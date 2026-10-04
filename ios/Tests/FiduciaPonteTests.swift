import XCTest
import Security
import CryptoKit
@testable import Bottega

final class FiduciaPonteTests: XCTestCase {
    // Certificato sintetico pubblico RSA/SHA-256, serverAuth, CA:FALSE.
    // SAN: IP 100.64.0.2 e DNS bottega.invalid. La chiave privata non e' conservata.
    private static let certificatoBase64 = """
        MIIDWzCCAkOgAwIBAgIUT9uAARIgg/w1rQUQz/vmRrSiha8wDQYJKoZIhvcNAQELBQAwGjEYMBYGA1UEAwwPYm90dGVnYS5pbnZh
        bGlkMB4XDTI2MTAwNDIxMzk0MVoXDTI3MTAwNDIxMzk0MVowGjEYMBYGA1UEAwwPYm90dGVnYS5pbnZhbGlkMIIBIjANBgkqhkiG
        9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwkKBi/QPY/pezyanwxaybRiLw6HjdyJgy9BHsLtnTL4Va0ekNK5N/BCGNyqDXOl6ju/uQ9yN
        2XAbQs58SxpEQE6ls8d6kndW3CnRo9qWOEISGmHikzcuIN03wgIU1X4IkjW2HeR3DDYsJcwzjbZMDb9R7sktcM5hM0kHs1whRMAi
        2R53uA0H/oXipn61vg5HTptEwPamP/af3LCG2rC1ZuabDZOfzHYhHjyZqUPTzPXMFk4Rjw/dmOBmumUDUwJutdOmkkKzwSpUjelR
        S/0NjLP76i6GsnDSew8dXPH93nhGll5nqWyrY+eVHlE/HeQk+rl51wtBulkK1vQ5zFx2lwIDAQABo4GYMIGVMB0GA1UdDgQWBBRP
        uJD12B4XSI7djmNIRbe2qAOrCjAfBgNVHSMEGDAWgBRPuJD12B4XSI7djmNIRbe2qAOrCjAgBgNVHREEGTAXhwRkQAACgg9ib3R0
        ZWdhLmludmFsaWQwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDQYJKoZIhvcNAQEL
        BQADggEBAF0+JQbtixyPtyjBx0e8CHifPSCywqoFB+3SJ1pzdPIiao/ceplbnWM7GxrT17DXuFnHOnqFusPpLjsGmFgM38J6dVWU
        aHmcxtgI6W4MUivwO9j24qxpcz4EnDgu18L+065VRIwM1WdD4MzvSn+LDwvRJ/t9FOY1oB2BNagkWgEscEob4qzB8vfaw5Wxz+IN
        lrSdZGY5/YG6QVR7llCHJRhpld8NDoVmQw2mKB6w4pW5ErAjDp6E9kMKMvb24mlgs8UbV/DpZ3mVf/FnoquE2gXetc2iS8QMKzF8
        k9ljqUFivNIBz5D/Ci9UyQGG+MOPupl+macTbmpN/YUJfNq8gBk=
        """
    private static let dataValida = Date(timeIntervalSince1970: 1791236381)
    private static let dataScaduta = Date(timeIntervalSince1970: 1822772381)

    private func fiducia(host: String = "100.64.0.2", scaduto: Bool = false) throws -> (SecTrust, String) {
        let dati = try XCTUnwrap(Data(base64Encoded: Self.certificatoBase64, options: .ignoreUnknownCharacters))
        let certificato = try XCTUnwrap(SecCertificateCreateWithData(nil, dati as CFData))
        let policy = SecPolicyCreateSSL(true, host as CFString)
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(certificato, policy, &trust), errSecSuccess)
        let risultato = try XCTUnwrap(trust)
        XCTAssertEqual(SecTrustSetVerifyDate(risultato, (scaduto ? Self.dataScaduta : Self.dataValida) as CFDate), errSecSuccess)
        XCTAssertEqual(SecTrustSetNetworkFetchAllowed(risultato, false), errSecSuccess)
        let impronta = SHA256.hash(data: dati).map { String(format: "%02x", $0) }.joined()
        return (risultato, impronta)
    }

    func testIPNelSANConPinCorrettoAccettato() throws {
        let (trust, impronta) = try fiducia()
        XCTAssertTrue(FiduciaPonte.verifica(trust: trust, improntaAttesa: impronta))
    }

    func testPinDiversoRifiutato() throws {
        let (trust, _) = try fiducia()
        XCTAssertFalse(FiduciaPonte.verifica(trust: trust, improntaAttesa: String(repeating: "0", count: 64)))
    }

    func testHostEstraneoAlSANRifiutatoAncheConPinCorretto() throws {
        let (trust, impronta) = try fiducia(host: "100.64.0.3")
        XCTAssertFalse(FiduciaPonte.verifica(trust: trust, improntaAttesa: impronta))
    }

    func testCertificatoScadutoRifiutatoAncheConPinCorretto() throws {
        let (trust, impronta) = try fiducia(scaduto: true)
        XCTAssertFalse(FiduciaPonte.verifica(trust: trust, improntaAttesa: impronta))
    }
}
