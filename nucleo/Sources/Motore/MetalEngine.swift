//
//  MetalEngine.swift
//  Bottega Nucleo
//
//  One Metal engine for the whole Nucleo: one device, one command queue, one shader
//  library (default.metallib holds every shader: orb and sky). Nothing is created until
//  somebody draws: `shared` itself is a few properties and one notification observer.
//
//  It also owns what every renderer needs to agree on:
//  - frame cost per client (CPU encoding time, GPU time from gpuStartTime/gpuEndTime),
//    as moving averages, for `metal.stats` and `--cli metal-bench`;
//  - the rhythm: 0 fps when nobody can see a view, 12/15/30/60 by state, and Reduce
//    motion (no continuous animation: one frame when the data changes);
//  - the load of the Claude sessions (busy, waiting) and the per-project pulses from the
//    live board: the orb breathes faster with the work, the sky's stars flash.
//
//  Thread-safety: draws and commands run on main, GPU completion handlers on a Metal
//  thread. Everything mutable sits behind one lock; no call holds it for long.
//

import AppKit
import Metal
import QuartzCore

final class MetalEngine: @unchecked Sendable {
    static let shared = MetalEngine()

    /// Who draws. The raw value is the name in reports.
    enum Client: String, CaseIterable {
        case orb = "sfera"
        case orbDocked = "sferaAgganciata"
        case sky = "cielo"
        case vedetta = "vedetta"
    }

    /// Posted on main when something that changes a picture without animation changed:
    /// Reduce motion, the load, a pulse. Views paused under Reduce motion redraw once.
    static let didChange = Notification.Name("bottega.metal.didChange")

    private let lock = NSLock()

    private init() {
        reduceMotionCache = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            let v = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            self.lock.withLock { self.reduceMotionCache = v }
            Self.notifyChange()
        }
    }

    // MARK: - Device, queue, library

    private var deviceStorage: MTLDevice?
    private var queueStorage: MTLCommandQueue?
    private var libraries: [MTLLibrary]?
    private var librarySource = "nessuna"

    /// The system GPU, created on first use.
    var device: MTLDevice? {
        lock.withLock {
            if deviceStorage == nil { deviceStorage = MTLCreateSystemDefaultDevice() }
            return deviceStorage
        }
    }

    /// The one command queue every renderer submits to.
    var queue: MTLCommandQueue? {
        guard let dev = device else { return nil }
        return lock.withLock {
            if queueStorage == nil {
                queueStorage = dev.makeCommandQueue()
                queueStorage?.label = "bottega.motore"
            }
            return queueStorage
        }
    }

    /// The precompiled default.metallib (every shader). Slow only the first time and only
    /// on the fallback path, so callers on main should load it from a detached task.
    var library: MTLLibrary? { loadLibraries().first }

    /// The library that contains `function`: the single default.metallib, or on the
    /// fallback path the one compiled from the .metal file that defines it.
    func library(containing function: String) -> MTLLibrary? {
        loadLibraries().first { $0.functionNames.contains(function) }
    }

    func makeFunction(_ name: String) -> MTLFunction? {
        library(containing: name)?.makeFunction(name: name)
    }

    /// Where the shaders came from: "precompilati", "compilati al volo" or "nessuna".
    var shaderSource: String { lock.withLock { librarySource } }

    private func loadLibraries() -> [MTLLibrary] {
        guard let dev = device else { return [] }
        lock.lock()
        if let libs = libraries { lock.unlock(); return libs }
        lock.unlock()
        // Built outside the lock (it can take seconds on the fallback path); two racing
        // callers both compile and the first one in wins: harmless and rare.
        var libs: [MTLLibrary] = []
        var source = "nessuna"
        if let url = Nucleo.bundle.url(forResource: "default", withExtension: "metallib"),
           let lib = try? dev.makeLibrary(URL: url) {
            libs = [lib]
            source = "precompilati"
        } else {
            // Each .metal file on its own: helpers with the same name in two files would
            // clash in a single source.
            let urls = Nucleo.bundle.urls(forResourcesWithExtension: "metal", subdirectory: nil) ?? []
            let opts = MTLCompileOptions()
            opts.mathMode = .fast
            for url in urls.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
                do {
                    libs.append(try dev.makeLibrary(source: text, options: opts))
                } catch {
                    Log.error("Shader \(url.lastPathComponent) non compilabili: \(error.localizedDescription)")
                }
            }
            if !libs.isEmpty {
                source = "compilati al volo"
                Log.info("shader compilati al volo (\(libs.count) file)")
            } else {
                Log.error("Il motore Metal non trova shader nel pacchetto.")
            }
        }
        lock.lock()
        defer { lock.unlock() }
        if let existing = libraries { return existing }
        libraries = libs
        librarySource = source
        return libs
    }

    // MARK: - Frame cost

    private struct Cost {
        var cpuMicros: Double = 0
        var gpuMs: Double = 0
        var frames: Int = 0
        var gpuFrames: Int = 0
        var lastFrame: CFTimeInterval = 0
        var fps: Int = 0
        var visible = false
    }
    private var costs: [Client: Cost] = [:]
    /// Weight of the newest sample in the moving averages (~30 frames of memory).
    private static let ema = 0.06

    struct FrameToken {
        let client: Client
        let cpuStart: UInt64
    }

    /// Call right before encoding (after the drawable is in hand: waiting for one is
    /// not encoding work).
    func beginFrame(_ client: Client) -> FrameToken {
        FrameToken(client: client, cpuStart: clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID))
    }

    /// Call after encoding, before commit: records the CPU time now and the GPU time
    /// when the command buffer completes.
    func endFrame(_ token: FrameToken, commandBuffer cmd: MTLCommandBuffer) {
        let cpu = Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - token.cpuStart) / 1000
        let client = token.client
        let now = CACurrentMediaTime()
        lock.withLock {
            var c = costs[client] ?? Cost()
            c.cpuMicros = c.frames == 0 ? cpu : c.cpuMicros + (cpu - c.cpuMicros) * Self.ema
            c.frames += 1
            c.lastFrame = now
            costs[client] = c
        }
        cmd.addCompletedHandler { [weak self] cb in
            let gpu = (cb.gpuEndTime - cb.gpuStartTime) * 1000
            guard gpu > 0, let self else { return }
            self.lock.withLock {
                var c = self.costs[client] ?? Cost()
                c.gpuMs = c.gpuFrames == 0 ? gpu : c.gpuMs + (gpu - c.gpuMs) * Self.ema
                c.gpuFrames += 1
                self.costs[client] = c
            }
        }
    }

    /// What a view reports about itself, for the stats.
    func noteRhythm(_ client: Client, fps: Int, visible: Bool) {
        lock.withLock {
            var c = costs[client] ?? Cost()
            c.fps = fps
            c.visible = visible
            costs[client] = c
        }
    }

    // MARK: - Rhythm

    private var reduceMotionCache = false

    /// System setting "Riduci movimento" (Accessibilita', Schermo).
    var reduceMotion: Bool { lock.withLock { reduceMotionCache } }

    /// Frames per second for a client. 0 means "no continuous frames": either nobody can
    /// see it, or Reduce motion is on and the view draws one frame when its data changes
    /// (see `onDemand`).
    ///  - orb: 60 while it reacts to a voice, 30 while it breathes;
    ///  - docked orb: 30 while it moves, 0 at rest (still on its last frame: 0% CPU);
    ///  - sky: 30 with live sessions or a pulse in flight, 15 when it only twinkles.
    /// Under Reduce motion only a lively orb keeps moving (it is the feedback of a voice,
    /// a function, not decoration), at 30.
    func fps(for client: Client, visible: Bool, lively: Bool) -> Int {
        guard visible else { return 0 }
        if reduceMotion {
            switch client {
            case .orb, .orbDocked: return lively ? 30 : 0
            case .sky, .vedetta: return 0
            }
        }
        switch client {
        case .orb: return lively ? 60 : 30
        case .orbDocked: return lively ? 30 : 0   // at rest in the dock: still, one frame on change
        case .sky: return lively ? 30 : 15
        case .vedetta: return lively ? 30 : 12
        }
    }

    /// True when the view is visible but should only draw when something changes.
    func onDemand(for client: Client, visible: Bool, lively: Bool) -> Bool {
        visible && fps(for: client, visible: visible, lively: lively) == 0
    }

    // MARK: - Load and breath

    private var busy = 0
    private var waiting = 0
    private var rate: Double = MetalEngine.restRate
    private var phase: Double = 0
    private var lastAdvance: CFTimeInterval = 0

    static let restRate = 1.4
    static let maxRate = 3.0
    /// Wraps the phase at 28 pi: a multiple of 2 pi both for the phase and for the
    /// phase scaled by 11/14 (the orb shader breathes at 1.1/1.4 of the particles).
    private static let phaseWrap = 28 * Double.pi

    /// Claude sessions working and waiting for Andrea (from menubar.update).
    func setLoad(busy newBusy: Int, waiting newWaiting: Int) {
        let changed = lock.withLock { () -> Bool in
            let c = busy != max(0, newBusy) || waiting != max(0, newWaiting)
            busy = max(0, newBusy)
            waiting = max(0, newWaiting)
            return c
        }
        if changed { Self.notifyChange() }
    }

    var load: (busy: Int, waiting: Int) { lock.withLock { (busy, waiting) } }

    /// The breath the load asks for, in rad/s: 1.4 at rest, rising gently with each
    /// session at work (one: ~1.9, three: ~2.5), never above 3.
    var targetBreathRate: Double {
        let b = Double(load.busy)
        return min(Self.maxRate, Self.restRate + 1.6 * (1 - exp(-b / 2.5)))
    }

    /// Current breath rate (eased towards the target over ~3 s, so a new session never
    /// makes the orb jump).
    var breathRate: Double { lock.withLock { rate } }

    /// Advances and returns the breath phase (radians, continuous, wrapped at 28 pi).
    /// Call once per frame from the draw; with Reduce motion the phase stands still.
    func breathPhase(now: CFTimeInterval = CACurrentMediaTime()) -> Double {
        let target = targetBreathRate
        let still = reduceMotion
        return lock.withLock {
            let dt = lastAdvance == 0 ? 0 : min(0.25, max(0, now - lastAdvance))
            lastAdvance = now
            if still { return phase }
            rate += (target - rate) * min(1, dt / 3.0)
            phase += rate * dt
            if phase > Self.phaseWrap { phase -= Self.phaseWrap }
            return phase
        }
    }

    // MARK: - Pulses

    /// A pulse lasts this long (the star's wave and glow decay to nothing).
    static let pulseSeconds: Double = 6

    struct Pulse {
        let key: String
        let project: String
        let at: CFTimeInterval
        /// 0...1, eased out; 0 once the pulse is over.
        func intensity(now: CFTimeInterval) -> Double {
            let age = now - at
            guard age >= 0, age < MetalEngine.pulseSeconds else { return 0 }
            let x = 1 - age / MetalEngine.pulseSeconds
            return x * x
        }
        func age(now: CFTimeInterval) -> Double { now - at }
    }
    private var pulses: [String: Pulse] = [:]

    /// Claude just wrote in that project (from the live board, `bacheca.attivita`).
    /// `projectKey` is the project's path when there is one, else its name.
    func pulse(projectKey: String, project: String) {
        let key = projectKey.isEmpty ? project : projectKey
        guard !key.isEmpty else { return }
        let now = CACurrentMediaTime()
        lock.withLock {
            pulses[key] = Pulse(key: key, project: project, at: now)
            pulses = pulses.filter { now - $0.value.at < Self.pulseSeconds }
        }
        Self.notifyChange()
        // Under Reduce motion the glow is a static change: one more frame when it ends.
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.pulseSeconds + 0.1) { Self.notifyChange() }
    }

    /// The pulses still in flight.
    func activePulses(now: CFTimeInterval = CACurrentMediaTime()) -> [Pulse] {
        lock.withLock { pulses.values.filter { $0.intensity(now: now) > 0 } }
    }

    /// The intensity per project key (decays to 0 in ~6 s).
    func pulseIntensities(now: CFTimeInterval = CACurrentMediaTime()) -> [String: Double] {
        var out: [String: Double] = [:]
        for p in activePulses(now: now) { out[p.key] = p.intensity(now: now) }
        return out
    }

    // MARK: - Report

    /// `metal.stats`: device, shaders, cost per client, rhythm, load, pulses.
    func report() -> [String: Any] {
        let now = CACurrentMediaTime()
        let (snapshot, deviceName, src, b, w, r, rm) = lock.withLock {
            (costs, deviceStorage?.name, librarySource, busy, waiting, rate, reduceMotionCache)
        }
        var clients: [String: Any] = [:]
        for (client, c) in snapshot {
            clients[client.rawValue] = [
                "cpuMicrosPerFrame": (c.cpuMicros * 10).rounded() / 10,
                "gpuMsPerFrame": (c.gpuMs * 1000).rounded() / 1000,
                "frames": c.frames,
                "fps": c.fps,
                "visible": c.visible,
                "secondsSinceLastFrame": c.lastFrame > 0 ? ((now - c.lastFrame) * 10).rounded() / 10 : -1,
                // Encoding plus GPU at the current rhythm: what the view costs right now.
                "estimatedCpuPercent": c.visible ? (c.cpuMicros * Double(c.fps) / 10_000 * 1000).rounded() / 1000 : 0,
                "estimatedGpuPercent": c.visible ? (c.gpuMs * Double(c.fps) / 10 * 100).rounded() / 100 : 0,
            ] as [String: Any]
        }
        let live = activePulses(now: now).map {
            ["key": $0.key, "project": $0.project, "intensity": ($0.intensity(now: now) * 100).rounded() / 100] as [String: Any]
        }
        return [
            "device": deviceName ?? "non ancora creato",
            "shaders": src,
            "reduceMotion": rm,
            "busy": b,
            "waiting": w,
            "breathRate": (r * 100).rounded() / 100,
            "targetBreathRate": (targetBreathRate * 100).rounded() / 100,
            "pulses": live,
            "clients": clients,
        ]
    }

    // MARK: - Helpers

    static func notifyChange() {
        if Thread.isMainThread {
            NotificationCenter.default.post(name: didChange, object: nil)
        } else {
            DispatchQueue.main.async { NotificationCenter.default.post(name: didChange, object: nil) }
        }
    }
}
