//
//  BenvenutoView.swift
//  Bottega per iPhone
//
//  Prima del collegamento: come si collega l'iPhone al Mac.
//

import SwiftUI
import UIKit

struct BenvenutoView: View {
    let ponte: Ponte
    /// Un QR o un link non valido aperto da fuori (BottegaApp).
    @Binding var avvisoLink: String?
    @State private var avviso: String?

    var body: some View {
        ZStack {
            Tinte.sfondo.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 22) {
                    Image("Lampada")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 132, height: 132)
                        .shadow(color: Tinte.ambra.opacity(0.25), radius: 30)
                        .padding(.top, 48)
                    VStack(spacing: 8) {
                        Text("La Bottega in tasca")
                            .font(.largeTitle.weight(.semibold))
                            .foregroundStyle(Tinte.testo)
                        Text("Melissa e i lavori del tuo Mac, da dove vuoi.")
                            .font(.body)
                            .foregroundStyle(Tinte.tinta)
                    }
                    .multilineTextAlignment(.center)

                    VStack(alignment: .leading, spacing: 16) {
                        passo(1, "Sul Mac, nella Bottega, apri la palette dei comandi e scegli «Collega l'iPhone».")
                        passo(2, "Inquadra il codice con la Fotocamera dell'iPhone e tocca il collegamento: la Bottega si apre già collegata.")
                        passo(3, "Tailscale acceso sull'iPhone e sul Mac, il Mac acceso con la Bottega aperta. Funziona anche fuori casa.")
                    }
                    .padding(20)
                    .background(RoundedRectangle(cornerRadius: 20).fill(Tinte.notteFonda.opacity(0.7)))
                    .overlay(RoundedRectangle(cornerRadius: 20).stroke(Tinte.bordo))

                    Button {
                        incolla()
                    } label: {
                        Label("Incolla il collegamento", systemImage: "doc.on.clipboard")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                    }
                    .buttonStyle(.borderedProminent)
                    .foregroundStyle(Tinte.notteFonda)
                    .clipShape(RoundedRectangle(cornerRadius: 14))

                    if let avviso {
                        Text(avviso)
                            .font(.footnote)
                            .foregroundStyle(Tinte.rosso)
                            .multilineTextAlignment(.center)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 40)
            }
        }
        .alert("Collegamento", isPresented: Binding(get: { avvisoLink != nil }, set: { if !$0 { avvisoLink = nil } })) {
            Button("Va bene", role: .cancel) {}
        } message: {
            Text(avvisoLink ?? "")
        }
    }

    private func passo(_ n: Int, _ testo: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Text("\(n)")
                .font(.headline.monospacedDigit())
                .foregroundStyle(Tinte.notteFonda)
                .frame(width: 28, height: 28)
                .background(Circle().fill(Tinte.ambra))
            Text(testo)
                .font(.callout)
                .foregroundStyle(Tinte.testo)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func incolla() {
        guard let s = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = URL(string: s), ponte.collega(url) else {
            avviso = "Negli appunti non c'è un collegamento della Bottega. Sul Mac usa «Copia il collegamento»."
            return
        }
        avviso = nil
        // il gettone non resta negli appunti, dove lo leggerebbe qualunque app
        UIPasteboard.general.items = []
    }
}
