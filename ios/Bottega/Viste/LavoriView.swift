//
//  LavoriView.swift
//  Bottega per iPhone
//
//  Tutte le sessioni Claude del Mac, come nella stanza Lavori: in cima chi ti aspetta. Ai lavori avviati dalla
//  Bottega si puo' scrivere da qui; le sessioni aperte altrove si leggono chiedendo a Melissa.
//

import SwiftUI

struct LavoriView: View {
    let ponte: Ponte
    @State private var scelto: StatoMac.Lavoro?

    var body: some View {
        List {
            if lavori.isEmpty {
                Text(ponte.stato == nil ? "Aspetto il Mac…" : "Nessuna sessione Claude aperta sul Mac.")
                    .foregroundStyle(Tinte.tinta)
                    .listRowBackground(Color.clear)
            }
            ForEach(gruppi, id: \.0) { g in
                Section(g.0) {
                    ForEach(g.1) { l in
                        Button {
                            if l.jobId != nil { scelto = l }
                        } label: {
                            Riga(lavoro: l)
                        }
                        .listRowBackground(Tinte.notteFonda.opacity(0.7))
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .refreshable { await ponte.aggiornaStato() }
        .sheet(item: $scelto) { l in
            ScriviLavoroView(ponte: ponte, lavoro: l)
                .presentationDetents([.medium])
        }
    }

    private var lavori: [StatoMac.Lavoro] { ponte.stato?.lavori ?? [] }

    private var gruppi: [(String, [StatoMac.Lavoro])] {
        let ordine = ["ti aspetta", "in corso", "nel terminale", "in coda", "stanotte"]
        return ordine.compactMap { s in
            let l = lavori.filter { $0.stato == s }
            return l.isEmpty ? nil : (s.prefix(1).uppercased() + s.dropFirst(), l)
        }
    }
}

private struct Riga: View {
    let lavoro: StatoMac.Lavoro

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(lavoro.stato == "ti aspetta" ? Tinte.ambra : lavoro.stato == "in corso" ? Tinte.verde : Tinte.tinta)
                .frame(width: 9, height: 9)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                Text(lavoro.progetto)
                    .font(.headline)
                    .foregroundStyle(Tinte.testo)
                Text(lavoro.titolo)
                    .font(.subheadline)
                    .foregroundStyle(Tinte.tinta)
                    .lineLimit(2)
                Text(dettaglio)
                    .font(.caption)
                    .foregroundStyle(Tinte.tinta.opacity(0.8))
            }
            Spacer()
            if lavoro.jobId != nil {
                Image(systemName: "text.bubble")
                    .foregroundStyle(Tinte.ambra)
                    .padding(.top, 4)
            }
        }
        .padding(.vertical, 4)
    }

    private var dettaglio: String {
        let minuti = max(0, Int((Date().timeIntervalSince1970 * 1000 - lavoro.da) / 60_000))
        let quando = minuti < 1 ? "adesso" : minuti < 60 ? "da \(minuti) min" : "da \(minuti / 60) h \(minuti % 60) min"
        return "\(lavoro.origine == "bottega" ? "Lavoro della Bottega" : "Aperta altrove"), \(quando)"
    }
}

private struct ScriviLavoroView: View {
    let ponte: Ponte
    let lavoro: StatoMac.Lavoro
    @Environment(\.dismiss) private var chiudi
    @State private var testo = ""
    @State private var errore: String?
    @State private var invio = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Cosa deve fare Claude", text: $testo, axis: .vertical)
                        .lineLimit(3...8)
                } header: {
                    Text(lavoro.titolo)
                } footer: {
                    Text(errore ?? "Il testo arriva nel terminale del lavoro sul Mac, come se lo scrivessi tu.")
                        .foregroundStyle(errore == nil ? Tinte.tinta : Tinte.rosso)
                }
            }
            .navigationTitle(lavoro.progetto)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { chiudi() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Manda") {
                        Task {
                            invio = true
                            do {
                                try await ponte.scriviLavoro(lavoro.jobId ?? "", testo)
                                chiudi()
                            } catch {
                                errore = error.localizedDescription
                            }
                            invio = false
                        }
                    }
                    .disabled(testo.trimmingCharacters(in: .whitespaces).isEmpty || invio)
                }
            }
        }
    }
}
