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

/// Un modello della chat scritta: lo stesso catalogo di Moony AI per Mac (ChatModelStore.catalog), stessi id, stessi
/// nomi, stessi testi e stesso ordine (Andrea, 16/10/2026: «tutti come sul Mac, deve essere tutto uguale»). La voce non
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
            // il piano free: circa 20 richieste al minuto per tutto l'account
            case .agnes: "https://apihub.agnes-ai.com/v1/chat/completions"
            // l'endpoint europeo
            case .mistral: "https://api.mistral.ai/v1/chat/completions"
            }
        }
        /// Mistral rifiuta i campi che non conosce: niente `reasoning_effort` ne' `stream_options` (i token li manda
        /// comunque nell'ultimo pezzo). Agnes parla come DeepSeek.
        var ragiona: Bool { self != .mistral }

        /// Il fornitore di un modello, dal nome (ConsumiAI.fornitore sul Mac).
        static func di(modello: String) -> Fornitore {
            let m = modello.lowercased()
            if m.hasPrefix("agnes") { return .agnes }
            if m.hasPrefix("mistral") || m.hasPrefix("codestral") || m.hasPrefix("ministral") || m.hasPrefix("magistral")
                || m.hasPrefix("zai-") { return .mistral }
            return .deepseek
        }
    }

    let id: String
    let fornitore: Fornitore
    /// Il nome del modello sul filo.
    let modello: String
    let nome: String
    let dettaglio: String
    let simbolo: String
    /// Modo Vision: con immagini allegate risponde la visione di questo fornitore guardandole (senza strumenti);
    /// senza immagini e' una chat normale con lo stesso modello.
    var vede = false

    static let catalogo: [ModelloChat] = [
        // DeepSeek
        ModelloChat(id: "deepseek-flash", fornitore: .deepseek, modello: "deepseek-flash", nome: "Flash",
                    dettaglio: "DeepSeek V4.1 Flash: risponde in 3-4 secondi e costa pochissimo", simbolo: "bolt.fill"),
        ModelloChat(id: "deepseek-v4-pro", fornitore: .deepseek, modello: "deepseek-v4-pro", nome: "Pro",
                    dettaglio: "DeepSeek V4 Pro: più preciso, più lento, costa circa 4 volte Flash", simbolo: "brain.head.profile"),
        ModelloChat(id: "vision", fornitore: .deepseek, modello: "deepseek-flash", nome: "Vision",
                    dettaglio: "Flash che guarda: le immagini allegate le vede e risponde lei, senza strumenti", simbolo: "eye.fill",
                    vede: true),
        // Agnes
        ModelloChat(id: "agnes-3.0-flash", fornitore: .agnes, modello: "agnes-3.0-flash", nome: "Agnes 3.0 Flash",
                    dettaglio: "gratis, piano free: più lento di DeepSeek, circa 20 richieste al minuto", simbolo: "sparkles"),
        ModelloChat(id: "agnes-3.0-pro", fornitore: .agnes, modello: "agnes-3.0-pro", nome: "Agnes 3.0 Pro",
                    dettaglio: "a pagamento: risponde solo se il conto Agnes ha credito", simbolo: "sparkles"),
        ModelloChat(id: "agnes-vision", fornitore: .agnes, modello: "agnes-3.0-flash", nome: "Agnes Vision",
                    dettaglio: "Agnes 3.0 Flash che guarda le immagini allegate, gratis, senza strumenti", simbolo: "eye",
                    vede: true),
        ModelloChat(id: "agnes-2.5-flash", fornitore: .agnes, modello: "agnes-2.5-flash", nome: "Agnes 2.5 Flash",
                    dettaglio: "gratis, la generazione precedente", simbolo: "sparkles"),
        ModelloChat(id: "agnes-2.5-pro-beta", fornitore: .agnes, modello: "agnes-2.5-pro-beta", nome: "Agnes 2.5 Pro beta",
                    dettaglio: "a pagamento, versione di prova", simbolo: "sparkles"),
        ModelloChat(id: "agnes-2.5-pro-alpha", fornitore: .agnes, modello: "agnes-2.5-pro-alpha", nome: "Agnes 2.5 Pro alpha",
                    dettaglio: "a pagamento, versione di prova", simbolo: "sparkles"),
        // Mistral
        ModelloChat(id: "mistral-small-latest", fornitore: .mistral, modello: "mistral-small-latest", nome: "Mistral Small",
                    dettaglio: "Small 4: veloce ed economico, dati in Europa", simbolo: "wind"),
        ModelloChat(id: "mistral-medium-latest", fornitore: .mistral, modello: "mistral-medium-latest", nome: "Mistral Medium",
                    dettaglio: "Medium 3.5: il più caro di Mistral, circa 10 volte Small", simbolo: "wind"),
        ModelloChat(id: "mistral-large-latest", fornitore: .mistral, modello: "mistral-large-latest", nome: "Mistral Large",
                    dettaglio: "Large 3: molto capace e costa meno di Medium", simbolo: "wind"),
        ModelloChat(id: "mistral-vision", fornitore: .mistral, modello: "mistral-small-latest", nome: "Mistral Vision",
                    dettaglio: "Mistral Small che guarda le immagini allegate, senza strumenti", simbolo: "eye",
                    vede: true),
        ModelloChat(id: "codestral-latest", fornitore: .mistral, modello: "codestral-latest", nome: "Codestral",
                    dettaglio: "Mistral per il codice", simbolo: "chevron.left.forwardslash.chevron.right"),
        ModelloChat(id: "ministral-14b-latest", fornitore: .mistral, modello: "ministral-14b-latest", nome: "Ministral 14B",
                    dettaglio: "piccolo e molto economico", simbolo: "wind"),
        ModelloChat(id: "ministral-8b-latest", fornitore: .mistral, modello: "ministral-8b-latest", nome: "Ministral 8B",
                    dettaglio: "più piccolo, quasi gratis", simbolo: "wind"),
        ModelloChat(id: "ministral-3b-latest", fornitore: .mistral, modello: "ministral-3b-latest", nome: "Ministral 3B",
                    dettaglio: "il più piccolo, per cose semplici", simbolo: "wind"),
        ModelloChat(id: "zai-glm-latest", fornitore: .mistral, modello: "zai-glm-latest", nome: "GLM (Z.ai)",
                    dettaglio: "modello di Z.ai servito da Mistral; costo stimato come Medium", simbolo: "wind"),
    ]

    static let predefinito = "deepseek-flash"

    /// Gli id delle build 173-178, prima di prendere quelli del Mac.
    static let vecchiID = ["flash": "deepseek-flash", "pro": "deepseek-v4-pro", "mistral-small": "mistral-small-latest",
                           "mistral-medium": "mistral-medium-latest", "mistral-large": "mistral-large-latest",
                           "codestral": "codestral-latest"]

    /// Il modello con questo id (anche uno delle build di prima); uno sconosciuto vale Flash.
    static func con(_ id: String) -> ModelloChat {
        let vero = vecchiID[id] ?? id
        return catalogo.first { $0.id == vero } ?? catalogo[0]
    }

    /// Chi risponde davvero: la voce sempre Flash; con le immagini mandate al modello la Vision scelta (o quella di
    /// DeepSeek se la scelta non guarda: le immagini, allora, le ha gia' descritte la visione); altrimenti la scelta.
    static func risponde(scelto: ModelloChat, voce: Bool, immagini: Bool) -> ModelloChat {
        if voce { return con(predefinito) }
        if immagini, !scelto.vede { return con("vision") }
        return scelto
    }
}

// MARK: - i consumi

/// Una chiamata a un modello fatta da questo iPhone, per i consumi (il registro delle chiamate di Avo sul Mac).
struct ChiamataAI: Codable, Equatable {
    /// In secondi dal 1970.
    let at: Double
    let modello: String
    let input: Int
    let output: Int
}

/// Quanto consuma ogni fornitore, per la barra della chat: ConsumiAI di Moony AI per Mac, stesse regole e stesse
/// etichette. Solo le chiamate di questo iPhone: Agnes e Mistral non dicono quante ne fanno gli altri.
enum ConsumiAI {
    /// Il budget del workspace Mistral (10 euro al mese, condiviso con Nora).
    static let budgetMistralEUR = 10.0
    static let sogliaAvvisoMistral = 0.8
    /// Il tetto del piano free di Agnes, per tutto l'account; giallo da 16.
    static let tettoAgnesAlMinuto = 20
    static let avvisoAgnesAlMinuto = 16
    static let usdToEur = 0.92

    /// Tariffe Mistral in USD per milione di token (ingresso, uscita), verificate il 16/10/2026. Uno sconosciuto vale
    /// come Medium, il piu' caro.
    static func tariffaMistral(_ modello: String) -> (input: Double, output: Double) {
        let m = modello.lowercased()
        if m.hasPrefix("mistral-small") { return (0.15, 0.60) }
        if m.hasPrefix("mistral-large") { return (0.50, 1.50) }
        if m.hasPrefix("codestral") { return (0.30, 0.90) }
        if m.hasPrefix("ministral-3b") { return (0.10, 0.10) }
        if m.hasPrefix("ministral-8b") { return (0.15, 0.15) }
        if m.hasPrefix("ministral-14b") { return (0.20, 0.20) }
        return (1.50, 7.50)
    }

    static func costoMistralUSD(modello: String, input: Int, output: Int) -> Double {
        let t = tariffaMistral(modello)
        return (Double(input) * t.input + Double(output) * t.output) / 1_000_000
    }

    struct Consumo: Equatable {
        var chiamateOggi = 0
        var tokenOggi = 0
        var chiamateUltimoMinuto = 0
        var spesaOggiUSD = 0.0
        var spesaMeseUSD = 0.0
    }

    static func consumo(_ f: ModelloChat.Fornitore, chiamate: [ChiamataAI], adesso: Date = Date(),
                        calendario: Calendar = .current) -> Consumo {
        let oggi = calendario.startOfDay(for: adesso).timeIntervalSince1970
        let mese = (calendario.dateInterval(of: .month, for: adesso)?.start ?? calendario.startOfDay(for: adesso)).timeIntervalSince1970
        let ora = adesso.timeIntervalSince1970
        var c = Consumo()
        for x in chiamate where ModelloChat.Fornitore.di(modello: x.modello) == f && x.at <= ora {
            let costo = f == .mistral ? costoMistralUSD(modello: x.modello, input: x.input, output: x.output) : 0
            if x.at >= mese { c.spesaMeseUSD += costo }
            if x.at >= oggi {
                c.chiamateOggi += 1
                c.tokenOggi += x.input + x.output
                c.spesaOggiUSD += costo
            }
            if x.at >= ora - 60 { c.chiamateUltimoMinuto += 1 }
        }
        return c
    }

    static func formatEuro(_ eur: Double) -> String {
        eur < 0.01 && eur > 0 ? "meno di 1 cent" : String(format: "%.2f €", eur).replacingOccurrences(of: ".", with: ",")
    }

    /// «Agnes 3/20 al min · 12 oggi», e se va in giallo.
    static func etichettaAgnes(_ c: Consumo) -> (testo: String, avviso: Bool) {
        ("Agnes \(c.chiamateUltimoMinuto)/\(tettoAgnesAlMinuto) al min · \(c.chiamateOggi) oggi",
         c.chiamateUltimoMinuto >= avvisoAgnesAlMinuto)
    }

    /// «Mistral 0,04 € su 10 €» (spesa stimata da inizio mese), e se va in giallo.
    static func etichettaMistral(_ c: Consumo) -> (testo: String, avviso: Bool) {
        let eur = c.spesaMeseUSD * usdToEur
        return ("Mistral \(formatEuro(eur)) su \(Int(budgetMistralEUR)) €", eur >= budgetMistralEUR * sogliaAvvisoMistral)
    }

    /// Il registro tiene 31 giorni.
    static func pota(_ chiamate: [ChiamataAI], adesso: Date = Date()) -> [ChiamataAI] {
        let limite = adesso.timeIntervalSince1970 - 31 * 86_400
        return chiamate.filter { $0.at >= limite }
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
    /// La conversazione sulla VM (stringa opaca, docs/CONTRATTI.md 9.10): quella di una chat nata altrove (il Mac,
    /// anche la conversazione storica della voce); nil per una chat nata qui, che usa il suo UUID in minuscolo.
    var vm: String? = nil
    /// Quanti turni ha sulla VM, dall'ultimo elenco: una chat del Mac sta fra i recenti anche prima di aprirla.
    var remoti: Int? = nil

    var nomeScheda: String { titolo.isEmpty ? "Nuova chat" : titolo }
    var idVM: String { vm ?? id.uuidString.lowercased() }
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

    /// L'elenco delle conversazioni della VM (GET /mem/conversations): una che l'iPhone non conosce diventa una chat
    /// (fra i recenti, non in una scheda); di quelle note si aggiornano titolo, ultimo turno e numero di turni.
    mutating func unisci(_ remote: [ConversazioneVM]) {
        for c in remote where !c.conversation_id.isEmpty {
            if let i = chat.firstIndex(where: { $0.idVM == c.conversation_id }) {
                chat[i].ultima = max(chat[i].ultima, c.last_at * 1000)
                chat[i].remoti = c.n
                if chat[i].titolo.isEmpty, let t = c.title, !t.isEmpty { chat[i].titolo = TestoChat.titolo(t) }
            } else {
                // l'UUID della chat e' quello della VM quando lo e' (le chat nate su un'altra superficie con lo stesso
                // contratto), altrimenti uno nuovo e l'id della VM si tiene a parte
                let uuid = UUID(uuidString: c.conversation_id)
                chat.append(ChatMoony(id: uuid ?? UUID(), titolo: TestoChat.titolo(c.title ?? ""), inizio: c.started_at * 1000,
                                      ultima: c.last_at * 1000, vm: uuid == nil ? c.conversation_id : nil, remoti: c.n))
            }
        }
    }

    /// La chat a cui va una riga arrivata solo dal Mac: quella nata per ultima prima della riga.
    func chat(perRigaDelle alle: Double) -> UUID? {
        chat.filter { $0.inizio <= alle }.max { $0.inizio < $1.inizio }?.id
    }
}

// MARK: - la memoria condivisa (VM)

/// Una conversazione della VM (GET /mem/conversations). Tempi in secondi unix.
struct ConversazioneVM: Codable, Equatable {
    let conversation_id: String
    let title: String?
    let started_at: Double
    let last_at: Double
    let n: Int
    let last_source: String?
}

/// Un turno della VM (GET /mem/recent).
struct RigaVM: Codable, Equatable {
    let source: String?
    let role: String
    let content: String
    let persona: String?
    let speaker: String?
    let event_id: String?
    /// Secondi unix.
    let created_at: Double
}

enum MemoriaVM {
    /// Un turno dell'iPhone come lo conosce l'unione: id (anche event_id sulla VM), ruolo, testo, ora in secondi.
    struct Locale: Equatable {
        let id: String
        let role: String
        let content: String
        let at: Double
    }

    /// I turni della VM che l'iPhone non ha: non quelli col suo event_id, e senza event_id non quelli con lo stesso
    /// ruolo e testo entro 2 secondi (il Mac li scrive cosi', d'accordo con Moony AI per Mac). Vale anche fra loro.
    static func nuovi(_ righe: [RigaVM], locali: [Locale]) -> [RigaVM] {
        var ids = Set(locali.map { $0.id.lowercased() })
        var visti = locali
        var out: [RigaVM] = []
        for r in righe.sorted(by: { $0.created_at < $1.created_at }) {
            let content = r.content.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !content.isEmpty else { continue }
            if let e = r.event_id?.lowercased(), !e.isEmpty {
                if ids.contains(e) { continue }
                ids.insert(e)
            } else if visti.contains(where: { $0.role == r.role && $0.content == content && abs($0.at - r.created_at) <= 2 }) {
                continue
            }
            visti.append(Locale(id: r.event_id ?? "", role: r.role, content: content, at: r.created_at))
            out.append(r)
        }
        return out
    }

    /// Il testo che va sulla VM: un allegato solo con la sua riga d'intestazione (il contenuto e' esterno e grande).
    static func contenuto(_ testo: String, esterno: Bool) -> String {
        guard esterno, testo.hasPrefix(TestoChat.prefissoAllegato) else { return testo }
        return String(testo.prefix { $0 != "\n" })
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
