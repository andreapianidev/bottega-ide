import XCTest
@testable import Bottega

@MainActor
final class AvvisiTokenTests: XCTestCase {
    func testSpegnimentoInVoloNonSorpassaLaRiaccensioneEAttendeIlFlush() async throws {
        let primoInvio = expectation(description: "Spegnimento in rete")
        let riaccensioneAccodata = expectation(description: "Riaccensione accodata")
        let duplicatoAccodato = expectation(description: "Duplicato accodato")
        var sblocca: CheckedContinuation<Void, Error>?
        var inviati: [[String: String]] = []
        var salvati: [[String: String]] = []
        var secondoTerminato = false, duplicatoTerminato = false
        let coda = InvioTokenDispositivo(mandati: ["avvio": "prima"], invia: { campi in
            inviati.append(campi)
            if inviati.count == 1 {
                try await withCheckedThrowingContinuation { continuation in
                    sblocca = continuation
                    primoInvio.fulfill()
                }
            }
        }, conserva: { salvati.append($0) })
        let spento = Task { try await coda.manda(["avvio": "", "attivita": ""]) }
        await fulfillment(of: [primoInvio], timeout: 1)
        let acceso = Task {
            riaccensioneAccodata.fulfill()
            try await coda.manda(["avvio": "nuovo", "attivita": ""])
            secondoTerminato = true
        }
        await fulfillment(of: [riaccensioneAccodata], timeout: 1)
        let duplicato = Task {
            duplicatoAccodato.fulfill()
            try await coda.manda(["avvio": "nuovo", "attivita": ""])
            duplicatoTerminato = true
        }
        await fulfillment(of: [duplicatoAccodato], timeout: 1)
        XCTAssertEqual(inviati, [["avvio": "", "attivita": ""]], "Una sola POST in volo")
        XCTAssertFalse(secondoTerminato)
        XCTAssertFalse(duplicatoTerminato, "Anche il chiamante duplicato aspetta il flush precedente")
        XCTAssertEqual(coda.mandati["avvio"], "prima", "Non si confermano token prima dell'ACK")
        try XCTUnwrap(sblocca).resume()
        try await spento.value
        try await acceso.value
        try await duplicato.value
        XCTAssertEqual(inviati, [["avvio": "", "attivita": ""], ["avvio": "nuovo"]])
        XCTAssertEqual(salvati.map { $0["avvio"] }, ["", "nuovo"], "Il primo ACK conferma il proprio snapshot, non quello mutato dopo")
        XCTAssertEqual(coda.mandati["avvio"], "nuovo")
        XCTAssertTrue(secondoTerminato && duplicatoTerminato)
    }

    func testErroreNonConfermaTokenENonBloccaLaGenerazioneSuccessiva() async throws {
        enum Prova: Error { case rete }
        var tentativi = 0
        let coda = InvioTokenDispositivo(invia: { _ in
            tentativi += 1
            if tentativi == 1 { throw Prova.rete }
        })
        do {
            try await coda.manda(["avvio": "nuovo"])
            XCTFail("La prima richiesta deve fallire")
        } catch Prova.rete {}
        XCTAssertTrue(coda.mandati.isEmpty)
        try await coda.manda(["avvio": "nuovo"])
        XCTAssertEqual(tentativi, 2)
        XCTAssertEqual(coda.mandati["avvio"], "nuovo")
    }

    func testDimenticaScartaACKETokenAccodatiDelMacPrecedente() async throws {
        let inRete = expectation(description: "Vecchio Mac in rete")
        let accodato = expectation(description: "Vecchio token accodato")
        var sblocca: CheckedContinuation<Void, Error>?
        var inviati: [[String: String]] = []
        var salvati: [[String: String]] = []
        let coda = InvioTokenDispositivo(invia: { campi in
            inviati.append(campi)
            if inviati.count == 1 {
                try await withCheckedThrowingContinuation { continuation in
                    sblocca = continuation
                    inRete.fulfill()
                }
            }
        }, conserva: { salvati.append($0) })
        let vecchio = Task { try await coda.manda(["avvio": "vecchio-in-volo"]) }
        await fulfillment(of: [inRete], timeout: 1)
        let vecchioAccodato = Task {
            accodato.fulfill()
            try await coda.manda(["avvio": "vecchio-in-coda"])
        }
        await fulfillment(of: [accodato], timeout: 1)
        coda.dimentica()
        let nuovo = Task { try await coda.manda(["avvio": "nuovo-mac"]) }
        try XCTUnwrap(sblocca).resume()
        try await vecchio.value
        try await vecchioAccodato.value
        try await nuovo.value
        XCTAssertEqual(inviati.map { $0["avvio"] }, ["vecchio-in-volo", "nuovo-mac"], "Il token vecchio accodato non raggiunge il nuovo Mac")
        XCTAssertEqual(salvati, [["avvio": "nuovo-mac"]], "L'ACK vecchio non ripopola la memoria dopo dimentica")
        XCTAssertEqual(coda.mandati, ["avvio": "nuovo-mac"])
    }

    func testCongedoScartaLaCodaERimuovePerUltimoSenzaNuoviToken() async throws {
        let inRete = expectation(description: "Token gia' in rete")
        let accodato = expectation(description: "Secondo token in coda")
        let congedoAccodato = expectation(description: "Congedo accodato")
        var sblocca: CheckedContinuation<Void, Error>?
        var ordine: [String] = []
        var salvati: [[String: String]] = []
        let coda = InvioTokenDispositivo(invia: { campi in
            ordine.append(try XCTUnwrap(campi["avvio"]))
            if ordine.count == 1 {
                try await withCheckedThrowingContinuation { continuation in
                    sblocca = continuation
                    inRete.fulfill()
                }
            }
        }, conserva: { salvati.append($0) })
        let primo = Task { try await coda.manda(["avvio": "in-volo"]) }
        await fulfillment(of: [inRete], timeout: 1)
        let secondo = Task {
            accodato.fulfill()
            try await coda.manda(["avvio": "da-scartare"])
        }
        await fulfillment(of: [accodato], timeout: 1)
        let congedo = Task {
            congedoAccodato.fulfill()
            try await coda.congeda { ordine.append("rimuovi") }
        }
        await fulfillment(of: [congedoAccodato], timeout: 1)
        try await coda.manda(["avvio": "token-asincrono-durante-congedo"])
        XCTAssertEqual(ordine, ["in-volo"], "Il clear aspetta la POST gia' partita")
        try XCTUnwrap(sblocca).resume()
        try await primo.value
        try await secondo.value
        try await congedo.value
        try await coda.manda(["avvio": "token-asincrono-dopo-congedo"])
        XCTAssertEqual(ordine, ["in-volo", "rimuovi"], "Nessun token puo' riscrivere il clear")
        XCTAssertTrue(salvati.isEmpty, "Non si conserva l'ACK invalidato dal congedo")
        coda.dimentica()
        try await coda.manda(["avvio": "nuovo-abbinamento"])
        XCTAssertEqual(ordine, ["in-volo", "rimuovi", "nuovo-abbinamento"])
        XCTAssertEqual(coda.mandati, ["avvio": "nuovo-abbinamento"])
    }

    func testCambioMacDuranteCongedoScartaLaRimozioneAccodata() async throws {
        let inRete = expectation(description: "Vecchio Mac in rete")
        let congedoAccodato = expectation(description: "Rimozione accodata")
        var sblocca: CheckedContinuation<Void, Error>?
        var rimosso = false
        let coda = InvioTokenDispositivo(invia: { _ in
            try await withCheckedThrowingContinuation { continuation in
                sblocca = continuation
                inRete.fulfill()
            }
        })
        let primo = Task { try await coda.manda(["avvio": "vecchio"]) }
        await fulfillment(of: [inRete], timeout: 1)
        let congedo = Task {
            congedoAccodato.fulfill()
            try await coda.congeda { rimosso = true }
        }
        await fulfillment(of: [congedoAccodato], timeout: 1)
        coda.dimentica()
        try XCTUnwrap(sblocca).resume()
        try await primo.value
        try await congedo.value
        XCTAssertFalse(rimosso, "La rimozione del vecchio Mac non parte dopo un nuovo abbinamento")
    }

    func testTokenAttivitaToltoNonRiavviaDaSoloIlTokenDiAvvio() async throws {
        var inviati: [[String: String]] = []
        let coda = InvioTokenDispositivo(mandati: ["avvio": "start", "attivita": "live"], invia: { inviati.append($0) })
        try await coda.manda(["avvio": "start", "attivita": ""])
        try await coda.manda(["avvio": "start", "attivita": ""])
        XCTAssertEqual(inviati, [["attivita": ""]], "Dismiss manuale non simula off/on del token di avvio")
        XCTAssertEqual(coda.mandati["avvio"], "start")
    }
}
