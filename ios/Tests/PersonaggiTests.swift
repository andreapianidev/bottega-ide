import XCTest
@testable import Bottega

/// Le frasi che passano la chiamata e lo strumento passa_parola: stesse regole della Bottega (docs/CONTRATTI.md, 9.11).
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

    /// Chi risponde lo dice lo strumento passa_parola, mai un nome nel testo (docs/CONTRATTI.md, 9.11): la stessa forma
    /// della Bottega.
    func testPassaParola() throws {
        let t = Personaggi.strumentoPassaParola(["elliot", "krista"])
        let f = try XCTUnwrap(t["function"] as? [String: Any])
        XCTAssertEqual(f["name"] as? String, "passa_parola")
        let par = try XCTUnwrap(f["parameters"] as? [String: Any])
        let a = try XCTUnwrap((par["properties"] as? [String: Any])?["a"] as? [String: Any])
        XCTAssertEqual(a["enum"] as? [String], ["elliot", "krista"])
        XCTAssertEqual(par["required"] as? [String], ["a"])
        XCTAssertNotNil(try? JSONSerialization.data(withJSONObject: t), "si manda com'e' nel corpo della richiesta")
        XCTAssertEqual(Personaggi.passaParolaA(#"{"a": "elliot", "perche": "le chiavi"}"#, offerte: ["elliot", "krista"]), "elliot")
        XCTAssertEqual(Personaggi.passaParolaA(#"{"a": "Krista"}"#, offerte: ["elliot", "krista"]), "krista")
        XCTAssertNil(Personaggi.passaParolaA(#"{"a": "darlene"}"#, offerte: ["elliot", "krista"]), "solo tra gli offerti")
        XCTAssertNil(Personaggi.passaParolaA(#"{"a": "ell"#, offerte: ["elliot"]), "JSON rotto: nessuno")
        XCTAssertNil(Personaggi.passaParolaA(nil, offerte: ["elliot"]))
        let chiama = Personaggi.chiamaCon("elliot")
        XCTAssertTrue(chiama.hasPrefix("Nella stessa risposta fai due cose"))
        XCTAssertTrue(chiama.contains("passa_parola con a = elliot"))
        XCTAssertEqual(Personaggi.chiamaCon("nessuno"), "")
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
    }

    func testInvito() {
        XCTAssertEqual(Personaggi.invito(scelto: nil), "")
        let uno = Personaggi.invito(scelto: "elliot")
        XCTAssertTrue(uno.contains("passa_parola con a = elliot"))
        XCTAssertFalse(uno.contains("@"))
        XCTAssertFalse(uno.contains("\u{2014}"))
        XCTAssertTrue(uno.contains("Solo quando"))
        let vivo = Personaggi.invito(scelto: "krista", vivo: true)
        XCTAssertTrue(vivo.contains("Stavolta tira dentro Krista"))
        XCTAssertTrue(vivo.contains("passa_parola con a = krista"))
        // a ognuno si chiede dal suo campo, a Krista il lato umano: lo stesso testo della Bottega (9.11)
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
        XCTAssertNil(Personaggi.perFatto("che bel tramonto"))
    }

    /// Il nome esatto passa subito nel codice; un nome capito male o un soprannome li capisce il modello (ChiVuole),
    /// niente elenchi di nomi storpiati (9.11).
    func testNomeEsattoNelCodice() {
        XCTAssertEqual(Personaggi.chiChiede("passami Krista"), "krista")
        // dal registro del 6 ottobre: nel codice non passano, li capisce il modello (anche "chiedi a Krista")
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
