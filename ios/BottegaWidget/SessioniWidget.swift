//
//  SessioniWidget.swift
//  Bottega per iPhone, estensione dei widget
//
//  Il widget «Sessioni»: chi ti aspetta (in ambra), quante sessioni Claude sono al lavoro sul Mac, i primi progetti
//  e l'eta' del dato. Legge GET /v1/stato dal ponte con il collegamento condiviso (docs/CONTRATTI.md, 9.4); se il Mac
//  non risponde mostra l'ultimo stato salvato dall'app. Il Mac lo sveglia con una push «content-changed»: il token
//  arriva a SpintaWidget, che lo lascia nelle preferenze condivise per l'app.
//

import SwiftUI
import WidgetKit

// MARK: - dati

struct VoceSessioni: TimelineEntry {
    enum Fonte {
        /// Appena letto dal Mac.
        case diretta
        /// Il Mac non risponde: l'ultimo stato visto (puo' mancare).
        case salvata
        /// L'iPhone non e' collegato a nessun Mac.
        case scollegato
    }

    let date: Date
    let stato: StatoMac?
    let fonte: Fonte

    var tiAspetta: Int { stato?.conti.tiAspetta ?? 0 }
    var inCorso: Int { stato?.conti.inCorso ?? 0 }
    var quando: Date? { stato.map { Pezzi.data($0.ora) } }

    /// Le sessioni nell'ordine della stanza Lavori: prima chi ti aspetta.
    var lavori: [StatoMac.Lavoro] {
        (stato?.lavori ?? []).enumerated()
            .sorted { (Pezzi.rango($0.element.stato), $0.offset) < (Pezzi.rango($1.element.stato), $1.offset) }
            .map(\.element)
    }

    /// I progetti, ognuno una volta sola, nello stesso ordine.
    var progetti: [String] {
        var visti = Set<String>()
        return lavori.map(\.progetto).filter { visti.insert($0).inserted }
    }

    static var esempio: VoceSessioni {
        let ora = Date().timeIntervalSince1970 * 1000
        func lavoro(_ chiave: String, _ stato: String, _ progetto: String, _ titolo: String, _ minuti: Double) -> StatoMac.Lavoro {
            StatoMac.Lavoro(chiave: chiave, origine: "bottega", stato: stato, progetto: progetto, titolo: titolo,
                            da: ora - minuti * 60_000, jobId: nil)
        }
        let stato = StatoMac(
            versione: "", mac: "Mac", ora: ora,
            melissa: StatoMac.Melissa(stato: "riposo", cervello: "", parziale: nil, registro: []),
            lavori: [lavoro("a", "ti aspetta", "Sito", "Rivedere la pagina dei prezzi", 6),
                     lavoro("b", "in corso", "Bottega", "Widget per iPhone", 24),
                     lavoro("c", "in corso", "Appunti", "Riordino delle note", 52)],
            conti: StatoMac.Conti(inCorso: 2, tiAspetta: 1, inCoda: 0, vive: 3))
        return VoceSessioni(date: .now, stato: stato, fonte: .diretta)
    }
}

// MARK: - timeline

struct FornitoreSessioni: TimelineProvider {
    func placeholder(in context: Context) -> VoceSessioni { .esempio }

    func getSnapshot(in context: Context, completion: @escaping (VoceSessioni) -> Void) {
        if context.isPreview {
            completion(Collegamento.carica() == nil ? .esempio : VoceSessioni(date: .now, stato: StatoMac.ultimo() ?? VoceSessioni.esempio.stato, fonte: .salvata))
            return
        }
        Task { completion(await Self.leggi()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<VoceSessioni>) -> Void) {
        Task {
            let voce = await Self.leggi()
            completion(Timeline(entries: [voce], policy: .after(Date().addingTimeInterval(15 * 60))))
        }
    }

    static func leggi() async -> VoceSessioni {
        guard let c = Collegamento.carica() else { return VoceSessioni(date: .now, stato: nil, fonte: .scollegato) }
        if let s = await chiedi(c) {
            s.salvaComeUltimo()
            return VoceSessioni(date: .now, stato: s, fonte: .diretta)
        }
        return VoceSessioni(date: .now, stato: StatoMac.ultimo(), fonte: .salvata)
    }

    private static let sessione: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 6
        c.timeoutIntervalForResource = 8
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    /// Prima il nome MagicDNS; se non si risolve (MagicDNS spento sull'iPhone) l'indirizzo 100.x.
    private static func chiedi(_ c: Collegamento) async -> StatoMac? {
        do {
            return try await stato(c, host: c.host)
        } catch let e as URLError where [.cannotFindHost, .dnsLookupFailed].contains(e.code) && !c.ip.isEmpty && c.ip != c.host {
            return try? await stato(c, host: c.ip)
        } catch {
            return nil
        }
    }

    private static func stato(_ c: Collegamento, host: String) async throws -> StatoMac? {
        guard let url = URL(string: "http://\(host):\(c.porta)/v1/stato") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 6)
        req.setValue("Bearer \(c.token)", forHTTPHeaderField: "authorization")
        let (d, r) = try await sessione.data(for: req)
        guard let h = r as? HTTPURLResponse, (200..<300).contains(h.statusCode) else { return nil }
        return try? JSONDecoder().decode(StatoMac.self, from: d)
    }
}

// MARK: - push

/// Il token per le push dei widget (WidgetKit, iOS 26): in esadecimale nelle preferenze condivise sotto
/// `tokenWidget`. L'app lo manda al Mac con POST /v1/dispositivo {widget}; la notifica di Darwin la avvisa subito
/// se e' aperta.
struct SpintaWidget: WidgetPushHandler {
    static let chiave = Condiviso.chiaveTokenWidget
    static let avviso = "com.andreapiani.bottega.ios.tokenWidget"

    init() {}

    func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
        let esadecimale = pushInfo.token.map { String(format: "%02x", $0) }.joined()
        guard Condiviso.preferenze.string(forKey: Self.chiave) != esadecimale else { return }
        Condiviso.preferenze.set(esadecimale, forKey: Self.chiave)
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(),
                                             CFNotificationName(Self.avviso as CFString), nil, nil, true)
    }
}

// MARK: - widget

struct SessioniWidget: Widget {
    static let kind = "com.andreapiani.bottega.ios.widget.sessioni"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: FornitoreSessioni()) { voce in
            VistaSessioni(voce: voce)
                .widgetURL(Pezzi.lavori)
        }
        .configurationDisplayName("Sessioni")
        .description("Chi ti aspetta e quante sessioni Claude sono al lavoro sul Mac.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
        .pushHandler(SpintaWidget.self)
    }
}

struct VistaSessioni: View {
    let voce: VoceSessioni
    @Environment(\.widgetFamily) private var famiglia

    var body: some View {
        Group {
            switch famiglia {
            case .accessoryCircular: tondo
            case .accessoryRectangular: rettangolo
            case .accessoryInline: riga
            case .systemMedium: SessioniMedio(voce: voce)
            default: SessioniPiccolo(voce: voce)
            }
        }
        .containerBackground(for: .widget) {
            switch famiglia {
            case .accessoryCircular, .accessoryRectangular, .accessoryInline: Color.clear
            default: Tinte.sfondo
            }
        }
    }

    // MARK: schermata di blocco

    private var tondo: some View {
        ZStack {
            AccessoryWidgetBackground()
            if voce.fonte == .scollegato || voce.stato == nil {
                Image(systemName: "laptopcomputer.slash")
                    .font(.title3)
            } else {
                VStack(spacing: -1) {
                    Image(systemName: voce.tiAspetta > 0 ? "hand.raised.fill" : "hammer.fill")
                        .font(.system(size: 11, weight: .semibold))
                    Text("\(voce.tiAspetta > 0 ? voce.tiAspetta : voce.inCorso)")
                        .font(.system(size: 22, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .minimumScaleFactor(0.6)
                }
                .widgetAccentable(voce.tiAspetta > 0)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(Riassunto.frase(voce)))
    }

    private var rettangolo: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                Image(systemName: "hammer.fill")
                Text("Bottega")
                Spacer(minLength: 4)
                if let q = voce.quando, voce.fonte != .scollegato {
                    Text(q, style: .time)
                        .foregroundStyle(.secondary)
                }
            }
            .font(.caption.weight(.semibold))
            switch voce.fonte {
            case .scollegato:
                Text("Apri la Bottega e collega il Mac")
                    .font(.footnote)
                    .lineLimit(2)
            case _ where voce.stato == nil:
                Text("Il Mac non risponde")
                    .font(.headline)
            default:
                if voce.tiAspetta > 0 {
                    Text(Pezzi.aspetta(voce.tiAspetta))
                        .font(.headline)
                        .widgetAccentable()
                    Text(voce.inCorso > 0 ? "\(Pezzi.alLavoro(voce.inCorso)), \(progettiInBreve)" : progettiInBreve)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else if voce.inCorso > 0 {
                    Text(Pezzi.alLavoro(voce.inCorso))
                        .font(.headline)
                    Text(progettiInBreve)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else {
                    Text("Nessuna sessione al lavoro")
                        .font(.footnote)
                        .lineLimit(2)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var riga: some View {
        Label {
            Text(Riassunto.frase(voce))
        } icon: {
            Image(systemName: voce.tiAspetta > 0 ? "hand.raised.fill" : "hammer.fill")
        }
    }

    private var progettiInBreve: String { voce.progetti.prefix(2).joined(separator: ", ") }
}

enum Riassunto {
    /// Una frase per la riga della schermata di blocco e per VoiceOver.
    static func frase(_ v: VoceSessioni) -> String {
        if v.fonte == .scollegato { return "Bottega da collegare" }
        guard v.stato != nil else { return "Il Mac non risponde" }
        switch (v.tiAspetta, v.inCorso) {
        case (0, 0): return "Nessuna sessione al lavoro"
        case (0, let n): return Pezzi.alLavoro(n)
        case (let a, 0): return Pezzi.aspetta(a)
        case (let a, let n): return "\(Pezzi.aspetta(a)), \(Pezzi.alLavoro(n))"
        }
    }
}

// MARK: - schermata Home

/// Quando e' stato visto il dato: l'ora se viene dal Mac adesso, da quanto se e' l'ultimo salvato.
private struct Eta: View {
    let voce: VoceSessioni

    var body: some View {
        Group {
            if let q = voce.quando {
                if voce.fonte == .diretta {
                    Text("alle \(Text(q, style: .time))")
                } else {
                    Text("\(Image(systemName: "wifi.slash")) \(Pezzi.daQuanto(q)) fa")
                }
            }
        }
        .font(.caption2)
        .foregroundStyle(Tinte.tinta.opacity(0.85))
        .lineLimit(1)
    }
}

/// Testata: la sferetta e il nome del Mac.
private struct Testata: View {
    let voce: VoceSessioni

    var body: some View {
        HStack(spacing: 6) {
            Sferetta(aspetta: voce.tiAspetta > 0, lavora: voce.inCorso > 0, diametro: 14)
            Text(voce.stato?.mac ?? "Bottega")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Tinte.tinta)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
    }
}

/// Il numero grande: chi ti aspetta se c'e' qualcuno, altrimenti chi lavora.
private struct Numero: View {
    let voce: VoceSessioni

    var body: some View {
        let aspetta = voce.tiAspetta > 0
        let n = aspetta ? voce.tiAspetta : voce.inCorso
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text("\(n)")
                .font(.system(size: 38, weight: .semibold, design: .rounded))
                .monospacedDigit()
            Text(aspetta ? (n == 1 ? "ti aspetta" : "ti aspettano") : "al lavoro")
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .foregroundStyle(aspetta ? Tinte.ambra : Tinte.testo)
        .widgetAccentable(aspetta)
    }
}

/// Senza Mac o senza sessioni: una frase sola, al centro.
private struct Vuoto: View {
    let voce: VoceSessioni

    var body: some View {
        switch voce.fonte {
        case .scollegato:
            Text("Apri la Bottega e collega il Mac.")
        case _ where voce.stato == nil:
            Text("Il Mac non risponde.")
        default:
            Text("Nessuna sessione al lavoro.")
        }
    }

    static func serve(_ v: VoceSessioni) -> Bool { v.stato == nil || (v.tiAspetta == 0 && v.inCorso == 0 && v.lavori.isEmpty) }
}

private struct SessioniPiccolo: View {
    let voce: VoceSessioni

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Testata(voce: voce)
            Spacer(minLength: 0)
            if Vuoto.serve(voce) {
                Vuoto(voce: voce)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Tinte.testo)
                    .lineLimit(3)
            } else {
                Numero(voce: voce)
                if voce.tiAspetta > 0, voce.inCorso > 0 {
                    Text(Pezzi.alLavoro(voce.inCorso))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Tinte.testo)
                }
                Text(voce.progetti.prefix(3).joined(separator: ", "))
                    .font(.caption)
                    .foregroundStyle(Tinte.tinta)
                    .lineLimit(voce.tiAspetta > 0 && voce.inCorso > 0 ? 1 : 2)
            }
            Spacer(minLength: 0)
            Eta(voce: voce)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct SessioniMedio: View {
    let voce: VoceSessioni

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Testata(voce: voce)
                Spacer(minLength: 0)
                if Vuoto.serve(voce) {
                    Vuoto(voce: voce)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Tinte.testo)
                        .lineLimit(3)
                } else {
                    Numero(voce: voce)
                    if voce.tiAspetta > 0, voce.inCorso > 0 {
                        Text(Pezzi.alLavoro(voce.inCorso))
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Tinte.testo)
                    }
                }
                Spacer(minLength: 0)
                Eta(voce: voce)
            }
            .frame(width: 118, alignment: .leading)

            if !Vuoto.serve(voce) {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(voce.lavori.prefix(3)) { l in
                        RigaLavoro(lavoro: l)
                    }
                    Spacer(minLength: 0)
                    if voce.lavori.count > 3 {
                        Text("e altre \(voce.lavori.count - 3)")
                            .font(.caption2)
                            .foregroundStyle(Tinte.tinta)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct RigaLavoro: View {
    let lavoro: StatoMac.Lavoro

    var body: some View {
        let colore = Pezzi.colore(lavoro.stato)
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Circle()
                .fill(colore)
                .frame(width: 7, height: 7)
                .widgetAccentable(lavoro.stato == "ti aspetta")
            VStack(alignment: .leading, spacing: 1) {
                Text(lavoro.progetto)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Tinte.testo)
                    .lineLimit(1)
                Text(lavoro.titolo)
                    .font(.caption2)
                    .foregroundStyle(Tinte.tinta)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Pezzi.daQuanto(Pezzi.data(lavoro.da))
                .font(.caption2)
                .foregroundStyle(lavoro.stato == "ti aspetta" ? Tinte.ambra : Tinte.tinta)
        }
    }
}

#Preview("Piccolo", as: .systemSmall) {
    SessioniWidget()
} timeline: {
    VoceSessioni.esempio
    VoceSessioni(date: .now, stato: nil, fonte: .scollegato)
}

#Preview("Medio", as: .systemMedium) {
    SessioniWidget()
} timeline: {
    VoceSessioni.esempio
}
