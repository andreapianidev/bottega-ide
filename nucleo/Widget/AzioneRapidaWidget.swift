//
//  AzioneRapidaWidget.swift
//  Bottega Nucleo, widget da scrivania
//
//  The widget's body for the quick actions of Shared/AzioniRapide.swift. They declare
//  allowedExecutionTargets .main, so the system performs them in the Nucleo: this runs
//  only if a future system ignores that. Then it asks LaunchServices for the link,
//  which a sandboxed extension may do for a URL scheme owned by another app.
//

import AppKit

enum AzioneRapida {
    @MainActor
    static func apri(_ via: String, _ query: [String: String] = [:]) async throws {
        guard let url = BottegaURL.make(via, query) else { return }
        NSWorkspace.shared.open(url)
    }
}
