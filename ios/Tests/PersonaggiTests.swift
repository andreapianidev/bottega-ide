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
        // a ognuno si chiede dal suo campo, a Krista il lato umano: lo stesso testo della mod e della Bottega (9.11)
        let elliot = Personaggi.tutti["elliot"]!
        XCTAssertTrue(uno.contains("chiedi a Elliot solo dal suo campo (\(elliot.ruoloCronaca))"))
        XCTAssertFalse(uno.contains("lato umano"))
        XCTAssertTrue(vivo.contains("il lato umano anche di un fatto tecnico, mai dettagli di file, errori o comandi che non puo' sapere"))
        XCTAssertNotEqual(elliot.ruoloCronaca, elliot.ruolo, "ruolo_cronaca letto dal file")
        XCTAssertFalse(vivo.contains("\u{2014}") || vivo.contains("\u{2013}"))
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

    /// Ognuno nel suo campo (9.11): senza `parole`, a caso entra o riceve la parola solo chi ha `chiacchiera` (oggi
    /// tutti e tre, Krista compresa); lo sfogo di Andrea, le sue parole e il nome scelgono Krista (`umore`).
    func testChiacchieraEUmore() throws {
        for k in ["darlene", "elliot", "krista"] { XCTAssertTrue(Personaggi.inChiacchiera(k), k) }
        XCTAssertTrue(try XCTUnwrap(Personaggi.tutti["krista"]).occasioni.contains("umore"))
        // Krista puo' uscire a caso, da adatto e da passa
        XCTAssertEqual(Personaggi.adatto("che bel tramonto", ultimo: "darlene", caso: 0.99), "krista")
        XCTAssertEqual(Personaggi.passa(fra: ["darlene", "krista"], ultima: false, caso: 0, caso2: 0.99), "krista")
        // un personaggio senza `chiacchiera` non esce mai a caso
        let json = #"{"chiave":"prova","nome":"Prova","carattere":"Sei Prova.","saluti":["Ciao."],"occasioni":["umore"]}"#
        let prova = try JSONDecoder().decode(Personaggio.self, from: Data(json.utf8))
        let elliot = try XCTUnwrap(Personaggi.tutti["elliot"])
        for caso in stride(from: 0.0, to: 1.0, by: 0.05) {
            for ultimo in [nil, "elliot", "prova"] {
                XCTAssertEqual(Personaggi.adatto("che bel tramonto", ultimo: ultimo, caso: caso, fra: [prova, elliot]), "elliot")
            }
            XCTAssertEqual(Personaggi.passa(fra: ["prova", "elliot"], ultima: false, caso: 0, caso2: caso), "elliot")
        }
        XCTAssertNil(Personaggi.adatto("che bel tramonto", ultimo: nil, caso: 0, fra: [prova]))
        XCTAssertNil(Personaggi.passa(fra: ["prova"], ultima: false, caso: 0, caso2: 0))
        // le sue parole
        XCTAssertEqual(Personaggi.adatto("lo faccio domani", ultimo: "krista", caso: 0), "krista")
        // uno sfogo
        XCTAssertEqual(Personaggi.perFatto("che palle, non funziona niente"), "krista")
        XCTAssertEqual(Personaggi.adatto("che palle, non funziona niente", ultimo: "elliot", caso: 0), "krista")
        XCTAssertTrue(Personaggi.invitoDeciso("che palle, non funziona niente", dallUltimo: 1, scelto: "krista"))
        XCTAssertFalse(Personaggi.puoEntrare("che palle", dallUltimo: 1, ultimo: "krista"))
        // chiamata per nome
        XCTAssertEqual(Personaggi.chiamata("Krista, tu che ne pensi?").ospite, "krista")
        XCTAssertEqual(Personaggi.chiamatoPerNome("Vabbe' Krista, hai ragione", daAndrea: true), "krista")
        XCTAssertEqual(Personaggi.ospiteChiesto("chiedi a Krista"), "krista")
        XCTAssertNil(Personaggi.perFatto("che bel tramonto"))
    }

    /// Il nome esatto passa subito nel codice; un nome capito male o un soprannome li capisce il modello (ChiVuole),
    /// niente elenchi di nomi storpiati (9.11, mod 0.18.3). "chiedi" accetta anche al, alla, allo, all'.
    func testNomeEsattoNelCodice() {
        XCTAssertEqual(Personaggi.chiChiede("passami Krista"), "krista")
        XCTAssertEqual(Personaggi.ospiteChiesto("chiedi alla Krista cosa ne pensa"), "krista")
        XCTAssertEqual(Personaggi.ospiteChiesto("chiedete all'Elliot"), "elliot")
        XCTAssertEqual(Personaggi.ospiteChiesto("e tu Elliot che ne dici"), "elliot")
        XCTAssertEqual(Personaggi.ospiteChiesto("chiedi a Darlene"), "darlene")
        // dal registro del 6 ottobre: nel codice non passano, li capisce il modello
        XCTAssertNil(Personaggi.chiChiede("Passami Cristal Vista"))
        XCTAssertNil(Personaggi.chiChiede("Passami la nostra amica psicologa"))
    }

    /// La parte pura di chiVuole: il prompt con chiave, nome e ruolo, e la lettura del JSON del modello.
    func testChiVuole() {
        let chiavi = Personaggi.ordine
        let prompt = ChiVuole.prompt(Personaggi.ordine.compactMap { Personaggi.tutti[$0] })
        for k in chiavi {
            let p = Personaggi.tutti[k]!
            XCTAssertTrue(prompt.contains("- \(k): \(p.nome), \(p.ruolo)"))
        }
        XCTAssertTrue(prompt.contains("solo con il JSON"))
        // sempre DeepSeek Flash, mai Agnes, come nella mod e nella Bottega
        XCTAssertEqual(ChiVuole.modello, "deepseek-flash")
        XCTAssertEqual(ChiVuole.url, "https://api.deepseek.com/chat/completions")
        XCTAssertEqual(ChiVuole.maxToken, 40)
        XCTAssertFalse(prompt.contains("\u{2014}"))
        XCTAssertFalse(prompt.contains("\u{2013}"))
        // JSON valido
        XCTAssertEqual(ChiVuole.leggi(#"{"passa": "krista", "chiede": null}"#, chiavi: chiavi), ChiVuole(passa: "krista"))
        XCTAssertEqual(ChiVuole.leggi(#"{"passa": null, "chiede": "elliot"}"#, chiavi: chiavi), ChiVuole(passa: nil, chiede: ["elliot"]))
        XCTAssertEqual(ChiVuole.leggi(#"{"passa":"melissa","chiede":null}"#, chiavi: chiavi), ChiVuole(passa: "melissa"))
        XCTAssertEqual(ChiVuole.leggi("```json\n{\"passa\": \"Darlene\", \"chiede\": null}\n```", chiavi: chiavi),
                       ChiVuole(passa: "darlene"))
        XCTAssertEqual(ChiVuole.leggi(#"{"passa": null, "chiede": null}"#, chiavi: chiavi)?.riga, "nessuno")
        // una chiave che non c'e' vale null; "melissa" non si chiede
        XCTAssertEqual(ChiVuole.leggi(#"{"passa": "marta", "chiede": "melissa"}"#, chiavi: chiavi), ChiVuole(passa: nil))
        // JSON rotto vale null
        XCTAssertNil(ChiVuole.leggi(#"{"passa": "krista", "chiede"#, chiavi: chiavi))
        XCTAssertNil(ChiVuole.leggi("passa a Krista", chiavi: chiavi))
        XCTAssertNil(ChiVuole.leggi("", chiavi: chiavi))
    }

    /// Il giro a piu' voci e la regia di Melissa (docs/CONTRATTI.md, 9.11): i due esempi veri del 6 ottobre, letti come li
    /// darebbe il modello, portano a una regia di Melissa e poi alle battute di tutti.
    func testGiroAPiuVociERegia() {
        let chiavi = Personaggi.ordine
        let prompt = ChiVuole.prompt(Personaggi.ordine.compactMap { Personaggi.tutti[$0] })
        XCTAssertTrue(prompt.contains(#"siamo io te e altri» = {"passa": "elliot", "chiede": [], "tutti": true}"#))
        XCTAssertTrue(prompt.contains(#"parla con gli altri» = {"passa": null, "chiede": ["krista"], "tutti": true}"#))
        // primo esempio: la chiamata passa a Elliot, che parla per primo, poi gli altri; Melissa non tira le somme
        let uno = ChiVuole.leggi(#"{"passa": "elliot", "chiede": [], "tutti": true}"#, chiavi: chiavi)
        XCTAssertEqual(uno, ChiVuole(passa: "elliot", tutti: true))
        XCTAssertEqual(uno?.riga, "passa elliot, tutti")
        let g1 = Personaggi.giroDiVoci(uno, conVoce: chiavi, conLaChiamata: "melissa")
        XCTAssertEqual(g1.voci, ["elliot", "darlene", "krista"])
        XCTAssertFalse(g1.chiude)
        XCTAssertTrue(Personaggi.regia(passa: "elliot", voci: g1.voci).contains("passa la chiamata a Elliot e annuncia che dopo parlano anche gli altri"))
        // secondo: Krista per prima, poi gli altri, e Melissa apre il giro e tira le somme
        let due = ChiVuole.leggi(#"{"passa": null, "chiede": ["Krista"], "tutti": true}"#, chiavi: chiavi)
        XCTAssertEqual(due?.riga, "chiede krista, tutti")
        let g2 = Personaggi.giroDiVoci(due, conVoce: chiavi, conLaChiamata: "melissa")
        XCTAssertEqual(g2.voci, ["krista", "darlene", "elliot"])
        XCTAssertTrue(g2.chiude)
        let apre = Personaggi.regia(voci: g2.voci)
        XCTAssertTrue(apre.contains("Andrea vuole sentire Krista, Darlene e Elliot, uno dopo l'altro"))
        XCTAssertTrue(apre.contains("Krista, comincia tu"))
        XCTAssertTrue(Personaggi.regia(chiede: "krista").contains("Andrea vuole il parere di Krista"))
        XCTAssertEqual(Personaggi.regia(), "")
        // il JSON di prima, con una chiave sola, vale un elenco di uno: niente giro; due chiesti fanno un giro
        let vecchio = ChiVuole.leggi(#"{"passa": null, "chiede": "elliot"}"#, chiavi: chiavi)
        XCTAssertEqual(vecchio, ChiVuole(passa: nil, chiede: ["elliot"]))
        XCTAssertTrue(Personaggi.giroDiVoci(vecchio, conVoce: chiavi, conLaChiamata: "melissa").voci.isEmpty)
        XCTAssertEqual(Personaggi.giroDiVoci(ChiVuole(passa: nil, chiede: ["elliot", "krista"]), conVoce: chiavi, conLaChiamata: "melissa").voci,
                       ["elliot", "krista"])
        // con un personaggio al telefono il giro sono gli altri, e Melissa non chiude
        let g3 = Personaggi.giroDiVoci(ChiVuole(passa: nil, tutti: true), conVoce: chiavi, conLaChiamata: "darlene")
        XCTAssertEqual(g3.voci, ["elliot", "krista"])
        XCTAssertFalse(g3.chiude)
        XCTAssertNil(ChiVuole.leggi(#"{"tutti": tru"#, chiavi: chiavi))
        // ognuno dal suo campo, il successivo sapendo cosa hanno detto quelli prima
        XCTAssertTrue(Personaggi.istruzioneGiro("krista", primo: true).contains("il lato umano anche di un fatto tecnico"))
        XCTAssertTrue(Personaggi.istruzioneGiro("elliot", primo: false).contains("non ripeterlo, aggiungi la tua"))
        XCTAssertFalse(Personaggi.istruzioneGiro("elliot", primo: true).contains("non ripeterlo"))
        // Melissa non rifiuta, nessuno ripete gli altri
        XCTAssertTrue(Personaggi.regolaRegia.contains("non ti rifiuti mai"))
        XCTAssertTrue(Personaggi.regolaRegia.contains("centralino"))
        XCTAssertTrue(Personaggi.regole.contains(Personaggi.nonRipetere))
        for t in [apre, Personaggi.regolaRegia, Personaggi.nonRipetere, prompt] {
            XCTAssertFalse(t.contains("\u{2014}") || t.contains("\u{2013}"))
        }
    }

    /// `occasioni` e' facoltativo: un file senza il campo vale [] e si legge lo stesso.
    func testOccasioniFacoltative() throws {
        let senza = #"{"chiave":"prova","nome":"Prova","carattere":"Sei Prova.","saluti":["Ciao."]}"#
        XCTAssertEqual(try JSONDecoder().decode(Personaggio.self, from: Data(senza.utf8)).occasioni, [])
        let con = #"{"chiave":"prova","nome":"Prova","carattere":"Sei Prova.","saluti":["Ciao."],"occasioni":["rischio","fine"]}"#
        XCTAssertEqual(try JSONDecoder().decode(Personaggio.self, from: Data(con.utf8)).occasioni, ["rischio", "fine"])
        XCTAssertFalse(try XCTUnwrap(Personaggi.tutti["elliot"]).occasioni.isEmpty)
    }

    /// Ognuno ricorda le sue ultime 5 battute delle ultime 12 ore, con la forma del file del Mac (9.11).
    func testDettiUltimeCinqueInDodiciOre() throws {
        let nome = "detti-prova-\(UUID().uuidString)"
        let difesa = try XCTUnwrap(UserDefaults(suiteName: nome))
        defer { difesa.removePersistentDomain(forName: nome) }
        let ora: Double = 1_800_000_000_000
        XCTAssertEqual(Detti.prompt(di: "elliot", adesso: ora, in: difesa), "")
        Detti.ricorda("Vecchia.", di: "elliot", adesso: ora - 13 * 3600 * 1000, in: difesa)
        for i in 1...6 { Detti.ricorda("Battuta \(i).", di: "elliot", adesso: ora + Double(i), in: difesa) }
        Detti.ricorda("Ciao Andrea.", di: "melissa", adesso: ora, in: difesa)
        XCTAssertEqual(Detti.recenti(di: "elliot", adesso: ora + 10, in: difesa),
                       ["Battuta 2.", "Battuta 3.", "Battuta 4.", "Battuta 5.", "Battuta 6."])
        XCTAssertEqual(Detti.recenti(di: "melissa", adesso: ora + 10, in: difesa), ["Ciao Andrea."])
        // dopo 12 ore non conta piu'
        XCTAssertEqual(Detti.recenti(di: "melissa", adesso: ora + 12 * 3600 * 1000, in: difesa), [])
        // al massimo 5 per chiave anche su disco, nella forma {chiave: [{at, testo, dove}]}
        let grezzo = try XCTUnwrap(difesa.data(forKey: Detti.chiave))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: grezzo) as? [String: [[String: Any]]])
        XCTAssertEqual(json["elliot"]?.count, 5)
        XCTAssertEqual(json["melissa"]?.first?["testo"] as? String, "Ciao Andrea.")
        XCTAssertNotNil(json["melissa"]?.first?["at"] as? Double)
        XCTAssertNotNil(json["melissa"]?.first?["dove"] as? String)
        let riga = Detti.prompt(di: "melissa", adesso: ora + 10, in: difesa)
        XCTAssertTrue(riga.hasPrefix("Hai detto di recente (non ripeterti, niente battute o immagini uguali): "))
        XCTAssertTrue(riga.contains("Ciao Andrea."))
        XCTAssertFalse(riga.contains("\u{2014}"))
    }
}
