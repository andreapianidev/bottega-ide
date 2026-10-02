//
//  AzioniRapide.swift
//  Bottega Nucleo (app and widget)
//
//  Quick actions for the Control Center controls (Widget/Controlli.swift) and Comandi
//  rapidi. Compiled into both targets because a control must name an intent its own
//  extension contains, but performed only by the Nucleo (allowedExecutionTargets .main):
//  the sandboxed widget cannot open the Bottega. Each one opens a bottega:// link,
//  the same way the older intents do.
//
//  AzioneRapida.apri(_:) has one body per target: Sources/Entita/AzioneRapidaNucleo.swift
//  (BottegaLink, Quiet) and Widget/AzioneRapidaWidget.swift (a fallback that should
//  never run). No compiler flag needed.
//

import AppIntents
import Foundation

struct ParlaConMelissa: AppIntent {
    static let title: LocalizedStringResource = "Parla con Melissa"
    static let description = IntentDescription("Apre la Bottega e accende la conversazione con Melissa.")
    static let supportedModes: IntentModes = .background
    static let allowedExecutionTargets: IntentExecutionTargets = .main

    func perform() async throws -> some IntentResult {
        try await AzioneRapida.apri("melissa")
        return .result()
    }
}

struct ApriPlancia: AppIntent {
    static let title: LocalizedStringResource = "Apri la plancia"
    static let description = IntentDescription("Apre la Bottega sulla plancia.")
    static let supportedModes: IntentModes = .background
    static let allowedExecutionTargets: IntentExecutionTargets = .main

    func perform() async throws -> some IntentResult {
        try await AzioneRapida.apri("plancia")
        return .result()
    }
}

struct NuovoLavoro: AppIntent {
    static let title: LocalizedStringResource = "Nuovo lavoro"
    static let description = IntentDescription("Apre la Bottega sul compositore dei lavori. Niente parte senza conferma.")
    static let supportedModes: IntentModes = .background
    static let allowedExecutionTargets: IntentExecutionTargets = .main

    func perform() async throws -> some IntentResult {
        try await AzioneRapida.apri("lavoro")
        return .result()
    }
}

struct ApriOsservatorio: AppIntent {
    static let title: LocalizedStringResource = "Apri l'Osservatorio"
    static let description = IntentDescription("Apre l'Osservatorio: ore, progetti e token della Bottega in un cielo stellato.")
    static let supportedModes: IntentModes = .background
    static let allowedExecutionTargets: IntentExecutionTargets = .main

    func perform() async throws -> some IntentResult {
        try await AzioneRapida.apri("osservatorio")
        return .result()
    }
}

/// bottega://andreapiani.bottega-home/<via>?... built with Foundation only (the widget has
/// no BottegaLink). Same encoding as BottegaLink.url in Intents.swift.
enum BottegaURL {
    static let base = "bottega://andreapiani.bottega-home/"

    static func make(_ via: String, _ query: [String: String] = [:]) -> URL? {
        guard var c = URLComponents(string: base + via) else { return nil }
        if !query.isEmpty {
            c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
            // A form decoder would read a bare "+" as a space.
            c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        }
        return c.url
    }
}
