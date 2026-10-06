//
//  SegniVoce.swift
//  Bottega per iPhone
//
//  Segni nella coda della voce: un'azione che parte quando la voce arriva a quel punto, cioe' quando ha finito di
//  suonare tutto quello che era in coda prima. Serve al nome di chi parla: la battuta dopo si pensa e si accoda mentre
//  quella prima suona ancora, e l'etichetta deve cambiare quando la nuova voce comincia, non quando arriva il suo
//  audio. Logica pura, la usa FlussoVoce; i test girano senza simulatore (scripts/test-ios-personaggi.sh).
//

import Foundation

final class SegniVoce {
    /// Buffer messi in coda e buffer finiti di suonare, dall'ultimo azzeramento.
    private(set) var accodati = 0
    private(set) var suonati = 0
    private var attesa: [(soglia: Int, azione: () -> Void)] = []

    /// `azione` subito se non c'e' niente da suonare, altrimenti quando ha suonato tutto quello che e' in coda adesso.
    func segna(_ azione: @escaping () -> Void) {
        if suonati >= accodati { azione() } else { attesa.append((accodati, azione)) }
    }

    func accodato() { accodati += 1 }

    /// Un buffer e' finito: partono i segni che aspettavano lui.
    func suonato() {
        suonati += 1
        let pronti = attesa.filter { $0.soglia <= suonati }
        attesa.removeAll { $0.soglia <= suonati }
        pronti.forEach { $0.azione() }
    }

    /// La coda e' stata tagliata ma la voce continua (un riempitivo taciuto): quello che aspettava parte adesso.
    func svuota() {
        let pronti = attesa
        azzera()
        pronti.forEach { $0.azione() }
    }

    /// Interruzione o giro nuovo: i segni di prima non valgono piu'.
    func azzera() {
        accodati = 0
        suonati = 0
        attesa.removeAll()
    }
}
