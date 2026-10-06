//
//  Personaggi.swift
//  Bottega per iPhone
//
//  Darlene, Elliot e Krista: i personaggi di Mr. Robot a cui Melissa passa la chiamata. Un file ciascuno in
//  extensions/bottega-home/personaggi/, la fonte unica anche per la mod melissa e per la barra della Bottega: la build
//  li mette nell'app (project.yml). Qui si leggono, con le regole su chi entra. Il giro sta in Melissa.swift.
//

import Foundation

/// Un file di personaggi/ (personaggi/LEGGIMI.md).
struct Personaggio: Equatable, Decodable {
    let chiave: String
    let nome: String
    let ordine: Int
    /// ID della voce ElevenLabs dell'account di Andrea: senza la sua chiave non serve a niente
    let voce: String
    let carattere: String
    let saluti: [String]
    /// a cosa serve nella chiacchierata (il nome, se il file non lo dice)
    let ruolo: String
    /// il suo campo: cosa gli si chiede quando entra (il ruolo, se il file non lo dice; docs/CONTRATTI.md, 9.11)
    let ruoloCronaca: String
    /// espressione regolare: se Andrea la dice, Melissa tira dentro questo personaggio ("" mai, o se non e' valida)
    let parole: String
    /// cosa dice mentre pensa, per gruppo (Riempitivi.swift); nil se il file non ne ha
    let riempitivi: FrasiRiempitivo?
    /// in quali fatti entra da solo (docs/CONTRATTI.md, 9.11, «Ospiti dai fatti»); [] se il file non lo dice.
    /// Sull'iPhone c'e' solo la chiacchierata: contano `chiacchiera` e `umore` (Personaggi.adatto).
    let occasioni: [String]

    private enum CodingKeys: String, CodingKey {
        case chiave, nome, ordine, voce, carattere, saluti, ruolo, parole, riempitivi, occasioni
        case ruoloCronaca = "ruolo_cronaca"
    }

    /// Gli stessi campi facoltativi della mod e della Bottega: un file senza `ruolo` o `parole` funziona ovunque.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chiave = try c.decode(String.self, forKey: .chiave)
        nome = try c.decode(String.self, forKey: .nome)
        ordine = try c.decodeIfPresent(Int.self, forKey: .ordine) ?? 99
        voce = try c.decodeIfPresent(String.self, forKey: .voce) ?? ""
        carattere = try c.decode(String.self, forKey: .carattere)
        saluti = try c.decode([String].self, forKey: .saluti)
        let r = try c.decodeIfPresent(String.self, forKey: .ruolo) ?? ""
        ruolo = r.isEmpty ? nome : r
        let rc = try c.decodeIfPresent(String.self, forKey: .ruoloCronaca) ?? ""
        ruoloCronaca = rc.isEmpty ? ruolo : rc
        let p = try c.decodeIfPresent(String.self, forKey: .parole) ?? ""
        parole = (try? NSRegularExpression(pattern: p)) != nil ? p : ""
        // facoltativo: senza, o con un gruppo vuoto, si usano i suoi `chiacchiera` e poi le frasi di Melissa
        riempitivi = try? c.decodeIfPresent(FrasiRiempitivo.self, forKey: .riempitivi)
        occasioni = (try? c.decodeIfPresent([String].self, forKey: .occasioni)) ?? []
    }
}

/// Cosa ha detto di recente ciascuno, "melissa" o la chiave di un personaggio: le ultime 5 battute delle ultime 12 ore,
/// che vanno nel suo prompt perche' non si ripeta. In UserDefaults con la stessa forma del file del Mac,
/// `{chiave: [{at, testo, dove}]}` (docs/CONTRATTI.md, 9.11, «Ognuno ricorda cosa ha detto»).
enum Detti {
    struct Detto: Codable, Equatable {
        /// millisecondi dal 1970, come `alle` nella storia
        let at: Double
        let testo: String
        let dove: String
    }

    static let chiave = "detti-personaggi"
    static let quanti = 5
    static let durata: Double = 12 * 3600 * 1000

    static func tutti(in difesa: UserDefaults = .standard) -> [String: [Detto]] {
        guard let data = difesa.data(forKey: chiave),
              let t = try? JSONDecoder().decode([String: [Detto]].self, from: data) else { return [:] }
        return t
    }

    /// Le battute di `chi` ancora valide, dalla piu' vecchia.
    static func recenti(di chi: String, adesso: Double = Date().timeIntervalSince1970 * 1000,
                        in difesa: UserDefaults = .standard) -> [String] {
        (tutti(in: difesa)[chi] ?? []).filter { adesso - $0.at < durata }.suffix(quanti).map(\.testo)
    }

    static func ricorda(_ testo: String, di chi: String, adesso: Double = Date().timeIntervalSince1970 * 1000,
                        in difesa: UserDefaults = .standard) {
        let t = testo.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        var detti = tutti(in: difesa)
        let lista = ((detti[chi] ?? []) + [Detto(at: adesso, testo: t, dove: "iphone")]).filter { adesso - $0.at < durata }
        detti[chi] = Array(lista.suffix(quanti))
        if let data = try? JSONEncoder().encode(detti) { difesa.set(data, forKey: chiave) }
    }

    /// La riga del prompt di `chi`, "" se non ha detto niente nelle ultime 12 ore.
    static func prompt(di chi: String, adesso: Double = Date().timeIntervalSince1970 * 1000,
                       in difesa: UserDefaults = .standard) -> String {
        let r = recenti(di: chi, adesso: adesso, in: difesa)
        guard !r.isEmpty else { return "" }
        return "Hai detto di recente (non ripeterti, niente battute o immagini uguali): " + r.map { "«\($0)»" }.joined(separator: " ")
    }
}

/// Chi vuole sentire Andrea con una frase, capito da DeepSeek Flash (mai Agnes) in chiacchierata, in parallelo con la
/// risposta: `passa` (parlare con lui da ora in poi, o "melissa") o `chiede` (solo il suo parere adesso). Qui il prompt e
/// la lettura del JSON; la richiesta in AssistenteTelefono.chiVuole (docs/CONTRATTI.md, 9.11, mod 0.18.3).
struct ChiVuole: Equatable {
    let passa: String?
    /// chi sentire adesso, una volta: un elenco (un JSON vecchio con una chiave sola vale come elenco di uno)
    let chiede: [String]
    /// vuole sentirli tutti, uno dopo l'altro (il giro a piu' voci)
    let tutti: Bool

    init(passa: String?, chiede: [String] = [], tutti: Bool = false) {
        self.passa = passa
        self.chiede = chiede
        self.tutti = tutti
    }

    static let maxToken = 40
    static let attesa: Duration = .milliseconds(2500)
    /// Sempre DeepSeek Flash, mai Agnes, come nella mod e nella Bottega.
    static let url = "https://api.deepseek.com/chat/completions"
    static let modello = "deepseek-flash"

    /// Il prompt di sistema: chiave, nome e ruolo di ognuno, quando vale `passa`, `chiede` o `tutti`, e i due esempi veri
    /// del 6 ottobre. Parola per parola quello della mod e della Bottega (promptChiVuole).
    static func prompt(_ personaggi: [Personaggio]) -> String {
        let elenco = personaggi.map { "- \($0.chiave): \($0.nome), \($0.ruolo)" }.joined(separator: "\n")
        return "Andrea parla a voce con Melissa, la sua assistente; il microfono puo' capire male i nomi. Con lei ci sono " +
            "questi personaggi (chiave: nome, ruolo):\n\(elenco)\n" +
            "Dalla frase di Andrea decidi chi vuole sentire. \"passa\": la chiave di chi vuole come interlocutore da ora " +
            "in poi (\"passami...\", \"fammi parlare con...\", \"la psicologa\", un nome capito male che somiglia), oppure " +
            "\"melissa\" se rivuole Melissa; altrimenti null. \"chiede\": l'elenco delle chiavi di chi vuole sentire solo " +
            "adesso, una volta (\"chiedi a...\", \"e tu...?\", \"c'e' la psicologa?\"); altrimenti []. \"tutti\": true se vuole " +
            "sentirli tutti, uno dopo l'altro (\"fammi sentire tutti\", \"parla con gli altri\", \"e gli altri\"); altrimenti false. " +
            "Esempi: «No dicevo Eliot Elliot passami Elliot e gli altri personaggi passami qualcuno fammi sentire tutte... " +
            "siamo io te e altri» = {\"passa\": \"elliot\", \"chiede\": [], \"tutti\": true}; «Melissa c'e' la psicologa se mi " +
            "fumo una canna, parla con gli altri» = {\"passa\": null, \"chiede\": [\"krista\"], \"tutti\": true}. Rispondi solo con " +
            "il JSON, nient'altro: {\"passa\": chiave o \"melissa\" o null, \"chiede\": [chiavi], \"tutti\": true o false}"
    }

    /// La risposta del modello: nil se non e' JSON (anche dentro un blocco ```json); una chiave che non c'e' si toglie.
    static func leggi(_ testo: String, chiavi: [String]) -> ChiVuole? {
        guard let inizio = testo.firstIndex(of: "{"), let fine = testo.lastIndex(of: "}"), inizio < fine,
              let json = try? JSONSerialization.jsonObject(with: Data(testo[inizio...fine].utf8)) as? [String: Any]
        else { return nil }
        let passa = (json["passa"] as? String)?.lowercased()
        let grezzi: [String] = (json["chiede"] as? [Any])?.compactMap { $0 as? String } ?? ((json["chiede"] as? String).map { [$0] } ?? [])
        var chiede: [String] = []
        for k in grezzi.map({ $0.lowercased() }) where chiavi.contains(k) && !chiede.contains(k) { chiede.append(k) }
        return ChiVuole(passa: passa.flatMap { $0 == "melissa" || chiavi.contains($0) ? $0 : nil }, chiede: chiede,
                        tutti: json["tutti"] as? Bool == true)
    }

    /// Per il registro, come nella mod e nella Bottega: "passa elliot, tutti", "chiede krista darlene", "nessuno".
    var riga: String {
        let parti = [passa.map { "passa \($0)" }, chiede.isEmpty ? nil : "chiede " + chiede.joined(separator: " "), tutti ? "tutti" : nil]
            .compactMap { $0 }
        return parti.isEmpty ? "nessuno" : parti.joined(separator: ", ")
    }
}

/// personaggi/melissa.json: non e' un personaggio, porta solo le frasi che Melissa dice mentre pensa.
private struct FileMelissa: Decodable {
    let chiave: String
    let riempitivi: FrasiRiempitivo?
}

enum Personaggi {
    /// Letti una volta dai file inclusi nell'app; nei test dalla cartella in BOTTEGA_PERSONAGGI.
    static let tutti: [String: Personaggio] = carica()

    /// In ordine, come li elenca Melissa.
    static let ordine: [String] = tutti.values.sorted { $0.ordine < $1.ordine }.map(\.chiave)

    /// I riempitivi di Melissa, da personaggi/melissa.json: letti a parte, mai dentro `tutti`.
    static let riempitiviMelissa: FrasiRiempitivo? = caricaMelissa()

    /// La cartella dei file: nei test BOTTEGA_PERSONAGGI, altrimenti quella inclusa nell'app.
    private static var cartella: URL? {
        ProcessInfo.processInfo.environment["BOTTEGA_PERSONAGGI"].map { URL(fileURLWithPath: $0) }
            ?? Bundle.main.url(forResource: "personaggi", withExtension: nil)
    }

    static func carica() -> [String: Personaggio] {
        guard let cartella, let file = try? FileManager.default.contentsOfDirectory(at: cartella, includingPropertiesForKeys: nil)
        else { return [:] }
        var tutti: [String: Personaggio] = [:]
        for url in file where url.pathExtension == "json" {
            // chiave minuscola come nella mod e nella Bottega: e' anche il segnale @chiave
            guard let data = try? Data(contentsOf: url), let p = try? JSONDecoder().decode(Personaggio.self, from: data),
                  p.chiave != "melissa", p.chiave.range(of: "^[a-z]+$", options: .regularExpression) != nil, !p.saluti.isEmpty
            else { continue }
            tutti[p.chiave] = p
        }
        return tutti
    }

    private static func caricaMelissa() -> FrasiRiempitivo? {
        guard let url = cartella?.appendingPathComponent("melissa.json"), let data = try? Data(contentsOf: url),
              let f = try? JSONDecoder().decode(FileMelissa.self, from: data), f.chiave == "melissa" else { return nil }
        return f.riempitivi
    }

    /// Le frasi di attesa di chi parla: "melissa" o la chiave di un personaggio.
    static func riempitivi(di chi: String) -> FrasiRiempitivo? {
        chi == "melissa" ? riempitiviMelissa : tutti[chi]?.riempitivi
    }

    /// Chi non e' un tema per l'eco: Melissa, Andrea e i personaggi.
    static var nonTemi: [String] { ["Melissa", "Andrea"] + ordine.compactMap { tutti[$0]?.nome } }

    /// Le regole che ogni personaggio rispetta, qualunque carattere abbia: voce, verita', lingua.
    static let regole = "Non hai strumenti e non vedi file, progetti o sessioni; quello che non sai lo dici, non inventi mai. " +
        "Parli sempre e solo in italiano. Tutto viene letto ad alta voce: frasi parlate, niente markdown, elenchi, emoji, " +
        "asterischi, niente lineette lunghe. " + nonRipetere

    /// Nessuno ripete un fatto o un argomento che un altro ha gia' detto nella chiacchierata (docs/CONTRATTI.md, 9.11).
    static let nonRipetere = "Non ripetere un fatto o un argomento che un altro ha gia' detto nella chiacchierata: aggiungi " +
        "qualcosa di nuovo, oppure non citarlo."

    /// Melissa coordina, non rifiuta (docs/CONTRATTI.md, 9.11): la stessa regola della mod e della Bottega.
    static let regolaRegia = "Quando Andrea vuole parlare con uno dei personaggi o sentire il loro parere, anche di tutti, lo fai " +
        "sempre: puoi punzecchiarlo, ma non ti rifiuti mai e non dici mai che non ti va di fare da tramite o da centralino. " +
        "Quando parlano tutti tieni le fila, e alla fine tiri le somme in una o due frasi."

    /// Il giro a piu' voci (docs/CONTRATTI.md, 9.11): con `tutti`, o con piu' di un `chiede`, chi risponde a turno. Prima i
    /// chiesti, poi (con `tutti`) gli altri in ordine; mai chi ha gia' la chiamata, salvo quello a cui e' appena passata,
    /// che parla per primo. `chiude`: Melissa tira le somme alla fine, se la chiamata e' sua. Come nella mod e nella Bottega.
    static func giroDiVoci(_ v: ChiVuole?, conVoce: [String], conLaChiamata: String) -> (voci: [String], chiude: Bool) {
        guard let v else { return ([], false) }
        let chiesti = v.chiede.filter { conVoce.contains($0) }
        guard v.tutti || chiesti.count >= 2 else { return ([], false) }
        let tutti = v.tutti ? chiesti + conVoce.filter { !chiesti.contains($0) } : chiesti
        let dopo = v.passa ?? conLaChiamata
        let nuovo = v.passa.flatMap { $0 != "melissa" && $0 != conLaChiamata && conVoce.contains($0) ? $0 : nil }
        return ((nuovo.map { [$0] } ?? []) + tutti.filter { $0 != dopo && $0 != nuovo }, dopo == "melissa")
    }

    /// Cosa si dice a uno del giro: rispondere ad Andrea solo dal suo campo, aggiungendo a quelli prima.
    static func istruzioneGiro(_ chi: String, primo: Bool) -> String {
        guard let p = tutti[chi] else { return "" }
        let umano = p.occasioni.contains("umore")
            ? ": il lato umano anche di un fatto tecnico, mai dettagli di file, errori o comandi che non puoi sapere" : ""
        return "Rispondi ad Andrea in una o due frasi, a modo tuo e solo dal tuo campo (\(p.ruoloCronaca))\(umano)." +
            (primo ? "" : " Hai sentito cosa hanno detto quelli prima di te: non ripeterlo, aggiungi la tua.") +
            " Non fare domande agli altri. Solo le parole che diresti."
    }

    /// La regia di Melissa quando chiVuole ha capito chi vuole Andrea («Melissa coordina, non rifiuta»): cosa succede, per
    /// una sua battuta breve al posto della risposta pensata prima. "" se non c'e' niente da dirigere. Come nella mod.
    static func regia(passa: String? = nil, chiede: String? = nil, voci: [String] = []) -> String {
        let voci = voci.filter { tutti[$0] != nil }
        let altri = voci.filter { $0 != passa }
        var cosa = ""
        if let passa, tutti[passa] != nil {
            cosa = altri.isEmpty
                ? "Andrea vuole parlare con \(nome(passa)): passagli la chiamata (per esempio \"Ok, ti passo \(nome(passa)).\")."
                : "Andrea vuole parlare con \(nome(passa)) e sentire anche \(elenco(altri.map(nome))): passa la chiamata a " +
                  "\(nome(passa)) e annuncia che dopo parlano anche gli altri."
        } else if let primo = voci.first {
            cosa = "Andrea vuole sentire \(elenco(voci.map(nome))), uno dopo l'altro: apri il giro e da' la parola a " +
                "\(nome(primo)) (per esempio \"Sentiamo tutti: \(nome(primo)), comincia tu.\")."
        } else if let chiede, tutti[chiede] != nil {
            cosa = "Andrea vuole il parere di \(nome(chiede)): chiediglielo tu, per nome."
        }
        return cosa.isEmpty ? "" : cosa + " Una frase breve, al massimo due, nel tuo stile: puoi punzecchiare, ma lo fai. " +
            "Non rispondere tu alla domanda. Solo le parole che diresti."
    }

    /// Il nome da mostrare per chi parla: "melissa" o la chiave di un personaggio.
    static func nome(_ chi: String) -> String { tutti[chi]?.nome ?? "Melissa" }

    /// I nomi per le espressioni regolari, e da un nome detto alla chiave.
    private static var nomi: String {
        ordine.compactMap { tutti[$0].map { NSRegularExpression.escapedPattern(for: $0.nome.lowercased()) } }.joined(separator: "|")
    }
    private static func chiaveDi(_ nome: String) -> String? { ordine.first { tutti[$0]?.nome.lowercased() == nome.lowercased() } }

    private static func primo(_ schema: String, in testo: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: schema, options: .caseInsensitive),
              let m = re.firstMatch(in: testo, range: NSRange(testo.startIndex..., in: testo)),
              let r = Range(m.range(at: 1), in: testo) else { return nil }
        return testo[r].lowercased()
    }

    /// "passami Darlene", "fammi parlare con Elliot", "ridammi Melissa": a chi passare la chiamata, o nil.
    static func chiChiede(_ testo: String) -> String? {
        guard let chi = primo("\\b(?:passami|passa|fammi parlare con|voglio parlare con|ridammi|torna|chiama)\\s+(?:a\\s+)?(melissa|\(nomi)|mr\\.?\\s*robot)\\b", in: testo)
        else { return nil }
        if chi == "melissa" { return chi }
        return chi.hasPrefix("mr") ? chiaveDi("elliot") : chiaveDi(chi)
    }

    /// Lo strumento con cui chi parla da' la parola a un personaggio (docs/CONTRATTI.md, 9.11, «Chi parla lo decide il
    /// modello»): la decisione viaggia nella chiamata, strutturata, e non finisce mai nel testo detto. Stesso nome e
    /// stessa forma della Bottega (`strumentoPassaParola` in personaggi.ts). `a`: le chiavi di chi puo' rispondere adesso.
    static let passaParola = "passa_parola"
    static func strumentoPassaParola(_ a: [String]) -> [String: Any] {
        ["type": "function",
         "function": [
            "name": passaParola,
            "description": "Da' la parola a uno dei personaggi: risponde con la sua voce subito dopo la tua battuta. Senza " +
                "questa chiamata nessuno risponde, anche se lo nomini.",
            "parameters": [
                "type": "object",
                "properties": [
                    "a": ["type": "string", "enum": a, "description": "la chiave di chi deve rispondere"],
                    "perche": ["type": "string", "description": "per cosa lo chiami, in poche parole"],
                ],
                "required": ["a"],
            ] as [String: Any],
         ] as [String: Any]]
    }

    /// A chi da' la parola una chiamata a passa_parola: una chiave fra le `offerte` (con la maiuscola vale lo stesso), o
    /// nil se gli argomenti non si leggono o la chiave non e' offerta.
    static func passaParolaA(_ argomenti: String?, offerte: [String]) -> String? {
        guard let data = (argomenti?.isEmpty == false ? argomenti! : "{}").data(using: .utf8),
              let x = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let a = (x["a"] as? String)?.trimmingCharacters(in: .whitespaces).lowercased(),
              offerte.contains(a) else { return nil }
        return a
    }

    /// Come si chiede al modello di dare la parola: la battuta e la chiamata insieme, nella stessa risposta (misura del
    /// 6/10: cosi' DeepSeek Flash la chiama 6 volte su 6, Agnes 3 su 3, e il testo arriva prima della chiamata). Stesso
    /// testo di `chiamaCon` nella Bottega.
    static func chiamaCon(_ chi: String) -> String {
        guard let p = tutti[chi] else { return "" }
        return "Nella stessa risposta fai due cose: scrivi la tua battuta, che chiude con una domanda rivolta a \(p.nome), " +
            "e chiama lo strumento \(passaParola) con a = \(chi). Il testo da solo non basta: senza la chiamata \(p.nome) " +
            "non sente la domanda."
    }

    /// "Darlene, Elliot e Krista".
    static func elenco(_ nomi: [String]) -> String {
        nomi.count <= 1 ? (nomi.first ?? "") : nomi.dropLast().joined(separator: ", ") + " e " + nomi.last!
    }

    /// A cosa serve ciascuno, gli stessi ruoli della cronaca della mod (RUOLI in register.tsx).
    /// A cosa serve ciascuno, dal campo `ruolo` del suo file (lo stesso nella mod e nella Bottega).
    static var ruoli: [String: String] { tutti.mapValues(\.ruolo) }

    /// Chi entra quando Melissa lo tira dentro da sola: quello di `perFatto` (le sue `parole`, o chi ha `umore` per
    /// uno sfogo), altrimenti, a caso, uno diverso dall'ultimo fra chi ha `chiacchiera` nelle `occasioni`
    /// (docs/CONTRATTI.md, 9.11). Lo sceglie il codice: lasciato al modello,
    /// chiamava sempre Darlene (misura del 6 ottobre 2026 sulla cronaca della mod). `caso` in [0, 1). `fra`: i
    /// personaggi in ordine (nei test anche uno di prova).
    static func adatto(_ testo: String, ultimo: String?, caso: Double = Double.random(in: 0..<1),
                       fra personaggi: [Personaggio] = Personaggi.ordine.compactMap { Personaggi.tutti[$0] }) -> String? {
        if let k = perFatto(testo) { return k }
        let liberi = personaggi.filter { $0.occasioni.contains("chiacchiera") }.map(\.chiave)
        let altri = liberi.filter { $0 != ultimo }
        let fra = altri.isEmpty ? liberi : altri
        guard !fra.isEmpty else { return nil }
        return fra[min(fra.count - 1, Int(caso * Double(fra.count)))]
    }

    /// Ha `chiacchiera` nelle `occasioni`: puo' entrare o ricevere la parola senza un motivo.
    static func inChiacchiera(_ chiave: String) -> Bool { tutti[chiave]?.occasioni.contains("chiacchiera") == true }

    /// Chi e' scelto da quello che Andrea ha detto: le `parole` di un personaggio, oppure, per uno sfogo, il primo in
    /// ordine con `umore` (Krista).
    static func perFatto(_ testo: String) -> String? {
        if let k = perArgomento(testo) { return k }
        guard Riempitivi.intento(testo) == .sfogo else { return nil }
        return ordine.first { tutti[$0]?.occasioni.contains("umore") == true }
    }

    /// Il primo, in ordine, le cui `parole` Andrea ha detto (Elliot sulla password, Krista su una scusa), o nil.
    static func perArgomento(_ testo: String) -> String? {
        ordine.first { k in
            guard let parole = tutti[k]?.parole, !parole.isEmpty else { return false }
            return primo("(\(parole))", in: testo) != nil
        }
    }

    /// Chi puo' entrare da solo nella risposta di adesso (docs/CONTRATTI.md, 9.11, mod 0.16): dopo ogni risposta di
    /// Melissa senza ospite; appena dopo un ospite no, e alla prima risposta dopo non torna lo stesso per argomento.
    /// `dallUltimo`: le risposte di Melissa dall'ultimo ospite (1 all'inizio della conversazione, come nella mod).
    static func puoEntrare(_ testo: String, dallUltimo: Int, ultimo: String?) -> Bool {
        guard dallUltimo >= 1 else { return false }
        if dallUltimo >= 2 { return true }
        let k = perFatto(testo)
        return k == nil || k != ultimo
    }

    /// L'invito e' deciso dopo due risposte senza ospiti, o subito se entra quello di cui Andrea ha toccato l'argomento.
    static func invitoDeciso(_ testo: String, dallUltimo: Int, scelto: String?) -> Bool {
        dallUltimo >= 2 || (scelto != nil && scelto == perFatto(testo))
    }

    /// Nel giro a tre gli altri con una voce, a cui `chi` puo' passare la parola: mai se stesso, mai chi l'ha chiamato.
    static func altri(di chi: String, daChi: String?) -> [String] {
        ordine.filter { $0 != chi && $0 != daChi && tutti[$0]?.voce.isEmpty == false }
    }

    /// Nel 40% dei casi un ospite chiude chiedendo a un altro, scelto a caso fra quelli di `altri` che hanno
    /// `chiacchiera`, cosa ne pensa: parlano fra loro (mod 0.16, 9.11). `caso` decide se,
    /// `caso2` chi; mai al secondo di un giro (`ultima`).
    static func passa(fra altri: [String], ultima: Bool, caso: Double = Double.random(in: 0..<1),
                      caso2: Double = Double.random(in: 0..<1)) -> String? {
        let fra = altri.filter(inChiacchiera)
        guard !ultima, !fra.isEmpty, caso < 0.4 else { return nil }
        return fra[min(fra.count - 1, Int(caso2 * Double(fra.count)))]
    }

    /// Cosa si aggiunge al prompt di Melissa perche' sappia di poter tirare dentro qualcuno. `scelto`: chi puo'
    /// tirare dentro da sola adesso, se puo'. `vivo`: piu' risposte senza ospiti, quindi lo tira dentro adesso, e
    /// l'invito e' deciso. Chi Andrea vuole sentire lo capisce ChiVuole. Stesso testo di `invito` nella Bottega.
    static func invito(scelto: String?, vivo: Bool = false) -> String {
        guard let scelto, let p = tutti[scelto] else { return "" }
        if vivo {
            return "Stavolta tira dentro \(p.nome) di Mr. Robot (\(ruoli[scelto] ?? p.nome)): trova l'aggancio in quello che " +
                "ha detto Andrea e rispondi tu; \(campo(di: scelto)). \(chiamaCon(scelto))"
        }
        return "Con te c'e' anche \(p.nome) di Mr. Robot (\(ruoli[scelto] ?? p.nome)). Solo quando rende la chiacchierata " +
            "piu' viva puoi tirarlo dentro; \(campo(di: scelto)). Per farlo: \(chiamaCon(scelto)) Di solito rispondi da sola " +
            "e non chiami nessuno."
    }

    /// Cosa si chiede a un ospite: solo dal suo campo (`ruolo_cronaca`). A chi ha `umore` (Krista) il lato umano anche
    /// di un fatto tecnico, mai i dettagli che non puo' sapere. Lo stesso testo di `campoDi` nella mod e nella Bottega
    /// (docs/CONTRATTI.md, 9.11, «Tutti presenti, ognuno con la domanda del suo campo»).
    static func campo(di chi: String) -> String {
        guard let p = tutti[chi] else { return "" }
        let umano = p.occasioni.contains("umore")
            ? ": il lato umano anche di un fatto tecnico, mai dettagli di file, errori o comandi che non puo' sapere" : ""
        return "chiedi a \(p.nome) solo dal suo campo (\(p.ruoloCronaca))\(umano)"
    }

    /// Il prompt di sistema di un personaggio che ha la chiamata sull'iPhone.
    static func sistema(_ p: Personaggio) -> String {
        "\(p.carattere) Andrea ti parla dall'iPhone: e' una chiacchierata, di qualunque cosa. \(regole) Due o tre frasi brevi."
    }
}
