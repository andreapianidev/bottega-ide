//
//  AttivitaWidget.swift
//  Bottega per iPhone, estensione dei widget
//
//  La Live Activity delle sessioni Claude (attributi BottegaAttivita, docs/CONTRATTI.md, 9.4): schermata di blocco e
//  Dynamic Island. La avvia e la aggiorna il Mac con le push; i tempi scorrono da soli, senza aggiornamenti.
//  Compatta: la sferetta e «2 al lavoro»; ambra con «1 ti aspetta» quando qualcuno aspetta.
//

import ActivityKit
import SwiftUI
import WidgetKit

struct AttivitaWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BottegaAttivita.self) { context in
            SchermataDiBlocco(stato: context.state, mac: context.attributes.mac, vecchia: context.isStale)
                .activityBackgroundTint(Tinte.notteFonda.opacity(0.92))
                .activitySystemActionForegroundColor(Tinte.testo)
                .widgetURL(Pezzi.lavori)
        } dynamicIsland: { context in
            let s = context.state
            let aspetta = s.tiAspetta > 0
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 7) {
                        Sferetta(aspetta: aspetta, lavora: s.inCorso > 0, diametro: 22)
                        Text("Bottega")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Tinte.testo)
                            .lineLimit(1)
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Conti(stato: s)
                        .font(.subheadline.weight(.semibold))
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 6) {
                        ForEach(Array(s.righe.prefix(3).enumerated()), id: \.offset) { _, r in
                            RigaAttivita(riga: r)
                        }
                        if s.righe.isEmpty {
                            Text("Nessuna sessione al lavoro")
                                .font(.footnote)
                                .foregroundStyle(Tinte.tinta)
                        }
                    }
                    .padding(.horizontal, 4)
                    .padding(.top, 4)
                }
            } compactLeading: {
                Sferetta(aspetta: aspetta, lavora: s.inCorso > 0, diametro: 16)
                    .padding(.leading, 2)
            } compactTrailing: {
                Text(aspetta ? Pezzi.aspetta(s.tiAspetta) : Pezzi.alLavoro(s.inCorso))
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(aspetta ? Tinte.ambra : Tinte.testo)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .contentTransition(.numericText())
            } minimal: {
                ZStack {
                    Sferetta(aspetta: aspetta, lavora: s.inCorso > 0, diametro: 18)
                    if aspetta {
                        Text("\(s.tiAspetta)")
                            .font(.system(size: 10, weight: .bold, design: .rounded))
                            .foregroundStyle(Tinte.notteFonda)
                    }
                }
            }
            .widgetURL(Pezzi.lavori)
            .keylineTint(aspetta ? Tinte.ambra : Tinte.tinta)
        }
    }
}

/// «1 ti aspetta» in ambra e «2 al lavoro», uno sotto l'altro quando ci sono tutti e due.
private struct Conti: View {
    let stato: BottegaAttivita.ContentState

    var body: some View {
        VStack(alignment: .trailing, spacing: 1) {
            if stato.tiAspetta > 0 {
                Text(Pezzi.aspetta(stato.tiAspetta))
                    .foregroundStyle(Tinte.ambra)
            }
            if stato.tiAspetta == 0 {
                Text(Pezzi.alLavoro(stato.inCorso))
                    .foregroundStyle(Tinte.testo)
            } else if stato.inCorso > 0 {
                Text(Pezzi.alLavoro(stato.inCorso))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Tinte.tinta)
            }
        }
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
}

/// Una sessione: il punto del colore dello stato, il progetto, lo stato e da quanto.
private struct RigaAttivita: View {
    let riga: BottegaAttivita.ContentState.Riga

    var body: some View {
        let colore = Pezzi.colore(riga.stato)
        HStack(spacing: 8) {
            Circle()
                .fill(colore)
                .frame(width: 7, height: 7)
            Text(riga.progetto)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Tinte.testo)
                .lineLimit(1)
            Text(riga.stato)
                .font(.caption)
                .foregroundStyle(riga.stato == "ti aspetta" ? Tinte.ambra : Tinte.tinta)
                .lineLimit(1)
                .layoutPriority(-1)
            Spacer(minLength: 6)
            Pezzi.daQuanto(Pezzi.data(riga.da))
                .font(.caption)
                .foregroundStyle(Tinte.tinta)
        }
    }
}

private struct SchermataDiBlocco: View {
    let stato: BottegaAttivita.ContentState
    let mac: String
    let vecchia: Bool

    var body: some View {
        let aspetta = stato.tiAspetta > 0
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 9) {
                Sferetta(aspetta: aspetta, lavora: stato.inCorso > 0, diametro: 26)
                VStack(alignment: .leading, spacing: 0) {
                    Text("Bottega")
                        .font(.headline)
                        .foregroundStyle(Tinte.testo)
                    Text(vecchia ? "\(mac), il Mac non aggiorna da un po'" : mac)
                        .font(.caption)
                        .foregroundStyle(vecchia ? Tinte.rosso : Tinte.tinta)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Conti(stato: stato)
                    .font(.subheadline.weight(.semibold))
            }
            if !stato.righe.isEmpty {
                VStack(spacing: 6) {
                    ForEach(Array(stato.righe.prefix(3).enumerated()), id: \.offset) { _, r in
                        RigaAttivita(riga: r)
                    }
                }
                .padding(.leading, 2)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

#Preview("Schermata di blocco", as: .content, using: BottegaAttivita(mac: "Mac")) {
    AttivitaWidget()
} contentStates: {
    BottegaAttivita.ContentState.esempio(aspetta: 1)
    BottegaAttivita.ContentState.esempio(aspetta: 0)
}

#Preview("Isola compatta", as: .dynamicIsland(.compact), using: BottegaAttivita(mac: "Mac")) {
    AttivitaWidget()
} contentStates: {
    BottegaAttivita.ContentState.esempio(aspetta: 1)
    BottegaAttivita.ContentState.esempio(aspetta: 0)
}

#Preview("Isola aperta", as: .dynamicIsland(.expanded), using: BottegaAttivita(mac: "Mac")) {
    AttivitaWidget()
} contentStates: {
    BottegaAttivita.ContentState.esempio(aspetta: 1)
}

extension BottegaAttivita.ContentState {
    /// Solo per le anteprime di Xcode: progetti di fantasia.
    static func esempio(aspetta: Int) -> Self {
        let ora = Date().timeIntervalSince1970 * 1000
        var righe = [Riga(progetto: "Bottega", stato: "in corso", da: ora - 24 * 60_000),
                     Riga(progetto: "Appunti", stato: "in corso", da: ora - 75 * 60_000)]
        if aspetta > 0 { righe.insert(Riga(progetto: "Sito", stato: "ti aspetta", da: ora - 6 * 60_000), at: 0) }
        return Self(inCorso: 2, tiAspetta: aspetta, vive: 2 + aspetta, righe: righe, aggiornato: ora)
    }
}
