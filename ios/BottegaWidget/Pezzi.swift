//
//  Pezzi.swift
//  Bottega per iPhone, estensione dei widget
//
//  I pezzi comuni a widget e Live Activity: la sferetta, il colore di ogni stato, le frasi con il plurale giusto
//  e la durata che scorre da sola (senza aggiornamenti dal Mac).
//

import SwiftUI
import WidgetKit

enum Pezzi {
    static let lavori = URL(string: "bottega://lavori")!

    static func colore(_ stato: String) -> Color {
        switch stato {
        case "ti aspetta": Tinte.ambra
        case "in corso": Tinte.verde
        default: Tinte.tinta
        }
    }

    /// "1 ti aspetta", "2 ti aspettano".
    static func aspetta(_ n: Int) -> String { n == 1 ? "1 ti aspetta" : "\(n) ti aspettano" }

    /// "2 al lavoro".
    static func alLavoro(_ n: Int) -> String { "\(n) al lavoro" }

    /// Millisecondi dal 1970, come li manda il ponte.
    static func data(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    /// Prima chi ti aspetta, poi chi lavora, poi il resto: l'ordine della stanza Lavori.
    static let ordine = ["ti aspetta", "in corso", "nel terminale", "in coda", "stanotte"]

    static func rango(_ stato: String) -> Int { ordine.firstIndex(of: stato) ?? ordine.count }

    /// Da quanto: "12 min", "1 h 5 min". Scorre da sola, senza che il widget chieda niente a nessuno.
    static func daQuanto(_ da: Date) -> Text {
        Text(.currentDate, format: .offset(to: da, allowedFields: [.day, .hour, .minute], maxFieldCount: 2, sign: .never))
            .monospacedDigit()
    }
}

/// La sferetta della Bottega: il blu della notte acceso dalla lampada. Ambra quando qualcuno ti aspetta.
struct Sferetta: View {
    var aspetta: Bool
    var lavora: Bool = true
    var diametro: CGFloat = 16

    var body: some View {
        let luce = aspetta ? Tinte.ambra : lavora ? Color(red: 0x8f / 255, green: 0xb4 / 255, blue: 0xe8 / 255) : Tinte.tinta
        Circle()
            .fill(RadialGradient(colors: [Tinte.testo, luce, luce.opacity(0.35)],
                                 center: UnitPoint(x: 0.38, y: 0.34), startRadius: 0, endRadius: diametro * 0.62))
            .overlay(Circle().strokeBorder(luce.opacity(0.6), lineWidth: max(0.5, diametro / 28)))
            .shadow(color: luce.opacity(0.55), radius: diametro / 5)
            .frame(width: diametro, height: diametro)
    }
}
