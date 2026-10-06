//
//  CacheRiempitivi.swift
//  Bottega per iPhone
//
//  L'audio dei riempitivi gia' pronto, cosi' «Mmh, vediamo.» parte a 900 ms senza aspettare ElevenLabs: la copia
//  dell'iPhone di quello che il Nucleo tiene con `scalda` (docs/CONTRATTI.md, 9.11). Un file per frase in
//  Caches/riempitivi/, PCM 16 bit a 24 kHz mono, chiamato con lo sha256 di modello, voce, stabilita', somiglianza e
//  testo: cambiato uno di questi e' un'altra frase. Generato con VoceTelefono, stesso modello e stessi parametri della
//  risposta, quindi lo stesso timbro. Il sistema puo' svuotare Caches quando vuole: un file che manca si rigenera.
//

import CryptoKit
import Foundation

@MainActor
final class CacheRiempitivi {
    static let shared = CacheRiempitivi()

    private let cartella: URL
    private var scaldatura: Task<Void, Never>?
    private var giroScaldatura = 0

    init(cartella: URL? = nil) {
        self.cartella = cartella ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("riempitivi", isDirectory: true)
        try? FileManager.default.createDirectory(at: self.cartella, withIntermediateDirectories: true)
    }

    /// Il nome del file di una frase detta con una voce.
    nonisolated static func nome(voce: String, testo: String) -> String {
        let chiave = "\(VoceTelefono.modello)|\(voce)|\(VoceTelefono.stabilita)|\(VoceTelefono.somiglianza)|\(testo)"
        return SHA256.hash(data: Data(chiave.utf8)).map { String(format: "%02x", $0) }.joined() + ".pcm"
    }

    private func file(voce: String, testo: String) -> URL {
        cartella.appendingPathComponent(Self.nome(voce: voce, testo: testo))
    }

    /// L'audio pronto, o nil se manca (mai preparato, o tolto dal sistema).
    func leggi(voce: String, testo: String) -> Data? {
        guard let pcm = try? Data(contentsOf: file(voce: voce, testo: testo)), !pcm.isEmpty, pcm.count % 2 == 0 else { return nil }
        return pcm
    }

    /// La frase detta da ElevenLabs, raccolta intera: un riempitivo suona tutto o niente, mai a pezzi mescolati alla
    /// risposta. `salva` falso per l'eco, che non si ripete. Cancellare il Task chiude il socket e non salva niente.
    func genera(key: String, voce: String, testo: String, salva: Bool = true) async throws -> Data {
        var pcm = Data()
        let tts = VoceTelefono(key: key, voiceID: voce) { pcm.append($0) }
        do {
            try await tts.apri()
            try await tts.invia(testo)
            try await tts.finisci()
        } catch {
            tts.ferma()
            throw error
        }
        try Task.checkCancellation()
        guard !pcm.isEmpty else { throw ErrorePonte(messaggio: "ElevenLabs non ha mandato l'audio del riempitivo.") }
        if salva {
            do { try pcm.write(to: file(voce: voce, testo: testo), options: .atomic) }
            catch { Log.warn("riempitivi: non salvo in cache (\(error.localizedDescription))") }
        }
        return pcm
    }

    /// Prepara, una frase alla volta, quelle che mancano. Pigra: parte a fine giro, quando c'e' la configurazione e la
    /// voce e' accesa, e un giro nuovo la sospende (`sospendi`): mai un socket in piu' mentre si aspetta una risposta.
    /// Al prossimo giro riprende da dove manca. Un errore (rete, credito) la ferma fino al giro dopo.
    func scalda(key: String, voci: [(voce: String, frasi: [String])]) {
        guard scaldatura == nil else { return }
        let mancanti = voci.flatMap { v in
            v.frasi.filter { !FileManager.default.fileExists(atPath: file(voce: v.voce, testo: $0).path) }.map { (v.voce, $0) }
        }
        guard !mancanti.isEmpty else { return }
        giroScaldatura += 1
        let g = giroScaldatura
        Log.info("riempitivi: preparo \(mancanti.count) frasi")
        scaldatura = Task { [weak self] in
            defer { if self?.giroScaldatura == g { self?.scaldatura = nil } }
            var fatte = 0
            for (voce, testo) in mancanti {
                guard !Task.isCancelled, let self else { return }
                if self.leggi(voce: voce, testo: testo) != nil { continue }
                do {
                    _ = try await self.genera(key: key, voce: voce, testo: testo)
                    fatte += 1
                } catch {
                    if !Task.isCancelled { Log.warn("riempitivi: preparazione ferma dopo \(fatte) frasi (\(error.localizedDescription))") }
                    return
                }
            }
            Log.info("riempitivi: pronte \(fatte) frasi")
        }
    }

    /// Un giro comincia, o l'app va dietro: la preparazione si ferma (la frase a meta' non si salva).
    func sospendi() {
        guard scaldatura != nil else { return }
        giroScaldatura += 1
        scaldatura?.cancel()
        scaldatura = nil
    }
}
