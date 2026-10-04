//
//  OggiWidget.swift
//  Bottega Nucleo, widget da scrivania
//
//  "Oggi" (kind com.andreapiani.bottega.oggi): today's hours, the last seven days as
//  bars with today lit by the sodium lamp, what is waiting for Andrea, the rules light,
//  yesterday's money when the radar has it. Medium and large add three buttons.
//  Data: ~/.bottega/stato.json through Stato (rules) and StatoNativo (everything else).
//
//  The buttons are Links, like the existing widget's widgetURL: a click reaches the
//  Nucleo (the containing app), which hands the bottega:// link to the Bottega.
//

import Charts
import SwiftUI
import WidgetKit

struct OggiEntry: TimelineEntry {
    let date: Date
    let stato: Stato
    let nativo: StatoNativo
}

struct OggiProvider: TimelineProvider {
    func placeholder(in context: Context) -> OggiEntry { Self.esempio(Date()) }

    func getSnapshot(in context: Context, completion: @escaping (OggiEntry) -> Void) {
        completion(context.isPreview ? Self.esempio(Date()) : Self.vero(Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<OggiEntry>) -> Void) {
        let now = Date()
        // Every 15 minutes, and right after midnight so "oggi" starts again from zero.
        let cal = Calendar(identifier: .gregorian)
        let midnight = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: now)) ?? now
        let next = min(now.addingTimeInterval(15 * 60), midnight.addingTimeInterval(30))
        completion(Timeline(entries: [Self.vero(now)], policy: .after(next)))
    }

    static func vero(_ now: Date) -> OggiEntry {
        // Read once: the writer replaces the file atomically. Two reads could mix
        // the rules of one generation with the hours of the following generation.
        guard let data = try? Data(contentsOf: Stato.fileURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return OggiEntry(date: now, stato: Stato(), nativo: StatoNativo())
        }
        return OggiEntry(date: now, stato: Stato.parse(object), nativo: StatoNativo.parse(object))
    }

    /// Plausible, invented data for the gallery and the placeholder.
    static func esempio(_ now: Date) -> OggiEntry {
        var s = Stato()
        s.present = true
        s.rosso = 0; s.giallo = 2; s.verde = 12
        let cal = Calendar(identifier: .gregorian)
        let minutes = [190, 245, 80, 0, 310, 220, 135]
        let giorni = minutes.enumerated().map { i, m in
            ["date": StatoNativo.day(cal.date(byAdding: .day, value: i - 6, to: now) ?? now), "minuti": m] as [String: Any]
        }
        let ms = now.timeIntervalSince1970 * 1000
        let n = StatoNativo.parse([
            "aggiornato": ms,
            "ore": ["oggi": 135, "ieri": 220, "settimana": 1180, "giorni": giorni],
            "lavori": ["inCorso": 1, "tiAspetta": 2, "inCoda": 0, "stanotte": 1, "vive": 3, "voci": [
                ["key": "job:1", "progetto": "Faro", "path": "/esempio/Faro", "titolo": "sistema il login con Apple",
                 "stato": "ti aspetta", "da": ms - 20 * 60_000],
                ["key": "sess:2", "progetto": "Taccuino", "path": "/esempio/Taccuino", "titolo": "aggiorna le traduzioni",
                 "stato": "ti aspetta", "da": ms - 70 * 60_000],
                ["key": "job:3", "progetto": "Orto", "path": "/esempio/Orto", "titolo": "rifai le icone",
                 "stato": "in corso", "da": ms - 5 * 60_000],
            ]],
            "soldi": ["ieri": 12.4, "sette": 81.9, "valuta": "USD"],
        ])
        return OggiEntry(date: now, stato: s, nativo: n)
    }
}

// MARK: - Palette: night over La Palma, sodium street lamps (same values as BottegaWidget)

private enum Notte {
    static let night = Color(red: 0.07, green: 0.07, blue: 0.10)
    static let horizon = Color(red: 0.13, green: 0.10, blue: 0.09)
    static let sodium = Color(red: 1.00, green: 0.69, blue: 0.29)
    static let ember = Color(red: 0.93, green: 0.48, blue: 0.18)
    static let rosso = Color(red: 0.96, green: 0.33, blue: 0.29)
    static let giallo = Color(red: 0.98, green: 0.78, blue: 0.27)
    static let verde = Color(red: 0.42, green: 0.82, blue: 0.53)
    static let text = Color.white.opacity(0.92)
    static let dim = Color.white.opacity(0.55)
    static let faint = Color.white.opacity(0.12)
}

/// The sky behind the widget: a dark gradient, a few fixed stars, the town's sodium glow low on the horizon.
private struct CieloNotturno: View {
    var body: some View {
        ZStack {
            LinearGradient(colors: [Notte.night, Notte.horizon], startPoint: .top, endPoint: .bottom)
            Canvas { ctx, size in
                // Deterministic stars: the widget is archived as a still image, no animation.
                var seed: UInt64 = 0x5EED_1A9A
                for _ in 0..<26 {
                    seed = seed &* 6364136223846793005 &+ 1442695040888963407
                    let x = CGFloat(seed >> 40 & 0xFFFF) / 65535 * size.width
                    seed = seed &* 6364136223846793005 &+ 1442695040888963407
                    let y = CGFloat(seed >> 40 & 0xFFFF) / 65535 * size.height * 0.62
                    let r = CGFloat(seed >> 20 & 0x3) * 0.25 + 0.4
                    let a = Double(seed >> 10 & 0xFF) / 255 * 0.35 + 0.08
                    ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: r * 2, height: r * 2)), with: .color(.white.opacity(a)))
                }
            }
            RadialGradient(colors: [Notte.sodium.opacity(0.16), .clear], center: .bottom, startRadius: 0, endRadius: 220)
        }
    }
}

// MARK: - Pieces

/// "2 h 15 min" with the numbers large and the units small.
private struct OreGrandi: View {
    let minuti: Int
    var size: CGFloat = 32

    var body: some View {
        let h = max(0, minuti) / 60, m = max(0, minuti) % 60
        HStack(alignment: .firstTextBaseline, spacing: 2) {
            if h > 0 {
                number("\(h)")
                unit("h")
            }
            if m > 0 || h == 0 {
                number("\(m)").padding(.leading, h > 0 ? 4 : 0)
                unit("min")
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Oggi \(Formato.durata(minuti))")
    }

    private func number(_ s: String) -> some View {
        Text(s)
            .font(.system(size: size, weight: .semibold, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(Notte.text)
            .widgetAccentable()
    }

    private func unit(_ s: String) -> some View {
        Text(s)
            .font(.system(size: size * 0.42, weight: .medium, design: .rounded))
            .foregroundStyle(Notte.dim)
    }
}

/// Seven bars, oldest first, today in sodium.
private struct GraficoSettimana: View {
    let giorni: [StatoNativo.Giorno]
    let today: String
    var assi: Assi = .nessuno
    var annota = false

    enum Assi { case nessuno, iniziali, brevi }

    var body: some View {
        let top = max(60, giorni.map(\.minuti).max() ?? 0)
        Chart(giorni, id: \.date) { g in
            BarMark(x: .value("Giorno", g.date), y: .value("Minuti", g.minuti), width: .ratio(0.62))
                .foregroundStyle(g.date == today
                    ? AnyShapeStyle(LinearGradient(colors: [Notte.sodium, Notte.ember], startPoint: .top, endPoint: .bottom))
                    : AnyShapeStyle(Notte.sodium.opacity(0.24)))
                .cornerRadius(3)
                .annotation(position: .top, spacing: 2) {
                    if annota && g.date == today && g.minuti > 0 {
                        Text(Formato.durata(g.minuti))
                            .font(.system(size: 9, weight: .semibold, design: .rounded))
                            .foregroundStyle(Notte.sodium)
                    }
                }
        }
        .chartYScale(domain: 0...Double(top) * (annota ? 1.25 : 1.0))
        .chartYAxis(.hidden)
        .chartXAxis {
            if assi == .nessuno {
                AxisMarks { _ in }
            } else {
                AxisMarks { value in
                    AxisValueLabel {
                        let d = value.as(String.self) ?? ""
                        Text(Self.nome(d, brevi: assi == .brevi))
                            .font(.system(size: 9, weight: d == today ? .semibold : .regular, design: .rounded))
                            .foregroundStyle(d == today ? Notte.sodium : Notte.dim)
                    }
                }
            }
        }
        .accessibilityLabel("Ore degli ultimi sette giorni")
    }

    /// "2026-10-02" -> "gi" or "gio".
    static func nome(_ iso: String, brevi: Bool) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        guard let d = f.date(from: iso) else { return "" }
        let wd = Calendar(identifier: .gregorian).component(.weekday, from: d)   // 1 = Sunday
        let names = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"]
        let n = names[(wd - 1) % 7]
        return brevi ? n : String(n.prefix(2))
    }
}

/// The rules light on its side: three small lamps.
private struct SemaforoPiccolo: View {
    let stato: Stato

    var body: some View {
        HStack(spacing: 3) {
            lamp(Notte.rosso, on: stato.present && stato.rosso > 0)
            lamp(Notte.giallo, on: stato.present && stato.rosso == 0 && stato.giallo > 0)
            lamp(Notte.verde, on: stato.present && stato.rosso == 0 && stato.giallo == 0)
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 3)
        .background(Capsule().fill(Color.black.opacity(0.35)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(stato.rulesSentence)
    }

    private func lamp(_ c: Color, on: Bool) -> some View {
        Circle()
            .fill(on ? c : c.opacity(0.14))
            .frame(width: 7, height: 7)
            .shadow(color: on ? c.opacity(0.8) : .clear, radius: 3)
    }
}

private struct Pulsanti: View {
    var corti = false

    private static let voci: [(titolo: String, corto: String, icona: String, via: String)] = [
        ("Parla con Melissa", "Melissa", "waveform", "melissa"),
        ("Apri la plancia", "Plancia", "square.grid.2x2", "plancia"),
        ("Nuovo lavoro", "Lavoro", "hammer", "lavoro"),
    ]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(Self.voci, id: \.via) { v in
                if let url = BottegaURL.make(v.via) {
                    Link(destination: url) {
                        HStack(spacing: 4) {
                            Image(systemName: v.icona).font(.system(size: 10, weight: .semibold))
                            Text(corti ? v.corto : v.titolo)
                                .font(.system(size: 11, weight: .medium, design: .rounded))
                                .lineLimit(1)
                        }
                        .foregroundStyle(Notte.sodium)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .frame(maxWidth: .infinity)
                        .background(Capsule().fill(Notte.sodium.opacity(0.13)))
                        .overlay(Capsule().strokeBorder(Notte.sodium.opacity(0.28), lineWidth: 0.5))
                    }
                    .accessibilityLabel(v.titolo)
                }
            }
        }
    }
}

// MARK: - The widget

struct OggiWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: OggiEntry

    private var n: StatoNativo { entry.nativo }
    private var today: String { StatoNativo.day(entry.date) }
    private var oggi: Int { n.minutiOggi(entry.date) }
    private var giorni: [StatoNativo.Giorno] { n.ultimiSette(entry.date) }
    private var waiting: [StatoNativo.Voce] { n.tiAspettano }
    private var waitingCount: Int { max(waiting.count, n.lavori?.tiAspetta ?? 0) }

    var body: some View {
        if !n.present || !n.hasOre {
            vuoto
        } else {
            switch family {
            case .systemSmall: small
            case .systemLarge: large
            default: medium
            }
        }
    }

    // MARK: small

    private var small: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                etichetta("oggi")
                Spacer(minLength: 4)
                SemaforoPiccolo(stato: entry.stato)
            }
            OreGrandi(minuti: oggi, size: 30)
            aggiornamento
            if waitingCount > 0 {
                Text(waitingCount == 1 ? "1 lavoro ti aspetta" : "\(waitingCount) lavori ti aspettano")
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                    .foregroundStyle(Notte.sodium)
                    .lineLimit(1)
            } else {
                Text("settimana \(Formato.durata(n.minutiSettimana(entry.date)))")
                    .font(.caption2).foregroundStyle(Notte.dim).lineLimit(1)
            }
            Spacer(minLength: 2)
            GraficoSettimana(giorni: giorni, today: today)
                .frame(height: 40)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: medium

    private var medium: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                etichetta("oggi")
                Spacer(minLength: 4)
                if let s = n.soldi { soldi(s) }
                SemaforoPiccolo(stato: entry.stato)
            }
            HStack(alignment: .bottom, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    OreGrandi(minuti: oggi, size: 30)
                    Text("settimana \(Formato.durata(n.minutiSettimana(entry.date)))")
                        .font(.caption2).foregroundStyle(Notte.dim).lineLimit(1)
                    attesaBreve
                }
                .fixedSize(horizontal: true, vertical: false)
                GraficoSettimana(giorni: giorni, today: today, assi: .iniziali)
                    .frame(maxWidth: .infinity)
            }
            .frame(maxHeight: .infinity)
            aggiornamento
            ViewThatFits(in: .horizontal) {
                Pulsanti(corti: false)
                Pulsanti(corti: true)
            }
        }
    }

    @ViewBuilder private var attesaBreve: some View {
        if waitingCount > 0 {
            let names = Array(Set(waiting.map(\.progetto))).sorted().prefix(2)
            let tail = names.isEmpty ? "" : ": " + names.joined(separator: ", ")
            Text("\(waitingCount) ti \(waitingCount == 1 ? "aspetta" : "aspettano")\(tail)")
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .foregroundStyle(Notte.sodium)
                .lineLimit(1)
                .frame(maxWidth: 150, alignment: .leading)
        } else {
            Text("niente ti aspetta").font(.caption2).foregroundStyle(Notte.dim)
        }
    }

    // MARK: large

    private var large: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                etichetta("bottega")
                Text(Self.dataLunga(entry.date)).font(.caption2).foregroundStyle(Notte.dim)
                Spacer(minLength: 4)
                SemaforoPiccolo(stato: entry.stato)
            }
            HStack(alignment: .firstTextBaseline) {
                OreGrandi(minuti: oggi, size: 42)
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    if let ieri = n.minutiIeri(entry.date) { riga("ieri", Formato.durata(ieri)) }
                    riga("settimana", Formato.durata(n.minutiSettimana(entry.date)))
                    if let s = n.soldi { riga("AdMob ieri", Formato.soldi(s.ieri, s.valuta)) }
                }
            }
            GraficoSettimana(giorni: giorni, today: today, assi: .brevi, annota: true)
                .frame(height: 96)
            aggiornamento
            Divider().overlay(Notte.faint)
            attesaLista
            regole
            Spacer(minLength: 0)
            Pulsanti()
        }
    }

    @ViewBuilder private var attesaLista: some View {
        if waiting.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(waitingCount > 0 ? "\(waitingCount) \(waitingCount == 1 ? "lavoro ti aspetta" : "lavori ti aspettano")" : "Niente ti aspetta")
                    .font(.subheadline.weight(.medium)).foregroundStyle(waitingCount > 0 ? Notte.sodium : Notte.text)
                if let l = n.lavori, l.inCorso + l.stanotte > 0 {
                    Text(altriLavori(l)).font(.caption).foregroundStyle(Notte.dim)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 5) {
                Text(waiting.count == 1 ? "Ti aspetta" : "Ti aspettano")
                    .font(.caption2.weight(.semibold)).foregroundStyle(Notte.sodium)
                ForEach(waiting.prefix(3), id: \.key) { v in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "hourglass").font(.system(size: 9)).foregroundStyle(Notte.sodium)
                        Text(v.progetto).font(.caption.weight(.semibold)).foregroundStyle(Notte.text)
                        Text(v.titolo).font(.caption).foregroundStyle(Notte.dim).lineLimit(1)
                        Spacer(minLength: 4)
                        if let d = v.da {
                            Text(Formato.da(d, now: entry.date)).font(.caption2).foregroundStyle(Notte.dim).lineLimit(1)
                        }
                    }
                }
                if waiting.count > 3 {
                    Text("e altri \(waiting.count - 3)").font(.caption2).foregroundStyle(Notte.dim)
                }
            }
        }
    }

    @ViewBuilder private var regole: some View {
        let s = entry.stato
        if s.present {
            HStack(spacing: 6) {
                Circle().fill(s.rosso > 0 ? Notte.rosso : s.giallo > 0 ? Notte.giallo : Notte.verde).frame(width: 6, height: 6)
                Text(regoleRiga(s)).font(.caption).foregroundStyle(Notte.text).lineLimit(1)
            }
        }
    }

    // MARK: empty

    private var vuoto: some View {
        VStack(alignment: .leading, spacing: 6) {
            etichetta("oggi")
            Spacer(minLength: 0)
            Text("Nessun dato").font(.headline).foregroundStyle(Notte.text)
            Text("Apri la Bottega una volta: le ore arrivano da lì.")
                .font(.caption).foregroundStyle(Notte.dim)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: helpers

    private var aggiornamento: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 4) {
                Text(n.fontiOre)
                if let date = n.oreAggiornate { Text("· \(Self.dataAggiornamento(date))") }
            }
            if let date = n.oreAggiornate { Text("Dati del \(Self.dataAggiornamento(date))") }
        }
        .font(.system(size: 9, design: .rounded))
        .foregroundStyle(Notte.dim)
        .lineLimit(1)
        .accessibilityLabel("\(n.fontiOre). \(n.oreAggiornate.map { "Dati del " + Self.dataAggiornamento($0) } ?? "Aggiornamento sconosciuto")")
    }

    private static func dataAggiornamento(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "it_IT")
        // Keep the date even for today's snapshot: if WidgetKit cannot replace it,
        // the archived view still tells the truth tomorrow.
        formatter.dateFormat = "d/M HH:mm"
        return formatter.string(from: date)
    }

    private func etichetta(_ s: String) -> some View {
        Text(s)
            .font(.system(.caption2, design: .rounded).weight(.semibold))
            .foregroundStyle(Notte.sodium)
    }

    private func soldi(_ s: StatoNativo.Soldi) -> some View {
        Text("ieri \(Formato.soldi(s.ieri, s.valuta))")
            .font(.system(size: 10, weight: .medium, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(Notte.dim)
            .lineLimit(1)
    }

    private func riga(_ label: String, _ value: String) -> some View {
        HStack(spacing: 4) {
            Text(label).foregroundStyle(Notte.dim)
            Text(value).foregroundStyle(Notte.text).monospacedDigit()
        }
        .font(.caption)
        .lineLimit(1)
    }

    private func altriLavori(_ l: StatoNativo.Lavori) -> String {
        var parts: [String] = []
        if l.inCorso > 0 { parts.append("\(l.inCorso) in corso") }
        if l.stanotte > 0 { parts.append("\(l.stanotte) stanotte") }
        return Formato.elenco(parts)
    }

    private func regoleRiga(_ s: Stato) -> String {
        if s.rosso + s.giallo == 0 { return s.verde == 1 ? "Regole in ordine su 1 progetto" : "Regole in ordine su \(s.verde) progetti" }
        var parts: [String] = []
        if s.rosso > 0 { parts.append(s.rosso == 1 ? "1 regola rossa" : "\(s.rosso) regole rosse") }
        if s.giallo > 0 { parts.append(s.giallo == 1 ? "1 gialla" : "\(s.giallo) gialle") }
        return Formato.elenco(parts).prefix(1).uppercased() + Formato.elenco(parts).dropFirst()
    }

    /// "giovedì 2 ottobre".
    static func dataLunga(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "it_IT")
        f.dateFormat = "EEEE d MMMM"
        return f.string(from: d)
    }
}

struct BottegaOggiWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.andreapiani.bottega.oggi", provider: OggiProvider()) { entry in
            OggiWidgetView(entry: entry)
                .containerBackground(for: .widget) { CieloNotturno() }
                .widgetURL(BottegaURL.make("plancia"))
        }
        .configurationDisplayName("Oggi")
        .description("Le ore di oggi e della settimana, chi ti aspetta, il semaforo delle regole.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
