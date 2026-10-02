//
//  Ricerca.swift
//  Bottega Nucleo
//
//  Apple Intelligence for the Memoria search: short, structured jobs only.
//   - expand: a few extra terms for the query (synonyms, acronyms, it/en translation);
//   - rerank: a 0...3 score per candidate, under a time limit (default 1.5 s): when the
//     model is late the caller gets `completo: false` and falls back to its own order.
//  Plus the pool of prewarmed sessions shared by every guided job of the Cervello.
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

// MARK: - Expansion

@Generable(description: "Termini da aggiungere a una ricerca")
struct Espansione {
    @Guide(description: "Al massimo 6 termini brevi, di una o due parole: sinonimi, sigle, la traduzione inglese o italiana delle parole chiave. Niente frasi.",
           .maximumCount(6))
    var termini: [String]
}

enum Ricerca {
    static let expandInstructions = """
    Aiuti a cercare nella memoria di lavoro di uno sviluppatore italiano (app iOS, siti, codice, \
    clienti, rilasci). Data una domanda, proponi termini NUOVI da cercare, che non compaiono gia' \
    nella domanda: sinonimi, sigle, nomi tecnici e la traduzione inglese delle parole chiave \
    italiane (o italiana di quelle inglesi). Solo parole o coppie di parole, mai frasi.
    """

    static let rerankInstructions = """
    Valuti quanto ogni testo candidato risponde a una domanda di ricerca nella memoria di uno \
    sviluppatore. Punteggio: 0 non c'entra, 1 vagamente collegato, 2 pertinente, 3 risponde \
    proprio alla domanda. Un punteggio per candidato, nello stesso ordine dei candidati.
    """

    static let rerankBestInstructions = """
    Scegli, tra i testi candidati, quelli che rispondono a una domanda di ricerca nella memoria \
    di uno sviluppatore. Rispondi con i numeri dei candidati pertinenti, dal piu' pertinente, al \
    massimo tre; nessuno se nessuno c'entra.
    """

    struct Espanso: Sendable {
        let termini: [String]
        let ms: Int
        let warm: Bool
    }

    static func expand(query: String) async throws -> Espanso {
        try CervelloErrori.checkAvailable()
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { throw NucleoError("La domanda da espandere e' vuota.") }
        let start = Date()
        let prompt = "Domanda: " + Guidata.clip(q, 600)
        let (session, warm) = Sessioni.take("expand", instructions: expandInstructions)
        do {
            let r = try await session.respond(to: prompt, generating: Espansione.self,
                                              options: GenerationOptions(samplingMode: .greedy, maximumResponseTokens: 80))
            return Espanso(termini: pulisciTermini(r.content.termini, query: q),
                           ms: Int(Date().timeIntervalSince(start) * 1000), warm: warm)
        } catch {
            throw CervelloErrori.translate(error)
        }
    }

    static func pulisciTermini(_ raw: [String], query: String) -> [String] {
        let ql = query.lowercased()
        let queryWords = Set(ql.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init))
        var seen = Set<String>()
        var out: [String] = []
        for t in raw {
            let clean = Guidata.senzaLineette(t).trimmingCharacters(in: CharacterSet(charactersIn: " .,;:\"'"))
            let key = clean.lowercased()
            let words = key.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
            // Words already in the question add nothing to the search.
            guard !clean.isEmpty, key != ql, words.count <= 3, !seen.contains(key),
                  !words.allSatisfy({ queryWords.contains($0) }) else { continue }
            seen.insert(key)
            out.append(clean)
            if out.count == 6 { break }
        }
        return out
    }

    // MARK: Rerank

    struct Candidato: @unchecked Sendable {
        let id: Any
        let text: String
    }

    struct Riordino: @unchecked Sendable {
        var ordine: [Any]
        var punteggi: [String: Int]
        var ms: Int
        var completo: Bool
        var warm: Bool
        var clip: Int
        var forma: String

        var json: [String: Any?] {
            ["ordine": ordine, "punteggi": punteggi, "ms": ms, "completo": completo, "caldo": warm,
             "taglio": clip, "forma": forma]
        }
    }

    static func candidati(_ list: [[String: Any]]) -> [Candidato] {
        list.compactMap { d in
            guard let id = d["id"], !(id is NSNull) else { return nil }
            return Candidato(id: plainID(id), text: (d["text"] as? String) ?? (d["title"] as? String) ?? "")
        }
    }

    /// Ids from JSONSerialization are NSNumbers, and JSON.encode prints an all-NSNumber
    /// array through its [Float] case (1238 -> 1238.0): Swift Int keeps them integers.
    private static func plainID(_ v: Any) -> Any {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return v }
        if !CFNumberIsFloatType(n) { return n.intValue }
        let d = n.doubleValue
        return (d == d.rounded() && abs(d) < 1e15) ? Int(d) as Any : d as Any
    }

    /// Scores up to 20 candidates. Late (over `timeoutMs`) or failed: input order, completo false.
    static func rerank(query: String, candidates all: [Candidato], timeoutMs: Int = 1500,
                       maxChars: Int = 300, forma: String = "migliori") async throws -> Riordino {
        try CervelloErrori.checkAvailable()
        let start = Date()
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { throw NucleoError("La domanda da usare per il riordino e' vuota.") }
        let cands = Array(all.prefix(20))
        let inputOrder = cands.map(\.id) + all.dropFirst(20).map(\.id)
        guard !cands.isEmpty else {
            return Riordino(ordine: [], punteggi: [:], ms: 0, completo: true, warm: false, clip: 0, forma: forma)
        }

        let model = SystemLanguageModel.default
        let context = model.contextSize > 0 ? model.contextSize : 4096
        let reserve = cands.count * 4 + 60
        // Texts are cut to fit the window. Italian runs ~3 characters per token: the estimate
        // decides, tokenCount (~100 ms) is paid only when the estimate gets near the limit.
        var clip = max(40, maxChars)
        var prompt = rerankPrompt(q, cands, clip: clip)
        while true {
            let estimate = (prompt.count + rerankInstructions.count) / 3 + 120
            if estimate + reserve < context * 6 / 10 { break }
            let counted = try await model.tokenCount(for: prompt) + 250
            if counted + reserve <= context || clip <= 60 { break }
            clip = clip * 2 / 3
            prompt = rerankPrompt(q, cands, clip: clip)
        }

        let n = cands.count
        let migliori = forma == "migliori"
        let schema: GenerationSchema
        if migliori {
            // Compact form: only the numbers of the best candidates (fewer output tokens).
            schema = try GenerationSchema(root: DynamicGenerationSchema(
                name: "Scelta", description: "I candidati che rispondono alla domanda",
                properties: [DynamicGenerationSchema.Property(
                    name: "migliori", description: "I numeri dei candidati pertinenti, dal piu' pertinente; vuoto se nessuno",
                    schema: DynamicGenerationSchema(arrayOf: DynamicGenerationSchema(type: Int.self, guides: [.range(1...n)]),
                                                    minimumElements: 0, maximumElements: min(3, n)))]),
                dependencies: [])
        } else {
            schema = try GenerationSchema(root: DynamicGenerationSchema(
                name: "Giudizio", description: "I punteggi dei candidati, nello stesso ordine",
                properties: [DynamicGenerationSchema.Property(
                    name: "punteggi", description: "Un punteggio da 0 a 3 per ogni candidato, nell'ordine",
                    schema: DynamicGenerationSchema(arrayOf: DynamicGenerationSchema(type: Int.self, guides: [.range(0...3)]),
                                                    minimumElements: n, maximumElements: n))]),
                dependencies: [])
        }
        let instructions = migliori ? rerankBestInstructions : rerankInstructions
        let (session, warm) = Sessioni.take(migliori ? "rerank.migliori" : "rerank", instructions: instructions)
        let finalPrompt = prompt + (migliori
            ? "\n\nQuali candidati rispondono alla domanda? Al massimo 3 numeri, dal piu' pertinente."
            : "\n\nDai \(n) punteggi, uno per candidato, nell'ordine da 1 a \(n).")
        let left = max(100, timeoutMs - Int(Date().timeIntervalSince(start) * 1000))
        let scores: [Int]?
        do {
            scores = try await Scadenza.run(ms: left) {
                let r = try await session.respond(to: finalPrompt, schema: schema,
                                                  options: GenerationOptions(samplingMode: .greedy,
                                                                             maximumResponseTokens: migliori ? 30 : n * 4 + 40))
                if migliori {
                    let best = try r.content.value([Int].self, forProperty: "migliori")
                    var out = [Int](repeating: 0, count: n)
                    var score = 3
                    for i in best where i >= 1 && i <= n && out[i - 1] == 0 && score > 0 {
                        out[i - 1] = score
                        score -= 1
                    }
                    return out
                }
                return try r.content.value([Int].self, forProperty: "punteggi")
            }
        } catch {
            let e = CervelloErrori.translate(error)
            if e.unavailable { throw e }
            Log.warn("riordino non riuscito: \(e.message)")
            scores = nil
        }
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        guard let scores, scores.count == n else {
            return Riordino(ordine: inputOrder, punteggi: [:], ms: ms, completo: false, warm: warm, clip: clip, forma: forma)
        }
        var punteggi: [String: Int] = [:]
        for (i, c) in cands.enumerated() { punteggi["\(c.id)"] = min(3, max(0, scores[i])) }
        let ranked = cands.indices.sorted { a, b in
            scores[a] != scores[b] ? scores[a] > scores[b] : a < b
        }.map { cands[$0].id }
        return Riordino(ordine: ranked + all.dropFirst(20).map(\.id), punteggi: punteggi, ms: ms,
                        completo: true, warm: warm, clip: clip, forma: forma)
    }

    private static func rerankPrompt(_ q: String, _ cands: [Candidato], clip: Int) -> String {
        var lines = ["Domanda: " + Guidata.clip(q, 400), "", "Candidati:"]
        for (i, c) in cands.enumerated() {
            lines.append("[\(i + 1)] " + Guidata.clip(c.text.trimmingCharacters(in: .whitespacesAndNewlines), clip))
        }
        return lines.joined(separator: "\n")
    }
}
