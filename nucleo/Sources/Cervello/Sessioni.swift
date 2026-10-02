//
//  Sessioni.swift
//  Bottega Nucleo
//
//  The pool of prewarmed sessions shared by every guided job of the Cervello, and a
//  deadline helper. (Query expansion and reranking for the Memoria search were measured
//  on 2 Oct 2026 and left out: see docs/CONTRATTI.md, 7.4.)
//

import Foundation
import FoundationModels

// MARK: - Prewarmed sessions

/// One spare, prewarmed session per kind of job. The first request of a kind runs cold and
/// leaves a warm spare behind; every later request takes the spare and prewarms the next.
enum Sessioni {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var spare: [String: LanguageModelSession] = [:]

    static func take(_ kind: String, instructions: String) -> (session: LanguageModelSession, warm: Bool) {
        lock.lock()
        let s = spare.removeValue(forKey: kind)
        lock.unlock()
        let session = s ?? LanguageModelSession(model: .default, instructions: instructions)
        prewarm(kind, instructions: instructions)
        return (session, s != nil)
    }

    /// Prepares the spare of a kind (no-op when there is one, or without Apple Intelligence).
    static func prewarm(_ kind: String, instructions: String) {
        guard Intelligence.isAvailable else { return }
        lock.lock(); defer { lock.unlock() }
        guard spare[kind] == nil else { return }
        let s = LanguageModelSession(model: .default, instructions: instructions)
        s.prewarm()
        spare[kind] = s
    }
}

/// Runs `op`, giving up after `ms` milliseconds (nil). The operation is cancelled then.
enum Scadenza {
    private final class Once<T>: @unchecked Sendable {
        private let lock = NSLock()
        private var cont: CheckedContinuation<T?, Error>?
        init(_ c: CheckedContinuation<T?, Error>) { cont = c }
        @discardableResult
        func finish(_ r: Result<T?, Error>) -> Bool {
            lock.lock()
            let c = cont
            cont = nil
            lock.unlock()
            guard let c else { return false }
            c.resume(with: r)
            return true
        }
    }

    static func run<T: Sendable>(ms: Int, _ op: @escaping @Sendable () async throws -> T) async throws -> T? {
        let task = Task { try await op() }
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<T?, Error>) in
            let once = Once<T>(c)
            Task {
                do { once.finish(.success(try await task.value)) } catch { once.finish(.failure(error)) }
            }
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + .milliseconds(ms)) {
                if once.finish(.success(nil)) { task.cancel() }
            }
        }
    }
}
