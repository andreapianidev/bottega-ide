//
//  VedettaView.swift
//  Bottega per iPhone
//
//  La Vedetta del Mac (docs/CONTRATTI.md, 4.1 e 9.6): il semaforo dei progetti, prima i rossi, ognuno con la frase
//  e il rimedio, poi i siti su Vercel con lo stato dell'ultima pubblicazione (prima le fallite). Guarda le
//  pubblicazioni, non se i siti rispondono in questo momento.
//

import SwiftUI

struct VedettaView: View {
    let ponte: Ponte
    @State private var lettura = LetturaStanza<StanzaVedetta>("vedetta")

    var body: some View {
        CorniceStanza(lettura: lettura, query: [:], datiDelMac: { $0.aggiornatoAt }) { d in
            semaforo(d)
            if !d.globali.isEmpty {
                RiquadroStanza(titolo: "Per tutti i progetti") {
                    ForEach(d.globali) { RigaRegola(regola: $0) }
                }
            }
            if !d.progetti.isEmpty { progetti(d) }
            if let s = d.siti { siti(s) }
        }
    }

    private func semaforo(_ d: StanzaVedetta) -> some View {
        RiquadroStanza(titolo: "Semaforo") {
            HStack(spacing: 18) {
                conto(d.conti.rosso, "rossi", Tinte.rosso)
                conto(d.conti.giallo, "gialli", Tinte.ambra)
                conto(d.conti.verde, "verdi", Tinte.verde)
                Spacer()
            }
        }
    }

    private func conto(_ n: Double, _ nome: String, _ colore: Color) -> some View {
        HStack(spacing: 6) {
            Pallino(colore: colore)
            Text("\(Int(n))").font(.title3.weight(.semibold)).monospacedDigit().foregroundStyle(Tinte.testo)
            Text(nome).font(.caption).foregroundStyle(Tinte.tinta)
        }
        .accessibilityElement(children: .combine)
    }

    private func progetti(_ d: StanzaVedetta) -> some View {
        let altri = Int(d.progettiTotali ?? 0) - d.progetti.count
        return RiquadroStanza(titolo: "Da sistemare", nota: altri > 0 ? "e altri \(altri) sul Mac" : nil) {
            ForEach(d.progetti) { p in
                VStack(alignment: .leading, spacing: 6) {
                    ConSessione(ponte: ponte, progetto: p.nome) {
                        HStack(spacing: 8) {
                            Pallino(colore: p.livello == "rosso" ? Tinte.rosso : Tinte.ambra)
                            Text(p.nome).font(.callout.weight(.semibold)).foregroundStyle(Tinte.testo)
                            Spacer()
                        }
                    }
                    ForEach(p.regole) { RigaRegola(regola: $0).padding(.leading, 17) }
                    if let a = p.altre, a > 0 {
                        Text("E altre \(Int(a)).").font(.caption).foregroundStyle(Tinte.tinta).padding(.leading, 17)
                    }
                }
                if p.id != d.progetti.last?.id { Divider().overlay(Tinte.bordo) }
            }
        }
    }

    private func siti(_ s: StanzaVedetta.Siti) -> some View {
        RiquadroStanza(titolo: "Siti su Vercel", nota: "\(Int(s.conti.ok)) pubblicati" + (s.conti.male > 0 ? ", \(Int(s.conti.male)) falliti" : "") + (s.conti.attesa > 0 ? ", \(Int(s.conti.attesa)) in corso" : "")) {
            ForEach(s.elenco) { x in
                HStack(alignment: .top, spacing: 10) {
                    Pallino(colore: x.tono == "male" ? Tinte.rosso : x.tono == "attesa" ? Tinte.ambra : Tinte.verde).padding(.top, 5)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(x.nome).font(.callout.weight(.medium)).foregroundStyle(Tinte.testo)
                        Text("\(x.etichetta), \(Formati.giorno(ms: x.at))" + (x.dominio.map { ", \($0)" } ?? ""))
                            .font(.caption)
                            .foregroundStyle(Tinte.tinta)
                        if let e = x.errore { Text(e).font(.caption).foregroundStyle(Tinte.rosso) }
                        if let o = x.onlineDal { Text("Online resta quella di \(Formati.giorno(ms: o)).").font(.caption).foregroundStyle(Tinte.tinta) }
                    }
                    Spacer()
                }
            }
            if let e = s.errore { Text("L'ultima lettura non è riuscita: \(e)").font(.caption).foregroundStyle(Tinte.rosso) }
            Text("Guardo lo stato delle pubblicazioni, non se i siti rispondono in questo momento.")
                .font(.caption2)
                .foregroundStyle(Tinte.tinta)
        }
    }
}

private struct RigaRegola: View {
    let regola: StanzaVedetta.Regola

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(regola.frase).font(.callout).foregroundStyle(regola.livello == "rosso" ? Tinte.rosso : Tinte.testo)
            Text(regola.rimedio).font(.caption).foregroundStyle(Tinte.tinta)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}
