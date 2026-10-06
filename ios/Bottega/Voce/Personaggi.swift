//
//  Personaggi.swift
//  Bottega per iPhone
//
//  Darlene, Elliot e Krista: i personaggi di Mr. Robot a cui Melissa passa la chiamata. Un file ciascuno in
//  extensions/bottega-home/personaggi/, la fonte unica anche per la mod melissa e per la barra della Bottega: la build
//  li mette nell'app (project.yml). Qui si leggono, con le regole su chi entra. Il giro sta in Melissa.swift.
//

import Foundation

/// Un file di personaggi/ (personaggi/LEGGIMI.md).
struct Personaggio: Equatable, Decodable {
    let chiave: String
    let nome: String
    let ordine: Int
    /// ID della voce ElevenLabs dell'account di Andrea: senza la sua chiave non serve a niente
    let voce: String
    let carattere: String
    let saluti: [String]
    /// a cosa serve nella chiacchierata (il nome, se il file non lo dice)
    let ruolo: String
    /// espressione regolare: se Andrea la dice, Melissa tira dentro questo personaggio ("" mai, o se non e' valida)
    let parole: String

    private enum CodingKeys: String, CodingKey { case chiave, nome, ordine, voce, carattere, saluti, ruolo, parole }

    /// Gli stessi campi facoltativi della mod e della Bottega: un file senza `ruolo` o `parole` funziona ovunque.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chiave = try c.decode(String.self, forKey: .chiave)
        nome = try c.decode(String.self, forKey: .nome)
        ordine = try c.decodeIfPresent(Int.self, forKey: .ordine) ?? 99
        voce = try c.decodeIfPresent(String.self, forKey: .voce) ?? ""
        carattere = try c.decode(String.self, forKey: .carattere)
        saluti = try c.decode([String].self, forKey: .saluti)
        let r = try c.decodeIfPresent(String.self, forKey: .ruolo) ?? ""
        ruolo = r.isEmpty ? nome : r
        let p = try c.decodeIfPresent(String.self, forKey: .parole) ?? ""
        parole = (try? NSRegularExpression(pattern: p)) != nil ? p : ""
    }
}

enum Personaggi {
    /// Letti una volta dai file inclusi nell'app; nei test dalla cartella in BOTTEGA_PERSONAGGI.
    static let tutti: [String: Personaggio] = carica()

    /// In ordine, come li elenca Melissa.
    static let ordine: [String] = tutti.values.sorted { $0.ordine < $1.ordine }.map(\.chiave)

    static func carica() -> [String: Personaggio] {
        let cartella = ProcessInfo.processInfo.environment["BOTTEGA_PERSONAGGI"].map { URL(fileURLWithPath: $0) }
            ?? Bundle.main.url(forResource: "personaggi", withExtension: nil)
        guard let cartella, let file = try? FileManager.default.contentsOfDirectory(at: cartella, includingPropertiesForKeys: nil)
        else { return [:] }
        var tutti: [String: Personaggio] = [:]
        for url in file where url.pathExtension == "json" {
            // chiave minuscola come nella mod e nella Bottega: e' anche il segnale @chiave
            guard let data = try? Data(contentsOf: url), let p = try? JSONDecoder().decode(Personaggio.self, from: data),
                  p.chiave.range(of: "^[a-z]+$", options: .regularExpression) != nil, !p.saluti.isEmpty else { continue }
            tutti[p.chiave] = p
        }
        return tutti
    }

    /// Le regole che ogni personaggio rispetta, qualunque carattere abbia: voce, verita', lingua.
    static let regole = "Non hai strumenti e non vedi file, progetti o sessioni; quello che non sai lo dici, non inventi mai. " +
        "Parli sempre e solo in italiano. Tutto viene letto ad alta voce: frasi parlate, niente markdown, elenchi, emoji, " +
        "asterischi, niente lineette lunghe."

    /// Il nome da mostrare per chi parla: "melissa" o la chiave di un personaggio.
    static func nome(_ chi: String) -> String { tutti[chi]?.nome ?? "Melissa" }

    /// I nomi per le espressioni regolari, e da un nome detto alla chiave.
    private static var nomi: String {
        ordine.compactMap { tutti[$0].map { NSRegularExpression.escapedPattern(for: $0.nome.lowercased()) } }.joined(separator: "|")
    }
    private static func chiaveDi(_ nome: String) -> String? { ordine.first { tutti[$0]?.nome.lowercased() == nome.lowercased() } }

    private static func primo(_ schema: String, in testo: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: schema, options: .caseInsensitive),
              let m = re.firstMatch(in: testo, range: NSRange(testo.startIndex..., in: testo)),
              let r = Range(m.range(at: 1), in: testo) else { return nil }
        return testo[r].lowercased()
    }

    /// "passami Darlene", "fammi parlare con Elliot", "ridammi Melissa": a chi passare la chiamata, o nil.
    static func chiChiede(_ testo: String) -> String? {
        guard let chi = primo("\\b(?:passami|passa|fammi parlare con|voglio parlare con|ridammi|torna|chiama)\\s+(?:a\\s+)?(melissa|\(nomi)|mr\\.?\\s*robot)\\b", in: testo)
        else { return nil }
        if chi == "melissa" { return chi }
        return chi.hasPrefix("mr") ? chiaveDi("elliot") : chiaveDi(chi)
    }

    /// "chiedi a Darlene", "sentiamo Elliot", "cosa ne pensa Krista": chi Andrea vuole sentire anche.
    static func ospiteChiesto(_ testo: String) -> String? {
        primo("\\b(?:chiedi(?:lo)? a|chiedete a|sentiamo(?: anche)?|senti(?: anche)?|cosa ne pensa|che ne pensa|e tu)\\s+(\(nomi))\\b", in: testo)
            .flatMap(chiaveDi)
    }

    /// La frase senza il segnale "@darlene", che non si legge mai ad alta voce, ovunque Melissa l'abbia messo.
    static func senzaSegnale(_ testo: String) -> String {
        let chiavi = ordine.isEmpty ? "darlene|elliot|krista" : ordine.joined(separator: "|")
        var t = testo.replacingOccurrences(of: "\\s*@(?:\(chiavi))\\b[.!?]?", with: "",
                                           options: [.regularExpression, .caseInsensitive])
        // un segnale ancora a meta' in coda, mentre la risposta arriva ("@dar"), non si vede
        t = t.replacingOccurrences(of: "\\s*@[a-z]*$", with: "", options: [.regularExpression, .caseInsensitive])
        t = t.replacingOccurrences(of: "[ \\t]{2,}", with: " ", options: .regularExpression)
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Una risposta di Melissa puo' finire con "@darlene": lei tira dentro Darlene. Il testo senza segnale e chi e'
    /// stato chiamato, se puo' venire.
    static func chiamata(_ risposta: String) -> (testo: String, ospite: String?) {
        let testo = senzaSegnale(risposta)
        // senza segnale ma con una domanda per nome ("Elliot, tu che dici?"): risponde lui, o la domanda resta nel vuoto
        // solo le chiavi dei personaggi: un indirizzo email non e' un segnale
        let chi = primo("@(\(ordine.joined(separator: "|")))\\b", in: risposta) ?? chiamatoPerNome(testo)
        return (testo, chi.flatMap { tutti[$0] == nil ? nil : $0 })
    }

    /// Il personaggio a cui Melissa chiede qualcosa per nome alla fine della battuta: "Elliot, tu che dici?",
    /// "Elliot... che dici?", "che ne pensi, Krista?", "Darlene?". Un nome dentro una domanda ("ti ricordi quando
    /// Elliot ha bucato E Corp?") parla di loro, non a loro. La stessa regola della mod e della Bottega.
    static func chiamatoPerNome(_ testo: String) -> String? {
        let n = nomi
        guard !n.isEmpty else { return nil }
        let fine = "\\s*\\?\\W{0,2}$"
        let vocativi = [
            "(?:^|[.!?…]\\s*)(?:e\\s+)?(\(n))\\s*(?:,|!|:|\\.{3}|…)[^.!?…]*" + fine,
            ",\\s*(\(n))" + fine,
            "(?:^|[.!?…]\\s*)(\(n))" + fine,
        ]
        for v in vocativi {
            if let nome = primo(v, in: testo) { return chiaveDi(nome) }
        }
        return nil
    }

    /// "Darlene, Elliot e Krista".
    static func elenco(_ nomi: [String]) -> String {
        nomi.count <= 1 ? (nomi.first ?? "") : nomi.dropLast().joined(separator: ", ") + " e " + nomi.last!
    }

    /// A cosa serve ciascuno, gli stessi ruoli della cronaca della mod (RUOLI in register.tsx).
    /// A cosa serve ciascuno, dal campo `ruolo` del suo file (lo stesso nella mod e nella Bottega).
    static var ruoli: [String: String] { tutti.mapValues(\.ruolo) }

    /// Chi entra quando Melissa lo tira dentro da sola: il primo, in ordine, le cui `parole` Andrea ha detto (Elliot
    /// sulla sicurezza, Krista sulle scuse), altrimenti uno diverso dall'ultimo. Lo sceglie il codice: lasciato al
    /// modello, chiamava sempre Darlene (misura del 6 ottobre 2026 sulla cronaca della mod). `caso` in [0, 1).
    static func adatto(_ testo: String, ultimo: String?, caso: Double = Double.random(in: 0..<1)) -> String? {
        for k in ordine {
            if let parole = tutti[k]?.parole, !parole.isEmpty, primo("(\(parole))", in: testo) != nil { return k }
        }
        let altri = ordine.filter { $0 != ultimo }
        let fra = altri.isEmpty ? ordine : altri
        guard !fra.isEmpty else { return nil }
        return fra[min(fra.count - 1, Int(caso * Double(fra.count)))]
    }

    /// Cosa si aggiunge al prompt di Melissa perche' sappia di poter tirare dentro qualcuno.
    /// `voluto`: chi Andrea ha appena chiesto di sentire. `scelto`: chi puo' tirare dentro da sola adesso, se puo'.
    /// `vivo`: piu' risposte senza ospiti, quindi lo tira dentro adesso. Stesso testo di `invitoConversa` della mod.
    static func invito(voluto: String?, scelto: String?, vivo: Bool = false) -> String {
        if let voluto, let p = tutti[voluto] {
            return "Andrea vuole sentire anche \(p.nome): rispondi tu e chiudi con una domanda rivolta a lei o a lui, " +
                "poi scrivi alla fine, da sola, la parola @\(voluto)."
        }
        guard let scelto, let p = tutti[scelto] else { return "" }
        let chiudi = "chiudi con una domanda rivolta a \(p.nome) e scrivi alla fine, da sola, la parola @\(scelto)"
        if vivo {
            return "Stavolta tira dentro \(p.nome) di Mr. Robot (\(ruoli[scelto] ?? p.nome)): trova l'aggancio in quello che " +
                "ha detto Andrea, rispondi tu e \(chiudi)."
        }
        return "Con te c'e' anche \(p.nome) di Mr. Robot (\(ruoli[scelto] ?? p.nome)). Solo quando rende la chiacchierata " +
            "piu' viva puoi tirarlo dentro: \(chiudi). Di solito rispondi da sola."
    }

    /// Il prompt di sistema di un personaggio che ha la chiamata sull'iPhone.
    static func sistema(_ p: Personaggio) -> String {
        "\(p.carattere) Andrea ti parla dall'iPhone: e' una chiacchierata, di qualunque cosa. \(regole) Due o quattro frasi."
    }
}
