//
//  ClientiView.swift
//  Bottega per iPhone
//
//  Le ore e gli importi del mese per cliente, come nella stanza Clienti del Mac (src/clienti.ts, docs/CONTRATTI.md,
//  9.6): ore arrotondate al quarto d'ora giorno per giorno, importo con la tariffa, i progetti fuori dai clienti.
//  I nomi dei clienti non restano sul disco dell'iPhone: la copia vive solo finche' l'app e' aperta.
//

import SwiftUI

struct ClientiView: View {
    let ponte: Ponte
    @State private var lettura = LetturaStanza<StanzaClienti>("clienti")
    /// "" = il mese in corso
    @State private var mese = ""

    var body: some View {
        CorniceStanza(lettura: lettura, query: ["mese": mese]) { d in
            testata(d)
            if d.configurati == 0 {
                RiquadroStanza(titolo: "Nessun cliente") {
                    Text("I clienti si impostano nella stanza Clienti sul Mac, collegando i progetti a ogni cliente.")
                        .font(.callout)
                        .foregroundStyle(Tinte.tinta)
                }
            }
            ForEach(d.clienti) { c in
                RiquadroStanza(titolo: c.nome, nota: c.minuti > 0 ? "\(Int(c.giorni)) giorn\(c.giorni == 1 ? "o" : "i")" : nil) {
                    if c.minuti > 0 {
                        HStack(alignment: .top, spacing: 12) {
                            Cifra(etichetta: "Ore", valore: Formati.ore(c.minuti))
                            Cifra(etichetta: "Da fatturare", valore: c.importo.map { Formati.euro($0) } ?? "senza tariffa", colore: c.importo == nil ? Tinte.tinta : Tinte.ambra)
                        }
                        if let t = c.tariffa { Text("Tariffa \(Formati.euro(t)) l'ora").font(.caption).foregroundStyle(Tinte.tinta) }
                        ForEach(c.progetti) { p in
                            ConSessione(ponte: ponte, progetto: p.nome) {
                                HStack {
                                    Text(p.nome).font(.callout).foregroundStyle(Tinte.testo)
                                    Spacer()
                                    Text(Formati.ore(p.minuti)).font(.callout).monospacedDigit().foregroundStyle(Tinte.tinta)
                                }
                            }
                        }
                    } else {
                        Text("Nessuna ora questo mese.").font(.callout).foregroundStyle(Tinte.tinta)
                    }
                }
            }
            if !d.fuori.isEmpty {
                RiquadroStanza(titolo: "Fuori dai clienti") {
                    ForEach(d.fuori) { p in
                        HStack {
                            Text(p.nome).font(.callout).foregroundStyle(Tinte.testo)
                            Spacer()
                            Text(Formati.ore(p.minuti)).font(.callout).monospacedDigit().foregroundStyle(Tinte.tinta)
                        }
                    }
                }
            }
            Text("Ore arrotondate al quarto d'ora, giorno per giorno.").font(.caption2).foregroundStyle(Tinte.tinta)
        }
    }

    private func testata(_ d: StanzaClienti) -> some View {
        RiquadroStanza(titolo: Formati.chiaveDetta(d.mese).capitalized(with: Formati.it) + (d.inCorso ? ", fin qui" : "")) {
            HStack(alignment: .top, spacing: 12) {
                Cifra(etichetta: "Ore dei clienti", valore: Formati.ore(d.totale.minuti), grande: true)
                if let i = d.totale.importo {
                    Cifra(etichetta: "Da fatturare", valore: Formati.euro(i), grande: true, colore: Tinte.ambra)
                }
            }
            if d.mesi.count > 1 {
                Menu {
                    ForEach(d.mesi, id: \.self) { m in
                        Button(Formati.chiaveDetta(m)) { mese = m == d.mesi.first ? "" : m }
                    }
                } label: {
                    Label("Cambia mese", systemImage: "calendar").font(.footnote)
                }
            }
        }
    }
}
