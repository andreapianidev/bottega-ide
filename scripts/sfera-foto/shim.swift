// Per scripts/sfera-foto: quel poco del Nucleo che OrbRenderer chiama, per un programma da riga di comando su macOS.
import Metal
import QuartzCore
import Foundation
import os

enum Nucleo { static let bundle = Bundle.main }
enum Log {
    static func info(_ m: String) { FileHandle.standardError.write(("info: " + m + "\n").data(using: .utf8)!) }
    static func warn(_ m: String) { FileHandle.standardError.write(("warn: " + m + "\n").data(using: .utf8)!) }
    static func error(_ m: String) { FileHandle.standardError.write(("errore: " + m + "\n").data(using: .utf8)!) }
}
enum Out { static func event(_ name: String, _ fields: [String: Any?] = [:]) {} }
enum OrbPanel {
    static let orbSide: CGFloat = 344
    static let renderScale: CGFloat = 1.5
    static let dockSide: CGFloat = 72
    static let dockScale: CGFloat = 2
    static let dockedIdleFPS = 12
}
final class MetalEngine: @unchecked Sendable {
    static let shared = MetalEngine()
    enum Client { case orb, orbDocked }
    struct FrameToken { let client: Client }
    let device: MTLDevice? = MTLCreateSystemDefaultDevice()
    lazy var queue: MTLCommandQueue? = device?.makeCommandQueue()
    static var sorgente = ""
    private lazy var lib: MTLLibrary? = {
        let o = MTLCompileOptions(); o.mathMode = .fast
        return try? device?.makeLibrary(source: Self.sorgente, options: o)
    }()
    func library(containing function: String) -> MTLLibrary? {
        guard let lib, lib.functionNames.contains(function) else { return nil }
        return lib
    }
    func beginFrame(_ client: Client) -> FrameToken { FrameToken(client: client) }
    func endFrame(_ token: FrameToken, commandBuffer cmd: MTLCommandBuffer) {}
    var reduceMotion: Bool { false }
    private var phase = 0.0, last = 0.0
    func setLoad(_ sessions: Int) {}
    func breathPhase(now: CFTimeInterval = CACurrentMediaTime()) -> Double {
        let dt = last == 0 ? 0 : min(0.25, max(0, now - last)); last = now; phase += 1.4 * dt; return phase
    }
    static func notifyChange() {}
}
