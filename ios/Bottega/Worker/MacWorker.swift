// Foreground, explicit opt-in contribution to the paired Mac. One lease and one compute task at a time.
import Foundation
import Observation
import UIKit

private struct MacWorkerClaim: Decodable { let job: MacWorkerJob? }

private struct MacWorkerReceipt: Codable {
    let pairing: String
    let jobId: String
    let leaseToken: String
    let attempt: Int
    var result: MacWorkerResult?
    var metrics: MacWorkerMetrics?
    var reason: String?

    var payload: [String: Any] {
        get throws {
            var value: [String: Any] = ["jobId": jobId, "leaseToken": leaseToken, "attempt": attempt]
            if let result, let metrics {
                value["result"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(result))
                value["metrics"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(metrics))
            } else { value["reason"] = reason ?? "interrupted" }
            return value
        }
    }
}

@MainActor
@Observable
final class MacWorker {
    static let shared = MacWorker()
    var enabled: Bool {
        didSet {
            UserDefaults.standard.set(enabled, forKey: "macWorkerEnabled")
            reconcile()
        }
    }
    private(set) var status = "Disattivato"
    private(set) var running = false
    private(set) var completed = 0
    private(set) var lastComputeMs: Double?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var activePairing: String?
    @ObservationIgnored private var pausePresence: Task<Void, Never>?
    @ObservationIgnored private var foreground = false
    @ObservationIgnored private var voice = false
    @ObservationIgnored private let ponte = Ponte.shared
    @ObservationIgnored private let workerID: String

    private init() {
        let prefs = UserDefaults.standard
        if let id = prefs.string(forKey: "macWorkerID") { workerID = id }
        else { let id = UUID().uuidString; workerID = id; prefs.set(id, forKey: "macWorkerID") }
        let args = ProcessInfo.processInfo.arguments
        enabled = args.contains("--worker-pause") ? false : args.contains("--worker-enable") || prefs.bool(forKey: "macWorkerEnabled")
        prefs.set(enabled, forKey: "macWorkerEnabled")
    }

    /// Called by the app for scene, voice, thermal and pairing changes. Never runs in background.
    func update(foreground: Bool, voice: Bool) {
        self.foreground = foreground
        self.voice = voice
        reconcile()
    }

    var keepsDisplayAwake: Bool { running && allowed }
    private var allowed: Bool {
        enabled && foreground && !voice && !MacWorkerCompute.hot && ponte.identitaWorker != nil && !WorkerBenchmarkLaunch.requested
    }

    private func reconcile() {
        if task != nil && activePairing != ponte.identitaWorker { task?.cancel() }
        guard allowed else {
            running = false
            if let pairing = activePairing, task != nil { markUnavailable(pairing) }
            task?.cancel()
            if !enabled { status = "Disattivato" }
            else if !foreground { status = "In pausa: app in secondo piano" }
            else if voice { status = "In pausa: Melissa ha la precedenza" }
            else if MacWorkerCompute.hot { status = "In pausa: il telefono deve raffreddarsi" }
            else { status = "In pausa: collega il Mac" }
            return
        }
        guard task == nil, let pairing = ponte.identitaWorker else { return }
        running = true
        activePairing = pairing
        task = Task { await loop(pairing: pairing) }
    }

    private var profile: [String: Any] {
        ["id": workerID, "version": "bottega-ios-worker/1", "device": UIDevice.current.model,
         "capacity": 1, "thermal": MacWorkerCompute.thermal, "available": true,
         "capabilities": [
            ["operation": "embeddings", "implementation": "apple-nl-it", "revision": 1, "dimension": 640],
            ["operation": "ocr", "implementation": "apple-vision", "revision": 3]
         ]]
    }

    private func loop(pairing: String) async {
        var receipt: MacWorkerReceipt?
        var backoff: UInt64 = 2
        do { receipt = try load(pairing) }
        catch {
            status = "Ricevuta locale non leggibile: controlla lo spazio del telefono"
            running = false
            task = nil
            return
        }
        while allowed && ponte.identitaWorker == pairing && !Task.isCancelled {
            do {
                if let pending = receipt {
                    // Persist before network. An interrupted process releases its claim on the next foreground run.
                    try save(pending)
                    status = pending.result == nil ? "Rilascio del lavoro sospeso…" : "Invio del risultato al Mac…"
                    var accepted = true
                    do {
                        _ = try await ponte.richiestaWorker(pending.result == nil ? "release" : "complete",
                                                           body: try pending.payload, pairing: pairing)
                    } catch let error as ErrorePonte {
                        switch MacWorkerReceiptPolicy.failure(statusCode: error.codice, hasResult: pending.result != nil) {
                        case .discard:
                            // Expired/reassigned lease: never apply its result to a newer attempt.
                            accepted = false
                        case .releaseRejected:
                            // Validation happens before lease lookup on the Mac. Preserve a release instead of
                            // retrying an invalid completion forever, even after its lease expires.
                            var rejected = pending
                            rejected.result = nil
                            rejected.metrics = nil
                            rejected.reason = "result_rejected"
                            receipt = rejected
                            try save(rejected)
                            continue
                        case .retry: throw error
                        }
                    }
                    try remove(pairing)
                    if pending.result != nil && accepted { completed += 1; lastComputeMs = pending.metrics?.elapsedMs }
                    receipt = nil
                    backoff = 2
                    continue
                }
                status = "Pronto: in attesa di un lavoro del Mac"
                let data = try await ponte.richiestaWorker("claim", body: ["worker": profile, "waitMs": 20_000],
                                                          pairing: pairing, timeout: 30)
                guard data.count <= 6 * 1024 * 1024 else { throw MacWorkerCompute.Failure("Richiesta oltre il limite.") }
                let response = try JSONDecoder().decode(MacWorkerClaim.self, from: data)
                guard let job = response.job else {
                    backoff = 2
                    try await Task.sleep(for: .seconds(1))
                    continue
                }
                guard !job.id.isEmpty, job.id.utf8.count <= 200, !job.leaseToken.isEmpty,
                      job.leaseToken.utf8.count <= 256, job.attempt > 0 else {
                    throw MacWorkerCompute.Failure("Identità del lavoro non valida.")
                }
                receipt = MacWorkerReceipt(pairing: pairing, jobId: job.id, leaseToken: job.leaseToken, attempt: job.attempt)
                try save(receipt!)
                try Task.checkCancellation()
                guard allowed && ponte.identitaWorker == pairing else { throw CancellationError() }
                status = job.operation == "ocr" ? "Leggo un'immagine per il Mac…" : "Preparo la memoria per il Mac…"
                do {
                    let compute = Task.detached(priority: .utility) { try MacWorkerCompute.run(job) }
                    let (result, metrics) = try await withTaskCancellationHandler {
                        try await compute.value
                    } onCancel: { compute.cancel() }
                    receipt?.result = result
                    receipt?.metrics = metrics
                    try save(receipt!)
                } catch {
                    receipt?.reason = MacWorkerCompute.hot ? "thermal" : error is CancellationError ? "paused" : "execution_failed"
                    try save(receipt!)
                    if error is CancellationError { throw error }
                }
                backoff = 2
            } catch {
                if Task.isCancelled || error is CancellationError { break }
                status = "In attesa del Mac: riprovo fra poco"
                do { try await Task.sleep(nanoseconds: backoff * 1_000_000_000) }
                catch { break }
                backoff = min(backoff * 2, 30)
            }
        }
        // Serialize the pause acknowledgement before a resumed claim. No late pause can hide new work.
        markUnavailable(pairing)
        await pausePresence?.value
        pausePresence = nil
        running = false
        task = nil
        activePairing = nil
        reconcile()
    }

    private func markUnavailable(_ pairing: String) {
        guard pausePresence == nil, ponte.identitaWorker == pairing else { return }
        var offline = profile
        offline["available"] = false
        let body = offline
        pausePresence = Task { @MainActor in
            _ = try? await ponte.richiestaWorker("presence", body: ["worker": body], pairing: pairing, timeout: 5)
        }
    }

    private func location(_ pairing: String) throws -> URL {
        let folder = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                appropriateFor: nil, create: true).appendingPathComponent("MacWorker", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutable = folder
        try mutable.setResourceValues(values)
        return folder.appendingPathComponent(pairing + ".json")
    }
    private func save(_ receipt: MacWorkerReceipt) throws {
        let data = try JSONEncoder().encode(receipt)
        try data.write(to: location(receipt.pairing), options: [.atomic, .completeFileProtection])
    }
    private func load(_ pairing: String) throws -> MacWorkerReceipt? {
        let url = try location(pairing)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        guard data.count <= 1024 * 1024 else { throw MacWorkerCompute.Failure("Ricevuta troppo grande.") }
        let receipt = try JSONDecoder().decode(MacWorkerReceipt.self, from: data)
        guard receipt.pairing == pairing else { throw MacWorkerCompute.Failure("Ricevuta di un altro Mac.") }
        return receipt
    }
    private func remove(_ pairing: String) throws { try FileManager.default.removeItem(at: location(pairing)) }
}
