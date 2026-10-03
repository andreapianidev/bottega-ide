//
//  CervelloView.swift
//  Bottega per iPhone
//
//  Il cervello di Melissa sull'iPhone (docs/CONTRATTI.md, 9.8): sotto la sfera il nome di quello che sta usando,
//  dallo stato del Mac; un tocco sul nome, o un tocco lungo sulla sfera, apre il selettore. Il cambio passa dal Mac
//  con gli stessi metodi della barra di Melissa, quindi Mac e iPhone mostrano sempre la stessa scelta.
//

import SwiftUI

/// Il nome del cervello sotto la sfera, piccolo. Senza lo stato del Mac (o con una Bottega vecchia) non c'e'.
struct CervelloNome: View {
    let scelta: StatoMac.Scelta?
    let acceso: Bool
    let apri: () -> Void

    var body: some View {
        if let s = scelta {
            Button(action: apri) {
                HStack(spacing: 4) {
                    Text(s.nome)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                }
                .font(.caption)
                .foregroundStyle(Tinte.tinta.opacity(acceso ? 1 : 0.55))
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cervello di Melissa: \(s.nome)")
            .accessibilityHint("Tocca per cambiarlo")
        }
    }
}

/// Il selettore: i cervelli che il Mac dice disponibili, per quanto vale la scelta, l'impegno.
struct CervelloFoglio: View {
    let ponte: Ponte
    @Environment(\.dismiss) private var chiudi
    @State private var dati: CervelliMac?
    @State private var errore: String?
    @State private var invio = false
    /// Come vale il prossimo cervello scelto: per questa conversazione (come a voce) o sempre.
    @State private var sempre = false

    private var acceso: Bool { ponte.linea == .collegato }

    var body: some View {
        NavigationStack {
            CervelloModulo(dati: dati ?? ultimo, acceso: acceso, invio: invio, errore: errore, sempre: $sempre,
                           scegli: { p in Task { await manda(provider: p, sempre: sempre) } },
                           cambiaDurata: cambiaDurata,
                           impegno: { i in Task { await manda(impegno: i) } })
                .navigationTitle("Il cervello di Melissa")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { Button("Fatto") { chiudi() } }
                }
        }
        .task(id: acceso) { await carica() }
        // cambiato dal Mac o a voce mentre il foglio e' aperto: si rilegge
        .onChange(of: ponte.stato?.melissa.scelta) { _, _ in Task { await carica() } }
    }

    /// Con il Mac spento resta l'ultimo cervello visto, senza alternative.
    private var ultimo: CervelliMac? {
        guard let s = ponte.stato?.melissa.scelta else { return nil }
        return CervelliMac(provider: s.provider, nome: s.nome, impegno: s.impegno, predefinito: s.predefinito, perOra: s.perOra, opzioni: [])
    }

    private func carica() async {
        guard acceso else { return }
        do {
            let d = try await ponte.cervelli()
            if dati == nil { sempre = !d.perOra && d.provider != "agnes" }
            dati = d
            errore = nil
        } catch {
            errore = error.localizedDescription
        }
    }

    private func manda(provider: String? = nil, impegno: String? = nil, sempre: Bool = false) async {
        invio = true
        defer { invio = false }
        do {
            dati = try await ponte.scegliCervello(provider: provider, impegno: impegno, sempre: sempre)
            errore = nil
        } catch {
            errore = error.localizedDescription
        }
    }

    /// Cambiare «per questa conversazione» o «sempre» vale anche per il cervello di adesso, se non e' Agnes.
    private func cambiaDurata(_ nuovo: Bool) {
        sempre = nuovo
        guard let d = dati, d.provider != "agnes" else { return }
        Task {
            if nuovo, d.perOra {
                await manda(provider: d.provider, sempre: true)
            } else if !nuovo, !d.perOra {
                // il predefinito torna Agnes, e questo cervello resta per la conversazione
                await manda(provider: "agnes", sempre: true)
                await manda(provider: d.provider)
            }
        }
    }
}

/// Il contenuto del selettore, senza rete: lo disegnano anche le prove.
struct CervelloModulo: View {
    let dati: CervelliMac?
    let acceso: Bool
    let invio: Bool
    let errore: String?
    @Binding var sempre: Bool
    let scegli: (String) -> Void
    let cambiaDurata: (Bool) -> Void
    let impegno: (String) -> Void

    var body: some View {
        Form {
            if !acceso {
                Section {
                    Label("Serve il Mac acceso", systemImage: "desktopcomputer")
                        .foregroundStyle(Tinte.tinta)
                } footer: {
                    Text("Il cervello lo sceglie Melissa sul Mac: accendilo, con la Bottega aperta e Tailscale attivo.")
                }
            }
            Section {
                if let d = dati, !d.opzioni.isEmpty {
                    ForEach(d.opzioni) { o in riga(o, attuale: o.provider == d.provider) }
                } else if let d = dati {
                    rigaNome(d.nome, nota: "l'ultimo visto", attuale: true)
                } else {
                    Text(acceso ? "Chiedo al Mac…" : "Nessun cervello visto ancora")
                        .foregroundStyle(Tinte.tinta)
                }
            } header: {
                Text("Cervello")
            } footer: {
                if let d = dati { Text(adesso(d)) }
            }
            Section {
                Picker("Vale", selection: Binding(get: { sempre }, set: { cambiaDurata($0) })) {
                    Text("Per questa conversazione").tag(false)
                    Text("Sempre").tag(true)
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } header: {
                Text("Vale")
            } footer: {
                Text("Per questa conversazione: chiusa la conversazione, o dopo 15 minuti senza domande, Melissa torna \(CervelliMac.ritorno(dati?.predefinito ?? "agnes")). Sempre: resta finché non ne scegli un altro.")
            }
            Section {
                Picker("Impegno", selection: Binding(get: { dati?.impegno ?? "normale" }, set: { impegno($0) })) {
                    ForEach(CervelliMac.impegni, id: \.self) { Text($0).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            } header: {
                Text("Impegno")
            } footer: {
                Text("Come nella barra del Mac, resta finché non lo cambi. Con DeepSeek, «profondo» pensa con V4 Pro.")
            }
            if let errore {
                Section { Text(errore).foregroundStyle(Tinte.rosso) }
            }
        }
        .disabled(!acceso || invio)
        .opacity(acceso ? 1 : 0.6)
    }

    private func riga(_ o: CervelliMac.Opzione, attuale: Bool) -> some View {
        Button {
            scegli(o.provider)
        } label: {
            rigaNome(o.nome, nota: o.disponibile ? o.nota : "non disponibile: \(o.perche ?? o.nota)", attuale: attuale, spenta: !o.disponibile)
        }
        // stile semplice: il testo va a capo invece di troncarsi; la riga intera resta toccabile (contentShape)
        .buttonStyle(.plain)
        .disabled(!o.disponibile)
        .accessibilityAddTraits(attuale ? .isSelected : [])
    }

    private func rigaNome(_ nome: String, nota: String, attuale: Bool, spenta: Bool = false) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(nome)
                    .foregroundStyle(spenta ? Tinte.tinta : Tinte.testo)
                Text(nota)
                    .font(.caption)
                    .foregroundStyle(spenta ? Tinte.rosso : Tinte.tinta)
                    // il perche' di un cervello spento va letto intero, anche su due righe
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if attuale {
                Image(systemName: "checkmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Tinte.ambra)
            }
        }
        .contentShape(Rectangle())
    }

    private func adesso(_ d: CervelliMac) -> String {
        if d.perOra { return "Adesso \(d.nome), per questa conversazione: poi torna \(CervelliMac.ritorno(d.predefinito))." }
        return d.provider == "agnes" ? "Adesso Agnes, il cervello di sempre." : "Adesso \(d.nome), sempre."
    }
}
