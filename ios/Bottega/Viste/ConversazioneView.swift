//
//  ConversazioneView.swift
//  Bottega per iPhone
//
//  La conversazione con Melissa: i turni fatti sull'iPhone appaiono subito e arrivano anche al Mac
//  con la sincronizzazione. Sotto, le domande pronte.
//

import SwiftUI

struct ConversazioneView: View {
    let stato: StatoMac?
    let melissa: Melissa
    let online: Bool
    @State private var telefono = AssistenteTelefono.shared

    private var statoVisibile: StatoMac? { stato ?? StatoMac.ultimo() }

    private static let pronte: [(String, String)] = [
        ("Briefing", "Fammi il briefing di oggi."),
        ("Chi mi aspetta", "Quali attività Claude, Cline, Codex o terminali mi aspettano?"),
        ("Regole", "Ci sono regole violate nei progetti?"),
        ("Al lavoro", "Cosa stanno facendo Claude, Cline, Codex e i terminali adesso?"),
    ]

    var body: some View {
        ScrollViewReader { scorri in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if !online, let ultimo = statoVisibile, !ultimo.melissa.registro.isEmpty {
                        Text("Ultima conversazione ricevuta dal Mac alle \(Date(timeIntervalSince1970: ultimo.ora / 1000).formatted(date: .abbreviated, time: .shortened)).")
                            .font(.caption)
                            .foregroundStyle(Tinte.tinta)
                    }
                    if righe.isEmpty {
                        Text("Qui compare la conversazione con Melissa, la stessa che vedi nella Bottega sul Mac.")
                            .font(.callout)
                            .foregroundStyle(Tinte.tinta)
                            .padding(.top, 24)
                            .frame(maxWidth: .infinity)
                            .multilineTextAlignment(.center)
                    }
                    ForEach(righe) { r in
                        Fumetto(riga: r).id(r.id)
                    }
                    if let parziale = stato?.melissa.risposta, !parziale.isEmpty, online {
                        Text(parziale)
                            .font(.body)
                            .foregroundStyle(Tinte.testo)
                            .textSelection(.enabled)
                            .padding(14)
                            .background(RoundedRectangle(cornerRadius: 18).fill(Tinte.notteFonda))
                            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Tinte.bordo))
                            .id("risposta-mac")
                    }
                    if !telefono.rispostaParziale.isEmpty {
                        Text(telefono.rispostaParziale)
                            .font(.body)
                            .foregroundStyle(Tinte.testo)
                            .padding(14)
                            .background(RoundedRectangle(cornerRadius: 18).fill(Tinte.notteFonda))
                    }
                    pronte.padding(.top, 6).id("fondo")
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: righe.last?.id) { _, _ in
                withAnimation(.easeOut(duration: 0.25)) { scorri.scrollTo("fondo", anchor: .bottom) }
            }
            .onChange(of: stato?.melissa.risposta?.count) { _, _ in
                scorri.scrollTo("fondo", anchor: .bottom)
            }
            .onAppear { scorri.scrollTo("fondo", anchor: .bottom) }
        }
    }

    private var righe: [StatoMac.Riga] {
        // Il server assegna il proprio orario ai turni importati. Mostriamo solo i locali ancora in attesa,
        // cosi' non appaiono due volte dopo che sono entrati nel registro del Mac.
        let mac = statoVisibile?.melissa.registro ?? []
        let locali = telefono.turni.filter { turno in
            !turno.sincronizzato || (!online && !mac.contains { $0.chi == turno.riga.chi && $0.testo == turno.riga.testo })
        }
        return (mac + locali.map(\.riga))
            .sorted { $0.alle < $1.alle }
    }

    private var pronte: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Self.pronte, id: \.0) { p in
                    Button(p.0) { melissa.scrivi(p.1) }
                        .font(.footnote.weight(.medium))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(Capsule().fill(Tinte.notteFonda))
                        .overlay(Capsule().stroke(Tinte.bordo))
                        .foregroundStyle(Tinte.testo)
                        .disabled(melissa.occupata)
                }
            }
        }
    }
}

private struct Fumetto: View {
    let riga: StatoMac.Riga

    var body: some View {
        switch riga.chi {
        case "azione":
            Label(riga.testo, systemImage: "bolt.fill")
                .font(.footnote)
                .foregroundStyle(Tinte.ambra)
                .padding(.horizontal, 4)
        case "tu":
            HStack {
                Spacer(minLength: 48)
                Text(riga.testo)
                    .font(.body)
                    .foregroundStyle(Tinte.notteFonda)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Tinte.ambra))
            }
        default:
            HStack {
                Text(riga.testo)
                    .font(.body)
                    .foregroundStyle(Tinte.testo)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Tinte.notteFonda))
                    .overlay(RoundedRectangle(cornerRadius: 18).stroke(Tinte.bordo))
                Spacer(minLength: 48)
            }
        }
    }
}
