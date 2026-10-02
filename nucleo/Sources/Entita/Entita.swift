//
//  Entita.swift
//  Bottega Nucleo
//
//  App Intents entities for Siri, Spotlight and Comandi rapidi: the Bottega's projects
//  (ProgettoEntity, id = path) and its work items (LavoroEntity, id = WorkItem.key,
//  docs/CONTRATTI.md 4.9). Both read ~/.bottega/stato.json through StatoNativo; before
//  the extension writes "progetti" there, the project names come from the Spotlight map
//  (~/.bottega/nucleo/spotlight.json, "progetto:<path>" -> url).
//

import AppIntents
import CoreSpotlight
import Foundation

// MARK: - Projects

struct ProgettoEntity: IndexedEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(
        name: "Progetto", numericFormat: "\(placeholder: .int) progetti")
    static let defaultQuery = ProgettoQuery()

    let id: String                     // absolute path

    @Property(title: "Nome")
    var nome: String

    @Property(title: "Ramo")
    var ramo: String?

    @Property(title: "Stato")
    var stato: String

    @Property(title: "Commit da spingere")
    var daSpingere: Int

    init(_ p: StatoNativo.Progetto, conosciuto: Bool = true) {
        id = p.path
        nome = p.nome
        ramo = p.ramo
        daSpingere = p.daSpingere
        stato = conosciuto ? Self.riga(p) : "nella Bottega"
    }

    /// For an item Spotlight.swift indexes: only the name is known there.
    init(path: String, nome: String) {
        self.init(StatoNativo.Progetto(nome: nome, path: path), conosciuto: false)
    }

    var displayRepresentation: DisplayRepresentation {
        let sub = ramo.map { "\($0), \(stato)" } ?? stato
        return DisplayRepresentation(title: "\(nome)", subtitle: "\(sub)", image: .init(systemName: "folder"))
    }

    var attributeSet: CSSearchableItemAttributeSet {
        let a = defaultAttributeSet
        a.displayName = nome
        a.contentDescription = "Progetto nella Bottega, \(stato)"
        a.keywords = [nome, "Bottega", "progetto"]
        return a
    }

    /// One line: "3 commit da spingere, 2 file modificati", "pulito".
    static func riga(_ p: StatoNativo.Progetto) -> String {
        var parts: [String] = []
        if p.daSpingere > 0 { parts.append("\(p.daSpingere) commit da spingere") }
        if p.modifiche > 0 { parts.append(p.modifiche == 1 ? "1 file modificato" : "\(p.modifiche) file modificati") }
        if p.livello == "rosso" { parts.append("regole in rosso") }
        else if p.livello == "giallo" { parts.append("regole in giallo") }
        return parts.isEmpty ? "pulito" : parts.joined(separator: ", ")
    }
}

struct ProgettoQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [ProgettoEntity] {
        let all = Entita.progetti()
        return identifiers.map { id in
            if let p = all.list.first(where: { $0.path == id }) { return ProgettoEntity(p, conosciuto: all.fromStato) }
            // A saved shortcut keeps working even when the project left the list.
            return ProgettoEntity(path: id, nome: (id as NSString).lastPathComponent)
        }
    }

    func entities(matching string: String) async throws -> [ProgettoEntity] {
        let all = Entita.progetti()
        return Entita.cerca(string, in: all.list, nome: \.nome).map { ProgettoEntity($0, conosciuto: all.fromStato) }
    }

    /// Every project, most recent first: Siri learns the names it can hear from here
    /// (BottegaScorciatoie.updateAppShortcutParameters()).
    func suggestedEntities() async throws -> [ProgettoEntity] {
        let all = Entita.progetti()
        let sorted = all.list.sorted { ($0.ultima ?? .distantPast) > ($1.ultima ?? .distantPast) }
        return sorted.prefix(80).map { ProgettoEntity($0, conosciuto: all.fromStato) }
    }
}

// MARK: - Work items

struct LavoroEntity: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(
        name: "Lavoro", numericFormat: "\(placeholder: .int) lavori")
    static let defaultQuery = LavoroQuery()

    let id: String                     // WorkItem.key: "job:<id>" or "sess:<sessionId>"

    @Property(title: "Progetto")
    var progetto: String

    @Property(title: "Titolo")
    var titolo: String

    @Property(title: "Stato")
    var stato: String

    @Property(title: "Dal")
    var da: Date?

    var path: String

    init(_ v: StatoNativo.Voce) {
        // Plain stored properties first: the @Property ones go through self.
        id = v.key
        path = v.path
        progetto = v.progetto
        titolo = v.titolo
        stato = v.stato
        da = v.da
    }

    var displayRepresentation: DisplayRepresentation {
        let title = titolo.isEmpty ? progetto : "\(progetto): \(titolo)"
        let sub = da.map { "\(stato), \(Formato.da($0))" } ?? stato
        let icon = stato == "ti aspetta" ? "hourglass" : "hammer"
        return DisplayRepresentation(title: "\(title)", subtitle: "\(sub)", image: .init(systemName: icon))
    }
}

struct LavoroQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [LavoroEntity] {
        let voci = StatoNativo.load().lavori?.voci ?? []
        return identifiers.compactMap { id in voci.first { $0.key == id }.map(LavoroEntity.init) }
    }

    func entities(matching string: String) async throws -> [LavoroEntity] {
        let voci = StatoNativo.load().lavori?.voci ?? []
        let byTitle = Entita.cerca(string, in: voci, nome: \.titolo)
        let byProject = Entita.cerca(string, in: voci, nome: \.progetto)
        var seen = Set<String>()
        return (byProject + byTitle).filter { seen.insert($0.key).inserted }.map(LavoroEntity.init)
    }

    /// Who waits for Andrea first, then the rest in the extension's order.
    func suggestedEntities() async throws -> [LavoroEntity] {
        let voci = StatoNativo.load().lavori?.voci ?? []
        return (voci.filter { $0.stato == "ti aspetta" } + voci.filter { $0.stato != "ti aspetta" }).map(LavoroEntity.init)
    }
}

// MARK: - Sources and Spotlight

enum Entita {
    /// The projects from stato.json, or the names in the Spotlight map when the
    /// extension has not written "progetti" yet (fromStato false: no git state).
    static func progetti() -> (list: [StatoNativo.Progetto], fromStato: Bool) {
        if let ps = StatoNativo.load().progetti { return (ps, true) }
        guard let data = try? Data(contentsOf: Nucleo.supportDir.appendingPathComponent("spotlight.json")),
              let map = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return ([], false) }
        let list = map.keys.filter { $0.hasPrefix("progetto:") }.map { key -> StatoNativo.Progetto in
            let path = String(key.dropFirst("progetto:".count))
            return StatoNativo.Progetto(nome: (path as NSString).lastPathComponent, path: path)
        }.sorted { $0.nome.localizedCompare($1.nome) == .orderedAscending }
        return (list, false)
    }

    /// Exact name first, then names that start with the text, then names that contain it;
    /// case, accents, spaces and dashes do not count ("walkie talky" finds WalkieTalky).
    static func cerca<T>(_ text: String, in items: [T], nome: KeyPath<T, String>) -> [T] {
        let k = StatoNativo.chiave(text)
        guard !k.isEmpty else { return [] }
        var exact: [T] = [], prefix: [T] = [], contains: [T] = []
        for it in items {
            let n = StatoNativo.chiave(it[keyPath: nome])
            if n == k { exact.append(it) }
            else if n.hasPrefix(k) { prefix.append(it) }
            else if n.contains(k) { contains.append(it) }
        }
        return exact + prefix + contains
    }

    /// Ties an item Spotlight.swift already indexes (kind "progetto", id = path) to its
    /// entity: Siri and Spotlight see one result, not two.
    static func associa(_ attributes: CSSearchableItemAttributeSet, progettoPath path: String, nome: String) {
        attributes.associateAppEntity(ProgettoEntity(path: path, nome: nome))
    }

    /// The alternative: the entities as items of their own (they would sit next to the
    /// ones Spotlight.swift indexes, so this is not used while that indexing exists).
    static func indicizza(progetti: [StatoNativo.Progetto]) async throws {
        try await CSSearchableIndex.default().indexAppEntities(progetti.map { ProgettoEntity($0) })
    }
}
