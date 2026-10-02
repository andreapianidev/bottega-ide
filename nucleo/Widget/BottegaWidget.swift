//
//  BottegaWidget.swift
//  Bottega Nucleo, widget da scrivania
//
//  A WidgetKit extension (Contents/PlugIns/BottegaWidget.appex) with the rules traffic
//  light and the day's briefing, read from ~/.bottega/stato.json (docs/CONTRATTI.md, 4.6)
//  through a read-only home-relative sandbox exception. No network, no App Group: the
//  extension rewrites the file, the Nucleo asks WidgetKit to reload (widget.reload),
//  and the timeline refreshes by itself every 15 minutes anyway.
//

import SwiftUI
import WidgetKit

struct StatoEntry: TimelineEntry {
    let date: Date
    let stato: Stato
}

struct StatoProvider: TimelineProvider {
    func placeholder(in context: Context) -> StatoEntry {
        var s = Stato()
        s.present = true
        s.rosso = 0; s.giallo = 2; s.verde = 12
        s.briefing = "Buongiorno. Ieri quattro ore di lavoro, due lavori finiti, nessuna recensione nuova."
        return StatoEntry(date: Date(), stato: s)
    }

    func getSnapshot(in context: Context, completion: @escaping (StatoEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : StatoEntry(date: Date(), stato: Stato.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<StatoEntry>) -> Void) {
        let entry = StatoEntry(date: Date(), stato: Stato.load())
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(15 * 60))))
    }
}

// MARK: - Palette: the sodium lamps over the observatory (Bottega Notte)

private enum Palette {
    static let night = Color(red: 0.07, green: 0.07, blue: 0.10)
    static let sodium = Color(red: 1.00, green: 0.69, blue: 0.29)
    static let rosso = Color(red: 0.96, green: 0.33, blue: 0.29)
    static let giallo = Color(red: 0.98, green: 0.78, blue: 0.27)
    static let verde = Color(red: 0.42, green: 0.82, blue: 0.53)
    static let text = Color.white.opacity(0.92)
    static let dim = Color.white.opacity(0.55)
}

// MARK: - Views

struct Semaforo: View {
    let stato: Stato

    private var lit: Color {
        if stato.rosso > 0 { return Palette.rosso }
        if stato.giallo > 0 { return Palette.giallo }
        return Palette.verde
    }

    var body: some View {
        VStack(spacing: 5) {
            lamp(Palette.rosso, on: stato.rosso > 0)
            lamp(Palette.giallo, on: stato.rosso == 0 && stato.giallo > 0)
            lamp(Palette.verde, on: stato.rosso == 0 && stato.giallo == 0)
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 6)
        .background(Capsule().fill(Color.black.opacity(0.35)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(stato.rulesSentence)
    }

    private func lamp(_ color: Color, on: Bool) -> some View {
        Circle()
            .fill(on ? color : color.opacity(0.14))
            .frame(width: 14, height: 14)
            .shadow(color: on ? color.opacity(0.8) : .clear, radius: 5)
    }
}

struct Conteggi: View {
    let stato: Stato

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if !stato.present {
                Text("Nessuno stato").font(.headline).foregroundStyle(Palette.text)
                Text("Apri la Bottega una volta.").font(.caption).foregroundStyle(Palette.dim)
            } else if stato.rosso + stato.giallo == 0 {
                Text("Tutto in regola").font(.headline).foregroundStyle(Palette.text)
                Text(stato.verde == 1 ? "1 progetto" : "\(stato.verde) progetti")
                    .font(.caption).foregroundStyle(Palette.dim)
            } else {
                if stato.rosso > 0 {
                    Text(stato.rosso == 1 ? "1 rossa" : "\(stato.rosso) rosse")
                        .font(.headline).foregroundStyle(Palette.rosso)
                }
                if stato.giallo > 0 {
                    Text(stato.giallo == 1 ? "1 gialla" : "\(stato.giallo) gialle")
                        .font(stato.rosso > 0 ? .subheadline : .headline).foregroundStyle(Palette.giallo)
                }
                Text("regole da sistemare").font(.caption).foregroundStyle(Palette.dim)
            }
        }
    }
}

struct BottegaWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StatoEntry

    var body: some View {
        switch family {
        case .systemSmall: small
        case .systemLarge: large
        default: medium
        }
    }

    private var title: some View {
        Text("bottega")
            .font(.system(.caption2, design: .rounded).weight(.semibold))
            .foregroundStyle(Palette.sodium)
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 8) {
            title
            HStack(alignment: .center, spacing: 10) {
                Semaforo(stato: entry.stato)
                Conteggi(stato: entry.stato)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var medium: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                title
                Semaforo(stato: entry.stato)
                Spacer(minLength: 0)
            }
            VStack(alignment: .leading, spacing: 6) {
                Conteggi(stato: entry.stato)
                Text(briefingLine)
                    .font(.caption)
                    .foregroundStyle(Palette.text)
                    .lineLimit(4)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var large: some View {
        VStack(alignment: .leading, spacing: 10) {
            title
            HStack(alignment: .center, spacing: 12) {
                Semaforo(stato: entry.stato)
                Conteggi(stato: entry.stato)
            }
            ForEach(Array(entry.stato.voci.prefix(3).enumerated()), id: \.offset) { _, v in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Circle().fill(v.livello == "rosso" ? Palette.rosso : Palette.giallo).frame(width: 6, height: 6)
                    Text(v.progetto.isEmpty ? v.frase : "\(v.progetto): \(v.frase)")
                        .font(.caption).foregroundStyle(Palette.text).lineLimit(2)
                }
            }
            Divider().overlay(Palette.dim.opacity(0.4))
            Text("Briefing").font(.caption2.weight(.semibold)).foregroundStyle(Palette.sodium)
            Text(briefingLine)
                .font(.callout)
                .foregroundStyle(Palette.text)
                .lineLimit(8)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var briefingLine: String {
        if let b = entry.stato.briefing, !b.isEmpty { return b }
        return "Il briefing di oggi non c'è ancora."
    }
}

struct BottegaStatoWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.andreapiani.bottega.stato", provider: StatoProvider()) { entry in
            BottegaWidgetView(entry: entry)
                .containerBackground(for: .widget) {
                    LinearGradient(colors: [Palette.night, Color(red: 0.13, green: 0.10, blue: 0.09)],
                                   startPoint: .top, endPoint: .bottom)
                }
                .widgetURL(URL(string: "bottega://andreapiani.bottega-home/briefing"))
        }
        .configurationDisplayName("Bottega")
        .description("Il semaforo delle regole e il briefing del giorno.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

@main
struct BottegaWidgets: WidgetBundle {
    var body: some Widget {
        BottegaStatoWidget()
    }
}
