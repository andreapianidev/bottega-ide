//
//  AudioLevels.swift
//  Bottega Nucleo
//
//  The one place where live audio energy lives. Written from audio render threads (mic
//  tap, TTS output tap), read by the orb renderer once per frame and forwarded to the
//  extension as `voice.level` at most 15 times a second. A tiny unfair lock, no hops to
//  the main thread: the orb keeps breathing even when main is busy.
//

import Foundation
import os
import Accelerate
import AVFoundation

final class AudioLevels: @unchecked Sendable {
    static let shared = AudioLevels()
    static let bandCount = 16

    enum Source: String { case mic, tts }

    private struct State {
        var mic: Float = 0
        var tts: Float = 0
        var micBands = [Float](repeating: 0, count: AudioLevels.bandCount)
        var ttsBands = [Float](repeating: 0, count: AudioLevels.bandCount)
        var lastEmit: [Source: CFTimeInterval] = [:]
        var lastValue: [Source: Float] = [:]
    }

    private let lock = OSAllocatedUnfairLock(initialState: State())

    func set(_ source: Source, level: Float, bands: [Float]?) {
        let now = CACurrentMediaTime()
        let shouldEmit: Bool = lock.withLock { s in
            switch source {
            case .mic:
                s.mic = level
                if let bands { s.micBands = bands }
            case .tts:
                s.tts = level
                if let bands { s.ttsBands = bands }
            }
            let last = s.lastEmit[source] ?? 0
            let previous = s.lastValue[source] ?? 0
            // Silence that stays silence is not news: no event while both are near zero.
            if level < 0.02, previous < 0.02 { return false }
            // 15 per second at most; a drop to 0 always goes out so the UI can settle.
            if now - last >= 1.0 / 15.0 || level == 0 {
                s.lastEmit[source] = now
                s.lastValue[source] = level
                return true
            }
            return false
        }
        if shouldEmit {
            Out.event("voice.level", ["level": (level * 1000).rounded() / 1000, "source": source.rawValue])
        }
    }

    func reset(_ source: Source) {
        set(source, level: 0, bands: [Float](repeating: 0, count: Self.bandCount))
    }

    /// What the orb should react to. Listening reads the mic, speaking reads the voice
    /// output; any other state takes whichever is louder (so the orb still moves if the
    /// extension forgets to switch state).
    func snapshot(forOrbState state: Int32) -> (level: Float, bands: [Float]) {
        lock.withLock { s in
            switch state {
            case 1: return (s.mic, s.micBands)
            case 3: return (s.tts, s.ttsBands)
            default: return s.mic >= s.tts ? (s.mic, s.micBands) : (s.tts, s.ttsBands)
            }
        }
    }

    // MARK: - Metering helpers (pure, callable from any thread)

    /// RMS mapped so ordinary speech (~0.0 to 0.2) fills 0...1.
    static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let ch = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var ms: Float = 0
        vDSP_measqv(ch, 1, &ms, vDSP_Length(buffer.frameLength))
        return min(1, ms.squareRoot() * 6)
    }

    // 16 log-spaced bands from a 1024-point FFT (ported from Melissa's VoiceSpectrum).
    private static let log2n: vDSP_Length = 10
    private static let n = 1 << 10
    private static let half = (1 << 10) / 2
    nonisolated(unsafe) private static let setup: FFTSetup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
    private static let window: [Float] = {
        var w = [Float](repeating: 0, count: n)
        vDSP_hann_window(&w, vDSP_Length(n), Int32(vDSP_HANN_NORM))
        return w
    }()

    static func bands(_ buffer: AVAudioPCMBuffer, loudness: Float) -> [Float] {
        let zero = [Float](repeating: 0, count: bandCount)
        guard loudness > 0.001, let channel = buffer.floatChannelData?[0] else { return zero }
        let avail = Int(buffer.frameLength)
        guard avail > 0 else { return zero }
        var samples = [Float](repeating: 0, count: n)
        let m = min(avail, n)
        samples.withUnsafeMutableBufferPointer { sp in
            sp.baseAddress!.update(from: channel, count: m)
            window.withUnsafeBufferPointer { wp in
                vDSP_vmul(sp.baseAddress!, 1, wp.baseAddress!, 1, sp.baseAddress!, 1, vDSP_Length(n))
            }
        }
        var realp = [Float](repeating: 0, count: half)
        var imagp = [Float](repeating: 0, count: half)
        var mags = [Float](repeating: 0, count: half)
        realp.withUnsafeMutableBufferPointer { rp in
            imagp.withUnsafeMutableBufferPointer { ip in
                var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                samples.withUnsafeBufferPointer { sp in
                    sp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) { cp in
                        vDSP_ctoz(cp, 2, &split, 1, vDSP_Length(half))
                    }
                }
                vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                vDSP_zvabs(&split, 1, &mags, 1, vDSP_Length(half))
            }
        }
        var raw = [Float](repeating: 0, count: bandCount)
        let minBin: Float = 1, maxBin = Float(half - 1)
        func bin(_ b: Int) -> Int {
            let t = Float(b) / Float(bandCount)
            return min(half - 1, max(1, Int((minBin * powf(maxBin / minBin, t)).rounded())))
        }
        for b in 0..<bandCount {
            let lo = bin(b)
            let hi = min(half, max(lo + 1, bin(b + 1)))
            var sum: Float = 0
            for k in lo..<hi { sum += mags[k] }
            raw[b] = sum / Float(max(1, hi - lo))
        }
        let peak = max(raw.max() ?? 0, 1e-6)
        return raw.map { ($0 / peak) * loudness }
    }
}
