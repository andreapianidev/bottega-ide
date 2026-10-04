import XCTest
@testable import Bottega

@MainActor
final class AmbientePushTests: XCTestCase {
    private func profilo(_ ambiente: String?) throws -> Data {
        let diritti = ambiente.map { ["aps-environment": $0] } ?? [:]
        let plist = try PropertyListSerialization.data(fromPropertyList: ["Entitlements": diritti], format: .xml, options: 0)
        // Byte CMS non UTF-8 attorno alla plist, come nel mobileprovision firmato.
        return Data([0x30, 0x82, 0xFF, 0x00]) + plist + Data([0x00, 0xFF, 0x82])
    }

    func testFirmaDevelopmentUsaSandboxAncheSenzaDEBUG() throws {
        XCTAssertEqual(AmbientePush.dalProfilo(try profilo("development")), "sviluppo")
    }

    func testFirmaDistributionUsaProduzione() throws {
        XCTAssertEqual(AmbientePush.dalProfilo(try profilo("production")), "produzione")
    }

    func testProfiloAssenteOMalformatoRipiegaSuProduzione() throws {
        XCTAssertEqual(AmbientePush.dalProfilo(nil), "produzione")
        XCTAssertEqual(AmbientePush.dalProfilo(Data("<plist>troncato".utf8)), "produzione")
        XCTAssertEqual(AmbientePush.dalProfilo(try profilo(nil)), "produzione")
    }

    func testSimulatoreUsaSandbox() throws {
        XCTAssertEqual(AmbientePush.dalProfilo(nil, simulatore: true), "sviluppo")
        XCTAssertEqual(AmbientePush.dalProfilo(try profilo("production"), simulatore: true), "sviluppo")
    }

    func testCambioFirmaInvalidaACKERimandaIlTokenCorrente() async throws {
        let nome = "AmbientePushTests.\(UUID().uuidString)"
        let preferenze = try XCTUnwrap(UserDefaults(suiteName: nome))
        defer { preferenze.removePersistentDomain(forName: nome) }
        preferenze.set("produzione", forKey: "pushAmbiente")
        preferenze.set(["avvio": "corrente"], forKey: "tokenMandati")
        let confermati = AmbientePush.tokenConfermati(preferenze: preferenze, ambiente: "sviluppo")
        XCTAssertTrue(confermati.isEmpty)
        XCTAssertNil(preferenze.dictionary(forKey: "tokenMandati"))
        XCTAssertEqual(preferenze.string(forKey: "pushAmbiente"), "sviluppo")
        var inviati: [[String: String]] = []
        let coda = InvioTokenDispositivo(mandati: confermati, invia: { inviati.append($0) },
            conserva: { preferenze.set($0, forKey: "tokenMandati") })
        try await coda.manda(["avvio": "corrente"])
        XCTAssertEqual(inviati, [["avvio": "corrente"]])
        XCTAssertEqual(AmbientePush.tokenConfermati(preferenze: preferenze, ambiente: "sviluppo"), ["avvio": "corrente"],
                       "Una nuova apertura con la stessa firma conserva l'ACK")
    }

    func testACKPreesistenteSenzaMarkerNonSopprimeRegistrazione() throws {
        let nome = "AmbientePushTests.\(UUID().uuidString)"
        let preferenze = try XCTUnwrap(UserDefaults(suiteName: nome))
        defer { preferenze.removePersistentDomain(forName: nome) }
        preferenze.set(["avvio": "vecchio"], forKey: "tokenMandati")
        XCTAssertTrue(AmbientePush.tokenConfermati(preferenze: preferenze, ambiente: "produzione").isEmpty)
        XCTAssertNil(preferenze.dictionary(forKey: "tokenMandati"))
        XCTAssertTrue(AmbientePush.tokenConfermati(preferenze: preferenze, ambiente: "produzione").isEmpty,
                      "Senza ACK anche l'apertura successiva deve ritentare")
    }
}
