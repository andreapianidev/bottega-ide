//
//  LunaAvvioView.swift
//  Bottega per iPhone
//
//  La luna Metal della schermata d'avvio (LunaAvvio.metal): il Sole vero di adesso (LunaVera) sorge sulla luna
//  mentre l'app si prepara, il terminatore scorre fino alla fase di stasera con le ombre del rilievo, poi la
//  vista si ferma sull'ultimo fotogramma e non consuma piu' niente. "Riduci movimento" mostra subito la fase
//  di stasera. Se Metal non c'e' (`disponibile` falso) AvvioView mostra l'immagine di prima.
//
//  Va messa in un riquadro un po' piu' grande del disco: il disco occupa l'80% del lato, il resto e' l'alone
//  (190 punti di lato per un disco di 150, come l'immagine di prima).
//

import SwiftUI
import MetalKit

struct LunaAvvioView: UIViewRepresentable {
    /// Quanto dura l'alba sulla luna, in secondi. AvvioView resta a schermo 1,6 secondi e passa 1,4.
    var durata: Double = 1.1

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static var disponibile: Bool { MTLCreateSystemDefaultDevice() != nil }

    func makeCoordinator() -> LunaAvvioRenderer? {
        guard let device = MTLCreateSystemDefaultDevice() else { return nil }
        return LunaAvvioRenderer(device: device, stato: LunaVera.stato(at: Date()))
    }

    func makeUIView(context: Context) -> MTKView {
        let view = MTKView()
        view.isOpaque = false
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        guard let renderer = context.coordinator else { return view }
        view.device = renderer.device
        view.colorPixelFormat = .bgra8Unorm
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        view.framebufferOnly = true
        view.preferredFramesPerSecond = 60
        renderer.durata = reduceMotion ? 0 : durata
        view.delegate = renderer
        return view
    }

    func updateUIView(_ uiView: MTKView, context: Context) {}
}

final class LunaAvvioRenderer: NSObject, MTKViewDelegate {
    let device: MTLDevice
    var durata: Double = 1.1
    private let queue: MTLCommandQueue
    private let pipe: MTLRenderPipelineState
    private let cielo: SIMD4<Float>
    private var inizio: CFTimeInterval?
    private var fermi = 0

    /// Specchio di `LunaAvvioU` in LunaAvvio.metal.
    private struct Uniformi {
        var a: SIMD4<Float>
        var b: SIMD4<Float>
    }

    init?(device: MTLDevice, stato: LunaVera.Stato) {
        guard let q = device.makeCommandQueue(),
              let lib = device.makeDefaultLibrary(),
              let v = lib.makeFunction(name: "luna_avvio_vertex"),
              let f = lib.makeFunction(name: "luna_avvio_fragment") else { return nil }
        let d = MTLRenderPipelineDescriptor()
        d.vertexFunction = v
        d.fragmentFunction = f
        d.colorAttachments[0].pixelFormat = .bgra8Unorm
        guard let p = try? device.makeRenderPipelineState(descriptor: d) else { return nil }
        self.device = device
        self.queue = q
        self.pipe = p
        self.cielo = SIMD4(Float(Double.pi - stato.angoloFase),
                           Float(-sin(stato.angoloLembo)), Float(cos(stato.angoloLembo)), 0)
        super.init()
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        let ora = CACurrentMediaTime()
        if inizio == nil { inizio = ora }
        let t = durata > 0 ? min(1, (ora - inizio!) / durata) : 1
        let p = 1 - pow(1 - t, 3)                          // l'alba rallenta arrivando alla fase vera
        let size = view.drawableSize
        guard size.width > 1, size.height > 1,
              let rpd = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
              let cmd = queue.makeCommandBuffer(),
              let enc = cmd.makeRenderCommandEncoder(descriptor: rpd) else { return }
        var u = Uniformi(a: SIMD4(Float(size.width), Float(size.height), Float(p), 0), b: cielo)
        enc.setRenderPipelineState(pipe)
        enc.setFragmentBytes(&u, length: MemoryLayout<Uniformi>.stride, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
        cmd.present(drawable)
        cmd.commit()
        // Arrivata alla fase vera, ancora due fotogrammi per sicurezza e poi la vista si ferma.
        if t >= 1 {
            fermi += 1
            if fermi > 2 { view.isPaused = true }
        }
    }
}
