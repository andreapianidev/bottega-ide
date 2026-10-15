//
//  Tinte.swift
//  Bottega per iPhone (app e widget)
//
//  I colori di Moony: il nero del cielo, l'argento della luna e l'ambra della lampada.
//

import SwiftUI

enum Tinte {
    // 16/10/2026 (Andrea: «sfondo nero nero che risalta il buio, sempre»): il fondo e' nero vero e le superfici
    // sono grafite neutra, non piu' blu notte. La luce la fanno la luna, le stelle e l'ambra della lampada.
    static let notte = Color(red: 0x0f / 255, green: 0x10 / 255, blue: 0x13 / 255)
    static let notteFonda = Color(red: 0x09 / 255, green: 0x0a / 255, blue: 0x0c / 255)
    static let bordo = Color(red: 0x26 / 255, green: 0x28 / 255, blue: 0x2e / 255)
    static let testo = Color(red: 0xe8 / 255, green: 0xe2 / 255, blue: 0xd0 / 255)
    static let tinta = Color(red: 0x8e / 255, green: 0x92 / 255, blue: 0x9b / 255)
    static let ambra = Color(red: 0xf4 / 255, green: 0xab / 255, blue: 0x3c / 255)
    static let rosso = Color(red: 0xee / 255, green: 0x7a / 255, blue: 0x6a / 255)
    static let verde = Color(red: 0x7f / 255, green: 0xd1 / 255, blue: 0x9b / 255)
    /// L'argento della luna: stelle, alone, la scelta accesa.
    static let argento = Color(red: 0xc9 / 255, green: 0xce / 255, blue: 0xd8 / 255)
    /// Le superfici sul nero: vetro appena acceso, con un filo chiaro attorno.
    static let vetro = Color.white.opacity(0.07)
    static let filo = Color.white.opacity(0.12)

    static let sfondo = LinearGradient(colors: [.black, .black], startPoint: .top, endPoint: .bottom)
}
