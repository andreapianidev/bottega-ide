import XCTest
@testable import Bottega

final class VercelStackTests: XCTestCase {
    func testInventarioIncludeProgettiSenzaPubblicazioneOCartella() throws {
        let data = Data(#"{"aggiornatoAt":1000,"parziale":false,"aggiornando":false,"totale":1,"progetti":[{"id":"prj_cloud","name":"cloud","localPaths":[],"state":"NONE","label":"nessuna produzione","tone":"attesa","at":0,"url":"https://vercel.com/dashboard"}]}"#.utf8)
        let d = try JSONDecoder().decode(StanzaVercel.self, from: data)
        XCTAssertEqual(d.progetti.count, 1)
        XCTAssertTrue(d.progetti[0].localPaths.isEmpty)
        XCTAssertNil(d.progetti[0].commit)
        XCTAssertEqual(d.progetti[0].state, "NONE")
    }

    func testClientiCompatibiliConPontePrecedente() throws {
        let data = Data(#"{"mese":"2026-10","mesi":["2026-10"],"inCorso":true,"configurati":0,"clienti":[],"fuori":[],"totale":{"minuti":0}}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(StanzaClienti.self, from: data).stack)
    }

    func testClientiRicevonoStackAncheSenzaOre() throws {
        let data = Data(#"{"mese":"2026-10","mesi":[],"inCorso":true,"configurati":1,"clienti":[],"fuori":[],"totale":{"minuti":0},"stack":{"githubAt":1000,"vercelAt":1000,"partial":false,"assets":[{"id":"github:example/app","name":"App","repo":"example/app","clientId":"c","vercel":[]}]}}"#.utf8)
        let d = try JSONDecoder().decode(StanzaClienti.self, from: data)
        XCTAssertEqual(d.stack?.assets.first?.clientId, "c")
        XCTAssertEqual(d.stack?.assets.first?.repo, "example/app")
    }

    func testLinkEsterniSoloHTTPS() {
        XCTAssertNotNil(linkStack("https://github.com/example/app"))
        XCTAssertNil(linkStack("javascript:alert(1)"))
        XCTAssertNil(linkStack("file:///etc/passwd"))
        XCTAssertNil(linkStack("https://token@example.test"))
    }
}
