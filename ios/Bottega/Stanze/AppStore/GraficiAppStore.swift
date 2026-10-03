//
//  GraficiAppStore.swift
//  Bottega per iPhone
//
//  I grafici della stanza App Store, con Swift Charts: guadagni a barre impilate (AdMob sotto, Store sopra) con le
//  versioni uscite segnate, download, la tendenza cumulata contro il periodo prima, il confronto tra le app, gli
//  abbonati nel tempo, e le barre semplici per paesi e fonti. Un tocco o un trascinamento sul grafico mostra il valore
//  di quel giorno (chartXSelection). Colori come sul Mac (media/appstore.css): l'ambra della lampada per AdMob, la
//  luce fredda per lo Store; le misure di una serie sola in un colore neutro, i testi sempre nell'inchiostro.
//

import Charts
import SwiftUI

/// I colori dei guadagni della plancia (media/appstore.css, verificati sul fondo scuro).
enum ColoriSoldi {
    static let admob = Color(red: 0xc4 / 255, green: 0x82 / 255, blue: 0x1c / 255)
    static let store = Color(red: 0x66 / 255, green: 0x83 / 255, blue: 0xe6 / 255)
    /// Le misure di una serie sola (download, prove): neutro, come `aps-m-una` sul Mac.
    static let una = Color(red: 0x8f / 255, green: 0x98 / 255, blue: 0xad / 255)
}

private let animazione = Animation.easeOut(duration: 0.3)

/// Il riquadro del valore scelto, sopra il grafico.
struct FumettoGrafico<C: View>: View {
    @ViewBuilder let contenuto: C

    var body: some View {
        VStack(alignment: .leading, spacing: 2) { contenuto }
            .font(.caption2)
            .foregroundStyle(Tinte.testo)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8).fill(Tinte.notteFonda))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Tinte.bordo))
    }
}

/// Un quadratino di legenda.
struct Quadretto: View {
    let colore: Color
    var body: some View { RoundedRectangle(cornerRadius: 2).fill(colore).frame(width: 8, height: 8) }
}

/// Assi in italiano con le date brevi; asse dei valori a sinistra, con la griglia appena visibile.
private struct AssiData: ViewModifier {
    let mesi: Bool
    let valore: (Double) -> String

    func body(content: Content) -> some View {
        content
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { v in
                    AxisGridLine().foregroundStyle(Tinte.bordo)
                    AxisValueLabel { if let n = v.as(Double.self) { Text(valore(n)).foregroundStyle(Tinte.tinta) } }
                }
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: mesi ? 6 : 5)) { _ in
                    AxisValueLabel(format: mesi ? .dateTime.month(.abbreviated) : .dateTime.day().month(.abbreviated))
                        .foregroundStyle(Tinte.tinta)
                }
            }
            .environment(\.locale, CalcoliAppStore.it)
    }
}

/// Il punto del grafico che cade nel giorno (o nel mese) scelto.
private func scelto<P>(_ punti: [P], _ data: Date?, _ unita: Calendar.Component, chiave: (P) -> String) -> P? {
    guard let data else { return nil }
    return punti.first { p in CalcoliAppStore.data(chiave(p)).map { Calendar.current.isDate($0, equalTo: data, toGranularity: unita) } ?? false }
}

// MARK: - guadagni

struct GraficoGuadagni: View {
    let punti: [StanzaAppStore.Punto]
    let versioni: [StanzaAppStore.Versione]
    let mesi: Bool
    @State private var data: Date?

    private var unita: Calendar.Component { mesi ? .month : .day }

    var body: some View {
        let p = scelto(punti, data, unita) { $0.chiave }
        Chart {
            ForEach(punti) { p in
                if let x = CalcoliAppStore.data(p.chiave) {
                    BarMark(x: .value("Quando", x, unit: unita), y: .value("Euro", p.admob))
                        .foregroundStyle(by: .value("Fonte", "AdMob"))
                        .opacity(p.nelPeriodo ? 1 : 0.35)
                    if let s = p.store {
                        BarMark(x: .value("Quando", x, unit: unita), y: .value("Euro", s))
                            .foregroundStyle(by: .value("Fonte", "Store"))
                            .opacity(p.nelPeriodo ? 1 : 0.35)
                    }
                }
            }
            ForEach(versioni) { v in
                if let x = CalcoliAppStore.data(v.chiave) {
                    RuleMark(x: .value("Versione", x, unit: unita))
                        .foregroundStyle(Tinte.testo.opacity(0.55))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                        .annotation(position: .top, spacing: 1, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                            Text(v.v).font(.caption2).foregroundStyle(Tinte.tinta)
                        }
                }
            }
            if let p, let x = CalcoliAppStore.data(p.chiave) {
                RuleMark(x: .value("Scelto", x, unit: unita))
                    .foregroundStyle(Tinte.testo.opacity(0.22))
                    .annotation(position: .top, spacing: 4, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        FumettoGrafico {
                            Text(CalcoliAppStore.dataLunga(p.chiave)).fontWeight(.semibold)
                            HStack(spacing: 4) { Quadretto(colore: ColoriSoldi.admob); Text("AdMob \(CalcoliAppStore.euro(p.admob))") }
                            HStack(spacing: 4) {
                                Quadretto(colore: ColoriSoldi.store)
                                Text(p.store.map { "Store \(CalcoliAppStore.euro($0))" } ?? (mesi ? "Store: Apple non dà più questo mese" : "Store: non ancora pubblicato"))
                            }
                            if let s = p.store { Text("Totale \(CalcoliAppStore.euro(p.admob + s))") }
                            ForEach(versioni.filter { $0.chiave == p.chiave }) { v in
                                Text(versioni.count > 1 && Set(versioni.map(\.app)).count > 1 ? "Uscita \(v.app) \(v.v)" : "Uscita la versione \(v.v)")
                            }
                        }
                    }
            }
        }
        .chartForegroundStyleScale(["AdMob": ColoriSoldi.admob, "Store": ColoriSoldi.store])
        .chartLegend(.hidden)
        .chartXSelection(value: $data)
        .modifier(AssiData(mesi: mesi) { CalcoliAppStore.euro($0, decimali: 0) })
        .animation(animazione, value: punti.map(\.chiave))
        .frame(height: 200)
        .accessibilityLabel("Guadagni, AdMob e Store, in euro")
    }
}

// MARK: - download

struct GraficoDownload: View {
    let punti: [StanzaAppStore.Punto]
    let versioni: [StanzaAppStore.Versione]
    let mesi: Bool
    @State private var data: Date?

    private var unita: Calendar.Component { mesi ? .month : .day }

    var body: some View {
        let p = scelto(punti, data, unita) { $0.chiave }
        Chart {
            ForEach(punti) { p in
                // i download vengono dai report dello Store: dove manca il report non sono zero, mancano
                if let x = CalcoliAppStore.data(p.chiave), p.store != nil {
                    BarMark(x: .value("Quando", x, unit: unita), y: .value("Download", p.download))
                        .foregroundStyle(ColoriSoldi.una.opacity(p.nelPeriodo ? 0.9 : 0.35))
                }
            }
            ForEach(versioni) { v in
                if let x = CalcoliAppStore.data(v.chiave) {
                    RuleMark(x: .value("Versione", x, unit: unita))
                        .foregroundStyle(Tinte.testo.opacity(0.55))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                }
            }
            if let p, let x = CalcoliAppStore.data(p.chiave) {
                RuleMark(x: .value("Scelto", x, unit: unita))
                    .foregroundStyle(Tinte.testo.opacity(0.22))
                    .annotation(position: .top, spacing: 4, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        FumettoGrafico {
                            Text(CalcoliAppStore.dataLunga(p.chiave)).fontWeight(.semibold)
                            Text(p.store == nil ? "Download: non ancora pubblicati" : "\(CalcoliAppStore.numero(p.download)) download")
                            if let pr = p.prima, pr.store != nil { Text("Prima: \(CalcoliAppStore.numero(pr.download))").foregroundStyle(Tinte.tinta) }
                        }
                    }
            }
        }
        .chartXSelection(value: $data)
        .modifier(AssiData(mesi: mesi) { CalcoliAppStore.numero($0) })
        .animation(animazione, value: punti.map(\.chiave))
        .frame(height: 120)
        .accessibilityLabel("Download nuovi")
    }
}

// MARK: - tendenza

/// Quanto si e' accumulato dall'inizio del periodo, contro lo stesso tratto del periodo prima.
struct GraficoTendenza: View {
    let passi: [CalcoliAppStore.PassoTendenza]
    let mesi: Bool
    @State private var data: Date?

    private var unita: Calendar.Component { mesi ? .month : .day }

    var body: some View {
        let p = scelto(passi, data, unita) { $0.chiave }
        Chart {
            ForEach(passi) { p in
                if let x = CalcoliAppStore.data(p.chiave) {
                    LineMark(x: .value("Quando", x, unit: unita), y: .value("Euro", p.prima), series: .value("Serie", "Periodo prima"))
                        .foregroundStyle(by: .value("Serie", "Periodo prima"))
                        .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("Quando", x, unit: unita), y: .value("Euro", p.adesso), series: .value("Serie", "Adesso"))
                        .foregroundStyle(by: .value("Serie", "Adesso"))
                        .lineStyle(StrokeStyle(lineWidth: 2.5))
                        .interpolationMethod(.monotone)
                }
            }
            if let p, let x = CalcoliAppStore.data(p.chiave) {
                RuleMark(x: .value("Scelto", x, unit: unita))
                    .foregroundStyle(Tinte.testo.opacity(0.22))
                    .annotation(position: .top, spacing: 4, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        FumettoGrafico {
                            Text("Fino a \(CalcoliAppStore.dataBreve(p.chiave))").fontWeight(.semibold)
                            Text("Adesso \(CalcoliAppStore.euro(p.adesso))")
                            Text("Prima \(CalcoliAppStore.euro(p.prima))").foregroundStyle(Tinte.tinta)
                            if let d = CalcoliAppStore.delta(p.adesso, p.prima) { Text(d) }
                        }
                    }
            }
        }
        .chartForegroundStyleScale(["Adesso": Tinte.testo, "Periodo prima": ColoriSoldi.una])
        .chartLegend(.hidden)
        .chartXSelection(value: $data)
        .modifier(AssiData(mesi: mesi) { CalcoliAppStore.euro($0, decimali: 0) })
        .animation(animazione, value: passi.map(\.chiave))
        .frame(height: 150)
        .accessibilityLabel("Tendenza: euro accumulati nel periodo, contro il periodo prima")
    }
}

// MARK: - confronto tra le app

/// Le app a barre orizzontali, la piu' ricca in alto, AdMob e Store impilati e il totale in fondo alla barra.
struct GraficoConfronto: View {
    let app: [StanzaAppStore.App]
    @State private var scelta: String?

    private func nome(_ a: StanzaAppStore.App) -> String { a.piattaforma == "android" ? "\(a.nome) Android" : a.nome }

    var body: some View {
        let righe = Array(app.prefix(10))
        let massimo = max(1, righe.map(\.totale).max() ?? 1)
        Chart {
            ForEach(righe) { a in
                BarMark(x: .value("Euro", a.admob), y: .value("App", nome(a)))
                    .foregroundStyle(by: .value("Fonte", "AdMob"))
                    .opacity(scelta == nil || scelta == nome(a) ? 1 : 0.4)
                BarMark(x: .value("Euro", a.store), y: .value("App", nome(a)))
                    .foregroundStyle(by: .value("Fonte", "Store"))
                    .opacity(scelta == nil || scelta == nome(a) ? 1 : 0.4)
                    .annotation(position: .trailing, spacing: 4) {
                        Text(scelta == nome(a) ? "AdMob \(CalcoliAppStore.euro(a.admob, decimali: 0)), Store \(CalcoliAppStore.euro(a.store, decimali: 0))" : CalcoliAppStore.euro(a.totale, decimali: 0))
                            .font(.caption2)
                            .foregroundStyle(Tinte.testo)
                    }
            }
        }
        .chartForegroundStyleScale(["AdMob": ColoriSoldi.admob, "Store": ColoriSoldi.store])
        .chartLegend(.hidden)
        .chartXAxis(.hidden)
        .chartXScale(domain: 0...(massimo * 1.45))
        .chartYAxis {
            AxisMarks { _ in AxisValueLabel().foregroundStyle(Tinte.testo).font(.caption) }
        }
        .chartYSelection(value: $scelta)
        .animation(animazione, value: righe.map(\.chiave))
        .frame(height: CGFloat(righe.count) * 30 + 10)
        .accessibilityLabel("Confronto tra le app, euro nel periodo")
    }
}

// MARK: - abbonati

struct GraficoAbbonati: View {
    let serie: [StanzaAppStore.GiornoAbbonati]
    @State private var data: Date?

    var body: some View {
        let p = scelto(serie, data, .day) { $0.giorno }
        let mostraProve = serie.contains { $0.prove > 0 }
        Chart {
            ForEach(serie) { g in
                if let x = CalcoliAppStore.data(g.giorno) {
                    AreaMark(x: .value("Giorno", x, unit: .day), y: .value("Abbonati", g.attivi), series: .value("Serie", "Che pagano"))
                        .foregroundStyle(ColoriSoldi.store.opacity(0.18))
                        .interpolationMethod(.monotone)
                    LineMark(x: .value("Giorno", x, unit: .day), y: .value("Abbonati", g.attivi), series: .value("Serie", "Che pagano"))
                        .foregroundStyle(ColoriSoldi.store)
                        .lineStyle(StrokeStyle(lineWidth: 2))
                        .interpolationMethod(.monotone)
                    if mostraProve {
                        LineMark(x: .value("Giorno", x, unit: .day), y: .value("Abbonati", g.prove), series: .value("Serie", "In prova"))
                            .foregroundStyle(ColoriSoldi.una)
                            .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                            .interpolationMethod(.monotone)
                    }
                }
            }
            if let p, let x = CalcoliAppStore.data(p.giorno) {
                RuleMark(x: .value("Scelto", x, unit: .day))
                    .foregroundStyle(Tinte.testo.opacity(0.22))
                    .annotation(position: .top, spacing: 4, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        FumettoGrafico {
                            Text(CalcoliAppStore.dataLunga(p.giorno)).fontWeight(.semibold)
                            Text("\(CalcoliAppStore.numero(p.attivi)) che pagano")
                            if mostraProve { Text("\(CalcoliAppStore.numero(p.prove)) in prova").foregroundStyle(Tinte.tinta) }
                        }
                    }
            }
        }
        .chartXSelection(value: $data)
        .modifier(AssiData(mesi: false) { CalcoliAppStore.numero($0) })
        .animation(animazione, value: serie.map(\.giorno))
        .frame(height: 140)
        .accessibilityLabel("Abbonati giorno per giorno")
    }
}

// MARK: - barre semplici

/// Paesi, fonti dei download: una barra per riga con il valore in fondo.
struct BarreSemplici: View {
    struct Riga: Identifiable {
        let id: String
        let etichetta: String
        let valore: Double
        let testo: String
    }

    let righe: [Riga]
    var colore: Color = ColoriSoldi.una

    var body: some View {
        let massimo = max(0.01, righe.map(\.valore).max() ?? 0.01)
        Chart(righe) { r in
            BarMark(x: .value("Valore", r.valore), y: .value("Voce", r.etichetta))
                .foregroundStyle(colore)
                .cornerRadius(3)
                .annotation(position: .trailing, spacing: 4) {
                    Text(r.testo).font(.caption2).foregroundStyle(Tinte.testo)
                }
        }
        .chartXAxis(.hidden)
        .chartXScale(domain: 0...(massimo * 1.6))
        .chartYAxis { AxisMarks { _ in AxisValueLabel().foregroundStyle(Tinte.testo).font(.caption) } }
        .frame(height: CGFloat(righe.count) * 26 + 8)
    }
}

/// La scintilla di una riga: l'andamento del periodo, senza assi.
struct Scintilla: View {
    let valori: [Double]

    var body: some View {
        Chart(Array(valori.enumerated()), id: \.offset) { i, v in
            LineMark(x: .value("i", i), y: .value("v", v))
                .foregroundStyle(Tinte.tinta)
                .lineStyle(StrokeStyle(lineWidth: 1.2))
                .interpolationMethod(.monotone)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
        .frame(width: 64, height: 20)
        .accessibilityHidden(true)
    }
}
