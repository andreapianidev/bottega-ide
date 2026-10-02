//
//  Schermo.swift
//  Bottega Nucleo
//
//  `vision.guarda`: one capture of the main display with ScreenCaptureKit, only when asked,
//  then text recognition. The image lives in memory and is dropped at the end: never on disk.
//  The Nucleo's own windows (the orb) are left out of the picture.
//

import Foundation
import AppKit
import CoreGraphics
import ScreenCaptureKit

enum Schermo {
    static let messaggioPermesso = "Serve il permesso di registrazione dello schermo: Impostazioni di Sistema, " +
        "Privacy e sicurezza, Registrazione schermo, Bottega."

    struct SenzaPermesso: Error {}

    struct Esito: Sendable {
        let testo: String
        let righe: Int
        let app: String?
        let finestra: String?
    }

    static func guarda(lingue: [String]? = nil) async throws -> Esito {
        guard CGPreflightScreenCaptureAccess() else {
            // First time: macOS shows its own request (and lists the app in the settings).
            _ = CGRequestScreenCaptureAccess()
            throw SenzaPermesso()
        }
        let front = await MainActor.run { () -> (String?, pid_t?) in
            let app = NSWorkspace.shared.frontmostApplication
            return (app?.localizedName, app?.processIdentifier)
        }
        let image: CGImage
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let mainID = CGMainDisplayID()
            guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
                throw NucleoError("Non trovo lo schermo principale.")
            }
            let mine = content.applications.filter { $0.processID == getpid() }
            let filter = SCContentFilter(display: display, excludingApplications: mine, exceptingWindows: [])
            let config = SCStreamConfiguration()
            let scale = CGFloat(filter.pointPixelScale > 0 ? filter.pointPixelScale : 2)
            config.width = Int(CGFloat(display.width) * scale)
            config.height = Int(CGFloat(display.height) * scale)
            config.showsCursor = false
            config.capturesAudio = false
            image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        } catch let e as NSError where e.domain == SCStreamErrorDomain && e.code == SCStreamError.userDeclined.rawValue {
            throw SenzaPermesso()
        }
        let ocr = try await Ocr.testo(image: image, lingue: lingue)
        return Esito(testo: ocr.testo, righe: ocr.righe.count, app: front.0, finestra: front.1.flatMap(titolo(pid:)))
    }

    /// Title of the frontmost normal window of `pid` (readable with the screen permission).
    static func titolo(pid: pid_t) -> String? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]] else { return nil }
        for w in list {
            guard (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                  (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 else { continue }
            if let name = w[kCGWindowName as String] as? String, !name.isEmpty { return name }
        }
        return nil
    }
}
