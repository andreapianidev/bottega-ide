//
//  OsservatorioView.swift
//  Bottega Nucleo
//
//  The Osservatorio, SwiftUI: the sky of the projects (Metal) fills the window; over it,
//  Liquid Glass panels in two columns, so the middle of the sky stays open. Left, what
//  happened (today, this week, when you work); right, where (the projects, the tokens,
//  what kind of work). The "secondo schermo" mode drops every control and enlarges the
//  text, for a second monitor in full screen.
//
//  Palette "Roque" (always night), titles in New York, numbers in SF. Charts follow the
//  dataviz rules: one hue per measure (sodium for your hours, star blue for Claude's
//  tokens), a sentence that reads each chart in words, no dual axes.
//

import AppKit
import Charts
import Observation
import Spatial
import SwiftUI

// MARK: - Model

@MainActor
@Observable
final class OsservatorioModel {
    var data: OsservatorioData? { didSet { recompute() } }
    var period = "30" { didSet { if period != oldValue { recompute() } } }
    var selected: Int?
    var hovered: Int?
    var secondScreen = false
    private(set) var pannelli = Pannelli()
    private(set) var scene = SkyScene()
    private var version = 0

    private func recompute() {
        let keepKey = selected.flatMap { $0 < scene.stars.count ? scene.stars[$0].key : nil }
        version += 1
        guard let data else {
            pannelli = Pannelli()
            scene = SkyScene(stars: [], edges: [], version: version)
            selected = nil
            return
        }
        pannelli = Pannelli.compute(data, period: period)
        scene = OsservatorioCielo.scene(data, period: period, version: version)
        selected = scene.index(ofKey: keepKey)
        hovered = nil
    }

    var selectedStar: SkyStar? { selected.flatMap { $0 < scene.stars.count ? scene.stars[$0] : nil } }

    func project(for star: SkyStar) -> OsservatorioData.Project? {
        pannelli.progetti.first { ($0.path ?? $0.name) == star.key }
    }

    func toggleSelection(key: String) {
        let i = scene.index(ofKey: key)
        selected = (i == selected) ? nil : i
    }
}

// MARK: - Palette

private func rc(_ hex: Int, _ alpha: Double = 1) -> Color {
    let c = Roque.srgb(hex)
    return Color(.sRGB, red: Double(c.x), green: Double(c.y), blue: Double(c.z), opacity: alpha)
}

private enum Tinta {
    static let testo = rc(Roque.calima)
    static let seconda = rc(Roque.tinta)
    static let sodio = rc(Roque.sodio)
    static let stella = rc(Roque.stella)
    static let focus = rc(Roque.focus)
    static let laurisilva = rc(Roque.laurisilva)
    static let vetro = rc(Roque.cielo, 0.28)
}

private extension Font {
    static func titolo(_ size: CGFloat) -> Font { .system(size: size, weight: .regular, design: .serif) }
    static func cifra(_ size: CGFloat) -> Font { .system(size: size, weight: .semibold) }
}

// MARK: - Root

struct OsservatorioView: View {
    @Bindable var model: OsservatorioModel
    @State private var showExit = false
    @State private var hideTask: Task<Void, Never>?

    private static let column: CGFloat = 320
    private static let gutter: CGFloat = 24

    private func insets(_ size: CGSize) -> NSEdgeInsets {
        if model.secondScreen { return NSEdgeInsets(top: 230, left: 80, bottom: 0, right: 80) }
        let side = Self.column + Self.gutter * 2
        return NSEdgeInsets(top: 92, left: side, bottom: 0, right: side)
    }

    var body: some View {
        GeometryReader { geo in
            let ins = insets(geo.size)
            ZStack(alignment: .topLeading) {
                SkyView(scene: model.scene, selected: model.selected, insets: ins,
                        onHover: { model.hovered = $0 },
                        onSelect: { i in model.selected = (i == model.selected) ? nil : i })
                    .ignoresSafeArea()
                StarLabels(model: model, field: SkyGeometry.fieldRect(size: geo.size, insets: ins), big: model.secondScreen)
                    .allowsHitTesting(false)
                if model.data == nil {
                    EmptySky()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if model.secondScreen {
                    SecondScreen(model: model)
                } else {
                    panels
                }
                if model.secondScreen && showExit {
                    Button("Torna ai pannelli") { model.secondScreen = false }
                        .buttonStyle(.glass)
                        .padding(28)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                        .transition(.opacity)
                }
            }
        }
        .background(rc(Roque.zenit))
        .environment(\.colorScheme, .dark)
        .onContinuousHover { phase in
            guard model.secondScreen, case .active = phase else { return }
            withAnimation(.easeOut(duration: 0.2)) { showExit = true }
            hideTask?.cancel()
            hideTask = Task { @MainActor in
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                withAnimation(.easeIn(duration: 0.3)) { showExit = false }
            }
        }
    }

    private var panels: some View {
        VStack(alignment: .leading, spacing: 18) {
            Header(model: model)
            HStack(alignment: .top, spacing: 0) {
                ScrollView(.vertical, showsIndicators: false) {
                    GlassEffectContainer(spacing: 14) {
                        VStack(spacing: 14) {
                            OggiPanel(p: model.pannelli)
                            SettimanaPanel(p: model.pannelli)
                            OrePanel(p: model.pannelli)
                        }
                    }
                    .padding(.bottom, 24)
                }
                .frame(width: Self.column)
                Spacer(minLength: 0)
                ScrollView(.vertical, showsIndicators: false) {
                    GlassEffectContainer(spacing: 14) {
                        VStack(spacing: 14) {
                            ProgettiPanel(model: model)
                            TokenPanel(p: model.pannelli)
                            if model.pannelli.categorie != nil { CategoriePanel(p: model.pannelli) }
                        }
                    }
                    .padding(.bottom, 24)
                }
                .frame(width: Self.column)
            }
        }
        .padding(.horizontal, Self.gutter)
        .padding(.top, 34)
    }
}

// MARK: - Header

private struct Header: View {
    @Bindable var model: OsservatorioModel

    private var riga: String {
        let n = model.scene.stars.count
        let l = model.scene.edges.count
        let v = model.pannelli.vive
        var s = n == 1 ? "Una stella" : "\(n) stelle"
        s += l == 0 ? ", nessun legame" : (l == 1 ? ", un legame" : ", \(l) legami")
        if v > 0 { s += v == 1 ? ", una sessione al lavoro" : ", \(v) sessioni al lavoro" }
        return s + "."
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Osservatorio")
                    .font(.titolo(26))
                    .foregroundStyle(Tinta.testo)
                Text(riga)
                    .font(.system(size: 12))
                    .foregroundStyle(Tinta.seconda)
            }
            Spacer()
            Picker("Periodo", selection: $model.period) {
                Text("7 giorni").tag("7")
                Text("30 giorni").tag("30")
                Text("90 giorni").tag("90")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 240)
            Button {
                model.secondScreen = true
            } label: {
                Label("Secondo schermo", systemImage: "rectangle.on.rectangle")
            }
            .buttonStyle(.glass)
            .help("Vista d'insieme senza controlli, con i testi grandi")
        }
    }
}

// MARK: - Panels

private struct Pannello<Content: View>: View {
    var titolo: String
    var radius: CGFloat = 24
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(titolo)
                .font(.titolo(16))
                .foregroundStyle(Tinta.testo)
            content
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.tint(Tinta.vetro), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

/// When a block of the data did not arrive: one sentence, no zeros pretending to be data.
private struct Mancano: View {
    var frase: String
    var body: some View {
        Text(frase)
            .font(.system(size: 12))
            .foregroundStyle(Tinta.seconda)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct KpiRow: View {
    var kpi: [Pannelli.Kpi]
    var size: CGFloat = 22

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ForEach(kpi.indices, id: \.self) { i in
                let k = kpi[i]
                VStack(alignment: .leading, spacing: 3) {
                    Text(k.label)
                        .font(.system(size: size * 0.52))
                        .foregroundStyle(Tinta.seconda)
                    Text(k.value)
                        .font(.cifra(size))
                        .foregroundStyle(i == 0 ? Tinta.sodio : Tinta.testo)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    if let note = k.note {
                        Text(note)
                            .font(.system(size: size * 0.5))
                            .foregroundStyle(Tinta.seconda)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct OggiPanel: View {
    var p: Pannelli
    var body: some View {
        Pannello(titolo: "Oggi") {
            if let k = p.oggi {
                KpiRow(kpi: k)
                if let f = p.oggiFrase { Mancano(frase: f) }
            } else {
                Mancano(frase: "I numeri di oggi non sono arrivati.")
            }
        }
    }
}

private struct SettimanaPanel: View {
    var p: Pannelli
    var body: some View {
        Pannello(titolo: "Questa settimana") {
            if let k = p.settimana {
                KpiRow(kpi: k)
                if let f = p.settimanaFrase { Mancano(frase: f) }
                Text("Le percentuali confrontano con la settimana scorsa fino allo stesso giorno e alla stessa ora.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(Tinta.seconda.opacity(0.8))
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Mancano(frase: "Il confronto con la settimana scorsa non è arrivato.")
            }
        }
    }
}

/// Hours of the week as a 3D surface: day x hour x minutes, one hue (sodium), rotatable.
private struct OrePanel: View {
    var p: Pannelli
    @State private var pose = Chart3DPose(azimuth: .degrees(-28), inclination: .degrees(24))

    var body: some View {
        Pannello(titolo: "Quando lavori") {
            if let heat = p.heat {
                let top = max(1, p.heatMax)
                Chart3D {
                    SurfacePlot(x: "ora", y: "minuti", z: "giorno") { x, z in
                        Self.sample(heat, hour: x, day: z)
                    }
                    .foregroundStyle(.heightBased(Gradient(colors: [rc(0x24304f), rc(0x8a6a3a), Tinta.sodio]),
                                                  yRange: 0...top))
                }
                .chartXScale(domain: 0...23)
                .chartYScale(domain: 0...top)
                .chartZScale(domain: 0...6)
                .chartXAxisLabel("ora del giorno")
                .chartYAxisLabel("minuti")
                .chartZAxisLabel("da lunedì a domenica")
                .chart3DPose($pose)
                .chart3DCameraProjection(.perspective)
                .frame(height: 230)
                .help("Trascina per girare il grafico")
                if let f = p.heatFrase { Mancano(frase: f) }
            } else {
                Mancano(frase: "La mappa delle ore non è arrivata.")
            }
        }
    }

    /// Bilinear sample of the 7 x 24 grid (Monday first).
    nonisolated static func sample(_ heat: [[Double]], hour: Double, day: Double) -> Double {
        guard heat.count == 7 else { return 0 }
        let x = min(max(hour, 0), 23), z = min(max(day, 0), 6)
        let x0 = Int(x), z0 = Int(z)
        let x1 = min(23, x0 + 1), z1 = min(6, z0 + 1)
        let fx = x - Double(x0), fz = z - Double(z0)
        let a = heat[z0][x0] + (heat[z0][x1] - heat[z0][x0]) * fx
        let b = heat[z1][x0] + (heat[z1][x1] - heat[z1][x0]) * fx
        return a + (b - a) * fz
    }
}

/// Bars, one hue: a ranking, every value written at the end of its bar.
private struct BarList: View {
    var bars: [Pannelli.Bar]
    var color: Color

    var body: some View {
        Chart(bars.indices, id: \.self) { i in
            let b = bars[i]
            BarMark(x: .value("valore", b.value), y: .value("voce", b.label))
                .foregroundStyle(color)
                .cornerRadius(4)
                .annotation(position: .trailing, alignment: .leading, spacing: 6) {
                    Text(b.text)
                        .font(.system(size: 11))
                        .foregroundStyle(Tinta.seconda)
                }
        }
        .chartXAxis(.hidden)
        .chartYAxis {
            AxisMarks { _ in
                AxisValueLabel()
                    .font(.system(size: 11))
                    .foregroundStyle(Tinta.testo)
            }
        }
        .chartXScale(range: .plotDimension(endPadding: 56))
        .frame(height: CGFloat(bars.count) * 26 + 4)
    }
}

private struct TokenPanel: View {
    var p: Pannelli
    var body: some View {
        Pannello(titolo: "Token per progetto") {
            if let bars = p.token {
                BarList(bars: bars, color: Tinta.stella)
                if let f = p.tokenFrase { Mancano(frase: f) }
            } else {
                Mancano(frase: "Nessun token nel periodo.")
            }
        }
    }
}

private struct CategoriePanel: View {
    var p: Pannelli
    var body: some View {
        Pannello(titolo: "Che lavoro è stato") {
            if let bars = p.categorie {
                BarList(bars: bars.map { Pannelli.Bar(label: $0.label, value: $0.value, text: $0.text) }, color: Tinta.sodio)
                if let f = p.categorieFrase { Mancano(frase: f) }
            }
        }
    }
}

private struct ProgettiPanel: View {
    @Bindable var model: OsservatorioModel

    var body: some View {
        Pannello(titolo: "Progetti") {
            if let star = model.selectedStar {
                Selezionata(star: star, project: model.project(for: star))
                Divider().overlay(rc(Roque.linea))
            }
            if model.pannelli.progetti.isEmpty {
                Mancano(frase: "Nessun progetto con ore tue nel periodo.")
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.vertical) {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(model.pannelli.progetti, id: \.name) { p in
                                riga(p).id(p.path ?? p.name)
                            }
                        }
                    }
                    .frame(maxHeight: 230)
                    .onChange(of: model.selected) { _, _ in
                        if let s = model.selectedStar { withAnimation { proxy.scrollTo(s.key, anchor: .center) } }
                    }
                }
            }
        }
    }

    private func riga(_ p: OsservatorioData.Project) -> some View {
        let key = p.path ?? p.name
        let isSel = model.selectedStar?.key == key
        let star = model.scene.stars.first { $0.key == key }
        return Button {
            model.toggleSelection(key: key)
        } label: {
            HStack(spacing: 10) {
                Circle()
                    .fill(star.map { starColor($0) } ?? Tinta.seconda)
                    .frame(width: 7, height: 7)
                Text(p.name)
                    .font(.system(size: 12.5))
                    .foregroundStyle(Tinta.testo)
                    .lineLimit(1)
                if p.live > 0 || (star?.live ?? false) {
                    Text("al lavoro")
                        .font(.system(size: 10.5))
                        .foregroundStyle(Tinta.sodio)
                }
                Spacer(minLength: 6)
                Text(Fmt.hm(p.you))
                    .font(.system(size: 11.5).monospacedDigit())
                    .foregroundStyle(Tinta.seconda)
            }
            .padding(.vertical, 5)
            .padding(.horizontal, 8)
            .background(isSel ? Tinta.focus.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func starColor(_ s: SkyStar) -> Color {
        let c = SkyRenderer.starColor(warmth: s.warmth, hollow: s.hollow)
        // linear P3 back to display: close enough for a 7 pt dot
        return Color(.displayP3, red: Double(powf(c.x, 1 / 2.2)), green: Double(powf(c.y, 1 / 2.2)), blue: Double(powf(c.z, 1 / 2.2)))
    }
}

private struct Selezionata: View {
    var star: SkyStar
    var project: OsservatorioData.Project?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(star.name)
                .font(.titolo(18))
                .foregroundStyle(Tinta.testo)
            if let p = project {
                Text("\(Fmt.hm(p.you)) tue, \(Fmt.hm(p.claude)) di Claude, \(Fmt.tk(p.tok)) token.")
                    .font(.system(size: 12))
                    .foregroundStyle(Tinta.testo.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
                if p.last > 0 {
                    Text(Self.quando(p.last))
                        .font(.system(size: 11))
                        .foregroundStyle(Tinta.seconda)
                }
            }
            if let path = star.path {
                Text((path as NSString).abbreviatingWithTildeInPath)
                    .font(.system(size: 10.5))
                    .foregroundStyle(Tinta.seconda)
                    .lineLimit(1)
                    .truncationMode(.middle)
            } else {
                Text("Le sessioni partite fuori dai progetti.")
                    .font(.system(size: 11))
                    .foregroundStyle(Tinta.seconda)
            }
        }
    }

    static func quando(_ ms: Double) -> String {
        let days = Int((Date().timeIntervalSince1970 * 1000 - ms) / 86_400_000)
        switch days {
        case ..<1: return "Ci hai lavorato oggi."
        case 1: return "Ci hai lavorato ieri."
        default: return "Ci hai lavorato \(days) giorni fa."
        }
    }
}

// MARK: - Star names

private struct StarLabels: View {
    var model: OsservatorioModel
    var field: CGRect
    var big: Bool

    var body: some View {
        let scene = model.scene
        // The brightest nine, the live ones, the one in focus: never every name.
        let shown = scene.stars.indices.filter { i in
            i < 9 || scene.stars[i].live || i == model.selected || i == model.hovered
        }
        ZStack(alignment: .topLeading) {
            ForEach(shown, id: \.self) { i in
                let s = scene.stars[i]
                let p = SkyGeometry.point(of: s, in: field)
                let focus = i == model.selected || i == model.hovered
                let dx = CGFloat(s.size) * 1.8 + 8
                Text(focus ? "\(s.name), \(Fmt.hm(s.minutes))" : s.name)
                    .font(.system(size: big ? 17 : 11, weight: focus ? .semibold : .regular))
                    .foregroundStyle(focus ? Tinta.testo : Tinta.testo.opacity(0.62))
                    .shadow(color: .black.opacity(0.8), radius: 3)
                    .fixedSize()
                    .alignmentGuide(.leading) { _ in -(p.x + dx) }
                    .alignmentGuide(.top) { d in -(p.y - d.height / 2) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Empty

private struct EmptySky: View {
    var body: some View {
        VStack(spacing: 6) {
            Text("Il cielo aspetta i numeri")
                .font(.titolo(22))
                .foregroundStyle(Tinta.testo)
            Text("Li manda la Bottega quando il cruscotto ha finito di contare. Se resta così, apri il cruscotto nella plancia.")
                .font(.system(size: 13))
                .foregroundStyle(Tinta.seconda)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
        }
        .padding(28)
        .glassEffect(.regular.tint(Tinta.vetro), in: RoundedRectangle(cornerRadius: 28, style: .continuous))
    }
}

// MARK: - Second screen

private struct SecondScreen: View {
    var model: OsservatorioModel

    var body: some View {
        let p = model.pannelli
        VStack(alignment: .leading, spacing: 22) {
            HStack(alignment: .top, spacing: 40) {
                if let k = p.oggi {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Oggi").font(.titolo(30)).foregroundStyle(Tinta.testo)
                        KpiRow(kpi: k, size: 46)
                    }
                    .frame(maxWidth: 620, alignment: .leading)
                }
                if let k = p.settimana {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Questa settimana").font(.titolo(30)).foregroundStyle(Tinta.testo)
                        KpiRow(kpi: k, size: 34)
                    }
                    .frame(maxWidth: 520, alignment: .leading)
                }
                Spacer(minLength: 0)
                if let live = model.data?.live, !live.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Al lavoro adesso").font(.titolo(26)).foregroundStyle(Tinta.testo)
                        ForEach(Array(live.prefix(6).enumerated()), id: \.offset) { _, l in
                            VStack(alignment: .leading, spacing: 1) {
                                Text(l.project).font(.system(size: 20, weight: .semibold)).foregroundStyle(Tinta.sodio)
                                if !l.title.isEmpty {
                                    Text(l.title).font(.system(size: 15)).foregroundStyle(Tinta.seconda).lineLimit(1)
                                }
                            }
                        }
                    }
                    .frame(maxWidth: 420, alignment: .leading)
                }
            }
            .padding(30)
            .glassEffect(.regular.tint(Tinta.vetro), in: RoundedRectangle(cornerRadius: 34, style: .continuous))
            let frasi = [p.settimanaFrase, p.categorieFrase, p.heatFrase].compactMap { $0 }
            if !frasi.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(frasi, id: \.self) { f in
                        Text(f).font(.system(size: 19)).foregroundStyle(Tinta.testo.opacity(0.88))
                    }
                }
                .padding(.horizontal, 32)
                .shadow(color: .black.opacity(0.7), radius: 4)
            }
        }
        .padding(.horizontal, 48)
        .padding(.top, 44)
    }
}
