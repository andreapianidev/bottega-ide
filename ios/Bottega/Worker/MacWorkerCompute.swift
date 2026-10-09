// Finite, bounded local operations. No tools, remote code, credentials or model downloads.
import Foundation
import NaturalLanguage
import Vision
import ImageIO
import Darwin

struct MacWorkerJob: Codable, Sendable {
    struct Input: Codable, Sendable {
        var texts: [String]?
        var imageBase64: String?
        var mimeType: String?
    }
    let id: String
    let origin: String
    let operation: String
    let input: Input
    let implementation: String
    let revision: Int
    let dimension: Int?
    let leaseToken: String
    let attempt: Int
    let leaseExpiresAt: Double
}

struct MacWorkerResult: Codable, Sendable {
    var vectors: [[Float]]?
    var text: String?
    let implementation: String
    let revision: Int
    var dimension: Int?
}

struct MacWorkerMetrics: Codable, Sendable {
    let elapsedMs: Double
    let cpuMs: Double
    let peakResidentBytes: Int64
    let inputBytes: Int
    let outputBytes: Int
    let thermalStart: String
    let thermalEnd: String
}

enum MacWorkerCompute {
    struct Failure: Error, LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    static func run(_ job: MacWorkerJob) throws -> (MacWorkerResult, MacWorkerMetrics) {
        try Task.checkCancellation()
        guard !hot else { throw Failure("Telefono caldo: lavoro sospeso.") }
        let start = ProcessInfo.processInfo.systemUptime
        let before = usage()
        let thermalStart = thermal
        let result: MacWorkerResult
        let inputBytes: Int
        switch job.operation {
        case "embeddings":
            guard job.implementation == "apple-nl-it", job.revision == 1, job.dimension == 640,
                  let texts = job.input.texts, (1...6).contains(texts.count),
                  texts.allSatisfy({ $0.count <= 2000 && $0.utf8.count <= 8000 }),
                  let model = NLEmbedding.sentenceEmbedding(for: .italian),
                  model.revision == 1, model.dimension == 640 else {
                throw Failure("Testi o modello embedding non compatibili.")
            }
            inputBytes = texts.reduce(0) { $0 + $1.utf8.count }
            let rows = try texts.map { text -> [Float] in
                try Task.checkCancellation()
                guard !hot else { throw Failure("Telefono caldo: lavoro sospeso.") }
                let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if clean.isEmpty { return [Float](repeating: 0, count: 640) }
                guard let values = model.vector(for: clean), values.count == 640,
                      values.allSatisfy(\.isFinite) else { throw Failure("Vettore non valido.") }
                let norm = values.reduce(0) { $0 + $1 * $1 }.squareRoot()
                guard norm.isFinite, norm > 0 else { throw Failure("Norma non valida.") }
                return values.map { Float($0 / norm) }
            }
            result = MacWorkerResult(vectors: rows, implementation: "apple-nl-it", revision: 1, dimension: 640)
        case "ocr":
            guard job.implementation == "apple-vision", job.revision == 3,
                  let encoded = job.input.imageBase64, encoded.utf8.count <= 5_592_408,
                  let mime = job.input.mimeType, ["image/png", "image/jpeg"].contains(mime),
                  let data = Data(base64Encoded: encoded), !data.isEmpty, data.count <= 4 * 1024 * 1024,
                  let source = CGImageSourceCreateWithData(data as CFData, nil),
                  CGImageSourceGetCount(source) == 1,
                  let type = CGImageSourceGetType(source) as String?,
                  type == (mime == "image/png" ? "public.png" : "public.jpeg"),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                  let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
                  width.intValue > 0, height.intValue > 0,
                  width.intValue <= 8192, height.intValue <= 8192,
                  width.intValue * height.intValue <= 24_000_000,
                  VNRecognizeTextRequest.supportedRevisions.contains(3) else {
                throw Failure("Immagine o modello OCR non compatibili.")
            }
            inputBytes = data.count
            let request = VNRecognizeTextRequest()
            request.revision = 3
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            request.recognitionLanguages = ["it-IT", "en-US"]
            request.automaticallyDetectsLanguage = false
            try VNImageRequestHandler(data: data, options: [:]).perform([request])
            try Task.checkCancellation()
            let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
            guard text.utf8.count <= 128_000 else { throw Failure("Risultato OCR oltre il limite.") }
            result = MacWorkerResult(text: text, implementation: "apple-vision", revision: 3)
        default: throw Failure("Operazione non supportata.")
        }
        try Task.checkCancellation()
        let after = usage()
        let bytes = try JSONEncoder().encode(result).count
        return (result, MacWorkerMetrics(elapsedMs: (ProcessInfo.processInfo.systemUptime - start) * 1000,
                    cpuMs: max(0, after.cpuMs - before.cpuMs), peakResidentBytes: after.peakResidentBytes,
                    inputBytes: inputBytes, outputBytes: bytes, thermalStart: thermalStart, thermalEnd: thermal))
    }

    static var hot: Bool { ProcessInfo.processInfo.thermalState == .serious || ProcessInfo.processInfo.thermalState == .critical }
    static var thermal: String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }
    private static func usage() -> (cpuMs: Double, peakResidentBytes: Int64) {
        var value = rusage()
        getrusage(RUSAGE_SELF, &value)
        let user = Double(value.ru_utime.tv_sec) * 1000 + Double(value.ru_utime.tv_usec) / 1000
        let system = Double(value.ru_stime.tv_sec) * 1000 + Double(value.ru_stime.tv_usec) / 1000
        return (user + system, Int64(value.ru_maxrss))
    }
}
