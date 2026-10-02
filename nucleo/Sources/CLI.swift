//
//  CLI.swift
//  Bottega Nucleo
//
//  --cli mode, used by the Memoria hooks outside the IDE. A plain process: no AppKit UI,
//  no status item, no Dock icon, exits as soon as the answer is printed.
//
//    BottegaNucleo --cli summarize [--instructions "..."]  < testo
//    BottegaNucleo --cli generate  [--instructions "..."] [--max-tokens N] < prompt
//    BottegaNucleo --cli embed     [--language it]  < una frase per riga
//    BottegaNucleo --cli stats
//    BottegaNucleo --cli capabilities
//    BottegaNucleo --cli tts --out file.wav [--engine elevenlabs|apple] [--via ws|rest] < testo
//    BottegaNucleo --cli power
//    BottegaNucleo --cli stato [--file stato.json]   the sentences the App Intents would say
//    BottegaNucleo --cli spotlight-find <testo>      our own items in the Spotlight index
//
//  Exit codes: 0 ok, 1 error (message on stderr), 2 Apple Intelligence unavailable,
//  64 usage error.
//

import Foundation

enum CLI {
    static func run(_ argv: [String]) -> Never {
        Out.enabled = false
        guard let command = argv.first else { usage() }
        var options: [String: String] = [:]
        var i = 1
        while i < argv.count {
            let a = argv[i]
            if a.hasPrefix("--") {
                let key = String(a.dropFirst(2))
                if i + 1 < argv.count, !argv[i + 1].hasPrefix("--") {
                    options[key] = argv[i + 1]
                    i += 2
                } else {
                    options[key] = "1"
                    i += 1
                }
            } else {
                i += 1
            }
        }

        let opts = options
        switch command {
        case "stats":
            print(JSON.encode(SystemStats.snapshot()))
            exit(0)
        case "capabilities":
            runAsync { print(JSON.encode(await Capabilities.collect())) }
        case "power":
            print(JSON.encode(Power.snapshot()))
            exit(0)
        case "stato":
            // Diagnostics: what "Briefing" and "Stato delle regole" would answer right now.
            let s = opts["file"].map { Stato.load(from: URL(fileURLWithPath: $0)) } ?? Stato.load()
            print(JSON.encode(["briefing": s.briefingText, "regole": s.rulesSentence]))
            exit(0)
        case "spotlight-find":
            guard argv.count > 1, !argv[1].hasPrefix("--") else { usage() }
            let text = argv[1]
            runAsync { print(JSON.encode(try await Spotlight.find(text))) }
        case "embed":
            let lines = readStdin().components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            do {
                let r = try Intelligence.embed(lines, language: opts["language"])
                print(JSON.encode(["dimension": r.dimension, "vectors": r.vectors]))
                exit(0)
            } catch {
                fail(error)
            }
        case "summarize":
            let text = readStdin()
            runAsync {
                let s = try await Intelligence.summarize(text: text, instructions: opts["instructions"])
                print(s)
            }
        case "generate":
            let prompt = readStdin()
            runAsync {
                let s = try await Intelligence.generate(prompt: prompt, instructions: opts["instructions"],
                                                        maxTokens: opts["max-tokens"].flatMap(Int.init))
                print(s)
            }
        case "stt-file":
            // Diagnostics: streams a WAV through the ElevenLabs STT client. No microphone.
            guard argv.count > 1, !argv[1].hasPrefix("--") else { usage() }
            let wav = argv[1]
            runAsync { print(JSON.encode(try await SttFile.run(path: wav, commit: opts["commit"] ?? "manual"))) }
        case "orb-selftest":
            // Diagnostics only: builds every Metal pipeline and renders offscreen. No window.
            runAsync { print(JSON.encode(await OrbSelfTest.run())) }
        case "tts":
            guard let out = opts["out"] else { usage() }
            let text = readStdin().trimmingCharacters(in: .whitespacesAndNewlines)
            runAsync {
                let info = try await SpeechFile.render(text: text, to: URL(fileURLWithPath: out),
                                                       engine: opts["engine"], via: opts["via"], model: opts["model"])
                print(JSON.encode(info))
            }
        default:
            usage()
        }
    }

    private static func readStdin() -> String {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        return String(decoding: data, as: UTF8.self)
    }

    private static func runAsync(_ body: @escaping @Sendable () async throws -> Void) -> Never {
        Task.detached {
            do {
                try await body()
                fflush(stdout)
                exit(0)
            } catch {
                fail(error)
            }
        }
        dispatchMain()
    }

    private static func fail(_ error: Error) -> Never {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        FileHandle.standardError.write(Data("nucleo: \(message)\n".utf8))
        if let e = error as? NucleoError, e.unavailable { exit(2) }
        exit(1)
    }

    private static func usage() -> Never {
        FileHandle.standardError.write(Data("""
        uso: BottegaNucleo --cli <comando>
          summarize [--instructions "..."]             < testo     riassunto su stdout
          generate  [--instructions "..."] [--max-tokens N] < prompt
          embed     [--language it]                    < una frase per riga
          stats
          capabilities
          tts --out file.wav [--engine elevenlabs|apple] [--via ws|rest] < testo
          power
          stato [--file stato.json]
          spotlight-find <testo>

        """.utf8))
        exit(64)
    }
}
