//
//  BachecaViva.swift
//  Bottega Nucleo
//
//  The live board. FSEvents on ~/.bottega/memoria/bacheca (no polling: 0% CPU when quiet),
//  every new line of a `<chiave>.jsonl` becomes a `bacheca.attivita` event, and for each
//  session a sentence ("Claude sta sistemando il login di Peak") is generated on the Mac
//  after 20 s of calm (or 90 s of continuous work), at most one per session every 90 s,
//  one generation at a time. Sentences go to `frasi.json` (mode 600, last 6 hours) and
//  out as `bacheca.frase`.
//
//  BOTTEGA_BACHECA_DIR points it elsewhere (tests); otherwise BOTTEGA_HOME/memoria/bacheca.
//

import Foundation
import CoreServices

final class BachecaViva: @unchecked Sendable {
    static let shared = BachecaViva()

    /// Every new board line, on the main queue (the Metal sky makes the star pulse).
    var onActivity: ((_ project: String, _ key: String, _ kind: String) -> Void)?

    static let calm: TimeInterval = 20
    static let maxBusy: TimeInterval = 90
    static let minGap: TimeInterval = 90
    static let keep: TimeInterval = 6 * 3600
    static let backlog: TimeInterval = 10 * 60

    static var dir: URL {
        let env = ProcessInfo.processInfo.environment
        if let d = env["BOTTEGA_BACHECA_DIR"], !d.isEmpty { return URL(fileURLWithPath: d, isDirectory: true) }
        let home = env["BOTTEGA_HOME"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".bottega", isDirectory: true)
        return home.appendingPathComponent("memoria/bacheca", isDirectory: true)
    }
    static var frasiURL: URL { dir.appendingPathComponent("frasi.json") }

    private struct FileState {
        var inode: UInt64
        var offset: UInt64
        var lastAt: Int64
    }

    private struct SessionState {
        var sessionId: String
        var project: String
        var key: String
        var events: [RigaBacheca] = []
        var lastPrompt: RigaBacheca?
        var pendingSince: Date?
        var lastEvent = Date.distantPast
        var lastFrase = Date.distantPast
        var newestAt: Int64 = 0
        var queued = false
    }

    private let q = DispatchQueue(label: "nucleo.bacheca", qos: .utility)
    private var stream: FSEventStreamRef?
    private var files: [String: FileState] = [:]
    private var sessions: [String: SessionState] = [:]
    private var frasi: [String: [String: Any]] = [:]
    private var timer: DispatchSourceTimer?
    private var waiting: [String] = []
    private var generating = false
    private var pausedUntil = Date.distantPast
    private var watchedDir: URL?

    var isOn: Bool { q.sync { stream != nil } }

    // MARK: - Start / stop

    func start() throws {
        try q.sync {
            guard stream == nil else { return }
            let dir = Self.dir
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                     attributes: [.posixPermissions: 0o700])
            watchedDir = dir
            frasi = loadFrasi()
            seed(dir)
            var ctx = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(),
                                           retain: nil, release: nil, copyDescription: nil)
            let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes
                                                 | kFSEventStreamCreateFlagIgnoreSelf | kFSEventStreamCreateFlagWatchRoot)
            guard let s = FSEventStreamCreate(kCFAllocatorDefault, { _, info, count, paths, _, _ in
                guard let info else { return }
                let me = Unmanaged<BachecaViva>.fromOpaque(info).takeUnretainedValue()
                let list = (unsafeBitCast(paths, to: NSArray.self) as? [String]) ?? []
                me.changed(Array(list.prefix(count)))
            }, &ctx, [dir.path] as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 1.0, flags) else {
                throw NucleoError("Non riesco a guardare la cartella della bacheca.")
            }
            FSEventStreamSetDispatchQueue(s, q)
            guard FSEventStreamStart(s) else {
                FSEventStreamInvalidate(s); FSEventStreamRelease(s)
                throw NucleoError("Non riesco ad avviare l'osservatore della bacheca.")
            }
            stream = s
            Log.info("bacheca viva accesa su \(dir.path) (\(files.count) file, \(sessions.count) sessioni recenti)")
            reschedule()
        }
    }

    func stop() {
        q.sync {
            if let s = stream {
                FSEventStreamStop(s); FSEventStreamInvalidate(s); FSEventStreamRelease(s)
            }
            stream = nil
            timer?.cancel(); timer = nil
            waiting.removeAll()
            files.removeAll()
            sessions.removeAll()
            Log.info("bacheca viva spenta")
        }
    }

    /// The sentences of the last 6 hours, newest first (from memory when on, from disk when off).
    func frasiRecenti() -> [[String: Any]] {
        q.sync {
            let source = stream != nil ? frasi : loadFrasi()
            return source.values.sorted { (($0["at"] as? NSNumber)?.int64Value ?? 0) > (($1["at"] as? NSNumber)?.int64Value ?? 0) }
        }
    }

    // MARK: - Reading the files (on q)

    /// Initial state: offsets at the end, no backlog except the last 10 minutes, which are
    /// fed to the sessions so a live session gets its sentence right away.
    private func seed(_ dir: URL) {
        let since = Int64((Date().timeIntervalSince1970 - Self.backlog) * 1000)
        for url in boardFiles(dir) {
            guard let (inode, size) = fileInfo(url), let data = try? Data(contentsOf: url) else { continue }
            var lastAt: Int64 = 0
            let consumed = completeLength(data)
            let key = url.deletingPathExtension().lastPathComponent
            for line in lines(data.prefix(consumed)) {
                guard let r = RigaBacheca(line: line) else { continue }
                lastAt = max(lastAt, r.at)
                if r.at >= since { track(r, key: key, live: false) }
            }
            files[key] = FileState(inode: inode, offset: min(UInt64(consumed), size), lastAt: lastAt)
        }
        // Sessions whose sentence already covers their last event wait for new ones.
        for (sid, s) in sessions {
            if let upTo = (frasi[sid]?["upTo"] as? NSNumber)?.int64Value, upTo >= s.newestAt {
                sessions[sid]?.pendingSince = nil
            }
        }
    }

    private func changed(_ paths: [String]) {
        let relevant = paths.contains { p in
            !p.contains("/sessioni/") && !p.hasSuffix("/sessioni") && !p.hasSuffix(".tmp") && !p.hasSuffix("frasi.json")
        }
        guard relevant, let dir = watchedDir else { return }
        var any = false
        for url in boardFiles(dir) {
            if readNew(url) { any = true }
        }
        if any { reschedule() }
    }

    /// Reads what was appended since last time. True when there were new lines.
    private func readNew(_ url: URL) -> Bool {
        let key = url.deletingPathExtension().lastPathComponent
        guard let (inode, size) = fileInfo(url) else { return false }
        var st = files[key] ?? FileState(inode: inode, offset: 0, lastAt: 0)
        let rotated = st.inode != inode || size < st.offset
        if !rotated && size == st.offset { return false }
        if rotated { st.offset = 0; st.inode = inode }
        guard let h = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? h.close() }
        do { try h.seek(toOffset: st.offset) } catch { return false }
        guard let data = try? h.readToEnd(), !data.isEmpty else { files[key] = st; return false }
        let consumed = completeLength(data)
        var got = false
        for line in lines(data.prefix(consumed)) {
            guard let r = RigaBacheca(line: line) else { continue }
            // After the memoria rewrote the file (rotation) the old lines come back: skip them.
            // Otherwise the offset is the truth (two hooks may append slightly out of order).
            if rotated && r.at <= st.lastAt { continue }
            st.lastAt = max(st.lastAt, r.at)
            track(r, key: key, live: true)
            got = true
        }
        st.offset += UInt64(consumed)
        files[key] = st
        return got
    }

    private func track(_ r: RigaBacheca, key: String, live: Bool) {
        if live {
            Out.event("bacheca.attivita", ["project": r.project, "key": key, "sessionId": r.sessionId,
                                           "kind": r.kind, "at": r.at])
            if let cb = onActivity {
                let project = r.project, kind = r.kind
                DispatchQueue.main.async { cb(project, key, kind) }
            }
        }
        guard !r.sessionId.isEmpty else { return }
        var s = sessions[r.sessionId] ?? SessionState(sessionId: r.sessionId, project: r.project, key: key)
        if !r.project.isEmpty { s.project = r.project }
        s.key = key
        s.events.append(r)
        if s.events.count > 30 { s.events.removeFirst(s.events.count - 30) }
        if r.kind == "prompt" { s.lastPrompt = r }
        s.newestAt = max(s.newestAt, r.at)
        let when = live ? Date() : Date(timeIntervalSince1970: TimeInterval(r.at) / 1000)
        s.lastEvent = max(s.lastEvent, when)
        if s.pendingSince == nil { s.pendingSince = when }
        sessions[r.sessionId] = s
    }

    // MARK: - Scheduling (on q)

    private func due(_ s: SessionState) -> Date? {
        guard let since = s.pendingSince, !s.queued else { return nil }
        let ready = min(s.lastEvent.addingTimeInterval(Self.calm), since.addingTimeInterval(Self.maxBusy))
        return max(ready, s.lastFrase.addingTimeInterval(Self.minGap), pausedUntil)
    }

    /// One-shot timer at the earliest due session (no periodic wakeups).
    private func reschedule() {
        timer?.cancel(); timer = nil
        guard stream != nil else { return }
        prune()
        let now = Date()
        var next: Date?
        for (sid, s) in sessions {
            guard let d = due(s) else { continue }
            if d <= now {
                sessions[sid]?.queued = true
                waiting.append(sid)
            } else if next == nil || d < next! {
                next = d
            }
        }
        pump()
        guard let next else { return }
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + max(0.5, next.timeIntervalSinceNow), leeway: .seconds(2))
        t.setEventHandler { [weak self] in self?.reschedule() }
        t.resume()
        timer = t
    }

    private func pump() {
        guard !generating, stream != nil, !waiting.isEmpty else { return }
        let info = ProcessInfo.processInfo
        if info.thermalState == .serious || info.thermalState == .critical || info.isLowPowerModeEnabled {
            // Too hot or saving power: try again in 90 s.
            pausedUntil = Date().addingTimeInterval(Self.minGap)
            for sid in waiting { sessions[sid]?.queued = false }
            waiting.removeAll()
            Log.info("bacheca viva: frasi rimandate (temperatura o risparmio energetico)")
            return
        }
        let sid = waiting.removeFirst()
        guard let s = sessions[sid] else { pump(); return }
        generating = true
        var events = Array(s.events.suffix(12))
        if let p = s.lastPrompt, !events.contains(where: { $0.kind == "prompt" }) { events.insert(p, at: 0) }
        let upTo = s.newestAt
        let project = s.project, key = s.key
        Task.detached(priority: .utility) { [weak self] in
            let start = Date()
            var result: FraseBacheca?
            var failure: NucleoError?
            do {
                result = try await Guidata.frase(eventi: events, progetto: project)
            } catch {
                failure = CervelloErrori.translate(error)
            }
            let ms = Int(Date().timeIntervalSince(start) * 1000)
            self?.q.async { self?.finished(sid: sid, key: key, upTo: upTo, result: result, failure: failure, ms: ms) }
        }
    }

    private func finished(sid: String, key: String, upTo: Int64, result: FraseBacheca?, failure: NucleoError?, ms: Int) {
        generating = false
        let now = Date()
        if var s = sessions[sid] {
            s.queued = false
            s.lastFrase = now
            // Events that arrived during the generation stay pending.
            s.pendingSince = s.newestAt > upTo ? now : nil
            sessions[sid] = s
        }
        if let f = result {
            let rec: [String: Any] = ["sessionId": sid, "project": f.progetto, "key": key, "frase": f.frase,
                                      "azione": f.azione, "oggetto": f.oggetto,
                                      "at": Int64(now.timeIntervalSince1970 * 1000), "upTo": upTo]
            frasi[sid] = rec
            saveFrasi()
            Out.event("bacheca.frase", rec)
            Log.info("bacheca viva: \(f.frase) (\(ms) ms)")
        } else if let failure {
            Log.warn("bacheca viva: frase non generata: \(failure.message)")
            if failure.unavailable { pausedUntil = now.addingTimeInterval(600) }
        }
        reschedule()
    }

    private func prune() {
        let cutoff = Date().addingTimeInterval(-Self.keep)
        sessions = sessions.filter { $0.value.lastEvent > cutoff || $0.value.queued }
        let cutoffMs = Int64(cutoff.timeIntervalSince1970 * 1000)
        frasi = frasi.filter { (($0.value["at"] as? NSNumber)?.int64Value ?? 0) >= cutoffMs }
    }

    // MARK: - frasi.json

    private func loadFrasi() -> [String: [String: Any]] {
        guard let data = try? Data(contentsOf: Self.frasiURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let s = obj["sessions"] as? [String: [String: Any]] else { return [:] }
        let cutoffMs = Int64((Date().timeIntervalSince1970 - Self.keep) * 1000)
        return s.filter { (($0.value["at"] as? NSNumber)?.int64Value ?? 0) >= cutoffMs }
    }

    private func saveFrasi() {
        let url = Self.frasiURL
        let obj: [String: Any] = ["version": 1, "sessions": frasi]
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
        let tmp = url.deletingLastPathComponent().appendingPathComponent("frasi.json.\(getpid()).tmp")
        guard FileManager.default.createFile(atPath: tmp.path, contents: data,
                                             attributes: [.posixPermissions: 0o600]) else {
            Log.warn("bacheca viva: non riesco a scrivere \(tmp.path)")
            return
        }
        if rename(tmp.path, url.path) != 0 {
            Log.warn("bacheca viva: non riesco a sostituire frasi.json (errno \(errno))")
            unlink(tmp.path)
        }
    }

    // MARK: - Helpers

    private func boardFiles(_ dir: URL) -> [URL] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return names.filter { $0.hasSuffix(".jsonl") && !$0.hasPrefix(".") }
            .map { dir.appendingPathComponent($0) }
    }

    private func fileInfo(_ url: URL) -> (UInt64, UInt64)? {
        var st = stat()
        guard stat(url.path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { return nil }
        return (UInt64(st.st_ino), UInt64(st.st_size))
    }

    /// Bytes up to and including the last newline (a half-written line waits for the next round).
    private func completeLength(_ data: Data) -> Int {
        guard let last = data.lastIndex(of: 0x0A) else { return 0 }
        return data.distance(from: data.startIndex, to: last) + 1
    }

    private func lines(_ data: Data) -> [String] {
        String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init)
    }
}
