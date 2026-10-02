//
//  Collegamento.swift
//  Bottega per iPhone
//
//  Dove sta il Mac e il gettone per parlargli. Arriva dal QR del comando "Collega l'iPhone" della Bottega:
//  bottega://collega?host=<nome MagicDNS>&ip=<100.x>&porta=7790&token=<gettone>
//  Nome, indirizzo e porta stanno nelle preferenze; il gettone nel portachiavi, solo su questo iPhone.
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

    static func carica() -> Collegamento? {
        guard let d = UserDefaults.standard.dictionary(forKey: chiave),
              let host = d["host"] as? String, let porta = d["porta"] as? Int,
              let token = leggiToken() else { return nil }
        return Collegamento(host: host, ip: d["ip"] as? String ?? "", porta: porta, token: token)
    }

    func salva() {
        UserDefaults.standard.set(["host": host, "ip": ip, "porta": porta], forKey: Self.chiave)
        Self.scriviToken(token)
    }

    static func dimentica() {
        UserDefaults.standard.removeObject(forKey: chiave)
        SecItemDelete(query() as CFDictionary)
    }

    private static func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: servizio, kSecAttrAccount as String: "gettone"]
    }

    private static func leggiToken() -> String? {
        var q = query()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    private static func scriviToken(_ token: String) {
        SecItemDelete(query() as CFDictionary)
        var q = query()
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
}
