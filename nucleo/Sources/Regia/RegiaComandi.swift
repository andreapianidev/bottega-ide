import Foundation

struct RegiaProject: Identifiable {
    var id: String { name }
    let name: String
    let waiting: Int
    let errors: Int
    let running: Int
    let queued: Int
    var total: Int { waiting + errors + running + queued }
}

struct RegiaData {
    var projects: [RegiaProject] = []
    var summary = ""
    var engine = ""
    var updatedAt: Double = 0

    static func decode(_ any: Any?) throws -> RegiaData {
        guard let root = any as? [String: Any] else { throw NucleoError("Mancano i dati della Regia.") }
        var d = RegiaData()
        d.summary = (root["summary"] as? String) ?? ""
        d.engine = (root["engine"] as? String) ?? ""
        d.updatedAt = (root["updatedAt"] as? NSNumber)?.doubleValue ?? 0
        d.projects = ((root["projects"] as? [Any]) ?? []).compactMap { raw -> RegiaProject? in
            guard let p = raw as? [String: Any], let name = p["name"] as? String, !name.isEmpty else { return nil }
            func number(_ key: String) -> Int { max(0, min(999, (p[key] as? NSNumber)?.intValue ?? 0)) }
            return RegiaProject(name: name, waiting: number("waiting"), errors: number("errors"),
                                running: number("running"), queued: number("queued"))
        }.prefix(14).map { $0 }
        return d
    }
}

@MainActor
enum RegiaComandi {
    static func handle(_ r: Request) async throws -> Bool {
        switch r.cmd {
        case "regia.open":
            RegiaWindow.shared.model.data = try RegiaData.decode(r.args["data"])
            RegiaWindow.shared.open()
            r.respond(["open": true, "projects": RegiaWindow.shared.model.data.projects.count])
        case "regia.data":
            RegiaWindow.shared.model.data = try RegiaData.decode(r.args["data"])
            r.respond(["open": RegiaWindow.shared.isOpen])
        case "regia.close":
            RegiaWindow.shared.close()
            r.respond()
        default:
            return false
        }
        return true
    }
}
