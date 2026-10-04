//
//  BottegaAttivita.swift
//  Bottega per iPhone (app e widget)
//
//  La Live Activity delle sessioni osservate sul Mac: nella Dynamic Island e sulla schermata di blocco. La avvia e la
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
            /// Nome leggibile della sorgente. Assente nelle push delle Botteghe precedenti.
            var fonte: String? = nil
        }
        var inCorso: Int
        var tiAspetta: Int
        var vive: Int
        /// Al massimo tre, prima chi ti aspetta.
        var righe: [Riga]
        var aggiornato: Double
        /// La sessione seguita dall'iPhone («segui questo lavoro»): progetto, ultimo passo corto (un verbo e un nome
        /// di file o di programma, mai percorsi o argomenti) e stato. Facoltativo: manca quando non si segue niente.
        struct Segui: Codable, Hashable {
            var progetto: String
            var passo: String
            var stato: String
        }
        var segui: Segui? = nil
    }

    /// Il nome del Mac.
    var mac: String
}
