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
    /// Who speaks: the name over the text (Melissa, or the character whose line sounds).
    var chi = ChiParla.melissa
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

    /// `chi`: the name over the text. Without it a .parla keeps the name it has (the line
    /// sounding now says who it is, Isola.segmentoIniziato), every other phase is Melissa's.
    func mostra(_ f: Fase, testo nuovo: String, chi: String? = nil) {
        let nome = chi ?? (f == .parla ? modello.chi : ChiParla.melissa)
        // the sphere of who speaks (its agitation comes from the Speaker, which has the audio
        // tags); every other phase is Melissa's
        if f == .parla { OrbAspetto.parla(chi: nome) } else { OrbAspetto.riposo() }
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
            modello.chi = nome
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
            modello.chi = nome
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
            modello.tacca = CGSize(width: 140, height: bar)
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
    // Sizes of the open island (build 127): smaller and finer than the first version, with
    // a text that reads at a glance, about 45 characters a line. The strip level with the
    // notch keeps the notch's own height.
    static let sfera: CGFloat = 20
    private static let orecchio: CGFloat = 54
    private static let larghezzaAperta: CGFloat = 326
    private static let spalla: CGFloat = 7
    /// The line being said: light, with room between the lines.
    static let carattereTesto = Font.system(size: 13, weight: .regular, design: .rounded)
    static let interlinea: CGFloat = 3
    /// A new line comes in: fades in while it rises a few points.
    static let entrata = Animation.timingCurve(0.22, 1, 0.36, 1, duration: 0.3)

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
        let forma = FormaTacca(spalla: Self.spalla, fondo: conTesto ? 21 : (m.aperta ? 11 : 10))
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
                    .offset(y: 7)
                forma.fill(.black)
                forma
                    .stroke(Palette.bordo(m.fase), lineWidth: 0.75)
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
                    Alone(fase: m.fase, lato: Self.sfera)
                    if let sfera {
                        SferaVista(vista: sfera)
                            .frame(width: Self.sfera, height: Self.sfera)
                    } else {
                        Circle().fill(Palette.gradiente(m.fase)).frame(width: 13, height: 13)
                    }
                }
                .padding(.leading, 10)
                .transition(.scale(scale: 0.3).combined(with: .opacity))
            }
            Spacer(minLength: m.tacca.width)
            if m.aperta {
                IsolaStato(fase: m.fase)
                    .padding(.trailing, 12)
                    .transition(.scale(scale: 0.3).combined(with: .opacity))
            }
        }
    }

    /// While she speaks each new line enters (fade, a small rise); while she listens or
    /// thinks the text only follows, without entrances (a partial changes word by word).
    private var chiaveTesto: String { m.fase == .parla ? m.testo : "segue" }

    private var corpo: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                // a new name crossfades over the old one
                ZStack(alignment: .leading) {
                    Text(m.chi.uppercased())
                        .foregroundStyle(.white.opacity(0.42))
                        .id(m.chi)
                        .transition(.opacity.animation(.easeInOut(duration: 0.3)))
                }
                Text(Palette.parola(m.fase).uppercased())
                    .foregroundStyle(Palette.gradiente(m.fase))
                    .contentTransition(.interpolate)
            }
            .font(.system(size: 8.5, weight: .semibold, design: .rounded))
            .tracking(0.8)

            ZStack(alignment: .topLeading) {
                testo
                    .id(chiaveTesto)
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .offset(y: 4)).animation(Self.entrata),
                        removal: .opacity.animation(.easeOut(duration: 0.14))))
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .padding(.horizontal, 18)
        .padding(.top, 4)
        .padding(.bottom, 14)
    }

    private var testo: some View {
        Text(m.testo)
            .font(Self.carattereTesto)
            .lineSpacing(Self.interlinea)
            .foregroundStyle(.white.opacity(0.94))
            .lineLimit(3)
            .truncationMode(.head)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentTransition(.interpolate)
            .animation(.smooth(duration: 0.22), value: m.fase == .parla ? "" : m.testo)
            .overlay {
                if m.fase == .pensa { Luccichio().mask(Text(m.testo).font(Self.carattereTesto).lineSpacing(Self.interlinea).lineLimit(3).truncationMode(.head).frame(maxWidth: .infinity, alignment: .leading)) }
            }
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
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Palette.gradiente(fase))
                    .symbolEffect(.bounce, value: fase)
                    .transition(.blurReplace)
            case .errore:
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(Palette.gradiente(fase))
                    .symbolEffect(.pulse)
                    .transition(.blurReplace)
            case .riposo:
                EmptyView()
            }
        }
        .frame(width: 28, height: 16)
    }
}

/// The voice as the island draws it: one smoothed level for the halo and the aura, five
/// bars for the right ear. Each follows its target on a spring, stiff when the voice rises
/// (quick attack) and soft when it falls (gentle release). Advanced by time, not by calls:
/// the views that read it in the same frame do not step it twice, and after a pause it
/// starts again from where it was, without a jump. It is read only by timelines that run
/// while she listens or speaks: at rest nothing asks for frames.
@MainActor
final class VoceViva {
    static let shared = VoceViva()
    static let barre = 5

    private(set) var livello: CGFloat = 0
    private var velLivello: CGFloat = 0
    private(set) var altezze = [CGFloat](repeating: 0, count: VoceViva.barre)
    private var velAltezze = [CGFloat](repeating: 0, count: VoceViva.barre)
    private var ultimo: Double = 0
    /// The loudest of the last seconds: it is full height, whatever the voice's volume. The raw
    /// level of ordinary speech sits around 0.1-0.25, which drew bars a point or two tall that
    /// looked still (Andrea, 6 October 2026).
    private var picco: CGFloat = 0.12
    private var ultimoLog: Double = 0
    private var massimoLog: Float = 0

    /// Speech bands per bar (the middle of the 16) and how much each bar takes of them.
    private static let gruppi = [[1, 2], [3, 4], [5, 6, 7], [8, 9], [10, 11, 12]]
    private static let peso: [CGFloat] = [0.72, 0.9, 1.0, 0.88, 0.7]
    /// Each bar its own rhythm, so they never move as one block.
    private static let fase: [Double] = [0.0, 1.7, 3.1, 4.6, 5.9]
    private static let passo: [Double] = [4.1, 4.7, 3.8, 5.2, 4.4]

    func aggiorna(_ t: Double, fonte: Int32) {
        var dt = t - ultimo
        guard dt > 0 else { return }
        ultimo = t
        if dt > 0.1 { dt = 1.0 / 60 }   // after a pause: one frame, not a jump
        let s = AudioLevels.shared.snapshot(forOrbState: fonte)
        let grezzo = CGFloat(s.level)
        // automatic gain: the peak follows the voice up at once and comes down slowly (about 10%
        // a second), never below a floor that keeps room noise from filling the bars
        picco = max(grezzo, 0.05, picco * CGFloat(1 - 0.1 * dt))
        let voce = min(1, grezzo / picco)
        // the shape across the bars from the speech bands, relative to the loudest of them
        let medie: [CGFloat] = (0..<Self.barre).map { i in
            let idx = Self.gruppi[i].filter { $0 < s.bands.count }
            return idx.isEmpty ? 0 : CGFloat(idx.map { s.bands[$0] }.reduce(0, +) / Float(idx.count))
        }
        let forte = max(medie.max() ?? 0, 0.0001)
        var obiettivi = [CGFloat](repeating: 0, count: Self.barre)
        for i in 0..<Self.barre {
            // a little texture of its own on top of the voice, and a slow breath in silence
            let grana = 0.82 + 0.18 * CGFloat(sin(t * (7.3 + 1.1 * Double(i)) + Self.fase[i]))
            let forma = 0.45 + 0.55 * medie[i] / forte
            let v = min(1, voce * forma * Self.peso[i] * grana * 1.15)
            let respiro = 0.1 + 0.05 * CGFloat(sin(t * Self.passo[i] + Self.fase[i]))
            obiettivi[i] = max(respiro, v)
        }
        // the level actually read, in the log every few seconds while speaking: measurable, not guessed
        massimoLog = max(massimoLog, s.level)
        if fonte == 3, t - ultimoLog > 4 {
            if ultimoLog > 0 { Log.info("isola: barre, livello della voce massimo \(String(format: "%.3f", massimoLog)) negli ultimi 4 s") }
            ultimoLog = t
            massimoLog = 0
        }
        // small fixed steps keep the stiff spring stable at any frame rate
        var resto = dt
        while resto > 0 {
            let h = min(resto, 1.0 / 240)
            resto -= h
            Self.molla(&livello, &velLivello, voce, h)
            for i in 0..<Self.barre { Self.molla(&altezze[i], &velAltezze[i], obiettivi[i], h) }
        }
    }

    /// Rising: stiff and near critical (about 40 ms). Falling: soft (about 250 ms).
    private static func molla(_ x: inout CGFloat, _ v: inout CGFloat, _ target: CGFloat, _ h: Double) {
        let sale = target > x
        let k: CGFloat = sale ? 900 : 110
        let c: CGFloat = sale ? 54 : 19
        v += (k * (target - x) - c * v) * CGFloat(h)
        x = min(1.1, max(0, x + v * CGFloat(h)))
    }
}

/// Five rounded bars on the live audio: the microphone while listening, Melissa's voice
/// (AudioOut's real output, AudioLevels .tts) while speaking. Display rate while shown.
struct Onda: View {
    let fonte: Int32
    let fase: IsolaPanel.Fase

    /// Each bar its own height and pace, so they never move as one block.
    private static let alte: [CGFloat] = [9, 13, 16, 12, 8]
    private static let durate: [Double] = [0.42, 0.55, 0.36, 0.5, 0.46]

    @State private var su = false

    // SwiftUI's own repeating animation, no audio metering: the bars move whenever she speaks
    // or listens. In build 127-128 they were drawn from a shared level object and stood still
    // on screen while the level moved underneath (Andrea, 6 October 2026).
    var body: some View {
        HStack(spacing: 2.2) {
            ForEach(0..<5, id: \.self) { i in
                Capsule(style: .continuous)
                    .fill(Palette.gradiente(fase))
                    .frame(width: 2.2, height: su ? Self.alte[i] : 3)
                    .animation(.easeInOut(duration: Self.durate[i]).repeatForever(autoreverses: true).delay(Double(i) * 0.07), value: su)
            }
        }
        .frame(height: 16)
        .onAppear { su = true }
    }
}

/// The halo behind the sphere: it breathes with the voice, gently. Still (no timeline
/// running) unless she listens or speaks.
struct Alone: View {
    let fase: IsolaPanel.Fase
    let lato: CGFloat

    private var viva: Bool { fase == .parla || fase == .ascolto }

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: !viva)) { ctx in
            let voce = VoceViva.shared
            let _ = viva ? voce.aggiorna(ctx.date.timeIntervalSinceReferenceDate, fonte: fase == .parla ? 3 : 1) : ()
            let l = viva ? voce.livello : 0
            Circle()
                .fill(Palette.colori(fase).first ?? .white)
                .blur(radius: 6)
                .opacity(0.42 + 0.3 * min(1, l))
                .scaleEffect(1 + 0.22 * min(1, l))
                .frame(width: lato, height: lato)
        }
        .allowsHitTesting(false)
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
                    .stroke(.white.opacity(0.12), lineWidth: 1.6)
                Circle()
                    .trim(from: 0, to: 0.7)
                    .stroke(AngularGradient(colors: Palette.colori(fase) + [Palette.colori(fase)[0]], center: .center),
                            style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                    .rotationEffect(.degrees((a * 300).truncatingRemainder(dividingBy: 360)))
            }
            .frame(width: 12, height: 12)
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
        TimelineView(.animation(minimumInterval: nil, paused: !viva)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            let voce = VoceViva.shared
            let _ = voce.aggiorna(t, fonte: fase == .parla ? 3 : 1)
            let respiro = 0.5 + 0.5 * sin(t * 2.2)
            // the voice through the same soft spring as the bars: it swells, it never flashes
            let forza = viva ? 0.32 + 0.12 * respiro + 0.4 * min(1, voce.livello) : 0
            Capsule()
                .fill(Palette.gradienteLineare(fase))
                .padding(.horizontal, 20)
                .blur(radius: 16)
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
