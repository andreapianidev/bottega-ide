//
//  ElevenLabs.swift
//  Bottega Nucleo
//
//  Melissa's real voice. Ported from Avo Agency AI (ElevenLabsDialogueStream +
//  ElevenLabsTTSClient), with the Avo secrets store replaced by ~/.secrets/elevenlabs.env.
//
//  Realtime path: wss text-to-dialogue/stream-input, eleven_v3_conversational, pcm_24000.
//   1. connect with model_id + output_format, `xi-api-key` header;
//   2. first frame registers the session: {"voices":[id], "voice_settings":{...}};
//   3. text frames {"inputs":[{"text":"... ","voice_id":id,"new_turn":true?}]}, text
//      ending with a space (token boundary);
//   4. {"flush":true} generates what is buffered;
//   5. audio comes back as {"audio": base64 pcm}, then {"is_final_audio_for_turn":true};
//   6. the server hangs up after 20 s of silence: {"keep_alive":true} every 8 s.
//  REST fallback: POST /v1/text-to-speech/{id}?output_format=pcm_24000.
//
//  The key has restricted permissions (no user_read): account endpoints answer 401, so
//  nothing here asks the account for its balance. Characters are counted locally in
//  ~/.bottega/nucleo/usage.json. The key is never logged.
//

import Foundation

enum ElevenLabsConfig {
    static let defaultVoiceID = "QITiGyM4owEZrBEf0QV8"   // Melissa
    /// Default realtime model (owner's choice, measured 1 Oct 2026: ~200 ms to first
    /// audio on a warm socket, half the cost of eleven_v4). eleven_v4* and
    /// eleven_v3_conversational only work on the text-to-dialogue socket.
    static let realtimeModel = "eleven_v4_turbo"
    /// REST fallback: tries the same model first, then this one.
    static let restFallbackModel = "eleven_multilingual_v2"

    private static let lock = NSLock()
    nonisolated(unsafe) private static var cached: (stamp: Date?, key: String?, voice: String?)?

    private static var envFile: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".secrets/elevenlabs.env")
    }

    /// The API key: environment first, then ~/.secrets/elevenlabs.env. Re-read when the
    /// file changes, so adding the key does not need a restart.
    static var apiKey: String? { load().key }

    static var voiceID: String { load().voice ?? defaultVoiceID }

    static var isConfigured: Bool { apiKey != nil }

    private static func load() -> (key: String?, voice: String?) {
        let env = ProcessInfo.processInfo.environment
        let envKey = env["ELEVENLABS_API_KEY"].flatMap { $0.isEmpty ? nil : $0 }
        let envVoice = env["ELEVENLABS_VOICE_ID"].flatMap { $0.isEmpty ? nil : $0 }
        let stamp = (try? FileManager.default.attributesOfItem(atPath: envFile.path))?[.modificationDate] as? Date
        lock.lock(); defer { lock.unlock() }
        if let c = cached, c.stamp == stamp {
            return (envKey ?? c.key, envVoice ?? c.voice)
        }
        var fileKey: String?
        var fileVoice: String?
        if let text = try? String(contentsOf: envFile, encoding: .utf8) {
            for raw in text.components(separatedBy: .newlines) {
                var line = raw.trimmingCharacters(in: .whitespaces)
                if line.isEmpty || line.hasPrefix("#") { continue }
                if line.hasPrefix("export ") { line = String(line.dropFirst(7)) }
                guard let eq = line.firstIndex(of: "=") else { continue }
                let name = line[..<eq].trimmingCharacters(in: .whitespaces)
                var value = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
                if value.count >= 2, let f = value.first, let l = value.last, (f == "\"" && l == "\"") || (f == "'" && l == "'") {
                    value = String(value.dropFirst().dropLast())
                }
                if name == "ELEVENLABS_API_KEY", !value.isEmpty { fileKey = value }
                if name == "ELEVENLABS_VOICE_ID", !value.isEmpty { fileVoice = value }
            }
        }
        cached = (stamp, fileKey, fileVoice)
        return (envKey ?? fileKey, envVoice ?? fileVoice)
    }
}

/// Characters sent to ElevenLabs, per calendar month and per day (local time), in ~/.bottega/nucleo/usage.json.
/// The extension draws the days in the Cruscotto (src/conti.ts, CONTRATTI 14); the last 400 days are kept.
enum ElevenLabsUsage {
    private static let lock = NSLock()
    private static var file: URL { Nucleo.supportDir.appendingPathComponent("usage.json") }

    private static func monthKey(_ date: Date = Date()) -> String {
        let c = Calendar(identifier: .gregorian).dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", c.year ?? 0, c.month ?? 0)
    }

    private static func dayKey(_ date: Date = Date()) -> String {
        let c = Calendar(identifier: .gregorian).dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    private static func read() -> [String: Any] {
        guard let data = try? Data(contentsOf: file),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj
    }

    static var charsThisMonth: Int {
        lock.lock(); defer { lock.unlock() }
        let obj = read()
        let months = obj["elevenLabsCharsByMonth"] as? [String: Any] ?? [:]
        return (months[monthKey()] as? NSNumber)?.intValue ?? 0
    }

    static func add(_ chars: Int) {
        guard chars > 0 else { return }
        lock.lock(); defer { lock.unlock() }
        var obj = read()
        var months = obj["elevenLabsCharsByMonth"] as? [String: Any] ?? [:]
        let key = monthKey()
        months[key] = ((months[key] as? NSNumber)?.intValue ?? 0) + chars
        obj["elevenLabsCharsByMonth"] = months
        var days = obj["elevenLabsCharsByDay"] as? [String: Any] ?? [:]
        let day = dayKey()
        days[day] = ((days[day] as? NSNumber)?.intValue ?? 0) + chars
        for old in days.keys.sorted().dropLast(400) { days.removeValue(forKey: old) }
        obj["elevenLabsCharsByDay"] = days
        obj["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: file, options: .atomic)
        }
    }
}

enum ElevenLabsError: Error, LocalizedError {
    case notConfigured
    case server(String)
    case disconnected(String)
    case http(Int)
    case empty

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "ElevenLabs non configurato (manca la chiave)."
        case .server(let m): return "ElevenLabs: \(m)"
        case .disconnected(let m): return "ElevenLabs disconnesso: \(m)"
        case .http(let code): return "ElevenLabs ha risposto con HTTP \(code)."
        case .empty: return "ElevenLabs ha restituito un audio vuoto."
        }
    }
}

/// The realtime socket. Control (connect, send, flush, close, keep-alive) is main-actor
/// bound; receiving is not: frames are read and decoded on a private serial queue
/// (ElevenLabsReceiver), and their events land on main in arrival order.
///
/// Playback mode (`onPlayback` set before `connect()`, the Speaker): the PCM goes from the
/// socket straight to AudioOut on that queue, never through main, with an AudioOut marker
/// before the first PCM of each audio turn and one after its last. A busy main thread (the
/// island's animations, the HTTP server, a build loading the Mac) then delays only the
/// bookkeeping, not the audio. In that mode `.audio` and `.turnFinished` do not come
/// through `onEvent`.
@MainActor
final class ElevenLabsStream {
    enum Event: Sendable {
        case audio(Data)
        case turnFinished
        case sessionFinished
        case failed(ElevenLabsError)
    }

    enum Playback: Sendable {
        /// `bytes` of PCM went to AudioOut. `turn` is set on the first PCM of an audio
        /// turn: its start marker was queued just before it.
        case audio(bytes: Int, turn: Int?)
        /// is_final_audio_for_turn. `turn` is set when the turn had audio: its end marker
        /// was queued after its last PCM.
        case turnFinished(turn: Int?)
        /// AudioOut reached the start or the end marker of an audio turn. Delivered even
        /// after a close: that audio was already queued and still plays.
        case heard(turn: Int, end: Bool)
    }

    var onEvent: ((Event) -> Void)?
    var onPlayback: ((Playback) -> Void)?

    private let apiKey: String
    private let voiceID: String
    let model: String
    /// Asked every keep-alive tick: false lets the socket close after `idleCutoff`.
    var keepWarm: (() -> Bool)?
    private var task: URLSessionWebSocketTask?
    private var receiver: ElevenLabsReceiver?
    /// A close_socket frame is already queued. New text must use a fresh socket.
    private var finishing = false
    private var keepAlive: Timer?
    private var lastSend = Date()
    private(set) var hasSpokenBefore = false
    var isOpen: Bool { task != nil }
    /// The socket has sent close_socket and is still bringing in the last turn's audio: it
    /// takes no new text until the server ends the session and it is opened again.
    var isFinishing: Bool { task != nil && finishing }
    /// Seconds since the receiver last had PCM, nil if none on this connection. Ahead of
    /// main: its events may still be on their way.
    var secondsSinceAudio: TimeInterval? { receiver?.secondsSinceAudio }

    /// Close after this long without text instead of pinging forever.
    private static let idleCutoff: TimeInterval = 90

    init?(voiceID: String = ElevenLabsConfig.voiceID, model: String = ElevenLabsConfig.realtimeModel) {
        guard let key = ElevenLabsConfig.apiKey else { return nil }
        apiKey = key
        self.voiceID = voiceID
        self.model = model
    }

    @discardableResult
    func connect() -> Bool {
        guard task == nil else { return !finishing }
        var comps = URLComponents(string: "wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input")!
        comps.queryItems = [URLQueryItem(name: "model_id", value: model),
                            URLQueryItem(name: "output_format", value: "pcm_24000")]
        guard let url = comps.url else { return false }
        var request = URLRequest(url: url)
        request.setValue(apiKey, forHTTPHeaderField: "xi-api-key")
        request.timeoutInterval = 20
        let socket = URLSession.shared.webSocketTask(with: request)
        task = socket
        finishing = false
        hasSpokenBefore = false
        lastSend = Date()
        socket.resume()
        send(["voices": [voiceID], "voice_settings": ["stability": 0.5, "similarity_boost": 0.75]])
        let r = ElevenLabsReceiver(socket: socket, plays: onPlayback != nil) { [weak self] delivery in
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated { self?.deliver(delivery, from: socket) }
            }
        }
        receiver = r
        r.start()
        startKeepAlive()
        return true
    }

    func close() {
        keepAlive?.invalidate(); keepAlive = nil
        // after this nothing more of this connection reaches AudioOut or main
        receiver?.stop(); receiver = nil
        let socket = task
        task = nil
        finishing = false
        socket?.cancel(with: .goingAway, reason: nil)
    }

    func send(text: String, newTurn: Bool) {
        guard isOpen else { return }
        let padded = text.hasSuffix(" ") ? text : text + " "
        var input: [String: Any] = ["text": padded, "voice_id": voiceID]
        if newTurn { input["new_turn"] = true }
        send(["inputs": [input]])
        hasSpokenBefore = true
    }

    func flush() {
        guard isOpen else { return }
        send(["flush": true])
    }

    /// The final marker belongs to the socket, not to each flushed sentence.
    func finish() {
        guard isOpen, !finishing else { return }
        finishing = true
        send(["close_socket": true])
    }

    private func deliver(_ delivery: ElevenLabsReceiver.Delivery, from socket: URLSessionWebSocketTask) {
        switch delivery {
        case .playback(let p):
            if case .heard = p { onPlayback?(p); return }
            guard task === socket else { return }
            onPlayback?(p)
        case .event(let e):
            guard task === socket else { return }
            switch e {
            case .failed(.disconnected(_)):
                task = nil
                receiver = nil
                keepAlive?.invalidate(); keepAlive = nil
                onEvent?(e)
            case .sessionFinished:
                onEvent?(e)
                close()
            default:
                onEvent?(e)
            }
        }
    }

    private func startKeepAlive() {
        keepAlive?.invalidate()
        let timer = Timer(timeInterval: 8, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.isOpen else { return }
                let warm = self.keepWarm?() ?? false
                if !warm, Date().timeIntervalSince(self.lastSend) > Self.idleCutoff { self.close(); return }
                self.task?.send(.string(#"{"keep_alive":true}"#)) { _ in }
            }
        }
        timer.tolerance = 1
        RunLoop.main.add(timer, forMode: .common)
        keepAlive = timer
    }

    private func send(_ frame: [String: Any]) {
        guard let socket = task,
              let data = try? JSONSerialization.data(withJSONObject: frame),
              let json = String(data: data, encoding: .utf8) else { return }
        lastSend = Date()
        socket.send(.string(json)) { error in
            if let error { Log.warn("ElevenLabs: invio fallito (\(error.localizedDescription))") }
        }
    }
}

/// The receiving half of one connection. Everything here runs on `lane`, never on main:
/// receive, JSON and base64, the odd trailing byte, and in playback mode the Float32
/// conversion and the hand-off to AudioOut, markers included, in arrival order.
private final class ElevenLabsReceiver: @unchecked Sendable {
    enum Delivery: Sendable {
        case event(ElevenLabsStream.Event)
        case playback(ElevenLabsStream.Playback)
    }

    private let socket: URLSessionWebSocketTask
    private let plays: Bool
    /// Hops to main. Called in arrival order, and (except `.heard`) never after `stop()`.
    private let deliver: @Sendable (Delivery) -> Void
    private let lane = DispatchQueue(label: "nucleo.elevenlabs-in", qos: .userInitiated)

    // lane only
    /// Odd trailing byte of a chunk: a 16-bit frame split across two messages.
    private var residue = Data()
    /// The audio turn being played: its start marker is queued, its end marker not yet.
    private var turn: Int?
    /// AudioOut generation of that turn: a barge-in drops the rest of it.
    private var turnGeneration = 0

    // shared with main, under `lock`
    private let lock = NSLock()
    private var alive = true
    private var lastAudio: DispatchTime?

    /// Audio turn numbers, unique across connections (the Speaker keys segments by them).
    private static let seqLock = NSLock()
    nonisolated(unsafe) private static var seq = 0

    init(socket: URLSessionWebSocketTask, plays: Bool, deliver: @escaping @Sendable (Delivery) -> Void) {
        self.socket = socket
        self.plays = plays
        self.deliver = deliver
    }

    func start() { lane.async { self.receiveNext() } }

    /// After this returns nothing more of this connection reaches AudioOut or main (bar the
    /// `.heard` of markers already queued).
    func stop() {
        lock.lock(); alive = false; lock.unlock()
    }

    var secondsSinceAudio: TimeInterval? {
        lock.lock(); defer { lock.unlock() }
        guard let lastAudio else { return nil }
        return Double(DispatchTime.now().uptimeNanoseconds - lastAudio.uptimeNanoseconds) / 1e9
    }

    private var isAlive: Bool {
        lock.lock(); defer { lock.unlock() }
        return alive
    }

    private static func nextTurn() -> Int {
        seqLock.lock(); defer { seqLock.unlock() }
        seq += 1
        return seq
    }

    private func receiveNext() {
        socket.receive { [self] result in
            let at = DispatchTime.now()
            lane.async {
                guard self.isAlive else { return }
                switch result {
                case .success(let message):
                    if self.handle(message, receivedAt: at) { self.receiveNext() }
                case .failure(let error):
                    self.post(.event(.failed(.disconnected(error.localizedDescription))))
                }
            }
        }
    }

    private func post(_ d: Delivery) {
        lock.lock(); defer { lock.unlock() }
        if alive { deliver(d) }
    }

    /// False once the session is over: nothing more to read.
    private func handle(_ message: URLSessionWebSocketTask.Message, receivedAt: DispatchTime) -> Bool {
        let payload: Data
        switch message {
        case .string(let s): payload = Data(s.utf8)
        case .data(let d): payload = d
        @unknown default: return true
        }
        guard let frame = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { return true }
        if frame["error"] != nil || frame["code"] != nil {
            let detail = (frame["message"] as? String) ?? (frame["error"] as? String) ?? "errore sconosciuto"
            post(.event(.failed(.server(detail))))
            return true
        }
        if let b64 = frame["audio"] as? String, var pcm = Data(base64Encoded: b64), !pcm.isEmpty {
            if !residue.isEmpty { pcm = residue + pcm; residue.removeAll() }
            if pcm.count % 2 == 1 { residue = pcm.suffix(1); pcm = pcm.dropLast() }
            if !pcm.isEmpty { audio(pcm, receivedAt: receivedAt) }
        }
        if frame["is_final_audio_for_turn"] as? Bool == true {
            residue.removeAll()
            turnEnded()
        }
        if frame["is_final"] as? Bool == true {
            post(.event(.sessionFinished))
            return false
        }
        return true
    }

    private func audio(_ pcm: Data, receivedAt: DispatchTime) {
        guard plays else { return post(.event(.audio(pcm))) }
        // under the lock: a close() on main waits for this hand-off, then nothing follows it
        lock.lock(); defer { lock.unlock() }
        guard alive else { return }
        lastAudio = receivedAt
        var started: Int?
        if turn == nil {
            started = Self.nextTurn()
            turn = started
            turnGeneration = AudioOut.shared.generation
        }
        let gen = turnGeneration
        // main learns of the turn before its start marker can fire (both hop to main, in order)
        deliver(.playback(.audio(bytes: pcm.count, turn: started)))
        if let started {
            let deliver = self.deliver
            AudioOut.shared.marker(generation: gen) { deliver(.playback(.heard(turn: started, end: false))) }
        }
        AudioOut.shared.enqueuePCM16(pcm, generation: gen, receivedAt: started == nil ? nil : receivedAt)
    }

    private func turnEnded() {
        guard plays else { return post(.event(.turnFinished)) }
        lock.lock(); defer { lock.unlock() }
        guard alive else { return }
        let ended = turn
        turn = nil
        deliver(.playback(.turnFinished(turn: ended)))
        if let ended {
            let deliver = self.deliver
            AudioOut.shared.marker(generation: turnGeneration) { deliver(.playback(.heard(turn: ended, end: true))) }
        }
    }
}

enum ElevenLabsREST {
    /// One sentence, raw PCM 16-bit 24 kHz back.
    static func synthesize(_ text: String, voiceID: String = ElevenLabsConfig.voiceID,
                           model: String = ElevenLabsConfig.realtimeModel) async throws -> Data {
        do {
            return try await request(text, voiceID: voiceID, model: model)
        } catch ElevenLabsError.http(400) where model != ElevenLabsConfig.restFallbackModel {
            // The newest models are socket-only: REST answers 400 unsupported_model.
            return try await request(text, voiceID: voiceID, model: ElevenLabsConfig.restFallbackModel)
        }
    }

    private static func request(_ text: String, voiceID: String, model: String) async throws -> Data {
        guard let key = ElevenLabsConfig.apiKey else { throw ElevenLabsError.notConfigured }
        var comps = URLComponents(string: "https://api.elevenlabs.io/v1/text-to-speech/\(voiceID)")!
        comps.queryItems = [URLQueryItem(name: "output_format", value: "pcm_24000")]
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "POST"
        req.timeoutInterval = 30
        req.setValue(key, forHTTPHeaderField: "xi-api-key")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "text": text,
            "model_id": model,
            "voice_settings": ["stability": 0.5, "similarity_boost": 0.75],
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw ElevenLabsError.http(0) }
        guard http.statusCode == 200 else { throw ElevenLabsError.http(http.statusCode) }
        guard !data.isEmpty else { throw ElevenLabsError.empty }
        ElevenLabsUsage.add(text.count)
        return data
    }
}

enum SpokenText {
    /// Removes ElevenLabs v3 delivery tags like [laughs] or [whispers]: every other engine
    /// would read them aloud.
    static func strippingAudioTags(_ text: String) -> String {
        let stripped = text.replacingOccurrences(of: #"\[[^\]\n]{1,40}\]"#, with: " ", options: .regularExpression)
        return stripped.replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
