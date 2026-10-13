// Run with:
// swiftc nucleo/Sources/Isola/CodaVoci.swift nucleo/Tests/CodaVociTests.swift -o /tmp/coda-voci-tests && /tmp/coda-voci-tests
import Foundation

@main
struct CodaVociTests {
    static func expect(_ ok: Bool, _ what: String, line: Int = #line) {
        precondition(ok, "CodaVociTests, riga \(line): \(what)")
    }

    static let t0 = Date(timeIntervalSince1970: 1_000_000)
    static func b(_ s: String, _ testo: String, final: Bool = true, append: Bool = true, at: TimeInterval = 0) -> Battuta {
        Battuta(sessione: s, testo: testo, append: append, final: final, voce: nil, at: t0.addingTimeInterval(at))
    }

    static func main() {
        // A free voice: the first line goes at once and its session holds it.
        var c = CodaVoci()
        expect(c.arriva(b("A", "uno"), suona: false, ascolta: false, ora: t0) == .subito, "voce libera")
        expect(c.di == "A", "A tiene la voce")

        // Another session while A sounds: it waits, behind A.
        expect(c.arriva(b("B", "avviso"), suona: true, ascolta: false, ora: t0) == .inCoda(dietro: "A"), "B aspetta A")
        // A goes on speaking in its own voice, never behind B.
        expect(c.arriva(b("A", "due"), suona: true, ascolta: false, ora: t0) == .subito, "il titolare non aspetta")
        expect(c.prossime(suona: true, ascolta: false, ora: t0).dire.isEmpty, "mentre A suona nessuno passa")

        // A is over: B's lines go out, all of them, in order, and B holds the voice.
        expect(c.arriva(b("B", "seconda", final: true), suona: true, ascolta: false, ora: t0) == .inCoda(dietro: "A"), "B accoda ancora")
        var p = c.prossime(suona: false, ascolta: false, ora: t0.addingTimeInterval(1))
        expect(p.dire.map(\.testo) == ["avviso", "seconda"], "le battute di B in ordine: \(p.dire.map(\.testo))")
        expect(c.di == "B" && c.attesa.isEmpty, "ora la voce e' di B")

        // An open turn (a filler, no final) keeps the voice while its answer is thought...
        c = CodaVoci()
        _ = c.arriva(b("A", "mmh", final: false), suona: false, ascolta: false, ora: t0)
        _ = c.arriva(b("B", "avviso"), suona: true, ascolta: false, ora: t0)
        p = c.prossime(suona: false, ascolta: false, ora: t0.addingTimeInterval(10))
        expect(p.dire.isEmpty && c.di == "A", "turno aperto da 10 s: resta di A")
        // ...but not for ever: a session gone mid-turn leaves the voice after turnoMuto.
        p = c.prossime(suona: false, ascolta: false, ora: t0.addingTimeInterval(CodaVoci.turnoMuto + 1))
        expect(p.dire.map(\.sessione) == ["B"], "turno muto: passa a B")

        // The microphone open: nobody's lines go out, they wait for it to close.
        c = CodaVoci()
        expect(c.arriva(b("B", "avviso"), suona: false, ascolta: true, ora: t0) == .inCoda(dietro: "B"), "col microfono aperto si aspetta")
        expect(c.prossime(suona: false, ascolta: true, ora: t0).dire.isEmpty, "microfono ancora aperto")
        expect(c.prossime(suona: false, ascolta: false, ora: t0).dire.count == 1, "microfono chiuso: parte")
        // not even the holder speaks into an open microphone
        expect(c.arriva(b("B", "ancora"), suona: false, ascolta: true, ora: t0) == .inCoda(dietro: "B"), "il titolare aspetta il microfono")

        // A line that waited past scadenza is dropped, not said late.
        c = CodaVoci()
        _ = c.arriva(b("A", "lunga", final: false), suona: false, ascolta: false, ora: t0)
        _ = c.arriva(b("B", "vecchia"), suona: true, ascolta: false, ora: t0)
        p = c.prossime(suona: true, ascolta: false, ora: t0.addingTimeInterval(CodaVoci.scadenza + 1))
        expect(p.scartate.map(\.testo) == ["vecchia"] && c.attesa.isEmpty, "scaduta")

        // /zitta from a session that does not hold the voice: only its waiting lines go.
        c = CodaVoci()
        _ = c.arriva(b("A", "cronaca"), suona: false, ascolta: false, ora: t0)
        _ = c.arriva(b("B", "avviso"), suona: true, ascolta: false, ora: t0)
        _ = c.arriva(b("C", "altro"), suona: true, ascolta: false, ora: t0)
        expect(c.zitta(sessione: "B") == false, "B non ferma la voce di A")
        expect(c.di == "A" && c.attesa.map(\.sessione) == ["C"], "tolte solo le battute di B")
        // ...from the holder: the voice stops and the next one may go.
        expect(c.zitta(sessione: "A") == true && c.di == nil, "A zittisce se stessa")
        expect(c.prossime(suona: false, ascolta: false, ora: t0).dire.map(\.sessione) == ["C"], "poi C")
        // ...with no session: everything.
        _ = c.arriva(b("D", "x"), suona: true, ascolta: false, ora: t0)
        expect(c.zitta(sessione: "") == true && c.di == nil && c.attesa.isEmpty, "zitta senza sessione: tutto")

        // /ping: the queue holds back whoever does not hold the voice, never the holder.
        c = CodaVoci()
        _ = c.arriva(b("A", "uno", final: false), suona: false, ascolta: false, ora: t0)
        _ = c.arriva(b("B", "avviso"), suona: true, ascolta: false, ora: t0)
        expect(!c.altriInAttesa(per: "A"), "il titolare non aspetta chi e' in coda dietro di lui")
        expect(c.altriInAttesa(per: "C"), "un terzo aspetta")
        expect(c.altriInAttesa(per: ""), "senza sessione: c'e' chi aspetta")
        expect(!c.altriInAttesa(per: "B") , "B non aspetta se stessa")

        // A click empties everything.
        c.svuota()
        expect(c.di == nil && c.attesa.isEmpty, "clic: tutto vuoto")

        print("CodaVociTests: tutto bene")
    }
}
