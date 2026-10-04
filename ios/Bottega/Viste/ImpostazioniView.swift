//
//  ImpostazioniView.swift
//  Bottega per iPhone
//

import ActivityKit
import SwiftUI
import UIKit

struct ImpostazioniView: View {
    let ponte: Ponte
    @Bindable var melissa: Melissa
    @Environment(\.dismiss) private var chiudi
    @State private var scollego = false
    @State private var importando = false
    @State private var esitoImportazione: String?
    @State private var telefono = AssistenteTelefono.shared
    @AppStorage(Avvisi.chiaveLive, store: Condiviso.preferenze) private var liveAccese = true
    /// Il permesso di sistema (Impostazioni di iOS, Bottega, Live Activity): senza, l'interruttore qui non basta.
    @State private var permessoLive = ActivityAuthorizationInfo().areActivitiesEnabled

    var body: some View {
        NavigationStack {
            Form {
                Section("Melissa") {
                    Toggle("Risponde a voce", isOn: $melissa.voceAccesa)
                    LabeledContent("Sul telefono", value: telefono.configurato ? "pronta anche senza Mac" : "da configurare")
                    Button(importando ? "Importo…" : "Importa Agnes, DeepSeek e ElevenLabs dal Mac") {
                        importando = true
                        Task {
                            defer { importando = false }
                            do {
                                try await ponte.importaConfigurazioneAssistente()
                                esitoImportazione = "Melissa può rispondere dall'iPhone anche con il Mac spento."
                            } catch { esitoImportazione = error.localizedDescription }
                        }
                    }
                    .disabled(importando || ponte.linea != .collegato)
                    if let esitoImportazione { Text(esitoImportazione).font(.footnote) }
                }
                Section {
                    Toggle("Live Activity e Dynamic Island", isOn: $liveAccese)
                        .onChange(of: liveAccese) { _, accese in
                            Task { await Avvisi.shared.cambiaLive(accese) }
                        }
                    if !permessoLive {
                        Button("Apri le impostazioni di iOS") {
                            if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
                        }
                    }
                } header: {
                    Text("Sessioni sulla schermata di blocco")
                } footer: {
                    Text(permessoLive
                         ? "Mentre una sessione Claude lavora sul Mac, la vedi sulla schermata di blocco e nella Dynamic Island."
                         : "Sono spente nelle impostazioni di iOS: accendile in Impostazioni, Bottega, Live Activity.")
                }
                Section {
                    LabeledContent("Mac", value: ponte.collegamento?.nomeMac ?? "nessuno")
                    LabeledContent("Indirizzo", value: ponte.collegamento.map { "\($0.host):\($0.porta)" } ?? "n/d")
                    if let v = ponte.stato?.versione { LabeledContent("Bottega sul Mac", value: v) }
                    LabeledContent("Questa app", value: versioneApp)
                } header: {
                    Text("Collegamento")
                } footer: {
                    Text("I lavori passano da Tailscale e richiedono il Mac acceso. Le domande generiche usano le API direttamente dall'iPhone; le chiavi restano nel suo portachiavi.")
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
            .onAppear { permessoLive = ActivityAuthorizationInfo().areActivitiesEnabled }
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
