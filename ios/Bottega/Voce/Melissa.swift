//
//  Melissa.swift
//  Bottega per iPhone
//
//  Il giro della conversazione sull'iPhone, come sul Mac: tocchi la sfera, parli, la frase va al Mac, Melissa
//  pensa con il suo cervello e i suoi strumenti, la risposta torna con la sua voce. In conversazione si
//  rimette in ascolto da sola; "basta" o un tocco mentre ascolta senza parole la chiudono. Toccarla mentre
//  parla la interrompe, come sul Mac.
//

import AVFoundation
import Foundation
import Observation

@MainActor
@Observable
final class Melissa {
    private(set) var sfera: StatoSfera = .riposo
    private(set) var parziale = ""
    private(set) var conversazione = false
    var avviso: String?
    var voceAccesa: Bool = UserDefaults.standard.object(forKey: "voce") as? Bool ?? true {
        didSet { UserDefaults.standard.set(voceAccesa, forKey: "voce") }
    }

    private let ponte: Ponte
    private let ascolto = Ascolto()
    private let parlato = Parlato()
    private let flusso = FlussoVoce()
    private var turno: Task<Void, Never>?
    /// La risposta a voce in arrivo dal Mac: cancellarla chiude la connessione e il Mac smette di rispondere.
    private var rete: Task<Void, Error>?
    /// Il giro di adesso: ogni tocco, domanda scritta o chiusura ne apre uno nuovo. Un giro vecchio che si
    /// risveglia dopo (i permessi, il riascolto automatico, un ascolto fermato) non tocca piu' niente.
    private var giro = 0

    private static let paroleFine = try! NSRegularExpression(pattern: "\\b(basta|a dopo|chiudi|ci sentiamo|stop|a pi[uù] tardi)\\b", options: .caseInsensitive)

    init(ponte: Ponte) {
        self.ponte = ponte
        ascolto.parziale = { [weak self] t in self?.parziale = t }
        // Siri o una chiamata si prendono l'audio: la conversazione si chiude, non si riascolta durante la chiamata
        flusso.interrotta = { [weak self] in self?.chiudiConversazione() }
    }

    /// Mentre pensa o parla non si scrive: il giro dopo parte quando questo e' finito.
    var occupata: Bool { sfera == .pensa || sfera == .parla }

    /// Il tocco sulla sfera.
    func tocca() {
        switch sfera {
        case .ascolta:
            ascolto.chiudi()
        case .parla:
            // interruzione: si tace, il Mac smette di rispondere, e in conversazione si torna ad ascoltare
            rete?.cancel()
            flusso.ferma()
            parlato.ferma()
        case .pensa:
            break
        case .riposo, .errore:
            conversazione = true
            giro += 1
            let g = giro
            // lo stato subito, prima dei permessi: un secondo tocco o un link ascolta=1 non aprono un altro ascolto
            parziale = ""
            sfera = .ascolta
            Task { await ascoltaFrase(g) }
        }
    }

    func chiudiConversazione() {
        giro += 1
        conversazione = false
        ascolto.ferma()
        rete?.cancel()
        flusso.ferma()
        parlato.ferma()
        if sfera != .pensa { sfera = .riposo }
        parziale = ""
        // con una domanda ancora in corso l'audio lo lascia chi la chiude (chiedi)
        if sfera == .riposo { liberaAudio() }
    }

    /// Una domanda scritta: stesso giro, senza microfono dopo.
    func scrivi(_ testo: String) {
        let t = testo.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !occupata else { return }
        giro += 1
        let g = giro
        conversazione = false
        ascolto.ferma()
        parlato.ferma()
        turno = Task { await chiedi(t, giro: g) }
    }

    /// L'app va dietro: niente microfono acceso di nascosto, e la sessione audio torna alle altre app.
    func sospendi() {
        chiudiConversazione()
        // con una domanda ancora in corso chiudiConversazione l'audio non lo lascia: dietro si lascia comunque
        if sfera == .pensa { liberaAudio() }
    }

    // MARK: - il giro

    private func ascoltaFrase(_ g: Int) async {
        parziale = ""
        sfera = .ascolta
        let problema = await Ascolto.permessi()
        guard g == giro else { return }
        if let problema {
            avviso = problema
            conversazione = false
            sfera = .errore
            return
        }
        do {
            let testo: String = try await withCheckedThrowingContinuation { k in
                do {
                    try ascolto.ascolta { k.resume(returning: $0) }
                } catch {
                    k.resume(throwing: error)
                }
            }
            guard g == giro, conversazione else { return }
            if testo.isEmpty {
                // silenzio: la conversazione si chiude, come sul Mac dopo un minuto senza parole
                chiudiConversazione()
                return
            }
            if Self.paroleFine.firstMatch(in: testo, range: NSRange(testo.startIndex..., in: testo)) != nil {
                conversazione = false
                sfera = .riposo
                parziale = ""
                if voceAccesa { await parlato.dici("A dopo.") }
                if g == giro { liberaAudio() }
                return
            }
            await chiedi(testo, giro: g)
        } catch {
            guard g == giro else { return }
            avviso = error.localizedDescription
            conversazione = false
            sfera = .errore
            liberaAudio()
        }
    }

    private func chiedi(_ testo: String, giro g: Int) async {
        sfera = .pensa
        parziale = testo
        do {
            if voceAccesa {
                try await chiediAVoce(testo)
            } else {
                _ = try await ponte.chiedi(testo)
            }
        } catch is CancellationError {
            // interrotta con un tocco: niente errore
        } catch {
            if (error as? URLError)?.code != .cancelled {
                avviso = error.localizedDescription
                sfera = .errore
                conversazione = false
                parziale = ""
                liberaAudio()
                return
            }
        }
        parziale = ""
        sfera = .riposo
        guard conversazione, g == giro else {
            // giro finito senza conversazione aperta: musica e podcast possono ripartire
            liberaAudio()
            return
        }
        try? await Task.sleep(nanoseconds: 250_000_000)
        // riascolto solo se nel frattempo non e' partito nient'altro (un tocco, una domanda scritta, una chiusura)
        if conversazione, g == giro, sfera == .riposo { await ascoltaFrase(g) }
    }

    /// La risposta arriva a frasi e la voce suona mentre Melissa sta ancora rispondendo (ponte /v1/parla).
    /// Se dal Mac non arriva la voce, parla la voce italiana di iOS con il testo; se si perde a meta', la voce di
    /// iOS dice le frasi arrivate dopo l'ultimo audio.
    private func chiediAVoce(_ testo: String) async throws {
        let pronto: Bool
        do {
            try flusso.prepara()
            pronto = true
        } catch {
            // niente coda su un motore fermo: alla fine parla la voce di iOS
            Log.warn("voce: il motore audio non parte (\(error.localizedDescription)), parla la voce di iOS")
            pronto = false
        }
        var vocePonte = true
        var persa = false
        var frasi: [String] = []
        /// Le frasi arrivate fino all'ultimo audio: quelle dopo, se la voce si perde, le dice iOS.
        var coperte = 0
        var risposta = ""
        let compito = Task { @MainActor in
            try await ponte.parla(testo) { riga in
                switch riga {
                case .voce(let ok): vocePonte = ok
                case .frase(let f):
                    if sfera == .pensa { parziale = "" }
                    frasi.append(f)
                case .audio(let pcm):
                    guard pronto, !persa else { break }
                    coperte = frasi.count
                    if sfera != .parla { sfera = .parla }
                    flusso.accoda(pcm)
                case .vocePersa:
                    vocePonte = false
                    persa = true
                case .fine(let r): risposta = r
                }
            }
        }
        rete = compito
        defer { if rete == compito { rete = nil } }
        try await compito.value
        try Task.checkCancellation()
        if compito.isCancelled { throw CancellationError() }
        if flusso.haSuonato {
            sfera = .parla
            await flusso.aspettaFine()
            let resto = frasi.dropFirst(coperte).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            // interrotta con un tocco mentre suonava: il resto non si dice
            if persa, !resto.isEmpty, !compito.isCancelled, sfera == .parla {
                Log.warn("la voce del Mac si e' persa a meta': il resto lo dice la voce di iOS")
                await parlato.dici(resto)
            }
        } else if !risposta.isEmpty {
            // nessun audio dal Mac (ElevenLabs o il Nucleo giu'): la voce di iOS, con il testo intero
            if vocePonte { Log.warn("il ponte non ha mandato audio: parla la voce di iOS") }
            sfera = .parla
            await parlato.dici(risposta)
        }
    }

    /// Fine del giro: microfono e motore spenti e sessione audio lasciata, cosi' musica e podcast ripartono.
    private func liberaAudio() {
        ascolto.ferma()
        flusso.spegni()
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            Log.warn("audio: la sessione non si chiude (\(error.localizedDescription))")
        }
    }
}
