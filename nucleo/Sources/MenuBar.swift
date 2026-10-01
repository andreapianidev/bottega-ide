//
//  MenuBar.swift
//  Bottega Nucleo
//
//  Status item: an SF Symbol plus compact counts (in corso, in attesa, in coda), and a
//  menu with one row per job when the extension sends `items`. Appears on the first
//  menubar.update, never on its own.
//

import AppKit

@MainActor
final class MenuBar: NSObject, NSMenuDelegate {
    static let shared = MenuBar()

    struct Item { let id: String; let title: String; let status: String }

    private var statusItem: NSStatusItem?
    private var busy = 0, waiting = 0, queued = 0
    private var title: String?
    private var items: [Item] = []

    func update(busy: Int, waiting: Int, queued: Int, title: String?, items: [Item]?, visible: Bool?) {
        if visible == false {
            if let s = statusItem { NSStatusBar.system.removeStatusItem(s); statusItem = nil }
            return
        }
        self.busy = busy; self.waiting = waiting; self.queued = queued
        self.title = title
        if let items { self.items = items }
        if statusItem == nil {
            let s = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            s.behavior = []
            statusItem = s
        }
        render()
    }

    func remove() {
        if let s = statusItem { NSStatusBar.system.removeStatusItem(s); statusItem = nil }
    }

    private func render() {
        guard let s = statusItem, let button = s.button else { return }
        let symbol: String
        if waiting > 0 { symbol = "hand.raised.fill" }
        else if busy > 0 { symbol = "sparkles" }
        else { symbol = "circle.hexagongrid" }
        let img = NSImage(systemSymbolName: symbol, accessibilityDescription: "Bottega")
        img?.isTemplate = true
        button.image = img
        button.imagePosition = .imageLeading

        var text = title ?? ""
        if title == nil {
            var parts: [String] = []
            if busy > 0 { parts.append("\(busy)") }
            if waiting > 0 { parts.append("\(waiting) in attesa") }
            if queued > 0 { parts.append("+\(queued)") }
            text = parts.joined(separator: " · ")
        }
        button.title = text.isEmpty ? "" : " " + text
        button.font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize(for: .small), weight: .regular)
        button.toolTip = "Bottega: \(busy) in corso, \(waiting) in attesa, \(queued) in coda"
        s.menu = buildMenu()
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        let summary = NSMenuItem(title: "In corso \(busy), in attesa \(waiting), in coda \(queued)", action: nil, keyEquivalent: "")
        summary.isEnabled = false
        menu.addItem(summary)
        if !items.isEmpty {
            menu.addItem(.separator())
            for it in items {
                let mi = NSMenuItem(title: it.title, action: #selector(clicked(_:)), keyEquivalent: "")
                mi.target = self
                mi.representedObject = it.id
                mi.image = NSImage(systemSymbolName: Self.symbol(for: it.status), accessibilityDescription: it.status)
                mi.toolTip = Self.label(for: it.status)
                menu.addItem(mi)
            }
        }
        menu.addItem(.separator())
        let open = NSMenuItem(title: "Apri la Bottega", action: #selector(clicked(_:)), keyEquivalent: "")
        open.target = self
        open.representedObject = "open"
        menu.addItem(open)
        return menu
    }

    @objc private func clicked(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        Out.event("menubar.clicked", ["item": id])
    }

    private static func symbol(for status: String) -> String {
        switch status {
        case "busy", "running", "in corso": return "circle.dotted.circle"
        case "waiting", "attesa", "in attesa": return "hand.raised"
        case "queued", "coda", "in coda": return "clock"
        case "done", "fatto", "finito": return "checkmark.circle"
        case "error", "errore": return "exclamationmark.triangle"
        default: return "circle"
        }
    }

    private static func label(for status: String) -> String {
        switch status {
        case "busy", "running": return "in corso"
        case "waiting": return "in attesa"
        case "queued": return "in coda"
        case "done": return "finito"
        case "error": return "errore"
        default: return status
        }
    }
}
