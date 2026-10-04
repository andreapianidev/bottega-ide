import SwiftUI
import WidgetKit

private struct Voce: TimelineEntry {
    let date: Date
    let istantanea: IstantaneaOrologio?
}

private struct Fornitore: TimelineProvider {
    func placeholder(in context: Context) -> Voce {
        Voce(date: .now, istantanea: .init(visto: .now, mac: "Mac", melissa: "idle",
                                          inCorso: 2, tiAspetta: 1, totale: 3, sessioni: []))
    }

    func getSnapshot(in context: Context, completion: @escaping (Voce) -> Void) {
        completion(Voce(date: .now, istantanea: IstantaneaOrologio.leggi()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Voce>) -> Void) {
        let voce = Voce(date: .now, istantanea: IstantaneaOrologio.leggi())
        completion(Timeline(entries: [voce], policy: .after(.now.addingTimeInterval(30 * 60))))
    }
}

private struct Faccia: View {
    @Environment(\.widgetFamily) private var famiglia
    let voce: Voce

    private var attesa: Int { voce.istantanea?.tiAspetta ?? 0 }
    private var attive: Int { voce.istantanea?.inCorso ?? 0 }
    private var numero: Int { attesa > 0 ? attesa : attive }

    var body: some View {
        Group {
            switch famiglia {
            case .accessoryCircular:
                VStack(spacing: 0) {
                    Image(systemName: attesa > 0 ? "hourglass" : "hammer.fill")
                        .font(.system(size: 10, weight: .bold))
                        .widgetAccentable()
                    Text(numero.formatted())
                        .font(.system(size: 25, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .minimumScaleFactor(0.7)
                }
            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 1) {
                    Text("BOTTEGA")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .tracking(1)
                        .widgetAccentable()
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(numero.formatted())
                            .font(.system(size: 27, weight: .bold, design: .rounded))
                            .monospacedDigit()
                        Text(attesa > 0 ? "in attesa" : "in corso")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    Text(voce.istantanea == nil ? "Apri su iPhone" : "\(attive) in corso · \(attesa) in attesa")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            case .accessoryInline:
                Label("Bottega: \(numero) \(attesa > 0 ? "in attesa" : "in corso")", systemImage: "hammer.fill")
            case .accessoryCorner:
                Text(numero.formatted())
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .widgetAccentable()
                    .widgetLabel { Text(attesa > 0 ? "In attesa" : "In corso") }
            default:
                Text(numero.formatted())
            }
        }
        .containerBackground(.black, for: .widget)
    }
}

@main
struct ComplicazioneBottega: Widget {
    let kind = "BottegaWatch"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Fornitore()) { Faccia(voce: $0) }
            .configurationDisplayName("Bottega")
            .description("Lavori in corso e in attesa sul Mac.")
            .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
    }
}

#Preview(as: .accessoryCircular) {
    ComplicazioneBottega()
} timeline: {
    Voce(date: .now, istantanea: .init(visto: .now, mac: "Mac", melissa: "idle",
                                      inCorso: 2, tiAspetta: 1, totale: 3, sessioni: []))
}
