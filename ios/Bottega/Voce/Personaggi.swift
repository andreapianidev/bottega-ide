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
    /// cosa dice mentre pensa, per gruppo (Riempitivi.swift); nil se il file non ne ha
    let riempitivi: FrasiRiempitivo?

    private enum CodingKeys: String, CodingKey { case chiave, nome, ordine, voce, carattere, saluti, ruolo, parole, riempitivi }

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
        // facoltativo: senza, o con un gruppo vuoto, si usano i suoi `chiacchiera` e poi le frasi di Melissa
        riempitivi = try? c.decodeIfPresent(FrasiRiempitivo.self, forKey: .riempitivi)
    }
}

/// personaggi/melissa.json: non e' un personaggio, porta solo le frasi che Melissa dice mentre pensa.
private struct FileMelissa: Decodable {
    let chiave: String
    let riempitivi: FrasiRiempitivo?
}

enum Personaggi {
    /// Letti una volta dai file inclusi nell'app; nei test dalla cartella in BOTTEGA_PERSONAGGI.
    static let tutti: [String: Personaggio] = carica()

    /// In ordine, come li elenca Melissa.
    static let ordine: [String] = tutti.values.sorted { $0.ordine < $1.ordine }.map(\.chiave)

    /// I riempitivi di Melissa, da personaggi/melissa.json: letti a parte, mai dentro `tutti`.
    static let riempitiviMelissa: FrasiRiempitivo? = caricaMelissa()

    /// La cartella dei file: nei test BOTTEGA_PERSONAGGI, altrimenti quella inclusa nell'app.
    private static var cartella: URL? {
        ProcessInfo.processInfo.environment["BOTTEGA_PERSONAGGI"].map { URL(fileURLWithPath: $0) }
            ?? Bundle.main.url(forResource: "personaggi", withExtension: nil)
    }

    static func carica() -> [String: Personaggio] {
        guard let cartella, let file = try? FileManager.default.contentsOfDirectory(at: cartella, includingPropertiesForKeys: nil)
        else { return [:] }
        var tutti: [String: Personaggio] = [:]
        for url in file where url.pathExtension == "json" {
            // chiave minuscola come nella mod e nella Bottega: e' anche il segnale @chiave
            guard let data = try? Data(contentsOf: url), let p = try? JSONDecoder().decode(Personaggio.self, from: data),
                  p.chiave != "melissa", p.chiave.range(of: "^[a-z]+$", options: .regularExpression) != nil, !p.saluti.isEmpty
            else { continue }
            tutti[p.chiave] = p
        }
        return tutti
    }

    private static func caricaMelissa() -> FrasiRiempitivo? {
        guard let url = cartella?.appendingPathComponent("melissa.json"), let data = try? Data(contentsOf: url),
              let f = try? JSONDecoder().decode(FileMelissa.self, from: data), f.chiave == "melissa" else { return nil }
        return f.riempitivi
    }

    /// Le frasi di attesa di chi parla: "melissa" o la chiave di un personaggio.
    static func riempitivi(di chi: String) -> FrasiRiempitivo? {
        chi == "melissa" ? riempitiviMelissa : tutti[chi]?.riempitivi
    }

    /// Chi non e' un tema per l'eco: Melissa, Andrea e i personaggi.
    static var nonTemi: [String] { ["Melissa", "Andrea"] + ordine.compactMap { tutti[$0]?.nome } }

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

    /// La battuta di Melissa chiama un personaggio: il testo senza segnale e chi risponde, se puo' venire (solo chi ha
    /// una voce). Il segnale "@darlene" ovunque, altrimenti `chiamatoPerNome`. `invitato`: chi il codice le aveva
    /// chiesto di tirare dentro (docs/CONTRATTI.md, 9.11).
    static func chiamata(_ risposta: String, invitato: String? = nil) -> (testo: String, ospite: String?) {
        let testo = senzaSegnale(risposta)
        // solo le chiavi dei personaggi, e non dentro un indirizzo: un'email non e' un segnale
        let chi = primo("(?<![\\w.])@(\(ordine.joined(separator: "|")))\\b", in: risposta) ?? chiamatoPerNome(testo, invitato: invitato)
        return (testo, chi.flatMap { tutti[$0]?.voce.isEmpty == false ? $0 : nil })
    }

    // una parola finisce dove non segue una lettera o una cifra (come nella mod, dove \b e' ASCII)
    private static let fineParola = "(?![\\p{L}\\p{N}])"
    /// Prima di un nome detto a qualcuno: l'inizio della frase, una virgola, oppure "dai", "e tu", "tocca a te",
    /// "vabbe'", "grazie", "ciao"...
    private static let primaDelNome = "(?:^|[,;:]\\s*|(?<![\\p{L}\\p{N}])(?:e\\s+tu|e\\s+te|dai|su|senti|allora|ehi|oh|ok|tocca\\s+a\\s+te|vabb[eè]'?|grazie|ciao|scusa|beh)\\s*,?\\s*)"
    /// Dopo: punteggiatura, la fine della frase, oppure "tu", "che ne", "dimmi", "ascolta"... Non "te": "Krista te lo
    /// sta dicendo" parla di lei, non a lei.
    private static let dopoIlNome = "(?=\\s*(?:[,!?:;…]|\\.{2,}|\\.?\\s*$)|\\s+(?:tu|che\\s+ne|che\\s+dici|cosa\\s+ne|cosa\\s+dici|dimmi|digli|dille|diglielo|ascolta|senti|guarda|dicci)(?![\\p{L}\\p{N}]))"
    /// La battuta si rivolge a qualcuno: una domanda, o una parola detta a "te".
    private static let aQualcuno = "\\?|(?<![\\p{L}\\p{N}])(?:tu|te|ti|dimmi|digli|diglielo|dille|dai|senti|pensaci|aiutami|aiutalo|spiegagli|spiegaci|raccontaci|ascolta|guarda|ne pensi|che dici|cosa dici|tocca a te|la tua)" + fineParola

    /// Il personaggio a cui Melissa parla, perche' risponda: chi e' interrogato risponde sempre. L'invitato conta se il
    /// suo nome c'e', ovunque; gli altri se in una delle ultime due frasi il nome e' detto a lui ("Elliot, tu che
    /// dici?", "Dai Krista, diglielo tu.", "E tu Krista che ne dici?", "Tocca a te, Krista.") e la battuta si rivolge a
    /// qualcuno. "Ti ricordi quando Elliot ha bucato E Corp?" e "il file di Krista" parlano di loro, non a loro.
    /// La stessa regola della mod (register.tsx) e della Bottega (personaggi.ts): docs/CONTRATTI.md, 9.11.
    /// `daAndrea`: e' Andrea che parla, con Melissa al telefono. Un nome detto a qualcuno ("Vabbe' Elliot, hai
    /// ragione") chiama in qualunque frase e senza bisogno di una domanda; "Ieri Elliot mi ha detto..." no.
    static func chiamatoPerNome(_ testo: String, invitato: String? = nil, daAndrea: Bool = false) -> String? {
        if let invitato, let p = tutti[invitato],
           primo("(?<![\\p{L}\\p{N}@])(\(NSRegularExpression.escapedPattern(for: p.nome)))" + fineParola, in: testo) != nil {
            return invitato
        }
        let n = nomi
        guard !n.isEmpty else { return nil }
        // la frase finisce con . ! ? … seguiti da spazi o dalla fine: un punto dentro ".env" o "gmail.com" non la taglia
        let frasi = testo.replacingOccurrences(of: "(?<=[.!?…])\\s+", with: "\u{0}", options: .regularExpression)
            .split(separator: "\u{0}").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let coda = daAndrea ? frasi : Array(frasi.suffix(2))
        guard !coda.isEmpty, daAndrea || primo("(\(aQualcuno))", in: coda.joined(separator: " ")) != nil else { return nil }
        for f in coda.reversed() {
            if let nome = primo(primaDelNome + "(\(n))" + dopoIlNome, in: f) { return chiaveDi(nome) }
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
        if let k = perArgomento(testo) { return k }
        let altri = ordine.filter { $0 != ultimo }
        let fra = altri.isEmpty ? ordine : altri
        guard !fra.isEmpty else { return nil }
        return fra[min(fra.count - 1, Int(caso * Double(fra.count)))]
    }

    /// Il primo, in ordine, le cui `parole` Andrea ha detto (Elliot sulla password, Krista su una scusa), o nil.
    static func perArgomento(_ testo: String) -> String? {
        ordine.first { k in
            guard let parole = tutti[k]?.parole, !parole.isEmpty else { return false }
            return primo("(\(parole))", in: testo) != nil
        }
    }

    /// Chi puo' entrare da solo nella risposta di adesso (docs/CONTRATTI.md, 9.11, mod 0.16): dopo ogni risposta di
    /// Melissa senza ospite; appena dopo un ospite no, e alla prima risposta dopo non torna lo stesso per argomento.
    /// `dallUltimo`: le risposte di Melissa dall'ultimo ospite (1 all'inizio della conversazione, come nella mod).
    static func puoEntrare(_ testo: String, dallUltimo: Int, ultimo: String?) -> Bool {
        guard dallUltimo >= 1 else { return false }
        if dallUltimo >= 2 { return true }
        let k = perArgomento(testo)
        return k == nil || k != ultimo
    }

    /// L'invito e' deciso dopo due risposte senza ospiti, o subito se entra quello di cui Andrea ha toccato l'argomento.
    static func invitoDeciso(_ testo: String, dallUltimo: Int, scelto: String?) -> Bool {
        dallUltimo >= 2 || (scelto != nil && scelto == perArgomento(testo))
    }

    /// Nel giro a tre gli altri con una voce, a cui `chi` puo' passare la parola: mai se stesso, mai chi l'ha chiamato.
    static func altri(di chi: String, daChi: String?) -> [String] {
        ordine.filter { $0 != chi && $0 != daChi && tutti[$0]?.voce.isEmpty == false }
    }

    /// Nel 40% dei casi un ospite chiude chiedendo a un altro, scelto a caso fra `altri`, cosa ne pensa: parlano fra
    /// loro (mod 0.16). `caso` decide se, `caso2` chi; mai al secondo di un giro (`ultima`).
    static func passa(fra altri: [String], ultima: Bool, caso: Double = Double.random(in: 0..<1),
                      caso2: Double = Double.random(in: 0..<1)) -> String? {
        guard !ultima, !altri.isEmpty, caso < 0.4 else { return nil }
        return altri[min(altri.count - 1, Int(caso2 * Double(altri.count)))]
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
        "\(p.carattere) Andrea ti parla dall'iPhone: e' una chiacchierata, di qualunque cosa. \(regole) Due o tre frasi brevi."
    }
}
