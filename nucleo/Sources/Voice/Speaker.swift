//
//  Speaker.swift
//  Bottega Nucleo
//
//  Text to speech. Two engines behind one queue:
//   - ElevenLabs realtime (text-to-dialogue socket, default model eleven_v4_turbo), kept
//     WARM while voice is in use, so a reply starts ~200 ms after its first clause;
//   - Apple AVSpeechSynthesizer (premium Emma it-IT), the default without a key and the
//     fallback on any ElevenLabs error.
//  Both render into AudioOut, which plays everything gapless and meters the real output
//  for the orb.
//
//  Streaming: `voice.speak {text, append:true}` adds LLM chunks to an open turn; the first
//  complete clause is synthesized immediately, then each sentence; `final:true` flushes
//  the rest and closes the turn. A plain `voice.speak {text}` is a whole turn.
//
//  Events: voice.spoken {text, engine} when a segment has been HEARD (not just generated),
//  and voice.state through VoiceHub.
//

import Foundation
import AVFoundation

@MainActor
final class Speaker: NSObject {
    static let shared = Speaker()

    static var defaultModel: String { ElevenLabsConfig.realtimeModel }

    enum Engine: String { case elevenlabs, apple }

    /// One flushed (ElevenLabs) or synthesized (Apple) piece of text.
    final class Segment {
        let id: Int
        let text: String
        let engine: Engine
        var started = false
        var pcmBytes = 0
        init(id: Int, text: String, engine: Engine) {
            self.id = id; self.text = text; self.engine = engine
        }
    }

    /// The reply currently being received from the extension.
    private final class Turn {
        var engine: Engine
        let model: String
        let voiceID: String?
        let appleVoice: String?
        var buffer = ""            // text not yet handed to an engine
        var firstSent = false
        var piecesSent = 0
        var open = true
        init(engine: Engine, model: String, voiceID: String?, appleVoice: String?) {
            self.engine = engine; self.model = model; self.voiceID = voiceID; self.appleVoice = appleVoice
        }
    }

    private var turn: Turn?
    /// A streamed turn whose `final` never comes (extension bug, LLM stalled) must not
    /// keep the voice "speaking" forever: closed after 20 s without new text.
    private var turnIdle: DispatchWorkItem?
    private var segmentSeq = 0
    private var generation = 0

    // ElevenLabs
    private var streams: [String: ElevenLabsStream] = [:]
    /// Per stream: segments sent, in order, waiting for is_final_audio_for_turn.
    private var inflight: [String: [Segment]] = [:]
    /// Per stream: text sent since the last flush (becomes a segment at flush).
    private var unflushed: [String: String] = [:]
    private var watchdogs: [String: DispatchWorkItem] = [:]
    private var cooldownUntil: Date?
    private var reconnectDelay: TimeInterval = 1
    private var lastUse = Date.distantPast

    // Apple
    private let synth = AVSpeechSynthesizer()
    private var appleQueue: [(Segment, String?)] = []
    private var appleCurrent: Segment?

    /// Segments scheduled in AudioOut whose end marker has not fired yet.
    private var awaitingHeard = 0

    /// Everything spoken in the current speaking episode (for echo rejection).
    private(set) var spokenSoFar = ""

    private override init() {
        super.init()
        synth.delegate = self
    }

    // MARK: - State

    var isSpeaking: Bool {
        (turn != nil) || awaitingHeard > 0 || appleCurrent != nil || !appleQueue.isEmpty
            || inflight.values.contains { !$0.isEmpty }
    }

    var currentEngine: Engine {
        if ElevenLabsConfig.isConfigured, !inCooldown { return .elevenlabs }
        return .apple
    }

    private var inCooldown: Bool {
        if let until = cooldownUntil, until > Date() { return true }
        return false
    }

    /// The socket stays open while voice is in use: conversation, big orb on screen, or a
    /// reply in the last two minutes. Outside that, it closes after 90 s of silence.
    var keepWarm: Bool {
        VoiceHub.shared.conversing || OrbPanel.shared.isExpanded || Date().timeIntervalSince(lastUse) < 120
    }

    // MARK: - Public API

    /// Opens the default ElevenLabs socket ahead of time. Cheap and idempotent.
    func prewarm(model: String? = nil) {
        guard currentEngine == .elevenlabs else { return }
        _ = stream(model: model ?? Self.defaultModel, voiceID: nil)?.connect()
    }

    func speak(text: String, append: Bool, final: Bool, model: String?, voice: String?) {
        lastUse = Date()
        if !append, let t = turn, t.open {
            // A whole reply arriving while a streamed one is still open: close the open one.
            closeTurn(t)
        }
        let t: Turn
        if let existing = turn, existing.open {
            t = existing
        } else {
            t = makeTurn(model: model, voice: voice)
            turn = t
        }
        t.buffer += text
        drain(t, final: final || !append)
        turnIdle?.cancel(); turnIdle = nil
        if final || !append {
            closeTurn(t)
        } else {
            let work = DispatchWorkItem { [weak self, weak t] in
                MainActor.assumeIsolated {
                    guard let self, let t, self.turn === t, t.open else { return }
                    Log.info("turno di voce chiuso per inattivita' (manca final)")
                    self.closeTurn(t)
                    self.endEpisodeIfIdle()
                    VoiceHub.shared.refresh()
                }
            }
            turnIdle = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: work)
        }
        VoiceHub.shared.refresh()
    }

    /// Barge-in: silence now, drop everything queued, keep the socket warm.
    func stopSpeaking() {
        generation += 1
        AudioOut.shared.stop()
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        appleQueue.removeAll()
        appleCurrent = nil
        awaitingHeard = 0
        turn = nil
        turnIdle?.cancel(); turnIdle = nil
        // A socket mid-generation would keep streaming audio for the cancelled reply:
        // close it and open a fresh one (keeps the next reply fast).
        for (key, s) in streams where !(inflight[key]?.isEmpty ?? true) || !(unflushed[key]?.isEmpty ?? true) {
            s.close()
            inflight[key] = []
            unflushed[key] = ""
            watchdogs[key]?.cancel()
            if keepWarm { s.connect() }
        }
        endEpisodeIfIdle()
        VoiceHub.shared.refresh()
    }

    // MARK: - Turn handling

    private func makeTurn(model: String?, voice: String?) -> Turn {
        var engine = currentEngine
        var appleVoice: String?
        var elVoice: String?
        if let v = voice?.trimmingCharacters(in: .whitespaces), !v.isEmpty {
            if v == "apple" { engine = .apple }
            else if v.hasPrefix("com.apple.") { engine = .apple; appleVoice = v }
            else if v == "elevenlabs" { /* default voice */ }
            else { elVoice = v }
        }
        return Turn(engine: engine, model: (model?.isEmpty == false) ? model! : Self.defaultModel,
                    voiceID: elVoice, appleVoice: appleVoice)
    }

    private func closeTurn(_ t: Turn) {
        t.open = false
        drain(t, final: true)
        if turn === t { turn = nil }
        Log.info("voce: turno chiuso, \(t.piecesSent) segmenti inviati a \(t.engine.rawValue)")
        // `flush` forces the current sentence, but does not finalize the dialogue
        // session. Close only after the final text frame: ElevenLabs then emits all
        // remaining PCM and its terminal marker. Otherwise the last sentence can
        // remain pending until the server's idle timeout.
        if t.engine == .elevenlabs, t.firstSent, let key = key(t) {
            streams[key]?.finish()
        }
    }

    /// Hands complete pieces of the turn's buffer to its engine. The first clause goes
    /// out alone (lowest latency to first audio), then whole sentences.
    private func drain(_ t: Turn, final: Bool) {
        while let cut = Self.boundary(in: t.buffer, clauseOK: !t.firstSent) {
            let piece = String(t.buffer[..<cut])
            t.buffer = String(t.buffer[cut...])
            emitPiece(piece, turn: t)
        }
        if final {
            let rest = t.buffer
            t.buffer = ""
            emitPiece(rest, turn: t, last: true)
        }
    }

    private func emitPiece(_ raw: String, turn t: Turn, last: Bool = false) {
        let clean = Self.cleanForSpeech(raw)
        switch t.engine {
        case .elevenlabs:
            if clean.isEmpty {
                if last, let key = key(t), !(unflushed[key]?.isEmpty ?? true) { flush(key) }
                return
            }
            guard let s = stream(model: t.model, voiceID: t.voiceID), s.connect(), let key = key(t) else {
                // No socket: this turn continues on Apple.
                t.engine = .apple
                enqueueApple(clean, voice: t.appleVoice)
                return
            }
            let newTurn = !t.firstSent && s.hasSpokenBefore && (inflight[key]?.isEmpty ?? true)
            s.send(text: clean, newTurn: newTurn)
            ElevenLabsUsage.add(clean.count)
            unflushed[key, default: ""] += (unflushed[key]?.isEmpty ?? true) ? clean : " " + clean
            t.firstSent = true
            t.piecesSent += 1
            flush(key)
        case .apple:
            t.firstSent = true
            let spoken = SpokenText.strippingAudioTags(clean)
            if !spoken.isEmpty { t.piecesSent += 1; enqueueApple(spoken, voice: t.appleVoice) }
        }
    }

    private func key(_ t: Turn) -> String? { "\(t.model)|\(t.voiceID ?? ElevenLabsConfig.voiceID)" }

    // MARK: - ElevenLabs

    private func stream(model: String, voiceID: String?) -> ElevenLabsStream? {
        let voice = voiceID ?? ElevenLabsConfig.voiceID
        let key = "\(model)|\(voice)"
        if let s = streams[key] { return s }
        guard let s = ElevenLabsStream(voiceID: voice, model: model) else { return nil }
        s.keepWarm = { [weak self] in self?.keepWarm ?? false }
        s.onEvent = { [weak self, weak s] event in
            guard let self, let s else { return }
            self.handle(event, key: key, stream: s)
        }
        streams[key] = s
        inflight[key] = []
        unflushed[key] = ""
        return s
    }

    private func flush(_ key: String) {
        guard let s = streams[key], let text = unflushed[key], !text.isEmpty else { return }
        unflushed[key] = ""
        segmentSeq += 1
        inflight[key, default: []].append(Segment(id: segmentSeq, text: text, engine: .elevenlabs))
        s.flush()
        armWatchdog(key)
    }

    /// No audio and no end of turn for 8 s while text is pending: the socket is stuck.
    private func armWatchdog(_ key: String) {
        watchdogs[key]?.cancel()
        let gen = generation
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, gen == self.generation, !(self.inflight[key]?.isEmpty ?? true) else { return }
                Log.warn("ElevenLabs non risponde da 8 secondi, passo alla voce di Apple.")
                self.failStream(key, reason: "nessuna risposta")
            }
        }
        watchdogs[key] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
    }

    private func handle(_ event: ElevenLabsStream.Event, key: String, stream s: ElevenLabsStream) {
        switch event {
        case .audio(let pcm):
            guard let head = inflight[key]?.first ?? pendingHeadPlaceholder(key) else { return }
            armWatchdog(key)
            reconnectDelay = 1
            if !head.started {
                head.started = true
                scheduleStartMarker(head)
            }
            head.pcmBytes += pcm.count
            AudioOut.shared.enqueuePCM16(pcm, generation: AudioOut.shared.generation)
        case .turnFinished:
            guard var list = inflight[key], !list.isEmpty else { return }
            let seg = list.removeFirst()
            inflight[key] = list
            if list.isEmpty { watchdogs[key]?.cancel() }
            Log.info("voce: segmento \(seg.id) concluso, \(seg.pcmBytes) byte PCM, \(list.count) in attesa")
            if seg.started { scheduleEndMarker(seg) }
            endEpisodeIfIdle()
        case .sessionFinished:
            if !(inflight[key]?.isEmpty ?? true) { failStream(key, reason: "sessione ElevenLabs chiusa prima dell'audio finale") }
            else if keepWarm {
                // ElevenLabsStream closes the old socket just after this callback.
                // Reconnect on the next main-loop turn so the following reply is warm.
                DispatchQueue.main.async { [weak s] in
                    MainActor.assumeIsolated {
                        guard let s, !s.isOpen, Speaker.shared.keepWarm else { return }
                        s.connect()
                    }
                }
            }
        case .failed(let error):
            let pending = !(inflight[key]?.isEmpty ?? true)
            if pending {
                Log.warn("\(error.localizedDescription). Continuo con la voce di Apple.")
                failStream(key, reason: error.localizedDescription)
            } else if keepWarm {
                // Idle socket dropped by the server: reopen quietly, with backoff.
                let delay = reconnectDelay
                reconnectDelay = min(30, reconnectDelay * 2)
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak s] in
                    MainActor.assumeIsolated {
                        guard let s, !s.isOpen, Speaker.shared.keepWarm else { return }
                        s.connect()
                    }
                }
            }
        }
    }

    /// Audio that arrives for text the server generated before our flush (it starts on
    /// its own after ~40 characters): it belongs to the segment still being built.
    private func pendingHeadPlaceholder(_ key: String) -> Segment? {
        guard let text = unflushed[key], !text.isEmpty else { return nil }
        // Promote the unflushed text to a segment now; the later flush adds no new text.
        unflushed[key] = ""
        segmentSeq += 1
        let seg = Segment(id: segmentSeq, text: text, engine: .elevenlabs)
        inflight[key, default: []].append(seg)
        streams[key]?.flush()
        return seg
    }

    private func failStream(_ key: String, reason: String) {
        watchdogs[key]?.cancel()
        let list = inflight[key] ?? []
        inflight[key] = []
        let rest = unflushed[key] ?? ""
        unflushed[key] = ""
        streams[key]?.close()
        cooldownUntil = Date().addingTimeInterval(60)
        // Text that never made a sound goes to Apple; a half-spoken segment is dropped
        // (repeating it from the start would sound like a stutter).
        var reroute: [String] = list.filter { !$0.started }.map(\.text)
        if !rest.isEmpty { reroute.append(rest) }
        if let t = turn, t.engine == .elevenlabs { t.engine = .apple }
        for text in reroute {
            let spoken = SpokenText.strippingAudioTags(text)
            if !spoken.isEmpty { enqueueApple(spoken, voice: nil) }
        }
        Out.event("voice.engine", ["engine": "apple", "reason": reason])
        endEpisodeIfIdle()
        VoiceHub.shared.refresh()
    }

    // MARK: - Apple

    private func enqueueApple(_ text: String, voice: String?) {
        segmentSeq += 1
        appleQueue.append((Segment(id: segmentSeq, text: text, engine: .apple), voice))
        pumpApple()
    }

    nonisolated static func appleVoice(_ identifier: String? = nil) -> AVSpeechSynthesisVoice? {
        if let identifier, let v = AVSpeechSynthesisVoice(identifier: identifier) { return v }
        if let v = AVSpeechSynthesisVoice(identifier: "com.apple.voice.premium.it-IT.Emma") { return v }
        let italian = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "it-IT" }
        return italian.max { $0.quality.rawValue < $1.quality.rawValue } ?? AVSpeechSynthesisVoice(language: "it-IT")
    }

    private func pumpApple() {
        guard appleCurrent == nil, !appleQueue.isEmpty else { return }
        let (seg, voice) = appleQueue.removeFirst()
        appleCurrent = seg
        let utterance = AVSpeechUtterance(string: seg.text)
        utterance.voice = Self.appleVoice(voice)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        let gen = generation
        let audioGen = AudioOut.shared.generation
        var first = true
        // write() renders faster than real time: the next segment is synthesized while
        // this one is still playing, which is what makes the queue gapless.
        synth.write(utterance) { [weak self] buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            if pcm.frameLength == 0 {
                DispatchQueue.main.async { self?.appleSegmentRendered(seg, gen: gen) }
                return
            }
            if first {
                first = false
                DispatchQueue.main.async { self?.scheduleStartMarker(seg) }
                // Make sure the start marker is queued before the audio.
                DispatchQueue.main.async { AudioOut.shared.enqueue(pcm, generation: audioGen) }
            } else {
                DispatchQueue.main.async { AudioOut.shared.enqueue(pcm, generation: audioGen) }
            }
        }
    }

    fileprivate func appleSegmentRendered(_ seg: Segment, gen: Int) {
        guard gen == generation, appleCurrent === seg else { return }
        appleCurrent = nil
        if seg.started { scheduleEndMarker(seg) }
        pumpApple()
        endEpisodeIfIdle()
    }

    // MARK: - Markers (what the user actually hears)

    private func scheduleStartMarker(_ seg: Segment) {
        seg.started = true
        awaitingHeard += 1
        let gen = generation
        AudioOut.shared.marker(generation: AudioOut.shared.generation) {
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard gen == Speaker.shared.generation else { return }
                    Speaker.shared.segmentStarted(seg)
                }
            }
        }
    }

    private func scheduleEndMarker(_ seg: Segment) {
        let gen = generation
        AudioOut.shared.marker(generation: AudioOut.shared.generation) {
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard gen == Speaker.shared.generation else { return }
                    Speaker.shared.segmentHeard(seg)
                }
            }
        }
    }

    private func segmentStarted(_ seg: Segment) {
        spokenSoFar += spokenSoFar.isEmpty ? seg.text : " " + seg.text
        VoiceHub.shared.speakingSegment(SpokenText.strippingAudioTags(seg.text))
        VoiceHub.shared.refresh()
    }

    private func segmentHeard(_ seg: Segment) {
        awaitingHeard = max(0, awaitingHeard - 1)
        Out.event("voice.spoken", ["text": SpokenText.strippingAudioTags(seg.text), "engine": seg.engine.rawValue])
        endEpisodeIfIdle()
        VoiceHub.shared.refresh()
    }

    private func endEpisodeIfIdle() {
        guard !isSpeaking else { return }
        if !spokenSoFar.isEmpty {
            VoiceHub.shared.speakingEnded(spoken: spokenSoFar)
            spokenSoFar = ""
        }
    }

    // MARK: - Text shaping

    /// Index just past the next speakable boundary: end of sentence, newline, or (for the
    /// very first piece of a reply) the end of a clause long enough to be worth sending.
    static func boundary(in text: String, clauseOK: Bool) -> String.Index? {
        var idx = text.startIndex
        var count = 0
        while idx < text.endIndex {
            let ch = text[idx]
            count += 1
            let next = text.index(after: idx)
            let atEnd = next == text.endIndex
            let followedBySpace = !atEnd && (text[next] == " " || text[next] == "\n")
            if ch == "\n", count > 1 { return next }
            if ".!?".contains(ch), followedBySpace, count >= 8 {
                // Avoid splitting "3.5" or "ecc." in the middle of a list item.
                return next
            }
            if clauseOK, ",;:".contains(ch), followedBySpace, count >= 24 { return next }
            idx = next
        }
        return nil
    }

    /// Markdown and code fences read aloud are noise. Audio tags stay (ElevenLabs reads
    /// them as delivery; Apple strips them later).
    static func cleanForSpeech(_ text: String) -> String {
        var s = text
        s = s.replacingOccurrences(of: "```", with: " ")
        s = s.replacingOccurrences(of: #"[*_`#>]+"#, with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

extension Speaker: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        // write() also reports through the delegate; the zero-length buffer usually comes
        // first, this is the safety net when it does not.
        let spoken = utterance.speechString
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                let sp = Speaker.shared
                if let cur = sp.appleCurrent, cur.text == spoken {
                    sp.appleSegmentRendered(cur, gen: sp.generation)
                }
            }
        }
    }
}
