//
//  AspettoPersonaggi.swift
//  Bottega per iPhone
//
//  Chi parla si riconosce dalla sfera anche sull'iPhone (docs/CONTRATTI.md, 9.11, «La sfera di chi parla»): il campo
//  `sfera` dei file dei personaggi inclusi nell'app, letto con le regole del Nucleo (SferaAspetto.leggi, lo stesso
//  OrbAspetto.swift). Le figure le disegna OrbShaders.metal, lo stesso file del Mac: Darlene il nucleo con gli anelli
//  al neon, Elliot il codice che scende, Krista la macchia di Rorschach; Melissa la sfera di sempre.
//

import Foundation

enum AspettoPersonaggi {
    /// L'aspetto di ogni personaggio, per chiave, letto una volta dai file inclusi nell'app.
    static let tutti: [String: SferaAspetto] = {
        guard let cartella = Bundle.main.url(forResource: "personaggi", withExtension: nil),
              let file = try? FileManager.default.contentsOfDirectory(at: cartella, includingPropertiesForKeys: nil)
        else { return [:] }
        var tutti: [String: SferaAspetto] = [:]
        for url in file where url.pathExtension == "json" {
            guard let data = try? Data(contentsOf: url),
                  let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let chiave = o["chiave"] as? String, chiave != "melissa" else { continue }
            tutti[chiave] = SferaAspetto.leggi(o["sfera"], chiave: chiave)
        }
        return tutti
    }()

    /// Chi si vede nella sfera, come `aspetto.daStato` della barra: mentre parla chi parla (il nome sotto la sfera),
    /// se no chi ha la chiamata. Melissa, o una chiave che non c'e', e' la sfera di Melissa.
    @MainActor static func di(_ melissa: Melissa) -> SferaAspetto {
        let chi = melissa.sfera == .parla
            ? Personaggi.tutti.values.first { $0.nome == melissa.parlante }?.chiave ?? "melissa"
            : melissa.chiParla
        return tutti[chi] ?? .melissa
    }
}
