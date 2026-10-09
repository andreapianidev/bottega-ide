//
//  OrbAspetto.swift
//  Bottega Nucleo
//
//  Who is speaking, at a glance (CONTRATTI 9.11, «La sfera di chi parla»). Melissa is a sphere
//  with her own palette; every character has a shape (cube, rhombus, star) and a colour of
//  their own (Elliot's `codice` is a dark glass sphere with falling green code), from the `sfera` field of their file in ~/.bottega/personaggi (ChiParla reads it),
//  or chosen from the key when the field is missing (never the sphere: that is Melissa's).
//  The emotion of the line gives an agitation 0..1 that spins the shape, lengthens the star's
//  spikes, deforms more and changes the light of the colour. Melissa changes agitation, never
//  shape or colour.
//
//  Same rules as the views (extensions/bottega-home/src/sfera-aspetto.ts and
//  media/motore/sfera-gpu.js, `aspetto`) and as Avo Agency AI: change them everywhere.
//
//  OrbAspetto.attuale is what the sphere should show now: written on main by the voice
//  (Speaker, when a line starts to sound) and by the island, read on main by every
//  OrbRenderer, which moves towards it in about 0.4 s.
//

import Foundation
import simd

struct SferaAspetto: Equatable {
    /// `codice`: a sphere of dark glass with green code falling inside (Elliot); `cubo` in a
    /// file is read as `codice` (no cube is drawn any more).
    enum Forma: String, CaseIterable { case sfera, codice, rombo, stella }

    var forma: Forma
    /// nil: Melissa's palette, no tint.
    var colore: SIMD3<Float>?

    static let melissa = SferaAspetto(forma: .sfera, colore: nil)

    /// The weights of (code, rhombus, star); the sphere is what is left (the code is a sphere too).
    var pesi: SIMD3<Float> {
        switch forma {
        case .sfera: return .zero
        case .codice: return SIMD3(1, 0, 0)
        case .rombo: return SIMD3(0, 1, 0)
        case .stella: return SIMD3(0, 0, 1)
        }
    }

    /// The `sfera` field of a character's file: what is valid is kept, the rest comes from the key.
    static func leggi(_ x: Any?, chiave: String) -> SferaAspetto {
        let def = predefinito(chiave: chiave)
        guard let o = x as? [String: Any] else { return def }
        let forma = (o["forma"] as? String).flatMap { Forma(rawValue: $0 == "cubo" ? "codice" : $0) } ?? def.forma
        let colore = (o["colore"] as? String).flatMap(rgb) ?? def.colore
        return SferaAspetto(forma: forma, colore: colore)
    }

    /// Without a `sfera` field: h = FNV-1a 32 of the key (UTF-8), shape = [star, code,
    /// rhombus][h % 3], hue = (h >> 8) % 360, saturation 0.75, value 1.
    static func predefinito(chiave: String) -> SferaAspetto {
        let h = fnv1a(chiave)
        let forme: [Forma] = [.stella, .codice, .rombo]
        return SferaAspetto(forma: forme[Int(h % 3)], colore: rgb(hsvHex(Double((h >> 8) % 360), 0.75, 1)))
    }

    static func fnv1a(_ t: String) -> UInt32 {
        var h: UInt32 = 0x811c9dc5
        for b in t.utf8 {
            h ^= UInt32(b)
            h = h &* 0x01000193
        }
        return h
    }

    /// Same rounding as the extension, so a default colour is the same hex everywhere.
    static func hsvHex(_ tono: Double, _ s: Double, _ v: Double) -> String {
        let c = v * s
        let x = c * (1 - abs((tono / 60).truncatingRemainder(dividingBy: 2) - 1))
        let m = v - c
        let (r, g, b): (Double, Double, Double)
        switch tono {
        case ..<60: (r, g, b) = (c, x, 0)
        case ..<120: (r, g, b) = (x, c, 0)
        case ..<180: (r, g, b) = (0, c, x)
        case ..<240: (r, g, b) = (0, x, c)
        case ..<300: (r, g, b) = (x, 0, c)
        default: (r, g, b) = (c, 0, x)
        }
        func h2(_ n: Double) -> String { String(format: "%02X", Int(((n + m) * 255).rounded())) }
        return "#" + h2(r) + h2(g) + h2(b)
    }

    /// "#RRGGBB" -> 0..1 per channel, used like the palette's tints; nil if not a colour.
    static func rgb(_ hex: String) -> SIMD3<Float>? {
        var t = hex.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("#") { t.removeFirst() }
        guard t.count == 6, t.allSatisfy(\.isHexDigit), let n = UInt32(t, radix: 16) else { return nil }
        return SIMD3(Float((n >> 16) & 255), Float((n >> 8) & 255), Float(n & 255)) / 255
    }
}

/// The emotion of a line, as an agitation 0..1.
enum Umore {
    static let neutra: Float = 0.3

    /// ElevenLabs audio tags: high for joy, excitement and alarm, low for sadness and sighs.
    private static let tag: [String: Float] = [
        "laughs": 0.85, "laughing": 0.85, "laugh": 0.85, "giggles": 0.8, "chuckles": 0.75, "excited": 0.85,
        "cheerful": 0.8, "happy": 0.8, "surprised": 0.85, "gasps": 0.9, "gasp": 0.9, "shouts": 0.95,
        "shouting": 0.95, "angry": 0.95, "furious": 0.95,
        "sad": 0.05, "crying": 0.05, "sighs": 0.1, "sigh": 0.1, "exhales": 0.1, "whispers": 0.1,
        "whispering": 0.1, "tired": 0.1,
    ]
    private static let reTag = try? NSRegularExpression(pattern: "\\[([a-z ]+)\\]", options: [.caseInsensitive])
    private static let reAlte = try? NSRegularExpression(
        pattern: "\\b(?:ah(?:ah)+|evviva|fantastico|wow|urr[aà]|aiuto|attento|attenzione|allarme|cazzo)\\b|!{2,}",
        options: [.caseInsensitive])
    private static let reBasse = try? NSRegularExpression(
        pattern: "\\b(?:purtroppo|mi dispiace|che peccato|triste|uff+)\\b", options: [.caseInsensitive])

    /// The first audio tag that says an emotion; else the words (whichever comes first); else neutral.
    static func agitazione(_ testo: String) -> Float {
        let ns = testo as NSString
        let tutto = NSRange(location: 0, length: ns.length)
        for m in reTag?.matches(in: testo, range: tutto) ?? [] {
            let nome = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces).lowercased()
            if let v = tag[nome] { return v }
        }
        let a = reAlte?.firstMatch(in: testo, range: tutto)?.range.location
        let b = reBasse?.firstMatch(in: testo, range: tutto)?.range.location
        if let a, b == nil || a <= b! { return 0.75 }
        if b != nil { return 0.1 }
        return neutra
    }

    private static func liscio(_ a: Float, _ b: Float, _ x: Float) -> Float {
        let t = min(1, max(0, (x - a) / (b - a)))
        return t * t * (3 - 2 * t)
    }

    /// The light of the colour: +15% from 0.75 up, -25% from 0.1 down, 1 at 0.3.
    static func luce(_ a: Float) -> Float { 1 + 0.15 * liscio(0.5, 0.75, a) - 0.25 * (1 - liscio(0.1, 0.3, a)) }

    /// The star's spike length in radii: 0.42, up to 1.5 times with the agitation.
    static func punta(_ a: Float) -> Float { 0.42 * (1 + 0.5 * liscio(0.3, 0.85, a)) }
}

/// What the sphere shows now (written and read on main).
enum OrbAspetto {
    nonisolated(unsafe) static var aspetto = SferaAspetto.melissa
    nonisolated(unsafe) static var agitazione = Umore.neutra

    /// A line by `chi` (the name from ChiParla) starts to sound; with its text (audio tags
    /// included) the agitation follows its emotion, without it stays as it is.
    static func parla(chi: String, testo: String? = nil) {
        let nuovo = ChiParla.aspetto(nome: chi)
        let ag = testo.map(Umore.agitazione) ?? agitazione
        guard nuovo != aspetto || ag != agitazione else { return }
        aspetto = nuovo
        agitazione = ag
        MetalEngine.notifyChange()
    }

    /// The voice is over: Melissa again, calm.
    static func riposo() {
        guard aspetto != .melissa || agitazione != Umore.neutra else { return }
        aspetto = .melissa
        agitazione = Umore.neutra
        MetalEngine.notifyChange()
    }
}

/// One renderer's own motion towards OrbAspetto: about 0.4 s to 95%, never a jump; the
/// angle of the shape turns with the agitation (0.15 + 0.6 x agitation rad/s).
struct OrbMolla {
    var pesi = SIMD3<Float>(repeating: 0)
    var tinta: Float = 0
    var colore = SIMD3<Float>(repeating: 1)
    var agit = Umore.neutra
    var angolo: Float = 0.6

    mutating func passo(dt: Float, verso a: SferaAspetto, agitazione: Float, salta: Bool) {
        let tintaVuole: Float = a.colore == nil ? 0 : 0.85
        if salta {
            pesi = a.pesi
            if let c = a.colore { colore = c }
            tinta = tintaVuole
            agit = agitazione
            return
        }
        let k = 1 - expf(-dt / 0.13)
        pesi += (a.pesi - pesi) * k
        // a new colour comes in at once when there was no tint; without one (Melissa) the old one fades out
        if let c = a.colore { colore = tinta < 0.01 ? c : colore + (c - colore) * k }
        tinta += (tintaVuole - tinta) * k
        agit += (agitazione - agit) * k
        angolo += dt * (0.15 + 0.6 * agit)
    }

    func ferma(verso a: SferaAspetto, agitazione: Float) -> Bool {
        let d = abs(pesi - a.pesi)
        return d.x + d.y + d.z < 0.01 && abs(tinta - (a.colore == nil ? 0 : 0.85)) < 0.005 && abs(agit - agitazione) < 0.005
    }
}
