import AppKit
import Observation
import SwiftUI

@MainActor
@Observable
final class RegiaModel {
    var data = RegiaData()
}

@MainActor
final class RegiaWindow: NSObject, NSWindowDelegate {
    static let shared = RegiaWindow()
    let model = RegiaModel()
    private var window: NSWindow?
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
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 750),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        w.title = "Regia"
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.appearance = NSAppearance(named: .darkAqua)
        w.backgroundColor = Roque.nsColor(Roque.zenit)
        w.minSize = NSSize(width: 780, height: 560)
        w.isReleasedWhenClosed = false
        w.tabbingMode = .disallowed
        w.collectionBehavior = [.fullScreenPrimary, .managed]
        w.delegate = self
        let host = NSHostingView(rootView: RegiaView(model: model))
        host.sizingOptions = []
        w.contentView = host
        if !w.setFrameUsingName("BottegaRegia") { w.center() }
        w.setFrameAutosaveName("BottegaRegia")
        return w
    }

    func windowWillClose(_ notification: Notification) {
        guard let w = window else { return }
        w.saveFrame(usingName: "BottegaRegia")
        w.contentView = nil
        window = nil
        MetalEngine.shared.noteRhythm(.regia, fps: 0, visible: false)
        if holdsQuiet { Quiet.end(); holdsQuiet = false }
        Out.event("regia.closed", [:])
    }
}
