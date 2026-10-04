//
//  StatoNativo.swift
//  Bottega Nucleo (app and widget)
//
//  The newer parts of ~/.bottega/stato.json (docs/CONTRATTI.md, 4.6): hours, work items,
//  projects, categories, plus the money and work counts Stato.swift does not read.
//  Same file as Stato.fileURL. Foundation only: compiled into the Nucleo and the widget.
//  Read leniently: a missing or malformed field is nil or empty, never an error.
//

import Foundation

struct StatoNativo: Sendable {
    struct Giorno: Sendable, Hashable {
        var date: String          // YYYY-MM-DD
        var minuti: Int
    }

    struct Ore: Sendable {
        var oggi: Int?
        var ieri: Int?
        var settimana: Int?
        var giorni: [Giorno] = []   // last 7, oldest first
        var aggiornato: Date?
        var fonti: [String] = []
    }

    struct Voce: Sendable, Hashable {
        var key: String           // WorkItem.key: "job:<id>" or "sess:<sessionId>"
        var progetto: String
        var path: String
        var titolo: String
        var stato: String         // 'in corso' | 'ti aspetta' | 'nel terminale' | 'in coda' | 'stanotte'
        var da: Date?
    }

    struct Lavori: Sendable {
        var inCorso = 0, tiAspetta = 0, nelTerminale = 0, inCoda = 0, stanotte = 0, vive = 0
        var voci: [Voce] = []
    }

    struct Progetto: Sendable, Hashable {
        var nome: String
        var path: String
        var ramo: String?
        var daSpingere = 0
        var modifiche = 0
        var livello: String?      // 'rosso' | 'giallo' | 'verde' | nil
        var ultima: Date?
    }

    struct Soldi: Sendable {
        var ieri: Double
        var sette: Double?
        var valuta: String
    }

    var present = false
    var aggiornato: Date?
    var ore: Ore?
    var lavori: Lavori?
    var progetti: [Progetto]?     // nil: the extension has not written them yet
    var categorie: [String: Int]? // this week, minutes per category
    var soldi: Soldi?

    // MARK: loading

    static func load(from url: URL = Stato.fileURL) -> StatoNativo {
        guard let data = try? Data(contentsOf: url),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return StatoNativo() }
        return parse(o)
    }

    static func parse(_ o: [String: Any]) -> StatoNativo {
        var s = StatoNativo()
        s.present = true
        s.aggiornato = date(o["aggiornato"])

        if let r = o["ore"] as? [String: Any] {
            var ore = Ore(oggi: int(r["oggi"]), ieri: int(r["ieri"]), settimana: int(r["settimana"]))
            ore.aggiornato = date(r["aggiornato"])
            ore.fonti = r["fonti"] as? [String] ?? ["claude"]
            ore.giorni = (r["giorni"] as? [[String: Any]] ?? []).compactMap { g in
                guard let d = g["date"] as? String, d.count == 10 else { return nil }
                return Giorno(date: d, minuti: max(0, int(g["minuti"]) ?? 0))
            }.sorted { $0.date < $1.date }
            s.ore = ore
        }

        if let l = o["lavori"] as? [String: Any] {
            var lav = Lavori()
            lav.inCorso = int(l["inCorso"]) ?? 0
            lav.tiAspetta = int(l["tiAspetta"]) ?? 0
            lav.nelTerminale = int(l["nelTerminale"]) ?? 0
            lav.inCoda = int(l["inCoda"]) ?? 0
            lav.stanotte = int(l["stanotte"]) ?? 0
            lav.vive = int(l["vive"]) ?? 0
            lav.voci = (l["voci"] as? [[String: Any]] ?? []).compactMap { v in
                let path = v["path"] as? String ?? ""
                let progetto = (v["progetto"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                    ?? (path as NSString).lastPathComponent
                let titolo = (v["titolo"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                // An item without a key still needs a stable id for App Intents.
                let key = (v["key"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "voce:\(path):\(titolo)"
                guard !progetto.isEmpty || !titolo.isEmpty else { return nil }
                return Voce(key: key, progetto: progetto, path: path, titolo: titolo,
                            stato: v["stato"] as? String ?? "", da: date(v["da"]))
            }
            s.lavori = lav
        }

        if let ps = o["progetti"] as? [[String: Any]] {
            s.progetti = ps.compactMap { p in
                guard let path = p["path"] as? String, !path.isEmpty else { return nil }
                let nome = (p["nome"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (path as NSString).lastPathComponent
                let livello = (p["livello"] as? String).flatMap { ["rosso", "giallo", "verde"].contains($0) ? $0 : nil }
                return Progetto(nome: nome, path: path, ramo: (p["ramo"] as? String).flatMap { $0.isEmpty ? nil : $0 },
                                daSpingere: max(0, int(p["daSpingere"]) ?? 0), modifiche: max(0, int(p["modifiche"]) ?? 0),
                                livello: livello, ultima: date(p["ultima"]))
            }
        }

        if let c = o["categorie"] as? [String: Any], let week = c["settimana"] as? [String: Any] {
            var out: [String: Int] = [:]
            for (k, v) in week { if let m = int(v), m > 0 { out[k] = m } }
            s.categorie = out
        }

        if let m = o["soldi"] as? [String: Any], let ieri = (m["ieri"] as? NSNumber)?.doubleValue {
            s.soldi = Soldi(ieri: ieri, sette: (m["sette"] as? NSNumber)?.doubleValue,
                            valuta: (m["valuta"] as? String) ?? "USD")
        }
        return s
    }

    // MARK: hours, robust to a file written yesterday

    /// Minutes worked today. A file written on another day says nothing about today.
    func minutiOggi(_ now: Date = Date()) -> Int {
        let today = Self.day(now)
        if let g = ore?.giorni.first(where: { $0.date == today }) { return g.minuti }
        if let a = oreAggiornate, Self.day(a) == today { return ore?.oggi ?? 0 }
        return 0
    }

    /// Minutes worked yesterday, nil when unknown.
    func minutiIeri(_ now: Date = Date()) -> Int? {
        let yesterday = Self.day(now.addingTimeInterval(-86_400))
        if let g = ore?.giorni.first(where: { $0.date == yesterday }) { return g.minuti }
        guard let a = oreAggiornate else { return nil }
        if Self.day(a) == Self.day(now) { return ore?.ieri }
        if Self.day(a) == yesterday { return ore?.oggi }
        return nil
    }

    /// The last seven days ending today, oldest first, zeros where the file has nothing.
    func ultimiSette(_ now: Date = Date()) -> [Giorno] {
        let cal = Calendar(identifier: .gregorian)
        let start = cal.startOfDay(for: now)
        let known = Dictionary((ore?.giorni ?? []).map { ($0.date, $0.minuti) }, uniquingKeysWith: { a, _ in a })
        return (0..<7).reversed().map { back -> Giorno in
            let d = cal.date(byAdding: .day, value: -back, to: start) ?? start
            let key = Self.day(d)
            return Giorno(date: key, minuti: back == 0 ? minutiOggi(now) : (known[key] ?? 0))
        }
    }

    /// Minutes of the last seven days: the extension's figure when it is fresh, else the sum.
    func minutiSettimana(_ now: Date = Date()) -> Int {
        if let a = oreAggiornate, Self.day(a) == Self.day(now), let w = ore?.settimana { return w }
        return ultimiSette(now).reduce(0) { $0 + $1.minuti }
    }

    var hasOre: Bool { ore != nil }

    /// State can be republished for work/rules without recomputing the hours.
    /// Use their computation time rather than claiming they were just refreshed.
    var oreAggiornate: Date? { ore?.aggiornato ?? aggiornato }

    var fontiOre: String {
        let names = (ore?.fonti ?? []).compactMap { fonte -> String? in
            switch fonte {
            case "claude": return "Claude Code"
            case "codex": return "Codex"
            default: return nil
            }
        }
        return names.isEmpty ? "Ore di lavoro" : names.joined(separator: " + ")
    }

    // MARK: work

    var tiAspettano: [Voce] { (lavori?.voci ?? []).filter { $0.stato == "ti aspetta" } }

    /// Projects with commits to push, most commits first.
    var daSpingere: [Progetto] {
        (progetti ?? []).filter { $0.daSpingere > 0 }.sorted {
            $0.daSpingere != $1.daSpingere ? $0.daSpingere > $1.daSpingere : $0.nome.localizedCompare($1.nome) == .orderedAscending
        }
    }

    // MARK: helpers

    /// Lowercased, without accents and anything that is not a letter or a digit:
    /// "Walkie-Talky", "walkie talky" and "WalkieTalky" all become "walkietalky".
    static func chiave(_ s: String) -> String {
        let folded = s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
                               locale: Locale(identifier: "it_IT"))
        return String(String.UnicodeScalarView(folded.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }))
    }

    static func day(_ d: Date) -> String {
        let c = Calendar(identifier: .gregorian).dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    private static func int(_ v: Any?) -> Int? {
        if let n = v as? NSNumber { let d = n.doubleValue; return d.isFinite ? Int(d.rounded()) : nil }
        if let s = v as? String { return Int(s) }
        return nil
    }

    /// Milliseconds since 1970 (Date.now() in the extension), seconds, or ISO 8601.
    private static func date(_ v: Any?) -> Date? {
        if let n = v as? NSNumber {
            let d = n.doubleValue
            guard d > 0, d.isFinite else { return nil }
            return Date(timeIntervalSince1970: d > 1e11 ? d / 1000 : d)
        }
        if let s = v as? String { return ISO8601DateFormatter().date(from: s) }
        return nil
    }
}

// MARK: - Italian wording shared by the widget and the intents

enum Formato {
    /// 135 -> "2 h 15 min", 120 -> "2 h", 40 -> "40 min", 0 -> "0 min".
    static func durata(_ minuti: Int) -> String {
        let m = max(0, minuti)
        let h = m / 60, r = m % 60
        if h == 0 { return "\(r) min" }
        return r == 0 ? "\(h) h" : "\(h) h \(r) min"
    }

    /// 12.3, "USD" -> "12,30 $" (Italian separators, symbol after the amount).
    static func soldi(_ value: Double, _ valuta: String) -> String {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "it_IT")
        f.numberStyle = .decimal
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        let n = f.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value)
        let symbols = ["USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥"]
        return "\(n) \(symbols[valuta.uppercased()] ?? valuta.uppercased())"
    }

    /// Small numbers in words at the start of a sentence ("Tre progetti"), digits above ten.
    static func numero(_ n: Int, femminile: Bool = false, maiuscolo: Bool = false) -> String {
        let words = ["zero", femminile ? "una" : "uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci"]
        let w = (0...10).contains(n) ? words[n] : "\(n)"
        return maiuscolo ? w.prefix(1).uppercased() + w.dropFirst() : w
    }

    /// "a", "a e b", "a, b e c".
    static func elenco(_ items: [String]) -> String {
        switch items.count {
        case 0: return ""
        case 1: return items[0]
        default: return items.dropLast().joined(separator: ", ") + " e " + items[items.count - 1]
        }
    }

    /// How long ago, in words: "da 5 minuti", "da 2 ore", "da ieri".
    static func da(_ d: Date, now: Date = Date()) -> String {
        let s = max(0, now.timeIntervalSince(d))
        if s < 90 { return "da un minuto" }
        if s < 3600 { return "da \(Int(s / 60)) minuti" }
        if s < 2 * 3600 { return "da un'ora" }
        if s < 86_400 { return "da \(Int(s / 3600)) ore" }
        return s < 2 * 86_400 ? "da ieri" : "da \(Int(s / 86_400)) giorni"
    }
}
