//
//  main.swift
//  Bottega Nucleo
//
//  Two lives in one binary:
//   - service mode (default): launched by the Bottega extension, JSON lines on
//     stdin/stdout, owns the orb, the voice, the hotkey, notifications, the menu bar;
//   - --cli mode: a plain short-lived process for the Memoria hooks (no UI at all).
//  See docs/CONTRATTI.md, section 1.
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
        MainActor.assumeIsolated {
            Notifier.shared.start()
        }
        PressureMonitor.shared.start()
        StdinReader.start()
        Log.info("servizio avviato, versione \(Nucleo.version)")
        Out.event("ready", ["version": Nucleo.version])
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
