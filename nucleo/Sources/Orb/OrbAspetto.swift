//
//  OrbAspetto.swift
//  Bottega Nucleo
//
//  Who is speaking, at a glance (CONTRATTI 9.11, «La sfera di chi parla»). Melissa is a sphere
//  with her own palette; every character has a figure and a colour of their own, from the `sfera`
//  field of their file in ~/.bottega/personaggi (ChiParla reads it), or chosen from the key when the
//  field is missing (never the sphere: that is Melissa's). The figures are Avo's (10/10/2026), the
//  names stay the file keys: `codice` (Elliot) a dark glass sphere with falling green code,
//  `stella` (Darlene) a dark glass core with three neon rings and a glitch, `rombo` (Krista) an
//  amber Rorschach blot. The emotion of the line gives an agitation 0..1 that moves the figure
//  more, deforms more and changes the light of the colour. Melissa changes agitation, never
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

}

/// Moony's mood: which moon it is tonight (CONTRATTI 9.x, «La luna di Moony»). The state of the voice chooses it
/// (at rest calm, listening curious, thinking focused), and while speaking the text said so far does, with Avo's
/// lexicon (OrbMoodDirector.classify). The table of the moons is Avo's (OrbIdentita.lunaPerUmore). The same keys,
/// lexicon and table are in the extension (src/sfera-aspetto.ts) and in the views (media/motore/sfera-gpu.js):
/// change them everywhere. Only the moon reads it; Darlene, Krista and Elliot ignore it.
enum UmoreLuna: String, CaseIterable {
    case calma, concentrata, curiosa, calore, gioia, meraviglia, malinconia, allarme

    /// (phase, eclipse, harvest, halo ring) for the shader (p9). Phase 0 = the approved silver moon (gibbous, light
    /// from the left), negative towards full, positive towards the crescent. All 0 = calm.
    var luna: SIMD4<Float> {
        switch self {
        case .calma: return SIMD4(0, 0, 0, 0)             // silver super moon
        case .concentrata: return SIMD4(0.15, 0, 0, 0)    // silver, a slightly lower light: sharp relief
        case .curiosa: return SIMD4(0.45, 0, 0, 0)        // half moon, grazing light: the craters stand out
        case .calore: return SIMD4(-0.2, 0, 0.6, 0)       // honey moon, almost full
        case .gioia: return SIMD4(-0.65, 0, 1, 0)         // full harvest moon, golden, wide halo
        case .meraviglia: return SIMD4(-0.25, 0, 0, 1)    // ice halo ring around the moon
        case .malinconia: return SIMD4(0.85, 0, 0, 0)     // thin cold crescent, earthshine on the rest
        case .allarme: return SIMD4(-0.5, 1, 0, 0)        // eclipse: blood moon, halo dimmed
        }
    }

    /// The mood the moon goes to: the voice state, and for speaking the mood of the text.
    static func perStato(_ stato: Int32, parlato: UmoreLuna) -> UmoreLuna {
        switch stato {
        case 1: return .curiosa
        case 2: return .concentrata
        case 3: return parlato
        default: return .calma          // at rest, and the error (its sodium amber stays the sign)
        }
    }

    /// Avo's words, with Avo's weights (OrbMoodDirector.classify): the first 400 characters, substring match on the
    /// lower-cased text. The highest score wins; a tie goes to the first in this order. No word: calm.
    private static let lessico: [(UmoreLuna, Int, [String])] = [
        (.meraviglia, 2, ["storia", "racconto", "c'era una volta", "immagina", "sogno", "universo",
                          "stelle", "galassia", "mistero", "leggenda", "favola", "magia",
                          "story", "imagine", "dream", "universe", "galaxy", "myth"]),
        (.gioia, 2, ["fantastico", "bellissimo", "ottimo", "perfetto", "evviva", "complimenti",
                     "ce l'abbiamo fatta", "riuscito", "felice", "auguri", "grande",
                     "great", "awesome", "wonderful", "congratulations", "done"]),
        (.calore, 1, ["grazie", "prego", "caro", "affetto", "amico", "casa", "famiglia",
                      "buongiorno", "buonasera", "ti voglio", "coccole", "abbraccio",
                      "thanks", "welcome", "friend", "home", "family"]),
        (.malinconia, 1, ["mi dispiace", "purtroppo", "triste", "malinconia", "perso",
                          "addio", "solitudine", "nostalgia", "manca", "difficile",
                          "sorry", "unfortunately", "sad", "lonely", "miss"]),
        (.allarme, 2, ["attenzione", "errore", "problema", "guasto", "fallito", "urgente",
                       "pericolo", "allarme", "non funziona", "critico", "subito",
                       "error", "failed", "warning", "urgent", "danger", "critical"]),
        (.concentrata, 1, ["codice", "funzione", "compila", "build", "server", "database", "api",
                           "calcolo", "analisi", "configura", "installa", "script", "log",
                           "code", "function", "compile", "deploy", "query", "debug"]),
        (.curiosa, 1, ["forse", "chissà", "domanda", "curioso", "interessante", "perché",
                       "come mai", "scopriamo", "vediamo", "ipotesi", "e se",
                       "maybe", "question", "curious", "interesting", "why", "what if"]),
        (.calma, 1, ["tranquillo", "calma", "riposo", "respira", "piano", "va bene",
                     "certo", "d'accordo", "ok", "sereno",
                     "calm", "relax", "breathe", "fine", "sure"]),
    ]

    static func classifica(_ testo: String) -> UmoreLuna {
        let s = String(testo.prefix(400)).lowercased()
        var meglio = UmoreLuna.calma, punti = 0
        for (u, peso, parole) in lessico {
            let p = parole.reduce(0) { $0 + (s.contains($1) ? peso : 0) }
            if p > punti { meglio = u; punti = p }
        }
        return meglio
    }
}

/// What the sphere shows now (written and read on main).
enum OrbAspetto {
    nonisolated(unsafe) static var aspetto = SferaAspetto.melissa
    nonisolated(unsafe) static var agitazione = Umore.neutra
    /// The mood of what the voice has said in this episode (UmoreLuna.classifica of `parlato`): the moon shows it
    /// while speaking (UmoreLuna.perStato).
    nonisolated(unsafe) static var umoreParlato = UmoreLuna.calma
    /// The text of this voice episode, up to the 400 characters the lexicon reads; emptied when the voice is over.
    nonisolated(unsafe) private static var parlato = ""

    #if os(macOS)
    /// The desktop resolves names from its character files. iOS shares the appearance
    /// rules and spring below without depending on desktop paths or ElevenLabsConfig.
    static func parla(chi: String, testo: String? = nil) {
        parla(aspetto: ChiParla.aspetto(nome: chi), testo: testo)
    }
    #endif

    /// Platform-independent appearance update; audio tags control the same agitation
    /// on Mac and iPhone. An omitted text keeps the current agitation.
    static func parla(aspetto nuovo: SferaAspetto, testo: String? = nil) {
        let ag = testo.map(Umore.agitazione) ?? agitazione
        var um = umoreParlato
        if let t = testo, !t.isEmpty, parlato.count < 400 {
            parlato += parlato.isEmpty ? t : " " + t
            um = UmoreLuna.classifica(parlato)
        }
        guard nuovo != aspetto || ag != agitazione || um != umoreParlato else { return }
        aspetto = nuovo
        agitazione = ag
        umoreParlato = um
        MetalEngine.notifyChange()
    }

    /// The voice is over: Melissa again, calm. The next episode reads its own mood.
    static func riposo() {
        parlato = ""
        guard aspetto != .melissa || agitazione != Umore.neutra || umoreParlato != .calma else { return }
        umoreParlato = .calma
        aspetto = .melissa
        agitazione = Umore.neutra
        MetalEngine.notifyChange()
    }
}

/// One renderer's own motion towards OrbAspetto: about 0.4 s to 95%, never a jump.
struct OrbMolla {
    var pesi = SIMD3<Float>(repeating: 0)
    var tinta: Float = 0
    var colore = SIMD3<Float>(repeating: 1)
    var agit = Umore.neutra
    /// Moony's mood for the shader (UmoreLuna.luna): the moon changes face in a few seconds, like a passing cloud.
    var luna = SIMD4<Float>(repeating: 0)

    /// Towards the mood's moon, with Avo's rate (OrbIdentita: k = dt * 0.8); `salta` lands at once.
    mutating func passoLuna(dt: Float, verso v: SIMD4<Float>, salta: Bool) {
        luna = salta ? v : luna + (v - luna) * min(1, dt * 0.8)
        let d = abs(luna - v)
        if d.x + d.y + d.z + d.w < 0.004 { luna = v }
    }

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
        // close enough: land exactly on the target, so a sphere that stops drawing (docked, at rest)
        // stays on the shape and tint it was going to, not on a 99% that never ends
        if ferma(verso: a, agitazione: agitazione) {
            pesi = a.pesi
            if let c = a.colore { colore = c }
            tinta = tintaVuole
            agit = agitazione
        }
    }

    /// True when the spring has arrived: a renderer that draws only on change (the docked orb
    /// at rest) keeps drawing until this is true, then stops.
    func ferma(verso a: SferaAspetto, agitazione: Float) -> Bool {
        let d = abs(pesi - a.pesi)
        return d.x + d.y + d.z < 0.01 && abs(tinta - (a.colore == nil ? 0 : 0.85)) < 0.005 && abs(agit - agitazione) < 0.005
    }
}
