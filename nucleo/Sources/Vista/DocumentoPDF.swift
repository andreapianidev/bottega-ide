//
//  DocumentoPDF.swift
//  Bottega Nucleo
//
//  `vision.documento`: a PDF or an image as text. PDF pages with a text layer come from
//  PDFKit; pages without (scans) are rendered in memory and go through document recognition
//  (paragraphs and tables), falling back to plain text recognition. At most 30 pages.
//

import Foundation
import CoreGraphics
import PDFKit

enum DocumentoPDF {
    static let maxPagine = 30

    struct Esito: Sendable {
        var testo: String
        var pagine: Int
        var pagineTotali: Int
        var tabelle: [[[String]]]
        var metodo: String
        var avviso: String?
    }

    static let immagini: Set<String> = ["png", "jpg", "jpeg", "heic", "heif", "tif", "tiff", "gif", "bmp", "webp"]

    static func leggi(path: String) async throws -> Esito {
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw NucleoError("Il file \(url.path) non esiste.")
        }
        let ext = url.pathExtension.lowercased()
        if immagini.contains(ext) {
            guard let data = FileManager.default.contents(atPath: url.path), let img = Ocr.immagine(data) else {
                throw NucleoError("L'immagine \(url.lastPathComponent) non si legge.")
            }
            let (t, tab, metodo) = try await riconosci(img)
            return Esito(testo: t, pagine: 1, pagineTotali: 1, tabelle: tab, metodo: metodo, avviso: nil)
        }
        guard ext == "pdf" || ext.isEmpty else {
            throw NucleoError("Leggo solo PDF e immagini (png, jpg, heic, tiff): \(url.lastPathComponent) non lo e'.")
        }
        guard let doc = PDFDocument(url: url) else {
            throw NucleoError("Il PDF \(url.lastPathComponent) non si apre: forse e' rovinato.")
        }
        if doc.isLocked {
            throw NucleoError("Il PDF \(url.lastPathComponent) e' protetto da password.")
        }
        let totali = doc.pageCount
        let n = min(totali, maxPagine)
        var parti: [String] = []
        var tabelle: [[[String]]] = []
        var metodi = Set<String>()
        for i in 0..<n {
            try Task.checkCancellation()
            guard let page = doc.page(at: i) else { continue }
            let layer = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if layer.count >= 40 {
                parti.append(layer)
                metodi.insert("pdfkit")
                continue
            }
            guard let img = render(page) else { continue }
            let (t, tab, metodo) = try await riconosci(img)
            if !t.isEmpty { parti.append(t) }
            tabelle += tab
            metodi.insert(metodo)
        }
        let metodo = metodi.count == 1 ? metodi.first! : (metodi.isEmpty ? "vuoto" : "misto")
        let avviso = totali > maxPagine
            ? "Il documento ha \(totali) pagine: ho letto solo le prime \(maxPagine)." : nil
        return Esito(testo: parti.joined(separator: "\n\n"), pagine: n, pagineTotali: totali,
                     tabelle: tabelle, metodo: metodo, avviso: avviso)
    }

    /// Documents first (tables), plain text recognition when that fails or finds nothing.
    private static func riconosci(_ img: CGImage) async throws -> (String, [[[String]]], String) {
        do {
            if let d = try await Ocr.documento(image: img), !d.testo.isEmpty || !d.tabelle.isEmpty {
                return (d.testo, d.tabelle, "documenti")
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            Log.info("riconoscimento documenti non riuscito, passo al testo: \(error.localizedDescription)")
        }
        let e = try await Ocr.testo(image: img)
        return (e.testo, [], "ocr")
    }

    /// The page at about 200 dpi, at most 3000 px on the long side, white background.
    static func render(_ page: PDFPage) -> CGImage? {
        let box = page.bounds(for: .mediaBox)
        guard box.width > 0, box.height > 0 else { return nil }
        let rotated = page.rotation % 180 != 0
        let w0 = rotated ? box.height : box.width, h0 = rotated ? box.width : box.height
        let scale = min(200.0 / 72.0, 3000.0 / max(w0, h0))
        let w = Int(w0 * scale), h = Int(h0 * scale)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: ctx)
        return ctx.makeImage()
    }
}
