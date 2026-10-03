//
//  ModelliAppStore.swift
//  Bottega per iPhone
//
//  La stanza App Store dal ponte (docs/CONTRATTI.md, 9.6 e 9.7): GET /v1/stanza?nome=appstore[&app=<chiave>] e la
//  risposta di POST /v1/stanza/azione. Tutto quello che il Mac ha aggiunto dopo la build 58 e' facoltativo: un Mac
//  con la Bottega vecchia risponde senza e la stanza si mostra lo stesso. Numeri in Double, tempi in ms dal 1970.
//  Solo Foundation: il programmino di prova lo compila con swiftc, senza simulatore.
//

import Foundation

struct StanzaAppStore: Decodable {
    struct Cifre: Decodable {
        let totale: Double
        let admob: Double
        let store: Double
        let download: Double
    }

    /// Lo stesso punto nel periodo prima (tanti giorni o mesi indietro quanti ne ha il grafico): per la tendenza.
    struct PuntoPrima: Decodable {
        let chiave: String
        let admob: Double
        let store: Double?
        let download: Double
    }

    struct Punto: Decodable, Identifiable {
        /// YYYY-MM-DD o YYYY-MM
        let chiave: String
        let admob: Double
        /// nil: lo Store non ha ancora (o non ha piu') il report di quel giorno o mese. Non e' zero.
        let store: Double?
        let download: Double
        let nelPeriodo: Bool
        let prima: PuntoPrima?
        var id: String { chiave }
    }

    /// Una versione uscita dentro il grafico (solo con un'app o un progetto scelti, come sul Mac).
    struct Versione: Decodable, Identifiable {
        let chiave: String
        let v: String
        let app: String
        var id: String { "\(app)-\(v)-\(chiave)" }
    }

    struct GiornoAbbonati: Decodable, Identifiable {
        let giorno: String
        let attivi: Double
        let prove: Double
        var id: String { giorno }
    }

    struct AbbonatiApp: Decodable, Identifiable {
        let chiave: String
        let nome: String
        let attivi: Double
        let prove: Double
        let mrr: Double
        var id: String { chiave }
    }

    struct Abbonamenti: Decodable {
        let finoA: String?
        let attivi: Double
        let prove: Double
        let mrr: Double
        let ritardo: Double
        let grazia: Double?
        let attiviPrima: Double?
        let mrrPrima: Double?
        let giorniPrima: Double?
        let eventi: [String: Double]?
        let eventiPrima: [String: Double]?
        let serie: [GiornoAbbonati]?
        let perApp: [AbbonatiApp]?
    }

    struct Fonte: Decodable, Identifiable {
        let fonte: String
        let imp: Double
        let vis: Double
        let dl: Double
        var id: String { fonte }
    }

    struct SchedaApp: Decodable, Identifiable {
        let chiave: String
        let nome: String
        let imp: Double
        let vis: Double
        let dl: Double
        var id: String { chiave }
    }

    /// La scheda dello Store: impressioni e visite (dispositivi unici), download nuovi, sulla finestra che finisce
    /// all'ultimo giorno con i dati di Apple.
    struct Scheda: Decodable {
        let finoA: String
        let giorni: Double
        let imp: Double
        let vis: Double
        let dl: Double
        let impPrima: Double
        let visPrima: Double
        let dlPrima: Double
        let haPrima: Bool
        let fonti: [Fonte]
        let perApp: [SchedaApp]?
    }

    struct App: Decodable, Identifiable, Hashable {
        let chiave: String
        let nome: String
        let piattaforma: String?
        let path: String?
        let progetto: String?
        let totale: Double
        let admob: Double
        let store: Double
        let download: Double
        let totalePrima: Double?
        let buchi: Double?
        let subito: Double?
        let abbonati: Double?
        let andamento: [Double]?
        var id: String { chiave }

        static func == (a: App, b: App) -> Bool { a.chiave == b.chiave }
        func hash(into h: inout Hasher) { h.combine(chiave) }
    }

    struct Verifica: Decodable {
        let versione: String
        let giorno: String
        let prima: Double
        let dopo: Double
        let giorniDopo: Double
        /// risolto | meglio | uguale | presto
        let esito: String
    }

    struct Buco: Decodable, Identifiable {
        let id: String
        let chiave: String?
        let app: String
        /// alta | media | bassa
        let gravita: String
        let titolo: String
        let perche: String?
        let cosa: String
        let stima: Double?
        let stimaNota: String?
        let path: String?
        let progetto: String?
        let daQuando: Double?
        let tipo: String?
        let fonte: String?
        let soglia: Double?
        let verifica: Verifica?
        /// Il compito per «Fallo sistemare a Claude»; c'e' solo se l'app ha un progetto sul Mac.
        let compito: String?
    }

    /// Un buco risolto (negli ultimi 60 giorni) o ignorato (con il motivo).
    struct Chiuso: Decodable, Identifiable {
        let id: String
        let chiave: String?
        let app: String
        let titolo: String
        let quando: Double
        let daQuando: Double?
        let prima: Double?
        let dopo: Double?
        let motivo: String?
    }

    struct Allarme: Decodable, Identifiable {
        let app: String
        let chiave: String?
        let testo: String
        let at: Double
        var id: String { "\(at)-\(app)" }
    }

    struct Paese: Decodable, Identifiable {
        let codice: String
        let euro: Double
        let impressioni: Double
        var id: String { codice }
    }

    struct Formato: Decodable, Identifiable {
        let formato: String
        let richieste: Double
        let abbinate: Double
        let impressioni: Double
        let clic: Double
        let euro: Double
        var id: String { formato }
    }

    struct Unita: Decodable, Identifiable {
        let nome: String
        let formato: String
        let richieste: Double
        let impressioni: Double
        let euro: Double
        var id: String { "\(nome)-\(formato)" }
    }

    struct Acquisti: Decodable {
        let nuovi: Double
        let rinnovi: Double
        let altri: Double
        let euro: Double
    }

    struct Uscita: Decodable, Identifiable {
        let v: String
        let quando: String
        var id: String { "\(v)-\(quando)" }
    }

    /// Cosa c'e' nel codice del progetto collegato (letto dal Mac ogni 6 ore).
    struct Codice: Decodable {
        let letteAt: Double?
        let file: Double?
        let sdk: Bool
        let ump: Bool
        let att: Bool
        let attRichiesta: Bool?
        let skan: Double
        let storekit: Bool
        let revenuecat: Bool
        let formati: [String]
        let idProva: Double?
    }

    /// La scheda di un'app (solo con `app=<chiave>`): annunci per formato e per unita', acquisti, versioni, codice.
    struct Dettaglio: Decodable {
        let chiave: String
        let nome: String
        let piattaforma: String?
        let progetto: String?
        let path: String?
        let bundleId: String?
        let approvazione: String?
        let collegata: Bool?
        let suAdmob: Bool?
        let formati: [Formato]
        let unita: [Unita]
        let acquisti: Acquisti?
        let versioni: [Uscita]
        let versioniMesi: [Uscita]?
        let codice: Codice?
    }

    struct Errori: Decodable {
        let store: String?
        let admob: String?
    }

    let aggiornatoAt: Double
    let aggiornando: Bool?
    let fase: String?
    let controlloOre: Double?
    let periodo: Double
    let mese: String?
    let quale: String
    let etichetta: String
    let cifre: Cifre
    let prima: Cifre?
    let grafico: [Punto]
    let versioni: [Versione]?
    let storeFinoA: String?
    let storeIncompleto: Bool?
    let abbonamenti: Abbonamenti?
    let scheda: Scheda?
    let app: [App]
    let buchi: [Buco]
    let buchiTotali: Double
    let stimaTotale: Double
    let risolti: [Chiuso]?
    let ignorati: [Chiuso]?
    let allarmi: [Allarme]?
    let paesi: [Paese]?
    let dettaglio: Dettaglio?
    let errori: Errori?
}

/// La risposta di POST /v1/stanza/azione: la frase da mostrare cosi' com'e'.
struct EsitoAzioneAppStore: Decodable {
    let ok: Bool
    let azione: String?
    let messaggio: String
    let lavoro: String?
    let stato: String?
    let progetto: String?
}
