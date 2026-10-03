//
//  CreditiWidget.swift
//  Bottega per iPhone, estensione dei widget
//
//  Il widget «Crediti»: quanto resta sui servizi che la Bottega paga a consumo. DeepSeek con il saldo e
//  i giorni al ritmo attuale, ElevenLabs con i caratteri del mese, Agnes gratis; ognuno col suo tono (verde, ambra
//  quando e' ora di ricaricare, rosso quando e' finito). Nel medio anche la spesa di DeepSeek degli ultimi 14 giorni.
//  Legge GET /v1/stanza?nome=servizi (docs/CONTRATTI.md, 9.6 e 14) con DatiWidget, ogni ora.
//

import Charts
import SwiftUI
import WidgetKit

struct VoceCrediti: TimelineEntry {
    let date: Date
    let letto: Letto<DatiServizi>

    /// Il tono peggiore: quello della sferetta in testa.
    var peggiore: String {
        let toni = (letto.dati?.servizi ?? []).map(\.tono)
        return toni.contains("male") ? "male" : toni.contains("attesa") ? "attesa" : "ok"
    }

    static var esempio: VoceCrediti {
        let cal = Calendar.current
        let spesa: [Double?] = [0.31, 0.12, nil, 0.44, 0.28, 0.19, 0.52, 0.36, 0.21, 0.4, 0.33, 0.15, 0.47, 0.29]
        let giorni = spesa.enumerated().map { i, v -> DatiServizi.Giorno in
            let d = cal.date(byAdding: .day, value: i - 13, to: .now) ?? .now
            let c = cal.dateComponents([.year, .month, .day], from: d)
            return DatiServizi.Giorno(giorno: String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0), deepseek: v)
        }
        let d = DatiServizi(aggiornatoAt: Date().timeIntervalSince1970 * 1000, servizi: [
            .init(id: "deepseek", nome: "DeepSeek", tono: "ok", frase: "restano 9,98 $, circa 31 giorni", valuta: "USD", saldo: 9.98,
                  mediaGiorno: 0.32, giorniRimasti: 31, usati: nil, limite: nil, gratis: nil),
            .init(id: "elevenlabs", nome: "ElevenLabs", tono: "ok", frase: nil, valuta: nil, saldo: nil, mediaGiorno: nil,
                  giorniRimasti: nil, usati: 12_345, limite: nil, gratis: nil),
            .init(id: "agnes", nome: "Agnes", tono: "ok", frase: "gratis, 15 richieste oggi", valuta: nil, saldo: nil, mediaGiorno: nil,
                  giorniRimasti: nil, usati: nil, limite: nil, gratis: true),
        ], spesa: .init(valuta: "USD", giorni: giorni))
        return VoceCrediti(date: .now, letto: Letto(dati: d, visto: .now, fonte: .diretta, errore: nil))
    }
}

struct FornitoreCrediti: TimelineProvider {
    func placeholder(in context: Context) -> VoceCrediti { .esempio }

    func getSnapshot(in context: Context, completion: @escaping (VoceCrediti) -> Void) {
        if context.isPreview {
            completion(DatiWidget.copia(DatiServizi.self, stanza: "servizi").map { VoceCrediti(date: .now, letto: $0) } ?? .esempio)
            return
        }
        Task { completion(VoceCrediti(date: .now, letto: await DatiWidget.leggi(DatiServizi.self, stanza: "servizi"))) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<VoceCrediti>) -> Void) {
        Task {
            let l = await DatiWidget.leggi(DatiServizi.self, stanza: "servizi")
            // il Mac rilegge i saldi ogni 30 minuti; il widget ogni ora
            completion(Timeline(entries: [VoceCrediti(date: .now, letto: l)], policy: .after(Date().addingTimeInterval(60 * 60))))
        }
    }
}

struct CreditiWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: TipiWidget.crediti, provider: FornitoreCrediti()) { voce in
            VistaCrediti(voce: voce)
                .widgetURL(URL(string: "bottega://stanze?nome=cruscotto"))
        }
        .configurationDisplayName("Crediti")
        .description("Quanto resta su DeepSeek, ElevenLabs e Agnes, e quando ricaricare.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct VistaCrediti: View {
    let voce: VoceCrediti
    @Environment(\.widgetFamily) private var famiglia

    var body: some View {
        Group {
            if let d = voce.letto.dati, !d.servizi.isEmpty {
                if famiglia == .systemMedium {
                    CreditiMedio(voce: voce, d: d)
                } else {
                    CreditiPiccolo(voce: voce, d: d)
                }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    TestataWidget(titolo: "Crediti")
                    VuotoWidget(fonte: voce.letto.fonte, errore: voce.letto.errore)
                }
            }
        }
        .sfondoBottega(famiglia)
    }
}

// MARK: - pezzi

private enum Leggi {
    /// Il numero che conta in poco spazio: i giorni rimasti, o il saldo, o i caratteri, o «gratis».
    static func breve(_ s: DatiServizi.Servizio) -> String {
        if s.gratis == true { return "gratis" }
        if let u = s.usati {
            if let l = s.limite, l > 0 { return "\(Int((u / l * 100).rounded()))%" }
            return caratteri(u)
        }
        if let g = s.giorniRimasti { return g >= 365 ? "1 anno+" : "\(Int(g)) g" }
        if let v = s.saldo { return FormatiWidget.soldi(v, valuta: s.valuta ?? "USD") }
        return ""
    }

    /// Il saldo con i giorni accanto, per il medio: «9,98 $ · 31 g».
    static func lungo(_ s: DatiServizi.Servizio) -> String {
        if s.gratis == true { return "gratis" }
        if let u = s.usati {
            if let l = s.limite, l > 0 { return "\(caratteri(u)) di \(caratteri(l))" }
            return "\(caratteri(u)) nel mese"
        }
        let saldo = s.saldo.map { FormatiWidget.soldi($0, valuta: s.valuta ?? "USD") }
        let giorni = s.giorniRimasti.map { $0 >= 365 ? "oltre un anno" : "\(Int($0)) g" }
        return [saldo, giorni].compactMap { $0 }.joined(separator: ", ")
    }

    /// L'ultima risorsa quando nemmeno il breve ci sta: «1,2M», «123k», «1,2k $».
    static func minimo(_ s: DatiServizi.Servizio) -> String {
        if s.gratis == true { return "gratis" }
        if let u = s.usati {
            if let l = s.limite, l > 0 { return "\(Int((u / l * 100).rounded()))%" }
            if u >= 1_000_000 { return "\((u / 1_000_000).formatted(.number.locale(FormatiWidget.it).precision(.fractionLength(1))))M" }
            if u >= 1000 { return "\(Int((u / 1000).rounded()))k" }
            return "\(Int(u))"
        }
        if let g = s.giorniRimasti { return g >= 365 ? "1 anno+" : "\(Int(g)) g" }
        if let v = s.saldo, abs(v) >= 1000 {
            let k = (v / 1000).formatted(.number.locale(FormatiWidget.it).precision(.fractionLength(1)))
            return (s.valuta ?? "USD").uppercased() == "EUR" ? "\(k)k €" : "\(k)k $"
        }
        return breve(s)
    }

    /// «12,3 mila car.», «840 car.»; senza unita' «12,3 mila», «840».
    static func caratteri(_ v: Double, unita: Bool = true) -> String {
        let car = unita ? " car." : ""
        if v >= 1_000_000 { return "\((v / 1_000_000).formatted(.number.locale(FormatiWidget.it).precision(.fractionLength(1)))) mln\(car)" }
        if v >= 1000 { return "\((v / 1000).formatted(.number.locale(FormatiWidget.it).precision(.fractionLength(v < 10_000 ? 1 : 0)))) mila\(car)" }
        return "\(Int(v))\(car)"
    }

    /// Per il medio, quando la frase del servizio non ci sta: «DeepSeek da ricaricare», «ElevenLabs finito».
    static func avviso(_ s: DatiServizi.Servizio) -> String {
        s.tono == "male" ? "\(s.nome): finito" : "\(s.nome) da ricaricare"
    }

    /// Un servizio a posto ha il numero in chiaro; in attesa o male prende il colore del tono.
    static func colore(_ s: DatiServizi.Servizio) -> Color { s.tono == "ok" ? Tinte.testo : ColoriWidget.tono(s.tono) }
}

private struct Riga: View {
    let s: DatiServizi.Servizio
    var lungo = false

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(ColoriWidget.tono(s.tono))
                .frame(width: 6, height: 6)
                .widgetAccentable(s.tono != "ok")
            // il nome ha la precedenza; la cifra passa da lunga a breve a minima, intera
            Text(s.nome)
                .font(.caption.weight(.medium))
                .foregroundStyle(Tinte.testo)
                .lineLimit(1)
                .fixedSize()
                .layoutPriority(1)
            Spacer(minLength: 3)
            ViewThatFits(in: .horizontal) {
                if lungo { cifra(Leggi.lungo(s)).lineLimit(1).fixedSize() }
                cifra(Leggi.breve(s)).lineLimit(1).fixedSize()
                cifra(Leggi.minimo(s)).lineLimit(1).minimumScaleFactor(0.8)
            }
            .contentTransition(.numericText(value: s.saldo ?? s.usati ?? 0))
        }
    }

    private func cifra(_ t: String) -> Text {
        Text(t)
            .font(.caption.weight(s.tono == "ok" ? .regular : .semibold))
            .monospacedDigit()
            .foregroundStyle(Leggi.colore(s))
    }
}

// MARK: - piccolo

private struct CreditiPiccolo: View {
    let voce: VoceCrediti
    let d: DatiServizi

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TestataWidget(titolo: "Crediti", acceso: voce.peggiore != "ok")
            Spacer(minLength: 0)
            ForEach(d.servizi.prefix(4)) { Riga(s: $0) }
            Spacer(minLength: 0)
            EtaWidget(visto: voce.letto.visto, fonte: voce.letto.fonte)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

// MARK: - medio

private struct CreditiMedio: View {
    let voce: VoceCrediti
    let d: DatiServizi

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                TestataWidget(titolo: "Crediti", acceso: voce.peggiore != "ok")
                Spacer(minLength: 0)
                ForEach(d.servizi.prefix(4)) { Riga(s: $0, lungo: true) }
                Spacer(minLength: 0)
                // la frase del servizio che chiede attenzione, se ce n'e' uno
                if let s = d.servizi.first(where: { $0.tono != "ok" }), let f = s.frase {
                    // la frase intera se ci sta (anche su due righe), altrimenti l'avviso corto
                    ViewThatFits(in: .vertical) {
                        Text(f).fixedSize(horizontal: false, vertical: true)
                        Text(Leggi.avviso(s)).lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .font(.caption2)
                    .foregroundStyle(ColoriWidget.tono(s.tono))
                } else {
                    EtaWidget(visto: voce.letto.visto, fonte: voce.letto.fonte)
                }
            }
            .frame(maxWidth: .infinity)

            if let spesa = d.spesa, spesa.giorni.contains(where: { $0.deepseek != nil }) {
                SpesaDeepSeek(spesa: spesa, media: d.servizi.first { $0.id == "deepseek" }?.mediaGiorno)
                    .frame(width: 112)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

/// La spesa di DeepSeek per giorno: un giorno senza lettura non ha barra (non e' zero).
private struct SpesaDeepSeek: View {
    let spesa: DatiServizi.Spesa
    let media: Double?
    @Environment(\.widgetRenderingMode) private var modo

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ViewThatFits(in: .horizontal) {
                Text("DeepSeek, 14 giorni")
                Text("DeepSeek")
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Tinte.tinta)
            .lineLimit(1)
            Chart {
                ForEach(spesa.giorni) { g in
                    if let v = g.deepseek {
                        BarMark(x: .value("Giorno", g.giorno), y: .value("Speso", v), width: .ratio(0.7))
                            .foregroundStyle(modo == .fullColor ? ColoriWidget.cielo : Color.primary)
                            .cornerRadius(1.5)
                    }
                }
                if let m = media, m > 0 {
                    RuleMark(y: .value("Media", m))
                        .foregroundStyle(Tinte.ambra.opacity(0.8))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 2]))
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartXScale(domain: spesa.giorni.map(\.giorno))
            if let m = media, m > 0 {
                let media = FormatiWidget.soldi(m, valuta: spesa.valuta)
                ViewThatFits(in: .horizontal) {
                    Text("media \(media) al giorno")
                    Text("\(media) al giorno")
                    Text("\(media)/g")
                }
                .font(.caption2)
                .foregroundStyle(Tinte.tinta)
                .monospacedDigit()
                .lineLimit(1)
            }
        }
    }
}

// MARK: - anteprime (dati di fantasia)

#Preview("Piccolo", as: .systemSmall) {
    CreditiWidget()
} timeline: {
    VoceCrediti.esempio
    VoceCrediti(date: .now, letto: Letto(dati: nil, visto: nil, fonte: .salvata, errore: "I conti dei servizi non sono ancora stati letti: li legge la Bottega sul Mac."))
}

#Preview("Medio", as: .systemMedium) {
    CreditiWidget()
} timeline: {
    VoceCrediti.esempio
}
