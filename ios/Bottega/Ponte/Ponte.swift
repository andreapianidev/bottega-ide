//
//  Ponte.swift
//  Bottega per iPhone
//
//  Il cliente del ponte della Bottega (extensions/bottega-home/src/ponte.ts, docs/CONTRATTI.md, 9): HTTP sulla
//  rete Tailscale, gettone in ogni richiesta. Gli eventi in diretta tengono aggiornati Melissa e i lavori; se
//  cadono si riprovano da soli, sempre piu' di rado, finche' l'app e' davanti.
//

import Foundation
import Observation
import WidgetKit

struct ErrorePonte: LocalizedError {
    let messaggio: String
    /// Il codice HTTP, quando l'errore viene da una risposta del Mac (401 gettone, 409 domanda cambiata).
    var codice: Int?
    var errorDescription: String? { messaggio }
}

@MainActor
@Observable
final class Ponte {
    /// Uno solo per tutta l'app: la usano le viste, le notifiche e Siri.
    static let shared = Ponte()
    enum Linea: Equatable {
        case scollegato
        case provo
        case collegato
        case fuori(String)
    }

    private(set) var collegamento: Collegamento? = Collegamento.carica()
    private(set) var stato: StatoMac?
    private(set) var linea: Linea = .scollegato

    private var eventi: Task<Void, Never>?
    /// Se il nome MagicDNS non si risolve (MagicDNS spento sull'iPhone) si passa all'indirizzo 100.x.
    private var usaIP = false
    private let sessione: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 90
        c.waitsForConnectivity = false
        return URLSession(configuration: c, delegate: FiduciaPonte.shared, delegateQueue: nil)
    }()
    /// Per /v1/parla: con uno strumento lento il Mac puo' restare zitto a lungo prima della frase dopo.
    private let sessioneLunga: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 180
        c.waitsForConnectivity = false
        return URLSession(configuration: c, delegate: FiduciaPonte.shared, delegateQueue: nil)
    }()

    var collegato: Bool { collegamento != nil }

    // MARK: - collegamento

    @discardableResult
    func collega(_ url: URL) -> Bool {
        guard let c = Collegamento(url: url) else { return false }
        let prima = collegamento
        c.salva()
        collegamento = c
        usaIP = false
        stato = nil
        riavvia()
        // un altro Mac o un gettone nuovo: quel Mac non ha i token di questo iPhone, si rimandano tutti
        if prima == nil || prima?.host != c.host || prima?.token != c.token {
            Avvisi.shared.dimentica()
            // da scollegati ci pensa il cambio di `collegato` (BottegaApp)
            if prima != nil { Avvisi.shared.avvia() }
        }
        return true
    }

    /// Prima il Mac toglie i token di questo iPhone e si chiudono le Live Activity, poi si dimentica tutto.
    func scollega() async {
        await Avvisi.shared.congeda()
        ferma()
        Collegamento.dimentica()
        collegamento = nil
        stato = nil
        linea = .scollegato
        Avvisi.shared.dimentica()
    }

    /// Il portachiavi non si legge prima del primo sblocco dopo l'accensione: se all'avvio il gettone non c'era,
    /// si riprova da qui (app davanti, token da mandare).
    func ricarica() {
        guard collegamento == nil, let c = Collegamento.carica() else { return }
        collegamento = c
    }

    // MARK: - eventi in diretta

    func avvia() {
        guard collegamento != nil, eventi == nil else { return }
        eventi = Task { [weak self] in await self?.segui() }
    }

    func ferma() {
        eventi?.cancel()
        eventi = nil
    }

    func riavvia() {
        ferma()
        avvia()
    }

    private func segui() async {
        var attesa: UInt64 = 1
        while !Task.isCancelled {
            linea = .provo
            do {
                let (bytes, risposta) = try await sessione.bytes(for: richiesta("/v1/eventi", timeout: 60))
                try controlla(risposta, corpo: nil)
                attesa = 1
                for try await riga in bytes.lines {
                    guard riga.hasPrefix("data: ") else { continue }
                    let dati = Data(riga.dropFirst(6).utf8)
                    if let s = try? JSONDecoder().decode(StatoMac.self, from: dati) {
                        aggiorna(s)
                        linea = .collegato
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                if Task.isCancelled { return }
                if collegamento?.ripiegaSuHttp(error, ripetibile: true) == true || scambiaSuIP(error) { continue }
                linea = .fuori(spiega(error))
                if (error as? ErrorePonte)?.codice == 401 {
                    // gettone rifiutato: riprovare farebbe solo chiudere fuori questo iPhone dal Mac. Si riparte con
                    // un nuovo collegamento o al prossimo ritorno davanti dell'app.
                    eventi = nil
                    return
                }
            }
            try? await Task.sleep(nanoseconds: attesa * 1_000_000_000)
            attesa = min(attesa * 2, 30)
        }
    }

    private func aggiorna(_ s: StatoMac) {
        let prima = stato
        stato = s
        s.salvaComeUltimo()
        Collegamento.ricordaSicuro(s.sicuro)
        if prima?.conti != s.conti || prima?.lavori.map(\.chiave) != s.lavori.map(\.chiave) { WidgetCenter.shared.reloadAllTimelines() }
        MetalEngine.shared.setLoad(s.conti.inCorso)
    }

    // MARK: - richieste

    /// `conferma`: il numero della domanda arrivato con la notifica CONFERMA; se nel frattempo la domanda e'
    /// cambiata il Mac risponde 409.
    func chiedi(_ testo: String, conferma: Int? = nil) async throws -> String {
        struct R: Decodable { let risposta: String; let stato: StatoMac }
        var corpo: [String: Any] = ["testo": testo]
        if let conferma { corpo["conferma"] = conferma }
        let r: R = try await manda("/v1/chiedi", corpo)
        aggiorna(r.stato)
        return r.risposta
    }

    enum Parla {
        case voce(Bool)
        case frase(String)
        case audio(Data)
        case vocePersa(String)
        case fine(String)
    }

    /// La domanda a voce: righe del ponte mentre Melissa risponde (frasi, audio), fino alla fine. Cancellare il
    /// compito chiude la connessione e il Mac interrompe la risposta.
    func parla(_ testo: String, riga: (Parla) -> Void) async throws {
        struct Riga: Decodable {
            let tipo: String
            let ok: Bool?
            let testo: String?
            let pcm: String?
            let errore: String?
            let risposta: String?
            let stato: StatoMac?
        }
        var req = try richiesta("/v1/parla", timeout: 180)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["testo": testo])
        let bytes: URLSession.AsyncBytes
        do {
            let (b, r) = try await sessioneLunga.bytes(for: req)
            if let h = r as? HTTPURLResponse, !(200..<300).contains(h.statusCode) {
                var corpo = Data()
                for try await x in b { corpo.append(x) }
                try controlla(r, corpo: corpo)
            }
            bytes = b
        } catch {
            if collegamento?.ripiegaSuHttp(error, ripetibile: false) == true || scambiaSuIP(error) {
                return try await parla(testo, riga: riga)
            }
            throw (error as? ErrorePonte) ?? ErrorePonte(messaggio: spiega(error))
        }
        let dec = JSONDecoder()
        for try await linea in bytes.lines {
            guard let r = try? dec.decode(Riga.self, from: Data(linea.utf8)) else { continue }
            switch r.tipo {
            case "voce": riga(.voce(r.ok ?? false))
            case "frase": riga(.frase(r.testo ?? ""))
            case "audio": if let d = r.pcm.flatMap({ Data(base64Encoded: $0) }) { riga(.audio(d)) }
            case "voce-persa": riga(.vocePersa(r.errore ?? ""))
            case "fine":
                if let s = r.stato { aggiorna(s) }
                riga(.fine(r.risposta ?? ""))
                return
            case "errore": throw ErrorePonte(messaggio: r.errore ?? "Sul Mac qualcosa non è andato.")
            default: break
            }
        }
    }

    /// I token per le push del Mac (docs/CONTRATTI.md, 9.4): notifiche, Live Activity, widget.
    func registraDispositivo(_ campi: [String: String], timeout: TimeInterval = 90) async throws {
        struct R: Decodable { let ok: Bool }
        let _: R = try await manda("/v1/dispositivo", campi, timeout: timeout)
    }

    func scriviLavoro(_ id: String, _ testo: String) async throws {
        struct R: Decodable { let ok: Bool }
        let _: R = try await manda("/v1/lavoro", ["id": id, "testo": testo])
    }

    func aggiornaStato() async {
        do {
            let (d, r) = try await sessione.data(for: richiesta("/v1/stato"))
            try controlla(r, corpo: d)
            aggiorna(try JSONDecoder().decode(StatoMac.self, from: d))
            linea = .collegato
        } catch {
            if collegamento?.ripiegaSuHttp(error, ripetibile: true) == true || scambiaSuIP(error) {
                await aggiornaStato()
            } else {
                linea = .fuori(spiega(error))
            }
        }
    }

    // MARK: - il cervello di Melissa (9.8)

    /// I cervelli che il Mac dice disponibili, quello di adesso, l'impegno e il predefinito.
    func cervelli() async throws -> CervelliMac {
        try await prendi("/v1/cervelli")
    }

    /// Cambia il cervello e/o l'impegno, con gli stessi metodi della barra del Mac. `sempre`: diventa il predefinito.
    func scegliCervello(provider: String? = nil, impegno: String? = nil, sempre: Bool = false) async throws -> CervelliMac {
        var corpo: [String: Any] = ["sempre": sempre]
        if let provider { corpo["provider"] = provider }
        if let impegno { corpo["impegno"] = impegno }
        let r: CervelliMac = try await manda("/v1/cervello", corpo, timeout: 30)
        // il nome sotto la sfera cambia subito, anche se gli eventi sono caduti
        Task { await aggiornaStato() }
        return r
    }

    private func prendi<T: Decodable>(_ percorso: String, timeout: TimeInterval = 30) async throws -> T {
        do {
            let (d, r) = try await sessione.data(for: richiesta(percorso, timeout: timeout))
            try controlla(r, corpo: d)
            return try JSONDecoder().decode(T.self, from: d)
        } catch {
            if collegamento?.ripiegaSuHttp(error, ripetibile: true) == true || scambiaSuIP(error) {
                return try await prendi(percorso, timeout: timeout)
            }
            throw (error as? ErrorePonte) ?? ErrorePonte(messaggio: spiega(error))
        }
    }

    private func manda<T: Decodable>(_ percorso: String, _ corpo: [String: Any], timeout: TimeInterval = 90) async throws -> T {
        let d = try await mandaDati(percorso, corpo, timeout: timeout)
        return try JSONDecoder().decode(T.self, from: d)
    }

    private func mandaDati(_ percorso: String, _ corpo: [String: Any], timeout: TimeInterval) async throws -> Data {
        var req = try richiesta(percorso, timeout: timeout)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: corpo)
        do {
            let (d, r) = try await sessione.data(for: req)
            try controlla(r, corpo: d)
            return d
        } catch {
            if collegamento?.ripiegaSuHttp(error, ripetibile: false) == true || scambiaSuIP(error) {
                return try await mandaDati(percorso, corpo, timeout: timeout)
            }
            throw (error as? ErrorePonte) ?? ErrorePonte(messaggio: spiega(error))
        }
    }

    private func richiesta(_ percorso: String, timeout: TimeInterval = 90) throws -> URLRequest {
        guard let c = collegamento else { throw ErrorePonte(messaggio: "L'iPhone non e' collegato a nessun Mac.") }
        let host = usaIP && !c.ip.isEmpty ? c.ip : c.host
        guard let url = URL(string: "\(c.schema)://\(host):\(c.portaAdesso)\(percorso)") else {
            throw ErrorePonte(messaggio: "Indirizzo del Mac non valido.")
        }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.setValue("Bearer \(c.token)", forHTTPHeaderField: "authorization")
        return req
    }

    private func controlla(_ r: URLResponse, corpo: Data?) throws {
        guard let h = r as? HTTPURLResponse else { return }
        guard (200..<300).contains(h.statusCode) else {
            struct E: Decodable { let errore: String }
            let m = corpo.flatMap { try? JSONDecoder().decode(E.self, from: $0) }?.errore
            let ripiego = h.statusCode == 401
                ? "Il Mac non riconosce più questo iPhone: ricollegalo con «Collega l'iPhone» dalla Bottega."
                : "Il Mac ha risposto \(h.statusCode)."
            throw ErrorePonte(messaggio: m ?? ripiego, codice: h.statusCode)
        }
    }

    private func scambiaSuIP(_ error: Error) -> Bool {
        guard !usaIP, let c = collegamento, !c.ip.isEmpty, c.ip != c.host,
              (error as? URLError)?.code == .cannotFindHost || (error as? URLError)?.code == .dnsLookupFailed else { return false }
        usaIP = true
        return true
    }

    private func spiega(_ error: Error) -> String {
        if let e = error as? ErrorePonte { return e.messaggio }
        switch (error as? URLError)?.code {
        case .notConnectedToInternet?, .networkConnectionLost?:
            return "Niente rete sull'iPhone."
        case .cannotConnectToHost?, .timedOut?, .cannotFindHost?, .dnsLookupFailed?:
            return "Il Mac non risponde: controlla che sia acceso, con la Bottega aperta e Tailscale attivo su tutti e due."
        case .appTransportSecurityRequiresSecureConnection?:
            return "iOS ha bloccato la connessione al Mac."
        default:
            return error.localizedDescription
        }
    }
}
