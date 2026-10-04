//
//  Melissa.swift
//  Bottega per iPhone
//
//  Il giro della conversazione sull'iPhone: col Mac acceso usa il ponte e i suoi strumenti; col Mac spento
//  Agnes o DeepSeek e ElevenLabs rispondono direttamente sul telefono. In conversazione si
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
    private let flusso = FlussoVoce()
    private var turno: Task<Void, Never>?
    /// La risposta a voce in arrivo dal Mac: cancellarla chiude la connessione e il Mac smette di rispondere.
    private var rete: Task<Void, Error>?
    private var lavoroTelefono: Task<String, Error>?
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
            lavoroTelefono?.cancel()
            flusso.ferma()
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
        lavoroTelefono?.cancel()
        flusso.ferma()
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
            if ponte.linea != .collegato {
                try await chiediSulTelefono(testo)
            } else if voceAccesa {
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

    private func chiediSulTelefono(_ testo: String) async throws {
        if voceAccesa { try flusso.prepara() }
        let task = Task { @MainActor in
            try await AssistenteTelefono.shared.rispondi(testo, voce: voceAccesa) { pcm in
                if self.sfera != .parla { self.sfera = .parla; self.parziale = "" }
                self.flusso.accoda(pcm)
            }
        }
        lavoroTelefono = task
        defer { lavoroTelefono = nil }
        let risposta = try await task.value
        if voceAccesa {
            guard flusso.haSuonato else { throw ErrorePonte(messaggio: "ElevenLabs non ha mandato l'audio della voce di Melissa.") }
            sfera = .parla
            await flusso.aspettaFine()
        } else {
            parziale = risposta
        }
    }

    /// La risposta arriva a frasi e la voce suona mentre Melissa sta ancora rispondendo (ponte /v1/parla).
    /// Se ElevenLabs non manda audio, mostriamo l'errore senza cambiare la voce di Melissa.
    private func chiediAVoce(_ testo: String) async throws {
        try flusso.prepara()
        var vocePonte = true
        var erroreVoce: String?
        var risposta = ""
        let compito = Task { @MainActor in
            try await ponte.parla(testo) { riga in
                switch riga {
                case .voce(let ok): vocePonte = ok
                case .frase(let f):
                    if sfera == .pensa { parziale = "" }
                    parziale = f
                case .audio(let pcm):
                    if sfera != .parla { sfera = .parla }
                    flusso.accoda(pcm)
                case .vocePersa(let errore):
                    vocePonte = false
                    erroreVoce = errore
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
        }
        if !vocePonte || (!risposta.isEmpty && !flusso.haSuonato) {
            throw ErrorePonte(messaggio: erroreVoce ?? "ElevenLabs non ha mandato la voce di Melissa.")
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
