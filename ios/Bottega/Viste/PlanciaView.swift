//
//  PlanciaView.swift
//  Bottega per iPhone
//
//  La schermata dell'app: in alto il Mac e la linea, poi la sfera di Melissa, sotto la conversazione (la stessa
//  della barra della Bottega sul Mac) o i lavori, in fondo la riga per scriverle.
//

import SwiftUI

struct PlanciaView: View {
    let ponte: Ponte
    @Bindable var melissa: Melissa
    let davanti: Bool

    typealias Stanza = Navigazione.Stanza
    @Bindable private var nav = Navigazione.shared
    @State private var testo = ""
    @State private var impostazioni = false
    @State private var cervello = false
    @FocusState private var scrivendo: Bool

    private var statoVisibile: StatoMac? { ponte.collegato ? ponte.stato ?? StatoMac.ultimo() : nil }

    var body: some View {
        ZStack {
            Tinte.sfondo.ignoresSafeArea()
            VStack(spacing: 0) {
                testata
                sfera
                Picker("Stanza", selection: $nav.stanza) {
                    ForEach(Stanza.allCases, id: \.self) { s in
                        Text(etichetta(s)).tag(s)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 20)
                .padding(.bottom, 8)
                switch nav.stanza {
                case .melissa: ConversazioneView(stato: ponte.stato, melissa: melissa, online: ponte.linea == .collegato)
                case .lavori: LavoriView(ponte: ponte)
                case .stanze: StanzeView(ponte: ponte)
                }
                if nav.stanza == .melissa { scrivi }
            }
        }
        // sulla scrivania (9.9): attaccato al Mac col cavo e con l'app davanti, lo schermo resta acceso
        .onChange(of: sullaScrivania, initial: true) { _, si in
            UIApplication.shared.isIdleTimerDisabled = si
        }
        .onChange(of: nav.ascoltaSubito, initial: true) { _, si in
            // dal Centro di Controllo: la sfera comincia ad ascoltare
            guard si else { return }
            nav.ascoltaSubito = false
            guard ponte.collegato else { return }
            if melissa.sfera == .riposo || melissa.sfera == .errore { melissa.tocca() }
        }
        .sheet(isPresented: $impostazioni) {
            ImpostazioniView(ponte: ponte, melissa: melissa)
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $cervello) {
            Group {
                if AssistenteTelefono.shared.configurato { CervelloTelefonoFoglio() }
                else { CervelloFoglio(ponte: ponte) }
            }.presentationDetents([.medium, .large])
        }
        .alert("Melissa", isPresented: Binding(get: { melissa.avviso != nil }, set: { if !$0 { melissa.avviso = nil } })) {
            Button("Va bene", role: .cancel) {}
        } message: {
            Text(melissa.avviso ?? "")
        }
    }

    // MARK: - pezzi

    private var testata: some View {
        HStack(spacing: 10) {
            Circle().fill(coloreLinea).frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 1) {
                Text(ponte.collegamento?.nomeMac ?? "Mac")
                    .font(.headline)
                    .foregroundStyle(Tinte.testo)
                Text(fraseLinea)
                    .font(.caption)
                    .foregroundStyle(Tinte.tinta)
                    .lineLimit(2)
            }
            Spacer()
            Button {
                impostazioni = true
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.title3)
                    .foregroundStyle(Tinte.tinta)
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Impostazioni")
        }
        .padding(.horizontal, 20)
        .padding(.top, 6)
    }

    private var sfera: some View {
        VStack(spacing: 6) {
            SferaView(stato: melissa.sfera, attiva: davanti)
                .frame(width: 250, height: 250)
                // la maschera radiale della barra sul Mac (sfera-gpu.js, VoiceOrbIndicator di Avo): piena fino al
                // 62% del raggio, zero sul bordo, cosi' particelle e bagliore non disegnano mai un quadrato
                .mask {
                    RadialGradient(stops: [.init(color: .black, location: 0.62), .init(color: .clear, location: 1)],
                                   center: .center, startRadius: 0, endRadius: 125)
                }
                .contentShape(Circle())
                .onTapGesture { melissa.tocca() }
                // tocco lungo: il selettore del cervello (CervelloView.swift)
                .onLongPressGesture(minimumDuration: 0.5) { cervello = true }
                .accessibilityLabel("Sfera di Melissa")
                .accessibilityHint(melissa.sfera == .ascolta ? "Tocca per mandare la frase" : "Tocca per parlare con Melissa")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction(named: "Scegli il cervello") { cervello = true }
            CervelloNome(scelta: sceltaVisibile, acceso: true) { cervello = true }
                .padding(.top, -4)
            Text(fraseSfera)
                .font(.callout)
                .foregroundStyle(melissa.sfera == .errore ? Tinte.rosso : Tinte.tinta)
                .multilineTextAlignment(.center)
                .lineLimit(3)
                .frame(minHeight: 44, alignment: .top)
                .padding(.horizontal, 28)
                .animation(.easeOut(duration: 0.2), value: fraseSfera)
            if melissa.conversazione {
                Button("Chiudi la conversazione") { melissa.chiudiConversazione() }
                    .font(.footnote)
                    .foregroundStyle(Tinte.ambra)
            }
        }
        .padding(.bottom, 10)
    }

    private var scrivi: some View {
        HStack(spacing: 10) {
            TextField("Scrivi a Melissa", text: $testo, axis: .vertical)
                .lineLimit(1...4)
                .focused($scrivendo)
                .submitLabel(.send)
                .onSubmit(manda)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(RoundedRectangle(cornerRadius: 18).fill(Tinte.notteFonda))
                .overlay(RoundedRectangle(cornerRadius: 18).stroke(Tinte.bordo))
                .foregroundStyle(Tinte.testo)
            Button(action: manda) {
                Image(systemName: "arrow.up")
                    .font(.headline)
                    .foregroundStyle(Tinte.notteFonda)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(testo.isEmpty || melissa.occupata ? Tinte.tinta.opacity(0.4) : Tinte.ambra))
            }
            .disabled(testo.trimmingCharacters(in: .whitespaces).isEmpty || melissa.occupata)
            .accessibilityLabel("Manda")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func manda() {
        let t = testo
        testo = ""
        scrivendo = false
        melissa.scrivi(t)
    }

    // MARK: - frasi

    private func etichetta(_ s: Stanza) -> String {
        guard s == .lavori, let c = statoVisibile?.conteggiAttivita, c.tiAspetta > 0 else { return s.rawValue }
        // nel segmentato a tre la frase intera non ci sta: solo il numero di chi ti aspetta
        return "Lavori · \(c.tiAspetta)"
    }

    private var coloreLinea: Color {
        switch ponte.linea {
        case .collegato: Tinte.verde
        case .provo, .scollegato: Tinte.ambra
        case .fuori: Tinte.rosso
        }
    }

    private var sullaScrivania: Bool {
        davanti && ponte.linea == .collegato && ponte.stato?.vicino == "usb"
    }

    private var sceltaVisibile: StatoMac.Scelta? {
        let t = AssistenteTelefono.shared
        if t.configurato {
            return StatoMac.Scelta(provider: t.provider, nome: t.nome, impegno: t.impegno,
                                   predefinito: t.provider, perOra: false)
        }
        return ponte.stato?.melissa.scelta
    }

    private var fraseLinea: String {
        switch ponte.linea {
        case .collegato:
            let dove = switch ponte.stato?.vicino {
            case "usb"?: "Vicino via cavo, ponte Tailscale"
            case "casa"?: "Collegato in casa"
            default: "Collegato"
            }
            guard let stato = ponte.stato else { return dove }
            let c = stato.conteggiAttivita
            // nella barra del Mac la chiamata ce l'ha un personaggio: lo si dice in testa
            let con = personaggioMac.map { ", sul Mac sei con \($0)" } ?? ""
            if c.totale == 0 { return "\(dove), nessuna attività osservata\(con)" }
            return "\(dove), \(c.totale) attività, \(c.inCorso) in corso, \(c.tiAspetta) in attesa\(con)"
        case .provo, .scollegato, .fuori:
            let stato = switch ponte.linea {
            case .provo: "Cerco il Mac…"
            case .scollegato: "Scollegato"
            case .fuori(let perche): perche
            case .collegato: "Collegato"
            }
            guard let ultimo = statoVisibile else { return stato }
            let quando = Date(timeIntervalSince1970: ultimo.ora / 1000).formatted(date: .abbreviated, time: .shortened)
            return "\(stato) · \(ultimo.conteggiAttivita.totale) attività salvate alle \(quando)"
        }
    }

    /// Il nome di chi ha la chiamata nella barra del Mac, se non e' Melissa (`melissa.personaggio` di /v1/stato).
    private var personaggioMac: String? {
        guard let k = ponte.stato?.melissa.personaggio, k != "melissa", !k.isEmpty else { return nil }
        return Personaggi.tutti[k]?.nome ?? (k.prefix(1).uppercased() + String(k.dropFirst()))
    }

    private var fraseSfera: String {
        switch melissa.sfera {
        case .ascolta: melissa.parziale.isEmpty ? "Ti ascolto" : melissa.parziale
        case .pensa: "Ci penso…"
        case .parla: melissa.parlante == "Melissa" ? "Tocca la sfera per interrompermi" : "Parla \(melissa.parlante). Tocca la sfera per interrompere"
        case .errore: "Qualcosa non è andato. Tocca la sfera per riprovare."
        case .riposo:
            switch ponte.stato?.melissa.stato {
            case "thinking"?: personaggioMac.map { "Sul Mac \($0) sta già rispondendo" } ?? "Sul Mac sto già rispondendo"
            case "speaking"?: personaggioMac.map { "Sul Mac sta parlando \($0)" } ?? "Sto parlando sul Mac"
            case "listening"?: "Sul Mac ti sto ascoltando"
            default: melissa.chiParla == "melissa" ? "Tocca la sfera per parlarmi"
                : "Sei con \(Personaggi.nome(melissa.chiParla)). «Ridammi Melissa» per tornare da me"
            }
        }
    }
}
