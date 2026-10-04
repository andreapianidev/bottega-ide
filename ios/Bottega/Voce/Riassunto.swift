// Il racconto di Melissa per una stanza o una sessione: DeepSeek Flash, Agnes di riserva,
// testo e voce ElevenLabs in streaming sul telefono.
import AVFoundation
import Observation

@MainActor
@Observable
final class Riassunto {
    enum Stato: Equatable { case fermo, pensa, parla }

    private(set) var stato: Stato = .fermo
    private(set) var testo = ""
    var errore: String?

    private let flusso = FlussoVoce()
    private var compito: Task<Void, Never>?
    private var numero = 0

    func avvia(titolo: String, contesto: String) {
        guard stato == .fermo else { return ferma() }
        errore = nil
        testo = ""
        stato = .pensa
        numero += 1
        let corrente = numero
        compito = Task { await giro(titolo: titolo, contesto: contesto, numero: corrente) }
    }

    func ferma() {
        numero += 1
        compito?.cancel()
        compito = nil
        flusso.spegni()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        stato = .fermo
    }

    private func giro(titolo: String, contesto: String, numero corrente: Int) async {
        do {
            try flusso.prepara()
            _ = try await AssistenteTelefono.shared.racconta(contesto, titolo: titolo) { [weak self] pezzo in
                guard let self, self.numero == corrente else { return }
                self.testo += pezzo
            } audio: { [weak self] pcm in
                guard let self, self.numero == corrente else { return }
                self.stato = .parla
                self.flusso.accoda(pcm)
            }
            try Task.checkCancellation()
            await flusso.aspettaFine()
        } catch is CancellationError {
            // Il pulsante Ferma chiude sia la richiesta sia la voce.
        } catch {
            if numero == corrente { errore = error.localizedDescription }
        }
        guard numero == corrente else { return }
        flusso.spegni()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        compito = nil
        stato = .fermo
    }
}
