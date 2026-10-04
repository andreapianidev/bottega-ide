//
//  OsservatorioWindow.swift
//  Bottega Nucleo
//
//  The Osservatorio's window: a normal NSWindow (title "Osservatorio", resizable, its
//  frame remembered, ready for full screen on a second monitor). It opens even though
//  the Nucleo is an accessory app (no Dock icon): it activates the app and comes front.
//
//  Closed means gone: the hosting view, the MTKView, the renderer and its textures are
//  released, nothing draws, 0% CPU and GPU. The model (the last numbers) stays, and the
//  last numbers are also kept in ~/.bottega/nucleo/osservatorio.json (600) so the window
//  shows them at once next time, even when macOS opens the Nucleo for an intent.
//

import AppKit
import SwiftUI

@MainActor
final class OsservatorioWindow: NSObject, NSWindowDelegate {
    static let shared = OsservatorioWindow()

    let model = OsservatorioModel()
    private var window: NSWindow?
    private var keyMonitor: Any?
    private var holdsQuiet = false

    var isOpen: Bool { window != nil }

    private static let autosave = "BottegaOsservatorio"
    private static let defaultSize = NSSize(width: 1280, height: 820)

    /// Opens the window or brings it front. `secondScreen`: overview mode, and when there
    /// is a second monitor the window moves there in full screen.
    func open(secondScreen: Bool = false) {
        if model.data == nil, let cached = OsservatorioStore.load() { model.data = cached }
        if secondScreen { model.secondScreen = true }
        let w = window ?? makeWindow()
        window = w
        if LaunchMode.fromMacOS, !holdsQuiet { Quiet.begin(); holdsQuiet = true }
        NSApp.activate()
        w.makeKeyAndOrderFront(nil)
        if secondScreen { moveToSecondScreen(w) }
    }

    func close() {
        window?.close()
    }

    private func makeWindow() -> NSWindow {
        let w = NSWindow(contentRect: NSRect(origin: .zero, size: Self.defaultSize),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        w.title = "Osservatorio"
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.appearance = NSAppearance(named: .darkAqua)
        w.backgroundColor = Roque.nsColor(Roque.zenit)
        w.minSize = NSSize(width: 860, height: 620)
        w.isReleasedWhenClosed = false
        w.tabbingMode = .disallowed
        w.collectionBehavior = [.fullScreenPrimary, .managed]
        w.delegate = self
        let host = NSHostingView(rootView: OsservatorioView(model: model))
        host.sizingOptions = []
        w.contentView = host
        if !w.setFrameUsingName(Self.autosave) {
            if let vf = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame {
                let size = NSSize(width: min(Self.defaultSize.width, vf.width - 80), height: min(Self.defaultSize.height, vf.height - 60))
                w.setFrame(NSRect(x: vf.midX - size.width / 2, y: vf.midY - size.height / 2, width: size.width, height: size.height), display: false)
            } else {
                w.center()
            }
        }
        w.setFrameAutosaveName(Self.autosave)
        installKeys()
        return w
    }

    /// Without a main menu, the usual keys by hand: Esc leaves the second-screen mode,
    /// Cmd-W closes, Ctrl-Cmd-F toggles full screen.
    private func installKeys() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            let code = e.keyCode
            let mods = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
            let chars = e.charactersIgnoringModifiers ?? ""
            let number = e.windowNumber
            let handled = MainActor.assumeIsolated {
                self?.handleKey(code: code, mods: mods, chars: chars, windowNumber: number) ?? false
            }
            return handled ? nil : e
        }
    }

    private func handleKey(code: UInt16, mods: NSEvent.ModifierFlags, chars: String, windowNumber: Int) -> Bool {
        guard let w = window, w.windowNumber == windowNumber else { return false }
        if code == 53, mods.isEmpty, model.secondScreen {
            model.secondScreen = false
            return true
        }
        if mods == .command, chars == "w" { w.performClose(nil); return true }
        if mods == [.command, .control], chars == "f" { w.toggleFullScreen(nil); return true }
        return false
    }

    private func moveToSecondScreen(_ w: NSWindow) {
        let screens = NSScreen.screens
        guard screens.count > 1, let main = NSScreen.screens.first,
              let other = screens.first(where: { $0 != main && $0 != w.screen }) ?? screens.first(where: { $0 != main }) else { return }
        if !w.styleMask.contains(.fullScreen) {
            let vf = other.visibleFrame
            w.setFrame(vf.insetBy(dx: 40, dy: 40), display: true)
            DispatchQueue.main.async { w.toggleFullScreen(nil) }
        }
    }

    func windowWillClose(_ notification: Notification) {
        guard let w = window else { return }
        w.saveFrame(usingName: Self.autosave)
        // Drop the whole view tree: the MTKView and its renderer go with it.
        w.contentView = nil
        window = nil
        if let m = keyMonitor { NSEvent.removeMonitor(m); keyMonitor = nil }
        model.camera = SkyCamera()
        model.selected = nil
        model.hovered = nil
        MetalEngine.shared.noteRhythm(.sky, fps: 0, visible: false)
        if holdsQuiet { Quiet.end(); holdsQuiet = false }
        Out.event("osservatorio.closed", [:])
    }
}

/// The last numbers on disk (outside any repository): ~/.bottega/nucleo/osservatorio.json.
enum OsservatorioStore {
    /// BOTTEGA_OSSERVATORIO_FILE points somewhere else (tests: never the real file).
    static var url: URL {
        if let p = ProcessInfo.processInfo.environment["BOTTEGA_OSSERVATORIO_FILE"], !p.isEmpty {
            return URL(fileURLWithPath: (p as NSString).expandingTildeInPath)
        }
        return Nucleo.supportDir.appendingPathComponent("osservatorio.json")
    }

    static func save(_ json: Data) {
        let fm = FileManager.default
        do {
            try json.write(to: url, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            Log.warn("Osservatorio: non riesco a salvare gli ultimi numeri: \(error.localizedDescription)")
        }
    }

    static func load() -> OsservatorioData? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let d = OsservatorioData.decode(data)
        return d.isEmpty ? nil : d
    }
}
