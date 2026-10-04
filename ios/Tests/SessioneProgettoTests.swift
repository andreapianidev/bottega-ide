import XCTest
@testable import Bottega

final class SessioneProgettoTests: XCTestCase {
    private func attivita(_ fonte: String, stato: String = "in corso", alle: Double = 100) -> StatoMac.Attivita {
        .init(key: "\(fonte):1", source: fonte, project: "Faro", status: stato,
              title: "Verifica", summary: nil, updatedAt: alle)
    }

    private func snapshot(_ attivita: [StatoMac.Attivita]?, lavori: [StatoMac.Lavoro] = []) -> StatoMac {
        .init(versione: "prova", mac: "Mac", ora: 1000,
              melissa: .init(stato: "idle", cervello: "", parziale: nil, registro: []),
              lavori: lavori, conti: .init(inCorso: 0, tiAspetta: 0, inCoda: 0, vive: 0), attivita: attivita)
    }

    private func lavoro(_ activityKey: String? = nil) -> StatoMac.Lavoro {
        .init(chiave: "job:1", origine: "bottega", stato: "in corso", progetto: "Faro",
              titolo: "Verifica", da: 200, jobId: "1", activityKey: activityKey)
    }

    func testOgniFonteApreIlProprioDettaglio() {
        for fonte in ["claude", "codex", "cline", "terminale"] {
            let scelta = SessioneProgetto.scegli(progetto: " faro ", da: snapshot([attivita(fonte)]))
            XCTAssertEqual(scelta?.id, "attivita:\(fonte):1")
        }
    }

    func testAttesaPrecedeLavoroClaudeEStoricoRecente() {
        let s = snapshot([attivita("codex", stato: "ti aspetta"), attivita("cline", stato: "finito", alle: 500)], lavori: [lavoro()])
        XCTAssertEqual(SessioneProgetto.scegli(progetto: "Faro", da: s)?.id, "attivita:codex:1")
    }

    func testClaudeCollegatoMantieneLaSchedaConLeAzioni() {
        let s = snapshot([attivita("claude")], lavori: [lavoro("claude:1")])
        XCTAssertEqual(SessioneProgetto.scegli(progetto: "Faro", da: s)?.id, "lavoro:job:1")
    }

    func testAttivitaFinitaNonRiviveDalLavoroCollegatoVecchio() {
        let s = snapshot([attivita("claude", stato: "finito"), attivita("codex")], lavori: [lavoro("claude:1")])
        XCTAssertEqual(SessioneProgetto.scegli(progetto: "Faro", da: s)?.id, "attivita:codex:1")
    }

    func testPonteVecchioContinuaAdAprireIlLavoro() {
        XCTAssertEqual(SessioneProgetto.scegli(progetto: "Faro", da: snapshot(nil, lavori: [lavoro()]))?.id, "lavoro:job:1")
    }

    func testDuplicatiUsanoLoStatoPiuRecente() {
        let s = snapshot([attivita("codex", stato: "ti aspetta", alle: 10),
                          attivita("codex", stato: "finito", alle: 100), attivita("cline")])
        XCTAssertEqual(SessioneProgetto.scegli(progetto: "Faro", da: s)?.id, "attivita:cline:1")
    }

    func testProgettoDiversoVuotoOStatoAssenteNonApreUnaScheda() {
        let s = snapshot([attivita("codex")])
        XCTAssertNil(SessioneProgetto.scegli(progetto: "Altro", da: s))
        XCTAssertNil(SessioneProgetto.scegli(progetto: " ", da: s))
        XCTAssertNil(SessioneProgetto.scegli(progetto: "Faro", da: nil))
    }
}
