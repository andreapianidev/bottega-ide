//
//  Protocol.swift
//  Bottega Nucleo
//
//  JSON lines on stdin/stdout (docs/CONTRATTI.md, section 1).
//  - one request per line in, one response or event per line out;
//  - every write to stdout goes through ONE serial queue, so lines never interleave
//    even when requests are answered concurrently;
//  - stderr is free-form log.
//

import Foundation
import Darwin

/// Minimal JSON encoder with control over number formatting. Vectors of 512 floats are
/// the heaviest thing we print: Float's shortest representation keeps them ~9 chars per
/// value instead of the 17 digits JSONSerialization would print for a Double.
enum JSON {
    static func encode(_ value: Any?) -> String {
        var out = ""
        out.reserveCapacity(256)
        write(value, into: &out)
        return out
    }

    private static func write(_ value: Any?, into out: inout String) {
        switch value {
        case nil, is NSNull:
            out += "null"
        case let n as NSNumber where Swift.type(of: value!) is NSNumber.Type:
            // Values that came from JSONSerialization (ids, echoed args) are NSNumbers:
            // they must be told apart from Swift Bools by their CF type, or 1 prints as true.
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                out += n.boolValue ? "true" : "false"
            } else if CFNumberIsFloatType(n) {
                write(n.doubleValue, into: &out)
            } else {
                out += n.stringValue
            }
        case let b as Bool:
            out += b ? "true" : "false"
        case let i as Int:
            out += String(i)
        case let i as Int32:
            out += String(i)
        case let i as Int64:
            out += String(i)
        case let u as UInt64:
            out += String(u)
        case let f as Float:
            out += f.isFinite ? shortest(f) : "0"
        case let d as Double:
            if d.isFinite {
                if d == d.rounded(), abs(d) < 1e15 { out += String(Int64(d)) } else { out += String(d) }
            } else { out += "0" }
        case let n as NSNumber:
            // Bridged values from JSONSerialization (ids, numeric args echoed back).
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                out += n.boolValue ? "true" : "false"
            } else if CFNumberIsFloatType(n) {
                write(n.doubleValue, into: &out)
            } else {
                out += n.stringValue
            }
        case let s as String:
            writeString(s, into: &out)
        case let fs as [Float]:
            out += "["
            for (i, f) in fs.enumerated() {
                if i > 0 { out += "," }
                out += f.isFinite ? shortest(f) : "0"
            }
            out += "]"
        case let arr as [Any?]:
            out += "["
            for (i, v) in arr.enumerated() {
                if i > 0 { out += "," }
                write(v, into: &out)
            }
            out += "]"
        case let arr as [Any]:
            out += "["
            for (i, v) in arr.enumerated() {
                if i > 0 { out += "," }
                write(v, into: &out)
            }
            out += "]"
        case let dict as [String: Any?]:
            writeObject(dict.map { ($0.key, $0.value) }, into: &out)
        case let dict as [String: Any]:
            writeObject(dict.map { ($0.key, Optional($0.value)) }, into: &out)
        default:
            writeString(String(describing: value!), into: &out)
        }
    }

    private static func writeObject(_ pairs: [(String, Any?)], into out: inout String) {
        // Stable order: `id`, `ok`, `event` first (easier to read in a log), then the rest.
        let head = ["id", "ok", "event", "error"]
        let sorted = pairs.sorted { a, b in
            let ia = head.firstIndex(of: a.0) ?? head.count
            let ib = head.firstIndex(of: b.0) ?? head.count
            return ia != ib ? ia < ib : a.0 < b.0
        }
        out += "{"
        var first = true
        for (k, v) in sorted {
            if !first { out += "," }
            first = false
            writeString(k, into: &out)
            out += ":"
            write(v, into: &out)
        }
        out += "}"
    }

    private static func shortest(_ f: Float) -> String {
        if f == 0 { return "0" }
        return String(describing: f)
    }

    private static func writeString(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 || scalar.value == 0x2028 || scalar.value == 0x2029 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}

/// Everything that leaves the process on stdout. Thread-safe: callable from any thread,
/// including audio render threads (it only enqueues).
enum Out {
    private static let queue = DispatchQueue(label: "nucleo.stdout", qos: .userInitiated)
    /// Off in --cli mode: there stdout carries the command's own output, not JSON lines.
    nonisolated(unsafe) static var enabled = true

    static func line(_ object: [String: Any?]) {
        guard enabled else { return }
        let text = JSON.encode(object) + "\n"
        queue.async {
            let data = Data(text.utf8)
            do {
                try FileHandle.standardOutput.write(contentsOf: data)
            } catch {
                // The parent closed our stdout: nobody is listening any more.
                Log.info("stdout chiuso, esco")
                exit(0)
            }
        }
    }

    static func respond(_ id: Any?, _ fields: [String: Any?] = [:]) {
        var o = fields
        o["id"] = id
        o["ok"] = true
        line(o)
    }

    static func fail(_ id: Any?, _ message: String) {
        line(["id": id, "ok": false, "error": message])
    }

    static func event(_ name: String, _ fields: [String: Any?] = [:]) {
        var o = fields
        o["event"] = name
        line(o)
    }

    /// Waits until everything queued has been written (used before exit).
    static func drain() {
        queue.sync {}
    }
}

/// stderr log, plus an optional `log` event towards the extension for warnings/errors.
enum Log {
    private static let queue = DispatchQueue(label: "nucleo.stderr", qos: .utility)
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    static func info(_ message: String) { write("info", message, forward: false) }
    static func warn(_ message: String) { write("warn", message, forward: true) }
    static func error(_ message: String) { write("error", message, forward: true) }

    private static func write(_ level: String, _ message: String, forward: Bool) {
        let stamp = formatter.string(from: Date())
        queue.async {
            FileHandle.standardError.write(Data("[nucleo \(stamp)] \(level): \(message)\n".utf8))
        }
        if forward { Out.event("log", ["level": level, "message": message]) }
    }
}

/// A decoded request line. Arguments are read leniently: JSON numbers may arrive as
/// Int or Double, booleans as Bool or 0/1.
struct Request: @unchecked Sendable {
    let id: Any?
    let cmd: String
    let args: [String: Any]

    init?(line: String) {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = obj["cmd"] as? String else { return nil }
        self.id = obj["id"]
        self.cmd = cmd
        self.args = obj
    }

    func string(_ key: String) -> String? {
        if let s = args[key] as? String { return s }
        return nil
    }

    func int(_ key: String) -> Int? {
        if let n = args[key] as? NSNumber { return n.intValue }
        if let s = args[key] as? String { return Int(s) }
        return nil
    }

    func bool(_ key: String) -> Bool? {
        if let n = args[key] as? NSNumber { return n.boolValue }
        return nil
    }

    func strings(_ key: String) -> [String]? {
        if let a = args[key] as? [Any] { return a.map { "\($0)" } }
        if let s = args[key] as? String { return [s] }
        return nil
    }

    func dicts(_ key: String) -> [[String: Any]]? {
        args[key] as? [[String: Any]]
    }

    func respond(_ fields: [String: Any?] = [:]) { Out.respond(id, fields) }
    func fail(_ message: String) { Out.fail(id, message) }
}

/// Paths and identity shared by every part.
enum Nucleo {
    /// The .app bundle even when we are started through the ~/.bottega/bin/nucleo
    /// symlink (Bundle.main does not resolve symlinks and would miss Info.plist).
    static let bundle: Bundle = {
        if Bundle.main.bundleIdentifier != nil { return Bundle.main }
        // proc_pidpath gives the real executable path, symlinks already resolved.
        var buf = [CChar](repeating: 0, count: 4096)
        let n = proc_pidpath(getpid(), &buf, UInt32(buf.count))
        let path = n > 0 ? String(cString: buf) : CommandLine.arguments[0]
        let exe = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        let app = exe.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return Bundle(url: app) ?? Bundle.main
    }()

    static let version: String = {
        let info = bundle.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "0.1.0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }()

    /// ~/.bottega/nucleo (created on demand, mode 700).
    static let supportDir: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".bottega/nucleo", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        return dir
    }()

    /// Bundle id domain (com.andreapiani.bottega.nucleo) because we run from inside the .app.
    static var defaults: UserDefaults { .standard }
}
