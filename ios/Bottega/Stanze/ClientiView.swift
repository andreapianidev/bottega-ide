//
//  ClientiView.swift
//  Bottega per iPhone
//
//  Le ore e gli importi del mese per cliente, come nella stanza Clienti del Mac (src/clienti.ts, docs/CONTRATTI.md,
//  9.6): ore arrotondate al quarto d'ora giorno per giorno, importo con la tariffa, i progetti fuori dai clienti.
//  I nomi dei clienti non restano sul disco dell'iPhone: la copia vive solo finche' l'app e' aperta.
//

import SwiftUI

struct ClientiView: View {
    let ponte: Ponte
    @State private var lettura = LetturaStanza<StanzaClienti>("clienti")
    /// "" = il mese in corso
    @State private var mese = ""
    @State private var richiestaSync = 0
    @State private var sincronizzando = false
    @State private var erroreSync: String?

    var body: some View {
        CorniceStanza(lettura: lettura, query: ["mese": mese]) { d in
            testata(d)
            if d.configurati == 0 {
                RiquadroStanza(titolo: "Nessun cliente") {
                    Text("I clienti si impostano nella stanza Clienti sul Mac, collegando i progetti a ogni cliente.")
                        .font(.callout)
                        .foregroundStyle(Tinte.tinta)
                }
            }
            ForEach(d.clienti) { c in
                RiquadroStanza(titolo: c.nome, nota: c.minuti > 0 ? "\(Int(c.giorni)) giorn\(c.giorni == 1 ? "o" : "i")" : nil) {
                    if c.minuti > 0 {
                        HStack(alignment: .top, spacing: 12) {
                            Cifra(etichetta: "Ore", valore: Formati.ore(c.minuti))
                            Cifra(etichetta: "Da fatturare", valore: c.importo.map { Formati.euro($0) } ?? "senza tariffa", colore: c.importo == nil ? Tinte.tinta : Tinte.ambra)
                        }
                        if let t = c.tariffa { Text("Tariffa \(Formati.euro(t)) l'ora").font(.caption).foregroundStyle(Tinte.tinta) }
                        ForEach(c.progetti) { p in
                            ConSessione(ponte: ponte, progetto: p.nome) {
                                HStack {
                                    Text(p.nome).font(.callout).foregroundStyle(Tinte.testo)
                                    Spacer()
                                    Text(Formati.ore(p.minuti)).font(.callout).monospacedDigit().foregroundStyle(Tinte.tinta)
                                }
                            }
                        }
                    } else {
                        Text("Nessuna ora questo mese.").font(.callout).foregroundStyle(Tinte.tinta)
                    }
                    if let stack = d.stack {
                        ForEach(stack.assets.filter { $0.clientId == c.id }) { asset in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(asset.name).font(.callout.weight(.semibold))
                                Text(asset.path ?? "Nessuna cartella locale").font(.caption).foregroundStyle(Tinte.tinta)
                                if let git = asset.git {
                                    Text("\(git.branch): \(git.changes) file modificati. \(git.ahead) commit avanti, \(git.behind) indietro rispetto all’ultimo fetch.")
                                        .font(.caption).foregroundStyle(Tinte.tinta)
                                }
                                if let repo = asset.repo, let u = linkStack("https://github.com/" + repo) {
                                    Link(repo, destination: u).font(.caption)
                                }
                                if let github = asset.github, github.pushedAt > 0 {
                                    Text("Ultimo push: \(Date(timeIntervalSince1970: github.pushedAt / 1000).formatted(date: .abbreviated, time: .shortened))")
                                        .font(.caption2).foregroundStyle(Tinte.tinta)
                                }
                                ForEach(asset.vercel) { v in
                                    if let u = linkStack(v.url) {
                                        Link("\(v.name): \(v.label)", destination: u).font(.caption)
                                    }
                                }
                            }
                            .padding(.top, 8)
                        }
                    }
                }
            }
            if let stack = d.stack {
                RiquadroStanza(titolo: "Sincronizzazione") {
                    Button { richiestaSync += 1 } label: {
                        Label(sincronizzando ? "Sincronizzazione in corso…" : "Sincronizza GitHub e Vercel", systemImage: "arrow.triangle.2.circlepath")
                    }
                    .disabled(sincronizzando || ponte.linea != .collegato)
                    if let erroreSync { Text(erroreSync).font(.caption).foregroundStyle(Tinte.rosso) }
                    if stack.githubAt > 0 { Text("GitHub: \(Date(timeIntervalSince1970: stack.githubAt / 1000).formatted(date: .abbreviated, time: .shortened))").font(.caption) }
                    if stack.vercelAt > 0 { Text("Vercel: \(Date(timeIntervalSince1970: stack.vercelAt / 1000).formatted(date: .abbreviated, time: .shortened))").font(.caption) }
                    if let e = stack.githubError { Text(e).font(.caption).foregroundStyle(Tinte.rosso) }
                    if let e = stack.vercelError { Text(e).font(.caption).foregroundStyle(Tinte.rosso) }
                    if stack.partial { Text("Inventario parziale").font(.caption).foregroundStyle(Tinte.ambra) }
                    if stack.assets.contains(where: { $0.conflict == true }) {
                        Text("Alcune associazioni sono in conflitto. Controlla i clienti sul Mac.").font(.caption).foregroundStyle(Tinte.ambra)
                    }
                }
            }
            if !d.fuori.isEmpty {
                RiquadroStanza(titolo: "Fuori dai clienti") {
                    ForEach(d.fuori) { p in
                        HStack {
                            Text(p.nome).font(.callout).foregroundStyle(Tinte.testo)
                            Spacer()
                            Text(Formati.ore(p.minuti)).font(.callout).monospacedDigit().foregroundStyle(Tinte.tinta)
                        }
                    }
                }
            }
            Text("Ore arrotondate al quarto d'ora, giorno per giorno.").font(.caption2).foregroundStyle(Tinte.tinta)
        }
        .task(id: richiestaSync) {
            guard richiestaSync > 0 else { return }
            sincronizzando = true
            erroreSync = nil
            defer { sincronizzando = false }
            let prima = lettura.dati?.stack
            do {
                _ = try await PonteStanze.shared.azione(["stanza": "clienti", "azione": "aggiorna"])
                for _ in 0..<12 {
                    try await Task.sleep(for: .seconds(3))
                    await lettura.carica(["mese": mese])
                    if let nuovo = lettura.dati?.stack,
                       nuovo.githubAt > (prima?.githubAt ?? 0), nuovo.vercelAt > (prima?.vercelAt ?? 0) { break }
                }
            } catch is CancellationError { } catch { erroreSync = error.localizedDescription }
        }
    }

    private func testata(_ d: StanzaClienti) -> some View {
        RiquadroStanza(titolo: Formati.chiaveDetta(d.mese).capitalized(with: Formati.it) + (d.inCorso ? ", fin qui" : "")) {
            HStack(alignment: .top, spacing: 12) {
                Cifra(etichetta: "Ore dei clienti", valore: Formati.ore(d.totale.minuti), grande: true)
                if let i = d.totale.importo {
                    Cifra(etichetta: "Da fatturare", valore: Formati.euro(i), grande: true, colore: Tinte.ambra)
                }
            }
            if d.mesi.count > 1 {
                Menu {
                    ForEach(d.mesi, id: \.self) { m in
                        Button(Formati.chiaveDetta(m)) { mese = m == d.mesi.first ? "" : m }
                    }
                } label: {
                    Label("Cambia mese", systemImage: "calendar").font(.footnote)
                }
            }
        }
    }
}
