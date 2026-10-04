// swiftc nucleo/Sources/Stato.swift nucleo/Shared/StatoNativo.swift nucleo/Tests/StatoNativoTests.swift -o /tmp/stato-tests && /tmp/stato-tests
import Foundation

@main
struct StatoNativoTests {
    static func main() throws {
        let calendar = Calendar(identifier: .gregorian)
        let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 4, hour: 19))!
        let yesterday = calendar.date(byAdding: .day, value: -1, to: now)!
        let milliseconds = { (date: Date) in date.timeIntervalSince1970 * 1000 }
        let snapshot: [String: Any] = [
            "aggiornato": milliseconds(now),
            "regole": ["rosso": 6, "giallo": 11],
            "ore": ["aggiornato": milliseconds(now), "fonti": ["claude", "codex"],
                    "oggi": 147, "ieri": 245, "settimana": 2390,
                    "giorni": [["date": "2026-10-04", "minuti": 147]]],
        ]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("stato.json")
        try JSONSerialization.data(withJSONObject: snapshot).write(to: file, options: .atomic)
        let native = StatoNativo.load(from: file)
        let rules = Stato.load(from: file)
        assert(native.minutiOggi(now) == 147 && native.minutiSettimana(now) == 2390)
        assert(native.oreAggiornate == now && native.fontiOre == "Claude Code + Codex")
        assert(rules.updated == native.aggiornato && rules.rosso == 6 && rules.giallo == 11)

        // Publishing fresh rules must not make yesterday's hours look current.
        let stale = StatoNativo.parse([
            "aggiornato": milliseconds(now),
            "ore": ["aggiornato": milliseconds(yesterday), "fonti": ["codex"],
                    "oggi": 581, "ieri": 500, "settimana": 1954,
                    "giorni": [["date": "2026-10-03", "minuti": 581]]],
        ])
        assert(stale.oreAggiornate == yesterday)
        assert(stale.minutiOggi(now) == 0 && stale.minutiIeri(now) == 581)
        assert(stale.minutiSettimana(now) == 581 && stale.fontiOre == "Codex")
        assert(stale.ultimiSette(now).last == .init(date: "2026-10-04", minuti: 0))

        // Older installed writers remain readable, without inventing source coverage.
        let legacy = StatoNativo.parse(["aggiornato": milliseconds(now), "ore": ["oggi": 147, "settimana": 2390]])
        assert(legacy.oreAggiornate == now && legacy.fontiOre == "Claude Code")
        assert(legacy.minutiOggi(now) == 147)
        let unavailable = StatoNativo.parse(["ore": ["fonti": [String]()]])
        assert(unavailable.oreAggiornate == nil && unavailable.fontiOre == "Ore di lavoro")
        assert(!StatoNativo.load(from: directory.appendingPathComponent("missing")).present)
        print("StatoNativoTests passed (current generation, independent freshness, midnight, legacy, missing)")
    }
}
