//
//  AppStoreView.swift
//  Bottega per iPhone
//
//  La stanza App Store del Mac (docs/CONTRATTI.md, 13, 9.6 e 9.7), con tutto quello che mostra la plancia: la frase
//  in testa con l'ora dei dati, gli allarmi delle ultime 48 ore, le cifre con il confronto sul periodo prima, i
//  guadagni a barre impilate (AdMob sotto, Store sopra, gli stessi colori della plancia), i download, la tendenza,
//  «Dove intervenire» con le azioni del Mac, le app a confronto (un tocco apre la scheda dell'app, SchedaAppView),
//  gli abbonamenti, la scheda dello Store e i paesi dove rende AdMob. I pezzi stanno in Stanze/AppStore/.
//
//  Con il Mac spento resta l'ultimo dato visto con la sua eta' (CorniceStanza) e le azioni si spengono.
//

import SwiftUI

struct AppStoreView: View {
    let ponte: Ponte
    @State private var lettura = LetturaStanza<StanzaAppStore>("appstore")
    @State private var azioni = AzioniAppStore()
    @State private var periodo = "settimana"
    @State private var rilettura: Task<Void, Never>?

    static let periodi = [("ieri", "Ieri"), ("settimana", "Settimana"), ("mese", "Mese"), ("anno", "Anno")]

    private var query: [String: String] { ["periodo": periodo] }
    /// Il Mac ha risposto all'ultima lettura: le azioni si possono mandare.
    private var attivo: Bool { lettura.errore == nil && lettura.dati != nil }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Periodo", selection: $periodo) {
                ForEach(Self.periodi, id: \.0) { Text($0.1).tag($0.0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            CorniceStanza(lettura: lettura, query: query, datiDelMac: { $0.aggiornatoAt }) { d in
                contenuto(d)
            }
        }
        .safeAreaInset(edge: .bottom) { BannerEsito(azioni: azioni) }
        .animation(.easeOut(duration: 0.2), value: azioni.esito)
        .navigationDestination(for: StanzaAppStore.App.self) { a in
            SchedaAppView(ponte: ponte, app: a, periodo: periodo)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { Task { await verifica() } } label: {
                    if azioni.inCorso == "verifica" { ProgressView() } else { Image(systemName: "arrow.clockwise") }
                }
                .disabled(!attivo || azioni.inCorso != nil || lettura.dati?.aggiornando == true)
                .accessibilityLabel("Fai rileggere al Mac AdMob e App Store Connect")
            }
        }
        .onDisappear { rilettura?.cancel() }
    }

    @ViewBuilder
    private func contenuto(_ d: StanzaAppStore) -> some View {
        TestaAppStore(d: d)
        SezioneAllarmi(allarmi: d.allarmi ?? [])
        CifreAppStore(d: d)
        SezioneGrafici(d: d)
        SezioneBuchi(ponte: ponte, d: d, attivo: attivo, azioni: azioni, verifica: verifica, ricarica: ricarica)
        if !d.app.isEmpty { SezioneApp(d: d) }
        if let a = d.abbonamenti { SezioneAbbonati(a: a) }
        if let s = d.scheda { SezioneScheda(s: s) }
        SezionePaesi(paesi: d.paesi ?? [])
        SezioneErroriAppStore(e: d.errori)
        Text("AdMob è la stima di AdMob, in euro. Lo Store sono i ricavi netti dei report di vendita di Apple, portati in euro con i cambi del giorno; Apple pubblica le vendite di ieri verso le 14. I buchi sono regole scritte nel codice della Bottega, non un modello.")
            .font(.caption2)
            .foregroundStyle(Tinte.tinta)
    }

    /// «Verifica di nuovo»: il Mac rilegge tutto; la stanza si rilegge finche' il Mac ha finito (al massimo 3 minuti).
    private func verifica() async {
        guard await azioni.esegui("verifica") else { return }
        await ricarica()
        rilettura?.cancel()
        rilettura = Task {
            for _ in 0..<22 {
                try? await Task.sleep(for: .seconds(8))
                if Task.isCancelled { return }
                await lettura.carica(query)
                if lettura.dati?.aggiornando != true { return }
            }
        }
    }

    private func ricarica() async { await lettura.carica(query) }
}

// MARK: - le app

/// Il confronto tra le app (barre orizzontali, la piu' ricca in alto) e una riga per app: un tocco apre la sua scheda.
private struct SezioneApp: View {
    let d: StanzaAppStore

    var body: some View {
        RiquadroStanza(titolo: "App per app", nota: "tocca per la sua scheda") {
            GraficoConfronto(app: d.app)
            ForEach(d.app) { a in
                NavigationLink(value: a) { RigaApp(a: a) }
                    .buttonStyle(.plain)
                if a.id != d.app.last?.id { Divider().overlay(Tinte.bordo) }
            }
        }
    }
}

private struct RigaApp: View {
    let a: StanzaAppStore.App

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(a.nome).font(.callout.weight(.medium)).foregroundStyle(Tinte.testo)
                Text(sotto).font(.caption).foregroundStyle(Tinte.tinta).lineLimit(1)
                if let s = a.subito, s > 0 {
                    Text(s == 1 ? "una cosa da sistemare subito" : "\(Int(s)) cose da sistemare subito").font(.caption2).foregroundStyle(Tinte.rosso)
                }
            }
            Spacer(minLength: 6)
            if let v = a.andamento, v.count > 2 { Scintilla(valori: v) }
            VStack(alignment: .trailing, spacing: 2) {
                Text(Formati.euro(a.totale)).font(.callout.weight(.semibold)).monospacedDigit().foregroundStyle(Tinte.testo)
                if let t = CalcoliAppStore.delta(a.totale, a.totalePrima) { Text(t).font(.caption2).foregroundStyle(Tinte.tinta) }
            }
            Image(systemName: "chevron.right").font(.caption).foregroundStyle(Tinte.tinta)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Apre la scheda dell'app")
    }

    private var sotto: String {
        var p = [a.piattaforma == "android" ? "Android" : "iOS"]
        if let pr = a.progetto { p.append(pr) }
        p.append("\(Formati.numero(a.download)) download")
        if let ab = a.abbonati, ab > 0 { p.append("\(Formati.numero(ab)) abbonati") }
        return p.joined(separator: " · ")
    }
}
