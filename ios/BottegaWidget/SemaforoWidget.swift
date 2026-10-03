//
//  SemaforoWidget.swift
//  Bottega per iPhone, estensione dei widget
//
//  Il widget «Semaforo»: i rossi, i gialli e i verdi della Vedetta e il primo rosso in una riga. Legge
//  GET /v1/stanza?nome=vedetta (docs/CONTRATTI.md, 9.6) con DatiWidget; il Mac lo sveglia con la push dei widget
//  quando un progetto passa a rosso (9.4).
//

import SwiftUI
import WidgetKit

struct VoceSemaforo: TimelineEntry {
    let date: Date
    let letto: Letto<DatiSemaforo>

    static var esempio: VoceSemaforo {
        let d = DatiSemaforo(aggiornatoAt: Date().timeIntervalSince1970 * 1000, conti: .init(rosso: 1, giallo: 3, verde: 38), globali: [],
                             progetti: [.init(nome: "Lanterna", livello: "rosso", regole: [.init(id: "segreti", livello: "rosso", frase: "Una chiave nei commit da spingere.")])])
        return VoceSemaforo(date: .now, letto: Letto(dati: d, visto: .now, fonte: .diretta, errore: nil))
    }
}

struct FornitoreSemaforo: TimelineProvider {
    func placeholder(in context: Context) -> VoceSemaforo { .esempio }

    func getSnapshot(in context: Context, completion: @escaping (VoceSemaforo) -> Void) {
        if context.isPreview {
            completion(DatiWidget.copia(DatiSemaforo.self, stanza: "vedetta").map { VoceSemaforo(date: .now, letto: $0) } ?? .esempio)
            return
        }
        Task { completion(VoceSemaforo(date: .now, letto: await DatiWidget.leggi(DatiSemaforo.self, stanza: "vedetta"))) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<VoceSemaforo>) -> Void) {
        Task {
            let l = await DatiWidget.leggi(DatiSemaforo.self, stanza: "vedetta")
            completion(Timeline(entries: [VoceSemaforo(date: .now, letto: l)], policy: .after(Date().addingTimeInterval(30 * 60))))
        }
    }
}

struct SemaforoWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: TipiWidget.semaforo, provider: FornitoreSemaforo()) { voce in
            VistaSemaforo(voce: voce)
                .widgetURL(URL(string: "bottega://stanze?nome=vedetta"))
        }
        .configurationDisplayName("Semaforo")
        .description("I rossi, i gialli e i verdi della Vedetta, e il primo rosso.")
        .supportedFamilies([.systemSmall, .accessoryCircular])
        .pushHandler(SpintaWidget.self)
    }
}

struct VistaSemaforo: View {
    let voce: VoceSemaforo
    @Environment(\.widgetFamily) private var famiglia

    var body: some View {
        Group {
            if famiglia == .accessoryCircular {
                SemaforoTondo(voce: voce)
            } else if let d = voce.letto.dati {
                SemaforoPiccolo(voce: voce, d: d)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    TestataWidget(titolo: "Vedetta")
                    VuotoWidget(fonte: voce.letto.fonte, errore: voce.letto.errore)
                }
            }
        }
        .sfondoBottega(famiglia)
    }
}

/// Una luce del semaforo: accesa se c'e' almeno un progetto di quel colore, con il numero dentro.
private struct Luce: View {
    let colore: Color
    let n: Int
    var accesa: Bool { n > 0 }

    var body: some View {
        ZStack {
            Circle()
                .fill(accesa ? AnyShapeStyle(RadialGradient(colors: [colore.opacity(0.95), colore.opacity(0.55)], center: UnitPoint(x: 0.4, y: 0.35), startRadius: 0, endRadius: 22))
                             : AnyShapeStyle(colore.opacity(0.12)))
                .overlay(Circle().strokeBorder(colore.opacity(accesa ? 0.8 : 0.3), lineWidth: 0.8))
                .shadow(color: accesa ? colore.opacity(0.55) : .clear, radius: 6)
            Text("\(n)")
                .font(.system(size: 16, weight: .bold, design: .rounded))
                .monospacedDigit()
                .contentTransition(.numericText(value: Double(n)))
                .foregroundStyle(accesa ? Tinte.notteFonda : colore.opacity(0.6))
                .minimumScaleFactor(0.5)
        }
        .frame(width: 36, height: 36)
        .widgetAccentable(accesa && colore == Tinte.rosso)
    }
}

private struct SemaforoPiccolo: View {
    let voce: VoceSemaforo
    let d: DatiSemaforo

    var body: some View {
        let rossi = Int(d.conti.rosso)
        VStack(alignment: .leading, spacing: 6) {
            TestataWidget(titolo: "Vedetta", acceso: rossi > 0)
            Spacer(minLength: 0)
            HStack(spacing: 0) {
                Luce(colore: Tinte.rosso, n: rossi)
                Spacer(minLength: 0)
                Luce(colore: Tinte.ambra, n: Int(d.conti.giallo))
                Spacer(minLength: 0)
                Luce(colore: Tinte.verde, n: Int(d.conti.verde))
            }
            .padding(.horizontal, 2)
            Spacer(minLength: 0)
            if let r = d.primoRosso {
                // la frase della regola se ci sta intera; altrimenti chi e' in rosso, e la frase si legge nella Vedetta
                ViewThatFits(in: .vertical) {
                    rosso(r.chi, frase: r.frase)
                    rosso(r.chi, frase: r.chi == nil ? "Una regola rossa per tutti i progetti." : (rossi == 1 ? "Una regola rossa." : "E altri \(rossi - 1) in rosso."))
                }
            } else {
                Text(d.conti.giallo > 0 ? "Nessun rosso. I gialli possono aspettare." : "Tutto in ordine.")
                    .font(.caption2)
                    .foregroundStyle(Tinte.verde)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if voce.letto.fonte == .salvata { EtaWidget(visto: voce.letto.visto, fonte: voce.letto.fonte) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func rosso(_ chi: String?, frase: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            if let chi {
                Text(chi)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Tinte.rosso)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            Text(frase)
                .font(.caption2)
                .foregroundStyle(Tinte.testo)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Schermata di blocco: l'anello e' la parte verde dei progetti, al centro i rossi (o il segno di spunta).
private struct SemaforoTondo: View {
    let voce: VoceSemaforo

    var body: some View {
        if let d = voce.letto.dati {
            let rossi = Int(d.conti.rosso)
            let totale = max(1, d.conti.rosso + d.conti.giallo + d.conti.verde)
            Gauge(value: d.conti.verde, in: 0...totale) {
                Image(systemName: "light.beacon.max")
            } currentValueLabel: {
                if rossi > 0 {
                    Text("\(rossi)")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .widgetAccentable()
                } else {
                    Image(systemName: "checkmark")
                        .font(.system(size: 16, weight: .bold))
                }
            }
            .gaugeStyle(.accessoryCircularCapacity)
            .accessibilityLabel(rossi > 0 ? "\(rossi) progetti in rosso" : "Nessun progetto in rosso")
        } else {
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: voce.letto.fonte == .scollegato ? "laptopcomputer.slash" : "light.beacon.min")
                    .font(.title3)
            }
        }
    }
}

// MARK: - anteprime (dati di fantasia)

#Preview("Piccolo", as: .systemSmall) {
    SemaforoWidget()
} timeline: {
    VoceSemaforo.esempio
}

#Preview("Tondo", as: .accessoryCircular) {
    SemaforoWidget()
} timeline: {
    VoceSemaforo.esempio
}
