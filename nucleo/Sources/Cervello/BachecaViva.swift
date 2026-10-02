//
//  BachecaViva.swift
//  Bottega Nucleo
//
//  The live board. FSEvents on ~/.bottega/memoria/bacheca (no polling: 0% CPU when quiet):
//  every new line of a `<chiave>.jsonl` becomes a `bacheca.attivita` event and a pulse of
//  that project's star in the Metal sky (onActivity). The sentences written on the Mac
//  ("Claude sta sistemando il login di Peak") were measured on 2 Oct 2026 on real sessions
//  and came out too vague: they are not generated (docs/CONTRATTI.md, 7.2).
//
//  BOTTEGA_BACHECA_DIR points it elsewhere (tests); otherwise BOTTEGA_HOME/memoria/bacheca.
//

import Foundation
import CoreServices

final class BachecaViva: @unchecked Sendable {
    static let shared = BachecaViva()

    /// Every new board line, on the main queue (the Metal sky makes the star pulse).
    var onActivity: ((_ project: String, _ key: String, _ kind: String) -> Void)?


    static var dir: URL {
        let env = ProcessInfo.processInfo.environment
        if let d = env["BOTTEGA_BACHECA_DIR"], !d.isEmpty { return URL(fileURLWithPath: d, isDirectory: true) }
        let home = env["BOTTEGA_HOME"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".bottega", isDirectory: true)
        return home.appendingPathComponent("memoria/bacheca", isDirectory: true)
    }

    private struct FileState {
        var inode: UInt64
        var offset: UInt64
        var lastAt: Int64
    }

    private let q = DispatchQueue(label: "nucleo.bacheca", qos: .utility)
    private var stream: FSEventStreamRef?
    private var files: [String: FileState] = [:]
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
            Log.info("bacheca viva accesa su \(dir.path) (\(files.count) file)")
        }
    }

    func stop() {
        q.sync {
            if let s = stream {
                FSEventStreamStop(s); FSEventStreamInvalidate(s); FSEventStreamRelease(s)
            }
            stream = nil
            files.removeAll()
            Log.info("bacheca viva spenta")
        }
    }

    // MARK: - Reading the files (on q)

    /// Initial state: offsets at the end of every file, nothing old is replayed.
    private func seed(_ dir: URL) {
        for url in boardFiles(dir) {
            guard let (inode, size) = fileInfo(url), let data = try? Data(contentsOf: url) else { continue }
            var lastAt: Int64 = 0
            let consumed = completeLength(data)
            for line in lines(data.prefix(consumed)) {
                if let r = RigaBacheca(line: line) { lastAt = max(lastAt, r.at) }
            }
            let key = url.deletingPathExtension().lastPathComponent
            files[key] = FileState(inode: inode, offset: min(UInt64(consumed), size), lastAt: lastAt)
        }
    }

    private func changed(_ paths: [String]) {
        let relevant = paths.contains { p in
            !p.contains("/sessioni/") && !p.hasSuffix("/sessioni") && !p.hasSuffix(".tmp")
        }
        guard relevant, let dir = watchedDir else { return }
        for url in boardFiles(dir) { _ = readNew(url) }
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
            track(r, key: key)
            got = true
        }
        st.offset += UInt64(consumed)
        files[key] = st
        return got
    }

    private func track(_ r: RigaBacheca, key: String) {
        Out.event("bacheca.attivita", ["project": r.project, "key": key, "sessionId": r.sessionId,
                                       "kind": r.kind, "at": r.at])
        if let cb = onActivity {
            let project = r.project, kind = r.kind
            DispatchQueue.main.async { cb(project, key, kind) }
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
