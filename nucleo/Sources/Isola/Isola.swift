//
//  Isola.swift
//  Bottega Nucleo
//
//  The fourth life: --isola. Melissa for Claude Code in a terminal, driven by the mod
//  `melissa` (~/claude-code-mods/melissa). One process per Mac. The mod launches it through
//  LaunchServices (`open -n -g -a "Bottega Nucleo.app" --args --isola`), so microphone and
//  speech recognition belong to the Nucleo and not to whichever terminal runs Claude Code.
//
//  It serves HTTP/1.1 on a Unix socket, ~/.bottega/nucleo/isola.sock, which the mod reaches
//  with $.http.fetch(url, { socketPath }). Every answer is JSON:
//
//    GET  /ping                              -> {ok, versione, parla, ascolta}  parla: something of
//                                             Melissa's voice is still to be heard (Speaker.isSounding,
//                                             not an open turn); ascolta: the microphone is open
//    POST /detta     {sessione, progetto}     -> {ok}  opens the microphone (Apple recognizer)
//    POST /detta/fine                         -> {ok}  closes it; the text arrives as an event
//    POST /stato     {stato, testo?}          -> {ok}  the island: pensa | pronto | riposo
//    POST /parla     {sessione, testo, append?, final?, voce?} -> {ok}  Melissa says it (ElevenLabs, Apple as
//                                             fallback); append streams pieces of one text in order
//    POST /zitta                              -> {ok}  silence now
//    GET  /eventi?sessione=X                  -> held up to 15 s: {eventi:[...]}
//
//  Events for a session: {tipo:"parziale", testo}, {tipo:"testo", testo} (the dictation is
//  over), {tipo:"errore", messaggio}, {tipo:"ferma"} (the island was clicked while Melissa's
//  voice for that session could be heard: the mod stops the Claude turn). A "ferma" nobody
//  collects within 3 s is dropped, so it never stops a later turn; /detta drops what a
//  session left in its queue.
//
//  The dictation closes by itself 3.5 s after the last new word, or with nothing said in 10 s.
//  The process quits after 15 minutes without requests, dictation or speech. One island per
//  Mac: a lock on ~/.bottega/nucleo/isola.lock, held for the process's life, keeps a second
//  one (two launches in the same instant) from taking the socket away from the first. An
//  island left showing "thinking" or "speaking" with nothing behind it for two minutes
//  goes back to rest by itself.
//

import AppKit
import Darwin

@MainActor
final class Isola {
    static let shared = Isola()

    static var attiva: Bool { CommandLine.arguments.contains("--isola") }

    static let socketPath: String = Nucleo.supportDir.appendingPathComponent("isola.sock").path

    private static let idleQuit: TimeInterval = 15 * 60
    private static let silenzioFine: TimeInterval = 3.5
    private static let silenzioVuoto: TimeInterval = 10
    private static let attesaEventi: TimeInterval = 15

    private var server: IsolaServer?
    /// The lock that makes this the only island; open for the process's life.
    private var lock: Int32 = -1
    /// The panel's phase at the last minute tick, and how many ticks it has stood still.
    private var faseVista: IsolaPanel.Fase = .riposo
    private var faseFerma = 0
    /// The session the microphone is open for.
    private var dettaPer: String?
    private var dettaParziale = ""
    /// Bumped at every /detta: a microphone that opens late knows whether it is still wanted.
    private var dettaGiro = 0
    private var silenzio: DispatchWorkItem?
    /// The session Melissa last spoke for (the one a click on the island stops).
    private var narraPer: String?
    private var code: [String: [[String: Any]]] = [:]
    private var attese: [String: [IsolaResponder]] = [:]
    private var ultimoUso = Date()
    /// A microphone closed for an old /detta still sends its voice.final: until this moment,
    /// a final that comes with no word heard in the new dictation is that one, not this.
    private var ignoraFinaleFinoA = Date.distantPast
    private static let fermaValido: TimeInterval = 3

    // MARK: - Start

    func start() {
        Out.enabled = false
        // two islands launched together both find no socket answering: the lock decides
        let lockPath = Nucleo.supportDir.appendingPathComponent("isola.lock").path
        lock = Darwin.open(lockPath, O_CREAT | O_RDWR, 0o600)
        if lock < 0 || flock(lock, LOCK_EX | LOCK_NB) != 0 {
            Log.info("isola: un'altra isola sta gia' partendo o gira, esco")
            exit(0)
        }
        if IsolaServer.risponde(path: Self.socketPath) {
            Log.info("isola: un'altra isola risponde gia' su \(Self.socketPath), esco")
            exit(0)
        }
        Out.tap = { name, fields in
            let testo = (fields["text"] as? String) ?? (fields["message"] as? String) ?? ""
            let stato = fields["state"] as? String ?? ""
            DispatchQueue.main.async {
                MainActor.assumeIsolated { Isola.shared.voce(name, testo: testo, stato: stato) }
            }
        }
        let s = IsolaServer(path: Self.socketPath) { req, res in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { Isola.shared.gestisci(req, res) }
            }
        }
        do {
            try s.start()
        } catch {
            Log.error("isola: il socket non si apre: \(error.localizedDescription)")
            exit(1)
        }
        server = s
        IsolaPanel.shared.onClick = { Isola.shared.clic() }
        Log.info("isola pronta su \(Self.socketPath), versione \(Nucleo.version)")
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
            MainActor.assumeIsolated { Isola.shared.forseEsci() }
        }
    }

    private func forseEsci() {
        riposaSeFerma()
        let occupata = dettaPer != nil || Speaker.shared.isSpeaking || Listener.shared.isCapturing
        guard !occupata, Date().timeIntervalSince(ultimoUso) > Self.idleQuit else { return }
        Log.info("isola: \(Int(Self.idleQuit / 60)) minuti senza richieste, esco")
        server?.stop()
        Service.shutdown(reason: "isola inattiva")
    }

    /// "Thinking" or "speaking" for two minute ticks in a row with no voice and no microphone:
    /// whoever should have moved it on (a session closed mid-turn) is gone.
    private func riposaSeFerma() {
        let fase = IsolaPanel.shared.fase
        let sospesa = (fase == .pensa || fase == .parla) && dettaPer == nil && !Speaker.shared.isSounding
        faseFerma = sospesa && fase == faseVista ? faseFerma + 1 : 0
        faseVista = fase
        if faseFerma >= 2 {
            Log.info("isola: ferma su \(fase) da due minuti senza voce, torna a riposo")
            IsolaPanel.shared.riposa(dopo: 0)
            faseFerma = 0
        }
    }

    // MARK: - Requests

    private func gestisci(_ req: IsolaRequest, _ res: IsolaResponder) {
        ultimoUso = Date()
        let corpo = req.json
        let sessione = (corpo["sessione"] as? String) ?? req.query["sessione"] ?? ""
        switch (req.method, req.path) {
        case ("GET", "/ping"):
            res.ok(["versione": Nucleo.version, "parla": Speaker.shared.isSounding, "ascolta": dettaPer != nil])

        case ("POST", "/detta"):
            guard !sessione.isEmpty else { return res.errore(400, "Manca la sessione.") }
            if let altra = dettaPer, altra != sessione {
                return res.errore(409, "Melissa sta gia' ascoltando un'altra sessione.")
            }
            if dettaPer == sessione { return res.ok() }
            dettaPer = sessione
            dettaParziale = ""
            narraPer = nil
            // what this session left unread (an old ferma, an old text) belongs to before
            code[sessione] = nil
            dettaGiro &+= 1
            let giro = dettaGiro
            IsolaPanel.shared.mostra(.ascolto, testo: "Ti ascolto")
            res.ok()
            Task {
                do {
                    // The first time macOS asks for the microphone here: the silence clock
                    // starts only once the microphone is really open.
                    try await Listener.shared.listen(mode: .push, locale: "it-IT")
                    if self.dettaPer == sessione, self.dettaGiro == giro {
                        self.armaSilenzio(vuoto: true)
                    } else {
                        // Closed (a click, an error) while the microphone was still opening:
                        // it must not stay open with nobody listening. Its final is not ours.
                        self.ignoraFinaleFinoA = Date().addingTimeInterval(2.5)
                        await Listener.shared.stop()
                    }
                } catch {
                    if self.dettaGiro == giro { self.fineDettatura(errore: error.localizedDescription) }
                }
            }

        case ("POST", "/detta/fine"):
            res.ok()
            chiudiDettatura()

        case ("POST", "/stato"):
            let testo = corpo["testo"] as? String
            switch corpo["stato"] as? String {
            case "pensa": IsolaPanel.shared.mostra(.pensa, testo: testo ?? "Ci penso")
            case "pronto":
                IsolaPanel.shared.mostra(.pronto, testo: testo ?? "Fatto")
                IsolaPanel.shared.riposa(dopo: 1.8)
            default: IsolaPanel.shared.riposa(dopo: 0)
            }
            res.ok()

        case ("POST", "/parla"):
            // append: a piece of a text still being written (Claude's answer read live), spoken
            // in order on the same warm ElevenLabs turn; final closes it (text may be empty then).
            let testo = (corpo["testo"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let append = corpo["append"] as? Bool ?? false
            let final = corpo["final"] as? Bool ?? !append
            // voce: another ElevenLabs voice of the account (a character Melissa passes the call
            // to). Only an id is taken: "apple" and com.apple.* would switch the engine.
            let voce = (corpo["voce"] as? String).flatMap { v in
                v.range(of: "^[A-Za-z0-9]{10,40}$", options: .regularExpression) != nil ? v : nil
            }
            guard !testo.isEmpty || final else { return res.errore(400, "Niente da dire.") }
            guard dettaPer == nil else { return res.errore(409, "Melissa sta ascoltando.") }
            if !sessione.isEmpty { narraPer = sessione }
            Log.info("isola: parla da \(sessione.prefix(8)), \(testo.count) caratteri\(append ? ", in coda" : "")\(final ? ", fine" : "")\(voce.map { ", voce \($0.prefix(6))" } ?? "")")
            if !testo.isEmpty { IsolaPanel.shared.mostra(.parla, testo: testo) }
            // a voice of its own opens its own turn: sent whole (append false), it closes the one open
            Speaker.shared.speak(text: testo.isEmpty ? "" : testo + " ", append: append, final: final, model: nil, voice: voce)
            res.ok(["voce": Speaker.shared.currentEngine.rawValue])

        case ("POST", "/zitta"):
            Log.info("isola: zitta da \(sessione.isEmpty ? "?" : String(sessione.prefix(8)))")
            Speaker.shared.stopSpeaking()
            // the voice stops; the island stays while the microphone is open
            if dettaPer == nil { IsolaPanel.shared.riposa(dopo: 0.3) }
            res.ok()

        case ("GET", "/eventi"):
            guard !sessione.isEmpty else { return res.errore(400, "Manca la sessione.") }
            if let pronti = code[sessione], !pronti.isEmpty {
                code[sessione] = nil
                let ora = Date().timeIntervalSince1970
                let validi = pronti.filter { ev in
                    guard ev["tipo"] as? String == "ferma", let at = ev["at"] as? Double else { return true }
                    return ora - at <= Self.fermaValido
                }
                if !validi.isEmpty { return res.ok(["eventi": validi]) }
            }
            attese[sessione, default: []].append(res)
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.attesaEventi) { [weak res] in
                MainActor.assumeIsolated {
                    guard let res else { return }
                    Isola.shared.scaduta(res, sessione: sessione)
                }
            }

        default:
            res.errore(404, "Non conosco \(req.method) \(req.path).")
        }
    }

    private func scaduta(_ res: IsolaResponder, sessione: String) {
        guard var lista = attese[sessione], let i = lista.firstIndex(where: { $0 === res }) else { return }
        lista.remove(at: i)
        attese[sessione] = lista.isEmpty ? nil : lista
        res.ok(["eventi": [Any]()])
    }

    /// Hands an event to the session: to a waiting /eventi if there is one, else to its queue.
    private func manda(_ evento: [String: Any], a sessione: String) {
        if var lista = attese[sessione], !lista.isEmpty {
            let res = lista.removeFirst()
            attese[sessione] = lista.isEmpty ? nil : lista
            res.ok(["eventi": [evento]])
            return
        }
        var q = code[sessione] ?? []
        // A partial replaces the previous one still waiting: only the latest text matters.
        if evento["tipo"] as? String == "parziale" { q.removeAll { $0["tipo"] as? String == "parziale" } }
        q.append(evento)
        code[sessione] = Array(q.suffix(50))
    }

    // MARK: - Dictation

    private func armaSilenzio(vuoto: Bool) {
        silenzio?.cancel()
        let work = DispatchWorkItem {
            MainActor.assumeIsolated { Isola.shared.chiudiDettatura() }
        }
        silenzio = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (vuoto ? Self.silenzioVuoto : Self.silenzioFine), execute: work)
    }

    private func chiudiDettatura() {
        silenzio?.cancel(); silenzio = nil
        guard dettaPer != nil else { return }
        IsolaPanel.shared.mostra(.pensa, testo: dettaParziale.isEmpty ? "Ci penso" : dettaParziale)
        if Listener.shared.isCapturing {
            Task { await Listener.shared.stop() }   // voice.final follows
        } else {
            fineDettatura(testo: dettaParziale)
        }
    }

    private func fineDettatura(testo: String = "", errore: String? = nil) {
        silenzio?.cancel(); silenzio = nil
        guard let sessione = dettaPer else { return }
        dettaPer = nil
        dettaParziale = ""
        if let errore {
            manda(["tipo": "errore", "messaggio": errore], a: sessione)
            IsolaPanel.shared.mostra(.errore, testo: errore)
            IsolaPanel.shared.riposa(dopo: 4)
            return
        }
        manda(["tipo": "testo", "testo": testo], a: sessione)
        if testo.isEmpty {
            IsolaPanel.shared.mostra(.pronto, testo: "Non ho sentito niente")
            IsolaPanel.shared.riposa(dopo: 1.5)
        }
    }

    // MARK: - Voice events (Out.tap)

    private func voce(_ name: String, testo: String, stato: String) {
        switch name {
        case "voice.partial":
            guard let sessione = dettaPer, !testo.isEmpty else { return }
            dettaParziale = testo
            IsolaPanel.shared.mostra(.ascolto, testo: testo)
            manda(["tipo": "parziale", "testo": testo], a: sessione)
            armaSilenzio(vuoto: false)
        case "voice.final":
            if Date() < ignoraFinaleFinoA, dettaParziale.isEmpty, testo.isEmpty {
                ignoraFinaleFinoA = .distantPast
                return
            }
            fineDettatura(testo: testo.isEmpty ? dettaParziale : testo)
        case "voice.state":
            if stato == "error", dettaPer != nil {
                fineDettatura(errore: testo.isEmpty ? "Il riconoscimento vocale si e' fermato." : testo)
            } else if stato == "idle", dettaPer == nil, IsolaPanel.shared.fase == .parla, !Speaker.shared.isSounding {
                IsolaPanel.shared.riposa(dopo: 1.2)
            }
        case "voice.spoken":
            if !testo.isEmpty, dettaPer == nil { IsolaPanel.shared.mostra(.parla, testo: testo) }
        default:
            break
        }
    }

    // MARK: - Click

    /// While dictating a click closes the sentence; while Melissa narrates it stops Claude
    /// (the mod aborts the turn) and silences her; otherwise it puts the island away.
    private func clic() {
        ultimoUso = Date()
        if dettaPer != nil {
            chiudiDettatura()
            return
        }
        // only while her voice can really be heard: a click on an island that is just
        // fading out puts it away, it does not stop Claude
        if let sessione = narraPer, Speaker.shared.isSounding {
            Speaker.shared.stopSpeaking()
            manda(["tipo": "ferma", "at": Date().timeIntervalSince1970], a: sessione)
            IsolaPanel.shared.mostra(.pronto, testo: "Fermo Claude")
            IsolaPanel.shared.riposa(dopo: 1.5)
            return
        }
        IsolaPanel.shared.riposa(dopo: 0)
    }
}

// MARK: - HTTP over a Unix socket

struct IsolaRequest: @unchecked Sendable {
    let method: String
    let path: String
    let query: [String: String]
    let json: [String: Any]
}

/// One connection's answer, sent once (a held /eventi answers later, from main).
final class IsolaResponder: @unchecked Sendable {
    private let fd: Int32
    private let lock = NSLock()
    private var sent = false

    init(fd: Int32) { self.fd = fd }

    func ok(_ fields: [String: Any?] = [:]) {
        var o = fields
        o["ok"] = true
        send(200, JSON.encode(o))
    }

    func errore(_ status: Int, _ message: String) {
        send(status, JSON.encode(["ok": false, "errore": message]))
    }

    private func send(_ status: Int, _ body: String) {
        lock.lock()
        if sent { lock.unlock(); return }
        sent = true
        lock.unlock()
        let data = Data(body.utf8)
        let reason = status == 200 ? "OK" : "Error"
        let head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(data.count)\r\nConnection: close\r\n\r\n"
        var all = Data(head.utf8)
        all.append(data)
        let fd = self.fd
        DispatchQueue.global(qos: .userInitiated).async {
            all.withUnsafeBytes { raw in
                var off = 0
                while off < raw.count {
                    let n = Darwin.write(fd, raw.baseAddress!.advanced(by: off), raw.count - off)
                    if n <= 0 { break }
                    off += n
                }
            }
            close(fd)
        }
    }
}

final class IsolaServer: @unchecked Sendable {
    private let path: String
    private let handler: @Sendable (IsolaRequest, IsolaResponder) -> Void
    private var fd: Int32 = -1
    private var source: DispatchSourceRead?
    private let queue = DispatchQueue(label: "nucleo.isola.accept")
    private let workers = DispatchQueue(label: "nucleo.isola.conn", attributes: .concurrent)

    init(path: String, handler: @escaping @Sendable (IsolaRequest, IsolaResponder) -> Void) {
        self.path = path
        self.handler = handler
    }

    private static func address(_ path: String) -> sockaddr_un? {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return nil }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        return addr
    }

    /// True when something already accepts connections on `path`.
    static func risponde(path: String) -> Bool {
        guard var addr = address(path) else { return false }
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { return false }
        defer { close(s) }
        let r = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        return r == 0
    }

    func start() throws {
        guard var addr = Self.address(path) else { throw NucleoError("Percorso del socket troppo lungo: \(path)") }
        unlink(path)
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw NucleoError("socket(): \(String(cString: strerror(errno)))") }
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else { throw NucleoError("bind(): \(String(cString: strerror(errno)))") }
        chmod(path, 0o600)
        guard listen(fd, 16) == 0 else { throw NucleoError("listen(): \(String(cString: strerror(errno)))") }
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        src.setEventHandler { [weak self] in self?.accetta() }
        src.resume()
        source = src
    }

    func stop() {
        source?.cancel()
        if fd >= 0 { close(fd) }
        unlink(path)
    }

    private func accetta() {
        let c = accept(fd, nil, nil)
        guard c >= 0 else { return }
        var one: Int32 = 1
        setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        var tv = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        workers.async { [handler] in
            guard let req = Self.leggi(c) else { close(c); return }
            handler(req, IsolaResponder(fd: c))
        }
    }

    /// Reads one request: headers, then Content-Length bytes of body (64 KB at most).
    private static func leggi(_ c: Int32) -> IsolaRequest? {
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        let sep = Data("\r\n\r\n".utf8)
        var headEnd: Range<Data.Index>?
        while headEnd == nil {
            let n = read(c, &buf, buf.count)
            if n <= 0 { return nil }
            data.append(contentsOf: buf[0..<n])
            headEnd = data.range(of: sep)
            if data.count > 65_536 { return nil }
        }
        guard let end = headEnd,
              let head = String(data: data[..<end.lowerBound], encoding: .utf8) else { return nil }
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines.first?.split(separator: " ") ?? []
        guard parts.count >= 2 else { return nil }
        var length = 0
        for line in lines.dropFirst() {
            let kv = line.split(separator: ":", maxSplits: 1)
            if kv.count == 2, kv[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
                length = Int(kv[1].trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }
        guard length <= 65_536 else { return nil }
        var body = Data(data[end.upperBound...])
        while body.count < length {
            let n = read(c, &buf, min(buf.count, length - body.count))
            if n <= 0 { break }
            body.append(contentsOf: buf[0..<n])
        }
        let target = String(parts[1])
        let comps = URLComponents(string: target)
        var query: [String: String] = [:]
        for item in comps?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        return IsolaRequest(method: String(parts[0]).uppercased(), path: comps?.path ?? target,
                            query: query, json: json)
    }
}
