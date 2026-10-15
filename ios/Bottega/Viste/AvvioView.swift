//
//  AvvioView.swift
//  Bottega per iPhone
//
//  La schermata d'avvio di Moony AI: sul cielo nero (CieloView) la luna vera di stasera che si accende
//  (LunaAvvioView), nome, beta e build. La schermata di lancio di iOS e' statica (Info.plist, solo il colore Notte, che dal 16/10/2026 e' nero) e non puo' leggere il
//  bundle: questa ne prende il posto al primo fotogramma, sullo stesso fondo, e sfuma da sola. Non blocca
//  niente: sotto l'app parte subito.
//

import SwiftUI

/// Versione e build lette dal bundle (CFBundleShortVersionString, CFBundleVersion): le scrive
/// scripts/bump-build.sh in Version.xcconfig, quindi sono sempre quelle dell'installazione.
enum VersioneApp {
    static var versione: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?" }
    static var build: String { Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?" }
    /// La fase, come AvoFase su Moony AI per Mac: vuota per una versione stabile, «beta 3» per una beta. Dal 16/10/2026
    /// la versione (CFBundleShortVersionString) e' quella di Moony AI per Mac, scritta da scripts/bump-build.sh --moony.
    static let fase = ""
    /// «4.0.1 (176)»
    static var testo: String { "\(versione) (\(build))" }
    /// «v4.0.1 stabile · build 176», come la schermata d'avvio del Mac
    static var esteso: String { "v\(versione) \(fase.isEmpty ? "stabile" : fase) · build \(build)" }
}

/// «MOONY AI» come sulla schermata d'avvio del Mac (LaunchView): SF Pro grassetto, spaziatura 1,5, il bianco dei titoli.
struct TitoloMoony: View {
    var testo = "MOONY AI"
    var corpo: CGFloat = 40
    /// L'ingresso del Mac: la scritta si stringe e si mette a fuoco, una volta sola.
    var entra = false
    @State private var acceso = false
    @Environment(\.accessibilityReduceMotion) private var riduciMovimento

    var body: some View {
        let fermo = !entra || acceso
        Text(testo)
            .font(.system(size: corpo, weight: .bold))
            .foregroundStyle(Tinte.luce)
            .tracking(fermo ? 1.5 : 14)
            .opacity(fermo ? 1 : 0)
            .blur(radius: fermo ? 0 : 6)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .onAppear {
                guard entra else { return }
                if riduciMovimento { acceso = true } else { withAnimation(.easeOut(duration: 1.4).delay(0.15)) { acceso = true } }
            }
    }
}

struct AvvioView: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            CieloView(attivo: true).ignoresSafeArea()
            VStack(spacing: 14) {
                // la luna vera di stasera, che si accende mentre l'app si prepara (LunaAvvioView); senza Metal l'icona
                if LunaAvvioView.disponibile {
                    LunaAvvioView(durata: 1.4)
                        .frame(width: 280, height: 280)
                } else {
                    Image("Luna")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 220, height: 220)
                        .shadow(color: .white.opacity(0.18), radius: 30)
                }
                TitoloMoony(entra: true)
                Text("Personal intelligence, fully integrated")
                    .font(.caption)
                    .foregroundStyle(Tinte.tinta)
                    .textCase(.uppercase)
                    .tracking(2)
                    .multilineTextAlignment(.center)
                Text(VersioneApp.esteso)
                    .font(.system(size: 11, weight: .medium).monospacedDigit())
                    .foregroundStyle(Tinte.tinta.opacity(0.8))
                    .padding(.top, 2)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    AvvioView()
}
