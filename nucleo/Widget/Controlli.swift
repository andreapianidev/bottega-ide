//
//  Controlli.swift
//  Bottega Nucleo, widget da scrivania
//
//  Control Center controls (macOS 26+): one button each for Melissa, the plancia, a new
//  work item and the Osservatorio. The intents are in Shared/AzioniRapide.swift and run
//  in the Nucleo, which opens the bottega:// link.
//

import AppIntents
import SwiftUI
import WidgetKit

struct ControlloMelissa: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.andreapiani.bottega.controllo.melissa") {
            ControlWidgetButton(action: ParlaConMelissa()) {
                Label("Melissa", systemImage: "waveform")
            }
        }
        .displayName("Parla con Melissa")
        .description("Apre la Bottega e accende la conversazione con Melissa.")
    }
}

struct ControlloPlancia: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.andreapiani.bottega.controllo.plancia") {
            ControlWidgetButton(action: ApriPlancia()) {
                Label("Plancia", systemImage: "square.grid.2x2")
            }
        }
        .displayName("Apri la plancia")
        .description("Apre la Bottega sulla plancia.")
    }
}

struct ControlloNuovoLavoro: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.andreapiani.bottega.controllo.lavoro") {
            ControlWidgetButton(action: NuovoLavoro()) {
                Label("Nuovo lavoro", systemImage: "hammer")
            }
        }
        .displayName("Nuovo lavoro")
        .description("Apre il compositore dei lavori di Claude. Niente parte senza conferma.")
    }
}

struct ControlloOsservatorio: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.andreapiani.bottega.controllo.osservatorio") {
            ControlWidgetButton(action: ApriOsservatorio()) {
                Label("Osservatorio", systemImage: "moon.stars")
            }
        }
        .displayName("Apri l'Osservatorio")
        .description("Ore, progetti e token della Bottega in un cielo stellato.")
    }
}
