//
//  StanzeView.swift
//  Bottega per iPhone
//
//  Le stanze della plancia del Mac, in sola lettura (docs/CONTRATTI.md, 9.6): una griglia, e ogni stanza si apre
//  a tutto schermo. Qui ci sono anche i pezzi comuni: la cornice che mostra l'ultimo dato con la sua eta' quando
//  il Mac non risponde, i riquadri, le cifre e i formati dei numeri.
//

import SwiftUI

/// Le stanze che l'iPhone sa aprire. Il valore e' il `nome` di /v1/stanza e del link bottega://stanze?nome=..
enum StanzaPlancia: String, CaseIterable, Identifiable {
    case appstore, cruscotto, vedetta, dafare, posta, clienti, notte
    var id: String { rawValue }

    var titolo: String {
        switch self {
        case .appstore: "App Store"
        case .cruscotto: "Cruscotto"
        case .vedetta: "Vedetta"
        case .dafare: "Cose da fare"
        case .posta: "Posta e WhatsApp"
        case .clienti: "Clienti"
        case .notte: "Notte"
        }
    }

    var sotto: String {
        switch self {
        case .appstore: "Guadagni, download, buchi"
        case .cruscotto: "Ore, sessioni, token"
        case .vedetta: "Semaforo e siti"
        case .dafare: "Dalla Memoria"
        case .posta: "Chi ha scritto"
        case .clienti: "Ore e importi del mese"
        case .notte: "Coda e resoconto"
        }
    }

    var simbolo: String {
        switch self {
        case .appstore: "chart.bar.xaxis"
        case .cruscotto: "gauge.with.dots.needle.33percent"
        case .vedetta: "light.beacon.max"
        case .dafare: "checklist"
        case .posta: "envelope"
        case .clienti: "person.2"
        case .notte: "moon.stars"
        }
    }
}

struct StanzeView: View {
    let ponte: Ponte
    @Bindable private var nav = Navigazione.shared

    private let colonne = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: colonne, spacing: 12) {
                ForEach(StanzaPlancia.allCases) { s in
                    Button { nav.stanzaAperta = s } label: { Tessera(stanza: s) }
                        .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            Text("Le stanze si leggono dal Mac, con la Bottega aperta. Senza il Mac vedi l'ultimo dato, con la sua età.")
                .font(.caption)
                .foregroundStyle(Tinte.tinta)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)
                .padding(.bottom, 12)
        }
        .scrollContentBackground(.hidden)
        .fullScreenCover(item: $nav.stanzaAperta) { s in
            ApriStanza(ponte: ponte, stanza: s)
        }
    }
}

private struct Tessera: View {
    let stanza: StanzaPlancia

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: stanza.simbolo)
                .font(.title3)
                .foregroundStyle(Tinte.ambra)
            Text(stanza.titolo)
                .font(.headline)
                .foregroundStyle(Tinte.testo)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Text(stanza.sotto)
                .font(.caption)
                .foregroundStyle(Tinte.tinta)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16).fill(Tinte.notteFonda.opacity(0.8)))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Tinte.bordo))
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

/// Una stanza a tutto schermo, con la sua barra e «Chiudi».
private struct ApriStanza: View {
    let ponte: Ponte
    let stanza: StanzaPlancia
    @Environment(\.dismiss) private var chiudi

    var body: some View {
        NavigationStack {
            Group {
                switch stanza {
                case .appstore: AppStoreView(ponte: ponte)
                case .cruscotto: CruscottoView(ponte: ponte)
                case .vedetta: VedettaView(ponte: ponte)
                case .dafare: DaFareView(ponte: ponte)
                case .posta: PostaView(ponte: ponte)
                case .clienti: ClientiView(ponte: ponte)
                case .notte: NotteView(ponte: ponte)
                }
            }
            .background(Tinte.sfondo.ignoresSafeArea())
            .navigationTitle(stanza.titolo)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Chiudi") { chiudi() } }
            }
        }
        .tint(Tinte.ambra)
        .preferredColorScheme(.dark)
    }
}

// MARK: - la cornice di ogni stanza

private struct IdentitaRiletturaStanza: Equatable {
    let query: [String: String]
    let attiva: Bool
}

/// Mostra il dato della stanza dentro uno ScrollView che si tira giu' per aggiornare. In cima: con il Mac che non
/// risponde, la frase e l'eta' dell'ultimo dato visto; senza alcun dato, solo la frase. Mai una schermata vuota.
struct CorniceStanza<T: Decodable, Contenuto: View>: View {
    let lettura: LetturaStanza<T>
    let query: [String: String]
    @Environment(\.scenePhase) private var fase
    @State private var riassunto = Riassunto()
    @State private var erroreRacconto: String?
    /// L'ora (ms) del dato sul Mac, se la stanza ce l'ha: per dire «dati del Mac di 3 ore fa».
    var datiDelMac: ((T) -> Double?)?
    @ViewBuilder let contenuto: (T) -> Contenuto

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let d = lettura.dati {
                    stato(d)
                    HStack {
                        Button(riassunto.stato == .fermo ? "Racconta con Melissa" : "Ferma Melissa") {
                            if riassunto.stato == .fermo { avviaRacconto() } else { riassunto.ferma() }
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Tinte.ambra)
                        Spacer()
                        if riassunto.stato != .fermo { ProgressView().tint(Tinte.ambra) }
                    }
                    if riassunto.stato != .fermo || !riassunto.testo.isEmpty || riassunto.errore != nil || erroreRacconto != nil {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Melissa racconta").font(.caption.weight(.semibold)).foregroundStyle(Tinte.ambra)
                            if let errore = riassunto.errore ?? erroreRacconto {
                                Text(errore).foregroundStyle(Tinte.rosso)
                            } else {
                                Text(riassunto.testo.isEmpty ? "Preparo il racconto e la voce…" : riassunto.testo)
                                    .foregroundStyle(Tinte.testo)
                            }
                        }
                        .font(.callout)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Tinte.notteFonda))
                    }
                    contenuto(d)
                } else if lettura.caricando {
                    HStack(spacing: 10) {
                        ProgressView().tint(Tinte.tinta)
                        Text("Chiedo al Mac…").font(.callout).foregroundStyle(Tinte.tinta)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 60)
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                            .font(.largeTitle)
                            .foregroundStyle(Tinte.tinta)
                        Text(lettura.errore ?? "Niente da mostrare.")
                            .font(.callout)
                            .foregroundStyle(Tinte.testo)
                            .multilineTextAlignment(.center)
                        Text("Questa stanza non l'hai ancora vista con il Mac acceso: non c'è un dato da mostrare.")
                            .font(.caption)
                            .foregroundStyle(Tinte.tinta)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 60)
                    .padding(.horizontal, 20)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .refreshable { await lettura.carica(query) }
        .task(id: IdentitaRiletturaStanza(query: query, attiva: fase == .active)) {
            guard fase == .active else { return }
            // La prima lettura cambia subito periodo; il numero di giro impedisce
            // alla risposta della query precedente di sovrascriverla.
            await lettura.carica(query)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
                guard !Task.isCancelled else { return }
                // Non sovrapporre il polling a refresh manuali o verifica App Store.
                if !lettura.caricando { await lettura.carica(query) }
            }
        }
        .onChange(of: query) { _, _ in riassunto.ferma(); riassunto = Riassunto(); erroreRacconto = nil }
        .onChange(of: fase) { _, nuova in if nuova == .background { riassunto.ferma() } }
        .onDisappear { riassunto.ferma() }
    }

    private func avviaRacconto() {
        erroreRacconto = nil
        guard let copia = PonteStanze.shared.ultima(lettura.nome, query) else {
            erroreRacconto = "Aspetta che i dati della stanza siano pronti."
            return
        }
        let contenuto: String
        if let json = try? JSONSerialization.jsonObject(with: copia.dati),
           let ordinato = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]) {
            contenuto = String(decoding: ordinato, as: UTF8.self)
        } else {
            contenuto = String(decoding: copia.dati, as: UTF8.self)
        }
        let nome = StanzaPlancia(rawValue: lettura.nome)?.titolo ?? lettura.nome
        var contesto = "Dati visti il \(copia.visto.formatted(date: .complete, time: .shortened)):\n\(contenuto)"
        if lettura.nome == "cruscotto" {
            let ambito = "I consumi, le ore e i token del JSON del Cruscotto riguardano soltanto Claude Code. Non presentarli come totali di tutti gli strumenti e non ricavare durate di Codex, Cline o terminali dal numero di sessioni."
            let registro = Ponte.shared.contestoMelissa(per: "Riepilogo delle attività e sessioni Claude Code, Codex, Cline e terminali")
            contesto = ([ambito, registro, contesto].compactMap { $0 }).joined(separator: "\n\n")
        }
        riassunto.avvia(titolo: "la stanza \(nome)", contesto: contesto)
    }

    @ViewBuilder
    private func stato(_ d: T) -> some View {
        if let errore = lettura.errore {
            Label {
                VStack(alignment: .leading, spacing: 3) {
                    Text(errore).foregroundStyle(Tinte.testo)
                    if let v = lettura.visto {
                        Text("Questo è l'ultimo dato visto, \(Formati.fa(v)).").foregroundStyle(Tinte.tinta)
                    }
                }
            } icon: {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(Tinte.ambra)
            }
            .font(.footnote)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Tinte.ambra.opacity(0.10)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Tinte.ambra.opacity(0.5)))
        } else {
            HStack(spacing: 6) {
                if lettura.caricando { ProgressView().controlSize(.mini).tint(Tinte.tinta) }
                Text(fraseEta(d)).font(.caption).foregroundStyle(Tinte.tinta)
            }
        }
    }

    private func fraseEta(_ d: T) -> String {
        if lettura.caricando && lettura.vecchio, let v = lettura.visto { return "Ultimo dato visto \(Formati.fa(v)), chiedo al Mac…" }
        if let at = datiDelMac?(d), at > 0 {
            let dal = Date(timeIntervalSince1970: at / 1000)
            // un dato del Mac vecchio va detto; uno fresco basta l'ora
            if Date().timeIntervalSince(dal) > 30 * 60 { return "Dati del Mac di \(Formati.fa(dal, conFa: false))" }
        }
        if let v = lettura.visto { return "Aggiornato alle \(v.formatted(date: .omitted, time: .shortened))" }
        return ""
    }
}

// MARK: - pezzi comuni

struct RiquadroStanza<C: View>: View {
    let titolo: String
    var nota: String? = nil
    @ViewBuilder let contenuto: C

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(titolo).font(.subheadline.weight(.semibold)).foregroundStyle(Tinte.testo)
                Spacer()
                if let nota { Text(nota).font(.caption).foregroundStyle(Tinte.tinta) }
            }
            contenuto
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Tinte.notteFonda.opacity(0.8)))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Tinte.bordo))
    }
}

/// Una cifra con la sua etichetta e, se c'e', la variazione sul periodo prima.
struct Cifra: View {
    let etichetta: String
    let valore: String
    var adesso: Double? = nil
    var prima: Double? = nil
    var grande = false
    var colore: Color = Tinte.testo

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(etichetta).font(.caption).foregroundStyle(Tinte.tinta)
            Text(valore)
                .font(grande ? .title.weight(.semibold) : .title3.weight(.semibold))
                .foregroundStyle(colore)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .monospacedDigit()
            if let v = Formati.variazione(adesso, prima) {
                Text(v.testo).font(.caption2).foregroundStyle(v.su ? Tinte.verde : v.giu ? Tinte.rosso : Tinte.tinta)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Il pallino di un livello: rosso, ambra (giallo o media), verde, grigio.
struct Pallino: View {
    let colore: Color
    var body: some View { Circle().fill(colore).frame(width: 9, height: 9) }
}

/// Un progetto toccabile: apre la sessione prioritaria nel registro di tutte le fonti.
struct ConSessione<C: View>: View {
    let ponte: Ponte
    let progetto: String?
    @ViewBuilder let contenuto: C
    @State private var scelto: SessioneProgetto?

    private var statoVisibile: StatoMac? { ponte.collegato ? ponte.stato ?? StatoMac.ultimo() : nil }

    var body: some View {
        if let l = sessione {
            Button { scelto = l } label: {
                HStack(spacing: 8) {
                    contenuto
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(Tinte.ambra)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Apre la sessione registrata su \(l.progetto)")
            .sheet(item: $scelto) { scelta in
                switch scelta {
                case .lavoro(let lavoro):
                    if ponte.linea == .collegato { SessioneView(ponte: ponte, lavoro: lavoro) }
                    else { SchedaLavoroSalvato(lavoro: lavoro, ora: statoVisibile?.ora) }
                case .attivita(let attivita): SchedaAttivita(ponte: ponte, iniziale: attivita)
                }
            }
        } else {
            contenuto
        }
    }

    private var sessione: SessioneProgetto? { SessioneProgetto.scegli(progetto: progetto, da: statoVisibile) }
}

enum Formati {
    static let it = Locale(identifier: "it_IT")

    static func euro(_ v: Double) -> String {
        let decimali = abs(v) < 100 ? 2 : 0
        return v.formatted(.currency(code: "EUR").locale(it).precision(.fractionLength(decimali)))
    }

    static func dollari(_ v: Double) -> String {
        "\(numero(v, decimali: abs(v) < 100 ? 2 : 0)) $"
    }

    static func numero(_ v: Double, decimali: Int = 0) -> String {
        v.formatted(.number.locale(it).precision(.fractionLength(decimali)))
    }

    /// Minuti: «45 min», «3 h 20 min», «41 h».
    static func ore(_ minuti: Double) -> String {
        let m = Int(max(0, minuti).rounded())
        if m < 60 { return "\(m) min" }
        if m >= 20 * 60 { return "\(m / 60) h" }
        let r = m % 60
        return r == 0 ? "\(m / 60) h" : "\(m / 60) h \(r) min"
    }

    static func token(_ v: Double) -> String {
        if v >= 1e9 { return "\(numero(v / 1e9, decimali: 1)) mld" }
        if v >= 1e6 { return "\(numero(v / 1e6, decimali: v < 1e7 ? 1 : 0)) mln" }
        if v >= 1e3 { return "\(numero(v / 1e3)) mila" }
        return numero(v)
    }

    /// «adesso», «5 minuti fa», «2 ore fa», «3 giorni fa». Con `conFa` falso: «5 minuti», «2 ore».
    static func fa(_ d: Date, conFa: Bool = true) -> String {
        let s = max(0, Date().timeIntervalSince(d))
        let coda = conFa ? " fa" : ""
        if s < 60 { return conFa ? "adesso" : "pochi secondi" }
        let m = Int(s / 60)
        if m < 60 { return m == 1 ? "un minuto\(coda)" : "\(m) minuti\(coda)" }
        let h = Int((s / 3600).rounded())
        if h < 36 { return h == 1 ? "un'ora\(coda)" : "\(h) ore\(coda)" }
        let g = Int((s / 86400).rounded())
        return "\(g) giorni\(coda)"
    }

    static func fa(ms: Double, conFa: Bool = true) -> String { fa(Date(timeIntervalSince1970: ms / 1000), conFa: conFa) }

    /// «oggi», «ieri», «3 ottobre».
    static func giorno(ms: Double) -> String {
        let d = Date(timeIntervalSince1970: ms / 1000)
        let cal = Calendar.current
        if cal.isDateInToday(d) { return "oggi" }
        if cal.isDateInYesterday(d) { return "ieri" }
        return d.formatted(.dateTime.day().month(.wide).locale(it))
    }

    /// "2026-10-01" -> Date; "2026-10" -> il primo del mese.
    static func data(_ chiave: String) -> Date? {
        let p = chiave.split(separator: "-").compactMap { Int($0) }
        guard p.count >= 2 else { return nil }
        return Calendar.current.date(from: DateComponents(year: p[0], month: p[1], day: p.count > 2 ? p[2] : 1))
    }

    /// "2026-10-01" -> «1 ottobre»; "2026-10" -> «ottobre 2026».
    static func chiaveDetta(_ chiave: String) -> String {
        guard let d = data(chiave) else { return chiave }
        return chiave.count > 7 ? d.formatted(.dateTime.day().month(.wide).locale(it)) : d.formatted(.dateTime.month(.wide).year().locale(it))
    }

    struct Variazione {
        let testo: String
        let su: Bool
        let giu: Bool
    }

    /// «+12% sul periodo prima», «-30%», «uguale».
    static func variazione(_ adesso: Double?, _ prima: Double?) -> Variazione? {
        guard let a = adesso, let p = prima, p > 0 else { return nil }
        let v = Int(((a - p) / p * 100).rounded())
        if abs(v) < 3 { return Variazione(testo: "uguale al periodo prima", su: false, giu: false) }
        return Variazione(testo: "\(v > 0 ? "+" : "")\(v)% sul periodo prima", su: v > 0, giu: v < 0)
    }
}
