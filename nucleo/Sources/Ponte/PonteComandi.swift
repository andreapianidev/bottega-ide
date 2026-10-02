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
//  Live voice for the iPhone, while Melissa is still answering (the same warm ElevenLabs socket and
//  model the Mac speaks with, eleven_v4_turbo, flushed clause by clause like Speaker.swift):
//    ponte.flusso.apri {id}            -> {ok}  opens (or reuses) the socket
//    ponte.flusso.testo {id, testo}    -> {}    one clause, flushed at once
//    ponte.flusso.fine {id}            -> {}    no more text: `ponte.audio.fine` once the last audio is out
//    ponte.flusso.ferma {id}           -> {}    interrupted: nothing more for this id
//  events: ponte.audio {id, pcm: base64 PCM 16 bit 24 kHz mono}, ponte.audio.fine {id},
//          ponte.audio.errore {id, errore}
//

import CoreImage
import CoreImage.CIFilterBuiltins
import AppKit
import Foundation

@MainActor
enum PonteComandi {
    static let commands: Set<String> = ["ponte.voce", "ponte.qr", "ponte.flusso.apri", "ponte.flusso.testo",
                                        "ponte.flusso.fine", "ponte.flusso.ferma"]

    static func handle(_ r: Request) async throws -> Bool {
        guard commands.contains(r.cmd) else { return false }
        let testo = r.string("testo") ?? ""
        switch r.cmd {
        case "ponte.flusso.apri":
            r.respond(["ok": PonteFlusso.shared.apri(r.string("id") ?? "")])
        case "ponte.flusso.testo":
            PonteFlusso.shared.testo(r.string("id") ?? "", testo)
            r.respond()
        case "ponte.flusso.fine":
            PonteFlusso.shared.fine(r.string("id") ?? "")
            r.respond()
        case "ponte.flusso.ferma":
            PonteFlusso.shared.ferma(r.string("id") ?? "")
            r.respond()
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

/// One remote turn at a time. The socket stays warm for a minute and a half after the last turn (the
/// keep-alive of ElevenLabsStream), so the next answer starts in about 200 ms instead of a new handshake.
@MainActor
final class PonteFlusso {
    static let shared = PonteFlusso()

    private var stream: ElevenLabsStream?
    private var id = ""
    private var inAttesa = 0
    private var chiuso = false
    private var inviato = false
    private var guardia: DispatchWorkItem?

    func apri(_ nuovo: String) -> Bool {
        if !id.isEmpty, id != nuovo {
            Out.event("ponte.audio.fine", ["id": id])
            // il turno di prima ha ancora audio in arrivo: arriverebbe con l'id nuovo, socket nuovo
            if inAttesa > 0 { stream?.close(); stream = nil }
        }
        id = nuovo
        inAttesa = 0
        chiuso = false
        inviato = false
        if stream == nil {
            guard let s = ElevenLabsStream() else { return false }
            s.onEvent = { [weak self] e in self?.evento(e) }
            stream = s
        }
        return stream?.connect() ?? false
    }

    func testo(_ quale: String, _ t: String) {
        let pulito = Speaker.cleanForSpeech(t)
        guard quale == id, !chiuso, !pulito.isEmpty, let s = stream, s.isOpen || s.connect() else { return }
        s.send(text: pulito, newTurn: !inviato && s.hasSpokenBefore)
        ElevenLabsUsage.add(pulito.count)
        inviato = true
        inAttesa += 1
        s.flush()
        armaGuardia()
    }

    func fine(_ quale: String) {
        guard quale == id else { return }
        chiuso = true
        if inAttesa == 0 { concludi() }
    }

    func ferma(_ quale: String) {
        guard quale == id else { return }
        // il socket non sa fermare una frase gia' chiesta: si chiude e il prossimo turno ne apre uno nuovo
        stream?.close()
        stream = nil
        id = ""
        guardia?.cancel()
    }

    private func evento(_ e: ElevenLabsStream.Event) {
        guard !id.isEmpty else { return }
        switch e {
        case .audio(let pcm):
            Out.event("ponte.audio", ["id": id, "pcm": pcm.base64EncodedString()])
            armaGuardia()
        case .turnFinished:
            inAttesa = max(0, inAttesa - 1)
            if chiuso && inAttesa == 0 { concludi() }
        case .failed(let err):
            Out.event("ponte.audio.errore", ["id": id, "errore": err.localizedDescription])
            // chiuso davvero: il keep-alive ogni 8 s non deve restare acceso per sempre
            stream?.close()
            stream = nil
            id = ""
            guardia?.cancel()
        }
    }

    private func concludi() {
        guardia?.cancel()
        Out.event("ponte.audio.fine", ["id": id])
        id = ""
    }

    /// Text pending and no audio for 8 s: the socket is stuck (same watchdog as Speaker.swift).
    private func armaGuardia() {
        guardia?.cancel()
        let quale = id
        let w = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.id == quale, self.inAttesa > 0 else { return }
                Out.event("ponte.audio.errore", ["id": quale, "errore": "ElevenLabs non risponde da 8 secondi"])
                self.stream?.close()
                self.stream = nil
                self.id = ""
            }
        }
        guardia = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: w)
    }
}
