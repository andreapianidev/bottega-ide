import SwiftUI

struct ProgettoVercel: Decodable, Identifiable {
    struct Commit: Decodable { let sha: String; let message: String; let ref: String? }
    let id: String
    let name: String
    let repo: String?
    let framework: String?
    let productionBranch: String?
    let localPaths: [String]
    let state: String
    let label: String
    let tone: String
    let at: Double
    let domain: String?
    let url: String
    let commit: Commit?
}

struct StanzaVercel: Decodable {
    let aggiornatoAt: Double
    let errore: String?
    let parziale: Bool
    let aggiornando: Bool
    let progetti: [ProgettoVercel]
    let totale: Int
}

/// Il collegamento esterno ammette solo HTTPS, senza credenziali nell'indirizzo.
func linkStack(_ stringa: String) -> URL? {
    guard let u = URL(string: stringa), u.scheme == "https", u.host != nil,
          u.user == nil, u.password == nil else { return nil }
    return u
}

struct VercelView: View {
    let ponte: Ponte
    @State private var lettura = LetturaStanza<StanzaVercel>("vercel")
    @State private var cerca = ""
    @State private var soloErrori = false
    @State private var richiesta = 0
    @State private var aggiornando = false
    @State private var errore: String?

    var body: some View {
        CorniceStanza(lettura: lettura, query: [:], datiDelMac: { $0.aggiornatoAt }) { d in
            RiquadroStanza(titolo: "I tuoi progetti", nota: "\(d.totale) su Vercel") {
                TextField("Cerca nome, repository o dominio", text: $cerca)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("vercel-cerca")
                Toggle("Solo pubblicazioni fallite", isOn: $soloErrori)
                Button { richiesta += 1 } label: {
                    Label(aggiornando || d.aggiornando ? "Sincronizzazione in corso…" : "Sincronizza Vercel", systemImage: "arrow.triangle.2.circlepath")
                }
                .disabled(aggiornando || d.aggiornando || ponte.linea != .collegato)
                if d.aggiornatoAt > 0 {
                    Text("Inventario letto \(Date(timeIntervalSince1970: d.aggiornatoAt / 1000).formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption).foregroundStyle(Tinte.tinta)
                } else {
                    Text("Premi Sincronizza Vercel per leggere i progetti dal Mac.").font(.caption).foregroundStyle(Tinte.tinta)
                }
                if let e = errore ?? d.errore { Text(e).font(.callout).foregroundStyle(Tinte.rosso) }
                if d.parziale { Text("Inventario parziale: alcuni progetti o team potrebbero mancare.").font(.caption).foregroundStyle(Tinte.ambra) }
            }
            let progetti = d.progetti.filter { p in
                (!soloErrori || p.tone == "male") && (cerca.isEmpty || [p.name, p.repo ?? "", p.domain ?? ""].joined(separator: " ").localizedCaseInsensitiveContains(cerca))
            }
            if progetti.isEmpty {
                RiquadroStanza(titolo: "Nessun progetto") {
                    Text(d.progetti.isEmpty ? "L’inventario non contiene progetti. Controlla il collegamento Vercel sul Mac e sincronizza." : "Nessun risultato per questi filtri.")
                        .font(.callout).foregroundStyle(Tinte.tinta)
                }
            }
            ForEach(progetti) { p in
                RiquadroStanza(titolo: p.name) {
                    Label(p.label.capitalized, systemImage: p.tone == "male" ? "exclamationmark.triangle" : p.tone == "ok" ? "checkmark.circle" : "clock")
                        .font(.callout.weight(.semibold)).foregroundStyle(p.tone == "male" ? Tinte.rosso : Tinte.ambra)
                    if let domain = p.domain, let u = linkStack("https://" + domain) { Link(domain, destination: u).font(.callout) }
                    if let repo = p.repo, let u = linkStack("https://github.com/" + repo) { Link(repo, destination: u).font(.callout) }
                    if p.localPaths.isEmpty {
                        Text("Cartella non rilevata sul Mac").font(.caption).foregroundStyle(Tinte.tinta)
                    } else {
                        ForEach(p.localPaths, id: \.self) { path in
                            Text(path).font(.caption).foregroundStyle(Tinte.tinta).textSelection(.enabled)
                        }
                    }
                    if let branch = p.productionBranch { Text("Produzione: \(branch)").font(.caption).foregroundStyle(Tinte.tinta) }
                    if let commit = p.commit {
                        Text("\(commit.sha.prefix(7)) · \(commit.message)").font(.caption).foregroundStyle(Tinte.tinta)
                    }
                    if p.at > 0 {
                        Text(Date(timeIntervalSince1970: p.at / 1000).formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(Tinte.tinta)
                    }
                    if let u = linkStack(p.url) { Link("Apri su Vercel", destination: u).font(.callout.weight(.medium)) }
                }
            }
        }
        .task(id: richiesta) {
            guard richiesta > 0 else { return }
            aggiornando = true
            errore = nil
            defer { aggiornando = false }
            do {
                _ = try await PonteStanze.shared.azione(["stanza": "vercel", "azione": "aggiorna"])
                for _ in 0..<12 {
                    try await Task.sleep(for: .seconds(3))
                    await lettura.carica()
                    if let d = lettura.dati, !d.aggiornando { break }
                }
            } catch is CancellationError { } catch { self.errore = error.localizedDescription }
        }
    }
}
