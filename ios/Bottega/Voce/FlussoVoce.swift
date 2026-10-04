//
//  FlussoVoce.swift
//  Bottega per iPhone
//
//  La voce di Melissa mentre arriva: pezzi di PCM 16 bit a 24 kHz dal ponte (/v1/parla), messi in coda su un
//  AVAudioPlayerNode e suonati subito, senza aspettare la fine della risposta. Il suono in uscita passa da
//  AudioLevels (lo stesso del Nucleo) e la sfera si muove con la voce vera, bande comprese.
//
//  Il motore lo puo' fermare anche il sistema (Siri, una chiamata, le AirPods che arrivano o se ne vanno): si
//  guarda sempre `motore.isRunning`, mai un nostro flag, e a ogni fermata si torna in uno stato pulito. Suonare su
//  un motore fermo fa cadere l'app.
//

import AVFoundation

@MainActor
final class FlussoVoce {
    private let motore = AVAudioEngine()
    private let lettore = AVAudioPlayerNode()
    private let formato = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!
    private var inCoda = 0
    private var bytePCM = 0
    private var chiuso = false
    private var fine: CheckedContinuation<Void, Never>?
    /// Il giro di adesso: i buffer di un giro fermato che finiscono dopo non toccano il conto di quello nuovo.
    private var giro = 0
    private var osservatori: [NSObjectProtocol] = []
    private(set) var haSuonato = false
    /// Il sistema si e' preso l'audio (Siri, una chiamata): la voce si e' fermata e il giro va chiuso.
    var interrotta: (() -> Void)?

    init() {
        motore.attach(lettore)
        do {
            try motore.connectNode(lettore, to: motore.mainMixerNode, format: formato)
        } catch {
            Log.warn("voce: il lettore non si collega al mixer (\(error.localizedDescription)), riprovo al primo turno")
        }
        let centro = NotificationCenter.default
        // cambio di percorso (AirPods, altoparlante): il motore si e' fermato da solo. La notifica arriva dopo, sulla
        // coda principale: se nel frattempo prepara() l'ha gia' riacceso non c'e' niente da pulire.
        osservatori.append(centro.addObserver(forName: .AVAudioEngineConfigurationChange, object: motore, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.motore.isRunning else { return }
                Log.warn("voce iPhone: motore fermato da un cambio audio, PCM \(self.bytePCM) byte")
                self.fermatoDalSistema()
            }
        })
        osservatori.append(centro.addObserver(forName: AVAudioSession.interruptionNotification,
                                              object: AVAudioSession.sharedInstance(), queue: .main) { [weak self] n in
            // solo l'inizio (1, InterruptionType.began, deprecato in iOS 27 come tipo ma non come valore): alla fine
            // non c'e' niente da rifare, il prossimo turno riaccende il motore
            guard n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt == 1 else { return }
            MainActor.assumeIsolated {
                guard let self else { return }
                Log.warn("voce iPhone: sessione audio interrotta, PCM \(self.bytePCM) byte")
                self.fermatoDalSistema()
                self.interrotta?()
            }
        })
    }

    /// Prima del primo pezzo: sessione audio e motore pronti, cosi' il primo suono non aspetta.
    func prepara() throws {
        ferma()
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try s.setActive(true)
        chiuso = false
        haSuonato = false
        bytePCM = 0
        if !motore.isRunning {
            // da capo: dopo un cambio di percorso il formato dell'uscita puo' essere un altro
            motore.mainMixerNode.removeTap(onBus: 0)
            motore.disconnectNodeOutput(lettore)
            try motore.connectNode(lettore, to: motore.mainMixerNode, format: formato)
            try motore.mainMixerNode.installAudioTap(onBus: 0, bufferSize: 1024, format: nil) { pezzo, _ in
                let buf = AVAudioPCMBuffer(copying: pezzo)
                let livello = AudioLevels.rms(buf)
                AudioLevels.shared.set(.tts, level: livello, bands: AudioLevels.bands(buf, loudness: livello))
            }
            motore.prepare()
            try motore.start()
        }
        try lettore.playAudio()
        Log.info("voce iPhone: lettore pronto, motore \(motore.isRunning)")
    }

    /// Un pezzo di audio dal Mac (PCM 16 bit little endian, 24 kHz, mono). Con il motore fermo si scarta.
    func accoda(_ pcm16: Data) {
        let campioni = pcm16.count / 2
        guard motore.isRunning, campioni > 0,
              let buf = AVAudioPCMBuffer(pcmFormat: formato, frameCapacity: AVAudioFrameCount(campioni)) else { return }
        buf.frameLength = AVAudioFrameCount(campioni)
        let dst = buf.floatChannelData![0]
        pcm16.withUnsafeBytes { raw in
            // Data non garantisce l'allineamento di Int16: decodifica esplicita del PCM little endian.
            let src = raw.bindMemory(to: UInt8.self)
            for i in 0..<campioni {
                let sample = UInt16(src[i * 2]) | (UInt16(src[i * 2 + 1]) << 8)
                dst[i] = Float(Int16(bitPattern: sample)) / 32768
            }
        }
        inCoda += 1
        bytePCM += pcm16.count
        if !haSuonato { Log.info("voce iPhone: primo PCM in coda, \(pcm16.count) byte") }
        haSuonato = true
        let g = giro
        lettore.scheduleBuffer(buf, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in self?.suonato(g) }
        }
    }

    /// Non arriva altro: ritorna quando l'ultimo pezzo e' stato suonato (o subito, se non ce n'erano).
    func aspettaFine() async {
        chiuso = true
        Log.info("voce iPhone: attendo riproduzione, \(inCoda) buffer, PCM \(bytePCM) byte")
        if inCoda == 0 { return finisci() }
        await withCheckedContinuation { k in
            // chi aspettava prima non resta appeso
            let vecchia = fine
            fine = k
            vecchia?.resume()
        }
    }

    /// Interruzione: si tace subito.
    func ferma() {
        giro += 1
        lettore.stop()
        inCoda = 0
        finisci()
    }

    /// L'app va dietro o il giro e' finito: il motore si spegne (lo riaccende il prossimo turno).
    func spegni() {
        if motore.isRunning { Log.info("voce iPhone: spengo motore, PCM \(bytePCM) byte, in coda \(inCoda)") }
        ferma()
        motore.mainMixerNode.removeTap(onBus: 0)
        if motore.isRunning { motore.stop() }
    }

    private func fermatoDalSistema() {
        spegni()
    }

    private func suonato(_ g: Int) {
        guard g == giro else { return }
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
