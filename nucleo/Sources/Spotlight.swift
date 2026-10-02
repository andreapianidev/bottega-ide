//
//  Spotlight.swift
//  Bottega Nucleo
//
//  spotlight.index / spotlight.clear (docs/CONTRATTI.md, 4.4). Projects and memories
//  become CoreSpotlight items: domainIdentifier = kind, uniqueIdentifier = kind:id.
//  A click on a result reaches the app as an NSUserActivity (CSSearchableItemActionType)
//  that carries only the unique identifier, so the url of every item is also kept in
//  ~/.bottega/nucleo/spotlight.json and opened from there.
//

import AppKit
import CoreSpotlight
import UniformTypeIdentifiers

enum Spotlight {
    struct Item {
        let id: String
        let kind: String
        let title: String
        let text: String?
        let url: String
        let keywords: [String]
        let date: Date?

        var uniqueIdentifier: String { "\(kind):\(id)" }

        init(_ d: [String: Any]) throws {
            guard let id = d["id"].map({ "\($0)" }), !id.isEmpty else {
                throw NucleoError("Un elemento per Spotlight non ha l'id.")
            }
            guard let kind = d["kind"] as? String, !kind.isEmpty else {
                throw NucleoError("L'elemento \(id) non ha il kind (progetto o ricordo).")
            }
            guard let title = d["title"] as? String, !title.isEmpty else {
                throw NucleoError("L'elemento \(id) non ha il titolo.")
            }
            guard let url = d["url"] as? String, URL(string: url) != nil else {
                throw NucleoError("L'elemento \(id) non ha un url valido.")
            }
            self.id = id
            self.kind = kind
            self.title = title
            self.text = d["text"] as? String
            self.url = url
            self.keywords = (d["keywords"] as? [Any])?.map { "\($0)" } ?? []
            self.date = Spotlight.date(d["date"])
        }
    }

    private static var index: CSSearchableIndex { .default() }

    // MARK: commands

    static func index(_ items: [Item], replace: Bool) async throws -> Int {
        guard CSSearchableIndex.isIndexingAvailable() else {
            throw NucleoError("Spotlight non è disponibile su questo Mac.")
        }
        let kinds = Set(items.map(\.kind))
        if replace, !kinds.isEmpty {
            try await guarded { try await index.deleteSearchableItems(withDomainIdentifiers: Array(kinds)) }
        }
        let searchable = items.map { it -> CSSearchableItem in
            let a = CSSearchableItemAttributeSet(contentType: .text)
            a.title = it.title
            a.displayName = it.title
            a.contentDescription = it.text
            a.contentURL = URL(string: it.url)
            if !it.keywords.isEmpty { a.keywords = it.keywords }
            if let date = it.date {
                a.contentModificationDate = date
                a.lastUsedDate = date
            }
            // One result per project for Spotlight and Siri: the item carries its entity.
            if it.kind == "progetto" { Entita.associa(a, progettoPath: it.id, nome: it.title) }
            let item = CSSearchableItem(uniqueIdentifier: it.uniqueIdentifier, domainIdentifier: it.kind,
                                        attributeSet: a)
            item.expirationDate = .distantFuture
            return item
        }
        if !searchable.isEmpty { try await guarded { try await index.indexSearchableItems(searchable) } }

        var map = loadMap()
        if replace { map = map.filter { !kinds.contains(kindOf($0.key)) } }
        for it in items { map[it.uniqueIdentifier] = it.url }
        saveMap(map)
        // Siri learns the project names it can hear ("Apri Woofmap nella Bottega").
        if kinds.contains("progetto") { BottegaScorciatoie.updateAppShortcutParameters() }
        return items.count
    }

    static func clear(kind: String?) async throws {
        if let kind, !kind.isEmpty {
            try await guarded { try await index.deleteSearchableItems(withDomainIdentifiers: [kind]) }
            saveMap(loadMap().filter { kindOf($0.key) != kind })
        } else {
            try await guarded { try await index.deleteAllSearchableItems() }
            saveMap([:])
        }
    }

    // MARK: a click on a result

    /// Called with the activity macOS hands us. Returns true when it was ours.
    @MainActor
    static func open(_ activity: NSUserActivity) -> Bool {
        guard activity.activityType == CSSearchableItemActionType,
              let uid = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String else { return false }
        guard let url = url(for: uid) else {
            Log.warn("spotlight: nessun indirizzo per \(uid)")
            return true
        }
        Log.info("spotlight: apro \(url.absoluteString)")
        NSWorkspace.shared.open(url)
        return true
    }

    /// The stored url, or a sensible one rebuilt from kind and id (contract 4.5).
    static func url(for uniqueIdentifier: String) -> URL? {
        if let s = loadMap()[uniqueIdentifier], let u = URL(string: s) { return u }
        let kind = kindOf(uniqueIdentifier)
        let id = String(uniqueIdentifier.dropFirst(kind.count + 1))
        var c = URLComponents(string: "bottega://andreapiani.bottega-home/")!
        switch kind {
        case "progetto": c.path = "/progetto"; c.queryItems = [URLQueryItem(name: "path", value: id)]
        case "ricordo": c.path = "/ricordo"; c.queryItems = [URLQueryItem(name: "id", value: id)]
        default: return nil
        }
        return c.url
    }

    // MARK: diagnostics (--cli spotlight-find)

    /// Searches our own items: proves that indexing reached Spotlight.
    static func find(_ text: String) async throws -> [[String: Any?]] {
        let escaped = text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let context = CSSearchQueryContext()
        context.fetchAttributes = ["title", "contentURL"]
        let query = CSSearchQuery(queryString: "title == \"*\(escaped)*\"cd || textContent == \"*\(escaped)*\"cd",
                                  queryContext: context)
        let found = ResultBox()
        try await guarded { found.append(try await run(query)) }
        return found.items
    }

    private static func run(_ query: CSSearchQuery) async throws -> [[String: Any?]] {
        try await withCheckedThrowingContinuation { cont in
            let box = ResultBox()
            query.foundItemsHandler = { items in
                box.append(items.map { ["id": $0.uniqueIdentifier, "kind": $0.domainIdentifier,
                                        "title": $0.attributeSet.title,
                                        "url": $0.attributeSet.contentURL?.absoluteString] })
            }
            query.completionHandler = { error in
                if let error { cont.resume(throwing: error) } else { cont.resume(returning: box.items) }
            }
            query.start()
        }
    }

    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false
        func run(_ body: () -> Void) {
            lock.lock(); defer { lock.unlock() }
            if done { return }
            done = true
            body()
        }
    }

    private final class ResultBox: @unchecked Sendable {
        private let lock = NSLock()
        private var _items: [[String: Any?]] = []
        func append(_ more: [[String: Any?]]) { lock.lock(); _items += more; lock.unlock() }
        var items: [[String: Any?]] { lock.lock(); defer { lock.unlock() }; return _items }
    }

    // MARK: helpers

    /// Every CoreSpotlight call gets 10 seconds: corespotlightd can leave a request
    /// unanswered, and a request of the extension must never hang. Errors in Italian.
    private static func guarded(_ op: @escaping @Sendable () async throws -> Void) async throws {
        // Not a task group: a group waits for all its children, the stuck one included.
        let once = Once()
        do {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                Task {
                    do { try await op(); once.run { cont.resume() } }
                    catch { once.run { cont.resume(throwing: error) } }
                }
                Task {
                    try? await Task.sleep(for: .seconds(10))
                    once.run { cont.resume(throwing: NucleoError("Spotlight non ha risposto entro 10 secondi.")) }
                }
            }
        } catch let e as NSError where e.domain == CSIndexErrorDomain {
            throw NucleoError(message(for: e))
        }
    }

    private static func message(for e: NSError) -> String {
        switch CSIndexError.Code(rawValue: e.code) {
        case .remoteConnectionError?, .indexUnavailableError?, .indexingUnsupported?:
            // -1003 is what corespotlightd answers when Spotlight is off (mdutil -a -i off).
            return "Spotlight non accetta l'indice della Bottega (CoreSpotlight \(e.code)): di solito vuol dire che "
                + "l'indicizzazione di Spotlight è spenta su questo Mac (mdutil -s /)."
        case .quotaExceeded?:
            return "Spotlight ha rifiutato gli elementi: troppi per la quota di un'app."
        case .invalidItemError?:
            return "Spotlight ha rifiutato un elemento non valido."
        default:
            return "Spotlight ha risposto con un errore (CoreSpotlight \(e.code))."
        }
    }

    private static func kindOf(_ uniqueIdentifier: String) -> String {
        uniqueIdentifier.split(separator: ":", maxSplits: 1).first.map(String.init) ?? ""
    }

    /// Milliseconds since 1970 (the extension's Date.now()), seconds, or an ISO string.
    private static func date(_ v: Any?) -> Date? {
        if let n = v as? NSNumber {
            let d = n.doubleValue
            return Date(timeIntervalSince1970: d > 1e11 ? d / 1000 : d)
        }
        if let s = v as? String {
            if let d = ISO8601DateFormatter().date(from: s) { return d }
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "yyyy-MM-dd"
            return f.date(from: s)
        }
        return nil
    }

    private static let lock = NSLock()
    private static var mapURL: URL { Nucleo.supportDir.appendingPathComponent("spotlight.json") }

    private static func loadMap() -> [String: String] {
        lock.lock(); defer { lock.unlock() }
        guard let data = try? Data(contentsOf: mapURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return [:] }
        return obj
    }

    private static func saveMap(_ map: [String: String]) {
        lock.lock(); defer { lock.unlock() }
        guard let data = try? JSONSerialization.data(withJSONObject: map, options: [.sortedKeys]) else { return }
        try? data.write(to: mapURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: mapURL.path)
    }
}
