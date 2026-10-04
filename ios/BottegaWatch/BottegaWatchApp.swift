import SwiftUI
import WatchKit

private enum ColoriWatch {
    static let ambra = Color(red: 244 / 255, green: 171 / 255, blue: 60 / 255)
    static let verde = Color(red: 127 / 255, green: 209 / 255, blue: 155 / 255)
    static let testo = Color(red: 232 / 255, green: 226 / 255, blue: 208 / 255)
}

@main
struct BottegaWatchApp: App {
    @StateObject private var collegamento = CollegamentoWatch.shared
    @Environment(\.scenePhase) private var fase

    init() { CollegamentoWatch.shared.avvia() }

    var body: some Scene {
        WindowGroup {
            PlanciaWatch(istantanea: collegamento.istantanea, aggiorna: collegamento.aggiorna)
                .onAppear { collegamento.avvia() }
                .onChange(of: fase) { _, nuova in
                    if nuova == .active { collegamento.aggiorna() }
                }
        }
    }
}

private struct PlanciaWatch: View {
    let istantanea: IstantaneaOrologio?
    let aggiorna: () -> Void
    @Environment(\.isLuminanceReduced) private var ridotta

    private var numero: Int { istantanea.map { $0.tiAspetta > 0 ? $0.tiAspetta : $0.inCorso } ?? 0 }
    private var colore: Color { ridotta ? .white : (istantanea?.tiAspetta ?? 0) > 0 ? ColoriWatch.ambra : ColoriWatch.verde }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 13) {
                    HStack(spacing: 5) {
                        Circle().fill(istantanea == nil ? .gray : colore).frame(width: 6, height: 6)
                        Text("Bottega")
                            .font(.system(size: 12, weight: .bold, design: .rounded))
                            .tracking(1)
                        Spacer(minLength: 2)
                        Button {
                            WKInterfaceDevice.current().play(.click)
                            aggiorna()
                        } label: {
                            Image(systemName: "arrow.clockwise")
                                .font(.system(size: 13, weight: .bold))
                                .frame(width: 30, height: 30)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Aggiorna dal telefono")
                    }

                    if let istantanea {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(numero.formatted())
                                .font(.system(size: 70, weight: .bold, design: .rounded))
                                .monospacedDigit()
                                .contentTransition(.numericText())
                                .minimumScaleFactor(0.7)
                                .foregroundStyle(colore)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(istantanea.tiAspetta > 0 ? "ti aspettano" : "in corso")
                                .font(.system(size: 14, weight: .semibold, design: .rounded))
                                .foregroundStyle(ColoriWatch.testo)
                        }
                        .padding(.top, 2)
                        .accessibilityElement(children: .combine)

                        HStack(spacing: 7) {
                            miniDato(istantanea.inCorso, "In corso", colore: ColoriWatch.verde)
                            miniDato(istantanea.tiAspetta, "In attesa", colore: ColoriWatch.ambra)
                        }

                        HStack(spacing: 6) {
                            Image(systemName: "waveform")
                                .foregroundStyle(ridotta ? .white : ColoriWatch.ambra)
                            Text(statoMelissa(istantanea.melissa))
                                .foregroundStyle(ColoriWatch.testo)
                        }
                        .font(.system(size: 11, weight: .medium))
                        .lineLimit(1)

                        if !istantanea.sessioni.isEmpty {
                            Text("Lavori")
                                .font(.system(size: 11, weight: .semibold, design: .rounded))
                                .foregroundStyle(.secondary)
                                .padding(.top, 3)
                            ForEach(istantanea.sessioni) { sessione in
                                NavigationLink {
                                    DettaglioWatch(sessione: sessione)
                                } label: {
                                    riga(sessione)
                                }
                                .buttonStyle(.plain)
                                .simultaneousGesture(TapGesture().onEnded { WKInterfaceDevice.current().play(.click) })
                            }
                            let altre = max(0, istantanea.totale - istantanea.sessioni.count)
                            if altre > 0 {
                                Text(altre == 1 ? "Un'altra sessione su iPhone" : "Altre \(altre) sessioni su iPhone")
                                    .font(.system(size: 11, weight: .medium, design: .rounded))
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }

                        HStack(spacing: 4) {
                            Image(systemName: "iphone")
                            Text("Via iPhone")
                            Text("·")
                            Text(istantanea.visto, style: .relative)
                        }
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .padding(.top, 2)
                    } else {
                        VStack(alignment: .leading, spacing: 5) {
                            Image(systemName: "iphone.gen3")
                                .font(.system(size: 25, weight: .light))
                                .foregroundStyle(ColoriWatch.ambra)
                            Text("Apri Bottega su iPhone")
                                .font(.system(size: 17, weight: .bold, design: .rounded))
                                .fixedSize(horizontal: false, vertical: true)
                            Text("Collega il Mac dall'app.")
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.top, 4)
                    }
                }
                .padding(.horizontal, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.hidden)
            .containerBackground(.black, for: .navigation)
        }
        .tint(ColoriWatch.ambra)
    }

    private func miniDato(_ valore: Int, _ nome: LocalizedStringKey, colore: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(valore.formatted())
                .font(.system(size: 23, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(ridotta ? .white : colore)
            Text(nome)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
    }

    private func statoMelissa(_ stato: String) -> LocalizedStringKey {
        switch stato {
        case "thinking": "Melissa sta pensando"
        case "speaking": "Melissa sta parlando"
        case "listening": "Melissa ascolta"
        default: "Melissa pronta"
        }
    }

    private func riga(_ sessione: IstantaneaOrologio.Sessione) -> some View {
        HStack(spacing: 8) {
            Capsule()
                .fill(sessione.stato == "ti aspetta" ? ColoriWatch.ambra : sessione.stato == "in corso" ? ColoriWatch.verde : .gray)
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 2) {
                Text(sessione.progetto.isEmpty ? sessione.fonte : sessione.progetto)
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
                    .lineLimit(1)
                Text("\(sessione.fonte) · \(sessione.stato)")
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(ridotta ? .white : ColoriWatch.testo)
                    .lineLimit(2)
                Text(sessione.titolo.isEmpty ? sessione.stato : sessione.titolo)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 39)
        .padding(8)
        .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct DettaglioWatch: View {
    let sessione: IstantaneaOrologio.Sessione

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text(sessione.stato.capitalized)
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(sessione.stato == "ti aspetta" ? ColoriWatch.ambra : ColoriWatch.verde)
                Text(sessione.progetto)
                    .font(.system(size: 21, weight: .bold, design: .rounded))
                    .foregroundStyle(ColoriWatch.testo)
                Text(sessione.titolo)
                    .font(.system(size: 14))
                Text(sessione.fonte)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .containerBackground(.black, for: .navigation)
    }
}

#Preview("SE 40 mm", traits: .fixedLayout(width: 162, height: 197)) {
    PlanciaWatch(istantanea: .init(visto: .now, mac: "Mac", melissa: "idle", inCorso: 2,
                                    tiAspetta: 1, totale: 3, sessioni: []), aggiorna: {})
}

#Preview("SE 44 mm", traits: .fixedLayout(width: 184, height: 224)) {
    PlanciaWatch(istantanea: .init(visto: .now, mac: "Mac", melissa: "idle", inCorso: 2,
                                    tiAspetta: 0, totale: 2, sessioni: []), aggiorna: {})
}

#Preview("Display attenuato") {
    PlanciaWatch(istantanea: .init(visto: .now, mac: "Mac", melissa: "thinking", inCorso: 2,
                                    tiAspetta: 1, totale: 3, sessioni: []), aggiorna: {})
        .environment(\.isLuminanceReduced, true)
}
