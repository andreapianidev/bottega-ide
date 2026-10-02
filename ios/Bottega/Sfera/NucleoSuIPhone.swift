//
//  NucleoSuIPhone.swift
//  Bottega per iPhone
//
//  OrbRenderer.swift, OrbShaders.metal e AudioLevels.swift sono gli stessi file del Nucleo del Mac
//  (project.yml li prende da nucleo/Sources). Qui c'e' quel poco del Nucleo che quei file chiamano,
//  rifatto per l'iPhone: il motore Metal condiviso, il registro, il pacchetto, le misure del pannello.
//

import Metal
import QuartzCore
import UIKit
import os

enum Nucleo {
    static let bundle = Bundle.main
}

enum Log {
    private static let log = Logger(subsystem: "com.andreapiani.bottega.ios", category: "sfera")
    static func info(_ m: String) { log.info("\(m, privacy: .public)") }
    static func warn(_ m: String) { log.warning("\(m, privacy: .public)") }
    static func error(_ m: String) { log.error("\(m, privacy: .public)") }
}

/// Sul Mac manda gli eventi all'estensione; sull'iPhone non c'e' nessuno da avvisare.
enum Out {
    static func event(_ name: String, _ fields: [String: Any?] = [:]) {}
}

/// Le misure che OrbSelfTest legge dal pannello del Mac.
enum OrbPanel {
    static let orbSide: CGFloat = 344
    static let renderScale: CGFloat = 1.5
    static let dockSide: CGFloat = 72
    static let dockScale: CGFloat = 2
    static let dockedIdleFPS = 12
}

/// Il motore Metal del Nucleo, ridotto a cio' che serve alla sfera: un dispositivo, una coda, la libreria
/// compilata da Xcode e il respiro, che sul Mac accelera con le sessioni Claude al lavoro.
final class MetalEngine: @unchecked Sendable {
    static let shared = MetalEngine()

    enum Client { case orb, orbDocked }
    struct FrameToken { let client: Client }

    let device: MTLDevice? = MTLCreateSystemDefaultDevice()
    lazy var queue: MTLCommandQueue? = device?.makeCommandQueue()
    private lazy var lib: MTLLibrary? = device?.makeDefaultLibrary()

    private let lock = OSAllocatedUnfairLock(initialState: (phase: 0.0, last: 0.0, rate: 1.4, target: 1.4))

    func library(containing function: String) -> MTLLibrary? {
        guard let lib, lib.functionNames.contains(function) else { return nil }
        return lib
    }

    func beginFrame(_ client: Client) -> FrameToken { FrameToken(client: client) }
    func endFrame(_ token: FrameToken, commandBuffer cmd: MTLCommandBuffer) {}

    var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }

    /// Le sessioni Claude vive sul Mac: come sul Mac, piu' lavorano e piu' la sfera respira in fretta.
    func setLoad(_ sessions: Int) {
        let target = 1.4 + min(Double(max(0, sessions)), 6) * 0.25
        lock.withLock { $0.target = target }
    }

    func breathPhase(now: CFTimeInterval = CACurrentMediaTime()) -> Double {
        let still = reduceMotion
        return lock.withLock { s in
            let dt = s.last == 0 ? 0 : min(0.25, max(0, now - s.last))
            s.last = now
            if still { return s.phase }
            s.rate += (s.target - s.rate) * min(1, dt / 3.0)
            s.phase += s.rate * dt
            if s.phase > 28 * .pi { s.phase -= 28 * .pi }
            return s.phase
        }
    }

    static func notifyChange() {}
}
