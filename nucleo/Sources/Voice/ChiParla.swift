//
//  ChiParla.swift
//  Bottega Nucleo
//
//  Who is speaking, from the voice: the island shows the name of the character whose line is
//  sounding now, and voice.spoken carries it as `chi`. The protocol does not change: /parla
//  and voice.speak already say the voice, the names come from the characters' files,
//  ~/.bottega/personaggi/*.json (`voce` -> `nome`; melissa.json and files without a voice
//  are skipped), read again at most once a minute. Melissa's own voice (ElevenLabsConfig),
//  the Apple voice and any voice not in the files are "Melissa".
//  The same files give the shape and colour of the sphere while that character speaks
//  (`sfera`, or from the key: SferaAspetto in Orb/OrbAspetto.swift), by name.
//

import Foundation

enum ChiParla {
    static let melissa = "Melissa"

    private static let lock = NSLock()
    nonisolated(unsafe) private static var mappa: [String: String] = [:]
    /// name -> shape and colour of the sphere (CONTRATTI 9.11, «La sfera di chi parla»).
    nonisolated(unsafe) private static var aspetti: [String: SferaAspetto] = [:]
    nonisolated(unsafe) private static var lettaIl = Date.distantPast
    private static let rilettura: TimeInterval = 60

    private static var cartella: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".bottega/personaggi", isDirectory: true)
    }

    /// The name for an ElevenLabs voice id (nil: the default voice).
    static func nome(voce: String?) -> String {
        guard let v = voce?.trimmingCharacters(in: .whitespaces), !v.isEmpty, v != "apple", v != "elevenlabs",
              !v.hasPrefix("com.apple."), v != ElevenLabsConfig.voiceID else { return melissa }
        return nomi()[v] ?? melissa
    }

    /// The name for a Speaker stream key, "model|voice".
    static func nome(chiave: String) -> String {
        guard let bar = chiave.firstIndex(of: "|") else { return melissa }
        return nome(voce: String(chiave[chiave.index(after: bar)...]))
    }

    /// The sphere of who speaks, by the name nome(voce:) gives: Melissa's for her and for a
    /// name not in the files.
    static func aspetto(nome: String) -> SferaAspetto {
        let n = nome.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty, n != melissa else { return .melissa }
        lock.lock(); defer { lock.unlock() }
        rileggi()
        return aspetti[n] ?? .melissa
    }

    private static func nomi() -> [String: String] {
        lock.lock(); defer { lock.unlock() }
        rileggi()
        return mappa
    }

    /// Under the lock: the files again, at most once a minute.
    private static func rileggi() {
        if Date().timeIntervalSince(lettaIl) < rilettura { return }
        lettaIl = Date()
        var m: [String: String] = [:]
        var a: [String: SferaAspetto] = [:]
        let files = (try? FileManager.default.contentsOfDirectory(at: cartella, includingPropertiesForKeys: nil)) ?? []
        for f in files where f.pathExtension == "json" && f.lastPathComponent != "melissa.json" {
            guard let data = try? Data(contentsOf: f),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  obj["chiave"] as? String != "melissa",
                  let voce = (obj["voce"] as? String)?.trimmingCharacters(in: .whitespaces), !voce.isEmpty,
                  let nome = (obj["nome"] as? String)?.trimmingCharacters(in: .whitespaces), !nome.isEmpty
            else { continue }
            m[voce] = nome
            let chiave = (obj["chiave"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
            a[nome] = SferaAspetto.leggi(obj["sfera"], chiave: chiave.isEmpty ? nome.lowercased() : chiave)
        }
        mappa = m
        aspetti = a
    }
}
