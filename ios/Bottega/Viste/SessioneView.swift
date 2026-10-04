//
//  SessioneView.swift
//  Bottega per iPhone
//
//  La scheda di una sessione Claude, per tutte le sessioni del Mac (anche quelle aperte in iTerm o altrove): in
//  cima la domanda se ti aspetta, poi l'ultima richiesta e l'ultima risposta, i passi in chiaro, i file toccati,
//  da quanto lavora e i token. In diretta finche' la scheda e' aperta (GET /v1/sessione/eventi, docs/CONTRATTI.md
//  9.5): chiusa la scheda, il Mac smette di guardare. Ai lavori della Bottega si risponde da qui; le sessioni
//  aperte altrove si leggono soltanto.
//

import SwiftUI

struct SessioneView: View {
    let ponte: Ponte
    let lavoro: StatoMac.Lavoro

    @Environment(\.dismiss) private var chiudi
    @Environment(\.scenePhase) private var fase
    @State private var scheda: SchedaSessione?
    @State private var errore: String?
    @State private var riassunto = Riassunto()
    @State private var scrivi = false
    @State private var seguendo = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    testata
                    if let d = scheda?.domanda {
                        DomandaView(scheda: scheda!, domanda: d)
                    } else if lavoro.origine != "bottega", lavoro.stato == "ti aspetta" {
                        Nota(testo: "Questa sessione è aperta in un'altra app: rispondi dal Mac.")
                    }
                    azioni
                    if let errore {
                        Text(errore).font(.footnote).foregroundStyle(Tinte.rosso)
                    }
                    if let s = scheda { contenuto(s) } else if errore == nil { attesa }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .background(Tinte.sfondo.ignoresSafeArea())
            .navigationTitle(lavoro.progetto)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Chiudi") { chiudi() } }
                if scheda?.scrivibile == true {
                    ToolbarItem(placement: .primaryAction) {
                        Button { scrivi = true } label: { Image(systemName: "square.and.pencil") }
                            .accessibilityLabel("Scrivi al lavoro")
                    }
                }
            }
            .sheet(isPresented: $scrivi) {
                ScriviLavoroView(ponte: ponte, lavoro: lavoro).presentationDetents([.medium])
            }
        }
        .tint(Tinte.ambra)
        // in diretta solo con l'app davanti: dietro la connessione si chiude e il Mac smette di guardare
        .task(id: fase == .active) { if fase == .active { await segui() } }
        .onDisappear { riassunto.ferma() }
    }

    // MARK: - parti

    private var testata: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(colore(scheda?.stato ?? lavoro.stato)).frame(width: 9, height: 9)
                Text(scheda?.stato ?? lavoro.stato).font(.subheadline.weight(.medium)).foregroundStyle(colore(scheda?.stato ?? lavoro.stato))
                Spacer()
                Text(lavoro.origine == "bottega" ? "Lavoro della Bottega" : "Aperta altrove")
                    .font(.caption)
                    .foregroundStyle(Tinte.tinta)
            }
            Text(lavoro.titolo.isEmpty ? "Sessione senza titolo" : lavoro.titolo)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Tinte.testo)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var azioni: some View {
        HStack(spacing: 10) {
            Pulsante(titolo: titoloRiassunto, simbolo: riassunto.stato == .fermo ? "waveform" : "stop.fill", acceso: riassunto.stato != .fermo) {
                if riassunto.stato != .fermo { riassunto.ferma() }
                else if let scheda { riassunto.avvia(titolo: "la sessione di \(scheda.progetto)", contesto: contestoRacconto(scheda)) }
            }
            .disabled(scheda == nil && riassunto.stato == .fermo)
            Pulsante(titolo: scheda?.seguita == true ? "La segui" : "Segui", simbolo: scheda?.seguita == true ? "pin.fill" : "pin", acceso: scheda?.seguita == true) {
                Task { await cambiaSegui() }
            }
            .disabled(seguendo || scheda == nil || scheda?.finita == true)
        }
    }

    private var titoloRiassunto: String {
        switch riassunto.stato {
        case .fermo: "Racconta"
        case .pensa: "Melissa legge…"
        case .parla: "Fermala"
        }
    }

    private func contestoRacconto(_ s: SchedaSessione) -> String {
        var righe = ["Progetto: \(s.progetto)", "Titolo: \(s.titolo)", "Stato: \(s.stato)"]
        if let richiesta = s.richiesta { righe.append("Richiesta: \(richiesta.prefix(1200))") }
        if !s.passi.isEmpty {
            righe.append("Passi recenti:\n" + s.passi.suffix(12).map { "- \($0.testo)\($0.inCorso == true ? " (in corso)" : "")" }.joined(separator: "\n"))
        }
        if !s.file.isEmpty { righe.append("File toccati: " + s.file.prefix(20).joined(separator: ", ")) }
        if let risposta = s.risposta { righe.append("Ultima risposta: \(risposta.prefix(1500))") }
        if let domanda = s.domanda { righe.append("Ora aspetta Andrea: \(domanda.testo.prefix(500))") }
        return righe.joined(separator: "\n")
    }

    private var attesa: some View {
        HStack(spacing: 10) {
            ProgressView().tint(Tinte.tinta)
            Text("Leggo la sessione sul Mac…").font(.callout).foregroundStyle(Tinte.tinta)
        }
        .padding(.top, 8)
    }

    @ViewBuilder
    private func contenuto(_ s: SchedaSessione) -> some View {
        if riassunto.stato != .fermo || !riassunto.testo.isEmpty || riassunto.errore != nil {
            Riquadro(titolo: "Melissa") {
                Text(riassunto.errore ?? (riassunto.testo.isEmpty ? "Sta leggendo la sessione…" : riassunto.testo))
                    .font(.callout)
                    .foregroundStyle(riassunto.errore == nil ? Tinte.testo : Tinte.rosso)
            }
        }
        numeri(s)
        if let r = s.richiesta {
            Riquadro(titolo: "Ultima richiesta") { Testo(testo: r, righe: 6) }
        }
        if let r = s.risposta, s.domanda?.tipo != "domanda" {
            Riquadro(titolo: "Ultima risposta di Claude") { Testo(testo: r, righe: 8) }
        }
        if !s.passi.isEmpty {
            Riquadro(titolo: "Ultimi passi") {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(s.passi.reversed().enumerated()), id: \.offset) { _, p in
                        PassoView(passo: p)
                    }
                }
            }
        }
        if !s.file.isEmpty {
            Riquadro(titolo: "File toccati") {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(s.file, id: \.self) { f in
                        Text(f).font(.footnote.monospaced()).foregroundStyle(Tinte.testo).lineLimit(1).truncationMode(.head)
                    }
                }
            }
        }
        if s.modifiche || s.terminale {
            VStack(spacing: 0) {
                if s.modifiche {
                    NavigationLink { ModificheView(chiave: s.chiave) } label: { Voce(titolo: "Le modifiche", sotto: "git diff del progetto", simbolo: "plusminus") }
                }
                if s.modifiche && s.terminale { Divider().overlay(Tinte.bordo) }
                if s.terminale {
                    NavigationLink { TerminaleView(chiave: s.chiave, progetto: s.progetto) } label: { Voce(titolo: "Il terminale", sotto: "in diretta, solo da guardare", simbolo: "terminal") }
                }
            }
            .background(RoundedRectangle(cornerRadius: 14).fill(Tinte.notteFonda.opacity(0.8)))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Tinte.bordo))
        }
        if s.seguita {
            Nota(testo: "La Live Activity mostra l'ultimo passo di questa sessione finché c'è una sessione al lavoro sul Mac.")
        }
    }

    private func numeri(_ s: SchedaSessione) -> some View {
        HStack(spacing: 10) {
            Numero(valore: durata(da: s.iniziata ?? s.da), etichetta: s.stato == "in corso" ? "lavora da" : "aperta da")
            if let u = s.ultimo { Numero(valore: fa(u), etichetta: "ultimo passo") }
            if let t = s.token {
                Numero(valore: breve(t.contesto), etichetta: "contesto")
                Numero(valore: breve(t.uscita), etichetta: t.parziale == true ? "scritti (circa)" : "token scritti")
            }
        }
    }

    // MARK: - diretta

    private func segui() async {
        var attesa: UInt64 = 1
        while !Task.isCancelled {
            do {
                try await PonteSessioni.shared.diretta(lavoro.chiave) { s in
                    scheda = s
                    errore = nil
                }
                attesa = 1
            } catch {
                if Task.isCancelled { return }
                if (error as? ErrorePonte)?.codice == 404 {
                    errore = "Questa sessione non c'è più sul Mac."
                    return
                }
                errore = error.localizedDescription
            }
            try? await Task.sleep(nanoseconds: attesa * 1_000_000_000)
            attesa = min(attesa * 2, 20)
        }
    }

    private func cambiaSegui() async {
        seguendo = true
        defer { seguendo = false }
        do {
            _ = try await PonteSessioni.shared.segui(scheda?.seguita == true ? "" : lavoro.chiave)
            scheda = try? await PonteSessioni.shared.scheda(lavoro.chiave)
        } catch {
            errore = error.localizedDescription
        }
    }
}

// MARK: - la domanda in primo piano

private struct DomandaView: View {
    let scheda: SchedaSessione
    let domanda: SchedaSessione.Domanda

    @State private var testo = ""
    @State private var invio = false
    @State private var esito: String?
    @State private var errore: String?
    @FocusState private var scrivendo: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(titolo, systemImage: simbolo)
                .font(.headline)
                .foregroundStyle(Tinte.ambra)
            Text(domanda.testo)
                .font(.callout)
                .foregroundStyle(Tinte.testo)
                .lineLimit(domanda.tipo == "domanda" ? 12 : nil)
                .textSelection(.enabled)
            if let c = domanda.comando {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(c).font(.footnote.monospaced()).foregroundStyle(Tinte.testo).textSelection(.enabled)
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.black.opacity(0.35)))
            }
            if let o = domanda.opzioni, !o.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(o.enumerated()), id: \.offset) { i, v in
                        Text("\(i + 1). \(v)").font(.footnote).foregroundStyle(Tinte.testo)
                    }
                }
            }
            risposte
            if let errore { Text(errore).font(.footnote).foregroundStyle(Tinte.rosso) }
            if let esito { Text(esito).font(.footnote).foregroundStyle(Tinte.verde) }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16).fill(Tinte.ambra.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Tinte.ambra.opacity(0.6)))
        .onChange(of: domanda.id) { _, _ in
            esito = nil
            errore = nil
        }
    }

    @ViewBuilder
    private var risposte: some View {
        if domanda.tipo == "finestra" {
            Nota(testo: "Questa finestra di Claude Code si gestisce dal Mac.")
        } else if !scheda.scrivibile {
            Nota(testo: scheda.origine == "bottega" ? "Il terminale di questo lavoro non è più aperto: rispondi dal Mac." : "Questa sessione è aperta in un'altra app: rispondi dal Mac.")
        } else {
            if domanda.tipo == "permesso" || (domanda.tipo == "domanda" && domanda.chiede == true) {
                HStack(spacing: 10) {
                    Button { manda("si") } label: { Text("Sì").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent)
                        .tint(Tinte.verde)
                    Button { manda("no") } label: { Text("No").frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered)
                        .tint(Tinte.rosso)
                }
                .font(.body.weight(.semibold))
                .disabled(invio)
            }
            HStack(spacing: 8) {
                TextField(segnaposto, text: $testo, axis: .vertical)
                    .lineLimit(1...4)
                    .focused($scrivendo)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Tinte.notteFonda))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Tinte.bordo))
                    .foregroundStyle(Tinte.testo)
                Button { manda("testo") } label: {
                    Image(systemName: "arrow.up")
                        .font(.headline)
                        .foregroundStyle(Tinte.notteFonda)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(vuoto || invio ? Tinte.tinta.opacity(0.4) : Tinte.ambra))
                }
                .disabled(vuoto || invio)
                .accessibilityLabel("Manda la risposta")
            }
            Text(spiegazione).font(.caption).foregroundStyle(Tinte.tinta)
        }
    }

    private var vuoto: Bool { testo.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private var titolo: String {
        switch domanda.tipo {
        case "permesso": "Chiede il permesso" + (domanda.strumento.map { ": \($0)" } ?? "")
        case "scelta": "Ti chiede di scegliere"
        case "finestra": "Aspetta sul Mac"
        default: domanda.chiede == true ? "Ti chiede" : "Ha finito e ti aspetta"
        }
    }

    private var simbolo: String {
        switch domanda.tipo {
        case "permesso": "hand.raised.fill"
        case "scelta": "list.bullet"
        case "finestra": "macwindow"
        default: "bubble.left.fill"
        }
    }

    private var segnaposto: String {
        switch domanda.tipo {
        case "permesso": "No, e invece fai così…"
        case "scelta": "La tua risposta"
        default: "Rispondi a Claude"
        }
    }

    private var spiegazione: String {
        switch domanda.tipo {
        case "permesso": "Sì conferma il permesso nel terminale sul Mac. No lo rifiuta; con un testo lo rifiuta e dice a Claude cosa fare invece."
        case "scelta": "La domanda si chiude e la tua risposta arriva a Claude come messaggio."
        default: "Arriva nel terminale del lavoro sul Mac, come se lo scrivessi tu."
        }
    }

    private func manda(_ risposta: String) {
        let t = testo.trimmingCharacters(in: .whitespacesAndNewlines)
        invio = true
        errore = nil
        esito = nil
        Task {
            do {
                try await PonteSessioni.shared.rispondi(scheda.chiave, domanda: domanda.id, risposta: risposta, testo: risposta == "testo" ? t : "")
                esito = risposta == "si" ? "Sì mandato." : risposta == "no" ? "No mandato." : "Risposta mandata."
                if risposta == "testo" { testo = "" }
                scrivendo = false
            } catch {
                errore = error.localizedDescription
            }
            invio = false
        }
    }
}

// MARK: - pezzi

private struct PassoView: View {
    let passo: SchedaSessione.Passo

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: simbolo)
                .font(.footnote)
                .foregroundStyle(passo.inCorso == true ? Tinte.verde : Tinte.tinta)
                .frame(width: 18)
            Text(passo.testo)
                .font(.callout)
                .foregroundStyle(passo.inCorso == true ? Tinte.testo : Tinte.testo.opacity(0.85))
                .lineLimit(2)
            Spacer(minLength: 4)
            if passo.alle > 0 {
                Text(fa(passo.alle)).font(.caption2).foregroundStyle(Tinte.tinta)
            }
        }
    }

    private var simbolo: String {
        switch passo.tipo {
        case "modifica": "pencil"
        case "comando": "terminal"
        case "lettura": "doc.text"
        case "ricerca": "magnifyingglass"
        case "web": "globe"
        case "agente": "person.2"
        default: "circle.dotted"
        }
    }
}

private struct Riquadro<C: View>: View {
    let titolo: String
    @ViewBuilder let contenuto: C

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(titolo).font(.caption.weight(.semibold)).foregroundStyle(Tinte.tinta)
            contenuto
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Tinte.notteFonda.opacity(0.8)))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Tinte.bordo))
    }
}

private struct Testo: View {
    let testo: String
    let righe: Int
    @State private var tutto = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(testo)
                .font(.callout)
                .foregroundStyle(Tinte.testo)
                .lineLimit(tutto ? nil : righe)
                .textSelection(.enabled)
            if testo.count > righe * 60 {
                Button(tutto ? "Meno" : "Tutto") { tutto.toggle() }.font(.caption.weight(.medium))
            }
        }
    }
}

private struct Numero: View {
    let valore: String
    let etichetta: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(valore).font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(Tinte.testo)
            Text(etichetta).font(.caption2).foregroundStyle(Tinte.tinta)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 12).fill(Tinte.notteFonda.opacity(0.8)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Tinte.bordo))
    }
}

private struct Pulsante: View {
    let titolo: String
    let simbolo: String
    let acceso: Bool
    let azione: () -> Void

    var body: some View {
        Button(action: azione) {
            Label(titolo, systemImage: simbolo)
                .font(.footnote.weight(.medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(Capsule().fill(acceso ? Tinte.ambra.opacity(0.18) : Tinte.notteFonda))
                .overlay(Capsule().stroke(acceso ? Tinte.ambra : Tinte.bordo))
                .foregroundStyle(acceso ? Tinte.ambra : Tinte.testo)
        }
        .buttonStyle(.plain)
    }
}

private struct Voce: View {
    let titolo: String
    let sotto: String
    let simbolo: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: simbolo).foregroundStyle(Tinte.tinta).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(titolo).font(.callout.weight(.medium)).foregroundStyle(Tinte.testo)
                Text(sotto).font(.caption).foregroundStyle(Tinte.tinta)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Tinte.tinta)
        }
        .padding(14)
        .contentShape(Rectangle())
    }
}

private struct Nota: View {
    let testo: String

    var body: some View {
        Label(testo, systemImage: "info.circle")
            .font(.footnote)
            .foregroundStyle(Tinte.tinta)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - tempi e numeri

private func colore(_ stato: String) -> Color {
    switch stato {
    case "ti aspetta": Tinte.ambra
    case "in corso": Tinte.verde
    default: Tinte.tinta
    }
}

private func durata(da ms: Double) -> String {
    let minuti = max(0, Int((Date().timeIntervalSince1970 * 1000 - ms) / 60_000))
    if minuti < 1 { return "adesso" }
    if minuti < 60 { return "\(minuti) min" }
    return "\(minuti / 60) h \(minuti % 60) min"
}

private func fa(_ ms: Double) -> String {
    let s = max(0, Int(Date().timeIntervalSince1970 - ms / 1000))
    if s < 60 { return "ora" }
    if s < 3600 { return "\(s / 60) min fa" }
    return "\(s / 3600) h fa"
}

private func breve(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.1f M", Double(n) / 1_000_000).replacingOccurrences(of: ".", with: ",") }
    if n >= 1000 { return "\(n / 1000) mila" }
    return "\(n)"
}
