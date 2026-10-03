//
//  ConsigliWidget.swift
//  Bottega per iPhone, estensione dei widget
//
//  Il widget «Consigli»: la cosa piu' utile da fare adesso, in una frase, con il perche' e quanto vale. Le fonti, in
//  ordine, le mette insieme il Mac (GET /v1/stanza?nome=consigli, docs/CONTRATTI.md, 9.6): il buco piu' grosso
//  dell'App Store con la stima al mese, una regola rossa della Vedetta, chi ti aspetta, le cose da fare della
//  Memoria, i consigli della Home scritti da Apple Intelligence. Un tocco apre la stanza giusta; con piu' consigli
//  la freccia passa al successivo senza aprire l'app (ProssimoConsiglio, solo dalla copia: niente rete).
//

import AppIntents
import SwiftUI
import WidgetKit

// MARK: - il pulsante «poi»

enum ScorriConsigli {
    /// L'id del consiglio mostrato adesso, nelle preferenze del gruppo.
    static let chiave = "consiglioAttuale"
    /// Messo dal pulsante: il prossimo giro della timeline usa la copia e non chiede niente al Mac.
    static let soloCopia = "consiglioSoloCopia"

    /// Il consiglio da mostrare: quello scelto, se c'e' ancora, altrimenti il primo.
    static func attuale(_ elenco: [DatiConsigli.Consiglio]) -> Int {
        let id = Condiviso.preferenze.string(forKey: chiave)
        return elenco.firstIndex { $0.id == id } ?? 0
    }
}

struct ProssimoConsiglio: AppIntent {
    static let title: LocalizedStringResource = "Prossimo consiglio"
    static let description = IntentDescription("Passa al consiglio dopo nel widget della Bottega.")
    static let isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult {
        guard let c = CacheWidget.leggi("consigli"),
              let d = try? JSONDecoder().decode(DatiConsigli.self, from: c.dati), !d.consigli.isEmpty else { return .result() }
        let i = (ScorriConsigli.attuale(d.consigli) + 1) % d.consigli.count
        Condiviso.preferenze.set(d.consigli[i].id, forKey: ScorriConsigli.chiave)
        Condiviso.preferenze.set(true, forKey: ScorriConsigli.soloCopia)
        return .result()
    }
}

// MARK: - timeline

struct VoceConsigli: TimelineEntry {
    let date: Date
    let letto: Letto<DatiConsigli>

    var elenco: [DatiConsigli.Consiglio] { letto.dati?.consigli ?? [] }
    var indice: Int { ScorriConsigli.attuale(elenco) }

    static var esempio: VoceConsigli {
        let d = DatiConsigli(aggiornatoAt: Date().timeIntervalSince1970 * 1000, consigli: [
            .init(id: "a", fonte: "appstore", etichetta: "App Store", titolo: "Manca il consenso per gli annunci in Europa",
                  perche: "Senza consenso gli annunci in Europa rendono un terzo.", cosa: "Aggiungi il modulo del consenso.", valore: 38,
                  soggetto: "Marea", apri: "appstore"),
            .init(id: "b", fonte: "vedetta", etichetta: "Vedetta", titolo: "Tre commit da spingere da due giorni.",
                  perche: nil, cosa: "Spingili: esistono solo su questo Mac.", valore: nil, soggetto: "Lanterna", apri: "vedetta"),
            .init(id: "c", fonte: "lavori", etichetta: "Lavori", titolo: "Taccuino ti aspetta", perche: "Rivedere la pagina dei prezzi",
                  cosa: "Rispondi dalla scheda della sessione.", valore: nil, soggetto: "Taccuino", apri: "lavori"),
            .init(id: "d", fonte: "home", etichetta: "Apple Intelligence", titolo: "Chiudi oggi la pagina dei prezzi: è a un passo.",
                  perche: nil, cosa: nil, valore: nil, soggetto: nil, apri: "stanze"),
        ])
        return VoceConsigli(date: .now, letto: Letto(dati: d, visto: .now, fonte: .diretta, errore: nil))
    }
}

struct FornitoreConsigli: TimelineProvider {
    func placeholder(in context: Context) -> VoceConsigli { .esempio }

    func getSnapshot(in context: Context, completion: @escaping (VoceConsigli) -> Void) {
        if context.isPreview {
            completion(DatiWidget.copia(DatiConsigli.self, stanza: "consigli").map { VoceConsigli(date: .now, letto: $0) } ?? .esempio)
            return
        }
        Task { completion(await Self.leggi()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<VoceConsigli>) -> Void) {
        Task {
            let voce = await Self.leggi()
            completion(Timeline(entries: [voce], policy: .after(Date().addingTimeInterval(30 * 60))))
        }
    }

    static func leggi() async -> VoceConsigli {
        let solo = Condiviso.preferenze.bool(forKey: ScorriConsigli.soloCopia)
        if solo { Condiviso.preferenze.set(false, forKey: ScorriConsigli.soloCopia) }
        let l = await DatiWidget.leggi(DatiConsigli.self, stanza: "consigli", soloCopia: solo)
        return VoceConsigli(date: .now, letto: l)
    }
}

// MARK: - widget

struct ConsigliWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: TipiWidget.consigli, provider: FornitoreConsigli()) { voce in
            VistaConsigli(voce: voce)
        }
        .configurationDisplayName("Consigli")
        .description("La cosa più utile da fare adesso, con il perché e quanto vale.")
        .supportedFamilies([.systemMedium, .systemLarge])
        .pushHandler(SpintaWidget.self)
    }
}

/// Come si presenta ogni fonte: simbolo e colore.
private enum Aspetto {
    static func simbolo(_ fonte: String) -> String {
        switch fonte {
        case "appstore": "eurosign"
        case "vedetta": "light.beacon.max.fill"
        case "lavori": "hand.raised.fill"
        case "dafare": "checklist"
        default: "sparkles"
        }
    }

    static func colore(_ fonte: String) -> Color {
        switch fonte {
        case "appstore": ColoriWidget.admob
        case "vedetta": Tinte.rosso
        case "lavori": Tinte.ambra
        case "dafare": Tinte.verde
        default: ColoriWidget.cielo
        }
    }

    /// Dove porta un tocco: la stanza della plancia, i Lavori o le Stanze.
    static func url(_ c: DatiConsigli.Consiglio) -> URL {
        switch c.apri {
        case "lavori": URL(string: "bottega://lavori")!
        case "appstore", "vedetta", "dafare", "cruscotto", "notte":
            URL(string: "bottega://stanze?nome=\(c.apri)")!
        default: URL(string: "bottega://stanze")!
        }
    }
}

struct VistaConsigli: View {
    let voce: VoceConsigli
    @Environment(\.widgetFamily) private var famiglia

    var body: some View {
        Group {
            if voce.letto.dati == nil {
                VStack(alignment: .leading, spacing: 6) {
                    TestataWidget(titolo: "Consigli")
                    VuotoWidget(fonte: voce.letto.fonte, errore: voce.letto.errore)
                }
            } else if voce.elenco.isEmpty {
                TuttoInOrdine(voce: voce)
            } else if famiglia == .systemLarge {
                ConsigliGrande(voce: voce)
            } else {
                ConsigliMedio(voce: voce)
            }
        }
        .widgetURL(voce.elenco.isEmpty ? URL(string: "bottega://stanze") : Aspetto.url(voce.elenco[voce.indice]))
        .sfondoBottega(famiglia)
    }
}

/// Il simbolo della fonte in un tondo del suo colore.
private struct Bollo: View {
    let fonte: String
    var lato: CGFloat = 22

    var body: some View {
        let colore = Aspetto.colore(fonte)
        Image(systemName: Aspetto.simbolo(fonte))
            .font(.system(size: lato * 0.48, weight: .semibold))
            .foregroundStyle(colore)
            .frame(width: lato, height: lato)
            .background(Circle().fill(colore.opacity(0.16)))
            .overlay(Circle().strokeBorder(colore.opacity(0.45), lineWidth: 0.5))
            .widgetAccentable()
    }
}

/// «1 di 4» e la freccia che passa al prossimo.
private struct Scorri: View {
    let indice: Int
    let totale: Int

    var body: some View {
        if totale > 1 {
            HStack(spacing: 6) {
                Text("\(indice + 1) di \(totale)")
                    .font(.caption2)
                    .foregroundStyle(Tinte.tinta)
                    .monospacedDigit()
                    .contentTransition(.numericText(value: Double(indice)))
                Button(intent: ProssimoConsiglio()) {
                    Image(systemName: "arrow.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Tinte.testo)
                        .frame(width: 26, height: 26)
                        .background(Circle().fill(Tinte.bordo))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Prossimo consiglio")
            }
        }
    }
}

/// Quanto vale, in ambra: «≈ 38 € al mese».
private struct Valore: View {
    let euro: Double

    var body: some View {
        Text("≈ \(FormatiWidget.euro(euro)) al mese")
            .font(.caption.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(Tinte.ambra)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(Tinte.ambra.opacity(0.14)))
            .widgetAccentable()
    }
}

/// La riga sopra la frase: la fonte e di chi parla.
private struct Provenienza: View {
    let c: DatiConsigli.Consiglio

    var body: some View {
        Text(c.soggetto.map { "\(c.etichetta), \($0)" } ?? c.etichetta)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Aspetto.colore(c.fonte))
            .lineLimit(1)
    }
}

private struct ConsigliMedio: View {
    let voce: VoceConsigli

    var body: some View {
        let c = voce.elenco[voce.indice]
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 7) {
                Bollo(fonte: c.fonte)
                Provenienza(c: c)
                Spacer(minLength: 4)
                Scorri(indice: voce.indice, totale: voce.elenco.count)
            }
            Text(c.titolo)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Tinte.testo)
                .lineLimit(2)
                .minimumScaleFactor(0.85)
                .padding(.top, 2)
            if let sotto = c.perche ?? c.cosa {
                Text(sotto)
                    .font(.caption)
                    .foregroundStyle(Tinte.tinta)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            HStack(alignment: .center) {
                if let v = c.valore, v >= 1 { Valore(euro: v) }
                Spacer(minLength: 0)
                EtaWidget(visto: voce.letto.visto, fonte: voce.letto.fonte)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct ConsigliGrande: View {
    let voce: VoceConsigli

    var body: some View {
        let c = voce.elenco[voce.indice]
        let poi = (1..<voce.elenco.count).map { voce.elenco[(voce.indice + $0) % voce.elenco.count] }.prefix(3)
        VStack(alignment: .leading, spacing: 8) {
            TestataWidget(titolo: "Consigli") { Scorri(indice: voce.indice, totale: voce.elenco.count) }

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Bollo(fonte: c.fonte, lato: 28)
                    Provenienza(c: c)
                }
                Text(c.titolo)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Tinte.testo)
                    .lineLimit(3)
                    .minimumScaleFactor(0.85)
                if let p = c.perche {
                    Text(p)
                        .font(.subheadline)
                        .foregroundStyle(Tinte.tinta)
                        .lineLimit(3)
                }
                if let cosa = c.cosa {
                    Label(cosa, systemImage: "arrow.turn.down.right")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Tinte.testo)
                        .lineLimit(2)
                }
                if let v = c.valore, v >= 1 { Valore(euro: v) }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Tinte.notteFonda.opacity(0.55)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Aspetto.colore(c.fonte).opacity(0.35), lineWidth: 0.6))

            if !poi.isEmpty {
                Text("Poi")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Tinte.tinta)
                ForEach(Array(poi)) { x in
                    Link(destination: Aspetto.url(x)) {
                        HStack(spacing: 8) {
                            Bollo(fonte: x.fonte, lato: 18)
                            Text(x.titolo)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(Tinte.testo)
                                .lineLimit(1)
                            Spacer(minLength: 4)
                            if let v = x.valore, v >= 1 {
                                Text("≈ \(FormatiWidget.euro(v))")
                                    .font(.caption2)
                                    .monospacedDigit()
                                    .foregroundStyle(Tinte.ambra)
                            }
                        }
                    }
                }
            }
            Spacer(minLength: 0)
            EtaWidget(visto: voce.letto.visto, fonte: voce.letto.fonte)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// Niente da fare: si dice, in verde, senza riempire il vuoto.
private struct TuttoInOrdine: View {
    let voce: VoceConsigli

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TestataWidget(titolo: "Consigli")
            Spacer(minLength: 0)
            Label("Niente di urgente.", systemImage: "checkmark.seal.fill")
                .font(.headline)
                .foregroundStyle(Tinte.verde)
                .widgetAccentable()
            Text("Nessun buco, nessun rosso, nessuno che ti aspetta.")
                .font(.caption)
                .foregroundStyle(Tinte.tinta)
            Spacer(minLength: 0)
            EtaWidget(visto: voce.letto.visto, fonte: voce.letto.fonte)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

// MARK: - anteprime (dati di fantasia)

#Preview("Medio", as: .systemMedium) {
    ConsigliWidget()
} timeline: {
    VoceConsigli.esempio
}

#Preview("Grande", as: .systemLarge) {
    ConsigliWidget()
} timeline: {
    VoceConsigli.esempio
}
