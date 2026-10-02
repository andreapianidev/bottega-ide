//
//  MetalBench.swift
//  Bottega Nucleo
//
//  `--cli metal-bench`: what a frame costs, measured offscreen, no window. The sky with a
//  sample scene (40 projects, 16 lines, two live sessions), and the orb through its own
//  self test (OrbRenderer.selfTest), both on the shared engine's device and library.
//  Main thread only: the orb swaps in its rich noise volume on main.
//

import AppKit
import Metal
import QuartzCore

/// JSON null for a missing measure (JSON.encode does not unwrap an Optional inside Any).
private func ms(_ v: Double?) -> Any { v.map { ($0 * 1000).rounded() / 1000 as Any } ?? NSNull() }

extension MetalEngine {
    /// Runs on main. Spins the main run loop while the orb's noise volume is generated
    /// (no window is ever created).
    @MainActor
    static func bench(width: Int, height: Int, frames: Int) -> [String: Any] {
        let engine = MetalEngine.shared
        guard let device = engine.device else { return ["ok": false, "error": "nessun dispositivo Metal"] }
        let t0 = CACurrentMediaTime()
        _ = engine.library
        let libMs = Int((CACurrentMediaTime() - t0) * 1000)
        var out: [String: Any] = ["ok": true, "device": device.name, "shaders": engine.shaderSource,
                                  "libraryMs": libMs, "reduceMotion": engine.reduceMotion]

        // Sky.
        if let sky = SkyRenderer(engine: engine) {
            sky.setScene(SkyScene.sample(count: 40))
            sky.fieldRect = SIMD4(0.25, 0.08, 0.5, 0.68)
            sky.pixelsPerPoint = 1.5
            sky.selected = 3
            var sizes: [String: Any] = [:]
            for (w, h) in [(width, height), (1920, 1230), (3840, 2160)] where sizes["\(w)x\(h)"] == nil {
                if let r = sky.bench(width: w, height: h, frames: frames) { sizes["\(w)x\(h)"] = r }
            }
            var skyOut: [String: Any] = ["bySize": sizes]
            if let main = sizes["\(width)x\(height)"] as? [String: Any], let gpu = main["gpuMsPerFrame"] as? Double,
               let cpu = main["cpuMicrosPerFrame"] as? Double {
                var rhythm: [String: Any] = [:]
                for (name, lively) in [("aRiposo", false), ("vivo", true)] {
                    let fps = engine.fps(for: .sky, visible: true, lively: lively)
                    rhythm[name] = ["fps": fps,
                                    "estimatedCpuPercent": (cpu * Double(fps) / 10_000 * 1000).rounded() / 1000,
                                    "estimatedGpuPercent": (gpu * Double(fps) / 10 * 100).rounded() / 100]
                }
                skyOut["rhythm"] = rhythm
            }
            out["sky"] = skyOut
        } else {
            out["sky"] = ["error": "pipeline del cielo non create (shader mancanti?)"]
        }

        // Orb, with its own self test, on the shared device and library.
        if let lib = engine.library(containing: "orb_vertex"),
           let orb = OrbRenderer(device: device, library: lib, pixelFormat: .rgba16Float) {
            let t1 = CACurrentMediaTime()
            while !orb.hasRichNoise, CACurrentMediaTime() - t1 < 10 {
                RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.02))
            }
            let side = Int(OrbPanel.orbSide * OrbPanel.renderScale)
            var big: [String: Any] = [:]
            for (name, st) in [("idle", Int32(0)), ("speaking", Int32(3))] {
                let gpu = orb.selfTest(width: side, height: side, frames: frames, state: st)
                let fps = engine.fps(for: .orb, visible: true, lively: st == 3)
                big[name] = ["gpuMsPerFrame": ms(gpu),
                             "cpuMicrosPerFrame": (orb.selfTestCPUMicros * 10).rounded() / 10,
                             "fps": fps]
            }
            orb.docked = true
            let dockPx = Int(OrbPanel.dockSide * OrbPanel.dockScale)
            let dGPU = orb.selfTest(width: dockPx, height: dockPx, frames: frames, state: 0)
            let dCPU = orb.selfTestCPUMicros
            let dFps = engine.fps(for: .orbDocked, visible: true, lively: false)
            out["orb"] = ["pixels": side, "richNoiseMs": Int((CACurrentMediaTime() - t1) * 1000), "big": big,
                          "docked": ["pixels": dockPx, "fps": dFps,
                                     "gpuMsPerFrame": ms(dGPU),
                                     "cpuMicrosPerFrame": (dCPU * 10).rounded() / 10]]
        } else {
            out["orb"] = ["error": "pipeline della sfera non create"]
        }
        out["engine"] = engine.report()
        return out
    }
}
