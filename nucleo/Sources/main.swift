//
//  main.swift
//  Bottega Nucleo
//
//  Three lives in one binary:
//   - service mode (default): launched by the Bottega extension, JSON lines on
//     stdin/stdout, owns the orb, the voice, the hotkey, notifications, the menu bar;
//   - macOS mode: launched by LaunchServices for an App Intent or a Spotlight click
//     (stdin is not a pipe, see LaunchMode.swift); serves that and quits after 30 s;
//   - --cli mode: a plain short-lived process for the Memoria hooks (no UI at all).
//  See docs/CONTRATTI.md, section 1 and 4.4.
//

import AppKit

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOFBF, 1 << 16)

let arguments = CommandLine.arguments
if let i = arguments.firstIndex(of: "--cli") {
    CLI.run(Array(arguments[(i + 1)...]))
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        if LaunchMode.fromMacOS {
            // Nobody reads our stdout: no JSON lines, no voice, no orb, no menu bar.
            Out.enabled = false
            Log.info("avviato da macOS (intents, Spotlight), versione \(Nucleo.version)")
            MainActor.assumeIsolated { Quiet.start() }
            return
        }
        MainActor.assumeIsolated {
            Notifier.shared.start()
            Power.shared.startMonitoring()
        }
        PressureMonitor.shared.start()
        StdinReader.start()
        Log.info("servizio avviato, versione \(Nucleo.version)")
        Out.event("ready", ["version": Nucleo.version])
    }

    /// A click on one of our Spotlight results (CSSearchableItemActionType).
    func application(_ application: NSApplication, continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([any NSUserActivityRestoring]) -> Void) -> Bool {
        MainActor.assumeIsolated {
            Quiet.touch()
            return Spotlight.open(userActivity)
        }
    }

    func application(_ application: NSApplication, willContinueUserActivityWithType userActivityType: String) -> Bool {
        true
    }

    /// A click on the widget (widgetURL) reaches the app that contains it, us: pass the
    /// bottega:// link on to the Bottega, which owns the scheme.
    func application(_ application: NSApplication, open urls: [URL]) {
        MainActor.assumeIsolated {
            Quiet.touch()
            for url in urls where url.scheme == "bottega" {
                guard let handler = NSWorkspace.shared.urlForApplication(toOpen: url),
                      Bundle(url: handler)?.bundleIdentifier != Nucleo.bundle.bundleIdentifier else {
                    Log.warn("nessuna app apre \(url.absoluteString)")
                    continue
                }
                NSWorkspace.shared.open(url)
            }
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        MainActor.assumeIsolated { Service.shutdown(reason: "terminazione") }
        return .terminateNow
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
