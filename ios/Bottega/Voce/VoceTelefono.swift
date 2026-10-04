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
    private var inviati = 0
    private var finiti = 0
    private var scadenza: Task<Void, Never>?

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
        task.resume()
        try await manda(["voices": [voiceID], "voice_settings": ["stability": 0.5, "similarity_boost": 0.75]])
        lettura = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do { self.ricevi(try await task.receive()) }
                catch {
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
        inviati += 1
        try await manda(["inputs": [["text": text, "voice_id": voiceID, "new_turn": primo]]])
        primo = false
        try await manda(["flush": true])
    }

    func finisci() async throws {
        if let errore { throw errore }
        try await manda(["flush": true])
        if finiti < inviati {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (k: CheckedContinuation<Void, Error>) in
                    attesa = k
                    scadenza = Task { [weak self] in
                        try? await Task.sleep(for: .seconds(20))
                        guard let self, !Task.isCancelled, let pending = self.attesa else { return }
                        self.attesa = nil
                        pending.resume(throwing: ErrorePonte(messaggio: "ElevenLabs non ha finito la voce in tempo."))
                    }
                }
            } onCancel: { Task { @MainActor in self.ferma() } }
        }
        ferma()
    }

    func ferma() {
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

    private func ricevi(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let chunk): data = chunk
        @unknown default: return
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if json["error"] != nil || json["code"] != nil {
            let message = (json["message"] as? String) ?? "La voce ElevenLabs non risponde."
            errore = ErrorePonte(messaggio: message)
            attesa?.resume(throwing: errore!)
            attesa = nil
            return
        }
        if let encoded = json["audio"] as? String, var pcm = Data(base64Encoded: encoded), !pcm.isEmpty {
            if !residuo.isEmpty { pcm = residuo + pcm; residuo.removeAll() }
            if pcm.count % 2 == 1 { residuo = pcm.suffix(1); pcm = pcm.dropLast() }
            if !pcm.isEmpty { audio(pcm) }
        }
        if json["is_final_audio_for_turn"] as? Bool == true {
            residuo.removeAll()
            finiti += 1
            if finiti >= inviati {
                scadenza?.cancel()
                scadenza = nil
                attesa?.resume()
                attesa = nil
            }
        }
    }
}
