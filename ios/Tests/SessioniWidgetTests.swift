import Foundation
import XCTest
@testable import Bottega

final class SessioniWidgetTests: XCTestCase {
    func testDurataStabileEDeduplicaPerAggiornamento() throws {
        var prima = attivita("codex:a", "codex", "in corso", alle: 200)
        prima.startedAt = 50
        var dopo = attivita("codex:a", "codex", "ti aspetta", alle: 300)
        dopo.startedAt = 50
        let s = stato([prima, dopo])
        XCTAssertEqual(s.sessioniWidget.count, 1)
        XCTAssertEqual(s.sessioniWidget.first?.da, 50)
        XCTAssertEqual(s.sessioniWidget.first?.stato, "ti aspetta")
        let copia = try JSONDecoder().decode(StatoMac.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(copia.sessioniWidget, s.sessioniWidget)
        XCTAssertEqual(stato([attivita("legacy", "cline", "in corso", alle: 99)]).sessioniWidget.first?.da, 99)
    }

    private func attivita(_ key: String, _ source: String, _ status: String,
                          progetto: String = "Bottega", alle: Double = 100) -> StatoMac.Attivita {
        .init(key: key, source: source, project: progetto, status: status,
              title: "Verifica progetto", summary: nil, updatedAt: alle)
    }

    private func stato(_ attivita: [StatoMac.Attivita]?) -> StatoMac {
        .init(versione: "prova", mac: "Mac", ora: 1000,
              melissa: .init(stato: "riposo", cervello: "", parziale: nil, registro: []),
              lavori: [.init(chiave: "legacy", origine: "bottega", stato: "in corso",
                             progetto: "Legacy", titolo: "Vecchia sessione", da: 50, jobId: nil)],
              conti: .init(inCorso: 1, tiAspetta: 0, inCoda: 0, vive: 1), attivita: attivita)
    }

    func testQuattroFontiUsanoLeStesseRigheContatoriEProgetti() {
        let s = stato([
            attivita("claude:a", "claude", "in corso", alle: 100),
            attivita("cline:a", "cline", "ti aspetta", progetto: "Sito", alle: 50),
            attivita("codex:a", "codex", "in corso", alle: 200),
            attivita("terminale:a", "terminale", "in corso", progetto: "Note", alle: 150),
            attivita("codex:b", "codex", "finito", progetto: "Archivio", alle: 900),
        ])
        XCTAssertEqual(s.sessioniWidget.map(\.fonte), ["Cline", "Codex", "Terminale", "Claude Code", "Codex"])
        XCTAssertEqual(s.sessioniWidget.map(\.id), ["cline:a", "codex:a", "terminale:a", "claude:a", "codex:b"])
        XCTAssertEqual(s.conteggiAttivita.totale, 5)
        XCTAssertEqual(s.conteggiAttivita.inCorso, 3)
        XCTAssertEqual(s.conteggiAttivita.tiAspetta, 1)
        XCTAssertEqual(s.progettiWidget, ["Sito", "Bottega", "Note"])
        XCTAssertFalse(s.sessioniWidget.contains { $0.id == "legacy" })
        XCTAssertEqual(s.sessioniWidget.last?.stato, "finito", "Il medio conserva anche lo storico")
    }

    func testRegistroVuotoNonResuscitaIContatoriELeRigheLegacy() {
        let s = stato([])
        XCTAssertTrue(s.sessioniWidget.isEmpty)
        XCTAssertTrue(s.progettiWidget.isEmpty)
        XCTAssertEqual(s.conteggiAttivita.totale, 0)
        XCTAssertEqual(s.conteggiAttivita.inCorso, 0)
        XCTAssertEqual(s.conteggiAttivita.tiAspetta, 0)
    }

    func testPontePrecedenteContinuaAMostrareLeSessioniClaude() throws {
        let encoded = try JSONEncoder().encode(stato(nil))
        let s = try JSONDecoder().decode(StatoMac.self, from: encoded)
        XCTAssertNil(s.attivita)
        XCTAssertEqual(s.sessioniWidget.map(\.id), ["legacy"])
        XCTAssertEqual(s.sessioniWidget.first?.fonte, "Claude Code")
        XCTAssertEqual(s.progettiWidget, ["Legacy"])
        XCTAssertEqual(s.conteggiAttivita.totale, 1)
        XCTAssertEqual(s.conteggiAttivita.inCorso, 1)
    }

    func testQuadroLavoriDecodificaConteggiEStoricoSenzaRompereIlPontePrecedente() throws {
        let precedente = try JSONEncoder().encode(stato(nil))
        let vecchio = try JSONDecoder().decode(StatoMac.self, from: precedente)
        XCTAssertNil(vecchio.quadroLavori)
        XCTAssertNil(vecchio.conti.nelTerminale)
        XCTAssertNil(vecchio.conti.stanotte)

        var payload = try XCTUnwrap(JSONSerialization.jsonObject(with: precedente) as? [String: Any])
        var conti = try XCTUnwrap(payload["conti"] as? [String: Any])
        conti["nelTerminale"] = 2
        conti["stanotte"] = 3
        payload["conti"] = conti
        payload["quadroLavori"] = [
            "progetti": [["nome": "Faro", "conteggio": 4]],
            "giorni": [["data": "2026-10-04", "conteggio": 5]],
        ]
        let nuovo = try JSONDecoder().decode(StatoMac.self, from: JSONSerialization.data(withJSONObject: payload))
        XCTAssertEqual(nuovo.conti.nelTerminale, 2)
        XCTAssertEqual(nuovo.conti.stanotte, 3)
        XCTAssertEqual(nuovo.quadroLavori?.progetti.first?.conteggio, 4)
        XCTAssertEqual(nuovo.quadroLavori?.giorni.first?.data, "2026-10-04")
        XCTAssertEqual(try JSONDecoder().decode(StatoMac.self, from: JSONEncoder().encode(nuovo)), nuovo)
    }

    func testPassiEdEvidenzaSonoOpzionaliERestanoNelPayload() throws {
        let vecchia = attivita("codex:a", "codex", "in corso")
        let copia = try JSONDecoder().decode(StatoMac.Attivita.self, from: JSONEncoder().encode(vecchia))
        XCTAssertNil(copia.steps)
        XCTAssertNil(copia.evidence)
        var nuova = vecchia
        nuova.steps = ["Verifica dei test", "Aggiornamento del widget"]
        nuova.evidence = "Codex: sessione locale"
        XCTAssertEqual(try JSONDecoder().decode(StatoMac.Attivita.self, from: JSONEncoder().encode(nuova)), nuova)
    }

    func testChiaviRipetuteContanoUnaVoltaConLoStatoPiuRecente() {
        let vecchia = attivita("codex:a", "codex", "in corso", alle: 100)
        let recente = attivita("codex:a", "codex", "finito", alle: 200)
        for righe in [[vecchia, recente], [recente, vecchia]] {
            let s = stato(righe)
            XCTAssertEqual(s.sessioniWidget.count, 1)
            XCTAssertEqual(s.sessioniWidget.first?.stato, "finito")
            XCTAssertEqual(s.conteggiAttivita.totale, 1)
            XCTAssertEqual(s.conteggiAttivita.inCorso, 0)
            XCTAssertTrue(s.progettiWidget.isEmpty)
        }
    }

    func testOrdineDeterministicoACoincidenzaDiStatoEOra() {
        let a = attivita("codex:a", "codex", "in corso")
        let b = attivita("cline:b", "cline", "in corso")
        XCTAssertEqual(stato([a, b]).sessioniWidget, stato([b, a]).sessioniWidget)
    }

    func testPushPrecedenteSenzaFonteContinuaADecodificarsi() throws {
        let json = #"{"inCorso":1,"tiAspetta":0,"vive":1,"righe":[{"progetto":"Bottega","stato":"in corso","da":100}],"aggiornato":200}"#
        let s = try JSONDecoder().decode(BottegaAttivita.ContentState.self, from: Data(json.utf8))
        XCTAssertEqual(s.righe.count, 1)
        XCTAssertNil(s.righe.first?.fonte)
        XCTAssertNil(s.segui)
    }

    func testPushMultifonteConservaFonteEConteggi() throws {
        let json = #"{"inCorso":2,"tiAspetta":1,"vive":3,"righe":[{"progetto":"Bottega","stato":"ti aspetta","da":100,"fonte":"Cline"},{"progetto":"Bottega","stato":"in corso","da":150,"fonte":"Codex"},{"progetto":"Note","stato":"in corso","da":160,"fonte":"Terminale"}],"aggiornato":200}"#
        let s = try JSONDecoder().decode(BottegaAttivita.ContentState.self, from: Data(json.utf8))
        XCTAssertEqual(s.righe.compactMap(\.fonte), ["Cline", "Codex", "Terminale"])
        XCTAssertEqual(s.inCorso, 2)
        XCTAssertEqual(s.tiAspetta, 1)
        XCTAssertEqual(try JSONDecoder().decode(BottegaAttivita.ContentState.self, from: JSONEncoder().encode(s)), s)
    }
}
