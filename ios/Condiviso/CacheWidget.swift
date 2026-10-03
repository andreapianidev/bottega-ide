//
//  CacheWidget.swift
//  Bottega per iPhone (app e widget)
//
//  L'ultima copia delle stanze che servono ai widget (docs/CONTRATTI.md, 9.4 e 9.6): App Store, Vedetta, consigli e
//  servizi. La scrivono l'app, quando apre una stanza, e i widget, quando il Mac risponde; col Mac spento i widget
//  mostrano questa, con la sua eta'. Sta nel contenitore del gruppo, protetta fino al primo sblocco: i widget della
//  schermata di blocco la leggono anche a telefono bloccato. Mai posta, WhatsApp o clienti. Scollegando l'iPhone si
//  cancella.
//

import Foundation
import WidgetKit

/// I nomi dei widget nuovi: li usano i widget stessi e l'app per ricaricarli.
enum TipiWidget {
    static let guadagni = "com.andreapiani.bottega.ios.widget.guadagni"
    static let consigli = "com.andreapiani.bottega.ios.widget.consigli"
    static let crediti = "com.andreapiani.bottega.ios.widget.crediti"
    static let semaforo = "com.andreapiani.bottega.ios.widget.semaforo"
}

enum CacheWidget {
    /// Le sole stanze che possono finire qui.
    static let stanze: Set<String> = ["appstore", "vedetta", "consigli", "servizi"]

    struct Copia {
        let dati: Data
        /// Quando l'iPhone l'ha ricevuta dal Mac.
        let visto: Date
    }

    /// Le app viste nella stanza App Store, per scegliere l'app del widget «Guadagni».
    private static let chiaveApp = "appGuadagni"

    /// Lo stesso nome della copia di PonteStanze: la stanza e i parametri non vuoti, in ordine.
    static func chiave(_ nome: String, _ query: [String: String]) -> String {
        let resto = query.filter { !$0.value.isEmpty }.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "&")
        return resto.isEmpty ? nome : "\(nome)?\(resto)"
    }

    private static var cartella: URL? {
        guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Condiviso.gruppo) else { return nil }
        let d = base.appendingPathComponent("Library/Caches/widget", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private static func file(_ chiave: String) -> URL? {
        let nome = String(chiave.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "_" }.prefix(120))
        return cartella?.appendingPathComponent(nome + ".json")
    }

    static func leggi(_ nome: String, _ query: [String: String] = [:]) -> Copia? {
        guard stanze.contains(nome), let f = file(chiave(nome, query)),
              let d = try? Data(contentsOf: f),
              let quando = (try? FileManager.default.attributesOfItem(atPath: f.path))?[.modificationDate] as? Date else { return nil }
        return Copia(dati: d, visto: quando)
    }

    /// Salva la risposta del Mac. Con `ricarica` (dall'app) i widget di quella stanza si ridisegnano.
    static func scrivi(_ dati: Data, _ nome: String, _ query: [String: String] = [:], ricarica: Bool = false) {
        guard stanze.contains(nome), let f = file(chiave(nome, query)) else { return }
        try? dati.write(to: f, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        if nome == "appstore", query["progetto"]?.isEmpty ?? true { ricordaApp(dati) }
        if ricarica, let tipo = tipo(nome) { WidgetCenter.shared.reloadTimelines(ofKind: tipo) }
    }

    static func dimentica() {
        if let c = cartella { try? FileManager.default.removeItem(at: c) }
        Condiviso.preferenze.removeObject(forKey: chiaveApp)
        for t in [TipiWidget.guadagni, TipiWidget.consigli, TipiWidget.crediti, TipiWidget.semaforo] {
            WidgetCenter.shared.reloadTimelines(ofKind: t)
        }
    }

    /// Il widget che mostra quella stanza.
    static func tipo(_ nome: String) -> String? {
        switch nome {
        case "appstore": TipiWidget.guadagni
        case "vedetta": TipiWidget.semaforo
        case "consigli": TipiWidget.consigli
        case "servizi": TipiWidget.crediti
        default: nil
        }
    }

    /// I nomi delle app che hanno reso qualcosa, le ultime viste per prime (al massimo 20).
    static func appNote() -> [String] {
        Condiviso.preferenze.stringArray(forKey: chiaveApp) ?? []
    }

    private static func ricordaApp(_ dati: Data) {
        struct Elenco: Decodable {
            struct App: Decodable { let nome: String }
            let app: [App]
        }
        guard let nuove = (try? JSONDecoder().decode(Elenco.self, from: dati))?.app.map(\.nome), !nuove.isEmpty else { return }
        var tutte = nuove
        for n in appNote() where !tutte.contains(n) { tutte.append(n) }
        Condiviso.preferenze.set(Array(tutte.prefix(20)), forKey: chiaveApp)
    }
}
