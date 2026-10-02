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

    #if DEBUG
    private let ambiente = "sviluppo"
    #else
    private let ambiente = "produzione"
    #endif

    /// A collegamento fatto: permesso (la prima volta lo chiede iOS), registrazione, token della Live Activity e
    /// dei widget. Si puo' chiamare a ogni apertura: rimanda solo cio' che e' cambiato.
    func avvia() {
        guard ponte.collegato else { return }
        Task {
            let c = UNUserNotificationCenter.current()
            let ok = (try? await c.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            if ok { UIApplication.shared.registerForRemoteNotifications() }
        }
        if osservaAttivita == nil { osservaAttivita = Task { await self.seguiAttivita() } }
        if let w = Condiviso.preferenze.string(forKey: Condiviso.chiaveTokenWidget), !w.isEmpty { inAttesa["widget"] = w }
        Task { await manda() }
    }

    /// Scollegato: il Mac non sa piu' niente di questo iPhone.
    func dimentica() {
        mandati = [:]
        Condiviso.preferenze.removeObject(forKey: "tokenMandati")
    }

    func token(_ campo: String, _ dati: Data) {
        inAttesa[campo] = dati.map { String(format: "%02x", $0) }.joined()
        Task { await manda() }
    }

    private func manda() async {
        let nuovi = inAttesa.filter { mandati[$0.key] != $0.value }
        guard !nuovi.isEmpty, ponte.collegato else { return }
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
        for await a in Activity<BottegaAttivita>.activityUpdates { seguiUna(a) }
    }

    private func seguiUna(_ a: Activity<BottegaAttivita>) {
        Task {
            for await t in a.pushTokenUpdates { self.token("attivita", t) }
        }
        Task {
            for await s in a.activityStateUpdates where s == .ended || s == .dismissed {
                self.inAttesa["attivita"] = ""
                await self.manda()
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
            case "si":
                _ = try await ponte.chiedi("sì")
            case "no":
                _ = try await ponte.chiedi("no")
            default:
                Navigazione.shared.stanza = categoria == "CONFERMA" ? .melissa : .lavori
            }
        } catch {
            // Il Mac non ha risposto (Tailscale spento sull'iPhone?): lo si dice con una notifica locale.
            let c = UNMutableNotificationContent()
            c.title = "Bottega"
            c.body = "Non sono riuscita a raggiungere il Mac: \(error.localizedDescription)"
            try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        }
    }
}
