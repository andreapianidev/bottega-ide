import Foundation
import WatchConnectivity

@MainActor
final class OrologioTelefono: NSObject, WCSessionDelegate {
    static let shared = OrologioTelefono()
    private var ultima: IstantaneaOrologio?
    private var daInviare: IstantaneaOrologio?
    private var vuotoDaInviare = false

    func avvia() {
        guard WCSession.isSupported() else { return }
        let sessione = WCSession.default
        sessione.delegate = self
        sessione.activate()
    }

    func aggiorna(_ stato: StatoMac) {
        let conti = stato.conteggiAttivita
        let nuova = IstantaneaOrologio(
            visto: Date(timeIntervalSince1970: stato.ora / 1000), mac: stato.mac, melissa: stato.melissa.stato,
            inCorso: conti.inCorso, tiAspetta: conti.tiAspetta, totale: conti.totale,
            sessioni: Array(stato.sessioniWidget.prefix(12)).map {
                .init(id: $0.id, fonte: $0.fonte, stato: $0.stato,
                      progetto: $0.progetto, titolo: $0.titolo)
            })
        guard ultima.map({ !nuova.stessiContenuti(di: $0) || nuova.visto.timeIntervalSince($0.visto) >= 600 }) ?? true else { return }
        ultima = nuova
        daInviare = nuova
        vuotoDaInviare = false
        nuova.salva()
        invia()
    }

    func dimentica() {
        ultima = nil
        daInviare = nil
        vuotoDaInviare = true
        IstantaneaOrologio.dimentica()
        inviaVuoto()
    }

    private func invia() {
        let sessione = WCSession.default
        guard sessione.activationState == .activated, sessione.isWatchAppInstalled,
              let istantanea = daInviare,
              let dati = try? JSONEncoder().encode(istantanea) else { return }
        do {
            try sessione.updateApplicationContext(["istantanea": dati])
            daInviare = nil
        } catch {
            NSLog("Bottega Watch: aggiornamento non inviato: %@", String(describing: error))
        }
    }

    private func inviaVuoto() {
        let sessione = WCSession.default
        guard sessione.activationState == .activated, sessione.isWatchAppInstalled else { return }
        do {
            try sessione.updateApplicationContext(["dimentica": true])
            vuotoDaInviare = false
        } catch {
            NSLog("Bottega Watch: cancellazione non inviata: %@", String(describing: error))
        }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        Task { @MainActor in
            guard state == .activated else { return }
            if self.vuotoDaInviare { self.inviaVuoto(); return }
            if let stato = Ponte.shared.stato ?? StatoMac.ultimo() { self.aggiorna(stato) }
            self.invia()
        }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        Task { @MainActor in
            if let stato = Ponte.shared.stato ?? StatoMac.ultimo() { self.aggiorna(stato) }
            self.invia()
        }
    }

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any],
                             replyHandler: @escaping ([String: Any]) -> Void) {
        Task { @MainActor in
            if let istantanea = self.ultima ?? IstantaneaOrologio.leggi(),
               let dati = try? JSONEncoder().encode(istantanea) {
                replyHandler(["istantanea": dati])
            } else {
                replyHandler(["dimentica": true])
            }
            if message["aggiorna"] as? Bool == true { await Ponte.shared.aggiornaStato() }
        }
    }
}
