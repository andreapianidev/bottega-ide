//
//  Parlato.swift
//  Bottega per iPhone
//
//  La voce di Melissa sull'iPhone. Il Mac la sintetizza con ElevenLabs (la chiave resta li') e la manda come
//  WAV dal ponte; qui si suona, e il suo livello muove la sfera. Se il Mac non riesce, parla la voce
//  italiana di iOS.
//

import AVFoundation

@MainActor
final class Parlato: NSObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    private var lettore: AVAudioPlayer?
    private let sintesi = AVSpeechSynthesizer()
    private var misura: Timer?
    private var fine: CheckedContinuation<Void, Never>?

    override init() {
        super.init()
        sintesi.delegate = self
    }

    var parla: Bool { lettore?.isPlaying == true || sintesi.isSpeaking }

    /// Suona il WAV e ritorna quando ha finito (o quando viene fermato).
    func suona(_ wav: Data) async {
        ferma()
        prepara()
        guard let p = try? AVAudioPlayer(data: wav) else { return }
        p.delegate = self
        p.isMeteringEnabled = true
        lettore = p
        p.play()
        misura = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.misuraLivello() }
        }
        await withCheckedContinuation { fine = $0 }
    }

    /// La voce di iOS, quando la voce del Mac non arriva.
    func dici(_ testo: String) async {
        ferma()
        prepara()
        let u = AVSpeechUtterance(string: testo)
        u.voice = AVSpeechSynthesisVoice(language: "it-IT")
        u.rate = AVSpeechUtteranceDefaultSpeechRate * 1.05
        sintesi.speak(u)
        AudioLevels.shared.set(.tts, level: 0.35, bands: nil)
        await withCheckedContinuation { fine = $0 }
    }

    func ferma() {
        lettore?.stop()
        lettore = nil
        if sintesi.isSpeaking { sintesi.stopSpeaking(at: .immediate) }
        concludi()
    }

    private func prepara() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try? s.setActive(true)
    }

    private func misuraLivello() {
        guard let p = lettore, p.isPlaying else { return }
        p.updateMeters()
        let db = p.averagePower(forChannel: 0)
        let livello = max(0, min(1, (db + 50) / 40))
        // niente FFT del suono in uscita: bande finte, piu' forti sui bassi, che seguono il livello
        let bande = (0..<AudioLevels.bandCount).map { i in livello * (1 - Float(i) / Float(AudioLevels.bandCount) * 0.6) }
        AudioLevels.shared.set(.tts, level: livello, bands: bande)
    }

    private func concludi() {
        misura?.invalidate()
        misura = nil
        AudioLevels.shared.reset(.tts)
        let f = fine
        fine = nil
        f?.resume()
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.lettore = nil
            self.concludi()
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.concludi() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.concludi() }
    }
}
