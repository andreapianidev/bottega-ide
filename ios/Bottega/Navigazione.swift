//
//  Navigazione.swift
//  Bottega per iPhone
//
//  Dove va l'app quando arriva un link bottega:// (dal QR, da un widget, dalla Live Activity, dal Centro di
//  Controllo) o un tocco su una notifica.
//
//    bottega://collega?...          collega l'iPhone al Mac
//    bottega://lavori               la stanza Lavori
//    bottega://melissa[?ascolta=1]  la stanza Melissa, e con ascolta=1 la sfera comincia ad ascoltare
//    bottega://stanze[?nome=appstore]  le stanze della plancia, e con nome quella stanza aperta (Stanze/)
//

import Foundation
import Observation

@MainActor
@Observable
final class Navigazione {
    static let shared = Navigazione()

    enum Stanza: String, CaseIterable { case melissa = "Melissa", lavori = "Lavori", stanze = "Stanze" }

    var stanza: Stanza = .melissa
    /// La stanza della plancia aperta a tutto schermo (StanzeView), se ce n'e' una.
    var stanzaAperta: StanzaPlancia?
    /// Messo a vero da un link: la plancia fa partire l'ascolto e lo rimette a falso.
    var ascoltaSubito = false

    /// Vero se il link era della Bottega (anche se non valido); il messaggio d'errore, se ce n'e' uno.
    func apri(_ url: URL, ponte: Ponte) -> String? {
        guard url.scheme == "bottega" else { return nil }
        switch url.host {
        case "collega":
            return ponte.collega(url) ? nil : "Quel collegamento non è valido: rifallo dalla Bottega sul Mac."
        case "lavori":
            stanza = .lavori
        case "melissa":
            stanza = .melissa
            // da scollegati resterebbe armato e la sfera partirebbe da sola al collegamento
            if ponte.collegato,
               URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "ascolta" && $0.value == "1" }) == true {
                ascoltaSubito = true
            }
        case "stanze":
            stanza = .stanze
            let nome = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "nome" }?.value
            // come il Mac, che normalizza il nome: anche ?nome=AppStore apre la stanza
            stanzaAperta = nome.flatMap { StanzaPlancia(rawValue: $0.lowercased()) }
        default:
            break
        }
        return nil
    }
}
