//
//  AppleBrain.swift
//  Bottega Nucleo
//
//  `ai.agent`: one turn of Apple Intelligence with real tool calling. The extension sends
//  its tools as OpenAI function specs (the same JSON Schema that goes to Agnes); each one
//  becomes a FoundationModels `Tool` with a dynamic schema. When the model calls a tool the
//  Nucleo emits `tool.call` and waits for `tool.result` from the extension.
//  The on-device context is small (~4k tokens): history, then tools from the tail of the
//  list, are dropped until instructions + tools + history + prompt fit.
//

import Foundation
import FoundationModels

// MARK: - Errors

enum CervelloErrori {
    /// Italian message for any FoundationModels failure (same wording as Intelligence).
    /// Only `LanguageModelError`: `LanguageModelSession.GenerationError` is deprecated in macOS 27.
    static func translate(_ error: Error) -> NucleoError {
        if let e = error as? NucleoError { return e }
        if error is CancellationError { return NucleoError("Richiesta annullata.") }
        if let e = error as? LanguageModelError {
            switch e {
            case .contextSizeExceeded:
                return NucleoError("Il testo e' troppo lungo per il modello sul dispositivo. Accorcialo o dividilo in parti.")
            case .guardrailViolation:
                return NucleoError("Apple Intelligence si e' rifiutata di elaborare questo testo per le sue regole di sicurezza.")
            case .refusal:
                return NucleoError("Apple Intelligence ha rifiutato la richiesta.")
            case .unsupportedLanguageOrLocale:
                return NucleoError("Apple Intelligence non supporta la lingua di questo testo.")
            case .rateLimited:
                return NucleoError("Apple Intelligence e' occupata da troppe richieste: riprova tra qualche secondo.")
            case .timeout:
                return NucleoError("Apple Intelligence non ha risposto in tempo.")
            case .unsupportedGenerationGuide:
                return NucleoError("Apple Intelligence non accetta lo schema richiesto (uno strumento o una risposta guidata).")
            case .unsupportedCapability:
                return NucleoError("Il modello sul Mac non sa fare quello che gli e' stato chiesto.")
            case .unsupportedTranscriptContent:
                return NucleoError("La conversazione contiene qualcosa che il modello sul Mac non sa leggere.")
            default:
                return NucleoError("Apple Intelligence non ha potuto rispondere: \(e.localizedDescription)")
            }
        }
        return NucleoError("Apple Intelligence non ha potuto rispondere: \(error.localizedDescription)")
    }

    static func checkAvailable() throws {
        if let reason = Intelligence.unavailableReason { throw NucleoError(reason, unavailable: true) }
    }
}

// MARK: - Tool specs and schema conversion

/// One OpenAI-style function tool: `{type:'function', function:{name, description, parameters}}`.
struct ToolSpec: @unchecked Sendable {
    let name: String
    let description: String
    let parameters: [String: Any]

    init?(json: [String: Any]) {
        let fn = (json["function"] as? [String: Any]) ?? json
        guard let name = fn["name"] as? String, !name.isEmpty else { return nil }
        self.name = name
        self.description = (fn["description"] as? String) ?? ""
        self.parameters = (fn["parameters"] as? [String: Any]) ?? [:]
    }

    init(name: String, description: String, parameters: [String: Any]) {
        self.name = name
        self.description = description
        self.parameters = parameters
    }
}

/// JSON Schema (the subset tools use) -> DynamicGenerationSchema.
enum SchemaConverter {
    static func generationSchema(for spec: ToolSpec) throws -> GenerationSchema {
        let base = safeName(spec.name)
        let root = object(name: base + "_argomenti", description: nil, schema: spec.parameters, path: base)
        return try GenerationSchema(root: root, dependencies: [])
    }

    private static func object(name: String, description: String?, schema: [String: Any], path: String) -> DynamicGenerationSchema {
        let props = (schema["properties"] as? [String: Any]) ?? [:]
        let required = Set(((schema["required"] as? [Any]) ?? []).compactMap { $0 as? String })
        // JSONSerialization loses key order: required first, then alphabetical (stable).
        let names = props.keys.sorted { a, b in
            let ra = required.contains(a), rb = required.contains(b)
            return ra != rb ? ra : a < b
        }
        let properties = names.map { key -> DynamicGenerationSchema.Property in
            let sub = (props[key] as? [String: Any]) ?? [:]
            return DynamicGenerationSchema.Property(
                name: key,
                description: sub["description"] as? String,
                schema: value(sub, path: path + "_" + safeName(key)),
                isOptional: !required.contains(key))
        }
        return DynamicGenerationSchema(name: name, description: description, properties: properties)
    }

    private static func value(_ s: [String: Any], path: String) -> DynamicGenerationSchema {
        let desc = s["description"] as? String
        if let choices = s["enum"] as? [Any], !choices.isEmpty {
            return DynamicGenerationSchema(name: path, description: desc, anyOf: choices.map { "\($0)" })
        }
        var type = s["type"] as? String
        if type == nil, let types = s["type"] as? [Any] {
            type = types.compactMap { $0 as? String }.first { $0 != "null" }
        }
        if type == nil { type = s["properties"] != nil ? "object" : (s["items"] != nil ? "array" : "string") }
        switch type {
        case "integer":
            return DynamicGenerationSchema(type: Int.self)
        case "number":
            return DynamicGenerationSchema(type: Double.self)
        case "boolean":
            return DynamicGenerationSchema(type: Bool.self)
        case "array":
            let items = (s["items"] as? [String: Any]) ?? ["type": "string"]
            return DynamicGenerationSchema(arrayOf: value(items, path: path + "_voce"),
                                           minimumElements: (s["minItems"] as? NSNumber)?.intValue,
                                           maximumElements: (s["maxItems"] as? NSNumber)?.intValue)
        case "object":
            return object(name: path, description: desc, schema: s, path: path)
        default:
            return DynamicGenerationSchema(type: String.self)
        }
    }

    private static func safeName(_ s: String) -> String {
        String(s.map { $0.isLetter || $0.isNumber || $0 == "_" ? $0 : "_" })
    }

    /// GeneratedContent -> plain JSON values (for events and for the CLI).
    static func plain(_ c: GeneratedContent) -> Any {
        switch c.kind {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let d): return (d == d.rounded() && abs(d) < 1e15) ? Int(d) as Any : d as Any
        case .string(let s): return s
        case .array(let items): return items.map { plain($0) }
        case .structure(let props, let keys):
            var out: [String: Any] = [:]
            for k in keys { if let v = props[k] { out[k] = plain(v) } }
            for (k, v) in props where out[k] == nil { out[k] = plain(v) }
            return out
        @unknown default:
            return c.jsonString
        }
    }
}

/// A tool whose arguments arrive as GeneratedContent and whose work is done by `runner`
/// (the extension in service mode, a fake in `--cli agent-prova`).
struct AgentTool: Tool {
    typealias Arguments = GeneratedContent
    typealias Output = String

    let name: String
    let description: String
    let parameters: GenerationSchema
    let runner: @Sendable (_ name: String, _ args: [String: Any]) async -> String

    @concurrent func call(arguments: GeneratedContent) async throws -> String {
        let args = (SchemaConverter.plain(arguments) as? [String: Any]) ?? [:]
        return await runner(name, args)
    }
}

// MARK: - Waiting for tool.result

/// Pending tool calls of the service: `tool.call` goes out, `tool.result` resolves it.
final class ToolBroker: @unchecked Sendable {
    static let shared = ToolBroker()
    static let timeoutMessage = "Lo strumento non ha risposto in tempo."
    static let timeout: TimeInterval = 20

    private struct Pending {
        let req: String
        let cont: CheckedContinuation<String, Never>
    }
    private let lock = NSLock()
    private var counter = 0
    private var pending: [String: Pending] = [:]

    func nextCallID() -> String {
        lock.lock(); defer { lock.unlock() }
        counter += 1
        return "c\(counter)"
    }

    /// Registers the call, emits the event (after registering, so a fast answer is not
    /// lost) and waits for the result, the timeout or the cancellation of the turn.
    func run(req: String, reqValue: Any?, name: String, args: [String: Any]) async -> String {
        let call = nextCallID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<String, Never>) in
                lock.lock()
                pending[call] = Pending(req: req, cont: cont)
                lock.unlock()
                Out.event("tool.call", ["req": reqValue, "call": call, "id": call, "name": name, "args": args])
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + Self.timeout) { [weak self] in
                    if self?.resolve(call: call, result: Self.timeoutMessage) == true {
                        Log.warn("strumento \(name) (\(call)) senza risposta dopo \(Int(Self.timeout)) s")
                    }
                }
            }
        } onCancel: {
            _ = self.resolve(call: call, result: "Richiesta annullata.")
        }
    }

    /// True when the call was waiting (and is now resolved).
    @discardableResult
    func resolve(call: String, result: String) -> Bool {
        lock.lock()
        let p = pending.removeValue(forKey: call)
        lock.unlock()
        guard let p else { return false }
        p.cont.resume(returning: result)
        return true
    }

    func cancelAll(req: String) {
        lock.lock()
        let calls = pending.filter { $0.value.req == req }.map(\.key)
        lock.unlock()
        for c in calls { resolve(call: c, result: "Richiesta annullata.") }
    }
}

/// Turns in progress, by `req`, for `ai.cancel`.
final class AgentTurns: @unchecked Sendable {
    static let shared = AgentTurns()
    private let lock = NSLock()
    private var tasks: [String: Task<AppleBrain.Output, Error>] = [:]

    func add(_ req: String, _ task: Task<AppleBrain.Output, Error>) {
        lock.lock(); tasks[req] = task; lock.unlock()
    }
    func remove(_ req: String) {
        lock.lock(); tasks[req] = nil; lock.unlock()
    }
    /// True when a turn with that req was running.
    func cancel(_ req: String) -> Bool {
        lock.lock()
        let t = tasks.removeValue(forKey: req)
        lock.unlock()
        ToolBroker.shared.cancelAll(req: req)
        t?.cancel()
        return t != nil
    }
}

// MARK: - The turn

enum AppleBrain {

    struct Turn: Sendable {
        let role: String      // "user" | "assistant"
        let content: String
    }

    struct Input: @unchecked Sendable {
        var instructions: String
        var prompt: String
        var history: [Turn] = []
        var tools: [ToolSpec] = []
        var maxTokens: Int?
        var temperature: Double?
    }

    struct Output: @unchecked Sendable {
        var text: String
        var toolCalls: [[String: Any]]
        var ms: Int
        var dropped: [String]
        var droppedHistory: Int
        var tokens: [String: Int]
        /// "stop", "length" (the answer hit maxTokens) or "cancelled" (ai.cancel: partial text).
        var finish: String

        var json: [String: Any?] {
            ["text": text, "toolCalls": toolCalls, "ms": ms, "dropped": dropped,
             "droppedHistory": droppedHistory, "tokens": tokens, "finish": finish]
        }
    }

    typealias Runner = @Sendable (_ name: String, _ args: [String: Any]) async -> String

    /// Parses the `ai.agent` arguments: `instructions/prompt/history`, or OpenAI `messages`;
    /// `effort` (rapido, normale, profondo) picks maxTokens (200/400/800) and temperature.
    static func input(from r: Request) throws -> Input {
        let effort = r.string("effort") ?? "normale"
        let (defaultTokens, temperature): (Int, Double) = {
            switch effort {
            case "rapido": return (200, 0.3)
            case "profondo": return (800, 0.7)
            default: return (400, 0.6)
            }
        }()
        let tools = (r.dicts("tools") ?? []).compactMap(ToolSpec.init(json:))
        var input: Input
        if let messages = r.dicts("messages"), !messages.isEmpty {
            input = try fromMessages(messages)
        } else {
            let history = (r.dicts("history") ?? []).compactMap { d -> Turn? in
                guard let c = d["content"] as? String, !c.isEmpty else { return nil }
                return Turn(role: (d["role"] as? String) == "assistant" ? "assistant" : "user", content: c)
            }
            input = Input(instructions: r.string("instructions") ?? "", prompt: r.string("prompt") ?? "", history: history)
        }
        input.prompt = input.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.prompt.isEmpty else { throw NucleoError("La domanda e' vuota.") }
        if input.instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            input.instructions = Intelligence.defaultGenerateInstructions
        }
        input.tools = tools
        input.maxTokens = r.int("maxTokens") ?? defaultTokens
        input.temperature = temperature
        return input
    }

    /// OpenAI messages -> instructions (all system messages), prompt (the last user message),
    /// history (what came before; tool calls and results as short bracketed text).
    static func fromMessages(_ messages: [[String: Any]]) throws -> Input {
        func text(_ m: [String: Any]) -> String {
            if let s = m["content"] as? String { return s }
            if let parts = m["content"] as? [[String: Any]] {
                return parts.compactMap { $0["text"] as? String }.joined(separator: "\n")
            }
            return ""
        }
        var system: [String] = []
        var callNames: [String: String] = [:]
        var turns: [Turn] = []
        func add(_ role: String, _ content: String) {
            let c = content.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !c.isEmpty else { return }
            // Consecutive turns of the same side are merged: the transcript stays alternating.
            if let last = turns.last, last.role == role {
                turns[turns.count - 1] = Turn(role: role, content: last.content + "\n" + c)
            } else {
                turns.append(Turn(role: role, content: c))
            }
        }
        let lastUser = messages.lastIndex { ($0["role"] as? String) == "user" }
        guard let lastUser else { throw NucleoError("Nei messaggi manca una domanda dell'utente.") }
        var after: [String] = []
        for (i, m) in messages.enumerated() {
            let role = (m["role"] as? String) ?? "user"
            var piece = ""
            switch role {
            case "system", "developer":
                system.append(text(m)); continue
            case "assistant":
                piece = text(m)
                for call in (m["tool_calls"] as? [[String: Any]]) ?? [] {
                    let fn = (call["function"] as? [String: Any]) ?? [:]
                    let name = (fn["name"] as? String) ?? "?"
                    if let id = call["id"] as? String { callNames[id] = name }
                    let args = (fn["arguments"] as? String) ?? ""
                    piece += (piece.isEmpty ? "" : "\n") + "[chiamo lo strumento \(name)\(args.isEmpty || args == "{}" ? "" : " " + Guidata.clip(args, 120))]"
                }
            case "tool", "function":
                let name = (m["name"] as? String) ?? (m["tool_call_id"] as? String).flatMap { callNames[$0] } ?? "?"
                piece = "[strumento \(name): \(Guidata.clip(text(m), 300))]"
            default:
                piece = text(m)
            }
            if i == lastUser { continue }
            if i > lastUser { after.append(piece); continue }
            add(role == "user" ? "user" : "assistant", piece)
        }
        var prompt = text(messages[lastUser])
        if !after.isEmpty { prompt += "\n\n" + after.joined(separator: "\n") }
        return Input(instructions: system.joined(separator: "\n\n"), prompt: prompt, history: turns)
    }

    /// One turn. `onDelta` gets only the new text of every snapshot; `reset` is true when
    /// the model rewrote what it had already streamed (rare: then `text` is the whole answer).
    static func run(_ input: Input,
                    onDelta: @escaping @Sendable (_ text: String, _ reset: Bool) -> Void,
                    runTool: @escaping Runner) async throws -> Output {
        try CervelloErrori.checkAvailable()
        let start = Date()
        let model = SystemLanguageModel.default
        // Start loading the model while the context is measured (tokenCount takes ~100 ms each).
        let warmup = LanguageModelSession(model: model, instructions: input.instructions)
        warmup.prewarm()

        // Every call is recorded, whoever answers it.
        let log = CallLog()
        let recording: Runner = { name, args in
            log.add(["name": name, "args": args])
            return await runTool(name, args)
        }
        let built = buildTools(input.tools, runner: recording)
        let fitted = try await fit(input, tools: built.tools)
        let tools = fitted.tools, history = fitted.history, counts = fitted.counts
        let dropped = built.dropped + fitted.dropped, droppedHistory = fitted.droppedHistory
        if droppedHistory > 0 || !dropped.isEmpty {
            Log.info("ai.agent: contesto stretto, tolti \(droppedHistory) turni di storia e gli strumenti [\(dropped.joined(separator: ", "))]")
        }

        // Instructions and history as a real transcript.
        var entries: [Transcript.Entry] = [
            .instructions(Transcript.Instructions(
                segments: [.text(Transcript.TextSegment(content: input.instructions))],
                toolDefinitions: tools.map { Transcript.ToolDefinition(tool: $0) }))
        ]
        for t in history {
            let seg: [Transcript.Segment] = [.text(Transcript.TextSegment(content: t.content))]
            if t.role == "assistant" {
                entries.append(.response(Transcript.Response(assetIDs: [], segments: seg)))
            } else {
                entries.append(.prompt(Transcript.Prompt(segments: seg)))
            }
        }
        let session = LanguageModelSession(model: model, tools: tools, transcript: Transcript(entries: entries))
        withExtendedLifetime(warmup) {}
        let maxResponse = input.maxTokens.map { max(16, $0) }
        let options = GenerationOptions(temperature: input.temperature, maximumResponseTokens: maxResponse,
                                        toolCallingMode: tools.isEmpty ? nil : .allowed)

        var text = ""
        var finish = "stop"
        var outputTokens = 0
        do {
            let stream = session.streamResponse(to: input.prompt, options: options)
            for try await snapshot in stream {
                if Task.isCancelled { finish = "cancelled"; break }
                outputTokens = snapshot.usage.output.totalTokenCount
                let now: String = snapshot.content
                if now == text { continue }
                if now.hasPrefix(text) {
                    onDelta(String(now.dropFirst(text.count)), false)
                } else {
                    onDelta(now, true)
                }
                text = now
            }
            if Task.isCancelled { finish = "cancelled" }
        } catch {
            // ai.cancel: the turn ends with what was said so far, not with an error.
            if Task.isCancelled || error is CancellationError {
                finish = "cancelled"
            } else {
                throw CervelloErrori.translate(error)
            }
        }
        if finish == "stop", let maxResponse, outputTokens >= maxResponse { finish = "length" }

        var tokens = counts
        tokens["output"] = outputTokens
        return Output(text: text.trimmingCharacters(in: .whitespacesAndNewlines),
                      toolCalls: log.all, ms: Int(Date().timeIntervalSince(start) * 1000),
                      dropped: dropped, droppedHistory: droppedHistory, tokens: tokens, finish: finish)
    }

    static func buildTools(_ specs: [ToolSpec], runner: @escaping Runner) -> (tools: [AgentTool], dropped: [String]) {
        var tools: [AgentTool] = []
        var dropped: [String] = []
        for spec in specs {
            do {
                tools.append(AgentTool(name: spec.name, description: spec.description,
                                       parameters: try SchemaConverter.generationSchema(for: spec), runner: runner))
            } catch {
                Log.warn("strumento \(spec.name) scartato: schema non convertibile (\(error.localizedDescription))")
                dropped.append(spec.name)
            }
        }
        return (tools, dropped)
    }

    struct Fit {
        var tools: [AgentTool]
        var history: [Turn]
        var dropped: [String]
        var droppedHistory: Int
        var counts: [String: Int]
        var perTool: [String: Int]
    }

    /// Measures instructions, prompt, history and tools with the model's tokenizer and drops
    /// history (oldest first), then tools (from the tail), until the turn fits
    /// `contextSize - (maxTokens ?? 400) - 200`.
    static func fit(_ input: Input, tools all: [AgentTool], perToolCounts: Bool = false) async throws -> Fit {
        let model = SystemLanguageModel.default
        let context = model.contextSize > 0 ? model.contextSize : 4096
        let budget = context - (input.maxTokens ?? 400) - 200
        var tools = all
        var history = input.history
        var dropped: [String] = []
        var droppedHistory = 0
        do {
            let instr = try await model.tokenCount(for: Instructions(input.instructions))
            let prompt = try await model.tokenCount(for: input.prompt)
            var historyTokens: [Int] = []
            for t in history { historyTokens.append(try await model.tokenCount(for: t.content) + 4) }
            // Tools are measured together: every count carries the same fixed tool-calling
            // preamble, so a sum of single counts overstates (2 tools: 497 as singles, 304 together).
            var perTool: [String: Int] = [:]
            if perToolCounts {
                for t in tools { perTool[t.name] = try await model.tokenCount(for: [t] as [any Tool]) }
            }
            let allTools = tools.isEmpty ? 0 : try await model.tokenCount(for: tools as [any Tool])
            var toolsCount = allTools
            func total() -> Int { instr + prompt + historyTokens.reduce(0, +) + toolsCount }
            while total() > budget {
                if !history.isEmpty {
                    history.removeFirst(); historyTokens.removeFirst(); droppedHistory += 1
                } else if !tools.isEmpty {
                    dropped.append(tools.removeLast().name)
                    toolsCount = tools.isEmpty ? 0 : try await model.tokenCount(for: tools as [any Tool])
                } else {
                    break
                }
            }
            var counts = ["instructions": instr, "prompt": prompt, "history": historyTokens.reduce(0, +),
                          "tools": toolsCount, "toolsAll": allTools, "budget": budget, "context": context]
            counts["total"] = total()
            if total() > budget {
                throw NucleoError("La domanda e' troppo lunga per il modello sul Mac anche senza storia e senza strumenti.")
            }
            return Fit(tools: tools, history: history, dropped: dropped, droppedHistory: droppedHistory,
                       counts: counts, perTool: perTool)
        } catch let e as NucleoError {
            throw e
        } catch {
            throw CervelloErrori.translate(error)
        }
    }

    /// Token accounting only, no generation (`--cli agent-prova --solo-misura`).
    static func measure(_ input: Input) async throws -> [String: Any?] {
        try CervelloErrori.checkAvailable()
        let start = Date()
        let built = buildTools(input.tools, runner: { _, _ in "" })
        let f = try await fit(input, tools: built.tools, perToolCounts: true)
        return ["tokens": f.counts, "perTool": f.perTool, "dropped": built.dropped + f.dropped,
                "droppedHistory": f.droppedHistory, "kept": f.tools.map(\.name),
                "ms": Int(Date().timeIntervalSince(start) * 1000)]
    }

    /// Thread-safe list of the calls made during a turn.
    final class CallLog: @unchecked Sendable {
        private let lock = NSLock()
        private var calls: [[String: Any]] = []
        func add(_ c: [String: Any]) { lock.lock(); calls.append(c); lock.unlock() }
        var all: [[String: Any]] { lock.lock(); defer { lock.unlock() }; return calls }
    }
}
