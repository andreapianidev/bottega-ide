//
//  LaunchMode.swift
//  Bottega Nucleo
//
//  Who started us. The extension spawns the Nucleo with stdin on a pipe (a socketpair,
//  for Node); macOS (an App Intent, a click on a Spotlight result) launches it through
//  LaunchServices with stdin on /dev/null. In that second life the Nucleo only serves
//  intents and Spotlight: no voice, no orb, no hotkey, no menu bar, no JSON on stdout,
//  and it quits by itself after 30 seconds of quiet (docs/CONTRATTI.md, 4.4).
//
//  BOTTEGA_NUCLEO_MODO=servizio|macos forces one or the other (tests, diagnostics).
//

import AppKit
import Darwin

enum LaunchMode {
    static let fromMacOS: Bool = {
        switch ProcessInfo.processInfo.environment["BOTTEGA_NUCLEO_MODO"] {
        case "servizio": return false
        case "macos": return true
        default: break
        }
        // A terminal (someone typing JSON by hand) counts as service mode too.
        if isatty(STDIN_FILENO) != 0 { return false }
        var st = stat()
        guard fstat(STDIN_FILENO, &st) == 0 else { return true }   // no stdin at all
        let type = st.st_mode & S_IFMT
        return !(type == S_IFIFO || type == S_IFSOCK)
    }()

    static var name: String { fromMacOS ? "macos" : "servizio" }
}

/// The quiet timer of the macOS mode: every intent or Spotlight click calls touch().
@MainActor
enum Quiet {
    static let seconds: TimeInterval = 30
    private static var timer: Timer?
    private static var busy = 0

    static func start() { touch() }

    static func touch() {
        guard LaunchMode.fromMacOS else { return }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in
            MainActor.assumeIsolated {
                if busy > 0 { touch(); return }
                Log.info("modo macos: \(Int(seconds)) s di quiete, esco")
                Service.shutdown(reason: "quiete")
            }
        }
        timer?.tolerance = 2
    }

    /// Keeps the process alive while an intent is still working.
    static func begin() { busy += 1; touch() }
    static func end() { busy = max(0, busy - 1); touch() }
}
