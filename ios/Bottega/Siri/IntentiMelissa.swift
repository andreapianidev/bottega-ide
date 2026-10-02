//
//  IntentiMelissa.swift
//  Bottega per iPhone
//
//  Siri e Comandi rapidi (docs/CONTRATTI.md, 9.4): «Chiedi a Melissa su Bottega» e «Chi mi aspetta su Bottega».
//  Girano senza aprire l'app: la domanda va al Mac dal ponte e Siri legge la risposta. Il cervello resta Agnes
//  sul Mac: su questo iPhone Apple Intelligence non c'e' e non serve.
//

import AppIntents

struct ChiediAMelissa: AppIntent {
    static let title: LocalizedStringResource = "Chiedi a Melissa"
    static let description = IntentDescription("Fai una domanda a Melissa, sul tuo Mac, e ascolta la risposta.")
    static let openAppWhenRun = false

    @Parameter(title: "Domanda", requestValueDialog: IntentDialog("Cosa vuoi chiedere a Melissa?"))
    var domanda: String

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let ponte = Ponte.shared
        guard ponte.collegato else {
            return .result(value: "", dialog: "La Bottega non è collegata a nessun Mac. Apri l'app e collegala.")
        }
        do {
            let risposta = try await ponte.chiedi(domanda)
            return .result(value: risposta, dialog: IntentDialog(stringLiteral: risposta))
        } catch {
            return .result(value: "", dialog: IntentDialog(stringLiteral: error.localizedDescription))
        }
    }
}

struct ChiMiAspetta: AppIntent {
    static let title: LocalizedStringResource = "Chi mi aspetta"
    static let description = IntentDescription("Le sessioni Claude del Mac che aspettano te.")
    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let ponte = Ponte.shared
        guard ponte.collegato else {
            return .result(dialog: "La Bottega non è collegata a nessun Mac. Apri l'app e collegala.")
        }
        await ponte.aggiornaStato()
        guard let s = ponte.stato else {
            return .result(dialog: "Il Mac non risponde: controlla che sia acceso, con la Bottega aperta.")
        }
        return .result(dialog: IntentDialog(stringLiteral: Self.frase(s)))
    }

    static func frase(_ s: StatoMac) -> String {
        let aspettano = s.lavori.filter { $0.stato == "ti aspetta" }.map(\.progetto)
        let alLavoro = s.conti.inCorso
        var parti: [String] = []
        switch aspettano.count {
        case 0: parti.append("Non ti aspetta nessuno")
        case 1: parti.append("Ti aspetta \(aspettano[0])")
        default: parti.append("Ti aspettano \(aspettano.dropLast().joined(separator: ", ")) e \(aspettano.last!)")
        }
        switch alLavoro {
        case 0: parti.append("nessuna sessione è al lavoro.")
        case 1: parti.append("una sessione è al lavoro.")
        default: parti.append("\(alLavoro) sessioni sono al lavoro.")
        }
        return parti.joined(separator: ", ")
    }
}

struct ScorciatoieBottega: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ChiediAMelissa(),
                    phrases: ["Chiedi a Melissa su \(.applicationName)", "Parla con Melissa su \(.applicationName)"],
                    shortTitle: "Chiedi a Melissa", systemImageName: "sparkles")
        AppShortcut(intent: ChiMiAspetta(),
                    phrases: ["Chi mi aspetta su \(.applicationName)", "Cosa mi aspetta su \(.applicationName)"],
                    shortTitle: "Chi mi aspetta", systemImageName: "hourglass")
    }
}
