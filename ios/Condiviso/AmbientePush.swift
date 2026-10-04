import Foundation

/// L'ambiente APNs dipende dalla firma, non dalla configurazione Debug/Release.
/// Il profilo incorporato contiene una plist XML avvolta nel contenitore CMS.
enum AmbientePush {
    static func attuale(bundle: Bundle = .main) -> String {
        #if targetEnvironment(simulator)
        return "sviluppo"
        #else
        let dati = bundle.url(forResource: "embedded", withExtension: "mobileprovision")
            .flatMap { try? Data(contentsOf: $0) }
        return dalProfilo(dati)
        #endif
    }

    static func dalProfilo(_ dati: Data?, simulatore: Bool = false) -> String {
        if simulatore { return "sviluppo" }
        // App Store e TestFlight possono non incorporare il profilo: APNs produzione.
        guard let dati,
              let inizio = dati.range(of: Data("<plist".utf8)),
              let fine = dati.range(of: Data("</plist>".utf8), in: inizio.lowerBound..<dati.endIndex),
              let plist = try? PropertyListSerialization.propertyList(
                from: dati.subdata(in: inizio.lowerBound..<fine.upperBound), options: [], format: nil),
              let profilo = plist as? [String: Any],
              let diritti = profilo["Entitlements"] as? [String: Any],
              let ambiente = diritti["aps-environment"] as? String else { return "produzione" }
        return ambiente == "development" ? "sviluppo" : "produzione"
    }

    /// Gli ACK di una firma diversa non attestano che il nuovo ambiente conosca
    /// questi token. Anche gli ACK precedenti all'introduzione del marker scadono.
    static func tokenConfermati(preferenze: UserDefaults, ambiente: String) -> [String: String] {
        guard preferenze.string(forKey: "pushAmbiente") == ambiente else {
            preferenze.removeObject(forKey: "tokenMandati")
            preferenze.set(ambiente, forKey: "pushAmbiente")
            return [:]
        }
        return preferenze.dictionary(forKey: "tokenMandati") as? [String: String] ?? [:]
    }
}
