//
//  ChatPura.swift
//  Bottega per iPhone
//
//  La logica della chat di Moony che non tocca ne' schermo ne' rete (16/10/2026): il catalogo dei modelli, le chat
//  e le loro schede, i tagli del testo verso il ponte, il markdown in blocchi, lo zip dei docx e odt. Solo Foundation e
//  Compression, cosi' scripts/test-ios-chat.sh la prova su macOS senza simulatore (ios/Tests/ChatTests.swift).
//

import Compression
import Foundation

// MARK: - i modelli

/// Un modello della chat scritta (lo stesso catalogo di Moony AI sul Mac, stessi nomi e stesso ordine). La voce non
/// segue la scelta: parla sempre DeepSeek Flash.
struct ModelloChat: Identifiable, Equatable {
    enum Fornitore: String, CaseIterable {
        case deepseek, agnes, mistral
        var nome: String {
            switch self {
            case .deepseek: "DeepSeek"
            case .agnes: "Agnes"
            case .mistral: "Mistral"
            }
        }
        var url: String {
            switch self {
            case .deepseek: "https://api.deepseek.com/chat/completions"
            // solo i modelli del piano free, circa 20 richieste al minuto per tutto l'account
            case .agnes: "https://apihub.agnes-ai.com/v1/chat/completions"
            // l'endpoint europeo
            case .mistral: "https://api.mistral.ai/v1/chat/completions"
            }
        }
        /// Mistral rifiuta i campi che non conosce: niente `reasoning_effort`. Agnes parla come DeepSeek.
        var ragiona: Bool { self != .mistral }
    }

    let id: String
    let nome: String
    let fornitore: Fornitore
    /// Il nome del modello sul filo.
    let modello: String
    let simbolo: String
    let dettaglio: String
    /// Vision: le immagini allegate vanno al modello, che le guarda.
    var vede: Bool { id == "vision" }

    static let catalogo: [ModelloChat] = [
        ModelloChat(id: "flash", nome: "Flash", fornitore: .deepseek, modello: "deepseek-flash", simbolo: "bolt.fill",
                    dettaglio: "DeepSeek V4.1 Flash: risponde in 3-4 secondi e costa pochissimo"),
        ModelloChat(id: "pro", nome: "Pro", fornitore: .deepseek, modello: "deepseek-v4-pro", simbolo: "brain.head.profile",
                    dettaglio: "DeepSeek V4 Pro: più preciso, più lento, costa circa 4 volte Flash"),
        ModelloChat(id: "vision", nome: "Vision", fornitore: .deepseek, modello: "deepseek-flash", simbolo: "eye.fill",
                    dettaglio: "Flash che guarda: le immagini allegate le vede e risponde lei"),
        ModelloChat(id: "agnes-3.0-flash", nome: "Agnes 3.0 Flash", fornitore: .agnes, modello: "agnes-3.0-flash",
                    simbolo: "sparkles", dettaglio: "gratis, piano free: più lento di DeepSeek, circa 20 richieste al minuto"),
        ModelloChat(id: "agnes-2.5-flash", nome: "Agnes 2.5 Flash", fornitore: .agnes, modello: "agnes-2.5-flash",
                    simbolo: "sparkles", dettaglio: "gratis, la generazione precedente di Agnes"),
        ModelloChat(id: "mistral-small", nome: "Mistral Small", fornitore: .mistral, modello: "mistral-small-latest",
                    simbolo: "wind", dettaglio: "veloce ed economico, dati in Europa"),
        ModelloChat(id: "mistral-medium", nome: "Mistral Medium", fornitore: .mistral, modello: "mistral-medium-latest",
                    simbolo: "wind", dettaglio: "più capace di Small, costa di più"),
        ModelloChat(id: "mistral-large", nome: "Mistral Large", fornitore: .mistral, modello: "mistral-large-latest",
                    simbolo: "wind", dettaglio: "il più capace di Mistral, il più caro"),
        ModelloChat(id: "codestral", nome: "Codestral", fornitore: .mistral, modello: "codestral-latest",
                    simbolo: "chevron.left.forwardslash.chevron.right", dettaglio: "Mistral per il codice"),
    ]

    /// Il modello con questo id; uno sconosciuto (una scelta salvata da una versione diversa) vale Flash.
    static func con(_ id: String) -> ModelloChat { catalogo.first { $0.id == id } ?? catalogo[0] }

    /// Chi risponde davvero: la voce sempre Flash, con un'immagine allegata Vision, altrimenti la scelta.
    static func risponde(scelto: ModelloChat, voce: Bool, immagini: Bool) -> ModelloChat {
        let m = voce ? con("flash") : scelto
        return m.vede || immagini ? con("vision") : m
    }
}

// MARK: - le chat e le schede

/// Una chat della barra delle schede: i suoi turni hanno `chat` uguale al suo id.
struct ChatMoony: Codable, Identifiable, Equatable {
    let id: UUID
    /// La prima domanda scritta o detta, accorciata; vuoto finche' non c'e'.
    var titolo: String
    /// Quando e' nata, in millisecondi: le righe che arrivano solo dal Mac vanno nella chat nata per ultima prima di loro.
    let inizio: Double
    /// L'ultimo turno, per ordinare i recenti.
    var ultima: Double

    var nomeScheda: String { titolo.isEmpty ? "Nuova chat" : titolo }
}

/// Le chat dell'iPhone, le schede aperte (al piu' `massimo`) e quella attiva. `vuota(id)` dice se una chat non ha turni:
/// i turni stanno in AssistenteTelefono, qui solo l'ordine.
struct SchedeChat: Codable, Equatable {
    var chat: [ChatMoony]
    var schede: [UUID]
    var attiva: UUID

    static let massimo = 8

    /// Una chat sola, aperta. `inizio`: da quando valgono le righe del Mac (la chat di prima delle schede).
    static func iniziale(inizio: Double, adesso: Double) -> SchedeChat {
        let c = ChatMoony(id: UUID(), titolo: "", inizio: inizio, ultima: adesso)
        return SchedeChat(chat: [c], schede: [c.id], attiva: c.id)
    }

    var chatAttiva: ChatMoony? { chat.first { $0.id == attiva } }

    /// Dopo la lettura dal disco: niente schede di chat che non ci sono piu', e l'attiva sempre fra le schede. Falso
    /// se l'attiva non esiste: allora si riparte da capo.
    mutating func normalizza() -> Bool {
        guard chat.contains(where: { $0.id == attiva }) else { return false }
        schede = schede.filter { id in chat.contains { $0.id == id } }
        if !schede.contains(attiva) { schede.append(attiva) }
        return true
    }

    /// «+»: una chat nuova in una scheda nuova. Se quella aperta e' ancora vuota e sta in una scheda, si resta li'.
    mutating func nuova(adesso: Double, vuota: (UUID) -> Bool) {
        if let c = chatAttiva, c.titolo.isEmpty, vuota(c.id), schede.contains(c.id) { return }
        let n = ChatMoony(id: UUID(), titolo: "", inizio: adesso, ultima: adesso)
        chat.insert(n, at: 0)
        // le chat nuove mai usate e senza scheda non servono piu'
        chat.removeAll { c in c.id != n.id && c.titolo.isEmpty && !schede.contains(c.id) && vuota(c.id) }
        apri(n.id)
    }

    /// Apre una chat: nella sua scheda se c'e', altrimenti in una nuova in fondo. Oltre `massimo` si chiude la piu'
    /// vecchia che non e' quella che si apre.
    mutating func apri(_ id: UUID) {
        guard chat.contains(where: { $0.id == id }) else { return }
        if !schede.contains(id) {
            schede.append(id)
            while schede.count > Self.massimo, let vecchia = schede.first(where: { $0 != id }) {
                schede.removeAll { $0 == vecchia }
            }
        }
        attiva = id
    }

    /// «x»: chiude la scheda, la chat resta. Chiusa quella attiva si passa alla vicina; chiusa l'ultima se ne apre una
    /// nuova vuota, cosi' c'e' sempre almeno una scheda.
    mutating func chiudi(_ id: UUID, adesso: Double, vuota: (UUID) -> Bool) {
        guard let i = schede.firstIndex(of: id) else { return }
        schede.remove(at: i)
        guard attiva == id else { return }
        if schede.isEmpty {
            nuova(adesso: adesso, vuota: vuota)
        } else {
            attiva = schede[max(0, i - 1)]
        }
    }

    /// Toglie una chat dai recenti (i turni li toglie chi chiama).
    mutating func togli(_ id: UUID, adesso: Double, vuota: (UUID) -> Bool) {
        let aperta = schede.contains(id)
        chat.removeAll { $0.id == id }
        if aperta { chiudi(id, adesso: adesso, vuota: vuota) }
        if chat.isEmpty || chatAttiva == nil { self = Self.iniziale(inizio: adesso, adesso: adesso) }
    }

    /// Un turno nuovo nella chat `id`: l'ora dell'ultimo turno e, alla prima domanda, il titolo.
    mutating func registra(in id: UUID, chi: String, testo: String, adesso: Double) {
        guard let i = chat.firstIndex(where: { $0.id == id }) else { return }
        chat[i].ultima = adesso
        if chat[i].titolo.isEmpty, chi == "tu" { chat[i].titolo = TestoChat.titolo(testo) }
    }

    /// La chat a cui va una riga arrivata solo dal Mac: quella nata per ultima prima della riga.
    func chat(perRigaDelle alle: Double) -> UUID? {
        chat.filter { $0.inizio <= alle }.max { $0.inizio < $1.inizio }?.id
    }
}

// MARK: - il testo

enum TestoChat {
    /// I primi `massimo` caratteri contati come li conta il ponte (JavaScript, `length`: unita' UTF-16, un'emoji ne vale
    /// due), senza spezzare un carattere a meta'.
    static func taglia(_ testo: String, massimo: Int = 2000) -> String {
        guard testo.utf16.count > massimo else { return testo }
        var n = 0
        var fine = testo.startIndex
        for c in testo {
            n += c.utf16.count
            if n > massimo { break }
            fine = testo.index(after: fine)
        }
        return String(testo[..<fine])
    }

    /// Il titolo di una chat: la prima riga, al piu' 48 caratteri.
    static func titolo(_ testo: String) -> String {
        let riga = testo.split(whereSeparator: \.isNewline).first.map(String.init) ?? testo
        return riga.count > 48 ? String(riga.prefix(47)) + "…" : riga
    }

    static let prefissoAllegato = "[Allegato: "

    /// Il nome dell'allegato se `testo` e' un turno-allegato (`[Allegato: nome · tipo]`), altrimenti nil.
    static func nomeAllegato(in testo: String) -> String? {
        guard testo.hasPrefix(prefissoAllegato) else { return nil }
        let prima = testo.prefix { $0 != "\n" }
        guard prima.hasSuffix("]") else { return nil }
        let dentro = prima.dropFirst(prefissoAllegato.count).dropLast()
        guard let r = dentro.range(of: " · ", options: .backwards) else { return String(dentro) }
        return String(dentro[..<r.lowerBound])
    }

    /// Il testo di un XML di Word o di LibreOffice: i paragrafi vanno a capo, i tag spariscono.
    static func testoDaXML(_ xml: String) -> String {
        var s = xml.replacingOccurrences(of: "</w:p>", with: "\n").replacingOccurrences(of: "</text:p>", with: "\n")
            .replacingOccurrences(of: "</text:h>", with: "\n").replacingOccurrences(of: "<w:tab/>", with: "\t")
        s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        for (a, b) in [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&apos;", "'"), ("&amp;", "&")] {
            s = s.replacingOccurrences(of: a, with: b)
        }
        return s
    }

    // MARK: markdown

    enum Blocco: Equatable {
        case paragrafo(String)
        case titolo(String, livello: Int)
        case codice(String)
    }

    /// Markdown come lo scrive un modello: paragrafi, titoli con #, elenchi con - * + (diventano •), codice fra ```.
    /// Lo stesso di MoonyMarkdownText sul Mac.
    static func blocchi(_ testo: String) -> [Blocco] {
        var out: [Blocco] = []
        var paragrafo: [String] = []
        var codice: [String]?

        func chiudi() {
            let p = paragrafo.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !p.trimmingCharacters(in: .whitespaces).isEmpty { out.append(.paragrafo(p)) }
            paragrafo.removeAll()
        }

        for riga in testo.components(separatedBy: "\n") {
            let pulita = riga.trimmingCharacters(in: .whitespaces)
            if pulita.hasPrefix("```") {
                if let aperto = codice {
                    out.append(.codice(aperto.joined(separator: "\n")))
                    codice = nil
                } else {
                    chiudi()
                    codice = []
                }
                continue
            }
            if codice != nil { codice?.append(riga); continue }
            if pulita.isEmpty { chiudi(); continue }
            if pulita.hasPrefix("#") {
                let livello = pulita.prefix { $0 == "#" }.count
                let resto = pulita.dropFirst(livello)
                if livello <= 6, resto.hasPrefix(" ") {
                    chiudi()
                    out.append(.titolo(resto.trimmingCharacters(in: .whitespaces), livello: livello))
                    continue
                }
            }
            let rientro = riga.prefix { $0 == " " || $0 == "\t" }
            if let primo = pulita.first, "-*+".contains(primo), pulita.dropFirst().hasPrefix(" ") {
                paragrafo.append(String(rientro) + "• " + pulita.dropFirst(2))
                continue
            }
            paragrafo.append(riga)
        }
        if let aperto = codice { out.append(.codice(aperto.joined(separator: "\n"))) }
        chiudi()
        return out
    }
}

// MARK: - lo zip

/// Il minimo per leggere un file da uno zip (docx, odt): la directory centrale, poi il file, salvato o compresso
/// con deflate. Niente zip64 ne' cifratura: un documento d'ufficio normale non li usa.
enum Zip {
    static func leggi(_ percorso: String, in data: Data) -> Data? {
        let b = [UInt8](data)
        func u16(_ i: Int) -> Int { i >= 0 && i + 1 < b.count ? Int(b[i]) | Int(b[i + 1]) << 8 : 0 }
        func u32(_ i: Int) -> Int { u16(i) | u16(i + 2) << 16 }
        // la fine della directory centrale, cercata dal fondo
        guard b.count > 22, let fine = stride(from: b.count - 22, through: max(0, b.count - 65_557), by: -1)
            .first(where: { u32($0) == 0x0605_4b50 }) else { return nil }
        var i = u32(fine + 16)
        for _ in 0..<u16(fine + 10) {
            guard i + 46 <= b.count, u32(i) == 0x0201_4b50 else { return nil }
            let metodo = u16(i + 10), compresso = u32(i + 20), intero = u32(i + 24)
            let lNome = u16(i + 28), lExtra = u16(i + 30), lNota = u16(i + 32), locale = u32(i + 42)
            guard i + 46 + lNome <= b.count else { return nil }
            let nome = String(decoding: b[(i + 46)..<(i + 46 + lNome)], as: UTF8.self)
            i += 46 + lNome + lExtra + lNota
            guard nome == percorso, locale + 30 <= b.count, u32(locale) == 0x0403_4b50 else { continue }
            let inizio = locale + 30 + u16(locale + 26) + u16(locale + 28)
            guard inizio + compresso <= b.count, intero < 64 * 1024 * 1024 else { return nil }
            let pezzo = Array(b[inizio..<(inizio + compresso)])
            if metodo == 0 { return Data(pezzo) }
            guard metodo == 8, intero > 0 else { return nil }
            var out = [UInt8](repeating: 0, count: intero)
            // COMPRESSION_ZLIB di Apple e' deflate grezzo, proprio quello degli zip
            let n = compression_decode_buffer(&out, intero, pezzo, pezzo.count, nil, COMPRESSION_ZLIB)
            return n == intero ? Data(out) : nil
        }
        return nil
    }
}
