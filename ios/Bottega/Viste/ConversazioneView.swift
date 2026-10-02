//
//  ConversazioneView.swift
//  Bottega per iPhone
//
//  La conversazione con Melissa: e' quella del Mac (il registro della barra della Bottega), quindi quello che
//  le dici dall'iPhone lo ritrovi sul Mac e viceversa. Sotto, le domande pronte.
//

import SwiftUI

struct ConversazioneView: View {
    let stato: StatoMac?
    let melissa: Melissa

    private static let pronte: [(String, String)] = [
        ("Briefing", "Fammi il briefing di oggi."),
        ("Chi mi aspetta", "Quali sessioni Claude mi aspettano e cosa vogliono?"),
        ("Regole", "Ci sono regole violate nei progetti?"),
        ("Al lavoro", "Cosa stanno facendo le sessioni Claude adesso?"),
    ]

    var body: some View {
        ScrollViewReader { scorri in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
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
                    pronte.padding(.top, 6).id("fondo")
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: righe.last?.id) { _, _ in
                withAnimation(.easeOut(duration: 0.25)) { scorri.scrollTo("fondo", anchor: .bottom) }
            }
            .onAppear { scorri.scrollTo("fondo", anchor: .bottom) }
        }
    }

    private var righe: [StatoMac.Riga] { stato?.melissa.registro ?? [] }

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
