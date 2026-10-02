//
//  Riassunto.swift
//  Bottega per iPhone
//
//  «Riassumimelo» nella scheda di una sessione: Melissa legge la sessione sul Mac e la racconta in due frasi
//  (POST /v1/sessione/riassunto, docs/CONTRATTI.md 9.5). La voce arriva a pezzi come per /v1/parla e suona
//  subito (FlussoVoce); se dal Mac non arriva l'audio parla la voce italiana di iOS. Un tocco mentre parla la
//  ferma, anche sul Mac (si chiude la connessione).
//

import AVFoundation
import Observation

@MainActor
@Observable
final class Riassunto {
    enum Stato: Equatable { case fermo, pensa, parla }

    private(set) var stato: Stato = .fermo
    private(set) var testo = ""
    var errore: String?

    private let flusso = FlussoVoce()
    private let parlato = Parlato()
    private var compito: Task<Void, Never>?

    func avvia(_ chiave: String) {
        guard stato == .fermo else { return ferma() }
        errore = nil
        testo = ""
        stato = .pensa
        compito = Task { await giro(chiave) }
    }

    func ferma() {
        compito?.cancel()
        compito = nil
        flusso.ferma()
        parlato.ferma()
        stato = .fermo
    }

    private func giro(_ chiave: String) async {
        defer {
            if !Task.isCancelled { stato = .fermo }
            flusso.spegni()
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        let pronto = (try? flusso.prepara()) != nil
        var frasi: [String] = []
        var audio = false
        do {
            try await PonteSessioni.shared.riassunto(chiave) { riga in
                switch riga {
                case .frase(let f):
                    frasi.append(f)
                    testo = frasi.joined(separator: " ")
                case .audio(let pcm):
                    guard pronto else { break }
                    audio = true
                    stato = .parla
                    flusso.accoda(pcm)
                case .fine(let r):
                    if !r.isEmpty { testo = r }
                default:
                    break
                }
            }
        } catch {
            if !Task.isCancelled { errore = error.localizedDescription }
            return
        }
        if Task.isCancelled { return }
        stato = .parla
        if audio {
            await flusso.aspettaFine()
        } else if !testo.isEmpty {
            await parlato.dici(testo)
        }
    }
}
