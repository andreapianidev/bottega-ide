//
//  AppleSTT.swift
//  Bottega Nucleo
//
//  The transcription Melissa uses in Avo Agency AI (Features/Voice/VoiceSession.swift), on
//  the Mac: SFSpeechRecognizer it-IT fed with the microphone buffers as they come, partial
//  results on, a FRESH SFSpeechAudioBufferRecognitionRequest for every utterance, and the
//  utterance closed after 1.8 s with no new words (Avo's `endOfSpeechSilence`). Apple
//  recognition windows are rotated before their one-minute limit; the text carries over.
//  While Melissa speaks the microphone is not heard
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
    static let recognitionWindow: TimeInterval = 45
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
    private var transcript = RollingTranscript()
    private var waitingCommit = false
    private var silenceWork: DispatchWorkItem?
    private var rolloverWork: DispatchWorkItem?

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
        rolloverWork?.cancel(); rolloverWork = nil
        lock.withLock { muted = false }
        transcript.reset()
        waitingCommit = false
        endRequest()
    }

    func setGated(_ on: Bool) {}

    /// Audio thread: the buffer goes to the recognizer as it is, like Avo's mic tap.
    func append(_ buffer: AVAudioPCMBuffer, level: Float) {
        lock.withLock {
            guard !muted, let request else { return }
            frames += Double(buffer.frameLength) / max(1, buffer.format.sampleRate)
            request.append(buffer)
        }
    }

    /// Push-to-talk released: the words heard so far are the utterance. If nothing has
    /// been recognized yet, the first result closes it (Avo: waitingForFirstRecognition).
    func commit() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard self.opened else { return }
            if !self.transcript.isEmpty { self.finalize() } else { self.waitingCommit = true }
        }
    }

    func setMuted(_ on: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard self.opened else { return }
            if on {
                guard !self.lock.withLock({ self.muted }) else { return }
                self.lock.withLock { self.muted = true }
                self.silenceWork?.cancel(); self.silenceWork = nil
                self.rolloverWork?.cancel(); self.rolloverWork = nil
                self.transcript.reset()
                self.waitingCommit = false
                self.endRequest()
            } else {
                // connect() already starts an unmuted request. Restarting it here drops
                // the first words captured while the microphone is opening. Listener
                // already waits 250 ms before reopening the mic after Melissa speaks.
                guard self.lock.withLock({ self.muted }) else { return }
                self.lock.withLock { self.muted = false }
                self.startRequest()
            }
        }
    }

    // MARK: - Requests (main queue)

    private func startRequest() {
        guard opened, let recognizer else { return }
        rolloverWork?.cancel(); rolloverWork = nil
        endRequest()
        generation &+= 1
        let g = generation
        let r = SFSpeechAudioBufferRecognitionRequest()
        r.shouldReportPartialResults = true
        // the names Andrea says to Melissa: Apple prefers them when the sound is close
        // ("Cristal Vista" was Krista, 6 Oct 2026; contract 9.11)
        r.contextualStrings = Self.nomiDaRiconoscere()
        lock.withLock { request = r }
        task = recognizer.recognitionTask(with: r) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let message = error?.localizedDescription
            DispatchQueue.main.async { self?.handle(g, text: text, isFinal: isFinal, error: message) }
        }
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.opened, self.generation == g else { return }
            self.rollover(reason: "finestra programmata")
        }
        rolloverWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.recognitionWindow, execute: work)
    }

    /// Melissa's characters (their `nome` in ~/.bottega/personaggi/*.json) and the words around her.
    static func nomiDaRiconoscere() -> [String] {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".bottega/personaggi")
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        let nomi = files.filter { $0.pathExtension == "json" }.compactMap { url -> String? in
            guard let data = try? Data(contentsOf: url),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  json["chiave"] as? String != "melissa" else { return nil }
            return json["nome"] as? String
        }
        return nomi.sorted() + ["Melissa", "Claude", "Claude Code", "Bottega"]
    }

    private func endRequest() {
        lock.withLock {
            request?.endAudio()
            request = nil
        }
        task?.cancel()
        task = nil
    }

    private func handle(_ g: Int, text: String?, isFinal: Bool, error: String?) {
        guard g == generation, opened, lock.withLock({ !muted }) else { return }
        if let text {
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty, t != transcript.current {
                transcript.partial(t)
                onEvent?(.partial(transcript.text))
                if waitingCommit {
                    finalize()
                    return
                }
                scheduleSilence()
            }
        }
        if isFinal || error != nil {
            // A final result may mean only that Apple closed its request. The silence
            // timer, or an explicit push-to-talk commit, decides when the turn ends.
            if waitingCommit, !transcript.isEmpty { finalize(); return }
            if let error { Log.info("riconoscimento vocale: finestra chiusa (\(error)), ne apro un'altra") }
            rollover(reason: isFinal ? "risultato finale Apple" : "richiesta terminata")
        }
    }

    private func rollover(reason: String) {
        guard opened, lock.withLock({ !muted }) else { return }
        transcript.rollOver()
        Log.info("riconoscimento vocale: \(reason), continuo il turno")
        startRequest()
        // Keep the existing silence deadline: rotating a request is not new speech.
    }

    private func scheduleSilence() {
        silenceWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.transcript.isEmpty else { return }
            self.finalize()
        }
        silenceWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.endOfSpeechSilence, execute: work)
    }

    /// One utterance is over: hand it to Listener and start a fresh request for the next one.
    private func finalize() {
        let text = transcript.text
        silenceWork?.cancel(); silenceWork = nil
        rolloverWork?.cancel(); rolloverWork = nil
        waitingCommit = false
        transcript.reset()
        if lock.withLock({ !muted }) { startRequest() } else { endRequest() }
        if !text.isEmpty { onEvent?(.committed(text)) }
    }
}
