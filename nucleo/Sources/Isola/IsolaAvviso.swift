//
//  IsolaAvviso.swift
//  Bottega Nucleo
//
//  The service's voice on the island. The island (--isola, Isola.swift) shows who is speaking
//  only for the voice of its own process, the mod's. When the service speaks (the bar's
//  Melissa, or the character who has the call), each line that starts to sound goes to the
//  island too: POST /mostra {testo, chi}, and {fine: true} when the voice is over.
//
//  Fire and forget, off main, on one serial queue: nothing here ever waits on the voice or
//  holds it up. No island (no socket, nobody listening): nothing happens. More than a few
//  lines waiting (an island that does not answer) and the new lines are dropped; the end
//  always goes. Only in service mode: the island itself, the macOS mode and --cli never send.
//

import Darwin
import Foundation

@MainActor
enum IsolaAvviso {
    static let attivo: Bool = !Isola.attiva && !LaunchMode.fromMacOS
        && !CommandLine.arguments.contains("--cli")

    private nonisolated static let coda = DispatchQueue(label: "nucleo.isola.avviso", qos: .utility)
    private nonisolated static let lock = NSLock()
    nonisolated(unsafe) private static var inAttesa = 0
    private nonisolated static let massimoInAttesa = 6

    /// A line has just started to sound in the service: the island shows it under `chi`.
    static func battuta(_ testo: String, chi: String) {
        guard attivo, !testo.isEmpty else { return }
        manda(["testo": String(testo.prefix(500)), "chi": chi], scartabile: true)
    }

    /// The service's voice is over: the island goes back to rest, if it is still showing ours.
    static func fine() {
        guard attivo else { return }
        manda(["fine": true], scartabile: false)
    }

    private static func manda(_ corpo: [String: Any], scartabile: Bool) {
        let path = Isola.socketPath
        let body = JSON.encode(corpo)
        lock.lock()
        if scartabile && inAttesa >= massimoInAttesa { lock.unlock(); return }
        inAttesa += 1
        lock.unlock()
        coda.async {
            Self.invia(path: path, body: body)
            lock.lock(); inAttesa -= 1; lock.unlock()
        }
    }

    /// One HTTP/1.1 request on the island's socket, with a 1 s timeout each way. Any failure
    /// is silent: the island is optional.
    private nonisolated static func invia(path: String, body: String) {
        guard access(path, F_OK) == 0 else { return }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { return }
        defer { close(s) }
        var one: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        var tv = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        let connesso = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connesso == 0 else { return }
        let dati = Data(body.utf8)
        var richiesta = Data("POST /mostra HTTP/1.1\r\nHost: isola\r\nContent-Type: application/json\r\nContent-Length: \(dati.count)\r\nConnection: close\r\n\r\n".utf8)
        richiesta.append(dati)
        let scritto = richiesta.withUnsafeBytes { raw -> Bool in
            var off = 0
            while off < raw.count {
                let n = write(s, raw.baseAddress!.advanced(by: off), raw.count - off)
                if n <= 0 { return false }
                off += n
            }
            return true
        }
        guard scritto else { return }
        // the answer is only read away (the island closes after it), at most 1 s
        var buf = [UInt8](repeating: 0, count: 512)
        while read(s, &buf, buf.count) > 0 {}
    }
}
