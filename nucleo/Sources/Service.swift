//
//  Service.swift
//  Bottega Nucleo
//
//  Service mode: reads JSON lines from stdin on a background thread (a blocking read,
//  so 0% CPU while nothing arrives), dispatches each request concurrently, and exits
//  cleanly when stdin closes (the extension, our parent, went away).
//

import AppKit
import Metal
import WidgetKit

enum StdinReader {
    static func start() {
        let thread = Thread {
            while let line = readLine(strippingNewline: true) {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty { continue }
                guard let req = Request(line: trimmed) else {
                    Log.warn("riga non valida ignorata: \(trimmed.prefix(120))")
                    if let data = trimmed.data(using: .utf8),
                       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let id = obj["id"] {
                        Out.fail(id, "Richiesta non valida: manca il campo cmd.")
                    }
                    continue
                }
                Task { @MainActor in await Service.handle(req) }
            }
            // EOF: the parent is gone.
            DispatchQueue.main.async {
                MainActor.assumeIsolated { Service.shutdown(reason: "stdin chiuso") }
            }
        }
        thread.name = "nucleo.stdin"
        thread.qualityOfService = .userInitiated
        thread.start()
    }
}

@MainActor
enum Service {
    static func handle(_ r: Request) async {
        do {
            switch r.cmd {
            case "ping":
                r.respond(["version": Nucleo.version])

            case "capabilities":
                r.respond(await Capabilities.collect())

            case "system.stats":
                r.respond(SystemStats.snapshot())

            // MARK: voice
            case "voice.listen":
                let mode = Listener.Mode(rawValue: r.string("mode") ?? "push") ?? .push
                guard mode == .push || mode == .utterance else {
                    throw NucleoError("Modo di ascolto \"\(r.string("mode") ?? "")\" non valido: usa push o utterance.")
                }
                try await Listener.shared.listen(mode: mode, locale: r.string("locale"))
                r.respond(["backend": Listener.shared.backendName])

            case "voice.stop":
                await Listener.shared.stop()
                r.respond()

            case "voice.converse.start":
                try await Listener.shared.converseStart(locale: r.string("locale"))
                r.respond(["echoCancellation": Listener.shared.echoCancellation,
                           "backend": Listener.shared.backendName])

            case "voice.converse.stop":
                await Listener.shared.converseStop()
                r.respond()

            case "voice.speak":
                let text = r.string("text") ?? ""
                let append = r.bool("append") ?? false
                let final = r.bool("final") ?? false
                if text.isEmpty && !final { throw NucleoError("Niente da dire: il campo text e' vuoto.") }
                Speaker.shared.speak(text: text, append: append, final: final,
                                     model: r.string("model"), voice: r.string("voice"))
                r.respond(["engine": Speaker.shared.currentEngine.rawValue])

            case "voice.stopSpeaking":
                Speaker.shared.stopSpeaking()
                r.respond()

            case "wake.enable":
                try await Listener.shared.wakeEnable(phrase: r.string("phrase") ?? "melissa", locale: r.string("locale"))
                r.respond()

            case "wake.disable":
                await Listener.shared.wakeDisable()
                r.respond()

            // MARK: orb
            case "orb.show":
                OrbPanel.shared.show()
                r.respond()

            case "orb.dock":
                OrbPanel.shared.dock()
                r.respond(["presentation": "docked"])

            case "orb.hide":
                OrbPanel.shared.hide()
                r.respond()

            case "orb.state":
                guard let name = r.string("state"), let st = OrbPanel.OrbState(name: name) else {
                    throw NucleoError("Stato della sfera non valido: usa idle, listening, thinking, speaking o error.")
                }
                OrbPanel.shared.set(state: st, caption: r.string("caption"))
                // In conversation a turn that ends without voice reopens the microphone.
                if st == .listening || st == .idle { Listener.shared.replyOver() }
                r.respond()

            // MARK: hotkey, notifications, menu bar
            case "hotkey.register":
                let label = try Hotkey.shared.register(key: r.string("key"), modifiers: r.strings("modifiers"))
                r.respond(["label": label])

            case "hotkey.unregister":
                Hotkey.shared.unregister()
                r.respond()

            case "notify":
                guard let id = r.string("id") ?? r.int("id").map(String.init) else {
                    throw NucleoError("La notifica ha bisogno di un id.")
                }
                let actions = (r.dicts("actions") ?? []).compactMap { d -> Notifier.Action? in
                    guard let aid = d["id"] as? String, let title = d["title"] as? String else { return nil }
                    return Notifier.Action(id: aid, title: title)
                }
                try await Notifier.shared.post(id: id, title: r.string("title") ?? "Bottega",
                                               body: r.string("body") ?? "", subtitle: r.string("subtitle"),
                                               sound: r.bool("sound") ?? true, actions: actions)
                r.respond()

            case "menubar.update":
                let items = r.dicts("items")?.compactMap { d -> MenuBar.Item? in
                    guard let id = d["id"].map({ "\($0)" }), let title = d["title"] as? String else { return nil }
                    return MenuBar.Item(id: id, title: title, status: (d["status"] as? String) ?? "")
                }
                let lines = r.dicts("lines")?.compactMap { d -> MenuBar.Line? in
                    guard let title = d["title"] as? String else { return nil }
                    return MenuBar.Line(id: d["id"].flatMap { $0 is NSNull ? nil : "\($0)" }, title: title,
                                        tone: d["tone"] as? String)
                }
                // tone: absent = keep, null = no dot, "rosso" / "giallo" = dot.
                let tone: String?? = r.args["tone"] == nil ? .none : .some(r.string("tone"))
                // The orb breathes faster with the sessions at work.
                MetalEngine.shared.setLoad(busy: r.int("busy") ?? 0, waiting: r.int("waiting") ?? 0)
                MenuBar.shared.update(busy: r.int("busy") ?? 0, waiting: r.int("waiting") ?? 0,
                                      queued: r.int("queued") ?? 0, title: r.string("title"),
                                      items: items, visible: r.bool("visible"), lines: lines, tone: tone)
                r.respond()

            // MARK: power
            case "power.status":
                r.respond(Power.snapshot())

            case "power.keepAwake":
                r.respond(["token": try Power.shared.keepAwake(reason: r.string("reason") ?? "")])

            case "power.release":
                guard let token = r.string("token") else { throw NucleoError("Manca il token da rilasciare.") }
                try Power.shared.release(token: token)
                r.respond()

            // MARK: Spotlight
            case "spotlight.index":
                let items = try (r.dicts("items") ?? []).map(Spotlight.Item.init)
                let count = try await Spotlight.index(items, replace: r.bool("replace") ?? false)
                r.respond(["count": count])

            case "spotlight.clear":
                try await Spotlight.clear(kind: r.string("kind"))
                r.respond()

            // MARK: widget
            case "widget.reload":
                // stato.json changed: the desktop widget redraws now instead of within 15 minutes.
                WidgetCenter.shared.reloadAllTimelines()
                r.respond()

            // MARK: Apple Intelligence
            case "ai.generate":
                let text = try await Intelligence.generate(prompt: r.string("prompt") ?? "",
                                                           instructions: r.string("instructions"),
                                                           maxTokens: r.int("maxTokens"))
                r.respond(["text": text])

            case "ai.summarize":
                let text = try await Intelligence.summarize(text: r.string("text") ?? "",
                                                            instructions: r.string("instructions"))
                r.respond(["text": text])

            case "ai.embed":
                let texts = r.strings("texts") ?? []
                let lang = r.string("language")
                let result = try await Task.detached(priority: .userInitiated) {
                    try Intelligence.embed(texts, language: lang)
                }.value
                r.respond(["dimension": result.dimension, "vectors": result.vectors])

            case "quit":
                r.respond()
                shutdown(reason: "richiesta quit")

            default:
                // Apple Intelligence with tools, live board, Osservatorio, Metal (Nativo.swift).
                if try await Nativo.handle(r) { return }
                throw NucleoError("Comando sconosciuto: \(r.cmd)")
            }
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            r.fail(message)
        }
    }

    static func shutdown(reason: String) {
        Log.info("chiusura: \(reason)")
        Power.shared.releaseAll()
        Hotkey.shared.unregister()
        MenuBar.shared.remove()
        Speaker.shared.stopSpeaking()
        Out.drain()
        exit(0)
    }
}

@MainActor
enum Capabilities {
    static func collect() async -> [String: Any?] {
        var out: [String: Any?] = [
            "version": Nucleo.version,
            "foundationModels": Intelligence.isAvailable,
            // No local speech model any more: "installed" means "usable" (ElevenLabs key present).
            "speechLocaleInstalled": ElevenLabsConfig.isConfigured,
            "speechLocale": "it-IT",
            "speechBackend": Listener.backend,
            "sttSecondsThisSession": (Listener.shared.sttSecondsSent * 10).rounded() / 10,
            "embedding": Intelligence.embeddingAvailable,
            "embeddingDimension": Intelligence.embedding(for: .italian)?.dimension ?? 0,
            "metal": MTLCreateSystemDefaultDevice()?.name ?? "",
            "memoryGB": SystemStats.memoryTotalGB,
            "cores": SystemStats.cores,
            "ttsEngine": Speaker.shared.currentEngine.rawValue,
            "ttsModel": Speaker.shared.currentEngine == .elevenlabs ? ElevenLabsConfig.realtimeModel : "apple",
            "elevenLabsConfigured": ElevenLabsConfig.isConfigured,
            "elevenLabsVoice": ElevenLabsConfig.isConfigured ? ElevenLabsConfig.voiceID : nil,
            "elevenLabsCharsThisMonth": ElevenLabsUsage.charsThisMonth,
            "appleVoice": Speaker.appleVoice()?.identifier,
            "echoCancellation": Listener.shared.echoCancellation,
            "echoCancellationTested": Listener.shared.echoTested,
            "conversing": Listener.shared.conversing,
            "hotkey": Hotkey.shared.isArmed ? Hotkey.shared.label : nil,
        ]
        if let reason = Intelligence.unavailableReason { out["foundationModelsReason"] = reason }
        return out
    }
}
