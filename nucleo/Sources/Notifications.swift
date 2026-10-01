//
//  Notifications.swift
//  Bottega Nucleo
//
//  System notifications with action buttons. This works because the executable runs
//  from inside its .app bundle (com.andreapiani.bottega.nucleo): the notification shows
//  as "Bottega Nucleo" with its own permission in System Settings.
//

import Foundation
import UserNotifications

@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    private var center: UNUserNotificationCenter { .current() }
    private var categories: [String: UNNotificationCategory] = [:]
    private var authorized: Bool?

    func start() {
        center.delegate = self
    }

    struct Action { let id: String; let title: String }

    func post(id: String, title: String, body: String, subtitle: String?, sound: Bool, actions: [Action]) async throws {
        try await ensureAuthorized()
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let subtitle { content.subtitle = subtitle }
        if sound { content.sound = .default }
        content.userInfo = ["bottegaId": id]
        if !actions.isEmpty {
            let catID = "bottega." + actions.map(\.id).joined(separator: ".")
            if categories[catID] == nil {
                let uns = actions.map { UNNotificationAction(identifier: $0.id, title: $0.title, options: []) }
                categories[catID] = UNNotificationCategory(identifier: catID, actions: uns, intentIdentifiers: [], options: [])
                center.setNotificationCategories(Set(categories.values))
            }
            content.categoryIdentifier = catID
        }
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        try await center.add(request)
    }

    private func ensureAuthorized() async throws {
        if authorized == true { return }
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional:
            authorized = true
        case .notDetermined:
            let ok = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            authorized = ok
            if !ok { throw NucleoError("Le notifiche della Bottega sono state negate.") }
        default:
            authorized = false
            throw NucleoError("Le notifiche della Bottega sono spente: attivale in Impostazioni di Sistema, Notifiche, Bottega Nucleo.")
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let id = response.notification.request.identifier
        let action = response.actionIdentifier
        var fields: [String: Any?] = ["id": id]
        if action != UNNotificationDefaultActionIdentifier {
            fields["action"] = action == UNNotificationDismissActionIdentifier ? "dismiss" : action
        }
        Out.event("notify.clicked", fields)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}
