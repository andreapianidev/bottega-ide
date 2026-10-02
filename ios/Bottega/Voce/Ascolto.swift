//
//  Ascolto.swift
//  Bottega per iPhone
//
//  Come Melissa ascolta sul Mac (nucleo/Sources/Voice/AppleSTT.swift, a sua volta preso da Avo): SFSpeechRecognizer
//  it-IT con il microfono, testo in diretta, frase chiusa dopo 1,8 s senza parole nuove o quando il
//  riconoscimento dice che e' finita. Il livello del microfono va alla sfera (AudioLevels, lo stesso del Nucleo).
//

import AVFoundation
import Speech

@MainActor
final class Ascolto {
    static let silenzioFineFrase: TimeInterval = 1.8

    private let riconoscitore = SFSpeechRecognizer(locale: Locale(identifier: "it-IT"))
    private let motore = AVAudioEngine()
    private var richiesta: SFSpeechAudioBufferRecognitionRequest?
    private var compito: SFSpeechRecognitionTask?
    private var silenzio: Task<Void, Never>?
    private var ultimo = ""
    private var chiusa = false
    private var fine: ((String) -> Void)?

    var parziale: ((String) -> Void)?

    /// Microfono e riconoscimento vocale: chiede i permessi la prima volta.
    static func permessi() async -> String? {
        let parlato: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { k in
            SFSpeechRecognizer.requestAuthorization { k.resume(returning: $0) }
        }
        guard parlato == .authorized else {
            return "Il riconoscimento vocale non è autorizzato: accendilo in Impostazioni, Bottega."
        }
        let mic = await AVAudioApplication.requestRecordPermission()
        return mic ? nil : "Il microfono non è autorizzato: accendilo in Impostazioni, Bottega."
    }

    /// Ascolta una frase; `fine` arriva una volta sola, con il testo (vuoto se non hai detto niente).
    func ascolta(fine: @escaping (String) -> Void) throws {
        ferma()
        guard let riconoscitore, riconoscitore.isAvailable else {
            throw ErrorePonte(messaggio: "Il riconoscimento vocale italiano non è disponibile adesso.")
        }
        let sessione = AVAudioSession.sharedInstance()
        try sessione.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try sessione.setActive(true, options: .notifyOthersOnDeactivation)

        let r = SFSpeechAudioBufferRecognitionRequest()
        r.shouldReportPartialResults = true
        r.addsPunctuation = true
        r.taskHint = .dictation
        richiesta = r
        ultimo = ""
        chiusa = false
        self.fine = fine

        let ingresso = motore.inputNode
        let formato = ingresso.outputFormat(forBus: 0)
        ingresso.removeTap(onBus: 0)
        ingresso.installTap(onBus: 0, bufferSize: 1024, format: formato) { [weak r] buf, _ in
            r?.append(buf)
            let livello = AudioLevels.rms(buf)
            AudioLevels.shared.set(.mic, level: livello, bands: AudioLevels.bands(buf, loudness: livello))
        }
        motore.prepare()
        try motore.start()

        compito = riconoscitore.recognitionTask(with: r) { [weak self] esito, errore in
            let testo = esito?.bestTranscription.formattedString
            let finale = esito?.isFinal ?? false
            Task { @MainActor in
                guard let self else { return }
                if let testo, testo != self.ultimo {
                    self.ultimo = testo
                    self.parziale?(testo)
                    self.armaSilenzio()
                }
                if finale || (errore != nil && esito == nil) { self.chiudi() }
            }
        }
        // se non dici niente per otto secondi la frase si chiude vuota
        silenzio = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            if !Task.isCancelled { self?.chiudi() }
        }
    }

    /// Chiude la frase adesso (un tocco sulla sfera mentre ascolta).
    func chiudi() {
        guard !chiusa else { return }
        chiusa = true
        let testo = ultimo.trimmingCharacters(in: .whitespacesAndNewlines)
        ferma()
        let f = fine
        fine = nil
        f?(testo)
    }

    func ferma() {
        silenzio?.cancel()
        silenzio = nil
        if motore.isRunning {
            motore.stop()
            motore.inputNode.removeTap(onBus: 0)
        }
        richiesta?.endAudio()
        compito?.cancel()
        richiesta = nil
        compito = nil
        AudioLevels.shared.reset(.mic)
    }

    private func armaSilenzio() {
        silenzio?.cancel()
        silenzio = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.silenzioFineFrase * 1_000_000_000))
            if !Task.isCancelled { self?.chiudi() }
        }
    }
}
