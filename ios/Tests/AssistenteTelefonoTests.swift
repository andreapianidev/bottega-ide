import XCTest
@testable import Bottega

@MainActor
final class AssistenteTelefonoTests: XCTestCase {
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
