//
//  System.swift
//  Bottega Nucleo
//
//  system.stats and the system.pressure event. Everything here is a syscall or a kernel
//  notification: no polling timers, so it costs nothing while idle.
//

import Foundation
import Darwin

enum SystemStats {
    static var cores: Int { ProcessInfo.processInfo.activeProcessorCount }

    static var memoryTotalGB: Double {
        round1(Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824)
    }

    static func load() -> [Double] {
        var l = [Double](repeating: 0, count: 3)
        let n = getloadavg(&l, 3)
        guard n == 3 else { return [0, 0, 0] }
        return l.map { (($0 * 100).rounded()) / 100 }
    }

    /// Used memory the way Activity Monitor counts it: app (active + inactive minus
    /// purgeable is close enough, we keep it simple) + wired + compressed.
    static func memoryUsedGB() -> Double {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &stats) { ptr in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return 0 }
        var pageSize: vm_size_t = 0
        host_page_size(mach_host_self(), &pageSize)
        let page = Double(pageSize)
        let anonymous = Double(stats.internal_page_count) - Double(stats.purgeable_count)
        let used = (max(0, anonymous) + Double(stats.wire_count) + Double(stats.compressor_page_count)) * page
        return round1(used / 1_073_741_824)
    }

    /// Kernel view of memory pressure: 1 normal, 2 warning, 4 critical.
    static func memoryPressure() -> String {
        var level: Int32 = 0
        var size = MemoryLayout<Int32>.size
        if sysctlbyname("kern.memorystatus_vm_pressure_level", &level, &size, nil, 0) == 0 {
            switch level {
            case 4: return "critical"
            case 2: return "warning"
            default: return "normal"
            }
        }
        return PressureMonitor.shared.current
    }

    static func thermal() -> String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "nominal"
        }
    }

    static func snapshot() -> [String: Any?] {
        [
            "load": load(),
            "memoryPressure": memoryPressure(),
            "memoryUsedGB": memoryUsedGB(),
            "memoryTotalGB": memoryTotalGB,
            "thermal": thermal(),
            "cores": cores,
        ]
    }

    private static func round1(_ v: Double) -> Double { (v * 10).rounded() / 10 }
}

/// Emits `system.pressure {memoryPressure, thermal}` when either changes. Kernel-driven:
/// a dispatch memory-pressure source and the thermal-state notification.
final class PressureMonitor: @unchecked Sendable {
    static let shared = PressureMonitor()

    private let queue = DispatchQueue(label: "nucleo.pressure", qos: .utility)
    private var source: DispatchSourceMemoryPressure?
    private var thermalObserver: NSObjectProtocol?
    private(set) var current = "normal"
    private var lastSent: (String, String)?

    func start() {
        guard source == nil else { return }
        let src = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical], queue: queue)
        src.setEventHandler { [weak self] in
            guard let self else { return }
            let ev = src.data
            if ev.contains(.critical) { self.current = "critical" }
            else if ev.contains(.warning) { self.current = "warning" }
            else { self.current = "normal" }
            self.publish()
        }
        src.resume()
        source = src
        thermalObserver = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil
        ) { [weak self] _ in
            self?.queue.async { self?.publish() }
        }
        queue.async { self.lastSent = (SystemStats.memoryPressure(), SystemStats.thermal()) }
    }

    private func publish() {
        let pressure = SystemStats.memoryPressure()
        let thermal = SystemStats.thermal()
        if let last = lastSent, last.0 == pressure, last.1 == thermal { return }
        lastSent = (pressure, thermal)
        Out.event("system.pressure", ["memoryPressure": pressure, "thermal": thermal])
    }
}
