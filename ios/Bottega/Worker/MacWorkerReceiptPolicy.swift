/// HTTP delivery decisions shared by the foreground runtime and isolated tests.
/// A rejected result must not be retried forever: release the lease through the server's failure budget.
enum MacWorkerReceiptPolicy {
    enum FailureAction: Equatable { case discard, releaseRejected, retry }

    static func failure(statusCode: Int?, hasResult: Bool) -> FailureAction {
        switch statusCode {
        case 404, 409: return .discard
        case 422 where hasResult: return .releaseRejected
        default: return .retry
        }
    }
}
