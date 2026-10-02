//
//  Intelligence.swift
//  Bottega Nucleo
//
//  Apple Intelligence on device (FoundationModels) and sentence embeddings
//  (NaturalLanguage). Nothing here touches the network.
//

import Foundation
import FoundationModels
import NaturalLanguage
import Accelerate

struct NucleoError: Error, LocalizedError {
    let message: String
    /// Distinguishes "the model is not there" (CLI exit 2) from any other failure.
    var unavailable = false
    init(_ message: String, unavailable: Bool = false) {
        self.message = message
        self.unavailable = unavailable
    }
    var errorDescription: String? { message }
}

enum Intelligence {

    static let defaultSummaryInstructions = """
    Sei l'assistente della Bottega, un ambiente di sviluppo. Riassumi in italiano, in modo \
    conciso e concreto, la sessione di lavoro che ti viene data. Usa queste sezioni, ciascuna \
    con poche righe e solo se c'e' qualcosa da dire: Richiesta, Cosa e' stato fatto, Decisioni, \
    File toccati, Prossimi passi. Non inventare nulla che non sia nel testo. Niente preamboli.
    """

    static let defaultGenerateInstructions = """
    Sei l'assistente della Bottega, un ambiente di sviluppo. Rispondi in italiano, in modo \
    chiaro e conciso.
    """

    // MARK: - Availability

    static var model: SystemLanguageModel { .default }

    static var isAvailable: Bool {
        if case .available = model.availability { return true }
        return false
    }

    /// Italian explanation of why the model cannot be used, nil when it can.
    static var unavailableReason: String? {
        switch model.availability {
        case .available:
            return nil
        case .unavailable(let reason):
            switch reason {
            case .deviceNotEligible:
                return "Apple Intelligence non e' supportata da questo Mac."
            case .appleIntelligenceNotEnabled:
                return "Apple Intelligence e' spenta: attivala in Impostazioni di Sistema, Apple Intelligence e Siri."
            case .modelNotReady:
                return "Il modello di Apple Intelligence non e' ancora pronto (download in corso o in preparazione). Riprova tra poco."
            @unknown default:
                return "Apple Intelligence non e' disponibile su questo Mac in questo momento."
            }
        }
    }

    // MARK: - Generation

    static func generate(prompt: String, instructions: String?, maxTokens: Int?) async throws -> String {
        if let reason = unavailableReason { throw NucleoError(reason, unavailable: true) }
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw NucleoError("Il testo da elaborare e' vuoto.") }
        let instr = (instructions?.isEmpty == false) ? instructions! : defaultGenerateInstructions
        let session = LanguageModelSession(model: model, instructions: instr)
        let options = GenerationOptions(maximumResponseTokens: maxTokens.map { max(16, $0) })
        do {
            let response = try await session.respond(to: trimmed, options: options)
            return response.content.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            throw translate(error)
        }
    }

    /// Summaries of texts longer than the context window are done in two passes: every
    /// chunk is summarized on its own, then the partial summaries are merged. The on-device
    /// model has a small window (a few thousand tokens), and a coding session easily
    /// exceeds it.
    static func summarize(text: String, instructions: String?) async throws -> String {
        if let reason = unavailableReason { throw NucleoError(reason, unavailable: true) }
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { throw NucleoError("Il testo da riassumere e' vuoto.") }
        let instr = (instructions?.isEmpty == false) ? instructions! : defaultSummaryInstructions

        let budget = charBudget()
        if clean.count <= budget {
            return try await generate(prompt: "Testo da riassumere:\n\n" + clean, instructions: instr, maxTokens: 700)
        }

        let chunks = split(clean, maxChars: budget)
        Log.info("riassunto in \(chunks.count) parti (testo di \(clean.count) caratteri)")
        var partials: [String] = []
        for (i, chunk) in chunks.enumerated() {
            let part = try await generate(
                prompt: "Parte \(i + 1) di \(chunks.count) di una sessione di lavoro. Riassumila in punti brevi, in italiano, conservando decisioni, file e problemi aperti:\n\n" + chunk,
                instructions: defaultGenerateInstructions,
                maxTokens: 400)
            partials.append(part)
        }
        var merged = partials.joined(separator: "\n\n")
        // Very long sessions: the partial summaries may themselves overflow. Fold again.
        while merged.count > budget {
            let again = split(merged, maxChars: budget)
            var next: [String] = []
            for chunk in again {
                next.append(try await generate(prompt: "Condensa questi appunti in italiano, senza perdere decisioni e file:\n\n" + chunk,
                                               instructions: defaultGenerateInstructions, maxTokens: 400))
            }
            merged = next.joined(separator: "\n\n")
        }
        return try await generate(prompt: "Appunti presi durante la sessione, parte per parte. Il riassunto deve coprire TUTTE le parti, non solo la prima:\n\n" + merged,
                                  instructions: instr, maxTokens: 700)
    }

    /// Characters of input that comfortably fit next to the instructions and the answer.
    /// Italian runs at roughly 3 characters per token on this tokenizer; we stay under.
    private static func charBudget() -> Int {
        let context = model.contextSize > 0 ? model.contextSize : 4096
        let reserved = 1100   // instructions + answer
        // Capped well below the window: measured on 1 Oct 2026, with ~21k characters per
        // chunk the small model summarized the first half and forgot the second.
        return min(10_000, max(2000, (context - reserved) * 3))
    }

    private static func split(_ text: String, maxChars: Int) -> [String] {
        var chunks: [String] = []
        var current = ""
        for paragraph in text.components(separatedBy: "\n") {
            if current.count + paragraph.count + 1 > maxChars, !current.isEmpty {
                chunks.append(current)
                current = ""
            }
            if paragraph.count > maxChars {
                // A single enormous line (a pasted log): cut it hard.
                var rest = Substring(paragraph)
                while !rest.isEmpty {
                    let piece = rest.prefix(maxChars)
                    chunks.append(String(piece))
                    rest = rest.dropFirst(piece.count)
                }
                continue
            }
            current += current.isEmpty ? paragraph : "\n" + paragraph
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }

    /// One translation of FoundationModels errors for the whole Nucleo (Cervello/AppleBrain.swift),
    /// on the current API: LanguageModelError (GenerationError is deprecated in macOS 27).
    private static func translate(_ error: Error) -> NucleoError {
        CervelloErrori.translate(error)
    }

    // MARK: - Embeddings

    private static let embeddingLock = NSLock()
    nonisolated(unsafe) private static var embeddings: [String: NLEmbedding] = [:]

    static func language(_ code: String?) -> NLLanguage {
        let c = (code ?? "it").lowercased()
        switch c {
        case "it", "ita", "italian", "italiano": return .italian
        case "en", "eng", "english", "inglese": return .english
        default: return NLLanguage(rawValue: c)
        }
    }

    static func embedding(for language: NLLanguage) -> NLEmbedding? {
        embeddingLock.lock(); defer { embeddingLock.unlock() }
        if let e = embeddings[language.rawValue] { return e }
        guard let e = NLEmbedding.sentenceEmbedding(for: language) else { return nil }
        embeddings[language.rawValue] = e
        return e
    }

    static var embeddingAvailable: Bool { NLEmbedding.sentenceEmbedding(for: .italian) != nil }

    /// L2-normalized sentence vectors. Empty or unknown text gives a zero vector, so the
    /// output always has one row per input and the caller can index by position.
    static func embed(_ texts: [String], language code: String?) throws -> (dimension: Int, vectors: [[Float]]) {
        let lang = language(code)
        guard let model = embedding(for: lang) else {
            throw NucleoError("Gli embedding di frase per la lingua \"\(lang.rawValue)\" non sono disponibili su questo Mac.")
        }
        let dim = model.dimension
        var out: [[Float]] = []
        out.reserveCapacity(texts.count)
        for t in texts {
            let clean = t.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !clean.isEmpty, let v = model.vector(for: clean), v.count == dim else {
                out.append([Float](repeating: 0, count: dim))
                continue
            }
            out.append(normalized(v))
        }
        return (dim, out)
    }

    static func normalized(_ v: [Double]) -> [Float] {
        var f = [Float](repeating: 0, count: v.count)
        vDSP_vdpsp(v, 1, &f, 1, vDSP_Length(v.count))
        var sumSq: Float = 0
        vDSP_svesq(f, 1, &sumSq, vDSP_Length(f.count))
        let norm = sumSq.squareRoot()
        guard norm > 0 else { return f }
        var inv = 1 / norm
        vDSP_vsmul(f, 1, &inv, &f, 1, vDSP_Length(f.count))
        return f
    }
}
