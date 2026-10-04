// «Racconta» legge i dati già mostrati sull'iPhone con DeepSeek Pro, poi Agnes se serve.
// Il testo e l'audio ElevenLabs arrivano insieme, senza passare dal Mac per la sintesi.
import Foundation

@MainActor
extension AssistenteTelefono {
    func racconta(_ contesto: String, titolo: String, testo: @escaping (String) -> Void,
                  audio: @escaping (Data) -> Void) async throws -> String {
        guard let config = SegretiTelefono.leggi() else {
            throw ErrorePonte(messaggio: "Importa le chiavi dal Mac nelle impostazioni per usare Racconta.")
        }
        guard let voiceKey = config.elevenlabs, !voiceKey.isEmpty else {
            throw ErrorePonte(messaggio: "Manca la chiave ElevenLabs: Melissa non può raccontare con la sua voce.")
        }
        guard !config.voiceID.isEmpty else {
            throw ErrorePonte(messaggio: "Manca la voce di Melissa: importa di nuovo la configurazione dal Mac.")
        }
        let fonti: [(nome: String, url: String, modello: String, chiave: String, impegno: String)] = [
            ("DeepSeek V4 Pro", "https://api.deepseek.com/chat/completions", "deepseek-v4-pro", config.deepseek ?? "", "high"),
            ("Agnes", "https://apihub.agnes-ai.com/v1/chat/completions", "agnes-3.0-flash", config.agnes ?? "", "none")
        ].filter { !$0.chiave.isEmpty }
        guard !fonti.isEmpty else { throw ErrorePonte(messaggio: "Manca una chiave DeepSeek o Agnes sull'iPhone.") }

        let system = "Sei Melissa. Racconta in italiano in modo naturale e concreto quello che mostrano i dati. " +
            "Spiega lo stato attuale, i fatti importanti e cosa sta facendo la sessione se si tratta di una sessione. " +
            "Usa solo i dati forniti; non inventare risultati né dire che hai accesso ad aggiornamenti successivi. " +
            "Scrivi frasi adatte a essere dette ad alta voce, senza Markdown."
        let domanda = "Raccontami \(titolo). Dati letti dall'app:\n\(String(contesto.prefix(16_000)))"
        var ultimoErrore: Error = ErrorePonte(messaggio: "Nessun cervello ha risposto.")
        for fonte in fonti {
            try Task.checkCancellation()
            var richiesta = URLRequest(url: URL(string: fonte.url)!, timeoutInterval: 90)
            richiesta.httpMethod = "POST"
            richiesta.setValue("Bearer \(fonte.chiave)", forHTTPHeaderField: "Authorization")
            richiesta.setValue("application/json", forHTTPHeaderField: "Content-Type")
            richiesta.httpBody = try JSONSerialization.data(withJSONObject: [
                "model": fonte.modello, "reasoning_effort": fonte.impegno, "stream": true,
                "messages": [["role": "system", "content": system], ["role": "user", "content": domanda]]
            ])
            let bytes: URLSession.AsyncBytes
            do {
                let (stream, response) = try await URLSession.shared.bytes(for: richiesta)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    throw ErrorePonte(messaggio: "\(fonte.nome) ha risposto \(status).")
                }
                bytes = stream
            } catch {
                ultimoErrore = error
                continue
            }
            var risposta = ""
            var daDire = ""
            var byteAudio = 0
            let lettore = VoceTelefono(key: voiceKey, voiceID: config.voiceID) { pcm in
                byteAudio += pcm.count
                audio(pcm)
            }
            try await lettore.apri()
            do {
                for try await line in bytes.lines {
                    try Task.checkCancellation()
                    guard line.hasPrefix("data:") else { continue }
                    let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                    if payload == "[DONE]" { break }
                    guard let data = payload.data(using: .utf8),
                          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let choice = (json["choices"] as? [[String: Any]])?.first,
                          let delta = choice["delta"] as? [String: Any],
                          let piece = delta["content"] as? String, !piece.isEmpty else { continue }
                    risposta += piece
                    testo(piece)
                    daDire += piece
                    if let end = daDire.lastIndex(where: { ".!?\n".contains($0) }),
                       daDire.distance(from: daDire.startIndex, to: end) > 25 {
                        let frase = String(daDire[...end]).trimmingCharacters(in: .whitespacesAndNewlines)
                        daDire = String(daDire[daDire.index(after: end)...])
                        if !frase.isEmpty { try await lettore.invia(frase) }
                    }
                }
                if !daDire.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { try await lettore.invia(daDire) }
                try await lettore.finisci()
                guard !risposta.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw ErrorePonte(messaggio: "\(fonte.nome) ha restituito un racconto vuoto.")
                }
                guard byteAudio > 0 else { throw ErrorePonte(messaggio: "ElevenLabs non ha mandato la voce di Melissa.") }
                return risposta
            } catch {
                lettore.ferma()
                // Dopo il primo frammento non si ricomincia con Agnes: ripeterebbe a voce il racconto.
                if !risposta.isEmpty { throw error }
                ultimoErrore = error
            }
        }
        throw ultimoErrore
    }
}
