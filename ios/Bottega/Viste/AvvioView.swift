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
    /// La beta di Moony AI che questa build porta all'iPhone. I numeri sono unici fra Mac e iPhone: la 6 e la 9 sono
    /// dell'iPhone, le altre del Mac (AvoFase, nel repository di Moony AI). Si alza a mano, d'accordo con il Mac.
    static let fase = "4.0 beta 9"
    /// «4.0 beta 6 (172)»
    static var testo: String { "\(fase) (\(build))" }
    /// «4.0 beta 6, build 172»
    static var esteso: String { "\(fase), build \(build)" }
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
                Text("Moony AI")
                    .font(.system(size: 38, weight: .regular, design: .serif))
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
