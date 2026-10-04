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
                .activityBackgroundTint(Tinte.notteFonda)
                .activitySystemActionForegroundColor(Tinte.testo)
                .widgetURL(Pezzi.lavori)
        } dynamicIsland: { context in
            let s = context.state
            let aspetta = s.tiAspetta > 0
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 7) {
                        SferaFoto(aspetta: aspetta, lavora: s.inCorso > 0, diametro: 22)
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
                    IsolaSotto(stato: s)
                }
            } compactLeading: {
                SferaFoto(aspetta: aspetta, lavora: s.inCorso > 0, diametro: 16)
                    .padding(.leading, 2)
            } compactTrailing: {
                IsolaDestra(stato: s)
            } minimal: {
                ZStack {
                    SferaFoto(aspetta: aspetta, lavora: s.inCorso > 0, diametro: 18)
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

/// La sfera di Melissa nella Live Activity: una fotografia della sfera Metal dell'app (stesso renderer del Nucleo, in
/// modalita' piccola, toni ridotti per uno schermo normale), perche' una Live Activity non esegue Metal. Tre stati:
/// a riposo (ardesia, nessuno al lavoro), al lavoro (acqua) e «ti aspetta» (ambra fatta apposta: nell'app l'ambra
/// della sfera e' l'errore, qui no). L'immagine ha l'alone attorno: la sfera occupa circa l'80% del lato, quindi il
/// riquadro e' un po' piu' grande del diametro. Le immagini sono 96 px (3x di 32 punti), circa 15 KB l'una.
struct SferaFoto: View {
    var aspetta: Bool
    var lavora: Bool = true
    var diametro: CGFloat = 16

    var body: some View {
        Image(aspetta ? "SferaAspetta" : lavora ? "SferaLavoro" : "SferaRiposo")
            .resizable()
            .interpolation(.high)
            .scaledToFit()
            .frame(width: diametro * 1.2, height: diametro * 1.2)
    }
}

/// L'Isola compatta, a destra: «1 ti aspetta» o «2 al lavoro»; se la frase non ci sta, il simbolo e il numero.
struct IsolaDestra: View {
    let stato: BottegaAttivita.ContentState

    var body: some View {
        let aspetta = stato.tiAspetta > 0
        let n = aspetta ? stato.tiAspetta : stato.inCorso
        ViewThatFits(in: .horizontal) {
            Text(aspetta ? Pezzi.aspetta(n) : Pezzi.alLavoro(n)).fixedSize()
            HStack(spacing: 3) {
                Image(systemName: aspetta ? "hand.raised.fill" : "hammer.fill")
                Text("\(n)").contentTransition(.numericText(value: Double(n)))
            }
            .fixedSize()
        }
        .font(.caption.weight(.semibold))
        .monospacedDigit()
        .foregroundStyle(aspetta ? Tinte.ambra : Tinte.testo)
        .lineLimit(1)
    }
}

/// L'Isola aperta, sotto: la sessione seguita e le prime sessioni.
struct IsolaSotto: View {
    let stato: BottegaAttivita.ContentState

    var body: some View {
        VStack(spacing: 6) {
            if let seg = stato.segui { RigaSeguita(segui: seg) }
            ForEach(Array(stato.righe.prefix(stato.segui == nil ? 3 : 2).enumerated()), id: \.offset) { _, r in
                RigaAttivita(riga: r)
            }
            if stato.righe.isEmpty {
                Text("Nessuna sessione al lavoro")
                    .font(.footnote)
                    .foregroundStyle(Tinte.tinta)
            }
        }
        .padding(.horizontal, 4)
        .padding(.top, 4)
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

/// La sessione seguita dall'iPhone, in testa: il progetto e il suo ultimo passo («modifica ponte.ts»).
private struct RigaSeguita: View {
    let segui: BottegaAttivita.ContentState.Segui

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "eye")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Pezzi.colore(segui.stato))
            // il progetto e il passo; se non ci stanno insieme si accorcia il progetto, il passo e' la notizia.
            // Solo per la Dynamic Island: la schermata di blocco ha le sue righe (SeguitaBlocco, issue #1).
            Text(segui.progetto)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Tinte.testo)
                .lineLimit(1)
            Text(segui.passo)
                .font(.caption)
                .foregroundStyle(segui.stato == "ti aspetta" ? Tinte.ambra : Tinte.tinta)
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(1)
            Spacer(minLength: 0)
        }
        .padding(.leading, 2)
    }
}

/// Una sessione: il punto del colore dello stato, il progetto, lo stato (se ci sta: il colore del punto lo dice gia')
/// e da quanto.
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
                .minimumScaleFactor(0.8)
                .layoutPriority(1)
            // lo stato cede per primo (il colore del punto lo dice gia'); solo per l'isola, vedi RigaBlocco (issue #1)
            Text(riga.stato)
                .font(.caption)
                .foregroundStyle(riga.stato == "ti aspetta" ? Tinte.ambra : Tinte.tinta)
                .lineLimit(1)
                .layoutPriority(-1)
            Spacer(minLength: 6)
            Pezzi.daQuanto(Pezzi.data(riga.da))
                .font(.caption)
                .foregroundStyle(Tinte.tinta)
                .lineLimit(1)
                .fixedSize()
        }
    }
}

/// La schermata di blocco ha al massimo 160 punti di altezza: tre sessioni, due se c'e' quella seguita.
/// La schermata di blocco (issue #1). Dalla build 62 alla 75 qui si vedeva solo nero, mentre la Dynamic Island
/// funzionava; la riga sola della 76 si vedeva. Questa e' la vista di prima del commit 2b6fa49 (l'ultima che si
/// vedeva), con le righe tutte sue: niente ViewThatFits, niente .fixedSize ne' .minimumScaleFactor sul testo che
/// scorre, il tempo con due campi. Sono le cose che quel commit aveva aggiunto e che la Dynamic Island regge ma la
/// schermata di blocco no. Le righe di qui non si mescolano con quelle dell'isola (RigaAttivita, RigaSeguita):
/// chi le ritocca per l'isola non deve rompere la schermata di blocco.
private struct SchermataDiBlocco: View {
    let stato: BottegaAttivita.ContentState
    let mac: String
    let vecchia: Bool

    var body: some View {
        let aspetta = stato.tiAspetta > 0
        // al massimo 160 punti: tre sessioni, due se c'e' quella seguita
        let quante = stato.segui == nil ? 3 : 2
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 9) {
                SferaFoto(aspetta: aspetta, lavora: stato.inCorso > 0, diametro: 26)
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
            if let seg = stato.segui { SeguitaBlocco(segui: seg) }
            if stato.righe.isEmpty {
                if stato.segui == nil {
                    Text("Nessuna sessione al lavoro")
                        .font(.footnote)
                        .foregroundStyle(Tinte.tinta)
                }
            } else {
                VStack(spacing: 6) {
                    ForEach(Array(stato.righe.prefix(quante).enumerated()), id: \.offset) { _, r in
                        RigaBlocco(riga: r)
                    }
                }
                .padding(.leading, 2)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

/// La sessione seguita, sulla schermata di blocco: come prima di 2b6fa49.
private struct SeguitaBlocco: View {
    let segui: BottegaAttivita.ContentState.Segui

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "eye")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Pezzi.colore(segui.stato))
            Text(segui.progetto)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Tinte.testo)
                .lineLimit(1)
            Text(segui.passo)
                .font(.caption)
                .foregroundStyle(segui.stato == "ti aspetta" ? Tinte.ambra : Tinte.tinta)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .padding(.leading, 2)
    }
}

/// Una sessione sulla schermata di blocco: il punto del colore dello stato, il progetto, lo stato e da quanto. Come
/// prima di 2b6fa49: il tempo con due campi e senza .fixedSize.
private struct RigaBlocco: View {
    let riga: BottegaAttivita.ContentState.Riga

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Pezzi.colore(riga.stato))
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
            Text(.currentDate, format: .offset(to: Pezzi.data(riga.da), allowedFields: [.day, .hour, .minute], maxFieldCount: 2, sign: .never))
                .monospacedDigit()
                .font(.caption)
                .foregroundStyle(Tinte.tinta)
        }
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
