// Persistent JSONL adapter around the production phone/Mac compute implementation.
// Build with ios/Bottega/Worker/MacWorkerCompute.swift; stdout contains JSON only.
import Foundation

@main
struct WorkerLocalMain {
    private struct Request: Decodable { let job: MacWorkerJob }
    private struct Response: Encodable {
        var result: MacWorkerResult?
        var metrics: MacWorkerMetrics?
        var error: String?
    }

    static func main() {
        while let line = readLine(strippingNewline: true) {
            let output: Data = autoreleasepool {
                let response: Response
                do {
                    guard line.utf8.count <= 6 * 1024 * 1024 else {
                        throw MacWorkerCompute.Failure("Richiesta oltre il limite.")
                    }
                    let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
                    let (result, metrics) = try MacWorkerCompute.run(request.job)
                    response = Response(result: result, metrics: metrics)
                } catch {
                    response = Response(error: error.localizedDescription)
                }
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
                var data = (try? encoder.encode(response)) ?? Data("{\"error\":\"Risultato non serializzabile.\"}".utf8)
                data.append(0x0a)
                return data
            }
            FileHandle.standardOutput.write(output)
        }
    }
}
