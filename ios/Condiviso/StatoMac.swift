//
//  StatoMac.swift
//  Bottega per iPhone (app e widget)
//
//  Lo stato del Mac come lo manda il ponte (GET /v1/stato, docs/CONTRATTI.md, 9.1). L'app lo salva anche nel
//  gruppo condiviso, cosi' i widget hanno sempre l'ultimo stato visto anche quando il Mac non risponde.
//

import Foundation

/// Il nome da solo non identifica una cartella: due progetti omonimi restano distinti.
struct ProgettoLavori {
    let nome: String
    let path: String?

    init(nome: String, path: String?) {
        self.nome = nome.isEmpty ? "Progetto non indicato" : nome
        self.path = path.flatMap { $0.isEmpty ? nil : $0 }
    }

    var id: String { path.map { "path:\($0)" } ?? "nome:\(nome)" }

    static func etichette(_ progetti: [Self]) -> [String: String] {
        let unici = Dictionary(progetti.map { ($0.id, $0) }, uniquingKeysWith: { primo, _ in primo })
        let omonimi = Dictionary(grouping: unici.values, by: \.nome)
        return unici.mapValues { p in
            guard (omonimi[p.nome]?.count ?? 0) > 1 else { return p.nome }
            let cartella = p.path.map { URL(fileURLWithPath: $0).deletingLastPathComponent().path }
                ?? "percorso non disponibile"
            return "\(p.nome) · \(cartella)"
        }
    }
}

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
        /// Chi ha la chiamata nella barra del Mac: "melissa" o la chiave di un personaggio (docs/CONTRATTI.md, 9.1).
        /// Assente con una Bottega sul Mac che non lo manda ancora: vale Melissa.
        var personaggio: String? = nil
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
        var path: String? = nil
        var id: String { chiave }
    }
    struct Conti: Codable, Equatable {
        let inCorso: Int
        let tiAspetta: Int
        let inCoda: Int
        let vive: Int
        /// Assenti se il Mac usa ancora il ponte precedente al quadro Lavori.
        var nelTerminale: Int? = nil
        var stanotte: Int? = nil
    }
    struct QuadroLavori: Codable, Equatable {
        struct Progetto: Codable, Equatable {
            let nome: String
            let conteggio: Int
        }
        struct Giorno: Codable, Equatable {
            let data: String
            let conteggio: Int
        }
        let progetti: [Progetto]
        let giorni: [Giorno]
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
        var startedAt: Double? = nil
        var steps: [String]? = nil
        var evidence: String? = nil
        var path: String? = nil
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
    struct RegiaDigest: Codable, Equatable {
        let at: Double
        let text: String
        let engine: String
    }
    let versione: String
    let mac: String
    let ora: Double
    let melissa: Melissa
    let lavori: [Lavoro]
    let conti: Conti
    /// Aggregati dal Mac prima che la lista Lavori venga limitata a 40 righe.
    var quadroLavori: QuadroLavori? = nil
    var attivita: [Attivita]? = nil
    var regiaDigest: RegiaDigest? = nil
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
    /// Quello che la memoria della Bottega sa del lavoro di Andrea (docs/CONTRATTI.md, 9.11): riassunto del progetto
    /// piu' recente e titoli degli ultimi tre giorni, gia' pronto e censurato dal Mac. Assente con un Mac che non lo
    /// manda ancora. Si salva con lo stato, cosi' senza Mac si usa l'ultimo, con la sua ora.
    var memoria: String? = nil

    /// Quello che lo stato dice dell'https, da ricordare (Collegamento.ricordaSicuro).
    var sicuro: Collegamento.Sicuro? { https.map { Collegamento.Sicuro(porta: $0.porta, impronta: $0.impronta) } }

    /// Un'unica proiezione per righe, progetti e contatori dei widget. Il registro nuovo,
    /// anche vuoto, e' autorevole: non si somma alla vecchia lista Claude.
    struct SessioneWidget: Equatable, Identifiable {
        let id: String
        let fonte: String
        let stato: String
        let progetto: String
        let titolo: String
        let da: Double
        var aggiornato: Double? = nil
        var path: String? = nil

        var attiva: Bool { stato == "ti aspetta" || stato == "in corso" }
        fileprivate var rango: Int {
            let ordine = ["ti aspetta", "in corso", "nel terminale", "in coda", "stanotte", "errore", "sconosciuto", "finito"]
            return ordine.firstIndex(of: stato) ?? ordine.count
        }
    }

    var sessioniWidget: [SessioneWidget] {
        let righe: [SessioneWidget]
        if let attivita {
            righe = attivita.map {
                SessioneWidget(id: $0.key, fonte: $0.fonte, stato: $0.status,
                               progetto: $0.project, titolo: $0.title, da: $0.startedAt ?? $0.updatedAt,
                               aggiornato: $0.updatedAt, path: $0.path)
            }
        } else {
            righe = lavori.map {
                SessioneWidget(id: $0.activityKey ?? $0.chiave, fonte: "Claude Code", stato: $0.stato,
                               progetto: $0.progetto, titolo: $0.titolo, da: $0.da, path: $0.path)
            }
        }
        // Se una sorgente ripete la chiave, conta una sola sessione e conserva il dato piu' recente.
        var uniche: [String: SessioneWidget] = [:]
        for riga in righe {
            if let precedente = uniche[riga.id], (precedente.aggiornato ?? precedente.da) >= (riga.aggiornato ?? riga.da) { continue }
            uniche[riga.id] = riga
        }
        return uniche.values.sorted {
            if $0.rango != $1.rango { return $0.rango < $1.rango }
            let a = $0.aggiornato ?? $0.da, b = $1.aggiornato ?? $1.da
            if a != b { return a > b }
            return $0.id < $1.id
        }
    }

    var progettiWidget: [String] {
        var visti = Set<String>()
        return sessioniWidget.filter { attivita == nil || $0.attiva }
            .map(\.progetto).filter { visti.insert($0).inserted }
    }

    var conteggiAttivita: (totale: Int, inCorso: Int, tiAspetta: Int) {
        guard attivita != nil else { return (conti.vive, conti.inCorso, conti.tiAspetta) }
        let sessioni = sessioniWidget
        return (sessioni.count, sessioni.filter { $0.stato == "in corso" }.count,
                sessioni.filter { $0.stato == "ti aspetta" }.count)
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
    /// La memoria per il prompt di Melissa e dei personaggi: dati, non istruzioni. `salvato`: il Mac non risponde e
    /// si usa l'ultima vista, dichiarandone l'ora come per lo snapshot delle attivita'.
    func contestoMemoria(salvato: Bool = false) -> String? {
        guard let m = memoria?.trimmingCharacters(in: .whitespacesAndNewlines), !m.isEmpty else { return nil }
        let quando = Date(timeIntervalSince1970: ora / 1000).formatted(date: .abbreviated, time: .shortened)
        let origine = salvato
            ? "Ultima memoria salvata dal Mac alle \(quando); il collegamento non è attivo e nel frattempo puo' essere cambiata."
            : "Memoria letta dal Mac alle \(quando)."
        return origine + "\n" + String(m.prefix(2500))
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
