//
//  Collegamento.swift
//  Bottega per iPhone
//
//  Dove sta il Mac e il gettone per parlargli. Arriva dal QR del comando "Collega l'iPhone" della Bottega:
//  bottega://collega?host=<nome MagicDNS>&ip=<100.x>&porta=7790&token=<gettone>
//  Nome, indirizzo e porta stanno nelle preferenze del gruppo; il gettone nel portachiavi condiviso, solo su
//  questo iPhone: li leggono sia l'app sia i widget (Condiviso.swift).
//

import CryptoKit
import Foundation
import os
import Security

struct Collegamento: Equatable {
    var host: String
    var ip: String
    var porta: Int
    var token: String
    /// Impronta consegnata dal QR del Mac, se il ponte TLS era gia' acceso al momento dell'abbinamento.
    var httpsDalQR: Sicuro? = nil

    /// Il nome del Mac da mostrare: la prima parte del nome MagicDNS, con gli spazi al posto dei trattini.
    var nomeMac: String {
        let primo = host.split(separator: ".").first.map(String.init) ?? host
        return primo.replacingOccurrences(of: "-", with: " ")
    }

    init?(url: URL) {
        guard url.scheme == "bottega", url.host == "collega",
              let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        func v(_ k: String) -> String? { q.first { $0.name == k }?.value?.trimmingCharacters(in: .whitespaces) }
        guard let token = v("token"), token.count >= 32 else { return nil }
        let host = v("host") ?? ""
        let ip = v("ip") ?? ""
        guard !host.isEmpty || !ip.isEmpty else { return nil }
        self.host = host.isEmpty ? ip : host
        self.ip = ip
        self.porta = Int(v("porta") ?? "") ?? 7790
        self.token = token
        if let securePort = Int(v("https_porta") ?? ""), securePort == self.porta + 1,
           let fingerprint = v("https_impronta")?.lowercased(), fingerprint.count == 64,
           fingerprint.allSatisfy({ $0.isHexDigit }) {
            self.httpsDalQR = Sicuro(porta: securePort, impronta: fingerprint)
        }
    }

    init(host: String, ip: String, porta: Int, token: String) {
        self.host = host
        self.ip = ip
        self.porta = porta
        self.token = token
    }

    // MARK: - https (docs/CONTRATTI.md, 9.1)

    /// Le stesse rotte cifrate, sulla porta accanto: porta e impronta SHA-256 del certificato fatto dal Mac,
    /// imparate da /v1/stato. In http col nome MagicDNS iOS passava prima dal relay privato di iCloud (502) e solo
    /// dopo dal tunnel di Tailscale: da 0,7 a 5,7 s in piu' a richiesta, e i widget scadevano (log del 3 ottobre
    /// 2026). Il traffico cifrato il relay non lo tocca.
    struct Sicuro: Equatable {
        var porta: Int
        var impronta: String
    }

    private static let chiaveSicuro = "ponteHttps"
    /// Quando l'https e' caduto in questo processo (app o widget): per due minuti si va in http, poi si riprova.
    private static let sicuroGiu = OSAllocatedUnfairLock<Date?>(initialState: nil)
    private static let pausaSicuro: TimeInterval = 120

    /// Quello che il Mac ha annunciato, se l'ha annunciato.
    static var sicuro: Sicuro? {
        guard let d = Condiviso.preferenze.dictionary(forKey: chiaveSicuro), let porta = d["porta"] as? Int,
              let impronta = d["impronta"] as? String, impronta.count == 64 else { return nil }
        return Sicuro(porta: porta, impronta: impronta)
    }

    /// Lo stato del Mac dice dove sta l'https (o che non c'e'): si ricorda per l'app e per i widget.
    static func ricordaSicuro(_ s: Sicuro?) {
        guard s != sicuro else { return }
        if let s {
            Condiviso.preferenze.set(["porta": s.porta, "impronta": s.impronta.lowercased()], forKey: chiaveSicuro)
        } else {
            Condiviso.preferenze.removeObject(forKey: chiaveSicuro)
        }
        sicuroGiu.withLock { $0 = nil }
    }

    private static var usaSicuro: Bool {
        guard sicuro != nil else { return false }
        return sicuroGiu.withLock { giu in giu.map { Date().timeIntervalSince($0) > pausaSicuro } ?? true }
    }

    /// "https" o "http", e la porta che va con lo schema.
    var schema: String { Self.usaSicuro ? "https" : "http" }
    var portaAdesso: Int { Self.usaSicuro ? (Self.sicuro?.porta ?? porta) : porta }

    /// Con un'impronta HTTPS nota non si torna a HTTP: sull'IP Tailscale iOS lo blocca con ATS.
    /// Il ponte riapre HTTPS (e, se il certificato cambia, rinnova l'impronta con /v1/stato).
    func ripiegaSuHttp(_ error: Error, ripetibile: Bool) -> Bool { false }

    // MARK: - dove si conserva

    private static let chiave = "collegamento"
    private static let servizio = "com.andreapiani.bottega.ios.ponte"

    /// Dove sta il gettone. Fino alla build 30 nel portachiavi della sola app; dalla 31 in quello condiviso con i
    /// widget. Ogni lettura e cancellazione nomina il suo gruppo: senza gruppo SecItemDelete cancella in tutti (era
    /// il guaio della build 31, che dopo aver copiato il gettone cancellava anche la copia).
    private enum Posto {
        case condiviso, app
        var gruppo: String { self == .condiviso ? Condiviso.portachiavi : "ERAK83QBBM.com.andreapiani.bottega.ios" }
    }

    static func carica() -> Collegamento? {
        let d = Condiviso.preferenze.dictionary(forKey: chiave) ?? UserDefaults.standard.dictionary(forKey: chiave)
        guard let d, let host = d["host"] as? String, let porta = d["porta"] as? Int else { return nil }
        let token: String
        if let t = leggiToken(.condiviso) {
            token = t
        } else if let t = leggiToken(.app) {
            // collegamento di prima: si copia dove lo leggono anche i widget, e quello vecchio resta li'
            token = t
            scriviToken(t, .condiviso)
        } else {
            return nil
        }
        if Condiviso.preferenze.dictionary(forKey: chiave) == nil { Condiviso.preferenze.set(d, forKey: chiave) }
        return Collegamento(host: host, ip: d["ip"] as? String ?? "", porta: porta, token: token)
    }

    func salva() {
        let d: [String: Any] = ["host": host, "ip": ip, "porta": porta]
        // un Mac nuovo (o un gettone nuovo): l'https si reimpara dal suo stato
        Condiviso.preferenze.removeObject(forKey: Self.chiaveSicuro)
        if let httpsDalQR { Self.ricordaSicuro(httpsDalQR) }
        Condiviso.preferenze.set(d, forKey: Self.chiave)
        UserDefaults.standard.set(d, forKey: Self.chiave)
        Self.scriviToken(token, .condiviso)
        Self.scriviToken(token, .app)
    }

    static func dimentica() {
        Condiviso.preferenze.removeObject(forKey: chiave)
        Condiviso.preferenze.removeObject(forKey: chiaveSicuro)
        UserDefaults.standard.removeObject(forKey: chiave)
        SecItemDelete(query(.condiviso) as CFDictionary)
        SecItemDelete(query(.app) as CFDictionary)
    }

    private static func query(_ posto: Posto) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: servizio,
         kSecAttrAccount as String: "gettone", kSecAttrAccessGroup as String: posto.gruppo]
    }

    private static func leggiToken(_ posto: Posto) -> String? {
        var q = query(posto)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    private static func scriviToken(_ token: String, _ posto: Posto) {
        SecItemDelete(query(posto) as CFDictionary)
        var q = query(posto)
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let esito = SecItemAdd(q as CFDictionary, nil)
        if esito != errSecSuccess { NSLog("Bottega: gettone non salvato nel portachiavi (%d)", esito) }
    }
}

/// Accetta il certificato del ponte solo se la sua impronta e' quella che il Mac ha annunciato in /v1/stato (9.1).
/// Nessuna autorita' lo firma: lo fa il Mac per se'. Le sessioni del ponte (app e widget) lo usano come delegato, e le
/// richieste in streaming (`bytes(for:delegate:)`) anche come delegato della richiesta: senza, il flusso degli eventi
/// finiva nella verifica predefinita di iOS e cadeva (-1202, build 71). Forma con completion handler, non async.
final class FiduciaPonte: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = FiduciaPonte()

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let (d, c) = Self.decidi(challenge)
        completionHandler(d, c)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let (d, c) = Self.decidi(challenge)
        completionHandler(d, c)
    }

    private static func decidi(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else { return (.performDefaultHandling, nil) }
        guard let attesa = Collegamento.sicuro?.impronta,
              verifica(trust: trust, improntaAttesa: attesa) else {
            return (.cancelAuthenticationChallenge, nil)
        }
        return (.useCredential, URLCredential(trust: trust))
    }

    static func verifica(trust: SecTrust, improntaAttesa: String) -> Bool {
        guard let catena = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let foglia = catena.first else { return false }
        let impronta = SHA256.hash(data: SecCertificateCopyData(foglia) as Data).map { String(format: "%02x", $0) }.joined()
        guard impronta == improntaAttesa else { return false }
        // Il pin autorizza esclusivamente questa ancora. La policy TLS originale
        // continua a verificare nome/IP, validita' temporale e uso del certificato.
        return SecTrustSetAnchorCertificates(trust, [foglia] as CFArray) == errSecSuccess
            && SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess
            && SecTrustEvaluateWithError(trust, nil)
    }
}
