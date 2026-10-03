//
//  GuadagniWidget.swift
//  Bottega per iPhone, estensione dei widget
//
//  Il widget «Guadagni»: quanto hanno reso le app ieri, nella settimana o nel mese, il totale in ambra, AdMob e
//  Store separati, la freccia sul periodo prima e le barre dei giorni (AdMob sotto, Store sopra, i colori della
//  stanza App Store). Nel grande anche le tre app che rendono di piu' e il primo buco da sistemare con la stima.
//  Legge GET /v1/stanza?nome=appstore (docs/CONTRATTI.md, 9.6) con DatiWidget; si sceglie il periodo e l'app.
//  Quando il report dello Store non e' ancora uscito lo dice («Store fino al 1 ott»): mai uno zero falso.
//

import AppIntents
import Charts
import SwiftUI
import WidgetKit

// MARK: - configurazione

enum PeriodoGuadagni: String, AppEnum {
    case ieri, settimana, mese

    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Periodo"
    static let caseDisplayRepresentations: [PeriodoGuadagni: DisplayRepresentation] = [
        .ieri: "Ieri", .settimana: "Settimana", .mese: "Mese",
    ]

    /// Come si legge sotto la cifra.
    var detto: String {
        switch self {
        case .ieri: "ieri"
        case .settimana: "ultimi 7 giorni"
        case .mese: "ultimi 30 giorni"
        }
    }

    var breve: String {
        switch self {
        case .ieri: "ieri"
        case .settimana: "7 giorni"
        case .mese: "30 giorni"
        }
    }
}

/// Un'app della stanza App Store (per nome, come la cerca il Mac), oppure tutte.
struct AppGuadagni: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "App"
    static let defaultQuery = AppGuadagniQuery()
    static let tutte = AppGuadagni(id: "*", nome: "Tutte le app")

    let id: String
    let nome: String

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(nome)") }
    var tutteLeApp: Bool { id == Self.tutte.id }
}

struct AppGuadagniQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [AppGuadagni] {
        identifiers.map { $0 == AppGuadagni.tutte.id ? .tutte : AppGuadagni(id: $0, nome: $0) }
    }

    /// Le app viste l'ultima volta nella stanza App Store (dall'app o da questo widget).
    func suggestedEntities() async throws -> [AppGuadagni] {
        [.tutte] + CacheWidget.appNote().map { AppGuadagni(id: $0, nome: $0) }
    }

    func defaultResult() async -> AppGuadagni? { .tutte }
}

struct ConfiguraGuadagni: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Guadagni"
    static let description = IntentDescription("Quanto hanno reso le app: il periodo e, se vuoi, una sola app.")

    @Parameter(title: "Periodo", default: .settimana)
    var periodo: PeriodoGuadagni

    @Parameter(title: "App")
    var app: AppGuadagni?

    init() {}

    init(periodo: PeriodoGuadagni, app: AppGuadagni? = nil) {
        self.periodo = periodo
        self.app = app
    }
}

// MARK: - timeline

struct VoceGuadagni: TimelineEntry {
    let date: Date
    let letto: Letto<DatiGuadagni>
    let periodo: PeriodoGuadagni
    /// nil = tutte le app.
    let app: String?

    var titolo: String { app ?? "Guadagni" }

    static func query(_ periodo: PeriodoGuadagni, _ app: String?) -> [String: String] {
        var q = ["periodo": periodo.rawValue]
        if let app { q["progetto"] = app }
        return q
    }

    static func esempio(_ periodo: PeriodoGuadagni = .settimana) -> VoceGuadagni {
        let cal = Calendar.current
        let n = periodo == .mese ? 30 : 7
        let oggi = cal.startOfDay(for: .now)
        let admob: [Double] = [7.2, 8.9, 6.4, 9.8, 11.2, 10.4, 12.6, 9.1, 8.3, 10.9, 12.2, 11.4, 9.6, 13.1, 12.8, 10.2, 9.4, 11.7, 12.9, 14.2, 13.3, 11.8, 10.6, 12.4, 13.9, 15.1, 14.4, 12.7, 13.6, 14.8]
        let punti = (0..<n).map { i -> DatiGuadagni.Punto in
            let d = cal.date(byAdding: .day, value: i - n, to: oggi) ?? oggi
            let k = d.formatted(.iso8601.year().month().day().dateSeparator(.dash))
            let a = admob[(admob.count - n + i) % admob.count]
            return DatiGuadagni.Punto(chiave: k, admob: a, store: i == n - 1 ? nil : (a * 0.22).rounded(), nelPeriodo: periodo != .ieri || i == n - 1)
        }
        let nel = punti.filter(\.nelPeriodo)
        let a = nel.map(\.admob).reduce(0, +)
        let s = nel.compactMap(\.store).reduce(0, +)
        let dati = DatiGuadagni(
            aggiornatoAt: Date().timeIntervalSince1970 * 1000, periodo: Double(n), etichetta: periodo == .ieri ? "ieri" : "ultimi \(n) giorni",
            cifre: .init(totale: a + s, admob: a, store: s), prima: .init(totale: (a + s) * 0.88, admob: a * 0.9, store: s * 0.8),
            grafico: punti, storeFinoA: punti.dropLast().last?.chiave, storeIncompleto: true,
            app: [.init(chiave: "1", nome: "Lanterna", totale: (a + s) * 0.52), .init(chiave: "2", nome: "Marea", totale: (a + s) * 0.31),
                  .init(chiave: "3", nome: "Taccuino", totale: (a + s) * 0.12)],
            buchi: [.init(id: "b1", app: "Marea", gravita: "alta", titolo: "Manca il consenso per gli annunci in Europa", cosa: "Aggiungi il modulo del consenso.", stima: 38)],
            buchiTotali: 3, stimaTotale: 61)
        return VoceGuadagni(date: .now, letto: Letto(dati: dati, visto: .now, fonte: .diretta, errore: nil), periodo: periodo, app: nil)
    }
}

struct FornitoreGuadagni: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> VoceGuadagni { .esempio() }

    func snapshot(for configuration: ConfiguraGuadagni, in context: Context) async -> VoceGuadagni {
        let (periodo, app) = Self.scelta(configuration)
        if context.isPreview {
            // la galleria: l'ultima copia se c'e', altrimenti la fantasia (mai il Mac, deve essere subito)
            if let l = DatiWidget.copia(DatiGuadagni.self, stanza: "appstore", query: VoceGuadagni.query(periodo, app)) {
                return VoceGuadagni(date: .now, letto: l, periodo: periodo, app: app)
            }
            return .esempio(periodo)
        }
        return await Self.leggi(periodo, app)
    }

    func timeline(for configuration: ConfiguraGuadagni, in context: Context) async -> Timeline<VoceGuadagni> {
        let (periodo, app) = Self.scelta(configuration)
        let voce = await Self.leggi(periodo, app)
        // AdMob e lo Store cambiano poche volte al giorno: ogni mezz'ora basta (e la push del Mac per un allarme)
        return Timeline(entries: [voce], policy: .after(Date().addingTimeInterval(30 * 60)))
    }

    static func scelta(_ c: ConfiguraGuadagni) -> (PeriodoGuadagni, String?) {
        let app = c.app.flatMap { $0.tutteLeApp ? nil : $0.nome }
        return (c.periodo, app)
    }

    static func leggi(_ periodo: PeriodoGuadagni, _ app: String?) async -> VoceGuadagni {
        let l = await DatiWidget.leggi(DatiGuadagni.self, stanza: "appstore", query: VoceGuadagni.query(periodo, app))
        return VoceGuadagni(date: .now, letto: l, periodo: periodo, app: app)
    }
}

// MARK: - widget

struct GuadagniWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: TipiWidget.guadagni, intent: ConfiguraGuadagni.self, provider: FornitoreGuadagni()) { voce in
            VistaGuadagni(voce: voce)
                .widgetURL(URL(string: "bottega://stanze?nome=appstore"))
        }
        .configurationDisplayName("Guadagni")
        .description("Quanto rendono le app: AdMob e Store, il confronto con prima, le app migliori e il primo buco da sistemare.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryInline])
        .pushHandler(SpintaWidget.self)
    }
}

struct VistaGuadagni: View {
    let voce: VoceGuadagni
    @Environment(\.widgetFamily) private var famiglia

    var body: some View {
        Group {
            if let d = voce.letto.dati {
                switch famiglia {
                case .accessoryRectangular: GuadagniRettangolo(voce: voce, d: d)
                case .accessoryInline: GuadagniRiga(voce: voce, d: d)
                case .systemLarge: GuadagniGrande(voce: voce, d: d)
                case .systemMedium: GuadagniMedio(voce: voce, d: d)
                default: GuadagniPiccolo(voce: voce, d: d)
                }
            } else {
                switch famiglia {
                case .accessoryInline:
                    Label(voce.letto.fonte == .scollegato ? "Bottega da collegare" : "Guadagni non letti", systemImage: "eurosign.circle")
                case .accessoryRectangular:
                    VStack(alignment: .leading) {
                        Label("Guadagni", systemImage: "eurosign.circle").font(.caption.weight(.semibold))
                        Text(voce.letto.fonte == .scollegato ? "Collega il Mac" : (voce.letto.errore ?? "Il Mac non risponde"))
                            .font(.footnote)
                            .lineLimit(2)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                default:
                    VStack(alignment: .leading, spacing: 6) {
                        TestataWidget(titolo: voce.titolo)
                        VuotoWidget(fonte: voce.letto.fonte, errore: voce.letto.errore)
                    }
                }
            }
        }
        .sfondoBottega(famiglia)
    }
}

// MARK: - pezzi

/// La cifra grande, in ambra: scorre da sola da un valore all'altro.
private struct Totale: View {
    let valore: Double
    var dimensione: CGFloat = 30

    var body: some View {
        Text(FormatiWidget.euro(valore))
            .font(.system(size: dimensione, weight: .semibold, design: .rounded))
            .monospacedDigit()
            .contentTransition(.numericText(value: valore))
            .foregroundStyle(Tinte.ambra)
            .lineLimit(1)
            .minimumScaleFactor(0.55)
            .widgetAccentable()
    }
}

/// Le barre dei giorni, AdMob sotto e Store sopra; i giorni fuori dal periodo (per ieri, la settimana) piu' tenui.
private struct Barre: View {
    let punti: [DatiGuadagni.Punto]
    var assi = false
    @Environment(\.widgetRenderingMode) private var modo

    var body: some View {
        let colori = modo == .fullColor
        Chart {
            ForEach(punti) { p in
                BarMark(x: .value("Giorno", p.chiave), y: .value("Euro", p.admob), width: .ratio(0.72))
                    .foregroundStyle(by: .value("Fonte", "AdMob"))
                    .opacity(p.nelPeriodo ? 1 : 0.38)
                if let s = p.store {
                    BarMark(x: .value("Giorno", p.chiave), y: .value("Euro", s), width: .ratio(0.72))
                        .foregroundStyle(by: .value("Fonte", "Store"))
                        .opacity(p.nelPeriodo ? 1 : 0.38)
                }
            }
        }
        .chartForegroundStyleScale(["AdMob": colori ? ColoriWidget.admob : Color.primary,
                                    "Store": colori ? ColoriWidget.store : Color.primary.opacity(0.45)])
        .chartLegend(.hidden)
        .chartXAxis(.hidden)
        .chartYAxis {
            if assi {
                AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { v in
                    AxisGridLine().foregroundStyle(Tinte.bordo.opacity(0.7))
                    AxisValueLabel {
                        if let e = v.as(Double.self) { Text(FormatiWidget.euro(e)).font(.system(size: 8)).foregroundStyle(Tinte.tinta) }
                    }
                }
            }
        }
    }
}

/// «AdMob 70 €  Store 14 €», con il pallino del colore; lo Store a meta' lo dice.
private struct Fonti: View {
    let d: DatiGuadagni
    var verticale = false

    var body: some View {
        let layout = verticale ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(spacing: 8))
        layout {
            voce("AdMob", d.cifre.admob, ColoriWidget.admob)
            voce(d.incompleto ? "Store*" : "Store", d.cifre.store, ColoriWidget.store)
        }
        .font(.caption2)
        .lineLimit(1)
    }

    private func voce(_ nome: String, _ v: Double, _ colore: Color) -> some View {
        HStack(spacing: 4) {
            Circle().fill(colore).frame(width: 6, height: 6)
            Text(nome).foregroundStyle(Tinte.tinta)
            Text(FormatiWidget.euro(v))
                .foregroundStyle(Tinte.testo)
                .monospacedDigit()
                .contentTransition(.numericText(value: v))
        }
    }
}

/// «Store fino al 1 ott»: il report di Apple non e' ancora uscito per gli ultimi giorni.
private struct NotaStore: View {
    let d: DatiGuadagni

    var body: some View {
        if d.incompleto {
            Text(d.storeFinoA.map { "* Store fino al \(FormatiWidget.giornoBreve($0))" } ?? "* Store parziale")
                .font(.caption2)
                .foregroundStyle(Tinte.tinta)
                .lineLimit(1)
        }
    }
}

/// Il secondo numero: con «ieri» la settimana intorno, altrimenti ieri.
private func altroNumero(_ voce: VoceGuadagni, _ d: DatiGuadagni) -> (String, Double)? {
    guard !d.grafico.isEmpty else { return nil }
    if voce.periodo == .ieri {
        guard !d.incompleto || d.grafico.allSatisfy({ $0.store != nil }) else {
            return ("AdMob 7 giorni", d.grafico.map(\.admob).reduce(0, +))
        }
        return ("7 giorni", d.grafico.map(\.totale).reduce(0, +))
    }
    guard let ultimo = d.grafico.last else { return nil }
    return ultimo.store == nil ? ("AdMob ieri", ultimo.admob) : ("ieri", ultimo.totale)
}

private struct Freccia: View {
    let d: DatiGuadagni

    var body: some View {
        if let c = d.confronto { FrecciaWidget(adesso: c.adesso, prima: c.prima) }
    }
}

// MARK: - piccolo

private struct GuadagniPiccolo: View {
    let voce: VoceGuadagni
    let d: DatiGuadagni

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            TestataWidget(titolo: voce.titolo) { Freccia(d: d) }
            Spacer(minLength: 2)
            Totale(valore: d.cifre.totale, dimensione: 30)
            Text(voce.periodo.detto + (d.incompleto ? "*" : ""))
                .font(.caption2)
                .foregroundStyle(Tinte.tinta)
            Barre(punti: d.grafico)
                .frame(height: 26)
                .padding(.top, 3)
            Spacer(minLength: 2)
            if voce.letto.fonte == .salvata {
                EtaWidget(visto: voce.letto.visto, fonte: voce.letto.fonte)
            } else {
                Fonti(d: d)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

// MARK: - medio

private struct GuadagniMedio: View {
    let voce: VoceGuadagni
    let d: DatiGuadagni

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                TestataWidget(titolo: voce.titolo)
                Spacer(minLength: 0)
                Totale(valore: d.cifre.totale, dimensione: 32)
                HStack(spacing: 6) {
                    Text(voce.periodo.detto)
                        .font(.caption2)
                        .foregroundStyle(Tinte.tinta)
                    Freccia(d: d)
                }
                Spacer(minLength: 0)
                Fonti(d: d, verticale: true)
            }
            .frame(width: 128, alignment: .leading)

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    if let (nome, v) = altroNumero(voce, d) {
                        Text(nome).font(.caption2).foregroundStyle(Tinte.tinta)
                        Text(FormatiWidget.euro(v))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Tinte.testo)
                            .monospacedDigit()
                            .contentTransition(.numericText(value: v))
                    }
                    Spacer(minLength: 0)
                    EtaWidget(visto: voce.letto.visto, fonte: voce.letto.fonte)
                }
                Barre(punti: d.grafico, assi: true)
                NotaStore(d: d)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

// MARK: - grande

private struct GuadagniGrande: View {
    let voce: VoceGuadagni
    let d: DatiGuadagni

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TestataWidget(titolo: voce.titolo) { EtaWidget(visto: voce.letto.visto, fonte: voce.letto.fonte) }

            HStack(alignment: .lastTextBaseline, spacing: 8) {
                Totale(valore: d.cifre.totale, dimensione: 36)
                VStack(alignment: .leading, spacing: 1) {
                    Freccia(d: d)
                    Text(voce.periodo.detto)
                        .font(.caption2)
                        .foregroundStyle(Tinte.tinta)
                }
                Spacer(minLength: 0)
            }
            Fonti(d: d)

            Barre(punti: d.grafico, assi: true)
                .frame(height: 74)
            NotaStore(d: d)

            if !d.app.isEmpty, voce.app == nil {
                MiglioriApp(app: Array(d.app.prefix(3)))
            }
            Spacer(minLength: 0)
            if let b = d.buchi.first {
                PrimoBuco(buco: b, altri: Int(d.buchiTotali) - 1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// Le tre app che rendono di piu', con una barra lunga quanto la loro parte.
private struct MiglioriApp: View {
    let app: [DatiGuadagni.App]

    var body: some View {
        let massimo = max(app.map(\.totale).max() ?? 1, 0.01)
        VStack(alignment: .leading, spacing: 4) {
            Text("Le app che rendono di più")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Tinte.tinta)
            ForEach(app) { a in
                HStack(spacing: 8) {
                    Text(a.nome)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Tinte.testo)
                        .lineLimit(1)
                        .frame(width: 92, alignment: .leading)
                    GeometryReader { g in
                        Capsule()
                            .fill(ColoriWidget.admob.opacity(0.85))
                            .frame(width: max(4, g.size.width * a.totale / massimo), height: 5)
                            .frame(maxHeight: .infinity, alignment: .center)
                    }
                    .frame(height: 10)
                    Text(FormatiWidget.euro(a.totale))
                        .font(.caption)
                        .foregroundStyle(Tinte.testo)
                        .monospacedDigit()
                        .frame(width: 62, alignment: .trailing)
                }
            }
        }
    }
}

/// Il primo buco da sistemare, con quanto vale al mese.
private struct PrimoBuco: View {
    let buco: DatiGuadagni.Buco
    let altri: Int

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "wrench.and.screwdriver.fill")
                .font(.caption)
                .foregroundStyle(Tinte.ambra)
                .widgetAccentable()
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(buco.titolo)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Tinte.testo)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(buco.app)
                    if let s = buco.stima, s >= 1 {
                        Text("≈ \(FormatiWidget.euro(s)) al mese")
                            .foregroundStyle(Tinte.ambra)
                            .monospacedDigit()
                    }
                    if altri > 0 {
                        Text(altri == 1 ? "e un altro" : "e altri \(altri)")
                    }
                }
                .font(.caption2)
                .foregroundStyle(Tinte.tinta)
                .lineLimit(1)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Tinte.notteFonda.opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Tinte.bordo, lineWidth: 0.5))
    }
}

// MARK: - schermata di blocco

private struct GuadagniRettangolo: View {
    let voce: VoceGuadagni
    let d: DatiGuadagni

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 3) {
                    Image(systemName: "eurosign.circle.fill")
                    Text(voce.app ?? voce.periodo.breve)
                    if let c = d.confronto, let v = FormatiWidget.variazione(c.adesso, c.prima) {
                        Text(FormatiWidget.percento(v)).monospacedDigit()
                    }
                }
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
                Text(FormatiWidget.euro(d.cifre.totale))
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: d.cifre.totale))
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                    .widgetAccentable()
                Text(voce.letto.fonte == .salvata ? "dato di prima" : "AdMob \(FormatiWidget.euro(d.cifre.admob))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Barre(punti: Array(d.grafico.suffix(7)))
                .frame(width: 46)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct GuadagniRiga: View {
    let voce: VoceGuadagni
    let d: DatiGuadagni

    var body: some View {
        let freccia = d.confronto.flatMap { FormatiWidget.variazione($0.adesso, $0.prima) }.map { ", \(FormatiWidget.percento($0))" } ?? ""
        Label("\(FormatiWidget.euro(d.cifre.totale)) \(voce.periodo.breve)\(freccia)", systemImage: "eurosign.circle")
    }
}

// MARK: - anteprime (dati di fantasia)

#Preview("Piccolo", as: .systemSmall) {
    GuadagniWidget()
} timeline: {
    VoceGuadagni.esempio(.settimana)
    VoceGuadagni(date: .now, letto: .scollegato, periodo: .settimana, app: nil)
}

#Preview("Medio", as: .systemMedium) {
    GuadagniWidget()
} timeline: {
    VoceGuadagni.esempio(.ieri)
}

#Preview("Grande", as: .systemLarge) {
    GuadagniWidget()
} timeline: {
    VoceGuadagni.esempio(.mese)
}

#Preview("Blocco", as: .accessoryRectangular) {
    GuadagniWidget()
} timeline: {
    VoceGuadagni.esempio(.ieri)
}
