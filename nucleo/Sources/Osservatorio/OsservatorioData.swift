//
//  OsservatorioData.swift
//  Bottega Nucleo
//
//  The data of the Osservatorio: the cruscotto's `Stats` (docs/CONTRATTI.md, section 3),
//  read leniently from JSON (a missing or malformed field empties one panel, never
//  crashes), plus the optional `categorie` {"7": {correzione: minuti, ...}, "30", "90"}.
//  Here too the numbers the panels show, in Italian (decimal comma), so they can be
//  checked from the command line without a window (`--cli osservatorio-prova`).
//

import Foundation

// MARK: - Lenient JSON access

private extension Dictionary where Key == String, Value == Any {
    func num(_ k: String) -> Double? {
        if let n = self[k] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { return n.doubleValue }
        if let s = self[k] as? String { return Double(s) }
        return nil
    }
    func str(_ k: String) -> String? { self[k] as? String }
    func obj(_ k: String) -> [String: Any]? { self[k] as? [String: Any] }
    func arr(_ k: String) -> [[String: Any]] { (self[k] as? [Any])?.compactMap { $0 as? [String: Any] } ?? [] }
    func nums(_ k: String) -> [Double] {
        (self[k] as? [Any])?.map { ($0 as? NSNumber)?.doubleValue ?? 0 } ?? []
    }
}

/// [input, output, read from cache, written to cache].
private func tokSum(_ any: Any?) -> Double {
    if let a = any as? [Any] { return a.reduce(0) { $0 + (($1 as? NSNumber)?.doubleValue ?? 0) } }
    if let n = any as? NSNumber { return n.doubleValue }
    return 0
}

// MARK: - Model

struct OsservatorioData {
    struct Today { var date: String; var you: Double; var claude: Double; var tok: Double; var sessions: Int }
    struct Triple { var you: Double; var claude: Double; var tok: Double }
    struct Week { var start: String; var now: Triple; var prevSoFar: Triple; var prevFull: Triple? }
    struct Day { var date: String; var you: Double; var claude: Double; var tok: Double }
    struct Project {
        var name: String
        var path: String?
        var you: Double
        var claude: Double
        var tok: Double
        var sessions: Int
        var last: Double            // ms since 1970
        var hours: [Double]         // 24, your minutes per hour
        var live: Int
    }
    struct Edge { var a: String; var b: String; var minutes: Double }
    struct Period {
        var days: Int
        var you: Double
        var claude: Double
        var tok: Double
        var sessions: Int
        var projects: [Project]
        var edges: [Edge]
        var heat: [[Double]]?       // 7 x 24, Monday first
    }
    struct Live { var project: String; var path: String?; var title: String; var status: String }

    var computedAt: Double?
    var today: Today?
    var week: Week?
    var days: [Day] = []
    var periods: [String: Period] = [:]
    var live: [Live] = []
    var categorie: [String: [String: Double]]?
    var streak: Int?
    /// What was missing or malformed (for the CLI check; the window just shows less).
    var notes: [String] = []

    var isEmpty: Bool { today == nil && week == nil && periods.isEmpty }

    static func decode(_ data: Data) -> OsservatorioData {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            var d = OsservatorioData()
            d.notes.append("il JSON non si legge")
            return d
        }
        return decode(root)
    }

    static func decode(_ root: [String: Any]) -> OsservatorioData {
        // Accept both the bare Stats and a wrapper {stats: Stats, live?, categorie?}.
        var r = root
        if let inner = root.obj("stats") {
            r = inner
            if let l = root["live"] { r["live"] = l }
            if let c = root["categorie"] { r["categorie"] = c }
        }
        var d = OsservatorioData()
        d.computedAt = r.num("computedAt")
        if let t = r.obj("today") {
            d.today = Today(date: t.str("date") ?? "", you: t.num("you") ?? 0, claude: t.num("claude") ?? 0,
                            tok: tokSum(t["tok"]), sessions: Int(t.num("sessions") ?? 0))
        } else { d.notes.append("manca today") }
        if let w = r.obj("week") {
            func tri(_ o: [String: Any]?) -> Triple? {
                guard let o else { return nil }
                return Triple(you: o.num("you") ?? 0, claude: o.num("claude") ?? 0, tok: tokSum(o["tok"]))
            }
            if let now = tri(w.obj("now")) {
                d.week = Week(start: w.str("start") ?? "", now: now,
                              prevSoFar: tri(w.obj("prevSoFar")) ?? Triple(you: 0, claude: 0, tok: 0),
                              prevFull: tri(w.obj("prevFull")))
            } else { d.notes.append("week senza now") }
        } else { d.notes.append("manca week") }
        d.days = r.arr("days").compactMap { o in
            guard let date = o.str("date") else { return nil }
            return Day(date: date, you: o.num("you") ?? 0, claude: o.num("claude") ?? 0, tok: tokSum(o["tok"]))
        }
        if let ps = r.obj("periods") {
            for (key, any) in ps {
                guard let p = any as? [String: Any] else { continue }
                let projects = p.arr("projects").compactMap { o -> Project? in
                    guard let name = o.str("name") else { return nil }
                    var hours = o.nums("hours")
                    if hours.count != 24 { hours = Array(repeating: 0, count: 24) }
                    return Project(name: name, path: o.str("path"), you: o.num("you") ?? 0, claude: o.num("claude") ?? 0,
                                   tok: tokSum(o["tok"]), sessions: Int(o.num("sessions") ?? 0),
                                   last: o.num("last") ?? 0, hours: hours, live: Int(o.num("live") ?? 0))
                }
                let edges = p.arr("edges").compactMap { o -> Edge? in
                    guard let a = o.str("a"), let b = o.str("b") else { return nil }
                    return Edge(a: a, b: b, minutes: o.num("minutes") ?? 0)
                }
                var heat: [[Double]]?
                if let rows = p["heat"] as? [Any] {
                    let grid = rows.map { row -> [Double] in
                        let v = (row as? [Any])?.map { ($0 as? NSNumber)?.doubleValue ?? 0 } ?? []
                        return v.count == 24 ? v : Array(repeating: 0, count: 24)
                    }
                    if grid.count == 7 { heat = grid } else { d.notes.append("heat del periodo \(key) non e' 7x24") }
                }
                d.periods[key] = Period(days: Int(p.num("days") ?? Double(key) ?? 0), you: p.num("you") ?? 0,
                                        claude: p.num("claude") ?? 0, tok: tokSum(p["tok"]),
                                        sessions: Int(p.num("sessions") ?? 0), projects: projects, edges: edges, heat: heat)
            }
        } else { d.notes.append("mancano i periodi") }
        d.live = r.arr("live").map { o in
            Live(project: o.str("project") ?? "", path: o.str("path"), title: o.str("title") ?? "", status: o.str("status") ?? "")
        }
        if let c = r.obj("categorie") {
            var out: [String: [String: Double]] = [:]
            for (k, v) in c {
                guard let m = v as? [String: Any] else { continue }
                var row: [String: Double] = [:]
                for (cat, n) in m { if let x = (n as? NSNumber)?.doubleValue, x > 0 { row[cat] = x } }
                if !row.isEmpty { out[k] = row }
            }
            d.categorie = out.isEmpty ? nil : out
        }
        d.streak = r.obj("streak")?.num("current").map(Int.init)
        return d
    }
}

// MARK: - Italian formatting (same rules as the cruscotto: hm, tk, it)

enum Fmt {
    private static let formatters: [Int: NumberFormatter] = {
        var out: [Int: NumberFormatter] = [:]
        for d in 0...2 {
            let f = NumberFormatter()
            f.locale = Locale(identifier: "it_IT")
            f.numberStyle = .decimal
            f.maximumFractionDigits = d
            f.minimumFractionDigits = 0
            out[d] = f
        }
        return out
    }()

    /// 1234,5 -> "1.234,5"
    static func it(_ n: Double, _ digits: Int = 0) -> String {
        formatters[min(2, max(0, digits))]!.string(from: NSNumber(value: n)) ?? "0"
    }

    /// Minutes -> "5 h 20 min", "45 min", "meno di un minuto".
    static func hm(_ minutes: Double) -> String {
        let m = Int(minutes.rounded())
        if m < 1 { return minutes > 0 ? "meno di un minuto" : "0 min" }
        if m < 60 { return "\(m) min" }
        let h = m / 60
        if h >= 100 { return "\(it(Double(h))) h" }
        return m % 60 == 0 ? "\(h) h" : "\(h) h \(m % 60) min"
    }

    /// Tokens -> "1,2 mln", "340 mila", "1,4 mld".
    static func tk(_ n: Double) -> String {
        if n >= 1e9 { return "\(it(n / 1e9, n >= 1e10 ? 0 : 1)) mld" }
        if n >= 1e6 { return "\(it(n / 1e6, n >= 1e7 ? 0 : 1)) mln" }
        if n >= 1e4 { return "\(it(n / 1e3)) mila" }
        return it(n)
    }

    /// Change against a previous value: "+12%", "-3,5%", nil when there is nothing to compare.
    static func delta(_ now: Double, _ prev: Double) -> String? {
        guard prev > 0 else { return nil }
        let x = (now - prev) / prev * 100
        let digits = abs(x) < 10 ? 1 : 0
        let s = it(abs(x), digits)
        if s == "0" { return "pari" }
        return x > 0 ? "+\(s)%" : "-\(s)%"
    }

    static func pct(_ x: Double) -> String {
        x > 0 && x < 0.1 ? "meno dello 0,1%" : "\(it(x, x < 10 ? 1 : 0))%"
    }

    /// Hour of the day in a sentence: "mezzanotte", "l'una", "le 14".
    static func ora(_ h: Int) -> String {
        let x = ((h % 24) + 24) % 24
        return x == 0 ? "mezzanotte" : (x == 1 ? "l'una" : "le \(x)")
    }

    static let giorni = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"]
    static let giorniBrevi = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"]
}

// MARK: - Panel numbers

struct Pannelli {
    struct Kpi { var label: String; var value: String; var note: String? }
    struct Bar { var label: String; var value: Double; var text: String }

    var oggi: [Kpi]?
    var oggiFrase: String?
    var settimana: [Kpi]?
    var settimanaFrase: String?
    var heat: [[Double]]?
    var heatMax: Double = 0
    var heatFrase: String?
    var token: [Bar]?
    var tokenFrase: String?
    var categorie: [Bar]?
    var categorieFrase: String?
    var progetti: [OsservatorioData.Project] = []
    var vive: Int = 0

    /// Category -> (bar label, subject of the sentence with its article, plural).
    static let categorieNomi: [String: (String, String, Bool)] = [
        "correzione": ("Correzioni", "le correzioni", true),
        "funzione": ("Funzioni nuove", "le funzioni nuove", true),
        "rilascio": ("Rilasci", "i rilasci", true),
        "ricerca": ("Ricerca", "la ricerca", false),
        "manutenzione": ("Manutenzione", "la manutenzione", false),
        "documentazione": ("Documentazione", "la documentazione", false),
    ]

    static func compute(_ d: OsservatorioData, period: String) -> Pannelli {
        var p = Pannelli()
        if let t = d.today {
            p.oggi = [Kpi(label: "Tu", value: Fmt.hm(t.you), note: nil),
                      Kpi(label: "Claude", value: Fmt.hm(t.claude), note: t.sessions > 0 ? (t.sessions == 1 ? "una sessione" : "\(t.sessions) sessioni") : nil),
                      Kpi(label: "Token", value: Fmt.tk(t.tok), note: nil)]
            if t.you < 1 && t.claude < 1 {
                p.oggiFrase = "Oggi non hai ancora lavorato con Claude."
            } else if t.you > 0 {
                let ratio = t.claude / t.you
                p.oggiFrase = ratio >= 1.5
                    ? "Claude ha lavorato \(Fmt.it(ratio, 1)) volte il tuo tempo: più sessioni insieme."
                    : "Oggi \(Fmt.hm(t.you)) al lavoro."
            }
        }
        if let w = d.week {
            p.settimana = [Kpi(label: "Tu", value: Fmt.hm(w.now.you), note: Fmt.delta(w.now.you, w.prevSoFar.you)),
                           Kpi(label: "Claude", value: Fmt.hm(w.now.claude), note: Fmt.delta(w.now.claude, w.prevSoFar.claude)),
                           Kpi(label: "Token", value: Fmt.tk(w.now.tok), note: Fmt.delta(w.now.tok, w.prevSoFar.tok))]
            if w.prevSoFar.you > 0 {
                let x = (w.now.you - w.prevSoFar.you) / w.prevSoFar.you * 100
                p.settimanaFrase = abs(x) < 5
                    ? "Quasi come la settimana scorsa allo stesso punto."
                    : (x > 0 ? "Più ore della settimana scorsa allo stesso punto."
                             : "Meno ore della settimana scorsa allo stesso punto.")
            } else {
                p.settimanaFrase = "La settimana scorsa a questo punto non c'era lavoro da confrontare."
            }
        }
        let per = d.periods[period] ?? d.periods["30"] ?? d.periods.values.first
        if let per {
            if let heat = per.heat {
                let mx = heat.flatMap { $0 }.max() ?? 0
                if mx > 0 {
                    p.heat = heat
                    p.heatMax = mx
                    // the busiest weekday and the busiest hour, separately (the reading in words)
                    let dayTot = heat.map { $0.reduce(0, +) }
                    let hourTot = (0..<24).map { h in heat.reduce(0) { $0 + $1[h] } }
                    let dBest = dayTot.indices.max { dayTot[$0] < dayTot[$1] } ?? 0
                    let hBest = hourTot.indices.max { hourTot[$0] < hourTot[$1] } ?? 0
                    p.heatFrase = "Lavori di più \(dBest == 6 ? "la" : "il") \(Fmt.giorni[dBest]), e l'ora più piena è tra \(Fmt.ora(hBest)) e \(Fmt.ora(hBest + 1))."
                }
            }
            let byTok = per.projects.filter { $0.tok > 0 }.sorted { $0.tok > $1.tok }
            if !byTok.isEmpty {
                var bars = byTok.prefix(6).map { Bar(label: $0.name, value: $0.tok, text: Fmt.tk($0.tok)) }
                let rest = byTok.dropFirst(6).reduce(0) { $0 + $1.tok }
                if rest > 0 { bars.append(Bar(label: "altri \(byTok.count - 6)", value: rest, text: Fmt.tk(rest))) }
                p.token = bars
                let total = byTok.reduce(0) { $0 + $1.tok }
                if let first = byTok.first, total > 0 {
                    p.tokenFrase = "\(first.name) da solo fa il \(Fmt.pct(first.tok / total * 100)) dei token del periodo."
                }
            }
            p.progetti = per.projects.filter { $0.you >= 1 || $0.live > 0 }.sorted { $0.you > $1.you }
        }
        // The period asked for, else the nearest one there is (the sentence names the real one).
        if let catKey = [period, "30", "7", "90"].first(where: { d.categorie?[$0] != nil }), let cats = d.categorie?[catKey] {
            let total = cats.values.reduce(0, +)
            if total > 0 {
                let sorted = cats.sorted { $0.value > $1.value }
                p.categorie = sorted.map {
                    Bar(label: categorieNomi[$0.key]?.0 ?? $0.key.capitalized, value: $0.value, text: Fmt.pct($0.value / total * 100))
                }
                if let top = sorted.first {
                    let (_, subject, plural) = categorieNomi[top.key] ?? (top.key, top.key, false)
                    let quando = "Negli ultimi \(catKey) giorni"
                    p.categorieFrase = "\(quando) \(subject) \(plural ? "sono" : "è") il \(Fmt.pct(top.value / total * 100)) del lavoro."
                }
            }
        }
        p.vive = d.live.count
        return p
    }
}

// MARK: - The sky from the data

enum OsservatorioCielo {
    /// One star per project with at least a minute of your work in the period (48 at
    /// most), stable position from the path, size and brightness from the hours, warmth
    /// from the rank, a ring when a session is live, lines from the period's edges.
    static func scene(_ d: OsservatorioData, period: String, version: Int) -> SkyScene {
        guard let per = d.periods[period] ?? d.periods["30"] ?? d.periods.values.first else {
            return SkyScene(stars: [], edges: [], version: version)
        }
        let rows = Array(per.projects.filter { $0.you >= 1 }.sorted { $0.you > $1.you }.prefix(48))
        let maxYou = max(1, rows.map(\.you).max() ?? 1)
        let livePaths = Set(d.live.compactMap(\.path))
        let liveNames = Set(d.live.map { $0.project.lowercased() })
        let nowMs = (d.computedAt ?? Date().timeIntervalSince1970 * 1000)
        var stars: [SkyStar] = rows.enumerated().map { i, p in
            let key = p.path ?? p.name
            let share = Float(sqrt(p.you / maxYou))
            let ageDays = p.last > 0 ? max(0, (nowMs - p.last) / 86_400_000) : 30
            // worked on recently: full light; a month ago: about half
            let recency = Float(max(0.5, 1 - ageDays / 60))
            let warmth = rows.count > 1 ? 1 - Float(i) / Float(rows.count - 1) : 1
            let live = p.live > 0 || (p.path.map { livePaths.contains($0) } ?? false) || liveNames.contains(p.name.lowercased())
            return SkyStar(key: key, name: p.name, path: p.path,
                           position: SkyGeometry.stablePosition(for: key),
                           size: 2.6 + 9 * share, brightness: (0.35 + 0.65 * share) * recency,
                           warmth: warmth * 0.85 + share * 0.15, live: live, hollow: p.path == nil,
                           minutes: p.you)
        }
        SkyGeometry.relax(&stars)
        let index = Dictionary(stars.enumerated().map { ($1.name, $0) }, uniquingKeysWith: { a, _ in a })
        let edges = per.edges.compactMap { e -> SkyEdge? in
            guard let a = index[e.a], let b = index[e.b], a != b else { return nil }
            return SkyEdge(a: a, b: b, strength: Float(min(1, e.minutes / 120)))
        }
        return SkyScene(stars: stars, edges: edges, version: version)
    }
}
