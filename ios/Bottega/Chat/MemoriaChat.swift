//
//  MemoriaChat.swift
//  Bottega per iPhone
//
//  La continuita' delle chat fra Moony AI per iPhone e Moony AI per Mac (16/10/2026, Andrea: «continuita' delle
//  conversazioni fra iOS e macOS usando la memoria»). Il posto e' quello che esiste gia': la memoria condivisa sulla VM
//  Segretaria (docs/CONTRATTI.md 2.1 e 9.10), dove Moony per Mac scrive le sue conversazioni. Una chat e' una
//  conversazione della VM: `conversation_id` e' l'UUID della scheda in minuscolo, o l'id della VM per una chat nata
//  altrove (anche quella storica della voce del Mac).
//
//  - Dall'iPhone alla VM: ogni turno con POST /mem/add, `event_id` = l'id del turno, `trust` diretto per Andrea ed
//    esterno per risposte e allegati (di un allegato va solo la riga d'intestazione). Quelli non riusciti ripartono
//    al giro dopo.
//  - Dalla VM all'iPhone: GET /mem/conversations per i recenti (una chat del Mac compare fra i recenti e si apre in
//    una scheda), GET /mem/recent per la chat aperta (i turni detti sul Mac entrano nella chat, uniti per event_id).
//  Si gira all'apertura della chat, dopo ogni risposta e ogni 15 secondi con l'app davanti. Gettone ristretto a
//  quelle tre rotte, dal ponte della Bottega in HTTPS (ConfigurazioneTelefono.memoria). Senza: tutto come prima.
//

import Foundation

@MainActor
final class MemoriaChat {
    static let shared = MemoriaChat()
    private var inCorso = false

    /// Un giro: manda i turni in attesa, rilegge l'elenco delle chat e i turni della chat aperta. `conversazioni`
    /// falso salta l'elenco (il giro dei 15 secondi lo chiede ogni minuto).
    func sincronizza(conversazioni: Bool = true) async {
        let telefono = AssistenteTelefono.shared
        guard !inCorso, let config = telefono.configMemoria else { return }
        inCorso = true
        defer { inCorso = false }
        await manda(config)
        if conversazioni, let c: [ConversazioneVM] = await prendi(config, "/mem/conversations?limit=60", chiave: "conversations") {
            telefono.unisciConversazioni(c)
        }
        await leggi(telefono.attiva, config)
    }

    private func manda(_ config: ConfigMemoria) async {
        let telefono = AssistenteTelefono.shared
        var mandati: Set<UUID> = []
        defer { telefono.segnaInVM(mandati) }
        for (t, conversazione) in telefono.daMandareAllaVM() {
            let esterno = t.esterno == true
            let corpo: [String: Any] = [
                "source": "iphone",
                "role": t.chi == "tu" ? "user" : "assistant",
                "content": MemoriaVM.contenuto(t.testo, esterno: esterno),
                "conversation_id": conversazione,
                "event_id": t.id.uuidString.lowercased(),
                "created_at": t.alle / 1000,
                "persona": Personaggi.tutti[t.chi] != nil ? t.chi : "melissa",
                "speaker": t.chi == "tu" ? "andrea" : t.chi,
                // le parole di Andrea sono dirette; risposte e allegati non diventano fatti su di lui
                "trust": t.chi == "tu" && !esterno ? "diretto" : "esterno",
            ]
            guard let stato = await posta(config, "/mem/add", corpo) else { return }
            // 409: quell'event_id c'e' gia' (un giro di prima arrivato dopo il timeout): e' sulla VM, non si rimanda
            guard stato == 200 || stato == 409 else { return }
            mandati.insert(t.id)
        }
    }

    private func leggi(_ chatID: UUID, _ config: ConfigMemoria) async {
        let telefono = AssistenteTelefono.shared
        guard let chat = telefono.chat.first(where: { $0.id == chatID }) else { return }
        let id = chat.idVM.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? chat.idVM
        guard let righe: [RigaVM] = await prendi(config, "/mem/recent?conversation=\(id)&n=60", chiave: "messages") else { return }
        // la scheda puo' essere cambiata durante la lettura: i turni vanno nella chat letta
        telefono.aggiungiDallaVM(righe, in: chatID)
    }

    // MARK: - rete

    private func basi(_ config: ConfigMemoria) -> [URL] {
        [config.url, config.url_ip].compactMap { $0 }.filter { !$0.isEmpty }.compactMap(URL.init(string:))
    }

    private func prendi<T: Decodable>(_ config: ConfigMemoria, _ percorso: String, chiave: String) async -> T? {
        for base in basi(config) {
            guard let url = URL(string: base.absoluteString + percorso) else { continue }
            var req = URLRequest(url: url, timeoutInterval: 12)
            req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
            guard let (d, r) = try? await URLSession.shared.data(for: req) else { continue }
            guard (r as? HTTPURLResponse)?.statusCode == 200 else {
                Log.info("memoria: \(percorso.prefix { $0 != "?" }) ha risposto \((r as? HTTPURLResponse)?.statusCode ?? 0)")
                return nil
            }
            guard let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let dentro = obj[chiave],
                  let dati = try? JSONSerialization.data(withJSONObject: dentro) else { return nil }
            return try? JSONDecoder().decode(T.self, from: dati)
        }
        return nil
    }

    /// Lo stato HTTP, o nil se nessuna delle due strade risponde.
    private func posta(_ config: ConfigMemoria, _ percorso: String, _ corpo: [String: Any]) async -> Int? {
        guard let dati = try? JSONSerialization.data(withJSONObject: corpo) else { return nil }
        for base in basi(config) {
            guard let url = URL(string: base.absoluteString + percorso) else { continue }
            var req = URLRequest(url: url, timeoutInterval: 12)
            req.httpMethod = "POST"
            req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = dati
            guard let (_, r) = try? await URLSession.shared.data(for: req) else { continue }
            return (r as? HTTPURLResponse)?.statusCode ?? 0
        }
        return nil
    }
}
