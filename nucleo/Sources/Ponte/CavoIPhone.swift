//
//  CavoIPhone.swift
//  Bottega Nucleo
//
//  usb.iphone e l'evento usb.iphone (docs/CONTRATTI.md, 9.9): un iPhone attaccato al Mac col cavo. Tutto IOKit,
//  come Power.swift: il kernel avvisa quando un dispositivo USB di Apple compare o sparisce. Nessun timer,
//  nessun giro: da fermo resta a 0% di CPU.
//

import Foundation
import IOKit
import IOKit.usb

@MainActor
final class CavoIPhone {
    static let shared = CavoIPhone()

    private var porta: IONotificationPortRef?
    private var iteratori: [io_iterator_t] = []
    /// Gli iPhone attaccati adesso, per registryID: quando uno sparisce le sue proprieta' non si leggono piu'.
    private var attaccati = Set<UInt64>()
    private var ultimo: Bool?

    var collegato: Bool { !attaccati.isEmpty }

    /// Solo in modalita' servizio: l'evento va all'estensione.
    func start() {
        guard porta == nil, let p = IONotificationPortCreate(kIOMainPortDefault) else { return }
        porta = p
        CFRunLoopAddSource(CFRunLoopGetMain(), IONotificationPortGetRunLoopSource(p).takeUnretainedValue(), .defaultMode)
        // Consegnati sul run loop principale, dove sta la sorgente.
        let arrivato: IOServiceMatchingCallback = { _, it in
            MainActor.assumeIsolated { CavoIPhone.shared.scorri(it, arrivo: true) }
        }
        let partito: IOServiceMatchingCallback = { _, it in
            MainActor.assumeIsolated { CavoIPhone.shared.scorri(it, arrivo: false) }
        }
        for (tipo, cb, arrivo) in [(kIOFirstMatchNotification, arrivato, true), (kIOTerminatedNotification, partito, false)] {
            // tutti i dispositivi USB (sono pochi): un filtro su idVendor nel dizionario non trova niente su
            // IOUSBHostDevice, misurato il 3/10/2026; marca e nome si guardano in eIPhone
            var it: io_iterator_t = 0
            let rc = IOServiceAddMatchingNotification(p, tipo, IOServiceMatching("IOUSBHostDevice"), cb, nil, &it)
            guard rc == KERN_SUCCESS else {
                Log.warn("cavo: notifica USB di IOKit non disponibile (\(rc)), niente evento usb.iphone")
                continue
            }
            iteratori.append(it)
            // scorrere l'iteratore la prima volta arma la notifica (e trova chi e' gia' attaccato)
            scorri(it, arrivo: arrivo)
        }
    }

    func stop() {
        for it in iteratori { IOObjectRelease(it) }
        iteratori.removeAll()
        if let p = porta { IONotificationPortDestroy(p) }
        porta = nil
    }

    private func scorri(_ it: io_iterator_t, arrivo: Bool) {
        while case let s = IOIteratorNext(it), s != 0 {
            defer { IOObjectRelease(s) }
            var id: UInt64 = 0
            IORegistryEntryGetRegistryEntryID(s, &id)
            if arrivo {
                if Self.eIPhone(s) { attaccati.insert(id) }
            } else {
                attaccati.remove(id)
            }
        }
        avvisa()
    }

    /// Di Apple (idVendor 0x05AC) e con «USB Product Name» che comincia per «iPhone» (l'iPad dice «iPad», il cavo
    /// dell'Apple Watch il suo nome).
    private static func eIPhone(_ s: io_service_t) -> Bool {
        func proprieta(_ k: String) -> Any? {
            IORegistryEntryCreateCFProperty(s, k as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
        }
        guard (proprieta("idVendor") as? Int) == 0x05AC else { return false }
        return (proprieta("USB Product Name") as? String)?.hasPrefix("iPhone") ?? false
    }

    private func avvisa() {
        let ora = collegato
        if ora == ultimo { return }
        ultimo = ora
        Log.info("cavo: iPhone \(ora ? "attaccato" : "staccato")")
        Out.event("usb.iphone", ["collegato": ora])
    }
}
