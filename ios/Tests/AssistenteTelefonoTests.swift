import XCTest
@testable import Bottega

@MainActor
final class AssistenteTelefonoTests: XCTestCase {
    func testMacEAutonomiaSulDispositivo() async throws {
        let ponte = Ponte.shared
        ponte.ricarica()
        await ponte.aggiornaStato()
        XCTAssertEqual(ponte.linea, .collegato, "Il ponte sul Mac deve essere disponibile per importare le chiavi")
        try await ponte.importaConfigurazioneAssistente()
        XCTAssertTrue(AssistenteTelefono.shared.configurato)

        let dalMac = try await ponte.chiedi("Rispondi brevemente: quanto fa due più due?")
        XCTAssertFalse(dalMac.isEmpty, "Il percorso col Mac acceso deve rispondere")

        let telefono = AssistenteTelefono.shared
        let providerPrecedente = telefono.provider
        let impegnoPrecedente = telefono.impegno
        defer {
            telefono.impostaPerProva(provider: providerPrecedente, impegno: impegnoPrecedente)
            ponte.riavvia()
        }

        telefono.impostaPerProva(provider: "agnes", impegno: "rapido")
        ponte.simulaMacAssentePerProva()
        let iniziali = telefono.turni.count
        let melissa = Melissa(ponte: ponte)
        melissa.voceAccesa = true
        melissa.scrivi("Dì una frase breve per la prova sull'iPhone.")
        for _ in 0..<70 {
            if telefono.turni.count >= iniziali + 2 && !melissa.occupata { break }
            try await Task.sleep(for: .seconds(1))
        }
        XCTAssertGreaterThanOrEqual(telefono.turni.count, iniziali + 2, "Agnes deve rispondere senza il ponte")
        XCTAssertGreaterThan(telefono.ultimiByteVoce, 0, "ElevenLabs deve inviare audio direttamente all'iPhone")
        XCTAssertNil(melissa.avviso, "Melissa deve finire la voce senza errore")

        telefono.impostaPerProva(provider: "deepseek", impegno: "rapido")
        let deepseek = try await telefono.rispondi("Dì soltanto: prova DeepSeek riuscita.", voce: false) { _ in }
        XCTAssertFalse(deepseek.isEmpty, "DeepSeek deve rispondere direttamente all'iPhone")
    }
}
