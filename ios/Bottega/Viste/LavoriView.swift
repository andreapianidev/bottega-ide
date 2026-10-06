//
//  LavoriView.swift
//  Bottega per iPhone
//
//  Tutte le attivita' osservate dal Mac: Claude Code, Cline, Codex e terminali. Le sessioni Claude
//  collegate a un lavoro conservano la scheda con le azioni; le altre hanno un dettaglio di sola lettura.
//

import Charts
import SwiftUI

struct LavoriView: View {
    let ponte: Ponte
    @Environment(\.scenePhase) private var fase
    @State private var scelta: Selezione?
    @State private var riassunto = Riassunto()
    @State private var vistaPerProgetto = true
    @State private var mostraTutte = false

    private var statoVisibile: StatoMac? { ponte.collegato ? ponte.stato ?? StatoMac.ultimo() : nil }
    private var datoSalvato: Bool { ponte.linea != .collegato || ponte.stato == nil }

    private enum Selezione: Identifiable {
        case lavoro(StatoMac.Lavoro)
        case attivita(StatoMac.Attivita)
        var id: String {
            switch self {
            case .lavoro(let l): "lavoro:\(l.id)"
            case .attivita(let a): "attivita:\(a.id)"
            }
        }
        var progetto: String {
            switch self {
            case .lavoro(let l): l.progetto
            case .attivita(let a): a.project
            }
        }
        var stato: String {
            switch self {
            case .lavoro(let l): l.stato
            case .attivita(let a): a.status
            }
        }
        var identitaProgetto: ProgettoLavori {
            switch self {
            case .lavoro(let l): ProgettoLavori(nome: l.progetto, path: l.path)
            case .attivita(let a): ProgettoLavori(nome: a.project, path: a.path)
            }
        }
        var aggiornato: Double {
            switch self {
            case .lavoro(let l): l.da
            case .attivita(let a): a.updatedAt
            }
        }
    }

    var body: some View {
        List {
            if datoSalvato, let stato = statoVisibile {
                Text("Ultimo registro ricevuto dal Mac alle \(Date(timeIntervalSince1970: stato.ora / 1000).formatted(date: .abbreviated, time: .shortened)). Le sessioni potrebbero essere cambiate.")
                    .font(.caption)
                    .foregroundStyle(Tinte.tinta)
                    .listRowBackground(Color.clear)
            }
            if let digest = statoVisibile?.regiaDigest {
                Section("Il punto della situazione") {
                    Text(digest.text)
                        .font(.callout)
                        .textSelection(.enabled)
                    Text("\(digest.engine == "apple" ? "Apple Intelligence" : "Agnes") · \(Date(timeIntervalSince1970: digest.at / 1000).formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption)
                        .foregroundStyle(Tinte.tinta)
                }
                .listRowBackground(Tinte.notteFonda.opacity(0.7))
            }
            if let stato = statoVisibile, stato.quadroLavori != nil || stato.attivita != nil {
                QuadroLavoriIPhone(conti: stato.conti,
                                  quadro: stato.quadroLavori ?? .init(progetti: [], giorni: []),
                                  attivita: QuadroAttivitaLavori(stato: stato), salvato: datoSalvato)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 14, trailing: 16))
                    .listRowBackground(Color.clear)
            }
            Section {
                Button {
                    if riassunto.stato == .fermo { avviaRacconto() }
                    else { riassunto.ferma() }
                } label: {
                    HStack(spacing: 10) {
                        Label(riassunto.stato == .fermo ? "Racconta con Melissa" : "Ferma Melissa",
                              systemImage: riassunto.stato == .fermo ? "waveform" : "stop.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Tinte.ambra)
                        Spacer()
                        if riassunto.stato != .fermo { ProgressView().tint(Tinte.ambra) }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(statoVisibile == nil && riassunto.stato == .fermo)

                if riassunto.stato != .fermo || !riassunto.testo.isEmpty || riassunto.errore != nil {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Melissa racconta")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Tinte.ambra)
                        Text(riassunto.errore ?? (riassunto.testo.isEmpty ? "Preparo il racconto e la voce…" : riassunto.testo))
                            .font(.callout)
                            .foregroundStyle(riassunto.errore == nil ? Tinte.testo : Tinte.rosso)
                            .textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .listRowBackground(Tinte.notteFonda.opacity(0.7))

            // il titolo dell'elenco, con il menu che decide come guardarlo: subito sopra le sessioni che cambia
            if statoVisibile != nil {
                testataSessioni
                    .listRowInsets(EdgeInsets(top: 10, leading: 20, bottom: 2, trailing: 8))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if righeVisibili.isEmpty {
                Text(messaggioVuoto)
                    .foregroundStyle(Tinte.tinta)
                    .listRowBackground(Color.clear)
            }
            if vistaPerProgetto && statoVisibile != nil {
                ForEach(gruppiPerProgetto, id: \.0) { gruppo in
                    Section {
                        ForEach(gruppo.1) { riga in
                            Button { apri(riga) } label: {
                                switch riga {
                                case .attivita(let a): RigaAttivita(attivita: a)
                                case .lavoro(let l): Riga(lavoro: l)
                                }
                            }
                            .listRowBackground(Tinte.notteFonda.opacity(0.7))
                        }
                    } header: {
                        HStack {
                            Text(gruppo.0)
                            Spacer()
                            Text("\(gruppo.1.count)")
                        }
                        .textCase(nil)
                    }
                }
            } else if statoVisibile?.attivita != nil {
                ForEach(gruppiAttivita, id: \.0) { g in
                    Section(g.0) {
                        if g.0 == "Stato non confermato" {
                            Text("Il registro conserva l'attività, ma non prova che la sessione sia ancora aperta. Non richiede una tua conferma.")
                                .font(.caption)
                                .foregroundStyle(Tinte.tinta)
                                .listRowBackground(Color.clear)
                        }
                        ForEach(g.1) { a in
                            Button { apri(.attivita(a)) } label: {
                                RigaAttivita(attivita: a)
                            }
                            .listRowBackground(Tinte.notteFonda.opacity(0.7))
                        }
                    }
                }
            }
            if !vistaPerProgetto && !lavoriFiltrati.isEmpty {
                Section(statoVisibile?.attivita == nil ? "Sessioni Claude" : "Altri lavori Claude") {
                    ForEach(lavoriFiltrati) { l in
                        Button { scelta = .lavoro(l) } label: { Riga(lavoro: l) }
                            .listRowBackground(Tinte.notteFonda.opacity(0.7))
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .refreshable { await ponte.aggiornaStato() }
        .sheet(item: $scelta) { item in
            switch item {
            case .lavoro(let l):
                if ponte.linea == .collegato { SessioneView(ponte: ponte, lavoro: l) }
                else { SchedaLavoroSalvato(lavoro: l, ora: statoVisibile?.ora) }
            case .attivita(let a): SchedaAttivita(ponte: ponte, iniziale: a)
            }
        }
        .onChange(of: fase) { _, nuova in if nuova == .background { riassunto.ferma() } }
        .onDisappear { riassunto.ferma() }
        .onChange(of: scelta?.id) { _, nuova in if nuova != nil { riassunto.ferma() } }
    }

    // MARK: - come si guardano le sessioni

    /// Una sola barra resta in cima (Melissa, Lavori, Stanze): raggruppare e filtrare stanno in un menu accanto al
    /// titolo, con sotto una riga che dice la scelta di adesso. Toccare la riga apre lo stesso menu.
    private var testataSessioni: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Sessioni")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Tinte.testo)
                Menu { scelteVista } label: {
                    Text(fraseVista)
                        .font(.footnote)
                        .foregroundStyle(Tinte.tinta)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Vista delle sessioni: \(fraseVista)")
                .accessibilityHint("Apre le scelte per raggruppare e filtrare")
            }
            Spacer(minLength: 8)
            Menu { scelteVista } label: {
                // pieno e ambra quando non e' la vista di sempre (per progetto, da seguire)
                Image(systemName: vistaDiSempre ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                    .font(.title3)
                    .foregroundStyle(vistaDiSempre ? Tinte.tinta : Tinte.ambra)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Raggruppa e filtra le sessioni")
            .accessibilityValue(fraseVista)
        }
    }

    /// Le due scelte di sempre, a scelta singola: come raggruppare e cosa mostrare.
    @ViewBuilder private var scelteVista: some View {
        Section("Raggruppa") {
            Picker("Raggruppa", selection: $vistaPerProgetto) {
                Text("Per progetto").tag(true)
                Text("Per stato").tag(false)
            }
            .pickerStyle(.inline)
            .labelsHidden()
        }
        Section("Mostra") {
            Picker("Mostra", selection: $mostraTutte) {
                Text("Da seguire").tag(false)
                Text("Tutte").tag(true)
            }
            .pickerStyle(.inline)
            .labelsHidden()
        }
    }

    private var vistaDiSempre: Bool { vistaPerProgetto && !mostraTutte }

    /// «Per progetto · da seguire», «Per stato · tutte».
    private var fraseVista: String {
        "\(vistaPerProgetto ? "Per progetto" : "Per stato") · \(mostraTutte ? "tutte" : "da seguire")"
    }

    /// La lettura usa lo snapshot gia' sul telefono, con priorita' a cio' che richiede Andrea.
    /// Un contesto corto permette di cominciare il testo e la voce senza una nuova richiesta al Mac.
    private func avviaRacconto() {
        guard let stato = statoVisibile else { return }
        let quando = Date(timeIntervalSince1970: stato.ora / 1000).formatted(date: .abbreviated, time: .shortened)
        let provenienza = datoSalvato
            ? "Ultimo stato salvato dal Mac alle \(quando). Il Mac non è collegato ora: descrivi solo ciò che era registrato allora, senza presentarlo come attività attuale."
            : "Stato dei Lavori letto dal Mac alle \(quando)."
        var righe = ["\(provenienza) Racconta prima le sessioni che aspettano Andrea, poi quelle in corso, gli errori e le finite recenti."]
        if let attivita = stato.attivita {
            let conteggi = stato.conteggiAttivita
            righe.append("\(conteggi.totale) sessioni osservate: \(conteggi.tiAspetta) in attesa, \(conteggi.inCorso) in corso, \(attivita.filter { $0.status == "errore" }.count) in errore.")
            let priorita = ["ti aspetta": 0, "errore": 1, "in corso": 2, "sconosciuto": 3, "finito": 4]
            let ordinate = attivita.sorted {
                let sinistra = priorita[$0.status] ?? 3
                let destra = priorita[$1.status] ?? 3
                return sinistra == destra ? $0.updatedAt > $1.updatedAt : sinistra < destra
            }
            let attuali = ordinate.filter { $0.status != "finito" }
            let recenti = ordinate.filter { $0.status == "finito" }.prefix(6)
            let selezionate = Array((attuali + Array(recenti)).prefix(20))
            for a in selezionate {
                let testo = [a.fonte, a.project, a.status, a.title, a.summary ?? ""]
                    .map { String($0.replacingOccurrences(of: "\n", with: " ").prefix(180)) }
                    .joined(separator: " | ")
                righe.append("- \(testo)")
            }
            if attivita.count > selezionate.count {
                righe.append("Altre \(attivita.count - selezionate.count) sessioni sono nel registro, non descritte qui.")
            }
        } else {
            righe.append("\(stato.lavori.count) sessioni Claude nel vecchio registro.")
            for l in stato.lavori.prefix(12) {
                righe.append("- Claude Code | \(l.progetto) | \(l.stato) | \(String(l.titolo.prefix(180)))")
            }
        }
        riassunto.avvia(titolo: "i lavori e le sessioni osservate", contesto: String(righe.joined(separator: "\n").prefix(5_000)))
    }

    private var lavori: [StatoMac.Lavoro] { statoVisibile?.lavori ?? [] }

    private var attivita: [StatoMac.Attivita] { statoVisibile?.attivita ?? [] }

    private var lavoriNonRappresentati: [StatoMac.Lavoro] {
        guard statoVisibile?.attivita != nil else { return lavori }
        let chiavi = Set(attivita.map(\.key))
        return lavori.filter { $0.activityKey.map { !chiavi.contains($0) } ?? true }
    }

    private let statiDaSeguire: Set<String> = ["ti aspetta", "errore", "in corso", "in coda", "stanotte", "nel terminale"]

    private var attivitaFiltrate: [StatoMac.Attivita] {
        mostraTutte ? attivita : attivita.filter { statiDaSeguire.contains($0.status) }
    }

    private var lavoriFiltrati: [StatoMac.Lavoro] {
        mostraTutte ? lavoriNonRappresentati : lavoriNonRappresentati.filter { statiDaSeguire.contains($0.stato) }
    }

    private var righeVisibili: [Selezione] {
        attivitaFiltrate.map { .attivita($0) } + lavoriFiltrati.map { .lavoro($0) }
    }

    private var gruppiPerProgetto: [(String, [Selezione])] {
        let ordine = ["ti aspetta", "errore", "in corso", "in coda", "stanotte", "nel terminale", "sconosciuto", "finito"]
        let nomi = ProgettoLavori.etichette(righeVisibili.map(\.identitaProgetto))
        let gruppi = Dictionary(grouping: righeVisibili, by: { $0.identitaProgetto.id })
        return gruppi.map { id, righe in
            let nome = nomi[id] ?? "Progetto non indicato"
            return (nome, righe.sorted {
                let a = ordine.firstIndex(of: $0.stato) ?? ordine.count
                let b = ordine.firstIndex(of: $1.stato) ?? ordine.count
                return a == b ? $0.aggiornato > $1.aggiornato : a < b
            })
        }.sorted {
            let a = ordine.firstIndex(of: $0.1[0].stato) ?? ordine.count
            let b = ordine.firstIndex(of: $1.1[0].stato) ?? ordine.count
            return a == b ? $0.0.localizedStandardCompare($1.0) == .orderedAscending : a < b
        }
    }

    private func apri(_ riga: Selezione) {
        switch riga {
        case .lavoro(let l): scelta = .lavoro(l)
        case .attivita(let a):
            if let l = lavori.first(where: { $0.activityKey == a.key }) { scelta = .lavoro(l) }
            else { scelta = .attivita(a) }
        }
    }

    private var messaggioVuoto: String {
        guard let s = statoVisibile else { return "Aspetto il primo registro dal Mac…" }
        if !mostraTutte && (s.attivita != nil || !s.lavori.isEmpty) { return "Nessun agente richiede attenzione adesso. Tocca «Tutte» per vedere il registro." }
        if s.attivita != nil { return "Nessuna attività osservata dal Mac." }
        return "Nessuna sessione Claude rilevata. Aggiorna la Bottega sul Mac per vedere anche Codex, Cline e i terminali."
    }

    private var gruppiAttivita: [(String, [StatoMac.Attivita])] {
        let ordine: [(String, String)] = [("ti aspetta", "Ti aspetta"), ("in corso", "In corso"),
                                          ("sconosciuto", "Stato non confermato"), ("errore", "Errore"),
                                          ("finito", "Finite")]
        let righe = attivitaFiltrate.sorted { $0.updatedAt > $1.updatedAt }
        let noti = Set(ordine.map(\.0))
        var gruppi = ordine.compactMap { stato, titolo -> (String, [StatoMac.Attivita])? in
            let elementi = righe.filter { $0.status == stato }
            return elementi.isEmpty ? nil : (titolo, elementi)
        }
        let altri = righe.filter { !noti.contains($0.status) }
        if !altri.isEmpty { gruppi.append(("Altre attività", altri)) }
        return gruppi
    }

    private var gruppi: [(String, [StatoMac.Lavoro])] {
        let ordine = ["ti aspetta", "in corso", "nel terminale", "in coda", "stanotte"]
        return ordine.compactMap { s in
            let l = lavori.filter { $0.stato == s }
            return l.isEmpty ? nil : (s.prefix(1).uppercased() + s.dropFirst(), l)
        }
    }
}

/// Deriva i KPI dal medesimo registro autorevole usato da lista, Home e widget.
struct QuadroAttivitaLavori {
    let inCorso: Int
    let tiAspetta: Int
    let errori: Int
    let sconosciute: Int
    let finite: Int
    let progetti: [StatoMac.QuadroLavori.Progetto]

    var statiDaSeguire: [(String, Int)] {
        [("Ti aspettano", tiAspetta), ("In corso", inCorso),
         ("Errori", errori), ("Non confermate", sconosciute)]
    }

    init?(stato: StatoMac) {
        guard stato.attivita != nil else { return nil }
        let righe = stato.sessioniWidget
        inCorso = righe.filter { $0.stato == "in corso" }.count
        tiAspetta = righe.filter { $0.stato == "ti aspetta" }.count
        errori = righe.filter { $0.stato == "errore" }.count
        sconosciute = righe.filter { $0.stato == "sconosciuto" }.count
        finite = righe.filter { $0.stato == "finito" }.count
        let attive = righe.filter(\.attiva)
        let identita = attive.map { ProgettoLavori(nome: $0.progetto, path: $0.path) }
        let nomi = ProgettoLavori.etichette(identita)
        progetti = Dictionary(grouping: identita, by: \.id)
            .map { StatoMac.QuadroLavori.Progetto(nome: nomi[$0.key]!, conteggio: $0.value.count) }
            .sorted { $0.conteggio != $1.conteggio ? $0.conteggio > $1.conteggio : $0.nome < $1.nome }
            .prefix(5).map { $0 }
    }
}

private struct QuadroLavoriIPhone: View {
    let conti: StatoMac.Conti
    let quadro: StatoMac.QuadroLavori
    let attivita: QuadroAttivitaLavori?
    let salvato: Bool

    private var stati: [(String, Int)] {
        if let a = attivita {
            return a.statiDaSeguire
        }
        return [("Ti aspettano", conti.tiAspetta), ("In corso", conti.inCorso),
         ("Nel terminale", conti.nelTerminale ?? 0), ("In coda", conti.inCoda),
         ("Stanotte", conti.stanotte ?? 0)]
    }

    private var progetti: [StatoMac.QuadroLavori.Progetto] { attivita?.progetti ?? quadro.progetti }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            RiquadroStanza(titolo: attivita == nil ? "Lavori Claude Code" : "Attività di tutte le fonti") {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 14) {
                    Cifra(etichetta: "Ti aspettano", valore: "\(attivita?.tiAspetta ?? conti.tiAspetta)", colore: Tinte.ambra)
                    Cifra(etichetta: "In corso", valore: "\(attivita?.inCorso ?? conti.inCorso)")
                    if let a = attivita {
                        Cifra(etichetta: "Errori", valore: "\(a.errori)")
                        Cifra(etichetta: "Non confermate", valore: "\(a.sconosciute)")
                    } else {
                        Cifra(etichetta: "In coda", valore: "\(conti.inCoda)")
                        Cifra(etichetta: "Stanotte", valore: "\(conti.stanotte ?? 0)")
                    }
                }
            }
            if attivita != nil {
                RiquadroStanza(titolo: "Programmati con Claude Code") {
                    HStack(alignment: .top, spacing: 12) {
                        Cifra(etichetta: "In coda", valore: "\(conti.inCoda)")
                        Cifra(etichetta: "Stanotte", valore: "\(conti.stanotte ?? 0)")
                    }
                }
            }
            RiquadroStanza(titolo: attivita == nil ? "Stato dei lavori Claude Code" : "Stato delle attività · tutte le fonti", nota: salvato ? "Ultimo registro" : "Adesso") {
                barre(stati, colore: Tinte.ambra)
                if let a = attivita {
                    Text("\(a.finite) sessioni finite nel registro")
                        .font(.caption)
                        .foregroundStyle(Tinte.tinta)
                }
            }
            if !progetti.isEmpty {
                RiquadroStanza(titolo: attivita == nil ? "Progetti con Claude Code" : "Progetti impegnati · tutte le fonti", nota: "In corso o in attesa") {
                    barre(progetti.map { ($0.nome, $0.conteggio) }, colore: Tinte.verde)
                }
            }
            if quadro.giorni.count == 7 {
                RiquadroStanza(titolo: "Sessioni per ultimo aggiornamento", nota: salvato ? "Ultimo registro" : "Ultimi 7 giorni") {
                    Text("\(quadro.giorni.reduce(0) { $0 + $1.conteggio }) sessioni nel registro")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Tinte.testo)
                    Text("Ogni sessione compare nel giorno del suo ultimo aggiornamento. Claude Code, Cline, Codex e terminali.")
                        .font(.caption2)
                        .foregroundStyle(Tinte.tinta)
                    Text("Sette giorni fino al \(Formati.chiaveDetta(quadro.giorni[6].data)).")
                        .font(.caption2)
                        .foregroundStyle(Tinte.tinta)
                    Chart(quadro.giorni, id: \.data) { giorno in
                        if let data = Formati.data(giorno.data) {
                            BarMark(x: .value("Giorno", data, unit: .day), y: .value("Attività", giorno.conteggio))
                                .foregroundStyle(Tinte.ambra)
                        }
                    }
                    .chartLegend(.hidden)
                    .environment(\.locale, Formati.it)
                    .frame(height: 150)
                    .accessibilityLabel("Attività osservate per giorno: " + quadro.giorni.map { "\(Formati.chiaveDetta($0.data)): \($0.conteggio)" }.joined(separator: ", "))
                }
            }
        }
    }

    private func barre(_ righe: [(String, Int)], colore: Color) -> some View {
        let massimo = max(1, righe.map(\.1).max() ?? 0)
        return VStack(spacing: 10) {
            ForEach(righe.indices, id: \.self) { indice in
                let (nome, valore) = righe[indice]
                HStack(spacing: 8) {
                    Text(nome).font(.caption).foregroundStyle(Tinte.tinta)
                        .lineLimit(3).frame(width: 130, alignment: .leading)
                    GeometryReader { area in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 3).fill(Tinte.notte)
                            RoundedRectangle(cornerRadius: 3).fill(colore)
                                .frame(width: area.size.width * CGFloat(max(0, valore)) / CGFloat(massimo))
                        }
                    }
                    .frame(height: 10)
                    Text("\(valore)").font(.caption.weight(.semibold)).monospacedDigit()
                        .foregroundStyle(Tinte.testo)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(nome): \(valore) \(valore == 1 ? "lavoro" : "lavori")")
            }
        }
    }
}

struct SchedaLavoroSalvato: View {
    let lavoro: StatoMac.Lavoro
    let ora: Double?
    @Environment(\.dismiss) private var chiudi

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    RaccontoView(titolo: "la sessione salvata di \(lavoro.progetto)") {
                        ContestoRacconto.lavoroSalvato(lavoro, ora: ora)
                    }
                }
                Section("Ultimo registro") {
                    if let ora {
                        Text("Ricevuto dal Mac alle \(Date(timeIntervalSince1970: ora / 1000).formatted(date: .abbreviated, time: .shortened)). Il lavoro potrebbe essere cambiato.")
                    }
                }
                Section("Sessione Claude Code") {
                    LabeledContent("Progetto", value: lavoro.progetto)
                    LabeledContent("Stato registrato", value: lavoro.stato)
                    Text(lavoro.titolo)
                }
            }
            .navigationTitle(lavoro.progetto)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Chiudi") { chiudi() } } }
        }
        .tint(Tinte.ambra)
    }
}

private struct RigaAttivita: View {
    let attivita: StatoMac.Attivita

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(attivita.status == "ti aspetta" ? Tinte.ambra : attivita.status == "in corso" ? Tinte.verde : Tinte.tinta)
                .frame(width: 9, height: 9)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                Text("\(attivita.fonte) · \(attivita.project)")
                    .font(.headline)
                    .foregroundStyle(Tinte.testo)
                Text(attivita.title)
                    .font(.subheadline)
                    .foregroundStyle(Tinte.tinta)
                    .lineLimit(2)
                if let summary = attivita.summary, !summary.isEmpty {
                    Text(summary)
                        .font(.caption)
                        .foregroundStyle(Tinte.testo.opacity(0.82))
                        .lineLimit(2)
                }
                Text("\(attivita.status.capitalized) · \(Date(timeIntervalSince1970: attivita.updatedAt / 1000).formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption2)
                    .foregroundStyle(Tinte.tinta.opacity(0.8))
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(Tinte.tinta)
        }
        .padding(.vertical, 4)
    }
}

struct SchedaAttivita: View {
    let ponte: Ponte
    let iniziale: StatoMac.Attivita
    @Environment(\.dismiss) private var chiudi
    @State private var ultima: StatoMac.Attivita?

    /// La selezione della lista e' uno snapshot. Gli eventi del ponte aggiornano questa scheda
    /// anche mentre resta aperta, senza una seconda connessione per ogni sessione.
    private var attivitaCorrente: StatoMac.Attivita? {
        ponte.stato?.attivita?.first { $0.key == iniziale.key }
    }

    private var attivita: StatoMac.Attivita { attivitaCorrente ?? ultima ?? iniziale }

    private var scomparsa: Bool {
        ponte.linea == .collegato && ponte.stato?.attivita != nil && attivitaCorrente == nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    RaccontoView(titolo: "la sessione \(attivita.fonte) di \(attivita.project)") {
                        ContestoRacconto.attivita(attivita, salvata: scomparsa || ponte.linea != .collegato)
                    }
                }
                if scomparsa {
                    Section {
                        Text("Questa sessione non compare più nel registro attuale del Mac. Qui vedi l'ultimo stato ricevuto.")
                            .foregroundStyle(Tinte.ambra)
                    }
                } else if ponte.linea != .collegato {
                    Section {
                        Text("Il Mac non è collegato ora. Qui vedi l'ultimo stato ricevuto.")
                            .foregroundStyle(Tinte.tinta)
                    }
                }
                Section("Stato") {
                    LabeledContent("Fonte", value: attivita.fonte)
                    LabeledContent("Progetto", value: attivita.project)
                    LabeledContent("Stato", value: attivita.status.capitalized)
                    LabeledContent("Ultimo aggiornamento", value: Date(timeIntervalSince1970: attivita.updatedAt / 1000).formatted(date: .abbreviated, time: .shortened))
                }
                Section("Attività") {
                    Text(attivita.title)
                    if let summary = attivita.summary, !summary.isEmpty { Text(summary) }
                }
                if let passi = attivita.steps, !passi.isEmpty {
                    Section("Ultimi passi osservati") {
                        ForEach(Array(passi.enumerated()), id: \.offset) { _, passo in
                            Text(passo)
                        }
                    }
                }
                if let evidenza = attivita.evidence, !evidenza.isEmpty {
                    Section("Origine dello stato") { Text(evidenza) }
                }
                Section { Text("Lo stato è stato osservato dal Mac all'ora indicata. Apri la sessione sul Mac per vedere i dettagli o intervenire.") }
            }
            .refreshable { await ponte.aggiornaStato() }
            .navigationTitle(attivita.fonte)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fatto") { chiudi() } } }
        }
        .onChange(of: attivitaCorrente, initial: true) { _, nuova in
            if let nuova { ultima = nuova }
        }
    }
}

private struct Riga: View {
    let lavoro: StatoMac.Lavoro

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(lavoro.stato == "ti aspetta" ? Tinte.ambra : lavoro.stato == "in corso" ? Tinte.verde : Tinte.tinta)
                .frame(width: 9, height: 9)
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                Text(lavoro.progetto)
                    .font(.headline)
                    .foregroundStyle(Tinte.testo)
                Text(lavoro.titolo)
                    .font(.subheadline)
                    .foregroundStyle(Tinte.tinta)
                    .lineLimit(2)
                Text(dettaglio)
                    .font(.caption)
                    .foregroundStyle(Tinte.tinta.opacity(0.8))
            }
            Spacer()
            if lavoro.jobId != nil {
                Image(systemName: "text.bubble")
                    .foregroundStyle(Tinte.ambra)
                    .padding(.top, 4)
            }
        }
        .padding(.vertical, 4)
    }

    private var dettaglio: String {
        let minuti = max(0, Int((Date().timeIntervalSince1970 * 1000 - lavoro.da) / 60_000))
        let quando = minuti < 1 ? "adesso" : minuti < 60 ? "da \(minuti) min" : "da \(minuti / 60) h \(minuti % 60) min"
        return "\(lavoro.origine == "bottega" ? "Lavoro della Bottega" : "Aperta altrove"), \(quando)"
    }
}

struct ScriviLavoroView: View {
    let ponte: Ponte
    let lavoro: StatoMac.Lavoro
    @Environment(\.dismiss) private var chiudi
    @State private var testo = ""
    @State private var errore: String?
    @State private var invio = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Cosa deve fare Claude", text: $testo, axis: .vertical)
                        .lineLimit(3...8)
                } header: {
                    Text(lavoro.titolo)
                } footer: {
                    Text(errore ?? "Il testo arriva nel terminale del lavoro sul Mac, come se lo scrivessi tu.")
                        .foregroundStyle(errore == nil ? Tinte.tinta : Tinte.rosso)
                }
            }
            .navigationTitle(lavoro.progetto)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { chiudi() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Manda") {
                        Task {
                            invio = true
                            do {
                                try await ponte.scriviLavoro(lavoro.jobId ?? "", testo)
                                chiudi()
                            } catch {
                                errore = error.localizedDescription
                            }
                            invio = false
                        }
                    }
                    .disabled(testo.trimmingCharacters(in: .whitespaces).isEmpty || invio)
                }
            }
        }
    }
}
