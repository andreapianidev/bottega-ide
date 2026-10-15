import XCTest
@testable import Bottega

/// La logica della chat di Moony per iPhone (ios/Bottega/Chat/ChatPura.swift): catalogo dei modelli, schede, tagli
/// verso il ponte, titoli, allegati, markdown e zip dei documenti. Senza simulatore: `scripts/test-ios-chat.sh`.
final class ChatTests: XCTestCase {

    // MARK: modelli

    func testCatalogoUgualeAlMac() {
        // stesso ordine e stessi nomi di ChatModelStore su Moony AI per Mac
        XCTAssertEqual(ModelloChat.catalogo.map(\.nome), ["Flash", "Pro", "Vision", "Agnes 3.0 Flash", "Agnes 2.5 Flash",
                                                          "Mistral Small", "Mistral Medium", "Mistral Large", "Codestral"])
        XCTAssertEqual(ModelloChat.catalogo.map(\.modello), ["deepseek-flash", "deepseek-v4-pro", "deepseek-flash",
                                                             "agnes-3.0-flash", "agnes-2.5-flash", "mistral-small-latest",
                                                             "mistral-medium-latest", "mistral-large-latest", "codestral-latest"])
        XCTAssertEqual(Set(ModelloChat.catalogo.map(\.id)).count, ModelloChat.catalogo.count, "id doppi")
        // raggruppati per fornitore, nell'ordine del menu
        let fornitori = ModelloChat.catalogo.map(\.fornitore)
        XCTAssertEqual(fornitori, fornitori.sorted { ModelloChat.Fornitore.allCases.firstIndex(of: $0)! < ModelloChat.Fornitore.allCases.firstIndex(of: $1)! })
    }

    func testMistralSenzaReasoningEffort() {
        XCTAssertTrue(ModelloChat.Fornitore.deepseek.ragiona)
        XCTAssertTrue(ModelloChat.Fornitore.agnes.ragiona)
        XCTAssertFalse(ModelloChat.Fornitore.mistral.ragiona)
        XCTAssertEqual(ModelloChat.Fornitore.mistral.url, "https://api.mistral.ai/v1/chat/completions")
        XCTAssertEqual(ModelloChat.Fornitore.agnes.url, "https://apihub.agnes-ai.com/v1/chat/completions")
    }

    func testChiRispondeDavvero() {
        let large = ModelloChat.con("mistral-large")
        // la voce parla sempre con Flash, qualunque sia la scelta
        XCTAssertEqual(ModelloChat.risponde(scelto: large, voce: true, immagini: false).id, "flash")
        XCTAssertEqual(ModelloChat.risponde(scelto: ModelloChat.con("pro"), voce: true, immagini: false).id, "flash")
        // per iscritto, la scelta
        XCTAssertEqual(ModelloChat.risponde(scelto: large, voce: false, immagini: false).id, "mistral-large")
        // con le immagini arrivate al modello, Vision
        XCTAssertEqual(ModelloChat.risponde(scelto: ModelloChat.con("vision"), voce: false, immagini: true).id, "vision")
        XCTAssertEqual(ModelloChat.risponde(scelto: large, voce: false, immagini: true).id, "vision")
        // una scelta sconosciuta (da un'altra versione) vale Flash
        XCTAssertEqual(ModelloChat.con("agnes-3.5-pro").id, "flash")
    }

    // MARK: schede

    func testChatNuovaQuandoQuellaApertaEVuotaNonSiMoltiplica() {
        var s = SchedeChat.iniziale(inizio: 0, adesso: 1)
        let prima = s.attiva
        s.nuova(adesso: 2) { _ in true }
        XCTAssertEqual(s.attiva, prima)
        XCTAssertEqual(s.schede, [prima])
    }

    func testPiuApreUnaSchedaNuova() {
        var s = SchedeChat.iniziale(inizio: 0, adesso: 1)
        let prima = s.attiva
        s.registra(in: prima, chi: "tu", testo: "Come va il deploy di stasera?", adesso: 2)
        s.nuova(adesso: 3) { $0 != prima }
        XCTAssertEqual(s.schede.count, 2)
        XCTAssertNotEqual(s.attiva, prima)
        XCTAssertEqual(s.chat.first { $0.id == prima }?.titolo, "Come va il deploy di stasera?")
        XCTAssertEqual(s.chatAttiva?.nomeScheda, "Nuova chat")
    }

    func testAlPiuOttoSchedeLaNonaChiudeLaPiuVecchiaNonAttiva() {
        var s = SchedeChat.iniziale(inizio: 0, adesso: 0)
        var piene: Set<UUID> = []
        for i in 1...9 {
            piene.insert(s.attiva)
            s.registra(in: s.attiva, chi: "tu", testo: "domanda \(i)", adesso: Double(i))
            s.nuova(adesso: Double(i)) { !piene.contains($0) }
        }
        XCTAssertEqual(s.schede.count, SchedeChat.massimo)
        XCTAssertTrue(s.schede.contains(s.attiva))
        // le chat chiuse restano
        XCTAssertEqual(s.chat.count, 10)
        XCTAssertFalse(s.schede.contains(s.chat.last!.id), "la piu' vecchia non e' piu' in una scheda")
    }

    func testAprireUnaChatGiaApertaNonDuplicaLaScheda() {
        var s = SchedeChat.iniziale(inizio: 0, adesso: 0)
        let prima = s.attiva
        s.registra(in: prima, chi: "tu", testo: "uno", adesso: 1)
        s.nuova(adesso: 2) { $0 != prima }
        s.apri(prima)
        XCTAssertEqual(s.schede.count, 2)
        XCTAssertEqual(s.attiva, prima)
    }

    func testChiudereLaSchedaAttivaPassaAllaVicina() {
        var s = SchedeChat.iniziale(inizio: 0, adesso: 0)
        let a = s.attiva
        s.registra(in: a, chi: "tu", testo: "a", adesso: 1)
        s.nuova(adesso: 2) { $0 != a }
        let b = s.attiva
        s.registra(in: b, chi: "tu", testo: "b", adesso: 3)
        s.chiudi(b, adesso: 4) { $0 != a && $0 != b }
        XCTAssertEqual(s.attiva, a)
        XCTAssertEqual(s.schede, [a])
        XCTAssertTrue(s.chat.contains { $0.id == b }, "chiudere la scheda non cancella la chat")
    }

    /// Il difetto trovato nell'audit del 16/10/2026: chiudere l'unica scheda, se vuota, lasciava la fila senza schede.
    func testChiudereLUltimaSchedaVuotaNeApreUnaNuova() {
        var s = SchedeChat.iniziale(inizio: 0, adesso: 0)
        let unica = s.attiva
        s.chiudi(unica, adesso: 1) { _ in true }
        XCTAssertEqual(s.schede.count, 1)
        XCTAssertTrue(s.schede.contains(s.attiva))
        XCTAssertNotEqual(s.attiva, unica)
        XCTAssertNotNil(s.chatAttiva)
    }

    func testCancellareUnaChatApertaLasciaSempreUnaScheda() {
        var s = SchedeChat.iniziale(inizio: 0, adesso: 0)
        let unica = s.attiva
        s.registra(in: unica, chi: "tu", testo: "x", adesso: 1)
        s.togli(unica, adesso: 2) { $0 != unica }
        XCTAssertFalse(s.chat.contains { $0.id == unica })
        XCTAssertEqual(s.schede.count, 1)
        XCTAssertNotNil(s.chatAttiva)
    }

    func testLeRigheDelMacVannoNellaChatNataPerUltimaPrimaDiLoro() {
        var s = SchedeChat.iniziale(inizio: 100, adesso: 100)
        let a = s.attiva
        s.registra(in: a, chi: "tu", testo: "a", adesso: 150)
        s.nuova(adesso: 200) { $0 != a }
        let b = s.attiva
        XCTAssertEqual(s.chat(perRigaDelle: 150), a)
        XCTAssertEqual(s.chat(perRigaDelle: 250), b)
        XCTAssertNil(s.chat(perRigaDelle: 50), "prima di ogni chat: in nessuna")
    }

    func testLeSchedeSiRicordanoFraUnAvvioELAltro() throws {
        var s = SchedeChat.iniziale(inizio: 0, adesso: 0)
        let a = s.attiva
        s.registra(in: a, chi: "tu", testo: "a", adesso: 1)
        s.nuova(adesso: 2) { $0 != a }
        var letto = try JSONDecoder().decode(SchedeChat.self, from: JSONEncoder().encode(s))
        XCTAssertTrue(letto.normalizza())
        XCTAssertEqual(letto, s)
        // una scheda di una chat sparita si toglie; un'attiva sparita fa ripartire da capo
        letto.schede.append(UUID())
        XCTAssertTrue(letto.normalizza())
        XCTAssertEqual(letto.schede, s.schede)
        letto.attiva = UUID()
        XCTAssertFalse(letto.normalizza())
    }

    func testIlTitoloEDellaPrimaDomandaNonDiMoony() {
        var s = SchedeChat.iniziale(inizio: 0, adesso: 0)
        s.registra(in: s.attiva, chi: "melissa", testo: "Ciao Andrea", adesso: 1)
        XCTAssertEqual(s.chatAttiva?.titolo, "")
        s.registra(in: s.attiva, chi: "tu", testo: "Prima riga\nseconda riga", adesso: 2)
        XCTAssertEqual(s.chatAttiva?.titolo, "Prima riga")
        s.registra(in: s.attiva, chi: "tu", testo: "un'altra domanda", adesso: 3)
        XCTAssertEqual(s.chatAttiva?.titolo, "Prima riga")
        XCTAssertEqual(s.chatAttiva?.ultima, 3)
    }

    // MARK: testo

    func testTagliaContaComeIlPonte() {
        XCTAssertEqual(TestoChat.taglia("ciao"), "ciao")
        XCTAssertEqual(TestoChat.taglia(String(repeating: "a", count: 2500)).utf16.count, 2000)
        // un'emoji vale due unita' UTF-16, come `length` in JavaScript
        let emoji = String(repeating: "😀", count: 1000)
        XCTAssertEqual(TestoChat.taglia(emoji), emoji)
        let troppe = String(repeating: "😀", count: 1001)
        XCTAssertEqual(TestoChat.taglia(troppe).utf16.count, 2000)
        // non si spezza un'emoji a meta'
        let dispari = "a" + troppe
        let t = TestoChat.taglia(dispari)
        XCTAssertEqual(t.utf16.count, 1999)
        XCTAssertTrue(t.hasSuffix("😀"))
        XCTAssertNotNil(t.data(using: .utf8))
    }

    func testTitoloCorto() {
        XCTAssertEqual(TestoChat.titolo("breve"), "breve")
        let lungo = String(repeating: "x", count: 60)
        XCTAssertEqual(TestoChat.titolo(lungo).count, 48)
        XCTAssertTrue(TestoChat.titolo(lungo).hasSuffix("…"))
    }

    func testNomeDellAllegato() {
        XCTAssertEqual(TestoChat.nomeAllegato(in: "[Allegato: fattura.pdf · PDF, 2 pagine]\nContenuto esterno..."), "fattura.pdf")
        XCTAssertEqual(TestoChat.nomeAllegato(in: "[Allegato: note]\ntesto"), "note")
        XCTAssertNil(TestoChat.nomeAllegato(in: "Una domanda normale"))
        XCTAssertNil(TestoChat.nomeAllegato(in: "[Allegato: senza chiusura\n"))
    }

    func testTestoDaXMLDiWord() {
        let xml = "<w:document><w:body><w:p><w:r><w:t>Primo &amp; secondo</w:t></w:r></w:p>" +
            "<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b &lt;c&gt;</w:t></w:r></w:p></w:body></w:document>"
        XCTAssertEqual(TestoChat.testoDaXML(xml), "Primo & secondo\na\tb <c>\n")
    }

    func testMarkdownInBlocchi() {
        let b = TestoChat.blocchi("# Titolo\n\nRiga uno\n- punto\n  * sotto\n\n```\nlet x = 1\n```\nfine")
        XCTAssertEqual(b, [.titolo("Titolo", livello: 1), .paragrafo("Riga uno\n• punto\n  • sotto"),
                           .codice("let x = 1"), .paragrafo("fine")])
        // un blocco di codice non chiuso resta codice
        XCTAssertEqual(TestoChat.blocchi("```\naperto"), [.codice("aperto")])
        XCTAssertEqual(TestoChat.blocchi("#nontitolo"), [.paragrafo("#nontitolo")])
    }

    // MARK: zip

    #if os(macOS)
    /// Un docx vero e un odt veri, fatti con /usr/bin/zip: salvati e compressi con deflate.
    func testZipLeggeDocxEOdt() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("chat-zip-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("word"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let documento = "<w:document><w:body>" + String(repeating: "<w:p><w:r><w:t>Riga di prova</w:t></w:r></w:p>", count: 200) +
            "</w:body></w:document>"
        try documento.write(to: dir.appendingPathComponent("word/document.xml"), atomically: true, encoding: .utf8)
        try "<content/>".write(to: dir.appendingPathComponent("content.xml"), atomically: true, encoding: .utf8)
        for (nome, livello) in [("compresso.docx", "-9"), ("salvato.docx", "-0")] {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
            p.currentDirectoryURL = dir
            p.arguments = ["-q", livello, nome, "word/document.xml", "content.xml"]
            try p.run()
            p.waitUntilExit()
            XCTAssertEqual(p.terminationStatus, 0)
            let zip = try Data(contentsOf: dir.appendingPathComponent(nome))
            let letto = try XCTUnwrap(Zip.leggi("word/document.xml", in: zip), nome)
            XCTAssertEqual(String(data: letto, encoding: .utf8), documento, nome)
            XCTAssertEqual(Zip.leggi("content.xml", in: zip).flatMap { String(data: $0, encoding: .utf8) }, "<content/>")
            XCTAssertNil(Zip.leggi("manca.xml", in: zip))
            XCTAssertTrue(TestoChat.testoDaXML(String(data: letto, encoding: .utf8)!).hasPrefix("Riga di prova\nRiga di prova\n"))
        }
    }
    #endif

    func testZipRifiutaCioCheNonEUnoZip() {
        XCTAssertNil(Zip.leggi("word/document.xml", in: Data()))
        XCTAssertNil(Zip.leggi("word/document.xml", in: Data(repeating: 0x50, count: 100)))
        XCTAssertNil(Zip.leggi("word/document.xml", in: Data("non sono uno zip ma sono lungo abbastanza".utf8)))
    }
}
