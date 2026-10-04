import Foundation

@MainActor
enum VedettaComandi {
    static func handle(_ request: Request) async throws -> Bool {
        switch request.cmd {
        case "vedetta.open":
            let hasData = try apply(request.args["data"], required: false)
            VedettaWindow.shared.open()
            if !hasData { Out.event("vedetta.ready", [:]) }
            request.respond(["open": true, "projects": VedettaWindow.shared.model.data.projects.count])
        case "vedetta.data":
            _ = try apply(request.args["data"], required: true)
            request.respond(["projects": VedettaWindow.shared.model.data.projects.count,
                             "open": VedettaWindow.shared.isOpen])
        case "vedetta.close":
            VedettaWindow.shared.close()
            request.respond()
        default:
            return false
        }
        return true
    }

    private static func apply(_ value: Any?, required: Bool) throws -> Bool {
        guard let value, !(value is NSNull) else {
            if required { throw NucleoError("Mancano i dati della Vedetta.") }
            return false
        }
        let root: [String: Any]
        if let text = value as? String {
            guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
                  let parsed = object as? [String: Any] else { throw NucleoError("I dati della Vedetta non sono JSON valido.") }
            root = parsed
        } else if let object = value as? [String: Any] {
            root = object
        } else { throw NucleoError("I dati della Vedetta hanno un formato non valido.") }
        VedettaWindow.shared.model.apply(VedettaData.decode(root))
        return true
    }
}
