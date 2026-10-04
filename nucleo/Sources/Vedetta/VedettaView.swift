import AppKit
import Observation
import SwiftUI

@MainActor
@Observable
final class VedettaModel {
    var data = VedettaData()
    var islandPoints: [VedettaIslandPoint] = []
    var selectedPath: String?
    var hoveredPath: String?
    var query = ""

    var focused: VedettaData.Project? {
        guard let selectedPath else { return nil }
        return data.projects.first { $0.path == selectedPath }
    }

    var hovered: VedettaData.Project? {
        guard let hoveredPath else { return nil }
        return data.projects.first { $0.path == hoveredPath }
    }

    var ordered: [VedettaData.Project] {
        let rank = ["rosso": 0, "giallo": 1, "sconosciuto": 2, "verde": 3]
        return data.projects.sorted {
            let a = rank[$0.level] ?? 2, b = rank[$1.level] ?? 2
            return a == b ? $0.name.localizedStandardCompare($1.name) == .orderedAscending : a < b
        }
    }

    var filtered: [VedettaData.Project] {
        query.isEmpty ? ordered : ordered.filter { $0.name.localizedStandardContains(query) }
    }

    func apply(_ next: VedettaData) {
        data = next
        islandPoints = next.islandPoints
        if let selectedPath, !next.projects.contains(where: { $0.path == selectedPath }) { self.selectedPath = nil }
    }
}

private enum VedettaInk {
    static let night = color(0x070b17)
    static let basalt = color(0x121a2e)
    static let line = color(0x354261)
    static let text = color(0xe8e2d0)
    static let muted = color(0x9ba8bc)
    static let red = color(0xf2607a)
    static let yellow = color(0xf4ab3c)
    static let green = color(0x74b98f)
    static let unknown = color(0x9cc2ff)

    static func color(_ hex: Int) -> Color {
        Color(.sRGB, red: Double((hex >> 16) & 255) / 255,
              green: Double((hex >> 8) & 255) / 255,
              blue: Double(hex & 255) / 255, opacity: 1)
    }

    static func level(_ value: String) -> Color {
        switch value {
        case "rosso": red
        case "giallo": yellow
        case "verde": green
        default: unknown
        }
    }

    static func label(_ value: String) -> String {
        switch value {
        case "rosso": "Da sistemare subito"
        case "giallo": "Da sistemare"
        case "verde": "In regola"
        default: "Da verificare"
        }
    }

    static func symbol(_ value: String) -> String {
        switch value {
        case "rosso": "diamond.fill"
        case "giallo": "circle.fill"
        case "verde": "circle"
        default: "circle.dotted"
        }
    }
}

struct VedettaView: View {
    @Bindable var model: VedettaModel

    var body: some View {
        HStack(spacing: 0) {
            island
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            sidebar
                .frame(width: 342)
        }
        .background(VedettaInk.night)
        .foregroundStyle(VedettaInk.text)
        .environment(\.colorScheme, .dark)
    }

    private var island: some View {
        ZStack(alignment: .topLeading) {
            VedettaIslandView(points: model.islandPoints, selected: model.selectedPath,
                              onHover: { model.hoveredPath = $0 },
                              onSelect: { model.selectedPath = $0 })
                .ignoresSafeArea()

            LinearGradient(colors: [VedettaInk.night.opacity(0.88), .clear], startPoint: .top, endPoint: .bottom)
                .frame(height: 176)
                .allowsHitTesting(false)

            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("La Vedetta")
                            .font(.system(size: 38, weight: .regular, design: .serif))
                            .tracking(-1.1)
                        Text("Un'isola, un faro per progetto")
                            .font(.system(size: 13))
                            .foregroundStyle(VedettaInk.muted)
                    }
                    Spacer()
                    Text("\(model.data.projects.count) progetti")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(VedettaInk.muted)
                        .padding(.top, 15)
                }

                Spacer()

                if let hovered = model.hovered, hovered.path != model.selectedPath {
                    HStack(spacing: 9) {
                        Image(systemName: VedettaInk.symbol(hovered.level))
                            .foregroundStyle(VedettaInk.level(hovered.level))
                        Text(hovered.name).font(.system(size: 17, weight: .medium, design: .serif))
                        Text(VedettaInk.label(hovered.level))
                            .font(.system(size: 12))
                            .foregroundStyle(VedettaInk.muted)
                    }
                    .padding(.bottom, 20)
                    .accessibilityElement(children: .combine)
                }

                HStack(spacing: 18) {
                    legend("Subito", count: model.data.counts.red, level: "rosso")
                    legend("Da sistemare", count: model.data.counts.yellow, level: "giallo")
                    legend("In regola", count: model.data.counts.green, level: "verde")
                    if model.data.counts.unknown > 0 { legend("Da verificare", count: model.data.counts.unknown, level: "sconosciuto") }
                }
                .padding(.vertical, 13)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(alignment: .top) { Rectangle().fill(VedettaInk.line).frame(height: 1) }
            }
            .padding(.horizontal, 31)
            .padding(.top, 29)

            if model.data.projects.isEmpty {
                VStack(spacing: 9) {
                    Text("L'isola aspetta i progetti")
                        .font(.system(size: 23, design: .serif))
                    Text("Apri la Bottega e avvia il controllo delle regole.")
                        .font(.system(size: 13))
                        .foregroundStyle(VedettaInk.muted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .allowsHitTesting(false)
            }
        }
    }

    private func legend(_ title: String, count: Int, level: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: VedettaInk.symbol(level)).foregroundStyle(VedettaInk.level(level))
            Text("\(count)").fontWeight(.semibold).monospacedDigit()
            Text(title).foregroundStyle(VedettaInk.muted)
        }
        .font(.system(size: 12))
        .accessibilityElement(children: .combine)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text("Progetti")
                    .font(.system(size: 23, weight: .regular, design: .serif))
                Spacer()
                Button {
                    Out.event("vedetta.refresh", [:])
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.plain)
                .help("Ricontrolla le regole")
                .accessibilityLabel("Ricontrolla le regole")
                .disabled(model.data.running)
            }
            .padding(.bottom, 11)

            Text(model.data.running ? "Controllo in corso…" : checkedLabel)
                .font(.system(size: 11))
                .foregroundStyle(VedettaInk.muted)
                .padding(.bottom, 20)

            if let selected = model.focused {
                selectedDetail(selected)
                    .padding(.bottom, 20)
            }

            TextField("Cerca progetto", text: $model.query)
                .textFieldStyle(.roundedBorder)
                .padding(.bottom, 14)

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(model.filtered) { project in
                        Button { model.selectedPath = project.path } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 9) {
                                Image(systemName: VedettaInk.symbol(project.level))
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(VedettaInk.level(project.level))
                                    .frame(width: 12)
                                Text(project.name)
                                    .font(.system(size: 13, weight: model.selectedPath == project.path ? .semibold : .regular))
                                    .lineLimit(1)
                                Spacer(minLength: 4)
                                if !project.hits.isEmpty {
                                    Text("\(project.hits.count)")
                                        .font(.system(size: 11, weight: .medium, design: .rounded))
                                        .monospacedDigit()
                                        .foregroundStyle(VedettaInk.muted)
                                }
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(model.selectedPath == project.path ? VedettaInk.line.opacity(0.7) : .clear)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(project.name), \(VedettaInk.label(project.level))")
                        Rectangle().fill(VedettaInk.line.opacity(0.55)).frame(height: 1)
                    }
                }
            }

            if !model.data.global.isEmpty {
                VStack(alignment: .leading, spacing: 7) {
                    Text("Regole comuni")
                        .font(.system(size: 16, design: .serif))
                    ForEach(model.data.global) { hit in
                        Text(hit.sentence).font(.system(size: 12)).foregroundStyle(VedettaInk.muted)
                    }
                }
                .padding(.top, 16)
            }
        }
        .padding(.top, 38)
        .padding(.horizontal, 20)
        .padding(.bottom, 24)
        .background(VedettaInk.basalt)
        .overlay(alignment: .leading) { Rectangle().fill(VedettaInk.line).frame(width: 1) }
    }

    private var checkedLabel: String {
        guard model.data.checkedAt > 0 else { return "Regole non ancora controllate" }
        return "Controllato " + Date(timeIntervalSince1970: model.data.checkedAt / 1000)
            .formatted(date: .abbreviated, time: .shortened)
    }

    private func selectedDetail(_ project: VedettaData.Project) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: VedettaInk.symbol(project.level))
                    .foregroundStyle(VedettaInk.level(project.level))
                Text(VedettaInk.label(project.level))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(VedettaInk.level(project.level))
            }
            Text(project.name)
                .font(.system(size: 21, design: .serif))
                .textSelection(.enabled)
            ForEach(Array(project.hits.prefix(3))) { hit in
                VStack(alignment: .leading, spacing: 4) {
                    Text(hit.sentence).font(.system(size: 12, weight: .medium))
                    if !hit.remedy.isEmpty {
                        Text(hit.remedy).font(.system(size: 11)).foregroundStyle(VedettaInk.muted)
                    }
                }
            }
            if project.hits.count > 3 {
                Text("Altre \(project.hits.count - 3) regole nella Bottega")
                    .font(.system(size: 11))
                    .foregroundStyle(VedettaInk.muted)
            }
            Button("Apri in Bottega") {
                Out.event("vedetta.project", ["path": project.path])
            }
            .buttonStyle(.borderedProminent)
            .tint(VedettaInk.line)
            .font(.system(size: 12))
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(VedettaInk.night.opacity(0.66), in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(VedettaInk.line))
    }
}
