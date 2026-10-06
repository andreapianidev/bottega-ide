//
//  VoceCache.swift
//  Bottega Nucleo
//
//  Ready-made ElevenLabs audio for the short lines said while the model thinks (the
//  "riempitivi" of Melissa and the characters, CONTRATTI 9.11). A piece of a voice turn
//  whose clean text is here plays at once from disk instead of waiting for the socket.
//
//  On disk: ~/.bottega/nucleo/voce-cache/ (mode 700), one file per piece,
//  <sha256 hex of the key>.pcm (mode 600), raw PCM16 LE mono 24 kHz, the socket's own
//  output. The key is everything that changes the sound:
//      model | voice id | stability | similarity | clean text
//  An in-memory index of the files present is built when the cache opens; the audio is
//  read lazily and the last few MB stay in a small LRU.
//
//  This file depends on Foundation and CryptoKit only, so its pure parts (key, path,
//  read/write, splitting into pieces) build and test on their own:
//      nucleo/Tests/VoceCacheTests.swift
//  Filling (the dedicated sockets, /scalda, voice.scalda) is in VoceScalda.swift.
//

import Foundation
import CryptoKit

final class VoceCache: @unchecked Sendable {
    static let stability = 0.5
    static let similarity = 0.75
    /// Lines longer than this are not cached (a filler is a few words).
    static let maxCaratteri = 120
    /// LRU ceiling for audio kept in memory.
    static let tettoMemoria = 6 * 1024 * 1024

    // MARK: - Pure

    /// The cache key of one piece: everything that changes what the socket would say.
    static func chiave(model: String, voce: String, testo: String,
                       stability: Double = VoceCache.stability, similarity: Double = VoceCache.similarity) -> String {
        "\(model)|\(voce)|\(stability)|\(similarity)|\(testo)"
    }

    /// An ElevenLabs voice id as /parla takes it ("apple" and com.apple.* would switch engine).
    static func idVoceValido(_ v: String) -> Bool {
        v.range(of: "^[A-Za-z0-9]{10,40}$", options: .regularExpression) != nil
    }

    /// File name for a key: lowercase hex sha256, `.pcm`.
    static func nomeFile(chiave: String) -> String {
        SHA256.hash(data: Data(chiave.utf8)).map { String(format: "%02x", $0) }.joined() + ".pcm"
    }

    static func percorso(cartella: URL, chiave: String) -> URL {
        cartella.appendingPathComponent(nomeFile(chiave: chiave), isDirectory: false)
    }

    /// The PCM of a file, nil if missing, empty or not whole 16-bit frames.
    static func leggi(_ url: URL) -> Data? {
        guard let data = try? Data(contentsOf: url), !data.isEmpty, data.count % 2 == 0 else { return nil }
        return data
    }

    /// Writes through a temporary file renamed into place (a reader never sees half a
    /// file), mode 600.
    static func scrivi(_ pcm: Data, in url: URL) throws {
        guard !pcm.isEmpty, pcm.count % 2 == 0 else {
            throw NSError(domain: "VoceCache", code: 1, userInfo: [NSLocalizedDescriptionKey: "audio vuoto o non a 16 bit"])
        }
        let tmp = url.deletingLastPathComponent()
            .appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp", isDirectory: false)
        guard FileManager.default.createFile(atPath: tmp.path, contents: pcm, attributes: [.posixPermissions: 0o600]) else {
            throw NSError(domain: "VoceCache", code: 2, userInfo: [NSLocalizedDescriptionKey: "non riesco a scrivere \(tmp.lastPathComponent)"])
        }
        if rename(tmp.path, url.path) != 0 {
            let err = String(cString: strerror(errno))
            unlink(tmp.path)
            throw NSError(domain: "VoceCache", code: 3, userInfo: [NSLocalizedDescriptionKey: "rename: \(err)"])
        }
    }

    /// The names of the cache files in a folder (the index at open).
    static func elenca(_ cartella: URL) -> Set<String> {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: cartella.path)) ?? []
        return Set(names.filter { $0.hasSuffix(".pcm") && !$0.hasPrefix(".") })
    }

    /// The pieces a voice turn makes of `testo` sent whole (the island's /parla adds a
    /// trailing space): the same cuts as Speaker.drain, the first clause alone and then
    /// whole sentences, each cleaned as Speaker.emitPiece cleans it. /scalda caches these,
    /// so the lookup at speaking time finds them piece by piece.
    static func pezzi(_ testo: String) -> [String] {
        var buffer = testo
        var out: [String] = []
        var primo = true
        while let cut = PezziDiVoce.boundary(in: buffer, clauseOK: primo) {
            let p = PezziDiVoce.pulisci(String(buffer[..<cut]))
            buffer = String(buffer[cut...])
            if !p.isEmpty { out.append(p); primo = false }
        }
        let resto = PezziDiVoce.pulisci(buffer)
        if !resto.isEmpty { out.append(resto) }
        return out
    }

    // MARK: - Store

    let cartella: URL
    private let lock = NSLock()
    private var indice: Set<String>
    private var memoria: [String: Data] = [:]
    /// Least recently used first.
    private var ordine: [String] = []
    private var byteInMemoria = 0
    private let tetto: Int

    /// Opens (creating it, mode 700) the folder and indexes the files already there.
    init(cartella: URL, tetto: Int = VoceCache.tettoMemoria) {
        self.cartella = cartella
        self.tetto = tetto
        try? FileManager.default.createDirectory(at: cartella, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        chmod(cartella.path, 0o700)
        indice = Self.elenca(cartella)
    }

    var quanti: Int { lock.lock(); defer { lock.unlock() }; return indice.count }

    /// True when the piece is on disk. A miss in the index checks the disk once: the other
    /// life of the Nucleo (island or service) may have written it meanwhile.
    func contiene(_ chiave: String) -> Bool {
        let nome = Self.nomeFile(chiave: chiave)
        lock.lock()
        if indice.contains(nome) { lock.unlock(); return true }
        lock.unlock()
        guard FileManager.default.fileExists(atPath: cartella.appendingPathComponent(nome).path) else { return false }
        lock.lock(); indice.insert(nome); lock.unlock()
        return true
    }

    /// The audio of a piece, nil when it is not cached (or the file went bad).
    func pcm(_ chiave: String) -> Data? {
        let nome = Self.nomeFile(chiave: chiave)
        lock.lock()
        if let d = memoria[nome] {
            tocca(nome)
            lock.unlock()
            return d
        }
        let noto = indice.contains(nome)
        lock.unlock()
        let url = cartella.appendingPathComponent(nome)
        if !noto, !FileManager.default.fileExists(atPath: url.path) { return nil }
        guard let data = Self.leggi(url) else {
            // a bad file goes, so the next /scalda renders it again
            unlink(url.path)
            lock.lock(); indice.remove(nome); lock.unlock()
            return nil
        }
        lock.lock()
        indice.insert(nome)
        ricorda(nome, data)
        lock.unlock()
        return data
    }

    func salva(_ pcm: Data, chiave: String) throws {
        let nome = Self.nomeFile(chiave: chiave)
        try Self.scrivi(pcm, in: cartella.appendingPathComponent(nome))
        lock.lock()
        indice.insert(nome)
        if let old = memoria.removeValue(forKey: nome) {
            byteInMemoria -= old.count
            ordine.removeAll { $0 == nome }
        }
        lock.unlock()
    }

    /// Under `lock`.
    private func tocca(_ nome: String) {
        if let i = ordine.firstIndex(of: nome) { ordine.remove(at: i) }
        ordine.append(nome)
    }

    /// Under `lock`. A piece larger than the whole ceiling is not kept.
    private func ricorda(_ nome: String, _ data: Data) {
        guard data.count <= tetto else { return }
        if let old = memoria[nome] { byteInMemoria -= old.count }
        memoria[nome] = data
        byteInMemoria += data.count
        tocca(nome)
        while byteInMemoria > tetto, let first = ordine.first {
            ordine.removeFirst()
            if let d = memoria.removeValue(forKey: first) { byteInMemoria -= d.count }
        }
    }

    /// For tests: what the LRU holds, least recent first.
    var inMemoria: [String] { lock.lock(); defer { lock.unlock() }; return ordine }
}

/// How a voice turn cuts and cleans its text (Speaker.drain and emitPiece use these).
/// Pure, so VoceCache splits a filler exactly as the Speaker will.
enum PezziDiVoce {
    /// Index just past the next speakable boundary: end of sentence, newline, or (for the
    /// very first piece of a reply) the end of a clause long enough to be worth sending.
    static func boundary(in text: String, clauseOK: Bool) -> String.Index? {
        var idx = text.startIndex
        var count = 0
        while idx < text.endIndex {
            let ch = text[idx]
            count += 1
            let next = text.index(after: idx)
            let atEnd = next == text.endIndex
            let followedBySpace = !atEnd && (text[next] == " " || text[next] == "\n")
            if ch == "\n", count > 1 { return next }
            if ".!?".contains(ch), followedBySpace, count >= 8 {
                // Avoid splitting "3.5" or "ecc." in the middle of a list item.
                return next
            }
            if clauseOK, ",;:".contains(ch), followedBySpace, count >= 24 { return next }
            idx = next
        }
        return nil
    }

    /// Markdown and code fences read aloud are noise. Audio tags stay (ElevenLabs reads
    /// them as delivery; Apple strips them later).
    static func pulisci(_ text: String) -> String {
        var s = text
        s = s.replacingOccurrences(of: "```", with: " ")
        s = s.replacingOccurrences(of: #"[*_`#>]+"#, with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
