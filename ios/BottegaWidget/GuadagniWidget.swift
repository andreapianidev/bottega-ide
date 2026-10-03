//
//  GuadagniWidget.swift
//  Bottega per iPhone, estensione dei widget
//
//  Il widget «Guadagni»: quanto hanno reso le app ieri, nella settimana o nel mese, il totale in ambra, AdMob e
//  Store separati, la freccia sul periodo prima e le barre dei giorni (AdMob sotto, Store sopra, i colori della
//  stanza App Store). Nel grande anche le tre app che rendono di piu' e il primo buco da sistemare con la stima.
//  Nel piccolo solo la cifra, il periodo con la freccia e le barre. Nessun testo si taglia: ogni riga ha le sue
//  varianti dalla piu' ricca alla piu' asciutta (ViewThatFits), provate al banco con il testo grande (xLarge).
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
            let c = cal.dateComponents([.year, .month, .day], from: d)
            let k = String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
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
                        // la frase intera del Mac qui non ci sta: la sua versione corta
                        Text(FormatiWidget.erroreBreve(voce.letto.fonte, voce.letto.errore))
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

/// La cifra grande, in ambra: scorre da sola da un valore all'altro. Sopra il milione «1.234k €»; sotto, la cifra
/// intera, che puo' stringersi fino al 70% e mai essere tagliata.
private struct Totale: View {
    let valore: Double
    var dimensione: CGFloat = 30

    var body: some View {
        Text(abs(valore) >= 1_000_000 ? FormatiWidget.euroBreve(valore) : FormatiWidget.euro(valore))
            .font(.system(size: dimensione, weight: .semibold, design: .rounded))
            .monospacedDigit()
            .contentTransition(.numericText(value: valore))
            .foregroundStyle(Tinte.ambra)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .layoutPriority(1)
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
            AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { v in
                AxisGridLine().foregroundStyle(Tinte.bordo.opacity(0.7))
                AxisValueLabel {
                    if let e = v.as(Double.self) { Text(FormatiWidget.euroAsse(e)).font(.system(size: 8)).foregroundStyle(Tinte.tinta) }
                }
            }
        }
        .chartYAxis(assi ? .visible : .hidden)
    }
}

/// «AdMob 70 €  Store 14 €», con il pallino del colore; lo Store a meta' lo dice con l'asterisco. Se le cifre intere
/// non ci stanno su una riga si passa alle migliaia («9,9k €»), e solo poi si va a capo.
private struct Fonti: View {
    let d: DatiGuadagni
    var verticale = false

    var body: some View {
        Group {
            if verticale {
                VStack(alignment: .leading, spacing: 2) { voci(breve: false) }
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { voci(breve: false) }
                    HStack(spacing: 8) { voci(breve: true) }
                    VStack(alignment: .leading, spacing: 2) { voci(breve: false) }
                }
            }
        }
        .font(.caption2)
        .lineLimit(1)
    }

    @ViewBuilder private func voci(breve: Bool) -> some View {
        voce("AdMob", d.cifre.admob, ColoriWidget.admob, breve)
        voce(d.incompleto ? "Store*" : "Store", d.cifre.store, ColoriWidget.store, breve)
    }

    private func voce(_ nome: String, _ v: Double, _ colore: Color, _ breve: Bool) -> some View {
        HStack(spacing: 4) {
            Circle().fill(colore).frame(width: 6, height: 6)
            Text(nome).foregroundStyle(Tinte.tinta)
            Text(breve ? FormatiWidget.euroBreve(v) : FormatiWidget.euro(v))
                .foregroundStyle(Tinte.testo)
                .monospacedDigit()
                .contentTransition(.numericText(value: v))
        }
        .fixedSize()
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
                .fixedSize()
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

/// Il periodo e la freccia: sulla stessa riga se ci stanno, con il periodo corto se serve, altrimenti uno sotto l'altro.
private struct PeriodoEFreccia: View {
    let voce: VoceGuadagni
    let d: DatiGuadagni
    var corto = false

    var body: some View {
        ViewThatFits(in: .horizontal) {
            if !corto { riga(voce.periodo.detto) }
            riga(voce.periodo.breve)
            VStack(alignment: .leading, spacing: 1) {
                etichetta(voce.periodo.breve)
                Freccia(d: d)
            }
        }
    }

    private func riga(_ periodo: String) -> some View {
        HStack(spacing: 6) {
            etichetta(periodo)
            Freccia(d: d)
        }
    }

    private func etichetta(_ s: String) -> some View {
        Text(s)
            .font(.caption2)
            .foregroundStyle(Tinte.tinta)
            .lineLimit(1)
            .fixedSize()
    }
}

// MARK: - piccolo

/// Poche cose grandi: la cifra, il periodo con la freccia, le barre. AdMob e Store stanno nel medio e nel grande.
private struct GuadagniPiccolo: View {
    let voce: VoceGuadagni
    let d: DatiGuadagni

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            TestataWidget(titolo: voce.titolo)
            Spacer(minLength: 4)
            Totale(valore: d.cifre.totale, dimensione: 30)
            PeriodoEFreccia(voce: voce, d: d, corto: true)
            Barre(punti: d.grafico)
                .frame(minHeight: 18, maxHeight: 30)
                .padding(.top, 5)
            if voce.letto.fonte == .salvata {
                EtaWidget(visto: voce.letto.visto, fonte: voce.letto.fonte)
                    .padding(.top, 3)
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
        // la testata prende tutta la larghezza: il nome di un'app lunga ci sta, e l'ora ha il suo posto a destra
        VStack(alignment: .leading, spacing: 6) {
            TestataWidget(titolo: voce.titolo) { EtaWidget(visto: voce.letto.visto, fonte: voce.letto.fonte).fixedSize() }
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Spacer(minLength: 0)
                    Totale(valore: d.cifre.totale, dimensione: 32)
                    PeriodoEFreccia(voce: voce, d: d)
                    Spacer(minLength: 0)
                    Fonti(d: d, verticale: true)
                }
                .frame(width: 128, alignment: .leading)

                VStack(alignment: .leading, spacing: 4) {
                    altro
                    Barre(punti: d.grafico, assi: true)
                    NotaStore(d: d)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    @ViewBuilder private var altro: some View {
        if let a = altroNumero(voce, d) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(a.0).font(.caption2).foregroundStyle(Tinte.tinta)
                Text(FormatiWidget.euro(a.1))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Tinte.testo)
                    .monospacedDigit()
                    .contentTransition(.numericText(value: a.1))
            }
            .lineLimit(1)
            .fixedSize()
        }
    }
}

// MARK: - grande

/// Dall'alto: la cifra, AdMob e Store, le barre, le app migliori, il primo buco. Se il testo e' grande o il buco ha un
/// titolo lungo, prima si abbassano le barre, poi si mostrano meno app: il titolo del buco resta intero.
private struct GuadagniGrande: View {
    let voce: VoceGuadagni
    let d: DatiGuadagni

    var body: some View {
        ViewThatFits(in: .vertical) {
            corpo(barre: 74, app: 3)
            corpo(barre: 54, app: 3)
            corpo(barre: 54, app: 2)
            corpo(barre: 46, app: 0)
            corpo(barre: 46, app: 0, ultimo: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func corpo(barre: CGFloat, app: Int, ultimo: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            TestataWidget(titolo: voce.titolo) { EtaWidget(visto: voce.letto.visto, fonte: voce.letto.fonte).fixedSize() }

            HStack(alignment: .lastTextBaseline, spacing: 8) {
                Totale(valore: d.cifre.totale, dimensione: 36)
                VStack(alignment: .leading, spacing: 1) {
                    Freccia(d: d)
                    Text(voce.periodo.detto)
                        .font(.caption2)
                        .foregroundStyle(Tinte.tinta)
                        .lineLimit(1)
                        .fixedSize()
                }
                Spacer(minLength: 0)
            }
            Fonti(d: d)

            Barre(punti: d.grafico, assi: true)
                .frame(height: barre)
            NotaStore(d: d)

            if app > 0, !d.app.isEmpty, voce.app == nil {
                MiglioriApp(app: Array(d.app.prefix(app)))
            }
            Spacer(minLength: 0)
            if let b = d.buchi.first {
                PrimoBuco(buco: b, altri: Int(d.buchiTotali) - 1, taglia: ultimo)
            }
        }
    }
}

/// Le app che rendono di piu', con una barra lunga quanto la loro parte. Il nome ha la precedenza sulla barra.
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
                        .layoutPriority(1)
                    GeometryReader { g in
                        Capsule()
                            .fill(ColoriWidget.admob.opacity(0.85))
                            .frame(width: max(4, g.size.width * a.totale / massimo), height: 5)
                            .frame(maxHeight: .infinity, alignment: .center)
                    }
                    .frame(minWidth: 24)
                    .frame(height: 10)
                    Text(FormatiWidget.euro(a.totale))
                        .font(.caption)
                        .foregroundStyle(Tinte.testo)
                        .monospacedDigit()
                        .lineLimit(1)
                        .fixedSize()
                }
            }
        }
    }
}

/// Il primo buco da sistemare, con quanto vale al mese. Il titolo resta intero; sotto, la stima ha la precedenza
/// sul nome dell'app e su «e altri 3».
private struct PrimoBuco: View {
    let buco: DatiGuadagni.Buco
    let altri: Int
    /// L'ultima risorsa, quando proprio non ci sta: il titolo su tre righe.
    var taglia = false

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
                    .lineLimit(taglia ? 3 : nil)
                    .fixedSize(horizontal: false, vertical: !taglia)
                ViewThatFits(in: .horizontal) {
                    sotto(app: true, altri: true)
                    sotto(app: true, altri: false)
                    sotto(app: false, altri: true)
                    sotto(app: false, altri: false)
                }
                .font(.caption2)
                .foregroundStyle(Tinte.tinta)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Tinte.notteFonda.opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Tinte.bordo, lineWidth: 0.5))
    }

    private func sotto(app: Bool, altri mostraAltri: Bool) -> some View {
        HStack(spacing: 6) {
            if app { Text(buco.app) }
            if let s = buco.stima, s >= 1 {
                Text("≈ \(FormatiWidget.euroIntero(s)) al mese")
                    .foregroundStyle(Tinte.ambra)
                    .monospacedDigit()
            }
            if mostraAltri, altri > 0 {
                Text(altri == 1 ? "e un altro" : "e altri \(altri)")
            }
        }
        .lineLimit(1)
        .fixedSize()
    }
}

// MARK: - schermata di blocco

private struct GuadagniRettangolo: View {
    let voce: VoceGuadagni
    let d: DatiGuadagni

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            VStack(alignment: .leading, spacing: 0) {
                // l'app (o il periodo) e la variazione; se non ci stanno, prima va via il simbolo
                ViewThatFits(in: .horizontal) {
                    testata(simbolo: true)
                    testata(simbolo: false)
                    Text(voce.app ?? voce.periodo.breve).lineLimit(1).minimumScaleFactor(0.7)
                }
                .font(.caption2.weight(.semibold))
                Text(FormatiWidget.euro(d.cifre.totale))
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: d.cifre.totale))
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                    .widgetAccentable()
                if voce.letto.fonte == .salvata {
                    Text("dato di prima").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                } else {
                    ViewThatFits(in: .horizontal) {
                        Text("AdMob \(FormatiWidget.euro(d.cifre.admob))")
                        Text("AdMob \(FormatiWidget.euroBreve(d.cifre.admob))")
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
            }
            .layoutPriority(1)
            Spacer(minLength: 0)
            Barre(punti: Array(d.grafico.suffix(7)))
                .frame(width: 40)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func testata(simbolo: Bool) -> some View {
        HStack(spacing: 3) {
            if simbolo { Image(systemName: "eurosign.circle.fill") }
            Text(voce.app ?? voce.periodo.breve)
            if let c = d.confronto, let v = FormatiWidget.variazione(c.adesso, c.prima) {
                Text(FormatiWidget.percento(v)).monospacedDigit()
            }
        }
        .lineLimit(1)
        .fixedSize()
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
