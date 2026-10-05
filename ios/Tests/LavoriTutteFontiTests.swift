import Foundation
import XCTest
@testable import Bottega

final class LavoriTutteFontiTests: XCTestCase {
    private func attivita(_ key: String, _ source: String, _ status: String,
                          progetto: String, alle: Double = 100) -> StatoMac.Attivita {
        .init(key: key, source: source, project: progetto, status: status,
              title: "Prova", summary: nil, updatedAt: alle)
    }

    private func stato(_ attivita: [StatoMac.Attivita]?) -> StatoMac {
        .init(versione: "95", mac: "Mac", ora: 1000,
              melissa: .init(stato: "idle", cervello: "", parziale: nil, registro: []),
              lavori: [], conti: .init(inCorso: 99, tiAspetta: 98, inCoda: 7, vive: 100),
              quadroLavori: .init(progetti: [.init(nome: "Solo Claude", conteggio: 99)], giorni: []),
              attivita: attivita)
    }

    func testKPITutteFontiNonUsanoContatoriClaude() throws {
        let s = stato([
            attivita("claude:a", "claude", "in corso", progetto: "A"),
            attivita("codex:a", "codex", "in corso", progetto: "B"),
            attivita("cline:a", "cline", "ti aspetta", progetto: "B"),
            attivita("terminale:a", "terminale", "in corso", progetto: "C"),
            attivita("cline:b", "cline", "errore", progetto: "D"),
            attivita("codex:b", "codex", "sconosciuto", progetto: "E"),
            attivita("claude:b", "claude", "finito", progetto: "F"),
        ])
        let q = try XCTUnwrap(QuadroAttivitaLavori(stato: s))
        XCTAssertEqual(q.inCorso, 3)
        XCTAssertEqual(q.tiAspetta, 1)
        XCTAssertEqual(q.errori, 1)
        XCTAssertEqual(q.sconosciute, 1)
        XCTAssertEqual(q.finite, 1)
        XCTAssertEqual(q.progetti.map(\.nome), ["B", "A", "C"])
        XCTAssertEqual(q.progetti.map(\.conteggio), [2, 1, 1])
        XCTAssertEqual(q.inCorso, s.conteggiAttivita.inCorso)
    }

    func testVuotoAutorevoleNonResuscitaProgettiClaudeEFallbackLegacy() throws {
        XCTAssertNil(QuadroAttivitaLavori(stato: stato(nil)))
        let q = try XCTUnwrap(QuadroAttivitaLavori(stato: stato([])))
        XCTAssertEqual(q.inCorso, 0)
        XCTAssertEqual(q.tiAspetta, 0)
        XCTAssertTrue(q.progetti.isEmpty)
    }

    func testUltimoStatoVinceEProgettiSonoLimitatiACinque() throws {
        var rows = (0..<7).map { attivita("codex:\($0)", "codex", "in corso", progetto: "P\($0)") }
        rows.append(attivita("codex:0", "codex", "finito", progetto: "P0", alle: 200))
        let q = try XCTUnwrap(QuadroAttivitaLavori(stato: stato(rows)))
        XCTAssertEqual(q.inCorso, 6)
        XCTAssertEqual(q.finite, 1)
        XCTAssertEqual(q.progetti.count, 5)
        XCTAssertFalse(q.progetti.contains { $0.nome == "P0" })
    }

    func testProgettiOmonimiRestanoSeparatiAncheConStessoGenitore() throws {
        var a = attivita("codex:a", "codex", "in corso", progetto: "Faro")
        a.path = "/cliente-a/app/Faro"
        var b = attivita("cline:b", "cline", "ti aspetta", progetto: "Faro")
        b.path = "/cliente-b/app/Faro"
        var c = attivita("claude:c", "claude", "in corso", progetto: "Faro")
        c.path = a.path
        let s = stato([a, b, c])
        let copia = try JSONDecoder().decode(StatoMac.self, from: JSONEncoder().encode(s))
        let q = try XCTUnwrap(QuadroAttivitaLavori(stato: copia))
        XCTAssertEqual(q.progetti.map(\.conteggio), [2, 1])
        XCTAssertEqual(q.progetti.map(\.nome), ["Faro · /cliente-a/app", "Faro · /cliente-b/app"])
        XCTAssertEqual(copia.sessioniWidget.first { $0.id == a.key }?.path, a.path)
    }

    func testFiniteNonSchiaccianoLeBarreAttuali() throws {
        let rows = [attivita("codex:attivo", "codex", "in corso", progetto: "A")]
            + (0..<196).map { attivita("codex:finito-\($0)", "codex", "finito", progetto: "A") }
        let q = try XCTUnwrap(QuadroAttivitaLavori(stato: stato(rows)))
        XCTAssertEqual(q.finite, 196)
        XCTAssertEqual(q.statiDaSeguire.map(\.1).max(), 1)
        XCTAssertFalse(q.statiDaSeguire.contains { $0.0 == "Finite" })
    }

    func testPercorsoMancanteRestaCompatibileESiDistingueDaQuelloNoto() {
        let a = ProgettoLavori(nome: "Faro", path: nil)
        let b = ProgettoLavori(nome: "Faro", path: "/lavoro/Faro")
        let etichette = ProgettoLavori.etichette([a, b])
        XCTAssertNotEqual(a.id, b.id)
        XCTAssertEqual(etichette[a.id], "Faro · percorso non disponibile")
        XCTAssertEqual(etichette[b.id], "Faro · /lavoro")
    }
}
