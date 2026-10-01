//
//  Recognizers.swift
//  Bottega Nucleo
//
//  On-device speech to text, two backends behind one small interface:
//   - SpeechAnalyzer + SpeechTranscriber (macOS 26+), used when the it-IT model is
//     installed (speech.prepare downloads it);
//   - SFSpeechRecognizer with requiresOnDeviceRecognition when the device supports it,
//     used otherwise.
//  `append` is called on the audio render thread; everything else on main.
//  `cut()` closes the current user turn and keeps listening (conversation, wake word);
//  `finish()` closes the last turn and stops.
//

import Foundation
import AVFoundation
import Speech
import CoreMedia
import os

@MainActor
protocol Recognizer: AnyObject {
    /// The text of the current turn so far (partial), on main.
    var onText: ((String) -> Void)? { get set }
    var backendName: String { get }
    nonisolated func append(_ buffer: AVAudioPCMBuffer)
    func cut() async -> String
    func finish() async -> String
    func cancel()
}

enum RecognizerFactory {
    static let defaultLocale = "it-IT"

    /// True when SpeechTranscriber can run fully on device for this locale right now.
    /// Note: `SpeechTranscriber.installedLocales` is NOT the right question: on macOS 27.2
    /// it lists it-IT while AssetInventory still reports the transcriber model as only
    /// `supported` (not downloaded). The module status is what counts.
    static func analyzerReady(_ identifier: String) async -> Bool {
        guard SpeechTranscriber.isAvailable else { return false }
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier)) else { return false }
        let probe = SpeechTranscriber(locale: supported, transcriptionOptions: [],
                                      reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
        return await AssetInventory.status(forModules: [probe]) == .installed
    }

    @MainActor
    static func make(locale identifier: String) async throws -> Recognizer {
        if await analyzerReady(identifier) {
            do {
                return try await AnalyzerRecognizer.make(locale: identifier)
            } catch {
                Log.warn("SpeechAnalyzer non parte (\(error.localizedDescription)), uso SFSpeechRecognizer.")
            }
        }
        return try await SFRecognizer.make(locale: identifier)
    }
}

// MARK: - SpeechAnalyzer

@MainActor
final class AnalyzerRecognizer: Recognizer, @unchecked Sendable {
    var onText: ((String) -> Void)?
    let backendName = "SpeechAnalyzer"

    private let transcriber: SpeechTranscriber
    private let analyzer: SpeechAnalyzer
    nonisolated(unsafe) private let converter: AnalyzerInputConverter
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private var resultsTask: Task<Void, Never>?

    private var finalText = ""
    private var volatileText = ""
    /// Results that end at or before this audio time belong to a turn already closed.
    private var cutoff = CMTime.zero
    private var lastEnd = CMTime.zero
    private var finished = false

    private init(transcriber: SpeechTranscriber, analyzer: SpeechAnalyzer,
                 converter: AnalyzerInputConverter, continuation: AsyncStream<AnalyzerInput>.Continuation) {
        self.transcriber = transcriber
        self.analyzer = analyzer
        self.converter = converter
        self.continuation = continuation
    }

    static func make(locale identifier: String) async throws -> AnalyzerRecognizer {
        let wanted = Locale(identifier: identifier)
        let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) ?? wanted
        let transcriber = SpeechTranscriber(locale: locale,
                                            transcriptionOptions: [],
                                            reportingOptions: [.volatileResults, .fastResults],
                                            attributeOptions: [])
        let converter = try await AnalyzerInputConverter.converter(compatibleWith: [transcriber])
        let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self, bufferingPolicy: .unbounded)
        // `lingering` keeps the model warm for a while after the turn: push-to-talk used
        // again a few seconds later does not pay the load.
        let analyzer = SpeechAnalyzer(modules: [transcriber],
                                      options: .init(priority: .userInitiated, modelRetention: .lingering))
        let r = AnalyzerRecognizer(transcriber: transcriber, analyzer: analyzer,
                                   converter: converter, continuation: continuation)
        try await analyzer.start(inputSequence: stream)
        r.startResults()
        return r
    }

    private func startResults() {
        let results = transcriber.results
        resultsTask = Task { @MainActor [weak self] in
            do {
                for try await result in results {
                    guard let self else { return }
                    self.consume(result)
                }
            } catch {
                if !(error is CancellationError) {
                    Log.info("SpeechAnalyzer: risultati interrotti (\(error.localizedDescription))")
                }
            }
        }
    }

    private func consume(_ r: SpeechTranscriber.Result) {
        let end = r.range.end
        if CMTimeCompare(end, cutoff) <= 0, CMTimeCompare(cutoff, .zero) > 0 { return }
        if CMTimeCompare(end, lastEnd) > 0 { lastEnd = end }
        let text = String(r.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        if r.isFinal {
            if !text.isEmpty { finalText += finalText.isEmpty ? text : " " + text }
            volatileText = ""
        } else {
            volatileText = text
        }
        onText?(current)
    }

    private var current: String {
        [finalText, volatileText].filter { !$0.isEmpty }.joined(separator: " ")
    }

    nonisolated func append(_ buffer: AVAudioPCMBuffer) {
        guard let inputs = try? converter.convert(buffer, at: nil) else { return }
        for input in inputs { continuation.yield(input) }
    }

    func cut() async -> String {
        // Ask for the volatile tail to be finalized, but never wait long: the user is
        // waiting for an answer.
        let analyzer = self.analyzer
        _ = await withTimeout(0.35) { try? await analyzer.finalize(through: nil) }
        await Task.yield()
        let text = current
        cutoff = lastEnd
        finalText = ""
        volatileText = ""
        return text
    }

    func finish() async -> String {
        guard !finished else { return current }
        finished = true
        if let tail = try? converter.flush() { for input in tail { continuation.yield(input) } }
        continuation.finish()
        let analyzer = self.analyzer
        _ = await withTimeout(1.5) { try? await analyzer.finalizeAndFinishThroughEndOfInput() }
        if let task = resultsTask {
            _ = await withTimeout(0.5) { await task.value }
        }
        resultsTask?.cancel()
        return current
    }

    func cancel() {
        guard !finished else { return }
        finished = true
        continuation.finish()
        resultsTask?.cancel()
        let analyzer = self.analyzer
        Task.detached { await analyzer.cancelAndFinishNow() }
    }
}

// MARK: - SFSpeechRecognizer

@MainActor
final class SFRecognizer: NSObject, Recognizer, @unchecked Sendable {
    var onText: ((String) -> Void)?
    let backendName = "SFSpeechRecognizer"

    private let recognizer: SFSpeechRecognizer
    private let requestBox = OSAllocatedUnfairLock<SFSpeechAudioBufferRecognitionRequest?>(uncheckedState: nil)
    private var task: SFSpeechRecognitionTask?
    private var text = ""
    private var isFinal = false
    private var active = true
    private var taskStarted = Date()
    private var restartTimer: Timer?

    private init(recognizer: SFSpeechRecognizer) {
        self.recognizer = recognizer
        super.init()
    }

    static func make(locale identifier: String) async throws -> SFRecognizer {
        try await ensureAuthorized()
        guard let r = SFSpeechRecognizer(locale: Locale(identifier: identifier)), r.isAvailable else {
            throw NucleoError("Il riconoscimento vocale per \(identifier) non e' disponibile su questo Mac in questo momento.")
        }
        let s = SFRecognizer(recognizer: r)
        s.begin()
        // SFSpeech tasks end after about a minute: in continuous modes, restart quietly
        // whenever a task has been silent and old.
        let timer = Timer(timeInterval: 20, repeats: true) { [weak s] _ in
            MainActor.assumeIsolated {
                guard let s, s.active, s.text.isEmpty, Date().timeIntervalSince(s.taskStarted) > 45 else { return }
                s.begin()
            }
        }
        timer.tolerance = 5
        RunLoop.main.add(timer, forMode: .common)
        s.restartTimer = timer
        return s
    }

    static func ensureAuthorized() async throws {
        var status = SFSpeechRecognizer.authorizationStatus()
        if status == .notDetermined {
            status = await withCheckedContinuation { cont in
                SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0) }
            }
        }
        guard status == .authorized else {
            throw NucleoError("Il riconoscimento vocale non e' autorizzato: abilitalo in Impostazioni di Sistema, Privacy e sicurezza, Riconoscimento vocale.")
        }
    }

    private func begin() {
        task?.cancel()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        requestBox.withLockUnchecked { $0 = request }
        text = ""
        isFinal = false
        taskStarted = Date()
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let best = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            let failed = error != nil
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, self.requestBox.withLockUnchecked({ $0 === request }) else { return }
                    if let best {
                        self.text = best
                        self.onText?(best)
                    }
                    if final || failed {
                        self.isFinal = true
                        // "No speech detected" and friends end the task: a continuous
                        // listener simply opens a new one.
                        if failed, !final, self.active, self.text.isEmpty { self.begin() }
                    }
                }
            }
        }
    }

    nonisolated func append(_ buffer: AVAudioPCMBuffer) {
        requestBox.withLockUnchecked { $0?.append(buffer) }
    }

    private func endAndWait() async -> String {
        requestBox.withLockUnchecked { $0?.endAudio() }
        let deadline = Date().addingTimeInterval(0.8)
        while !isFinal, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(40))
        }
        return text
    }

    func cut() async -> String {
        let t = await endAndWait()
        if active { begin() }
        return t
    }

    func finish() async -> String {
        guard active else { return text }
        let t = await endAndWait()
        stopAll()
        return t
    }

    func cancel() {
        guard active else { return }
        stopAll()
    }

    private func stopAll() {
        active = false
        restartTimer?.invalidate()
        restartTimer = nil
        task?.cancel()
        task = nil
        requestBox.withLockUnchecked { $0 = nil }
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
