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
    /// Chi sta parlando adesso, da mostrare sotto la sfera: "Melissa", "Darlene". Cambia quando la voce di quella
    /// battuta comincia a suonare, non quando il suo audio arriva (`audio(di:)`).
    private(set) var parlante = "Melissa"
    /// Le risposte di Melissa da quando un personaggio e' intervenuto: non ne tira dentro uno ogni volta.
    private var dallUltimoOspite = 1
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
    /// I riempitivi del giro di adesso: i tre tempi e la frase che si sta preparando (docs/CONTRATTI.md, 9.11).
    private var riempitivi: Task<Void, Never>?
    /// Un riempitivo e' gia' stato detto in questo giro: la risposta perde il suo «Allora,» iniziale.
    private var riempito = false
    /// Gli ultimi riempitivi detti da ciascuna voce ("melissa" o la chiave), per non ripetersi (per l'eco, il modello).
    private var recentiRiempitivi: [String: [String]] = [:]

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
        annullaRiempitivi()
        switch sfera {
        case .ascolta:
            ascolto.chiudi()
        case .parla:
            // interruzione: si tace, il Mac smette di rispondere, e in conversazione si torna ad ascoltare
            rete?.cancel()
            lavoroTelefono?.cancel()
            flusso.ferma()
        case .pensa:
            // la risposta si sta pensando: il tocco tace il riempitivo, la domanda resta
            flusso.tagliaRiempitivi()
        case .riposo, .errore:
            conversazione = true
            // la prima risposta e' di Melissa da sola, salvo un personaggio per argomento (come la mod 0.15.1)
            dallUltimoOspite = 1
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
        annullaRiempitivi()
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

    /// I pulsanti «Con chi parli»: la chiamata passa a `chi` (o torna a Melissa) senza una frase di Andrea nella storia, e
    /// la conversazione resta com'e' (aperta, si torna ad ascoltare). Chi la prende saluta con la sua voce; senza le
    /// chiavi sul telefono cambia solo chi risponde.
    func passaChiamata(a chi: String) {
        guard chi != chiParla, !occupata, chi == "melissa" || Personaggi.tutti[chi]?.voce.isEmpty == false else { return }
        guard AssistenteTelefono.shared.configurato else {
            chiParla = chi
            parlante = Personaggi.nome(chi)
            return
        }
        giro += 1
        let g = giro
        let continua = conversazione
        ascolto.ferma()
        turno = Task {
            sfera = .pensa
            let voce = voceAccesa
            do {
                if voce { try flusso.prepara() }
                let suona: (Data) -> Void = { [weak self] pcm in
                    guard let self else { return }
                    if self.sfera != .parla { self.sfera = .parla }
                    self.flusso.accoda(pcm)
                }
                try await passaA(chi, dopo: nil, voce: voce, audio: suona)
                if voce, flusso.haSuonato {
                    sfera = .parla
                    await flusso.aspettaFine()
                }
            } catch is CancellationError {
                // interrotta con un tocco
            } catch {
                guard g == giro else { return }
                avviso = error.localizedDescription
                sfera = .errore
                liberaAudio()
                return
            }
            parlante = Personaggi.nome(chiParla)
            guard g == giro else { return }
            sfera = .riposo
            if continua, conversazione { await ascoltaFrase(g) } else { liberaAudio() }
        }
    }

    /// L'app va dietro: niente microfono acceso di nascosto, e la sessione audio torna alle altre app.
    func sospendi() {
        chiudiConversazione()
        CacheRiempitivi.shared.sospendi()
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
                try await chiediSulTelefono(testo, giro: g)
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

    private func chiediSulTelefono(_ testo: String, giro g: Int) async throws {
        // la risposta ha la precedenza: la cache dei riempitivi si prepara a fine giro
        CacheRiempitivi.shared.sospendi()
        riempito = false
        defer {
            annullaRiempitivi()
            if voceAccesa { scaldaRiempitivi() }
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
            // il primo audio vero: niente piu' riempitivi, ne' quelli in attesa ne' quello che si sta preparando
            self.annullaRiempitivi()
            if self.sfera != .parla { self.sfera = .parla; self.parziale = "" }
            self.flusso.accoda(pcm)
        }
        let task = Task { @MainActor in
            if let chiesto = Personaggi.chiChiede(testo), chiesto != self.chiParla {
                try await self.passaA(chiesto, dopo: testo, voce: voce, audio: suona)
                return
            }
            let p = Personaggi.tutti[self.chiParla]
            // chi Andrea vuole sentire ("chiedi a Elliot", "Vabbe' Krista, e tu?") lo capisce ChiVuole, qui sotto: niente
            // nomi cercati nel testo. Ogni tanto, solo a voce, Melissa tira dentro quello che il codice sceglie: dopo
            // ogni risposta senza ospite puo', dopo due lo fa; quello di cui Andrea ha toccato l'argomento lo fa subito
            let scelto = p == nil && self.conversazione && voce
                && Personaggi.puoEntrare(testo, dallUltimo: self.dallUltimoOspite, ultimo: self.ultimoOspite)
                ? Personaggi.adatto(testo, ultimo: self.ultimoOspite) : nil
            let vivo = Personaggi.invitoDeciso(testo, dallUltimo: self.dallUltimoOspite, scelto: scelto)
            let invito = p == nil ? Personaggi.invito(scelto: scelto, vivo: vivo) : ""
            // a chi Melissa puo' dare la parola, con passa_parola (docs/CONTRATTI.md, 9.11)
            let conVoce = Personaggi.ordine.filter { Personaggi.tutti[$0]?.voce.isEmpty == false }
            let contesto = p == nil ? self.ponte.contestoMelissa(per: testo) : nil
            // mentre il modello pensa parla chi ha la chiamata (non in passaA: il saluto e' gia' pronto)
            if voce { self.avviaRiempitivi(per: testo, chi: self.chiParla, giro: g) }
            let rispostaDi = self.chiParla
            // chi vuole sentire Andrea, capito dal modello in parallelo con la risposta: il nome esatto e' gia' passato
            // sopra, qui "passami la nostra amica psicologa" o un nome capito male (docs/CONTRATTI.md, 9.11)
            let capito = Task { @MainActor in await telefono.chiVuole(testo) }
            let risposta = Task { @MainActor in
                try await telefono.rispondi(testo, chi: rispostaDi, invito: invito,
                                            passaA: p == nil ? conVoce : [], deciso: p == nil && vivo ? scelto : nil, voce: voce,
                                            contestoMac: contesto, memoria: self.ponte.memoriaMelissa(),
                                            riempito: { self.riempito && g == self.giro },
                                            audio: self.audio(di: rispostaDi, voce: voce, suona))
            }
            let chi = await withTaskCancellationHandler { await capito.value } onCancel: { capito.cancel(); risposta.cancel() }
            let giro = Personaggi.giroDiVoci(chi, conVoce: conVoce, conLaChiamata: rispostaDi)
            let passa = chi?.passa.flatMap { $0 != rispostaDi && ($0 == "melissa" || conVoce.contains($0)) ? $0 : nil }
            let chiedeUno = giro.voci.isEmpty && passa == nil && p == nil
                ? chi?.chiede.first { conVoce.contains($0) } : nil
            // Andrea vuole un altro, il parere di qualcuno o tutti: la risposta pensata prima (che puo' essere un rifiuto)
            // si taglia, e Melissa dirige (docs/CONTRATTI.md, 9.11, «Melissa coordina, non rifiuta»). Con un personaggio
            // al telefono e un giro senza passaggio, risponde lui e poi parlano gli altri
            if passa != nil || chiedeUno != nil || (!giro.voci.isEmpty && p == nil) {
                risposta.cancel()
                _ = try? await risposta.value
                self.annullaRiempitivi()
                if voce { try self.flusso.prepara() }
                try await self.dirige(passa: passa, chiede: chiedeUno, giro: giro, voce: voce, audio: suona)
                return
            }
            let battuta = try await withTaskCancellationHandler { try await risposta.value } onCancel: { risposta.cancel() }
            if !giro.voci.isEmpty {
                try await self.coro(giro.voci, chiude: giro.chiude, voce: voce, audio: suona)
                return
            }
            // contano solo le risposte di Melissa: un personaggio con la chiamata non tira dentro nessuno
            if p == nil { self.dallUltimoOspite += 1 }
            // risponde chi ha ricevuto la parola con passa_parola, o chi l'invito deciso nominava
            if let ospite = battuta.ospite {
                try await self.aTre(ospite, voce: voce, audio: suona)
            }
        }
        lavoroTelefono = task
        // a fine giro, anche interrotto, il nome e' di chi ha la chiamata
        defer { lavoroTelefono = nil; parlante = Personaggi.nome(chiParla) }
        try await task.value
        if voceAccesa {
            guard flusso.haSuonato else { throw ErrorePonte(messaggio: "ElevenLabs non ha mandato l'audio della voce di \(parlante).") }
            sfera = .parla
            await flusso.aspettaFine()
        } else {
            parziale = telefono.turni.last?.riga.testo ?? ""
        }
    }

    /// Melissa dirige (docs/CONTRATTI.md, 9.11): una regia breve, pensata con un prompt che dice cosa succede, al posto
    /// della risposta tagliata; poi chi prende la chiamata saluta, oppure risponde chi e' chiesto, oppure il giro a piu'
    /// voci con le somme di Melissa alla fine.
    private func dirige(passa: String?, chiede: String?, giro: (voci: [String], chiude: Bool), voce: Bool,
                        audio suona: @escaping (Data) -> Void) async throws {
        let prima = chiParla
        let cosa = prima == "melissa" && passa != "melissa" ? Personaggi.regia(passa: passa, chiede: chiede, voci: giro.voci) : ""
        if !cosa.isEmpty {
            do {
                _ = try await AssistenteTelefono.shared.interviene("melissa", istruzione: cosa, memoria: ponte.memoriaMelissa(),
                                                                   voce: voce, audio: self.audio(di: "melissa", voce: voce, suona))
            } catch {
                if Task.isCancelled { throw error }
                Log.info("regia di Melissa non riuscita: \(error.localizedDescription)")
            }
        }
        if let passa {
            // senza giro chi prende la chiamata saluta; nel giro la sua prima battuta e' il saluto
            if giro.voci.isEmpty { return try await passaA(passa, dopo: nil, voce: voce, audio: suona) }
            chiParla = passa
        }
        if !giro.voci.isEmpty {
            try await coro(giro.voci, chiude: giro.chiude, nuovo: passa == "melissa" ? nil : passa, voce: voce, audio: suona)
        } else if let chiede {
            try await aTre(chiede, voce: voce, audio: suona)
        }
    }

    /// Il giro a piu' voci: ognuno, a turno, una battuta dal suo campo, sapendo cosa hanno detto quelli prima (la storia);
    /// la battuta del successivo si pensa mentre suona quella prima. `nuovo`: quello a cui e' appena passata la chiamata.
    /// `chiude`: alla fine Melissa tira le somme.
    private func coro(_ voci: [String], chiude: Bool, nuovo: String? = nil, voce: Bool,
                      audio suona: @escaping (Data) -> Void) async throws {
        let telefono = AssistenteTelefono.shared
        let memoria = ponte.memoriaMelissa()
        var dette: [String] = []
        for (i, chi) in voci.enumerated() {
            guard let p = Personaggi.tutti[chi], !p.voce.isEmpty else { continue }
            dallUltimoOspite = 0
            ultimoOspite = chi
            let perche = chi == nuovo ? "Melissa ti ha appena passato la chiamata, e Andrea vuole sentire anche gli altri"
                : "Andrea vuole sentire tutti, uno alla volta, e tocca a te"
            do {
                _ = try await telefono.interviene(chi, istruzione: "Sei in una chiacchierata a voce con Melissa, Andrea e gli " +
                                                    "altri di Mr. Robot. \(perche). " + Personaggi.istruzioneGiro(chi, primo: i == 0),
                                                  memoria: memoria, voce: voce, audio: self.audio(di: chi, voce: voce, suona))
                dette.append(p.nome)
            } catch {
                if Task.isCancelled { throw error }
                Log.info("giro: \(p.nome) non ha risposto: \(error.localizedDescription)")
            }
        }
        guard chiude, !dette.isEmpty else { return }
        _ = try await telefono.interviene(
            "melissa",
            istruzione: "Hanno detto la loro \(Personaggi.elenco(dette)). Tira le somme tu in una o due frasi, rivolta ad " +
                "Andrea: cosa ne esce, senza ripetere le loro parole e senza fare domande agli altri. Solo le parole che diresti.",
            memoria: memoria, voce: voce, audio: self.audio(di: "melissa", voce: voce, suona))
    }

    /// Passa la chiamata: il personaggio saluta con la sua voce, oppure Melissa riprende.
    private func passaA(_ chi: String, dopo testo: String?, voce: Bool, audio: @escaping (Data) -> Void) async throws {
        let telefono = AssistenteTelefono.shared
        if chi == "melissa" {
            let prima = Personaggi.tutti[chiParla]?.nome
            chiParla = "melissa"
            try await telefono.dici(prima.map { "Eccomi, \($0) mi ha ripassato la chiamata." } ?? "Sono qui.",
                                    chi: "melissa", domanda: testo, voce: voce, audio: self.audio(di: "melissa", voce: voce, audio))
            return
        }
        guard let p = Personaggi.tutti[chi] else { return }
        chiParla = chi
        try await telefono.dici(p.saluti.randomElement() ?? p.nome, chi: chi, domanda: testo, voce: voce,
                                audio: self.audio(di: chi, voce: voce, audio))
    }

    /// Melissa ha tirato dentro un personaggio: risponde lui con la sua voce, poi lei chiude e torna ad Andrea.
    /// La battuta dopo si pensa mentre quella prima sta ancora suonando. Se chiudendo da' comunque la parola a
    /// qualcuno con passa_parola, quello risponde una volta (`ultima`) e la parola torna ad Andrea (docs/CONTRATTI.md,
    /// 9.11). `daChi`: il personaggio che gli ha appena chiesto qualcosa (parlano fra loro).
    private func aTre(_ chi: String, voce: Bool, ultima: Bool = false, daChi: String? = nil,
                      audio: @escaping (Data) -> Void) async throws {
        guard let p = Personaggi.tutti[chi] else { return }
        let telefono = AssistenteTelefono.shared
        let memoria = ponte.memoriaMelissa()
        dallUltimoOspite = 0
        ultimoOspite = chi
        // ogni tanto chiude chiedendo a un altro di loro, per nome, cosa ne pensa, e quello risponde: parlano fra loro
        let altri = Personaggi.altri(di: chi, daChi: daChi)
        let passa = Personaggi.passa(fra: altri, ultima: ultima)
        let chiede: String
        let a: String
        if let daChi {
            chiede = "\(Personaggi.nome(daChi)) ti ha appena chiesto qualcosa"
            a = "Rispondi a \(Personaggi.nome(daChi)), davanti ad Andrea"
        } else {
            chiede = "Melissa ti ha appena tirato in mezzo, e tocca a te per \(Personaggi.ruoli[chi] ?? "dire la tua")"
            a = "Rispondi alla domanda di Melissa e ad Andrea"
        }
        let istruzione = "Sei in una chiacchierata a voce con Melissa, Andrea e gli altri di Mr. Robot. \(chiede). \(a) in una " +
            "o due frasi, a modo tuo e sul punto: qualcosa che gli serve davvero; puoi punzecchiare Melissa, ma da amici." +
            (passa.map { " Poi chiedi a \(Personaggi.nome($0)) cosa ne pensa. " + Personaggi.chiamaCon($0) } ?? "") +
            " Solo le parole che diresti."
        let battuta = try await telefono.interviene(chi, istruzione: istruzione, passaA: ultima ? [] : altri, deciso: passa,
                                                    memoria: memoria, voce: voce, audio: self.audio(di: chi, voce: voce, audio))
        // quello a cui ha chiesto risponde una volta, e basta; poi Melissa chiude con tutto il giro davanti
        if !ultima, let altro = battuta.ospite, altri.contains(altro) {
            try await aTre(altro, voce: voce, ultima: true, daChi: chi, audio: audio)
        }
        if ultima { return }
        let chiusa = try await telefono.interviene(
            "melissa",
            istruzione: "Hanno appena detto la loro. Chiudi tu in una o due frasi, rivolta ad Andrea, riprendendo il filo " +
                "o rispondendo a modo tuo, senza fare domande a \(p.nome) ne' agli altri. Solo le parole che diresti.",
            passaA: Personaggi.ordine.filter { Personaggi.tutti[$0]?.voce.isEmpty == false },
            memoria: memoria, voce: voce, audio: self.audio(di: "melissa", voce: voce, audio))
        // ha dato comunque la parola a qualcuno: risponde, una volta ancora
        if let altro = chiusa.ospite { try await aTre(altro, voce: voce, ultima: true, audio: audio) }
    }

    // MARK: - riempitivi

    /// I tre tempi da quando la domanda parte verso il modello: a 900 ms una frase per quello che Andrea ha detto, a 5
    /// e a 10 s una di `lunga`, con la voce di chi ha la chiamata. Ognuna solo se il giro e' lo stesso e non e' ancora
    /// arrivato audio vero. Dalla cache; se manca si dice dal vivo (l'eco sempre), e si butta se la risposta arriva prima.
    private func avviaRiempitivi(per testo: String, chi: String, giro g: Int) {
        annullaRiempitivi()
        guard let config = SegretiTelefono.leggi(), let key = config.elevenlabs, !key.isEmpty else { return }
        let voce = chi == "melissa" ? config.voiceID : (Personaggi.tutti[chi]?.voce ?? "")
        guard !voce.isEmpty else { return }
        let propri = Personaggi.riempitivi(di: chi)
        let tipo = Riempitivi.intento(testo)
        let cache = CacheRiempitivi.shared
        let partenza = ContinuousClock.now
        riempitivi = Task { [weak self] in
            for (i, quando) in Riempitivi.tempi.enumerated() {
                do { try await Task.sleep(until: partenza + quando, clock: .continuous) } catch { return }
                guard let self, self.riempitivoServe(g) else { return }
                guard let s = Riempitivi.scegli(propri, melissa: Personaggi.riempitiviMelissa, gruppo: i == 0 ? tipo : .lunga,
                                                recenti: self.recentiRiempitivi[chi] ?? [], testo: testo,
                                                esclusi: Personaggi.nonTemi) else { continue }
                var pcm = s.eco ? nil : cache.leggi(voce: voce, testo: s.frase)
                if pcm == nil {
                    pcm = try? await cache.genera(key: key, voce: voce, testo: s.frase, salva: !s.eco)
                }
                // pronta tardi: se intanto la risposta ha cominciato a parlare, non si dice piu'
                guard let pcm, self.riempitivoServe(g) else { continue }
                self.recentiRiempitivi[chi] = Array(((self.recentiRiempitivi[chi] ?? []) + [s.modello]).suffix(6))
                self.riempito = true
                Log.info("riempitivo a \(i == 0 ? "900 ms" : "\(quando)") (\(Personaggi.nome(chi))): \(s.frase)")
                // il nome di chi lo dice quando comincia a suonare
                self.flusso.segna { [weak self] in self?.parlante = Personaggi.nome(chi) }
                self.flusso.accodaRiempitivo(pcm)
            }
        }
    }

    private func riempitivoServe(_ g: Int) -> Bool {
        !Task.isCancelled && g == giro && sfera == .pensa && !flusso.haSuonato
    }

    /// Al primo audio vero, a fine giro, a un tocco, alla chiusura, a un errore: i tempi rimasti e la frase in
    /// preparazione si buttano. Quella gia' in coda finisce di suonare (un tocco mentre pensa la tace).
    private func annullaRiempitivi() {
        riempitivi?.cancel()
        riempitivi = nil
    }

    /// A fine giro, con la voce accesa: prepara l'audio delle frasi fisse di Melissa e dei personaggi con una voce.
    private func scaldaRiempitivi() {
        guard let config = SegretiTelefono.leggi(), let key = config.elevenlabs, !key.isEmpty, !config.voiceID.isEmpty else { return }
        let melissa = Personaggi.riempitiviMelissa
        var voci = [(voce: config.voiceID, frasi: Riempitivi.fisse(melissa, melissa: melissa))]
        for k in Personaggi.ordine {
            guard let p = Personaggi.tutti[k], !p.voce.isEmpty else { continue }
            voci.append((voce: p.voce, frasi: Riempitivi.fisse(p.riempitivi, melissa: melissa)))
        }
        CacheRiempitivi.shared.scalda(key: key, voci: voci)
    }

    /// L'audio di una battuta di `chi`: il nome sotto la sfera passa a lui quando la sua voce comincia a suonare, non
    /// quando arriva il primo PCM (la battuta dopo si pensa e si accoda mentre quella prima suona ancora). Senza
    /// voce, subito.
    private func audio(di chi: String, voce: Bool, _ suona: @escaping (Data) -> Void) -> (Data) -> Void {
        let nome = Personaggi.nome(chi)
        guard voce else {
            parlante = nome
            return suona
        }
        var primo = true
        return { [weak self] pcm in
            if primo {
                primo = false
                // prima di accodare: il segno sta subito prima del primo pezzo di questa battuta
                self?.flusso.segna { [weak self] in self?.parlante = nome }
            }
            suona(pcm)
        }
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
