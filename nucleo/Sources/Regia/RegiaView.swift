import AppKit
import MetalKit
import Observation
import SwiftUI
import simd

private enum RegiaInk {
    static func color(_ hex: Int) -> Color {
        Color(.sRGB, red: Double((hex >> 16) & 255) / 255,
              green: Double((hex >> 8) & 255) / 255,
              blue: Double(hex & 255) / 255, opacity: 1)
    }
    static let text = color(Roque.calima)
    static let muted = color(Roque.tinta)
    static let line = color(Roque.linea)
    static let waiting = color(Roque.sodio)
    static let errors = color(Roque.brace)
    static let running = color(Roque.laurisilva)
    static let queued = color(Roque.stella)
}

struct RegiaView: View {
    @Bindable var model: RegiaModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                header
                summary
                chart
            }
            .padding(.horizontal, 38)
            .padding(.top, 50)
            .padding(.bottom, 38)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(RegiaInk.color(Roque.zenit))
        .foregroundStyle(RegiaInk.text)
        .environment(\.colorScheme, .dark)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 11) {
            Text("Regia")
                .font(.system(size: 54, weight: .regular, design: .serif))
                .tracking(-2)
            Text("Dove serve attenzione, progetto per progetto")
                .font(.system(size: 15))
                .foregroundStyle(RegiaInk.muted)
            Rectangle().fill(RegiaInk.line).frame(height: 1).padding(.top, 10)
        }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Il punto della situazione")
                    .font(.system(size: 26, weight: .regular, design: .serif))
                Spacer()
                if !model.data.engine.isEmpty {
                    Text(model.data.engine == "apple" ? "Apple Intelligence" : "Agnes")
                        .font(.system(size: 12))
                        .foregroundStyle(RegiaInk.muted)
                }
            }
            Text(model.data.summary.isEmpty ? "Il riepilogo arriva dalla Regia della Bottega." : model.data.summary)
                .font(.system(size: 16))
                .lineSpacing(5)
                .foregroundStyle(model.data.summary.isEmpty ? RegiaInk.muted : RegiaInk.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 880, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var chart: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text("Carico dei progetti")
                    .font(.system(size: 26, weight: .regular, design: .serif))
                Spacer()
                Text("\(model.data.projects.count) progetti attivi")
                    .font(.system(size: 13))
                    .foregroundStyle(RegiaInk.muted)
            }
            HStack(spacing: 22) {
                legend("Ti aspetta", color: RegiaInk.waiting)
                legend("Errore", color: RegiaInk.errors)
                legend("In corso", color: RegiaInk.running)
                legend("In coda", color: RegiaInk.queued)
            }
            .font(.system(size: 12))
            .padding(.bottom, 5)
            if model.data.projects.isEmpty {
                Text("Nessun agente richiede attenzione adesso.")
                    .font(.system(size: 17, design: .serif))
                    .foregroundStyle(RegiaInk.muted)
                    .padding(.vertical, 35)
            } else {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(model.data.projects) { p in
                            Text(p.name)
                                .font(.system(size: 13, weight: .medium))
                                .lineLimit(1)
                                .help(p.name)
                                .frame(height: 43)
                        }
                    }
                    .frame(width: 185, alignment: .leading)
                    RegiaMetalChart(projects: model.data.projects)
                        .frame(maxWidth: .infinity)
                        .frame(height: CGFloat(model.data.projects.count * 43))
                        .accessibilityLabel("Grafico Metal del carico per progetto")
                    VStack(alignment: .trailing, spacing: 0) {
                        ForEach(model.data.projects) { p in
                            Text("\(p.total)")
                                .font(.system(size: 13, weight: .semibold, design: .rounded))
                                .monospacedDigit()
                                .foregroundStyle(RegiaInk.muted)
                                .frame(height: 43)
                        }
                    }
                    .frame(width: 26)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.top, 12)
        .overlay(alignment: .top) { Rectangle().fill(RegiaInk.line).frame(height: 1) }
    }

    private func legend(_ title: String, color: Color) -> some View {
        HStack(spacing: 7) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(title).foregroundStyle(RegiaInk.muted)
        }
    }
}

private final class RegiaChartRenderer: NSObject, MTKViewDelegate {
    private let engine: MetalEngine
    private let pipeline: MTLRenderPipelineState
    private let queue: MTLCommandQueue
    private var buffer: MTLBuffer?
    private var rowCount: Float = 0
    private var maxValue: Float = 1

    init?(metalEngine: MetalEngine = .shared) {
        guard let device = metalEngine.device, let queue = metalEngine.queue,
              let vertex = metalEngine.makeFunction("regia_chart_vertex"),
              let fragment = metalEngine.makeFunction("regia_chart_fragment") else { return nil }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = vertex
        descriptor.fragmentFunction = fragment
        descriptor.colorAttachments[0].pixelFormat = .rgba16Float
        guard let pipeline = try? device.makeRenderPipelineState(descriptor: descriptor) else { return nil }
        self.engine = metalEngine
        self.pipeline = pipeline
        self.queue = queue
        super.init()
    }

    func setProjects(_ projects: [RegiaProject]) {
        guard let device = engine.device else { return }
        var rows = projects.prefix(14).map { p in
            SIMD4<Float>(Float(p.waiting), Float(p.errors), Float(p.running), Float(p.queued))
        }
        rowCount = Float(rows.count)
        maxValue = Float(max(1, projects.map(\.total).max() ?? 1))
        while rows.count < 14 { rows.append(.zero) }
        buffer = rows.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return nil }
            return device.makeBuffer(bytes: base, length: bytes.count, options: .storageModeShared)
        }
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        guard rowCount > 0, let buffer, let pass = view.currentRenderPassDescriptor,
              let drawable = view.currentDrawable, let command = queue.makeCommandBuffer(),
              let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { return }
        let token = engine.beginFrame(.regia)
        var info = SIMD4<Float>(rowCount, maxValue, Float(view.drawableSize.width), Float(view.drawableSize.height))
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentBuffer(buffer, offset: 0, index: 0)
        encoder.setFragmentBytes(&info, length: MemoryLayout<SIMD4<Float>>.stride, index: 1)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
        command.present(drawable)
        engine.endFrame(token, commandBuffer: command)
        command.commit()
    }
}

private final class RegiaMTKView: MTKView {
    var chartRenderer: RegiaChartRenderer?
    private var observations: [NSObjectProtocol] = []

    init() {
        super.init(frame: .zero, device: MetalEngine.shared.device)
        colorPixelFormat = .rgba16Float
        clearColor = MTLClearColor(red: 0.018, green: 0.031, blue: 0.055, alpha: 1)
        framebufferOnly = true
        isPaused = true
        enableSetNeedsDisplay = true
        if let layer = layer as? CAMetalLayer {
            layer.wantsExtendedDynamicRangeContent = true
            layer.colorspace = CGColorSpace(name: CGColorSpace.extendedLinearDisplayP3)
        }
    }

    required init(coder: NSCoder) { fatalError("init(coder:) non usato") }
    deinit { observations.forEach { NotificationCenter.default.removeObserver($0) } }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observations.forEach { NotificationCenter.default.removeObserver($0) }
        observations.removeAll()
        guard let window else { MetalEngine.shared.noteRhythm(.regia, fps: 0, visible: false); return }
        for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didDeminiaturizeNotification,
                     NSWindow.didChangeBackingPropertiesNotification] {
            observations.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                self?.refresh()
            })
        }
        refresh()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        refresh()
    }

    func refresh() {
        let scale = min(window?.backingScaleFactor ?? 2, 1.5)
        drawableSize = CGSize(width: max(1, bounds.width * scale), height: max(1, bounds.height * scale))
        let visible = window?.isVisible == true && window?.isMiniaturized == false && window?.occlusionState.contains(.visible) == true
        MetalEngine.shared.noteRhythm(.regia, fps: 0, visible: visible)
        if visible { needsDisplay = true }
    }
}

private struct RegiaMetalChart: NSViewRepresentable {
    let projects: [RegiaProject]
    func makeNSView(context: Context) -> RegiaMTKView {
        let view = RegiaMTKView()
        let renderer = RegiaChartRenderer()
        view.chartRenderer = renderer
        view.delegate = renderer
        renderer?.setProjects(projects)
        return view
    }
    func updateNSView(_ view: RegiaMTKView, context: Context) {
        view.chartRenderer?.setProjects(projects)
        view.refresh()
    }
}
