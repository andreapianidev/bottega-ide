//
//  Collegamento.swift
//  Bottega per iPhone
//
//  Dove sta il Mac e il gettone per parlargli. Arriva dal QR del comando "Collega l'iPhone" della Bottega:
//  bottega://collega?host=<nome MagicDNS>&ip=<100.x>&porta=7790&token=<gettone>
//  Nome, indirizzo e porta stanno nelle preferenze del gruppo; il gettone nel portachiavi condiviso, solo su
//  questo iPhone: li leggono sia l'app sia i widget (Condiviso.swift).
//

import Foundation
import Security

struct Collegamento: Equatable {
    var host: String
    var ip: String
    var porta: Int
    var token: String

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
    }

    init(host: String, ip: String, porta: Int, token: String) {
        self.host = host
        self.ip = ip
        self.porta = porta
        self.token = token
    }

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
        Condiviso.preferenze.set(d, forKey: Self.chiave)
        UserDefaults.standard.set(d, forKey: Self.chiave)
        Self.scriviToken(token, .condiviso)
        Self.scriviToken(token, .app)
    }

    static func dimentica() {
        Condiviso.preferenze.removeObject(forKey: chiave)
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
