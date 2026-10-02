//
//  ImpostazioniView.swift
//  Bottega per iPhone
//

import SwiftUI

struct ImpostazioniView: View {
    let ponte: Ponte
    @Bindable var melissa: Melissa
    @Environment(\.dismiss) private var chiudi
    @State private var scollego = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Melissa") {
                    Toggle("Risponde a voce", isOn: $melissa.voceAccesa)
                }
                Section {
                    LabeledContent("Mac", value: ponte.collegamento?.nomeMac ?? "nessuno")
                    LabeledContent("Indirizzo", value: ponte.collegamento.map { "\($0.host):\($0.porta)" } ?? "n/d")
                    if let v = ponte.stato?.versione { LabeledContent("Bottega sul Mac", value: v) }
                    LabeledContent("Questa app", value: versioneApp)
                } header: {
                    Text("Collegamento")
                } footer: {
                    Text("Passa da Tailscale: il Mac deve essere acceso, con la Bottega aperta. Il gettone resta nel portachiavi di questo iPhone.")
                }
                Section {
                    Button(scollego ? "Scollego…" : "Scollega questo iPhone", role: .destructive) {
                        scollego = true
                        melissa.chiudiConversazione()
                        Task {
                            // prima il Mac smette di mandare notifiche e Live Activity a questo iPhone
                            await ponte.scollega()
                            chiudi()
                        }
                    }
                    .disabled(scollego)
                }
            }
            .navigationTitle("Impostazioni")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Fatto") { chiudi() } }
            }
        }
    }

    private var versioneApp: String {
        let i = Bundle.main.infoDictionary
        return "\(i?["CFBundleShortVersionString"] as? String ?? "?") (\(i?["CFBundleVersion"] as? String ?? "?"))"
    }
}
