//
//  PonteSessioni.swift
//  Bottega per iPhone
//
//  La scheda di una sessione Claude dal ponte (extensions/bottega-home/src/ponte-sessioni.ts, docs/CONTRATTI.md,
//  9.5): la scheda in diretta, le modifiche e il diff, il terminale da guardare, la risposta alla domanda, «segui»
//  per la Live Activity e il riassunto a voce. Un cliente a parte, accanto a Ponte: usa lo stesso collegamento
//  (nome MagicDNS, ripiego sull'indirizzo 100.x, gettone) ma le sue connessioni, cosi' una scheda aperta non
//  tocca gli eventi della plancia.
//

import Foundation

struct SchedaSessione: Decodable, Equatable {
    struct Passo: Decodable, Equatable, Hashable {
        let testo: String
        /// modifica | comando | lettura | ricerca | web | agente | altro
        let tipo: String
        let alle: Double
        let inCorso: Bool?
    }
    struct Token: Decodable, Equatable {
        let entrata: Int
        let uscita: Int
        let contesto: Int
        let parziale: Bool?
    }
    struct Domanda: Decodable, Equatable {
        let id: String
        /// permesso | scelta | domanda | finestra
        let tipo: String
        let testo: String
        let strumento: String?
        let comando: String?
        let opzioni: [String]?
        let chiede: Bool?
    }
    let chiave: String
    let origine: String
    let stato: String
    let progetto: String
    let titolo: String
    let da: Double
    let jobId: String?
    let iniziata: Double?
    let ultimo: Double?
    let richiesta: String?
    let risposta: String?
    let passi: [Passo]
    let file: [String]
    let token: Token?
    let domanda: Domanda?
    let scrivibile: Bool
    let terminale: Bool
    let modifiche: Bool
    let seguita: Bool
    let finita: Bool?
}

struct ModificheSessione: Decodable {
    struct File: Decodable, Identifiable, Hashable {
        let percorso: String
        let aggiunte: Int
        let tolte: Int
        /// modificato | nuovo | tolto | binario
        let tipo: String
        var id: String { percorso }
    }
    let cartella: String
    let ramo: String
    let file: [File]
    let nonTracciati: Int
    let troncato: Bool
}

struct DiffSessione: Decodable {
    let file: String
    let diff: String
    let troncato: Bool
    let nuovo: Bool
}

struct SchermoTerminale: Decodable, Equatable {
    let righe: [String]
    let vivo: Bool
}

@MainActor
final class PonteSessioni {
    static let shared = PonteSessioni()

    /// Se il nome MagicDNS non si risolve si passa all'indirizzo 100.x, come Ponte.
    private var usaIP = false
    private let sessione: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 60
        c.waitsForConnectivity = false
        return URLSession(configuration: c, delegate: FiduciaPonte.shared, delegateQueue: nil)
    }()
    /// Per i flussi (scheda in diretta, terminale, riassunto): tra un dato e l'altro possono passare minuti.
    private let lunga: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 180
        c.waitsForConnectivity = false
        return URLSession(configuration: c, delegate: FiduciaPonte.shared, delegateQueue: nil)
    }()

    // MARK: - richieste

    func scheda(_ chiave: String) async throws -> SchedaSessione {
        try await prendi("/v1/sessione", ["chiave": chiave])
    }

    func modifiche(_ chiave: String) async throws -> ModificheSessione {
        try await prendi("/v1/sessione/modifiche", ["chiave": chiave])
    }

    func diff(_ chiave: String, file: String) async throws -> DiffSessione {
        try await prendi("/v1/sessione/diff", ["chiave": chiave, "file": file])
    }

    /// `risposta`: "si", "no" o "testo". `domanda` e' l'id della domanda che si sta guardando: se nel frattempo e'
    /// cambiata il Mac risponde 409 e non scrive niente.
    func rispondi(_ chiave: String, domanda: String, risposta: String, testo: String = "") async throws {
        struct R: Decodable { let ok: Bool }
        let _: R = try await manda("/v1/sessione/rispondi", ["chiave": chiave, "domanda": domanda, "risposta": risposta, "testo": testo])
    }

    /// La sessione da seguire sulla Live Activity ("" smette). Ritorna la chiave seguita adesso.
    func segui(_ chiave: String) async throws -> String {
        struct R: Decodable { let seguita: String }
        let r: R = try await manda("/v1/sessione/segui", ["chiave": chiave])
        return r.seguita
    }

    // MARK: - flussi

    /// La scheda in diretta: `su` a ogni cambio, finche' il compito non viene cancellato o la connessione cade.
    func diretta(_ chiave: String, su: (SchedaSessione) -> Void) async throws {
        try await eventi("/v1/sessione/eventi", ["chiave": chiave]) { d in
            if let s = try? JSONDecoder().decode(SchedaSessione.self, from: d) { su(s) }
        }
    }

    /// L'uscita del terminale di un lavoro della Bottega, gia' ripulita sul Mac: le ultime righe a ogni cambio.
    func terminale(_ chiave: String, su: (SchermoTerminale) -> Void) async throws {
        try await eventi("/v1/sessione/terminale", ["chiave": chiave]) { d in
            if let s = try? JSONDecoder().decode(SchermoTerminale.self, from: d) { su(s) }
        }
    }

    /// Melissa racconta la sessione a voce: le stesse righe di /v1/parla (voce, frase, audio, fine).
    func riassunto(_ chiave: String, riga: (Ponte.Parla) -> Void) async throws {
        struct Riga: Decodable {
            let tipo: String
            let ok: Bool?
            let testo: String?
            let pcm: String?
            let errore: String?
            let risposta: String?
        }
        var req = try richiesta("/v1/sessione/riassunto", [:], timeout: 180)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["chiave": chiave])
        let bytes = try await apri(req)
        let dec = JSONDecoder()
        for try await linea in bytes.lines {
            guard let r = try? dec.decode(Riga.self, from: Data(linea.utf8)) else { continue }
            switch r.tipo {
            case "voce": riga(.voce(r.ok ?? false))
            case "frase": riga(.frase(r.testo ?? ""))
            case "audio": if let d = r.pcm.flatMap({ Data(base64Encoded: $0) }) { riga(.audio(d)) }
            case "voce-persa": riga(.vocePersa(r.errore ?? ""))
            case "fine":
                riga(.fine(r.risposta ?? ""))
                return
            case "errore": throw ErrorePonte(messaggio: r.errore ?? "Sul Mac qualcosa non è andato.")
            default: break
            }
        }
    }

    private func eventi(_ percorso: String, _ query: [String: String], su: (Data) -> Void) async throws {
        let bytes = try await apri(try richiesta(percorso, query, timeout: 180))
        for try await riga in bytes.lines {
            guard riga.hasPrefix("data: ") else { continue }
            su(Data(riga.dropFirst(6).utf8))
        }
    }

    // MARK: - rete

    private func apri(_ req: URLRequest) async throws -> URLSession.AsyncBytes {
        do {
            let (b, r) = try await lunga.bytes(for: req, delegate: FiduciaPonte.shared)
            if let h = r as? HTTPURLResponse, !(200..<300).contains(h.statusCode) {
                var corpo = Data()
                for try await x in b { corpo.append(x) }
                try controlla(r, corpo: corpo)
            }
            return b
        } catch {
            if let c = Ponte.shared.collegamento, c.ripiegaSuHttp(error, ripetibile: req.httpMethod == "GET"), let url = req.url {
                var nuova = req
                nuova.url = aHttp(url)
                return try await apri(nuova)
            }
            if scambiaSuIP(error), let url = req.url {
                var nuova = req
                nuova.url = conIP(url)
                return try await apri(nuova)
            }
            throw (error as? ErrorePonte) ?? ErrorePonte(messaggio: spiega(error))
        }
    }

    private func prendi<T: Decodable>(_ percorso: String, _ query: [String: String]) async throws -> T {
        let d = try await dati(try richiesta(percorso, query))
        return try JSONDecoder().decode(T.self, from: d)
    }

    private func manda<T: Decodable>(_ percorso: String, _ corpo: [String: Any]) async throws -> T {
        var req = try richiesta(percorso, [:])
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: corpo)
        return try JSONDecoder().decode(T.self, from: try await dati(req))
    }

    private func dati(_ req: URLRequest) async throws -> Data {
        do {
            let (d, r) = try await sessione.data(for: req)
            try controlla(r, corpo: d)
            return d
        } catch {
            if let c = Ponte.shared.collegamento, c.ripiegaSuHttp(error, ripetibile: req.httpMethod == "GET"), let url = req.url {
                var nuova = req
                nuova.url = aHttp(url)
                return try await dati(nuova)
            }
            if scambiaSuIP(error), let url = req.url {
                var nuova = req
                nuova.url = conIP(url)
                return try await dati(nuova)
            }
            throw (error as? ErrorePonte) ?? ErrorePonte(messaggio: spiega(error))
        }
    }

    private func richiesta(_ percorso: String, _ query: [String: String], timeout: TimeInterval = 60) throws -> URLRequest {
        guard let c = Ponte.shared.collegamento else { throw ErrorePonte(messaggio: "L'iPhone non è collegato a nessun Mac.") }
        var u = URLComponents()
        u.scheme = c.schema
        u.host = usaIP && !c.ip.isEmpty ? c.ip : c.host
        u.port = c.portaAdesso
        u.path = percorso
        if !query.isEmpty { u.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        // i ":" nella chiave vanno bene, ma "+" e "&" in un nome di file no
        u.percentEncodedQuery = u.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let url = u.url else { throw ErrorePonte(messaggio: "Indirizzo del Mac non valido.") }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.setValue("Bearer \(c.token)", forHTTPHeaderField: "authorization")
        return req
    }

    /// La stessa richiesta in http, dopo che l'https non ha risposto (Collegamento.ripiegaSuHttp).
    private func aHttp(_ url: URL) -> URL {
        guard let c = Ponte.shared.collegamento, var u = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        u.scheme = "http"
        u.port = c.porta
        return u.url ?? url
    }

    private func conIP(_ url: URL) -> URL {
        guard let c = Ponte.shared.collegamento, var u = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        u.host = c.ip
        return u.url ?? url
    }

    private func controlla(_ r: URLResponse, corpo: Data?) throws {
        guard let h = r as? HTTPURLResponse, !(200..<300).contains(h.statusCode) else { return }
        struct E: Decodable { let errore: String }
        let m = corpo.flatMap { try? JSONDecoder().decode(E.self, from: $0) }?.errore
        throw ErrorePonte(messaggio: m ?? "Il Mac ha risposto \(h.statusCode).", codice: h.statusCode)
    }

    private func scambiaSuIP(_ error: Error) -> Bool {
        guard !usaIP, let c = Ponte.shared.collegamento, !c.ip.isEmpty, c.ip != c.host,
              (error as? URLError)?.code == .cannotFindHost || (error as? URLError)?.code == .dnsLookupFailed else { return false }
        usaIP = true
        return true
    }

    private func spiega(_ error: Error) -> String {
        switch (error as? URLError)?.code {
        case .notConnectedToInternet?, .networkConnectionLost?:
            return "Niente rete sull'iPhone."
        case .cannotConnectToHost?, .timedOut?, .cannotFindHost?, .dnsLookupFailed?:
            return "Il Mac non risponde: controlla che sia acceso, con la Bottega aperta e Tailscale attivo."
        case .cancelled?:
            return "Interrotto."
        default:
            return error.localizedDescription
        }
    }
}
