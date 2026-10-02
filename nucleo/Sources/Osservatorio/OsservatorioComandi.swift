//
//  OsservatorioComandi.swift
//  Bottega Nucleo
//
//  Service commands of the Osservatorio and of the Metal engine (docs/CONTRATTI.md):
//
//    osservatorio.open  {data?, secondoSchermo?}  -> {open, hasData, stars}
//         opens the window or brings it front; without `data` it emits
//         `osservatorio.ready {}` so the extension sends the numbers
//    osservatorio.data  {data}                    -> {stars, edges, panels}
//    osservatorio.close                           -> {}
//    metal.stats                                  -> the engine report
//    metal.load         {busy, waiting}           -> {breathRate}
//    metal.pulse        {key, project}            -> {}      (Claude wrote there)
//  Event `osservatorio.closed {}` when Andrea closes the window.
//
//  `data` is the cruscotto's Stats (contract 3), as an object or a JSON string, with the
//  optional `categorie` and `live`. Read leniently: a missing block empties one panel.
//
//  CLI (no window, ever):
//    --cli metal-bench [--frames N] [--width W --height H]
//    --cli osservatorio-prova --dati stats.json
//

import AppKit
import Foundation
import simd

@MainActor
enum OsservatorioComandi {
    /// Handles the commands above; false for any other command.
    static func handle(_ r: Request) async throws -> Bool {
        switch r.cmd {
        case "osservatorio.open":
            let had = try apply(r.args["data"], required: false)
            OsservatorioWindow.shared.open(secondScreen: r.bool("secondoSchermo") ?? false)
            if !had { Out.event("osservatorio.ready", [:]) }
            let m = OsservatorioWindow.shared.model
            r.respond(["open": true, "hasData": m.data != nil, "stars": m.scene.stars.count])

        case "osservatorio.data":
            _ = try apply(r.args["data"], required: true)
            let m = OsservatorioWindow.shared.model
            r.respond(["stars": m.scene.stars.count, "edges": m.scene.edges.count,
                       "panels": panelsPresent(m.pannelli), "open": OsservatorioWindow.shared.isOpen])

        case "osservatorio.close":
            OsservatorioWindow.shared.close()
            r.respond()

        case "metal.stats":
            r.respond(MetalEngine.shared.report().mapValues { Optional($0) })

        case "metal.load":
            MetalEngine.shared.setLoad(busy: r.int("busy") ?? 0, waiting: r.int("waiting") ?? 0)
            r.respond(["targetBreathRate": (MetalEngine.shared.targetBreathRate * 100).rounded() / 100])

        case "metal.pulse":
            let key = r.string("key") ?? ""
            let project = r.string("project") ?? ""
            guard !(key.isEmpty && project.isEmpty) else { throw NucleoError("L'impulso ha bisogno di key o project.") }
            MetalEngine.shared.pulse(projectKey: key, project: project)
            r.respond()

        default:
            return false
        }
        return true
    }

    /// Decodes `data` (object or JSON string) into the model and saves it. Returns true if
    /// there were numbers.
    private static func apply(_ any: Any?, required: Bool) throws -> Bool {
        guard let any, !(any is NSNull) else {
            if required { throw NucleoError("Mancano i dati: manda il campo data con lo Stats del cruscotto.") }
            return false
        }
        let json: Data
        if let s = any as? String {
            json = Data(s.utf8)
        } else if JSONSerialization.isValidJSONObject(any), let d = try? JSONSerialization.data(withJSONObject: any) {
            json = d
        } else {
            throw NucleoError("Il campo data non e' un oggetto JSON.")
        }
        let decoded = OsservatorioData.decode(json)
        if decoded.isEmpty {
            throw NucleoError("I dati dell'Osservatorio non hanno ne' today ne' week ne' periods.")
        }
        OsservatorioWindow.shared.model.data = decoded
        OsservatorioStore.save(json)
        return true
    }

    nonisolated static func panelsPresent(_ p: Pannelli) -> [String: Bool] {
        ["oggi": p.oggi != nil, "settimana": p.settimana != nil, "ore": p.heat != nil,
         "token": p.token != nil, "categorie": p.categorie != nil, "progetti": !p.progetti.isEmpty]
    }
}

enum OsservatorioCLI {
    /// Runs our CLI commands and returns the exit code, or nil if `args[0]` is not ours.
    /// Must be called on the main thread (top level of main.swift, before the app runs).
    static func run(_ args: [String]) -> Int32? {
        guard let command = args.first else { return nil }
        var opts: [String: String] = [:]
        var i = 1
        while i < args.count {
            if args[i].hasPrefix("--") {
                let k = String(args[i].dropFirst(2))
                if i + 1 < args.count, !args[i + 1].hasPrefix("--") { opts[k] = args[i + 1]; i += 2 } else { opts[k] = "1"; i += 1 }
            } else { i += 1 }
        }
        switch command {
        case "metal-bench":
            Out.enabled = false
            let frames = max(5, min(2000, Int(opts["frames"] ?? "") ?? 120))
            let w = max(64, min(7680, Int(opts["width"] ?? "") ?? 1920))
            let h = max(64, min(4320, Int(opts["height"] ?? "") ?? 1230))
            let result = MainActor.assumeIsolated { MetalEngine.bench(width: w, height: h, frames: frames) }
            print(JSON.encode(result))
            fflush(stdout)
            return (result["ok"] as? Bool) == true ? 0 : 1

        case "osservatorio-prova":
            Out.enabled = false
            guard let path = opts["dati"], let data = FileManager.default.contents(atPath: (path as NSString).expandingTildeInPath) else {
                FileHandle.standardError.write(Data("uso: --cli osservatorio-prova --dati stats.json\n".utf8))
                return 64
            }
            print(JSON.encode(prova(data)))
            fflush(stdout)
            return 0

        default:
            return nil
        }
    }

    /// Decoding and every panel's numbers for the three periods, as JSON: what the window
    /// would show, checked without opening it.
    static func prova(_ json: Data) -> [String: Any] {
        let d = OsservatorioData.decode(json)
        var out: [String: Any] = ["vuoto": d.isEmpty, "note": d.notes, "periodi": d.periods.keys.sorted(),
                                  "sessioniVive": d.live.count, "categorie": d.categorie != nil]
        var per: [String: Any] = [:]
        for key in ["7", "30", "90"] where d.periods[key] != nil {
            let p = Pannelli.compute(d, period: key)
            let scene = OsservatorioCielo.scene(d, period: key, version: 1)
            func kpi(_ k: [Pannelli.Kpi]?) -> Any {
                k.map { $0.map { ["label": $0.label, "value": $0.value, "note": $0.note ?? ""] } } ?? NSNull()
            }
            func bars(_ b: [Pannelli.Bar]?) -> Any { b.map { $0.map { ["label": $0.label, "text": $0.text] } } ?? NSNull() }
            per[key] = [
                "pannelli": OsservatorioComandi.panelsPresent(p),
                "oggi": kpi(p.oggi), "oggiFrase": p.oggiFrase ?? NSNull(),
                "settimana": kpi(p.settimana), "settimanaFrase": p.settimanaFrase ?? NSNull(),
                "heatMax": p.heatMax, "heatFrase": p.heatFrase ?? NSNull(),
                "token": bars(p.token), "tokenFrase": p.tokenFrase ?? NSNull(),
                "categorie": bars(p.categorie), "categorieFrase": p.categorieFrase ?? NSNull(),
                "progetti": p.progetti.count,
                "cielo": [
                    "stelle": scene.stars.count,
                    "legami": scene.edges.count,
                    "vive": scene.stars.filter(\.live).count,
                    "vuote": scene.stars.filter(\.hollow).count,
                    "prime": scene.stars.prefix(5).map { s in
                        ["nome": s.name, "x": (Double(s.position.x) * 1000).rounded() / 1000,
                         "y": (Double(s.position.y) * 1000).rounded() / 1000,
                         "raggio": (Double(s.size) * 10).rounded() / 10,
                         "luce": (Double(s.brightness) * 100).rounded() / 100,
                         "calore": (Double(s.warmth) * 100).rounded() / 100] as [String: Any]
                    },
                    "distanzaMinima": minDistance(scene),
                ] as [String: Any],
            ] as [String: Any]
        }
        out["perPeriodo"] = per
        return out
    }

    private static func minDistance(_ s: SkyScene) -> Double {
        var m = Double.infinity
        for i in s.stars.indices {
            for j in s.stars.indices where j > i {
                m = min(m, Double(simd_distance(s.stars[i].position, s.stars[j].position)))
            }
        }
        return m.isFinite ? (m * 1000).rounded() / 1000 : 0
    }
}
