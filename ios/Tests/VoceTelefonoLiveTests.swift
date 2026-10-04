import XCTest
@testable import Bottega

@MainActor
final class VoceTelefonoLiveTests: XCTestCase {
    func testRaccontoCompletoConElevenLabs() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["BOTTEGA_TEST_REALE"] == "1" else { throw XCTSkip("Prova reale solo su richiesta") }
        let key = try XCTUnwrap(env["ELEVENLABS_API_KEY"])
        let voice = try XCTUnwrap(env["ELEVENLABS_VOICE_ID"])
        let prima = "Ecco il riepilogo dei dati del computer, aggiornato a questa mattina."
        let altre = [
            "Il primo progetto ha completato tutte le verifiche automatiche. Il secondo sta ancora compilando e bisogna aspettare il risultato prima di considerarlo concluso.",
            "Infine, ci sono tre sessioni di terminale aperte. La lettura deve arrivare fino a questa ultima frase, senza fermarsi dopo la breve introduzione."
        ]
        var introBytes = 0
        let intro = VoceTelefono(key: key, voiceID: voice) { introBytes += $0.count }
        try await intro.apri()
        try await intro.invia(prima)
        try await intro.finisci()
        XCTAssertGreaterThan(introBytes, 0)

        var bytes = 0
        var dopoChiusura = 0
        var chiudendo = false
        let voce = VoceTelefono(key: key, voiceID: voice) { pcm in
            bytes += pcm.count
            if chiudendo { dopoChiusura += pcm.count }
        }
        defer { voce.ferma() }
        try await voce.apri()
        try await voce.invia(prima)
        // Riproduce una prima frase gia' sintetizzata mentre il modello prepara il resto.
        try await Task.sleep(for: .seconds(3))
        for frase in altre { try await voce.invia(frase) }
        chiudendo = true
        try await voce.finisci()
        XCTAssertGreaterThan(dopoChiusura, 0, "Il PCM delle frasi finali deve arrivare dopo close_socket")
        XCTAssertGreaterThan(bytes, introBytes * 2, "Il racconto deve contenere molto piu' audio della sola introduzione")
        print("ElevenLabs: introduzione \(Double(introBytes) / 48000)s, racconto \(Double(bytes) / 48000)s, PCM dopo chiusura \(dopoChiusura) byte")
    }
}
