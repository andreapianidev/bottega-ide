// The native Vedetta reads the same rules as the Home. Positions depend on a
// project's path, never on its current warning level or list order.
import Foundation
import simd

struct VedettaData {
    struct Hit: Identifiable {
        var id: String
        var level: String
        var sentence: String
        var remedy: String
    }

    struct Project: Identifiable {
        var id: String { path }
        var path: String
        var name: String
        var level: String
        var hits: [Hit]
        var checkedAt: Double

        var islandLevel: VedettaIslandLevel {
            switch level {
            case "rosso": .red
            case "giallo": .yellow
            case "verde": .green
            default: .unknown
            }
        }
    }

    var projects: [Project] = []
    var global: [Hit] = []
    var checkedAt: Double = 0
    var running = false

    var counts: (red: Int, yellow: Int, green: Int, unknown: Int) {
        (projects.filter { $0.level == "rosso" }.count,
         projects.filter { $0.level == "giallo" }.count,
         projects.filter { $0.level == "verde" }.count,
         projects.filter { !["rosso", "giallo", "verde"].contains($0.level) }.count)
    }

    static func decode(_ root: [String: Any]) -> VedettaData {
        var data = VedettaData()
        data.checkedAt = (root["checkedAt"] as? NSNumber)?.doubleValue ?? 0
        data.running = (root["running"] as? Bool) ?? false
        data.global = decodeHits(root["global"])
        data.projects = ((root["projects"] as? [Any]) ?? []).compactMap { raw -> Project? in
            guard let p = raw as? [String: Any], let path = p["path"] as? String, !path.isEmpty else { return nil }
            return Project(path: path, name: (p["name"] as? String) ?? URL(fileURLWithPath: path).lastPathComponent,
                           level: (p["livello"] as? String) ?? "sconosciuto", hits: decodeHits(p["hits"]),
                           checkedAt: (p["checkedAt"] as? NSNumber)?.doubleValue ?? 0)
        }
        return data
    }

    private static func decodeHits(_ value: Any?) -> [Hit] {
        ((value as? [Any]) ?? []).enumerated().compactMap { index, raw in
            guard let h = raw as? [String: Any], let sentence = h["frase"] as? String else { return nil }
            return Hit(id: "\((h["id"] as? String) ?? "regola")-\(index)", level: (h["livello"] as? String) ?? "giallo",
                       sentence: sentence, remedy: (h["rimedio"] as? String) ?? "")
        }
    }

    var islandPoints: [VedettaIslandPoint] {
        var occupied: [SIMD2<Float>] = []
        return projects.sorted { $0.path < $1.path }.map { project in
            var chosen = SIMD2<Float>(0.5, 0.5)
            var bestClearance: Float = -1
            // Paths set the candidate sequence. Existing points normally keep their
            // place when a warning changes; a new project only resolves neighbours.
            for attempt in 0..<192 {
                let h = Self.hash(project.path + "#\(attempt)")
                let x = 0.13 + Float(h & 0xffff) / 65535 * 0.74
                let y = 0.20 + Float((h >> 20) & 0xffff) / 65535 * 0.56
                let candidate = SIMD2(x, y)
                let clearance = occupied.map { simd_distance($0, candidate) }.min() ?? 1
                if clearance > bestClearance { chosen = candidate; bestClearance = clearance }
                if clearance >= 0.075 { break }
            }
            occupied.append(chosen)
            return VedettaIslandPoint(key: project.path, name: project.name, level: project.islandLevel,
                                      position: chosen)
        }
    }

    private static func hash(_ text: String) -> UInt64 {
        var value: UInt64 = 0xcbf29ce484222325
        for byte in text.utf8 { value = (value ^ UInt64(byte)) &* 0x100000001b3 }
        return value
    }
}
