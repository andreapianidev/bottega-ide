import Foundation

/// Solo i dati necessari sul polso. Nessun token o credenziale lascia l'iPhone.
struct IstantaneaOrologio: Codable, Equatable {
    struct Sessione: Codable, Equatable, Identifiable {
        let id: String
        let fonte: String
        let stato: String
        let progetto: String
        let titolo: String
    }

    let visto: Date
    let mac: String
    let melissa: String
    let inCorso: Int
    let tiAspetta: Int
    let totale: Int
    let sessioni: [Sessione]

    static let gruppo = "group.com.andreapiani.bottega.ios"
    private static let chiave = "istantaneaOrologioV1"

    /// Evita di trasmettere ogni evento SSE quando i dati visibili non sono cambiati.
    func stessiContenuti(di altra: Self) -> Bool {
        mac == altra.mac && melissa == altra.melissa && inCorso == altra.inCorso &&
        tiAspetta == altra.tiAspetta && totale == altra.totale && sessioni == altra.sessioni
    }

    static func leggi() -> Self? {
        guard let dati = UserDefaults(suiteName: gruppo)?.data(forKey: chiave) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: dati)
    }

    func salva() {
        guard let dati = try? JSONEncoder().encode(self) else { return }
        UserDefaults(suiteName: Self.gruppo)?.set(dati, forKey: Self.chiave)
    }

    static func dimentica() {
        UserDefaults(suiteName: gruppo)?.removeObject(forKey: chiave)
    }
}
