//
//  Tinte.swift
//  Bottega per iPhone (app e widget)
//
//  I colori di Bottega Notte: il blu della notte e l'ambra della lampada.
//

import SwiftUI

enum Tinte {
    static let notte = Color(red: 0x12 / 255, green: 0x1a / 255, blue: 0x2e / 255)
    static let notteFonda = Color(red: 0x0c / 255, green: 0x12 / 255, blue: 0x22 / 255)
    static let bordo = Color(red: 0x26 / 255, green: 0x31 / 255, blue: 0x50 / 255)
    static let testo = Color(red: 0xe8 / 255, green: 0xe2 / 255, blue: 0xd0 / 255)
    static let tinta = Color(red: 0x8f / 255, green: 0x98 / 255, blue: 0xad / 255)
    static let ambra = Color(red: 0xf4 / 255, green: 0xab / 255, blue: 0x3c / 255)
    static let rosso = Color(red: 0xee / 255, green: 0x7a / 255, blue: 0x6a / 255)
    static let verde = Color(red: 0x7f / 255, green: 0xd1 / 255, blue: 0x9b / 255)

    static let sfondo = LinearGradient(colors: [Color(red: 0x1b / 255, green: 0x27 / 255, blue: 0x44 / 255), notte, notteFonda],
                                       startPoint: .top, endPoint: .bottom)
}
