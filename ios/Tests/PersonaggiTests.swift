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
        XCTAssertEqual(Personaggi.chiamata("Ha toccato le chiavi. Elliot, tu che dici?").ospite, "elliot")
        XCTAssertNil(Personaggi.chiamata("Darlene ti ha mai detto di no? Comunque ha finito.").ospite)
        XCTAssertNil(Personaggi.chiamata("Non so. Tu che dici?").ospite)
        // la stessa regola della mod e della Bottega: il nome conta solo se Melissa parla a lui
        XCTAssertEqual(Personaggi.chiamatoPerNome("Elliot... tu che dici?"), "elliot")
        XCTAssertEqual(Personaggi.chiamatoPerNome("Che ne pensi, Krista?"), "krista")
        XCTAssertEqual(Personaggi.chiamatoPerNome("Allora, Darlene?"), "darlene")
        XCTAssertNil(Personaggi.chiamatoPerNome("Ti ricordi quando Elliot ha bucato E Corp?"))
        XCTAssertNil(Personaggi.chiamatoPerNome("Vuoi che apra il file di Krista?"))
        XCTAssertEqual(Personaggi.chiamata("Scrivi a andrea@gmail.com. Elliot, che dici?").ospite, "elliot")
        XCTAssertEqual(Personaggi.senzaSegnale("Elliot, che dici? @dar"), "Elliot, che dici?")
    }

    /// La tabella di docs/CONTRATTI.md 9.11, uguale nei test della mod e della barra: chi e' interrogato risponde sempre.
    func testChiRispondeQuandoMelissaChiama() {
        let casi: [(String, String?)] = [
            ("Elliot, tu che dici?", "elliot"),
            ("Che ne pensi, Krista?", "krista"),
            ("Allora, Darlene?", "darlene"),
            ("Elliot... tu che dici?", "elliot"),
            ("Dai Krista, diglielo tu.", "krista"),
            ("E tu Krista che ne dici?", "krista"),
            ("Tocca a te, Krista.", "krista"),
            ("Krista, che ne pensi? Io dico di si'.", "krista"),
            ("Ehi Darlene ascolta questa.", "darlene"),
            ("Ok Elliot, ma tu cosa faresti?", "elliot"),
            ("Ti ricordi quando Elliot ha bucato E Corp?", nil),
            ("Vuoi che apra il file di Krista?", nil),
            ("Krista direbbe che sei pigro.", nil),
            ("Darlene, al posto tuo, avrebbe gia' litigato.", nil),
            ("Darlene ti ha mai detto di no? Comunque e' finita.", nil),
            ("Non so. Tu che dici?", nil),
            // "te" dopo il nome non chiama: parla di lei, non a lei
            ("Krista te lo sta dicendo da mezz'ora e tu fai lo gnorri.", nil),
            // un punto dentro una parola non taglia la frase: ".env" non diventa "." e "env"
            ("Hai guardato il file .env, Elliot?", "elliot"),
            ("Elliot, hai visto il file .env? Io no.", "elliot"),
            ("Darlene ha aperto il .env. Tu che dici?", nil),
            ("Sono sicura che Krista avrebbe qualcosa da dirti.", nil),
        ]
        for (battuta, chi) in casi {
            XCTAssertEqual(Personaggi.chiamatoPerNome(battuta), chi, battuta)
            XCTAssertEqual(Personaggi.chiamata(battuta).ospite, chi, battuta)
        }
        // l'invitato risponde se il suo nome c'e', ovunque
        XCTAssertEqual(Personaggi.chiamatoPerNome("Sono sicura che Krista avrebbe qualcosa da dirti.", invitato: "krista"), "krista")
        XCTAssertEqual(Personaggi.chiamata("Sono sicura che Krista avrebbe qualcosa da dirti.", invitato: "krista").ospite, "krista")
        // un altro invitato non cambia niente: la frase parla di Krista, non a lei
        XCTAssertNil(Personaggi.chiamata("Sono sicura che Krista avrebbe qualcosa da dirti.", invitato: "elliot").ospite)
        // il segnale vale ovunque, anche senza domanda
        XCTAssertEqual(Personaggi.chiamata("Krista direbbe che sei pigro. @krista").ospite, "krista")
    }

    func testMelissaNonEUnPersonaggio() {
        XCTAssertNil(Personaggi.tutti["melissa"])
        XCTAssertFalse(Personaggi.ordine.contains("melissa"))
        let m = try! XCTUnwrap(Personaggi.riempitiviMelissa)
        XCTAssertFalse(m.domanda.isEmpty)
        XCTAssertFalse(m.lunga.isEmpty)
        XCTAssertFalse(m.eco.isEmpty)
        XCTAssertEqual(Personaggi.riempitivi(di: "melissa"), m)
        for chiave in Personaggi.ordine {
            let r = try! XCTUnwrap(Personaggi.riempitivi(di: chiave), chiave)
            XCTAssertFalse(r.chiacchiera.isEmpty, chiave)
            XCTAssertTrue(r.eco.allSatisfy { $0.contains("{x}") }, chiave)
        }
        XCTAssertNil(Personaggi.chiChiede("passami Melissa").flatMap { Personaggi.tutti[$0] })
    }

    /// Prima del nome valgono anche vabbe', grazie, ciao, scusa, beh; e Andrea chiama in qualunque frase, senza domanda.
    func testVocativiNuoviEAndreaChiama() {
        XCTAssertEqual(Personaggi.chiamatoPerNome("Grazie Krista, tu che dici?"), "krista")
        XCTAssertEqual(Personaggi.chiamatoPerNome("Vabbè Darlene, dimmi tu."), "darlene")
        XCTAssertEqual(Personaggi.chiamatoPerNome("Beh Elliot? Che ne pensi?"), "elliot")
        // Andrea: basta il vocativo, in qualunque frase
        XCTAssertEqual(Personaggi.chiamatoPerNome("Vabbe' Elliot, hai ragione", daAndrea: true), "elliot")
        XCTAssertEqual(Personaggi.chiamatoPerNome("Ciao Darlene!", daAndrea: true), "darlene")
        XCTAssertEqual(Personaggi.chiamatoPerNome("Scusa Krista, hai ragione tu.", daAndrea: true), "krista")
        XCTAssertEqual(Personaggi.chiamatoPerNome("Elliot, hai ragione. Comunque domani vado al mare. Poi vediamo.", daAndrea: true), "elliot")
        XCTAssertNil(Personaggi.chiamatoPerNome("Ieri Elliot mi ha detto che il server era giu'.", daAndrea: true))
        XCTAssertNil(Personaggi.chiamatoPerNome("Ho riletto il file .env di Darlene.", daAndrea: true))
        // la stessa frase detta da Melissa, senza domanda ne' parole rivolte a qualcuno, non chiama
        XCTAssertNil(Personaggi.chiamatoPerNome("Elliot, hai ragione. Comunque domani vado al mare. Poi vediamo."))
    }

    /// Chi entra da solo (mod 0.16): dopo ogni risposta di Melissa senza ospite; appena dopo un ospite no, e alla
    /// prima risposta dopo non torna lo stesso per argomento. Deciso dopo due, o subito per argomento.
    func testPuoEntrare() {
        XCTAssertEqual(Personaggi.perArgomento("mi hanno rubato la password"), "elliot")
        XCTAssertEqual(Personaggi.perArgomento("lo faccio domani"), "krista")
        XCTAssertNil(Personaggi.perArgomento("che bel tramonto"))
        // appena dopo un ospite: mai
        XCTAssertFalse(Personaggi.puoEntrare("mi hanno rubato la password", dallUltimo: 0, ultimo: "darlene"))
        XCTAssertFalse(Personaggi.puoEntrare("che bel tramonto", dallUltimo: 0, ultimo: "darlene"))
        // una risposta dopo (o la prima della conversazione, il contatore parte da 1): si', ma non lo stesso per argomento
        XCTAssertTrue(Personaggi.puoEntrare("che bel tramonto", dallUltimo: 1, ultimo: nil))
        XCTAssertTrue(Personaggi.puoEntrare("che bel tramonto", dallUltimo: 1, ultimo: "darlene"))
        XCTAssertTrue(Personaggi.puoEntrare("mi hanno rubato la password", dallUltimo: 1, ultimo: "darlene"))
        XCTAssertFalse(Personaggi.puoEntrare("mi hanno rubato la password", dallUltimo: 1, ultimo: "elliot"))
        // due risposte dopo: chiunque, anche lo stesso
        XCTAssertTrue(Personaggi.puoEntrare("mi hanno rubato la password", dallUltimo: 2, ultimo: "elliot"))
        // invito deciso
        XCTAssertFalse(Personaggi.invitoDeciso("che bel tramonto", dallUltimo: 1, scelto: "darlene"))
        XCTAssertTrue(Personaggi.invitoDeciso("che bel tramonto", dallUltimo: 2, scelto: "darlene"))
        XCTAssertTrue(Personaggi.invitoDeciso("mi hanno rubato la password", dallUltimo: 1, scelto: "elliot"))
        XCTAssertFalse(Personaggi.invitoDeciso("mi hanno rubato la password", dallUltimo: 1, scelto: "krista"))
    }

    /// Parlano fra loro: nel 40% dei casi un ospite passa la parola a un altro, mai a se stesso ne' a chi l'ha chiamato.
    func testParlanoFraLoro() {
        XCTAssertEqual(Personaggi.altri(di: "elliot", daChi: nil), ["darlene", "krista"])
        XCTAssertEqual(Personaggi.altri(di: "elliot", daChi: "darlene"), ["krista"])
        let altri = Personaggi.altri(di: "elliot", daChi: nil)
        XCTAssertEqual(Personaggi.passa(fra: altri, ultima: false, caso: 0.39, caso2: 0), "darlene")
        XCTAssertEqual(Personaggi.passa(fra: altri, ultima: false, caso: 0, caso2: 0.99), "krista")
        XCTAssertNil(Personaggi.passa(fra: altri, ultima: false, caso: 0.4, caso2: 0))
        XCTAssertNil(Personaggi.passa(fra: altri, ultima: true, caso: 0, caso2: 0))
        XCTAssertNil(Personaggi.passa(fra: [], ultima: false, caso: 0, caso2: 0))
        // quello a cui chiede risponde: e' l'invitato, quindi basta il nome
        XCTAssertEqual(Personaggi.chiamata("Io la vedo cosi'. Krista direbbe il contrario.", invitato: "krista").ospite, "krista")
        XCTAssertEqual(Personaggi.chiamata("Io la vedo cosi'. Tu che ne pensi, Darlene?").ospite, "darlene")
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
