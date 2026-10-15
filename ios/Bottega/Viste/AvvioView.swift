//
//  AvvioView.swift
//  Bottega per iPhone
//
//  La schermata d'avvio di Moony AI: la luna vera di stasera che si accende (LunaAvvioView), nome, versione e
//  build. La schermata di lancio di iOS e' statica (Info.plist, solo il colore Notte) e non puo' leggere il
//  bundle: questa ne prende il posto al primo fotogramma, sullo stesso fondo, e sfuma da sola. Non blocca
//  niente: sotto l'app parte subito.
//

import SwiftUI

/// Versione e build lette dal bundle (CFBundleShortVersionString, CFBundleVersion): le scrive
/// scripts/bump-build.sh in Version.xcconfig, quindi sono sempre quelle dell'installazione.
enum VersioneApp {
    static var versione: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?" }
    static var build: String { Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?" }
    /// «0.1.1 (162)»
    static var testo: String { "\(versione) (\(build))" }
    /// «versione 0.1.1, build 162»
    static var esteso: String { "versione \(versione), build \(build)" }
}

struct AvvioView: View {
    var body: some View {
        ZStack {
            Color("Notte").ignoresSafeArea()
            VStack(spacing: 18) {
                // la luna vera di stasera, che si accende mentre l'app si prepara (LunaAvvioView); senza Metal l'icona
                if LunaAvvioView.disponibile {
                    LunaAvvioView(durata: 1.4)
                        .frame(width: 190, height: 190)
                } else {
                    Image("Luna")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 150, height: 150)
                        .shadow(color: .white.opacity(0.18), radius: 30)
                }
                Text("Moony AI")
                    .font(.largeTitle.weight(.semibold))
                    .foregroundStyle(Tinte.testo)
                Text(VersioneApp.esteso)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(Tinte.tinta)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    AvvioView()
}
