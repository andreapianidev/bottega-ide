//
//  DaFareView.swift
//  Bottega per iPhone
//
//  Le cose rimaste da fare, progetto per progetto: la riga «Da fare:» dell'ultimo riassunto della Memoria che ne
//  ha una (docs/CONTRATTI.md, 6 e 9.6). Un tocco su un progetto con una sessione aperta apre la sua scheda.
//

import SwiftUI

struct DaFareView: View {
    let ponte: Ponte
    @State private var lettura = LetturaStanza<StanzaDaFare>("dafare")

    var body: some View {
        CorniceStanza(lettura: lettura, query: [:]) { d in
            if d.progetti.isEmpty {
                RiquadroStanza(titolo: "Niente da fare") {
                    Text("Negli ultimi riassunti della Memoria non resta niente da fare.")
                        .font(.callout)
                        .foregroundStyle(Tinte.tinta)
                }
            }
            ForEach(d.progetti) { p in
                RiquadroStanza(titolo: p.nome, nota: "dal riassunto di \(Formati.giorno(ms: p.at))") {
                    ForEach(Array(p.cose.enumerated()), id: \.offset) { _, c in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: "circle").font(.caption2).foregroundStyle(Tinte.ambra)
                            Text(c).font(.callout).foregroundStyle(Tinte.testo).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if let a = p.altre, a > 0 {
                        Text("E altre \(Int(a)).").font(.caption).foregroundStyle(Tinte.tinta)
                    }
                    if sessioneAperta(p.nome) {
                        ConSessione(ponte: ponte, progetto: p.nome) {
                            Text("C'è una sessione aperta su \(p.nome)").font(.caption).foregroundStyle(Tinte.ambra)
                        }
                    }
                }
            }
        }
    }

    private func sessioneAperta(_ nome: String) -> Bool {
        ponte.stato?.lavori.contains { $0.progetto.lowercased() == nome.lowercased() } ?? false
    }
}
