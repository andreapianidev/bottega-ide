//
//  LunaVera.swift
//  Moony (Mac: Avo Agency AI/Core/Util, iPhone: Bottega ios/Condiviso; i due file sono identici)
//
//  La luna vera di questo momento, per la luna d'avvio di Moony (15/10/2026, Andrea: «durante il caricamento
//  deve mostrare la proiezione dell'ombra sulla luna in tempo reale, sia su iOS che su macOS»).
//  Non conta piu' i giorni da una luna nuova di riferimento (sbaglia di mezza giornata, il mese vero non e'
//  lungo sempre uguale): calcola dove sono davvero Sole e Luna e ne ricava
//  - quanta luna e' illuminata e se cresce o cala;
//  - da che parte sta il lembo illuminato COME LO VEDE CHI GUARDA IL CIELO da un luogo, cioe' l'angolo
//    di posizione del lembo (Meeus, Astronomical Algorithms, 48.5) meno l'angolo parallattico: la falce
//    serale "sdraiata" alle Canarie e piu' dritta a Milano viene da qui.
//  Formule ridotte (i termini principali della teoria lunare): la longitudine della Luna sbaglia di qualche
//  decimo di grado, cioe' meno di un'ora sulla fase. Tutto puro, senza stato: si prova con una data.
//

import Foundation

nonisolated enum LunaVera {
    struct Stato: Equatable, Sendable {
        /// Ciclo 0...1: 0 nuova, 0,25 primo quarto, 0,5 piena, 0,75 ultimo quarto (come MoonPhase).
        var fase: Double
        /// Frazione del disco illuminata, 0...1.
        var illuminata: Double
        /// Angolo di fase Sole-Luna-Terra in radianti: 0 piena, pi nuova.
        var angoloFase: Double
        /// Direzione del lembo illuminato sul disco visto in cielo, in radianti dallo zenit verso sinistra
        /// (verso est, in senso antiorario). Sullo schermo, con y in su: (-sin a, cos a).
        var angoloLembo: Double
        var crescente: Bool
    }

    /// Tijarafe, La Palma: dove guarda Andrea se l'app non sa dov'e'.
    static let latitudineCasa = 28.70
    static let longitudineCasa = -17.96

    static func stato(at date: Date = Date(),
                      latitudine: Double = latitudineCasa,
                      longitudine: Double = longitudineCasa) -> Stato {
        let r = Double.pi / 180
        func norm(_ x: Double) -> Double { let y = x.truncatingRemainder(dividingBy: 360); return y < 0 ? y + 360 : y }

        // Giorni dall'epoca J2000.0 (1 gennaio 2000, 12:00 TT; la differenza TT-UTC qui non conta).
        let d = date.timeIntervalSince1970 / 86_400 + 2_440_587.5 - 2_451_545.0

        // Sole: longitudine eclittica vera.
        let g = norm(357.529 + 0.98560028 * d)
        let qSole = norm(280.459 + 0.98564736 * d)
        let lamS = norm(qSole + 1.915 * sin(g * r) + 0.020 * sin(2 * g * r))

        // Luna: longitudine e latitudine con i termini maggiori (equazione del centro, evezione,
        // variazione, equazione annua) e l'argomento di latitudine.
        let lm = norm(218.316 + 13.176396 * d)
        let mm = norm(134.963 + 13.064993 * d)
        let f = norm(93.272 + 13.229350 * d)
        let dd = norm(lm - qSole)
        let lamM = norm(lm
            + 6.289 * sin(mm * r)
            + 1.274 * sin((2 * dd - mm) * r)
            + 0.658 * sin(2 * dd * r)
            - 0.186 * sin(g * r)
            + 0.214 * sin(2 * mm * r))
        let betM = 5.128 * sin(f * r)

        // Fase: elongazione dal Sole, angolo di fase, frazione illuminata.
        let dLam = norm(lamM - lamS)
        let psi = acos(max(-1, min(1, cos(betM * r) * cos(dLam * r))))
        let i = Double.pi - psi
        let illuminata = (1 + cos(i)) / 2
        let crescente = dLam < 180
        let fase = crescente ? psi / (2 * Double.pi) : 1 - psi / (2 * Double.pi)

        // Coordinate equatoriali di Sole e Luna.
        let eps = (23.439 - 0.0000004 * d) * r
        func equatoriali(_ lam: Double, _ bet: Double) -> (ra: Double, dec: Double) {
            let l = lam * r, b = bet * r
            let ra = atan2(sin(l) * cos(eps) - tan(b) * sin(eps), cos(l))
            let dec = asin(sin(b) * cos(eps) + cos(b) * sin(eps) * sin(l))
            return (ra, dec)
        }
        let sole = equatoriali(lamS, 0)
        let luna = equatoriali(lamM, betM)

        // Angolo di posizione del lembo illuminato, da nord verso est.
        let da = sole.ra - luna.ra
        let chi = atan2(cos(sole.dec) * sin(da),
                        sin(sole.dec) * cos(luna.dec) - cos(sole.dec) * sin(luna.dec) * cos(da))

        // Angolo parallattico: di quanto il nord celeste e' girato rispetto allo zenit, visto da qui.
        let gmst = norm(280.46061837 + 360.98564736629 * d)
        let h = (gmst + longitudine) * r - luna.ra
        let phi = latitudine * r
        let qPar = atan2(sin(h), tan(phi) * cos(luna.dec) - sin(luna.dec) * cos(h))

        return Stato(fase: fase, illuminata: illuminata, angoloFase: i,
                     angoloLembo: chi - qPar, crescente: crescente)
    }
}
