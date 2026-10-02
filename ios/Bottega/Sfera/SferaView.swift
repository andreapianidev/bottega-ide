//
//  SferaView.swift
//  Bottega per iPhone
//
//  La sfera di Melissa: la stessa del Nucleo (OrbRenderer, shader Metal), in una MTKView a 30 fotogrammi
//  al secondo, ferma quando l'app non si vede.
//

import MetalKit
import SwiftUI

enum StatoSfera: Int32 {
    case riposo = 0, ascolta = 1, pensa = 2, parla = 3, errore = 4
}

struct SferaView: UIViewRepresentable {
    var stato: StatoSfera
    var attiva: Bool

    final class Coordinator {
        var renderer: OrbRenderer?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> MTKView {
        let v = MTKView(frame: .zero, device: MetalEngine.shared.device)
        v.colorPixelFormat = .rgba16Float
        v.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        v.isOpaque = false
        v.backgroundColor = .clear
        v.framebufferOnly = true
        v.preferredFramesPerSecond = 30
        if let ml = v.layer as? CAMetalLayer {
            // luce lineare in Display P3 oltre il bianco, come sul Mac: il nucleo brilla quanto lo schermo concede
            ml.wantsExtendedDynamicRangeContent = true
            ml.colorspace = CGColorSpace(name: CGColorSpace.extendedLinearDisplayP3)
            ml.isOpaque = false
        }
        if let device = v.device, let lib = OrbLibrary.load(device: device),
           let r = OrbRenderer(device: device, library: lib, pixelFormat: v.colorPixelFormat) {
            r.state = stato.rawValue
            v.delegate = r
            context.coordinator.renderer = r
        }
        v.isPaused = !attiva
        return v
    }

    func updateUIView(_ v: MTKView, context: Context) {
        context.coordinator.renderer?.state = stato.rawValue
        v.isPaused = !attiva
    }
}
