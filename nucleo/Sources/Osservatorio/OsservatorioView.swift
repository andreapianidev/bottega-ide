//
//  OsservatorioView.swift
//  Bottega Nucleo
//
//  A dedicated, interactive Metal sky beside a scrollable project inspector. The
//  summary stays below the scene on wide windows and joins the inspector on narrow
//  ones. Every chart label owns layout space; sky labels use collision-tested frames.
//
//  Palette "Roque" (always night), titles in New York, numbers in SF. Charts follow the
//  dataviz rules: one hue per measure (sodium for your hours, star blue for Claude's
//  tokens), a sentence that reads each chart in words, no dual axes.
//

import AppKit
import Observation
import SwiftUI

// MARK: - Model

@MainActor
@Observable
final class OsservatorioModel {
    var data: OsservatorioData? { didSet { recompute() } }
    var period = "30" { didSet { if period != oldValue { recompute() } } }
    var selected: Int?
    var hovered: Int?
    var camera = SkyCamera()
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var revealed = false

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 20) {
                Header(model: model)
                if model.secondScreen {
                    sky
                    HStack(alignment: .top, spacing: 16) {
                        OggiPanel(p: model.pannelli)
                        SettimanaPanel(p: model.pannelli)
                    }
                    .frame(maxHeight: 200)
                } else {
                    HStack(alignment: .top, spacing: 20) {
                        VStack(spacing: 16) {
                            sky
                            if geo.size.width >= 1080 {
                                HStack(alignment: .top, spacing: 16) {
                                    OggiPanel(p: model.pannelli)
                                    SettimanaPanel(p: model.pannelli)
                                }
                                .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        ScrollView(.vertical) {
                            VStack(spacing: 16) {
                                ProgettiPanel(model: model)
                                if geo.size.width < 1080 {
                                    OggiPanel(p: model.pannelli)
                                    SettimanaPanel(p: model.pannelli)
                                }
                                OrePanel(p: model.pannelli)
                                TokenPanel(p: model.pannelli)
                                if model.pannelli.categorie != nil { CategoriePanel(p: model.pannelli) }
                            }
                            .padding(.bottom, 12)
                        }
                        .scrollIndicators(.hidden)
                        .frame(width: geo.size.width < 1080 ? 270 : 310)
                    }
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 42)
            .padding(.bottom, 20)
            .opacity(revealed ? 1 : 0)
            .offset(y: revealed || reduceMotion ? 0 : 12)
        }
        .background {
            LinearGradient(colors: [rc(0x111c30), rc(Roque.zenit), rc(0x101725)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
        }
        .environment(\.colorScheme, .dark)
        .task {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.7)) { revealed = true }
        }
    }

    private var sky: some View {
        GeometryReader { geo in
            let insets = NSEdgeInsets(top: 72, left: 28, bottom: 72, right: 28)
            let scene = model.camera.project(model.scene)
            ZStack(alignment: .topLeading) {
                SkyView(scene: scene, selected: model.selected, insets: insets,
                        camera: model.camera,
                        onOrbit: { dx, dy in model.camera.orbit(dx: dx, dy: dy) },
                        onZoom: { model.camera.magnify($0) },
                        onHover: { model.hovered = $0 },
                        onSelect: { i in model.selected = (i == model.selected) ? nil : i })
                StarLabels(scene: scene, selected: model.selected, hovered: model.hovered,
                           field: SkyGeometry.fieldRect(size: geo.size, insets: insets), big: model.secondScreen)
                    .allowsHitTesting(false)
                VStack {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Il tuo universo")
                                .font(.titolo(25)).foregroundStyle(Tinta.testo)
                            Text("Ogni stella, un progetto. Ogni legame, tempo condiviso.")
                                .font(.system(size: 11)).foregroundStyle(Tinta.seconda)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 8)
                        Color.clear.frame(width: 30, height: 30)
                    }
                    Spacer()
                    HStack(spacing: 8) {
                        Image(systemName: "move.3d")
                        Text("Trascina per esplorare · Scorri per avvicinarti")
                            .lineLimit(2)
                        Spacer(minLength: 0)
                        if model.pannelli.vive > 0 {
                            Circle().fill(Tinta.sodio).frame(width: 5, height: 5)
                            Text("\(model.pannelli.vive) al lavoro").foregroundStyle(Tinta.sodio)
                        }
                    }
                    .font(.system(size: 10.5))
                    .foregroundStyle(Tinta.seconda)
                }
                .padding(22)
                .allowsHitTesting(false)
                Button { model.camera = SkyCamera() } label: {
                    Image(systemName: "viewfinder").foregroundStyle(Tinta.testo).frame(width: 30, height: 30)
                }
                .buttonStyle(.glass)
                .help("Ripristina il punto di vista")
                .accessibilityLabel("Ripristina il punto di vista")
                .padding(22)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                if model.data == nil {
                    EmptySky().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(Tinta.focus.opacity(0.13)).allowsHitTesting(false))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)

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
                    .font(.titolo(32))
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
                model.secondScreen.toggle()
            } label: {
                Label(model.secondScreen ? "Mostra pannelli" : "Vista immersiva", systemImage: model.secondScreen ? "sidebar.right" : "arrow.up.left.and.arrow.down.right")
                    .foregroundStyle(Tinta.testo)
            }
            .buttonStyle(.glass)
            .help(model.secondScreen ? "Torna alla vista con i pannelli (Esc)" : "Allarga il cielo e i nomi dei progetti")
        }
    }
}

// MARK: - Panels

private struct Pannello<Content: View>: View {
    var titolo: String
    var radius: CGFloat = 18
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
        .background(rc(0x152035, 0.94), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(
            LinearGradient(colors: [Tinta.focus.opacity(0.19), Tinta.focus.opacity(0.04)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)))
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
    var size: CGFloat = 21

    private var columns: some View {
        HStack(alignment: .top, spacing: 10) {
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
                        .minimumScaleFactor(0.72)
                        .monospacedDigit()
                    if let note = k.note {
                        Text(note)
                            .font(.system(size: size * 0.5))
                            .foregroundStyle(Tinta.seconda)
                    }
                }
                .frame(minWidth: 95, maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            columns
            VStack(alignment: .leading, spacing: 10) {
                ForEach(kpi.indices, id: \.self) { i in
                    let k = kpi[i]
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(k.label).font(.system(size: 11)).foregroundStyle(Tinta.seconda)
                            .frame(width: 42, alignment: .leading)
                        Text(k.value).font(.cifra(18)).monospacedDigit()
                            .foregroundStyle(i == 0 ? Tinta.sodio : Tinta.testo)
                            .lineLimit(1).minimumScaleFactor(0.8)
                        Spacer(minLength: 0)
                        if let note = k.note {
                            Text(note).font(.system(size: 10)).foregroundStyle(Tinta.seconda)
                                .lineLimit(1)
                        }
                    }
                }
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

/// A 7 × 24 matrix keeps the rhythm readable at sidebar sizes; depth belongs to the sky.
private struct OrePanel: View {
    var p: Pannelli

    var body: some View {
        Pannello(titolo: "Il ritmo della settimana") {
            if let heat = p.heat {
                VStack(spacing: 5) {
                    HStack {
                        Text(" ").frame(width: 25)
                        ForEach(["00", "06", "12", "18", "23"], id: \.self) { hour in
                            Text(hour).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .font(.system(size: 9).monospacedDigit())
                    .foregroundStyle(Tinta.seconda)
                    ForEach(0..<7, id: \.self) { day in
                        HStack(spacing: 3) {
                            Text(Fmt.giorniBrevi[day])
                                .font(.system(size: 10)).foregroundStyle(Tinta.seconda)
                                .frame(width: 25, alignment: .leading)
                            ForEach(0..<24, id: \.self) { hour in
                                let value = heat[day][hour]
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(Tinta.sodio.opacity(value > 0 ? 0.18 + 0.82 * sqrt(value / max(1, p.heatMax)) : 0.045))
                                    .frame(maxWidth: .infinity).frame(height: 13)
                                    .help("\(Fmt.giorni[day]), \(hour):00: \(Fmt.hm(value))")
                                    .accessibilityLabel("\(Fmt.giorni[day]), ore \(hour): \(Fmt.hm(value))")
                            }
                        }
                    }
                    HStack(spacing: 5) {
                        Spacer()
                        Text("Meno")
                        ForEach(0..<5, id: \.self) { i in
                            RoundedRectangle(cornerRadius: 2).fill(Tinta.sodio.opacity(0.12 + Double(i) * 0.22))
                                .frame(width: 9, height: 7)
                        }
                        Text("Più ore")
                    }
                    .font(.system(size: 9)).foregroundStyle(Tinta.seconda).padding(.top, 5)
                }
                if let f = p.heatFrase { Mancano(frase: f) }
            } else {
                Mancano(frase: "La mappa delle ore non è arrivata.")
            }
        }
    }
}

/// Each row owns its label, value and track: no chart annotations can overlap text.
private struct BarList: View {
    var bars: [Pannelli.Bar]
    var color: Color

    var body: some View {
        let maximum = max(1, bars.map(\.value).max() ?? 1)
        VStack(spacing: 14) {
            ForEach(bars.indices, id: \.self) { i in
                let b = bars[i]
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(b.label).foregroundStyle(Tinta.testo).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 4)
                        Text(b.text).foregroundStyle(Tinta.seconda).monospacedDigit().fixedSize()
                    }
                    .font(.system(size: 11))
                    GeometryReader { geo in
                        Capsule().fill(color.opacity(0.10))
                        Capsule().fill(LinearGradient(colors: [color.opacity(0.55), color], startPoint: .leading, endPoint: .trailing))
                            .frame(width: max(3, geo.size.width * b.value / maximum))
                    }
                    .frame(height: 5)
                }
                .accessibilityElement(children: .combine)
            }
        }
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
                    .frame(height: min(300, CGFloat(model.pannelli.progetti.count) * 34))
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
            .padding(.vertical, 8)
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
    var scene: SkyScene
    var selected: Int?
    var hovered: Int?
    var field: CGRect
    var big: Bool

    var body: some View {
        let labels = SkyLabelLayout.place(scene: scene, field: field, selected: selected, hovered: hovered, big: big)
        ZStack(alignment: .topLeading) {
            ForEach(labels) { label in
                Text(label.text)
                    .font(.system(size: big ? 16 : 11, weight: .medium))
                    .foregroundStyle(label.focused ? Tinta.testo : Tinta.testo.opacity(0.78))
                    .lineLimit(1).truncationMode(.middle)
                    .padding(.horizontal, 8)
                    .frame(width: label.frame.width, height: label.frame.height)
                    .background(rc(Roque.zenit, label.focused ? 0.94 : 0.62), in: Capsule())
                    .overlay(Capsule().strokeBorder(Tinta.focus.opacity(label.focused ? 0.4 : 0)))
                    .position(x: label.frame.midX, y: label.frame.midY)
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
