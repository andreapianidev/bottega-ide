//
//  Posizione.swift
//  Moony AI per iPhone
//
//  Dov'e' Andrea (docs/CONTRATTI.md 9.12). L'iPhone e' il dispositivo che Andrea ha addosso: quando esce e
//  il Mac resta a casa, anche per giorni, e' lui che sa dove si trova. Con il permesso "sempre" l'app usa tre
//  servizi di iOS che costano pochissima batteria e la svegliano anche da chiusa:
//
//    - le soste (visite): arrivato in un posto, ripartito;
//    - la zona casa: entrata e uscita, con il raggio che decide la VM;
//    - gli spostamenti significativi: una posizione ogni qualche centinaio di metri.
//
//  Non c'e' una traccia continua. I segnali vanno DIRETTAMENTE alla memoria di Moony sulla VM, sulla rete
//  Tailscale, con un gettone ristretto che apre solo la posizione: il Mac puo' essere spento. Se la rete
//  manca restano in coda su disco e partono al giro dopo. A decidere "casa o fuori" e' la VM.
//

import CoreLocation
import Foundation
import MapKit
import Security
import UIKit

/// Indirizzo della VM e gettone, dal Mac con GET /v1/dove/config (solo HTTPS).
struct ConfigDove: Codable, Equatable {
    let url: String
    let url_ip: String?
    let token: String
}

enum SegretiDove {
    private static let servizio = "com.andreapiani.bottega.ios.dove"
    private static let gruppo = "ERAK83QBBM.com.andreapiani.bottega.ios"
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: servizio,
         kSecAttrAccount as String: "configurazione", kSecAttrAccessGroup as String: gruppo]
    }

    static func leggi() -> ConfigDove? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(ConfigDove.self, from: data)
    }

    static func salva(_ c: ConfigDove) throws {
        let data = try JSONEncoder().encode(c)
        SecItemDelete(query as CFDictionary)
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw ErrorePonte(messaggio: "Il portachiavi dell'iPhone non ha salvato la posizione (\(status)).")
        }
    }

    static func cancella() { SecItemDelete(query as CFDictionary) }
}

@MainActor
final class Posizione: NSObject, CLLocationManagerDelegate {
    static let shared = Posizione()

    /// Una sosta piu' corta e' un semaforo o una coda (come sulla VM).
    nonisolated static let sostaMinima: TimeInterval = 10 * 60
    /// Oltre, la coda perde i segnali piu' vecchi: la VM tiene comunque solo l'ultimo di ogni tipo.
    nonisolated static let codaMassima = 300
    /// Raggio della zona casa se la VM non ne dice uno.
    nonisolated static let raggioCasa: CLLocationDistance = 150
    nonisolated static let idZona = "casa"

    private let manager = CLLocationManager()
    private(set) var config: ConfigDove? = SegretiDove.leggi()
    private var avviata = false
    private var mandando = false
    private var coda: [[String: Any]] = []

    var configurata: Bool { config != nil }

    private static var fileCoda: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("posizione-coda.json")
    }

    private override init() {
        super.init()
        manager.delegate = self
        coda = Self.caricaCoda()
    }

    // MARK: - avvio

    /// Da didFinishLaunching: un evento di posizione rilancia l'app dietro, e arriva solo a un manager che ha
    /// gia' il delegato. Senza configurazione (iPhone non ancora collegato al Mac) non chiede niente.
    func avvia() {
        if config == nil { config = SegretiDove.leggi() }   // prima del primo sblocco il portachiavi non si legge
        guard config != nil, !avviata else { return }
        avviata = true
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
        default: break
        }
        accendiServizi()
        Task { await svuotaCoda() }
    }

    func importa(_ c: ConfigDove) throws {
        try SegretiDove.salva(c)
        let nuova = config != c
        config = c
        if nuova { Log.info("posizione: configurazione importata dal Mac") }
        avvia()
    }

    /// Scollegando l'iPhone dal Mac si spegne tutto e si dimentica il gettone.
    func dimentica() {
        manager.stopMonitoringVisits()
        manager.stopMonitoringSignificantLocationChanges()
        for r in manager.monitoredRegions where r.identifier == Self.idZona { manager.stopMonitoring(for: r) }
        SegretiDove.cancella()
        config = nil
        avviata = false
        coda = []
        try? FileManager.default.removeItem(at: Self.fileCoda)
    }

    private func accendiServizi() {
        let s = manager.authorizationStatus
        guard s == .authorizedAlways || s == .authorizedWhenInUse else { return }
        manager.startMonitoringVisits()
        manager.startMonitoringSignificantLocationChanges()
        Task { await aggiornaZonaCasa() }
    }

    // MARK: - delegato (iOS lo chiama sul thread del manager, cioe' il principale)

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated {
            let s = manager.authorizationStatus
            Log.info("posizione: permesso \(s.rawValue)")
            // "Mentre usi l'app" e' il primo passo: iOS chiede "sempre" solo dopo.
            if s == .authorizedWhenInUse, config != nil { manager.requestAlwaysAuthorization() }
            if config != nil { accendiServizi() }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        let lat = visit.coordinate.latitude, lon = visit.coordinate.longitude, acc = visit.horizontalAccuracy
        let arrivo = visit.arrivalDate == .distantPast ? nil : visit.arrivalDate.timeIntervalSince1970
        let partenza = visit.departureDate == .distantFuture ? nil : visit.departureDate.timeIntervalSince1970
        Task { @MainActor in
            if let arrivo, let partenza, partenza - arrivo < Self.sostaMinima { return }
            let luogo = await Self.nome(lat: lat, lon: lon, accuratezza: acc, dettagliato: true)
            var s: [String: Any] = ["tipo": "visita", "lat": lat, "lon": lon, "acc": acc,
                                    "at": Date().timeIntervalSince1970, "luogo": luogo]
            if let arrivo { s["arrivo"] = arrivo }
            if let partenza { s["partenza"] = partenza }
            await self.accoda(s)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let l = locations.last, l.horizontalAccuracy >= 0 else { return }
        let lat = l.coordinate.latitude, lon = l.coordinate.longitude, acc = l.horizontalAccuracy
        let at = l.timestamp.timeIntervalSince1970
        Task { @MainActor in
            let luogo = await Self.nome(lat: lat, lon: lon, accuratezza: acc, dettagliato: false)
            await self.accoda(["tipo": "fix", "lat": lat, "lon": lon, "acc": acc, "at": at, "luogo": luogo])
        }
    }

    /// Chiamato all'avvio della sorveglianza (requestState) e a ogni attraversamento del confine: un solo
    /// punto per entrata e uscita, cosi' non si mandano due segnali per lo stesso passaggio.
    nonisolated func locationManager(_ manager: CLLocationManager, didDetermineState state: CLRegionState,
                                     for region: CLRegion) {
        guard region.identifier == Self.idZona, state != .unknown else { return }
        let evento = state == .inside ? "entrata" : "uscita"
        Task { @MainActor in
            await self.accoda(["tipo": "zona", "evento": evento, "at": Date().timeIntervalSince1970])
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?,
                                     withError error: Error) {
        Log.warn("posizione: zona casa non sorvegliata (\(error.localizedDescription))")
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Log.warn("posizione: \(error.localizedDescription)")
    }

    // MARK: - zona casa

    /// Il centro di casa lo tiene la VM (l'ha imparato il Mac): la zona si rimette solo se e' cambiato.
    private func aggiornaZonaCasa() async {
        guard let stato = await leggiStato(), let casa = stato.casa else { return }
        let centro = CLLocationCoordinate2D(latitude: casa.lat, longitude: casa.lon)
        let raggio = min(max(casa.raggio_m ?? Self.raggioCasa, 100), manager.maximumRegionMonitoringDistance)
        if let r = manager.monitoredRegions.first(where: { $0.identifier == Self.idZona }) as? CLCircularRegion,
           CLLocation(latitude: r.center.latitude, longitude: r.center.longitude)
               .distance(from: CLLocation(latitude: centro.latitude, longitude: centro.longitude)) < 20,
           abs(r.radius - raggio) < 1 {
            return
        }
        let zona = CLCircularRegion(center: centro, radius: raggio, identifier: Self.idZona)
        zona.notifyOnEntry = true
        zona.notifyOnExit = true
        manager.startMonitoring(for: zona)
        manager.requestState(for: zona)
        Log.info("posizione: zona casa sorvegliata, raggio \(Int(raggio)) m")
    }

    // MARK: - coda e invio

    private func accoda(_ s: [String: Any]) async {
        coda.append(s)
        if coda.count > Self.codaMassima { coda.removeFirst(coda.count - Self.codaMassima) }
        salvaCoda()
        await svuotaCoda()
    }

    /// Manda la coda alla VM; con l'app chiusa iOS concede pochi secondi, chiesti con un'attivita' in background.
    private func svuotaCoda() async {
        guard !mandando, !coda.isEmpty, let config else { return }
        mandando = true
        defer { mandando = false }
        let attivita = UIApplication.shared.beginBackgroundTask(withName: "posizione") {}
        defer { UIApplication.shared.endBackgroundTask(attivita) }
        let lotto = Array(coda.prefix(100))
        let corpo: [String: Any] = ["device": "iphone", "segnali": lotto]
        for base in [config.url, config.url_ip].compactMap({ $0 }).filter({ !$0.isEmpty }) {
            guard let url = URL(string: base + "/dove/segnale"),
                  let dati = try? JSONSerialization.data(withJSONObject: corpo) else { continue }
            var req = URLRequest(url: url, timeoutInterval: 15)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
            req.httpBody = dati
            do {
                let (_, r) = try await URLSession.shared.data(for: req)
                guard (r as? HTTPURLResponse)?.statusCode == 200 else {
                    Log.warn("posizione: la VM ha risposto \((r as? HTTPURLResponse)?.statusCode ?? 0)")
                    continue
                }
                coda.removeFirst(min(lotto.count, coda.count))
                salvaCoda()
                Log.info("posizione: \(lotto.count) segnali consegnati")
                return
            } catch {
                Log.warn("posizione: invio non riuscito (\(error.localizedDescription))")
            }
        }
    }

    private struct StatoDove: Decodable {
        struct Casa: Decodable { let lat: Double; let lon: Double; let raggio_m: Double? }
        let casa: Casa?
    }

    private func leggiStato() async -> StatoDove? {
        guard let config else { return nil }
        for base in [config.url, config.url_ip].compactMap({ $0 }).filter({ !$0.isEmpty }) {
            guard let url = URL(string: base + "/dove") else { continue }
            var req = URLRequest(url: url, timeoutInterval: 15)
            req.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
            if let (d, r) = try? await URLSession.shared.data(for: req), (r as? HTTPURLResponse)?.statusCode == 200,
               let s = try? JSONDecoder().decode(StatoDove.self, from: d) {
                return s
            }
        }
        return nil
    }

    private func salvaCoda() {
        guard let d = try? JSONSerialization.data(withJSONObject: coda) else { return }
        try? d.write(to: Self.fileCoda, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private static func caricaCoda() -> [[String: Any]] {
        guard let d = try? Data(contentsOf: fileCoda),
              let v = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] else { return [] }
        return v
    }

    // MARK: - nome del posto

    /// Per una sosta il posto con un nome li' vicino (un bar, un negozio) o l'indirizzo; per uno spostamento
    /// basta il paese. Se la ricerca non risponde il nome resta vuoto: la VM sa cosa fare.
    private static func nome(lat: Double, lon: Double, accuratezza: Double, dettagliato: Bool) async -> String {
        let posto = CLLocation(latitude: lat, longitude: lon)
        var indirizzo = "", citta = ""
        if let richiesta = MKReverseGeocodingRequest(location: posto),
           let item = try? await richiesta.mapItems.first {
            citta = item.addressRepresentations?.cityName ?? ""
            indirizzo = item.address?.shortAddress ?? ""
        }
        guard dettagliato else { return citta.isEmpty ? indirizzo : citta }
        let poi = MKLocalPointsOfInterestRequest(center: posto.coordinate, radius: 80)
        if let r = try? await MKLocalSearch(request: poi).start(),
           let vicino = r.mapItems.filter({ !($0.name ?? "").isEmpty })
               .min(by: { $0.location.distance(from: posto) < $1.location.distance(from: posto) }),
           let n = vicino.name, vicino.location.distance(from: posto) <= 80 + min(max(accuratezza, 0), 100) {
            return citta.isEmpty || n.contains(citta) ? n : "\(n) (\(citta))"
        }
        if !indirizzo.isEmpty { return citta.isEmpty || indirizzo.contains(citta) ? indirizzo : "\(indirizzo), \(citta)" }
        return citta
    }
}
