//
//  Avvisi.swift
//  Bottega per iPhone
//
//  Le push che manda il Mac (docs/CONTRATTI.md, 9.4): permesso, categorie con le azioni, i token da dare al Mac
//  (notifiche, Live Activity, widget) e cosa fare quando tocchi una notifica o una sua azione.
//
//    ATTESA    una sessione ti aspetta: «Rispondi» scrive nel suo terminale sul Mac
//    CONFERMA  Melissa chiede un si' o un no: «Sì», «No»
//    FINITO    un lavoro ha finito
//    REGOLA    un progetto e' passato a rosso
//

import ActivityKit
import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().setNotificationCategories(Avvisi.categorie)
        // anche lanciata dietro dal sistema (push-to-start della Live Activity), quando una scena non c'e'
        MainActor.assumeIsolated {
            Avvisi.shared.osserva()
            OrologioTelefono.shared.avvia()
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in Avvisi.shared.token("token", deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Log.warn("notifiche: registrazione fallita (\(error.localizedDescription))")
    }

    // Con l'app davanti la notifica si vede lo stesso, come banner.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await Avvisi.shared.risposta(response)
    }
}

@MainActor
final class Avvisi {
    static let shared = Avvisi()

    static let categorie: Set<UNNotificationCategory> = [
        UNNotificationCategory(
            identifier: "ATTESA",
            actions: [UNTextInputNotificationAction(identifier: "rispondi", title: "Rispondi", options: [],
                                                    textInputButtonTitle: "Manda", textInputPlaceholder: "Cosa deve fare Claude")],
            intentIdentifiers: [], options: []),
        UNNotificationCategory(
            identifier: "CONFERMA",
            actions: [UNNotificationAction(identifier: "si", title: "Sì", options: [.authenticationRequired]),
                      UNNotificationAction(identifier: "no", title: "No", options: [.destructive])],
            intentIdentifiers: [], options: []),
        UNNotificationCategory(identifier: "FINITO", actions: [], intentIdentifiers: [], options: []),
        UNNotificationCategory(identifier: "REGOLA", actions: [], intentIdentifiers: [], options: []),
    ]

    private var ponte: Ponte { Ponte.shared }
    /// Quello che il Mac sa gia': non si rimanda a ogni apertura.
    private var mandati: [String: String] = Condiviso.preferenze.dictionary(forKey: "tokenMandati") as? [String: String] ?? [:]
    private var inAttesa: [String: String] = [:]
    private var osservaAttivita: Task<Void, Never>?
    /// Il token di ogni Live Activity (per id): alla fine di una si toglie dal Mac solo se e' ancora il suo.
    private var tokenAttivita: [String: String] = [:]
    private var seguite: Set<String> = []
    /// L'ultimo token per far partire la Live Activity dal Mac, anche quando sono spente: riaccese, si rimanda.
    private var ultimoAvvio = ""

    /// Live Activity e Dynamic Island, dalle impostazioni dell'app (accese se non si e' mai scelto).
    static let chiaveLive = "liveActivityAccese"
    var liveAccese: Bool { Condiviso.preferenze.object(forKey: Self.chiaveLive) as? Bool ?? true }

    #if DEBUG
    private let ambiente = "sviluppo"
    #else
    private let ambiente = "produzione"
    #endif

    /// Da quando l'app parte, anche lanciata dietro dal sistema senza scena (push-to-start): i token delle Live
    /// Activity e quello del widget arrivano e vanno al Mac. Il permesso delle notifiche no, quello solo con l'app
    /// davanti (avvia()). Si puo' chiamare piu' volte.
    func osserva() {
        guard osservaAttivita == nil else { return }
        osservaAttivita = Task { await self.seguiAttivita() }
        // il widget avvisa con una notifica di Darwin quando cambia il suo token (SpintaWidget)
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), nil, { _, _, _, _, _ in
            Task { @MainActor in Avvisi.shared.tokenWidget() }
        }, Condiviso.avvisoTokenWidget as CFString, nil, .deliverImmediately)
        leggiTokenWidget()
    }

    /// A collegamento fatto, con l'app davanti: permesso (la prima volta lo chiede iOS), registrazione, token
    /// della Live Activity e dei widget. Si puo' chiamare a ogni apertura: rimanda solo cio' che e' cambiato.
    func avvia() {
        osserva()
        guard ponte.collegato else { return }
        Task {
            let c = UNUserNotificationCenter.current()
            let ok = (try? await c.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            if ok { UIApplication.shared.registerForRemoteNotifications() }
        }
        leggiTokenWidget()
        Task { await manda() }
    }

    /// Scollegato, o collegato a un altro Mac: quel Mac non sa niente di questo iPhone.
    func dimentica() {
        mandati = [:]
        Condiviso.preferenze.removeObject(forKey: "tokenMandati")
    }

    /// «Scollega»: prima il Mac toglie i token di questo iPhone (campi vuoti), poi si chiudono le Live Activity
    /// aperte qui. Pochi secondi al massimo: con il Mac spento si scollega lo stesso.
    func congeda() async {
        if ponte.collegato {
            do {
                try await ponte.registraDispositivo(["ambiente": ambiente, "token": "", "avvio": "", "attivita": "", "widget": ""],
                                                    timeout: 6)
            } catch {
                Log.warn("notifiche: il Mac non ha tolto i token (\(error.localizedDescription)), scollego lo stesso")
            }
        }
        for a in Activity<BottegaAttivita>.activities {
            await a.end(nil, dismissalPolicy: .immediate)
        }
        inAttesa["attivita"] = nil
        tokenAttivita = [:]
    }

    /// Il widget ha un token nuovo (notifica di Darwin): va al Mac adesso, non alla prossima apertura.
    func tokenWidget() {
        leggiTokenWidget()
        Task { await manda() }
    }

    /// Il token dei widget, scritto dall'estensione nelle preferenze condivise.
    private func leggiTokenWidget() {
        if let w = Condiviso.preferenze.string(forKey: Condiviso.chiaveTokenWidget), !w.isEmpty { inAttesa["widget"] = w }
    }

    func token(_ campo: String, _ dati: Data) {
        let t = dati.map { String(format: "%02x", $0) }.joined()
        if campo == "avvio" {
            ultimoAvvio = t
            // spente dalle impostazioni: il Mac non deve poterle far partire
            if !liveAccese { return }
        }
        inAttesa[campo] = t
        Task { await manda() }
    }

    /// L'interruttore delle impostazioni. Spente: il Mac perde i token di avvio e dell'attivita' (non ne fa
    /// partire altre) e quelle aperte si chiudono. Riaccese: il token di avvio torna al Mac, che la fa ripartire
    /// al prossimo lavoro in corso.
    func cambiaLive(_ accese: Bool) async {
        Condiviso.preferenze.set(accese, forKey: Self.chiaveLive)
        if accese {
            let t = ultimoAvvio.isEmpty
                ? (Activity<BottegaAttivita>.pushToStartToken.map { $0.map { String(format: "%02x", $0) }.joined() } ?? "")
                : ultimoAvvio
            if !t.isEmpty { inAttesa["avvio"] = t }
        } else {
            inAttesa["avvio"] = ""
            inAttesa["attivita"] = ""
            tokenAttivita = [:]
            for a in Activity<BottegaAttivita>.activities {
                await a.end(nil, dismissalPolicy: .immediate)
            }
        }
        await manda()
    }

    private func manda() async {
        let nuovi = inAttesa.filter { mandati[$0.key] != $0.value }
        guard !nuovi.isEmpty else { return }
        // lanciata dietro prima del primo sblocco il gettone non si leggeva: si riprova qui
        ponte.ricarica()
        guard ponte.collegato else { return }
        var campi = nuovi
        campi["ambiente"] = ambiente
        do {
            try await ponte.registraDispositivo(campi)
            for (k, v) in nuovi { mandati[k] = v }
            Condiviso.preferenze.set(mandati, forKey: "tokenMandati")
        } catch {
            Log.warn("notifiche: il Mac non ha preso i token (\(error.localizedDescription)), riprovo alla prossima apertura")
        }
    }

    /// I token della Live Activity: quello per farla partire dal Mac, e quello di ogni attivita' aperta.
    private func seguiAttivita() async {
        Task {
            for await t in Activity<BottegaAttivita>.pushToStartTokenUpdates { self.token("avvio", t) }
        }
        for a in Activity<BottegaAttivita>.activities { seguiUna(a) }
        // App reinstallata o aggiornata, o attivita' chiusa mentre l'app era spenta: iOS l'ha tolta senza dircelo.
        // Il Mac ne ha ancora il token e la aggiornerebbe per sempre (APNs risponde 200 lo stesso) invece di farne
        // partire una nuova: glielo si toglie.
        if Activity<BottegaAttivita>.activities.isEmpty, let vecchio = mandati["attivita"], !vecchio.isEmpty {
            inAttesa["attivita"] = ""
            await manda()
        }
        for await a in Activity<BottegaAttivita>.activityUpdates { seguiUna(a) }
    }

    private func seguiUna(_ a: Activity<BottegaAttivita>) {
        let id = a.id
        guard seguite.insert(id).inserted else { return }
        Task {
            for await t in a.pushTokenUpdates {
                self.tokenAttivita[id] = t.map { String(format: "%02x", $0) }.joined()
                self.token("attivita", t)
            }
        }
        Task {
            for await s in a.activityStateUpdates where s == .ended || s == .dismissed {
                // al Mac va "" solo se il token che ha e' ancora quello di questa attivita': se nel frattempo e'
                // arrivato quello di un'altra, quella resta
                if let mio = self.tokenAttivita.removeValue(forKey: id), self.inAttesa["attivita"] == mio {
                    self.inAttesa["attivita"] = ""
                    await self.manda()
                }
                self.seguite.remove(id)
                break
            }
        }
    }

    // MARK: - tocchi e azioni

    func risposta(_ r: UNNotificationResponse) async {
        let info = r.notification.request.content.userInfo
        let categoria = r.notification.request.content.categoryIdentifier
        do {
            switch r.actionIdentifier {
            case "rispondi":
                guard let testo = (r as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines),
                      !testo.isEmpty, let id = info["jobId"] as? String else { return }
                try await ponte.scriviLavoro(id, testo)
            case "si", "no":
                // il numero della domanda: se nel frattempo e' cambiata il Mac risponde 409 e non conferma niente
                let conferma = (info["conferma"] as? NSNumber)?.intValue
                _ = try await ponte.chiedi(r.actionIdentifier == "si" ? "sì" : "no", conferma: conferma)
            default:
                Navigazione.shared.stanza = categoria == "CONFERMA" ? .melissa : .lavori
            }
        } catch {
            let c = UNMutableNotificationContent()
            if let e = error as? ErrorePonte, e.codice == 409 {
                // la domanda non e' piu' quella (o Melissa sta gia' rispondendo): il Mac dice perche'
                c.title = "Melissa"
                c.body = e.messaggio
            } else {
                // Il Mac non ha risposto (Tailscale spento sull'iPhone?): lo si dice con una notifica locale.
                c.title = "Bottega"
                c.body = "Non sono riuscita a raggiungere il Mac: \(error.localizedDescription)"
            }
            try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        }
    }
}
