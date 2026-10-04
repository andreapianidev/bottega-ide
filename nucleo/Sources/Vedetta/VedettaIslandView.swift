// Vedetta: an island made of projects. The map is Metal; controls and labels belong
// to the parent SwiftUI view. Positions are normalized in this view, origin top-left.

import AppKit
import MetalKit
import QuartzCore
import SwiftUI
import simd

enum VedettaIslandLevel: Equatable {
    case red, yellow, green, unknown
}

struct VedettaIslandPoint: Equatable {
    var key: String
    var name: String
    var level: VedettaIslandLevel
    var position: SIMD2<Float>
}

private struct IslandUniforms {
    var view: SIMD4<Float>     // pixel width, height, elapsed seconds, reduce motion
    var ocean: SIMD4<Float>
    var basalt: SIMD4<Float>
    var shore: SIMD4<Float>
    var contour: SIMD4<Float>
    var capes: SIMD4<Float> // two project-derived directions
}

private struct IslandBeacon {
    var position: SIMD4<Float> // x, y, diameter in px, selected/hovered strength
    var color: SIMD4<Float>    // linear P3, activity pulse
}

final class VedettaIslandRenderer: NSObject, MTKViewDelegate {
    static let pixelFormat: MTLPixelFormat = .rgba16Float

    private let engine: MetalEngine
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private let terrainPipeline: MTLRenderPipelineState
    private let beaconPipeline: MTLRenderPipelineState
    private let started = CACurrentMediaTime()

    var points: [VedettaIslandPoint] = [] {
        didSet { if points != oldValue { updateCapes() } }
    }
    var selected: String?
    var hovered: String?
    private var capes = SIMD4<Float>(-0.8, -0.6, 0.8, 0.6)

    private func updateCapes() {
        let center = SIMD2<Float>(0.5, 0.5)
        func direction(upper: Bool, fallback: SIMD2<Float>) -> SIMD2<Float> {
            guard let point = points.filter({ ($0.position.y < 0.5) == upper })
                .max(by: { simd_length_squared($0.position - center) < simd_length_squared($1.position - center) }) else { return fallback }
            let delta = point.position - center
            return simd_length_squared(delta) > 0.0001 ? simd_normalize(delta) : fallback
        }
        let a = direction(upper: true, fallback: SIMD2(-0.8, -0.6))
        let b = direction(upper: false, fallback: SIMD2(0.8, 0.6))
        capes = SIMD4(a.x, a.y, b.x, b.y)
    }

    init?(engine: MetalEngine = .shared) {
        guard let device = engine.device, let queue = engine.queue,
              let fullscreen = engine.makeFunction("vedetta_island_vertex"),
              let terrain = engine.makeFunction("vedetta_island_fragment"),
              let beaconV = engine.makeFunction("vedetta_beacon_vertex"),
              let beaconF = engine.makeFunction("vedetta_beacon_fragment") else { return nil }
        func pipeline(_ vertex: MTLFunction, _ fragment: MTLFunction, blend: Bool) -> MTLRenderPipelineState? {
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = vertex
            d.fragmentFunction = fragment
            d.colorAttachments[0].pixelFormat = Self.pixelFormat
            if blend {
                let a = d.colorAttachments[0]!
                a.isBlendingEnabled = true
                a.rgbBlendOperation = .add
                a.alphaBlendOperation = .add
                a.sourceRGBBlendFactor = .one
                a.sourceAlphaBlendFactor = .one
                a.destinationRGBBlendFactor = .oneMinusSourceAlpha
                a.destinationAlphaBlendFactor = .oneMinusSourceAlpha
            }
            return try? device.makeRenderPipelineState(descriptor: d)
        }
        guard let terrainPipeline = pipeline(fullscreen, terrain, blend: false),
              let beaconPipeline = pipeline(beaconV, beaconF, blend: true) else { return nil }
        self.engine = engine
        self.device = device
        self.queue = queue
        self.terrainPipeline = terrainPipeline
        self.beaconPipeline = beaconPipeline
        super.init()
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        guard view.drawableSize.width > 0, view.drawableSize.height > 0,
              let pass = view.currentRenderPassDescriptor,
              let drawable = view.currentDrawable,
              let command = queue.makeCommandBuffer() else { return }
        let token = engine.beginFrame(.vedetta)
        let width = Float(view.drawableSize.width)
        let height = Float(view.drawableSize.height)
        var uniforms = IslandUniforms(
            view: SIMD4(width, height, engine.reduceMotion ? 0 : Float(CACurrentMediaTime() - started), engine.reduceMotion ? 1 : 0),
            ocean: SIMD4(Roque.linear(Roque.zenit), 1),
            basalt: SIMD4(Roque.linear(Roque.basalto), 1),
            shore: SIMD4(Roque.linear(Roque.sodio), 1),
            contour: SIMD4(Roque.linear(Roque.tinta), 1),
            capes: capes
        )
        guard let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.label = "vedetta, isola e fari"
        encoder.setRenderPipelineState(terrainPipeline)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<IslandUniforms>.stride, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)

        let scale = Float(view.drawableSize.width / max(1, view.bounds.width))
        let pulses = engine.pulseIntensities()
        let beacons: [IslandBeacon] = points.map { p in
            let hex: Int
            switch p.level {
            case .red: hex = Roque.brace
            case .yellow: hex = Roque.sodio
            case .green: hex = Roque.laurisilva
            case .unknown: hex = Roque.focus
            }
            let focus: Float = p.key == selected ? 1 : (p.key == hovered ? 0.55 : 0)
            let position = simd_clamp(p.position, SIMD2<Float>(repeating: 0), SIMD2<Float>(repeating: 1))
            return IslandBeacon(
                position: SIMD4(position.x, position.y, (focus > 0 ? 42 : 32) * scale, focus),
                color: SIMD4(Roque.linear(hex), Float(pulses[p.key] ?? 0))
            )
        }
        if !beacons.isEmpty {
            encoder.setRenderPipelineState(beaconPipeline)
            beacons.withUnsafeBytes { bytes in
                guard let address = bytes.baseAddress else { return }
                if bytes.count <= 4096 {
                    encoder.setVertexBytes(address, length: bytes.count, index: 0)
                } else if let buffer = device.makeBuffer(bytes: address, length: bytes.count, options: .storageModeShared) {
                    encoder.setVertexBuffer(buffer, offset: 0, index: 0)
                }
            }
            encoder.setVertexBytes(&uniforms, length: MemoryLayout<IslandUniforms>.stride, index: 1)
            encoder.setFragmentBytes(&uniforms, length: MemoryLayout<IslandUniforms>.stride, index: 0)
            encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: beacons.count)
        }
        encoder.endEncoding()
        command.present(drawable)
        engine.endFrame(token, commandBuffer: command)
        command.commit()
    }
}

final class VedettaIslandMTKView: MTKView {
    var renderer: VedettaIslandRenderer?
    var pendingPoints: [VedettaIslandPoint] = []
    var pendingSelected: String?
    var onHover: ((String?) -> Void)?
    var onSelect: ((String) -> Void)?

    private var trackingAreaRef: NSTrackingArea?
    private var observers: [NSObjectProtocol] = []
    private var hoveredKey: String?

    init(frame: CGRect) {
        super.init(frame: frame, device: MetalEngine.shared.device)
        colorPixelFormat = VedettaIslandRenderer.pixelFormat
        clearColor = MTLClearColor(red: 0.02, green: 0.03, blue: 0.06, alpha: 1)
        framebufferOnly = true
        autoResizeDrawable = false
        isPaused = true
        layer?.isOpaque = true
        if let metalLayer = layer as? CAMetalLayer {
            metalLayer.wantsExtendedDynamicRangeContent = true
            metalLayer.colorspace = CGColorSpace(name: CGColorSpace.extendedLinearDisplayP3)
            metalLayer.isOpaque = true
        }
    }

    required init(coder: NSCoder) { fatalError("init(coder:) non usato") }

    deinit { observers.forEach { NotificationCenter.default.removeObserver($0) } }

    func attach(_ renderer: VedettaIslandRenderer) {
        self.renderer = renderer
        delegate = renderer
        updateDrawableSize()
        updateRhythm()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        guard let window else {
            isPaused = true
            MetalEngine.shared.noteRhythm(.vedetta, fps: 0, visible: false)
            return
        }
        let center = NotificationCenter.default
        for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification,
                     NSWindow.didDeminiaturizeNotification, NSWindow.didChangeScreenNotification,
                     NSWindow.didChangeBackingPropertiesNotification] {
            observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.updateDrawableSize()
                    self?.updateRhythm()
                }
            })
        }
        observers.append(center.addObserver(forName: MetalEngine.didChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.updateRhythm()
                self?.redrawIfStill()
            }
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
        guard let window, renderer != nil else { return false }
        return window.isVisible && !window.isMiniaturized && window.occlusionState.contains(.visible)
    }

    func updateRhythm() {
        let visible = visibleOnScreen
        let engine = MetalEngine.shared
        let fps = engine.fps(for: .vedetta, visible: visible, lively: hoveredKey != nil)
        let onDemand = engine.onDemand(for: .vedetta, visible: visible, lively: hoveredKey != nil)
        engine.noteRhythm(.vedetta, fps: fps, visible: visible)
        if fps > 0 {
            enableSetNeedsDisplay = false
            preferredFramesPerSecond = fps
            isPaused = false
        } else {
            isPaused = true
            enableSetNeedsDisplay = onDemand
            if onDemand { needsDisplay = true }
        }
    }

    func redrawIfStill() {
        guard renderer != nil, isPaused, visibleOnScreen else { return }
        enableSetNeedsDisplay = true
        needsDisplay = true
    }

    private func updateDrawableSize() {
        let scale = min(window?.backingScaleFactor ?? 2, 1.5)
        let size = CGSize(width: max(1, bounds.width * scale), height: max(1, bounds.height * scale))
        if drawableSize != size { drawableSize = size }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingAreaRef { removeTrackingArea(trackingAreaRef) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingAreaRef = area
    }

    private func pickedKey(_ event: NSEvent) -> String? {
        guard let renderer, bounds.width > 0, bounds.height > 0 else { return nil }
        let local = convert(event.locationInWindow, from: nil)
        let nx = Float(local.x / bounds.width)
        let ny = Float(1 - local.y / bounds.height)
        var bestKey: String?
        var bestDistance: Float = .infinity
        for point in renderer.points {
            let dx = (nx - point.position.x) * Float(bounds.width)
            let dy = (ny - point.position.y) * Float(bounds.height)
            let distance = hypotf(dx, dy)
            if distance < 21, distance < bestDistance {
                bestKey = point.key
                bestDistance = distance
            }
        }
        return bestKey
    }

    override func mouseMoved(with event: NSEvent) {
        let key = pickedKey(event)
        guard key != hoveredKey else { return }
        hoveredKey = key
        renderer?.hovered = key
        onHover?(key)
        updateRhythm()
        redrawIfStill()
        if key != nil { NSCursor.pointingHand.set() } else { NSCursor.arrow.set() }
    }

    override func mouseExited(with event: NSEvent) {
        guard hoveredKey != nil else { return }
        hoveredKey = nil
        renderer?.hovered = nil
        onHover?(nil)
        updateRhythm()
        redrawIfStill()
        NSCursor.arrow.set()
    }

    override func mouseUp(with event: NSEvent) {
        if let key = pickedKey(event) { onSelect?(key) }
    }

    override var acceptsFirstResponder: Bool { false }
}

struct VedettaIslandView: NSViewRepresentable {
    var points: [VedettaIslandPoint]
    var selected: String?
    var onHover: (String?) -> Void
    var onSelect: (String) -> Void

    func makeNSView(context: Context) -> VedettaIslandMTKView {
        let view = VedettaIslandMTKView(frame: .zero)
        view.onHover = onHover
        view.onSelect = onSelect
        view.pendingPoints = points
        view.pendingSelected = selected
        Task.detached(priority: .userInitiated) {
            _ = MetalEngine.shared.library
            await MainActor.run {
                guard view.renderer == nil else { return }
                guard let renderer = VedettaIslandRenderer() else {
                    Log.error("Vedetta non riesce a preparare la pipeline Metal.")
                    return
                }
                renderer.points = view.pendingPoints
                renderer.selected = view.pendingSelected
                view.attach(renderer)
            }
        }
        return view
    }

    func updateNSView(_ view: VedettaIslandMTKView, context: Context) {
        view.onHover = onHover
        view.onSelect = onSelect
        view.pendingPoints = points
        view.pendingSelected = selected
        guard let renderer = view.renderer else { return }
        let changed = renderer.points != points || renderer.selected != selected
        renderer.points = points
        renderer.selected = selected
        if changed { view.redrawIfStill() }
    }

    static func dismantleNSView(_ view: VedettaIslandMTKView, coordinator: ()) {
        view.isPaused = true
        view.delegate = nil
        view.renderer = nil
        MetalEngine.shared.noteRhythm(.vedetta, fps: 0, visible: false)
    }
}
