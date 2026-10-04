//
//  Stato.swift
//  Bottega Nucleo
//
//  ~/.bottega/stato.json (docs/CONTRATTI.md, 4.6), the summary the extension writes for
//  App Intents and the widget. Compiled into both the Nucleo and the widget extension,
//  so it depends on Foundation only.
//

import Foundation

/// ~/.bottega/stato.json, written by the extension (contract 4.6). Read leniently: any
/// missing piece becomes a sentence that says so, never an error.
struct Stato {
    var updated: Date?
    var briefingDate: String?
    var briefing: String?
    var rosso = 0, giallo = 0, verde = 0
    var voci: [(progetto: String, livello: String, frase: String)] = []
    var present = false

    /// The real home, also inside the widget's sandbox (where NSHomeDirectory() is the
    /// container): the widget reads the file through a home-relative exception.
    static var fileURL: URL {
        var home = NSHomeDirectory()
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir { home = String(cString: dir) }
        return URL(fileURLWithPath: home).appendingPathComponent(".bottega/stato.json")
    }

    static func load(from url: URL = fileURL) -> Stato {
        guard let data = try? Data(contentsOf: url),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return Stato() }
        return parse(o)
    }

    static func parse(_ o: [String: Any]) -> Stato {
        var s = Stato()
        s.present = true
        if let ms = (o["aggiornato"] as? NSNumber)?.doubleValue { s.updated = Date(timeIntervalSince1970: ms / 1000) }
        if let b = o["briefing"] as? [String: Any] {
            s.briefing = (b["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            s.briefingDate = b["date"] as? String
        }
        if let r = o["regole"] as? [String: Any] {
            s.rosso = (r["rosso"] as? NSNumber)?.intValue ?? 0
            s.giallo = (r["giallo"] as? NSNumber)?.intValue ?? 0
            s.verde = (r["verde"] as? NSNumber)?.intValue ?? 0
            s.voci = ((r["voci"] as? [[String: Any]]) ?? []).map {
                (($0["progetto"] as? String) ?? "", ($0["livello"] as? String) ?? "", ($0["frase"] as? String) ?? "")
            }
        }
        return s
    }

    var briefingText: String {
        guard present else { return Self.missing }
        guard let briefing, !briefing.isEmpty else {
            return "Oggi non c'è ancora un briefing. Lo prepara la Bottega quando la apri."
        }
        if let d = briefingDate, d != Self.today {
            return "Il briefing più recente è del \(Self.human(d)). \(briefing)"
        }
        return briefing
    }

    var rulesSentence: String {
        guard present else { return Self.missing }
        var out: String
        let total = rosso + giallo
        if total == 0 {
            out = verde > 0 ? "Tutto in regola su \(verde) progetti." : "Nessuna regola violata."
        } else {
            var parts: [String] = []
            if rosso > 0 { parts.append(rosso == 1 ? "1 rossa" : "\(rosso) rosse") }
            if giallo > 0 { parts.append(giallo == 1 ? "1 gialla" : "\(giallo) gialle") }
            if total == 1 {
                out = "C'è una regola violata, \(rosso == 1 ? "rossa" : "gialla")."
            } else {
                out = "Ci sono \(total) regole violate: \(parts.joined(separator: " e "))."
            }
            // Reds first, then the order the extension chose.
            let first = (voci.filter { $0.livello == "rosso" } + voci.filter { $0.livello != "rosso" }).prefix(3)
            for v in first where !v.frase.isEmpty {
                let frase = v.frase.hasSuffix(".") ? v.frase : v.frase + "."
                out += v.progetto.isEmpty ? " \(frase)" : " \(v.progetto): \(frase)"
            }
        }
        if let updated, Date().timeIntervalSince(updated) > 6 * 3600 {
            let hours = Int(Date().timeIntervalSince(updated) / 3600)
            out += hours < 48 ? " Dati di \(hours) ore fa." : " Dati di \(hours / 24) giorni fa."
        }
        return out
    }

    private static let missing = "La Bottega non ha ancora scritto il suo stato. Aprila una volta e riprova."

    private static var today: String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date())
    }

    /// "2026-10-01" -> "1 ottobre".
    private static func human(_ iso: String) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        guard let d = f.date(from: iso) else { return iso }
        let g = DateFormatter()
        g.locale = Locale(identifier: "it_IT")
        g.dateFormat = "d MMMM"
        return g.string(from: d)
    }
}
