//
//  AzioneRapidaNucleo.swift
//  Bottega Nucleo
//
//  The Nucleo's body for the quick actions of Shared/AzioniRapide.swift: open the link
//  through BottegaLink, kept alive by Quiet like every other intent.
//

import Foundation

enum AzioneRapida {
    @MainActor
    static func apri(_ via: String, _ query: [String: String] = [:]) async throws {
        Quiet.begin(); defer { Quiet.end() }
        try BottegaLink.open(via, query)
    }
}
