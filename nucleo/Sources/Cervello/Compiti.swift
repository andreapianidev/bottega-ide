//
//  Compiti.swift
//  Bottega Nucleo
//
//  Short guided jobs of Apple Intelligence for the sections of the Bottega: the status line
//  of a Claude session, a mail in one sentence, what changed in a project, the comment of a
//  chart (placeholders only, digits come from the data) and a two-sentence summary.
//  Every job: @Generable output, prewarmed session (Sessioni), input clipped to the measured
//  window, output cleaned (no long dashes, one sentence, capital first letter).
//
//    ai.stato {progetto, richiesta?, ultimoMessaggio?, strumenti?}   -> {riga, fase, ms}
//    ai.posta {da, oggetto, testo}                                  -> {riassunto, richiesta, scadenza, urgente, ms}
//    ai.cambiato {progetto, commit: [{oggetto, file?}]}             -> {frase, ms}
//    ai.commento {fatti: [{id, testo, valore?}]}                    -> {frase, segnaposto, riempita?, ms}
//                                                                      | error + scartata: true
//    ai.riassunto.breve {testo, tipo?: documento|posta}             -> {riassunto, tagliato, ms}
//    ai.compiti.prewarm {nomi?}                                     -> {pronti}
//

import Foundation
import FoundationModels

// MARK: - Guided outputs

@Generable(description: "In che fase e' il lavoro di Claude")
enum FaseLavoro {
    case capisce
    case scrive
    case prova
    case aspetta
    case chiude
}

@Generable(description: "La riga di stato di una sessione di lavoro")
struct StatoSessione {
    @Guide(description: "Cosa fa Claude in concreto, al presente, senza soggetto, da 4 a 10 parole: un verbo e la cosa precisa su cui lavora. Esempio: Sistema il calcolo delle ore nel cruscotto")
    var riga: String

    @Guide(description: "La fase del lavoro")
    var fase: FaseLavoro
}

@Generable(description: "Un messaggio di posta letto per Andrea")
struct LetturaPosta {
    @Guide(description: "Di cosa parla il messaggio, in una frase breve")
    var riassunto: String

    @Guide(description: "Vero solo se il mittente chiede ad Andrea di fare una cosa concreta (rispondere a una domanda, pagare, mandare, decidere); falso se informa, ringrazia, conferma, allega o rifiuta")
    var chiedeQualcosa: Bool

    @Guide(description: "Se chiede qualcosa: cosa deve fare Andrea, all'infinito, in una frase breve; altrimenti la parola nulla")
    var richiesta: String

    @Guide(description: "La scadenza o la data scritta nel messaggio, con le stesse parole del messaggio, oppure la parola nessuna")
    var scadenza: String

    @Guide(description: "Vero solo se il messaggio chiede di fare qualcosa entro oggi o domani, o parla di un problema grave in corso")
    var urgente: Bool
}

@Generable(description: "Cosa e' cambiato in un progetto")
struct FraseCambiato {
    @Guide(description: "Una sola frase in italiano, da 8 a 25 parole, senza elenchi, che dice cosa e' cambiato nel progetto")
    var frase: String
}

@Generable(description: "Il commento a un grafico")
struct FraseCommento {
    @Guide(description: "Una frase breve in italiano che commenta i fatti usando i segnaposto tra graffe, senza mai scrivere numeri")
    var frase: String
}

@Generable(description: "Un riassunto breve")
struct RiassuntoBreve {
    @Guide(description: "Il riassunto, una o due frasi in italiano")
    var riassunto: String
}

// MARK: - Jobs

enum Compiti {
    static let nomi = ["stato", "posta", "cambiato", "commento", "riassunto"]

    /// Instructions replaced from the test CLI (`--istruzioni file`), never in the service.
    nonisolated(unsafe) static var prova: [String: String] = [:]

    // MARK: stato

    static var statoInstructions: String { prova["stato"] ?? statoBase }

    static let statoBase = """
    Scrivi la riga di stato di una sessione di Claude Code che lavora per Andrea: cosa sta facendo Claude, al presente, in terza persona, senza soggetto, da 4 a 10 parole.
    La fonte principale e' l'ultimo messaggio di Claude, che e' piu' recente della richiesta di Andrea: cerca la frase che dice cosa ha fatto o cosa sta facendo (spesso comincia con "Ho" oppure segue "Fatto") e riscrivila al presente, tenendo la cosa precisa su cui lavora. La richiesta di Andrea serve solo se il messaggio non dice abbastanza.
    Esempi di forma, non di contenuto:
    "Fatto. Ho aggiunto il filtro per data nella lista delle fatture." diventa "Aggiunge il filtro per data alle fatture".
    "Fatto, provato. Come funziona: il login con Google ora passa dal nuovo callback." diventa "Ripara il login con Google".
    "Ti ho preparato la bozza della mail al commercialista." diventa "Prepara la bozza per il commercialista".
    Usa solo parole e cose che compaiono nel testo dato, non copiare gli esempi, non inventare. Mai parole vuote come "il file", "il codice", "la funzione", e niente numeri se non servono.
    Fase: capisce se legge, cerca o studia; scrive se cambia codice o testi; prova se compila, prova o misura; aspetta se fa una domanda ad Andrea o aspetta una sua risposta; chiude se il messaggio dice che il lavoro e' fatto, pubblicato o consegnato.
    """

    struct Stato { let riga: String; let fase: String }

    static func stato(progetto: String, richiesta: String?, ultimoMessaggio: String?, strumenti: [String]) async throws -> Stato {
        let ultimo = pulisciMessaggio(ultimoMessaggio ?? "")
        let rich = pulisciRichiesta(richiesta ?? "")
        guard !ultimo.isEmpty || !rich.isEmpty else {
            throw NucleoError("Servono la richiesta o l'ultimo messaggio di Claude per la riga di stato.")
        }
        if let fisso = statoFisso(ultimo) { return fisso }
        var ultimoBudget = 600, richBudget = 300
        var prompt = ""
        while true {
            var p = "Progetto: \(progetto.isEmpty ? "?" : progetto)\n"
            if !rich.isEmpty { p += "Ultima richiesta di Andrea: \"\(Guidata.clip(rich, richBudget))\"\n" }
            if !ultimo.isEmpty { p += "Ultimo messaggio di Claude: \"\(Guidata.clip(ultimo, ultimoBudget))\"\n" }
            let tools = strumenti.suffix(6).filter { !$0.isEmpty }
            if !tools.isEmpty { p += "Strumenti usati per ultimi: \(tools.joined(separator: ", "))\n" }
            prompt = p
            if ultimoBudget <= 300 { break }
            if try await Guidata.fitsContext(prompt, instructions: statoInstructions, reserve: 250) { break }
            ultimoBudget = ultimoBudget * 2 / 3; richBudget = max(200, richBudget * 2 / 3)
        }
        let out: StatoSessione = try await genera("stato", statoInstructions, prompt, reserve: 250, maxTokens: 80, temperature: 0.2)
        var riga = rifinisci(out.riga, punto: false)
        for prefix in ["Claude sta ", "Claude ", "Sta "] where riga.hasPrefix(prefix) {
            riga = maiuscola(String(riga.dropFirst(prefix.count)))
        }
        if riga.count > 70 { riga = Guidata.taglia(riga, 70) }
        guard riga.split(separator: " ").count >= 3, !riga.hasPrefix("Ha ") else {
            throw NucleoError("Apple Intelligence ha dato una riga di stato vuota (\(out.riga)).")
        }
        return Stato(riga: riga, fase: "\(out.fase)")
    }

    /// Sessions stopped by a limit or an API error: no model needed (and it would guess).
    static func statoFisso(_ ultimo: String) -> Stato? {
        let low = ultimo.lowercased()
        if low.contains("hit your session limit") || low.contains("hit your usage limit") || low.contains("limite di utilizzo")
            || low.contains("session limit") {
            return Stato(riga: "Fermo per il limite di utilizzo", fase: "aspetta")
        }
        if low.hasPrefix("api error") || low.contains("organization has disabled") {
            return Stato(riga: "Fermo per un errore del servizio di Claude", fase: "aspetta")
        }
        return nil
    }

    /// The assistant text as it reads in a prompt: no markdown, no code blocks, no tags.
    static func pulisciMessaggio(_ s: String) -> String {
        var t = s.replacingOccurrences(of: "```[\\s\\S]*?```", with: " ", options: .regularExpression)
        t = t.replacingOccurrences(of: "<system-reminder>[\\s\\S]*?</system-reminder>", with: " ", options: .regularExpression)
        t = Guidata.senzaTag(t)
        t = t.replacingOccurrences(of: "[*`#|>]+", with: " ", options: .regularExpression)
        t = t.replacingOccurrences(of: "\\[Image #\\d+\\]", with: " ", options: .regularExpression)
        t = t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return Guidata.senzaLineette(t)
    }

    /// The user turn: background notifications become their summary, messages between
    /// sessions lose the wrapping tag and keep the content, reminders disappear.
    static func pulisciRichiesta(_ s: String) -> String {
        var t = s
        if t.contains("<task-notification>") {
            if let r = t.range(of: "<summary>[\\s\\S]*?</summary>", options: .regularExpression) {
                t = "Notifica di un lavoro in background: " + String(t[r])
            } else {
                t = "Notifica di un lavoro in background."
            }
        }
        t = t.replacingOccurrences(of: "<system-reminder>[\\s\\S]*?</system-reminder>", with: " ", options: .regularExpression)
        return pulisciMessaggio(t)
    }

    // MARK: posta

    static var postaInstructions: String { prova["posta"] ?? postaBase }

    static let postaBase = """
    Leggi un messaggio di posta arrivato ad Andrea, uno sviluppatore che vende software e servizi. Conta solo il testo scritto dal mittente, in alto: sotto ci puo' essere il vecchio messaggio di Andrea a cui il mittente risponde, e quello non va riassunto.
    riassunto: una frase che dice chi scrive (il cliente, la banca, il servizio, con il nome se c'e') e cosa dice. Se il mittente rifiuta un'offerta, dillo.
    richiesta: la cosa concreta che il mittente chiede ad Andrea di fare, in una frase di almeno quattro parole presa dal messaggio. Scrivi nulla se il mittente informa, ringrazia, conferma, allega, rifiuta o non chiede niente: e' il caso piu' comune. Newsletter, notifiche automatiche e ricevute: nulla.
    scadenza: copia la data entro cui il mittente chiede qualcosa o dopo cui cambia qualcosa; nessuna se non c'e'. Non inventare date.
    urgente: vero solo se il mittente chiede di fare qualcosa entro oggi o domani, o segnala un problema grave in corso. Le offerte, i rifiuti e le notifiche non sono mai urgenti.
    Scrivi in italiano anche se il messaggio e' in un'altra lingua. Usa solo cose scritte nel messaggio.
    """

    struct Posta { let riassunto: String; let richiesta: String?; let scadenza: String?; let urgente: Bool }

    static func posta(da: String, oggetto: String, testo: String) async throws -> Posta {
        let corpo = senzaCitazioni(testo)
        guard !corpo.isEmpty || !oggetto.isEmpty else { throw NucleoError("Il messaggio e' vuoto.") }
        var budget = 2500
        var prompt = ""
        while true {
            prompt = "Da: \(Guidata.clip(da, 120))\nOggetto: \(Guidata.clip(oggetto, 200))\n\n\(Guidata.clip(corpo, budget))"
            if budget <= 500 { break }
            if try await Guidata.fitsContext(prompt, instructions: postaInstructions, reserve: 300) { break }
            budget = budget * 2 / 3
        }
        let out: LetturaPosta = try await genera("posta", postaInstructions, prompt, reserve: 300, maxTokens: 200, temperature: 0.1)
        let riassunto = rifinisci(out.riassunto, punto: true)
        var richiesta: String? = out.chiedeQualcosa ? rifinisci(out.richiesta, punto: true) : nil
        if let r = richiesta, vuoto(r, ["nulla", "niente", "nessuna", "nessuno", "null", "nil"]) { richiesta = nil }
        // A request must be a real sentence about things written in the mail.
        if let r = richiesta, r.split(separator: " ").count < 3 || !aderente(r, a: oggetto + " " + corpo)
            || r.lowercased().contains("nulla") || r.lowercased().contains("niente") { richiesta = nil }
        var scadenza: String? = Guidata.senzaLineette(out.scadenza).trimmingCharacters(in: CharacterSet(charactersIn: " ."))
        if let s = scadenza, vuoto(s, ["nessuna", "nessuno", "nulla", "niente", "null", "nil"]) { scadenza = nil }
        // A deadline must come from the text: every number in it must be in the mail.
        if let s = scadenza, !radicata(s, in: oggetto + " " + corpo) || !sembraData(s) { scadenza = nil }
        guard !riassunto.isEmpty else { throw NucleoError("Apple Intelligence ha dato un riassunto vuoto.") }
        return Posta(riassunto: riassunto, richiesta: richiesta, scadenza: scadenza, urgente: out.urgente)
    }

    /// Drops quoted replies, forwarded history and long footers.
    static func senzaCitazioni(_ s: String) -> String {
        var out: [String] = []
        for raw in s.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix(">") { continue }
            let low = line.lowercased()
            if (low.hasPrefix("il giorno") && low.contains("ha scritto")) || (low.hasPrefix("on ") && low.hasSuffix("wrote:"))
                || low.hasPrefix("-----original message") || low.hasPrefix("---------- forwarded") || low == "--"
                || ((low.hasPrefix("de:") || low.hasPrefix("from:") || low.hasPrefix("da:"))
                    && (low.contains("enviado") || low.contains("sent:") || low.contains("inviato")))
                || low.hasPrefix("advertencia legal") || low.hasPrefix("legal warning") || low.hasPrefix("avvertenza legale") {
                break
            }
            out.append(line)
        }
        return out.joined(separator: "\n")
            .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: cambiato

    static var cambiatoInstructions: String { prova["cambiato"] ?? cambiatoBase }

    static let cambiatoBase = """
    Ti do i commit recenti di un progetto software di Andrea, dal piu' recente al piu' vecchio. Scrivi una sola frase in italiano, da 12 a 25 parole, che dice cosa e' cambiato nel progetto.
    Prima leggi tutti i commit, poi scegli le due o tre novita' piu' grandi per chi usa il prodotto (funzioni nuove, prezzi e abbonamenti, correzioni visibili) e mettile nella frase con le parole dei commit. Le note interne (documenti, TODO, CLAUDE.md, intestazioni) contano solo se non c'e' altro.
    Riporta i fatti esattamente come sono scritti: se un commit aggiunge qualcosa non dire che l'ha tolto, e viceversa. Niente frasi di riempimento come "per migliorare l'esperienza" o "per garantire sicurezza", niente elenchi, niente nomi di file. Se i commit sono in un'altra lingua, scrivi comunque in italiano.
    """

    static func cambiato(progetto: String, commit: [(oggetto: String, file: [String])]) async throws -> String {
        let righe = commit.map { c -> String in
            var r = "- " + Guidata.clip(pulisciCommit(c.oggetto), 200)
            let f = c.file.prefix(4).map { ($0 as NSString).lastPathComponent }
            if !f.isEmpty { r += " (file: \(f.joined(separator: ", "))\(c.file.count > 4 ? ", ..." : ""))" }
            return r
        }.filter { $0.count > 2 }
        guard !righe.isEmpty else { throw NucleoError("Nessun commit da raccontare.") }
        var n = min(righe.count, 40)
        var prompt = ""
        while true {
            prompt = "Progetto: \(progetto)\nCommit, dal piu' recente:\n" + righe.prefix(n).joined(separator: "\n")
            if n <= 5 { break }
            if try await Guidata.fitsContext(prompt, instructions: cambiatoInstructions, reserve: 200) { break }
            n = n * 2 / 3
        }
        // A list glued with colons and semicolons is not a sentence: one more try, a bit warmer.
        var frase = ""
        var forma = false
        for tentativo in 0..<2 {
            let p = tentativo == 0 ? prompt
                : prompt + "\n\nScrivi una frase normale in italiano, con parole tue: niente due punti, niente punto e virgola."
            let out: FraseCambiato = try await genera("cambiato", cambiatoInstructions, p, reserve: 200, maxTokens: 120,
                                                      temperature: tentativo == 0 ? 0.2 : 0.5)
            frase = rifinisci(out.frase, punto: true)
            forma = !frase.contains(";") && !frase.contains(":") && frase.split(separator: " ").count >= 8
            if forma { break }
        }
        guard forma else { throw NucleoError("Apple Intelligence non ha scritto una frase sola: cambiamenti non riassunti.") }
        let parole = frase.split(separator: " ")
        if parole.count > 25 { frase = Guidata.taglia(frase, parole.prefix(25).joined(separator: " ").count) + "." }
        guard frase.split(separator: " ").count >= 5 else { throw NucleoError("Apple Intelligence ha dato una frase troppo corta.") }
        return frase
    }

    /// A commit subject without build numbers, emoji, signatures and CI markers.
    static func pulisciCommit(_ s: String) -> String {
        var t = s.replacingOccurrences(of: "\\[ci skip\\]|\\[skip ci\\]", with: " ", options: [.regularExpression, .caseInsensitive])
        t = t.replacingOccurrences(of: "(-\\s*)?Sviluppato da \\[[^\\]]*\\]?.*$", with: " ", options: .regularExpression)
        t = t.replacingOccurrences(of: "[,(]?\\s*\\(?build \\d+\\)?", with: " ", options: [.regularExpression, .caseInsensitive])
        t = t.replacingOccurrences(of: ",?\\s*bump to [0-9.]+( \\(\\d+\\))?", with: " ", options: [.regularExpression, .caseInsensitive])
        t = String(String.UnicodeScalarView(t.unicodeScalars.filter {
            $0.value < 0x80 || !($0.properties.isEmojiPresentation || ($0.properties.isEmoji && $0.value > 0x2000))
        }))
        t = t.replacingOccurrences(of: "\u{FE0F}", with: "")
        t = Guidata.senzaLineette(t).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return t.trimmingCharacters(in: CharacterSet(charactersIn: " ,;:-"))
    }

    // MARK: commento

    static var commentoInstructions: String { prova["commento"] ?? commentoBase }

    static let commentoBase = """
    Scrivi il commento a un grafico del cruscotto di Andrea, in una sola frase breve e naturale in italiano, senza due \
    punti e senza punto e virgola. Ti do dei fatti, ognuno con il suo segnaposto tra graffe. Nella frase non scrivere MAI \
    numeri, cifre, percentuali o quantita' a parole: dove serve un valore scrivi il segnaposto, per esempio "Questa \
    settimana {ore} di lavoro, soprattutto su {primo}". Usa solo i segnaposto dei fatti dati, scritti identici, al massimo \
    tre. Non fare confronti che i fatti non dicono. Non inventare fatti.
    """

    struct Commento { let frase: String; let segnaposto: [String]; let riempita: String? }

    struct CommentoScartato: Error { let motivo: String; let frase: String }

    static func commento(fatti: [(id: String, testo: String, valore: String?)]) async throws -> Commento {
        let validi = fatti.filter { !$0.id.isEmpty && !$0.testo.isEmpty }
        guard !validi.isEmpty else { throw NucleoError("Servono dei fatti {id, testo} per il commento.") }
        // The digits never reach the model: comparisons must be written in words by the caller.
        let righe = validi.prefix(12).map { "- {\($0.id)} = \(senzaCifre($0.testo))" }
        let prompt = "Fatti:\n" + righe.joined(separator: "\n")
        try await Guidata.checkContext(prompt, instructions: commentoInstructions, reserve: 150)
        var frase = ""
        for tentativo in 0..<2 {
            let p = tentativo == 0 ? prompt : prompt + "\n\nUna frase normale: niente due punti, niente punto e virgola."
            let out: FraseCommento = try await genera("commento", commentoInstructions, p, reserve: 150, maxTokens: 100,
                                                      temperature: tentativo == 0 ? 0.3 : 0.5)
            frase = rifinisci(out.frase, punto: true)
            if !frase.contains(":"), !frase.contains(";") { break }
        }
        if frase.contains(":") || frase.contains(";") {
            throw CommentoScartato(motivo: "Il commento non e' una frase sola.", frase: frase)
        }
        let ids = Set(validi.map(\.id))
        let usati = segnaposto(in: frase)
        if frase.range(of: "[0-9]", options: .regularExpression) != nil {
            throw CommentoScartato(motivo: "Il modello ha scritto delle cifre nel commento.", frase: frase)
        }
        if let parola = numeroAParole(frase) {
            throw CommentoScartato(motivo: "Il modello ha scritto una quantita' a parole (\(parola)).", frase: frase)
        }
        if usati.isEmpty {
            throw CommentoScartato(motivo: "Il commento non usa nessun segnaposto.", frase: frase)
        }
        if let ignoto = usati.first(where: { !ids.contains($0) }) {
            throw CommentoScartato(motivo: "Il commento usa un segnaposto che non esiste: {\(ignoto)}.", frase: frase)
        }
        var riempita: String? = frase
        for id in usati {
            guard let v = validi.first(where: { $0.id == id })?.valore, !v.isEmpty else { riempita = nil; break }
            riempita = riempita?.replacingOccurrences(of: "{\(id)}", with: v)
        }
        return Commento(frase: frase, segnaposto: usati, riempita: riempita)
    }

    static func segnaposto(in s: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: "\\{([^{}\\s]{1,40})\\}") else { return [] }
        var seen: [String] = []
        for m in re.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
            if let r = Range(m.range(at: 1), in: s), !seen.contains(String(s[r])) { seen.append(String(s[r])) }
        }
        return seen
    }

    /// The fact without its value: "ore di lavoro: 23 h" -> "ore di lavoro"; other numbers become "…".
    static func senzaCifre(_ s: String) -> String {
        var t = s.replacingOccurrences(of: "[:=]\\s*[0-9][^,;]*", with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: "[0-9]+([.,][0-9]+)?\\s*%?", with: "…", options: .regularExpression)
        return t.trimmingCharacters(in: .whitespaces)
    }

    /// Quantities written in words (outside placeholders); "un"/"una"/"sei" are left alone.
    static func numeroAParole(_ s: String) -> String? {
        let fuori = s.replacingOccurrences(of: "\\{[^}]*\\}", with: " ", options: .regularExpression).lowercased()
        let numeri: Set<String> = ["due", "tre", "quattro", "cinque", "sette", "otto", "nove", "dieci", "undici", "dodici",
                                   "venti", "trenta", "quaranta", "cinquanta", "sessanta", "cento", "mille", "doppio",
                                   "triplo", "meta'", "metà", "percento", "dozzina", "decina", "centinaia", "milioni", "milione",
                                   "miliardi", "migliaia"]
        let parole = fuori.components(separatedBy: CharacterSet.letters.union(CharacterSet(charactersIn: "'")).inverted)
        return parole.first { numeri.contains($0) }
    }

    // MARK: riassunto breve

    static func riassuntoInstructions(_ tipo: String?) -> String {
        if let p = prova["riassunto"] { return p }
        let cosa = tipo == "posta" ? "un messaggio di posta" : (tipo == "documento" ? "un documento" : "un testo")
        return """
        Riassumi \(cosa) per Andrea in una o due frasi brevi in italiano: di cosa si tratta e la \
        cosa piu' importante da sapere. Solo fatti scritti nel testo, niente elenchi, niente \
        introduzioni come "il testo parla di".
        """
    }

    struct Riassunto { let riassunto: String; let tagliato: Bool }

    static func riassunto(testo: String, tipo: String?) async throws -> Riassunto {
        let clean = testo.replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { throw NucleoError("Il testo da riassumere e' vuoto.") }
        let instr = riassuntoInstructions(tipo)
        // One window, never pieces: long summaries stay with Agnes.
        var body = String(clean.prefix(20000))
        var tagliato = body.count < clean.count
        while body.count > 600 {
            if try await Guidata.fitsContext("Testo:\n\n" + body, instructions: instr, reserve: 300) { break }
            body = String(body.prefix(body.count * 3 / 4)); tagliato = true
        }
        let out: RiassuntoBreve = try await genera("riassunto", instr, "Testo:\n\n" + body, reserve: 300, maxTokens: 240, temperature: 0.2)
        var r = Guidata.senzaLineette(out.riassunto).replacingOccurrences(of: "\n", with: " ")
        r = dueFrasi(r)
        guard !r.isEmpty else { throw NucleoError("Apple Intelligence ha dato un riassunto vuoto.") }
        return Riassunto(riassunto: maiuscola(r), tagliato: tagliato)
    }

    // MARK: - Shared

    static func instructions(for nome: String) -> String? {
        switch nome {
        case "stato": return statoInstructions
        case "posta": return postaInstructions
        case "cambiato": return cambiatoInstructions
        case "commento": return commentoInstructions
        case "riassunto": return riassuntoInstructions(nil)
        default: return nil
        }
    }

    static func prewarm(_ nomi: [String]) -> [String] {
        guard Intelligence.isAvailable else { return [] }
        var pronti: [String] = []
        for n in nomi { if let i = instructions(for: n) { Sessioni.prewarm("compito." + n, instructions: i); pronti.append(n) } }
        return pronti
    }

    private static func genera<T: Generable>(_ kind: String, _ instructions: String, _ prompt: String,
                                            reserve: Int, maxTokens: Int, temperature: Double) async throws -> T {
        try CervelloErrori.checkAvailable()
        do {
            try await Guidata.checkContext(prompt, instructions: instructions, reserve: reserve)
            let session = Sessioni.take("compito." + kind, instructions: instructions).session
            let response = try await session.respond(to: prompt, generating: T.self,
                                                     options: GenerationOptions(temperature: temperature,
                                                                                maximumResponseTokens: maxTokens))
            return response.content
        } catch {
            throw CervelloErrori.translate(error)
        }
    }

    /// No long dashes, one sentence, capital first letter, final period on demand.
    static func rifinisci(_ s: String, punto: Bool) -> String {
        var t = Guidata.unaFrase(Guidata.senzaLineette(s.replacingOccurrences(of: "\"", with: "")))
        t = t.trimmingCharacters(in: CharacterSet(charactersIn: " ,;:"))
        while let last = t.last, ".!?".contains(last) { t.removeLast() }
        t = maiuscola(t.trimmingCharacters(in: .whitespaces))
        if punto, !t.isEmpty { t += "." }
        return t
    }

    static func dueFrasi(_ s: String) -> String {
        var out = "", count = 0
        var current = ""
        for ch in s {
            current.append(ch)
            if ".!?".contains(ch) {
                out += current; current = ""; count += 1
                if count == 2 { break }
            }
        }
        if count < 2 { out += current }
        return out.trimmingCharacters(in: .whitespaces)
    }

    static func maiuscola(_ s: String) -> String {
        guard let f = s.first, f.isLowercase else { return s }
        return f.uppercased() + s.dropFirst()
    }

    private static func vuoto(_ s: String, _ parole: [String]) -> Bool {
        let t = s.lowercased().trimmingCharacters(in: CharacterSet.letters.inverted)
        return t.isEmpty || parole.contains(t) || parole.contains { t.hasPrefix($0 + " ") && t.count < $0.count + 12 }
    }

    /// A date or a deadline: a digit, or a word of time (oggi, venerdi', settembre, entro...).
    static func sembraData(_ s: String) -> Bool {
        if s.rangeOfCharacter(from: .decimalDigits) != nil { return true }
        let low = s.lowercased().folding(options: .diacriticInsensitive, locale: nil)
        let parole = ["oggi", "domani", "dopodomani", "stasera", "lunedi", "martedi", "mercoledi", "giovedi", "venerdi",
                      "sabato", "domenica", "settimana", "mese", "gennaio", "febbraio", "marzo", "aprile", "maggio",
                      "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre", "entro", "scadenza",
                      "fine anno", "natale", "pasqua"]
        return parole.contains { low.contains($0) }
    }

    /// True when at least half of the content words of `s` (5+ letters, prefix of 5) are in `source`.
    static func aderente(_ s: String, a source: String) -> Bool {
        let src = source.lowercased().folding(options: .diacriticInsensitive, locale: nil)
        let words = s.lowercased().folding(options: .diacriticInsensitive, locale: nil)
            .components(separatedBy: CharacterSet.letters.inverted).filter { $0.count >= 5 }
        guard !words.isEmpty else { return true }
        let hit = words.filter { src.contains(String($0.prefix(5))) }.count
        return hit * 2 >= words.count
    }

    /// True when every number of `s` is in `source` and at least one word or number of `s` is too.
    static func radicata(_ s: String, in source: String) -> Bool {
        let src = source.lowercased()
        let numbers = s.components(separatedBy: CharacterSet.decimalDigits.inverted).filter { !$0.isEmpty }
        if numbers.contains(where: { !src.contains($0) }) { return false }
        let words = s.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { $0.count >= 4 }
        return !numbers.isEmpty || words.contains { src.contains($0) }
    }
}

// MARK: - Commands

@MainActor
enum CompitiComandi {
    static let commands: Set<String> = ["ai.stato", "ai.posta", "ai.cambiato", "ai.commento", "ai.riassunto.breve",
                                        "ai.compiti.prewarm"]

    static func handle(_ r: Request) async throws -> Bool {
        guard commands.contains(r.cmd) else { return false }
        let start = Date()
        do {
            var out = try await esegui(r.cmd, r.args)
            out["ms"] = Int(Date().timeIntervalSince(start) * 1000)
            r.respond(out)
        } catch let e as Compiti.CommentoScartato {
            Out.line(["id": r.id, "ok": false, "error": e.motivo, "scartata": true, "frase": e.frase])
        } catch {
            let e = CervelloErrori.translate(error)
            var out: [String: Any?] = ["id": r.id, "ok": false, "error": e.message]
            if e.unavailable { out["unavailable"] = true }
            Out.line(out)
        }
        return true
    }

    /// One job from its JSON arguments (shared by the service and the CLI).
    nonisolated static func esegui(_ cmd: String, _ a: [String: Any]) async throws -> [String: Any?] {
        func s(_ k: String) -> String { (a[k] as? String) ?? "" }
        switch cmd {
        case "ai.stato":
            let tools = (a["strumenti"] as? [Any])?.map { "\($0)" } ?? []
            let st = try await Compiti.stato(progetto: s("progetto"), richiesta: a["richiesta"] as? String,
                                             ultimoMessaggio: a["ultimoMessaggio"] as? String, strumenti: tools)
            return ["riga": st.riga, "fase": st.fase]
        case "ai.posta":
            let p = try await Compiti.posta(da: s("da"), oggetto: s("oggetto"), testo: s("testo"))
            return ["riassunto": p.riassunto, "richiesta": p.richiesta, "scadenza": p.scadenza, "urgente": p.urgente]
        case "ai.cambiato":
            let commit = ((a["commit"] as? [[String: Any]]) ?? []).map { c in
                ((c["oggetto"] as? String) ?? "", ((c["file"] as? [Any]) ?? []).map { "\($0)" })
            }
            return ["frase": try await Compiti.cambiato(progetto: s("progetto"), commit: commit)]
        case "ai.commento":
            let fatti = ((a["fatti"] as? [[String: Any]]) ?? []).map { f in
                ((f["id"].map { "\($0)" }) ?? "", (f["testo"] as? String) ?? "", f["valore"].flatMap { $0 is NSNull ? nil : "\($0)" })
            }
            let c = try await Compiti.commento(fatti: fatti)
            return ["frase": c.frase, "segnaposto": c.segnaposto, "riempita": c.riempita]
        case "ai.riassunto.breve":
            let r = try await Compiti.riassunto(testo: s("testo"), tipo: a["tipo"] as? String)
            return ["riassunto": r.riassunto, "tagliato": r.tagliato]
        case "ai.compiti.prewarm":
            let nomi = (a["nomi"] as? [Any])?.map { "\($0)" } ?? Compiti.nomi
            return ["pronti": Compiti.prewarm(nomi)]
        default:
            throw NucleoError("Compito sconosciuto: \(cmd)")
        }
    }
}

/// `--cli compito <stato|posta|cambiato|commento|riassunto> [--istruzioni file]`: JSON on stdin (one object, or one
/// per line), one JSON line out per input with `ms`. Exit 2 without Apple Intelligence.
enum CompitiCLI {
    static func run(_ args: [String]) -> Int32? {
        guard args.first == "compito" else { return nil }
        Out.enabled = false
        guard args.count >= 2, Compiti.nomi.contains(args[1]) else {
            FileHandle.standardError.write(Data("uso: --cli compito <\(Compiti.nomi.joined(separator: "|"))>  < JSON\n".utf8))
            return 64
        }
        let cmd = args[1] == "riassunto" ? "ai.riassunto.breve" : "ai." + args[1]
        if let i = args.firstIndex(of: "--istruzioni"), i + 1 < args.count {
            guard let t = try? String(contentsOfFile: args[i + 1], encoding: .utf8) else {
                FileHandle.standardError.write(Data("nucleo: non leggo \(args[i + 1]).\n".utf8)); return 64
            }
            Compiti.prova[args[1]] = t.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let raw = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
        var inputs: [[String: Any]] = []
        if let d = raw.data(using: .utf8), let one = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            inputs = [one]
        } else {
            inputs = raw.components(separatedBy: "\n").compactMap { line in
                line.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            }
        }
        guard !inputs.isEmpty else {
            FileHandle.standardError.write(Data("nucleo: serve un oggetto JSON su stdin.\n".utf8))
            return 64
        }
        let lista = inputs
        return VistaCLI.attendi {
            var failed = 0
            for input in lista {
                let start = Date()
                var out: [String: Any?]
                do {
                    out = try await CompitiComandi.esegui(cmd, input)
                } catch let e as Compiti.CommentoScartato {
                    out = ["error": e.motivo, "scartata": true, "frase": e.frase]; failed += 1
                } catch {
                    let e = CervelloErrori.translate(error)
                    if e.unavailable { throw e }
                    out = ["error": e.message]; failed += 1
                }
                if let id = input["id"] { out["id"] = id }
                out["ms"] = Int(Date().timeIntervalSince(start) * 1000)
                print(JSON.encode(out)); fflush(stdout)
            }
            return failed == lista.count ? 1 : 0
        }
    }
}
