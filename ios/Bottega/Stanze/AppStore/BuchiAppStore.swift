//
//  BuchiAppStore.swift
//  Bottega per iPhone
//
//  «Dove intervenire» sull'iPhone: i buchi della stanza App Store del Mac (docs/CONTRATTI.md, 13.3 e 9.7), ognuno con
//  perche', cosa fare, quanto vale, da quanto c'e' e com'e' andata dopo l'ultima versione; e le stesse azioni del Mac:
//  «Fallo sistemare a Claude» (il compito si legge e si corregge prima di partire), «Ignora» con il motivo, «Verifica di
//  nuovo», e in fondo risolti e ignorati con «Ripristina». Le azioni vanno al Mac con POST /v1/stanza/azione: con il
//  Mac spento restano spente e lo dicono.
//

import SwiftUI

/// Le azioni verso il Mac, una alla volta, con la frase che il Mac risponde.
@MainActor
@Observable
final class AzioniAppStore {
    struct Esito: Identifiable, Equatable {
        let id = UUID()
        let testo: String
        let errore: Bool
    }

    /// L'azione in corso: «verifica» o l'id del buco.
    private(set) var inCorso: String?
    var esito: Esito?

    /// Vero se il Mac ha fatto l'azione.
    @discardableResult
    func esegui(_ azione: String, id: String? = nil, motivo: String? = nil, compito: String? = nil) async -> Bool {
        guard inCorso == nil else { return false }
        inCorso = id ?? azione
        defer { inCorso = nil }
        var corpo = ["stanza": "appstore", "azione": azione]
        if let id { corpo["id"] = id }
        if let motivo { corpo["motivo"] = motivo }
        if let compito { corpo["compito"] = compito }
        do {
            let d = try await PonteStanze.shared.azione(corpo)
            let r = try JSONDecoder().decode(EsitoAzioneAppStore.self, from: d)
            esito = Esito(testo: r.messaggio, errore: !r.ok)
            return r.ok
        } catch is DecodingError {
            esito = Esito(testo: "La risposta del Mac non si legge: aggiorna la Bottega.", errore: true)
        } catch {
            esito = Esito(testo: error.localizedDescription, errore: true)
        }
        return false
    }
}

/// La frase del Mac dopo un'azione, in basso, per qualche secondo.
struct BannerEsito: View {
    let azioni: AzioniAppStore

    var body: some View {
        if let e = azioni.esito {
            Label {
                Text(e.testo).foregroundStyle(Tinte.testo)
            } icon: {
                Image(systemName: e.errore ? "exclamationmark.triangle" : "checkmark.circle").foregroundStyle(e.errore ? Tinte.ambra : Tinte.verde)
            }
            .font(.footnote)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Tinte.notteFonda))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(e.errore ? Tinte.ambra.opacity(0.6) : Tinte.bordo))
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .onTapGesture { azioni.esito = nil }
            .task(id: e.id) {
                try? await Task.sleep(for: .seconds(e.errore ? 7 : 5))
                if azioni.esito?.id == e.id { withAnimation { azioni.esito = nil } }
            }
            .sensoryFeedback(e.errore ? .warning : .success, trigger: e.id)
        }
    }
}

/// La frase per i tasti spenti.
let fraseMacSpento = "Serve il Mac acceso, con la Bottega aperta."

// MARK: - la sezione

struct SezioneBuchi: View {
    let ponte: Ponte
    let d: StanzaAppStore
    /// Vero se il Mac ha risposto all'ultima lettura: le azioni si possono mandare.
    let attivo: Bool
    let azioni: AzioniAppStore
    /// «Verifica di nuovo»: la stanza manda l'azione e poi rilegge finche' il Mac ha finito.
    let verifica: () async -> Void
    /// Dopo «Ignora» e «Ripristina» la stanza si rilegge subito.
    let ricarica: () async -> Void
    var titolo = "Dove intervenire"

    @State private var filtro = "tutti"
    @State private var tutti = false

    private var lista: [StanzaAppStore.Buco] {
        switch filtro {
        case "subito": d.buchi.filter { $0.gravita == "alta" }
        case "stima": d.buchi.filter { ($0.stima ?? 0) > 0 }.sorted { ($0.stima ?? 0) > ($1.stima ?? 0) }
        default: d.buchi
        }
    }

    var body: some View {
        let n = max(d.buchi.count, Int(d.buchiTotali))
        RiquadroStanza(titolo: titolo, nota: n == 0 ? nil : d.stimaTotale >= 1 ? "\(n), circa \(CalcoliAppStore.euro(d.stimaTotale, decimali: 0)) al mese" : "\(n)") {
            if d.buchi.isEmpty {
                Text("Niente da sistemare: annunci, consenso e codice sono in ordine.").font(.callout).foregroundStyle(Tinte.verde)
            } else {
                Picker("Quali", selection: $filtro) {
                    Text("Tutti \(d.buchi.count)").tag("tutti")
                    Text("Subito \(d.buchi.filter { $0.gravita == "alta" }.count)").tag("subito")
                    Text("Con stima \(d.buchi.filter { ($0.stima ?? 0) > 0 }.count)").tag("stima")
                }
                .pickerStyle(.segmented)
                Text("Dai numeri di AdMob, dello Store, degli abbonamenti e della scheda degli ultimi 30 giorni, e dal codice dei progetti. Le stime sono ordini di grandezza, non promesse.")
                    .font(.caption2)
                    .foregroundStyle(Tinte.tinta)
                let l = lista
                if l.isEmpty { Text("Nessuno in questo gruppo.").font(.callout).foregroundStyle(Tinte.tinta) }
                ForEach(tutti ? l : Array(l.prefix(8))) { b in
                    SchedaBuco(ponte: ponte, buco: b, attivo: attivo, azioni: azioni, verifica: verifica, ricarica: ricarica)
                    if b.id != (tutti ? l : Array(l.prefix(8))).last?.id { Divider().overlay(Tinte.bordo) }
                }
                if l.count > 8 {
                    Button(tutti ? "Mostra i primi otto" : "Mostra tutti e \(l.count)") { withAnimation(.easeOut(duration: 0.2)) { tutti.toggle() } }
                        .font(.footnote)
                }
                if n > d.buchi.count {
                    Text("Gli altri \(n - d.buchi.count) sono nella stanza App Store sul Mac.").font(.caption).foregroundStyle(Tinte.tinta)
                }
            }
            SezioneChiusi(d: d, attivo: attivo, azioni: azioni, ricarica: ricarica)
        }
    }
}

// MARK: - un buco

struct SchedaBuco: View {
    let ponte: Ponte
    let buco: StanzaAppStore.Buco
    let attivo: Bool
    let azioni: AzioniAppStore
    let verifica: () async -> Void
    let ricarica: () async -> Void

    @State private var aperto = false
    @State private var componi = false
    @State private var ignora = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.easeOut(duration: 0.2)) { aperto.toggle() } } label: {
                HStack(alignment: .top, spacing: 10) {
                    Pallino(colore: colore).padding(.top, 5)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(testa).font(.caption).foregroundStyle(Tinte.tinta)
                        Text(buco.titolo).font(.callout.weight(.medium)).foregroundStyle(Tinte.testo).multilineTextAlignment(.leading)
                        if !aperto {
                            Text("Cosa fare: \(buco.cosa)").font(.caption).foregroundStyle(Tinte.testo.opacity(0.85)).lineLimit(2).multilineTextAlignment(.leading)
                        }
                    }
                    Spacer(minLength: 4)
                    VStack(alignment: .trailing, spacing: 2) {
                        if let s = buco.stima, s >= 1 {
                            Text("≈ \(CalcoliAppStore.euro(s, decimali: s < 10 ? 2 : 0))").font(.callout.weight(.semibold)).monospacedDigit().foregroundStyle(Tinte.testo)
                            Text("al mese").font(.caption2).foregroundStyle(Tinte.tinta)
                        } else {
                            Text("senza stima").font(.caption2).foregroundStyle(Tinte.tinta)
                        }
                        Image(systemName: aperto ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(Tinte.tinta).padding(.top, 2)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(aperto ? "Chiude il dettaglio" : "Apre perché, cosa fare e le azioni")

            if aperto {
                VStack(alignment: .leading, spacing: 8) {
                    if let p = buco.perche { Text(p).foregroundStyle(Tinte.tinta) }
                    if let v = CalcoliAppStore.verifica(buco) {
                        Text(v)
                            .foregroundStyle(Tinte.testo)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 8).fill((buco.verifica?.esito == "risolto" || buco.verifica?.esito == "meglio" ? Tinte.verde : Tinte.tinta).opacity(0.12)))
                    }
                    Text("\(Text("Cosa fare.").fontWeight(.semibold)) \(buco.cosa)").foregroundStyle(Tinte.testo)
                    if let n = buco.stimaNota { Text("La stima: \(n)").foregroundStyle(Tinte.tinta) }
                    if let p = buco.progetto {
                        ConSessione(ponte: ponte, progetto: p) {
                            Label("Progetto \(p)", systemImage: "folder").foregroundStyle(Tinte.tinta)
                        }
                    }
                    tasti
                }
                .font(.caption)
                .padding(.leading, 19)
                .transition(.opacity)
            }
        }
        .sheet(isPresented: $componi) {
            ComposizioneLavoro(buco: buco, attivo: attivo, azioni: azioni)
        }
        .sheet(isPresented: $ignora) {
            IgnoraBuco(buco: buco, attivo: attivo, azioni: azioni, ricarica: ricarica)
        }
    }

    @ViewBuilder
    private var tasti: some View {
        let occupato = azioni.inCorso != nil
        VStack(alignment: .leading, spacing: 8) {
            if buco.compito != nil {
                Button { componi = true } label: {
                    Label("Fallo sistemare a Claude", systemImage: "hammer")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Tinte.ambra)
                .foregroundStyle(Tinte.notteFonda)
            }
            HStack(spacing: 8) {
                Button { ignora = true } label: { Text("Ignora").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
                Button {
                    Task { await verifica() }
                } label: {
                    HStack(spacing: 6) {
                        if azioni.inCorso == "verifica" { ProgressView().controlSize(.mini) }
                        Text("Verifica di nuovo")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .tint(Tinte.testo)
            if !attivo {
                Text(fraseMacSpento).foregroundStyle(Tinte.ambra)
            } else if buco.compito == nil {
                Text("Per farlo sistemare a Claude serve un progetto sul Mac collegato a questa app.").foregroundStyle(Tinte.tinta)
            }
        }
        .font(.footnote)
        .disabled(!attivo || occupato)
        .padding(.top, 2)
    }

    private var testa: String {
        var s = "\(CalcoliAppStore.gravita(buco.gravita)) · \(buco.app)"
        if let d = buco.daQuando { s += " · \(CalcoliAppStore.daQuando(ms: d))" }
        return s
    }

    private var colore: Color {
        switch buco.gravita {
        case "alta": Tinte.rosso
        case "media": Tinte.ambra
        default: Tinte.tinta
        }
    }
}

// MARK: - «Fallo sistemare a Claude»

/// Il compito gia' scritto dal buco, da leggere e correggere; parte solo con «Avvia».
struct ComposizioneLavoro: View {
    let buco: StanzaAppStore.Buco
    let attivo: Bool
    let azioni: AzioniAppStore
    @State private var testo: String
    @Environment(\.dismiss) private var chiudi

    init(buco: StanzaAppStore.Buco, attivo: Bool, azioni: AzioniAppStore) {
        self.buco = buco
        self.attivo = attivo
        self.azioni = azioni
        _testo = State(initialValue: buco.compito ?? "")
    }

    private var pulito: String { testo.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(buco.titolo).foregroundStyle(Tinte.testo)
                    if let p = buco.progetto { LabeledContent("Progetto", value: p) }
                    if let s = buco.stima, s >= 1 { LabeledContent("Vale circa", value: "\(CalcoliAppStore.euro(s, decimali: 0)) al mese") }
                } header: {
                    Text("Il punto da sistemare")
                }
                Section {
                    TextEditor(text: $testo)
                        .frame(minHeight: 200)
                        .font(.callout)
                } header: {
                    Text("Il compito per Claude")
                } footer: {
                    Text("Correggilo se vuoi, poi «Avvia». Il lavoro si apre nella Bottega sul Mac, nel progetto dell'app, e lo segui da Lavori. In fondo il Mac aggiunge: non fare git push, non pubblicare e non mandare niente in revisione.")
                }
                if !attivo {
                    Section { Text(fraseMacSpento).foregroundStyle(Tinte.ambra) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Tinte.sfondo.ignoresSafeArea())
            .navigationTitle("Fallo sistemare a Claude")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { chiudi() } }
                ToolbarItem(placement: .confirmationAction) {
                    if azioni.inCorso == buco.id {
                        ProgressView()
                    } else {
                        Button("Avvia") {
                            Task { if await azioni.esegui("lavoro", id: buco.id, compito: pulito) { chiudi() } }
                        }
                        .disabled(!attivo || pulito.isEmpty || azioni.inCorso != nil)
                    }
                }
            }
            .safeAreaInset(edge: .bottom) { BannerEsito(azioni: azioni) }
        }
        .tint(Tinte.ambra)
        .preferredColorScheme(.dark)
    }
}

// MARK: - «Ignora»

struct IgnoraBuco: View {
    let buco: StanzaAppStore.Buco
    let attivo: Bool
    let azioni: AzioniAppStore
    let ricarica: () async -> Void
    @State private var motivo = ""
    @FocusState private var fuoco: Bool
    @Environment(\.dismiss) private var chiudi

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(buco.titolo).foregroundStyle(Tinte.testo)
                    Text(buco.app).foregroundStyle(Tinte.tinta)
                }
                Section {
                    TextField("Per esempio: gli annunci con premio li offro solo a chi li vuole", text: $motivo, axis: .vertical)
                        .lineLimit(2...5)
                        .focused($fuoco)
                } header: {
                    Text("Perché lo lasci così")
                } footer: {
                    Text("Non comparirà più, né qui né sul Mac, finché non lo ripristini dagli ignorati.")
                }
                if !attivo {
                    Section { Text(fraseMacSpento).foregroundStyle(Tinte.ambra) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Tinte.sfondo.ignoresSafeArea())
            .navigationTitle("Ignora")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Annulla") { chiudi() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Ignora") {
                        Task {
                            let m = String(motivo.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300))
                            if await azioni.esegui("ignora", id: buco.id, motivo: m) {
                                chiudi()
                                await ricarica()
                            }
                        }
                    }
                    .disabled(!attivo || azioni.inCorso != nil)
                }
            }
            .onAppear { fuoco = true }
            .safeAreaInset(edge: .bottom) { BannerEsito(azioni: azioni) }
        }
        .presentationDetents([.medium, .large])
        .tint(Tinte.ambra)
        .preferredColorScheme(.dark)
    }
}

// MARK: - risolti e ignorati

struct SezioneChiusi: View {
    let d: StanzaAppStore
    let attivo: Bool
    let azioni: AzioniAppStore
    let ricarica: () async -> Void

    var body: some View {
        let risolti = d.risolti ?? []
        let ignorati = d.ignorati ?? []
        if !risolti.isEmpty {
            DisclosureGroup {
                ForEach(risolti) { b in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(b.app): \(b.titolo)").foregroundStyle(Tinte.testo)
                        Text(fraseRisolto(b)).foregroundStyle(Tinte.tinta)
                    }
                    .font(.caption)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 3)
                }
            } label: {
                Text("Risolti negli ultimi 60 giorni: \(risolti.count)").font(.footnote).foregroundStyle(Tinte.verde)
            }
        }
        if !ignorati.isEmpty {
            DisclosureGroup {
                ForEach(ignorati) { b in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(b.app): \(b.titolo)").foregroundStyle(Tinte.testo)
                            Text((b.motivo.map { "«\($0)», " } ?? "") + "ignorato il \(giorno(b.quando))").foregroundStyle(Tinte.tinta)
                        }
                        Spacer()
                        Button("Ripristina") {
                            Task { if await azioni.esegui("ripristina", id: b.id) { await ricarica() } }
                        }
                        .font(.caption)
                        .buttonStyle(.bordered)
                        .tint(Tinte.testo)
                        .disabled(!attivo || azioni.inCorso != nil)
                    }
                    .font(.caption)
                    .padding(.vertical, 3)
                }
                if !attivo { Text(fraseMacSpento).font(.caption).foregroundStyle(Tinte.ambra) }
            } label: {
                Text("Ignorati: \(ignorati.count)").font(.footnote).foregroundStyle(Tinte.tinta)
            }
        }
    }

    private func giorno(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(.dateTime.day().month(.abbreviated).locale(CalcoliAppStore.it))
    }

    private func fraseRisolto(_ b: StanzaAppStore.Chiuso) -> String {
        var s = "risolto il \(giorno(b.quando))"
        if let da = b.daQuando {
            let g = max(0, Int(((b.quando - da) / 86_400_000).rounded()))
            s += ", dopo " + (g == 0 ? "meno di un giorno" : g == 1 ? "un giorno" : "\(g) giorni")
        }
        if let p = b.prima, let q = b.dopo { s += ", dal \(CalcoliAppStore.quota(p)) al \(CalcoliAppStore.quota(q))" }
        return s
    }
}
