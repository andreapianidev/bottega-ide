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

    var body: some Scene {
        WindowGroup {
            Group {
                if ponte.collegato {
                    PlanciaView(ponte: ponte, melissa: melissa, davanti: fase == .active)
                } else {
                    BenvenutoView(ponte: ponte)
                }
            }
            .preferredColorScheme(.dark)
            .tint(Tinte.ambra)
            .onOpenURL { url in
                if let errore = Navigazione.shared.apri(url, ponte: ponte) { melissa.avviso = errore }
            }
            .onChange(of: ponte.collegato) { _, si in
                if si { Avvisi.shared.avvia() } else { Avvisi.shared.dimentica() }
            }
            .onChange(of: fase) { _, nuova in
                switch nuova {
                case .active: ponte.avvia(); Avvisi.shared.avvia()
                case .background: ponte.ferma(); melissa.sospendi()
                default: break
                }
            }
            .onAppear { ponte.avvia(); Avvisi.shared.avvia() }
        }
    }
}
