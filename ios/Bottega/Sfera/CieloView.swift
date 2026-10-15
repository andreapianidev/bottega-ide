//
//  CieloView.swift
//  Bottega per iPhone
//
//  Il cielo nero di Moony AI dietro tutta l'app (Cielo.metal): stelle, comete e stelle cadenti, come la
//  schermata di caricamento del Mac. Una MTKView opaca a 30 fotogrammi al secondo, ferma quando l'app non si vede.
//  Le stelle compaiono una volta sola, alla prima apertura dell'app: cambiando stanza il cielo non ricomincia.
//  Con "Riduci movimento" le stelle stanno ferme e la vista si ferma dopo pochi fotogrammi. Senza Metal resta il nero.
//

import MetalKit
import SwiftUI

struct CieloView: UIViewRepresentable {
    /// Falso quando l'app e' dietro: niente fotogrammi.
    var attivo: Bool
    /// Quanto brillano stelle e comete, 0...1: piena sulla luna, piu' bassa sotto le liste da leggere.
    var luce: Double = 1

    @Environment(\.accessibilityReduceMotion) private var riduciMovimento

    func makeCoordinator() -> CieloRenderer? {
        MTLCreateSystemDefaultDevice().flatMap(CieloRenderer.init(device:))
    }

    func makeUIView(context: Context) -> MTKView {
        let v = MTKView()
        v.isOpaque = true
        v.backgroundColor = .black
        v.isUserInteractionEnabled = false
        v.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        guard let r = context.coordinator else {
            v.isPaused = true
            v.enableSetNeedsDisplay = true
            return v
        }
        v.device = r.device
        v.colorPixelFormat = .bgra8Unorm
        v.framebufferOnly = true
        v.preferredFramesPerSecond = 30
        v.delegate = r
        aggiorna(v, r)
        return v
    }

    func updateUIView(_ v: MTKView, context: Context) {
        guard let r = context.coordinator else { return }
        aggiorna(v, r)
    }

    private func aggiorna(_ v: MTKView, _ r: CieloRenderer) {
        r.moto = !riduciMovimento
        r.luce = Float(luce)
        r.fermi = 0
        v.isPaused = !attivo
    }
}

final class CieloRenderer: NSObject, MTKViewDelegate {
    let device: MTLDevice
    var moto = true
    var luce: Float = 1
    /// Fotogrammi disegnati da fermo (Riduci movimento): dopo tre la vista si ferma.
    var fermi = 0
    private let coda: MTLCommandQueue
    private let pipe: MTLRenderPipelineState

    /// Il primo istante del cielo in questa apertura dell'app: le stelle compaiono da li', una volta sola.
    private static let nascita = CACurrentMediaTime()
    private static let comparsa: Double = 2.4

    /// Specchio di `CieloU` in Cielo.metal.
    private struct Uniformi {
        var a: SIMD4<Float>
        var b: SIMD4<Float>
    }

    init?(device: MTLDevice) {
        guard let q = device.makeCommandQueue(),
              let lib = device.makeDefaultLibrary(),
              let v = lib.makeFunction(name: "cielo_vertex"),
              let f = lib.makeFunction(name: "cielo_fragment") else { return nil }
        let d = MTLRenderPipelineDescriptor()
        d.vertexFunction = v
        d.fragmentFunction = f
        d.colorAttachments[0].pixelFormat = .bgra8Unorm
        guard let p = try? device.makeRenderPipelineState(descriptor: d) else { return nil }
        self.device = device
        coda = q
        pipe = p
        super.init()
        _ = Self.nascita
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        let t = CACurrentMediaTime() - Self.nascita
        let comparsa = moto ? min(1, t / Self.comparsa) : 1
        let scala = max(view.contentScaleFactor, 1)
        let size = view.drawableSize
        guard size.width > 1, size.height > 1,
              let rpd = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
              let cmd = coda.makeCommandBuffer(),
              let enc = cmd.makeRenderCommandEncoder(descriptor: rpd) else { return }
        var u = Uniformi(a: SIMD4(Float(size.width / scala), Float(size.height / scala),
                                  Float(t.truncatingRemainder(dividingBy: 3600)), Float(comparsa)),
                         b: SIMD4(moto ? 1 : 0, luce, 0, 0))
        enc.setRenderPipelineState(pipe)
        enc.setFragmentBytes(&u, length: MemoryLayout<Uniformi>.stride, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
        cmd.present(drawable)
        cmd.commit()
        if !moto {
            fermi += 1
            if fermi > 2 { view.isPaused = true }
        }
    }
}
