//
//  BottegaApp.swift
//  Bottega per iPhone
//
//  La Bottega in tasca: Melissa e i lavori del Mac, raggiunti dalla rete Tailscale. Il Mac deve essere
//  acceso con la Bottega aperta; il collegamento arriva dal QR del comando "Collega l'iPhone".
//

import SwiftUI

@main
struct BottegaApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegato
    @State private var ponte = Ponte.shared
    @State private var melissa = Melissa(ponte: Ponte.shared)
    @Environment(\.scenePhase) private var fase
    /// Un link della Bottega non valido arrivato da scollegati: lo mostra la schermata di benvenuto.
    @State private var avvisoLink: String?

    var body: some Scene {
        WindowGroup {
            Group {
                if ponte.collegato {
                    PlanciaView(ponte: ponte, melissa: melissa, davanti: fase == .active)
                } else {
                    BenvenutoView(ponte: ponte, avvisoLink: $avvisoLink)
                }
            }
            .preferredColorScheme(.dark)
            .tint(Tinte.ambra)
            .onOpenURL { url in
                guard let errore = Navigazione.shared.apri(url, ponte: ponte) else { return }
                // l'avviso di Melissa vive nella plancia: da scollegati non si vedrebbe
                if ponte.collegato { melissa.avviso = errore } else { avvisoLink = errore }
            }
            .onChange(of: ponte.collegato) { _, si in
                if si {
                    avvisoLink = nil
                    Avvisi.shared.avvia()
                } else {
                    Avvisi.shared.dimentica()
                    Navigazione.shared.ascoltaSubito = false
                }
            }
            .onChange(of: fase) { _, nuova in
                switch nuova {
                case .active:
                    // aperta prima del primo sblocco il gettone non si leggeva: si riprova
                    ponte.ricarica()
                    ponte.avvia()
                    Avvisi.shared.avvia()
                case .background: ponte.ferma(); melissa.sospendi()
                default: break
                }
            }
            .onAppear { ponte.avvia(); Avvisi.shared.avvia() }
        }
    }
}
