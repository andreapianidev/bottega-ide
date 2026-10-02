//
//  IntentsProgetti.swift
//  Bottega Nucleo
//
//  Intents on the entities of Entita.swift: open a project, the projects waiting for a
//  push, what is waiting for Andrea. Their Siri phrases live in the one provider,
//  BottegaScorciatoie (Intents.swift).
//

import AppIntents
import Foundation

struct ApriProgetto: AppIntent {
    static let title: LocalizedStringResource = "Apri un progetto"
    static let description = IntentDescription("Apre un progetto nella plancia della Bottega.")
    static let supportedModes: IntentModes = .background

    @Parameter(title: "Progetto", requestValueDialog: "Quale progetto?")
    var progetto: ProgettoEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Apri \(\.$progetto)")
    }

    init() {}
    init(progetto: ProgettoEntity) { self.progetto = progetto }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        Quiet.begin(); defer { Quiet.end() }
        try BottegaLink.open("progetto", ["path": progetto.id])
        return .result(dialog: IntentDialog(stringLiteral: "Apro \(progetto.nome) nella Bottega."))
    }
}

struct ProgettiDaSpingere: AppIntent {
    static let title: LocalizedStringResource = "Progetti da spingere"
    static let description = IntentDescription("Quali progetti hanno commit che aspettano un push, e quanti.")
    static let supportedModes: IntentModes = .background

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<[ProgettoEntity]> & ProvidesDialog {
        Quiet.begin(); defer { Quiet.end() }
        let s = StatoNativo.load()
        let list = s.daSpingere
        return .result(value: list.map { ProgettoEntity($0) },
                       dialog: IntentDialog(stringLiteral: Self.frase(s)))
    }

    /// "Tre progetti aspettano un push: Peak con 2 commit, Faro con 1 commit e Orto con 5 commit."
    static func frase(_ s: StatoNativo) -> String {
        guard s.present else { return Frasi.manca }
        guard let all = s.progetti else {
            return "La Bottega non ha ancora scritto lo stato dei progetti. Aprila una volta e riprova."
        }
        let list = s.daSpingere
        var out: String
        if list.isEmpty {
            out = "Nessun progetto aspetta un push."
            let dirty = all.filter { $0.modifiche > 0 }.sorted { $0.modifiche > $1.modifiche }
            if !dirty.isEmpty {
                let names = dirty.prefix(3).map(\.nome) + (dirty.count > 3 ? ["altri \(dirty.count - 3)"] : [])
                out += " Ci sono modifiche ancora senza commit in \(Formato.elenco(names))."
            }
        } else {
            var items = list.prefix(5).map { "\($0.nome) con \($0.daSpingere) commit" }
            if list.count > 5 { items.append("altri \(list.count - 5)") }
            out = list.count == 1
                ? "Un progetto aspetta un push: \(items[0])."
                : "\(Formato.numero(list.count, maiuscolo: true)) progetti aspettano un push: \(Formato.elenco(items))."
        }
        return out + Frasi.eta(s.aggiornato)
    }
}

struct CosaMiAspetta: AppIntent {
    static let title: LocalizedStringResource = "Cosa mi aspetta"
    static let description = IntentDescription("I lavori e le sessioni di Claude che aspettano una tua risposta.")
    static let supportedModes: IntentModes = .background

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<[LavoroEntity]> & ProvidesDialog {
        Quiet.begin(); defer { Quiet.end() }
        let s = StatoNativo.load()
        return .result(value: s.tiAspettano.map(LavoroEntity.init),
                       dialog: IntentDialog(stringLiteral: Self.frase(s)))
    }

    /// "Ti aspettano due lavori: Peak, «sistema il login», da 20 minuti; Faro, da un'ora."
    static func frase(_ s: StatoNativo, now: Date = Date()) -> String {
        guard s.present else { return Frasi.manca }
        guard let l = s.lavori else {
            return "La Bottega non ha ancora scritto lo stato dei lavori. Aprila una volta e riprova."
        }
        let waiting = s.tiAspettano
        var out: String
        if !waiting.isEmpty {
            var items = waiting.prefix(4).map { v -> String in
                var t = v.progetto
                if !v.titolo.isEmpty { t += ", «\(Frasi.corto(v.titolo))»" }
                if let d = v.da { t += ", \(Formato.da(d, now: now))" }
                return t
            }
            if waiting.count > 4 { items.append("e altri \(waiting.count - 4)") }
            out = waiting.count == 1
                ? "Ti aspetta un lavoro: \(items[0])."
                : "Ti aspettano \(Formato.numero(waiting.count)) lavori: \(items.joined(separator: "; "))."
        } else if l.tiAspetta > 0 {
            out = l.tiAspetta == 1 ? "Ti aspetta un lavoro." : "Ti aspettano \(Formato.numero(l.tiAspetta)) lavori."
        } else {
            out = "Niente ti aspetta."
        }
        if l.inCorso > 0 {
            out += l.inCorso == 1 ? " Un lavoro è in corso." : " \(Formato.numero(l.inCorso, maiuscolo: true)) lavori sono in corso."
        }
        if l.stanotte > 0 {
            out += l.stanotte == 1 ? " Uno è in programma per stanotte."
                : " \(Formato.numero(l.stanotte, maiuscolo: true)) sono in programma per stanotte."
        }
        return out + Frasi.eta(s.aggiornato, now: now)
    }
}

private enum Frasi {
    static let manca = "La Bottega non ha ancora scritto il suo stato. Aprila una volta e riprova."

    /// " Dati di 7 ore fa." when the file is older than six hours, else nothing.
    static func eta(_ d: Date?, now: Date = Date()) -> String {
        guard let d else { return "" }
        let s = now.timeIntervalSince(d)
        guard s > 6 * 3600 else { return "" }
        let h = Int(s / 3600)
        return h < 48 ? " Dati di \(h) ore fa." : " Dati di \(h / 24) giorni fa."
    }

    /// Titles are prompts: Siri reads at most the first sixty characters.
    static func corto(_ s: String) -> String {
        let one = s.split(whereSeparator: \.isNewline).first.map(String.init) ?? s
        guard one.count > 60 else { return one }
        let cut = one.prefix(60)
        return (cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? String(cut)) + "…"
    }
}
