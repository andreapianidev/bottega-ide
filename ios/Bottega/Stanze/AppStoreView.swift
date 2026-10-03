//
//  AppStoreView.swift
//  Bottega per iPhone
//
//  La stanza App Store del Mac (docs/CONTRATTI.md, 13 e 9.6): il totale, AdMob, lo Store, i download, per ieri, la
//  settimana, il mese e l'anno, con il confronto sul periodo prima; i guadagni a barre impilate (AdMob sotto, Store
//  sopra, gli stessi colori della plancia); gli abbonati; le app che rendono di piu'; i buchi da sistemare con la
//  stima. Un giorno dopo l'ultimo report dello Store non e' zero: la barra dello Store manca e lo si dice.
//

import Charts
import SwiftUI

/// I colori dei guadagni della plancia (media/appstore.css, verificati sul fondo scuro).
enum ColoriSoldi {
    static let admob = Color(red: 0xc4 / 255, green: 0x82 / 255, blue: 0x1c / 255)
    static let store = Color(red: 0x66 / 255, green: 0x83 / 255, blue: 0xe6 / 255)
}

struct AppStoreView: View {
    let ponte: Ponte
    @State private var lettura = LetturaStanza<StanzaAppStore>("appstore")
    @State private var periodo = "settimana"
    @State private var tuttiIBuchi = false

    private static let periodi = [("ieri", "Ieri"), ("settimana", "Settimana"), ("mese", "Mese"), ("anno", "Anno")]

    var body: some View {
        VStack(spacing: 0) {
            Picker("Periodo", selection: $periodo) {
                ForEach(Self.periodi, id: \.0) { Text($0.1).tag($0.0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            CorniceStanza(lettura: lettura, query: ["periodo": periodo], datiDelMac: { $0.aggiornatoAt }) { d in
                contenuto(d)
            }
        }
    }

    @ViewBuilder
    private func contenuto(_ d: StanzaAppStore) -> some View {
        if let allarmi = d.allarmi, !allarmi.isEmpty {
            RiquadroStanza(titolo: "Allarmi") {
                ForEach(allarmi) { a in
                    Label {
                        Text("\(a.app): \(a.testo)").foregroundStyle(Tinte.testo)
                    } icon: {
                        Image(systemName: "bell.badge").foregroundStyle(Tinte.ambra)
                    }
                    .font(.callout)
                }
            }
        }
        cifre(d)
        grafico(d)
        if let a = d.abbonamenti { abbonati(a) }
        if !d.app.isEmpty { app(d) }
        buchi(d)
        if let e = d.errori, e.admob != nil || e.store != nil {
            VStack(alignment: .leading, spacing: 4) {
                if let a = e.admob { Text("AdMob: \(a)") }
                if let s = e.store { Text("Store: \(s)") }
            }
            .font(.caption)
            .foregroundStyle(Tinte.rosso)
        }
    }

    // MARK: - cifre

    private func cifre(_ d: StanzaAppStore) -> some View {
        RiquadroStanza(titolo: titoloPeriodo(d), nota: d.storeIncompleto == true ? notaStore(d) : nil) {
            VStack(alignment: .leading, spacing: 14) {
                Cifra(etichetta: "In tutto", valore: Formati.euro(d.cifre.totale), adesso: d.cifre.totale, prima: d.prima?.totale, grande: true, colore: Tinte.ambra)
                HStack(alignment: .top, spacing: 12) {
                    Cifra(etichetta: "AdMob", valore: Formati.euro(d.cifre.admob), adesso: d.cifre.admob, prima: d.prima?.admob)
                    Cifra(etichetta: "Store", valore: Formati.euro(d.cifre.store), adesso: d.storeIncompleto == true ? nil : d.cifre.store, prima: d.prima?.store)
                    Cifra(etichetta: "Download", valore: Formati.numero(d.cifre.download), adesso: d.storeIncompleto == true ? nil : d.cifre.download, prima: d.prima?.download)
                }
            }
        }
    }

    private func titoloPeriodo(_ d: StanzaAppStore) -> String {
        switch d.etichetta {
        case "ieri": "Ieri"
        default: d.quale == "mesi" ? "Ultimi 12 mesi" : "Ultimi \(Int(d.periodo)) giorni"
        }
    }

    private func notaStore(_ d: StanzaAppStore) -> String {
        guard let f = d.storeFinoA else { return "Store parziale" }
        return "Store fino al \(Formati.chiaveDetta(f))"
    }

    // MARK: - grafico

    private func grafico(_ d: StanzaAppStore) -> some View {
        let mesi = d.quale == "mesi"
        let unita: Calendar.Component = mesi ? .month : .day
        return RiquadroStanza(titolo: "Guadagni", nota: d.etichetta == "ieri" ? "la settimana, ieri in fondo" : nil) {
            Chart {
                ForEach(d.grafico) { p in
                    if let x = Formati.data(p.chiave) {
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
            }
            .chartForegroundStyleScale(["AdMob": ColoriSoldi.admob, "Store": ColoriSoldi.store])
            .chartLegend(position: .top, alignment: .leading)
            .chartYAxis {
                AxisMarks(position: .leading) { v in
                    AxisGridLine().foregroundStyle(Tinte.bordo)
                    AxisValueLabel { if let e = v.as(Double.self) { Text(Formati.euro(e)) } }
                }
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: mesi ? 6 : 5)) { _ in
                    AxisValueLabel(format: mesi ? .dateTime.month(.abbreviated) : .dateTime.day().month(.abbreviated))
                }
            }
            .environment(\.locale, Formati.it)
            .frame(height: 190)
            if d.grafico.contains(where: { $0.store == nil }) {
                Text("Dove manca la barra dello Store, Apple non ha ancora pubblicato il report: non è zero.")
                    .font(.caption2)
                    .foregroundStyle(Tinte.tinta)
            }
            Chart {
                ForEach(d.grafico) { p in
                    if let x = Formati.data(p.chiave) {
                        BarMark(x: .value("Quando", x, unit: unita), y: .value("Download", p.download))
                            .foregroundStyle(Tinte.tinta.opacity(p.nelPeriodo ? 0.9 : 0.35))
                    }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { v in
                    AxisGridLine().foregroundStyle(Tinte.bordo)
                    AxisValueLabel { if let n = v.as(Double.self) { Text(Formati.numero(n)) } }
                }
            }
            .chartXAxis(.hidden)
            .frame(height: 70)
            Text("Download nuovi").font(.caption2).foregroundStyle(Tinte.tinta)
        }
    }

    // MARK: - abbonati

    private func abbonati(_ a: StanzaAppStore.Abbonamenti) -> some View {
        RiquadroStanza(titolo: "Abbonati", nota: a.finoA.map { "al \(Formati.chiaveDetta($0))" }) {
            HStack(alignment: .top, spacing: 12) {
                Cifra(etichetta: "Che pagano", valore: Formati.numero(a.attivi), adesso: a.attivi, prima: a.attiviPrima)
                Cifra(etichetta: "In prova", valore: Formati.numero(a.prove))
                Cifra(etichetta: "Al mese", valore: Formati.euro(a.mrr))
            }
            if let e = a.eventi, !e.isEmpty {
                Text(e.sorted { $0.value > $1.value }.map { "\($0.key) \(Formati.numero($0.value))" }.joined(separator: ", "))
                    .font(.caption)
                    .foregroundStyle(Tinte.tinta)
            }
            if a.ritardo > 0 {
                Text("\(Formati.numero(a.ritardo)) in ritardo di pagamento").font(.caption).foregroundStyle(Tinte.ambra)
            }
        }
    }

    // MARK: - app

    private func app(_ d: StanzaAppStore) -> some View {
        RiquadroStanza(titolo: "Le app che rendono di più") {
            ForEach(d.app) { a in
                ConSessione(ponte: ponte, progetto: a.progetto) {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.nome).font(.callout.weight(.medium)).foregroundStyle(Tinte.testo)
                            Text("AdMob \(Formati.euro(a.admob)), Store \(Formati.euro(a.store)), \(Formati.numero(a.download)) download")
                                .font(.caption)
                                .foregroundStyle(Tinte.tinta)
                        }
                        Spacer()
                        Text(Formati.euro(a.totale)).font(.callout.weight(.semibold)).monospacedDigit().foregroundStyle(Tinte.testo)
                    }
                }
                if a.id != d.app.last?.id { Divider().overlay(Tinte.bordo) }
            }
        }
    }

    // MARK: - buchi

    @ViewBuilder
    private func buchi(_ d: StanzaAppStore) -> some View {
        let n = Int(d.buchiTotali)
        RiquadroStanza(titolo: "Da sistemare", nota: n == 0 ? nil : d.stimaTotale >= 1 ? "\(n) punti, circa \(Formati.euro(d.stimaTotale)) al mese" : "\(n) punti") {
            if d.buchi.isEmpty {
                Text("Nessun buco da sistemare.").font(.callout).foregroundStyle(Tinte.verde)
            }
            ForEach(tuttiIBuchi ? d.buchi : Array(d.buchi.prefix(4))) { b in
                RigaBuco(ponte: ponte, buco: b)
                if b.id != d.buchi.last?.id { Divider().overlay(Tinte.bordo) }
            }
            if d.buchi.count > 4 && !tuttiIBuchi {
                Button("Mostra i primi \(d.buchi.count)") { tuttiIBuchi = true }.font(.footnote)
            }
            if n > d.buchi.count && (tuttiIBuchi || d.buchi.count <= 4) {
                Text("Gli altri \(n - d.buchi.count) sono nella stanza App Store sul Mac.").font(.caption).foregroundStyle(Tinte.tinta)
            }
        }
    }
}

private struct RigaBuco: View {
    let ponte: Ponte
    let buco: StanzaAppStore.Buco
    @State private var aperto = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.easeOut(duration: 0.2)) { aperto.toggle() } } label: {
                HStack(alignment: .top, spacing: 10) {
                    Pallino(colore: colore).padding(.top, 5)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(buco.titolo).font(.callout.weight(.medium)).foregroundStyle(Tinte.testo).multilineTextAlignment(.leading)
                        Text(sotto).font(.caption).foregroundStyle(Tinte.tinta)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: aperto ? "chevron.up" : "chevron.down").font(.caption).foregroundStyle(Tinte.tinta)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if aperto {
                VStack(alignment: .leading, spacing: 6) {
                    if let p = buco.perche { Text(p).foregroundStyle(Tinte.tinta) }
                    Text(buco.cosa).foregroundStyle(Tinte.testo)
                    if let n = buco.stimaNota { Text("Stima: \(n)").foregroundStyle(Tinte.tinta) }
                    if let d = buco.daQuando { Text("C'è da \(Formati.fa(ms: d, conFa: false)).").foregroundStyle(Tinte.tinta) }
                    ConSessione(ponte: ponte, progetto: buco.progetto) {
                        if let p = buco.progetto { Text("Progetto: \(p)").foregroundStyle(Tinte.tinta) }
                    }
                }
                .font(.caption)
                .padding(.leading, 19)
            }
        }
    }

    private var colore: Color {
        switch buco.gravita {
        case "alta": Tinte.rosso
        case "media": Tinte.ambra
        default: Tinte.tinta
        }
    }

    private var sotto: String {
        var s = buco.app
        if let e = buco.stima, e >= 1 { s += ", circa \(Formati.euro(e)) al mese" }
        return s
    }
}
