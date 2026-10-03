//
//  PostaView.swift
//  Bottega per iPhone
//
//  Posta e WhatsApp per progetto, come nella stanza Connettori del Mac (docs/CONTRATTI.md, 5.5, 5.6 e 9.6): chi ha
//  scritto per quale progetto, i non letti, le chat che aspettano una risposta. Solo nome del contatto, oggetto e
//  un'anteprima breve: indirizzi e numeri non arrivano nemmeno dal Mac. Questa stanza non resta sul disco
//  dell'iPhone: la copia vive solo finche' l'app e' aperta.
//

import SwiftUI

struct PostaView: View {
    let ponte: Ponte
    @State private var lettura = LetturaStanza<StanzaPosta>("posta")

    var body: some View {
        CorniceStanza(lettura: lettura, query: [:], datiDelMac: { $0.aggiornatoAt }) { d in
            RiquadroStanza(titolo: "Ultimi \(Int(d.giorni)) giorni") {
                HStack(alignment: .top, spacing: 12) {
                    Cifra(etichetta: "Mail non lette", valore: Formati.numero(d.conti.nonLetti), colore: d.conti.nonLetti > 0 ? Tinte.ambra : Tinte.testo)
                    Cifra(etichetta: "Chat da rispondere", valore: Formati.numero(d.conti.chatDaRispondere), colore: d.conti.chatDaRispondere > 0 ? Tinte.ambra : Tinte.testo)
                }
                let fuori = Int(d.conti.mailDaAssegnare + d.conti.chatDaAssegnare)
                if fuori > 0 {
                    Text("\(fuori) tra mittenti e chat da assegnare a un progetto, nella stanza Connettori sul Mac.")
                        .font(.caption)
                        .foregroundStyle(Tinte.tinta)
                }
                if let e = d.posta?.errore { Text("Posta: \(e)").font(.caption).foregroundStyle(Tinte.rosso) }
                if let e = d.whatsapp?.errore { Text("WhatsApp: \(e)").font(.caption).foregroundStyle(Tinte.rosso) }
            }
            if d.progetti.isEmpty {
                RiquadroStanza(titolo: "Nessun messaggio dei progetti") {
                    Text("Le mail e le chat si collegano ai progetti con la rubrica della stanza Connettori, sul Mac.")
                        .font(.callout)
                        .foregroundStyle(Tinte.tinta)
                }
            }
            ForEach(d.progetti) { p in
                RiquadroStanza(titolo: p.nome, nota: nota(p)) {
                    ForEach(p.mail) { m in
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: m.nonLetto ? "envelope.badge" : "envelope")
                                .font(.caption)
                                .foregroundStyle(m.nonLetto ? Tinte.ambra : Tinte.tinta)
                                .padding(.top, 3)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(m.oggetto).font(.callout.weight(m.nonLetto ? .semibold : .regular)).foregroundStyle(Tinte.testo).lineLimit(2)
                                Text("\(m.da), \(Formati.giorno(ms: m.at))").font(.caption).foregroundStyle(Tinte.tinta)
                            }
                        }
                    }
                    if !p.mail.isEmpty && !p.chat.isEmpty { Divider().overlay(Tinte.bordo) }
                    ForEach(p.chat) { c in
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: c.gruppo ? "person.3" : "message")
                                .font(.caption)
                                .foregroundStyle(c.mio ? Tinte.tinta : Tinte.ambra)
                                .padding(.top, 3)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.contatto).font(.callout.weight(.medium)).foregroundStyle(Tinte.testo)
                                Text(c.mio ? "hai scritto tu per ultimo, \(Formati.giorno(ms: c.at))" : "\(c.anteprima.map { "«\($0)», " } ?? "")\(Formati.giorno(ms: c.at))")
                                    .font(.caption)
                                    .foregroundStyle(Tinte.tinta)
                                    .lineLimit(2)
                            }
                        }
                    }
                }
            }
        }
    }

    private func nota(_ p: StanzaPosta.Progetto) -> String? {
        var parti: [String] = []
        if p.nonLetti > 0 { parti.append("\(Int(p.nonLetti)) non lett\(p.nonLetti == 1 ? "a" : "e")") }
        if p.chatDaRispondere > 0 { parti.append("\(Int(p.chatDaRispondere)) da rispondere") }
        return parti.isEmpty ? nil : parti.joined(separator: ", ")
    }
}
