//
//  PonteStanze.swift
//  Bottega per iPhone
//
//  Le stanze della plancia dal ponte (extensions/bottega-home/src/ponte-stanze.ts, docs/CONTRATTI.md, 9.6):
//  GET /v1/stanza?nome=..&periodo=..&progetto=.., in sola lettura. Un cliente a parte accanto a Ponte, come
//  PonteSessioni: stesso collegamento (nome MagicDNS, ripiego sull'indirizzo 100.x, gettone), connessioni sue.
//
//  Ogni risposta buona resta come ultima copia, con l'ora in cui l'iPhone l'ha vista: con il Mac spento la stanza
//  mostra quella e dice quanto e' vecchia. In memoria sempre; su disco (cache dell'app, protezione completa) solo
//  le stanze senza dati di altre persone: App Store, cruscotto, Vedetta, cose da fare, notte. Posta e clienti
//  restano solo in memoria e spariscono con l'app chiusa.
//

import Foundation
import Observation

@MainActor
final class PonteStanze {
    static let shared = PonteStanze()

    struct Copia {
        let dati: Data
        /// Quando l'iPhone l'ha ricevuta dal Mac.
        let visto: Date
    }

    /// Le stanze che possono restare sul disco dell'iPhone.
    static let suDisco: Set<String> = ["appstore", "cruscotto", "vedetta", "dafare", "notte"]

    private var memoria: [String: Copia] = [:]
    private var usaIP = false
    private let sessione: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        // il cruscotto e le ore dei clienti si ricalcolano sul Mac: al massimo 20 secondi, poi «riprova»
        c.timeoutIntervalForRequest = 45
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    private lazy var cartella: URL? = {
        guard let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let d = base.appendingPathComponent("stanze", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    // MARK: - lettura

    /// L'ultima copia vista di questa stanza con questi parametri: prima in memoria, poi sul disco.
    func ultima(_ nome: String, _ query: [String: String]) -> Copia? {
        let k = chiave(nome, query)
        if let c = memoria[k] { return c }
        guard Self.suDisco.contains(nome), let f = file(k),
              let d = try? Data(contentsOf: f),
              let quando = (try? FileManager.default.attributesOfItem(atPath: f.path))?[.modificationDate] as? Date else { return nil }
        let c = Copia(dati: d, visto: quando)
        memoria[k] = c
        return c
    }

    /// Chiede la stanza al Mac; se risponde, la copia diventa l'ultima vista.
    func leggi(_ nome: String, _ query: [String: String]) async throws -> Copia {
        var q = query.filter { !$0.value.isEmpty }
        q["nome"] = nome
        let d = try await dati(try richiesta("/v1/stanza", q))
        let c = Copia(dati: d, visto: Date())
        let k = chiave(nome, query)
        memoria[k] = c
        if Self.suDisco.contains(nome), let f = file(k) {
            try? d.write(to: f, options: [.atomic, .completeFileProtection])
        }
        // App Store e Vedetta servono anche ai widget: la copia nel gruppo e il widget si ridisegna
        if CacheWidget.stanze.contains(nome) { CacheWidget.scrivi(d, nome, query, ricarica: true) }
        return c
    }

    /// Scollegando l'iPhone le copie non servono piu'.
    func dimentica() {
        memoria = [:]
        CacheWidget.dimentica()
        if let c = cartella { try? FileManager.default.removeItem(at: c) }
        cartella = nil
    }

    private func chiave(_ nome: String, _ query: [String: String]) -> String {
        let resto = query.filter { !$0.value.isEmpty }.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "&")
        return resto.isEmpty ? nome : "\(nome)?\(resto)"
    }

    private func file(_ chiave: String) -> URL? {
        // un nome di file sicuro: lettere e cifre, il resto diventa trattino basso
        let nome = String(chiave.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "_" }.prefix(120))
        return cartella?.appendingPathComponent(nome + ".json")
    }

    // MARK: - rete (come PonteSessioni)

    private func dati(_ req: URLRequest) async throws -> Data {
        do {
            let (d, r) = try await sessione.data(for: req)
            try controlla(r, corpo: d)
            return d
        } catch {
            if scambiaSuIP(error), let url = req.url {
                var nuova = req
                nuova.url = conIP(url)
                return try await dati(nuova)
            }
            throw (error as? ErrorePonte) ?? ErrorePonte(messaggio: spiega(error))
        }
    }

    private func richiesta(_ percorso: String, _ query: [String: String]) throws -> URLRequest {
        guard let c = Ponte.shared.collegamento else { throw ErrorePonte(messaggio: "L'iPhone non è collegato a nessun Mac.") }
        var u = URLComponents()
        u.scheme = "http"
        u.host = usaIP && !c.ip.isEmpty ? c.ip : c.host
        u.port = c.porta
        u.path = percorso
        if !query.isEmpty { u.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        u.percentEncodedQuery = u.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let url = u.url else { throw ErrorePonte(messaggio: "Indirizzo del Mac non valido.") }
        var req = URLRequest(url: url, timeoutInterval: 45)
        req.setValue("Bearer \(c.token)", forHTTPHeaderField: "authorization")
        return req
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

/// Lo stato di una stanza aperta: l'ultimo dato (dal Mac o dalla copia), quando l'iPhone l'ha visto, l'errore
/// dell'ultima richiesta. Con il Mac spento resta il dato vecchio e l'errore dice perche'.
@MainActor
@Observable
final class LetturaStanza<T: Decodable> {
    private(set) var dati: T?
    private(set) var visto: Date?
    private(set) var errore: String?
    private(set) var caricando = false
    /// Vero se `dati` viene dalla copia salvata e il Mac non ha ancora risposto.
    private(set) var vecchio = false

    let nome: String

    init(_ nome: String) { self.nome = nome }

    /// Un giro alla volta: la risposta di un periodo lasciato a meta' non sovrascrive quella del periodo nuovo.
    private var giro = 0

    func carica(_ query: [String: String] = [:]) async {
        giro += 1
        let mio = giro
        let ponte = PonteStanze.shared
        if let c = ponte.ultima(nome, query), let d = try? JSONDecoder().decode(T.self, from: c.dati) {
            dati = d
            visto = c.visto
            vecchio = true
        } else {
            // un periodo mai visto: niente dati di un altro periodo spacciati per questo
            dati = nil
            visto = nil
        }
        caricando = true
        defer { if mio == giro { caricando = false } }
        do {
            let c = try await ponte.leggi(nome, query)
            guard mio == giro else { return }
            dati = try JSONDecoder().decode(T.self, from: c.dati)
            visto = c.visto
            errore = nil
            vecchio = false
        } catch is DecodingError {
            guard mio == giro else { return }
            errore = "La risposta del Mac non si legge: aggiorna l'app o la Bottega."
        } catch {
            if mio != giro || (error as? ErrorePonte)?.messaggio == "Interrotto." { return }
            errore = error.localizedDescription
        }
    }
}
