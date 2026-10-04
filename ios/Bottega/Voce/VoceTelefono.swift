// La stessa voce di Melissa dal telefono: ElevenLabs Text to Dialogue, PCM mono a 24 kHz.
import Foundation

@MainActor
final class VoceTelefono {
    private let key: String
    private let voiceID: String
    private let audio: (Data) -> Void
    private var socket: URLSessionWebSocketTask?
    private var lettura: Task<Void, Never>?
    private var keepAlive: Task<Void, Never>?
    private var attesa: CheckedContinuation<Void, Error>?
    private var residuo = Data()
    private var primo = true
    private var errore: Error?
    private var haInviatoTesto = false
    private var completato = false
    private var audioFinaleDelTurno = false
    private var chiusuraRichiesta = false
    private var scadenza: Task<Void, Never>?
    private let idDiagnostica = String(UUID().uuidString.prefix(8))
    private var frammentiAudio = 0
    private var byteAudio = 0
    private var frasiInviate = 0
    private var haTracciatoFine = false

    init(key: String, voiceID: String, audio: @escaping (Data) -> Void) {
        self.key = key
        self.voiceID = voiceID
        self.audio = audio
    }

    func apri() async throws {
        var components = URLComponents(string: "wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input")!
        components.queryItems = [URLQueryItem(name: "model_id", value: "eleven_v4_turbo"),
                                 URLQueryItem(name: "output_format", value: "pcm_24000")]
        var request = URLRequest(url: components.url!, timeoutInterval: 20)
        request.setValue(key, forHTTPHeaderField: "xi-api-key")
        let task = URLSession.shared.webSocketTask(with: request)
        socket = task
        Log.info("voce ElevenLabs \(idDiagnostica): apertura websocket")
        task.resume()
        do {
            try await manda(["voices": [voiceID], "voice_settings": ["stability": 0.5, "similarity_boost": 0.75]])
        } catch {
            Log.warn("voce ElevenLabs \(idDiagnostica): inizializzazione fallita, \(categoria(error))")
            ferma()
            throw error
        }
        Log.info("voce ElevenLabs \(idDiagnostica): inizializzazione inviata")
        lettura = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    if self.ricevi(try await task.receive()) { return }
                }
                catch {
                    if Task.isCancelled || self.completato || self.socket == nil { return }
                    Log.warn("voce ElevenLabs \(self.idDiagnostica): ricezione interrotta, \(self.categoria(error)), chiusura \(task.closeCode.rawValue), audio \(self.byteAudio) byte")
                    self.errore = error
                    self.attesa?.resume(throwing: error)
                    self.attesa = nil
                    return
                }
            }
        }
        keepAlive = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(8))
                guard !Task.isCancelled, let self, self.socket != nil else { return }
                try? await self.manda(["keep_alive": true])
            }
        }
    }

    func invia(_ testo: String) async throws {
        if let errore { throw errore }
        let text = testo.hasSuffix(" ") ? testo : testo + " "
        try await manda(["inputs": [["text": text, "voice_id": voiceID, "new_turn": primo]]])
        haInviatoTesto = true
        frasiInviate += 1
        if frasiInviate == 1 { Log.info("voce ElevenLabs \(idDiagnostica): prima frase inviata") }
        primo = false
        try await manda(["flush": true])
    }

    func finisci() async throws {
        if let errore { throw errore }
        guard haInviatoTesto else { ferma(); return }
        // C'e' un solo turno (`new_turn` soltanto nella prima frase). Il marker
        // `is_final_audio_for_turn` segnala che tutto l'audio e' arrivato; `is_final`
        // puo' seguire piu' tardi quando il servizio chiude il WebSocket.
        try await manda(["close_socket": true])
        chiusuraRichiesta = true
        Log.info("voce ElevenLabs \(idDiagnostica): chiusura richiesta, frasi \(frasiInviate), audio \(byteAudio) byte")
        if audioFinaleDelTurno { completa("audio finale del turno") }
        if !completato {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
                    attesa = k
                    scadenza = Task { [weak self] in
                        try? await Task.sleep(for: .seconds(20))
                        guard let self, !Task.isCancelled, let pending = self.attesa else { return }
                        self.attesa = nil
                        Log.warn("voce ElevenLabs \(self.idDiagnostica): timeout finale, frasi \(self.frasiInviate), frammenti \(self.frammentiAudio), audio \(self.byteAudio) byte")
                        pending.resume(throwing: ErrorePonte(messaggio: "ElevenLabs non ha finito la voce in tempo."))
                    }
                }
            } onCancel: { Task { @MainActor in self.ferma() } }
        }
        ferma()
    }

    func ferma() {
        if socket != nil && !haTracciatoFine {
            haTracciatoFine = true
            Log.info("voce ElevenLabs \(idDiagnostica): fermata, finale \(completato), frasi \(frasiInviate), frammenti \(frammentiAudio), audio \(byteAudio) byte")
        }
        keepAlive?.cancel()
        keepAlive = nil
        scadenza?.cancel()
        scadenza = nil
        lettura?.cancel()
        lettura = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        attesa?.resume(throwing: CancellationError())
        attesa = nil
    }

    private func manda(_ json: [String: Any]) async throws {
        guard let socket else { throw ErrorePonte(messaggio: "ElevenLabs non è collegato.") }
        let data = try JSONSerialization.data(withJSONObject: json)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }

    /// `true` quando il protocollo e' terminato: il lettore non attende una seconda chiusura di rete.
    private func ricevi(_ message: URLSessionWebSocketTask.Message) -> Bool {
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let chunk): data = chunk
        @unknown default: return false
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            Log.warn("voce ElevenLabs \(idDiagnostica): frame non JSON, \(data.count) byte")
            return false
        }
        if json["error"] != nil || json["code"] != nil {
            let message = (json["message"] as? String) ?? "La voce ElevenLabs non risponde."
            errore = ErrorePonte(messaggio: message)
            Log.warn("voce ElevenLabs \(idDiagnostica): errore dal servizio, audio \(byteAudio) byte")
            attesa?.resume(throwing: errore!)
            attesa = nil
            return true
        }
        if let encoded = json["audio"] as? String, var pcm = Data(base64Encoded: encoded), !pcm.isEmpty {
            if !residuo.isEmpty { pcm = residuo + pcm; residuo.removeAll() }
            if pcm.count % 2 == 1 { residuo = pcm.suffix(1); pcm = pcm.dropLast() }
            if !pcm.isEmpty {
                frammentiAudio += 1
                byteAudio += pcm.count
                if frammentiAudio == 1 { Log.info("voce ElevenLabs \(idDiagnostica): primo frammento PCM, \(pcm.count) byte") }
                audio(pcm)
            }
        }
        if json["is_final_audio_for_turn"] as? Bool == true {
            audioFinaleDelTurno = true
            residuo.removeAll()
            if chiusuraRichiesta {
                completa("audio finale del turno")
                return true
            }
        }
        if json["is_final"] as? Bool == true {
            completa("socket finale")
            return true
        }
        return false
    }

    private func completa(_ motivo: String) {
        guard !completato else { return }
        completato = true
        Log.info("voce ElevenLabs \(idDiagnostica): \(motivo), frammenti \(frammentiAudio), audio \(byteAudio) byte")
        scadenza?.cancel()
        scadenza = nil
        attesa?.resume()
        attesa = nil
    }

    private func categoria(_ error: Error) -> String {
        if error is CancellationError { return "cancellazione" }
        if let url = error as? URLError { return "rete \(url.errorCode)" }
        return "errore \((error as NSError).code)"
    }
}
