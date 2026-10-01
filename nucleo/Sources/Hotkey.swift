//
//  Hotkey.swift
//  Bottega Nucleo
//
//  Global push-to-talk. Carbon RegisterEventHotKey is the one global shortcut API that
//  needs no Accessibility permission. We listen to BOTH pressed and released, so holding
//  the keys is "talk" and letting go is "done" (events hotkey.down / hotkey.up).
//  Default: Option+Space. Cmd+Option+M is Melissa's own app and is refused.
//

import AppKit
import Carbon.HIToolbox

@MainActor
final class Hotkey {
    static let shared = Hotkey()

    private static let signature: OSType = "BTGN".utf8.reduce(OSType(0)) { ($0 << 8) | OSType($1) }
    private static let hotKeyID: UInt32 = 1

    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var isDown = false
    private(set) var label = ""

    var isArmed: Bool { hotKeyRef != nil }

    func register(key: String?, modifiers: [String]?) throws -> String {
        let keyName = (key?.isEmpty == false ? key! : "space").lowercased()
        let mods = (modifiers?.isEmpty == false ? modifiers! : ["option"]).map { $0.lowercased() }
        guard let code = Self.keyCode(keyName) else {
            throw NucleoError("Tasto \"\(keyName)\" non riconosciuto per la scorciatoia.")
        }
        var carbonMods: UInt32 = 0
        var names: [String] = []
        for m in mods {
            switch m {
            case "option", "alt", "opt": carbonMods |= UInt32(optionKey); names.append("Option")
            case "command", "cmd": carbonMods |= UInt32(cmdKey); names.append("Cmd")
            case "control", "ctrl": carbonMods |= UInt32(controlKey); names.append("Ctrl")
            case "shift": carbonMods |= UInt32(shiftKey); names.append("Shift")
            default: throw NucleoError("Modificatore \"\(m)\" non riconosciuto (usa option, command, control, shift).")
            }
        }
        guard carbonMods != 0 else { throw NucleoError("La scorciatoia globale ha bisogno di almeno un modificatore.") }
        if code == UInt32(kVK_ANSI_M), carbonMods == UInt32(cmdKey | optionKey) {
            throw NucleoError("Cmd+Option+M e' la scorciatoia di Melissa: scegline un'altra.")
        }

        unregister()
        if handlerRef == nil {
            var types = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                         EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
            let status = InstallEventHandler(GetEventDispatcherTarget(), Self.handler, 2, &types, nil, &handlerRef)
            guard status == noErr else {
                throw NucleoError("Impossibile installare il gestore della scorciatoia (errore \(status)).")
            }
        }
        let id = EventHotKeyID(signature: Self.signature, id: Self.hotKeyID)
        let status = RegisterEventHotKey(code, carbonMods, id, GetEventDispatcherTarget(), 0, &hotKeyRef)
        guard status == noErr else {
            hotKeyRef = nil
            throw NucleoError("La scorciatoia \((names + [keyName]).joined(separator: "+")) e' gia' usata da un'altra app.")
        }
        label = (names + [keyName.count == 1 ? keyName.uppercased() : keyName.capitalized]).joined(separator: "+")
        Log.info("scorciatoia registrata: \(label)")
        return label
    }

    func unregister() {
        if let ref = hotKeyRef { UnregisterEventHotKey(ref); hotKeyRef = nil }
        if isDown { isDown = false; Out.event("hotkey.up") }
        label = ""
    }

    fileprivate func fire(pressed: Bool) {
        // Carbon does not auto-repeat hot keys, but be defensive about duplicates.
        if pressed {
            guard !isDown else { return }
            isDown = true
            Out.event("hotkey.down", ["key": label])
        } else {
            guard isDown else { return }
            isDown = false
            Out.event("hotkey.up", ["key": label])
        }
    }

    private static let handler: EventHandlerUPP = { _, event, _ -> OSStatus in
        var fired = EventHotKeyID()
        let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                       nil, MemoryLayout<EventHotKeyID>.size, nil, &fired)
        guard status == noErr, fired.signature == Hotkey.signature, fired.id == Hotkey.hotKeyID else { return noErr }
        let pressed = GetEventKind(event) == UInt32(kEventHotKeyPressed)
        MainActor.assumeIsolated { Hotkey.shared.fire(pressed: pressed) }
        return noErr
    }

    static func keyCode(_ name: String) -> UInt32? {
        let named: [String: Int] = [
            "space": kVK_Space, "return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab,
            "escape": kVK_Escape, "esc": kVK_Escape, "delete": kVK_Delete, "backspace": kVK_Delete,
            "left": kVK_LeftArrow, "right": kVK_RightArrow, "up": kVK_UpArrow, "down": kVK_DownArrow,
            "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
            "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
            "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
            "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
            "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
            "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
            "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y,
            "z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
            "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8,
            "9": kVK_ANSI_9, "period": kVK_ANSI_Period, "comma": kVK_ANSI_Comma, "slash": kVK_ANSI_Slash,
            "semicolon": kVK_ANSI_Semicolon, "quote": kVK_ANSI_Quote, "grave": kVK_ANSI_Grave,
        ]
        return named[name].map { UInt32($0) }
    }
}
