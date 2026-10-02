//
//  Contestuale.swift
//  Bottega Nucleo
//
//  Contextual sentence vectors: NLContextualEmbedding (Italian, 512 dimensions, 256 tokens),
//  mean of the token vectors, L2-normalized. Longer texts are split into windows of
//  sentences that fit, and the windows are averaged (weighted by their tokens).
//  The assets are already on the Mac: nothing is ever requested or downloaded here.
//

import Foundation
import NaturalLanguage
import Accelerate

enum Contestuale {
    static let modelName = "contestuale"
    /// Words per window before measuring: Italian runs ~1.5 tokens per word, 256 max.
    private static let wordsPerWindow = 140
    /// The model stays loaded this long after the last use, then memory is given back.
    private static let idleUnload: TimeInterval = 300

    private static let lock = NSLock()
    nonisolated(unsafe) private static var model: NLContextualEmbedding?
    nonisolated(unsafe) private static var unloadWork: DispatchWorkItem?

    static var available: Bool {
        NLContextualEmbedding(language: .italian)?.hasAvailableAssets ?? false
    }

    /// One L2-normalized vector per text; empty text gives a zero vector.
    static func embedContextual(_ texts: [String]) throws -> (dimension: Int, vectors: [[Float]]) {
        lock.lock()
        defer {
            scheduleUnload()
            lock.unlock()
        }
        let m = try loaded()
        let dim = m.dimension
        let maxLen = m.maximumSequenceLength
        var out: [[Float]] = []
        out.reserveCapacity(texts.count)
        for t in texts {
            let clean = t.trimmingCharacters(in: .whitespacesAndNewlines)
            if clean.isEmpty {
                out.append([Float](repeating: 0, count: dim))
                continue
            }
            var sum = [Double](repeating: 0, count: dim)
            var tokens = 0
            for w in windows(clean) {
                try accumulate(w, model: m, maxLen: maxLen, into: &sum, tokens: &tokens)
            }
            if tokens == 0 {
                out.append([Float](repeating: 0, count: dim))
            } else {
                out.append(Intelligence.normalized(sum))
            }
        }
        return (dim, out)
    }

    /// Cosine of two vectors (vDSP). The vectors above are already normalized, so this is
    /// their dot product, but any pair works.
    static func coseno(_ a: [Float], _ b: [Float]) -> Float {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        let na = vDSP.sumOfSquares(a), nb = vDSP.sumOfSquares(b)
        guard na > 0, nb > 0 else { return 0 }
        return vDSP.dot(a, b) / (na * nb).squareRoot()
    }

    // MARK: - Internals (called with the lock held)

    private static func loaded() throws -> NLContextualEmbedding {
        if let m = model { return m }
        guard let m = NLContextualEmbedding(language: .italian) else {
            throw NucleoError("Gli embedding contestuali per l'italiano non esistono su questo Mac.")
        }
        guard m.hasAvailableAssets else {
            throw NucleoError("Gli embedding contestuali per l'italiano non sono installati su questo Mac.")
        }
        do {
            try m.load()
        } catch {
            throw NucleoError("Non riesco a caricare gli embedding contestuali: \(error.localizedDescription)")
        }
        model = m
        return m
    }

    private static func scheduleUnload() {
        unloadWork?.cancel()
        let work = DispatchWorkItem {
            lock.lock(); defer { lock.unlock() }
            model?.unload()
            model = nil
            unloadWork = nil
        }
        unloadWork = work
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + idleUnload, execute: work)
    }

    /// Sums the token vectors of `text` into `sum`. A window the model truncated (it filled
    /// the whole sequence) is halved and measured again.
    private static func accumulate(_ text: String, model m: NLContextualEmbedding, maxLen: Int,
                                   into sum: inout [Double], tokens: inout Int) throws {
        let result: NLContextualEmbeddingResult
        do {
            result = try m.embeddingResult(for: text, language: .italian)
        } catch {
            throw NucleoError("Embedding contestuale non riuscito: \(error.localizedDescription)")
        }
        let words = text.split(whereSeparator: { $0.isWhitespace })
        if result.sequenceLength >= maxLen, words.count > 8 {
            let half = words.count / 2
            try accumulate(words[..<half].joined(separator: " "), model: m, maxLen: maxLen, into: &sum, tokens: &tokens)
            try accumulate(words[half...].joined(separator: " "), model: m, maxLen: maxLen, into: &sum, tokens: &tokens)
            return
        }
        let dim = sum.count
        result.enumerateTokenVectors(in: text.startIndex..<text.endIndex) { vector, _ in
            if vector.count == dim {
                sum = vDSP.add(sum, vector)
                tokens += 1
            }
            return true
        }
    }

    /// Sentences packed into windows of at most `wordsPerWindow` words.
    static func windows(_ text: String) -> [String] {
        let wordCount = text.split(whereSeparator: { $0.isWhitespace }).count
        if wordCount <= wordsPerWindow { return [text] }
        let tokenizer = NLTokenizer(unit: .sentence)
        tokenizer.string = text
        var sentences: [String] = []
        tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
            let s = text[range].trimmingCharacters(in: .whitespacesAndNewlines)
            if !s.isEmpty { sentences.append(s) }
            return true
        }
        var out: [String] = []
        var current: [Substring] = []
        func flush() {
            if !current.isEmpty { out.append(current.joined(separator: " ")); current = [] }
        }
        for s in sentences {
            let words = s.split(whereSeparator: { $0.isWhitespace })
            if words.count > wordsPerWindow {
                flush()
                var i = 0
                while i < words.count {
                    out.append(words[i..<min(i + wordsPerWindow, words.count)].joined(separator: " "))
                    i += wordsPerWindow
                }
                continue
            }
            if current.count + words.count > wordsPerWindow { flush() }
            current.append(contentsOf: words)
        }
        flush()
        return out
    }
}
