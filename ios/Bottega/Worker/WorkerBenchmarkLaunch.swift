import Foundation

/// Explicit diagnostic launch only. This never starts in a normal app launch.
/// The app's diagnostic UI owns the returned Task and cancels it on background/voice start.
enum WorkerBenchmarkLaunch {
    static var requested: Bool { ProcessInfo.processInfo.arguments.contains("--benchmark-worker") }

    static func configuration(arguments: [String] = ProcessInfo.processInfo.arguments) throws -> WorkerBenchmark.Configuration {
        var config = WorkerBenchmark.Configuration()
        for (flag, setter) in [
            ("--operation", { (value: String) throws in config.operation = value }),
            ("--repetitions", { (value: String) throws in
                guard let number = Int(value) else { throw WorkerBenchmark.Failure("Ripetizioni non valide.") }
                config.repetitions = number
            }),
            ("--sustained-seconds", { (value: String) throws in
                guard let number = Double(value) else { throw WorkerBenchmark.Failure("Durata non valida.") }
                config.sustainedSeconds = number
            })
        ] {
            if let i = arguments.firstIndex(of: flag) {
                guard i + 1 < arguments.count else { throw WorkerBenchmark.Failure("Manca il valore di \(flag).") }
                try setter(arguments[i + 1])
            }
        }
        try config.validate()
        return config
    }

    /// Call from a dedicated foreground diagnostic screen, not from the normal voice lifecycle.
    /// It writes an atomic synthetic report inside this app's Documents container for devicectl.
    static func run(progress: @escaping @Sendable (String) -> Void = { _ in }) async throws -> URL {
        guard requested else { throw WorkerBenchmark.Failure("Benchmark non richiesto esplicitamente.") }
        let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask,
                                                     appropriateFor: nil, create: true)
        let output = documents.appendingPathComponent("benchmark-worker-result.json")
        // An interrupted/invalid new run must never leave a previous success looking current.
        if FileManager.default.fileExists(atPath: output.path) { try FileManager.default.removeItem(at: output) }
        let config = try configuration()
        let datasetURL = documents.appendingPathComponent("benchmark-worker-dataset.json")
        let dataset: WorkerBenchmark.Dataset?
        if FileManager.default.fileExists(atPath: datasetURL.path) {
            let attrs = try FileManager.default.attributesOfItem(atPath: datasetURL.path)
            guard ((attrs[.size] as? NSNumber)?.intValue ?? Int.max) <= 6_000_000 else {
                throw WorkerBenchmark.Failure("Dataset oltre il limite di 6 MB.")
            }
            dataset = try JSONDecoder().decode(WorkerBenchmark.Dataset.self, from: Data(contentsOf: datasetURL))
        } else { dataset = nil }
        let worker = Task.detached(priority: .utility) { try WorkerBenchmark.run(config, dataset: dataset, progress: progress) }
        let report = try await withTaskCancellationHandler(operation: { try await worker.value }, onCancel: { worker.cancel() })
        try Task.checkCancellation()
        try WorkerBenchmark.encode(report).write(to: output, options: .atomic)
        if let reason = report.stoppedReason { throw WorkerBenchmark.Failure(reason) }
        if report.samples.contains(where: { !$0.qualityPassed }) {
            throw WorkerBenchmark.Failure("Qualità insufficiente: consultare il rapporto diagnostico.")
        }
        progress("Rapporto salvato: benchmark-worker-result.json")
        return output
    }
}
