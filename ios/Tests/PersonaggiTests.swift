import XCTest
@testable import Bottega

/// Le frasi che passano la chiamata e il segnale "@darlene": stesse regole della mod melissa.
/// Senza simulatore: `scripts/test-ios-personaggi.sh`.
final class PersonaggiTests: XCTestCase {
    func testChiChiedePassaLaChiamata() {
        XCTAssertEqual(Personaggi.chiChiede("Passami Darlene"), "darlene")
        XCTAssertEqual(Personaggi.chiChiede("fammi parlare con Krista per favore"), "krista")
        XCTAssertEqual(Personaggi.chiChiede("passa a Elliot"), "elliot")
        XCTAssertEqual(Personaggi.chiChiede("voglio parlare con mr robot"), "elliot")
        XCTAssertEqual(Personaggi.chiChiede("ok, ridammi Melissa"), "melissa")
        XCTAssertNil(Personaggi.chiChiede("Darlene e' simpatica"))
        XCTAssertNil(Personaggi.chiChiede("passami il sale"))
    }

    func testOspiteChiesto() {
        XCTAssertEqual(Personaggi.ospiteChiesto("chiedi a Darlene cosa ne pensa"), "darlene")
        XCTAssertEqual(Personaggi.ospiteChiesto("Sentiamo anche Elliot"), "elliot")
        XCTAssertEqual(Personaggi.ospiteChiesto("e cosa ne pensa Krista?"), "krista")
        XCTAssertNil(Personaggi.ospiteChiesto("chiedi a Marco"))
    }

    func testChiamataTogliIlSegnale() {
        let c = Personaggi.chiamata("Io dico di si'. Tu che dici, Darlene? @darlene")
        XCTAssertEqual(c.testo, "Io dico di si'. Tu che dici, Darlene?")
        XCTAssertEqual(c.ospite, "darlene")
        let m = Personaggi.chiamata("Chiediamolo a lui @Elliot. Ecco.")
        XCTAssertEqual(m.testo, "Chiediamolo a lui Ecco.")
        XCTAssertEqual(m.ospite, "elliot")
        let n = Personaggi.chiamata("Niente ospiti stavolta.")
        XCTAssertEqual(n.testo, "Niente ospiti stavolta.")
        XCTAssertNil(n.ospite)
        XCTAssertEqual(Personaggi.senzaSegnale("@krista."), "")
    }

    func testInvito() {
        XCTAssertEqual(Personaggi.invito(voluto: nil, scelto: nil), "")
        XCTAssertTrue(Personaggi.invito(voluto: "krista", scelto: "elliot").contains("@krista"))
        let uno = Personaggi.invito(voluto: nil, scelto: "elliot")
        XCTAssertTrue(uno.contains("@elliot"))
        XCTAssertFalse(uno.contains("@darlene"))
        XCTAssertFalse(uno.contains("\u{2014}"))
        XCTAssertTrue(uno.contains("Solo quando"))
        let vivo = Personaggi.invito(voluto: nil, scelto: "krista", vivo: true)
        XCTAssertTrue(vivo.contains("Stavolta tira dentro Krista"))
        XCTAssertTrue(vivo.contains("@krista"))
    }

    func testAdattoSceglieIlCodiceNonIlModello() {
        XCTAssertEqual(Personaggi.adatto("ho paura che mi rubino la password", ultimo: "elliot", caso: 0), "elliot")
        XCTAssertEqual(Personaggi.adatto("lo faccio domani, sono stanco", ultimo: nil, caso: 0), "krista")
        XCTAssertEqual(Personaggi.adatto("che ne dici del film", ultimo: "darlene", caso: 0), "elliot")
        XCTAssertEqual(Personaggi.adatto("che ne dici del film", ultimo: "darlene", caso: 0.99), "krista")
        XCTAssertEqual(Personaggi.adatto("che ne dici del film", ultimo: nil, caso: 0), "darlene")
    }

    func testOgniPersonaggioHaVoceESaluti() {
        for chiave in Personaggi.ordine {
            let p = try! XCTUnwrap(Personaggi.tutti[chiave])
            XCTAssertFalse(p.voce.isEmpty)
            XCTAssertFalse(p.saluti.isEmpty)
            XCTAssertFalse(Personaggi.sistema(p).contains("\u{2014}"))
        }
        XCTAssertEqual(Personaggi.nome("melissa"), "Melissa")
    }
}
