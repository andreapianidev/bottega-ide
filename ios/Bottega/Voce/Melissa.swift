//
//  Melissa.swift
//  Bottega per iPhone
//
//  Il giro della conversazione sull'iPhone, come sul Mac: tocchi la sfera, parli, la frase va al Mac, Melissa
//  pensa con il suo cervello e i suoi strumenti, la risposta torna con la sua voce. In conversazione si
//  rimette in ascolto da sola; "basta" o un tocco mentre ascolta senza parole la chiudono. Toccarla mentre
//  parla la interrompe, come sul Mac.
//

import Foundation
import Observation

@MainActor
@Observable
final class Melissa {
    private(set) var sfera: StatoSfera = .riposo
    private(set) var parziale = ""
    private(set) var conversazione = false
    var avviso: String?
    var voceAccesa: Bool = UserDefaults.standard.object(forKey: "voce") as? Bool ?? true {
        didSet { UserDefaults.standard.set(voceAccesa, forKey: "voce") }
    }

    private let ponte: Ponte
    private let ascolto = Ascolto()
    private let parlato = Parlato()
    private var turno: Task<Void, Never>?

    private static let paroleFine = try! NSRegularExpression(pattern: "\\b(basta|a dopo|chiudi|ci sentiamo|stop|a pi[uù] tardi)\\b", options: .caseInsensitive)

    init(ponte: Ponte) {
        self.ponte = ponte
        ascolto.parziale = { [weak self] t in self?.parziale = t }
    }

    var occupata: Bool { sfera == .pensa }

    /// Il tocco sulla sfera.
    func tocca() {
        switch sfera {
        case .ascolta:
            ascolto.chiudi()
        case .parla:
            parlato.ferma() // il giro riprende ad ascoltare da solo se la conversazione e' aperta
        case .pensa:
            break
        case .riposo, .errore:
            conversazione = true
            Task { await ascoltaFrase() }
        }
    }

    func chiudiConversazione() {
        conversazione = false
        ascolto.ferma()
        parlato.ferma()
        if sfera != .pensa { sfera = .riposo }
        parziale = ""
    }

    /// Una domanda scritta: stesso giro, senza microfono dopo.
    func scrivi(_ testo: String) {
        let t = testo.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !occupata else { return }
        conversazione = false
        ascolto.ferma()
        parlato.ferma()
        turno = Task { await chiedi(t) }
    }

    /// L'app va dietro: niente microfono acceso di nascosto.
    func sospendi() {
        chiudiConversazione()
    }

    // MARK: - il giro

    private func ascoltaFrase() async {
        if let problema = await Ascolto.permessi() {
            avviso = problema
            conversazione = false
            sfera = .errore
            return
        }
        parziale = ""
        sfera = .ascolta
        do {
            let testo: String = try await withCheckedThrowingContinuation { k in
                do {
                    try ascolto.ascolta { k.resume(returning: $0) }
                } catch {
                    k.resume(throwing: error)
                }
            }
            guard conversazione else { return }
            if testo.isEmpty {
                // silenzio: la conversazione si chiude, come sul Mac dopo un minuto senza parole
                chiudiConversazione()
                return
            }
            if Self.paroleFine.firstMatch(in: testo, range: NSRange(testo.startIndex..., in: testo)) != nil {
                conversazione = false
                sfera = .riposo
                parziale = ""
                if voceAccesa { await parlato.dici("A dopo.") }
                return
            }
            await chiedi(testo)
        } catch {
            avviso = error.localizedDescription
            conversazione = false
            sfera = .errore
        }
    }

    private func chiedi(_ testo: String) async {
        sfera = .pensa
        parziale = testo
        let risposta: String
        do {
            risposta = try await ponte.chiedi(testo)
        } catch {
            avviso = error.localizedDescription
            sfera = .errore
            conversazione = false
            parziale = ""
            return
        }
        parziale = ""
        if voceAccesa && !risposta.isEmpty {
            sfera = .parla
            do {
                let wav = try await ponte.voce(risposta)
                await parlato.suona(wav)
            } catch {
                await parlato.dici(risposta)
            }
        }
        sfera = .riposo
        if conversazione {
            try? await Task.sleep(nanoseconds: 250_000_000)
            if conversazione { await ascoltaFrase() }
        }
    }
}
