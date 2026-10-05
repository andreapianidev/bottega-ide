import SwiftUI

/// Lo stesso comando nelle schede, anche quando mostrano una copia salvata.
struct RaccontoView: View {
    let titolo: String
    let contesto: () -> String
    @Environment(\.scenePhase) private var fase
    @State private var riassunto = Riassunto()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                if riassunto.stato == .fermo {
                    riassunto.avvia(titolo: titolo, contesto: contesto())
                } else { riassunto.ferma() }
            } label: {
                Label(riassunto.stato == .fermo ? "Racconta con Melissa" : "Ferma Melissa",
                      systemImage: riassunto.stato == .fermo ? "waveform" : "stop.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Tinte.ambra)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("racconta-melissa")
            if riassunto.stato != .fermo || !riassunto.testo.isEmpty || riassunto.errore != nil {
                Text(riassunto.errore ?? (riassunto.testo.isEmpty ? "Preparo il racconto e la voce…" : riassunto.testo))
                    .font(.callout)
                    .foregroundStyle(riassunto.errore == nil ? Tinte.testo : Tinte.rosso)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: fase) { _, nuova in if nuova == .background { riassunto.ferma() } }
        .onDisappear { riassunto.ferma() }
    }
}

enum ContestoRacconto {
    static func attivita(_ a: StatoMac.Attivita, salvata: Bool) -> String {
        let quando = Date(timeIntervalSince1970: a.updatedAt / 1000).formatted(date: .abbreviated, time: .shortened)
        return [
            salvata ? "Ultimo stato salvato: non presentarlo come attuale." : "Ultimo stato osservato dal Mac.",
            "Aggiornamento: \(quando). Fonte: \(a.fonte). Progetto: \(a.project). Stato: \(a.status).",
            "Richiesta: \(a.title)",
            a.summary.map { "Riepilogo: \($0)" },
            a.steps.map { "Passi osservati:\n" + $0.joined(separator: "\n") },
            a.evidence.map { "Origine dello stato: \($0)" },
            "Uno stato sconosciuto non prova che il lavoro sia in corso o in attesa."
        ].compactMap { $0 }.joined(separator: "\n")
    }

    static func lavoroSalvato(_ l: StatoMac.Lavoro, ora: Double?) -> String {
        let quando = ora.map { Date(timeIntervalSince1970: $0 / 1000).formatted(date: .abbreviated, time: .shortened) } ?? "non disponibile"
        return "Ultimo stato salvato, aggiornamento \(quando). Non presentarlo come attuale. Claude Code, progetto \(l.progetto), stato \(l.stato). Richiesta: \(l.titolo)"
    }
}
