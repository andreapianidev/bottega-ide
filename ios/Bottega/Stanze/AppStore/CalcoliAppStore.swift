//
//  CalcoliAppStore.swift
//  Bottega per iPhone
//
//  I conti e le frasi della stanza App Store che non dipendono dalla grafica: la frase in testa, la verifica dopo una
//  versione, i nomi dei formati e degli eventi, la tendenza cumulata contro il periodo prima, le quote degli annunci.
//  Sono le stesse frasi di media/appstore.js sul Mac. Solo Foundation: il programmino di prova le prova con swiftc.
//

import Foundation

enum CalcoliAppStore {
    static let it = Locale(identifier: "it_IT")

    // MARK: - numeri

    static func euro(_ v: Double, decimali: Int? = nil) -> String {
        let d = decimali ?? (abs(v) < 100 ? 2 : 0)
        return v.formatted(.currency(code: "EUR").locale(it).precision(.fractionLength(d)))
    }

    static func numero(_ v: Double, decimali: Int = 0) -> String {
        v.formatted(.number.locale(it).precision(.fractionLength(decimali)))
    }

    /// Una quota tra 0 e 1: «41%»; sotto il 10% con un decimale («4,5%»).
    static func quota(_ q: Double) -> String {
        let p = q * 100
        return "\(numero(p, decimali: p < 10 && p > 0 ? 1 : 0))%"
    }

    // MARK: - parole

    static func gravita(_ g: String) -> String {
        switch g {
        case "alta": "subito"
        case "media": "da sistemare"
        default: "quando puoi"
        }
    }

    static func formato(_ f: String) -> String {
        switch f {
        case "banner": "banner"
        case "interstitial": "interstitial"
        case "rewarded": "con premio"
        case "rewarded_interstitial": "interstitial con premio"
        case "app_open": "all'apertura"
        case "native": "nativo"
        default: f
        }
    }

    /// Gli eventi degli abbonamenti, nell'ordine e con le parole della stanza del Mac.
    static let eventi: [(String, String)] = [
        ("prove", "prove iniziate"),
        ("conversioni", "prove diventate a pagamento"),
        ("nuovi", "abbonamenti nuovi"),
        ("rinnovi", "rinnovi"),
        ("disdette", "rinnovi spenti"),
        ("rimborsi", "rimborsi"),
        ("ritardi", "ritardi di pagamento"),
        ("ritorni", "tornati"),
    ]

    /// «Italia» dal codice del paese.
    static func paese(_ codice: String) -> String {
        it.localizedString(forRegionCode: codice) ?? codice
    }

    /// La fonte dei download con la maiuscola: «Ricerca», «Altre app».
    static func fonte(_ f: String) -> String {
        f.prefix(1).uppercased() + f.dropFirst()
    }

    /// "2026-10-01" -> «1 ott»; "2026-10" -> «ott 2026».
    static func dataBreve(_ chiave: String) -> String {
        guard let d = data(chiave) else { return chiave }
        return chiave.count > 7 ? d.formatted(.dateTime.day().month(.abbreviated).locale(it)) : d.formatted(.dateTime.month(.abbreviated).year().locale(it))
    }

    /// "2026-10-01" -> «giovedì 1 ottobre»; "2026-10" -> «ottobre 2026».
    static func dataLunga(_ chiave: String) -> String {
        guard let d = data(chiave) else { return chiave }
        return chiave.count > 7 ? d.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(it)) : d.formatted(.dateTime.month(.wide).year().locale(it))
    }

    static func data(_ chiave: String) -> Date? {
        let p = chiave.split(separator: "-").compactMap { Int($0) }
        guard p.count >= 2 else { return nil }
        return Calendar.current.date(from: DateComponents(year: p[0], month: p[1], day: p.count > 2 ? p[2] : 1, hour: 12))
    }

    /// «da oggi», «da ieri», «da 5 giorni».
    static func daQuando(ms: Double, ora: Date = Date()) -> String {
        let g = max(0, Int((ora.timeIntervalSince1970 - ms / 1000) / 86400 + 0.5))
        return g == 0 ? "visto oggi" : g == 1 ? "da ieri" : "da \(g) giorni"
    }

    // MARK: - frasi

    /// La frase in testa, come sul Mac: «Negli ultimi 30 giorni le app hanno reso 1.234 €, 900 € da AdMob e 334 € dallo
    /// Store. Il 12% in più del periodo prima.»
    static func frase(_ d: StanzaAppStore, nomeApp: String? = nil) -> String {
        let quando: String
        switch d.etichetta {
        case "ieri": quando = "Ieri"
        default:
            if let m = d.mese { quando = "A \(dataLunga(m))" }
            else { quando = d.quale == "mesi" ? (d.periodo == 90 ? "Negli ultimi 3 mesi" : "Negli ultimi 12 mesi") : "Negli ultimi \(Int(d.periodo)) giorni" }
        }
        let chi = nomeApp.map { "\($0) ha" } ?? "le app hanno"
        var s = "\(quando) \(chi) reso \(euro(d.cifre.totale, decimali: 0)), \(euro(d.cifre.admob, decimali: 0)) da AdMob e \(euro(d.cifre.store, decimali: 0)) dallo Store."
        if let p = d.prima, p.totale > 0, d.storeIncompleto != true {
            let v = (d.cifre.totale - p.totale) / p.totale
            s += abs(v) < 0.03 ? " Come nel periodo prima." : " Il \(Int((abs(v) * 100).rounded()))% \(v > 0 ? "in più" : "in meno") del periodo prima."
        }
        return s
    }

    /// Sotto la frase: quante cose da sistemare e quanto valgono.
    static func fraseBuchi(_ d: StanzaAppStore) -> String {
        let b = d.buchi
        guard !b.isEmpty else { return "Non vedo buchi: annunci, consenso e codice sono in ordine." }
        let subito = b.filter { $0.gravita == "alta" }.count
        let tot = max(b.count, Int(d.buchiTotali))
        var s = subito > 0 ? (subito == 1 ? "Una cosa da sistemare subito" : "\(subito) cose da sistemare subito") : "Niente di urgente"
        if tot > subito { s += ", \(tot - subito) quando puoi" }
        s += "."
        if d.stimaTotale >= 1, let primo = b.filter({ ($0.stima ?? 0) > 0 }).max(by: { ($0.stima ?? 0) < ($1.stima ?? 0) }), let st = primo.stima {
            s += " Quelle che si possono stimare valgono circa \(euro(d.stimaTotale, decimali: 0)) al mese; la più grossa è su \(primo.app) (\(euro(st, decimali: 0)))."
        }
        return s
    }

    /// Prima e dopo l'ultima versione, a parole (testoVerifica di media/appstore.js).
    static func verifica(_ b: StanzaAppStore.Buco) -> String? {
        guard let v = b.verifica else { return nil }
        let quando = dataBreve(v.giorno)
        let g = Int(v.giorniDopo)
        switch v.esito {
        case "risolto":
            return "Dalla \(v.versione) (\(quando)): \(quota(v.dopo)), prima \(quota(v.prima)). Sembra risolto: la media dei 30 giorni lo confermerà."
        case "meglio":
            let soglia = b.soglia.map { ", ma ancora sotto il \(quota($0))" } ?? ""
            return "Dalla \(v.versione) (\(quando)): dal \(quota(v.prima)) al \(quota(v.dopo)). Meglio\(soglia)."
        case "uguale":
            return "Dalla \(v.versione), uscita \(g) giorni fa, non è cambiato niente: \(quota(v.dopo)), prima \(quota(v.prima))."
        default:
            return "La \(v.versione) è uscita da \(g) \(g == 1 ? "giorno" : "giorni"): finora \(quota(v.dopo)), prima \(quota(v.prima))."
        }
    }

    // MARK: - tendenza

    struct PassoTendenza: Identifiable {
        let chiave: String
        /// Euro sommati dall'inizio del periodo fino a qui, e lo stesso nel periodo prima.
        let adesso: Double
        let prima: Double
        var id: String { chiave }
    }

    /// Il cumulato del periodo contro quello prima, giorno per giorno (o mese per mese). Dove lo Store di adesso manca
    /// (Apple non l'ha ancora pubblicato) lo Store non conta per nessuno dei due: il confronto resta onesto.
    static func tendenza(_ punti: [StanzaAppStore.Punto]) -> [PassoTendenza] {
        let usati = punti.filter { $0.nelPeriodo || punti.allSatisfy { !$0.nelPeriodo } }
        let scelti = usati.count > 1 ? usati : punti
        guard scelti.allSatisfy({ $0.prima != nil }) else { return [] }
        var a = 0.0, p = 0.0
        return scelti.map { x in
            let pr = x.prima!
            let conStore = x.store != nil && pr.store != nil
            a += x.admob + (conStore ? x.store! : 0)
            p += pr.admob + (conStore ? pr.store! : 0)
            return PassoTendenza(chiave: x.chiave, adesso: a, prima: p)
        }
    }

    // MARK: - annunci

    /// Quante richieste trovano un annuncio, quanti caricati vengono mostrati, quanto rendono mille impressioni.
    static func riempimento(_ f: StanzaAppStore.Formato) -> Double? { f.richieste > 0 ? f.abbinate / f.richieste : nil }
    static func mostrati(_ f: StanzaAppStore.Formato) -> Double? { f.abbinate > 0 ? f.impressioni / f.abbinate : nil }
    static func ecpm(euro: Double, impressioni: Double) -> Double? { impressioni > 0 ? euro / impressioni * 1000 : nil }

    /// La variazione a parole e senza colori: «+12% su prima», «come prima», «prima: zero».
    static func delta(_ ora: Double, _ prima: Double?) -> String? {
        guard let p = prima else { return nil }
        if p == 0 && ora == 0 { return "come prima" }
        if p == 0 { return "prima: zero" }
        let v = (ora - p) / abs(p)
        if abs(v) < 0.02 { return "come prima" }
        return "\(v > 0 ? "+" : "-")\(Int((abs(v) * 100).rounded()))% su prima"
    }
}
