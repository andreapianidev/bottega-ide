//
//  SpeechFile.swift
//  Bottega Nucleo
//
//  `--cli tts`: renders a sentence to a WAV file instead of the speakers. It proves the
//  whole voice path (key, socket protocol, PCM decoding, Apple fallback) without making
//  a sound.
//

import Foundation
import AVFoundation

enum SpeechFile {
    static func render(text: String, to url: URL, engine: String?, via: String?, model: String? = nil) async throws -> [String: Any?] {
        guard !text.isEmpty else { throw NucleoError("Il testo da pronunciare e' vuoto.") }
        let wantApple = engine == "apple" || (engine == nil && !ElevenLabsConfig.isConfigured)
        let started = Date()
        if wantApple {
            let pcm = try await apple(text)
            try writeWAV(pcm16: pcm, sampleRate: 24_000, to: url)
            return ["engine": "apple", "voice": Speaker.appleVoice()?.identifier, "bytes": pcm.count,
                    "seconds": Double(pcm.count / 2) / 24_000, "path": url.path]
        }
        guard ElevenLabsConfig.isConfigured else { throw ElevenLabsError.notConfigured }
        let m = model ?? ElevenLabsConfig.realtimeModel
        let pcm: Data
        var firstAudioMs: Int?
        if via == "rest" {
            pcm = try await ElevenLabsREST.synthesize(text, model: m)
        } else {
            (pcm, firstAudioMs) = try await socket(text, model: m)
        }
        try writeWAV(pcm16: pcm, sampleRate: 24_000, to: url)
        return ["engine": "elevenlabs", "via": via == "rest" ? "rest" : "ws", "model": m,
                "voice": ElevenLabsConfig.voiceID, "bytes": pcm.count,
                "seconds": Double(pcm.count / 2) / 24_000,
                "firstAudioMs": firstAudioMs, "totalMs": Int(Date().timeIntervalSince(started) * 1000),
                "path": url.path, "charsThisMonth": ElevenLabsUsage.charsThisMonth]
    }

    @MainActor
    private static func socket(_ text: String, model: String) async throws -> (Data, Int?) {
        guard let stream = ElevenLabsStream(model: model) else { throw ElevenLabsError.notConfigured }
        return try await withCheckedThrowingContinuation { cont in
            var audio = Data()
            var done = false
            var sentAt = Date()
            var first: Int?
            @MainActor func finish(_ result: Result<(Data, Int?), Error>) {
                guard !done else { return }
                done = true
                stream.close()
                cont.resume(with: result)
            }
            stream.onEvent = { event in
                switch event {
                case .audio(let pcm):
                    if first == nil { first = Int(Date().timeIntervalSince(sentAt) * 1000) }
                    audio.append(pcm)
                case .turnFinished:
                    finish(audio.isEmpty ? .failure(ElevenLabsError.empty) : .success((audio, first)))
                case .failed(let e):
                    finish(.failure(e))
                }
            }
            stream.connect()
            sentAt = Date()
            stream.send(text: text, newTurn: false)
            ElevenLabsUsage.add(text.count)
            stream.flush()
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
                MainActor.assumeIsolated { finish(.failure(ElevenLabsError.disconnected("nessuna risposta in 20 secondi"))) }
            }
        }
    }

    @MainActor
    private static func apple(_ text: String) async throws -> Data {
        let synth = AVSpeechSynthesizer()
        let utterance = AVSpeechUtterance(string: SpokenText.strippingAudioTags(text))
        utterance.voice = Speaker.appleVoice()
        let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true)!
        return try await withCheckedThrowingContinuation { cont in
            var out = Data()
            var converter: AVAudioConverter?
            var done = false
            synth.write(utterance) { buffer in
                guard !done, let pcm = buffer as? AVAudioPCMBuffer else { return }
                if pcm.frameLength == 0 {
                    done = true
                    _ = synth   // keep the synthesizer alive until the end
                    cont.resume(returning: out)
                    return
                }
                if converter == nil { converter = AVAudioConverter(from: pcm.format, to: target) }
                guard let converter,
                      let dst = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(Double(pcm.frameLength) * 24_000 / pcm.format.sampleRate + 64))
                else { return }
                var fed = false
                _ = converter.convert(to: dst, error: nil) { _, status in
                    if fed { status.pointee = .noDataNow; return nil }
                    fed = true
                    status.pointee = .haveData
                    return pcm
                }
                if let p = dst.int16ChannelData?[0] {
                    out.append(UnsafeBufferPointer(start: p, count: Int(dst.frameLength)))
                }
            }
        }
    }

    static func writeWAV(pcm16: Data, sampleRate: Int, to url: URL) throws {
        var header = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; header.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; header.append(Data(bytes: &x, count: 2)) }
        header.append("RIFF".data(using: .ascii)!)
        u32(UInt32(36 + pcm16.count))
        header.append("WAVEfmt ".data(using: .ascii)!)
        u32(16); u16(1); u16(1)
        u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        header.append("data".data(using: .ascii)!)
        u32(UInt32(pcm16.count))
        try (header + pcm16).write(to: url, options: .atomic)
    }
}

/// `--cli stt-file <wav> [--commit manual|vad]`: streams a WAV through ScribeClient in
/// real time (100 ms buffers) and reports every server event with its timing. The test
/// path for STT: no microphone involved.
@MainActor
enum SttFile {
    static func run(path: String, commit: String) async throws -> [String: Any?] {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        let fmt = file.processingFormat
        let client = ScribeClient(language: "it")
        var events: [[String: Any?]] = []
        var config: [String: Any] = [:]
        var audioEnd: CFTimeInterval?
        let t0 = CACurrentMediaTime()
        var committed = false
        func ms() -> Int { Int(((CACurrentMediaTime() - (audioEnd ?? t0))) * 1000) }
        client.onEvent = { event in
            switch event {
            case .started(let c): config = c; events.append(["type": "session_started", "ms": ms()])
            case .partial(let t): events.append(["type": "partial", "text": t, "msAfterAudio": audioEnd == nil ? nil : ms()])
            case .committed(let t): committed = true; events.append(["type": "committed", "text": t, "msAfterAudio": audioEnd == nil ? nil : ms()])
            case .failed(let m): events.append(["type": "error", "message": m])
            }
        }
        try client.connect()
        guard await client.waitReady() else {
            client.close()
            throw NucleoError("La sessione di trascrizione ElevenLabs non si apre.")
        }
        let frames = AVAudioFrameCount(fmt.sampleRate / 10)
        while file.framePosition < file.length {
            guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) else { break }
            try file.read(into: buf, frameCount: frames)
            if buf.frameLength == 0 { break }
            client.append(buf, level: AudioLevels.rms(buf))
            try await Task.sleep(for: .milliseconds(100))
        }
        audioEnd = CACurrentMediaTime()
        if commit == "manual" {
            client.commit()
        } else {
            // VAD needs to hear the silence: 1.5 s of zeros, in real time.
            for _ in 0..<15 {
                if let z = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) {
                    z.frameLength = frames
                    if let ch = z.floatChannelData?[0] { ch.update(repeating: 0, count: Int(frames)) }
                    client.append(z, level: 0)
                }
                try await Task.sleep(for: .milliseconds(100))
                if committed { break }
            }
        }
        let deadline = CACurrentMediaTime() + 4
        while !committed, CACurrentMediaTime() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        try await Task.sleep(for: .milliseconds(300))
        client.close()
        let cfg = config.filter { ["sample_rate", "audio_format", "language_code", "commit_strategy", "vad_silence_threshold_secs", "vad_threshold", "model_id"].contains($0.key) }
        return ["commit": commit, "config": cfg, "audioSeconds": Double(file.length) / fmt.sampleRate,
                "secondsSent": (client.secondsSent * 100).rounded() / 100, "events": events]
    }
}
