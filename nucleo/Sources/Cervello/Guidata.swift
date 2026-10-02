//
//  Guidata.swift
//  Bottega Nucleo
//
//  Guided generation (@Generable) for two small jobs of the Memoria: the sentence of the
//  live board ("Claude sta sistemando il login di Peak") and the category of a session.
//

import Foundation
import FoundationModels

/// One line of `~/.bottega/memoria/bacheca/<chiave>.jsonl` (memoria/lib/bacheca.mjs).
struct RigaBacheca: Sendable {
    let at: Int64
    let project: String
    let sessionId: String
    let kind: String
    let summary: String
    let file: String?
    let rel: String?
    let cmd: String?
    let text: String?

    init?(json d: [String: Any]) {
        guard let at = (d["at"] as? NSNumber)?.int64Value else { return nil }
        self.at = at
        project = (d["project"] as? String) ?? ""
        sessionId = (d["sessionId"] as? String) ?? ""
        kind = (d["kind"] as? String) ?? ""
        summary = (d["summary"] as? String) ?? ""
        file = d["file"] as? String
        rel = d["rel"] as? String
        cmd = d["cmd"] as? String
        text = d["text"] as? String
    }

    init?(line: String) {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        self.init(json: obj)
    }

    /// How the event reads in the prompt of the board sentence.
    var promptLine: String {
        switch kind {
        case "prompt":
            return "richiesta dell'utente: \"\(Guidata.clip(Guidata.senzaTag(text ?? summary), 300))\""
        case "edit", "write":
            return "modifica \(rel ?? file.map { ($0 as NSString).lastPathComponent } ?? Guidata.clip(summary, 120))"
        case "bash":
            return "comando: \(Guidata.clip(Guidata.comando(cmd ?? summary), 120))"
        case "read":
            return "legge \(rel ?? Guidata.clip(summary, 120))"
        default:
            return Guidata.clip(summary.isEmpty ? kind : summary, 140)
        }
    }
}

/// What the model decides for the board: the verb (closed list) and the object.
/// Measured on 2 Oct 2026: asked for the whole sentence, the on-device model copied the
/// examples of the instructions ("il login di Peak" for a session on another project) or
/// wrote "Claude, prova, ..."; the sentence is therefore composed here from these two fields.
@Generable(description: "Che cosa sta facendo una sessione di Claude su un progetto")
struct AttivitaBacheca {
    @Guide(description: "Il verbo che descrive meglio il lavoro in corso",
           .anyOf(["sistema", "costruisce", "prova", "cerca", "pubblica", "documenta", "riordina", "studia", "configura"]))
    var azione: String

    @Guide(description: "L'oggetto del lavoro, con l'articolo, in 2-6 parole italiane comprensibili a chiunque, ricavato dagli eventi. Niente nomi di file e niente nome del progetto.")
    var oggetto: String
}

/// The board sentence: `frase` is "Claude sta <azione al gerundio> <oggetto> di <progetto>".
struct FraseBacheca: Sendable {
    var progetto: String
    var azione: String
    var oggetto: String
    var frase: String
}

@Generable(description: "Il tipo di lavoro fatto in una sessione")
enum Categoria {
    case correzione
    case funzione
    case rilascio
    case ricerca
    case manutenzione
    case documentazione
}

@Generable(description: "La categoria di una sessione di lavoro e il perche'")
struct Classificazione {
    @Guide(description: "La categoria che descrive meglio la sessione")
    var categoria: Categoria

    @Guide(description: "Il motivo della scelta, in una frase breve in italiano")
    var motivo: String
}

enum Guidata {
    static let azioni = ["sistema", "costruisce", "prova", "cerca", "pubblica", "documenta", "riordina", "studia", "configura"]

    static let fraseInstructions = """
    Guardi gli eventi di una sessione di Claude (un assistente che programma) su un progetto e \
    dici che cosa sta facendo: un verbo dalla lista e l'oggetto del lavoro. La richiesta \
    dell'utente, se c'e', e' l'indizio migliore; poi i file modificati e i comandi. L'oggetto e' \
    in italiano semplice, con l'articolo, senza nomi di file (di' che cosa sono) e senza il nome \
    del progetto. Usa solo quello che c'e' negli eventi.
    """

    static let classificaInstructions = """
    Classifica una sessione di lavoro di uno sviluppatore a partire dal suo riassunto. Categorie: \
    correzione (si ripara un errore o un comportamento sbagliato), funzione (si costruisce qualcosa \
    di nuovo), rilascio (build, firma, pubblicazione sugli store, consegna, deploy), ricerca (si \
    studia, si confronta, si indaga senza cambiare il prodotto), manutenzione (pulizia, \
    aggiornamenti, configurazione, riordino), documentazione (si scrivono documenti, README, testi). \
    Scegli la categoria prevalente. Il motivo e' una frase breve in italiano.
    """

    /// The sentence for one session, from its latest events (the last ~12 are used).
    static func frase(eventi: [RigaBacheca], progetto: String) async throws -> FraseBacheca {
        try CervelloErrori.checkAvailable()
        guard !eventi.isEmpty else { throw NucleoError("Nessun evento della bacheca da descrivere.") }
        let sorted = eventi.sorted { $0.at < $1.at }
        var recent = Array(sorted.suffix(12))
        // The user's request says best what the object is: keep the latest one even if older.
        if !recent.contains(where: { $0.kind == "prompt" }), let p = sorted.last(where: { $0.kind == "prompt" }) {
            recent.insert(p, at: 0)
        }
        let name = progetto.isEmpty ? (sorted.last?.project ?? "") : progetto
        let prompt = """
        Progetto: \(name)
        Eventi della sessione, dal piu' vecchio al piu' recente:
        \(recent.map { "- " + $0.promptLine }.joined(separator: "\n"))

        Che cosa sta facendo Claude?
        """
        do {
            try await checkContext(prompt, instructions: fraseInstructions, reserve: 250)
            let session = Sessioni.take("frase", instructions: fraseInstructions).session
            let response = try await session.respond(to: prompt, generating: AttivitaBacheca.self,
                                                     options: GenerationOptions(temperature: 0.3, maximumResponseTokens: 80))
            return componi(response.content, progetto: name)
        } catch {
            throw CervelloErrori.translate(error)
        }
    }

    static func classifica(testo: String) async throws -> Classificazione {
        try CervelloErrori.checkAvailable()
        let clean = testo.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { throw NucleoError("Il testo da classificare e' vuoto.") }
        do {
            var body = clip(clean, 6000)
            // The window is small: measure, and cut further if the summary does not fit.
            while body.count > 800 {
                let fits = try await fitsContext("Riassunto della sessione:\n\n" + body,
                                                 instructions: classificaInstructions, reserve: 200)
                if fits { break }
                body = clip(body, body.count * 2 / 3)
            }
            let session = Sessioni.take("classify", instructions: classificaInstructions).session
            let response = try await session.respond(to: "Riassunto della sessione:\n\n" + body,
                                                     generating: Classificazione.self,
                                                     options: GenerationOptions(temperature: 0.2, maximumResponseTokens: 150))
            var c = response.content
            c.motivo = unaFrase(senzaLineette(c.motivo))
            if let f = c.motivo.first, f.isLowercase { c.motivo = f.uppercased() + c.motivo.dropFirst() }
            return c
        } catch {
            throw CervelloErrori.translate(error)
        }
    }

    static func nome(_ c: Categoria) -> String { "\(c)" }

    // MARK: - Context window

    /// True when instructions + prompt + `reserve` (answer and schema) fit the model's window.
    /// A cheap estimate first (~3 characters per token); tokenCount only near the limit.
    static func fitsContext(_ prompt: String, instructions: String, reserve: Int) async throws -> Bool {
        let model = SystemLanguageModel.default
        let context = model.contextSize > 0 ? model.contextSize : 4096
        if (prompt.count + instructions.count) / 3 + reserve < context * 6 / 10 { return true }
        let used = try await model.tokenCount(for: Instructions(instructions)) + model.tokenCount(for: prompt)
        return used + reserve <= context
    }

    static func checkContext(_ prompt: String, instructions: String, reserve: Int) async throws {
        guard try await fitsContext(prompt, instructions: instructions, reserve: reserve) else {
            throw NucleoError("Il testo e' troppo lungo per il modello sul dispositivo. Accorcialo o dividilo in parti.")
        }
    }

    // MARK: - Cleaning the events

    /// A shell command as it reads in a prompt: no `cd dir &&` prefix, no heredoc body.
    static func comando(_ raw: String) -> String {
        var c = raw.replacingOccurrences(of: "\n", with: " ")
        if let r = c.range(of: "<<") { c = String(c[..<r.lowerBound]) }
        while c.hasPrefix("cd ") {
            if let r = c.range(of: "&&") ?? c.range(of: ";") {
                c = String(c[r.upperBound...]).trimmingCharacters(in: .whitespaces)
            } else { break }
        }
        return c.trimmingCharacters(in: .whitespaces)
    }

    /// Drops XML-like tags (messages between sessions arrive wrapped in them).
    static func senzaTag(_ s: String) -> String {
        s.replacingOccurrences(of: "<[^>]{1,300}>", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Post-processing

    static let gerundi = ["sistema": "sistemando", "costruisce": "costruendo", "prova": "provando",
                          "cerca": "cercando", "pubblica": "pubblicando", "documenta": "documentando",
                          "riordina": "riordinando", "studia": "studiando", "configura": "configurando"]

    static func componi(_ a: AttivitaBacheca, progetto: String) -> FraseBacheca {
        let azione = azioni.contains(a.azione) ? a.azione : "sistema"
        var oggetto = unaFrase(senzaLineette(a.oggetto))
        while let last = oggetto.last, ".;:,".contains(last) { oggetto.removeLast() }
        // The model sometimes repeats the project at the end of the object: once is enough.
        for tail in [" di " + progetto, " della " + progetto, " del " + progetto, " in " + progetto, " " + progetto] {
            if oggetto.lowercased().hasSuffix(tail.lowercased()) { oggetto = String(oggetto.dropLast(tail.count)) }
        }
        oggetto = lowerFirst(oggetto.trimmingCharacters(in: .whitespaces))
        let verbo = gerundi[azione] ?? "lavorando su"
        var frase = oggetto.isEmpty ? "Claude sta lavorando su \(progetto)" : "Claude sta \(verbo) \(oggetto)"
        if !oggetto.isEmpty, !progetto.isEmpty {
            let conProgetto = frase + " di " + progetto
            frase = conProgetto.count <= 90 ? conProgetto : frase
        }
        if frase.count > 90 { frase = taglia(frase, 90) }
        return FraseBacheca(progetto: progetto, azione: azione, oggetto: oggetto, frase: frase)
    }

    /// U+2014 and U+2013 become commas (CLAUDE.md: never long dashes in visible text).
    static func senzaLineette(_ s: String) -> String {
        var t = s.replacingOccurrences(of: " \u{2014} ", with: ", ")
            .replacingOccurrences(of: " \u{2013} ", with: ", ")
            .replacingOccurrences(of: "\u{2014}", with: ", ")
            .replacingOccurrences(of: "\u{2013}", with: ", ")
        while t.contains(" ,") { t = t.replacingOccurrences(of: " ,", with: ",") }
        while t.contains(",,") { t = t.replacingOccurrences(of: ",,", with: ",") }
        while t.contains("  ") { t = t.replacingOccurrences(of: "  ", with: " ") }
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Only the first sentence.
    static func unaFrase(_ s: String) -> String {
        var t = s.components(separatedBy: .newlines).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
        for sep in [". ", "! ", "? "] {
            if let r = t.range(of: sep) { t = String(t[..<r.lowerBound]) + String(sep.first!) }
        }
        return t.trimmingCharacters(in: .whitespaces)
    }

    /// Cuts at a word boundary and drops a dangling connective.
    static func taglia(_ s: String, _ max: Int) -> String {
        var cut = String(s.prefix(max))
        if let space = cut.lastIndex(of: " ") { cut = String(cut[..<space]) }
        let dangling: Set<String> = ["e", "di", "del", "della", "dei", "delle", "a", "al", "alla", "in", "nel", "nella",
                                     "su", "sul", "sulla", "per", "con", "il", "lo", "la", "i", "gli", "le", "un", "una", "che"]
        var words = cut.split(separator: " ").map(String.init)
        while words.count > 1, let w = words.last,
              dangling.contains(w.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ",;:"))) {
            words.removeLast()
        }
        var out = words.joined(separator: " ")
        while let last = out.last, ",;:".contains(last) { out.removeLast() }
        return out
    }

    static func clip(_ s: String, _ n: Int) -> String {
        let t = s.replacingOccurrences(of: "\n", with: " ")
        return t.count <= n ? t : String(t.prefix(n - 1)) + "…"
    }

    /// "Il login" -> "il login", but "Xcode" and "iOS" stay as they are.
    private static func lowerFirst(_ s: String) -> String {
        let first = s.split(separator: " ").first.map(String.init) ?? ""
        let articles: Set<String> = ["Il", "Lo", "La", "I", "Gli", "Le", "Un", "Uno", "Una"]
        guard articles.contains(first) || first.hasPrefix("L'") || first.hasPrefix("Un'") else { return s }
        return s.prefix(1).lowercased() + s.dropFirst()
    }
}
