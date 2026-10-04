import Foundation
import XCTest
@testable import Bottega

final class CruscottoAttivitaTests: XCTestCase {
    private func attivita(_ key: String, _ source: String, _ status: String, alle: Double = 100) -> StatoMac.Attivita {
        .init(key: key, source: source, project: "Prova", status: status,
              title: "Attività di prova", summary: nil, updatedAt: alle)
    }

    private func stato(_ attivita: [StatoMac.Attivita]?, ora: Double = 1_791_140_000_000) -> StatoMac {
        .init(versione: "95", mac: "Mac", ora: ora,
              melissa: .init(stato: "idle", cervello: "", parziale: nil, registro: []),
              lavori: [.init(chiave: "legacy", origine: "bottega", stato: "in corso", progetto: "Prova",
                             titolo: "Sessione precedente", da: 50, jobId: nil)],
              conti: .init(inCorso: 99, tiAspetta: 98, inCoda: 0, vive: 100), attivita: attivita)
    }

    func testRiepilogoIncludeQuattroFontiEDeduplicaComeWidget() throws {
        let s = stato([
            attivita("claude:a", "claude", "in corso"),
            attivita("codex:a", "codex", "in corso"),
            attivita("codex:a", "codex", "finito", alle: 200),
            attivita("cline:a", "cline", "errore"),
            attivita("terminale:a", "terminale", "ti aspetta"),
        ])
        let r = try XCTUnwrap(RiepilogoAttivitaCruscotto(stato: s, salvato: false))
        XCTAssertEqual(r.fonti.map(\.nome), ["Claude Code", "Codex", "Cline", "Terminale"])
        XCTAssertEqual(r.fonti.map(\.totale), [1, 1, 1, 1])
        XCTAssertEqual(r.totale, s.conteggiAttivita.totale)
        XCTAssertEqual(r.inCorso, 1)
        XCTAssertEqual(r.tiAspetta, 1)
        XCTAssertEqual(r.fonti[2].errori, 1)
        XCTAssertEqual(r.fonti[1].inCorso, 0, "Il duplicato più vecchio non resuscita una sessione finita")
    }

    func testOfflineConservaIstanteDelloSnapshotENonOraDelTelefono() throws {
        let s = stato([attivita("codex:a", "codex", "in corso")], ora: 1_700_000_123_000)
        let r = try XCTUnwrap(RiepilogoAttivitaCruscotto(stato: s, salvato: true))
        XCTAssertTrue(r.salvato)
        XCTAssertEqual(r.visto.timeIntervalSince1970, 1_700_000_123)
        XCTAssertEqual(r.inCorso, 1)
    }

    func testRegistroVuotoENilSonoDistinti() throws {
        XCTAssertNil(RiepilogoAttivitaCruscotto(stato: stato(nil), salvato: true), "Legacy non equivale a zero per tutte le fonti")
        let r = try XCTUnwrap(RiepilogoAttivitaCruscotto(stato: stato([]), salvato: false))
        XCTAssertEqual(r.totale, 0)
        XCTAssertEqual(r.inCorso, 0)
        XCTAssertEqual(r.tiAspetta, 0)
        XCTAssertEqual(r.fonti.map(\.totale), [0, 0, 0, 0])
    }

    func testNuovoSnapshotAggiornaGliStatiDelleFonti() throws {
        let prima = try XCTUnwrap(RiepilogoAttivitaCruscotto(stato: stato([attivita("codex:a", "codex", "in corso")]), salvato: false))
        let dopo = try XCTUnwrap(RiepilogoAttivitaCruscotto(stato: stato([attivita("codex:a", "codex", "ti aspetta")]), salvato: false))
        XCTAssertEqual(prima.inCorso, 1)
        XCTAssertEqual(dopo.inCorso, 0)
        XCTAssertEqual(dopo.tiAspetta, 1)
    }
}
