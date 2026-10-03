//
//  SezioniAppStore.swift
//  Bottega per iPhone
//
//  I pezzi della stanza App Store che servono sia alla stanza intera sia alla scheda di un'app: la frase in testa con
//  l'ora dei dati, gli allarmi, le cifre, i grafici (guadagni, download, tendenza), gli abbonamenti, la scheda dello
//  Store e i paesi dove rende AdMob. Le stesse sezioni della stanza del Mac (media/appstore.js), una sotto l'altra.
//

import SwiftUI

// MARK: - testa

struct TestaAppStore: View {
    let d: StanzaAppStore
    var nomeApp: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(CalcoliAppStore.frase(d, nomeApp: nomeApp))
                .font(.title3.weight(.semibold))
                .foregroundStyle(Tinte.testo)
                .fixedSize(horizontal: false, vertical: true)
            Text(CalcoliAppStore.fraseBuchi(d))
                .font(.callout)
                .foregroundStyle(Tinte.tinta)
                .fixedSize(horizontal: false, vertical: true)
            Text(timbro)
                .font(.caption)
                .foregroundStyle(Tinte.tinta)
            if d.aggiornando == true {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini).tint(Tinte.tinta)
                    Text((d.fase ?? "Il Mac rilegge AdMob e App Store Connect") + "…").font(.caption).foregroundStyle(Tinte.testo)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var timbro: String {
        var parti: [String] = []
        if d.aggiornatoAt > 0 { parti.append("Letti dal Mac \(allOra(d.aggiornatoAt))") }
        if let f = d.storeFinoA { parti.append("Store fino al \(Formati.chiaveDetta(f))") }
        if let o = d.controlloOre { parti.append(o > 0 ? "ricontrolla da solo ogni \(o == 1 ? "ora" : "\(Int(o)) ore")" : "rilegge solo quando apri la stanza sul Mac") }
        return parti.joined(separator: " · ")
    }

    /// «oggi alle 9:05», «ieri alle 22:10», «2 ott alle 9:05».
    private func allOra(_ ms: Double) -> String {
        let t = Date(timeIntervalSince1970: ms / 1000)
        let ora = t.formatted(date: .omitted, time: .shortened)
        let cal = Calendar.current
        if cal.isDateInToday(t) { return "oggi alle \(ora)" }
        if cal.isDateInYesterday(t) { return "ieri alle \(ora)" }
        return "il \(t.formatted(.dateTime.day().month(.abbreviated).locale(CalcoliAppStore.it))) alle \(ora)"
    }
}

// MARK: - allarmi

struct SezioneAllarmi: View {
    let allarmi: [StanzaAppStore.Allarme]

    var body: some View {
        if !allarmi.isEmpty {
            RiquadroStanza(titolo: "Allarmi", nota: "ultime 48 ore") {
                ForEach(allarmi) { a in
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(a.app): \(a.testo)").foregroundStyle(Tinte.testo)
                            Text(Formati.fa(ms: a.at)).font(.caption2).foregroundStyle(Tinte.tinta)
                        }
                    } icon: {
                        Image(systemName: "bell.badge").foregroundStyle(Tinte.ambra)
                    }
                    .font(.callout)
                }
            }
        }
    }
}

// MARK: - cifre

struct CifreAppStore: View {
    let d: StanzaAppStore

    var body: some View {
        let incompleto = d.storeIncompleto == true
        RiquadroStanza(titolo: titolo, nota: incompleto ? d.storeFinoA.map { "Store fino al \(Formati.chiaveDetta($0))" } ?? "Store parziale" : nil) {
            VStack(alignment: .leading, spacing: 14) {
                Cifra(etichetta: "In tutto", valore: Formati.euro(d.cifre.totale), adesso: incompleto ? nil : d.cifre.totale, prima: d.prima?.totale, grande: true, colore: Tinte.ambra)
                HStack(alignment: .top, spacing: 12) {
                    Cifra(etichetta: "AdMob", valore: Formati.euro(d.cifre.admob), adesso: d.cifre.admob, prima: d.prima?.admob)
                    Cifra(etichetta: "Store", valore: Formati.euro(d.cifre.store), adesso: incompleto ? nil : d.cifre.store, prima: d.prima?.store)
                    Cifra(etichetta: "Download", valore: Formati.numero(d.cifre.download), adesso: incompleto ? nil : d.cifre.download, prima: d.prima?.download)
                }
                Text(incompleto ? "Lo Store è netto, dopo la quota di Apple; gli ultimi giorni Apple non li ha ancora pubblicati, per questo non c'è il confronto." : "Lo Store è netto, dopo la quota di Apple; AdMob è la sua stima. Download nuovi, senza aggiornamenti.")
                    .font(.caption2)
                    .foregroundStyle(Tinte.tinta)
            }
        }
    }

    private var titolo: String {
        if d.etichetta == "ieri" { return "Ieri" }
        if let m = d.mese { return Formati.chiaveDetta(m).capitalized(with: CalcoliAppStore.it) }
        if d.quale == "mesi" { return d.periodo == 90 ? "Ultimi 3 mesi" : "Ultimi 12 mesi" }
        return "Ultimi \(Int(d.periodo)) giorni"
    }
}

// MARK: - grafici

struct SezioneGrafici: View {
    let d: StanzaAppStore

    var body: some View {
        let mesi = d.quale == "mesi"
        let versioni = d.versioni ?? []
        RiquadroStanza(titolo: "Guadagni", nota: d.etichetta == "ieri" ? "la settimana, ieri in fondo" : nil) {
            HStack(spacing: 14) {
                HStack(spacing: 5) { Quadretto(colore: ColoriSoldi.admob); Text("AdMob") }
                HStack(spacing: 5) { Quadretto(colore: ColoriSoldi.store); Text("Store") }
                if !versioni.isEmpty {
                    HStack(spacing: 5) {
                        Rectangle().fill(Tinte.testo.opacity(0.55)).frame(width: 1, height: 10)
                        Text("versione uscita")
                    }
                }
            }
            .font(.caption)
            .foregroundStyle(Tinte.tinta)
            GraficoGuadagni(punti: d.grafico, versioni: versioni, mesi: mesi)
            if d.grafico.contains(where: { $0.store == nil }) {
                Text(mesi ? "Dove manca la barra dello Store, Apple non dà più quel mese: non è zero." : "Dove manca la barra dello Store, Apple non ha ancora pubblicato il report: non è zero.")
                    .font(.caption2)
                    .foregroundStyle(Tinte.tinta)
            }
            Text("Tocca o trascina sul grafico per vedere un giorno.").font(.caption2).foregroundStyle(Tinte.tinta.opacity(0.8))
        }
        RiquadroStanza(titolo: "Download", nota: "nuovi") {
            GraficoDownload(punti: d.grafico, versioni: versioni, mesi: mesi)
        }
        let passi = CalcoliAppStore.tendenza(d.grafico)
        if passi.count > 1, let ultimo = passi.last {
            RiquadroStanza(titolo: "Tendenza", nota: "accumulato, contro il periodo prima") {
                HStack(spacing: 14) {
                    HStack(spacing: 5) { Rectangle().fill(Tinte.testo).frame(width: 12, height: 2.5); Text("adesso") }
                    HStack(spacing: 5) { Rectangle().fill(ColoriSoldi.una).frame(width: 12, height: 1.5); Text("periodo prima") }
                }
                .font(.caption)
                .foregroundStyle(Tinte.tinta)
                GraficoTendenza(passi: passi, mesi: mesi)
                Text(fraseTendenza(ultimo)).font(.caption).foregroundStyle(Tinte.testo)
            }
        }
    }

    private func fraseTendenza(_ p: CalcoliAppStore.PassoTendenza) -> String {
        var s = "Finora \(CalcoliAppStore.euro(p.adesso, decimali: 0)), contro \(CalcoliAppStore.euro(p.prima, decimali: 0)) nello stesso tratto prima"
        if p.prima > 0 {
            let v = (p.adesso - p.prima) / p.prima
            s += abs(v) < 0.03 ? ": uguale." : ": il \(Int((abs(v) * 100).rounded()))% \(v > 0 ? "in più" : "in meno")."
        } else { s += "." }
        if d.grafico.contains(where: { $0.nelPeriodo && $0.store == nil }) { s += " Dove manca lo Store conta solo AdMob, per tutti e due." }
        return s
    }
}

// MARK: - abbonamenti

struct SezioneAbbonati: View {
    let a: StanzaAppStore.Abbonamenti

    var body: some View {
        RiquadroStanza(titolo: "Abbonamenti", nota: a.finoA.map { "al \(Formati.chiaveDetta($0))" }) {
            HStack(alignment: .top, spacing: 12) {
                Cifra(etichetta: "Che pagano", valore: Formati.numero(a.attivi), adesso: a.attivi, prima: a.attiviPrima)
                Cifra(etichetta: "In prova", valore: Formati.numero(a.prove))
                Cifra(etichetta: "Al mese", valore: Formati.euro(a.mrr), adesso: a.mrr, prima: a.mrrPrima)
            }
            if a.ritardo > 0 || (a.grazia ?? 0) > 0 {
                Text("\(Formati.numero(a.ritardo)) in ritardo di pagamento, " + ((a.grazia ?? 0) > 0 ? "\(Formati.numero(a.grazia ?? 0)) in periodo di tolleranza" : "nessuno in tolleranza"))
                    .font(.caption)
                    .foregroundStyle((a.grazia ?? 0) == 0 && a.ritardo > 0 ? Tinte.ambra : Tinte.tinta)
            }
            if let s = a.serie, s.count > 1 {
                HStack(spacing: 14) {
                    HStack(spacing: 5) { Rectangle().fill(ColoriSoldi.store).frame(width: 12, height: 2); Text("che pagano") }
                    if s.contains(where: { $0.prove > 0 }) {
                        HStack(spacing: 5) { Rectangle().fill(ColoriSoldi.una).frame(width: 12, height: 1.5); Text("in prova") }
                    }
                }
                .font(.caption)
                .foregroundStyle(Tinte.tinta)
                GraficoAbbonati(serie: s)
            }
            let eventi = CalcoliAppStore.eventi.filter { (a.eventi?[$0.0] ?? 0) > 0 || (a.eventiPrima?[$0.0] ?? 0) > 0 }
            if !eventi.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(eventi, id: \.0) { k, l in
                        HStack(alignment: .firstTextBaseline) {
                            Text(Formati.numero(a.eventi?[k] ?? 0)).font(.callout.weight(.semibold)).monospacedDigit().foregroundStyle(Tinte.testo)
                            Text(l).font(.callout).foregroundStyle(Tinte.testo)
                            Spacer()
                            if let p = a.eventiPrima { Text("prima \(Formati.numero(p[k] ?? 0))").font(.caption).foregroundStyle(Tinte.tinta) }
                        }
                    }
                }
            }
            if let per = a.perApp, per.count > 1 {
                Divider().overlay(Tinte.bordo)
                ForEach(per) { x in
                    HStack {
                        Text(x.nome).font(.caption.weight(.medium)).foregroundStyle(Tinte.testo)
                        Spacer()
                        Text("\(Formati.numero(x.attivi)) pagano, \(Formati.numero(x.prove)) in prova, \(Formati.euro(x.mrr)) al mese")
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(Tinte.tinta)
                    }
                }
            }
        }
    }
}

// MARK: - la scheda dello Store

struct SezioneScheda: View {
    let s: StanzaAppStore.Scheda

    var body: some View {
        RiquadroStanza(titolo: "La scheda dello Store", nota: "fino al \(Formati.chiaveDetta(s.finoA))") {
            HStack(alignment: .top, spacing: 12) {
                Cifra(etichetta: "Impressioni", valore: Formati.numero(s.imp), adesso: s.imp, prima: s.haPrima ? s.impPrima : nil)
                Cifra(etichetta: "Visite", valore: Formati.numero(s.vis), adesso: s.vis, prima: s.haPrima ? s.visPrima : nil)
            }
            HStack(alignment: .top, spacing: 12) {
                Cifra(etichetta: "Download nuovi", valore: Formati.numero(s.dl), adesso: s.dl, prima: s.haPrima ? s.dlPrima : nil)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Conversione").font(.caption).foregroundStyle(Tinte.tinta)
                    Text(s.imp > 0 ? CalcoliAppStore.quota(s.dl / s.imp) : "n/d").font(.title3.weight(.semibold)).monospacedDigit().foregroundStyle(Tinte.testo)
                    if s.haPrima, s.impPrima > 0 {
                        Text("prima \(CalcoliAppStore.quota(s.dlPrima / s.impPrima))").font(.caption2).foregroundStyle(Tinte.tinta)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if s.vis > 0 {
                Text("\(CalcoliAppStore.quota(s.dl / s.vis)) di chi apre la pagina scarica l'app. Impressioni e visite contano i dispositivi, non le volte; Apple le prepara con due o tre giorni di ritardo.")
                    .font(.caption2)
                    .foregroundStyle(Tinte.tinta)
            }
            if !s.fonti.isEmpty {
                Text("Da dove arrivano i download").font(.caption.weight(.semibold)).foregroundStyle(Tinte.testo).padding(.top, 4)
                BarreSemplici(righe: s.fonti.map { .init(id: $0.fonte, etichetta: CalcoliAppStore.fonte($0.fonte), valore: $0.dl, testo: "\(Formati.numero($0.dl)) download") })
            }
            if let per = s.perApp, per.count > 1 {
                Divider().overlay(Tinte.bordo)
                ForEach(per) { x in
                    HStack {
                        Text(x.nome).font(.caption.weight(.medium)).foregroundStyle(Tinte.testo)
                        Spacer()
                        Text("\(Formati.numero(x.imp)) imp., \(Formati.numero(x.dl)) download, \(x.imp > 0 ? CalcoliAppStore.quota(x.dl / x.imp) : "n/d")")
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(Tinte.tinta)
                    }
                }
            }
        }
    }
}

// MARK: - paesi

struct SezionePaesi: View {
    let paesi: [StanzaAppStore.Paese]

    var body: some View {
        if !paesi.isEmpty {
            RiquadroStanza(titolo: "Dove rende AdMob", nota: "30 giorni, tutte le app") {
                BarreSemplici(
                    righe: paesi.map { p in
                        let ecpm = CalcoliAppStore.ecpm(euro: p.euro, impressioni: p.impressioni)
                        return .init(id: p.codice, etichetta: CalcoliAppStore.paese(p.codice), valore: p.euro, testo: Formati.euro(p.euro) + (ecpm.map { ", \(Formati.euro($0)) ogni mille" } ?? ""))
                    },
                    colore: ColoriSoldi.admob
                )
            }
        }
    }
}

// MARK: - errori

struct SezioneErroriAppStore: View {
    let e: StanzaAppStore.Errori?

    var body: some View {
        if let e, e.admob != nil || e.store != nil {
            VStack(alignment: .leading, spacing: 4) {
                if let a = e.admob { Text("AdMob: \(a)") }
                if let s = e.store { Text("Store: \(s)") }
            }
            .font(.caption)
            .foregroundStyle(Tinte.rosso)
        }
    }
}
