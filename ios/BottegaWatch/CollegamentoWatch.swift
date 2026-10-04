import Foundation
import WatchConnectivity
import WidgetKit

@MainActor
final class CollegamentoWatch: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = CollegamentoWatch()
    @Published private(set) var istantanea = IstantaneaOrologio.leggi()

    func avvia() {
        guard WCSession.isSupported() else { return }
        let sessione = WCSession.default
        sessione.delegate = self
        if sessione.activationState == .notActivated { sessione.activate() }
        ricevi(sessione.receivedApplicationContext)
    }

    func aggiorna() {
        let sessione = WCSession.default
        guard sessione.activationState == .activated else { return }
        if sessione.isReachable {
            sessione.sendMessage(["aggiorna": true], replyHandler: { [weak self] risposta in
                Task { @MainActor in self?.ricevi(risposta) }
            }, errorHandler: { _ in })
        }
    }

    private func ricevi(_ messaggio: [String: Any]) {
        if messaggio["dimentica"] as? Bool == true {
            istantanea = nil
            IstantaneaOrologio.dimentica()
            WidgetCenter.shared.reloadTimelines(ofKind: "BottegaWatch")
            return
        }
        guard let dati = messaggio["istantanea"] as? Data,
              let nuova = try? JSONDecoder().decode(IstantaneaOrologio.self, from: dati),
              istantanea.map({ nuova.visto >= $0.visto }) ?? true else { return }
        istantanea = nuova
        nuova.salva()
        WidgetCenter.shared.reloadTimelines(ofKind: "BottegaWatch")
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        Task { @MainActor in
            if state == .activated {
                self.ricevi(session.receivedApplicationContext)
                self.aggiorna()
            }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext context: [String: Any]) {
        Task { @MainActor in self.ricevi(context) }
    }
}
