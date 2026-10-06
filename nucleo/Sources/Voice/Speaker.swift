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
//  for the orb. ElevenLabs PCM never passes through here: the stream hands it to AudioOut
//  off main (ElevenLabsStream, playback mode) and this side only keeps the books.
//
//  Streaming: `voice.speak {text, append:true}` adds LLM chunks to an open turn; the first
//  complete clause is synthesized immediately, then each sentence; `final:true` flushes
//  the rest and closes the turn. A plain `voice.speak {text}` is a whole turn.
//
//  Events: voice.spoken {text, engine} when a segment has been HEARD (not just generated),
//  and voice.state through VoiceHub.
//
//  Ready audio: an ElevenLabs piece whose clean text is in VoceCache (the fillers said while
//  the model thinks, warmed by /scalda or voice.scalda) plays straight from disk, as long as
//  nothing else is still on its way to AudioOut (it would jump the queue). The log says so
//  ("voce: dalla cache"), and for every turn how long the first sound took from the request.
//
//  The two engines never interleave in AudioOut (one FIFO: their buffers would alternate and
//  both voices would be heard over each other). Apple starts a segment only when no
//  ElevenLabs audio is still on its way; ElevenLabs text (and cached audio) waits, in order,
//  while an Apple segment is rendering or queued. Every switch to Apple says why in the log
//  ("voce: passo alla voce di Apple, ...").
//
//  Who speaks: each segment carries the name of its voice (ChiParla), shown by the island
//  when the segment starts to sound and sent as `chi` with voice.spoken.
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
        var heard = false
        /// ElevenLabs: the stream's audio turn whose markers say when this is heard.
        var audioTurn: Int?
        var pcmBytes = 0
        /// Played from VoceCache, not from the socket.
        var daCache = false
        /// The first segment of a turn carries when the turn was asked for, until it starts
        /// (the log measures the real wait to the first sound).
        var richiesta: DispatchTime?
        /// The name of the voice (ChiParla): Melissa or a character.
        var chi = ChiParla.melissa
        init(id: Int, text: String, engine: Engine, chi: String = ChiParla.melissa) {
            self.id = id; self.text = text; self.engine = engine; self.chi = chi
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
        /// A piece of this turn already played from VoceCache. Not `firstSent`: the socket
        /// has no text of this turn, so closing the turn must not send it close_socket, and
        /// its first live piece still opens a new dialogue turn.
        var cachedSent = false
        var piecesSent = 0
        var open = true
        /// When the turn was asked for; taken by its first segment.
        var richiesta: DispatchTime? = DispatchTime.now()
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
    /// Started segments by audio turn, until their end marker is heard.
    private var sounding: [Int: Segment] = [:]
    private var cooldownUntil: Date?
    private var reconnectDelay: TimeInterval = 1
    private var lastUse = Date.distantPast

    // Apple
    private let synth = AVSpeechSynthesizer()
    private var appleQueue: [(Segment, String?)] = []
    private var appleCurrent: Segment?

    /// Segments scheduled in AudioOut whose end marker has not fired yet.
    private var awaitingHeard = 0

    /// Pieces of a turn that came while its socket was finishing the turn before (close_socket
    /// sent, the last audio still arriving): kept in order until the server ends the session
    /// and the socket opens again, then sent. They wait as long as that socket still brings
    /// audio (is_final comes only when the whole turn before is generated, a long answer takes
    /// well over 3 s); a socket silent for `attesaFerma` is stuck: closed and opened again, and
    /// only if that fails do they go to Apple. Pieces of other voices that come meanwhile queue
    /// here too, so nothing overtakes them.
    private struct Attesa {
        let key: String
        /// In order, each with its turn: a new turn may start while the first still waits.
        var pieces: [(turn: Turn, text: String, last: Bool)]
        var timer: DispatchWorkItem
        let inizio: Date
    }
    private var attesa: Attesa?
    private static let attesaFerma: TimeInterval = 8

    /// ElevenLabs pieces (live or cached) that came while an Apple segment was rendering or
    /// queued: sent in order once Apple has handed all its audio to AudioOut.
    private var dopoApple: [(turn: Turn, text: String, last: Bool)] = []
    /// Logged once per wait, not at every pump.
    private var appleAspettaLoggato = false

    /// Everything spoken in the current speaking episode (for echo rejection).
    private(set) var spokenSoFar = ""

    private override init() {
        super.init()
        synth.delegate = self
    }

    // MARK: - State

    var isSpeaking: Bool {
        (turn != nil) || awaitingHeard > 0 || appleCurrent != nil || !appleQueue.isEmpty
            || inflight.values.contains { !$0.isEmpty } || attesa != nil || !dopoApple.isEmpty
    }

    /// Something is still to be heard: audio playing or on its way, text not yet voiced.
    /// Unlike `isSpeaking`, an open streamed turn with nothing left in it is silence (the
    /// island's /ping says `parla` from this, so a cronaca line does not read as "still
    /// speaking" for the 20 s a turn without `final` stays open).
    var isSounding: Bool {
        awaitingHeard > 0 || appleCurrent != nil || !appleQueue.isEmpty
            || inflight.values.contains { !$0.isEmpty }
            || unflushed.values.contains { !$0.isEmpty }
            || !(turn?.buffer.isEmpty ?? true) || attesa != nil || !dopoApple.isEmpty
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
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        appleQueue.removeAll()
        appleCurrent = nil
        awaitingHeard = 0
        sounding.removeAll()
        attesa?.timer.cancel(); attesa = nil
        dopoApple.removeAll()
        appleAspettaLoggato = false
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
        // INVARIANT: AudioOut.stop() only after the sockets are closed. Each ElevenLabs audio
        // turn takes AudioOut's generation at its first PCM: a stop before the close would let
        // an old turn start under the new generation and play, or drop the rest of a turn
        // whose end marker then never fires (voice.state stuck on speaking).
        AudioOut.shared.stop()
        endEpisodeIfIdle()
        VoiceHub.shared.refresh()
    }

    // MARK: - Turn handling

    private func makeTurn(model: String?, voice: String?) -> Turn {
        var engine = currentEngine
        var appleVoice: String?
        var elVoice: String?
        if engine == .apple, ElevenLabsConfig.isConfigured {
            Log.info("voce: ElevenLabs in pausa dopo un errore, questo turno va con la voce di Apple")
        }
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
        finisciSeChiuso(t)
    }

    /// Hands complete pieces of the turn's buffer to its engine. The first clause goes
    /// out alone (lowest latency to first audio), then whole sentences.
    private func drain(_ t: Turn, final: Bool) {
        // the first clause alone only while nothing of the turn has been voiced yet
        while let cut = Self.boundary(in: t.buffer, clauseOK: !t.firstSent && !t.cachedSent) {
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

    private func emitPiece(_ raw: String, turn t: Turn, last: Bool = false, giaPulito: Bool = false) {
        let clean = giaPulito ? raw : Self.cleanForSpeech(raw)
        switch t.engine {
        case .elevenlabs:
            if clean.isEmpty {
                if last, let key = key(t), !(unflushed[key]?.isEmpty ?? true) { flush(key) }
                return
            }
            // Apple is still rendering or has segments queued: its audio and this one would
            // interleave in AudioOut. Wait behind it, in order.
            if !dopoApple.isEmpty || appleCurrent != nil || !appleQueue.isEmpty {
                if dopoApple.isEmpty {
                    Log.info("voce: la voce di Apple non ha finito, ElevenLabs aspetta il suo turno")
                }
                dopoApple.append((t, clean, last))
                return
            }
            if let pcm = dallaCache(clean, turn: t) {
                suonaDallaCache(pcm, text: clean, turn: t)
                return
            }
            // a socket is still closing the turn before (or this turn's own text is already
            // waiting for it): queue behind, in order, instead of switching to Apple
            if attesa != nil {
                attesa?.pieces.append((t, clean, last))
                return
            }
            if let s = stream(model: t.model, voiceID: t.voiceID), s.isFinishing, let key = key(t) {
                aspettaSocket(t, key: key, piece: clean, last: last)
                return
            }
            guard let s = stream(model: t.model, voiceID: t.voiceID), s.connect(), let key = key(t) else {
                // No socket: this turn continues on Apple.
                Self.logApple("il socket ElevenLabs non si apre", turno: true)
                t.engine = .apple
                enqueueApple(clean, voice: t.appleVoice, richiesta: prendiRichiesta(t), chi: ChiParla.nome(voce: t.voiceID))
                return
            }
            let newTurn = !t.firstSent && s.hasSpokenBefore && (inflight[key]?.isEmpty ?? true)
            s.send(text: clean, newTurn: newTurn)
            ElevenLabsUsage.add(clean.count)
            unflushed[key, default: ""] += (unflushed[key]?.isEmpty ?? true) ? clean : " " + clean
            t.firstSent = true
            t.piecesSent += 1
            flush(key, richiesta: prendiRichiesta(t))
        case .apple:
            t.firstSent = true
            let spoken = SpokenText.strippingAudioTags(clean)
            if !spoken.isEmpty {
                t.piecesSent += 1
                enqueueApple(spoken, voice: t.appleVoice, richiesta: prendiRichiesta(t), chi: ChiParla.nome(voce: t.voiceID))
            }
        }
    }

    /// One line, always the same shape, for every switch to Apple.
    private static func logApple(_ motivo: String, turno: Bool) {
        Log.info("voce: passo alla voce di Apple, \(motivo)\(turno ? " (per questo turno)" : "")")
    }

    /// A closed turn whose text reached its socket owes it close_socket (ElevenLabs then
    /// delivers the rest and is_final), unless some of it still waits to be sent.
    private func finisciSeChiuso(_ t: Turn) {
        guard !t.open, t.engine == .elevenlabs, t.firstSent, let key = key(t) else { return }
        if attesa?.pieces.contains(where: { $0.turn === t }) == true { return }
        if dopoApple.contains(where: { $0.turn === t }) { return }
        streams[key]?.finish()
    }

    private func prendiRichiesta(_ t: Turn) -> DispatchTime? {
        defer { t.richiesta = nil }
        return t.richiesta
    }

    // MARK: - Ready audio (VoceCache)

    /// The cached audio of a piece, when it can play now without jumping ahead of anything:
    /// no ElevenLabs text or audio still on its way, no Apple segment rendering or queued,
    /// no turn waiting for its socket. Otherwise the piece takes the normal path.
    private func dallaCache(_ clean: String, turn t: Turn) -> Data? {
        guard clean.count <= VoceCache.maxCaratteri, attesa == nil,
              appleCurrent == nil, appleQueue.isEmpty,
              inflight.values.allSatisfy({ $0.isEmpty }),
              unflushed.values.allSatisfy({ $0.isEmpty }) else { return nil }
        let chiave = VoceCache.chiave(model: t.model, voce: t.voiceID ?? ElevenLabsConfig.voiceID, testo: clean)
        return VoceCache.shared.pcm(chiave)
    }

    /// Straight to AudioOut between a start and an end marker, like an Apple segment: the
    /// markers keep `isSounding`, voice.spoken and the episode honest. No characters are
    /// counted (nothing is sent to ElevenLabs) and the socket is not touched.
    private func suonaDallaCache(_ pcm: Data, text: String, turn t: Turn) {
        segmentSeq += 1
        let seg = Segment(id: segmentSeq, text: text, engine: .elevenlabs, chi: ChiParla.nome(voce: t.voiceID))
        seg.daCache = true
        seg.pcmBytes = pcm.count
        seg.richiesta = prendiRichiesta(t)
        scheduleStartMarker(seg)
        AudioOut.shared.enqueuePCM16(pcm, generation: AudioOut.shared.generation)
        scheduleEndMarker(seg)
        t.cachedSent = true
        t.piecesSent += 1
        Log.info("voce: dalla cache «\(text)»")
    }

    private func key(_ t: Turn) -> String? { "\(t.model)|\(t.voiceID ?? ElevenLabsConfig.voiceID)" }

    private func aspettaSocket(_ t: Turn, key: String, piece: String, last: Bool) {
        attesa = Attesa(key: key, pieces: [(t, piece, last)], timer: DispatchWorkItem {}, inizio: Date())
        Log.info("voce: il socket ElevenLabs sta chiudendo il turno prima, la frase aspetta che si riapra")
        armaControlloAttesa(key)
    }

    /// Once a second while pieces wait for a closing socket.
    private func armaControlloAttesa(_ key: String) {
        let gen = generation
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.controllaAttesa(key, gen: gen) }
        }
        attesa?.timer.cancel()
        attesa?.timer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: work)
    }

    /// Waiting is fine while the closing socket still brings audio. Silent for `attesaFerma`
    /// (since its last audio, or since the wait began if that is later): stuck.
    private func controllaAttesa(_ key: String, gen: Int) {
        guard gen == generation, let a = attesa, a.key == key else { return }
        guard let s = streams[key] else { return attesaSuApple(motivo: "il socket ElevenLabs non c'e' piu'") }
        if !s.isFinishing {
            // closed meanwhile (its is_final, or a drop) and nobody reopened it yet
            return riprendiAttesa(key, stream: s)
        }
        let dallInizio = Date().timeIntervalSince(a.inizio)
        let ferma = min(s.secondsSinceAudio ?? dallInizio, dallInizio)
        if ferma < Self.attesaFerma { return armaControlloAttesa(key) }
        if !(inflight[key]?.isEmpty ?? true) {
            // text of the turn before still without its audio: the watchdog's case
            return failStream(key, reason: "nessun audio da \(Int(Self.attesaFerma)) s mentre chiudeva il turno")
        }
        Log.info("voce: il socket ElevenLabs non chiude il turno e non manda niente da \(Int(Self.attesaFerma)) s, lo riapro")
        s.close()
        riprendiAttesa(key, stream: s)
    }

    /// The socket of the waiting turn ended its session: open it again and send what waited.
    private func riprendiAttesa(_ key: String, stream s: ElevenLabsStream) {
        guard let a = attesa, a.key == key else { return }
        guard s.connect() else { return attesaSuApple(motivo: "il socket ElevenLabs non si riapre") }
        a.timer.cancel()
        attesa = nil
        Log.info("voce: socket ElevenLabs riaperto dopo \(String(format: "%.1f", Date().timeIntervalSince(a.inizio))) s, riparto con \(a.pieces.count) frasi in attesa")
        for p in a.pieces { emitPiece(p.text, turn: p.turn, last: p.last, giaPulito: true) }
        // a turn closed while it waited still owes the socket its final marker (only the
        // last one: an earlier turn's close would shut the socket under the next one)
        if let t = a.pieces.last?.turn { finisciSeChiuso(t) }
        VoiceHub.shared.refresh()
    }

    /// No socket to wait for any more: what waited is said by Apple, as any failed turn.
    private func attesaSuApple(motivo: String) {
        guard let a = attesa else { return }
        a.timer.cancel()
        attesa = nil
        Self.logApple("\(motivo), \(a.pieces.count) frasi in attesa", turno: true)
        for p in a.pieces {
            p.turn.engine = .apple
            let spoken = SpokenText.strippingAudioTags(p.text)
            if !spoken.isEmpty {
                p.turn.piecesSent += 1
                enqueueApple(spoken, voice: p.turn.appleVoice, richiesta: prendiRichiesta(p.turn),
                             chi: ChiParla.nome(voce: p.turn.voiceID))
            }
        }
        VoiceHub.shared.refresh()
    }

    /// Apple has handed all its audio to AudioOut: what ElevenLabs held back goes now, in
    /// order (anything it gets from here is queued after Apple's audio).
    private func rilasciaDopoApple() {
        guard !dopoApple.isEmpty, appleCurrent == nil, appleQueue.isEmpty else { return }
        let lista = dopoApple
        dopoApple = []
        Log.info("voce: la voce di Apple ha finito, ElevenLabs riparte con \(lista.count) frasi")
        // if Apple takes over again meanwhile (a socket that will not open), emitPiece queues
        // the rest back here, still in order
        for p in lista { emitPiece(p.text, turn: p.turn, last: p.last, giaPulito: true) }
        if let t = lista.last?.turn { finisciSeChiuso(t) }
        VoiceHub.shared.refresh()
    }

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
        s.onPlayback = { [weak self] p in self?.playback(p, key: key) }
        streams[key] = s
        inflight[key] = []
        unflushed[key] = ""
        return s
    }

    private func flush(_ key: String, richiesta: DispatchTime? = nil) {
        guard let s = streams[key], let text = unflushed[key], !text.isEmpty else { return }
        unflushed[key] = ""
        segmentSeq += 1
        let seg = Segment(id: segmentSeq, text: text, engine: .elevenlabs, chi: ChiParla.nome(chiave: key))
        seg.richiesta = richiesta
        inflight[key, default: []].append(seg)
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
                // the stream had audio meanwhile, its news is still on the way to main
                if let ago = self.streams[key]?.secondsSinceAudio, ago < 8 { self.armWatchdog(key); return }
                Log.warn("ElevenLabs non risponde da 8 secondi, passo alla voce di Apple.")
                self.failStream(key, reason: "nessun audio da 8 s")
            }
        }
        watchdogs[key] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
    }

    private func handle(_ event: ElevenLabsStream.Event, key: String, stream s: ElevenLabsStream) {
        switch event {
        case .audio, .turnFinished:
            break   // playback mode: they come through playback(_:key:)
        case .sessionFinished:
            if !(inflight[key]?.isEmpty ?? true) { failStream(key, reason: "sessione ElevenLabs chiusa prima dell'audio finale") }
            else if attesa?.key == key {
                // ElevenLabsStream closes the old socket just after this callback
                DispatchQueue.main.async { [weak s] in
                    MainActor.assumeIsolated {
                        guard let s else { Speaker.shared.attesaSuApple(motivo: "il socket ElevenLabs non c'e' piu'"); return }
                        Speaker.shared.riprendiAttesa(key, stream: s)
                    }
                }
            } else if keepWarm {
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
            } else if attesa?.key == key {
                // the socket the pieces wait for dropped while closing its turn: whatever of
                // that turn was due has arrived (nothing in flight), open a fresh one now
                Log.info("voce: il socket ElevenLabs che chiudeva il turno e' caduto (\(error.localizedDescription)), lo riapro")
                DispatchQueue.main.async { [weak s] in
                    MainActor.assumeIsolated {
                        guard let s else { Speaker.shared.attesaSuApple(motivo: "il socket ElevenLabs non c'e' piu'"); return }
                        s.close()
                        Speaker.shared.riprendiAttesa(key, stream: s)
                    }
                }
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

    /// The stream's audio is already in AudioOut, markers included: this is the bookkeeping.
    private func playback(_ p: ElevenLabsStream.Playback, key: String) {
        switch p {
        case .audio(let bytes, let newTurn):
            guard let head = inflight[key]?.first ?? pendingHeadPlaceholder(key)
                    ?? silentPlaceholder(key, turn: newTurn) else { return }
            armWatchdog(key)
            reconnectDelay = 1
            if !head.started {
                if let n = newTurn {
                    head.started = true
                    head.audioTurn = n
                    awaitingHeard += 1
                    sounding[n] = head
                } else {
                    // the stream's turn began before this segment existed: count it anyway,
                    // with a start marker that lands a little after its first audio
                    scheduleStartMarker(head)
                }
            }
            head.pcmBytes += bytes
        case .turnFinished(let n):
            guard var list = inflight[key], !list.isEmpty else { return }
            let seg = list.removeFirst()
            inflight[key] = list
            if list.isEmpty { watchdogs[key]?.cancel() }
            Log.info("voce: segmento \(seg.id) concluso, \(seg.pcmBytes) byte PCM, \(list.count) in attesa")
            // the last ElevenLabs audio is in AudioOut: Apple may start behind it
            if list.isEmpty { pumpApple() }
            // its end marker is already queued after its audio, unless the stream counted
            // that audio as another turn
            if seg.started, n == nil || seg.audioTurn != n { scheduleEndMarker(seg) }
            endEpisodeIfIdle()
        case .heard(let n, let end):
            guard let seg = sounding[n] else { return }
            if end { segmentHeard(seg) } else { segmentStarted(seg) }
        }
    }

    /// Audio with no segment waiting for it (should not happen). It is already in AudioOut
    /// and will be heard, so it must count as speech until its end marker: an empty segment
    /// in flight takes it, and turn end, failStream and the watchdog treat it as any other.
    private func silentPlaceholder(_ key: String, turn: Int?) -> Segment? {
        guard turn != nil else { return nil }
        segmentSeq += 1
        let seg = Segment(id: segmentSeq, text: "", engine: .elevenlabs, chi: ChiParla.nome(chiave: key))
        inflight[key, default: []].append(seg)
        Log.info("voce: audio ElevenLabs senza un segmento in attesa, lo conto come voce fino alla sua fine")
        return seg
    }

    /// Audio that arrives for text the server generated before our flush (it starts on
    /// its own after ~40 characters): it belongs to the segment still being built.
    private func pendingHeadPlaceholder(_ key: String) -> Segment? {
        guard let text = unflushed[key], !text.isEmpty else { return nil }
        // Promote the unflushed text to a segment now; the later flush adds no new text.
        unflushed[key] = ""
        segmentSeq += 1
        let seg = Segment(id: segmentSeq, text: text, engine: .elevenlabs, chi: ChiParla.nome(chiave: key))
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
        Self.logApple("ElevenLabs caduto (\(reason)), per 20 s", turno: false)
        if attesa?.key == key { attesaSuApple(motivo: "ElevenLabs caduto (\(reason))") }
        // short: a dropped line is usually a moment, and her own voice should come back soon
        cooldownUntil = Date().addingTimeInterval(20)
        // A segment already sounding is dropped, but its start counted it as "to be heard":
        // its end marker, after what of it is already queued, keeps that count honest
        // (without it isSpeaking stays true until the next stopSpeaking).
        for seg in list where seg.started { scheduleEndMarker(seg) }
        // Text that never made a sound goes to Apple; a half-spoken segment is dropped
        // (repeating it from the start would sound like a stutter).
        var reroute: [(text: String, richiesta: DispatchTime?, chi: String)] =
            list.filter { !$0.started }.map { ($0.text, $0.richiesta, $0.chi) }
        if !rest.isEmpty { reroute.append((rest, nil, ChiParla.nome(chiave: key))) }
        if let t = turn, t.engine == .elevenlabs { t.engine = .apple }
        for r in reroute {
            let spoken = SpokenText.strippingAudioTags(r.text)
            if !spoken.isEmpty { enqueueApple(spoken, voice: nil, richiesta: r.richiesta, chi: r.chi) }
        }
        pumpApple()
        Out.event("voice.engine", ["engine": "apple", "reason": reason])
        endEpisodeIfIdle()
        VoiceHub.shared.refresh()
    }

    // MARK: - Apple

    private func enqueueApple(_ text: String, voice: String?, richiesta: DispatchTime? = nil, chi: String) {
        segmentSeq += 1
        let seg = Segment(id: segmentSeq, text: text, engine: .apple, chi: chi)
        seg.richiesta = richiesta
        appleQueue.append((seg, voice))
        pumpApple()
    }

    nonisolated static func appleVoice(_ identifier: String? = nil) -> AVSpeechSynthesisVoice? {
        if let identifier, let v = AVSpeechSynthesisVoice(identifier: identifier) { return v }
        if let v = AVSpeechSynthesisVoice(identifier: "com.apple.voice.premium.it-IT.Emma") { return v }
        let italian = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "it-IT" }
        return italian.max { $0.quality.rawValue < $1.quality.rawValue } ?? AVSpeechSynthesisVoice(language: "it-IT")
    }

    /// Starts the next Apple segment, unless ElevenLabs audio is still on its way: it would
    /// land in AudioOut between Apple's buffers. Called again when that audio has all come
    /// (turnFinished with nothing left in flight, failStream). With Apple idle and nothing
    /// queued, what ElevenLabs held back goes.
    private func pumpApple() {
        guard appleCurrent == nil else { return }
        guard !appleQueue.isEmpty else { appleAspettaLoggato = false; return rilasciaDopoApple() }
        if inflight.values.contains(where: { !$0.isEmpty }) {
            if !appleAspettaLoggato {
                appleAspettaLoggato = true
                Log.info("voce: la voce di Apple aspetta che finisca l'audio ElevenLabs gia' in arrivo")
            }
            return
        }
        appleAspettaLoggato = false
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
                // a stop in between must not count this segment again (awaitingHeard was reset)
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard let self, gen == self.generation else { return }
                        self.scheduleStartMarker(seg)
                    }
                }
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
        pumpApple()   // the next Apple segment, or what ElevenLabs held back
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
        if let r = seg.richiesta {
            seg.richiesta = nil
            let ms = (DispatchTime.now().uptimeNanoseconds &- r.uptimeNanoseconds) / 1_000_000
            Log.info("voce: primo suono \(ms) ms dopo la richiesta (\(seg.daCache ? "cache" : seg.engine.rawValue))")
        }
        if !seg.text.isEmpty {
            spokenSoFar += spokenSoFar.isEmpty ? seg.text : " " + seg.text
            VoiceHub.shared.speakingSegment(SpokenText.strippingAudioTags(seg.text))
            // the island shows who says this line, now that it really sounds
            if Isola.attiva { Isola.shared.segmentoIniziato(testo: SpokenText.strippingAudioTags(seg.text), chi: seg.chi) }
        }
        VoiceHub.shared.refresh()
    }

    private func segmentHeard(_ seg: Segment) {
        // a failed stream may queue a second end marker for a segment the stream already ended
        guard !seg.heard else { return }
        seg.heard = true
        if let n = seg.audioTurn { sounding[n] = nil }
        awaitingHeard = max(0, awaitingHeard - 1)
        if !seg.text.isEmpty {
            Out.event("voice.spoken", ["text": SpokenText.strippingAudioTags(seg.text), "engine": seg.engine.rawValue,
                                       "chi": seg.chi])
        }
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
    /// The rules live in PezziDiVoce (VoceCache.swift), so the cache splits a filler alike.
    nonisolated static func boundary(in text: String, clauseOK: Bool) -> String.Index? {
        PezziDiVoce.boundary(in: text, clauseOK: clauseOK)
    }

    /// Markdown and code fences read aloud are noise. Audio tags stay (ElevenLabs reads
    /// them as delivery; Apple strips them later).
    nonisolated static func cleanForSpeech(_ text: String) -> String {
        PezziDiVoce.pulisci(text)
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
