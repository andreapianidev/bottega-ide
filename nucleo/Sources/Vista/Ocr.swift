//
//  Ocr.swift
//  Bottega Nucleo
//
//  Text recognition with the Swift Vision API (RecognizeTextRequest, accurate level, language
//  correction, Italian and English). Everything stays on the Mac and in memory.
//

import Foundation
import CoreGraphics
import ImageIO
import Vision

enum Ocr {
    static let lingueStandard = ["it-IT", "en-US"]

    struct Riga: Sendable { let testo: String; let conf: Float }
    struct Esito: Sendable { let testo: String; let righe: [Riga] }

    static func request(_ lingue: [String]?) -> RecognizeTextRequest {
        var r = RecognizeTextRequest()
        r.recognitionLevel = .accurate
        r.usesLanguageCorrection = true
        let langs = (lingue?.isEmpty == false ? lingue! : lingueStandard).map { Locale.Language(identifier: $0) }
        r.recognitionLanguages = langs
        r.automaticallyDetectsLanguage = false
        return r
    }

    static func testo(image: CGImage, lingue: [String]? = nil) async throws -> Esito {
        esito(try await request(lingue).perform(on: image))
    }

    static func testo(data: Data, lingue: [String]? = nil) async throws -> Esito {
        guard let img = immagine(data) else {
            throw NucleoError("L'immagine non si legge: formato non riconosciuto o dati rovinati.")
        }
        return try await testo(image: img, lingue: lingue)
    }

    static func testo(url: URL, lingue: [String]? = nil) async throws -> Esito {
        guard let data = FileManager.default.contents(atPath: url.path) else {
            throw NucleoError("Non riesco a leggere il file \(url.path).")
        }
        return try await testo(data: data, lingue: lingue)
    }

    static func immagine(_ data: Data) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(src) > 0 else { return nil }
        // Huge images are scaled down to 4096 px on the long side (enough for OCR, bounded memory).
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 4096,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        if let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
           let w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
           let h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue, max(w, h) <= 4096 {
            var o = opts
            o[kCGImageSourceThumbnailMaxPixelSize] = max(w, h)
            return CGImageSourceCreateThumbnailAtIndex(src, 0, o as CFDictionary)
        }
        return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
    }

    private static func esito(_ obs: [RecognizedTextObservation]) -> Esito {
        let righe = obs.compactMap { o -> Riga? in
            let t = o.transcript.trimmingCharacters(in: .whitespaces)
            return t.isEmpty ? nil : Riga(testo: t, conf: (o.confidence * 100).rounded() / 100)
        }
        return Esito(testo: righe.map(\.testo).joined(separator: "\n"), righe: righe)
    }
}
