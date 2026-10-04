import Foundation
import WatchConnectivity

/// Keeps a failed or not-yet-deliverable update until WatchConnectivity accepts it.
struct CodaOrologio {
    enum Invio: Equatable { case istantanea(IstantaneaOrologio), dimentica }
    private(set) var ultima: IstantaneaOrologio?
    private(set) var pendente: Invio?

    mutating func aggiorna(_ nuova: IstantaneaOrologio, forza: Bool = false) {
        if let ultima, nuova.mac == ultima.mac, nuova.visto < ultima.visto { return }
        guard forza || ultima.map({ !nuova.stessiContenuti(di: $0) || nuova.visto.timeIntervalSince($0.visto) >= 600 }) ?? true else { return }
        ultima = nuova
        pendente = .istantanea(nuova)
    }

    mutating func dimentica() { ultima = nil; pendente = .dimentica }
    mutating func reinvia() {
        if let ultima { pendente = .istantanea(ultima) }
        else { pendente = .dimentica }
    }
    mutating func conferma() { pendente = nil }
}

@MainActor
final class OrologioTelefono: NSObject, WCSessionDelegate {
    static let shared = OrologioTelefono()
    private var coda = CodaOrologio()

    func avvia() {
        guard WCSession.isSupported() else { return }
        let sessione = WCSession.default
        sessione.delegate = self
        sessione.activate()
    }

    func aggiorna(_ stato: StatoMac, forza: Bool = false) {
        let conti = stato.conteggiAttivita
        let nuova = IstantaneaOrologio(
            visto: Date(timeIntervalSince1970: stato.ora / 1000), mac: stato.mac, melissa: stato.melissa.stato,
            inCorso: conti.inCorso, tiAspetta: conti.tiAspetta, totale: conti.totale,
            sessioni: Array(stato.sessioniWidget.prefix(12)).map {
                .init(id: $0.id, fonte: $0.fonte, stato: $0.stato,
                      progetto: $0.progetto, titolo: $0.titolo)
            })
        coda.aggiorna(nuova, forza: forza)
        if case .istantanea(let pendente) = coda.pendente { pendente.salva() }
        invia()
    }

    func dimentica() {
        coda.dimentica()
        IstantaneaOrologio.dimentica()
        invia()
    }

    private func invia() {
        let sessione = WCSession.default
        guard sessione.activationState == .activated, sessione.isWatchAppInstalled,
              let pendente = coda.pendente else { return }
        var messaggio: [String: Any]
        switch pendente {
        case .istantanea(let istantanea):
            guard let dati = try? JSONEncoder().encode(istantanea) else { return }
            messaggio = ["istantanea": dati]
        case .dimentica:
            messaggio = ["dimentica": true]
        }
        // A new Watch must receive even a payload identical to the previous Watch's.
        messaggio["invio"] = UUID().uuidString
        do {
            try sessione.updateApplicationContext(messaggio)
            coda.conferma()
        } catch {
            NSLog("Bottega Watch: aggiornamento non inviato: %@", String(describing: error))
        }
    }

    private func riallinea() {
        if coda.pendente == .dimentica { invia(); return }
        if let stato = Ponte.shared.stato ?? StatoMac.ultimo() { aggiorna(stato, forza: true) }
        else { coda.reinvia(); invia() }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        Task { @MainActor in
            guard state == .activated else { return }
            self.riallinea()
        }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        Task { @MainActor in
            self.riallinea()
        }
    }

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any],
                             replyHandler: @escaping ([String: Any]) -> Void) {
        Task { @MainActor in
            if let stato = Ponte.shared.stato ?? StatoMac.ultimo() { self.aggiorna(stato, forza: true) }
            if let istantanea = self.coda.ultima ?? IstantaneaOrologio.leggi(),
               let dati = try? JSONEncoder().encode(istantanea) {
                replyHandler(["istantanea": dati])
            } else {
                replyHandler(["dimentica": true])
            }
            if message["aggiorna"] as? Bool == true {
                await Ponte.shared.aggiornaStato()
                if let stato = Ponte.shared.stato { self.aggiorna(stato, forza: true) }
            }
        }
    }
}
