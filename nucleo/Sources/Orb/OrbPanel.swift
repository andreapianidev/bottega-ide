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

    private(set) var isVisible = false
    private(set) var state: OrbState = .idle
    private var caption = ""

    private enum Key {
        static let x = "orb.originX"
        static let y = "orb.originY"
    }

    // MARK: - Public API

    func show() {
        teardown?.cancel(); teardown = nil
        if panel == nil {
            buildPanel()
            if !caption.isEmpty { applyCaption() }
        }
        guard let panel else { return }
        if orbView == nil { buildOrbView() }
        if isVisible { return }
        isVisible = true
        panel.setFrameOrigin(restoredOrigin(for: panel))
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        updateRendering()
        animate(in: true, reduceMotion: reduce)
        Speaker.shared.prewarm()
    }

    func hide() {
        guard let panel, isVisible else { return }
        isVisible = false
        saveOrigin()
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        animate(in: false, reduceMotion: reduce) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.isVisible else { return }
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
                v.onClick = { Out.event("orb.clicked") }
                v.onMoved = { OrbPanel.shared.saveOrigin() }
                // Under the pill, so the caption stays on top.
                if let pill = me.pill { root.addSubview(v, positioned: .below, relativeTo: pill) } else { root.addSubview(v) }
                me.orbView = v
                me.renderer = r
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
        v.preferredFramesPerSecond = (state == .listening || state == .speaking) ? 60 : 30
        v.isPaused = !onScreen
    }

    func windowDidChangeOcclusionState(_ notification: Notification) {
        updateRendering()
    }

    func windowDidMove(_ notification: Notification) {
        if isVisible { saveOrigin() }
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

    private func restoredOrigin(for panel: NSPanel) -> NSPoint {
        let size = panel.frame.size
        let d = Nucleo.defaults
        if let x = d.object(forKey: Key.x) as? Double, let y = d.object(forKey: Key.y) as? Double {
            let rect = NSRect(origin: NSPoint(x: x, y: y), size: size)
            if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(rect) }) {
                return rect.origin
            }
        }
        let screen = NSScreen.main ?? NSScreen.screens.first
        let vf = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        // visibleFrame already excludes the Dock: sit just above it, centred.
        return NSPoint(x: vf.midX - size.width / 2, y: vf.minY + 6)
    }

    fileprivate func saveOrigin() {
        guard let panel else { return }
        Nucleo.defaults.set(Double(panel.frame.origin.x), forKey: Key.x)
        Nucleo.defaults.set(Double(panel.frame.origin.y), forKey: Key.y)
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
