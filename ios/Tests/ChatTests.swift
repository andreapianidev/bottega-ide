import XCTest
@testable import Bottega

/// La logica della chat di Moony per iPhone (ios/Bottega/Chat/ChatPura.swift): catalogo dei modelli, schede, tagli
/// verso il ponte, titoli, allegati, markdown e zip dei documenti. Senza simulatore: `scripts/test-ios-chat.sh`.
final class ChatTests: XCTestCase {

    // MARK: modelli

    func testCatalogoUgualeAlMac() {
        // stessi id, nomi e ordine di ChatModelStore.catalog su Moony AI per Mac (4.0.2)
        XCTAssertEqual(ModelloChat.catalogo.map(\.id), [
            "deepseek-flash", "deepseek-v4-pro", "vision",
            "agnes-3.0-flash", "agnes-3.0-pro", "agnes-vision", "agnes-2.5-flash", "agnes-2.5-pro-beta", "agnes-2.5-pro-alpha",
            "mistral-small-latest", "mistral-medium-latest", "mistral-large-latest", "mistral-vision", "codestral-latest",
            "ministral-14b-latest", "ministral-8b-latest", "ministral-3b-latest", "zai-glm-latest"])
        XCTAssertEqual(ModelloChat.catalogo.map(\.nome), [
            "Flash", "Pro", "Vision", "Agnes 3.0 Flash", "Agnes 3.0 Pro", "Agnes Vision", "Agnes 2.5 Flash",
            "Agnes 2.5 Pro beta", "Agnes 2.5 Pro alpha", "Mistral Small", "Mistral Medium", "Mistral Large", "Mistral Vision",
            "Codestral", "Ministral 14B", "Ministral 8B", "Ministral 3B", "GLM (Z.ai)"])
        XCTAssertEqual(ModelloChat.catalogo.filter(\.vede).map(\.id), ["vision", "agnes-vision", "mistral-vision"])
        // ogni modello col fornitore che il suo nome dice
        for m in ModelloChat.catalogo { XCTAssertEqual(ModelloChat.Fornitore.di(modello: m.modello), m.fornitore, m.id) }
        // raggruppati per fornitore, nell'ordine del menu
        let fornitori = ModelloChat.catalogo.map(\.fornitore)
        XCTAssertEqual(fornitori, fornitori.sorted { ModelloChat.Fornitore.allCases.firstIndex(of: $0)! < ModelloChat.Fornitore.allCases.firstIndex(of: $1)! })
    }

    func testGliIdDiPrimaSiConvertono() {
        XCTAssertEqual(ModelloChat.con("flash").id, "deepseek-flash")
        XCTAssertEqual(ModelloChat.con("pro").id, "deepseek-v4-pro")
        XCTAssertEqual(ModelloChat.con("mistral-large").id, "mistral-large-latest")
        XCTAssertEqual(ModelloChat.con("codestral").id, "codestral-latest")
        XCTAssertEqual(ModelloChat.con("vision").id, "vision")
        // uno sconosciuto vale Flash
        XCTAssertEqual(ModelloChat.con("agnes-9-ultra").id, "deepseek-flash")
    }

    func testMistralSenzaReasoningEffort() {
        XCTAssertTrue(ModelloChat.Fornitore.deepseek.ragiona)
        XCTAssertTrue(ModelloChat.Fornitore.agnes.ragiona)
        XCTAssertFalse(ModelloChat.Fornitore.mistral.ragiona)
        XCTAssertEqual(ModelloChat.Fornitore.mistral.url, "https://api.mistral.ai/v1/chat/completions")
        XCTAssertEqual(ModelloChat.Fornitore.agnes.url, "https://apihub.agnes-ai.com/v1/chat/completions")
    }

    func testChiRispondeDavvero() {
        let large = ModelloChat.con("mistral-large-latest")
        // la voce parla sempre con Flash, qualunque sia la scelta
        XCTAssertEqual(ModelloChat.risponde(scelto: large, voce: true, immagini: false).id, "deepseek-flash")
        XCTAssertEqual(ModelloChat.risponde(scelto: ModelloChat.con("mistral-vision"), voce: true, immagini: true).id, "deepseek-flash")
        // per iscritto, la scelta
        XCTAssertEqual(ModelloChat.risponde(scelto: large, voce: false, immagini: false).id, "mistral-large-latest")
        // con le immagini guarda la Vision del fornitore scelto
        XCTAssertEqual(ModelloChat.risponde(scelto: ModelloChat.con("agnes-vision"), voce: false, immagini: true).id, "agnes-vision")
        XCTAssertEqual(ModelloChat.risponde(scelto: ModelloChat.con("mistral-vision"), voce: false, immagini: true).modello, "mistral-small-latest")
        // una scelta che non guarda, con immagini arrivate comunque: la Vision di DeepSeek
        XCTAssertEqual(ModelloChat.risponde(scelto: large, voce: false, immagini: true).id, "vision")
    }

    // MARK: consumi

    func testConsumiComeSulMac() {
        let cal = Calendar(identifier: .gregorian)
        let adesso = Date(timeIntervalSince1970: 1_792_000_000)
        let t = adesso.timeIntervalSince1970
        let chiamate = [
            ChiamataAI(at: t - 10, modello: "agnes-3.0-flash", input: 100, output: 50),
            ChiamataAI(at: t - 30, modello: "agnes-2.5-flash", input: 10, output: 5),
            ChiamataAI(at: t - 3600, modello: "agnes-3.0-flash", input: 1, output: 1),
            ChiamataAI(at: t - 20, modello: "mistral-small-latest", input: 1_000_000, output: 1_000_000),
            ChiamataAI(at: t - 20, modello: "zai-glm-latest", input: 1_000_000, output: 0),
            ChiamataAI(at: t - 5, modello: "deepseek-flash", input: 1, output: 1),
        ]
        let agnes = ConsumiAI.consumo(.agnes, chiamate: chiamate, adesso: adesso, calendario: cal)
        XCTAssertEqual(agnes.chiamateUltimoMinuto, 2)
        XCTAssertEqual(ConsumiAI.etichettaAgnes(agnes).testo, "Agnes 2/20 al min · \(agnes.chiamateOggi) oggi")
        XCTAssertFalse(ConsumiAI.etichettaAgnes(agnes).avviso)
        let mistral = ConsumiAI.consumo(.mistral, chiamate: chiamate, adesso: adesso, calendario: cal)
        // Small 0,15 + 0,60, GLM come Medium 1,50 in ingresso
        XCTAssertEqual(mistral.spesaMeseUSD, 0.75 + 1.50, accuracy: 1e-9)
        XCTAssertEqual(ConsumiAI.etichettaMistral(mistral).testo, "Mistral 2,07 € su 10 €")
        XCTAssertEqual(ConsumiAI.formatEuro(0.004), "meno di 1 cent")
        // giallo dall'80% del budget e da 16 chiamate al minuto
        let tante = (0..<16).map { ChiamataAI(at: t - Double($0), modello: "agnes-3.0-flash", input: 0, output: 0) }
        XCTAssertTrue(ConsumiAI.etichettaAgnes(ConsumiAI.consumo(.agnes, chiamate: tante, adesso: adesso, calendario: cal)).avviso)
        let cara = [ChiamataAI(at: t - 1, modello: "mistral-medium-latest", input: 0, output: 1_200_000)]
        XCTAssertTrue(ConsumiAI.etichettaMistral(ConsumiAI.consumo(.mistral, chiamate: cara, adesso: adesso, calendario: cal)).avviso)
        // il registro tiene 31 giorni
        XCTAssertEqual(ConsumiAI.pota([ChiamataAI(at: t - 40 * 86_400, modello: "x", input: 0, output: 0)], adesso: adesso), [])
    }

    // MARK: memoria condivisa

    func testLeChatDelMacEntranoFraIRecenti() {
        var s = SchedeChat.iniziale(inizio: 0, adesso: 0)
        let mia = s.attiva
        let uuid = UUID()
        s.unisci([
            ConversazioneVM(conversation_id: uuid.uuidString.lowercased(), title: "Preventivo per il B&B", started_at: 100,
                            last_at: 200, n: 4, last_source: "mac"),
            ConversazioneVM(conversation_id: "conv-storica-voce", title: "Ciao Moony", started_at: 50, last_at: 300, n: 9,
                            last_source: "mac"),
            ConversazioneVM(conversation_id: mia.uuidString.lowercased(), title: "Dall'iPhone", started_at: 0, last_at: 400, n: 2,
                            last_source: "iphone"),
        ])
        XCTAssertEqual(s.chat.count, 3)
        XCTAssertEqual(s.schede, [mia], "le chat del Mac vanno fra i recenti, non in una scheda")
        // un UUID resta l'id della chat; un id che non lo e' si tiene come id della VM
        XCTAssertEqual(s.chat.first { $0.id == uuid }?.idVM, uuid.uuidString.lowercased())
        let storica = s.chat.first { $0.vm == "conv-storica-voce" }
        XCTAssertEqual(storica?.idVM, "conv-storica-voce")
        XCTAssertEqual(storica?.titolo, "Ciao Moony")
        XCTAssertEqual(storica?.remoti, 9)
        XCTAssertEqual(s.chat.first { $0.id == mia }?.ultima, 400_000)
        // un secondo elenco non duplica
        s.unisci([ConversazioneVM(conversation_id: "conv-storica-voce", title: nil, started_at: 50, last_at: 500, n: 10, last_source: "mac")])
        XCTAssertEqual(s.chat.count, 3)
        XCTAssertEqual(s.chat.first { $0.vm == "conv-storica-voce" }?.remoti, 10)
    }

    func testITurniDellaVmNonSiDuplicano() {
        let mio = UUID().uuidString.lowercased()
        let locali = [MemoriaVM.Locale(id: mio, role: "user", content: "ciao", at: 100)]
        let righe = [
            // il mio turno, tornato dalla VM col mio event_id
            RigaVM(source: "iphone", role: "user", content: "ciao", persona: "melissa", speaker: "andrea", event_id: mio, created_at: 100),
            // la risposta detta sul Mac, con il suo event_id, due volte
            RigaVM(source: "mac", role: "assistant", content: "Ciao Andrea", persona: "melissa", speaker: "melissa", event_id: "e1", created_at: 101),
            RigaVM(source: "mac", role: "assistant", content: "Ciao Andrea", persona: "melissa", speaker: "melissa", event_id: "E1", created_at: 101),
            // senza event_id: uguale a uno locale entro 2 s, oppure nuovo
            RigaVM(source: "mac", role: "user", content: "ciao", persona: nil, speaker: nil, event_id: nil, created_at: 101.5),
            RigaVM(source: "mac", role: "user", content: "e domani?", persona: nil, speaker: nil, event_id: nil, created_at: 200),
            RigaVM(source: "mac", role: "user", content: "e domani?", persona: nil, speaker: nil, event_id: nil, created_at: 201),
            RigaVM(source: "mac", role: "user", content: "   ", persona: nil, speaker: nil, event_id: nil, created_at: 300),
        ]
        let nuovi = MemoriaVM.nuovi(righe, locali: locali)
        XCTAssertEqual(nuovi.map(\.content), ["Ciao Andrea", "e domani?"])
    }

    func testDiUnAllegatoSullaVmVaSoloLIntestazione() {
        let blocco = "[Allegato: fattura.pdf · PDF, 2 pagine]\nContenuto esterno allegato...\ntesto lungo"
        XCTAssertEqual(MemoriaVM.contenuto(blocco, esterno: true), "[Allegato: fattura.pdf · PDF, 2 pagine]")
        XCTAssertEqual(MemoriaVM.contenuto("una domanda\nsu due righe", esterno: false), "una domanda\nsu due righe")
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
