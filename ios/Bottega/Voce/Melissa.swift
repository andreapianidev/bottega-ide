//
//  Melissa.swift
//  Bottega per iPhone
//
//  Il giro della conversazione sull'iPhone: se le chiavi sono importate, Agnes o DeepSeek ed ElevenLabs
//  rispondono direttamente sul telefono anche con il Mac acceso. Il ponte sincronizza la storia. In conversazione si
//  rimette in ascolto da sola; "basta" o un tocco mentre ascolta senza parole la chiudono. Toccarla mentre
//  parla la interrompe, come sul Mac. Come nella mod di Claude Code, Melissa passa la chiamata a Darlene, Elliot
//  o Krista («passami Darlene», «ridammi Melissa») e ogni tanto ne tira dentro uno (Personaggi.swift).
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
    /// Chi ha la chiamata: "melissa" o la chiave di un personaggio. Torna a Melissa quando la conversazione si chiude.
    private(set) var chiParla = "melissa"
    /// Chi sta parlando adesso, da mostrare sotto la sfera: "Melissa", "Darlene", "Melissa e Darlene".
    private(set) var parlante = "Melissa"
    /// Le risposte di Melissa da quando un personaggio e' intervenuto: non ne tira dentro uno ogni volta.
    private var dallUltimoOspite = 99
    /// Chi e' intervenuto l'ultima volta: il prossimo, se non c'e' un motivo, e' un altro.
    private var ultimoOspite: String?
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
    private var lavoroTelefono: Task<Void, Error>?
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
        tornaAMelissa()
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
                tornaAMelissa()
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
            if AssistenteTelefono.shared.configurato {
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
        defer {
            // Anche una risposta interrotta resta nella cronologia locale. La sincronizzazione e' autonoma:
            // non ritarda la voce e il server deduplica ogni turno tramite UUID.
            if ponte.linea == .collegato {
                Task { await AssistenteTelefono.shared.sincronizza(con: ponte) }
            }
        }
        if voceAccesa { try flusso.prepara() }
        let telefono = AssistenteTelefono.shared
        let voce = voceAccesa
        let suona: (Data) -> Void = { pcm in
            if self.sfera != .parla { self.sfera = .parla; self.parziale = "" }
            self.flusso.accoda(pcm)
        }
        let task = Task { @MainActor in
            if let chiesto = Personaggi.chiChiede(testo), chiesto != self.chiParla {
                try await self.passaA(chiesto, dopo: testo, voce: voce, audio: suona)
                return
            }
            let p = Personaggi.tutti[self.chiParla]
            // chi puo' entrare: quello che Andrea chiede, o ogni tanto, solo a voce, quello che il codice sceglie
            let voluto = p == nil ? Personaggi.ospiteChiesto(testo) : nil
            let scelto = p == nil && self.conversazione && voce && self.dallUltimoOspite >= 2
                ? Personaggi.adatto(testo, ultimo: self.ultimoOspite) : nil
            let invito = p == nil ? Personaggi.invito(voluto: voluto, scelto: scelto) : ""
            let contesto = p == nil ? self.ponte.contestoMelissa(per: testo) : nil
            let battuta = try await telefono.rispondi(testo, chi: self.chiParla, invito: invito, voce: voce,
                                                      contestoMac: contesto, audio: suona)
            self.dallUltimoOspite += 1
            // entra solo chi era stato offerto: un altro nome scritto dal modello si ignora
            if let ospite = battuta.ospite, ospite == voluto || ospite == scelto {
                try await self.aTre(ospite, voce: voce, audio: suona)
            }
        }
        lavoroTelefono = task
        defer { lavoroTelefono = nil; if chiParla == "melissa" { parlante = "Melissa" } }
        try await task.value
        if voceAccesa {
            guard flusso.haSuonato else { throw ErrorePonte(messaggio: "ElevenLabs non ha mandato l'audio della voce di \(parlante).") }
            sfera = .parla
            await flusso.aspettaFine()
        } else {
            parziale = telefono.turni.last?.riga.testo ?? ""
        }
    }

    /// Passa la chiamata: il personaggio saluta con la sua voce, oppure Melissa riprende.
    private func passaA(_ chi: String, dopo testo: String, voce: Bool, audio: @escaping (Data) -> Void) async throws {
        let telefono = AssistenteTelefono.shared
        if chi == "melissa" {
            let prima = Personaggi.tutti[chiParla]?.nome
            tornaAMelissa()
            try await telefono.dici(prima.map { "Eccomi, \($0) mi ha ripassato la chiamata." } ?? "Sono qui.",
                                    chi: "melissa", domanda: testo, voce: voce, audio: audio)
            return
        }
        guard let p = Personaggi.tutti[chi] else { return }
        chiParla = chi
        parlante = p.nome
        try await telefono.dici(p.saluti.randomElement() ?? p.nome, chi: chi, domanda: testo, voce: voce, audio: audio)
    }

    /// Melissa ha tirato dentro un personaggio: risponde lui con la sua voce, poi lei chiude e torna ad Andrea.
    /// La battuta dopo si pensa mentre quella prima sta ancora suonando.
    private func aTre(_ chi: String, voce: Bool, audio: @escaping (Data) -> Void) async throws {
        guard let p = Personaggi.tutti[chi] else { return }
        let telefono = AssistenteTelefono.shared
        dallUltimoOspite = 0
        ultimoOspite = chi
        parlante = "Melissa e \(p.nome)"
        _ = try await telefono.interviene(
            chi,
            istruzione: "Sei in una chiacchierata a voce a tre con Melissa e Andrea; Melissa ti ha appena tirato in mezzo. " +
                "Rispondi a Melissa e ad Andrea in una o due frasi, a modo tuo: puoi anche punzecchiarla. Solo le parole che diresti.",
            voce: voce, audio: audio)
        _ = try await telefono.interviene(
            "melissa",
            istruzione: "\(p.nome) ha appena detto la sua. Chiudi tu in una o due frasi, rivolta ad Andrea, riprendendo il filo " +
                "o rispondendo a \(p.nome) a modo tuo. Solo le parole che diresti.",
            voce: voce, audio: audio)
    }

    private func tornaAMelissa() {
        chiParla = "melissa"
        parlante = "Melissa"
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
