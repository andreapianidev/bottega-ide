//
//  BottegaAttivita.swift
//  Bottega per iPhone (app e widget)
//
//  La Live Activity delle sessioni Claude: nella Dynamic Island e sulla schermata di blocco. La avvia e la
//  aggiorna il Mac con le push (docs/CONTRATTI.md, 9.4): i nomi dei campi sono quelli del JSON che manda.
//

import ActivityKit
import Foundation

struct BottegaAttivita: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        struct Riga: Codable, Hashable {
            var progetto: String
            /// "in corso" | "ti aspetta" | "nel terminale" | "in coda" | "stanotte"
            var stato: String
            /// Da quando, in millisecondi dal 1970 (come il ponte).
            var da: Double
        }
        var inCorso: Int
        var tiAspetta: Int
        var vive: Int
        /// Al massimo tre, prima chi ti aspetta.
        var righe: [Riga]
        var aggiornato: Double
    }

    /// Il nome del Mac.
    var mac: String
}
