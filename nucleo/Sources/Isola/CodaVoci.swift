//
//  CodaVoci.swift
//  Bottega Nucleo
//
//  One voice, many sessions: the island speaks for one session at a time (CONTRATTI.md,
//  "Modalita' isola", "Una voce alla volta"). The session whose line is sounding holds the
//  voice until its turn is closed (`final`) and nothing of it is left to hear; the lines of
//  the others wait here, in arrival order, and go out whole, one session after the other.
//  Before this, two terminals (a cronaca and an end-of-work notice) talked over each other,
//  and the `append` pieces of one could land in the turn opened by the other.
//
//  Pure state, no AppKit and no clock of its own: Isola passes what the speaker is doing and
//  the time, so it runs the same in the tests (nucleo/Tests/CodaVociTests.swift).
//

import Foundation

/// One /parla, as it arrived.
struct Battuta: Equatable {
    let sessione: String
    let testo: String
    let append: Bool
    let final: Bool
    let voce: String?
    let at: Date
}

struct CodaVoci {
    /// An owner whose turn is still open (no `final`) but silent this long has gone (a session
    /// closed mid-sentence): the voice passes. The Speaker closes such a turn after 20 s anyway.
    static let turnoMuto: TimeInterval = 25
    /// A line that waited this long is old news (the cronaca of five minutes ago): dropped.
    static let scadenza: TimeInterval = 300

    enum Esito: Equatable {
        /// say it now
        case subito
        /// it waits behind the session holding the voice (or the first one waiting)
        case inCoda(dietro: String)
    }

    /// The session holding the voice; nil when it is free.
    private(set) var di: String?
    /// The owner has closed its turn: once nothing is sounding, the voice is free.
    private(set) var chiusa = true
    /// When the owner last sent something.
    private(set) var ultima = Date.distantPast
    /// The lines of the other sessions, in arrival order.
    private(set) var attesa: [Battuta] = []

    /// Frees the voice when its owner is done: turn closed and nothing sounding, or an open
    /// turn silent for `turnoMuto`. True when it was freed now.
    @discardableResult
    mutating func libera(suona: Bool, ora: Date) -> Bool {
        guard di != nil, !suona else { return false }
        guard chiusa || ora.timeIntervalSince(ultima) > Self.turnoMuto else { return false }
        di = nil
        chiusa = true
        return true
    }

    /// A /parla: said now if this session holds the voice or the voice is free with nobody
    /// waiting and no microphone open; otherwise queued.
    mutating func arriva(_ b: Battuta, suona: Bool, ascolta: Bool, ora: Date) -> Esito {
        libera(suona: suona, ora: ora)
        if di == b.sessione || (di == nil && attesa.isEmpty && !ascolta) {
            prendi(b, ora: ora)
            return .subito
        }
        attesa.append(b)
        return .inCoda(dietro: di ?? attesa.first?.sessione ?? "")
    }

    /// The lines to say now: when the voice is free and the microphone closed, every waiting
    /// line of the first session in the queue, in order (that session now holds the voice).
    /// Lines past `scadenza` are dropped first and returned in `scartate`.
    mutating func prossime(suona: Bool, ascolta: Bool, ora: Date) -> (dire: [Battuta], scartate: [Battuta]) {
        let scartate = attesa.filter { ora.timeIntervalSince($0.at) > Self.scadenza }
        if !scartate.isEmpty { attesa.removeAll { ora.timeIntervalSince($0.at) > Self.scadenza } }
        libera(suona: suona, ora: ora)
        guard di == nil, !ascolta, let primo = attesa.first?.sessione else { return ([], scartate) }
        let sue = attesa.filter { $0.sessione == primo }
        attesa.removeAll { $0.sessione == primo }
        for b in sue { prendi(b, ora: ora) }
        return (sue, scartate)
    }

    /// /zitta from a session: its waiting lines go, and if it holds the voice the voice is
    /// freed. True when the speaker must stop (it was this session's voice sounding).
    /// An empty session (a client that does not say who it is) silences everything.
    mutating func zitta(sessione: String) -> Bool {
        if sessione.isEmpty {
            svuota()
            return true
        }
        attesa.removeAll { $0.sessione == sessione }
        guard di == sessione else { return false }
        di = nil
        chiusa = true
        return true
    }

    /// A click on the island: silence, and nothing that was waiting is said after it.
    mutating func svuota() {
        di = nil
        chiusa = true
        attesa = []
    }

    /// For /ping: something of another session is waiting, so `sessione` should not take the
    /// floor (open the microphone, start a line in a new voice) yet. The holder itself is never
    /// held back by the ones waiting behind it.
    func altriInAttesa(per sessione: String) -> Bool {
        guard !attesa.isEmpty else { return false }
        if !sessione.isEmpty, di == sessione { return false }
        return attesa.contains { $0.sessione != sessione }
    }

    private mutating func prendi(_ b: Battuta, ora: Date) {
        di = b.sessione
        chiusa = b.final
        ultima = ora
    }
}
