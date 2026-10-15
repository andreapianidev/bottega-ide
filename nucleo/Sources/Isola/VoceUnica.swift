//
//  VoceUnica.swift
//  Bottega Nucleo
//
//  One Melissa on the Mac (docs/CONTRATTI.md, 4.11, «Chi ha la voce»; Andrea, 15 October 2026).
//  The bar of the Bottega, this island and Melissa of Avo Agency AI share one file,
//  ~/.bottega/voce/chi.json: {"chi": "bottega"|"avo"|"isola"|"", "pid", "at" (seconds), "personaggio"?}.
//  Whoever opens the microphone for Andrea writes it (takes the voice), whoever stops and held it
//  writes chi "" (leaves it). The island takes it when dictation opens and leaves it when it closes;
//  while another surface holds it, the island's lines wait in the queue as they do with the
//  microphone open (Isola: /parla, giraCoda). Avo and the bar also silence the island directly
//  with POST /zitta.
//

import Foundation
import Darwin

enum VoceUnica {
    static let io = "isola"
    /// A hold older than this no longer counts, even with its process alive.
    static let durataMassima: TimeInterval = 30 * 60

    private static var file: URL {
        Nucleo.supportDir.deletingLastPathComponent().appendingPathComponent("voce/chi.json")
    }

    private static func leggi() -> [String: Any]? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func scrivi(chi: String) {
        let dir = file.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        let presa: [String: Any] = ["chi": chi, "pid": Int(getpid()), "at": Date().timeIntervalSince1970]
        guard let data = try? JSONSerialization.data(withJSONObject: presa) else { return }
        let tmp = dir.appendingPathComponent(".chi.\(getpid()).tmp")
        guard FileManager.default.createFile(atPath: tmp.path, contents: data,
                                             attributes: [.posixPermissions: 0o600]) else { return }
        if rename(tmp.path, file.path) != 0 { try? FileManager.default.removeItem(at: tmp) }
    }

    /// The island opens the microphone: the other Melissas go quiet and drop theirs.
    static func prendi() { scrivi(chi: io) }

    /// Dictation over: the voice is free again, but only if it is still ours.
    static func lascia() {
        guard let p = leggi(), p["chi"] as? String == io, (p["pid"] as? Int) == Int(getpid()) else { return }
        scrivi(chi: "")
    }

    /// Another Melissa (Avo, the bar) is talking with Andrea now: live process, fresh hold.
    static func tenutaDaAltri(ora: Date = Date()) -> Bool {
        guard let p = leggi(), let chi = p["chi"] as? String, !chi.isEmpty, chi != io,
              let at = p["at"] as? Double, ora.timeIntervalSince1970 - at < durataMassima,
              let pid = p["pid"] as? Int else { return false }
        return kill(pid_t(pid), 0) == 0 || errno == EPERM
    }
}
