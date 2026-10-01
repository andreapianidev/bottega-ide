//
//  OrbPanel.swift
//  Bottega Nucleo
//
//  The floating orb: a borderless, non-activating, transparent NSPanel at the bottom
//  centre of the screen, above the Dock, on every Space and over full-screen apps. It
//  never takes focus. Under the orb, a Liquid Glass caption pill shows the live partial
//  transcript or the sentence being spoken (two lines at most).
//
//  Efficiency: the MTKView renders only while the panel is on screen and not occluded,
//  at 60 fps while listening or speaking and 30 fps otherwise. Two minutes after being
//  hidden, the Metal view and its textures are released entirely.
//

import AppKit
import MetalKit

/// MTKView that turns a click into `orb.clicked` and a drag into a window move.
final class OrbMTKView: MTKView {
    var onClick: (() -> Void)?
    var onMoved: (() -> Void)?
    private var downPoint: NSPoint?
    private var dragged = false

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override func mouseDown(with event: NSEvent) {
        downPoint = event.locationInWindow
        dragged = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = downPoint, !dragged else { return }
        let p = event.locationInWindow
        if hypot(p.x - start.x, p.y - start.y) > 3 {
            dragged = true
            window?.performDrag(with: event)
            onMoved?()
        }
    }

    override func mouseUp(with event: NSEvent) {
        defer { downPoint = nil }
        if !dragged { onClick?() }
    }
}

@MainActor
final class OrbPanel: NSObject, NSWindowDelegate {
    static let shared = OrbPanel()

    enum OrbState: Int32 {
        case idle = 0, listening = 1, thinking = 2, speaking = 3, error = 4
        init?(name: String) {
            switch name {
            case "idle": self = .idle
            case "listening": self = .listening
            case "thinking": self = .thinking
            case "speaking": self = .speaking
            case "error": self = .error
            default: return nil
            }
        }
    }

    /// The view is a square; the sphere fills about 48% of its side (~165 pt, up to
    /// ~175 pt while speaking). The rest is room for the halo, rays and sparks.
    static let orbSide: CGFloat = 344
    /// Pixels rendered per point. Below the Retina 2x on purpose: the orb is soft light
    /// (plasma, halo, bloom), and 1.5x costs about half the GPU time of 2x for a
    /// difference that does not show. The layer scales it up.
    static let renderScale: CGFloat = 1.5
    private static let captionMaxWidth: CGFloat = 320

    /// Docked mini orb: always on screen while the Nucleo runs, so it has to cost
    /// nothing. 72 pt view, sphere ~56 pt (zoomed in the shader), rendered at 2x (the
    /// view is tiny, 144 px), no sparks, no bloom, 12 fps while idle.
    static let dockSide: CGFloat = 72
    static let dockScale: CGFloat = 2
    static let dockedIdleFPS = 12
    private static let dockMargin: CGFloat = 24

    enum Presentation: String { case hidden, docked, big }
    private static let panelHeight: CGFloat = orbSide + 22

    private var panel: NSPanel?
    private var container: NSView?
    private var orbView: OrbMTKView?
    private var renderer: OrbRenderer?
    private var buildingView = false
    private var pill: NSView?
    private var label: NSTextField?
    private var captionClear: DispatchWorkItem?
    private var teardown: DispatchWorkItem?

    private(set) var presentation: Presentation = .hidden
    var isVisible: Bool { presentation != .hidden }
    /// The big orb is on screen (the docked one does not keep voice sockets warm).
    var isExpanded: Bool { presentation == .big }
    private(set) var state: OrbState = .idle
    private var caption = ""

    private enum Key {
        static let x = "orb.originX"
        static let y = "orb.originY"
        static let dockX = "orb.dock.originX"
        static let dockY = "orb.dock.originY"
    }

    // MARK: - Public API

    /// The big orb (orb.show).
    func show() { transition(to: .big) }

    /// The docked mini orb (orb.dock).
    func dock() { transition(to: .docked) }

    /// Fully hidden (orb.hide): only when voice is turned off.
    func hide() { transition(to: .hidden) }

    private func transition(to target: Presentation) {
        teardown?.cancel(); teardown = nil
        let from = presentation
        if target == from {
            if target != .hidden, orbView == nil { buildOrbView() }
            return
        }
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if target == .hidden {
            presentation = .hidden
            guard let panel else { return }
            saveOrigin(for: from)
            animate(in: false, reduceMotion: reduce) { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.presentation == .hidden else { return }
                    panel.orderOut(nil)
                    self.updateRendering()
                }
            }
            // Free the GPU memory if the orb stays hidden.
            let work = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated { self?.releaseOrbView() }
            }
            teardown = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 120, execute: work)
            return
        }
        if panel == nil { buildPanel() }
        guard let panel else { return }
        if orbView == nil { buildOrbView() }
        presentation = target
        let appear: @MainActor () -> Void = { [weak self] in
            guard let self, self.presentation == target else { return }
            self.layout(for: target)
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            self.updateRendering()
            self.animate(in: true, reduceMotion: reduce)
        }
        if from != .hidden, panel.isVisible {
            // Big to docked (or back): the current one shrinks away, the other grows in.
            saveOrigin(for: from)
            animate(in: false, reduceMotion: reduce) {
                DispatchQueue.main.async { MainActor.assumeIsolated { appear() } }
            }
        } else {
            appear()
        }
        if target == .big { Speaker.shared.prewarm() }
    }

    /// Sizes and places the panel, the Metal view and the caption for a presentation.
    private func layout(for p: Presentation) {
        guard let panel, p != .hidden else { return }
        let size = p == .docked ? NSSize(width: Self.dockSide, height: Self.dockSide)
                                : NSSize(width: Self.orbSide, height: Self.panelHeight)
        panel.setFrame(NSRect(origin: restoredOrigin(for: p, size: size), size: size), display: false)
        container?.frame = NSRect(origin: .zero, size: size)
        layoutOrbView(p)
        if p == .docked {
            pill?.isHidden = true
            pill?.alphaValue = 0
        } else if !caption.isEmpty {
            applyCaption()
        }
    }

    private func layoutOrbView(_ p: Presentation) {
        guard let v = orbView else { return }
        if p == .docked {
            v.frame = NSRect(x: 0, y: 0, width: Self.dockSide, height: Self.dockSide)
            v.drawableSize = CGSize(width: Self.dockSide * Self.dockScale, height: Self.dockSide * Self.dockScale)
            renderer?.docked = true
        } else {
            v.frame = NSRect(x: 0, y: Self.panelHeight - Self.orbSide, width: Self.orbSide, height: Self.orbSide)
            v.drawableSize = CGSize(width: Self.orbSide * Self.renderScale, height: Self.orbSide * Self.renderScale)
            renderer?.docked = false
        }
    }

    /// From `orb.state`: the extension's word wins until the next voice transition.
    func set(state newState: OrbState, caption newCaption: String?) {
        state = newState
        renderer?.state = newState.rawValue
        if let newCaption { setCaption(newCaption) }
        updateRendering()
    }

    /// From VoiceHub: follow the voice automatically.
    func autoState(_ newState: OrbState) {
        guard newState != state else { return }
        state = newState
        renderer?.state = newState.rawValue
        updateRendering()
        if newState == .idle { scheduleCaptionClear(after: 2.5) }
    }

    func autoCaption(_ text: String) { setCaption(text) }

    // MARK: - Panel

    private func buildPanel() {
        let size = NSSize(width: Self.orbSide, height: Self.panelHeight)
        let p = NSPanel(contentRect: NSRect(origin: NSPoint(x: -2000, y: -2000), size: size),
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.level = .floating
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.isMovableByWindowBackground = true
        p.isReleasedWhenClosed = false
        p.hidesOnDeactivate = false
        p.animationBehavior = .none
        p.title = "Melissa"
        p.delegate = self

        let root = NSView(frame: NSRect(origin: .zero, size: size))
        root.wantsLayer = true
        root.layer?.backgroundColor = .clear
        p.contentView = root
        container = root

        // Caption pill: Liquid Glass. It sits over the lower edge of the orb view, where
        // there is only faint glow.
        let pillView: NSView
        let text = NSTextField(wrappingLabelWithString: "")
        text.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        text.alignment = .center
        text.maximumNumberOfLines = 2
        text.lineBreakMode = .byTruncatingHead
        text.textColor = .labelColor
        text.isSelectable = false
        text.drawsBackground = false
        text.isBezeled = false
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView()
            glass.cornerRadius = 18
            let holder = NSView()
            holder.addSubview(text)
            glass.contentView = holder
            pillView = glass
        } else {
            let fx = NSVisualEffectView()
            fx.material = .hudWindow
            fx.blendingMode = .behindWindow
            fx.state = .active
            fx.wantsLayer = true
            fx.layer?.cornerRadius = 18
            fx.layer?.masksToBounds = true
            fx.addSubview(text)
            pillView = fx
        }
        pillView.alphaValue = 0
        pillView.isHidden = true
        root.addSubview(pillView)
        pill = pillView
        label = text
        panel = p
    }

    private func buildOrbView() {
        guard !buildingView, let root = container, let device = MTLCreateSystemDefaultDevice() else { return }
        buildingView = true
        // Library loading can mean a runtime shader compile: keep it off main.
        Task.detached(priority: .userInitiated) {
            let lib = OrbLibrary.load(device: device)
            await MainActor.run {
                let me = OrbPanel.shared
                me.buildingView = false
                guard let lib, me.orbView == nil else { return }
                let v = OrbMTKView(frame: NSRect(x: 0, y: Self.panelHeight - Self.orbSide,
                                                 width: Self.orbSide, height: Self.orbSide), device: device)
                v.colorPixelFormat = .rgba16Float
                v.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
                v.framebufferOnly = true
                v.enableSetNeedsDisplay = false
                v.autoResizeDrawable = false
                v.drawableSize = CGSize(width: Self.orbSide * Self.renderScale, height: Self.orbSide * Self.renderScale)
                v.layer?.isOpaque = false
                if let ml = v.layer as? CAMetalLayer {
                    ml.wantsExtendedDynamicRangeContent = true
                    ml.colorspace = CGColorSpace(name: CGColorSpace.extendedLinearDisplayP3)
                    ml.isOpaque = false
                }
                guard let r = OrbRenderer(device: device, library: lib, pixelFormat: v.colorPixelFormat) else {
                    Log.error("La sfera non riesce a preparare la sua pipeline Metal.")
                    return
                }
                r.state = me.state.rawValue
                v.delegate = r
                v.onClick = { Out.event("orb.clicked", ["mode": OrbPanel.shared.presentation.rawValue]) }
                v.onMoved = { OrbPanel.shared.saveOrigin(for: OrbPanel.shared.presentation) }
                // Under the pill, so the caption stays on top.
                if let pill = me.pill { root.addSubview(v, positioned: .below, relativeTo: pill) } else { root.addSubview(v) }
                me.orbView = v
                me.renderer = r
                me.layoutOrbView(me.presentation)
                me.updateRendering()
            }
        }
    }

    private func releaseOrbView() {
        guard !isVisible, let v = orbView else { return }
        v.isPaused = true
        v.delegate = nil
        v.removeFromSuperview()
        orbView = nil
        renderer = nil
        Log.info("sfera rilasciata dalla memoria")
    }

    /// 60 fps when the orb reacts to a voice, 30 when it only breathes, 0 when nobody
    /// can see it.
    private func updateRendering() {
        guard let v = orbView else { return }
        let onScreen = isVisible && (panel?.occlusionState.contains(.visible) ?? false)
        let lively = state == .listening || state == .speaking
        if presentation == .docked {
            v.preferredFramesPerSecond = lively ? 30 : Self.dockedIdleFPS
        } else {
            v.preferredFramesPerSecond = lively ? 60 : 30
        }
        v.isPaused = !onScreen
    }

    func windowDidChangeOcclusionState(_ notification: Notification) {
        updateRendering()
    }

    func windowDidMove(_ notification: Notification) {
        if isVisible { saveOrigin(for: presentation) }
    }

    // MARK: - Caption

    private func setCaption(_ text: String) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        captionClear?.cancel(); captionClear = nil
        guard clean != caption else { return }
        caption = clean
        applyCaption()
    }

    /// Lays out and fades the pill for the current caption (also used right after the
    /// panel is built, for a caption that arrived while it did not exist yet).
    private func applyCaption() {
        let clean = caption
        guard let pill, let label else { return }
        // The docked orb has no caption: the text waits for the big one.
        if presentation != .big {
            pill.isHidden = true
            pill.alphaValue = 0
            return
        }
        if clean.isEmpty {
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.18
                pill.animator().alphaValue = 0
            }, completionHandler: {
                MainActor.assumeIsolated {
                    if OrbPanel.shared.caption.isEmpty { pill.isHidden = true }
                }
            })
            return
        }
        label.stringValue = clean
        let maxText = Self.captionMaxWidth - 28
        let fit = label.sizeThatFits(NSSize(width: maxText, height: 200))
        let w = min(Self.captionMaxWidth, max(80, ceil(fit.width) + 28))
        let h = min(52, ceil(fit.height) + 14)
        let x = (Self.orbSide - w) / 2
        pill.frame = NSRect(x: x, y: 2, width: w, height: h)
        label.frame = NSRect(x: 14, y: 7, width: w - 28, height: h - 14)
        if pill.isHidden {
            pill.isHidden = false
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.18
                pill.animator().alphaValue = 1
            }
        }
    }

    private func scheduleCaptionClear(after seconds: Double) {
        captionClear?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.setCaption("") }
        }
        captionClear = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    // MARK: - Position

    private func restoredOrigin(for p: Presentation, size: NSSize) -> NSPoint {
        let d = Nucleo.defaults
        let (kx, ky) = p == .docked ? (Key.dockX, Key.dockY) : (Key.x, Key.y)
        if let x = d.object(forKey: kx) as? Double, let y = d.object(forKey: ky) as? Double {
            let rect = NSRect(origin: NSPoint(x: x, y: y), size: size)
            if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(rect) }) {
                return rect.origin
            }
        }
        let screen = NSScreen.main ?? NSScreen.screens.first
        // visibleFrame already excludes the Dock and the menu bar.
        let vf = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        if p == .docked {
            return NSPoint(x: vf.maxX - size.width - Self.dockMargin, y: vf.minY + Self.dockMargin)
        }
        return NSPoint(x: vf.midX - size.width / 2, y: vf.minY + 6)
    }

    fileprivate func saveOrigin(for p: Presentation) {
        guard let panel, p != .hidden else { return }
        let (kx, ky) = p == .docked ? (Key.dockX, Key.dockY) : (Key.x, Key.y)
        Nucleo.defaults.set(Double(panel.frame.origin.x), forKey: kx)
        Nucleo.defaults.set(Double(panel.frame.origin.y), forKey: ky)
    }

    // MARK: - Animation

    private func animate(in appearing: Bool, reduceMotion: Bool, completion: (@Sendable () -> Void)? = nil) {
        guard let panel, let root = container else { completion?(); return }
        let duration = reduceMotion ? 0.12 : 0.22
        if !reduceMotion, let layer = root.layer {
            let w = root.bounds.width, h = root.bounds.height
            var scaled = CATransform3DMakeTranslation(w / 2, h / 2, 0)
            scaled = CATransform3DScale(scaled, 0.86, 0.86, 1)
            scaled = CATransform3DTranslate(scaled, -w / 2, -h / 2, 0)
            let anim = CABasicAnimation(keyPath: "transform")
            anim.fromValue = appearing ? scaled : CATransform3DIdentity
            anim.toValue = appearing ? CATransform3DIdentity : scaled
            anim.duration = duration
            anim.timingFunction = CAMediaTimingFunction(name: appearing ? .easeOut : .easeIn)
            anim.isRemovedOnCompletion = true
            layer.add(anim, forKey: "orb.scale")
        }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = duration
            panel.animator().alphaValue = appearing ? 1 : 0
        }, completionHandler: completion)
    }
}
