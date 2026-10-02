//
//  Condiviso.swift
//  Bottega per iPhone (app e widget)
//
//  Cosa app ed estensione dei widget hanno in comune: il gruppo (preferenze) e il portachiavi condiviso (il
//  gettone del ponte). Gli identificatori stanno anche in ios/Bottega/Bottega.entitlements e
//  ios/BottegaWidget/BottegaWidget.entitlements.
//

import Foundation

enum Condiviso {
    static let gruppo = "group.com.andreapiani.bottega.ios"
    /// $(AppIdentifierPrefix) + nome: il prefisso e' il team.
    static let portachiavi = "ERAK83QBBM.com.andreapiani.bottega.condiviso"
    static let preferenze = UserDefaults(suiteName: gruppo) ?? .standard
    /// Il token delle push dei widget (WidgetPushHandler): lo scrive l'estensione, lo manda al Mac l'app.
    static let chiaveTokenWidget = "tokenWidget"
}
