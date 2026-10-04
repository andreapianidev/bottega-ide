import XCTest
import ActivityKit
@testable import Bottega

@MainActor
final class AssistenteTelefonoTests: XCTestCase {
    func testPonteTLSConIndirizzoTailscale() async throws {
        let ponte = Ponte.shared
        ponte.ricarica()
        let c = try XCTUnwrap(ponte.collegamento)
        let sicuro = try XCTUnwrap(Collegamento.sicuro)
        let url = try XCTUnwrap(URL(string: "https://\(c.ip):\(sicuro.porta)/v1/stato"))
        var richiesta = URLRequest(url: url, timeoutInterval: 15)
        richiesta.setValue("Bearer \(c.token)", forHTTPHeaderField: "authorization")
        let sessione = URLSession(configuration: .ephemeral, delegate: FiduciaPonte.shared, delegateQueue: nil)
        defer { sessione.invalidateAndCancel() }
        let (dati, risposta) = try await sessione.data(for: richiesta)
        XCTAssertEqual((risposta as? HTTPURLResponse)?.statusCode, 200)
        let stato = try JSONDecoder().decode(StatoMac.self, from: dati)
        XCTAssertLessThan(abs(Date().timeIntervalSince1970 * 1000 - stato.ora), 30_000)
        XCTAssertTrue(Set(["claude", "codex", "cline", "terminale"])
            .isSubset(of: Set(try XCTUnwrap(stato.attivita).map(\.source))))
    }

    func testLiveActivityRiparteDopoRiaccensione() async throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled, Avvisi.shared.liveAccese else {
            throw XCTSkip("Live Activity disabilitate nelle preferenze del dispositivo")
        }
        let ponte = Ponte.shared
        ponte.ricarica()
        await ponte.aggiornaStato()
        let stato = try XCTUnwrap(ponte.stato)
        guard stato.conteggiAttivita.inCorso + stato.conteggiAttivita.tiAspetta > 0 else {
            throw XCTSkip("Nessuna attività attuale da mostrare")
        }
        Avvisi.shared.avvia()
        await Avvisi.shared.cambiaLive(false)
        await Avvisi.shared.cambiaLive(true)
        var correnti: [Activity<BottegaAttivita>] = []
        for _ in 0..<45 {
            correnti = Activity<BottegaAttivita>.activities.filter {
                $0.activityState == .active && Date().timeIntervalSince1970 * 1000 - $0.content.state.aggiornato < 90_000
            }
            if !correnti.isEmpty { break }
            try await Task.sleep(for: .seconds(1))
        }
        XCTAssertFalse(correnti.isEmpty, "La Live Activity deve essere attiva con un dato recente")
        if let contenuto = correnti.first?.content.state {
            XCTAssertTrue(contenuto.righe.allSatisfy { $0.fonte != nil })
            print("Live Activity recente: righe=\(contenuto.righe.count), inCorso=\(contenuto.inCorso), inAttesa=\(contenuto.tiAspetta)")
        }
    }

    override func setUp() async throws {
        // Solo il runner dei test può fornire il collegamento: nessun gettone nel codice o nei risultati.
        guard let link = ProcessInfo.processInfo.environment["BOTTEGA_TEST_LINK"],
              let url = URL(string: link) else { return }
        await MainActor.run {
            let attuale = Ponte.shared.collegamento
            let richiesto = Collegamento(url: url)
            if attuale?.host != richiesto?.host || attuale?.token != richiesto?.token || attuale?.porta != richiesto?.porta {
                XCTAssertTrue(Ponte.shared.collega(url), "Il collegamento di prova deve essere valido")
            }
        }
    }

    func testAttivitaDelMacEContestoMelissa() async throws {
        let ponte = Ponte.shared
        ponte.ricarica()
        await ponte.aggiornaStato()
        XCTAssertEqual(ponte.linea, .collegato, "Il ponte deve riconnettersi al Mac")
        let stato = try XCTUnwrap(ponte.stato)
        let attivita = try XCTUnwrap(stato.attivita, "Il Mac aggiornato deve inviare tutte le attività")
        XCTAssertGreaterThan(attivita.count, 0, "Almeno questa sessione Codex deve essere visibile")
        XCTAssertTrue(attivita.contains { $0.source == "codex" }, "La sessione Codex attuale deve apparire")
        let contesto = try XCTUnwrap(stato.contestoMelissa(per: "Cosa fa Codex?"))
        XCTAssertTrue(contesto.contains("Codex"))
        XCTAssertEqual(stato.conteggiAttivita.totale, attivita.count)
    }

    func testRegistroQuattroFontiSiAggiornaConAppAperta() async throws {
        let ponte = Ponte.shared
        ponte.ricarica()
        await ponte.aggiornaStato()
        XCTAssertEqual(ponte.linea, .collegato)
        let prima = try XCTUnwrap(ponte.stato)
        let fonti = Set(try XCTUnwrap(prima.attivita).map(\.source))
        XCTAssertTrue(Set(["claude", "codex", "cline", "terminale"]).isSubset(of: fonti),
                      "Il Mac di prova deve esporre le quattro fonti osservate")
        XCTAssertLessThan(abs(Date().timeIntervalSince1970 * 1000 - prima.ora), 30_000)
        ponte.avvia()
        // Nessuna rilettura manuale: questa prova verifica il flusso mentre l'app resta aperta.
        // Il primo snapshot può essere quello iniziale SSE: ne servono altri distinti.
        var aggiornamenti = Set<Double>()
        for _ in 0..<35 {
            if let ora = ponte.stato?.ora, ora > prima.ora { aggiornamenti.insert(ora) }
            if aggiornamenti.count >= 3 { break }
            try await Task.sleep(for: .seconds(1))
        }
        XCTAssertGreaterThanOrEqual(aggiornamenti.count, 3, "Il flusso deve continuare oltre lo snapshot iniziale")
        let dopo = try XCTUnwrap(ponte.stato)
        XCTAssertGreaterThan(dopo.ora, prima.ora)
        XCTAssertTrue(Set(["claude", "codex", "cline", "terminale"])
            .isSubset(of: Set(try XCTUnwrap(dopo.attivita).map(\.source))))
        let salvato = try XCTUnwrap(StatoMac.ultimo())
        XCTAssertEqual(salvato.ora, dopo.ora, "Il widget deve leggere lo stesso aggiornamento")
        XCTAssertEqual(salvato.sessioniWidget, dopo.sessioniWidget)
    }

    func testRaccontoStanzaReale() async throws {
        let ponte = Ponte.shared
        ponte.ricarica()
        await ponte.aggiornaStato()
        XCTAssertEqual(ponte.linea, .collegato)
        try await ponte.importaConfigurazioneAssistente()
        let copia = try await PonteStanze.shared.leggi("cruscotto", ["periodo": "7"])
        let stanza = try JSONDecoder().decode(StanzaCruscotto.self, from: copia.dati)
        let contesto = "Cruscotto degli ultimi 7 giorni. Sessioni \(stanza.cifre.sessioni), " +
            "ore di lavoro \(stanza.cifre.tu), ore Claude \(stanza.cifre.claude). " +
            "Racconta questi numeri in due frasi brevi."
        let racconto = Riassunto()
        racconto.avvia(titolo: "il cruscotto", contesto: contesto)
        for _ in 0..<90 {
            if racconto.stato == .fermo { break }
            try await Task.sleep(for: .seconds(1))
        }
        if racconto.stato != .fermo { racconto.ferma(); XCTFail("Racconto ancora in corso dopo 90 secondi") }
        XCTAssertNil(racconto.errore, "La stanza deve terminare senza errore ElevenLabs")
        XCTAssertFalse(racconto.testo.isEmpty)
    }

    func testVoceDirettaConMacCollegato() async throws {
        let ponte = Ponte.shared
        ponte.ricarica()
        await ponte.aggiornaStato()
        XCTAssertEqual(ponte.linea, .collegato, "Il ponte sul Mac deve essere disponibile")
        try await ponte.importaConfigurazioneAssistente()
        let telefono = AssistenteTelefono.shared
        let providerPrima = telefono.provider
        let impegnoPrima = telefono.impegno
        defer {
            telefono.provider = providerPrima
            telefono.impegno = impegnoPrima
            Task { await telefono.sincronizzaScelta(con: ponte) }
        }

        let melissa = Melissa(ponte: ponte)
        melissa.voceAccesa = true
        for (provider, domanda) in [
            ("agnes", "Rispondi con una frase breve: mi senti?"),
            ("deepseek", "Rispondi con una frase breve: la voce funziona?")
        ] {
            telefono.provider = provider
            telefono.impegno = "rapido"
            let prima = telefono.turni.count
            melissa.avviso = nil
            melissa.scrivi(domanda)
            for _ in 0..<60 {
                if telefono.turni.count >= prima + 2 && !melissa.occupata { break }
                try await Task.sleep(for: .seconds(1))
            }
            XCTAssertGreaterThanOrEqual(telefono.turni.count, prima + 2, "\(provider) deve rispondere sull'iPhone")
            XCTAssertGreaterThan(telefono.ultimiByteVoce, 0, "\(provider) deve ricevere audio ElevenLabs")
            XCTAssertNil(melissa.avviso, "\(provider) deve terminare senza errore")
            XCTAssertEqual(ponte.linea, .collegato, "La prova deve restare con il Mac collegato")
            for _ in 0..<15 {
                if telefono.turni.suffix(2).allSatisfy(\.sincronizzato) { break }
                try await Task.sleep(for: .seconds(1))
            }
            XCTAssertTrue(telefono.turni.suffix(2).allSatisfy(\.sincronizzato), "\(provider) deve sincronizzare i turni sul Mac")
        }
    }

    func testMacEAutonomiaSulDispositivo() async throws {
        let ponte = Ponte.shared
        ponte.ricarica()
        await ponte.aggiornaStato()
        XCTAssertEqual(ponte.linea, .collegato, "Il ponte sul Mac deve essere disponibile per importare le chiavi")
        try await ponte.importaConfigurazioneAssistente()
        XCTAssertTrue(AssistenteTelefono.shared.configurato)

        let dalMac = try await ponte.chiedi("Rispondi brevemente: quanto fa due più due?")
        XCTAssertFalse(dalMac.isEmpty, "Il percorso col Mac acceso deve rispondere")

        let telefono = AssistenteTelefono.shared
        let providerPrecedente = telefono.provider
        let impegnoPrecedente = telefono.impegno
        defer {
            telefono.impostaPerProva(provider: providerPrecedente, impegno: impegnoPrecedente)
            ponte.riavvia()
        }

        telefono.impostaPerProva(provider: "agnes", impegno: "rapido")
        ponte.simulaMacAssentePerProva()
        let iniziali = telefono.turni.count
        let melissa = Melissa(ponte: ponte)
        melissa.voceAccesa = true
        melissa.scrivi("Dì una frase breve per la prova sull'iPhone.")
        for _ in 0..<70 {
            if telefono.turni.count >= iniziali + 2 && !melissa.occupata { break }
            try await Task.sleep(for: .seconds(1))
        }
        XCTAssertGreaterThanOrEqual(telefono.turni.count, iniziali + 2, "Agnes deve rispondere senza il ponte")
        XCTAssertGreaterThan(telefono.ultimiByteVoce, 0, "ElevenLabs deve inviare audio direttamente all'iPhone")
        XCTAssertNil(melissa.avviso, "Melissa deve finire la voce senza errore")

        let turniPrimaDelRacconto = telefono.turni.count
        var testoRacconto = ""
        var audioRacconto = 0
        let racconto = try await telefono.racconta("Sessione di prova: stato in corso, ha letto un file Swift e aspetta una conferma.",
                                                  titolo: "la sessione di prova") { testoRacconto += $0 } audio: { audioRacconto += $0.count }
        XCTAssertFalse(racconto.isEmpty, "DeepSeek Pro o Agnes deve raccontare i dati")
        XCTAssertEqual(racconto, testoRacconto, "Il testo deve arrivare in streaming")
        XCTAssertGreaterThan(audioRacconto, 0, "Il racconto deve avere la voce ElevenLabs")
        XCTAssertEqual(telefono.turni.count, turniPrimaDelRacconto, "Il racconto non entra nella conversazione")

        telefono.impostaPerProva(provider: "deepseek", impegno: "rapido")
        let deepseek = try await telefono.rispondi("Dì soltanto: prova DeepSeek riuscita.", voce: false) { _ in }
        XCTAssertFalse(deepseek.isEmpty, "DeepSeek deve rispondere direttamente all'iPhone")
    }
}
