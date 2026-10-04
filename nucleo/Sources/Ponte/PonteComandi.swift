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

/// One remote answer at a time. `flush` emits audio for short sentences, while `close_socket`
/// produces the only reliable final marker for the whole answer.
@MainActor
final class PonteFlusso {
    static let shared = PonteFlusso()

    private var stream: ElevenLabsStream?
    private var id = ""
    private var chiuso = false
    private var inviato = false
    private var haAudio = false
    private var caduto = false
    private var testoCompleto = ""
    private var recupero: Task<Void, Never>?
    private var guardia: DispatchWorkItem?

    func apri(_ nuovo: String) -> Bool {
        if !id.isEmpty, id != nuovo {
            Out.event("ponte.audio.fine", ["id": id])
            stream?.close()
            stream = nil
        }
        recupero?.cancel(); recupero = nil
        id = nuovo
        chiuso = false
        inviato = false
        haAudio = false
        caduto = false
        testoCompleto = ""
        if stream == nil {
            guard let s = ElevenLabsStream() else { return false }
            s.onEvent = { [weak self] e in self?.evento(e) }
            stream = s
        }
        return stream?.connect() ?? false
    }

    func testo(_ quale: String, _ t: String) {
        let pulito = Speaker.cleanForSpeech(t)
        guard quale == id, !chiuso, !pulito.isEmpty else { return }
        testoCompleto += (testoCompleto.isEmpty ? "" : " ") + pulito
        ElevenLabsUsage.add(pulito.count)
        guard !caduto else { return }
        guard let s = stream, s.isOpen || s.connect() else { caduto = true; return }
        s.send(text: pulito, newTurn: !inviato && s.hasSpokenBefore)
        inviato = true
        s.flush()
        armaGuardia()
    }

    func fine(_ quale: String) {
        guard quale == id else { return }
        chiuso = true
        if !inviato && testoCompleto.isEmpty { concludi(); return }
        if caduto || stream == nil { recuperaSePossibile(); return }
        stream?.finish()
        armaGuardia()
    }

    func ferma(_ quale: String) {
        guard quale == id else { return }
        // il socket non sa fermare una frase gia' chiesta: si chiude e il prossimo turno ne apre uno nuovo
        stream?.close()
        stream = nil
        recupero?.cancel(); recupero = nil
        id = ""
        testoCompleto = ""
        guardia?.cancel()
    }

    private func evento(_ e: ElevenLabsStream.Event) {
        guard !id.isEmpty else { return }
        switch e {
        case .audio(let pcm):
            haAudio = true
            Out.event("ponte.audio", ["id": id, "pcm": pcm.base64EncodedString()])
            armaGuardia()
        case .turnFinished:
            // A turn marker is not a marker for every `flush` sent above.
            armaGuardia()
        case .sessionFinished:
            concludi()
        case .failed(let err):
            Log.warn("ponte: socket ElevenLabs terminato (\(err.localizedDescription))")
            stream?.close()
            stream = nil
            caduto = true
            guardia?.cancel()
            if chiuso { recuperaSePossibile() }
        }
    }

    private func concludi() {
        guardia?.cancel()
        Out.event("ponte.audio.fine", ["id": id])
        id = ""
        testoCompleto = ""
    }

    /// If the WebSocket fails before sending any PCM, synthesize the same Melissa voice over HTTPS.
    private func recuperaSePossibile() {
        guard !id.isEmpty, recupero == nil else { return }
        guard !haAudio, !testoCompleto.isEmpty else {
            Out.event("ponte.audio.errore", ["id": id, "errore": "La voce ElevenLabs si è interrotta durante la riproduzione."])
            concludi()
            return
        }
        guardia?.cancel()
        let quale = id
        let frase = String(testoCompleto.prefix(4_000))
        recupero = Task { [weak self] in
            do {
                let pcm = try await ElevenLabsREST.synthesize(frase, model: ElevenLabsConfig.restFallbackModel)
                guard let self, self.id == quale, !Task.isCancelled else { return }
                guard !pcm.isEmpty else { throw ElevenLabsError.empty }
                Out.event("ponte.audio", ["id": quale, "pcm": pcm.base64EncodedString()])
                self.haAudio = true
                self.concludi()
            } catch {
                guard let self, self.id == quale, !Task.isCancelled else { return }
                Out.event("ponte.audio.errore", ["id": quale, "errore": error.localizedDescription])
                self.concludi()
            }
            self?.recupero = nil
        }
    }

    /// No audio or final marker for 12 s: use HTTPS if no PCM has been delivered yet.
    private func armaGuardia() {
        guardia?.cancel()
        let quale = id
        let w = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.id == quale else { return }
                self.stream?.close()
                self.stream = nil
                self.caduto = true
                if self.chiuso { self.recuperaSePossibile() }
            }
        }
        guardia = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: w)
    }
}
