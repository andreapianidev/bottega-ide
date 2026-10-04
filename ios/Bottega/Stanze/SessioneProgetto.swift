import Foundation

/// La stessa destinazione delle righe Lavori: azioni per un lavoro collegato,
/// scheda del registro per Codex, Cline, terminali e attività non collegate.
enum SessioneProgetto: Identifiable {
    case lavoro(StatoMac.Lavoro)
    case attivita(StatoMac.Attivita)

    var id: String {
        switch self {
        case .lavoro(let lavoro): "lavoro:\(lavoro.id)"
        case .attivita(let attivita): "attivita:\(attivita.id)"
        }
    }

    var progetto: String {
        switch self {
        case .lavoro(let lavoro): lavoro.progetto
        case .attivita(let attivita): attivita.project
        }
    }

    private var stato: String {
        switch self {
        case .lavoro(let lavoro): lavoro.stato
        case .attivita(let attivita): attivita.status
        }
    }

    private var aggiornato: Double {
        switch self {
        case .lavoro(let lavoro): lavoro.da
        case .attivita(let attivita): attivita.updatedAt
        }
    }

    static func scegli(progetto: String?, da stato: StatoMac?) -> SessioneProgetto? {
        guard let nome = progetto?.trimmingCharacters(in: .whitespacesAndNewlines), !nome.isEmpty,
              let stato else { return nil }
        let attivita = stato.attivita ?? []
        // Elimina duplicati conservando la riga più recente, come il registro Lavori.
        let ultime = Dictionary(attivita.map { ($0.key, $0) }, uniquingKeysWith: {
            $0.updatedAt >= $1.updatedAt ? $0 : $1
        })
        var scelte = ultime.values.map { SessioneProgetto.attivita($0) }
        scelte += stato.lavori.filter { lavoro in
            lavoro.activityKey.map { ultime[$0] == nil } ?? true
        }.map { .lavoro($0) }
        let ordine = ["ti aspetta", "in corso", "nel terminale", "in coda", "stanotte", "errore", "sconosciuto", "finito"]
        let scelta = scelte.filter { $0.progetto.localizedCaseInsensitiveCompare(nome) == .orderedSame }.sorted {
            let a = ordine.firstIndex(of: $0.stato) ?? ordine.count
            let b = ordine.firstIndex(of: $1.stato) ?? ordine.count
            if a != b { return a < b }
            if $0.aggiornato != $1.aggiornato { return $0.aggiornato > $1.aggiornato }
            return $0.id < $1.id
        }.first
        // La priorità viene dallo stato attuale del registro. Il collegamento serve
        // soltanto ad aprire la scheda interattiva già prevista per quel lavoro.
        if case .attivita(let attivita)? = scelta,
           let lavoro = stato.lavori.first(where: { $0.activityKey == attivita.key }) {
            return .lavoro(lavoro)
        }
        return scelta
    }
}
