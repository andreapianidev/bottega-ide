//
//  IconaWidget.swift
//  Bottega per iPhone, estensione dei widget
//
//  Il widget «Bottega»: l'icona dell'app, a tutta superficie, e basta. Toccandolo si apre l'app. Nessun dato e nessun
//  collegamento al Mac: una sola voce nella timeline, che non scade mai.
//

import SwiftUI
import WidgetKit

struct VoceIcona: TimelineEntry {
    let date: Date
}

struct FornitoreIcona: TimelineProvider {
    func placeholder(in context: Context) -> VoceIcona { VoceIcona(date: .now) }

    func getSnapshot(in context: Context, completion: @escaping (VoceIcona) -> Void) {
        completion(VoceIcona(date: .now))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<VoceIcona>) -> Void) {
        completion(Timeline(entries: [VoceIcona(date: .now)], policy: .never))
    }
}

struct IconaWidget: Widget {
    static let kind = "com.andreapiani.bottega.ios.widget.icona"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: FornitoreIcona()) { _ in
            VistaIcona()
        }
        .configurationDisplayName("Bottega")
        .description("L'icona della Bottega: toccala e si apre l'app.")
        .supportedFamilies([.systemSmall])
        .contentMarginsDisabled()
    }
}

struct VistaIcona: View {
    var body: some View {
        // l'icona e' il contenuto, non lo sfondo: con la Schermata Home colorata iOS toglie lo sfondo dei widget,
        // e l'icona deve restare a colori come quella dell'app
        Image("Icona")
            .resizable()
            .widgetAccentedRenderingMode(.fullColor)
            .scaledToFill()
            .accessibilityLabel("Bottega")
            .containerBackground(for: .widget) { Tinte.sfondo }
    }
}

#Preview(as: .systemSmall) {
    IconaWidget()
} timeline: {
    VoceIcona(date: .now)
}
