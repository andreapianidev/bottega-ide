//
//  Nativo.swift
//  Bottega Nucleo
//
//  One door for the native parts (docs/CONTRATTI.md, section 7): Apple Intelligence with
//  tools and the live board (Cervello), the shared Metal engine and the Osservatorio.
//  Service.swift and CLI.swift reach them through here, and here they are wired together:
//  every new line on the board makes that project's star pulse.
//

import Foundation

@MainActor
enum Nativo {
    private static var wired = false

    static func handle(_ r: Request) async throws -> Bool {
        wire()
        if try await CervelloComandi.handle(r) { return true }
        if try await OsservatorioComandi.handle(r) { return true }
        if try await VedettaComandi.handle(r) { return true }
        if try await VistaComandi.handle(r) { return true }
        if try await PonteComandi.handle(r) { return true }
        return false
    }

    /// Board activity -> star pulse in the sky (and nothing else: no rendering unless visible).
    static func wire() {
        guard !wired else { return }
        wired = true
        BachecaViva.shared.onActivity = { project, key, _ in
            MetalEngine.shared.pulse(projectKey: key, project: project)
        }
    }
}

enum NativoCLI {
    static func run(_ argv: [String]) -> Int32? {
        if let code = CervelloCLI.run(argv) { return code }
        if let code = OsservatorioCLI.run(argv) { return code }
        if let code = VistaCLI.run(argv) { return code }
        return nil
    }
}
