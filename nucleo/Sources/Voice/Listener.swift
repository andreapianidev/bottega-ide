//
//  Listener.swift
//  Bottega Nucleo
//
//  The microphone side. Transcription defaults to Apple's SFSpeechRecognizer;
//  ElevenLabs realtime is available with BOTTEGA_STT=elevenlabs. Modes:
//   - push:      open until voice.stop (push-to-talk): manual commit, then voice.final;
//   - utterance: ends at the first committed utterance;
//   - converse:  every committed utterance is a user turn (voice.final); with Apple
//                recognition the mic closes while Melissa thinks and speaks;
//   - wake:      waits for a phrase ("melissa"), event wake.detected.
//  Wake gates audio around speech; conversation sends everything while the mic is open.
//
//  Lessons kept from Melissa (Avo Agency AI, VoiceSession.swift):
//   - a FRESH AVAudioEngine per listening window (a reused one fails with -10868 after
//     a device switch);
//   - check the input format before installing the tap (and on macOS 27 the tap API
//     throws instead of aborting the process);
//   - open the HAL OFF the main thread: it blocked main up to 4.4 s;
//   - outside conversation mode the mic stays CLOSED while Melissa speaks.
//
//  The recognizer/session stays warm while voice is in use and closes 30 s after
//  the last listening window.
//

import AppKit
import Foundation
import AVFoundation
import os

/// Audio-thread side of the microphone: metering, barge-in VAD, and the hand-off to the
/// STT client.
final class MicTap: @unchecked Sendable {
    private struct State {
        var stt: (any Trascrittore)?
        var vadArmed = false          // conversation + hardware AEC + Melissa speaking
        var voicedSince: CFTimeInterval?
        var vadFired = false
        var buffers = 0
        var audible = 0
        var emitLevels = true
    }
    private let state = OSAllocatedUnfairLock(uncheckedState: State())
    var onVAD: (@Sendable () -> Void)?

    func setSTT(_ c: (any Trascrittore)?) { state.withLockUnchecked { $0.stt = c } }
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
        let (stt, emit): ((any Trascrittore)?, Bool) = state.withLockUnchecked { s in
            s.buffers += 1
            if level > 0.0005 { s.audible += 1 }
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
            return (s.stt, s.emitLevels)
        }
        if emit {
            AudioLevels.shared.set(.mic, level: level, bands: AudioLevels.bands(buffer, loudness: level))
        }
        stt?.append(buffer, level: level)
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

    /// Avo's engine (SFSpeechRecognizer) by default; ElevenLabs realtime with BOTTEGA_STT=elevenlabs.
    static let usaElevenLabs = ProcessInfo.processInfo.environment["BOTTEGA_STT"] == "elevenlabs"
    static let backend = usaElevenLabs ? "elevenlabs:\(ScribeClient.model)" : AppleSTT.name

    private(set) var mode: Mode?
    var backendName: String { Self.backend }
    /// "hardware" (VPIO) or "software" (text echo rejection); last conversation's path.
    private(set) var echoCancellation = "software"
    private(set) var echoTested = false

    private var stt: (any Trascrittore)?
    private var sttLanguage = "it"
    private var sttCloseWork: DispatchWorkItem?
    private var mic: MicEngine?
    private var usingDuplex = false
    /// Conversation, Apple engine: the microphone engine is OFF while Melissa thinks and speaks
    /// (Avo Agency AI, teardownAudio), so macOS does not show the microphone in use.
    private var micPaused = false
    private var reopenWork: DispatchWorkItem?
    private let tap = MicTap()
    private var locale = "it-IT"

    // Current window
    private var committedText = ""
    private var partialText = ""
    private var commitArrived = false
    private var limitWork: DispatchWorkItem?
    private var windowID = 0
    private var starting = false
    private var finishing = false
    private var conversationRequestID = 0

    // Conversation echo bookkeeping
    private var speechEndedAt = Date.distantPast
    private var lastSpoken = ""
    private var utteranceBeganWhileSpeaking = false
    private var lastReconnect = Date.distantPast

    // Wake
    private var wakePhrase: String?
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
    var sttSecondsSent: Double { stt?.secondsSent ?? 0 }

    // MARK: - Permissions

    /// The Privacy > Microphone pane of System Settings.
    static let microphoneSettings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!

    /// Microphone permission. The request has a time limit: the Nucleo is a helper with no
    /// window, and on 2/10/2026 `requestAccess` never returned (no dialog on screen), which
    /// left the voice hanging on "ti ascolto" with no error. Now it fails with a clear message
    /// and opens the Microphone pane, where Andrea can switch Bottega on.
    static func ensureMicrophone() async throws {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        Log.info("permesso del microfono: \(status.rawValue) (0 non deciso, 2 negato, 3 autorizzato)")
        switch status {
        case .authorized:
            return
        case .notDetermined:
            let granted: Bool? = await withCheckedContinuation { (k: CheckedContinuation<Bool?, Never>) in
                let once = OSAllocatedUnfairLock(initialState: false)
                let finish: (Bool?) -> Void = { value in
                    let first = once.withLock { done -> Bool in
                        if done { return false }
                        done = true
                        return true
                    }
                    if first { k.resume(returning: value) }
                }
                AVCaptureDevice.requestAccess(for: .audio) { finish($0) }
                DispatchQueue.global().asyncAfter(deadline: .now() + 20) { finish(nil) }
            }
            if granted == true { return }
            openMicrophoneSettings()
            if granted == nil {
                throw NucleoError("macOS non ha risposto alla richiesta del microfono. Si è aperto Impostazioni di Sistema, Privacy e sicurezza, Microfono: accendi Bottega e riprova.")
            }
            throw NucleoError("Il permesso del microfono è stato negato. Si è aperto Impostazioni di Sistema, Privacy e sicurezza, Microfono: accendi Bottega e riprova.")
        default:
            openMicrophoneSettings()
            throw NucleoError("Il microfono non è autorizzato per Bottega. Si è aperto Impostazioni di Sistema, Privacy e sicurezza, Microfono: accendi Bottega e riprova.")
        }
    }

    private static func openMicrophoneSettings() {
        DispatchQueue.main.async { NSWorkspace.shared.open(microphoneSettings) }
    }

    // MARK: - STT socket

    private static func languageCode(_ locale: String) -> String {
        String(locale.split(whereSeparator: { $0 == "-" || $0 == "_" }).first ?? "it").lowercased()
    }

    /// The warm STT session, opened if needed. On failure the voice goes to the error
    /// state with an Italian message, and the request fails with the same message.
    private func ensureSTT(locale loc: String) async throws -> any Trascrittore {
        sttCloseWork?.cancel(); sttCloseWork = nil
        let lang = Self.languageCode(loc)
        if let s = stt, s.isReady, lang == sttLanguage { return s }
        stt?.close()
        stt = nil
        if !Self.usaElevenLabs {
            do { try await AppleSTT.ensureAuthorization() } catch {
                VoiceHub.shared.error(error.localizedDescription)
                throw error
            }
        }
        let s: any Trascrittore = Self.usaElevenLabs ? ScribeClient(language: lang) : AppleSTT(language: loc.isEmpty ? lang : loc)
        s.onEvent = { [weak self, weak s] event in
            guard let self, let s, self.stt === s else { return }
            self.handleSTT(event)
        }
        do {
            try s.connect()
        } catch {
            VoiceHub.shared.error(error.localizedDescription)
            throw error
        }
        stt = s
        sttLanguage = lang
        guard await s.waitReady(timeout: 6) else {
            s.close()
            if stt === s { stt = nil }
            let message = "La trascrizione della voce non e' disponibile: il servizio non risponde."
            VoiceHub.shared.error(message)
            throw NucleoError(message)
        }
        return s
    }

    /// 30 s after the last window, nobody is listening: let the socket go.
    private func scheduleSTTClose() {
        sttCloseWork?.cancel()
        guard mode == nil, stt != nil else { return }
        let work = DispatchWorkItem {
            MainActor.assumeIsolated {
                let me = Listener.shared
                guard me.mode == nil, let s = me.stt else { return }
                s.close()
                me.stt = nil
                Log.info("trascrizione: sessione chiusa per inattivita'")
            }
        }
        sttCloseWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: work)
    }

    /// Opens the STT session ahead of a likely listen (orb shown, hotkey pressed).
    func prewarm() {
        guard !Self.usaElevenLabs || ElevenLabsConfig.isConfigured else { return }
        Task {
            _ = try? await ensureSTT(locale: locale)
            if mode == nil { scheduleSTTClose() }
        }
    }

    // MARK: - push / utterance

    /// Opening the HAL and closing a turn both cross suspension points. A second command
    /// must wait for that transition, otherwise two microphone engines can open together.
    private func waitForAudioTransition(conversationRequest requestID: Int? = nil) async throws -> Bool {
        let deadline = Date().addingTimeInterval(12)
        while starting || finishing {
            if let requestID, requestID != conversationRequestID { return false }
            guard Date() < deadline else {
                throw NucleoError("Il microfono sta ancora cambiando modalità. Riprova tra un momento.")
            }
            try await Task.sleep(for: .milliseconds(25))
        }
        return requestID == nil || requestID == conversationRequestID
    }

    func listen(mode newMode: Mode, locale loc: String?) async throws {
        guard newMode == .push || newMode == .utterance else { return }
        _ = try await waitForAudioTransition()
        if conversing {
            throw NucleoError("La conversazione e' attiva: il microfono e' gia' aperto.")
        }
        if isCapturing { return }
        starting = true
        defer { starting = false }
        // Outside conversation the mic stays closed while Melissa speaks.
        if Speaker.shared.isSpeaking { Speaker.shared.stopSpeaking() }
        await suspendWake()
        try await open(mode: newMode, locale: loc ?? locale, duplex: false)
        armLimits()
    }

    /// voice.stop: closes push/utterance and emits the last voice.final.
    func stop() async {
        guard let m = mode, m == .push || m == .utterance else { return }
        await finishWindow(emit: true, commitFirst: true)
    }

    // MARK: - Conversation

    func converseStart(locale loc: String?) async throws {
        Log.info("conversazione richiesta\(conversing ? ": era gia' aperta" : "")")
        if conversing { return }
        conversationRequestID &+= 1
        let requestID = conversationRequestID
        guard try await waitForAudioTransition(conversationRequest: requestID) else { return }
        if conversing { return }
        starting = true
        defer { starting = false }
        if isCapturing { await finishWindow(emit: true, commitFirst: true) }
        guard requestID == conversationRequestID else { return }
        await suspendWake()
        guard requestID == conversationRequestID else { return }
        // Avo: no voice processing on macOS (VPIO starves SFSpeechRecognizer: "No speech detected").
        do {
            try await open(mode: .converse, locale: loc ?? locale, duplex: Self.usaElevenLabs)
        } catch {
            if requestID != conversationRequestID { return }
            throw error
        }
        if requestID != conversationRequestID {
            await closeConversationWindow()
            return
        }
        Speaker.shared.prewarm()
    }

    func converseStop() async {
        // A stop may arrive while converseStart is still waiting for HAL/microphone
        // permission, before mode becomes .converse. Invalidate that pending start.
        conversationRequestID &+= 1
        await closeConversationWindow()
    }

    private func closeConversationWindow() async {
        guard conversing else { return }
        mode = nil
        finishing = true
        Log.info("conversazione chiusa dal Nucleo, audio inviato in questa sessione: \(String(format: "%.1f", sttSecondsSent)) s")
        // Chiudere la conversazione la chiude davvero: la frase a meta' non diventa una domanda.
        await closeWindowAudio()
        resetWindow()
        VoiceHub.shared.refresh()
        scheduleSTTClose()
        await resumeWakeIfNeeded()
        finishing = false
    }

    // MARK: - Wake word

    func wakeEnable(phrase: String, locale loc: String?) async throws {
        wakePhrase = Self.fold(phrase.isEmpty ? "melissa" : phrase)
        if let loc { locale = loc }
        if mode == nil, !Speaker.shared.isSpeaking { try await openWake() }
    }

    func wakeDisable() async {
        wakePhrase = nil
        if mode == .wake { await finishWindow(emit: false, commitFirst: false) }
    }

    private func openWake() async throws {
        guard wakePhrase != nil, mode == nil else { return }
        try await open(mode: .wake, locale: locale, duplex: false)
    }

    private func suspendWake() async {
        if mode == .wake { await finishWindow(emit: false, commitFirst: false) }
    }

    func resumeWakeIfNeeded() async {
        guard wakePhrase != nil, mode == nil, !Speaker.shared.isSpeaking, !starting else { return }
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
        let s = try await ensureSTT(locale: loc)
        // Only the wake word listens through the gate. In conversation everything goes to the
        // transcription: on 2/10/2026 the gate (level > 0.08, about -37 dBFS) kept a MacBook Air
        // built-in mic without voice processing (VPIO fails with -10875) below the threshold, so
        // ElevenLabs got no audio at all and dropped the socket after 14 s. A conversation closes
        // after 60 s of silence, so the extra audio is bounded.
        s.setGated(newMode == .wake)
        // The warm session may still be muted from a reply cut short (voice off while Melissa
        // spoke): reused as it was, it got the microphone and transcribed nothing (4/10/2026).
        s.setMuted(false)
        resetWindow()
        tap.setEmitLevels(newMode != .wake)
        tap.armVAD(false)
        tap.resetHealth()
        tap.setSTT(s)

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
                tap.setSTT(nil)
                scheduleSTTClose()
                throw error
            }
        }
        usingDuplex = duplexOK
        mode = newMode
        windowID &+= 1
        Log.info("microfono aperto: modo \(newMode.rawValue), \(Self.backend)\(wantDuplex ? ", eco \(echoCancellation)" : "")")
        // Three seconds later: does the mic deliver sound, or the silence of a capture macOS does not allow?
        let healthTap = tap
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            let (seen, audible) = healthTap.health
            Log.info("segnale del microfono dopo 3 s: \(seen) blocchi, \(audible) con suono\(seen > 0 && audible == 0 ? " (SILENZIO: macOS non sta dando l'audio a questo processo)" : "")")
        }
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

    private func closeWindowAudio() async {
        limitWork?.cancel(); limitWork = nil
        reopenWork?.cancel(); reopenWork = nil
        micPaused = false
        tap.setSTT(nil)
        tap.armVAD(false)
        mic?.stop()
        mic = nil
        if usingDuplex {
            usingDuplex = false
            await AudioOut.shared.stopDuplex()
        }
        AudioLevels.shared.reset(.mic)
    }

    private func resetWindow() {
        partialLogged = false
        committedText = ""
        partialText = ""
        commitArrived = false
        utteranceBeganWhileSpeaking = false
    }

    private func finishWindow(emit: Bool, commitFirst: Bool) async {
        guard let m = mode else { return }
        // Claim the window before the first await. Apple may still deliver its committed
        // transcript while the mic is closing; keep collecting it until voice.final.
        mode = nil
        finishing = true
        // Stop feeding audio, then (push-to-talk) close the utterance by hand and give
        // the server a moment to answer with the committed text.
        await closeWindowAudio()
        if emit, commitFirst, let s = stt, !partialText.isEmpty || committedText.isEmpty {
            VoiceHub.shared.setState("processing")
            commitArrived = false
            s.commit()
            let deadline = Date().addingTimeInterval(2.0)
            while !commitArrived, Date() < deadline, stt === s {
                try? await Task.sleep(for: .milliseconds(25))
            }
        }
        var text = committedText
        if !partialText.isEmpty, !commitArrived {
            // No commit in time: the last partial is the best we have.
            text += text.isEmpty ? partialText : " " + partialText
        }
        resetWindow()
        if emit {
            let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
            Out.event("voice.final", ["text": clean, "mode": m.rawValue])
            if !clean.isEmpty { VoiceHub.shared.userTurnEnded() }
        }
        VoiceHub.shared.refresh()
        scheduleSTTClose()
        if m != .wake { await resumeWakeIfNeeded() }
        finishing = false
    }

    private func armLimits() {
        limitWork?.cancel()
        let id = windowID
        // A held push-to-talk key can carry a long explanation; AppleSTT rotates its
        // 45-second recognition requests and RollingTranscript joins the pieces.
        let limit: Double = mode == .utterance ? 60 : 600
        let work = DispatchWorkItem {
            MainActor.assumeIsolated {
                let me = Listener.shared
                guard me.windowID == id, me.mode == .push || me.mode == .utterance else { return }
                Log.info("ascolto chiuso per durata massima")
                Task { await me.finishWindow(emit: true, commitFirst: true) }
            }
        }
        limitWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + limit, execute: work)
        if mode == .utterance {
            // Nobody spoke at all within 8 s: close with an empty final.
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
                MainActor.assumeIsolated {
                    let me = Listener.shared
                    guard me.windowID == id, me.mode == .utterance,
                          me.partialText.isEmpty, me.committedText.isEmpty else { return }
                    Task { await me.finishWindow(emit: true, commitFirst: false) }
                }
            }
        }
    }

    // MARK: - STT events

    private func handleSTT(_ event: ScribeClient.Event) {
        switch event {
        case .started(let config):
            let vad = config["vad_silence_threshold_secs"].map { "\($0)" } ?? "?"
            Log.info("trascrizione pronta (\(Self.backend), silenzio di fine frase \(vad) s)")
        case .partial(let text):
            handlePartial(text.trimmingCharacters(in: .whitespacesAndNewlines))
        case .committed(let text):
            let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !clean.isEmpty { commitArrived = true }
            handleCommitted(clean)
        case .failed(let message):
            sttFailed(message)
        }
    }

    private func sttFailed(_ message: String) {
        Log.warn("trascrizione (\(Self.backend)): \(message)")
        stt = nil
        guard let m = mode else { return }
        let text = "La trascrizione di ElevenLabs si e' interrotta: \(message)"
        switch m {
        case .push, .utterance:
            VoiceHub.shared.error(text)
            Task { await finishWindow(emit: true, commitFirst: false) }
        case .converse, .wake:
            // One quiet reconnect, at most every 10 s; otherwise give up with an error.
            if Date().timeIntervalSince(lastReconnect) > 10 {
                lastReconnect = Date()
                Task {
                    do {
                        let s = try await ensureSTT(locale: locale)
                        s.setGated(m == .wake)
                        tap.setSTT(s)
                        Log.info("trascrizione ricollegata")
                    } catch {
                        if m == .converse { await converseStop() } else { await wakeDisable() }
                    }
                }
            } else {
                VoiceHub.shared.error(text)
                Task { if m == .converse { await converseStop() } else { await wakeDisable() } }
            }
        }
    }

    private var partialLogged = false

    private func handlePartial(_ text: String) {
        if !partialLogged, !text.isEmpty {
            partialLogged = true
            Log.info("prima trascrizione parziale ricevuta (\(text.count) caratteri)")
        }
        guard let m = mode, !text.isEmpty, text != partialText else { return }
        // Apple's microphone is physically closed during a reply. A result already
        // queued before that close is stale user audio, never a barge-in.
        if m == .converse, micPaused, !Self.usaElevenLabs { return }
        switch m {
        case .wake:
            partialText = text
            checkWake(text)
            return
        case .converse:
            if Speaker.shared.isSpeaking {
                utteranceBeganWhileSpeaking = true
                if isEchoWhileSpeaking(text) { partialText = text; return }
                bargeIn(reason: "parole")
            }
            partialText = text
            Out.event("voice.partial", ["text": text, "mode": m.rawValue])
            VoiceHub.shared.partial(text)
        case .push, .utterance:
            partialText = text
            let shown = committedText.isEmpty ? text : committedText + " " + text
            Out.event("voice.partial", ["text": shown, "mode": m.rawValue])
            VoiceHub.shared.partial(shown)
        }
    }

    private func handleCommitted(_ text: String) {
        if finishing, mode == nil {
            if !text.isEmpty {
                committedText += committedText.isEmpty ? text : " " + text
                partialText = ""
            }
            return
        }
        guard let m = mode else { return }
        if m == .converse, micPaused, !Self.usaElevenLabs { return }
        partialText = ""
        guard !text.isEmpty else { return }
        switch m {
        case .wake:
            checkWake(text)
        case .push:
            committedText += committedText.isEmpty ? text : " " + text
            Out.event("voice.partial", ["text": committedText, "mode": m.rawValue])
            VoiceHub.shared.partial(committedText)
        case .utterance:
            committedText += committedText.isEmpty ? text : " " + text
            Task { await finishWindow(emit: true, commitFirst: false) }
        case .converse:
            let began = utteranceBeganWhileSpeaking
            utteranceBeganWhileSpeaking = false
            if Speaker.shared.isSpeaking {
                if isEchoWhileSpeaking(text) { return }
                bargeIn(reason: "parole")
            } else if began || Date().timeIntervalSince(speechEndedAt) < 0.4,
                      Self.looksLikeResidualEcho(recognized: text, spoken: lastSpoken) {
                Log.info("scartato come eco della voce: \"\(text)\"")
                return
            }
            Out.event("voice.final", ["text": text, "mode": m.rawValue])
            VoiceHub.shared.userTurnEnded()
            pauseMicForReply()
        }
    }

    private func isEchoWhileSpeaking(_ text: String) -> Bool {
        let spoken = Speaker.shared.spokenSoFar
        return echoCancellation == "hardware"
            ? Self.looksLikeResidualEcho(recognized: text, spoken: spoken)
            : Self.looksLikeOwnEcho(recognized: text, answer: spoken)
    }

    private func checkWake(_ text: String) {
        guard let phrase = wakePhrase, Self.fold(text).contains(phrase),
              Date().timeIntervalSince(lastWake) > 2 else { return }
        lastWake = Date()
        Out.event("wake.detected", ["phrase": phrase, "text": text])
    }

    // MARK: - Conversation hooks from the speaker

    /// Melissa started a reply: with hardware AEC the energy VAD watches for the user;
    /// outside conversation the wake listener closes the mic.
    func speechStarted() {
        if mode == .wake {
            Task { await suspendWake() }
            return
        }
        guard conversing else { return }
        // Avo Agency AI: while Melissa speaks the microphone is closed (no echo, no self-talk).
        if !Self.usaElevenLabs { pauseMicForReply(); return }
        tap.armVAD(echoCancellation == "hardware")
    }

    func speechEnded(spoken: String) {
        speechEndedAt = Date()
        lastSpoken = spoken
        tap.armVAD(false)
        if conversing, !Self.usaElevenLabs {
            if micPaused { replyOver() } else { stt?.setMuted(false) }
        }
        if !conversing { Task { await resumeWakeIfNeeded() } }
    }

    // MARK: - Microphone off during the reply (Avo Agency AI)

    /// The user's turn is closed, or Melissa started speaking: the microphone engine stops,
    /// not just the transcription. Before 3/10/2026 only the transcription was muted and
    /// macOS kept the orange microphone on for the whole reply.
    private func pauseMicForReply() {
        stt?.setMuted(true)
        guard conversing, !Self.usaElevenLabs, !usingDuplex else { return }
        reopenWork?.cancel(); reopenWork = nil
        guard let m = mic else { return }
        m.stop()
        mic = nil
        micPaused = true
        AudioLevels.shared.reset(.mic)
        Log.info("microfono chiuso: Melissa pensa e risponde")
    }

    /// The reply is over (voice ended, or the extension says the turn closed without voice):
    /// the microphone reopens 250 ms later, Avo's re-arm delay.
    func replyOver() {
        guard micPaused, conversing, !Speaker.shared.isSpeaking else { return }
        stt?.setMuted(false)
        reopenWork?.cancel()
        let work = DispatchWorkItem {
            Task { @MainActor in await Listener.shared.reopenMic() }
        }
        reopenWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + AppleSTT.rearmDelay, execute: work)
    }

    private func reopenMic() async {
        reopenWork = nil
        guard micPaused, conversing, mic == nil, !Speaker.shared.isSpeaking else { return }
        micPaused = false
        tap.resetHealth()
        do {
            let m = try await MicEngine.start(tap)
            // She started speaking again (or the conversation closed) while the engine was starting.
            if !conversing || Speaker.shared.isSpeaking {
                m.stop()
                micPaused = conversing
                return
            }
            mic = m
            Log.info("microfono riaperto dopo la risposta")
        } catch {
            Log.error("Il microfono non si riapre dopo la risposta: \(error.localizedDescription)")
            VoiceHub.shared.error("Il microfono non si riapre: \(error.localizedDescription)")
            await converseStop()
        }
    }

    /// The user talked over Melissa: silence her at once and keep listening.
    func bargeIn(reason: String) {
        guard conversing, Speaker.shared.isSpeaking else { return }
        let t0 = CACurrentMediaTime()
        Speaker.shared.stopSpeaking()
        tap.armVAD(false)
        let ms = Int((CACurrentMediaTime() - t0) * 1000)
        Log.info("barge-in (\(reason)), voce fermata in \(ms) ms")
        Out.event("voice.bargein", ["text": partialText, "trigger": reason == "voce" ? "energy" : "speech"])
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
