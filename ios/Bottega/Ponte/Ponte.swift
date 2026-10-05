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
import CryptoKit
import Security
import WidgetKit

struct ErrorePonte: LocalizedError {
    let messaggio: String
    /// Il codice HTTP, quando l'errore viene da una risposta del Mac (401 gettone, 409 domanda cambiata).
    var codice: Int?
    var errorDescription: String? { messaggio }
}

/// Solo per il recupero di un vecchio abbinamento: un'unica lettura HTTPS su Tailscale. La risposta
/// autenticata deve confermare questa impronta prima che Ponte la memorizzi come pin stabile.
private final class FiduciaBootstrap: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var valore: String?
    var impronta: String? { lock.lock(); defer { lock.unlock() }; return valore }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let (decisione, credenziale) = decidi(challenge)
        completionHandler(decisione, credenziale)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let (decisione, credenziale) = decidi(challenge)
        completionHandler(decisione, credenziale)
    }

    private func decidi(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let catena = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let foglia = catena.first else { return (.cancelAuthenticationChallenge, nil) }
        let impronta = SHA256.hash(data: SecCertificateCopyData(foglia) as Data)
            .map { String(format: "%02x", $0) }.joined()
        lock.lock(); valore = impronta; lock.unlock()
        return (.useCredential, URLCredential(trust: trust))
    }
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
    /// Col flusso degli eventi aperto in http: ogni 30 s guarda se l'https e' tornato utilizzabile (annunciato dal Mac
    /// e finita la pausa di Collegamento.ripiegaSuHttp) e in quel caso riapre il flusso in https. Senza, un flusso
    /// aperto in http ci restava per ore, passando dal relay di iCloud.
    @ObservationIgnored private var ritorno: Task<Void, Never>?
    /// Se il nome MagicDNS non si risolve (MagicDNS spento sull'iPhone) si passa all'indirizzo 100.x.
    private var usaIP = false
    private var ultimoSuccesso: Date?
    private var importandoAssistente = false
    private var sincronizzandoAssistente = false
    private var sincronizzandoScelta = false
    @ObservationIgnored private var preparandoHttps: Task<Bool, Never>?
#if DEBUG
    /// La prova autonoma non deve essere annullata da un evento /v1/eventi gia' in volo.
    @ObservationIgnored private var macAssentePerProva = false
#endif
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

    /// Anche senza rete Melissa può leggere l'ultimo registro del Mac abbinato, con la sua età esplicita.
    func contestoMelissa(per domanda: String) -> String? {
        guard collegato else { return nil }
        return (stato ?? StatoMac.ultimo())?.contestoMelissa(per: domanda, salvato: linea != .collegato)
    }

    // MARK: - collegamento

    @discardableResult
    func collega(_ url: URL) -> Bool {
        guard let c = Collegamento(url: url) else { return false }
        let prima = collegamento
        c.salva()
        collegamento = c
        usaIP = false
        stato = nil
        if prima == nil || prima?.host != c.host || prima?.token != c.token {
            StatoMac.dimenticaUltimo()
            OrologioTelefono.shared.dimentica()
        }
        riavvia()
        // un altro Mac o un gettone nuovo: quel Mac non ha i token di questo iPhone, si rimandano tutti
        if prima == nil || prima?.host != c.host || prima?.token != c.token {
            AssistenteTelefono.shared.cancella()
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
        StatoMac.dimenticaUltimo()
        OrologioTelefono.shared.dimentica()
        linea = .scollegato
        Avvisi.shared.dimentica()
        AssistenteTelefono.shared.cancella()
    }

    /// Il portachiavi non si legge prima del primo sblocco dopo l'accensione: se all'avvio il gettone non c'era,
    /// si riprova da qui (app davanti, token da mandare).
    func ricarica() {
        guard collegamento == nil, let c = Collegamento.carica() else { return }
        collegamento = c
    }

    // MARK: - eventi in diretta

    func avvia() {
#if DEBUG
        if macAssentePerProva { return }
#endif
        guard collegamento != nil, eventi == nil else { return }
        eventi = Task { [weak self] in await self?.segui() }
    }

    func ferma() {
        ritorno?.cancel()
        ritorno = nil
        eventi?.cancel()
        eventi = nil
    }

    func riavvia() {
#if DEBUG
        macAssentePerProva = false
#endif
        ferma()
        avvia()
    }

#if DEBUG
    /// Prova sul dispositivo: spegne soltanto gli eventi del ponte e usa il percorso autonomo.
    func simulaMacAssentePerProva() {
        macAssentePerProva = true
        ferma()
        linea = .fuori("Mac non raggiungibile nella prova")
    }
#endif

    private func segui() async {
        var attesa: UInt64 = 1
        // Il motivo dell'errore resta visibile durante i tentativi automatici.
        // Riscrivere .provo a ogni giro nascondeva il timeout dietro "Cerco il Mac".
        if ultimoSuccesso.map({ Date().timeIntervalSince($0) > 45 }) ?? true { linea = .provo }
        while !Task.isCancelled {
            if Collegamento.sicuro == nil { _ = await preparaHttps() }
            do {
                let req = try richiesta("/v1/eventi", timeout: 60)
                let (bytes, risposta) = try await sessione.bytes(for: req, delegate: FiduciaPonte.shared)
                try controlla(risposta, corpo: nil)
                if req.url?.scheme == "http" { tornaSicuro() } else { ritorno?.cancel(); ritorno = nil }
                attesa = 1
                for try await riga in bytes.lines {
#if DEBUG
                    if macAssentePerProva { return }
#endif
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
                Log.warn("ponte eventi: \(Self.categoriaVoce(error)), \(collegamento?.schema ?? "-") su \(usaIP ? "IP" : "nome")")
                if await rinnovaCertificatoSeServe(error) { continue }
                if scambiaSuIP(error, ripetibile: true) || collegamento?.ripiegaSuHttp(error, ripetibile: true) == true { continue }
                if ultimoSuccesso.map({ Date().timeIntervalSince($0) > 45 }) ?? true { linea = .fuori(spiega(error)) }
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

    /// Il flusso e' in http: appena l'https e' di nuovo la strada (impronta imparata, pausa finita) lo si riapre.
    private func tornaSicuro() {
        ritorno?.cancel()
        ritorno = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self, !Task.isCancelled else { return }
                if self.collegamento?.schema == "https" {
                    self.riavvia()
                    return
                }
            }
        }
    }

    private func aggiorna(_ s: StatoMac) {
        let prima = stato
        stato = s
        ultimoSuccesso = Date()
        s.salvaComeUltimo()
        OrologioTelefono.shared.aggiorna(s)
        Collegamento.ricordaSicuro(s.sicuro)
        AssistenteTelefono.shared.aggiornaSceltaDalMac(s.melissa.scelta)
        if AssistenteTelefono.shared.sceltaInAttesa && !sincronizzandoScelta {
            sincronizzandoScelta = true
            Task {
                defer { sincronizzandoScelta = false }
                await AssistenteTelefono.shared.sincronizzaScelta(con: self)
            }
        }
        if !AssistenteTelefono.shared.configurato && s.sicuro != nil && !importandoAssistente {
            importandoAssistente = true
            Task {
                defer { importandoAssistente = false }
                try? await importaConfigurazioneAssistente()
            }
        }
        if AssistenteTelefono.shared.turni.contains(where: { !$0.sincronizzato }) && !sincronizzandoAssistente {
            sincronizzandoAssistente = true
            Task {
                defer { sincronizzandoAssistente = false }
                await AssistenteTelefono.shared.sincronizza(con: self)
            }
        }
        if prima?.conti != s.conti || prima?.lavori.map(\.chiave) != s.lavori.map(\.chiave) || prima?.attivita != s.attivita {
            WidgetCenter.shared.reloadAllTimelines()
        }
        MetalEngine.shared.setLoad(s.conti.inCorso)
    }

    /// Ripara anche gli abbinamenti vecchi: il Mac espone HTTPS sulla porta successiva. Il certificato
    /// viene accettato provvisoriamente solo per questa lettura su Tailscale; il JSON autenticato con il
    /// gettone deve dichiarare la stessa impronta prima di salvarla e aprire gli eventi ordinari.
    private func preparaHttps(force: Bool = false) async -> Bool {
        if !force && Collegamento.sicuro != nil { return true }
        if let preparandoHttps { return await preparandoHttps.value }
        let task = Task { [weak self] in await self?.provaHttps() ?? false }
        preparandoHttps = task
        let ok = await task.value
        preparandoHttps = nil
        return ok
    }

    private func provaHttps() async -> Bool {
        guard let c = collegamento else { return false }
        let ip = c.ip.split(separator: ".").compactMap { Int($0) }
        let usaTailnetIP = ip.count == 4 && ip[0] == 100 && (64...127).contains(ip[1]) && ip.allSatisfy { (0...255).contains($0) }
        guard usaTailnetIP || c.host.hasSuffix(".ts.net") else { return false }
        let host = usaTailnetIP ? c.ip : c.host
        guard let url = URL(string: "https://\(host):\(c.porta + 1)/v1/stato") else { return false }
        let delegato = FiduciaBootstrap()
        let config = URLSessionConfiguration.ephemeral
        config.waitsForConnectivity = false
        let sessioneBootstrap = URLSession(configuration: config, delegate: delegato, delegateQueue: nil)
        defer { sessioneBootstrap.invalidateAndCancel() }
        var req = URLRequest(url: url, timeoutInterval: 12)
        req.setValue("Bearer \(c.token)", forHTTPHeaderField: "authorization")
        do {
            let (data, response) = try await sessioneBootstrap.data(for: req)
            try controlla(response, corpo: data)
            let nuovo = try JSONDecoder().decode(StatoMac.self, from: data)
            guard let https = nuovo.https, https.porta == c.porta + 1,
                  https.impronta.lowercased() == delegato.impronta else {
                Log.warn("ponte HTTPS: impronta annunciata diversa dal certificato")
                return false
            }
            usaIP = usaTailnetIP
            aggiorna(nuovo)
            linea = .collegato
            Log.info("ponte HTTPS: collegamento verificato su Tailscale")
            return true
        } catch {
            Log.warn("ponte HTTPS: verifica iniziale fallita (\(Self.categoriaVoce(error)))")
            return false
        }
    }

    private func certificatoDaRinnovare(_ error: Error) -> Bool {
        guard collegamento?.schema == "https", let code = (error as? URLError)?.code else { return false }
        return [.cancelled, .secureConnectionFailed, .serverCertificateUntrusted,
                .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot].contains(code)
    }

    private func rinnovaCertificatoSeServe(_ error: Error) async -> Bool {
        guard certificatoDaRinnovare(error) else { return false }
        return await preparaHttps(force: true)
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
        let idDiagnostica = String(UUID().uuidString.prefix(8))
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
            let (b, r) = try await sessioneLunga.bytes(for: req, delegate: FiduciaPonte.shared)
            Log.info("ponte voce \(idDiagnostica): HTTP \((r as? HTTPURLResponse)?.statusCode ?? 0)")
            if let h = r as? HTTPURLResponse, !(200..<300).contains(h.statusCode) {
                var corpo = Data()
                for try await x in b { corpo.append(x) }
                try controlla(r, corpo: corpo)
            }
            bytes = b
        } catch {
            Log.warn("ponte voce \(idDiagnostica): apertura fallita, \(Self.categoriaVoce(error))")
            if collegamento?.ripiegaSuHttp(error, ripetibile: false) == true || scambiaSuIP(error) {
                return try await parla(testo, riga: riga)
            }
            throw (error as? ErrorePonte) ?? ErrorePonte(messaggio: spiega(error))
        }
        let dec = JSONDecoder()
        var audioBytes = 0
        var audioFrames = 0
        var frasi = 0
        var invalide = 0
        var vocePersa = false
        do {
            for try await linea in bytes.lines {
                try Task.checkCancellation()
                guard let r = try? dec.decode(Riga.self, from: Data(linea.utf8)) else {
                    invalide += 1
                    continue
                }
                switch r.tipo {
                case "voce":
                    Log.info("ponte voce \(idDiagnostica): disponibilita audio \(r.ok ?? false)")
                    riga(.voce(r.ok ?? false))
                case "frase":
                    frasi += 1
                    riga(.frase(r.testo ?? ""))
                case "audio":
                    if let d = r.pcm.flatMap({ Data(base64Encoded: $0) }) {
                        audioBytes += d.count
                        audioFrames += 1
                        if audioFrames == 1 { Log.info("ponte voce \(idDiagnostica): primo PCM \(d.count) byte") }
                        riga(.audio(d))
                    } else { invalide += 1 }
                case "voce-persa":
                    vocePersa = true
                    Log.warn("ponte voce \(idDiagnostica): voce persa dal Mac, PCM \(audioBytes) byte")
                    riga(.vocePersa(r.errore ?? ""))
                case "fine":
                    Log.info("ponte voce \(idDiagnostica): finale, frasi \(frasi), frame \(audioFrames), PCM \(audioBytes) byte, righe invalide \(invalide), voce persa \(vocePersa)")
                    if let s = r.stato { aggiorna(s) }
                    riga(.fine(r.risposta ?? ""))
                    return
                case "errore":
                    Log.warn("ponte voce \(idDiagnostica): errore dal Mac, frasi \(frasi), PCM \(audioBytes) byte")
                    throw ErrorePonte(messaggio: r.errore ?? "Sul Mac qualcosa non è andato.")
                default: break
                }
            }
            Log.warn("ponte voce \(idDiagnostica): flusso terminato senza finale, frasi \(frasi), frame \(audioFrames), PCM \(audioBytes) byte, righe invalide \(invalide)")
            throw ErrorePonte(messaggio: "Il Mac ha interrotto la risposta a voce prima della fine.")
        } catch {
            Log.warn("ponte voce \(idDiagnostica): chiusura, \(Self.categoriaVoce(error)), frame \(audioFrames), PCM \(audioBytes) byte")
            throw error
        }
    }

    private static func categoriaVoce(_ error: Error) -> String {
        if error is CancellationError { return "cancellazione" }
        if let e = error as? URLError { return "rete \(e.errorCode)" }
        if error is ErrorePonte { return "protocollo" }
        return "errore \((error as NSError).code)"
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
#if DEBUG
        if macAssentePerProva { return }
#endif
        if Collegamento.sicuro == nil {
            if await preparaHttps() { return }
        }
        do {
            let (d, r) = try await sessione.data(for: richiesta("/v1/stato", timeout: 12))
#if DEBUG
            if macAssentePerProva { return }
#endif
            try controlla(r, corpo: d)
            aggiorna(try JSONDecoder().decode(StatoMac.self, from: d))
            linea = .collegato
        } catch {
            Log.warn("ponte stato: \(Self.categoriaVoce(error)), \(collegamento?.schema ?? "-") su \(usaIP ? "IP" : "nome")")
            if await rinnovaCertificatoSeServe(error) { return }
            if scambiaSuIP(error, ripetibile: true) || collegamento?.ripiegaSuHttp(error, ripetibile: true) == true {
                await aggiornaStato()
            } else {
                if ultimoSuccesso.map({ Date().timeIntervalSince($0) > 45 }) ?? true { linea = .fuori(spiega(error)) }
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

    /// Una sola importazione quando il Mac e' acceso. Chiavi mai sul ponte HTTP o nelle preferenze.
    func importaConfigurazioneAssistente() async throws {
        guard collegamento?.schema == "https" else {
            throw ErrorePonte(messaggio: "Per importare le chiavi serve il collegamento HTTPS con il Mac.")
        }
        let config: ConfigurazioneTelefono = try await prendi("/v1/assistente/config")
        try AssistenteTelefono.shared.importa(config)
    }

    func importaStoria(_ turns: [TurnoTelefono]) async throws {
        struct R: Decodable { let ok: Bool }
        let body: [[String: String]] = turns.map { ["id": $0.id.uuidString.lowercased(), "chi": $0.chi, "testo": $0.testo] }
        let _: R = try await manda("/v1/assistente/storia", ["turns": body])
    }

    private func prendi<T: Decodable>(_ percorso: String, timeout: TimeInterval = 30) async throws -> T {
        do {
            let (d, r) = try await sessione.data(for: richiesta(percorso, timeout: timeout))
            try controlla(r, corpo: d)
            return try JSONDecoder().decode(T.self, from: d)
        } catch {
            if await rinnovaCertificatoSeServe(error) {
                return try await prendi(percorso, timeout: timeout)
            }
            if scambiaSuIP(error, ripetibile: true) || collegamento?.ripiegaSuHttp(error, ripetibile: true) == true {
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
        // Un cambio di abbinamento durante un await non deve spostare una POST
        // (o il suo retry) sul nuovo Mac. I retry conservano questa identita'.
        let originale = collegamento
        func verificaCollegamento() throws {
            try Task.checkCancellation()
            guard collegamento == originale else { throw CancellationError() }
        }
        func invia() async throws -> Data {
            try verificaCollegamento()
            var req = try richiesta(percorso, timeout: timeout)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: corpo)
            do {
                let (d, r) = try await sessione.data(for: req)
                try verificaCollegamento()
                try controlla(r, corpo: d)
                return d
            } catch {
                try verificaCollegamento()
                if error is CancellationError { throw error }
                let rinnovato = await rinnovaCertificatoSeServe(error)
                try verificaCollegamento()
                if rinnovato { return try await invia() }
                if collegamento?.ripiegaSuHttp(error, ripetibile: false) == true || scambiaSuIP(error) {
                    return try await invia()
                }
                throw (error as? ErrorePonte) ?? ErrorePonte(messaggio: spiega(error))
            }
        }
        return try await invia()
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

    private func scambiaSuIP(_ error: Error, ripetibile: Bool = false) -> Bool {
        guard !usaIP, let c = collegamento, c.schema == "https", !c.ip.isEmpty, c.ip != c.host else { return false }
        let codice = (error as? URLError)?.code
        let nonArrivata: Set<URLError.Code> = [.cannotFindHost, .dnsLookupFailed, .cannotConnectToHost]
        let lettura: Set<URLError.Code> = [.timedOut, .networkConnectionLost, .badServerResponse]
        guard codice.map({ nonArrivata.contains($0) || (ripetibile && lettura.contains($0)) }) == true else { return false }
        usaIP = true
        Log.info("ponte: riprovo con IP Tailscale")
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
