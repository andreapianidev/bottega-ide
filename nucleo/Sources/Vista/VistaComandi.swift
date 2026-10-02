//
//  VistaComandi.swift
//  Bottega Nucleo
//
//  Entry point of the Vista (Vision): Nativo.handle and NativoCLI.run reach it through here.
//  (Documents and the short Apple Intelligence jobs were measured on 2 Oct 2026 and left
//  out: docs/CONTRATTI.md, 8.)
//
//    vision.ocr {path? | base64?, lingue?}  -> {testo, righe: [{testo, conf}], ms}
//    vision.guarda {lingue?}                 -> {testo, righe, app, finestra?, ms}
//                                               | error + permesso: false
//

import Foundation

@MainActor
enum VistaComandi {
    static let commands: Set<String> = ["vision.ocr", "vision.guarda"]

    static func handle(_ r: Request) async throws -> Bool {
        guard commands.contains(r.cmd) else { return false }
        let start = Date()
        let args = r.args
        do {
            var out = try await Task.detached(priority: .userInitiated) { try await esegui(r.cmd, args) }.value
            out["ms"] = Int(Date().timeIntervalSince(start) * 1000)
            r.respond(out)
        } catch is Schermo.SenzaPermesso {
            Out.line(["id": r.id, "ok": false, "error": Schermo.messaggioPermesso, "permesso": false])
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            Out.line(["id": r.id, "ok": false, "error": message])
        }
        return true
    }

    nonisolated static func esegui(_ cmd: String, _ a: [String: Any]) async throws -> [String: Any?] {
        let lingue = (a["lingue"] as? [Any])?.map { "\($0)" }
        switch cmd {
        case "vision.ocr":
            let e: Ocr.Esito
            if let b64 = a["base64"] as? String, !b64.isEmpty {
                e = try await Ocr.testo(data: try decodifica(b64), lingue: lingue)
            } else if let path = a["path"] as? String, !path.isEmpty {
                e = try await Ocr.testo(url: URL(fileURLWithPath: (path as NSString).expandingTildeInPath), lingue: lingue)
            } else {
                throw NucleoError("Serve path o base64 dell'immagine.")
            }
            return ["testo": e.testo, "righe": e.righe.map { ["testo": $0.testo, "conf": Double($0.conf)] }]
        case "vision.guarda":
            let e = try await Schermo.guarda(lingue: lingue)
            return ["testo": e.testo, "righe": e.righe, "app": e.app, "finestra": e.finestra]
        default:
            throw NucleoError("Comando sconosciuto: \(cmd)")
        }
    }

    /// Base64, also as a data: URL.
    nonisolated static func decodifica(_ s: String) throws -> Data {
        var b = s
        if b.hasPrefix("data:"), let comma = b.firstIndex(of: ",") { b = String(b[b.index(after: comma)...]) }
        guard let d = Data(base64Encoded: b, options: .ignoreUnknownCharacters), !d.isEmpty else {
            throw NucleoError("Il base64 dell'immagine non e' valido.")
        }
        return d
    }
}

// MARK: - Command line

/// `BottegaNucleo --cli <comando>` for the Vista. nil = not ours.
///
///   ocr                     long process: stdin lines {id, base64, mime?} -> stdout {id, testo, ms} | {id, error}
///   ocr-file <percorso>     {testo, righe, ms}
///   guarda                  {testo, righe, app, finestra?, ms}   (captures the screen: by hand only)
enum VistaCLI {
    static let commands: Set<String> = ["ocr", "ocr-file", "guarda"]

    static func run(_ args: [String]) -> Int32? {
        guard let command = args.first, commands.contains(command) else { return nil }
        Out.enabled = false
        switch command {
        case "ocr":
            return ocrStream()
        case "ocr-file":
            guard args.count >= 2 else { return usage() }
            return uno("vision.ocr", ["path": args[1]])
        case "guarda":
            return uno("vision.guarda", [:])
        default:
            return nil
        }
    }

    private static func uno(_ cmd: String, _ a: [String: Any]) -> Int32 {
        attendi {
            let start = Date()
            do {
                var out = try await VistaComandi.esegui(cmd, a)
                out["ms"] = Int(Date().timeIntervalSince(start) * 1000)
                print(JSON.encode(out))
                return 0
            } catch is Schermo.SenzaPermesso {
                print(JSON.encode(["error": Schermo.messaggioPermesso, "permesso": false]))
                return 1
            }
        }
    }

    /// One line in, one line out, flushed at once: the caller (memoria/lib/immagini.mjs) keeps
    /// the process open and feeds it images as it finds them.
    private static func ocrStream() -> Int32 {
        while let line = readLine(strippingNewline: true) {
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                print(JSON.encode(["id": nil, "error": "Riga non valida: serve {id, base64, mime?}."])); fflush(stdout)
                continue
            }
            let id = obj["id"]
            let b64 = (obj["base64"] as? String) ?? ""
            _ = attendi {
                let start = Date()
                do {
                    let e = try await Ocr.testo(data: try VistaComandi.decodifica(b64))
                    print(JSON.encode(["id": id, "testo": e.testo, "ms": Int(Date().timeIntervalSince(start) * 1000)]))
                } catch {
                    let m = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                    print(JSON.encode(["id": id, "error": m]))
                }
                return 0
            }
        }
        return 0
    }

    /// Runs async work from the synchronous CLI, then flushes stdout.
    static func attendi(_ body: @escaping @Sendable () async throws -> Int32) -> Int32 {
        final class Box: @unchecked Sendable { var code: Int32 = 1 }
        let box = Box()
        let sem = DispatchSemaphore(value: 0)
        Task.detached {
            do {
                box.code = try await body()
            } catch {
                let m = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                FileHandle.standardError.write(Data("nucleo: \(m)\n".utf8))
                box.code = (error as? NucleoError)?.unavailable == true ? 2 : 1
            }
            sem.signal()
        }
        sem.wait()
        fflush(stdout)
        return box.code
    }

    private static func usage() -> Int32 {
        FileHandle.standardError.write(Data("""
        uso: BottegaNucleo --cli <comando>
          ocr                       righe JSON {id, base64, mime?} su stdin, una riga {id, testo, ms} per immagine
          ocr-file <percorso>
          guarda                    cattura lo schermo principale e lo legge (chiede il permesso la prima volta)

        """.utf8))
        return 64
    }
}
