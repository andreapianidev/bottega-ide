import XCTest
import NaturalLanguage
@testable import Bottega

final class MacWorkerComputeTests: XCTestCase {
    private func embedding(_ texts: [String], revision: Int = 1) -> MacWorkerJob {
        MacWorkerJob(id: "test", origin: "bottega", operation: "embeddings", input: .init(texts: texts),
                     implementation: "apple-nl-it", revision: revision, dimension: 640,
                     leaseToken: "synthetic-lease", attempt: 1, leaseExpiresAt: Date().timeIntervalSince1970 * 1000 + 120_000)
    }

    func testRejectsOversizedBatchesAndDifferentModelRevision() {
        XCTAssertThrowsError(try MacWorkerCompute.run(embedding(Array(repeating: "testo", count: 7))))
        XCTAssertThrowsError(try MacWorkerCompute.run(embedding([String(repeating: "a", count: 2001)])))
        XCTAssertThrowsError(try MacWorkerCompute.run(embedding(["testo"], revision: 2)))
    }

    func testItalianVectorsAreFiniteNormalizedAndPreserveEmptyInput() throws {
        guard !MacWorkerCompute.hot else { throw XCTSkip("Il telefono è in pausa termica.") }
        guard let model = NLEmbedding.sentenceEmbedding(for: .italian), model.revision == 1, model.dimension == 640 else {
            throw XCTSkip("Il modello italiano richiesto non è disponibile nel simulatore.")
        }
        let (result, metrics) = try MacWorkerCompute.run(embedding(["La memoria mantiene il contesto del progetto.", "  "]))
        let rows = try XCTUnwrap(result.vectors)
        XCTAssertEqual(rows.count, 2)
        XCTAssertTrue(rows.allSatisfy { $0.count == 640 && $0.allSatisfy(\.isFinite) })
        XCTAssertEqual(rows[0].reduce(0.0) { $0 + Double($1) * Double($1) }.squareRoot(), 1, accuracy: 0.0001)
        XCTAssertTrue(rows[1].allSatisfy { $0 == 0 })
        XCTAssertGreaterThanOrEqual(metrics.elapsedMs, 0)
        XCTAssertGreaterThanOrEqual(metrics.cpuMs, 0)
        XCTAssertGreaterThan(metrics.outputBytes, 0)
    }

    func testRejectsNonImageBytesBeforeVision() {
        let job = MacWorkerJob(id: "image", origin: "avo", operation: "ocr",
                    input: .init(imageBase64: Data("not an image".utf8).base64EncodedString(), mimeType: "image/png"),
                    implementation: "apple-vision", revision: 3, dimension: nil,
                    leaseToken: "synthetic-lease", attempt: 1, leaseExpiresAt: 0)
        XCTAssertThrowsError(try MacWorkerCompute.run(job))
    }

    func testCancelledWorkNeverReturnsAResult() async {
        let job = embedding(["Contesto del progetto"])
        let task = Task.detached {
            withUnsafeCurrentTask { $0?.cancel() }
            return try MacWorkerCompute.run(job)
        }
        task.cancel()
        do { _ = try await task.value; XCTFail("Il lavoro annullato ha prodotto un risultato") }
        catch { XCTAssertTrue(error is CancellationError) }
    }
}
