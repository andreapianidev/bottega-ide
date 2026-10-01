//
//  STT.swift
//  Bottega Nucleo
//
//  Speech to text through ElevenLabs realtime (Scribe v2). Owner's decision: no local
//  speech models and no downloads, every voice path goes through ElevenLabs.
//
//  Protocol (verified against the live endpoint, 1 Oct 2026):
//   wss://api.elevenlabs.io/v1/speech-to-text/realtime
//     ?model_id=scribe_v2_realtime&language_code=it&audio_format=pcm_16000
//     &commit_strategy=vad&vad_silence_threshold_secs=0.8      header xi-api-key
//   <- {"message_type":"session_started","session_id":...,"config":{...}}
//   -> {"message_type":"input_audio_chunk","audio_base_64":"<s16le 16k mono>","commit":false,"sample_rate":16000}
//      100 ms per chunk; "commit": true closes the current utterance by hand (push-to-talk)
//   <- {"message_type":"partial_transcript","text":"..."}       while the user speaks
//   <- {"message_type":"committed_transcript","text":"..."}     when VAD (or a manual
//      commit) closes the utterance
//   <- errors carry message_type error / auth_error / quota_exceeded / ...
//
//  Audio work happens on one private serial queue: conversion to 16 kHz Int16 with
//  AVAudioConverter, 100 ms framing, base64, send. The audio thread only enqueues.
//  Gating (conversation, wake word): only audio around the voice is sent, with 300 ms
//  of pre-roll and 1.5 s of tail, so silence is neither billed nor processed.
//

import Foundation
import AVFoundation
import os

final class ScribeClient: @unchecked Sendable {
    static let model = "scribe_v2_realtime"
    static let sampleRate = 16_000
    /// Silence that closes an utterance. Default on the server is longer (~1.8 s
    /// measured end of speech to commit).
    static let vadSilence = 0.8

    enum Event {
        case started([String: Any])
        case partial(String)
        case committed(String)
        case failed(String)
    }

    /// Delivered on the main queue.
    var onEvent: ((Event) -> Void)?

    private let q = DispatchQueue(label: "nucleo.stt", qos: .userInitiated)
    private let language: String
    private var task: URLSessionWebSocketTask?
    private var sessionStarted = false
    private var waitingChunks: [Data] = []
    private let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(ScribeClient.sampleRate),
                                       channels: 1, interleaved: true)!
    private var converter: AVAudioConverter?
    private var converterKey = ""
    private var pcm = Data()
    private static let chunkBytes = ScribeClient.sampleRate / 10 * 2   // 100 ms of s16 mono

    // Gating
    private var gated = false
    private var lastVoice: CFTimeInterval = 0
    private var preroll: [Data] = []

    /// Seconds of audio actually sent (cost awareness, reported in capabilities).
    private(set) var secondsSent: Double = 0
    private(set) var lastActivity = Date()

    init(language: String) {
        self.language = language
    }

    var isOpen: Bool { q.sync { task != nil } }
    var isReady: Bool { q.sync { task != nil && sessionStarted } }

    // MARK: - Connection

    func connect() throws {
        guard let key = ElevenLabsConfig.apiKey else {
            throw NucleoError("La trascrizione passa da ElevenLabs, ma manca la chiave (ELEVENLABS_API_KEY in ~/.secrets/elevenlabs.env).")
        }
        try q.sync {
            guard task == nil else { return }
            var comps = URLComponents(string: "wss://api.elevenlabs.io/v1/speech-to-text/realtime")!
            comps.queryItems = [
                URLQueryItem(name: "model_id", value: Self.model),
                URLQueryItem(name: "language_code", value: language),
                URLQueryItem(name: "audio_format", value: "pcm_16000"),
                URLQueryItem(name: "commit_strategy", value: "vad"),
                URLQueryItem(name: "vad_silence_threshold_secs", value: String(Self.vadSilence)),
            ]
            guard let url = comps.url else { throw NucleoError("Indirizzo della trascrizione non valido.") }
            var request = URLRequest(url: url)
            request.setValue(key, forHTTPHeaderField: "xi-api-key")
            request.timeoutInterval = 15
            let socket = URLSession.shared.webSocketTask(with: request)
            task = socket
            sessionStarted = false
            waitingChunks.removeAll()
            pcm.removeAll()
            socket.resume()
            receive(socket)
        }
    }

    /// Waits for session_started (the socket is only usable after it).
    func waitReady(timeout: Double = 6) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if isReady { return true }
            if !isOpen { return false }
            try? await Task.sleep(for: .milliseconds(30))
        }
        return isReady
    }

    func close() {
        q.async {
            let socket = self.task
            self.task = nil
            self.sessionStarted = false
            self.waitingChunks.removeAll()
            self.pcm.removeAll()
            self.preroll.removeAll()
            socket?.cancel(with: .normalClosure, reason: nil)
        }
    }

    /// Gate the audio (only around the voice) or send everything.
    func setGated(_ on: Bool) {
        q.async { self.gated = on; self.preroll.removeAll() }
    }

    // MARK: - Audio

    /// Called from the audio thread with the mic level already measured.
    func append(_ buffer: AVAudioPCMBuffer, level: Float) {
        q.async { self.ingest(buffer, level: level) }
    }

    /// Closes the current utterance now (push-to-talk released). Whatever is buffered
    /// goes out first, then an empty chunk with commit: true.
    func commit() {
        q.async {
            if !self.pcm.isEmpty {
                self.send(self.pcm, commit: false)
                self.pcm.removeAll()
            }
            self.send(Data(), commit: true)
        }
    }

    private func ingest(_ buffer: AVAudioPCMBuffer, level: Float) {
        guard task != nil, let out = convert(buffer) else { return }
        pcm.append(out)
        let now = CACurrentMediaTime()
        if level > 0.08 { lastVoice = now }
        while pcm.count >= Self.chunkBytes {
            let chunk = pcm.prefix(Self.chunkBytes)
            pcm.removeFirst(Self.chunkBytes)
            if gated, now - lastVoice > 1.5 {
                // Silence: keep the last 300 ms as pre-roll for the next onset.
                preroll.append(Data(chunk))
                if preroll.count > 3 { preroll.removeFirst() }
                continue
            }
            if !preroll.isEmpty {
                for p in preroll { send(p, commit: false) }
                preroll.removeAll()
            }
            send(Data(chunk), commit: false)
        }
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> Data? {
        guard buffer.frameLength > 0 else { return nil }
        let src = buffer.format
        let key = "\(src.commonFormat.rawValue)-\(src.sampleRate)-\(src.channelCount)-\(src.isInterleaved)"
        if converter == nil || key != converterKey {
            converter = AVAudioConverter(from: src, to: target)
            converterKey = key
        }
        guard let converter else { return nil }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / src.sampleRate + 32)
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
        var fed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, st in
            if fed { st.pointee = .noDataNow; return nil }
            fed = true
            st.pointee = .haveData
            return buffer
        }
        guard status != .error, out.frameLength > 0, let p = out.int16ChannelData?[0] else { return nil }
        return Data(bytes: p, count: Int(out.frameLength) * 2)
    }

    private func send(_ audio: Data, commit: Bool) {
        guard let socket = task else { return }
        guard sessionStarted else {
            // The session is not open yet: hold the audio (up to ~3 s) and send it in order.
            if waitingChunks.count < 30 { waitingChunks.append(audio) }
            if commit { waitingChunks.append(Data([0xC0])) }   // marker: commit after these
            return
        }
        lastActivity = Date()
        secondsSent += Double(audio.count) / Double(Self.sampleRate * 2)
        let frame = "{\"message_type\":\"input_audio_chunk\",\"audio_base_64\":\"\(audio.base64EncodedString())\",\"commit\":\(commit),\"sample_rate\":\(Self.sampleRate)}"
        socket.send(.string(frame)) { error in
            if let error { Log.info("STT: invio audio fallito (\(error.localizedDescription))") }
        }
    }

    // MARK: - Receive

    private func receive(_ socket: URLSessionWebSocketTask) {
        socket.receive { [weak self] result in
            guard let self else { return }
            self.q.async {
                guard self.task === socket else { return }
                switch result {
                case .failure(let error):
                    self.task = nil
                    self.sessionStarted = false
                    self.deliver(.failed("connessione chiusa (\(error.localizedDescription))"))
                case .success(let message):
                    self.handle(message)
                    self.receive(socket)
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let s): data = Data(s.utf8)
        case .data(let d): data = d
        @unknown default: return
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["message_type"] as? String else { return }
        lastActivity = Date()
        switch type {
        case "session_started":
            sessionStarted = true
            let held = waitingChunks
            waitingChunks.removeAll()
            for chunk in held {
                if chunk == Data([0xC0]) { send(Data(), commit: true) } else { send(chunk, commit: false) }
            }
            deliver(.started(obj["config"] as? [String: Any] ?? [:]))
        case "partial_transcript":
            deliver(.partial((obj["text"] as? String) ?? ""))
        case "committed_transcript":
            deliver(.committed((obj["text"] as? String) ?? ""))
        case "committed_transcript_with_timestamps", "committed_transcript_entities", "edited_transcript":
            break
        case "warning":
            Log.info("STT avviso: \(obj["warning"] ?? "")")
        default:
            // error, auth_error, quota_exceeded, rate_limited, input_error, ...
            let detail = (obj["error"] as? String) ?? (obj["message"] as? String) ?? type
            deliver(.failed("\(type): \(detail)"))
        }
    }

    private func deliver(_ event: Event) {
        DispatchQueue.main.async { [weak self] in self?.onEvent?(event) }
    }
}

/// Runs `body` but stops waiting for it after `seconds` (the body keeps running in the
/// background if it ignores cancellation). Returns false on timeout.
@discardableResult
func withTimeout(_ seconds: Double, _ body: @escaping @Sendable () async -> Void) async -> Bool {
    await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
        let done = OSAllocatedUnfairLock(initialState: false)
        @Sendable func finish(_ value: Bool) {
            let first = done.withLock { d -> Bool in
                if d { return false }
                d = true
                return true
            }
            if first { cont.resume(returning: value) }
        }
        Task { await body(); finish(true) }
        Task { try? await Task.sleep(for: .seconds(seconds)); finish(false) }
    }
}
