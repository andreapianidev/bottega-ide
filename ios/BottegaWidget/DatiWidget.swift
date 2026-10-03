//
//  DatiWidget.swift
//  Bottega per iPhone, estensione dei widget
//
//  Come i widget «Guadagni», «Consigli», «Crediti» e «Semaforo» leggono le stanze del Mac (GET /v1/stanza,
//  docs/CONTRATTI.md, 9.6): una richiesta breve con il collegamento condiviso (nome MagicDNS, ripiego sull'indirizzo
//  100.x, gettone del portachiavi), come il widget «Sessioni». La risposta buona va nella copia del gruppo
//  (CacheWidget); col Mac spento il widget mostra quella, con la sua eta' e la frase dell'errore. Mai un dato finto:
//  senza copia e senza Mac il widget lo dice.
//
//  Qui anche i modelli (solo i campi che servono ai widget), i formati e i pezzi di grafica comuni.
//

import SwiftUI
import WidgetKit

// MARK: - lettura

enum FonteWidget {
    /// Appena letto dal Mac (o da meno di due minuti).
    case diretta
    /// Il Mac non risponde: l'ultima copia vista, se c'e'.
    case salvata
    /// L'iPhone non e' collegato a nessun Mac.
    case scollegato
}

struct Letto<T> {
    var dati: T?
    /// Quando l'iPhone ha visto il dato.
    var visto: Date?
    var fonte: FonteWidget
    /// La frase dell'errore del Mac (503 «non pronta») o della rete, da mostrare cosi' com'e'.
    var errore: String?

    static var scollegato: Letto<T> { Letto(dati: nil, visto: nil, fonte: .scollegato, errore: nil) }
}

enum DatiWidget {
    /// Una copia piu' giovane di cosi' non si richiede: piu' widget sulla stessa stanza fanno una richiesta sola.
    static let fresca: TimeInterval = 120

    private static let sessione: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        // i consigli aspettano la Memoria al massimo 4 secondi sul Mac
        c.timeoutIntervalForRequest = 8
        c.timeoutIntervalForResource = 10
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    /// Legge una stanza. Con `soloCopia` (il pulsante «poi» dei consigli) non chiede niente al Mac.
    static func leggi<T: Decodable>(_ tipo: T.Type, stanza: String, query: [String: String] = [:], soloCopia: Bool = false) async -> Letto<T> {
        guard let c = Collegamento.carica() else { return .scollegato }
        let copia = CacheWidget.leggi(stanza, query)
        let daCopia = copia.flatMap { try? JSONDecoder().decode(T.self, from: $0.dati) }
        if let copia, let daCopia, soloCopia || Date().timeIntervalSince(copia.visto) < fresca {
            return Letto(dati: daCopia, visto: copia.visto, fonte: .diretta, errore: nil)
        }
        let esito = await chiedi(c, stanza: stanza, query: query)
        if case .dati(let grezzi) = esito {
            if let d = try? JSONDecoder().decode(T.self, from: grezzi) {
                CacheWidget.scrivi(grezzi, stanza, query)
                return Letto(dati: d, visto: Date(), fonte: .diretta, errore: nil)
            }
            return Letto(dati: daCopia, visto: copia?.visto, fonte: .salvata, errore: "La risposta del Mac non si legge: aggiorna l'app o la Bottega.")
        }
        guard case .errore(let frase) = esito else { return .scollegato }
        return Letto(dati: daCopia, visto: daCopia == nil ? nil : copia?.visto, fonte: .salvata, errore: frase)
    }

    /// Solo la copia, senza rete: per le anteprime della galleria.
    static func copia<T: Decodable>(_ tipo: T.Type, stanza: String, query: [String: String] = [:]) -> Letto<T>? {
        guard let c = CacheWidget.leggi(stanza, query), let d = try? JSONDecoder().decode(T.self, from: c.dati) else { return nil }
        return Letto(dati: d, visto: c.visto, fonte: .salvata, errore: nil)
    }

    private enum Esito {
        case dati(Data)
        case errore(String)
    }

    /// Prima il nome MagicDNS; se non si risolve, l'indirizzo 100.x.
    private static func chiedi(_ c: Collegamento, stanza: String, query: [String: String]) async -> Esito {
        do {
            return try await richiesta(c, host: c.host, stanza: stanza, query: query)
        } catch let e as URLError where [.cannotFindHost, .dnsLookupFailed].contains(e.code) && !c.ip.isEmpty && c.ip != c.host {
            return (try? await richiesta(c, host: c.ip, stanza: stanza, query: query)) ?? .errore(nonRisponde)
        } catch let e as URLError where e.code == .notConnectedToInternet {
            return .errore("Niente rete sull'iPhone.")
        } catch {
            return .errore(nonRisponde)
        }
    }

    private static let nonRisponde = "Il Mac non risponde."

    private static func richiesta(_ c: Collegamento, host: String, stanza: String, query: [String: String]) async throws -> Esito {
        var u = URLComponents()
        u.scheme = "http"
        u.host = host
        u.port = c.porta
        u.path = "/v1/stanza"
        var q = query.filter { !$0.value.isEmpty }
        q["nome"] = stanza
        u.queryItems = q.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        u.percentEncodedQuery = u.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let url = u.url else { return .errore("Indirizzo del Mac non valido.") }
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.setValue("Bearer \(c.token)", forHTTPHeaderField: "authorization")
        let (d, r) = try await sessione.data(for: req)
        guard let h = r as? HTTPURLResponse else { return .errore(nonRisponde) }
        if (200..<300).contains(h.statusCode) { return .dati(d) }
        if h.statusCode == 401 { return .errore("Il Mac non riconosce l'iPhone: ricollegalo dalla Bottega.") }
        struct E: Decodable { let errore: String }
        return .errore((try? JSONDecoder().decode(E.self, from: d))?.errore ?? "Il Mac ha risposto \(h.statusCode).")
    }
}

// MARK: - modelli (i campi di 9.6 che servono ai widget)

struct DatiGuadagni: Decodable {
    struct Cifre: Decodable {
        let totale: Double
        let admob: Double
        let store: Double
    }
    struct Punto: Decodable, Identifiable {
        /// YYYY-MM-DD
        let chiave: String
        let admob: Double
        /// nil: lo Store non ha ancora il report di quel giorno. Non e' zero.
        let store: Double?
        let nelPeriodo: Bool
        var id: String { chiave }
        var totale: Double { admob + (store ?? 0) }
    }
    struct App: Decodable, Identifiable {
        let chiave: String
        let nome: String
        let totale: Double
        var id: String { chiave }
    }
    struct Buco: Decodable, Identifiable {
        let id: String
        let app: String
        let gravita: String
        let titolo: String
        let cosa: String
        let stima: Double?
    }
    let aggiornatoAt: Double
    let periodo: Double
    let etichetta: String
    let cifre: Cifre
    let prima: Cifre?
    let grafico: [Punto]
    let storeFinoA: String?
    let storeIncompleto: Bool?
    let app: [App]
    let buchi: [Buco]
    let buchiTotali: Double
    let stimaTotale: Double

    var incompleto: Bool { storeIncompleto == true }

    /// Il confronto con il periodo prima. Con lo Store a meta' si confronta solo AdMob: mai uno zero falso.
    var confronto: (adesso: Double, prima: Double)? {
        guard let p = prima else { return nil }
        return incompleto ? (cifre.admob, p.admob) : (cifre.totale, p.totale)
    }
}

struct DatiSemaforo: Decodable {
    struct Conti: Decodable {
        let rosso: Double
        let giallo: Double
        let verde: Double
    }
    struct Regola: Decodable {
        let id: String
        let livello: String
        let frase: String
    }
    struct Progetto: Decodable {
        let nome: String
        let livello: String
        let regole: [Regola]
    }
    let aggiornatoAt: Double
    let conti: Conti
    let globali: [Regola]
    let progetti: [Progetto]

    /// Il primo rosso: una regola di tutti i progetti, oppure il primo progetto rosso.
    var primoRosso: (chi: String?, frase: String)? {
        if let g = globali.first(where: { $0.livello == "rosso" }) { return (nil, g.frase) }
        for p in progetti where p.livello == "rosso" {
            if let r = p.regole.first(where: { $0.livello == "rosso" }) ?? p.regole.first { return (p.nome, r.frase) }
        }
        return nil
    }
}

struct DatiServizi: Decodable {
    struct Servizio: Decodable, Identifiable {
        /// deepseek | openrouter | elevenlabs | agnes
        let id: String
        let nome: String
        /// ok | attesa | male
        let tono: String
        let frase: String?
        let valuta: String?
        let saldo: Double?
        let mediaGiorno: Double?
        let giorniRimasti: Double?
        let usati: Double?
        let limite: Double?
        let gratis: Bool?
    }
    struct Giorno: Decodable, Identifiable {
        let giorno: String
        let deepseek: Double?
        var id: String { giorno }
    }
    struct Spesa: Decodable {
        let valuta: String
        let giorni: [Giorno]
    }
    let aggiornatoAt: Double
    let servizi: [Servizio]
    let spesa: Spesa?
}

struct DatiConsigli: Decodable {
    struct Consiglio: Decodable, Identifiable {
        let id: String
        /// appstore | vedetta | lavori | dafare | home
        let fonte: String
        let etichetta: String
        let titolo: String
        let perche: String?
        let cosa: String?
        /// Euro al mese.
        let valore: Double?
        let soggetto: String?
        /// Una stanza (appstore, vedetta, dafare), oppure lavori o stanze.
        let apri: String
    }
    let aggiornatoAt: Double
    let consigli: [Consiglio]
}

// MARK: - formati

enum FormatiWidget {
    static let it = Locale(identifier: "it_IT")

    /// «8,40 €», «184 €», «1.240 €».
    static func euro(_ v: Double) -> String {
        v.formatted(.currency(code: "EUR").locale(it).precision(.fractionLength(abs(v) < 100 ? 2 : 0)))
    }

    /// «12,35 $» (il simbolo dopo, come nella barra di Melissa).
    static func soldi(_ v: Double, valuta: String) -> String {
        let n = v.formatted(.number.locale(it).precision(.fractionLength(abs(v) < 100 ? 2 : 0)))
        switch valuta.uppercased() {
        case "USD": return "\(n) $"
        case "EUR": return "\(n) €"
        default: return "\(n) \(valuta.uppercased())"
        }
    }

    /// «+12%», «-8%»; nil se prima non c'era niente.
    static func variazione(_ adesso: Double, _ prima: Double) -> Double? {
        guard prima > 0.009 else { return nil }
        return (adesso - prima) / prima
    }

    static func percento(_ v: Double) -> String {
        let n = Int((abs(v) * 100).rounded())
        return v >= 0 ? "+\(n)%" : "-\(n)%"
    }

    /// "2026-10-01" -> «1 ott».
    static func giornoBreve(_ chiave: String) -> String {
        let p = chiave.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3, let d = Calendar.current.date(from: DateComponents(year: p[0], month: p[1], day: p[2])) else { return chiave }
        return d.formatted(.dateTime.day().month(.abbreviated).locale(it))
    }
}

/// I colori dei guadagni, gli stessi della stanza App Store (ColoriSoldi nell'app, media/appstore.css sul Mac).
enum ColoriWidget {
    static let admob = Color(red: 0xc4 / 255, green: 0x82 / 255, blue: 0x1c / 255)
    static let store = Color(red: 0x66 / 255, green: 0x83 / 255, blue: 0xe6 / 255)
    static let cielo = Color(red: 0x8f / 255, green: 0xb4 / 255, blue: 0xe8 / 255)

    /// ok, attesa (ambra), male (rosso).
    static func tono(_ t: String) -> Color {
        switch t {
        case "male": Tinte.rosso
        case "attesa": Tinte.ambra
        default: Tinte.verde
        }
    }
}

// MARK: - pezzi comuni

/// La testata dei widget: la sferetta, il titolo, e a destra quello che serve.
struct TestataWidget<Destra: View>: View {
    let titolo: String
    var acceso = false
    @ViewBuilder var destra: Destra

    var body: some View {
        HStack(spacing: 6) {
            Sferetta(aspetta: acceso, lavora: true, diametro: 12)
            Text(titolo)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Tinte.tinta)
                .lineLimit(1)
            Spacer(minLength: 4)
            destra
        }
    }
}

extension TestataWidget where Destra == EmptyView {
    init(titolo: String, acceso: Bool = false) {
        self.init(titolo: titolo, acceso: acceso) { EmptyView() }
    }
}

/// Quando e' stato visto il dato: l'ora se e' fresco, «2 h fa» se e' l'ultima copia col Mac che non risponde.
struct EtaWidget: View {
    let visto: Date?
    let fonte: FonteWidget

    var body: some View {
        Group {
            if let v = visto {
                if fonte == .diretta {
                    Text("alle \(Text(v, style: .time))")
                } else {
                    Text("\(Image(systemName: "wifi.slash")) \(Pezzi.daQuanto(v)) fa")
                }
            }
        }
        .font(.caption2)
        .foregroundStyle(Tinte.tinta.opacity(0.85))
        .lineLimit(1)
    }
}

/// Senza dati: scollegato, Mac che non risponde senza copia, stanza non pronta. Una frase sola, mai un numero finto.
struct VuotoWidget: View {
    let fonte: FonteWidget
    let errore: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: fonte == .scollegato ? "laptopcomputer.slash" : "moon.zzz")
                .font(.title3)
                .foregroundStyle(Tinte.tinta)
            Text(fonte == .scollegato ? "Apri la Bottega e collega il Mac." : (errore ?? "Il Mac non risponde."))
                .font(.footnote.weight(.medium))
                .foregroundStyle(Tinte.testo)
                .lineLimit(4)
                .minimumScaleFactor(0.85)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

/// La freccia sul periodo prima: su in verde, giu' in rosso, con la percentuale.
struct FrecciaWidget: View {
    let adesso: Double
    let prima: Double

    var body: some View {
        if let v = FormatiWidget.variazione(adesso, prima) {
            let su = v >= 0
            HStack(spacing: 2) {
                Image(systemName: su ? "arrow.up.right" : "arrow.down.right")
                Text(FormatiWidget.percento(v))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: v))
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(su ? Tinte.verde : Tinte.rosso)
        }
    }
}

/// Lo sfondo dei widget della Home; trasparente sulla schermata di blocco.
extension View {
    func sfondoBottega(_ famiglia: WidgetFamily) -> some View {
        containerBackground(for: .widget) {
            switch famiglia {
            case .accessoryCircular, .accessoryRectangular, .accessoryInline: Color.clear
            default: Tinte.sfondo
            }
        }
    }
}
