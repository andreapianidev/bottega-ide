//
//  IsolaPanel.swift
//  Bottega Nucleo
//
//  The island: Melissa grows out of the MacBook notch like the iPhone Dynamic Island.
//
//  The panel is a fixed transparent window hung from the top of the screen, centred on the
//  notch; SwiftUI draws the island inside it, so every change of size is a spring of the
//  shape itself and never a window resize. The shape is the notch's own: flush with the top
//  edge, two small concave shoulders where it meets the menu bar, round lower corners.
//
//   - closed: exactly the notch (black on black), then the panel goes away;
//   - compact: the notch with two ears, the sphere on the left and the state on the right
//     (live waveform from the microphone, a turning ring while thinking, the voice's
//     waveform while speaking, a check when done);
//   - open: wider and taller, with the state in small capitals and the text (the live
//     transcript, the sentence Melissa says) in two or three lines.
//
//  Under the island a soft aura in the state's colours breathes with the voice. On a screen
//  without a notch the island hangs from the middle of the menu bar, same shape.
//  A click goes to Isola. The sphere is the orb's renderer in docked mode, at 60 fps only
//  while the island is on screen.
//

import AppKit
import MetalKit
import Observation
import SwiftUI

@MainActor
@Observable
final class IsolaModello {
    var fase: IsolaPanel.Fase = .riposo
    var testo = ""
    var aperta = false
    var tacca = CGSize(width: 190, height: 32)
    var haTacca = true
    var onClick: (() -> Void)?
}

/// NSHostingView that takes the first click: the panel never becomes key.
final class IsolaHosting<V: View>: NSHostingView<V> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
final class IsolaPanel {
    static let shared = IsolaPanel()

    enum Fase: Equatable { case riposo, ascolto, pensa, parla, pronto, errore }

    var fase: Fase { modello.fase }
    var onClick: (() -> Void)? {
        get { modello.onClick }
        set { modello.onClick = newValue }
    }

    /// Room for the widest island plus its aura.
    private static let panelWidth: CGFloat = 640
    private static let panelExtraHeight: CGFloat = 200

    private let modello = IsolaModello()
    private var panel: NSPanel?
    private var orbView: OrbMTKView?
    private var renderer: OrbRenderer?
    private var nascondi: DispatchWorkItem?
    private var ritiro: DispatchWorkItem?

    // MARK: - Public

    func mostra(_ f: Fase, testo nuovo: String) {
        nascondi?.cancel(); nascondi = nil
        ritiro?.cancel(); ritiro = nil
        if panel == nil { costruisci() }
        guard let panel else { return }
        renderer?.state = Self.statoSfera(f)
        orbView?.isPaused = false
        let testo = nuovo.trimmingCharacters(in: .whitespacesAndNewlines)
        if !panel.isVisible || !modello.aperta {
            // From the notch: the first frame is the closed island, then the spring opens it.
            colloca(panel)
            modello.aperta = false
            modello.fase = f
            modello.testo = testo
            panel.alphaValue = 1
            panel.orderFrontRegardless()
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    withAnimation(IsolaVista.molla) { IsolaPanel.shared.modello.aperta = true }
                }
            }
            return
        }
        withAnimation(IsolaVista.molla) {
            modello.fase = f
            modello.testo = testo
        }
    }

    func riposa(dopo secondi: Double) {
        nascondi?.cancel()
        let work = DispatchWorkItem { MainActor.assumeIsolated { IsolaPanel.shared.chiudi() } }
        nascondi = work
        DispatchQueue.main.asyncAfter(deadline: .now() + secondi, execute: work)
    }

    // MARK: - Panel

    private func costruisci() {
        let p = NSPanel(contentRect: NSRect(x: -3000, y: -3000, width: Self.panelWidth, height: 260),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        // Above the menu bar, so the island sits on the notch.
        p.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) + 2)
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.isReleasedWhenClosed = false
        p.hidesOnDeactivate = false
        p.animationBehavior = .none
        p.title = "Melissa"
        costruisciSfera()
        let vista = IsolaVista(m: modello, sfera: orbView)
        let host = IsolaHosting(rootView: vista)
        host.sizingOptions = []
        host.layer?.backgroundColor = .clear
        p.contentView = host
        panel = p
    }

    /// Hangs the panel from the top of the screen, centred on the notch (or the menu bar).
    private func colloca(_ p: NSPanel) {
        let screen = NSScreen.main ?? NSScreen.screens.first!
        let f = screen.frame
        if screen.safeAreaInsets.top > 0,
           let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            modello.haTacca = true
            modello.tacca = CGSize(width: right.minX - left.maxX, height: screen.safeAreaInsets.top)
            let mid = (left.maxX + right.minX) / 2
            let h = modello.tacca.height + Self.panelExtraHeight
            p.setFrame(NSRect(x: mid - Self.panelWidth / 2, y: f.maxY - h, width: Self.panelWidth, height: h), display: false)
        } else {
            modello.haTacca = false
            let bar = max(24, f.maxY - screen.visibleFrame.maxY)
            modello.tacca = CGSize(width: 190, height: bar)
            let h = bar + Self.panelExtraHeight
            p.setFrame(NSRect(x: f.midX - Self.panelWidth / 2, y: f.maxY - h, width: Self.panelWidth, height: h), display: false)
        }
    }

    private func costruisciSfera() {
        guard let device = MetalEngine.shared.device,
              let lib = MetalEngine.shared.library(containing: "orb_vertex") ?? OrbLibrary.load(device: device) else {
            Log.warn("isola: la sfera non ha Metal, resta il resto dell'isola")
            return
        }
        let side = IsolaVista.sfera
        let v = OrbMTKView(frame: NSRect(x: 0, y: 0, width: side, height: side), device: device)
        v.colorPixelFormat = .rgba16Float
        v.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        v.framebufferOnly = true
        v.enableSetNeedsDisplay = false
        v.autoResizeDrawable = false
        v.drawableSize = CGSize(width: side * 3, height: side * 3)
        v.preferredFramesPerSecond = 60
        v.layer?.isOpaque = false
        if let ml = v.layer as? CAMetalLayer {
            ml.wantsExtendedDynamicRangeContent = true
            ml.colorspace = CGColorSpace(name: CGColorSpace.extendedLinearDisplayP3)
            ml.isOpaque = false
        }
        guard let r = OrbRenderer(device: device, library: lib, pixelFormat: v.colorPixelFormat) else { return }
        r.docked = true
        v.delegate = r
        v.isPaused = true
        v.onClick = { IsolaPanel.shared.modello.onClick?() }
        orbView = v
        renderer = r
    }

    private func chiudi() {
        guard let panel, panel.isVisible else { return }
        withAnimation(IsolaVista.molla) {
            modello.aperta = false
        }
        let work = DispatchWorkItem {
            MainActor.assumeIsolated {
                let me = IsolaPanel.shared
                guard !me.modello.aperta else { return }
                me.modello.fase = .riposo
                me.modello.testo = ""
                me.panel?.orderOut(nil)
                me.orbView?.isPaused = true
            }
        }
        ritiro = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.55, execute: work)
    }

    private static func statoSfera(_ f: Fase) -> Int32 {
        switch f {
        case .riposo, .pronto: return OrbPanel.OrbState.idle.rawValue
        case .ascolto: return OrbPanel.OrbState.listening.rawValue
        case .pensa: return OrbPanel.OrbState.thinking.rawValue
        case .parla: return OrbPanel.OrbState.speaking.rawValue
        case .errore: return OrbPanel.OrbState.error.rawValue
        }
    }
}

// MARK: - The shape

/// The notch's outline: flush with the top edge, concave shoulders of radius `spalla`
/// where it meets the menu bar, lower corners of radius `fondo`. The shoulders stand out
/// of the body by `spalla` on each side.
struct FormaTacca: Shape {
    var spalla: CGFloat
    var fondo: CGFloat

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(spalla, fondo) }
        set { spalla = newValue.first; fondo = newValue.second }
    }

    func path(in r: CGRect) -> Path {
        let s = min(spalla, r.width / 4)
        let b = min(fondo, (r.width - 2 * s) / 2, r.height - s)
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.minY))
        p.addQuadCurve(to: CGPoint(x: r.minX + s, y: r.minY + s), control: CGPoint(x: r.minX + s, y: r.minY))
        p.addLine(to: CGPoint(x: r.minX + s, y: r.maxY - b))
        p.addQuadCurve(to: CGPoint(x: r.minX + s + b, y: r.maxY), control: CGPoint(x: r.minX + s, y: r.maxY))
        p.addLine(to: CGPoint(x: r.maxX - s - b, y: r.maxY))
        p.addQuadCurve(to: CGPoint(x: r.maxX - s, y: r.maxY - b), control: CGPoint(x: r.maxX - s, y: r.maxY))
        p.addLine(to: CGPoint(x: r.maxX - s, y: r.minY + s))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.minY), control: CGPoint(x: r.maxX - s, y: r.minY))
        p.closeSubpath()
        return p
    }
}

// MARK: - The view

struct IsolaVista: View {
    let m: IsolaModello
    let sfera: OrbMTKView?

    static let molla = Animation.spring(response: 0.46, dampingFraction: 0.74, blendDuration: 0.1)
    static let sfera: CGFloat = 24
    private static let orecchio: CGFloat = 74
    private static let larghezzaAperta: CGFloat = 400
    private static let spalla: CGFloat = 9

    @State private var sopra = false

    private var conTesto: Bool { m.aperta && !m.testo.isEmpty && m.fase != .riposo }
    private var compatta: Bool { m.aperta && !conTesto }

    private var larghezzaCorpo: CGFloat {
        let base = m.tacca.width
        if !m.aperta { return base }
        return conTesto ? max(base + 2 * Self.orecchio, Self.larghezzaAperta) : base + 2 * Self.orecchio
    }

    var body: some View {
        VStack(spacing: 0) {
            isola
                .scaleEffect(sopra && m.aperta ? 1.025 : 1, anchor: .top)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .animation(Self.molla, value: m.aperta)
        .animation(Self.molla, value: m.fase)
        .animation(Self.molla, value: conTesto)
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: sopra)
    }

    private var isola: some View {
        let forma = FormaTacca(spalla: Self.spalla, fondo: conTesto ? 26 : (m.aperta ? 14 : 10))
        return VStack(spacing: 0) {
            barra
                .frame(height: m.tacca.height)
            if conTesto {
                corpo
                    .transition(.blurReplace.combined(with: .opacity))
            }
        }
        .padding(.horizontal, Self.spalla)
        .frame(width: larghezzaCorpo + 2 * Self.spalla)
        .background {
            ZStack {
                Aura(fase: m.fase, accesa: m.aperta)
                    .offset(y: 10)
                forma.fill(.black)
                forma
                    .stroke(Palette.bordo(m.fase), lineWidth: 1)
                    .opacity(m.aperta ? 0.9 : 0)
                    .mask(LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom))
            }
        }
        .contentShape(forma)
        .onTapGesture { m.onClick?() }
        .onHover { sopra = $0 }
    }

    // The strip level with the notch: sphere left, state right, the notch itself in the middle.
    private var barra: some View {
        HStack(spacing: 0) {
            if m.aperta {
                ZStack {
                    Circle()
                        .fill(Palette.colori(m.fase).first ?? .white)
                        .blur(radius: 8)
                        .opacity(0.55)
                        .frame(width: Self.sfera, height: Self.sfera)
                    if let sfera {
                        SferaVista(vista: sfera)
                            .frame(width: Self.sfera, height: Self.sfera)
                    } else {
                        Circle().fill(Palette.gradiente(m.fase)).frame(width: 16, height: 16)
                    }
                }
                .padding(.leading, 14)
                .transition(.scale(scale: 0.3).combined(with: .opacity))
            }
            Spacer(minLength: m.tacca.width)
            if m.aperta {
                IsolaStato(fase: m.fase)
                    .padding(.trailing, 16)
                    .transition(.scale(scale: 0.3).combined(with: .opacity))
            }
        }
    }

    private var corpo: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text("MELISSA")
                    .foregroundStyle(.white.opacity(0.45))
                Text(Palette.parola(m.fase).uppercased())
                    .foregroundStyle(Palette.gradiente(m.fase))
                    .contentTransition(.interpolate)
            }
            .font(.system(size: 9.5, weight: .heavy, design: .rounded))
            .tracking(1.4)

            Text(m.testo)
                .font(.system(size: 14.5, weight: .medium, design: .rounded))
                .foregroundStyle(.white)
                .lineLimit(3)
                .truncationMode(.head)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentTransition(.interpolate)
                .animation(.smooth(duration: 0.22), value: m.testo)
                .overlay {
                    if m.fase == .pensa { Luccichio().mask(Text(m.testo).font(.system(size: 14.5, weight: .medium, design: .rounded)).lineLimit(3).truncationMode(.head).frame(maxWidth: .infinity, alignment: .leading)) }
                }
        }
        .padding(.horizontal, 22)
        .padding(.top, 4)
        .padding(.bottom, 16)
    }
}

/// The existing orb view, hosted as is.
struct SferaVista: NSViewRepresentable {
    let vista: OrbMTKView
    func makeNSView(context: Context) -> OrbMTKView { vista }
    func updateNSView(_ nsView: OrbMTKView, context: Context) {}
}

// MARK: - Right ear

struct IsolaStato: View {
    let fase: IsolaPanel.Fase

    var body: some View {
        ZStack {
            switch fase {
            case .ascolto:
                Onda(fonte: 1, fase: fase).transition(.blurReplace)
            case .parla:
                Onda(fonte: 3, fase: fase).transition(.blurReplace)
            case .pensa:
                Anello(fase: fase).transition(.blurReplace)
            case .pronto:
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Palette.gradiente(fase))
                    .symbolEffect(.bounce, value: fase)
                    .transition(.blurReplace)
            case .errore:
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Palette.gradiente(fase))
                    .symbolEffect(.pulse)
                    .transition(.blurReplace)
            case .riposo:
                EmptyView()
            }
        }
        .frame(width: 34, height: 20)
    }
}

/// Five bars on the live audio: the microphone while listening, Melissa's voice while speaking.
struct Onda: View {
    let fonte: Int32
    let fase: IsolaPanel.Fase

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 40)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let snap = AudioLevels.shared.snapshot(forOrbState: fonte)
            HStack(spacing: 2.5) {
                ForEach(0..<5, id: \.self) { i in
                    Capsule()
                        .fill(Palette.gradiente(fase))
                        .frame(width: 3, height: Onda.altezza(snap, i, t))
                }
            }
            .frame(height: 20)
        }
    }

    /// Bars from the speech bands (the middle of the 16), the centre one tallest, with a
    /// small breath so the ear is alive in silence too.
    static func altezza(_ s: (level: Float, bands: [Float]), _ i: Int, _ t: Double) -> CGFloat {
        let gruppi = [[1, 2], [3, 4], [5, 6, 7], [8, 9], [10, 11, 12]]
        let idx = gruppi[i].filter { $0 < s.bands.count }
        let banda = idx.isEmpty ? 0 : idx.map { s.bands[$0] }.reduce(0, +) / Float(idx.count)
        let peso: [Float] = [0.7, 0.9, 1.0, 0.9, 0.7]
        let v = min(1, max(banda * 1.8, s.level * 1.4) * peso[i])
        let respiro = 0.12 + 0.08 * sin(t * 5 + Double(i) * 0.9)
        return 4 + 16 * CGFloat(max(Float(respiro), v))
    }
}

/// A turning ring in the state's colours.
struct Anello: View {
    let fase: IsolaPanel.Fase

    var body: some View {
        TimelineView(.animation) { ctx in
            let a = ctx.date.timeIntervalSinceReferenceDate
            ZStack {
                Circle()
                    .stroke(.white.opacity(0.12), lineWidth: 2.4)
                Circle()
                    .trim(from: 0, to: 0.7)
                    .stroke(AngularGradient(colors: Palette.colori(fase) + [Palette.colori(fase)[0]], center: .center),
                            style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
                    .rotationEffect(.degrees((a * 300).truncatingRemainder(dividingBy: 360)))
            }
            .frame(width: 15, height: 15)
        }
    }
}

/// A light that runs across the text while Melissa thinks.
struct Luccichio: View {
    var body: some View {
        TimelineView(.animation) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let x = CGFloat((t * 0.7).truncatingRemainder(dividingBy: 1.4)) - 0.2
            LinearGradient(stops: [.init(color: .clear, location: 0),
                                   .init(color: .white.opacity(0.85), location: 0.5),
                                   .init(color: .clear, location: 1)],
                           startPoint: UnitPoint(x: x - 0.25, y: 0.5), endPoint: UnitPoint(x: x + 0.25, y: 0.5))
                .blendMode(.plusLighter)
        }
    }
}

/// The glow under the island: the state's colours, breathing with the voice.
/// It is always in the view tree, also with the panel put away: off (closed island, or at
/// rest) its timeline is paused, so the hidden panel asks for no frames at all.
struct Aura: View {
    let fase: IsolaPanel.Fase
    let accesa: Bool

    private var viva: Bool { accesa && fase != .riposo }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !viva)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let livello = CGFloat(AudioLevels.shared.snapshot(forOrbState: fase == .parla ? 3 : 1).level)
            let respiro = 0.5 + 0.5 * sin(t * 2.2)
            let forza = viva ? 0.35 + 0.15 * respiro + 0.5 * min(1, livello * 1.5) : 0
            Capsule()
                .fill(Palette.gradienteLineare(fase))
                .padding(.horizontal, 26)
                .blur(radius: 22)
                .opacity(forza)
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Colours

enum Palette {
    static func colori(_ f: IsolaPanel.Fase) -> [Color] {
        switch f {
        case .ascolto: return [Color(red: 0.31, green: 0.82, blue: 1.0), Color(red: 0.42, green: 0.39, blue: 1.0)]
        case .pensa: return [Color(red: 0.65, green: 0.55, blue: 0.98), Color(red: 0.96, green: 0.45, blue: 0.71)]
        case .parla: return [Color(red: 0.96, green: 0.45, blue: 0.71), Color(red: 0.98, green: 0.57, blue: 0.24)]
        case .pronto: return [Color(red: 0.20, green: 0.83, blue: 0.60), Color(red: 0.13, green: 0.83, blue: 0.93)]
        case .errore: return [Color(red: 0.96, green: 0.62, blue: 0.04), Color(red: 0.94, green: 0.27, blue: 0.27)]
        case .riposo: return [Color.white.opacity(0.3), Color.white.opacity(0.1)]
        }
    }

    static func gradiente(_ f: IsolaPanel.Fase) -> LinearGradient {
        LinearGradient(colors: colori(f), startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    static func gradienteLineare(_ f: IsolaPanel.Fase) -> LinearGradient {
        LinearGradient(colors: colori(f), startPoint: .leading, endPoint: .trailing)
    }

    static func bordo(_ f: IsolaPanel.Fase) -> LinearGradient {
        LinearGradient(colors: colori(f).map { $0.opacity(0.75) }, startPoint: .leading, endPoint: .trailing)
    }

    static func parola(_ f: IsolaPanel.Fase) -> String {
        switch f {
        case .riposo: return ""
        case .ascolto: return "ascolto"
        case .pensa: return "un attimo"
        case .parla: return "parlo"
        case .pronto: return "fatto"
        case .errore: return "errore"
        }
    }
}
