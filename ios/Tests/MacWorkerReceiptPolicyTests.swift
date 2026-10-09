import XCTest
@testable import Bottega

final class MacWorkerReceiptPolicyTests: XCTestCase {
    func testRejectedCompletionBecomesBoundedRelease() {
        XCTAssertEqual(MacWorkerReceiptPolicy.failure(statusCode: 422, hasResult: true), .releaseRejected)
    }
    func testStaleAndRemovedLeasesAreDiscardedForBothReceiptTypes() {
        for code in [404, 409] {
            for hasResult in [false, true] {
                XCTAssertEqual(MacWorkerReceiptPolicy.failure(statusCode: code, hasResult: hasResult), .discard)
            }
        }
    }
    func testTransientAndAuthenticationErrorsPreserveDurableResult() {
        for code: Int? in [nil, 401, 429, 500, 503] {
            XCTAssertEqual(MacWorkerReceiptPolicy.failure(statusCode: code, hasResult: true), .retry)
        }
    }
    func testReleaseIsNotConvertedIntoAnotherRejectedCompletion() {
        XCTAssertEqual(MacWorkerReceiptPolicy.failure(statusCode: 422, hasResult: false), .retry)
    }
}
