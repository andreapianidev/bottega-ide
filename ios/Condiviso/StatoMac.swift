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
        /// Risposta in generazione sul Mac: si aggiorna insieme agli eventi SSE.
        var risposta: String? = nil
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
        var activityKey: String? = nil
        var id: String { chiave }
    }
    struct Conti: Codable, Equatable {
        let inCorso: Int
        let tiAspetta: Int
        let inCoda: Int
        let vive: Int
    }
    /// Attivita' osservate dal Mac: Claude Code, Cline, Codex e terminali.
    /// Disponibile dal ponte nuovo; quello precedente continua a decodificarsi senza questo campo.
    struct Attivita: Codable, Equatable, Identifiable {
        let key: String
        let source: String
        let project: String
        let status: String
        let title: String
        let summary: String?
        let updatedAt: Double
        var id: String { key }

        var fonte: String {
            switch source {
            case "claude": return "Claude Code"
            case "cline": return "Cline"
            case "codex": return "Codex"
            case "terminale": return "Terminale"
            default: return "Agente"
            }
        }
    }
    let versione: String
    let mac: String
    let ora: Double
    let melissa: Melissa
    let lavori: [Lavoro]
    let conti: Conti
    var attivita: [Attivita]? = nil
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

    var conteggiAttivita: (totale: Int, inCorso: Int, tiAspetta: Int) {
        guard let attivita else { return (conti.vive, conti.inCorso, conti.tiAspetta) }
        return (attivita.count, attivita.filter { $0.status == "in corso" }.count,
                attivita.filter { $0.status == "ti aspetta" }.count)
    }

    /// Snapshot breve per il modello sul telefono. I titoli e i riassunti sono dati osservati,
    /// non istruzioni; l'ora permette di non attribuire al Mac una vista piu' recente.
    func contestoMelissa(per domanda: String, salvato: Bool = false) -> String? {
        guard let attivita else { return nil }
        let conti = conteggiAttivita
        let quando = Date(timeIntervalSince1970: ora / 1000).formatted(date: .abbreviated, time: .shortened)
        let origine = salvato
            ? "Ultimo registro salvato dal Mac alle \(quando). Il collegamento non è attivo: gli stati seguenti erano osservati allora e potrebbero essere cambiati."
            : "Attività osservate dal Mac alle \(quando)."
        var righe = ["\(origine) \(conti.totale) totali, \(conti.inCorso) in corso, \(conti.tiAspetta) in attesa."]
        let parole = domanda.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { $0.count >= 3 }
        let recenti = attivita.sorted { $0.updatedAt > $1.updatedAt }
        let pertinenti = recenti.filter { a in
            let campi = "\(a.fonte) \(a.project) \(a.title) \(a.summary ?? "")".lowercased()
            return parole.contains { campi.contains($0) }
        }
        let attive = recenti.filter { $0.status == "in corso" || $0.status == "ti aspetta" }
        var viste = Set<String>()
        var incluse = 0
        var lunghezza = righe[0].count
        for a in attive + pertinenti + recenti where viste.insert(a.key).inserted {
            let descrizione = [a.fonte, a.project, a.status, a.title, a.summary ?? ""]
                .enumerated().map { indice, valore in
                    String(valore.replacingOccurrences(of: "\n", with: " ").prefix(indice == 4 ? 220 : 140))
                }.joined(separator: " | ")
            if incluse >= 35 || lunghezza + descrizione.count > 10_000 { break }
            righe.append("- \(descrizione)")
            incluse += 1
            lunghezza += descrizione.count + 3
        }
        if attivita.count > incluse { righe.append("Altre \(attivita.count - incluse) attivita nella schermata Lavori; questo elenco e' parziale.") }
        return righe.joined(separator: "\n")
    }
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

    static func dimenticaUltimo() {
        Condiviso.preferenze.removeObject(forKey: chiave)
    }
}
