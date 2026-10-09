// Standalone, synthetic diagnostic shared by the Mac CLI and iPhone app.
// No networking, credentials, production memory, model downloads or background services.
import Foundation
import NaturalLanguage
import Vision
import CoreGraphics
import CoreText
import ImageIO
import CryptoKit
import Darwin

enum WorkerBenchmark {
    static let version = "bottega-worker-benchmark/1"

    struct Configuration: Sendable {
        var operation = "all"
        var repetitions = 5
        var sustainedSeconds: Double = 0

        func validate() throws {
            guard ["all", "embeddings", "ocr"].contains(operation),
                  (1...1000).contains(repetitions), sustainedSeconds.isFinite,
                  (0...1200).contains(sustainedSeconds) else {
                throw Failure("Configurazione non valida: operazione all/embeddings/ocr, ripetizioni 1...1000, durata 0...1200 secondi.")
            }
        }
    }

    struct ImageFixture: Codable, Sendable {
        let id: String
        let png: Data
        let expected: String
    }

    struct Dataset: Codable, Sendable {
        let version: String
        let texts: [String]
        let images: [ImageFixture]

        func validate() throws {
            guard version == "synthetic-worker/1", texts.count == 12, images.count == 2,
                  texts.allSatisfy({ $0.utf8.count <= 2000 }),
                  texts.last == "", images.allSatisfy({
                      !$0.png.isEmpty && $0.png.count <= 2_000_000 && $0.expected.utf8.count <= 4000
                  }) else { throw Failure("Dataset sintetico non valido o oltre i limiti.") }
            for fixture in images {
                guard let source = CGImageSourceCreateWithData(fixture.png as CFData, nil),
                      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                      (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue == 1280,
                      (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue == 960 else {
                    throw Failure("Le fixture devono essere immagini sintetiche 1280 × 960.")
                }
            }
        }
    }

    struct Environment: Codable, Sendable {
        let machine: String
        let chip: String?
        let os: String
        let cores: Int
        let physicalMemoryBytes: UInt64
        let appBuild: String?
        let thermalStart: String
        let lowPowerMode: Bool
    }

    struct Sample: Codable, Sendable {
        let operation: String
        let iteration: Int
        let cache: String
        let elapsedMs: Double
        let cpuMs: Double
        let peakResidentBytes: Int64
        let thermal: String
        let inputBytes: Int
        let outputBytes: Int
        let outputSHA256: String
        let qualityPassed: Bool
        let normalizationMaxError: Double?
        let tokenRecall: Double?
    }

    struct Report: Codable, Sendable {
        let schemaVersion: Int
        let implementation: String
        let createdAt: String
        let environment: Environment
        let datasetVersion: String
        let datasetSHA256: String
        let datasetSource: String
        let embeddingRevision: Int?
        let embeddingDimension: Int?
        let visionRevision: Int?
        let requestedRepetitions: Int
        let sustainedSeconds: Double
        let preparationMs: Double
        let totalMs: Double
        let samples: [Sample]
        let probeVectors: [[Float]]?
        let recognizedTexts: [String]?
        let stoppedReason: String?
        let limitations: [String]
    }

    struct Failure: Error, LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }

    static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    static func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func syntheticDataset() throws -> Dataset {
        let texts = [
            "Richiesta: correggere la ricerca dei progetti e mantenere i filtri dopo il riavvio.",
            "Decisione: salvare il filtro del progetto nelle preferenze locali.",
            "Risultato: la ricerca conserva il progetto selezionato dopo la riapertura.",
            "Richiesta: aggiungere un riepilogo delle sessioni di lavoro della settimana.",
            "Decisione: mostrare solo sessioni concluse e indicare la provenienza delle informazioni.",
            "Risultato: il riepilogo settimanale include decisioni, file e problemi aperti.",
            "Richiesta: verificare la memoria dei personaggi fra applicazione Mac e telefono.",
            "Decisione: mantenere distinti autore, destinatario e contesto condiviso.",
            "Risultato: i messaggi senza identità storica conservano la loro incertezza.",
            "La passeggiata lungo la costa è durata quaranta minuti con cielo sereno.",
            "Ingredienti: farina, acqua, olio e un pizzico di sale per preparare il pane.",
            ""
        ]
        let pages = [
            ["SESSIONE DI LAVORO", "Progetto: progetto sintetico alfa", "Richiesta: correggere i filtri della ricerca.",
             "Decisione: salvare la selezione locale.", "File: Ricerca.swift e Preferenze.swift", "Verifica: riavvio e selezione conservata.",
             "Risultato: controllo completato.", "Prossimo passo: verificare sul telefono."],
            ["RIEPILOGO SETTIMANALE", "Progetto: progetto sintetico beta", "Sessioni concluse: 12", "Controlli completati: 8",
             "Problemi aperti: 2", "Decisione: mantenere la provenienza dei dati.", "Memoria: autore e destinatario distinti.",
             "Prossimo passo: confronto Mac e telefono."]
        ]
        return Dataset(version: "synthetic-worker/1", texts: texts,
                       images: try pages.enumerated().map { i, lines in
                           ImageFixture(id: "page-\(i + 1)", png: try page(lines), expected: lines.joined(separator: "\n"))
                       })
    }

    private static func page(_ lines: [String]) throws -> Data {
        let width = 1280, height = 960
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw Failure("Impossibile creare la pagina sintetica.")
        }
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.textMatrix = .identity
        for (i, text) in lines.enumerated() {
            let attributes: [NSAttributedString.Key: Any] = [
                NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica" as CFString, i == 0 ? 34 : 27, nil),
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1)
            ]
            context.textPosition = CGPoint(x: 64, y: height - 100 - i * 96)
            CTLineDraw(CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes)), context)
        }
        guard let image = context.makeImage() else { throw Failure("Pagina sintetica non disponibile.") }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, "public.png" as CFString, 1, nil) else {
            throw Failure("Codifica PNG non disponibile.")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw Failure("Codifica PNG fallita.") }
        return output as Data
    }

    /// Runs synchronously on the caller's executor. iOS must use Task.detached, never the main actor.
    /// Each sample is a finite batch. Cancellation/thermal pressure is checked between samples.
    static func run(_ config: Configuration, dataset supplied: Dataset? = nil, datasetSource: String? = nil,
                    progress: @Sendable (String) -> Void = { _ in }) throws -> Report {
        try config.validate()
        try Task.checkCancellation()
        let start = ProcessInfo.processInfo.systemUptime
        let environment = Environment(machine: machine(), chip: sysctlString("machdep.cpu.brand_string"),
                                      os: ProcessInfo.processInfo.operatingSystemVersionString,
                                      cores: ProcessInfo.processInfo.activeProcessorCount,
                                      physicalMemoryBytes: ProcessInfo.processInfo.physicalMemory,
                                      appBuild: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
                                      thermalStart: thermal(), lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled)
        let dataset = try supplied ?? syntheticDataset()
        try dataset.validate()
        let encoded = try encode(dataset)
        let preparationMs = (ProcessInfo.processInfo.systemUptime - start) * 1000
        var samples: [Sample] = []
        var model: NLEmbedding?
        var revision: Int?
        var dimension: Int?
        var vectors: [[Float]]?
        var recognized: [String]?
        var stopped: String?
        let operations = config.operation == "all" ? ["embeddings", "ocr"] : [config.operation]
        let runsStart = ProcessInfo.processInfo.systemUptime
        var iteration = 0
        outer: repeat {
            iteration += 1
            for operation in operations {
                try Task.checkCancellation()
                let thermalState = ProcessInfo.processInfo.thermalState
                if thermalState == .serious || thermalState == .critical {
                    stopped = "Pressione termica: \(thermal()). Riprendere dopo il raffreddamento."
                    break outer
                }
                let before = usage()
                let t0 = ProcessInfo.processInfo.systemUptime
                let output: Data
                let good: Bool
                var normError: Double?
                var recall: Double?
                let inputBytes: Int
                if operation == "embeddings" {
                    if model == nil { model = NLEmbedding.sentenceEmbedding(for: .italian) }
                    guard let model else { throw Failure("Embedding italiani di frase non disponibili su questo dispositivo.") }
                    revision = model.revision
                    dimension = model.dimension
                    let rows = try dataset.texts.map { text -> [Float] in
                        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        if clean.isEmpty { return [Float](repeating: 0, count: model.dimension) }
                        guard let row = model.vector(for: clean), row.count == model.dimension,
                              row.allSatisfy(\.isFinite) else { throw Failure("Il modello ha restituito un vettore non valido.") }
                        let norm = row.reduce(0) { $0 + $1 * $1 }.squareRoot()
                        guard norm.isFinite && norm > 0 else { throw Failure("Norma del vettore non valida.") }
                        return row.map { Float($0 / norm) }
                    }
                    let errors = rows.dropLast().map { abs(1 - Double($0.reduce(0) { $0 + $1 * $1 }).squareRoot()) }
                    normError = errors.max() ?? 0
                    good = normError! < 0.0001 && rows.last?.allSatisfy({ $0 == 0 }) == true
                    output = try encode(rows)
                    if vectors == nil { vectors = rows }
                    inputBytes = dataset.texts.reduce(0) { $0 + $1.utf8.count }
                } else {
                    var texts: [String] = []
                    var expectedTokens = 0, matchedTokens = 0
                    for fixture in dataset.images {
                        try Task.checkCancellation()
                        let request = VNRecognizeTextRequest()
                        request.recognitionLevel = .accurate
                        request.usesLanguageCorrection = true
                        request.recognitionLanguages = ["it-IT", "en-US"]
                        request.automaticallyDetectsLanguage = false
                        try VNImageRequestHandler(data: fixture.png, options: [:]).perform([request])
                        let result = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
                        texts.append(result)
                        let expected = tokens(fixture.expected)
                        var actual = tokens(result)
                        expectedTokens += expected.count
                        for token in expected {
                            if let i = actual.firstIndex(of: token) { matchedTokens += 1; actual.remove(at: i) }
                        }
                    }
                    recall = expectedTokens > 0 ? Double(matchedTokens) / Double(expectedTokens) : 0
                    good = recall! >= 0.95
                    output = try encode(texts)
                    if recognized == nil { recognized = texts }
                    inputBytes = dataset.images.reduce(0) { $0 + $1.png.count }
                }
                let elapsed = (ProcessInfo.processInfo.systemUptime - t0) * 1000
                let after = usage()
                samples.append(Sample(operation: operation, iteration: iteration,
                                      cache: iteration == 1 ? "first-in-process; system cache unknown" : "warm-in-process",
                                      elapsedMs: elapsed, cpuMs: max(0, after.cpuMs - before.cpuMs),
                                      peakResidentBytes: after.peakResidentBytes, thermal: thermal(),
                                      inputBytes: inputBytes, outputBytes: output.count, outputSHA256: hash(output),
                                      qualityPassed: good, normalizationMaxError: normError, tokenRecall: recall))
                progress("\(operation) #\(iteration): \(String(format: "%.1f", elapsed)) ms, qualità \(good ? "ok" : "insufficiente")")
            }
            // A real sustained run is opt-in; finite upper bound prevents an unattended endless task.
        } while iteration < config.repetitions || (config.sustainedSeconds > 0 &&
                     ProcessInfo.processInfo.systemUptime - runsStart < config.sustainedSeconds)
        return Report(schemaVersion: 1, implementation: version, createdAt: ISO8601DateFormatter().string(from: Date()),
                      environment: environment, datasetVersion: dataset.version, datasetSHA256: hash(encoded),
                      datasetSource: datasetSource ?? (supplied == nil ? "generated-on-device" : "provided-identical-bytes"),
                      embeddingRevision: revision, embeddingDimension: dimension,
                      visionRevision: operations.contains("ocr") ? VNRecognizeTextRequest.defaultRevision : nil,
                      requestedRepetitions: config.repetitions, sustainedSeconds: config.sustainedSeconds,
                      preparationMs: preparationMs, totalMs: (ProcessInfo.processInfo.systemUptime - start) * 1000,
                      samples: samples, probeVectors: vectors, recognizedTexts: recognized, stoppedReason: stopped,
                      limitations: [
                        "Compute-only diagnostic: network, serialization at the application boundary and coordinator overhead are not measured.",
                        "First-in-process is not a guaranteed cold OS/model cache; cache eviction is not attempted.",
                        "CPU is process CPU time; memory is process peak resident size. Apple service processes and GPU allocations are not included.",
                        "OCR uses VNRecognizeTextRequest on both devices; production Nucleo uses RecognizeTextRequest and needs separate parity validation.",
                        "NaturalLanguage revision and dimension alone do not prove cross-OS vector compatibility; compare probe vectors before indexing.",
                        "Synthetic token recall and normalized vectors do not validate all real documents or semantic retrieval quality.",
                        "Concurrent system workload is not controlled by this harness; record representative compilation/activity separately."
                      ])
    }

    private static func tokens(_ text: String) -> [String] {
        text.lowercased().folding(options: .diacriticInsensitive, locale: Locale(identifier: "it_IT"))
            .components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    }

    private static func usage() -> (cpuMs: Double, peakResidentBytes: Int64) {
        var value = rusage()
        guard getrusage(RUSAGE_SELF, &value) == 0 else { return (0, 0) }
        let seconds = Double(value.ru_utime.tv_sec + value.ru_stime.tv_sec)
        let microseconds = Double(value.ru_utime.tv_usec + value.ru_stime.tv_usec)
        return (seconds * 1000 + microseconds / 1000, Int64(value.ru_maxrss))
    }

    private static func thermal() -> String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }

    private static func machine() -> String {
        #if os(macOS)
        if let model = sysctlString("hw.model") { return model }
        #endif
        var value = utsname()
        uname(&value)
        let capacity = MemoryLayout.size(ofValue: value.machine)
        return withUnsafePointer(to: &value.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: capacity) { String(cString: $0) }
        }
    }

    private static func sysctlString(_ name: String) -> String? {
        var count = 0
        guard sysctlbyname(name, nil, &count, nil, 0) == 0, count > 1, count < 4096 else { return nil }
        var bytes = [CChar](repeating: 0, count: count)
        guard sysctlbyname(name, &bytes, &count, nil, 0) == 0 else { return nil }
        return String(cString: bytes)
    }
}
