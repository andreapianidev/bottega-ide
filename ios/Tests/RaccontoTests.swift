import XCTest
@testable import Bottega

@MainActor
final class RaccontoTests: XCTestCase {
    func testContestoPerTutteLeFontiESalvataggi() {
        for fonte in ["claude", "codex", "cline", "terminale"] {
            let a = StatoMac.Attivita(key: "\(fonte):1", source: fonte, project: "Prova",
                                     status: "sconosciuto", title: "Controlla i widget", summary: "Ha letto Swift",
                                     updatedAt: 1_000, steps: ["Ha eseguito i test"], evidence: "Registro locale")
            let vivo = ContestoRacconto.attivita(a, salvata: false)
            XCTAssertTrue(vivo.contains(a.fonte))
            XCTAssertTrue(vivo.contains(a.title))
            XCTAssertTrue(vivo.contains("Ha eseguito i test"))
            XCTAssertTrue(vivo.contains("non prova che il lavoro sia in corso"))
            XCTAssertTrue(ContestoRacconto.attivita(a, salvata: true).contains("non presentarlo come attuale"))
        }
    }

    func testSessioneSalvataNonDiventaUnaSessioneAttuale() {
        let l = StatoMac.Lavoro(chiave: "a", origine: "altrove", stato: "in corso", progetto: "Prova",
                               titolo: "Sistema Swift", da: 100, jobId: nil)
        let testo = ContestoRacconto.lavoroSalvato(l, ora: nil)
        XCTAssertTrue(testo.contains("Non presentarlo come attuale"))
        XCTAssertTrue(testo.contains("Sistema Swift"))
    }

    func testFermaPrimaDellaPartenzaNonAvviaReteOAudio() async {
        let r = Riassunto()
        r.avvia(titolo: "prova", contesto: "non inviare")
        r.ferma()
        await Task.yield()
        XCTAssertEqual(r.stato, .fermo)
        XCTAssertTrue(r.testo.isEmpty)
        XCTAssertNil(r.errore)
    }

    func testNuovoRaccontoFermaQuelloPrecedente() async {
        let prima = Riassunto(), dopo = Riassunto()
        prima.avvia(titolo: "prima", contesto: "non inviare")
        dopo.avvia(titolo: "dopo", contesto: "non inviare")
        XCTAssertEqual(prima.stato, .fermo)
        dopo.ferma()
        await Task.yield()
        XCTAssertNil(prima.errore)
        XCTAssertNil(dopo.errore)
    }
}
