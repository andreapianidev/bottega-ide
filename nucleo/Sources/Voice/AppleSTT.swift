//
//  AppleSTT.swift
//  Bottega Nucleo
//
//  The transcription Melissa uses in Avo Agency AI (Features/Voice/VoiceSession.swift), on
//  the Mac: SFSpeechRecognizer it-IT fed with the microphone buffers as they come, partial
//  results on, a FRESH SFSpeechAudioBufferRecognitionRequest for every utterance, and the
//  utterance closed after 1.8 s with no new words (Avo's `endOfSpeechSilence`) or when the
//  recognizer says the result is final. While Melissa speaks the microphone is not heard
//  (Avo Agency AI keeps it closed: on macOS there is no reliable echo cancellation), and
//  250 ms after she stops a new request starts (Avo's re-arm delay).
//
//  It replaces ElevenLabs realtime here (2/10/2026): on Andrea's Mac 20 s of microphone
//  audio went to ElevenLabs and not one word came back, while Avo on the same Mac hears him.
//  Same surface as ScribeClient (Trascrittore), so Listener does not change its modes.
//  ElevenLabs stays available with BOTTEGA_STT=elevenlabs.
//

import AppKit
import Foundation
import AVFoundation
import Speech

/// What Listener needs from a transcription engine.
protocol Trascrittore: AnyObject, Sendable {
    var onEvent: ((ScribeClient.Event) -> Void)? { get set }
    var isReady: Bool { get }
    var secondsSent: Double { get }
    func connect() throws
    func waitReady(timeout: Double) async -> Bool
    func close()
    func setGated(_ on: Bool)
    func append(_ buffer: AVAudioPCMBuffer, level: Float)
    func commit()
    /// While Melissa speaks the microphone is not transcribed (Avo Agency AI).
    func setMuted(_ on: Bool)
}

extension ScribeClient: Trascrittore {
    func setMuted(_ on: Bool) {}
}

final class AppleSTT: Trascrittore, @unchecked Sendable {
    /// Avo: "How long of a pause ends the turn" (VoiceSession.endOfSpeechSilence).
    static let endOfSpeechSilence: TimeInterval = 1.8
    /// Avo: re-arm delay after the voice stops (scheduleListeningRearm).
    static let rearmDelay: TimeInterval = 0.25
    static let name = "apple:SFSpeechRecognizer"

    /// Delivered on the main queue.
    var onEvent: ((ScribeClient.Event) -> Void)?

    private let recognizer: SFSpeechRecognizer?
    private let lock = NSLock()
    // Guarded by `lock` (the audio thread appends).
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var muted = false
    private var frames: Double = 0
    // Main queue only.
    private var task: SFSpeechRecognitionTask?
    private var opened = false
    private var generation = 0
    private var lastPartial = ""
    private var waitingCommit = false
    private var silenceWork: DispatchWorkItem?
    private var unmuteWork: DispatchWorkItem?

    init(language: String) {
        let id = language.contains("-") ? language : (language == "it" ? "it-IT" : language)
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: id))
    }

    var isReady: Bool { opened }
    var secondsSent: Double { lock.withLock { frames } }

    /// Speech recognition permission, as Avo asks for it (SFSpeechRecognizer.requestAuthorization),
    /// with the same time limit as the microphone: the Nucleo has no window of its own.
    static func ensureAuthorization() async throws {
        let status = SFSpeechRecognizer.authorizationStatus()
        Log.info("permesso del riconoscimento vocale: \(status.rawValue) (0 non deciso, 2 negato, 3 autorizzato)")
        if status == .authorized { return }
        if status == .notDetermined {
            let granted: Bool? = await withCheckedContinuation { (k: CheckedContinuation<Bool?, Never>) in
                let once = NSLock()
                var done = false
                let finish: (Bool?) -> Void = { value in
                    once.lock(); defer { once.unlock() }
                    if done { return }
                    done = true
                    k.resume(returning: value)
                }
                SFSpeechRecognizer.requestAuthorization { finish($0 == .authorized) }
                DispatchQueue.global().asyncAfter(deadline: .now() + 20) { finish(nil) }
            }
            if granted == true { return }
        }
        DispatchQueue.main.async {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition")!)
        }
        throw NucleoError("Il riconoscimento vocale non è autorizzato per Bottega Nucleo. Si è aperto Impostazioni di Sistema, Privacy e sicurezza, Riconoscimento vocale: accendi Bottega Nucleo e riprova.")
    }

    func connect() throws {
        guard let recognizer, recognizer.isAvailable else {
            throw NucleoError("Il riconoscimento vocale italiano non è disponibile su questo Mac in questo momento.")
        }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            throw NucleoError("Il riconoscimento vocale non è autorizzato per Bottega Nucleo.")
        }
        opened = true
        startRequest()
        let config: [String: Any] = ["vad_silence_threshold_secs": Self.endOfSpeechSilence]
        DispatchQueue.main.async { [weak self] in self?.onEvent?(.started(config)) }
    }

    func waitReady(timeout: Double) async -> Bool { opened }

    func close() {
        opened = false
        silenceWork?.cancel(); silenceWork = nil
        unmuteWork?.cancel(); unmuteWork = nil
        endRequest()
    }

    func setGated(_ on: Bool) {}

    /// Audio thread: the buffer goes to the recognizer as it is, like Avo's mic tap.
    func append(_ buffer: AVAudioPCMBuffer, level: Float) {
        lock.lock()
        let r = muted ? nil : request
        if r != nil { frames += Double(buffer.frameLength) / max(1, buffer.format.sampleRate) }
        lock.unlock()
        r?.append(buffer)
    }

    /// Push-to-talk released: the words heard so far are the utterance. If nothing has
    /// been recognized yet, the first result closes it (Avo: waitingForFirstRecognition).
    func commit() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if !self.lastPartial.isEmpty { self.finalize(self.lastPartial) } else { self.waitingCommit = true }
        }
    }

    func setMuted(_ on: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.unmuteWork?.cancel(); self.unmuteWork = nil
            if on {
                self.lock.withLock { self.muted = true }
                self.silenceWork?.cancel(); self.silenceWork = nil
                self.lastPartial = ""
                self.endRequest()
            } else {
                let work = DispatchWorkItem { [weak self] in
                    guard let self, self.opened else { return }
                    self.lock.withLock { self.muted = false }
                    self.startRequest()
                }
                self.unmuteWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.rearmDelay, execute: work)
            }
        }
    }

    // MARK: - Requests (main queue)

    private func startRequest() {
        guard opened, let recognizer else { return }
        endRequest()
        generation &+= 1
        let g = generation
        let r = SFSpeechAudioBufferRecognitionRequest()
        r.shouldReportPartialResults = true
        lock.withLock { request = r }
        lastPartial = ""
        task = recognizer.recognitionTask(with: r) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let message = error?.localizedDescription
            DispatchQueue.main.async { self?.handle(g, text: text, isFinal: isFinal, error: message) }
        }
    }

    private func endRequest() {
        let r: SFSpeechAudioBufferRecognitionRequest? = lock.withLock {
            let old = request
            request = nil
            return old
        }
        r?.endAudio()
        task?.cancel()
        task = nil
    }

    private func handle(_ g: Int, text: String?, isFinal: Bool, error: String?) {
        guard g == generation, opened else { return }
        if let text {
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if isFinal {
                finalize(t)
                return
            }
            if !t.isEmpty, t != lastPartial {
                lastPartial = t
                onEvent?(.partial(t))
                if waitingCommit {
                    finalize(t)
                    return
                }
                scheduleSilence()
            }
        }
        if let error {
            // The recognizer ends a window now and then ("No speech detected", the one-minute
            // limit): what was heard becomes the utterance, otherwise a new request starts.
            if !lastPartial.isEmpty {
                finalize(lastPartial)
            } else if lock.withLock({ !muted }) {
                Log.info("riconoscimento vocale: finestra chiusa (\(error)), ne apro un'altra")
                startRequest()
            }
        }
    }

    private func scheduleSilence() {
        silenceWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.lastPartial.isEmpty else { return }
            self.finalize(self.lastPartial)
        }
        silenceWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.endOfSpeechSilence, execute: work)
    }

    /// One utterance is over: hand it to Listener and start a fresh request for the next one.
    private func finalize(_ text: String) {
        silenceWork?.cancel(); silenceWork = nil
        waitingCommit = false
        lastPartial = ""
        if lock.withLock({ !muted }) { startRequest() } else { endRequest() }
        if !text.isEmpty { onEvent?(.committed(text)) }
    }
}
