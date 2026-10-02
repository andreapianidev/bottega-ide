//
//  ControlloMelissa.swift
//  Bottega per iPhone, estensione dei widget
//
//  Il controllo «Parla con Melissa» per il Centro di Controllo, la schermata di blocco e il tasto Azione: apre
//  l'app su bottega://melissa?ascolta=1 e la sfera comincia ad ascoltare.
//
//  Perche' cosi': l'intento gira qui nell'estensione e restituisce un OpenURLIntent, che e' il sistema ad
//  eseguire aprendo l'app con l'indirizzo. Non serve openAppWhenRun (deprecato da iOS 26) ne' copiare l'intento
//  nell'app: l'app riceve solo l'indirizzo, come da un QR o da una notifica.
//

import AppIntents
import SwiftUI
import WidgetKit

struct ApriMelissaIntent: AppIntent {
    static let title: LocalizedStringResource = "Parla con Melissa"
    static let description = IntentDescription("Apre la Bottega con Melissa gia' in ascolto.")
    /// In Comandi rapidi ci sono gia' le azioni dell'app: questa serve solo al controllo.
    static let isDiscoverable = false

    static let indirizzo = URL(string: "bottega://melissa?ascolta=1")!

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(Self.indirizzo))
    }
}

struct ControlloMelissa: ControlWidget {
    static let kind = "com.andreapiani.bottega.ios.widget.melissa"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: ApriMelissaIntent()) {
                Label("Parla con Melissa", systemImage: "waveform.circle.fill")
            }
            .tint(Tinte.ambra)
        }
        .displayName("Parla con Melissa")
        .description("Apre la Bottega con Melissa in ascolto.")
    }
}
