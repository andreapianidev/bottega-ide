//
//  OrbRenderer.swift
//  Bottega Nucleo
//
//  MTKViewDelegate for the orb. Port of Melissa's VoiceOrbRenderer (Avo Agency AI) with
//  the desktop panel in mind: fewer particles (2048 instead of 12288), no mood backdrop
//  or place photo, cinematic extras off, and the rich 96^3 noise volume generated off
//  the main thread the first time the orb is shown.
//
//  Per frame (dt based): a spring for loudness, an anticipation impulse on each state
//  change, a decaying onset envelope from the level's rising edges, a 0.35 s state
//  crossfade. Then: particles (compute), orb + sparks into an HDR scene texture, bloom
//  pyramid + anamorphic streak, composite into the drawable (premultiplied, EDR).
//

import MetalKit
import QuartzCore
import simd

struct OrbUniforms {
    var p0: SIMD4<Float>
    var p1: SIMD4<Float>
    var p2: SIMD4<Float>
    var p3: SIMD4<Float>
    var p4: SIMD4<Float>
    var p5: SIMD4<Float>
    var spectrum: (SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>)
}

private struct ParticleUniforms {
    var q0: SIMD4<Float>
    var q1: SIMD4<Float>
}

private struct ParticleData {
    var posLife: SIMD4<Float>
    var velSeed: SIMD4<Float>
}

private struct BloomUniforms {
    var b0: SIMD4<Float>
    var b1: SIMD4<Float>
}

enum OrbLibrary {
    /// The shader library: the precompiled default.metallib in the bundle (build.sh, when
    /// the Metal toolchain is installed), else OrbShaders.metal compiled at runtime. The
    /// runtime path is slow the first time; macOS keeps compiled pipelines in its own
    /// shader cache, keyed by bundle id, so later launches are fast.
    static func load(device: MTLDevice) -> MTLLibrary? {
        if let url = Nucleo.bundle.url(forResource: "default", withExtension: "metallib"),
           let lib = try? device.makeLibrary(URL: url) {
            return lib
        }
        guard let src = Nucleo.bundle.url(forResource: "OrbShaders", withExtension: "metal"),
              let text = try? String(contentsOf: src, encoding: .utf8) else {
            Log.error("La sfera non trova i suoi shader nel pacchetto.")
            return nil
        }
        let opts = MTLCompileOptions()
        opts.mathMode = .fast
        do {
            let lib = try device.makeLibrary(source: text, options: opts)
            Log.info("shader della sfera compilati al volo")
            return lib
        } catch {
            Log.error("Shader della sfera non compilabili: \(error.localizedDescription)")
            return nil
        }
    }
}

final class OrbRenderer: NSObject, MTKViewDelegate {
    static let particleCount = 2048
    private static let noiseDim = 96

    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let pixelFormat: MTLPixelFormat
    private var noiseTexture: MTLTexture
    private var noiseIsRich = false
    private let noiseSampler: MTLSamplerState

    private let particlePipeline: MTLRenderPipelineState?
    private let trailPipeline: MTLRenderPipelineState?
    private let particleCompute: MTLComputePipelineState?
    private let particleBuffer: MTLBuffer?

    private let brightPipeline: MTLRenderPipelineState?
    private let downPipeline: MTLRenderPipelineState?
    private let upPipeline: MTLRenderPipelineState?
    private let streakPipeline: MTLRenderPipelineState?
    private let compositePipeline: MTLRenderPipelineState?
    private let bloomSampler: MTLSamplerState?
    private var sceneTex: MTLTexture?
    private var bloomChain: [MTLTexture] = []
    private var streakA: MTLTexture?
    private var streakB: MTLTexture?
    private var bloomSize = SIMD2<Int>(0, 0)

    private let startTime = CACurrentMediaTime()

    /// Written on main by the panel, read on main in draw: no lock needed.
    var state: Int32 = 0
    /// Docked mini orb: zoomed sphere, no spark field, no bloom. A 144 px view has no
    /// room for either, and this mode is on screen all day, so it must cost nothing.
    var docked = false
    static let dockedZoom: Float = 0.60

    private var started = false
    private var lastFrameTime: CFTimeInterval = 0
    private var lastState: Int32 = 0
    private var prevState: Int32 = 0
    private var stateChangeTime: CFTimeInterval = 0
    private var loudPos: Float = 0, loudVel: Float = 0
    private var impulsePos: Float = 0, impulseVel: Float = 0
    private var onsetEnv: Float = 0
    private var lastLevel: Float = 0
    private var reveal: Float = 0
    private var spectrumS = [Float](repeating: 0, count: AudioLevels.bandCount)

    init?(device: MTLDevice, library lib: MTLLibrary, pixelFormat: MTLPixelFormat) {
        guard let q = device.makeCommandQueue(),
              let vfn = lib.makeFunction(name: "orb_vertex"),
              let ffn = lib.makeFunction(name: "orb_fragment") else { return nil }
        let desc = MTLRenderPipelineDescriptor()
        desc.vertexFunction = vfn
        desc.fragmentFunction = ffn
        Self.premultiplied(desc.colorAttachments[0]!, pixelFormat)
        guard let p = try? device.makeRenderPipelineState(descriptor: desc) else { return nil }

        let sd = MTLSamplerDescriptor()
        sd.minFilter = .linear; sd.magFilter = .linear; sd.mipFilter = .notMipmapped
        sd.sAddressMode = .repeat; sd.tAddressMode = .repeat; sd.rAddressMode = .repeat
        guard let samp = device.makeSamplerState(descriptor: sd),
              let boot = Self.makeNoiseTexture(device: device, dim: 4, data: Self.bootNoise(dim: 4)) else { return nil }

        self.device = device
        self.queue = q
        self.pipeline = p
        self.pixelFormat = pixelFormat
        self.noiseSampler = samp
        self.noiseTexture = boot

        var pp: MTLRenderPipelineState?
        var tp: MTLRenderPipelineState?
        var pc: MTLComputePipelineState?
        var pb: MTLBuffer?
        if let pv = lib.makeFunction(name: "orb_particle_vertex"),
           let pf = lib.makeFunction(name: "orb_particle_fragment"),
           let pk = lib.makeFunction(name: "orb_particle_update") {
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = pv
            d.fragmentFunction = pf
            Self.premultiplied(d.colorAttachments[0]!, pixelFormat)
            pp = try? device.makeRenderPipelineState(descriptor: d)
            pc = try? device.makeComputePipelineState(function: pk)
            pb = Self.makeParticleBuffer(device: device)
        }
        if let tv = lib.makeFunction(name: "orb_particle_trail_vertex"),
           let tf = lib.makeFunction(name: "orb_particle_trail_fragment") {
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = tv
            d.fragmentFunction = tf
            Self.premultiplied(d.colorAttachments[0]!, pixelFormat)
            tp = try? device.makeRenderPipelineState(descriptor: d)
        }
        particlePipeline = pp
        trailPipeline = tp
        particleCompute = pc
        particleBuffer = pb

        var bb, bd, bu, bs, bc: MTLRenderPipelineState?
        if let fv = lib.makeFunction(name: "fs_vertex"),
           let fb = lib.makeFunction(name: "bloom_brightpass"),
           let fd = lib.makeFunction(name: "bloom_downsample"),
           let fu = lib.makeFunction(name: "bloom_upsample"),
           let fk = lib.makeFunction(name: "bloom_streak"),
           let fc = lib.makeFunction(name: "bloom_composite") {
            func mk(_ frag: MTLFunction, additive: Bool = false) -> MTLRenderPipelineState? {
                let d = MTLRenderPipelineDescriptor()
                d.vertexFunction = fv
                d.fragmentFunction = frag
                d.colorAttachments[0].pixelFormat = pixelFormat
                if additive {
                    d.colorAttachments[0].isBlendingEnabled = true
                    d.colorAttachments[0].rgbBlendOperation = .add
                    d.colorAttachments[0].alphaBlendOperation = .add
                    d.colorAttachments[0].sourceRGBBlendFactor = .one
                    d.colorAttachments[0].sourceAlphaBlendFactor = .one
                    d.colorAttachments[0].destinationRGBBlendFactor = .one
                    d.colorAttachments[0].destinationAlphaBlendFactor = .one
                }
                return try? device.makeRenderPipelineState(descriptor: d)
            }
            bb = mk(fb); bd = mk(fd); bu = mk(fu, additive: true); bs = mk(fk); bc = mk(fc)
        }
        brightPipeline = bb; downPipeline = bd; upPipeline = bu; streakPipeline = bs; compositePipeline = bc
        let bsd = MTLSamplerDescriptor()
        bsd.minFilter = .linear; bsd.magFilter = .linear
        bsd.sAddressMode = .clampToEdge; bsd.tAddressMode = .clampToEdge
        bloomSampler = device.makeSamplerState(descriptor: bsd)
        super.init()
        warmRichNoise()
    }

    private static func premultiplied(_ att: MTLRenderPipelineColorAttachmentDescriptor, _ pf: MTLPixelFormat) {
        att.pixelFormat = pf
        att.isBlendingEnabled = true
        att.rgbBlendOperation = .add
        att.alphaBlendOperation = .add
        att.sourceRGBBlendFactor = .one
        att.sourceAlphaBlendFactor = .one
        att.destinationRGBBlendFactor = .oneMinusSourceAlpha
        att.destinationAlphaBlendFactor = .oneMinusSourceAlpha
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        let size = view.drawableSize
        guard size.width > 0, size.height > 0,
              let rpd = view.currentRenderPassDescriptor,
              let drawable = view.currentDrawable,
              let cmd = queue.makeCommandBuffer() else { return }
        encodeFrame(cmd: cmd, target: rpd, width: Int(size.width), height: Int(size.height))
        cmd.present(drawable)
        cmd.commit()
    }

    /// Diagnostics without a window: renders `frames` frames into an offscreen texture and
    /// returns the average GPU time per frame in milliseconds (nil if Metal refused).
    /// CPU time spent encoding the last self-test run, per frame, in microseconds.
    private(set) var selfTestCPUMicros: Double = 0

    func selfTest(width: Int, height: Int, frames: Int, state newState: Int32) -> Double? {
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: pixelFormat, width: width, height: height, mipmapped: false)
        d.usage = [.renderTarget, .shaderRead]
        d.storageMode = .private
        guard let target = device.makeTexture(descriptor: d) else { return nil }
        state = newState
        var total = 0.0
        var counted = 0
        var cpuNs: UInt64 = 0
        for _ in 0..<frames {
            let c0 = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
            let rpd = MTLRenderPassDescriptor()
            rpd.colorAttachments[0].texture = target
            rpd.colorAttachments[0].loadAction = .clear
            rpd.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
            rpd.colorAttachments[0].storeAction = .store
            guard let cmd = queue.makeCommandBuffer() else { return nil }
            encodeFrame(cmd: cmd, target: rpd, width: width, height: height)
            cmd.commit()
            cpuNs += clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - c0
            cmd.waitUntilCompleted()
            if cmd.status == .error { return nil }
            let gpu = cmd.gpuEndTime - cmd.gpuStartTime
            if gpu > 0 { total += gpu; counted += 1 }
        }
        selfTestCPUMicros = Double(cpuNs) / Double(max(1, frames)) / 1000
        return counted > 0 ? total / Double(counted) * 1000 : nil
    }

    var hasRichNoise: Bool { noiseIsRich }

    private func encodeFrame(cmd: MTLCommandBuffer, target rpd: MTLRenderPassDescriptor, width vw: Int, height vh: Int) {

        let now = CACurrentMediaTime()
        if !started { started = true; lastState = state; prevState = state; stateChangeTime = now - 1; lastFrameTime = now }
        var dt = Float(now - lastFrameTime); lastFrameTime = now
        dt = min(max(dt, 1.0 / 240.0), 0.05)

        if state != lastState { prevState = lastState; lastState = state; stateChangeTime = now; impulseVel += 7.0 }
        let mix = Float(min(1.0, max(0.0, (now - stateChangeTime) / 0.35)))

        let audio = AudioLevels.shared.snapshot(forOrbState: state)
        let level = audio.level
        // onset = rising edge of the level (a cheap stand-in for spectral flux)
        let rise = max(0, level - lastLevel)
        lastLevel = lastLevel + (level - lastLevel) * 0.5
        let onset = min(1, rise * 2.5)
        for i in 0..<spectrumS.count where i < audio.bands.count {
            let t = audio.bands[i], p = spectrumS[i]
            spectrumS[i] = p + (t - p) * (t > p ? 0.55 : 0.22)
        }

        loudVel += (130.0 * (level - loudPos) - 17.0 * loudVel) * dt
        loudPos = max(0.0, loudPos + loudVel * dt)
        let loud = min(loudPos, 1.5)
        impulseVel += (95.0 * (0.0 - impulsePos) - 8.0 * impulseVel) * dt
        impulsePos += impulseVel * dt
        onsetEnv = max(onsetEnv * (1.0 - min(1.0, dt * 7.0)), onset)

        let tSec = Float(now - startTime)
        let pulse = 0.5 + 0.5 * sinf(tSec * (state == 3 ? 4.2 : 1.4)) * (0.4 + loud)

        if noiseIsRich { reveal = min(1.0, reveal + dt * 1.25) }
        let revealS = reveal * reveal * (3.0 - 2.0 * reveal)

        func band(_ j: Int) -> Float { j < spectrumS.count ? spectrumS[j] : 0 }
        func vec(_ i: Int) -> SIMD4<Float> { SIMD4(band(4 * i), band(4 * i + 1), band(4 * i + 2), band(4 * i + 3)) }
        let ld = simd_normalize(SIMD3<Float>(0.45, 0.65, 0.85))
        var u = OrbUniforms(
            p0: SIMD4(Float(vw), Float(vh), tSec, level),
            p1: SIMD4(Float(state), Float(prevState), mix, loud),
            p2: SIMD4(onsetEnv, 0, impulsePos, revealS),
            p3: SIMD4(ld.x, ld.y, ld.z, 0.35),
            p4: SIMD4(0.10, 0.16, 0.26, 0.5),
            p5: SIMD4(docked ? Self.dockedZoom : 1, docked ? 1 : 0, 0, 0),
            spectrum: (vec(0), vec(1), vec(2), vec(3)))
        var pu = ParticleUniforms(q0: SIMD4(dt, tSec, Float(state), loud),
                                  q1: SIMD4(1, Float(Self.particleCount), pulse, 0))

        if !docked, let pc = particleCompute, let pb = particleBuffer, let ce = cmd.makeComputeCommandEncoder() {
            ce.setComputePipelineState(pc)
            ce.setBuffer(pb, offset: 0, index: 0)
            ce.setBytes(&pu, length: MemoryLayout<ParticleUniforms>.stride, index: 1)
            let tw = min(pc.maxTotalThreadsPerThreadgroup, Self.particleCount)
            ce.dispatchThreadgroups(MTLSize(width: (Self.particleCount + tw - 1) / tw, height: 1, depth: 1),
                                    threadsPerThreadgroup: MTLSize(width: tw, height: 1, depth: 1))
            ce.endEncoding()
        }

        let noise = noiseTexture
        func renderOrb(_ enc: MTLRenderCommandEncoder) {
            enc.setRenderPipelineState(pipeline)
            enc.setFragmentBytes(&u, length: MemoryLayout<OrbUniforms>.stride, index: 0)
            enc.setFragmentTexture(noise, index: 0)
            enc.setFragmentSamplerState(noiseSampler, index: 0)
            enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
            guard !docked, let pb = particleBuffer else { return }
            if let tp = trailPipeline {
                enc.setRenderPipelineState(tp)
                enc.setVertexBuffer(pb, offset: 0, index: 0)
                enc.setVertexBytes(&pu, length: MemoryLayout<ParticleUniforms>.stride, index: 1)
                enc.drawPrimitives(type: .line, vertexStart: 0, vertexCount: Self.particleCount * 2)
            }
            if let pp = particlePipeline {
                enc.setRenderPipelineState(pp)
                enc.setVertexBuffer(pb, offset: 0, index: 0)
                enc.setVertexBytes(&pu, length: MemoryLayout<ParticleUniforms>.stride, index: 1)
                enc.drawPrimitives(type: .point, vertexStart: 0, vertexCount: Self.particleCount)
            }
        }

        if !docked { ensureBloomTextures(width: vw, height: vh) }
        if !docked, let scene = sceneTex, bloomChain.count >= 2, let sA = streakA, let sB = streakB,
           let bright = brightPipeline, let down = downPipeline, let up = upPipeline,
           let streak = streakPipeline, let comp = compositePipeline, let bs = bloomSampler {

            func pass(_ target: MTLTexture, _ pipe: MTLRenderPipelineState, _ src: MTLTexture,
                      _ uni: BloomUniforms, clear: Bool = true) {
                let r = MTLRenderPassDescriptor()
                r.colorAttachments[0].texture = target
                r.colorAttachments[0].loadAction = clear ? .clear : .load
                r.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
                r.colorAttachments[0].storeAction = .store
                guard let e = cmd.makeRenderCommandEncoder(descriptor: r) else { return }
                var un = uni
                e.setRenderPipelineState(pipe)
                e.setFragmentTexture(src, index: 0)
                e.setFragmentSamplerState(bs, index: 0)
                e.setFragmentBytes(&un, length: MemoryLayout<BloomUniforms>.stride, index: 0)
                e.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
                e.endEncoding()
            }
            func texel(_ t: MTLTexture) -> SIMD4<Float> {
                SIMD4(1.0 / Float(max(1, t.width)), 1.0 / Float(max(1, t.height)), 0, 0)
            }

            let rs = MTLRenderPassDescriptor()
            rs.colorAttachments[0].texture = scene
            rs.colorAttachments[0].loadAction = .clear
            rs.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
            rs.colorAttachments[0].storeAction = .store
            if let e = cmd.makeRenderCommandEncoder(descriptor: rs) { renderOrb(e); e.endEncoding() }

            let bu = BloomUniforms(b0: .zero, b1: SIMD4(0.90, 1.35, 0.45, 0))
            pass(bloomChain[0], bright, scene, bu)
            for i in 0..<(bloomChain.count - 1) {
                pass(bloomChain[i + 1], down, bloomChain[i], BloomUniforms(b0: texel(bloomChain[i]), b1: bu.b1))
            }
            for i in stride(from: bloomChain.count - 2, through: 0, by: -1) {
                pass(bloomChain[i], up, bloomChain[i + 1],
                     BloomUniforms(b0: texel(bloomChain[i + 1]), b1: SIMD4(1.0, 0.85, 0, 0)), clear: false)
            }
            let st = texel(sA)
            let dirH = SIMD4<Float>(st.x, st.y, 1, 0)
            pass(sA, streak, bloomChain[1], BloomUniforms(b0: dirH, b1: SIMD4(4.0, 0.86, 0, 0)))
            pass(sB, streak, sA, BloomUniforms(b0: dirH, b1: SIMD4(36.0, 0.82, 0, 0)))
            pass(sA, streak, sB, BloomUniforms(b0: dirH, b1: SIMD4(324.0, 0.76, 0, 0)))

            if let e = cmd.makeRenderCommandEncoder(descriptor: rpd) {
                var cu = bu
                e.setRenderPipelineState(comp)
                e.setFragmentTexture(scene, index: 0)
                e.setFragmentTexture(bloomChain[0], index: 1)
                e.setFragmentTexture(sA, index: 2)
                e.setFragmentSamplerState(bs, index: 0)
                e.setFragmentBytes(&cu, length: MemoryLayout<BloomUniforms>.stride, index: 0)
                e.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
                e.endEncoding()
            }
        } else if let e = cmd.makeRenderCommandEncoder(descriptor: rpd) {
            renderOrb(e); e.endEncoding()
        }
    }

    // MARK: - Noise

    /// 4^3 hash noise: the orb renders a clean smooth globe (reveal 0) until the rich
    /// volume is ready a moment later.
    private static func bootNoise(dim n: Int) -> [Float16] {
        var data = [Float16](repeating: 0.5, count: n * n * n * 4)
        for i in 0..<(n * n * n) {
            data[i * 4 + 0] = Float16(hashF(i, 1, 0, 1))
            data[i * 4 + 3] = Float16(hashF(i, 2, 0, 91))
        }
        return data
    }

    private static func makeNoiseTexture(device: MTLDevice, dim n: Int, data: [Float16]) -> MTLTexture? {
        let d = MTLTextureDescriptor()
        d.textureType = .type3D
        d.pixelFormat = .rgba16Float
        d.width = n; d.height = n; d.depth = n
        d.usage = .shaderRead
        d.storageMode = .shared
        guard let tex = device.makeTexture(descriptor: d) else { return nil }
        let bpr = n * 4 * MemoryLayout<Float16>.size
        data.withUnsafeBytes { raw in
            tex.replace(region: MTLRegionMake3D(0, 0, 0, n, n, n), mipmapLevel: 0, slice: 0,
                        withBytes: raw.baseAddress!, bytesPerRow: bpr, bytesPerImage: bpr * n)
        }
        return tex
    }

    /// The 96^3 Perlin-Worley volume (~0.3 s on 8 cores), generated off main and swapped
    /// in on main. Not cached on disk: 7 MB of file for 0.3 s once per orb lifetime.
    private func warmRichNoise() {
        let device = self.device
        Task.detached(priority: .utility) { [weak self] in
            let data = Self.makeRichNoise(dim: Self.noiseDim)
            guard let tex = Self.makeNoiseTexture(device: device, dim: Self.noiseDim, data: data) else { return }
            await MainActor.run { [weak self] in
                self?.noiseTexture = tex
                self?.noiseIsRich = true
            }
        }
    }

    private static func hashF(_ x: Int, _ y: Int, _ z: Int, _ seed: Int) -> Float {
        var n = UInt32(truncatingIfNeeded: x &* 374761393 &+ y &* 668265263 &+ z &* 1274126177 &+ seed &* 2246822519)
        n = (n ^ (n >> 13)) &* 1274126177
        n = n ^ (n >> 16)
        return Float(n & 0xFFFFFF) / Float(0xFFFFFF)
    }

    private static func valueNoise(_ fx: Float, _ fy: Float, _ fz: Float, _ freq: Int, _ seed: Int) -> Float {
        let u = fx * Float(freq), v = fy * Float(freq), w = fz * Float(freq)
        let xi = Int(u.rounded(.down)), yi = Int(v.rounded(.down)), zi = Int(w.rounded(.down))
        let tx = u - Float(xi), ty = v - Float(yi), tz = w - Float(zi)
        func sm(_ t: Float) -> Float { t * t * (3 - 2 * t) }
        let sx = sm(tx), sy = sm(ty), sz = sm(tz)
        func cn(_ dx: Int, _ dy: Int, _ dz: Int) -> Float {
            hashF((xi + dx) % freq, (yi + dy) % freq, (zi + dz) % freq, seed)
        }
        let x00 = cn(0,0,0) + (cn(1,0,0) - cn(0,0,0)) * sx, x10 = cn(0,1,0) + (cn(1,1,0) - cn(0,1,0)) * sx
        let x01 = cn(0,0,1) + (cn(1,0,1) - cn(0,0,1)) * sx, x11 = cn(0,1,1) + (cn(1,1,1) - cn(0,1,1)) * sx
        let y0 = x00 + (x10 - x00) * sy, y1 = x01 + (x11 - x01) * sy
        return y0 + (y1 - y0) * sz
    }

    private static func vfbm(_ fx: Float, _ fy: Float, _ fz: Float, _ seed: Int) -> Float {
        var v: Float = 0, a: Float = 0.5
        for (k, f) in [6, 12, 24, 48].enumerated() {
            v += a * valueNoise(fx, fy, fz, f, seed + k * 101)
            a *= 0.5
        }
        return v / 0.9375
    }

    private static func worley(_ fx: Float, _ fy: Float, _ fz: Float, _ cells: Int, _ seed: Int) -> Float {
        let u = fx * Float(cells), v = fy * Float(cells), w = fz * Float(cells)
        let xi = Int(u.rounded(.down)), yi = Int(v.rounded(.down)), zi = Int(w.rounded(.down))
        var f1: Float = 8
        for dz in -1...1 { for dy in -1...1 { for dx in -1...1 {
            let cx = xi + dx, cy = yi + dy, cz = zi + dz
            let wx = ((cx % cells) + cells) % cells
            let wy = ((cy % cells) + cells) % cells
            let wz = ((cz % cells) + cells) % cells
            let px = Float(cx) + hashF(wx, wy, wz, seed)
            let py = Float(cy) + hashF(wx, wy, wz, seed + 1)
            let pz = Float(cz) + hashF(wx, wy, wz, seed + 2)
            let ddx = px - u, ddy = py - v, ddz = pz - w
            f1 = min(f1, ddx * ddx + ddy * ddy + ddz * ddz)
        }}}
        return f1.squareRoot()
    }

    private static func makeRichNoise(dim n: Int) -> [Float16] {
        var data = [Float16](repeating: 0, count: n * n * n * 4)
        let inv = 1.0 / Float(n)
        data.withUnsafeMutableBufferPointer { buf in
            let ptr = buf.baseAddress!
            DispatchQueue.concurrentPerform(iterations: n) { z in
                let fz = (Float(z) + 0.5) * inv
                for y in 0..<n {
                    let fy = (Float(y) + 0.5) * inv
                    for x in 0..<n {
                        let fx = (Float(x) + 0.5) * inv
                        let i = ((z * n + y) * n + x) * 4
                        ptr[i + 0] = Float16(vfbm(fx, fy, fz, 1))
                        ptr[i + 1] = Float16(1.0 - min(worley(fx, fy, fz, 8, 17), 1.0))
                        ptr[i + 2] = Float16(1.0 - min(worley(fx, fy, fz, 16, 53), 1.0))
                        ptr[i + 3] = Float16(vfbm(fx, fy, fz, 91))
                    }
                }
            }
        }
        return data
    }

    // MARK: - Particles

    private static func makeParticleBuffer(device: MTLDevice) -> MTLBuffer? {
        func r(_ x: Float) -> Float { let v = sinf(x) * 43758.5453; return v - floorf(v) }
        var arr = [ParticleData]()
        arr.reserveCapacity(particleCount)
        for i in 0..<particleCount {
            let fi = Float(i)
            let a = r(fi * 12.9898), b = r(fi * 78.233), c = r(fi * 37.719), seed = r(fi * 3.17 + 1.0)
            let theta = a * 2.0 * Float.pi
            let phi = acosf(2.0 * b - 1.0)
            let dir = SIMD3<Float>(sinf(phi) * cosf(theta), cosf(phi), sinf(phi) * sinf(theta))
            let pos = dir * (0.30 + c * 0.85)
            arr.append(ParticleData(posLife: SIMD4(pos.x, pos.y, pos.z, c), velSeed: SIMD4(0, 0, 0, seed)))
        }
        return device.makeBuffer(bytes: arr, length: MemoryLayout<ParticleData>.stride * particleCount,
                                 options: .storageModeShared)
    }

    // MARK: - Bloom targets

    private func ensureBloomTextures(width: Int, height: Int) {
        if bloomSize.x == width, bloomSize.y == height, sceneTex != nil, bloomChain.count >= 2, streakA != nil { return }
        func make(_ w: Int, _ h: Int) -> MTLTexture? {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: pixelFormat, width: max(1, w),
                                                             height: max(1, h), mipmapped: false)
            d.usage = [.renderTarget, .shaderRead]
            d.storageMode = .private
            return device.makeTexture(descriptor: d)
        }
        guard let s = make(width, height) else { return }
        var chain: [MTLTexture] = []
        var lw = width / 2, lh = height / 2
        while chain.count < 5, lw >= 8, lh >= 8 {
            guard let t = make(lw, lh) else { break }
            chain.append(t)
            lw /= 2; lh /= 2
        }
        guard chain.count >= 2, let a = make(chain[1].width, chain[1].height),
              let b = make(chain[1].width, chain[1].height) else { return }
        sceneTex = s
        bloomChain = chain
        streakA = a
        streakB = b
        bloomSize = SIMD2(width, height)
    }
}

@MainActor
enum OrbSelfTest {
    static func run() async -> [String: Any?] {
        guard let device = MTLCreateSystemDefaultDevice() else { return ["ok": false, "error": "nessun dispositivo Metal"] }
        let t0 = CACurrentMediaTime()
        guard let lib = OrbLibrary.load(device: device) else { return ["ok": false, "error": "libreria shader non caricata"] }
        let tLib = CACurrentMediaTime() - t0
        guard let r = OrbRenderer(device: device, library: lib, pixelFormat: .rgba16Float) else {
            return ["ok": false, "error": "pipeline non create"]
        }
        // Wait for the rich noise volume (generated off main) to measure the real shader.
        let t1 = CACurrentMediaTime()
        while !r.hasRichNoise, CACurrentMediaTime() - t1 < 10 { try? await Task.sleep(for: .milliseconds(20)) }
        let tNoise = CACurrentMediaTime() - t1
        let side = Int(OrbPanel.orbSide * OrbPanel.renderScale)
        var perState: [String: Any] = [:]
        for (name, st) in [("idle", Int32(0)), ("listening", 1), ("thinking", 2), ("speaking", 3), ("error", 4)] {
            perState[name] = r.selfTest(width: side, height: side, frames: 20, state: st).map { ($0 * 100).rounded() / 100 }
        }
        let bigCPU = r.selfTestCPUMicros
        // Docked mini orb: 72 pt at 2x, idle, 12 fps.
        r.docked = true
        let dockPx = Int(OrbPanel.dockSide * OrbPanel.dockScale)
        let dockGPU = r.selfTest(width: dockPx, height: dockPx, frames: 40, state: 0)
        let dockCPU = r.selfTestCPUMicros
        let dockErr = r.selfTest(width: dockPx, height: dockPx, frames: 20, state: 4)
        r.docked = false
        let fps = Double(OrbPanel.dockedIdleFPS)
        let docked: [String: Any?] = [
            "pixels": dockPx, "fps": OrbPanel.dockedIdleFPS,
            "gpuMsPerFrame": dockGPU.map { ($0 * 1000).rounded() / 1000 },
            "gpuMsPerFrameError": dockErr.map { ($0 * 1000).rounded() / 1000 },
            "cpuMicrosPerFrame": (dockCPU * 10).rounded() / 10,
            // Encoding cost only; MTKView's display-link callbacks add a little on top.
            "estimatedCpuPercent": ((dockCPU * fps / 1_000_000 * 100) * 1000).rounded() / 1000,
            "estimatedGpuPercent": dockGPU.map { (($0 * fps / 1000 * 100) * 100).rounded() / 100 },
        ]
        var bySize: [String: Any] = [:]
        for px in [344, 516, 688] {
            bySize["\(px)"] = r.selfTest(width: px, height: px, frames: 20, state: 3).map { ($0 * 100).rounded() / 100 }
        }
        return ["ok": true, "device": device.name, "precompiled": Nucleo.bundle.url(forResource: "default", withExtension: "metallib") != nil,
                "libraryMs": Int(tLib * 1000), "richNoiseMs": Int(tNoise * 1000), "pixels": side,
                "gpuMsPerFrame": perState, "cpuMicrosPerFrame": (bigCPU * 10).rounded() / 10,
                "speakingMsBySize": bySize, "docked": docked]
    }
}
