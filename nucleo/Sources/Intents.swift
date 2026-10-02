//
//  Intents.swift
//  Bottega Nucleo
//
//  App Intents for Comandi rapidi, Spotlight and Siri (docs/CONTRATTI.md, 4.5 and 4.6).
//  The first two only open a bottega:// link (the extension asks for confirmation before
//  doing anything); the other two read ~/.bottega/stato.json, which the extension keeps
//  up to date. The metadata the system needs to see them (Metadata.appintents) is
//  produced at build time by appintentsmetadataprocessor, see build.sh.
//

import AppIntents
import AppKit

// MARK: - Intents

struct ChiediAMelissa: AppIntent {
    static let title: LocalizedStringResource = "Chiedi a Melissa"
    static let description = IntentDescription("Apre la Bottega e fa una domanda a Melissa.")
    static let supportedModes: IntentModes = .background

    @Parameter(title: "Domanda", requestValueDialog: "Cosa vuoi chiedere a Melissa?")
    var testo: String

    static var parameterSummary: some ParameterSummary {
        Summary("Chiedi a Melissa \(\.$testo)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        Quiet.begin(); defer { Quiet.end() }
        try BottegaLink.open("chiedi", ["testo": testo])
        return .result()
    }
}

struct AvviaLavoro: AppIntent {
    static let title: LocalizedStringResource = "Avvia un lavoro"
    static let description = IntentDescription("Prepara un lavoro di Claude su un progetto. La Bottega chiede conferma prima di avviarlo.")
    static let supportedModes: IntentModes = .background

    @Parameter(title: "Progetto", requestValueDialog: "Su quale progetto?")
    var progetto: String

    @Parameter(title: "Compito", requestValueDialog: "Cosa deve fare Claude?")
    var compito: String

    static var parameterSummary: some ParameterSummary {
        Summary("Avvia \(\.$compito) su \(\.$progetto)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        Quiet.begin(); defer { Quiet.end() }
        try BottegaLink.open("lavoro", ["progetto": progetto, "compito": compito])
        return .result()
    }
}

struct LeggiBriefing: AppIntent {
    static let title: LocalizedStringResource = "Briefing"
    static let description = IntentDescription("Il briefing del giorno della Bottega: ore, lavori, store, regole.")
    static let supportedModes: IntentModes = .background

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        Quiet.begin(); defer { Quiet.end() }
        let text = Stato.load().briefingText
        try? BottegaLink.open("briefing", [:])
        return .result(value: text, dialog: IntentDialog(stringLiteral: text))
    }
}

struct StatoDelleRegole: AppIntent {
    static let title: LocalizedStringResource = "Stato delle regole"
    static let description = IntentDescription("Quante regole sono violate nei progetti, e quali.")
    static let supportedModes: IntentModes = .background

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        Quiet.begin(); defer { Quiet.end() }
        let text = Stato.load().rulesSentence
        return .result(value: text, dialog: IntentDialog(stringLiteral: text))
    }
}

// MARK: - App Shortcuts (Spotlight, Siri, Comandi rapidi without setup)

struct BottegaScorciatoie: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ChiediAMelissa(), phrases: [
            "Chiedi a Melissa con \(.applicationName)",
            "Fai una domanda a Melissa con \(.applicationName)",
        ], shortTitle: "Chiedi a Melissa", systemImageName: "waveform")
        AppShortcut(intent: AvviaLavoro(), phrases: [
            "Avvia un lavoro con \(.applicationName)",
            "Nuovo lavoro con \(.applicationName)",
        ], shortTitle: "Avvia un lavoro", systemImageName: "hammer")
        AppShortcut(intent: LeggiBriefing(), phrases: [
            "Briefing di \(.applicationName)",
            "Leggimi il briefing di \(.applicationName)",
        ], shortTitle: "Briefing", systemImageName: "sun.horizon")
        AppShortcut(intent: StatoDelleRegole(), phrases: [
            "Stato delle regole di \(.applicationName)",
            "Come stanno le regole su \(.applicationName)",
        ], shortTitle: "Stato delle regole", systemImageName: "checklist")
    }
}

// MARK: - Links and state

enum BottegaLink {
    static let base = "bottega://andreapiani.bottega-home/"

    static func url(_ via: String, _ query: [String: String]) -> URL? {
        guard var c = URLComponents(string: base + via) else { return nil }
        if !query.isEmpty {
            c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
            // URLComponents leaves "+" alone, and a form decoder would read it as a space.
            let encoded = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
            c.percentEncodedQuery = encoded
        }
        return c.url
    }

    @MainActor
    static func open(_ via: String, _ query: [String: String]) throws {
        guard let u = url(via, query) else { throw NucleoError("Indirizzo della Bottega non valido.") }
        Log.info("apro \(u.absoluteString)")
        guard NSWorkspace.shared.open(u) else {
            throw NucleoError("Non riesco ad aprire la Bottega: è installata in Applicazioni?")
        }
    }
}
