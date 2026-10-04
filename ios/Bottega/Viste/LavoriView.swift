//
//  LavoriView.swift
//  Bottega per iPhone
//
//  Tutte le attivita' osservate dal Mac: Claude Code, Cline, Codex e terminali. Le sessioni Claude
//  collegate a un lavoro conservano la scheda con le azioni; le altre hanno un dettaglio di sola lettura.
//

import SwiftUI

struct LavoriView: View {
    let ponte: Ponte
    @Environment(\.scenePhase) private var fase
    @State private var scelta: Selezione?
    @State private var riassunto = Riassunto()

    private enum Selezione: Identifiable {
        case lavoro(StatoMac.Lavoro)
        case attivita(StatoMac.Attivita)
        var id: String {
            switch self {
            case .lavoro(let l): "lavoro:\(l.id)"
            case .attivita(let a): "attivita:\(a.id)"
            }
        }
    }

    var body: some View {
        List {
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
                .disabled(ponte.stato == nil && riassunto.stato == .fermo)

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

            if attivita.isEmpty && lavoriNonRappresentati.isEmpty {
                Text(messaggioVuoto)
                    .foregroundStyle(Tinte.tinta)
                    .listRowBackground(Color.clear)
            }
            if ponte.stato?.attivita != nil {
                ForEach(gruppiAttivita, id: \.0) { g in
                    Section(g.0) {
                        if g.0 == "Stato non confermato" {
                            Text("Il registro conserva l'attività, ma non prova che la sessione sia ancora aperta. Non richiede una tua conferma.")
                                .font(.caption)
                                .foregroundStyle(Tinte.tinta)
                                .listRowBackground(Color.clear)
                        }
                        ForEach(g.1) { a in
                            Button {
                                if let l = lavori.first(where: { $0.activityKey == a.key }) {
                                    scelta = .lavoro(l)
                                } else {
                                    scelta = .attivita(a)
                                }
                            } label: {
                                RigaAttivita(attivita: a)
                            }
                            .listRowBackground(Tinte.notteFonda.opacity(0.7))
                        }
                    }
                }
            }
            if !lavoriNonRappresentati.isEmpty {
                Section(ponte.stato?.attivita == nil ? "Sessioni Claude" : "Altri lavori Claude") {
                    ForEach(lavoriNonRappresentati) { l in
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
            case .lavoro(let l): SessioneView(ponte: ponte, lavoro: l)
            case .attivita(let a): SchedaAttivita(attivita: a)
            }
        }
        .onChange(of: fase) { _, nuova in if nuova == .background { riassunto.ferma() } }
        .onDisappear { riassunto.ferma() }
    }

    /// La lettura usa lo snapshot gia' sul telefono, con priorita' a cio' che richiede Andrea.
    /// Un contesto corto permette di cominciare il testo e la voce senza una nuova richiesta al Mac.
    private func avviaRacconto() {
        guard let stato = ponte.stato else { return }
        let quando = Date(timeIntervalSince1970: stato.ora / 1000).formatted(date: .abbreviated, time: .shortened)
        var righe = ["Stato dei Lavori letto dal Mac alle \(quando). Racconta prima le sessioni che aspettano Andrea, poi quelle in corso, gli errori e le finite recenti."]
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

    private var lavori: [StatoMac.Lavoro] { ponte.stato?.lavori ?? [] }

    private var attivita: [StatoMac.Attivita] { ponte.stato?.attivita ?? [] }

    private var lavoriNonRappresentati: [StatoMac.Lavoro] {
        guard ponte.stato?.attivita != nil else { return lavori }
        let chiavi = Set(attivita.map(\.key))
        return lavori.filter { $0.activityKey.map { !chiavi.contains($0) } ?? true }
    }

    private var messaggioVuoto: String {
        guard let s = ponte.stato else { return "Aspetto il Mac…" }
        if s.attivita != nil { return "Nessuna attività osservata dal Mac." }
        return "Nessuna sessione Claude rilevata. Aggiorna la Bottega sul Mac per vedere anche Codex, Cline e i terminali."
    }

    private var gruppiAttivita: [(String, [StatoMac.Attivita])] {
        let ordine: [(String, String)] = [("ti aspetta", "Ti aspetta"), ("in corso", "In corso"),
                                          ("sconosciuto", "Stato non confermato"), ("errore", "Errore"),
                                          ("finito", "Finite")]
        let righe = attivita.sorted { $0.updatedAt > $1.updatedAt }
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

private struct SchedaAttivita: View {
    let attivita: StatoMac.Attivita
    @Environment(\.dismiss) private var chiudi

    var body: some View {
        NavigationStack {
            Form {
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
                Section { Text("Lo stato è stato osservato dal Mac all'ora indicata. Apri la sessione sul Mac per vedere i dettagli o intervenire.") }
            }
            .navigationTitle(attivita.fonte)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Fatto") { chiudi() } } }
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
