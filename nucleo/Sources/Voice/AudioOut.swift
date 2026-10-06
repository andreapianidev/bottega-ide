//
//  AudioOut.swift
//  Bottega Nucleo
//
//  One gapless output path for every voice engine: buffers are converted to a single
//  canonical format (Float32 mono 24 kHz, the ElevenLabs PCM rate) and scheduled back to
//  back on one AVAudioPlayerNode. Apple TTS buffers are converted on the way in.
//
//  The engine only runs while there is something to play, plus a short grace period:
//  a running AVAudioEngine keeps the output device open and costs CPU even when silent,
//  so after 6 s of silence it is stopped and the hardware released.
//
//  All AVAudioEngine work happens on one private serial queue, never on main: starting
//  the engine opens the audio HAL, which can stall for seconds after a device switch.
//
//  Streamed voice starts the moment its first piece arrives. If the pieces then come slower
//  than they play and the player runs dry in the middle of a sentence (the last thing heard
//  was audio, not an end marker), it pauses instead of stuttering piece by piece: it gathers
//  a reserve of audio, or waits a little longer than that reserve, or the end of the segment,
//  and goes on. The reserve adapts: 150 ms, doubled at each hole that comes within 3 s of the
//  last (a slow line), up to 1 s, and back to 150 ms after 10 s without holes. One longer
//  pause instead of many short ones; the first sentence never waits. Each hole is logged
//  ("voce: buco di N ms ... scorta M ms"), so the stutter can be measured, not guessed.
//

import Foundation
import AVFoundation
import os

final class AudioOut: @unchecked Sendable {
    static let shared = AudioOut()

    static let sampleRate: Double = 24_000
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: AudioOut.sampleRate,
                               channels: 1, interleaved: false)!

    private let q = DispatchQueue(label: "nucleo.audio-out", qos: .userInitiated)
    private var engine: AVAudioEngine?
    private var node: AVAudioPlayerNode?
    private var configObserver: NSObjectProtocol?
    private var pending = 0
    private var idleWork: DispatchWorkItem?
    /// Markers waiting for their audio to finish; fired (not dropped) on a device change
    /// so the caller never waits forever for a buffer that will not render.
    private var markers: [Int: @Sendable () -> Void] = [:]
    private var markerSeq = 0

    /// The player ran dry mid-sentence and is paused, gathering audio before it goes on.
    private var rebuffering = false
    private var heldFrames: AVAudioFrameCount = 0
    private var dryAt: DispatchTime?
    private var rebufferTimer: DispatchWorkItem?
    /// The buffer that finished last was audio (not a 1 ms marker).
    private var lastDoneWasAudio = false
    private static let rebufferMin: AVAudioFrameCount = 3600     // 150 ms at 24 kHz
    private static let rebufferMax: AVAudioFrameCount = 24_000   // 1 s
    /// A hole this soon after the last one means the line is slow: the reserve doubles.
    private static let holeStreak: TimeInterval = 3
    /// This long without holes and the reserve is back to its minimum.
    private static let holeCalm: TimeInterval = 10
    /// The reserve the next hole gathers before playing on.
    private var rebufferTarget: AVAudioFrameCount = AudioOut.rebufferMin
    private var lastHoleAt: DispatchTime?

    /// Bumped by `stop()`. Work stamped with an older generation is ignored.
    private let generationLock = OSAllocatedUnfairLock(initialState: 0)
    var generation: Int { generationLock.withLock { $0 } }

    /// Converters keyed by source format description (Apple TTS voices differ).
    private var converters: [String: AVAudioConverter] = [:]

    /// Conversation with hardware echo cancellation: the mic and the voice share ONE
    /// engine whose input runs Apple's voice processing (VPIO). The canceller can only
    /// remove what it hears itself play, so the voice must come out of this same engine.
    private var duplex = false
    /// Called (on the audio queue) when a device change kills the duplex engine.
    var onDuplexLost: (@Sendable () -> Void)?

    // MARK: - Public API (any thread)

    /// Signed 16-bit little-endian mono PCM at 24 kHz (ElevenLabs `pcm_24000`), converted on
    /// the caller's thread. `receivedAt` (the first piece of a segment) logs how long it took
    /// from the socket to the audio queue, when that is over 50 ms.
    func enqueuePCM16(_ data: Data, generation gen: Int, receivedAt: DispatchTime? = nil) {
        guard let buffer = Self.float32(fromPCM16: data, format: format) else { return }
        q.async {
            if let receivedAt, gen == self.generation {
                let ms = (DispatchTime.now().uptimeNanoseconds - receivedAt.uptimeNanoseconds) / 1_000_000
                if ms > 50 { Log.info("voce: primo audio del segmento in coda \(ms) ms dopo il socket") }
            }
            self.schedule(buffer, gen: gen, done: nil)
        }
    }

    /// Any PCM buffer (Apple TTS output); converted to the canonical format.
    func enqueue(_ buffer: AVAudioPCMBuffer, generation gen: Int) {
        q.async {
            guard let converted = self.convert(buffer) else { return }
            self.schedule(converted, gen: gen, done: nil)
        }
    }

    /// Calls `done` (on the audio queue) once everything scheduled before it has been
    /// heard. Implemented as 1 ms of silence with a played-back completion.
    func marker(generation gen: Int, _ done: @escaping @Sendable () -> Void) {
        q.async {
            guard let silence = AVAudioPCMBuffer(pcmFormat: self.format, frameCapacity: 24) else { done(); return }
            silence.frameLength = 24
            if let ch = silence.floatChannelData?[0] { ch.update(repeating: 0, count: 24) }
            self.schedule(silence, gen: gen, done: done)
        }
    }

    /// Barge-in: drops everything scheduled. Returns the new generation.
    /// INVARIANT: call it only after closing the ElevenLabs sockets (Speaker.stopSpeaking,
    /// today the only caller). Their receivers stamp each audio turn with the generation read
    /// at its first PCM: stopping first lets an old turn play under the new generation, or
    /// drops the rest of a turn and its end marker, and voice.state stays on speaking.
    @discardableResult
    func stop() -> Int {
        let gen = generationLock.withLock { g -> Int in g += 1; return g }
        q.async {
            self.markers.removeAll()
            self.pending = 0
            self.endRebuffer(log: false)
            self.lastDoneWasAudio = false
            self.node?.stop()
            AudioLevels.shared.reset(.tts)
            self.scheduleIdleStop()
        }
        return gen
    }

    var isBusy: Bool { q.sync { pending > 0 } }

    // MARK: - Internals (audio queue only)

    private func schedule(_ buffer: AVAudioPCMBuffer, gen: Int, done: (@Sendable () -> Void)?) {
        guard gen == generation else { return }
        guard ensureEngine(), let node else {
            done?()
            return
        }
        idleWork?.cancel()
        idleWork = nil
        pending += 1
        var markerID: Int?
        if let done {
            markerSeq += 1
            markerID = markerSeq
            markers[markerSeq] = done
        }
        let isMarker = done != nil
        node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            guard let self else { return }
            self.q.async {
                guard gen == self.generation else { return }
                self.pending = max(0, self.pending - 1)
                self.lastDoneWasAudio = !isMarker
                if let markerID, let cb = self.markers.removeValue(forKey: markerID) { cb() }
                if self.pending == 0 {
                    AudioLevels.shared.reset(.tts)
                    // dry after audio, not after an end marker: a hole mid-sentence
                    if self.lastDoneWasAudio, !self.rebuffering { self.beginRebuffer() }
                    self.scheduleIdleStop()
                }
            }
        }
        if rebuffering {
            if isMarker {
                // the segment ends (or the next one starts): nothing more to wait for
                endRebuffer(log: true)
            } else {
                heldFrames += buffer.frameLength
                if heldFrames >= rebufferTarget { endRebuffer(log: true) } else { armRebufferTimer() }
            }
            return
        }
        if !node.isPlaying {
            do { try node.playAudio() } catch {
                Log.warn("La voce non parte: \(error.localizedDescription)")
            }
        }
    }

    private func beginRebuffer() {
        let now = DispatchTime.now()
        if let last = lastHoleAt {
            let gap = Double(now.uptimeNanoseconds - last.uptimeNanoseconds) / 1e9
            if gap < Self.holeStreak {
                rebufferTarget = min(Self.rebufferMax, rebufferTarget * 2)
            } else if gap > Self.holeCalm {
                rebufferTarget = Self.rebufferMin
            }
        }
        lastHoleAt = now
        rebuffering = true
        heldFrames = 0
        dryAt = now
        node?.pause()
    }

    /// Plays again what was gathered; `log` writes how long the hole lasted.
    private func endRebuffer(log: Bool) {
        rebufferTimer?.cancel(); rebufferTimer = nil
        guard rebuffering else { return }
        rebuffering = false
        if log, let dryAt, heldFrames > 0 {
            let ms = (DispatchTime.now().uptimeNanoseconds - dryAt.uptimeNanoseconds) / 1_000_000
            Log.info("voce: buco di \(ms) ms a meta' frase, ripresa con \(heldFrames * 1000 / 24_000) ms pronti (scorta \(rebufferTarget * 1000 / 24_000) ms)")
        }
        heldFrames = 0
        dryAt = nil
        if let node, !node.isPlaying, pending > 0 {
            do { try node.playAudio() } catch {
                Log.warn("La voce non riparte: \(error.localizedDescription)")
            }
        }
    }

    /// A slow trickle does not keep her silent: a little longer than the reserve (250 ms for
    /// the 150 ms one, 1.6 s at most) and she goes on with what there is.
    private func armRebufferTimer() {
        guard rebufferTimer == nil else { return }
        let wait = min(1.6, Double(rebufferTarget) / 24_000 * 1.5 + 0.03)
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.rebuffering, self.heldFrames > 0 else { return }
            self.endRebuffer(log: true)
        }
        rebufferTimer = work
        q.asyncAfter(deadline: .now() + wait, execute: work)
    }

    private func ensureEngine() -> Bool {
        if let engine, engine.isRunning { return true }
        let e = engine ?? AVAudioEngine()
        let n = node ?? AVAudioPlayerNode()
        if engine == nil {
            e.attach(n)
            do { try e.connectNode(n, to: e.mainMixerNode, format: format) } catch {
                Log.error("La voce non riesce a collegare l'uscita audio: \(error.localizedDescription)")
                return false
            }
            engine = e
            node = n
            configObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: e, queue: nil
            ) { [weak self] _ in
                self?.q.async { self?.rebuildAfterConfigChange() }
            }
        }
        // Output level for the orb: the audio actually being rendered, not a guess.
        n.removeTap(onBus: 0)
        Self.installOutputMeter(on: n)
        e.prepare()
        do {
            try e.start()
            return true
        } catch {
            Log.error("La voce non riesce ad aprire l'uscita audio: \(error.localizedDescription)")
            n.removeTap(onBus: 0)
            return false
        }
    }

    /// Output level for the orb: the audio actually being rendered, not a guess.
    private static func installOutputMeter(on node: AVAudioPlayerNode) {
        do {
            try node.installAudioTap(onBus: 0, bufferSize: 1024, format: nil) { ro, _ in
                let buffer = AVAudioPCMBuffer(copying: ro)
                let level = min(1, AudioLevels.rms(buffer) * 0.55)
                AudioLevels.shared.set(.tts, level: level, bands: AudioLevels.bands(buffer, loudness: level))
            }
        } catch {
            Log.info("Misura del livello della voce non disponibile: \(error.localizedDescription)")
        }
    }

    private func scheduleIdleStop() {
        idleWork?.cancel()
        if duplex { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.pending == 0, let engine = self.engine else { return }
            // six seconds of nothing: whatever was waiting is not coming, start clean
            self.endRebuffer(log: false)
            self.lastDoneWasAudio = false
            self.node?.removeTap(onBus: 0)
            self.node?.stop()
            if engine.isRunning { engine.stop() }
        }
        idleWork = work
        q.asyncAfter(deadline: .now() + 6, execute: work)
    }

    private func rebuildAfterConfigChange() {
        let wasDuplex = duplex
        duplex = false
        engine?.inputNode.removeTap(onBus: 0)
        // AirPods connected mid-sentence: the graph no longer renders. Fire the markers
        // so the speaker's bookkeeping moves on, then rebuild lazily on the next buffer.
        let waiting = markers.values
        markers.removeAll()
        pending = 0
        endRebuffer(log: false)
        lastDoneWasAudio = false
        node?.removeTap(onBus: 0)
        node?.stop()
        if let engine, engine.isRunning { engine.stop() }
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        engine = nil
        node = nil
        converters.removeAll()
        AudioLevels.shared.reset(.tts)
        for cb in waiting { cb() }
        if wasDuplex { onDuplexLost?() }
    }

    // MARK: - Duplex (conversation with hardware echo cancellation)

    /// Rebuilds the engine with voice processing on the input and the voice player on its
    /// output. Returns true when it runs WITH echo cancellation; false means the caller
    /// must open a plain microphone and reject echo in software.
    func startDuplex(tap: @escaping @Sendable (AVAudioPCMBuffer) -> Void) async -> Bool {
        await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            q.async { cont.resume(returning: self.buildDuplex(tap: tap)) }
        }
    }

    func stopDuplex() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            q.async {
                if self.duplex {
                    self.duplex = false
                    self.teardownEngine()
                }
                cont.resume()
            }
        }
    }

    private func teardownEngine() {
        idleWork?.cancel()
        markers.removeAll()
        pending = 0
        node?.removeTap(onBus: 0)
        node?.stop()
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            if engine.isRunning { engine.stop() }
        }
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        engine = nil
        node = nil
        converters.removeAll()
        AudioLevels.shared.reset(.tts)
    }

    private func buildDuplex(tap: @escaping @Sendable (AVAudioPCMBuffer) -> Void) -> Bool {
        teardownEngine()
        let e = AVAudioEngine()
        let input = e.inputNode
        do {
            try input.setVoiceProcessingEnabled(true)
        } catch {
            Log.info("Cancellazione dell'eco hardware non disponibile (\(error.localizedDescription)): uso il filtro software.")
            return false
        }
        // Do not duck the user's music while Melissa talks.
        input.voiceProcessingOtherAudioDuckingConfiguration =
            AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
        let fmt = input.outputFormat(forBus: 0)
        // A 0 Hz / 0 channel format means "no microphone for you" (permission missing):
        // installTap would raise an Objective-C exception that Swift cannot catch.
        guard fmt.sampleRate > 0, fmt.channelCount > 0 else {
            try? input.setVoiceProcessingEnabled(false)
            return false
        }
        do {
            try input.installAudioTap(onBus: 0, bufferSize: 1024, format: fmt) { ro, _ in
                tap(AVAudioPCMBuffer(copying: ro))
            }
        } catch {
            Log.info("Il microfono con cancellazione dell'eco non si apre (\(error.localizedDescription)): uso il filtro software.")
            try? input.setVoiceProcessingEnabled(false)
            return false
        }
        let n = AVAudioPlayerNode()
        e.attach(n)
        do { try e.connectNode(n, to: e.mainMixerNode, format: format) } catch {
            input.removeTap(onBus: 0)
            try? input.setVoiceProcessingEnabled(false)
            return false
        }
        Self.installOutputMeter(on: n)
        e.prepare()
        do {
            try e.start()
        } catch {
            Log.info("Il motore audio con cancellazione dell'eco non parte (\(error.localizedDescription)): uso il filtro software.")
            input.removeTap(onBus: 0)
            n.removeTap(onBus: 0)
            try? input.setVoiceProcessingEnabled(false)
            return false
        }
        engine = e
        node = n
        duplex = true
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: e, queue: nil
        ) { [weak self] _ in
            self?.q.async { self?.rebuildAfterConfigChange() }
        }
        return true
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard buffer.frameLength > 0 else { return nil }
        let src = buffer.format
        if src.commonFormat == .pcmFormatFloat32, src.sampleRate == format.sampleRate,
           src.channelCount == 1, !src.isInterleaved { return buffer }
        let key = "\(src.commonFormat.rawValue)-\(src.sampleRate)-\(src.channelCount)-\(src.isInterleaved)"
        let converter: AVAudioConverter
        if let c = converters[key] {
            converter = c
        } else {
            guard let c = AVAudioConverter(from: src, to: format) else { return nil }
            converters[key] = c
            converter = c
        }
        let ratio = format.sampleRate / src.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var fed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if fed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        if status == .error {
            Log.warn("Conversione audio della voce fallita: \(error?.localizedDescription ?? "sconosciuto")")
            return nil
        }
        return out.frameLength > 0 ? out : nil
    }

    /// Int16 LE to Float32. Pure: an endianness slip here is white noise, not an error.
    static func float32(fromPCM16 pcm: Data, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let frames = pcm.count / 2
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = AVAudioFrameCount(frames)
        pcm.withUnsafeBytes { raw in
            for i in 0..<frames {
                let v = raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self)
                channel[i] = Float(Int16(littleEndian: v)) / 32_768
            }
        }
        return buffer
    }
}
