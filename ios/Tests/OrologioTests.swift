import XCTest
@testable import Bottega

final class OrologioTests: XCTestCase {
    private func copia(_ tempo: TimeInterval = 1000, attesa: Int = 1) -> IstantaneaOrologio {
        .init(visto: Date(timeIntervalSince1970: tempo), mac: "Mac", melissa: "idle",
              inCorso: 2, tiAspetta: attesa, totale: 3, sessioni: [])
    }

    func testReinstallazioneReinviaAncheContenutiInvariati() {
        var coda = CodaOrologio()
        coda.aggiorna(copia())
        coda.conferma()
        coda.aggiorna(copia(1001))
        XCTAssertNil(coda.pendente)
        coda.reinvia()
        XCTAssertEqual(coda.pendente, .istantanea(copia()))
        coda.conferma()
        coda.aggiorna(copia(1002), forza: true)
        XCTAssertEqual(coda.pendente, .istantanea(copia(1002)))
    }

    func testInvioFallitoRestaInCodaESiAggiornaAlDatoPiuRecente() {
        var coda = CodaOrologio()
        coda.aggiorna(copia())
        coda.aggiorna(copia(1001))
        XCTAssertEqual(coda.pendente, .istantanea(copia()))
        coda.aggiorna(copia(1002, attesa: 2))
        XCTAssertEqual(coda.pendente, .istantanea(copia(1002, attesa: 2)))
    }

    func testCancellazioneSopravviveAlCambioWatch() {
        var coda = CodaOrologio()
        coda.aggiorna(copia())
        coda.dimentica()
        coda.reinvia()
        XCTAssertNil(coda.ultima)
        XCTAssertEqual(coda.pendente, .dimentica)
        coda.conferma()
        coda.reinvia()
        XCTAssertEqual(coda.pendente, .dimentica)
        coda.aggiorna(copia(2000))
        XCTAssertEqual(coda.pendente, .istantanea(copia(2000)))
    }

    func testRispostaTardivaNonSovrascriveIlDatoRecente() {
        var coda = CodaOrologio()
        coda.aggiorna(copia(2000))
        coda.conferma()
        coda.aggiorna(copia(1000, attesa: 4), forza: true)
        XCTAssertEqual(coda.ultima, copia(2000))
        XCTAssertNil(coda.pendente)
    }

    func testHeartbeatNonRendeFrescoUnDatoVecchio() {
        var coda = CodaOrologio()
        coda.aggiorna(copia())
        coda.conferma()
        coda.aggiorna(copia(1599))
        XCTAssertNil(coda.pendente)
        coda.aggiorna(copia(1600))
        XCTAssertEqual(coda.pendente, .istantanea(copia(1600)))
        let vecchia = copia()
        XCTAssertFalse(vecchia.scaduta(al: Date(timeIntervalSince1970: 2199)))
        XCTAssertTrue(vecchia.scaduta(al: Date(timeIntervalSince1970: 2200)))
        XCTAssertTrue(vecchia.scaduta(al: Date(timeIntervalSince1970: 9000)))
    }
}
