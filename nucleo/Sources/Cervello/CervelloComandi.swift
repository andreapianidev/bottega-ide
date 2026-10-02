//
//  CervelloComandi.swift
//  Bottega Nucleo
//
//  The single entry point of the Cervello: service commands (handle) and --cli commands
//  (CervelloCLI.run). Service.swift and main.swift only need one line each.
//
//    ai.agent {req?, instructions, prompt, history? | messages (OpenAI), tools, maxTokens?, effort?}
//        -> {text, toolCalls:[{name,args}], ms, dropped, droppedHistory, tokens, finish}
//        events ai.delta {req, text, reset?}, tool.call {req, call, id, name, args}
//    tool.result {call, result}   ai.cancel {req}
//    ai.classify {text} -> {categoria, motivo}
//    ai.frase {project, events} -> {progetto, azione, oggetto, frase}
//    bacheca.live {on}   bacheca.frasi -> {sessions}
//    ai.embed.ctx {texts} -> {dimension, vectors, model:"contestuale"}
//    ai.expand {query} -> {termini, ms}
//    ai.rerank {query, candidates:[{id,text}], timeoutMs?, maxChars?, forma?} -> {ordine, punteggi, ms, completo}
//        forma "migliori" (default: the 3 best, scored 3/2/1) or "punteggi" (0...3 for each)
//

import Foundation

@MainActor
enum CervelloComandi {
    static let commands: Set<String> = ["ai.agent", "tool.result", "ai.cancel", "ai.classify", "ai.frase",
                                        "bacheca.live", "bacheca.frasi", "ai.embed.ctx",
                                        "ai.expand", "ai.rerank"]

    /// False when the command is not ours. Errors are answered here (with `unavailable: true`
    /// when Apple Intelligence is missing), so the caller never sees them.
    static func handle(_ r: Request) async throws -> Bool {
        guard commands.contains(r.cmd) else { return false }
        do {
            switch r.cmd {
            case "ai.agent":
                try await agent(r)

            case "tool.result":
                guard let call = r.string("call") else { throw NucleoError("Manca il campo call.") }
                let result: String
                if let s = r.args["result"] as? String {
                    result = s
                } else if let v = r.args["result"], !(v is NSNull) {
                    result = JSON.encode(v)
                } else {
                    result = ""
                }
                guard ToolBroker.shared.resolve(call: call, result: result) else {
                    throw NucleoError("Nessuno strumento in attesa con call \(call): forse e' scaduto o il turno e' stato annullato.")
                }
                r.respond()

            case "ai.cancel":
                guard let req = reqKey(r, field: "req") else { throw NucleoError("Manca il campo req del turno da annullare.") }
                r.respond(["cancelled": AgentTurns.shared.cancel(req)])

            case "ai.classify":
                let c = try await Guidata.classifica(testo: r.string("text") ?? "")
                r.respond(["categoria": Guidata.nome(c.categoria), "motivo": c.motivo])

            case "ai.frase":
                let events = (r.dicts("events") ?? []).compactMap(RigaBacheca.init(json:))
                let project = r.string("project") ?? events.last?.project ?? ""
                let f = try await Guidata.frase(eventi: events, progetto: project)
                r.respond(["progetto": f.progetto, "azione": f.azione, "oggetto": f.oggetto, "frase": f.frase])

            case "bacheca.live":
                if r.bool("on") ?? true {
                    try BachecaViva.shared.start()
                } else {
                    BachecaViva.shared.stop()
                }
                r.respond(["on": BachecaViva.shared.isOn, "dir": BachecaViva.dir.path])

            case "bacheca.frasi":
                r.respond(["sessions": BachecaViva.shared.frasiRecenti()])

            case "ai.embed.ctx":
                let texts = r.strings("texts") ?? []
                let result = try await Task.detached(priority: .userInitiated) {
                    try Contestuale.embedContextual(texts)
                }.value
                r.respond(["dimension": result.dimension, "vectors": result.vectors, "model": Contestuale.modelName])

            case "ai.expand":
                let e = try await Ricerca.expand(query: r.string("query") ?? "")
                r.respond(["termini": e.termini, "ms": e.ms, "caldo": e.warm])

            case "ai.rerank":
                let out = try await Ricerca.rerank(query: r.string("query") ?? "",
                                                   candidates: Ricerca.candidati(r.dicts("candidates") ?? []),
                                                   timeoutMs: r.int("timeoutMs") ?? 1500,
                                                   maxChars: r.int("maxChars") ?? 300,
                                                   forma: r.string("forma") ?? "migliori")
                r.respond(out.json)

            default:
                return false
            }
        } catch {
            let e = CervelloErrori.translate(error)
            var out: [String: Any?] = ["id": r.id, "ok": false, "error": e.message]
            if e.unavailable { out["unavailable"] = true }
            if error is CancellationError || e.message == "Richiesta annullata." { out["cancelled"] = true }
            Out.line(out)
        }
        return true
    }

    /// The turn key: the extension's own `req` string when present, else the request id.
    private static func reqKey(_ r: Request, field: String) -> String? {
        if let v = r.args[field], !(v is NSNull) { return "\(v)" }
        return nil
    }

    private static func agent(_ r: Request) async throws {
        let input = try AppleBrain.input(from: r)
        let reqValue: Any? = r.args["req"].flatMap { $0 is NSNull ? nil : $0 } ?? r.id
        let req = reqValue.map { "\($0)" } ?? UUID().uuidString
        let task = Task<AppleBrain.Output, Error> {
            try await AppleBrain.run(input, onDelta: { text, reset in
                var fields: [String: Any?] = ["req": reqValue, "text": text]
                if reset { fields["reset"] = true }
                Out.event("ai.delta", fields)
            }, runTool: { name, args in
                await ToolBroker.shared.run(req: req, reqValue: reqValue, name: name, args: args)
            })
        }
        AgentTurns.shared.add(req, task)
        defer { AgentTurns.shared.remove(req) }
        let out = try await task.value
        r.respond(out.json)
    }
}

// MARK: - Command line

/// `BottegaNucleo --cli <comando>` for the Cervello. nil = not one of ours.
///
///   classify                      < righe JSON {id, text}      -> righe {id, categoria, motivo, ms}
///   frase [--progetto P]          < righe della bacheca         -> {progetto, azione, oggetto, frase, ms}
///   embed-ctx [--righe] [--coseni] < una frase per riga         -> {dimension, model, vectors, ms}
///                                   (--righe: una riga {vector} per riga, subito, processo lungo)
///   expand                        < una domanda per riga        -> una riga {q, termini, ms, caldo} per domanda
///   rerank                        < righe {q, candidates, timeoutMs?} -> una riga {ordine, punteggi, ms, completo}
///   agent-prova --prompt "..." [--tools f.json] [--storia f.json] [--solo-misura] [--max-tokens N]
///   bacheca-viva [--secondi N]    eventi su stdout (cartella: BOTTEGA_BACHECA_DIR)
///
/// expand, rerank and embed-ctx --righe answer line by line (flushed) and keep the model warm
/// between lines: the Memoria MCP server keeps one of them open as a long-lived child.
///
/// Exit: 0 ok, 1 errore (stderr), 2 Apple Intelligence non disponibile, 64 uso sbagliato.
enum CervelloCLI {
    static let commands: Set<String> = ["classify", "frase", "embed-ctx", "agent-prova", "bacheca-viva",
                                        "expand", "rerank"]

    static func run(_ args: [String]) -> Int32? {
        guard let command = args.first, commands.contains(command) else { return nil }
        Out.enabled = false
        let opts = options(Array(args.dropFirst()))
        switch command {
        case "classify": return wait { try await classify() }
        case "frase": return wait { try await frase(progetto: opts["progetto"]) }
        case "embed-ctx":
            if opts["righe"] != nil { return embedLines() }
            return wait { try embedCtx(cosines: opts["coseni"] != nil) }
        case "expand":
            Sessioni.prewarm("expand", instructions: Ricerca.expandInstructions)
            return eachLine { line in
                let e = try await Ricerca.expand(query: line)
                return ["q": line, "termini": e.termini, "ms": e.ms, "caldo": e.warm]
            }
        case "rerank":
            Sessioni.prewarm("rerank.migliori", instructions: Ricerca.rerankBestInstructions)
            return eachLine { line in
                guard let data = line.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    throw NucleoError("Riga non valida: serve un oggetto JSON {q, candidates}.")
                }
                let r = try await Ricerca.rerank(query: (obj["q"] as? String) ?? (obj["query"] as? String) ?? "",
                                                 candidates: Ricerca.candidati((obj["candidates"] as? [[String: Any]]) ?? []),
                                                 timeoutMs: (obj["timeoutMs"] as? NSNumber)?.intValue ?? 1500,
                                                 maxChars: (obj["maxChars"] as? NSNumber)?.intValue ?? 300,
                                                 forma: (obj["forma"] as? String) ?? "migliori")
                var out = r.json
                if let q = obj["q"] ?? obj["query"] { out["q"] = q }
                return out
            }
        case "agent-prova":
            guard let prompt = opts["prompt"], !prompt.isEmpty else { return usage() }
            return wait { try await agentProva(prompt: prompt, opts: opts) }
        case "bacheca-viva":
            return bachecaViva(seconds: opts["secondi"].flatMap(Double.init) ?? 60)
        default:
            return nil
        }
    }

    // MARK: commands

    private static func classify() async throws -> Int32 {
        let lines = readStdin().components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        var ok = 0, failed = 0
        for line in lines {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                printLine(["error": "Riga non valida: serve un oggetto JSON {id, text}."]); failed += 1; continue
            }
            let id = obj["id"]
            let start = Date()
            do {
                let c = try await Guidata.classifica(testo: (obj["text"] as? String) ?? "")
                printLine(["id": id, "categoria": Guidata.nome(c.categoria), "motivo": c.motivo, "ms": ms(start)])
                ok += 1
            } catch {
                let e = CervelloErrori.translate(error)
                if e.unavailable { throw e }
                printLine(["id": id, "error": e.message, "ms": ms(start)])
                failed += 1
            }
        }
        return (failed > 0 && ok == 0) ? 1 : 0
    }

    private static func frase(progetto: String?) async throws -> Int32 {
        let rows = readStdin().components(separatedBy: "\n").compactMap { RigaBacheca(line: $0) }
        guard !rows.isEmpty else { throw NucleoError("Nessuna riga della bacheca su stdin.") }
        let start = Date()
        let f = try await Guidata.frase(eventi: rows, progetto: progetto ?? rows.last?.project ?? "")
        printLine(["progetto": f.progetto, "azione": f.azione, "oggetto": f.oggetto, "frase": f.frase, "ms": ms(start)])
        return 0
    }

    private static func embedCtx(cosines: Bool) throws -> Int32 {
        let lines = readStdin().components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        let start = Date()
        let r = try Contestuale.embedContextual(lines)
        var out: [String: Any?] = ["dimension": r.dimension, "model": Contestuale.modelName, "vectors": r.vectors, "ms": ms(start)]
        if cosines {
            out["coseni"] = r.vectors.map { a in r.vectors.map { b in (Contestuale.coseno(a, b) * 1000).rounded() / 1000 } }
        }
        printLine(out)
        return 0
    }

    /// One `{"vector": [...]}` line per input line, flushed at once (empty line: zero vector).
    private static func embedLines() -> Int32 {
        while let line = readLine(strippingNewline: true) {
            do {
                let r = try Contestuale.embedContextual([line])
                printLine(["vector": r.vectors.first ?? []])
            } catch {
                printLine(["error": CervelloErrori.translate(error).message])
            }
            fflush(stdout)
        }
        return 0
    }

    /// Long-lived line protocol: every non-empty stdin line gets one JSON line, flushed at
    /// once. A per-line failure is an `{"error"}` line; without Apple Intelligence: exit 2.
    private static func eachLine(_ body: @escaping @Sendable (String) async throws -> [String: Any?]) -> Int32 {
        while let raw = readLine(strippingNewline: true) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            let box = LineBox()
            let sem = DispatchSemaphore(value: 0)
            Task.detached {
                do { box.out = try await body(line) } catch { box.error = CervelloErrori.translate(error) }
                sem.signal()
            }
            sem.wait()
            if let e = box.error {
                printLine(["error": e.message])
                fflush(stdout)
                if e.unavailable {
                    FileHandle.standardError.write(Data("nucleo: \(e.message)\n".utf8))
                    return 2
                }
            } else {
                printLine(box.out)
                fflush(stdout)
            }
        }
        return 0
    }

    private final class LineBox: @unchecked Sendable {
        var out: [String: Any?] = [:]
        var error: NucleoError?
    }

    /// One `ai.agent` turn with two fake tools answered in-process (plus any from --tools):
    /// proves tool calling without the extension.
    private static func agentProva(prompt: String, opts: [String: String]) async throws -> Int32 {
        var tools: [ToolSpec] = []
        if let path = opts["tools"] {
            guard let data = FileManager.default.contents(atPath: path),
                  let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                throw NucleoError("Il file degli strumenti \(path) non e' un array JSON di ToolSpec.")
            }
            tools = arr.compactMap(ToolSpec.init(json:))
        } else {
            tools = [
                ToolSpec(name: "ora_attuale", description: "L'ora e la data di adesso sul Mac.",
                         parameters: ["type": "object", "properties": [String: Any](), "required": [String]()]),
                ToolSpec(name: "progetti_cerca", description: "Cerca tra i progetti di Andrea per nome o parola. Torna nome e percorso.",
                         parameters: ["type": "object",
                                      "properties": ["testo": ["type": "string", "description": "cosa cercare"]],
                                      "required": ["testo"]]),
            ]
        }
        var history: [AppleBrain.Turn] = []
        if let path = opts["storia"] {
            guard let data = FileManager.default.contents(atPath: path),
                  let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                throw NucleoError("Il file della storia \(path) non e' un array JSON di {role, content}.")
            }
            history = arr.compactMap { d in
                (d["content"] as? String).map { AppleBrain.Turn(role: (d["role"] as? String) ?? "user", content: $0) }
            }
        }
        let input = AppleBrain.Input(
            instructions: opts["instructions"] ?? """
            Sei Melissa, l'assistente vocale della Bottega di Andrea. Rispondi in italiano, in una o due \
            frasi brevi da dire a voce. Usa gli strumenti quando servono per rispondere con dati veri.
            """,
            prompt: prompt, history: history, tools: tools, maxTokens: opts["max-tokens"].flatMap(Int.init))

        if opts["solo-misura"] != nil {
            // Token accounting only, nothing is generated.
            let m = try await AppleBrain.measure(input)
            printLine(m)
            return 0
        }

        let deltas = AppleBrain.CallLog()
        let firstDelta = AppleBrain.CallLog()
        let start = Date()
        let out = try await AppleBrain.run(input, onDelta: { text, reset in
            if firstDelta.all.isEmpty { firstDelta.add(["ms": ms(start)]) }
            deltas.add(["text": text, "reset": reset])
        }, runTool: { name, args in
            let result = fakeTool(name, args)
            FileHandle.standardError.write(Data("strumento \(name) \(JSON.encode(args)) -> \(result)\n".utf8))
            return result
        })
        var json = out.json
        json["deltas"] = deltas.all.count
        json["firstDeltaMs"] = firstDelta.all.first?["ms"]
        printLine(json)
        return 0
    }

    private static func fakeTool(_ name: String, _ args: [String: Any]) -> String {
        switch name {
        case "ora_attuale":
            let f = DateFormatter()
            f.locale = Locale(identifier: "it_IT")
            f.dateFormat = "EEEE d MMMM yyyy, 'ore' HH:mm"
            return "Adesso e' " + f.string(from: Date()) + "."
        case "progetti_cerca":
            let all = ["Bottega (~/Prototipi/Bottega)", "Peak (~/Prototipi/Peak)", "Woofmap (~/Prototipi/Woofmap)",
                       "WalkieTalkie (~/Prototipi/WalkieTalkie)", "Paranoid (~/Prototipi/Paranoid)"]
            let q = ((args["testo"] as? String) ?? "").lowercased()
            let hit = all.filter { q.isEmpty || $0.lowercased().contains(q) }
            return hit.isEmpty ? "Nessun progetto trovato per \"\(q)\". Progetti: " + all.joined(separator: "; ")
                               : hit.joined(separator: "; ")
        default:
            return "Strumento finto \(name): nessun dato in modalita' prova."
        }
    }

    /// Watches the board for N seconds, printing the events as JSON lines.
    private static func bachecaViva(seconds: Double) -> Int32 {
        Out.enabled = true
        do {
            try BachecaViva.shared.start()
        } catch {
            return failure(error)
        }
        FileHandle.standardError.write(Data("bacheca viva su \(BachecaViva.dir.path) per \(Int(seconds)) s\n".utf8))
        let done = DispatchSemaphore(value: 0)
        _ = done.wait(timeout: .now() + seconds)
        BachecaViva.shared.stop()
        Out.drain()
        return 0
    }

    // MARK: plumbing

    private static func wait(_ body: @escaping @Sendable () async throws -> Int32) -> Int32 {
        let box = ResultBox()
        let sem = DispatchSemaphore(value: 0)
        Task.detached {
            do { box.code = try await body() } catch { box.code = failure(error) }
            sem.signal()
        }
        sem.wait()
        fflush(stdout)
        return box.code
    }

    private final class ResultBox: @unchecked Sendable { var code: Int32 = 1 }

    private static func failure(_ error: Error) -> Int32 {
        let e = CervelloErrori.translate(error)
        FileHandle.standardError.write(Data("nucleo: \(e.message)\n".utf8))
        return e.unavailable ? 2 : 1
    }

    private static func options(_ argv: [String]) -> [String: String] {
        var out: [String: String] = [:]
        var i = 0
        while i < argv.count {
            let a = argv[i]
            if a.hasPrefix("--") {
                let key = String(a.dropFirst(2))
                if i + 1 < argv.count, !argv[i + 1].hasPrefix("--") {
                    out[key] = argv[i + 1]; i += 2
                } else {
                    out[key] = "1"; i += 1
                }
            } else {
                i += 1
            }
        }
        return out
    }

    private static func readStdin() -> String {
        String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
    }

    private static func printLine(_ obj: [String: Any?]) {
        print(JSON.encode(obj))
    }

    private static func ms(_ start: Date) -> Int { Int(Date().timeIntervalSince(start) * 1000) }

    private static func usage() -> Int32 {
        FileHandle.standardError.write(Data("""
        uso: BottegaNucleo --cli <comando>
          classify                  < righe JSON {id, text}
          frase [--progetto P]      < righe della bacheca
          embed-ctx [--righe] [--coseni] < una frase per riga
          expand                    < una domanda per riga
          rerank                    < righe JSON {q, candidates, timeoutMs?}
          agent-prova --prompt "..." [--tools f.json] [--storia f.json] [--solo-misura] [--max-tokens N]
          bacheca-viva [--secondi N]

        """.utf8))
        return 64
    }
}
