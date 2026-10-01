//
//  Listener.swift
//  Bottega Nucleo
//
//  The microphone side. Modes:
//   - push:      open until voice.stop (push-to-talk), then voice.final;
//   - utterance: ends by itself after ~1.2 s of silence;
//   - converse:  mic always open, ~0.8 s of silence ends each user turn (voice.final),
//                barge-in stops Melissa when the user talks over her;
//   - wake:      low-power wait for a phrase ("melissa"), event wake.detected.
//
//  Lessons ported from Melissa (Avo Agency AI, VoiceSession.swift):
//   - a FRESH AVAudioEngine per listening window: a reused one fails with -10868 after a
//     device switch (AirPods);
//   - check the input format (sampleRate > 0, channels > 0) BEFORE installTap, or the
//     process aborts on an uncatchable Objective-C exception when the mic is not ours;
//   - open the HAL OFF the main thread: it blocked main up to 4.4 s;
//   - outside conversation mode the mic stays CLOSED while Melissa speaks.
//

import Foundation
import AVFoundation
import os

/// Audio-thread side of the microphone: metering, wake gating, barge-in VAD, and the
/// hand-off to the current recognizer.
final class MicTap: @unchecked Sendable {
    private struct State {
        var recognizer: Recognizer?
        var gate = false              // wake mode: feed the recognizer only around speech
        var vadArmed = false          // conversation + hardware AEC + Melissa speaking
        var lastVoice: CFTimeInterval = 0
        var voicedSince: CFTimeInterval?
        var vadFired = false
        var buffers = 0
        var audible = 0
        var emitLevels = true
    }
    private let state = OSAllocatedUnfairLock(uncheckedState: State())
    var onVAD: (@Sendable () -> Void)?

    func setRecognizer(_ r: Recognizer?) { state.withLockUnchecked { $0.recognizer = r } }
    func setGate(_ on: Bool) { state.withLockUnchecked { $0.gate = on } }
    func setEmitLevels(_ on: Bool) { state.withLockUnchecked { $0.emitLevels = on } }
    func armVAD(_ on: Bool) {
        state.withLockUnchecked { s in
            s.vadArmed = on
            s.voicedSince = nil
            s.vadFired = false
        }
    }
    /// (buffers seen, buffers with real signal) since the last reset: the VPIO watchdog.
    var health: (Int, Int) { state.withLockUnchecked { ($0.buffers, $0.audible) } }
    func resetHealth() { state.withLockUnchecked { $0.buffers = 0; $0.audible = 0 } }

    func process(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0 else { return }
        let level = AudioLevels.rms(buffer)
        let now = CACurrentMediaTime()
        var fireVAD = false
        let (recognizer, feed, emit): (Recognizer?, Bool, Bool) = state.withLockUnchecked { s in
            s.buffers += 1
            if level > 0.0005 { s.audible += 1 }
            if level > 0.12 { s.lastVoice = now }
            // Barge-in by energy, only with hardware echo cancellation (otherwise the mic
            // mostly hears Melissa herself): 150 ms of clear voice.
            if s.vadArmed, !s.vadFired {
                if level > 0.30 {
                    if s.voicedSince == nil { s.voicedSince = now }
                    if now - (s.voicedSince ?? now) >= 0.15 { s.vadFired = true; fireVAD = true }
                } else if level < 0.15 {
                    s.voicedSince = nil
                }
            }
            let feed = !s.gate || now - s.lastVoice < 1.5
            return (s.recognizer, feed, s.emitLevels)
        }
        if emit {
            AudioLevels.shared.set(.mic, level: level, bands: AudioLevels.bands(buffer, loudness: level))
        }
        if feed { recognizer?.append(buffer) }
        if fireVAD { onVAD?() }
    }
}

/// A plain microphone engine (no voice processing). Built fresh for every window.
final class MicEngine: @unchecked Sendable {
    private let engine = AVAudioEngine()

    static func start(_ tap: MicTap) async throws -> MicEngine {
        try await Task.detached(priority: .userInitiated) {
            let m = MicEngine()
            let input = m.engine.inputNode
            if input.isVoiceProcessingEnabled { try? input.setVoiceProcessingEnabled(false) }
            let fmt = input.outputFormat(forBus: 0)
            guard fmt.sampleRate > 0, fmt.channelCount > 0 else {
                throw NucleoError("Il microfono non e' disponibile: controlla il permesso in Impostazioni di Sistema, Privacy e sicurezza, Microfono.")
            }
            // macOS 27: the throwing tap reports a bad format instead of aborting the process.
            do {
                try input.installAudioTap(onBus: 0, bufferSize: 1024, format: fmt) { ro, _ in
                    tap.process(AVAudioPCMBuffer(copying: ro))
                }
            } catch {
                throw NucleoError("Il microfono non si apre: \(error.localizedDescription)")
            }
            m.engine.prepare()
            do {
                try m.engine.start()
            } catch {
                input.removeTap(onBus: 0)
                throw NucleoError("Impossibile avviare il microfono: \(error.localizedDescription)")
            }
            return m
        }.value
    }

    func stop() {
        let engine = self.engine
        Task.detached(priority: .utility) {
            if engine.isRunning { engine.stop() }
            engine.inputNode.removeTap(onBus: 0)
        }
    }
}

@MainActor
final class Listener {
    static let shared = Listener()

    enum Mode: String { case push, utterance, converse, wake }

    private(set) var mode: Mode?
    private(set) var backendName = "nessuno"
    /// "hardware" (VPIO) or "software" (text echo rejection); last conversation's path.
    private(set) var echoCancellation = "software"
    private(set) var echoTested = false

    private var recognizer: Recognizer?
    private var mic: MicEngine?
    private var usingDuplex = false
    private let tap = MicTap()
    private var locale = RecognizerFactory.defaultLocale

    private var turnText = ""
    private var heardAnything = false
    private var silenceWork: DispatchWorkItem?
    private var limitWork: DispatchWorkItem?
    private var starting = false

    // Conversation echo bookkeeping
    private var speechEndedAt = Date.distantPast
    private var lastSpoken = ""
    private var turnBeganWhileSpeaking = false

    // Wake
    private var wakePhrase: String?
    private var wakeSuspended = false
    private var lastWake = Date.distantPast

    private init() {
        tap.onVAD = {
            DispatchQueue.main.async { MainActor.assumeIsolated { Listener.shared.bargeIn(reason: "voce") } }
        }
    }

    /// Mic open for the user (wake word listening does not count).
    var isCapturing: Bool { mode != nil && mode != .wake }
    var conversing: Bool { mode == .converse }
    var wakeEnabled: Bool { wakePhrase != nil }

    // MARK: - Permissions

    static func ensureMicrophone() async throws {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return
        case .notDetermined:
            let ok = await AVCaptureDevice.requestAccess(for: .audio)
            if !ok { throw NucleoError("Il permesso del microfono e' stato negato.") }
        default:
            throw NucleoError("Il microfono non e' autorizzato: abilitalo per Bottega in Impostazioni di Sistema, Privacy e sicurezza, Microfono.")
        }
    }

    // MARK: - push / utterance

    func listen(mode newMode: Mode, locale loc: String?) async throws {
        guard newMode == .push || newMode == .utterance else { return }
        if conversing {
            throw NucleoError("La conversazione e' attiva: il microfono e' gia' aperto.")
        }
        if isCapturing || starting { return }
        // Outside conversation the mic stays closed while Melissa speaks.
        if Speaker.shared.isSpeaking { Speaker.shared.stopSpeaking() }
        await suspendWake()
        try await open(mode: newMode, locale: loc ?? RecognizerFactory.defaultLocale, duplex: false)
        armLimits()
    }

    /// voice.stop: closes push/utterance and emits the last voice.final.
    func stop() async {
        guard let m = mode, m == .push || m == .utterance else { return }
        await finishWindow(emit: true)
    }

    // MARK: - Conversation

    func converseStart(locale loc: String?) async throws {
        if conversing { return }
        if isCapturing { await finishWindow(emit: true) }
        await suspendWake()
        try await open(mode: .converse, locale: loc ?? RecognizerFactory.defaultLocale, duplex: true)
        Speaker.shared.prewarm()
    }

    func converseStop() async {
        guard conversing else { return }
        silenceWork?.cancel()
        let pending = Speaker.shared.isSpeaking ? "" : turnText
        let r = recognizer
        recognizer = nil
        tap.setRecognizer(nil)
        tap.armVAD(false)
        r?.cancel()
        await closeAudio()
        mode = nil
        if !pending.trimmingCharacters(in: .whitespaces).isEmpty, !looksLikeEcho(pending) {
            Out.event("voice.final", ["text": pending, "mode": Mode.converse.rawValue])
        }
        turnText = ""
        VoiceHub.shared.refresh()
        await resumeWakeIfNeeded()
    }

    // MARK: - Wake word

    func wakeEnable(phrase: String, locale loc: String?) async throws {
        wakePhrase = Self.fold(phrase.isEmpty ? "melissa" : phrase)
        if let loc { locale = loc }
        if mode == nil, !Speaker.shared.isSpeaking { try await openWake() }
    }

    func wakeDisable() async {
        wakePhrase = nil
        if mode == .wake { await finishWindow(emit: false) }
    }

    private func openWake() async throws {
        guard wakePhrase != nil, mode == nil else { return }
        try await open(mode: .wake, locale: locale, duplex: false)
    }

    private func suspendWake() async {
        if mode == .wake {
            wakeSuspended = true
            await finishWindow(emit: false)
        }
    }

    func resumeWakeIfNeeded() async {
        guard wakePhrase != nil, mode == nil, !Speaker.shared.isSpeaking, !starting else { return }
        wakeSuspended = false
        do { try await openWake() } catch {
            Log.warn("Ascolto della parola di attivazione non ripartito: \(error.localizedDescription)")
        }
    }

    // MARK: - Opening / closing

    private func open(mode newMode: Mode, locale loc: String, duplex wantDuplex: Bool) async throws {
        starting = true
        defer { starting = false }
        try await Self.ensureMicrophone()
        locale = loc
        let r = try await RecognizerFactory.make(locale: loc)
        backendName = r.backendName
        turnText = ""
        heardAnything = false
        turnBeganWhileSpeaking = false
        r.onText = { [weak self] text in self?.handleText(text) }
        tap.setRecognizer(r)
        tap.setGate(newMode == .wake)
        tap.setEmitLevels(newMode != .wake)
        tap.armVAD(false)
        tap.resetHealth()

        var duplexOK = false
        if wantDuplex {
            let t = tap
            duplexOK = await AudioOut.shared.startDuplex { buffer in t.process(buffer) }
            echoTested = true
            echoCancellation = duplexOK ? "hardware" : "software"
            if duplexOK {
                AudioOut.shared.onDuplexLost = {
                    DispatchQueue.main.async { MainActor.assumeIsolated { Listener.shared.duplexLost() } }
                }
            }
        }
        if !duplexOK {
            do {
                mic = try await MicEngine.start(tap)
            } catch {
                tap.setRecognizer(nil)
                r.cancel()
                throw error
            }
        }
        usingDuplex = duplexOK
        recognizer = r
        mode = newMode
        Log.info("microfono aperto: modo \(newMode.rawValue), \(r.backendName)\(wantDuplex ? ", eco \(echoCancellation)" : "")")
        VoiceHub.shared.refresh()
        if duplexOK { scheduleVPIOWatchdog() }
    }

    /// Melissa on macOS saw VPIO "start" and then deliver silence (-10877 family). If the
    /// tap has seen no real signal after 2.5 s, drop to a plain mic + software filter.
    private func scheduleVPIOWatchdog() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            MainActor.assumeIsolated {
                let me = Listener.shared
                guard me.conversing, me.usingDuplex else { return }
                let (seen, audible) = me.tap.health
                if seen == 0 || audible == 0 {
                    Log.warn("La cancellazione dell'eco hardware non consegna audio: passo al filtro software.")
                    Task { await me.fallBackToSoftwareEcho() }
                }
            }
        }
    }

    private func fallBackToSoftwareEcho() async {
        guard conversing, usingDuplex else { return }
        await AudioOut.shared.stopDuplex()
        tap.resetHealth()
        usingDuplex = false
        echoCancellation = "software"
        do {
            mic = try await MicEngine.start(tap)
        } catch {
            Log.error("Conversazione interrotta: \(error.localizedDescription)")
            await converseStop()
        }
    }

    fileprivate func duplexLost() {
        guard conversing else { return }
        // Device change (AirPods in or out): rebuild the conversation audio on the new route.
        Task {
            usingDuplex = false
            let t = tap
            let ok = await AudioOut.shared.startDuplex { buffer in t.process(buffer) }
            if ok {
                usingDuplex = true
                echoCancellation = "hardware"
            } else {
                echoCancellation = "software"
                do { mic = try await MicEngine.start(tap) } catch {
                    Log.error("Conversazione interrotta dopo il cambio di dispositivo audio: \(error.localizedDescription)")
                    await converseStop()
                }
            }
        }
    }

    private func closeAudio() async {
        tap.armVAD(false)
        mic?.stop()
        mic = nil
        if usingDuplex {
            usingDuplex = false
            await AudioOut.shared.stopDuplex()
        }
        AudioLevels.shared.reset(.mic)
    }

    private func finishWindow(emit: Bool) async {
        guard let m = mode else { return }
        silenceWork?.cancel(); silenceWork = nil
        limitWork?.cancel(); limitWork = nil
        let r = recognizer
        recognizer = nil
        // Stop feeding audio first, then let the recognizer settle on its last words.
        tap.setRecognizer(nil)
        await closeAudio()
        mode = nil
        var text = turnText
        if let r {
            if emit {
                VoiceHub.shared.setState("processing")
                let final = await r.finish()
                if !final.isEmpty { text = final }
            } else {
                r.cancel()
            }
        }
        turnText = ""
        if emit {
            let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
            Out.event("voice.final", ["text": clean, "mode": m.rawValue])
            if !clean.isEmpty { VoiceHub.shared.userTurnEnded() }
        }
        VoiceHub.shared.refresh()
        if m != .wake { await resumeWakeIfNeeded() }
    }

    private func armLimits() {
        limitWork?.cancel()
        let limit: Double = mode == .utterance ? 60 : 120
        let work = DispatchWorkItem {
            MainActor.assumeIsolated {
                let me = Listener.shared
                guard me.mode == .push || me.mode == .utterance else { return }
                Log.info("ascolto chiuso per durata massima")
                Task { await me.finishWindow(emit: true) }
            }
        }
        limitWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + limit, execute: work)
        if mode == .utterance { scheduleSilence(after: 8) }   // nobody spoke at all
    }

    // MARK: - Text handling

    private func handleText(_ text: String) {
        guard let m = mode else { return }
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean != turnText else { return }
        turnText = clean
        guard !clean.isEmpty else { return }

        switch m {
        case .wake:
            if let phrase = wakePhrase, Self.fold(clean).contains(phrase),
               Date().timeIntervalSince(lastWake) > 2 {
                lastWake = Date()
                Out.event("wake.detected", ["phrase": phrase, "text": clean])
                Task { _ = await recognizer?.cut(); turnText = "" }
            } else if clean.count > 160 {
                Task { _ = await recognizer?.cut(); turnText = "" }
            }
            return
        case .converse:
            if Speaker.shared.isSpeaking {
                let spoken = Speaker.shared.spokenSoFar
                let echo = echoCancellation == "hardware"
                    ? Self.looksLikeResidualEcho(recognized: clean, spoken: spoken)
                    : Self.looksLikeOwnEcho(recognized: clean, answer: spoken)
                if echo { return }
                bargeIn(reason: "parole")
            }
        case .push, .utterance:
            break
        }
        heardAnything = true
        Out.event("voice.partial", ["text": clean, "mode": m.rawValue])
        VoiceHub.shared.partial(clean)
        switch m {
        case .utterance: scheduleSilence(after: 1.2)
        case .converse: scheduleSilence(after: 0.8)
        default: break
        }
    }

    private func scheduleSilence(after seconds: Double) {
        silenceWork?.cancel()
        let work = DispatchWorkItem {
            MainActor.assumeIsolated {
                let me = Listener.shared
                switch me.mode {
                case .utterance:
                    Task { await me.finishWindow(emit: true) }
                case .converse:
                    Task { await me.endConverseTurn() }
                default:
                    break
                }
            }
        }
        silenceWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func endConverseTurn() async {
        guard conversing, let r = recognizer else { return }
        // Melissa still talking and no barge-in happened: whatever was heard is her.
        if Speaker.shared.isSpeaking { return }
        let text = await r.cut().trimmingCharacters(in: .whitespacesAndNewlines)
        let beganWhileSpeaking = turnBeganWhileSpeaking
        turnText = ""
        turnBeganWhileSpeaking = false
        guard !text.isEmpty else { return }
        if beganWhileSpeaking || Date().timeIntervalSince(speechEndedAt) < 0.4,
           Self.looksLikeOwnEchoByContent(recognized: text, spoken: lastSpoken) {
            Log.info("scartato come eco della voce: \"\(text)\"")
            return
        }
        Out.event("voice.final", ["text": text, "mode": Mode.converse.rawValue])
        VoiceHub.shared.userTurnEnded()
    }

    // MARK: - Conversation hooks from the speaker

    /// Melissa started a reply: what the mic hears from now on is presumed echo until it
    /// proves otherwise. With hardware AEC the energy VAD watches for the user.
    func speechStarted() {
        if mode == .wake {
            // Outside conversation the mic is closed while she speaks.
            Task { await suspendWake() }
            return
        }
        guard conversing else { return }
        silenceWork?.cancel()
        turnBeganWhileSpeaking = true
        if let r = recognizer { Task { _ = await r.cut(); self.turnText = "" } }
        tap.armVAD(echoCancellation == "hardware")
    }

    func speechEnded(spoken: String) {
        speechEndedAt = Date()
        lastSpoken = spoken
        tap.armVAD(false)
        guard conversing else {
            Task { await resumeWakeIfNeeded() }
            return
        }
        // Late echo still in the recognizer: drop it once the room is quiet.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            MainActor.assumeIsolated {
                let me = Listener.shared
                guard me.conversing, !Speaker.shared.isSpeaking, me.turnBeganWhileSpeaking else { return }
                if me.turnText.isEmpty || Self.looksLikeOwnEchoByContent(recognized: me.turnText, spoken: me.lastSpoken) {
                    me.turnBeganWhileSpeaking = false
                    me.turnText = ""
                    if let r = me.recognizer { Task { _ = await r.cut() } }
                }
            }
        }
    }

    /// The user talked over Melissa: silence her at once and keep listening.
    func bargeIn(reason: String) {
        guard conversing, Speaker.shared.isSpeaking else { return }
        let t0 = CACurrentMediaTime()
        Speaker.shared.stopSpeaking()
        tap.armVAD(false)
        turnBeganWhileSpeaking = false
        let ms = Int((CACurrentMediaTime() - t0) * 1000)
        Log.info("barge-in (\(reason)), voce fermata in \(ms) ms")
        Out.event("voice.bargein", ["text": turnText, "trigger": reason == "voce" ? "energy" : "speech"])
    }

    private func looksLikeEcho(_ text: String) -> Bool {
        Date().timeIntervalSince(speechEndedAt) < 0.4 && Self.looksLikeOwnEchoByContent(recognized: text, spoken: lastSpoken)
    }

    // MARK: - Echo rules (Melissa, VoiceSession.swift)

    private static func words(_ t: String) -> [String] {
        t.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    }

    /// While she speaks: fewer than 3 words is presumed echo; a substring of what she is
    /// saying is echo; more than 66% of the words in common is echo.
    static func looksLikeOwnEcho(recognized: String, answer: String) -> Bool {
        let heard = words(recognized)
        guard heard.count >= 3 else { return true }
        let said = words(answer)
        guard !said.isEmpty else { return false }
        let saidJoined = " " + said.joined(separator: " ") + " "
        if saidJoined.contains(" " + heard.joined(separator: " ") + " ") { return true }
        let saidSet = Set(said)
        let overlap = Double(heard.filter { saidSet.contains($0) }.count) / Double(heard.count)
        return overlap > 0.66
    }

    /// With hardware cancellation the echo is mostly gone, so short phrases count as the
    /// user, unless every word of them is something she is saying (residual echo).
    static func looksLikeResidualEcho(recognized: String, spoken: String) -> Bool {
        let heard = words(recognized)
        guard !heard.isEmpty else { return true }
        if heard.count < 3 {
            let saidSet = Set(words(spoken))
            return heard.allSatisfy { saidSet.contains($0) }
        }
        return looksLikeOwnEchoByContent(recognized: recognized, spoken: spoken)
    }

    /// Content-only version (no "short means echo"): used once she has stopped, so a
    /// short real reply ("si'", "no, aspetta") passes.
    static func looksLikeOwnEchoByContent(recognized: String, spoken: String) -> Bool {
        let heard = words(recognized)
        guard heard.count >= 3 else { return false }
        let said = words(spoken)
        guard !said.isEmpty else { return false }
        let saidJoined = " " + said.joined(separator: " ") + " "
        if saidJoined.contains(" " + heard.joined(separator: " ") + " ") { return true }
        let saidSet = Set(said)
        let overlap = Double(heard.filter { saidSet.contains($0) }.count) / Double(heard.count)
        return overlap > 0.66
    }

    static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "it_IT"))
            .lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
