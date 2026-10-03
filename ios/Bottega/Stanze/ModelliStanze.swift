//
//  ModelliStanze.swift
//  Bottega per iPhone
//
//  Le risposte di GET /v1/stanza (docs/CONTRATTI.md, 9.6). Tutti i numeri sono Double (i minuti del cruscotto
//  possono avere i decimali) e quasi tutto e' facoltativo: un campo nuovo o mancante sul Mac non rompe la stanza.
//  Tempi in millisecondi dal 1970.
//

import Foundation

// App Store: in Stanze/AppStore/ModelliAppStore.swift (la stanza ha anche le azioni, CONTRATTI 9.7).

// MARK: - cruscotto

struct StanzaCruscotto: Decodable {
    struct Cifre: Decodable {
        let tu: Double
        let claude: Double
        let sessioni: Double
        let token: Double
        let valore: Double
        let giorniAttivi: Double?
    }
    struct Prima: Decodable {
        let tu: Double
        let claude: Double
        let token: Double
        let valore: Double
    }
    struct Oggi: Decodable {
        let tu: Double
        let claude: Double?
        let sessioni: Double?
        let token: Double?
    }
    struct Settimana: Decodable {
        let tu: Double
        let claude: Double
        let primaFinOra: Double
        let inizio: String
    }
    struct Punto: Decodable, Identifiable {
        let giorno: String
        let tu: Double
        let claude: Double?
        var id: String { giorno }
    }
    struct Progetto: Decodable, Identifiable {
        let nome: String
        let path: String?
        let tu: Double
        let claude: Double
        let sessioni: Double
        let token: Double
        let valore: Double
        let vive: Double
        let ultimo: Double?
        var id: String { path ?? nome }
    }
    struct Nome: Decodable {
        let nome: String
        let path: String
    }
    let aggiornatoAt: Double
    let periodo: Double
    let progetto: Nome?
    let cifre: Cifre
    let prima: Prima?
    let oggi: Oggi
    let settimana: Settimana?
    let grafico: [Punto]
    let progetti: [Progetto]
    let vive: Double
    let anno: String?
}

// MARK: - Vedetta

struct StanzaVedetta: Decodable {
    struct Conti: Decodable {
        let rosso: Double
        let giallo: Double
        let verde: Double
    }
    struct Regola: Decodable, Identifiable {
        let id: String
        let livello: String
        let frase: String
        let rimedio: String
    }
    struct Progetto: Decodable, Identifiable {
        let path: String
        let nome: String
        let livello: String
        let regole: [Regola]
        let altre: Double?
        var id: String { path }
    }
    struct Sito: Decodable, Identifiable {
        let nome: String
        let path: String?
        let progetto: String?
        let stato: String
        let etichetta: String
        /// ok | attesa | male
        let tono: String
        let at: Double
        let dominio: String?
        let errore: String?
        let onlineDal: Double?
        var id: String { "\(nome)-\(path ?? "")" }
    }
    struct ContiSiti: Decodable {
        let male: Double
        let attesa: Double
        let ok: Double
    }
    struct Siti: Decodable {
        let aggiornatoAt: Double
        let errore: String?
        let conti: ContiSiti
        let elenco: [Sito]
    }
    let aggiornatoAt: Double
    let conti: Conti
    let globali: [Regola]
    let progetti: [Progetto]
    let progettiTotali: Double?
    let siti: Siti?
}

// MARK: - cose da fare

struct StanzaDaFare: Decodable {
    struct Progetto: Decodable, Identifiable {
        let nome: String
        let path: String?
        let at: Double
        let cose: [String]
        let altre: Double?
        var id: String { nome }
    }
    let aggiornatoAt: Double
    let progetti: [Progetto]
    let riassunti: Double?
}

// MARK: - posta e WhatsApp

struct StanzaPosta: Decodable {
    struct Fonte: Decodable {
        let aggiornatoAt: Double
        let errore: String?
    }
    struct Conti: Decodable {
        let nonLetti: Double
        let chatDaRispondere: Double
        let mailDaAssegnare: Double
        let chatDaAssegnare: Double
    }
    struct Mail: Decodable, Identifiable {
        let da: String
        let oggetto: String
        let at: Double
        let nonLetto: Bool
        var id: String { "\(at)-\(da)-\(oggetto.prefix(20))" }
    }
    struct Chat: Decodable, Identifiable {
        let contatto: String
        let gruppo: Bool
        let at: Double
        let mio: Bool
        let anteprima: String?
        var id: String { "\(at)-\(contatto)" }
    }
    struct Progetto: Decodable, Identifiable {
        let nome: String
        let path: String
        let nonLetti: Double
        let chatDaRispondere: Double
        let mail: [Mail]
        let mailTotali: Double?
        let chat: [Chat]
        let chatTotali: Double?
        var id: String { path }
    }
    let aggiornatoAt: Double
    let giorni: Double
    let posta: Fonte?
    let whatsapp: Fonte?
    let conti: Conti
    let progetti: [Progetto]
}

// MARK: - clienti

struct StanzaClienti: Decodable {
    struct ProgettoOre: Decodable, Identifiable {
        let nome: String
        let path: String?
        let minuti: Double
        var id: String { path ?? nome }
    }
    struct Cliente: Decodable, Identifiable {
        let id: String
        let nome: String
        let minuti: Double
        let importo: Double?
        let tariffa: Double?
        let giorni: Double
        let progetti: [ProgettoOre]
    }
    struct Totale: Decodable {
        let minuti: Double
        let importo: Double?
    }
    let mese: String
    let mesi: [String]
    let inCorso: Bool
    let arrotondamento: Double?
    let configurati: Double
    let clienti: [Cliente]
    let fuori: [ProgettoOre]
    let totale: Totale
}

// MARK: - notte

struct StanzaNotte: Decodable {
    struct Finestra: Decodable {
        let da: String
        let a: String
    }
    struct InFila: Decodable, Identifiable {
        let progetto: String
        let path: String?
        let titolo: String
        let stato: String
        let chiave: String
        var id: String { chiave }
    }
    struct Fatto: Decodable, Identifiable {
        let progetto: String
        let compito: String
        let stato: String
        let riassunto: String?
        var id: String { "\(progetto)-\(compito.prefix(30))" }
    }
    struct Resoconto: Decodable {
        let giorno: String
        let lavori: [Fatto]
    }
    let finestra: Finestra
    let insieme: Double
    let inFila: Double
    let inCorso: Double
    let corrente: Bool?
    let perche: String
    let fila: [InFila]
    let resoconto: Resoconto?
}
