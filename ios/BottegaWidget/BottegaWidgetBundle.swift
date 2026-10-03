//
//  BottegaWidgetBundle.swift
//  Bottega per iPhone, estensione dei widget
//
//  Tutto quello che la Bottega mette fuori dall'app (docs/CONTRATTI.md, 9.4): il widget «Sessioni», il widget
//  «Bottega» (l'icona, che apre l'app), la Live Activity delle sessioni Claude e il controllo «Parla con Melissa».
//  Dalle stanze del Mac (9.6): «Guadagni», «Consigli», «Crediti» e «Semaforo».
//

import SwiftUI
import WidgetKit

@main
struct BottegaWidgetBundle: WidgetBundle {
    var body: some Widget {
        SessioniWidget()
        IconaWidget()
        GuadagniWidget()
        ConsigliWidget()
        CreditiWidget()
        SemaforoWidget()
        AttivitaWidget()
        ControlloMelissa()
    }
}
