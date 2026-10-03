//
//  StatoMac.swift
//  Bottega per iPhone (app e widget)
//
//  Lo stato del Mac come lo manda il ponte (GET /v1/stato, docs/CONTRATTI.md, 9.1). L'app lo salva anche nel
//  gruppo condiviso, cosi' i widget hanno sempre l'ultimo stato visto anche quando il Mac non risponde.
//

import Foundation

struct StatoMac: Codable, Equatable {
    struct Riga: Codable, Equatable, Identifiable {
        let chi: String
        let testo: String
        let alle: Double
        var id: String { "\(alle)-\(chi)-\(testo.prefix(24))" }
    }
    /// Il cervello scelto adesso sul Mac (docs/CONTRATTI.md, 9.8): il nome sotto la sfera.
    struct Scelta: Codable, Equatable {
        /// agnes, deepseek, apple
        let provider: String
        /// «Agnes», «DeepSeek», «DeepSeek V4 Pro», «Apple Intelligence»
        let nome: String
        /// rapido, normale, profondo
        let impegno: String
        /// il cervello a cui si torna a fine conversazione
        let predefinito: String
        /// vero se vale solo per questa conversazione
        let perOra: Bool
    }
    struct Melissa: Codable, Equatable {
        let stato: String
        let cervello: String
        let parziale: String?
        let registro: [Riga]
        /// assente con una Bottega sul Mac che non lo manda ancora
        var scelta: Scelta? = nil
    }
    struct Lavoro: Codable, Equatable, Identifiable {
        let chiave: String
        let origine: String
        let stato: String
        let progetto: String
        let titolo: String
        let da: Double
        let jobId: String?
        var id: String { chiave }
    }
    struct Conti: Codable, Equatable {
        let inCorso: Int
        let tiAspetta: Int
        let inCoda: Int
        let vive: Int
    }
    let versione: String
    let mac: String
    let ora: Double
    let melissa: Melissa
    let lavori: [Lavoro]
    let conti: Conti
    /// Dov'e' l'iPhone rispetto al Mac (docs/CONTRATTI.md, 9.9): usb (attaccato col cavo), casa (stessa rete,
    /// Tailscale diretto), lontano. Assente con una Bottega sul Mac che non lo manda ancora.
    var vicino: String? = nil
    /// Le stesse rotte in https (9.1): porta e impronta del certificato del Mac. Assente con una Bottega che non
    /// lo manda ancora o se l'https sul Mac non e' partito.
    struct Https: Codable, Equatable {
        let porta: Int
        let impronta: String
    }
    var https: Https? = nil

    /// Quello che lo stato dice dell'https, da ricordare (Collegamento.ricordaSicuro).
    var sicuro: Collegamento.Sicuro? { https.map { Collegamento.Sicuro(porta: $0.porta, impronta: $0.impronta) } }
}

extension StatoMac {
    private static let chiave = "ultimoStato"

    /// L'ultimo stato visto, dal gruppo condiviso tra app e widget.
    static func ultimo() -> StatoMac? {
        guard let d = Condiviso.preferenze.data(forKey: chiave) else { return nil }
        return try? JSONDecoder().decode(StatoMac.self, from: d)
    }

    func salvaComeUltimo() {
        if let d = try? JSONEncoder().encode(self) { Condiviso.preferenze.set(d, forKey: Self.chiave) }
    }
}
