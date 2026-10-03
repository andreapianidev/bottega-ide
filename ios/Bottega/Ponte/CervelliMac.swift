//
//  CervelliMac.swift
//  Bottega per iPhone
//
//  Il cervello di Melissa come lo manda il Mac (GET /v1/cervelli e POST /v1/cervello, docs/CONTRATTI.md, 9.8):
//  quello di adesso, l'impegno, il predefinito e le alternative, con il perche' di quelle che non si possono usare.
//

import Foundation

struct CervelliMac: Codable, Equatable {
    struct Opzione: Codable, Equatable, Identifiable {
        /// agnes, deepseek, apple
        let provider: String
        let nome: String
        /// «gratis», «a consumo, a fondo V4 Pro», «gratis, sul Mac»
        let nota: String
        let disponibile: Bool
        /// perche' non si puo' usare: «senza credito», «il Nucleo non è acceso»
        let perche: String?
        var id: String { provider }
    }
    let provider: String
    let nome: String
    let impegno: String
    let predefinito: String
    let perOra: Bool
    let opzioni: [Opzione]

    static let impegni = ["rapido", "normale", "profondo"]

    /// Dove si torna a fine conversazione, per la frase «poi torna ad Agnes».
    static func ritorno(_ provider: String) -> String {
        switch provider {
        case "deepseek": "a DeepSeek"
        case "apple": "ad Apple Intelligence"
        default: "ad Agnes"
        }
    }
}
