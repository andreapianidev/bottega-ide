//
//  CruscottoView.swift
//  Bottega per iPhone
//
//  Il cruscotto del Mac (src/stats.ts, docs/CONTRATTI.md, 9.6): ore tue e di Claude, sessioni, token, valore a
//  listino, per 7, 30 e 90 giorni, con il confronto sul periodo prima; le tue ore giorno per giorno (e quelle di
//  Claude, che contano le sessioni in parallelo); i progetti principali. Un tocco su un progetto con una sessione
//  aperta apre la sua scheda.
//

import Charts
import SwiftUI

/// Il registro delle quattro fonti arriva da /v1/stato, indipendente dai consumi Claude.
struct RiepilogoAttivitaCruscotto {
    struct Fonte: Identifiable {
        let nome: String
        let totale: Int
        let inCorso: Int
        let tiAspetta: Int
        let errori: Int
        var id: String { nome }
    }
    let visto: Date
    let salvato: Bool
    let totale: Int
    let inCorso: Int
    let tiAspetta: Int
    let fonti: [Fonte]

    init?(stato: StatoMac, salvato: Bool) {
        guard stato.attivita != nil else { return nil }
        visto = Date(timeIntervalSince1970: stato.ora / 1000)
        self.salvato = salvato
        let conti = stato.conteggiAttivita
        totale = conti.totale
        inCorso = conti.inCorso
        tiAspetta = conti.tiAspetta
        let sessioni = stato.sessioniWidget
        fonti = ["Claude Code", "Codex", "Cline", "Terminale"].map { nome in
            let righe = sessioni.filter { $0.fonte == nome }
            return Fonte(nome: nome, totale: righe.count,
                         inCorso: righe.filter { $0.stato == "in corso" }.count,
                         tiAspetta: righe.filter { $0.stato == "ti aspetta" }.count,
                         errori: righe.filter { $0.stato == "errore" }.count)
        }
    }
}

struct CruscottoView: View {
    let ponte: Ponte
    @State private var lettura = LetturaStanza<StanzaCruscotto>("cruscotto")
    @State private var periodo = "7"

    var body: some View {
        VStack(spacing: 0) {
            Picker("Periodo", selection: $periodo) {
                Text("7 giorni").tag("7")
                Text("30 giorni").tag("30")
                Text("90 giorni").tag("90")
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            if lettura.dati == nil {
                ScrollView {
                    riepilogoAttivita.padding(.horizontal, 16).padding(.top, 8)
                }
                .frame(maxHeight: .infinity)
            }
            CorniceStanza(lettura: lettura, query: ["periodo": periodo], datiDelMac: { $0.aggiornatoAt }) { d in
                contenuto(d)
            }
        }
    }

    private var statoVisibile: StatoMac? {
        ponte.collegato ? ponte.stato ?? StatoMac.ultimo() : nil
    }

    @ViewBuilder
    private var riepilogoAttivita: some View {
        if let stato = statoVisibile,
           let r = RiepilogoAttivitaCruscotto(stato: stato, salvato: ponte.linea != .collegato || ponte.stato == nil) {
            RiquadroStanza(titolo: "Attività di tutte le fonti", nota: r.salvato ? "Dato salvato" : "Registro del Mac") {
                HStack(alignment: .top, spacing: 12) {
                    Cifra(etichetta: "Osservate", valore: "\(r.totale)")
                    Cifra(etichetta: "In corso", valore: "\(r.inCorso)")
                    Cifra(etichetta: "Ti aspettano", valore: "\(r.tiAspetta)", colore: Tinte.ambra)
                }
                ForEach(r.fonti) { fonte in
                    HStack(alignment: .firstTextBaseline) {
                        Text(fonte.nome).font(.caption.weight(.semibold))
                        Spacer(minLength: 6)
                        Text("\(fonte.totale) osservate · \(fonte.inCorso) in corso · \(fonte.tiAspetta) in attesa · \(fonte.errori) errori")
                            .font(.caption2)
                            .multilineTextAlignment(.trailing)
                            .foregroundStyle(Tinte.tinta)
                    }
                }
                Text("\(r.salvato ? "Ultimo registro salvato" : "Registrato") il \(r.visto.formatted(date: .abbreviated, time: .shortened)).\(r.salvato ? " Gli stati potrebbero essere cambiati." : "")")
                    .font(.caption2)
                    .foregroundStyle(Tinte.tinta)
            }
        } else {
            Text(statoVisibile == nil
                 ? "In attesa del registro delle attività dal Mac."
                 : "Il registro salvato contiene solo sessioni Claude Code; le altre fonti non sono disponibili.")
                .font(.caption)
                .foregroundStyle(Tinte.tinta)
        }
    }

    @ViewBuilder
    private func contenuto(_ d: StanzaCruscotto) -> some View {
        riepilogoAttivita
        RiquadroStanza(titolo: "Claude Code · ultimi \(Int(d.periodo)) giorni", nota: d.cifre.giorniAttivi.map { "\(Int($0)) giorni di lavoro" }) {
            HStack(alignment: .top, spacing: 12) {
                Cifra(etichetta: "Ore osservate", valore: Formati.ore(d.cifre.tu), adesso: d.cifre.tu, prima: d.prima?.tu, grande: true, colore: Tinte.ambra)
                Cifra(etichetta: "Ore sommate", valore: Formati.ore(d.cifre.claude), adesso: d.cifre.claude, prima: d.prima?.claude, grande: true)
            }
            HStack(alignment: .top, spacing: 12) {
                Cifra(etichetta: "Sessioni", valore: Formati.numero(d.cifre.sessioni))
                Cifra(etichetta: "Token", valore: Formati.token(d.cifre.token), adesso: d.cifre.token, prima: d.prima?.token)
                Cifra(etichetta: "A listino", valore: Formati.dollari(d.cifre.valore), adesso: d.cifre.valore, prima: d.prima?.valore)
            }
            Text("Questi consumi e grafici riguardano solo Claude Code. Le ore osservate contano una volta le sessioni in parallelo; le ore sommate le contano separatamente. Il valore a listino non è quello che paghi con l'abbonamento.")
                .font(.caption2)
                .foregroundStyle(Tinte.tinta)
        }
        oggi(d)
        grafico(d)
        if !d.progetti.isEmpty { progetti(d) }
    }

    private func oggi(_ d: StanzaCruscotto) -> some View {
        RiquadroStanza(titolo: "Claude Code · oggi", nota: d.vive > 0 ? "\(Int(d.vive)) sessioni aperte" : nil) {
            HStack(alignment: .top, spacing: 12) {
                Cifra(etichetta: "Unione", valore: Formati.ore(d.oggi.tu))
                if let c = d.oggi.claude { Cifra(etichetta: "Somma", valore: Formati.ore(c)) }
                if let s = d.settimana {
                    Cifra(etichetta: "Da lunedì", valore: Formati.ore(s.tu), adesso: s.tu, prima: s.primaFinOra)
                }
            }
        }
    }

    private func grafico(_ d: StanzaCruscotto) -> some View {
        RiquadroStanza(titolo: d.progetto == nil ? "Claude Code · giorno per giorno" : "Ore Claude Code su \(d.progetto!.nome)") {
            Chart {
                ForEach(d.grafico) { p in
                    if let x = Formati.data(p.giorno) {
                        BarMark(x: .value("Giorno", x, unit: .day), y: .value("Ore", p.tu / 60))
                            .foregroundStyle(by: .value("Chi", "Unione"))
                        if let c = p.claude {
                            LineMark(x: .value("Giorno", x, unit: .day), y: .value("Ore", c / 60))
                                .foregroundStyle(by: .value("Chi", "Somma"))
                                .interpolationMethod(.monotone)
                        }
                    }
                }
            }
            .chartForegroundStyleScale(["Unione": Tinte.ambra, "Somma": Tinte.tinta])
            .chartLegend(position: .top, alignment: .leading)
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { v in
                    AxisGridLine().foregroundStyle(Tinte.bordo)
                    AxisValueLabel { if let h = v.as(Double.self) { Text("\(Formati.numero(h)) h") } }
                }
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 5)) { _ in
                    AxisValueLabel(format: d.grafico.count <= 7 ? .dateTime.weekday(.abbreviated) : .dateTime.day().month(.abbreviated))
                }
            }
            .environment(\.locale, Formati.it)
            .frame(height: 190)
        }
    }

    private func progetti(_ d: StanzaCruscotto) -> some View {
        RiquadroStanza(titolo: "Progetti con sessioni Claude Code") {
            ForEach(d.progetti) { p in
                ConSessione(ponte: ponte, progetto: p.nome) {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(p.nome).font(.callout.weight(.medium)).foregroundStyle(Tinte.testo)
                                if p.vive > 0 { Pallino(colore: Tinte.verde) }
                            }
                            Text("\(Int(p.sessioni)) sessioni, Claude \(Formati.ore(p.claude)), \(Formati.token(p.token)) token")
                                .font(.caption)
                                .foregroundStyle(Tinte.tinta)
                        }
                        Spacer()
                        Text(Formati.ore(p.tu)).font(.callout.weight(.semibold)).monospacedDigit().foregroundStyle(Tinte.testo)
                    }
                }
                if p.id != d.progetti.last?.id { Divider().overlay(Tinte.bordo) }
            }
        }
    }
}
