//
//  Riempitivi.swift
//  Bottega per iPhone
//
//  Cosa si dice mentre il modello pensa: «Mmh, vediamo.», «Ok, ci penso io.», «Talky? Mh, vediamo.». Le frasi stanno
//  nei file di personaggi/ (campo `riempitivi`), quelle di Melissa in personaggi/melissa.json. Qui solo le regole,
//  identiche alla mod melissa (hooks/melissa.ts) e alla barra della Bottega (src/riempitivi.ts): docs/CONTRATTI.md,
//  9.11. Quando dirle lo decide Melissa.swift, l'audio gia' pronto sta in CacheRiempitivi.swift.
//

import Foundation

/// Le frasi di attesa di una voce, per gruppo (personaggi/LEGGIMI.md). Un gruppo che manca e' vuoto.
struct FrasiRiempitivo: Equatable, Decodable {
    var domanda: [String] = []
    var ordine: [String] = []
    var sfogo: [String] = []
    var battuta: [String] = []
    var chiacchiera: [String] = []
    /// le attese lunghe, a 5 e a 10 secondi
    var lunga: [String] = []
    /// modelli con `{x}`, il tema di quello che Andrea ha detto: cambiano ogni volta e vanno dal vivo
    var eco: [String] = []

    private enum CodingKeys: String, CodingKey { case domanda, ordine, sfogo, battuta, chiacchiera, lunga, eco }

    init(domanda: [String] = [], ordine: [String] = [], sfogo: [String] = [], battuta: [String] = [],
         chiacchiera: [String] = [], lunga: [String] = [], eco: [String] = []) {
        self.domanda = domanda
        self.ordine = ordine
        self.sfogo = sfogo
        self.battuta = battuta
        self.chiacchiera = chiacchiera
        self.lunga = lunga
        self.eco = eco
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func gruppo(_ k: CodingKeys) -> [String] { ((try? c.decodeIfPresent([String].self, forKey: k)) ?? nil) ?? [] }
        domanda = gruppo(.domanda)
        ordine = gruppo(.ordine)
        sfogo = gruppo(.sfogo)
        battuta = gruppo(.battuta)
        chiacchiera = gruppo(.chiacchiera)
        lunga = gruppo(.lunga)
        eco = gruppo(.eco)
    }

    /// Un gruppo per nome, senza le frasi vuote.
    func gruppo(_ g: Riempitivi.Gruppo) -> [String] {
        let l: [String]
        switch g {
        case .domanda: l = domanda
        case .ordine: l = ordine
        case .sfogo: l = sfogo
        case .battuta: l = battuta
        case .chiacchiera: l = chiacchiera
        case .lunga: l = lunga
        }
        return l.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

}

enum Riempitivi {
    /// I gruppi fra cui si sceglie: l'intenzione di Andrea, o `lunga`. L'eco si aggiunge da sola, con un tema.
    enum Gruppo: String, CaseIterable { case domanda, ordine, sfogo, battuta, chiacchiera, lunga }

    /// Quando, da quando la domanda parte verso il modello: la prima frase (intenzione), poi due attese lunghe.
    static let tempi: [Duration] = [.milliseconds(900), .seconds(5), .seconds(10)]

    // dove una parola comincia e finisce: nessuna lettera o cifra prima o dopo (come la mod, dove \b e' ASCII)
    private static let I = "(?<![\\p{L}\\p{N}])"
    private static let F = "(?![\\p{L}\\p{N}])"
    private static let sfogo = re("\(I)(?:cazz|merd|porc[aoi]|orco|vaffa|che palle|non funziona|non va\(F)|si e' rotto|si è rotto|odio|che schifo|stufo|incazz)")
    private static let battuta = re("\(I)(?:ah(?:ah)+|ha(?:ha)+|lol|scherz|rid[oei]\(F)|battuta)")
    private static let ordine = re("^(?:\\p{L}+,\\s*)?(?:(?:dai|allora|ok|okay|senti|ehi|ascolta)[,\\s]+)*(?:fai|fammi|apri|metti|controlla|scrivi|lancia|manda|cerca|trova|leggi|dimmi|spiega|spiegami|ricordami|prepara|aggiungi|togli|cambia|sistema|guarda|chiama|prova|ferma|crea|calcola|traduci|riassumi|puoi|potresti|devi|voglio che|vorrei che|mi serve)\(F)")
    private static let domanda = re("^(?:(?:e|ma|allora|senti)\\s+)?(?:come|perch[eé]|cosa|che cosa|quando|dove|quale|quali|quanto|quanti|quante|chi|sai|secondo te|ti ricordi|hai mai|c'e'|c'è|esiste)\(F)")
    private static let parolaTema = re("^\\p{Lu}[\\p{L}\\p{N}]{2,}$", [])
    private static let attacco = re("^(?:mh+|m+h|uhm+|ehm+|allora|dunque|vediamo|ok|okay|beh|be'|bah|ah|eh|oh|ecco|si|sì)\\s*[,.!…:]+\\s*")

    private static func re(_ schema: String, _ opzioni: NSRegularExpression.Options = .caseInsensitive) -> NSRegularExpression {
        try! NSRegularExpression(pattern: schema, options: opzioni)
    }

    private static func vale(_ r: NSRegularExpression, _ t: String) -> Bool {
        r.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil
    }

    /// Cos'e' quello che Andrea ha detto, per la frase che gli risponde: la prima regola che vale.
    static func intento(_ testo: String) -> Gruppo {
        let t = testo.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if vale(sfogo, t) { return .sfogo }
        if vale(battuta, t) { return .battuta }
        if vale(ordine, t) { return .ordine }
        if t.hasSuffix("?") || vale(domanda, t) { return .domanda }
        return .chiacchiera
    }

    /// Il nome che Andrea ha tirato fuori, per un'eco («Talky? Mh, vediamo.»): la prima parola con la maiuscola che
    /// non apre una frase (il riconoscimento di Apple scrive cosi' i nomi propri), di almeno tre lettere, e non in
    /// `esclusi` (Melissa, Andrea, i personaggi).
    static func tema(_ testo: String, esclusi: [String] = []) -> String? {
        let no = Set(esclusi.map { $0.lowercased() })
        for frase in testo.replacingOccurrences(of: "(?<=[.!?…])\\s+", with: "\u{0}", options: .regularExpression)
            .split(separator: "\u{0}") {
            let parole = frase.split(whereSeparator: \.isWhitespace)
            for p in parole.dropFirst() {
                let w = String(p).replacingOccurrences(of: "^[^\\p{L}\\p{N}]+|[^\\p{L}\\p{N}]+$", with: "", options: .regularExpression)
                if vale(parolaTema, w), !no.contains(w.lowercased()) { return w }
            }
        }
        return nil
    }

    /// La frase da dire adesso con la voce di chi ha la chiamata: il suo gruppo `gruppo`, se e' vuoto il suo
    /// `chiacchiera`, poi lo stesso gruppo di Melissa e il suo `chiacchiera`. Si lasciano fuori le ultime
    /// min(3, n - 1) dette da quella voce (`recenti`: per un'eco, il modello). `caso` sceglie; con un tema in `testo`
    /// (solo per domanda, ordine e chiacchiera) e `caso2` < 0.25 e' un'eco. nil se non c'e' niente da dire.
    static func scegli(_ propri: FrasiRiempitivo?, melissa: FrasiRiempitivo?, gruppo: Gruppo, recenti: [String],
                       testo: String = "", esclusi: [String] = [],
                       caso: Double = Double.random(in: 0..<1), caso2: Double = Double.random(in: 0..<1)) -> (frase: String, modello: String, eco: Bool)? {
        let piena = { (l: [String]?) in (l ?? []).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty } }
        let x = gruppo != .lunga && gruppo != .sfogo && gruppo != .battuta ? tema(testo, esclusi: esclusi) : nil
        let eco = piena(propri?.eco).isEmpty ? piena(melissa?.eco) : piena(propri?.eco)
        let ecoScelta = x != nil && !eco.isEmpty && caso2 < 0.25
        let lista = ecoScelta ? eco : Self.lista(gruppo, propri, melissa)
        guard !lista.isEmpty else { return nil }
        let k = min(3, lista.count - 1)
        let fuori = k > 0 ? Array(recenti.suffix(k)) : []
        let candidati = lista.filter { !fuori.contains($0) }
        let da = candidati.isEmpty ? lista : candidati
        let modello = da[min(da.count - 1, Int((caso * Double(da.count)).rounded(.down)))]
        let frase = x.map { modello.replacingOccurrences(of: "{x}", with: $0) } ?? modello
        return (frase, modello, ecoScelta)
    }

    /// Le frasi fisse che una voce puo' dire, con gli stessi ripieghi di `scegli` (il suo `chiacchiera`, poi le frasi di
    /// Melissa): quelle da preparare prima nella cache. L'eco no, cambia ogni volta.
    static func fisse(_ propri: FrasiRiempitivo?, melissa: FrasiRiempitivo?) -> [String] {
        var tutte: [String] = []
        for g in Gruppo.allCases {
            for f in lista(g, propri, melissa) where !tutte.contains(f) { tutte.append(f) }
        }
        return tutte
    }

    /// Il gruppo `g` di chi parla; se e' vuoto il suo `chiacchiera`, poi lo stesso gruppo di Melissa e il suo `chiacchiera`.
    private static func lista(_ g: Gruppo, _ propri: FrasiRiempitivo?, _ melissa: FrasiRiempitivo?) -> [String] {
        for l in [propri?.gruppo(g), propri?.gruppo(.chiacchiera), melissa?.gruppo(g), melissa?.gruppo(.chiacchiera)] {
            if let l, !l.isEmpty { return l }
        }
        return []
    }

    /// Dopo un riempitivo, la risposta senza il suo «Allora,» o «Mh.» iniziale: sarebbe detto due volte. Fino a due
    /// volte, poi la maiuscola; se non resta niente, la risposta com'era.
    static func senzaAttacco(_ testo: String) -> String {
        var t = testo.trimmingCharacters(in: .whitespacesAndNewlines)
        for _ in 0..<2 {
            t = attacco.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: "")
        }
        guard t.range(of: "[\\p{L}\\p{N}]", options: .regularExpression) != nil, let prima = t.first else { return testo }
        return prima.uppercased() + t.dropFirst()
    }
}
