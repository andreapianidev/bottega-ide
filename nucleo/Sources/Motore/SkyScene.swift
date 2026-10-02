//
//  SkyScene.swift
//  Bottega Nucleo
//
//  What the sky draws, independent of where the numbers come from: one star per project
//  (stable position, size and warmth from the hours), the lines between projects worked
//  on together, and the geometry shared by the Metal view and the SwiftUI labels on top
//  (star field rectangle, horizon, picking).
//
//  The palette is "Roque" (extensions/bottega-home/media/plancia.css): the night of La
//  Palma, sodium street lamps, basalt. Same hex values, converted here once to linear
//  Display P3 for the EDR drawable.
//

import AppKit
import simd

/// The Roque palette (dark theme of the plancia: the observatory is always night).
enum Roque {
    static let cielo = 0x121a2e
    static let basalto = 0x192238
    static let linea = 0x263150
    static let calima = 0xe8e2d0
    static let tinta = 0x8f98ad
    static let sodio = 0xf4ab3c
    static let brace = 0xf2607a
    static let laurisilva = 0x74b98f
    static let stella = 0x6683e6
    static let focus = 0x9cc2ff
    /// Deeper than cielo: the zenith of a sky with no moon.
    static let zenit = 0x070b17
    /// The silhouette of the ridge and the domes.
    static let inchiostro = 0x04060d

    /// sRGB components 0...1.
    static func srgb(_ hex: Int) -> SIMD3<Float> {
        SIMD3(Float((hex >> 16) & 0xff), Float((hex >> 8) & 0xff), Float(hex & 0xff)) / 255
    }

    /// Linear Display P3 (the colour space of the EDR layer).
    static func linear(_ hex: Int) -> SIMD3<Float> {
        let c = srgb(hex)
        func lin(_ v: Float) -> Float { v <= 0.04045 ? v / 12.92 : powf((v + 0.055) / 1.055, 2.4) }
        let l = SIMD3(lin(c.x), lin(c.y), lin(c.z))
        // linear sRGB -> linear Display P3
        return SIMD3(0.8225 * l.x + 0.1774 * l.y,
                     0.0332 * l.x + 0.9669 * l.y,
                     0.0171 * l.x + 0.0724 * l.y + 0.9108 * l.z)
    }

    static func nsColor(_ hex: Int, alpha: CGFloat = 1) -> NSColor {
        let c = srgb(hex)
        return NSColor(srgbRed: CGFloat(c.x), green: CGFloat(c.y), blue: CGFloat(c.z), alpha: alpha)
    }
}

/// One project in the sky.
struct SkyStar: Equatable {
    /// Path when the project has one, else its name. Pulses are matched on this.
    var key: String
    var name: String
    var path: String?
    /// Position inside the star field, 0...1, y from the top.
    var position: SIMD2<Float>
    /// Core radius in points.
    var size: Float
    /// 0...1: how much it shines (hours, softened by how long ago it was worked on).
    var brightness: Float
    /// 0...1: colour temperature, 0 cool white, 1 sodium amber (most worked).
    var warmth: Float
    /// A Claude session is open on it right now.
    var live: Bool
    /// "Fuori dai progetti": a hollow ring, no glow.
    var hollow: Bool
    /// Minutes in the period (for labels and the list).
    var minutes: Double
}

struct SkyEdge: Equatable {
    var a: Int
    var b: Int
    /// 0...1 from the minutes worked together.
    var strength: Float
}

struct SkyScene: Equatable {
    var stars: [SkyStar] = []
    var edges: [SkyEdge] = []
    /// Bumped by the builder: renderers rebuild their buffers only when it changes.
    var version: Int = 0

    var lively: Bool { stars.contains { $0.live } }

    func index(ofKey key: String?) -> Int? {
        guard let key else { return nil }
        return stars.firstIndex { $0.key == key }
    }

    /// Stars matching a pulse: by key (path), else by project name.
    func index(forPulse p: MetalEngine.Pulse) -> Int? {
        if let i = stars.firstIndex(where: { $0.key == p.key || $0.path == p.key }) { return i }
        let n = p.project.lowercased()
        guard !n.isEmpty else { return nil }
        return stars.firstIndex { $0.name.lowercased() == n }
    }

    /// A deterministic scene for the benchmark: `count` stars, a few edges, two live.
    static func sample(count: Int) -> SkyScene {
        var rng = SkyRandom(seed: 7)
        var s = SkyScene()
        for i in 0..<count {
            let key = "/progetti/esempio-\(i)"
            let minutes = Double(30 + rng.next() * 3000)
            s.stars.append(SkyStar(key: key, name: "esempio \(i)", path: key,
                                   position: SkyGeometry.stablePosition(for: key),
                                   size: 2.6 + 10 * Float(sqrt(minutes / 3030)), brightness: 0.4 + 0.6 * rng.next(),
                                   warmth: rng.next(), live: i < 2, hollow: false, minutes: minutes))
        }
        for i in 0..<min(16, max(0, count - 1)) {
            s.edges.append(SkyEdge(a: i, b: (i * 7 + 3) % count, strength: rng.next()))
        }
        s.version = 1
        return s
    }
}

/// mulberry32, the same generator as the cruscotto's background field (`semi`).
struct SkyRandom {
    private var state: UInt32
    init(seed: UInt32) { state = seed }
    mutating func next() -> Float {
        state = state &+ 0x6D2B_79F5
        var t = state
        t = (t ^ (t >> 15)) &* (1 | t)
        t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
        return Float((t ^ (t >> 14))) / 4_294_967_296
    }
}

/// Geometry shared by the renderer (normalized drawable space) and SwiftUI (points).
enum SkyGeometry {
    /// Top of the ridge, as a fraction of the height from the bottom (the domes stand on
    /// it, a little higher). The shader draws the same line.
    static let horizon: Float = 0.13
    /// Stars stay above this line (fraction of the height from the top).
    static let fieldBottom: CGFloat = 0.76

    /// Where the project stars may go, in view points (y from the top), given the room
    /// the glass panels take on each side.
    static func fieldRect(size: CGSize, insets: NSEdgeInsets) -> CGRect {
        var left = insets.left, right = insets.right
        // Too narrow for the side columns: the stars use the whole width.
        if size.width - left - right < 320 { left = 40; right = 40 }
        let top = max(insets.top, 24)
        let bottom = size.height * fieldBottom
        return CGRect(x: left, y: top, width: max(40, size.width - left - right),
                      height: max(40, bottom - top))
    }

    /// Point of a star in the view (points, y from the top).
    static func point(of star: SkyStar, in field: CGRect) -> CGPoint {
        CGPoint(x: field.minX + CGFloat(star.position.x) * field.width,
                y: field.minY + CGFloat(star.position.y) * field.height)
    }

    /// The star under the pointer, if any (hit area at least 14 pt, bigger than the mark).
    static func pick(_ p: CGPoint, scene: SkyScene, field: CGRect) -> Int? {
        var best: (Int, CGFloat)?
        for (i, s) in scene.stars.enumerated() {
            let c = point(of: s, in: field)
            let d = hypot(p.x - c.x, p.y - c.y)
            let reach = max(14, CGFloat(s.size) * 2.2 + 4)
            if d <= reach, d < (best?.1 ?? .infinity) { best = (i, d) }
        }
        return best?.0
    }

    /// Stable position from the key: FNV-1a of the path, two coordinates out of it. The
    /// same project sits in the same place every time, whatever else is in the sky.
    static func stablePosition(for key: String) -> SIMD2<Float> {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for b in key.utf8 { h = (h ^ UInt64(b)) &* 0x100_0000_01b3 }
        let x = Float(h & 0xffff) / 65535
        let y = Float((h >> 24) & 0xffff) / 65535
        return SIMD2(0.04 + 0.92 * x, 0.06 + 0.88 * y)
    }

    /// Nudges stars that would overlap, a few deterministic steps, so two projects never
    /// sit on each other. Positions move only when two of them collide.
    static func relax(_ stars: inout [SkyStar], minDistance: Float = 0.07) {
        guard stars.count > 1 else { return }
        for _ in 0..<24 {
            var moved = false
            for i in 0..<stars.count {
                for j in (i + 1)..<stars.count {
                    var d = stars[j].position - stars[i].position
                    var len = simd_length(d)
                    if len >= minDistance { continue }
                    if len < 1e-5 { d = SIMD2(0.6, 0.8); len = 1 }
                    let push = (minDistance - len) * 0.5 / len
                    stars[i].position -= d * push
                    stars[j].position += d * push
                    moved = true
                }
            }
            for i in stars.indices {
                stars[i].position = simd_clamp(stars[i].position, SIMD2(0.02, 0.03), SIMD2(0.98, 0.97))
            }
            if !moved { break }
        }
    }
}
