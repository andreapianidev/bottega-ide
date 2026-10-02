//
//  Power.swift
//  Bottega Nucleo
//
//  power.status, power.keepAwake / power.release and the power.changed event
//  (docs/CONTRATTI.md, 4.4). Everything is IOKit: a snapshot when asked, a run loop
//  source the kernel fires when a power source changes. No timers, no polling.
//

import Foundation
import IOKit.ps
import IOKit.pwr_mgt

@MainActor
final class Power {
    static let shared = Power()

    struct Status: Equatable {
        var ac: Bool
        var battery: Int?      // percent, nil on a Mac without a battery
        var charging: Bool
    }

    private var source: CFRunLoopSource?
    private var lastSent: Status?
    /// token -> IOKit assertion. Released one by one, or all together on shutdown.
    private var assertions: [String: IOPMAssertionID] = [:]
    private var nextToken = 1

    // MARK: status

    nonisolated static func current() -> Status {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue() else {
            return Status(ac: true, battery: nil, charging: false)
        }
        let providing = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String?
        var ac = providing != kIOPSBatteryPowerValue
        var battery: Int?
        var charging = false
        if let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] {
            for ps in list {
                guard let d = IOPSGetPowerSourceDescription(info, ps)?.takeUnretainedValue() as? [String: Any],
                      (d[kIOPSTypeKey] as? String) == kIOPSInternalBatteryType else { continue }
                if let cur = d[kIOPSCurrentCapacityKey] as? Int, let max = d[kIOPSMaxCapacityKey] as? Int, max > 0 {
                    battery = Int((Double(cur) / Double(max) * 100).rounded())
                }
                charging = (d[kIOPSIsChargingKey] as? Bool) ?? false
                if let state = d[kIOPSPowerSourceStateKey] as? String { ac = state == kIOPSACPowerValue }
            }
        }
        return Status(ac: ac, battery: battery, charging: charging)
    }

    nonisolated static func snapshot() -> [String: Any?] {
        let s = current()
        return ["ac": s.ac, "battery": s.battery, "charging": s.charging,
                "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled]
    }

    // MARK: power.changed

    /// Starts the kernel notification (service mode only: the event goes to the extension).
    func startMonitoring() {
        guard source == nil else { return }
        lastSent = Self.current()
        let callback: IOPowerSourceCallbackType = { _ in
            // Delivered on the main run loop, where the source was added.
            MainActor.assumeIsolated { Power.shared.changed() }
        }
        guard let src = IOPSNotificationCreateRunLoopSource(callback, nil)?.takeRetainedValue() else {
            Log.warn("alimentazione: notifica di IOKit non disponibile, niente evento power.changed")
            return
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .defaultMode)
        source = src
    }

    private func changed() {
        let now = Self.current()
        if now == lastSent { return }
        lastSent = now
        Out.event("power.changed", ["ac": now.ac, "battery": now.battery, "charging": now.charging])
    }

    // MARK: keepAwake

    func keepAwake(reason: String) throws -> String {
        let name = (reason.isEmpty ? "Bottega: un lavoro è in corso" : "Bottega: \(reason)") as CFString
        var id: IOPMAssertionID = 0
        let rc = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                                             IOPMAssertionLevel(kIOPMAssertionLevelOn), name, &id)
        guard rc == kIOReturnSuccess else {
            throw NucleoError("Non riesco a tenere sveglio il Mac (IOKit \(rc)).")
        }
        let token = "sveglio-\(nextToken)"
        nextToken += 1
        assertions[token] = id
        Log.info("alimentazione: \(token) tiene sveglio il Mac (\(reason))")
        return token
    }

    func release(token: String) throws {
        guard let id = assertions.removeValue(forKey: token) else {
            throw NucleoError("Nessuna richiesta di veglia con il token \(token).")
        }
        IOPMAssertionRelease(id)
        Log.info("alimentazione: \(token) rilasciato")
    }

    /// Shutdown: the kernel would drop them anyway when the process dies, but say it.
    func releaseAll() {
        for (_, id) in assertions { IOPMAssertionRelease(id) }
        assertions.removeAll()
    }
}
