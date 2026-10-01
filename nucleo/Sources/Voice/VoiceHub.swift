//
//  VoiceHub.swift
//  Bottega Nucleo
//
//  One place that knows the overall voice state, so `voice.state` is emitted once per
//  real change and the orb follows it without the extension having to drive every
//  transition. The extension can still set any orb state (thinking, error): it holds
//  until the next voice transition.
//

import Foundation

@MainActor
final class VoiceHub {
    static let shared = VoiceHub()

    private var lastState = "idle"
    private var lastConversing = false
    private var lastSpeaking = false
    private var thinkingUntil: Date?

    var conversing: Bool { Listener.shared.conversing }

    /// Recomputes the state and emits `voice.state` when it changed.
    func refresh() {
        let speaking = Speaker.shared.isSpeaking
        if speaking != lastSpeaking {
            lastSpeaking = speaking
            if speaking { Listener.shared.speechStarted() }
        }
        let state: String
        if speaking { state = "speaking" }
        else if Listener.shared.isCapturing { state = "listening" }
        else { state = "idle" }
        setState(state)
    }

    func setState(_ state: String) {
        let conv = conversing
        guard state != lastState || conv != lastConversing else { return }
        lastState = state
        lastConversing = conv
        var fields: [String: Any?] = ["state": state, "conversing": conv]
        if let m = Listener.shared.mode, m != .wake { fields["mode"] = m.rawValue }
        if Listener.shared.wakeEnabled { fields["wake"] = true }
        Out.event("voice.state", fields)

        switch state {
        case "speaking":
            thinkingUntil = nil
            OrbPanel.shared.autoState(.speaking)
        case "listening":
            if let until = thinkingUntil, until > Date() { return }
            OrbPanel.shared.autoState(.listening)
        case "processing":
            OrbPanel.shared.autoState(.thinking)
        default:
            if let until = thinkingUntil, until > Date() { return }
            OrbPanel.shared.autoState(.idle)
        }
    }

    /// A user turn just ended: the orb thinks until the reply starts (or 20 s pass).
    func userTurnEnded() {
        thinkingUntil = Date().addingTimeInterval(20)
        OrbPanel.shared.autoState(.thinking)
        DispatchQueue.main.asyncAfter(deadline: .now() + 20.5) {
            MainActor.assumeIsolated {
                let hub = VoiceHub.shared
                guard let until = hub.thinkingUntil, until <= Date() else { return }
                hub.thinkingUntil = nil
                hub.lastState = ""
                hub.refresh()
            }
        }
    }

    func partial(_ text: String) {
        OrbPanel.shared.autoCaption(text)
    }

    func speakingSegment(_ text: String) {
        OrbPanel.shared.autoCaption(text)
    }

    func speakingEnded(spoken: String) {
        Listener.shared.speechEnded(spoken: spoken)
    }
}
