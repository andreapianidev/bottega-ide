import AppKit
import SwiftUI

@MainActor
final class VedettaWindow: NSObject, NSWindowDelegate {
    static let shared = VedettaWindow()

    let model = VedettaModel()
    private var window: NSWindow?
    private var keyMonitor: Any?
    private var holdsQuiet = false

    var isOpen: Bool { window != nil }

    func open() {
        let w = window ?? makeWindow()
        window = w
        if LaunchMode.fromMacOS, !holdsQuiet { Quiet.begin(); holdsQuiet = true }
        NSApp.activate()
        w.makeKeyAndOrderFront(nil)
    }

    func close() { window?.close() }

    private func makeWindow() -> NSWindow {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 850),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        w.title = "La Vedetta"
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.appearance = NSAppearance(named: .darkAqua)
        w.backgroundColor = Roque.nsColor(Roque.zenit)
        w.minSize = NSSize(width: 900, height: 620)
        w.isReleasedWhenClosed = false
        w.tabbingMode = .disallowed
        w.collectionBehavior = [.fullScreenPrimary, .managed]
        w.delegate = self
        let host = NSHostingView(rootView: VedettaView(model: model))
        host.sizingOptions = []
        w.contentView = host
        if !w.setFrameUsingName("BottegaVedetta") {
            if let frame = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame {
                let size = NSSize(width: min(1400, frame.width - 60), height: min(850, frame.height - 60))
                w.setFrame(NSRect(x: frame.midX - size.width / 2, y: frame.midY - size.height / 2,
                                  width: size.width, height: size.height), display: false)
            } else { w.center() }
        }
        w.setFrameAutosaveName("BottegaVedetta")
        installKeys()
        return w
    }

    private func installKeys() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let handled = MainActor.assumeIsolated { () -> Bool in
                guard let self, event.windowNumber == self.window?.windowNumber else { return false }
                let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
                let key = event.charactersIgnoringModifiers ?? ""
                if mods == .command, key == "w" { self.window?.performClose(nil); return true }
                if mods == [.command, .control], key == "f" { self.window?.toggleFullScreen(nil); return true }
                return false
            }
            return handled ? nil : event
        }
    }

    func windowWillClose(_ notification: Notification) {
        guard let w = window else { return }
        w.saveFrame(usingName: "BottegaVedetta")
        w.contentView = nil
        window = nil
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor); self.keyMonitor = nil }
        model.selectedPath = nil
        model.hoveredPath = nil
        MetalEngine.shared.noteRhythm(.vedetta, fps: 0, visible: false)
        if holdsQuiet { Quiet.end(); holdsQuiet = false }
        Out.event("vedetta.closed", [:])
    }
}
