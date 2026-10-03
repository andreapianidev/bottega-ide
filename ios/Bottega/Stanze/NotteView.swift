//
//  NotteView.swift
//  Bottega per iPhone
//
//  La coda della notte del Mac (src/notte.ts, docs/CONTRATTI.md, 4.1 e 9.6): la finestra, i lavori in fila per
//  stanotte, perche' partono o no, e il resoconto dell'ultima notte.
//

import SwiftUI

struct NotteView: View {
    let ponte: Ponte
    @State private var lettura = LetturaStanza<StanzaNotte>("notte")

    var body: some View {
        CorniceStanza(lettura: lettura, query: [:]) { d in
            RiquadroStanza(titolo: "Stanotte", nota: "dalle \(d.finestra.da) alle \(d.finestra.a)") {
                HStack(alignment: .top, spacing: 12) {
                    Cifra(etichetta: "In fila", valore: Formati.numero(d.inFila), colore: d.inFila > 0 ? Tinte.ambra : Tinte.testo)
                    Cifra(etichetta: "In corso", valore: Formati.numero(d.inCorso))
                    Cifra(etichetta: "Alla volta", valore: Formati.numero(d.insieme))
                }
                if !d.perche.isEmpty { Text(d.perche).font(.callout).foregroundStyle(Tinte.testo) }
                if d.corrente == false { Text("Il Mac non è alla corrente.").font(.caption).foregroundStyle(Tinte.ambra) }
                ForEach(d.fila) { l in
                    ConSessione(ponte: ponte, progetto: l.progetto) {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "moon").font(.caption).foregroundStyle(Tinte.ambra).padding(.top, 3)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(l.progetto).font(.callout.weight(.medium)).foregroundStyle(Tinte.testo)
                                Text(l.titolo).font(.caption).foregroundStyle(Tinte.tinta).lineLimit(2)
                            }
                            Spacer()
                        }
                    }
                }
            }
            if let r = d.resoconto {
                RiquadroStanza(titolo: "L'ultima notte", nota: Formati.chiaveDetta(r.giorno)) {
                    if r.lavori.isEmpty {
                        Text("Non ha lavorato nessuno.").font(.callout).foregroundStyle(Tinte.tinta)
                    }
                    ForEach(Array(r.lavori.enumerated()), id: \.offset) { i, j in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 8) {
                                Pallino(colore: colore(j.stato))
                                Text(j.progetto).font(.callout.weight(.medium)).foregroundStyle(Tinte.testo)
                                Text(j.stato).font(.caption).foregroundStyle(Tinte.tinta)
                            }
                            Text(j.compito).font(.caption).foregroundStyle(Tinte.tinta).lineLimit(3)
                            if let s = j.riassunto { Text(s).font(.callout).foregroundStyle(Tinte.testo) }
                        }
                        if i < r.lavori.count - 1 { Divider().overlay(Tinte.bordo) }
                    }
                }
            } else {
                RiquadroStanza(titolo: "L'ultima notte") {
                    Text("Nessun resoconto: la coda della notte non ha ancora lavorato.").font(.callout).foregroundStyle(Tinte.tinta)
                }
            }
        }
    }

    private func colore(_ stato: String) -> Color {
        let s = stato.lowercased()
        if s.contains("fin") || s.contains("fatto") || s.contains("ok") { return Tinte.verde }
        if s.contains("err") || s.contains("fall") || s.contains("ferm") { return Tinte.rosso }
        return Tinte.ambra
    }
}
