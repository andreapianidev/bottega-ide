//
//  SchedaAppView.swift
//  Bottega per iPhone
//
//  La scheda di un'app della stanza App Store (GET /v1/stanza?nome=appstore&app=<chiave>, docs/CONTRATTI.md 9.7):
//  le sue cifre e i suoi grafici con le versioni uscite segnate, i suoi buchi con le azioni, gli annunci per formato
//  (riempimento, mostrati, ogni mille) e per unita', gli acquisti, le versioni, cosa c'e' nel codice, gli abbonati e
//  la sua scheda dello Store. Come la riga aperta di «App per app» sul Mac, con in piu' i grafici solo suoi.
//

import SwiftUI

struct SchedaAppView: View {
    let ponte: Ponte
    let app: StanzaAppStore.App
    @State private var periodo: String
    @State private var lettura = LetturaStanza<StanzaAppStore>("appstore")
    @State private var azioni = AzioniAppStore()
    @State private var rilettura: Task<Void, Never>?

    init(ponte: Ponte, app: StanzaAppStore.App, periodo: String) {
        self.ponte = ponte
        self.app = app
        _periodo = State(initialValue: periodo)
    }

    private var query: [String: String] { ["periodo": periodo, "app": app.chiave] }
    private var attivo: Bool { lettura.errore == nil && lettura.dati != nil }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Periodo", selection: $periodo) {
                ForEach(AppStoreView.periodi, id: \.0) { Text($0.1).tag($0.0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            CorniceStanza(lettura: lettura, query: query, datiDelMac: { $0.aggiornatoAt }) { d in
                contenuto(d)
            }
        }
        .background(Tinte.sfondo.ignoresSafeArea())
        .navigationTitle(app.nome)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) { BannerEsito(azioni: azioni) }
        .animation(.easeOut(duration: 0.2), value: azioni.esito)
        .onDisappear { rilettura?.cancel() }
    }

    @ViewBuilder
    private func contenuto(_ d: StanzaAppStore) -> some View {
        let x = d.dettaglio
        TestaAppStore(d: d, nomeApp: x?.nome ?? app.nome)
        if let x { Intestazione(ponte: ponte, x: x) }
        SezioneAllarmi(allarmi: d.allarmi ?? [])
        CifreAppStore(d: d)
        SezioneGrafici(d: d)
        SezioneBuchi(ponte: ponte, d: d, attivo: attivo, azioni: azioni, verifica: verifica, ricarica: ricarica, titolo: "Da sistemare in \(x?.nome ?? app.nome)")
        if let x { SezioneAnnunci(x: x) }
        if let a = d.abbonamenti { SezioneAbbonati(a: a) }
        if let s = d.scheda { SezioneScheda(s: s) }
        if let x { SezioneVersioniCodice(x: x) }
        SezioneErroriAppStore(e: d.errori)
    }

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

// MARK: - intestazione

/// Piattaforma, progetto (un tocco apre la sessione, se ce n'e' una), e quello che AdMob dice dell'app.
private struct Intestazione: View {
    let ponte: Ponte
    let x: StanzaAppStore.Dettaglio

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(x.piattaforma == "android" ? "Android" : "iOS")
                if let b = x.bundleId { Text(b).lineLimit(1).truncationMode(.middle) }
            }
            .font(.caption)
            .foregroundStyle(Tinte.tinta)
            if let p = x.progetto {
                ConSessione(ponte: ponte, progetto: p) {
                    Label("Progetto \(p)", systemImage: "folder").font(.caption).foregroundStyle(Tinte.testo)
                }
            } else {
                Text("Nessun progetto sul Mac collegato a questa app.").font(.caption).foregroundStyle(Tinte.tinta)
            }
            if x.suAdmob == true, let s = x.approvazione, s != "APPROVED" {
                Label("AdMob non ha approvato l'app (\(s.lowercased().replacingOccurrences(of: "_", with: " "))).", systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(Tinte.ambra)
            }
            if x.suAdmob == true, x.collegata == false {
                Label("L'app di AdMob non è collegata alla sua scheda dello Store.", systemImage: "link")
                    .font(.caption)
                    .foregroundStyle(Tinte.ambra)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - annunci

private struct SezioneAnnunci: View {
    let x: StanzaAppStore.Dettaglio

    var body: some View {
        RiquadroStanza(titolo: "Annunci", nota: "ultimi 30 giorni") {
            if x.formati.isEmpty {
                Text(x.suAdmob == true ? "Nessuna richiesta di annunci negli ultimi 30 giorni." : "Questa app non è su AdMob.")
                    .font(.callout)
                    .foregroundStyle(Tinte.tinta)
            }
            ForEach(x.formati) { f in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(CalcoliAppStore.formato(f.formato).capitalized(with: CalcoliAppStore.it)).font(.callout.weight(.medium)).foregroundStyle(Tinte.testo)
                        Spacer()
                        Text(Formati.euro(f.euro)).font(.callout.weight(.semibold)).monospacedDigit().foregroundStyle(Tinte.testo)
                    }
                    HStack(alignment: .top, spacing: 10) {
                        misura("Trovano un annuncio", CalcoliAppStore.riempimento(f), basso: 0.6)
                        misura("Mostrati", CalcoliAppStore.mostrati(f), basso: nil)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Ogni mille").font(.caption2).foregroundStyle(Tinte.tinta)
                            Text(CalcoliAppStore.ecpm(euro: f.euro, impressioni: f.impressioni).map { Formati.euro($0) } ?? "n/d")
                                .font(.callout.weight(.semibold)).monospacedDigit().foregroundStyle(Tinte.testo)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Text("\(Formati.numero(f.richieste)) richieste, \(Formati.numero(f.impressioni)) impressioni, \(Formati.numero(f.clic)) clic")
                        .font(.caption2)
                        .foregroundStyle(Tinte.tinta)
                }
                if f.id != x.formati.last?.id { Divider().overlay(Tinte.bordo) }
            }
            if !x.unita.isEmpty {
                Text("Per unità").font(.caption.weight(.semibold)).foregroundStyle(Tinte.testo).padding(.top, 4)
                ForEach(x.unita) { u in
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(u.nome).font(.caption).foregroundStyle(Tinte.testo).lineLimit(1)
                            Text("\(CalcoliAppStore.formato(u.formato)), \(Formati.numero(u.richieste)) richieste")
                                .font(.caption2)
                                .foregroundStyle(u.richieste == 0 ? Tinte.ambra : Tinte.tinta)
                        }
                        Spacer()
                        Text(Formati.euro(u.euro)).font(.caption).monospacedDigit().foregroundStyle(Tinte.testo)
                    }
                }
            }
            if let a = x.acquisti, a.nuovi + a.rinnovi + a.altri + a.euro > 0 {
                Divider().overlay(Tinte.bordo)
                Text(fraseAcquisti(a)).font(.caption).foregroundStyle(Tinte.testo)
            }
        }
    }

    private func misura(_ titolo: String, _ q: Double?, basso: Double?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(titolo).font(.caption2).foregroundStyle(Tinte.tinta)
            Text(q.map { CalcoliAppStore.quota($0) } ?? "n/d")
                .font(.callout.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(q.flatMap { v in basso.map { v < $0 } } == true ? Tinte.ambra : Tinte.testo)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func fraseAcquisti(_ a: StanzaAppStore.Acquisti) -> String {
        var p: [String] = []
        if a.nuovi > 0 { p.append("\(Formati.numero(a.nuovi)) abbonamenti nuovi") }
        if a.rinnovi > 0 { p.append("\(Formati.numero(a.rinnovi)) rinnovi") }
        if a.altri > 0 { p.append("\(Formati.numero(a.altri)) altri acquisti") }
        return "Negli ultimi 30 giorni: \(p.isEmpty ? "nessun acquisto" : p.joined(separator: ", ")), \(Formati.euro(a.euro)) netti dallo Store."
    }
}

// MARK: - versioni e codice

private struct SezioneVersioniCodice: View {
    let x: StanzaAppStore.Dettaglio

    var body: some View {
        RiquadroStanza(titolo: "Versioni e codice") {
            if x.versioni.isEmpty {
                Text("Nessuna versione nuova negli ultimi due mesi, dai report di vendita.").font(.caption).foregroundStyle(Tinte.tinta)
            } else {
                Text("Uscite negli ultimi due mesi: " + x.versioni.map { "\($0.v) il \(CalcoliAppStore.dataBreve($0.quando))" }.joined(separator: ", ") + ".")
                    .font(.caption)
                    .foregroundStyle(Tinte.testo)
            }
            if let c = x.codice {
                Divider().overlay(Tinte.bordo)
                VStack(alignment: .leading, spacing: 4) {
                    voce(c.sdk, "AdMob nel codice: \(c.sdk ? "sì" : "no")")
                    if c.sdk { voce(c.ump, "consenso UMP: \(c.ump ? "sì" : "no")") }
                    if x.piattaforma != "android" { voce(c.att && (c.attRichiesta ?? true), c.att && c.attRichiesta == false ? "ATT: c'è la frase, ma non viene mai chiesto" : "ATT: \(c.att ? "sì" : "no")") }
                    if x.piattaforma != "android" && c.sdk { voce(c.skan >= 10, "SKAdNetwork: \(Int(c.skan))") }
                    voce(c.storekit || c.revenuecat, "acquisti in-app: \(c.storekit || c.revenuecat ? "sì" : "no")")
                    if !c.formati.isEmpty { voce(true, "formati nel codice: " + c.formati.map(CalcoliAppStore.formato).joined(separator: ", ")) }
                    if let n = c.idProva, n > 0 { voce(false, "ID di prova di Google fuori da DEBUG in \(Int(n)) file") }
                }
                if let t = c.letteAt { Text("Codice letto \(Formati.fa(ms: t)).").font(.caption2).foregroundStyle(Tinte.tinta) }
            } else {
                Text(x.path == nil ? "Nessun progetto sul Mac collegato a questa app." : "Il codice non è ancora stato letto.").font(.caption).foregroundStyle(Tinte.tinta)
            }
        }
    }

    private func voce(_ si: Bool, _ testo: String) -> some View {
        Label {
            Text(testo).foregroundStyle(Tinte.testo)
        } icon: {
            Image(systemName: si ? "circle.fill" : "circle").foregroundStyle(si ? Tinte.verde : Tinte.ambra).font(.caption2)
        }
        .font(.caption)
    }
}
