//
//  IconaWidget.swift
//  Bottega per iPhone, estensione dei widget
//
//  Il widget «Moony AI»: la luna dell'icona, con l'ombra della fase di oggi (crescente, piena, calante), calcolata
//  in locale da LunaVera (Condiviso: Sole e Luna veri, lo stesso calcolo della luna d'avvio e dell'app Mac). La
//  timeline ha una voce ogni 3 ore, ogni ora vicino ai quarti; fra una voce e l'altra l'ombra scivola invece di
//  saltare. Toccando la luna l'alone si accende un momento e si apre l'app con Moony in ascolto. Nessun dato e
//  nessun collegamento al Mac, nessuna animazione continua.
//

import AppIntents
import SwiftUI
import WidgetKit

/// La fase per il widget: quella vera di LunaVera, contata in lunazioni.
enum FaseLuna {
    private static let riferimento = Date(timeIntervalSince1970: 947_182_440)  // luna nuova del 6/1/2000, 18:14 UTC
    static let sinodico: TimeInterval = 29.530588853 * 86_400

    /// Lunazioni dalla luna nuova di riferimento, senza tagliare: cresce sempre, cosi' l'animazione fra due voci
    /// va avanti anche quando passa per la luna nuova. La parte intera viene dal mese medio, la parte decimale e'
    /// la fase vera (0 nuova, 0,5 piena).
    static func cicli(_ d: Date) -> Double {
        let medio = d.timeIntervalSince(riferimento) / sinodico, vera = frazione(d)
        return (medio - vera).rounded() + vera
    }

    static func frazione(_ d: Date) -> Double { LunaVera.stato(at: d).fase }

    static func nome(_ d: Date) -> String {
        let nomi = ["Luna nuova", "Luna crescente", "Primo quarto", "Gibbosa crescente",
                    "Luna piena", "Gibbosa calante", "Ultimo quarto", "Luna calante"]
        return nomi[Int((frazione(d) * 8).rounded()) % 8]
    }
}

struct VoceIcona: TimelineEntry {
    let date: Date
    /// L'alone acceso dopo un tocco (ToccoLuna, lo segna l'app quando si apre dalla luna).
    var acceso = false
    var cicli: Double { FaseLuna.cicli(date) }
}

struct FornitoreIcona: TimelineProvider {
    /// Dopo il tocco l'alone resta acceso per cosi' tanto, poi la voce dopo lo spegne con la sua animazione.
    static let aloneAcceso: TimeInterval = 2.5

    func placeholder(in context: Context) -> VoceIcona { VoceIcona(date: .now) }

    func getSnapshot(in context: Context, completion: @escaping (VoceIcona) -> Void) {
        completion(VoceIcona(date: .now))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<VoceIcona>) -> Void) {
        let ora = Date.now
        var voci: [VoceIcona] = []
        var inizio = ora
        if let tocco = Condiviso.preferenze.object(forKey: ToccoLuna.chiave) as? Date,
           ora.timeIntervalSince(tocco) < Self.aloneAcceso {
            voci.append(VoceIcona(date: ora, acceso: true))
            inizio = tocco.addingTimeInterval(Self.aloneAcceso)
        }
        // un giorno di voci: ogni 3 ore, ogni ora quando un quarto (nuova, primo, piena, ultimo) e' a meno di un giorno
        var d = inizio
        while d < ora.addingTimeInterval(24 * 3600) {
            voci.append(VoceIcona(date: d))
            let quarto = FaseLuna.frazione(d) * 4
            let vicino = abs(quarto - quarto.rounded()) * FaseLuna.sinodico / 4 < 86_400
            d = d.addingTimeInterval(vicino ? 3600 : 3 * 3600)
        }
        completion(Timeline(entries: voci, policy: .atEnd))
    }
}

/// Il tocco sulla luna apre Moony in ascolto con un indirizzo (widgetURL), l'unico modo in cui un widget della
/// schermata Home porta l'app in primo piano. Fino al 15/10/2026 la luna era un Button(intent:) che restituiva un
/// OpenURLIntent: dalla Home l'intento gira in background, l'alone si accendeva ma l'app non si apriva.
/// L'alone lo accende ora l'app quando si apre da qui (Navigazione, `da=luna`): al ritorno sulla Home e' acceso.
enum ToccoLuna {
    static let chiave = "lunaToccata"
    static let indirizzo = URL(string: "bottega://melissa?ascolta=1&da=luna")!
}

struct IconaWidget: Widget {
    static let kind = "com.andreapiani.bottega.ios.widget.icona"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: FornitoreIcona()) { voce in
            VistaIcona(voce: voce)
        }
        .configurationDisplayName("Moony AI")
        .description("La luna di Moony con la fase di oggi: toccala e Moony ti ascolta.")
        .supportedFamilies([.systemSmall])
        .contentMarginsDisabled()
    }
}

/// L'ombra della fase sul disco della luna: semicerchio dal lato in ombra piu' il terminatore, un'ellisse che va
/// da un bordo all'altro. Calante e crescente sono speculari (emisfero nord: la luna crescente e' accesa a destra).
struct OmbraFase: Shape {
    var cicli: Double
    var animatableData: Double {
        get { cicli }
        set { cicli = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let r = min(rect.width, rect.height) / 2
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let f = cicli - cicli.rounded(.down)
        let k = cos(2 * .pi * f)              // 1 nuova, 0 ai quarti, -1 piena
        let lato: CGFloat = f < 0.5 ? -1 : 1  // dove sta l'ombra: a sinistra quando cresce, a destra quando cala
        var p = Path()
        let n = 72
        for i in 0...n {                       // semicerchio in ombra, dall'alto in basso
            let t = Double(i) / Double(n) * .pi
            let q = CGPoint(x: c.x + lato * r * sin(t), y: c.y - r * cos(t))
            if i == 0 { p.move(to: q) } else { p.addLine(to: q) }
        }
        for i in 0...n {                       // terminatore, dal basso in alto
            let t = .pi - Double(i) / Double(n) * .pi
            p.addLine(to: CGPoint(x: c.x - lato * r * CGFloat(k) * sin(t), y: c.y - r * cos(t)))
        }
        p.closeSubpath()
        return p
    }
}

struct VistaIcona: View {
    let voce: VoceIcona
    /// Il disco della luna nell'icona (scripts/icona-moony-ios.sh): centrato, raggio 0,282 del lato
    /// (il 70% del corpo da 824 su 1024 dell'icona del Mac).
    private let raggioLuna: CGFloat = 0.282

    var body: some View {
        // l'icona e' il contenuto, non lo sfondo: con la Schermata Home colorata iOS toglie lo sfondo dei widget,
        // e la luna deve restare a colori come quella dell'app
        GeometryReader { g in
            let lato = min(g.size.width, g.size.height)
            let disco = lato * raggioLuna * 2
            ZStack {
                Image("Icona")
                    .resizable()
                    .widgetAccentedRenderingMode(.fullColor)
                    .scaledToFill()
                    .frame(width: g.size.width, height: g.size.height)
                // l'alone che si accende al tocco: luce calda attorno alla luna, poi sfuma
                Circle()
                    .fill(RadialGradient(colors: [Color(red: 1, green: 0.95, blue: 0.85).opacity(0.75), .clear],
                                         center: .center, startRadius: disco * 0.45, endRadius: disco * 0.95))
                    .frame(width: disco * 2, height: disco * 2)
                    .opacity(voce.acceso ? 1 : 0)
                    .scaleEffect(voce.acceso ? 1 : 0.8)
                    .animation(.easeOut(duration: 0.8), value: voce.acceso)
                // l'ombra della fase, morbida sul terminatore e tenuta dentro il disco (un filo di luce cinerea)
                OmbraFase(cicli: voce.cicli)
                    .fill(Color(red: 0.03, green: 0.031, blue: 0.04).opacity(0.86))
                    .frame(width: disco * 1.03, height: disco * 1.03)
                    .blur(radius: lato * 0.008)
                    .mask(Circle().frame(width: disco * 1.03, height: disco * 1.03))
                    .animation(.smooth(duration: 1.6), value: voce.cicli)
            }
            .frame(width: g.size.width, height: g.size.height)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Moony AI, \(FaseLuna.nome(voce.date).lowercased())")
        .accessibilityHint("Tocca per parlare con Moony")
        .widgetURL(ToccoLuna.indirizzo)
        .containerBackground(for: .widget) { Tinte.sfondo }
    }
}

#Preview(as: .systemSmall) {
    IconaWidget()
} timeline: {
    VoceIcona(date: .now)
    VoceIcona(date: .now.addingTimeInterval(4 * 86_400))
    VoceIcona(date: .now.addingTimeInterval(4 * 86_400), acceso: true)
}
