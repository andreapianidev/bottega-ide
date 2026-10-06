import XCTest
@testable import Bottega

/// Il nome di chi parla cambia quando la sua battuta comincia a suonare, non quando il suo audio si accoda.
/// Senza simulatore: `scripts/test-ios-personaggi.sh`.
final class SegniVoceTests: XCTestCase {
    func testIlNomeCambiaAlPrimoAudioDellaBattuta() {
        let segni = SegniVoce()
        var parlante = "Melissa"
        // niente in coda: subito
        segni.segna { parlante = "Melissa" }
        XCTAssertEqual(parlante, "Melissa")
        // la battuta di Melissa: tre pezzi in coda
        (0..<3).forEach { _ in segni.accodato() }
        // Darlene ha gia' pensato la sua mentre Melissa suona: il suo primo pezzo arriva adesso
        segni.segna { parlante = "Darlene" }
        segni.accodato()
        XCTAssertEqual(parlante, "Melissa", "accodata, Darlene non parla ancora")
        segni.suonato()
        segni.suonato()
        XCTAssertEqual(parlante, "Melissa")
        segni.suonato()
        XCTAssertEqual(parlante, "Darlene", "finita Melissa, comincia Darlene")
        // Melissa chiude: il suo segno aspetta il pezzo di Darlene
        segni.segna { parlante = "Melissa" }
        segni.accodato()
        XCTAssertEqual(parlante, "Darlene")
        segni.suonato()
        XCTAssertEqual(parlante, "Melissa")
    }

    func testRiempitivoTaciutoEInterruzione() {
        let segni = SegniVoce()
        var parlante = "Melissa"
        segni.accodato()
        segni.segna { parlante = "Elliot" }
        // il riempitivo e' stato taciuto con un tocco: quello che aspettava parte adesso
        segni.svuota()
        XCTAssertEqual(parlante, "Elliot")
        // un'interruzione butta i segni in attesa
        segni.accodato()
        segni.segna { parlante = "Krista" }
        segni.azzera()
        segni.suonato()
        XCTAssertEqual(parlante, "Elliot")
        XCTAssertEqual(segni.accodati, 0)
    }
}
