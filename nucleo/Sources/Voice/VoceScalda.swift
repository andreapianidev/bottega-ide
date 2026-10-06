//
//  VoceScalda.swift
//  Bottega Nucleo
//
//  Fills VoceCache: the island's POST /scalda and the service's voice.scalda hand over the
//  fillers of each voice, {voci: [{voce: "<ElevenLabs id>" | "" (Melissa), testi: [...]}]},
//  and this renders the pieces not on disk yet, one at a time, on a dedicated socket in
//  non-playback mode (as SpeechFile does): the live PCM of a turn cannot be captured
//  reliably, and a separate socket leaves the warm one of the Speaker alone.
//
//  One serial queue per process. A piece already on disk or already queued is skipped;
//  texts over 120 characters and requests over 300 texts are cut; each piece has 20 s.
//  Nothing is generated while the voice speaks (it waits, polling every half second only
//  while there is work queued). Errors go to the log; three in a row drop what is left
//  (no key, no network, no credit: the next /scalda tries again).
//

import Foundation

extension VoceCache {
    /// The Nucleo's cache: ~/.bottega/nucleo/voce-cache, shared by the island and the service.
    static let shared = VoceCache(cartella: Nucleo.supportDir.appendingPathComponent("voce-cache", isDirectory: true))
}

@MainActor
final class VoceScalda {
    static let shared = VoceScalda()

    static let maxTesti = 300
    static let timeoutFrase: TimeInterval = 20
    static let erroriDiFila = 3

    struct Esito {
        /// Pieces of this request not on disk (newly queued or already in the queue).
        let mancanti: Int
        /// Pieces waiting in the queue, the one being rendered included.
        let inCoda: Int
        /// Texts not taken: too long, empty, over the limit, or with an invalid voice.
        let scartati: Int
    }

    private struct Lavoro {
        let chiave: String
        let model: String
        let voce: String
        let testo: String
    }

    private var coda: [Lavoro] = []
    private var accodate: Set<String> = []
    private(set) var occupata = false
    private var pronte = 0
    private var errori = 0

    /// Queues the missing pieces of `voci` and starts the queue if it is idle.
    func scalda(_ voci: [[String: Any]]) throws -> Esito {
        guard ElevenLabsConfig.isConfigured else { throw ElevenLabsError.notConfigured }
        let model = Speaker.defaultModel
        var presi = 0
        var scartati = 0
        var mancanti = 0
        var nuove = 0
        var tagliati = false
        for gruppo in voci {
            let testi = (gruppo["testi"] as? [Any] ?? []).compactMap { $0 as? String }
            let v = ((gruppo["voce"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
            if !v.isEmpty, !VoceCache.idVoceValido(v) {
                Log.info("voce: scalda, voce \"\(v.prefix(40))\" non valida, salto \(testi.count) frasi")
                scartati += testi.count
                continue
            }
            let voce = v.isEmpty ? ElevenLabsConfig.voiceID : v
            for raw in testi {
                guard presi < Self.maxTesti else { scartati += 1; tagliati = true; continue }
                presi += 1
                let testo = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !testo.isEmpty, testo.count <= VoceCache.maxCaratteri else { scartati += 1; continue }
                // the island's /parla sends the text with a trailing space: same cuts
                for pezzo in VoceCache.pezzi(testo + " ") where pezzo.count <= VoceCache.maxCaratteri {
                    let chiave = VoceCache.chiave(model: model, voce: voce, testo: pezzo)
                    if VoceCache.shared.contiene(chiave) { continue }
                    mancanti += 1
                    if accodate.contains(chiave) { continue }
                    accodate.insert(chiave)
                    coda.append(Lavoro(chiave: chiave, model: model, voce: voce, testo: pezzo))
                    nuove += 1
                }
            }
        }
        if tagliati { Log.info("voce: scalda, piu' di \(Self.maxTesti) frasi in una richiesta, le altre le salto") }
        Log.info("voce: scalda, \(presi) frasi chieste, \(mancanti) pezzi mancanti (\(nuove) nuovi in coda), \(scartati) scartate, \(VoceCache.shared.quanti) gia' pronti")
        avvia()
        return Esito(mancanti: mancanti, inCoda: accodate.count, scartati: scartati)
    }

    private func avvia() {
        guard !occupata, !coda.isEmpty else { return }
        occupata = true
        pronte = 0
        errori = 0
        let inizio = Date()
        Task { @MainActor in
            var diFila = 0
            while !self.coda.isEmpty {
                // never over her voice: the dedicated socket would compete with the live one
                while Speaker.shared.isSpeaking { try? await Task.sleep(for: .milliseconds(500)) }
                let l = self.coda.removeFirst()
                do {
                    let pcm = try await self.sintetizza(l)
                    try VoceCache.shared.salva(pcm, chiave: l.chiave)
                    self.pronte += 1
                    diFila = 0
                } catch {
                    self.errori += 1
                    diFila += 1
                    Log.info("voce: scalda, «\(l.testo)» non generata: \(error.localizedDescription)")
                }
                self.accodate.remove(l.chiave)
                if diFila >= Self.erroriDiFila, !self.coda.isEmpty {
                    Log.info("voce: scalda, \(diFila) errori di fila, lascio perdere le \(self.coda.count) frasi rimaste")
                    for r in self.coda { self.accodate.remove(r.chiave) }
                    self.coda.removeAll()
                }
            }
            self.occupata = false
            let s = Int(Date().timeIntervalSince(inizio).rounded())
            Log.info("voce: scalda finito, \(self.pronte) pezzi pronti, \(self.errori) errori, in \(s) s (\(VoceCache.shared.quanti) in cache)")
        }
    }

    /// One piece on its own socket: connect, text, close_socket, PCM until is_final.
    private func sintetizza(_ l: Lavoro) async throws -> Data {
        guard let stream = ElevenLabsStream(voiceID: l.voce, model: l.model) else { throw ElevenLabsError.notConfigured }
        return try await withCheckedThrowingContinuation { cont in
            var audio = Data()
            var done = false
            @MainActor func finish(_ result: Result<Data, Error>) {
                guard !done else { return }
                done = true
                stream.onEvent = nil
                stream.close()
                cont.resume(with: result)
            }
            stream.onEvent = { event in
                switch event {
                case .audio(let pcm):
                    audio.append(pcm)
                case .turnFinished:
                    break
                case .sessionFinished:
                    if audio.count % 2 == 1 { audio.removeLast() }
                    // under 50 ms is not a line, it is a glitch
                    finish(audio.count < 2_400 ? .failure(ElevenLabsError.empty) : .success(audio))
                case .failed(let e):
                    finish(.failure(e))
                }
            }
            guard stream.connect() else {
                finish(.failure(ElevenLabsError.disconnected("il socket non si apre")))
                return
            }
            stream.send(text: l.testo, newTurn: false)
            ElevenLabsUsage.add(l.testo.count)
            stream.finish()
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeoutFrase) {
                MainActor.assumeIsolated {
                    finish(.failure(ElevenLabsError.disconnected("nessuna risposta in \(Int(Self.timeoutFrase)) secondi")))
                }
            }
        }
    }
}
