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

    static func carica() -> Collegamento? {
        migra()
        guard let d = Condiviso.preferenze.dictionary(forKey: chiave),
              let host = d["host"] as? String, let porta = d["porta"] as? Int,
              let token = leggiToken(gruppo: true) else { return nil }
        return Collegamento(host: host, ip: d["ip"] as? String ?? "", porta: porta, token: token)
    }

    func salva() {
        Condiviso.preferenze.set(["host": host, "ip": ip, "porta": porta], forKey: Self.chiave)
        Self.scriviToken(token)
    }

    static func dimentica() {
        Condiviso.preferenze.removeObject(forKey: chiave)
        UserDefaults.standard.removeObject(forKey: chiave)
        SecItemDelete(query(gruppo: true) as CFDictionary)
        SecItemDelete(query(gruppo: false) as CFDictionary)
    }

    /// Fino alla build 30 il collegamento stava solo nell'app: si sposta nel gruppo, senza ricollegare l'iPhone.
    private static func migra() {
        guard Condiviso.preferenze.dictionary(forKey: chiave) == nil,
              let vecchio = UserDefaults.standard.dictionary(forKey: chiave),
              let token = leggiToken(gruppo: false) else { return }
        Condiviso.preferenze.set(vecchio, forKey: chiave)
        scriviToken(token)
        if leggiToken(gruppo: true) == token {
            UserDefaults.standard.removeObject(forKey: chiave)
            SecItemDelete(query(gruppo: false) as CFDictionary)
        }
    }

    private static func query(gruppo: Bool) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: servizio,
                                kSecAttrAccount as String: "gettone"]
        if gruppo { q[kSecAttrAccessGroup as String] = Condiviso.portachiavi }
        return q
    }

    private static func leggiToken(gruppo: Bool) -> String? {
        var q = query(gruppo: gruppo)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    private static func scriviToken(_ token: String) {
        SecItemDelete(query(gruppo: true) as CFDictionary)
        var q = query(gruppo: true)
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
}
