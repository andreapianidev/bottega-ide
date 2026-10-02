//
//  PonteComandi.swift
//  Bottega Nucleo
//
//  What the bridge to the iPhone needs from the native side (docs/CONTRATTI.md, section 9).
//  The bridge itself (HTTP on the Tailscale address) lives in the extension, src/ponte.ts.
//
//    ponte.voce {testo}  -> {path, engine, seconds}   Melissa's voice in a WAV file, for the
//                                                     iPhone: the ElevenLabs key stays on the Mac
//    ponte.qr {testo}    -> {png}                     a QR code (base64 PNG) for pairing
//

import CoreImage
import CoreImage.CIFilterBuiltins
import AppKit
import Foundation

@MainActor
enum PonteComandi {
    static let commands: Set<String> = ["ponte.voce", "ponte.qr"]

    static func handle(_ r: Request) async throws -> Bool {
        guard commands.contains(r.cmd) else { return false }
        let testo = r.string("testo") ?? ""
        switch r.cmd {
        case "ponte.voce":
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bottega-ponte", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            pulisci(dir)
            let url = dir.appendingPathComponent("\(UUID().uuidString).wav")
            let info = try await SpeechFile.render(text: testo, to: url, engine: nil, via: nil)
            r.respond(["path": url.path, "engine": info["engine"] ?? nil, "seconds": info["seconds"] ?? nil])
        default:
            guard !testo.isEmpty else { throw NucleoError("Il testo del QR e' vuoto.") }
            r.respond(["png": try qr(testo).base64EncodedString()])
        }
        return true
    }

    /// Black on white, 12 px per module, with the quiet zone CoreImage leaves around it.
    static func qr(_ text: String) throws -> Data {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let img = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 12, y: 12)) else {
            throw NucleoError("CoreImage non ha prodotto il QR.")
        }
        let rep = NSBitmapImageRep(ciImage: img)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            throw NucleoError("Il QR non si converte in PNG.")
        }
        return png
    }

    /// The extension reads each file right away: anything older than ten minutes is left over.
    private static func pulisci(_ dir: URL) {
        let fm = FileManager.default
        let limit = Date().addingTimeInterval(-600)
        for f in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            let d = (try? f.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            if d < limit { try? fm.removeItem(at: f) }
        }
    }
}
