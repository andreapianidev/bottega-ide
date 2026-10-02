//
//  BottegaWidgetBundle.swift
//  Bottega per iPhone, estensione dei widget
//
//  Tutto quello che la Bottega mette fuori dall'app (docs/CONTRATTI.md, 9.4): il widget «Sessioni», la Live
//  Activity delle sessioni Claude e il controllo «Parla con Melissa».
//

import SwiftUI
import WidgetKit

@main
struct BottegaWidgetBundle: WidgetBundle {
    var body: some Widget {
        SessioniWidget()
        AttivitaWidget()
        ControlloMelissa()
    }
}
