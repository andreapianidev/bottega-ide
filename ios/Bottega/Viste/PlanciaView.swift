//
//  PlanciaView.swift
//  Bottega per iPhone
//
//  La schermata dell'app, sul cielo nero (CieloView): in alto le tre stanze come un indice (SF Pro, come il Mac) e le impostazioni,
//  sotto il Mac e la linea in una riga sola. Moony e' la chat sulla luna (ConversazioneView): luna, conversazione e
//  barra di scrittura stanno li'; Lavori e Stanze usano tutto lo schermo, con il cielo piu' tenue sotto le liste.
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
            Color.black.ignoresSafeArea()
            CieloView(attivo: davanti, luce: nav.stanza == .melissa ? 1 : 0.45)
                .ignoresSafeArea()
                .animation(.easeInOut(duration: 0.4), value: nav.stanza)
            VStack(spacing: 0) {
                testata
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
                .presentationBackground(.black)
                .scrollContentBackground(.hidden)
        }
        .sheet(isPresented: $cervello) {
            Group {
                if AssistenteTelefono.shared.configurato { CervelloTelefonoFoglio() }
                else { CervelloFoglio(ponte: ponte) }
            }
            .presentationDetents([.medium, .large])
            .presentationBackground(.black)
                .scrollContentBackground(.hidden)
        }
        .alert("Moony", isPresented: Binding(get: { melissa.avviso != nil }, set: { if !$0 { melissa.avviso = nil } })) {
            Button("Va bene", role: .cancel) {}
        } message: {
            Text(melissa.avviso ?? "")
        }
    }

    // MARK: - pezzi

    /// Le stanze come un indice, nel carattere del Mac: quella aperta accesa, le altre spente. Sotto, in piccolo, il Mac.
    private var testata: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 18) {
                ForEach(Stanza.allCases, id: \.self) { s in
                    let scelta = nav.stanza == s
                    Button {
                        withAnimation(.easeInOut(duration: 0.25)) { nav.stanza = s }
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(s.rawValue)
                                .font(.system(size: 22, weight: scelta ? .bold : .regular))
                                .foregroundStyle(scelta ? Tinte.testo : Tinte.tinta.opacity(0.75))
                            if s == .lavori, let n = inAttesa {
                                Text("\(n)")
                                    .font(.caption.weight(.semibold).monospacedDigit())
                                    .foregroundStyle(Tinte.ambra)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(etichetta(s))
                    .accessibilityAddTraits(scelta ? [.isSelected, .isHeader] : [])
                }
                Spacer(minLength: 0)
                Button {
                    impostazioni = true
                } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 17))
                        .foregroundStyle(Tinte.tinta)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Impostazioni")
            }
            HStack(spacing: 7) {
                Circle().fill(coloreLinea).frame(width: 6, height: 6)
                Text("\(ponte.collegamento?.nomeMac ?? "Mac"), \(fraseLinea.prefix(1).lowercased() + fraseLinea.dropFirst())")
                    .font(.caption)
                    .foregroundStyle(Tinte.tinta)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .accessibilityElement(children: .combine)
        }
        .padding(.leading, 20)
        .padding(.trailing, 8)
        .padding(.top, 4)
        .padding(.bottom, 6)
    }

    /// Chi ti aspetta nei lavori, accanto alla parola Lavori.
    private var inAttesa: Int? {
        guard let c = statoVisibile?.conteggiAttivita, c.tiAspetta > 0 else { return nil }
        return c.tiAspetta
    }

    // MARK: - frasi

    private func etichetta(_ s: Stanza) -> String {
        guard s == .lavori, let n = inAttesa else { return s.rawValue }
        return "Lavori, \(n) ti \(n == 1 ? "aspetta" : "aspettano")"
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
