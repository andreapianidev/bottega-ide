import XCTest
@testable import Bottega

/// Le regole dei riempitivi (docs/CONTRATTI.md, 9.11), le stesse della mod melissa e della barra della Bottega.
/// Senza simulatore: `scripts/test-ios-personaggi.sh`.
final class RiempitiviTests: XCTestCase {
    func testIntento() {
        // sfogo prima di tutto, anche dentro una domanda o un ordine
        XCTAssertEqual(Riempitivi.intento("Cazzo, non funziona niente"), .sfogo)
        XCTAssertEqual(Riempitivi.intento("perché non va?"), .sfogo)
        XCTAssertEqual(Riempitivi.intento("che palle questo build"), .sfogo)
        XCTAssertEqual(Riempitivi.intento("si è rotto di nuovo"), .sfogo)
        XCTAssertEqual(Riempitivi.intento("sono stufo"), .sfogo)
        // "non va" solo come parola intera
        XCTAssertNotEqual(Riempitivi.intento("non vado da nessuna parte"), .sfogo)
        XCTAssertEqual(Riempitivi.intento("ahahah che scemo"), .battuta)
        XCTAssertEqual(Riempitivi.intento("stavo scherzando"), .battuta)
        XCTAssertEqual(Riempitivi.intento("rido da solo"), .battuta)
        XCTAssertNotEqual(Riempitivi.intento("ridammi Melissa"), .battuta)
        XCTAssertEqual(Riempitivi.intento("apri il progetto Talky"), .ordine)
        XCTAssertEqual(Riempitivi.intento("Melissa, fammi un riassunto"), .ordine)
        XCTAssertEqual(Riempitivi.intento("dai, ok, controlla la build"), .ordine)
        XCTAssertEqual(Riempitivi.intento("senti ascolta puoi chiamare Marco?"), .ordine)
        XCTAssertEqual(Riempitivi.intento("voglio che tu lo legga"), .ordine)
        XCTAssertEqual(Riempitivi.intento("mi serve una mano"), .ordine)
        // "fai" come parola intera: "faidate" non e' un ordine
        XCTAssertEqual(Riempitivi.intento("faidate"), .chiacchiera)
        XCTAssertEqual(Riempitivi.intento("come stai"), .domanda)
        XCTAssertEqual(Riempitivi.intento("e perché lo fa"), .domanda)
        XCTAssertEqual(Riempitivi.intento("ma secondo te funziona"), .domanda)
        XCTAssertEqual(Riempitivi.intento("c'è qualcosa di nuovo"), .domanda)
        XCTAssertEqual(Riempitivi.intento("oggi piove?"), .domanda)
        // "chi" come parola intera: "chiave" no
        XCTAssertEqual(Riempitivi.intento("chiave nuova importata"), .chiacchiera)
        XCTAssertEqual(Riempitivi.intento("oggi sono contento"), .chiacchiera)
    }

    func testTema() {
        let esclusi = ["Melissa", "Andrea", "Darlene", "Elliot", "Krista"]
        XCTAssertEqual(Riempitivi.tema("come va il lavoro su Talky?", esclusi: esclusi), "Talky")
        // a inizio frase la maiuscola non dice niente
        XCTAssertNil(Riempitivi.tema("Oggi piove. Domani anche", esclusi: esclusi))
        XCTAssertEqual(Riempitivi.tema("Oggi piove. Domani vado a Tijarafe.", esclusi: esclusi), "Tijarafe")
        // i nomi di chi parla non sono temi, e servono tre lettere
        XCTAssertNil(Riempitivi.tema("senti Melissa, chiedi a Darlene di Andrea", esclusi: esclusi))
        XCTAssertNil(Riempitivi.tema("ho visto Al ieri", esclusi: esclusi))
        XCTAssertEqual(Riempitivi.tema("parlavo con Elliot di \"Bottega\", sai", esclusi: esclusi), "Bottega")
    }

    private let propri = FrasiRiempitivo(domanda: ["D1", "D2", "D3", "D4", "D5"], chiacchiera: ["C1", "C2"],
                                         lunga: ["L1"], eco: ["{x}? Vediamo."])
    private let melissa = FrasiRiempitivo(domanda: ["MD"], ordine: ["MO1", "MO2"], sfogo: ["MS"], battuta: ["MB"],
                                          chiacchiera: ["MC"], lunga: ["ML"], eco: ["Ah, {x}."])

    func testSceltaEAntiRipetizione() {
        // caso sceglie fra i candidati
        XCTAssertEqual(Riempitivi.scegli(propri, melissa: melissa, gruppo: .domanda, recenti: [], caso: 0, caso2: 1)?.frase, "D1")
        XCTAssertEqual(Riempitivi.scegli(propri, melissa: melissa, gruppo: .domanda, recenti: [], caso: 0.99, caso2: 1)?.frase, "D5")
        // fuori le ultime min(3, n - 1) dette da quella voce
        XCTAssertEqual(Riempitivi.scegli(propri, melissa: melissa, gruppo: .domanda, recenti: ["D1", "D2", "D3", "D4"],
                                         caso: 0, caso2: 1)?.frase, "D1",
                       "le ultime tre sono D2, D3, D4: D1 torna fra i candidati")
        XCTAssertEqual(Riempitivi.scegli(propri, melissa: melissa, gruppo: .domanda, recenti: ["D2", "D3", "D4"],
                                         caso: 0.99, caso2: 1)?.frase, "D5")
        XCTAssertEqual(Riempitivi.scegli(propri, melissa: melissa, gruppo: .domanda, recenti: ["D1", "D5", "D2"],
                                         caso: 0, caso2: 1)?.frase, "D3")
        // con due frasi se ne esclude una, con una nessuna
        XCTAssertEqual(Riempitivi.scegli(propri, melissa: melissa, gruppo: .chiacchiera, recenti: ["C1"], caso: 0, caso2: 1)?.frase, "C2")
        XCTAssertEqual(Riempitivi.scegli(propri, melissa: melissa, gruppo: .lunga, recenti: ["L1"], caso: 0, caso2: 1)?.frase, "L1")
    }

    func testRipieghi() {
        // gruppo vuoto: il suo chiacchiera
        XCTAssertEqual(Riempitivi.scegli(propri, melissa: melissa, gruppo: .ordine, recenti: [], caso: 0, caso2: 1)?.frase, "C1")
        // senza niente di suo: lo stesso gruppo di Melissa
        XCTAssertEqual(Riempitivi.scegli(nil, melissa: melissa, gruppo: .ordine, recenti: [], caso: 0.99, caso2: 1)?.frase, "MO2")
        XCTAssertEqual(Riempitivi.scegli(FrasiRiempitivo(), melissa: melissa, gruppo: .sfogo, recenti: [], caso: 0, caso2: 1)?.frase, "MS")
        XCTAssertNil(Riempitivi.scegli(nil, melissa: nil, gruppo: .domanda, recenti: []))
        // le frasi da preparare seguono gli stessi ripieghi, senza l'eco
        let fisse = Riempitivi.fisse(propri, melissa: melissa)
        XCTAssertEqual(Set(fisse), ["D1", "D2", "D3", "D4", "D5", "C1", "C2", "L1"])
        XCTAssertEqual(Set(Riempitivi.fisse(nil, melissa: melissa)), ["MD", "MO1", "MO2", "MS", "MB", "MC", "ML"])
    }

    func testEco() {
        let esclusi = ["Melissa", "Andrea"]
        let e = Riempitivi.scegli(propri, melissa: melissa, gruppo: .domanda, recenti: [], testo: "come va con Talky?",
                                  esclusi: esclusi, caso: 0, caso2: 0.1)
        XCTAssertEqual(e?.frase, "Talky? Vediamo.")
        XCTAssertEqual(e?.modello, "{x}? Vediamo.")
        XCTAssertEqual(e?.eco, true)
        // caso2 >= 0.25: niente eco
        XCTAssertEqual(Riempitivi.scegli(propri, melissa: melissa, gruppo: .domanda, recenti: [], testo: "come va con Talky?",
                                         esclusi: esclusi, caso: 0, caso2: 0.25)?.eco, false)
        // niente tema, niente eco
        XCTAssertEqual(Riempitivi.scegli(propri, melissa: melissa, gruppo: .domanda, recenti: [], testo: "come va?",
                                         caso: 0, caso2: 0)?.frase, "D1")
        // sfogo, battuta e lunga non fanno eco
        XCTAssertEqual(Riempitivi.scegli(propri, melissa: melissa, gruppo: .lunga, recenti: [], testo: "e Talky?",
                                         caso: 0, caso2: 0)?.eco, false)
        XCTAssertEqual(Riempitivi.scegli(nil, melissa: melissa, gruppo: .sfogo, recenti: [], testo: "che palle Talky",
                                         caso: 0, caso2: 0)?.frase, "MS")
        // senza eco proprie, quelle di Melissa; per l'anti-ripetizione conta il modello
        let m = Riempitivi.scegli(FrasiRiempitivo(chiacchiera: ["C"]), melissa: melissa, gruppo: .ordine, recenti: [],
                                  testo: "apri il progetto Talky", caso: 0, caso2: 0)
        XCTAssertEqual(m?.frase, "Ah, Talky.")
        XCTAssertEqual(m?.modello, "Ah, {x}.")
    }

    func testSenzaAttacco() {
        XCTAssertEqual(Riempitivi.senzaAttacco("Allora, la build e' passata."), "La build e' passata.")
        XCTAssertEqual(Riempitivi.senzaAttacco("Mh. Ok, ci guardo io."), "Ci guardo io.")
        XCTAssertEqual(Riempitivi.senzaAttacco("mmh... ecco: tre errori."), "Tre errori.")
        XCTAssertEqual(Riempitivi.senzaAttacco("Beh, sì, funziona."), "Funziona.")
        XCTAssertEqual(Riempitivi.senzaAttacco("Allora la cosa e' questa."), "Allora la cosa e' questa.")
        XCTAssertEqual(Riempitivi.senzaAttacco("Okay!"), "Okay!")
        XCTAssertEqual(Riempitivi.senzaAttacco("Ecco."), "Ecco.")
        XCTAssertEqual(Riempitivi.senzaAttacco("Ok, è fatto."), "È fatto.")
    }

    func testTempi() {
        XCTAssertEqual(Riempitivi.tempi, [.milliseconds(900), .seconds(5), .seconds(10)])
    }

    func testFrasiVereSenzaLineette() {
        var tutte = Riempitivi.fisse(Personaggi.riempitiviMelissa, melissa: Personaggi.riempitiviMelissa)
        tutte += Personaggi.riempitiviMelissa?.eco ?? []
        for k in Personaggi.ordine {
            tutte += Riempitivi.fisse(Personaggi.riempitivi(di: k), melissa: Personaggi.riempitiviMelissa)
            tutte += Personaggi.riempitivi(di: k)?.eco ?? []
        }
        XCTAssertFalse(tutte.isEmpty)
        for f in tutte {
            XCTAssertFalse(f.contains("\u{2014}") || f.contains("\u{2013}"), f)
        }
    }
}
