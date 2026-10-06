// Run with:
// swiftc nucleo/Sources/Voice/VoceCache.swift nucleo/Tests/VoceCacheTests.swift -o /tmp/voce-cache-tests && /tmp/voce-cache-tests
import Foundation

@main
struct VoceCacheTests {
    static func expect(_ ok: Bool, _ what: String, line: Int = #line) {
        precondition(ok, "VoceCacheTests, riga \(line): \(what)")
    }

    static func main() {
        // Key and file name: everything that changes the sound, hashed.
        let k = VoceCache.chiave(model: "eleven_v4_turbo", voce: "QITiGyM4owEZrBEf0QV8", testo: "Mmh, vediamo.")
        expect(k == "eleven_v4_turbo|QITiGyM4owEZrBEf0QV8|0.5|0.75|Mmh, vediamo.", "chiave: \(k)")
        expect(VoceCache.nomeFile(chiave: k) == "57e69df68864bdcd5994acfbf1ff2d3b9257f94765ddb7a94a62c97be47bef03.pcm", "sha256")
        expect(VoceCache.chiave(model: "m", voce: "v", testo: "x", stability: 0.3) != VoceCache.chiave(model: "m", voce: "v", testo: "x"),
               "la stabilita' cambia la chiave")
        expect(VoceCache.nomeFile(chiave: VoceCache.chiave(model: "m", voce: "a", testo: "x"))
               != VoceCache.nomeFile(chiave: VoceCache.chiave(model: "m", voce: "b", testo: "x")), "voci diverse, file diversi")
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("voce-cache-test-\(UUID().uuidString)")
        expect(VoceCache.percorso(cartella: dir, chiave: k).lastPathComponent == VoceCache.nomeFile(chiave: k), "percorso")

        // Voice ids as /parla takes them.
        expect(VoceCache.idVoceValido("QITiGyM4owEZrBEf0QV8"), "id valido")
        expect(!VoceCache.idVoceValido("apple"), "apple non e' un id")
        expect(!VoceCache.idVoceValido("com.apple.voice.premium.it-IT.Emma"), "voce Apple non e' un id")
        expect(!VoceCache.idVoceValido("../../etc/passwd"), "percorso non e' un id")

        // Pieces: the same cuts as Speaker.drain on a whole /parla text (trailing space).
        expect(VoceCache.pezzi("Mmh, vediamo. ") == ["Mmh, vediamo."], "una frase")
        expect(VoceCache.pezzi("Eh, lo so. Aspetta. ") == ["Eh, lo so.", "Aspetta."], "due frasi")
        expect(VoceCache.pezzi("Mh. Ci sto pensando. ") == ["Mh. Ci sto pensando."], "frase sotto gli 8 caratteri non si taglia")
        expect(VoceCache.pezzi("Mh. Ci sto pensando.") == ["Mh. Ci sto pensando."], "senza spazio finale, stessi pezzi")
        expect(VoceCache.pezzi("Ricevuto, dammi un secondo che controllo bene, poi ti dico una cosa importante, davvero. ")
               == ["Ricevuto, dammi un secondo che controllo bene,", "poi ti dico una cosa importante, davvero."],
               "inciso solo per il primo pezzo")
        expect(VoceCache.pezzi("**Ok** ci penso. ") == ["Ok ci penso."], "markdown tolto")
        expect(VoceCache.pezzi("   ").isEmpty, "niente da dire")
        expect(PezziDiVoce.pulisci("  [laughs]  ok\n\nva bene ") == "[laughs] ok va bene", "i tag audio restano")

        // Write and read: atomic, mode 600, folder 700, only whole 16-bit frames.
        let cache = VoceCache(cartella: dir, tetto: 10)
        let attrsDir = try! FileManager.default.attributesOfItem(atPath: dir.path)
        expect((attrsDir[.posixPermissions] as? NSNumber)?.intValue == 0o700, "cartella 700")
        expect(cache.quanti == 0, "cache nuova vuota")
        let a = VoceCache.chiave(model: "m", voce: "v", testo: "a")
        let b = VoceCache.chiave(model: "m", voce: "v", testo: "b")
        let c = VoceCache.chiave(model: "m", voce: "v", testo: "c")
        expect(!cache.contiene(a) && cache.pcm(a) == nil, "assente")
        try! cache.salva(Data([1, 0, 2, 0]), chiave: a)
        let fa = VoceCache.percorso(cartella: dir, chiave: a)
        let attrs = try! FileManager.default.attributesOfItem(atPath: fa.path)
        expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600, "file 600")
        expect(VoceCache.leggi(fa) == Data([1, 0, 2, 0]), "rilettura")
        expect(cache.contiene(a) && cache.pcm(a) == Data([1, 0, 2, 0]), "presente")
        var rifiutato = false
        do { try VoceCache.scrivi(Data([1, 2, 3]), in: VoceCache.percorso(cartella: dir, chiave: "dispari")) } catch { rifiutato = true }
        expect(rifiutato, "un byte dispari non si scrive")
        rifiutato = false
        do { try cache.salva(Data(), chiave: b) } catch { rifiutato = true }
        expect(rifiutato && !cache.contiene(b), "audio vuoto non si scrive")
        let tmpLeft = (try! FileManager.default.contentsOfDirectory(atPath: dir.path)).filter { $0.hasSuffix(".tmp") }
        expect(tmpLeft.isEmpty, "nessun file temporaneo rimasto")

        // A file written by the other life of the Nucleo is found without reopening.
        try! VoceCache.scrivi(Data([5, 0, 6, 0]), in: VoceCache.percorso(cartella: dir, chiave: b))
        expect(cache.contiene(b), "file scritto da fuori trovato")

        // The index at open lists only finished .pcm files.
        FileManager.default.createFile(atPath: dir.appendingPathComponent(".mezzo.pcm.x.tmp").path, contents: Data([0]))
        FileManager.default.createFile(atPath: dir.appendingPathComponent("altro.txt").path, contents: Data([0]))
        expect(VoceCache.elenca(dir) == [VoceCache.nomeFile(chiave: a), VoceCache.nomeFile(chiave: b)], "indice")
        expect(VoceCache(cartella: dir).quanti == 2, "indice all'apertura")

        // LRU: 10 bytes, 4 per piece.
        try! cache.salva(Data([7, 0, 8, 0]), chiave: c)
        _ = cache.pcm(a); _ = cache.pcm(b); _ = cache.pcm(c)
        expect(cache.inMemoria == [VoceCache.nomeFile(chiave: b), VoceCache.nomeFile(chiave: c)], "il meno recente esce")
        _ = cache.pcm(b)
        expect(cache.inMemoria == [VoceCache.nomeFile(chiave: c), VoceCache.nomeFile(chiave: b)], "uso recente in fondo")
        expect(cache.pcm(a) == Data([1, 0, 2, 0]), "uscito dalla memoria, si rilegge dal disco")
        let grosso = VoceCache.chiave(model: "m", voce: "v", testo: "grosso")
        try! cache.salva(Data(repeating: 1, count: 12), chiave: grosso)
        expect(cache.pcm(grosso)?.count == 12 && !cache.inMemoria.contains(VoceCache.nomeFile(chiave: grosso)),
               "oltre il tetto si legge ma non si tiene")

        // A file gone bad is a miss, and leaves the index.
        let fc = VoceCache.percorso(cartella: dir, chiave: c)
        let fresh = VoceCache(cartella: dir, tetto: 10)
        FileManager.default.createFile(atPath: fc.path, contents: Data([1, 2, 3]))
        expect(fresh.pcm(c) == nil, "file rovinato")
        expect(!fresh.contiene(c), "file rovinato tolto, si rigenera")

        try? FileManager.default.removeItem(at: dir)
        print("VoceCacheTests passed")
    }
}
