//
//  SkyRenderer.swift
//  Bottega Nucleo
//
//  The sky of the projects in Metal, on the shared engine (MetalEngine): same device,
//  same queue, same library as the orb.
//
//  Per frame: copy of the cached background (redrawn only when the size changes), one
//  instanced draw for the constellation lines, one instanced draw for every star (the
//  faint field and the projects). The star buffer is a ring of three, so the CPU never
//  writes what the GPU is still reading.
//
//  SkyView (SwiftUI) wraps SkyMTKView: it renders only while its window is on screen and
//  not occluded or minimized, at the rhythm the engine gives (15 fps twinkling, 30 with
//  live sessions or a pulse, nothing but single frames under Reduce motion).
//

import AppKit
import MetalKit
import QuartzCore
import SwiftUI
import simd

struct SkyUniforms {
    var view: SIMD4<Float>
    var field: SIMD4<Float>
    var state: SIMD4<Float>
    var focus: SIMD4<Float>
    var zenith: SIMD4<Float>
    var horizonC: SIMD4<Float>
    var sodium: SIMD4<Float>
    var ink: SIMD4<Float>
    var milky: SIMD4<Float>
    var brace: SIMD4<Float>
    var line: SIMD4<Float>
    var reticle: SIMD4<Float>
    var live: SIMD4<Float>
    var camera: SIMD4<Float>
}

private struct SkyInstance {
    var a: SIMD4<Float>
    var col: SIMD4<Float>
    var b: SIMD4<Float>
    var c: SIMD4<Float>
}

private struct SkyLineInstance {
    var ab: SIMD4<Float>
    var style: SIMD4<Float>
    var extra: SIMD4<Float>
}

final class SkyRenderer: NSObject, MTKViewDelegate {
    static let pixelFormat: MTLPixelFormat = .rgba16Float
    static let fieldStarCount = 1800
    private static let ringSize = 3

    private let engine: MetalEngine
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private let backgroundPipeline: MTLRenderPipelineState
    private let copyPipeline: MTLRenderPipelineState
    private let linePipeline: MTLRenderPipelineState
    private let starPipeline: MTLRenderPipelineState

    private var background: MTLTexture?
    private var backgroundSize = SIMD2<Int>(0, 0)
    private(set) var lastBackgroundMs: Double = 0

    private var scene = SkyScene()
    private var fieldStars: [SkyInstance] = []
    private var lineBuffer: MTLBuffer?
    private var lineCount = 0
    private var ring: [MTLBuffer] = []
    private var ringCapacity = 0
    private var ringIndex = 0
    private let inFlight = DispatchSemaphore(value: SkyRenderer.ringSize)

    private var startTime: CFTimeInterval?
    private var entranceSettled = false
    private var frozenTime: Float = 0

    // Written by the view on main, read in draw on main.
    var fieldRect = SIMD4<Float>(0.25, 0.08, 0.5, 0.66)
    var selected: Int?
    var hovered: Int?
    /// Points per pixel of the drawable (set by the view from the backing scale).
    var pixelsPerPoint: Float = 1.5
    var headroom: Float = 1
    var camera = SkyCamera()
    var isEntering: Bool { startTime.map { CACurrentMediaTime() - $0 < 2.8 } ?? true }

    init?(engine: MetalEngine = .shared) {
        guard let device = engine.device, let queue = engine.queue,
              let fsv = engine.makeFunction("sky_fullscreen_vertex"),
              let bgf = engine.makeFunction("sky_background_fragment"),
              let cpf = engine.makeFunction("sky_copy_fragment"),
              let lv = engine.makeFunction("sky_line_vertex"),
              let lf = engine.makeFunction("sky_line_fragment"),
              let sv = engine.makeFunction("sky_star_vertex"),
              let sf = engine.makeFunction("sky_star_fragment") else { return nil }
        func pipe(_ v: MTLFunction, _ f: MTLFunction, additive: Bool) -> MTLRenderPipelineState? {
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = v
            d.fragmentFunction = f
            let att = d.colorAttachments[0]!
            att.pixelFormat = Self.pixelFormat
            if additive {
                att.isBlendingEnabled = true
                att.rgbBlendOperation = .add
                att.alphaBlendOperation = .add
                att.sourceRGBBlendFactor = .one
                att.sourceAlphaBlendFactor = .zero
                att.destinationRGBBlendFactor = .one
                att.destinationAlphaBlendFactor = .one
            }
            return try? device.makeRenderPipelineState(descriptor: d)
        }
        guard let bg = pipe(fsv, bgf, additive: false), let cp = pipe(fsv, cpf, additive: false),
              let lp = pipe(lv, lf, additive: true), let sp = pipe(sv, sf, additive: true) else { return nil }
        self.engine = engine
        self.device = device
        self.queue = queue
        backgroundPipeline = bg
        copyPipeline = cp
        linePipeline = lp
        starPipeline = sp
        super.init()
        fieldStars = Self.makeFieldStars()
    }

    // MARK: - Scene

    func setScene(_ newScene: SkyScene) {
        guard newScene.version != scene.version || newScene != scene else { return }
        scene = newScene
        var lines: [SkyLineInstance] = []
        for (n, e) in scene.edges.enumerated() where e.a < scene.stars.count && e.b < scene.stars.count && e.a != e.b {
            let a = scene.stars[e.a].position, b = scene.stars[e.b].position
            let width: Float = e.strength >= 0.5 ? 1.4 : 1.0
            lines.append(SkyLineInstance(ab: SIMD4(a.x, a.y, b.x, b.y),
                                         style: SIMD4(width, 0.045 + 0.12 * e.strength, Float(e.a), Float(e.b)),
                                         extra: SIMD4(Float(n) * 0.137, e.strength, 0, 0)))
        }
        lineCount = lines.count
        lineBuffer = lines.isEmpty ? nil : device.makeBuffer(bytes: lines, length: MemoryLayout<SkyLineInstance>.stride * lines.count,
                                                             options: .storageModeShared)
    }

    var currentScene: SkyScene { scene }

    /// True while something moves for a reason: live sessions or a pulse in flight.
    var isLively: Bool { scene.lively || !engine.activePulses().isEmpty }

    // MARK: - MTKViewDelegate

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        if !isEntering && !entranceSettled {
            entranceSettled = true
            (view as? SkyMTKView)?.updateRhythm()
        }
        let size = view.drawableSize
        guard size.width > 0, size.height > 0,
              let rpd = view.currentRenderPassDescriptor,
              let drawable = view.currentDrawable else { return }
        guard inFlight.wait(timeout: .now()) == .success else { return }
        guard let cmd = queue.makeCommandBuffer() else { inFlight.signal(); return }
        let token = engine.beginFrame(.sky)
        encode(cmd: cmd, target: rpd, width: Int(size.width), height: Int(size.height))
        engine.endFrame(token, commandBuffer: cmd)
        let sem = inFlight
        cmd.addCompletedHandler { _ in sem.signal() }
        cmd.present(drawable)
        cmd.commit()
    }

    // MARK: - Encoding

    private func uniforms(width: Int, height: Int) -> SkyUniforms {
        let still = engine.reduceMotion
        let clock = CACurrentMediaTime()
        if startTime == nil { startTime = clock }
        let now = Float(clock - (startTime ?? clock))
        if !still { frozenTime = now }
        let phase = Float(engine.breathPhase())
        func c(_ hex: Int, _ k: Float = 1) -> SIMD4<Float> { SIMD4(Roque.linear(hex) * k, 1) }
        return SkyUniforms(
            view: SIMD4(Float(width), Float(height), pixelsPerPoint, frozenTime),
            field: fieldRect,
            state: SIMD4(phase, headroom, still ? 1 : 0, isLively ? 1 : 0),
            focus: SIMD4(Float(selected ?? -1), Float(hovered ?? -1), SkyGeometry.horizon,
                         Float(width) / Float(max(1, height))),
            zenith: c(Roque.zenit),
            horizonC: c(0x1a2440),
            sodium: c(Roque.sodio),
            ink: c(Roque.inchiostro),
            milky: c(0xc4cce6),
            brace: c(Roque.brace),
            line: c(0x8fa6f0),
            reticle: c(Roque.focus),
            live: c(Roque.sodio),
            camera: SIMD4(camera.yaw, camera.pitch, camera.zoom, still ? 3 : now))
    }

    /// Encodes one frame into `rpd` (the drawable, or an offscreen texture for the bench).
    func encode(cmd: MTLCommandBuffer, target rpd: MTLRenderPassDescriptor, width: Int, height: Int) {
        var u = uniforms(width: width, height: height)
        ensureBackground(cmd: cmd, width: width, height: height, uniforms: u)

        // Star instances: the static field, then the projects (pulse, focus, extent).
        let now = CACurrentMediaTime()
        var stars = fieldStars
        stars.reserveCapacity(fieldStars.count + scene.stars.count)
        var pulseByStar: [Int: (Double, Double)] = [:]
        for p in engine.activePulses(now: now) {
            if let i = scene.index(forPulse: p) { pulseByStar[i] = (p.intensity(now: now), p.age(now: now)) }
        }
        for (i, s) in scene.stars.enumerated() {
            let (pi, age) = pulseByStar[i] ?? (0, 0)
            let col = Self.starColor(warmth: s.warmth, hollow: s.hollow)
            var ext = max(s.size * 8.0, s.size * 2.6 + 12, s.size * 2.3 + 6)
            if pi > 0 { ext = max(ext, s.size * 1.6 + Float(age) * 24 + 8) }
            let seed = Float((i * 37) % 97) / 97 * 6.28
            stars.append(SkyInstance(a: SIMD4(s.position.x, s.position.y, s.size, 1),
                                     col: SIMD4(col, s.brightness),
                                     b: SIMD4(0.9 + Float(i % 5) * 0.23, seed, Float(pi), Float(age)),
                                     c: SIMD4(s.live ? 1 : 0, s.hollow ? 1 : 0, Float(i), ext)))
        }
        let buf = ringBuffer(count: stars.count)
        if let buf {
            stars.withUnsafeBytes { raw in buf.contents().copyMemory(from: raw.baseAddress!, byteCount: raw.count) }
        }

        guard let bg = background, let enc = cmd.makeRenderCommandEncoder(descriptor: rpd) else { return }
        enc.label = "cielo"
        enc.setRenderPipelineState(copyPipeline)
        enc.setFragmentTexture(bg, index: 0)
        enc.setFragmentBytes(&u, length: MemoryLayout<SkyUniforms>.stride, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)

        if let lb = lineBuffer, lineCount > 0 {
            enc.setRenderPipelineState(linePipeline)
            enc.setVertexBuffer(lb, offset: 0, index: 0)
            enc.setVertexBytes(&u, length: MemoryLayout<SkyUniforms>.stride, index: 1)
            enc.setFragmentBytes(&u, length: MemoryLayout<SkyUniforms>.stride, index: 0)
            enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: lineCount)
        }
        if let buf, !stars.isEmpty {
            enc.setRenderPipelineState(starPipeline)
            enc.setVertexBuffer(buf, offset: 0, index: 0)
            enc.setVertexBytes(&u, length: MemoryLayout<SkyUniforms>.stride, index: 1)
            enc.setFragmentBytes(&u, length: MemoryLayout<SkyUniforms>.stride, index: 0)
            enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: stars.count)
        }
        enc.endEncoding()
    }

    private func ringBuffer(count: Int) -> MTLBuffer? {
        let needed = max(1, count) * MemoryLayout<SkyInstance>.stride
        if ring.count != Self.ringSize || ringCapacity < needed {
            let cap = max(needed, (Self.fieldStarCount + 64) * MemoryLayout<SkyInstance>.stride)
            // Frames in flight keep the old buffers alive: Metal retains what they use.
            ring = (0..<Self.ringSize).compactMap { _ in device.makeBuffer(length: cap, options: .storageModeShared) }
            ringCapacity = cap
        }
        guard ring.count == Self.ringSize else { return nil }
        ringIndex = (ringIndex + 1) % Self.ringSize
        return ring[ringIndex]
    }

    private func ensureBackground(cmd: MTLCommandBuffer, width: Int, height: Int, uniforms: SkyUniforms) {
        if background != nil, backgroundSize == SIMD2(width, height) { return }
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: Self.pixelFormat, width: width, height: height, mipmapped: false)
        d.usage = [.renderTarget, .shaderRead]
        d.storageMode = .private
        guard let tex = device.makeTexture(descriptor: d) else { return }
        let r = MTLRenderPassDescriptor()
        r.colorAttachments[0].texture = tex
        r.colorAttachments[0].loadAction = .dontCare
        r.colorAttachments[0].storeAction = .store
        guard let e = cmd.makeRenderCommandEncoder(descriptor: r) else { return }
        e.label = "cielo, fondo"
        var u = uniforms
        e.setRenderPipelineState(backgroundPipeline)
        e.setFragmentBytes(&u, length: MemoryLayout<SkyUniforms>.stride, index: 0)
        e.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        e.endEncoding()
        background = tex
        backgroundSize = SIMD2(width, height)
    }

    /// Forces the cached background to be redrawn (the bench measures it this way).
    func invalidateBackground() { background = nil }

    // MARK: - Colours and the field

    /// Colour temperature: cool white (little worked) to sodium amber (most worked).
    static func starColor(warmth: Float, hollow: Bool) -> SIMD3<Float> {
        if hollow { return Roque.linear(Roque.tinta) }
        let cool = Roque.linear(0xdfe6ff)
        let mid = Roque.linear(0xffe2b0)
        let warm = Roque.linear(Roque.sodio)
        let w = simd_clamp(warmth, 0, 1)
        return w < 0.5 ? simd_mix(cool, mid, SIMD3(repeating: w * 2)) : simd_mix(mid, warm, SIMD3(repeating: (w - 0.5) * 2))
    }

    /// The faint background field: fixed, deterministic (always the same sky), denser along
    /// the Milky Way, never below the ridge.
    private static func makeFieldStars() -> [SkyInstance] {
        var rng = SkyRandom(seed: 1990)
        var out: [SkyInstance] = []
        out.reserveCapacity(fieldStarCount)
        let calima = Roque.linear(Roque.calima)
        let blue = Roque.linear(0xb8c6ff)
        while out.count < fieldStarCount {
            var x = rng.next(), y = rng.next() * 0.84
            if out.count % 3 == 0 {
                // along the band (same line as the shader, in drawable fractions)
                let t = rng.next() - 0.5
                let spread = (rng.next() - 0.5) * 0.22
                x = 0.52 + t * 0.95
                y = 0.44 - t * 0.95 * 0.45 * 1.6 + spread
            }
            guard x > 0.005, x < 0.995, y > 0.01, y < 1 - SkyGeometry.horizon - 0.07 else { _ = rng.next(); continue }
            let size = 0.45 + rng.next() * 0.65
            let alpha = 0.10 + rng.next() * 0.30
            let tint = rng.next()
            let col = simd_mix(calima, blue, SIMD3(repeating: tint * 0.6))
            out.append(SkyInstance(a: SIMD4(x, y, size, 0), col: SIMD4(col * 0.9, alpha),
                                   b: SIMD4(0.6 + rng.next() * 1.4, rng.next() * 6.28, 0, 0),
                                   c: SIMD4(0, 0, -1, max(size * 3, 1.5))))
        }
        return out
    }

    // MARK: - Offscreen (bench)

    /// Renders `frames` frames offscreen at `width` x `height` px. Returns CPU encoding
    /// time per frame (µs), GPU time per frame (ms, mean and median), and the cost of
    /// the cached background (ms GPU), or nil if Metal refused.
    func bench(width: Int, height: Int, frames: Int) -> [String: Any]? {
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: Self.pixelFormat, width: width, height: height, mipmapped: false)
        d.usage = [.renderTarget, .shaderRead]
        d.storageMode = .private
        guard let target = device.makeTexture(descriptor: d) else { return nil }
        func pass() -> MTLRenderPassDescriptor {
            let r = MTLRenderPassDescriptor()
            r.colorAttachments[0].texture = target
            r.colorAttachments[0].loadAction = .dontCare
            r.colorAttachments[0].storeAction = .store
            return r
        }
        // The background alone, once (what a resize costs).
        invalidateBackground()
        guard let c0 = queue.makeCommandBuffer() else { return nil }
        ensureBackground(cmd: c0, width: width, height: height, uniforms: uniforms(width: width, height: height))
        c0.commit()
        c0.waitUntilCompleted()
        let bgMs = (c0.gpuEndTime - c0.gpuStartTime) * 1000

        var gpu: [Double] = []
        var cpuNs: UInt64 = 0
        for _ in 0..<frames {
            guard let cmd = queue.makeCommandBuffer() else { return nil }
            let t0 = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
            encode(cmd: cmd, target: pass(), width: width, height: height)
            cpuNs += clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - t0
            cmd.commit()
            cmd.waitUntilCompleted()
            if cmd.status == .error { return nil }
            let g = cmd.gpuEndTime - cmd.gpuStartTime
            if g > 0 { gpu.append(g * 1000) }
        }
        gpu.sort()
        let mean = gpu.isEmpty ? 0 : gpu.reduce(0, +) / Double(gpu.count)
        let median = gpu.isEmpty ? 0 : gpu[gpu.count / 2]
        func r3(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }
        return ["pixels": "\(width)x\(height)", "frames": frames,
                "stars": scene.stars.count, "fieldStars": fieldStars.count, "lines": lineCount,
                "cpuMicrosPerFrame": (Double(cpuNs) / Double(max(1, frames)) / 1000 * 10).rounded() / 10,
                "gpuMsPerFrame": r3(mean), "gpuMsPerFrameMedian": r3(median),
                "backgroundGpuMs": r3(bgMs)]
    }
}

// MARK: - The view

/// MTKView for the sky: renders only while visible, at the engine's rhythm, reports the
/// star under the pointer and clicks.
final class SkyMTKView: MTKView {
    var renderer: SkyRenderer?
    var onHover: ((Int?) -> Void)?
    var onSelect: ((Int?) -> Void)?
    var onOrbit: ((Float, Float) -> Void)?
    var onZoom: ((Float) -> Void)?
    var isMounted = true
    var pendingScene = SkyScene()
    var pendingSelection: Int?
    var camera = SkyCamera()
    private var dragOrigin: CGPoint?
    private var dragLast: CGPoint?
    private var dragged = false
    private var interactionUntil: CFTimeInterval = 0
    private var settleTask: Task<Void, Never>?
    private var entranceTask: Task<Void, Never>?

    /// Room taken by the glass panels, in points (the stars stay out of it).
    var fieldInsets = NSEdgeInsets(top: 70, left: 360, bottom: 0, right: 360) {
        didSet { updateField(); redrawIfStill() }
    }
    /// Render scale: soft light does not need the full Retina 2x.
    static let maxScale: CGFloat = 1.5

    private var tracking: NSTrackingArea?
    private var observers: [NSObjectProtocol] = []
    private var hoverIndex: Int?

    init(frame: CGRect) {
        super.init(frame: frame, device: MetalEngine.shared.device)
        colorPixelFormat = SkyRenderer.pixelFormat
        clearColor = MTLClearColor(red: 0.02, green: 0.03, blue: 0.06, alpha: 1)
        framebufferOnly = true
        autoResizeDrawable = false
        enableSetNeedsDisplay = false
        isPaused = true
        layer?.isOpaque = true
        if let ml = layer as? CAMetalLayer {
            ml.wantsExtendedDynamicRangeContent = true
            ml.colorspace = CGColorSpace(name: CGColorSpace.extendedLinearDisplayP3)
            ml.isOpaque = true
        }
    }

    required init(coder: NSCoder) { fatalError("init(coder:) non usato") }

    deinit {
        for o in observers { NotificationCenter.default.removeObserver(o) }
        settleTask?.cancel()
        entranceTask?.cancel()
    }

    func attach(_ r: SkyRenderer) {
        renderer = r
        r.setScene(pendingScene)
        r.selected = pendingSelection
        r.camera = camera
        delegate = r
        updateDrawableSize()
        updateRhythm()
        entranceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2.9))
            guard !Task.isCancelled else { return }
            self?.updateRhythm()
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers.removeAll()
        guard let w = window else { isPaused = true; return }
        let nc = NotificationCenter.default
        for name in [NSWindow.didBecomeKeyNotification, NSWindow.didExposeNotification,
                     NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification,
                     NSWindow.didDeminiaturizeNotification, NSWindow.didChangeScreenNotification,
                     NSWindow.didChangeBackingPropertiesNotification] {
            observers.append(nc.addObserver(forName: name, object: w, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.updateDrawableSize()
                    self?.updateRhythm()
                }
            })
        }
        observers.append(nc.addObserver(forName: MetalEngine.didChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.updateRhythm()
                self?.redrawIfStill()
            }
        })
        observers.append(nc.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.updateDrawableSize() }
        })
        updateDrawableSize()
        updateRhythm()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateDrawableSize()
        redrawIfStill()
    }

    private var visibleOnScreen: Bool {
        guard let w = window, renderer != nil else { return false }
        return w.isVisible && !w.isMiniaturized && w.occlusionState.contains(.visible)
    }

    /// Pause, fps and on-demand mode from the engine.
    func updateRhythm() {
        let engine = MetalEngine.shared
        let visible = visibleOnScreen
        let lively = (renderer?.isLively ?? false) || hoverIndex != nil
        let interacting = CACurrentMediaTime() < interactionUntil || (renderer?.isEntering ?? false)
        let fps = visible && !engine.reduceMotion && interacting
            ? (ProcessInfo.processInfo.isLowPowerModeEnabled ? 30 : 60)
            : engine.fps(for: .sky, visible: visible, lively: lively)
        let onDemand = engine.onDemand(for: .sky, visible: visible, lively: lively)
        engine.noteRhythm(.sky, fps: fps, visible: visible)
        if fps > 0 {
            enableSetNeedsDisplay = false
            preferredFramesPerSecond = fps
            isPaused = false
        } else {
            isPaused = true
            enableSetNeedsDisplay = onDemand
            if onDemand { needsDisplay = true }
        }
        renderer?.headroom = Float(window?.screen?.maximumExtendedDynamicRangeColorComponentValue ?? 1)
    }

    /// One frame when the picture changed but nothing animates (Reduce motion).
    func redrawIfStill() {
        guard renderer != nil, isPaused, visibleOnScreen else { return }
        enableSetNeedsDisplay = true
        needsDisplay = true
    }

    private func updateDrawableSize() {
        let scale = min(window?.backingScaleFactor ?? 2, Self.maxScale)
        let size = CGSize(width: max(1, bounds.width * scale), height: max(1, bounds.height * scale))
        if drawableSize != size { drawableSize = size }
        renderer?.pixelsPerPoint = Float(scale)
        updateField()
    }

    private func updateField() {
        let f = SkyGeometry.fieldRect(size: bounds.size, insets: fieldInsets)
        let w = max(1, bounds.width), h = max(1, bounds.height)
        renderer?.fieldRect = SIMD4(Float(f.minX / w), Float(f.minY / h), Float(f.width / w), Float(f.height / h))
    }

    // MARK: Pointer

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = tracking { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                               owner: self, userInfo: nil)
        addTrackingArea(t)
        tracking = t
    }

    private func starIndex(at event: NSEvent) -> Int? {
        guard let r = renderer else { return nil }
        var p = convert(event.locationInWindow, from: nil)
        p.y = bounds.height - p.y   // the field rect is measured from the top
        return SkyGeometry.pick(p, scene: r.currentScene, field: SkyGeometry.fieldRect(size: bounds.size, insets: fieldInsets))
    }

    override func mouseMoved(with event: NSEvent) {
        let i = starIndex(at: event)
        guard i != hoverIndex else { return }
        hoverIndex = i
        renderer?.hovered = i
        onHover?(i)
        updateRhythm()
        redrawIfStill()
        if i != nil { NSCursor.pointingHand.set() } else { NSCursor.arrow.set() }
    }

    override func mouseExited(with event: NSEvent) {
        guard hoverIndex != nil else { return }
        hoverIndex = nil
        renderer?.hovered = nil
        onHover?(nil)
        NSCursor.arrow.set()
        updateRhythm()
        redrawIfStill()
    }

    override func mouseDown(with event: NSEvent) {
        dragOrigin = event.locationInWindow
        dragLast = event.locationInWindow
        dragged = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = dragOrigin else { return }
        if hypot(event.locationInWindow.x - start.x, event.locationInWindow.y - start.y) > 3 { dragged = true }
        guard dragged else { return }
        NSCursor.closedHand.set()
        let current = event.locationInWindow
        let previous = dragLast ?? start
        onOrbit?(Float(current.x - previous.x), Float(previous.y - current.y))
        dragLast = current
        boostInteraction()
    }

    override func mouseUp(with event: NSEvent) {
        if !dragged { onSelect?(starIndex(at: event)) }
        dragOrigin = nil
        dragLast = nil
        dragged = false
        NSCursor.openHand.set()
    }

    override func scrollWheel(with event: NSEvent) {
        onZoom?(Float(event.scrollingDeltaY) * (event.hasPreciseScrollingDeltas ? 0.003 : 0.025))
        boostInteraction()
    }

    override func magnify(with event: NSEvent) {
        onZoom?(Float(event.magnification))
        boostInteraction()
    }

    private func boostInteraction() {
        interactionUntil = CACurrentMediaTime() + 0.3
        updateRhythm()
        settleTask?.cancel()
        settleTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            self?.updateRhythm()
        }
    }

    override var isOpaque: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var acceptsFirstResponder: Bool { false }
}

/// SwiftUI wrapper. The renderer is built once the shader library is loaded (off main the
/// first time, in case it has to be compiled at runtime). No view, no Metal objects.
struct SkyView: NSViewRepresentable {
    var scene: SkyScene
    var selected: Int?
    var insets: NSEdgeInsets
    var camera: SkyCamera = SkyCamera()
    var onOrbit: (Float, Float) -> Void = { _, _ in }
    var onZoom: (Float) -> Void = { _ in }
    var onHover: (Int?) -> Void
    var onSelect: (Int?) -> Void

    func makeNSView(context: Context) -> SkyMTKView {
        let v = SkyMTKView(frame: .zero)
        v.fieldInsets = insets
        v.onHover = onHover
        v.onSelect = onSelect
        v.pendingScene = scene
        v.pendingSelection = selected
        v.camera = camera
        v.onOrbit = onOrbit
        v.onZoom = onZoom
        Task.detached(priority: .userInitiated) {
            _ = MetalEngine.shared.library
            await MainActor.run {
                guard v.isMounted, v.renderer == nil else { return }
                guard let r = SkyRenderer() else {
                    Log.error("Il cielo non riesce a preparare la sua pipeline Metal.")
                    return
                }
                v.attach(r)
            }
        }
        return v
    }

    func updateNSView(_ v: SkyMTKView, context: Context) {
        v.onHover = onHover
        v.onSelect = onSelect
        v.onOrbit = onOrbit
        v.onZoom = onZoom
        v.pendingScene = scene
        v.pendingSelection = selected
        v.camera = camera
        let ins = v.fieldInsets
        if ins.top != insets.top || ins.left != insets.left || ins.right != insets.right || ins.bottom != insets.bottom {
            v.fieldInsets = insets
        }
        guard let r = v.renderer else { return }
        let changed = r.currentScene != scene || r.selected != selected || r.camera != camera
        r.setScene(scene)
        r.selected = selected
        r.camera = camera
        v.updateRhythm()
        if changed { v.redrawIfStill() }
    }

    static func dismantleNSView(_ v: SkyMTKView, coordinator: ()) {
        v.isMounted = false
        v.isPaused = true
        v.delegate = nil
        v.renderer = nil
        MetalEngine.shared.noteRhythm(.sky, fps: 0, visible: false)
    }
}
