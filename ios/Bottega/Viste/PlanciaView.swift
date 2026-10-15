//
//  PlanciaView.swift
//  Bottega per iPhone
//
//  La schermata dell'app: in alto il Mac e la linea, poi le stanze. Moony e' la chat sulla luna (ConversazioneView):
//  luna, conversazione e barra di scrittura stanno li'; Lavori e Stanze usano tutto lo schermo.
//

import SwiftUI

struct PlanciaView: View {
    let ponte: Ponte
    @Bindable var melissa: Melissa
    let davanti: Bool

    typealias Stanza = Navigazione.Stanza
    @Bindable private var nav = Navigazione.shared
    @State private var impostazioni = false
    @State private var cervello = false

    private var statoVisibile: StatoMac? { ponte.collegato ? ponte.stato ?? StatoMac.ultimo() : nil }

    var body: some View {
        ZStack {
            Tinte.sfondo.ignoresSafeArea()
            VStack(spacing: 0) {
                testata
                Picker("Stanza", selection: $nav.stanza) {
                    ForEach(Stanza.allCases, id: \.self) { s in
                        Text(etichetta(s)).tag(s)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 20)
                .padding(.bottom, 8)
                switch nav.stanza {
                case .melissa: ConversazioneView(ponte: ponte, melissa: melissa, davanti: davanti) { cervello = true }
                case .lavori: LavoriView(ponte: ponte)
                case .stanze: StanzeView(ponte: ponte)
                }
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
        .alert("Moony", isPresented: Binding(get: { melissa.avviso != nil }, set: { if !$0 { melissa.avviso = nil } })) {
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
            let con = ponte.personaggioMac.map { ", sul Mac sei con \($0)" } ?? ""
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
}
