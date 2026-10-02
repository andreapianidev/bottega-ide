//
//  MenuBar.swift
//  Bottega Nucleo
//
//  Status item: an SF Symbol plus compact counts (in corso, in attesa, in coda), and a
//  menu with one row per job when the extension sends `items`. Appears on the first
//  menubar.update, never on its own.
//  `lines` are rows at the top of the menu (money, rules, briefing), each with an optional
//  colored dot; `tone` puts a small red or yellow dot on the icon. The icon itself stays
//  a template image (it follows the menu bar appearance): the dot is a separate layer.
//

import AppKit

@MainActor
final class MenuBar: NSObject, NSMenuDelegate {
    static let shared = MenuBar()

    struct Item { let id: String; let title: String; let status: String }
    struct Line { let id: String?; let title: String; let tone: String? }

    private var statusItem: NSStatusItem?
    private var busy = 0, waiting = 0, queued = 0
    private var title: String?
    private var items: [Item] = []
    private var lines: [Line] = []
    private var tone: String?
    private var dot: NSView?

    /// `lines` and `tone` follow the same rule as `items`: absent means "keep what you
    /// have". `tone` present but null (`.some(nil)`) removes the dot.
    func update(busy: Int, waiting: Int, queued: Int, title: String?, items: [Item]?, visible: Bool?,
                lines: [Line]? = nil, tone: String?? = .none) {
        if visible == false {
            if let s = statusItem { NSStatusBar.system.removeStatusItem(s); statusItem = nil }
            return
        }
        self.busy = busy; self.waiting = waiting; self.queued = queued
        self.title = title
        if let items { self.items = items }
        if let lines { self.lines = lines }
        if let tone { self.tone = tone }
        if statusItem == nil {
            let s = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            s.behavior = []
            statusItem = s
        }
        render()
    }

    func remove() {
        if let s = statusItem { NSStatusBar.system.removeStatusItem(s); statusItem = nil }
        dot = nil
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
        var tip = "Bottega: \(busy) in corso, \(waiting) in attesa, \(queued) in coda"
        if let first = lines.first(where: { $0.tone == "rosso" }) ?? lines.first(where: { $0.tone == "giallo" }) {
            tip += "\n" + first.title
        }
        button.toolTip = tip
        renderDot(on: button)
        s.menu = buildMenu()
    }

    /// A 6 pt dot over the top trailing corner of the icon, in its own layer so that the
    /// icon stays a template. Hidden when there is no tone.
    private func renderDot(on button: NSStatusBarButton) {
        guard let color = Self.color(for: tone), tone != "ok" else {
            dot?.isHidden = true
            return
        }
        let view: NSView
        if let d = dot, d.superview === button {
            view = d
        } else {
            view = NSView()
            view.wantsLayer = true
            view.layer?.cornerRadius = 3
            button.addSubview(view)
            dot = view
        }
        button.layoutSubtreeIfNeeded()
        let size: CGFloat = 6
        let imageRect = button.cell?.imageRect(forBounds: button.bounds) ?? NSRect(x: 2, y: 2, width: 18, height: 18)
        // NSStatusBarButton is flipped: y grows downwards, so minY is the top edge.
        let flipped = button.isFlipped
        let x = imageRect.maxX - size + 1
        let y = flipped ? imageRect.minY : imageRect.maxY - size
        view.frame = NSRect(x: x, y: y, width: size, height: size)
        view.layer?.backgroundColor = color.cgColor
        // A thin ring in the menu bar's own color keeps the dot readable over the glyph.
        view.layer?.borderWidth = 1
        view.layer?.borderColor = NSColor.windowBackgroundColor.withAlphaComponent(0.6).cgColor
        view.isHidden = false
        view.toolTip = tone == "rosso" ? "Una regola rossa da sistemare" : "Qualcosa da sistemare"
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        if !lines.isEmpty {
            for line in lines {
                let mi = NSMenuItem(title: line.title, action: line.id == nil ? nil : #selector(clicked(_:)),
                                    keyEquivalent: "")
                if let id = line.id {
                    mi.target = self
                    mi.representedObject = id
                }
                // Enabled even without an id: a disabled row would be grey and hard to read.
                mi.isEnabled = true
                if let color = Self.color(for: line.tone) {
                    let config = NSImage.SymbolConfiguration(pointSize: 9, weight: .regular)
                        .applying(.init(paletteColors: [color]))
                    mi.image = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: line.tone)?
                        .withSymbolConfiguration(config)
                }
                menu.addItem(mi)
            }
            menu.addItem(.separator())
        }
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

    private static func color(for tone: String?) -> NSColor? {
        switch tone {
        case "rosso": return .systemRed
        case "giallo": return .systemYellow
        case "ok", "verde": return .systemGreen
        default: return nil
        }
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
