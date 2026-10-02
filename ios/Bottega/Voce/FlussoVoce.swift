//
//  FlussoVoce.swift
//  Bottega per iPhone
//
//  La voce di Melissa mentre arriva: pezzi di PCM 16 bit a 24 kHz dal ponte (/v1/parla), messi in coda su un
//  AVAudioPlayerNode e suonati subito, senza aspettare la fine della risposta. Il suono in uscita passa da
//  AudioLevels (lo stesso del Nucleo) e la sfera si muove con la voce vera, bande comprese.
//

import AVFoundation

@MainActor
final class FlussoVoce {
    private let motore = AVAudioEngine()
    private let lettore = AVAudioPlayerNode()
    private let formato = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!
    private var inCoda = 0
    private var chiuso = false
    private var fine: CheckedContinuation<Void, Never>?
    private var acceso = false
    private(set) var haSuonato = false

    init() {
        motore.attach(lettore)
        motore.connect(lettore, to: motore.mainMixerNode, format: formato)
    }

    /// Prima del primo pezzo: sessione audio e motore pronti, cosi' il primo suono non aspetta.
    func prepara() throws {
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try s.setActive(true)
        inCoda = 0
        chiuso = false
        haSuonato = false
        if !acceso {
            motore.mainMixerNode.removeTap(onBus: 0)
            motore.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { buf, _ in
                let livello = AudioLevels.rms(buf)
                AudioLevels.shared.set(.tts, level: livello, bands: AudioLevels.bands(buf, loudness: livello))
            }
            try motore.start()
            acceso = true
        }
        lettore.play()
    }

    /// Un pezzo di audio dal Mac (PCM 16 bit little endian, 24 kHz, mono).
    func accoda(_ pcm16: Data) {
        let campioni = pcm16.count / 2
        guard campioni > 0, let buf = AVAudioPCMBuffer(pcmFormat: formato, frameCapacity: AVAudioFrameCount(campioni)) else { return }
        buf.frameLength = AVAudioFrameCount(campioni)
        let dst = buf.floatChannelData![0]
        pcm16.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: Int16.self)
            for i in 0..<campioni { dst[i] = Float(Int16(littleEndian: src[i])) / 32768 }
        }
        inCoda += 1
        haSuonato = true
        lettore.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in self?.suonato() }
        }
    }

    /// Non arriva altro: ritorna quando l'ultimo pezzo e' stato suonato (o subito, se non ce n'erano).
    func aspettaFine() async {
        chiuso = true
        if inCoda == 0 { return finisci() }
        await withCheckedContinuation { fine = $0 }
    }

    /// Interruzione: si tace subito.
    func ferma() {
        lettore.stop()
        inCoda = 0
        finisci()
    }

    /// L'app va dietro: il motore si spegne (lo riaccende il prossimo turno).
    func spegni() {
        ferma()
        if acceso {
            motore.mainMixerNode.removeTap(onBus: 0)
            motore.stop()
            acceso = false
        }
    }

    private func suonato() {
        inCoda = max(0, inCoda - 1)
        if chiuso && inCoda == 0 { finisci() }
    }

    private func finisci() {
        AudioLevels.shared.reset(.tts)
        let f = fine
        fine = nil
        f?.resume()
    }
}
