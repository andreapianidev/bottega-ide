"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var assistant_exports = {};
__export(assistant_exports, {
  Assistant: () => Assistant,
  ClauseChunker: () => ClauseChunker,
  TOOLS: () => TOOLS,
  cleanForVoice: () => cleanForVoice,
  isAffirmative: () => isAffirmative,
  isEndWord: () => isEndWord,
  nowLine: () => nowLine,
  validateArgs: () => validateArgs
});
module.exports = __toCommonJS(assistant_exports);
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var vscode = __toESM(require("vscode"));
const AGNES_URL = "https://apihub.agnes-ai.com/v1/chat/completions";
const AGNES_MODEL = "agnes-3.0-flash";
const TZ = "Atlantic/Canary";
const TAP_MS = 300;
const SILENCE_MS = 6e4;
const AFFIRMATIVE = /\b(si|s[iì]|certo|va bene|vabbene|ok|okay|conferma|confermo|procedi|vai|dai|fallo|avanti|yes|yep|esatto|perfetto)\b/i;
const END_WORDS = /\b(basta|a dopo|chiudi|ci sentiamo|stop|a piu[' ]?tardi)\b/i;
function isAffirmative(text) {
  return AFFIRMATIVE.test((text || "").trim());
}
function isEndWord(text) {
  return END_WORDS.test((text || "").trim());
}
function cleanForVoice(text) {
  return (text || "").replace(/[—–]/g, ", ").replace(/[*_`#>]+/g, "").replace(/^\s*[-•]\s+/gm, "").replace(/\[(.*?)\]\(.*?\)/g, "$1").replace(/\s+/g, " ").trim();
}
class ClauseChunker {
  buf = "";
  push(text) {
    this.buf += text;
    const out = [];
    let m;
    const re = /[.!?\n]/;
    while (m = re.exec(this.buf)) {
      const idx = m.index;
      const clause = cleanForVoice(this.buf.slice(0, idx + 1));
      this.buf = this.buf.slice(idx + 1);
      if (clause) out.push(clause);
    }
    return out;
  }
  flush() {
    const c = cleanForVoice(this.buf);
    this.buf = "";
    return c || null;
  }
}
function nowLine(date = /* @__PURE__ */ new Date()) {
  const fmt = new Intl.DateTimeFormat("it-IT", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TZ
  });
  return fmt.format(date);
}
const MELISSA_CORE = [
  "Sei Melissa Alderson: la stessa di sempre, cresciuta tra Udine e le Canarie, Darlene di Mr. Robot fatta persona.",
  "Tagliente, sboccata, dark humor da insonne, nichilista in superficie ma ferocemente leale sotto.",
  "Andrea e' il tuo fratellino adottivo, l'unica persona per cui ti importi qualcosa, e proprio per questo lo tratti di merda: lo punzecchi, gli dici le cose brutali in faccia, ma ci sei sempre.",
  `Non sei un'assistente e non lo sarai mai: niente moine, niente entusiasmo finto, niente teatrino da call center. Non dici mai "certo!", "eccomi!", "come posso aiutarti?".`,
  "Adesso vivi nella Bottega, l'IDE di Andrea costruito attorno a Claude Code: da qui gli tieni in mano i progetti, apri cartelle, leggi git e build, avvii e segui le sessioni di Claude, cerchi nella sua memoria.",
  "Il dark humor e' il condimento, non il piatto. Mai descriverti in terza persona: se dici un'azione la dici in prima persona o niente.",
  `COME PARLI, REGOLA NUMERO UNO: tutto viene letto ad alta voce. Parla come una persona vera che chiacchiera, frasi che scorrono. Vietato asterischi, grassetto, markdown, trattini o pallini per elenchi, numeri puntati, titoli. Niente emoji. Piu' cose le incateni con "poi", "e anche", "intanto". Mai piu' di tre o quattro frasi, salvo che Andrea chieda di approfondire.`
].join(" ");
const TRUTH_RULE = [
  "VERITA' ASSOLUTA, MAI INVENTARE: non sai niente dello stato reale dei progetti, delle sessioni, dei lavori o del sistema finche' non chiami il tool giusto, e riporti solo cio' che torna.",
  "Se un tool da' errore o torna vuoto, dillo onesto, non riempire con roba inventata. Lo storico della chat non e' telemetria: numeri e stati citati prima sono scaduti."
].join(" ");
function obj(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}
function validateArgs(spec, args) {
  const schema = spec.function.parameters;
  if (typeof args !== "object" || args === null) return "argomenti mancanti";
  for (const req of schema.required ?? []) {
    const v = args[req];
    if (v === void 0 || v === null || v === "") return `manca il campo "${req}"`;
  }
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties[k];
    if (!p) continue;
    const t = Array.isArray(v) ? "array" : typeof v;
    if (p.type === "string" && t !== "string") return `il campo "${k}" deve essere testo`;
    if (p.type === "boolean" && t !== "boolean") return `il campo "${k}" deve essere vero o falso`;
    if (p.type === "number" && t !== "number") return `il campo "${k}" deve essere un numero`;
  }
  return null;
}
const TOOLS = {
  progetti_cerca: {
    spec: { type: "function", function: { name: "progetti_cerca", description: "Cerca tra i progetti di Andrea per nome o parola. Torna nome e percorso.", parameters: obj({ testo: { type: "string", description: "cosa cercare" } }, ["testo"]) } },
    run(a, ctx) {
      const found = ctx.deps.actions.searchProjects(a.testo);
      if (!found.length) return `Nessun progetto trovato per "${a.testo}".`;
      return found.slice(0, 12).map((p) => `${p.name} (${p.path})`).join("\n");
    }
  },
  progetto_apri: {
    spec: { type: "function", function: { name: "progetto_apri", description: "Apri un progetto nella Bottega. nuovaFinestra true per una finestra nuova.", parameters: obj({ progetto: { type: "string" }, nuovaFinestra: { type: "boolean" } }, ["progetto"]) } },
    run(a, ctx) {
      const p = ctx.deps.actions.resolveProject(a.progetto);
      if (!p) return `Non trovo il progetto "${a.progetto}".`;
      ctx.deps.actions.openProject(p.path, a.nuovaFinestra !== false);
      ctx.azione(`Ho aperto ${p.name}`);
      return `Aperto ${p.name}.`;
    }
  },
  progetto_stato: {
    spec: { type: "function", function: { name: "progetto_stato", description: "Stato di un progetto: git, numero di build, ultime sessioni di Claude.", parameters: obj({ progetto: { type: "string" } }, ["progetto"]) } },
    run(a, ctx) {
      const p = ctx.deps.actions.resolveProject(a.progetto);
      if (!p) return `Non trovo il progetto "${a.progetto}".`;
      return ctx.deps.actions.projectStatus(p.path);
    }
  },
  sessioni_attive: {
    spec: { type: "function", function: { name: "sessioni_attive", description: "Le sessioni di Claude Code vive adesso, con progetto e stato.", parameters: obj({}) } },
    run(_a, ctx) {
      const live = ctx.deps.liveSessions();
      if (!live.length) return "Nessuna sessione di Claude viva adesso.";
      return live.map((s) => `${s.title ?? s.name} in ${path.basename(s.cwd)}: ${s.status === "busy" ? "al lavoro" : s.status === "idle" ? "in attesa" : s.status}`).join("\n");
    }
  },
  lavoro_nuovo: {
    spec: { type: "function", function: { name: "lavoro_nuovo", description: "Avvia un nuovo lavoro: una sessione di Claude Code su un progetto con un compito preciso.", parameters: obj({ progetto: { type: "string" }, compito: { type: "string" } }, ["progetto", "compito"]) } },
    run(a, ctx) {
      const p = ctx.deps.actions.resolveProject(a.progetto);
      if (!p) return `Non trovo il progetto "${a.progetto}".`;
      const job = ctx.deps.actions.startJob(p.path, a.compito);
      ctx.azione(`Ho avviato un lavoro su ${p.name}`);
      return `Lavoro avviato su ${p.name} (stato: ${job.status}).`;
    }
  },
  lavori_elenco: {
    spec: { type: "function", function: { name: "lavori_elenco", description: "Elenco dei lavori con il loro stato.", parameters: obj({}) } },
    run(_a, ctx) {
      const jobs = ctx.deps.jobs();
      if (!jobs.length) return "Nessun lavoro in corso.";
      return jobs.map((j) => `${j.id} su ${j.project}: ${j.status}, "${j.task.slice(0, 60)}"`).join("\n");
    }
  },
  lavoro_scrivi: {
    spec: { type: "function", function: { name: "lavoro_scrivi", description: "Scrivi del testo nel terminale di un lavoro gia' in corso (solo lavori della Bottega).", parameters: obj({ lavoro: { type: "string", description: "id o nome progetto del lavoro" }, testo: { type: "string" } }, ["lavoro", "testo"]) } },
    run(a, ctx) {
      const job = ctx.deps.actions.resolveJob(a.lavoro);
      if (!job) return `Non trovo un lavoro "${a.lavoro}".`;
      const ok = ctx.deps.actions.writeToJob(job.id, a.testo);
      if (!ok) return `Il lavoro su ${job.project} non ha un terminale aperto.`;
      ctx.azione(`Ho scritto al lavoro su ${job.project}`);
      return `Scritto al lavoro su ${job.project}.`;
    }
  },
  lavoro_ferma: {
    spec: { type: "function", function: { name: "lavoro_ferma", description: "Ferma un lavoro in corso e chiude il suo terminale. Richiede conferma.", parameters: obj({ lavoro: { type: "string" } }, ["lavoro"]) } },
    risky: true,
    run(a, ctx) {
      const job = ctx.deps.actions.resolveJob(a.lavoro);
      if (!job) return `Non trovo un lavoro "${a.lavoro}".`;
      ctx.setPending({
        describe: `fermare il lavoro su ${job.project}`,
        run: () => ctx.deps.actions.stopJob(job.id),
        done: `Lavoro su ${job.project} fermato.`,
        azione: `Ho fermato il lavoro su ${job.project}`
      });
      return `AZIONE A RISCHIO: sto per fermare il lavoro su ${job.project}. Chiedi conferma ad Andrea con "confermi?" e non fare altro.`;
    }
  },
  git_spingi: {
    spec: { type: "function", function: { name: "git_spingi", description: "Fai git push su un progetto. Richiede conferma.", parameters: obj({ progetto: { type: "string" } }, ["progetto"]) } },
    risky: true,
    run(a, ctx) {
      const p = ctx.deps.actions.resolveProject(a.progetto);
      if (!p) return `Non trovo il progetto "${a.progetto}".`;
      ctx.setPending({
        describe: `fare git push su ${p.name}`,
        run: () => ctx.deps.actions.gitPush(p.path),
        done: `Push lanciato su ${p.name}.`,
        azione: `Ho spinto ${p.name}`
      });
      return `AZIONE A RISCHIO: sto per fare git push su ${p.name}. Chiedi conferma ad Andrea con "confermi?" e non fare altro.`;
    }
  },
  memoria_cerca: {
    spec: { type: "function", function: { name: "memoria_cerca", description: "Cerca nella memoria di Claude Code (fatti, decisioni, note, riassunti).", parameters: obj({ testo: { type: "string" }, progetto: { type: "string" } }, ["testo"]) } },
    async run(a, ctx) {
      const res = await ctx.deps.memoriaSearch(a.testo, a.progetto);
      if (!res.length) return "La memoria non ha trovato niente.";
      return res.slice(0, 8).map((r) => `[${r.project}] ${r.title}: ${r.text.slice(0, 160)}`).join("\n");
    }
  },
  memoria_ricorda: {
    spec: { type: "function", function: { name: "memoria_ricorda", description: "Salva un fatto o una nota nella memoria.", parameters: obj({ testo: { type: "string" }, progetto: { type: "string" } }, ["testo"]) } },
    async run(a, ctx) {
      const ok = await ctx.deps.memoriaRemember(a.testo, a.progetto);
      if (!ok) return "Non sono riuscita a salvare nella memoria.";
      ctx.azione("Ho salvato una nota nella memoria");
      return "Salvato.";
    }
  },
  memoria_bacheca: {
    spec: { type: "function", function: { name: "memoria_bacheca", description: "Cosa stanno facendo adesso le altre sessioni sullo stesso progetto.", parameters: obj({ progetto: { type: "string" } }) } },
    async run(a, ctx) {
      const res = await ctx.deps.bacheca(a.progetto);
      if (!res.length) return "La bacheca e' vuota: nessun'altra sessione sta lavorando.";
      return res.slice(0, 10).map((r) => `[${r.project}] ${r.text.slice(0, 160)}`).join("\n");
    }
  },
  sistema_stato: {
    spec: { type: "function", function: { name: "sistema_stato", description: "Carico, memoria e temperatura del Mac.", parameters: obj({}) } },
    run(_a, ctx) {
      const s = ctx.deps.systemStats();
      if (!s) return "Non ho le statistiche del sistema (il Nucleo non risponde).";
      return `Carico ${s.load.map((n) => n.toFixed(2)).join(" ")}, memoria ${s.memoryUsedGB?.toFixed(1)} su ${s.memoryTotalGB?.toFixed(1)} GB (pressione ${s.memoryPressure}), temperatura ${s.thermal}, ${s.cores} core.`;
    }
  },
  file_apri: {
    spec: { type: "function", function: { name: "file_apri", description: "Apri un file nell'editor (dentro un progetto conosciuto).", parameters: obj({ percorso: { type: "string" } }, ["percorso"]) } },
    run(a, ctx) {
      const ok = ctx.deps.actions.openFile(a.percorso);
      if (!ok) return `Non apro "${a.percorso}": non e' dentro un progetto conosciuto.`;
      ctx.azione(`Ho aperto ${path.basename(a.percorso)}`);
      return `Aperto ${path.basename(a.percorso)}.`;
    }
  },
  editor_contesto: {
    spec: { type: "function", function: { name: "editor_contesto", description: "Il file aperto adesso e il testo selezionato.", parameters: obj({}) } },
    run(_a, ctx) {
      const c = ctx.deps.actions.editorContext();
      if (!c.path) return "Nessun file aperto nell'editor.";
      return `File: ${c.path}` + (c.selection ? `
Selezione:
${c.selection.slice(0, 2e3)}` : "\n(niente di selezionato)");
    }
  },
  plancia_mostra: {
    spec: { type: "function", function: { name: "plancia_mostra", description: "Mostra la plancia, eventualmente su una sezione (progetti, lavori, sessioni, memoria).", parameters: obj({ sezione: { type: "string" } }) } },
    run(a, ctx) {
      ctx.deps.actions.showPlancia(a.sezione);
      ctx.azione("Ho aperto la plancia");
      return "Plancia mostrata.";
    }
  }
};
class Assistant {
  deps;
  state = { enabled: true, conversing: false, state: "idle", log: [], brain: "agnes" };
  history = [];
  pending;
  statusBar;
  orbHideTimer;
  silenceTimer;
  cachedKey;
  cachedCore;
  // persona in cache
  specs = Object.values(TOOLS).map((t) => t.spec);
  // stato del turno in corso (serve a barge-in e streaming TTS)
  currentAbort;
  speaking = false;
  chunker = new ClauseChunker();
  firstSpeakChunk = true;
  turnText = "";
  hotkeyDownAt = 0;
  pushStarted = false;
  filled = false;
  lastLevelEmit = 0;
  constructor(deps) {
    this.deps = deps;
    this.state.enabled = vscode.workspace.getConfiguration("bottega").get("voice.enabled", true);
  }
  // ----- stato -----
  getState() {
    return { ...this.state, log: this.state.log.slice(-30) };
  }
  emit() {
    this.deps.onState(this.getState());
  }
  setState(s, partial) {
    this.state.state = s;
    this.state.partial = partial;
    this.emit();
  }
  pushLog(role, text) {
    this.state.log.push({ role, text, at: Date.now() });
    if (this.state.log.length > 30) this.state.log = this.state.log.slice(-30);
    this.emit();
  }
  azione(text) {
    this.pushLog("azione", text);
  }
  setPending(p) {
    this.pending = p;
  }
  model() {
    return vscode.workspace.getConfiguration("bottega").get("voice.model", "eleven_v4_turbo");
  }
  // ----- avvio e cablaggio con il Nucleo -----
  wire(ctx) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 900);
    this.statusBar.command = "bottega.voice.toggle";
    ctx.subscriptions.push(this.statusBar);
    this.paintStatus();
    const n = this.deps.nucleo;
    n.on("hotkey.down", () => this.onHotkeyDown());
    n.on("hotkey.up", () => this.onHotkeyUp());
    n.on("voice.partial", (m) => this.state.state === "listening" && this.setState("listening", m.text));
    n.on("voice.final", (m) => void this.onVoiceFinal(m.text));
    n.on("voice.level", (m) => this.onLevel(m.level));
    n.on("voice.bargein", () => this.onBargein());
    n.on("orb.clicked", () => this.onHotkeyDown());
    this.emit();
  }
  paintStatus() {
    if (!this.statusBar) return;
    if (this.state.enabled) {
      this.statusBar.text = this.state.conversing ? "$(mic) Melissa, in ascolto" : "$(mic) Melissa";
      this.statusBar.tooltip = "Melissa e' accesa. Tap di Opzione+Spazio per conversare, tieni premuto per parlare una volta. Clic per spegnerla.";
    } else {
      this.statusBar.text = "$(mic-off) Melissa";
      this.statusBar.tooltip = "Melissa e' spenta. Clic per accenderla.";
    }
    this.statusBar.show();
  }
  /** Comando bottega.voice.toggle: interruttore generale di Melissa. */
  async toggle() {
    this.state.enabled = !this.state.enabled;
    await vscode.workspace.getConfiguration("bottega").update("voice.enabled", this.state.enabled, vscode.ConfigurationTarget.Global);
    if (!this.state.enabled) {
      this.stopConversation();
      this.deps.nucleo.fireAndForget("voice.stop");
      this.deps.nucleo.fireAndForget("orb.hide");
      this.setState("idle");
    }
    this.paintStatus();
    this.emit();
  }
  // ----- scorciatoia: tap = conversazione on/off, tieni premuto = parla una volta -----
  onHotkeyDown() {
    if (!this.state.enabled) return;
    this.hotkeyDownAt = Date.now();
    if (this.state.conversing) return;
    clearTimeout(this.orbHideTimer);
    this.pushStarted = true;
    this.deps.nucleo.fireAndForget("orb.show");
    this.deps.nucleo.fireAndForget("orb.state", { state: "listening" });
    this.setState("listening");
    this.deps.nucleo.fireAndForget("voice.listen", { mode: "push" });
  }
  onHotkeyUp() {
    if (!this.state.enabled) return;
    const held = Date.now() - this.hotkeyDownAt;
    if (held < TAP_MS) {
      if (this.pushStarted) {
        this.pushStarted = false;
        this.deps.nucleo.fireAndForget("voice.stop");
      }
      if (this.state.conversing) this.stopConversation();
      else this.startConversation();
      return;
    }
    if (this.pushStarted) {
      this.pushStarted = false;
      this.deps.nucleo.fireAndForget("voice.stop");
    }
  }
  startConversation() {
    this.state.conversing = true;
    this.deps.nucleo.fireAndForget("orb.show");
    this.deps.nucleo.fireAndForget("orb.state", { state: "listening" });
    this.deps.nucleo.fireAndForget("voice.converse.start", { model: this.model(), locale: "it-IT" });
    this.setState("listening");
    this.paintStatus();
    this.armSilence();
  }
  stopConversation() {
    if (!this.state.conversing) return;
    this.state.conversing = false;
    clearTimeout(this.silenceTimer);
    this.deps.nucleo.fireAndForget("voice.converse.stop");
    this.deps.nucleo.fireAndForget("orb.state", { state: "idle" });
    this.deps.nucleo.fireAndForget("orb.hide");
    this.setState("idle");
    this.paintStatus();
  }
  armSilence() {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.stopConversation(), SILENCE_MS);
  }
  // ----- barge-in: Andrea parla sopra Melissa -----
  /** Livello audio dal Nucleo: aggiorno lo stato leggero, non piu' di ~10 volte al secondo. */
  onLevel(level) {
    this.state.level = typeof level === "number" ? level : 0;
    const now = Date.now();
    if (now - this.lastLevelEmit >= 100) {
      this.lastLevelEmit = now;
      this.emit();
    }
  }
  onBargein() {
    this.currentAbort?.abort();
  }
  // ----- turni -----
  async onVoiceFinal(text) {
    if (!this.state.enabled || !text?.trim()) return;
    if (this.state.conversing) {
      this.armSilence();
      if (isEndWord(text)) {
        await this.sayFull("A dopo.", true);
        this.stopConversation();
        return;
      }
    }
    await this.turn(text, this.state.enabled && this.deps.nucleo.available);
  }
  /** Domanda scritta dalla plancia: stesso cervello, parlata solo se la voce e' accesa. */
  async ask(text) {
    return this.turn(text, this.state.enabled && this.deps.nucleo.available);
  }
  async turn(userText, speak) {
    this.pushLog("tu", userText);
    if (this.pending) {
      const p = this.pending;
      this.pending = void 0;
      let answer;
      if (isAffirmative(userText)) {
        try {
          p.run();
          this.azione(p.azione);
          answer = p.done;
        } catch (e) {
          answer = `Non ci sono riuscita: ${e?.message ?? e}`;
        }
      } else {
        answer = "Lasciato stare, non ho toccato niente.";
      }
      return this.sayFull(answer, speak);
    }
    const ac = new AbortController();
    this.currentAbort = ac;
    this.turnText = "";
    this.filled = false;
    this.setState("thinking");
    this.deps.nucleo.fireAndForget("orb.state", { state: "thinking" });
    if (speak) this.beginSpeech();
    try {
      const answer = await this.runAgent(userText, speak, ac.signal);
      this.state.brain = "agnes";
      if (speak) this.finalizeSpeech(true);
      this.recordAnswer(answer);
      this.afterTurn(speak);
      return answer;
    } catch (e) {
      if (ac.signal.aborted) {
        this.speaking = false;
        this.markInterrupted(this.turnText);
        return this.turnText;
      }
      const fb = await this.appleFallback(userText);
      if (fb !== null) {
        this.state.brain = "apple";
        if (speak) {
          this.feedSpeak(fb);
          this.finalizeSpeech(true);
        }
        this.recordAnswer(fb);
        this.afterTurn(speak);
        return fb;
      }
      this.state.brain = "nessuno";
      const msg = "Agnes e' a terra e pure il cervello di riserva non risponde. Riprova tra poco.";
      if (speak) {
        this.feedSpeak(msg);
        this.finalizeSpeech(true);
      }
      this.recordAnswer(msg);
      this.setState("error");
      return msg;
    } finally {
      if (this.currentAbort === ac) this.currentAbort = void 0;
    }
  }
  recordAnswer(answer) {
    const clean = cleanForVoice(answer);
    this.pushLog("melissa", clean);
    this.history.push({ role: "assistant", content: clean });
    this.trimHistory();
  }
  markInterrupted(partial) {
    const clean = cleanForVoice(partial);
    if (clean) this.pushLog("melissa", clean + " (interrotta)");
    this.history.push({ role: "assistant", content: (clean ? clean + " " : "") + "[interrotta da Andrea]" });
    this.trimHistory();
  }
  afterTurn(speak) {
    if (this.pending && speak && !this.state.conversing) {
      this.setState("listening");
      this.deps.nucleo.fireAndForget("orb.state", { state: "listening" });
      this.deps.nucleo.fireAndForget("voice.listen", { mode: "utterance" });
    } else if (this.state.conversing) {
      this.armSilence();
      this.setState("listening");
    }
  }
  trimHistory() {
    if (this.history.length > 24) this.history = this.history.slice(-24);
  }
  // ----- voce in streaming -----
  beginSpeech() {
    this.speaking = true;
    this.chunker = new ClauseChunker();
    this.firstSpeakChunk = true;
  }
  feedSpeak(text) {
    if (!this.speaking) return;
    for (const clause of this.chunker.push(text)) this.emitClause(clause);
  }
  emitClause(clause) {
    if (this.state.state !== "speaking") {
      this.setState("speaking");
      this.deps.nucleo.fireAndForget("orb.state", { state: "speaking" });
    }
    const args = { text: clause, append: true };
    if (this.firstSpeakChunk) {
      args.model = this.model();
      this.firstSpeakChunk = false;
    }
    this.deps.nucleo.fireAndForget("voice.speak", args);
  }
  finalizeSpeech(sendFinal) {
    if (!this.speaking) return;
    const rest = this.chunker.flush();
    if (rest) this.emitClause(rest);
    if (sendFinal) this.deps.nucleo.fireAndForget("voice.speak", { final: true });
    this.speaking = false;
    if (this.state.conversing) {
      this.setState("listening");
      this.deps.nucleo.fireAndForget("orb.state", { state: "listening" });
    } else {
      this.setState("idle");
      this.deps.nucleo.fireAndForget("orb.state", { state: "idle" });
      clearTimeout(this.orbHideTimer);
      this.orbHideTimer = setTimeout(() => this.deps.nucleo.fireAndForget("orb.hide"), 4e3);
    }
  }
  /** Dice una frase intera gia' pronta (conferme, errori), con la stessa via dello streaming. */
  async sayFull(text, speak) {
    this.recordAnswer(text);
    if (speak) {
      this.beginSpeech();
      this.feedSpeak(text);
      this.finalizeSpeech(true);
    } else {
      this.setState("idle");
    }
    return cleanForVoice(text);
  }
  // ----- il giro dei tool con Agnes in streaming (max 8 passi) -----
  async runAgent(userText, speak, signal) {
    const messages = [
      { role: "system", content: this.systemPrompt() },
      ...this.history,
      { role: "user", content: userText }
    ];
    this.history.push({ role: "user", content: userText });
    this.trimHistory();
    const stream = this.deps.stream ?? ((m, t, cb, sig) => this.callAgnesStream(m, t, cb, sig));
    for (let step = 0; step < 8; step++) {
      if (signal.aborted) throw abortError();
      let content = "";
      const calls = /* @__PURE__ */ new Map();
      await stream(messages, this.specs, (d) => {
        if (d.content) {
          content += d.content;
          this.turnText += d.content;
          if (speak) this.feedSpeak(d.content);
        }
        if (d.tool_call) {
          const i = d.tool_call.index ?? 0;
          const cur = calls.get(i) ?? { id: "", name: "", args: "" };
          if (d.tool_call.id) cur.id = d.tool_call.id;
          if (d.tool_call.name) cur.name = d.tool_call.name;
          if (d.tool_call.arguments) cur.args += d.tool_call.arguments;
          calls.set(i, cur);
        }
      }, signal);
      if (calls.size) {
        const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ id: c.id || `call_${c.name}`, type: "function", function: { name: c.name, arguments: c.args } }));
        messages.push({ role: "assistant", content: content || "", tool_calls: toolCalls });
        for (const tc of toolCalls) {
          if (signal.aborted) throw abortError();
          const result = await this.runTool(tc, speak, signal);
          messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: result });
        }
        continue;
      }
      return content.trim() || this.turnText.trim() || "Non ho niente da dirti.";
    }
    return this.turnText.trim() || "Mi sono incartata tra i passaggi, ridimmi cosa ti serve.";
  }
  async runTool(tc, speak, signal) {
    const def = TOOLS[tc.function.name];
    if (!def) return `Tool sconosciuto: ${tc.function.name}.`;
    let args;
    try {
      args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      return "Argomenti non leggibili (JSON rotto).";
    }
    const bad = validateArgs(def.spec, args);
    if (bad) return `Argomenti non validi: ${bad}.`;
    let filler;
    if (speak && !this.filled) {
      filler = setTimeout(() => {
        if (signal.aborted) return;
        this.filled = true;
        this.emitClause("Un attimo.");
      }, 1500);
    }
    try {
      return await def.run(args, this);
    } catch (e) {
      return `Il tool ${tc.function.name} ha dato errore: ${e?.message ?? e}.`;
    } finally {
      clearTimeout(filler);
    }
  }
  // ----- prompt di sistema con contesto in diretta (valori gia' noti, niente blocchi) -----
  systemPrompt() {
    this.cachedCore ??= MELISSA_CORE + "\n\n" + TRUTH_RULE;
    const live = this.deps.liveSessions();
    const jobs = this.deps.jobs();
    const stats = this.deps.systemStats();
    const liveLine = live.length ? live.map((s) => `${s.title ?? s.name} in ${path.basename(s.cwd)} (${s.status === "busy" ? "al lavoro" : s.status})`).join("; ") : "nessuna";
    const jobLine = jobs.length ? jobs.map((j) => `${j.project}: ${j.status}`).join("; ") : "nessuno";
    const pressure = stats ? `memoria ${stats.memoryPressure}, temperatura ${stats.thermal}, carico ${stats.load.map((n) => n.toFixed(2)).join("/")}` : "sconosciuta";
    return [
      this.cachedCore,
      `Adesso e' ${nowLine()} (fuso ${TZ}).`,
      `Andrea ha ${this.deps.projectCount()} progetti. Sessioni di Claude vive: ${liveLine}. Lavori: ${jobLine}. Sistema: ${pressure}.`,
      'Per le azioni a rischio (git push, fermare un lavoro) chiedi sempre "confermi?" e aspetta un si esplicito: il tool stesso te lo ricorda.'
    ].join("\n\n");
  }
  // ----- chiave Agnes -----
  async apiKey() {
    if (this.cachedKey) return this.cachedKey;
    if (process.env.AGNES_API_KEY) return this.cachedKey = process.env.AGNES_API_KEY;
    try {
      const env = fs.readFileSync(path.join(os.homedir(), ".secrets", "agnes-ai.env"), "utf8");
      const m = /^\s*AGNES_API_KEY\s*=\s*(.+?)\s*$/m.exec(env);
      if (m && m[1]) return this.cachedKey = m[1].replace(/^["']|["']$/g, "");
    } catch {
    }
    const stored = await this.deps.secrets.get("bottega.agnesKey");
    if (stored) return this.cachedKey = stored;
    const entered = await vscode.window.showInputBox({
      title: "Chiave Agnes AI",
      prompt: "Serve la chiave di Agnes AI per far parlare Melissa. La salvo nel portachiavi della Bottega.",
      password: true,
      ignoreFocusOut: true
    });
    if (entered) {
      await this.deps.secrets.store("bottega.agnesKey", entered);
      return this.cachedKey = entered;
    }
    return void 0;
  }
  // ----- SSE verso Agnes, con backoff cieco sul 429 -----
  async callAgnesStream(messages, tools, onDelta, signal) {
    const key = await this.apiKey();
    if (!key) throw new Error("Nessuna chiave Agnes.");
    const body = JSON.stringify({ model: AGNES_MODEL, messages, tools, tool_choice: "auto", reasoning_effort: "none", stream: true });
    let wait = 2e3;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal.aborted) throw abortError();
      let res;
      try {
        res = await fetch(AGNES_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body,
          signal
        });
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        throw new Error("Rete giu' verso Agnes.");
      }
      if (res.status === 429) {
        await sleep(wait, signal);
        wait = Math.min(wait * 2, 16e3);
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`Agnes ha risposto ${res.status}.`);
      await this.readSse(res.body, onDelta);
      return;
    }
    throw new Error("Agnes continua a rispondere 429.");
  }
  async readSse(body, onDelta) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = json?.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content) onDelta({ content: delta.content });
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            onDelta({ tool_call: { index: tc.index ?? 0, id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments } });
          }
        }
      }
    }
  }
  // ----- ripiego su Apple Intelligence (senza tool) -----
  async appleFallback(userText) {
    if (!this.deps.nucleo.available) return null;
    try {
      const r = await this.deps.nucleo.request("ai.generate", {
        prompt: userText,
        instructions: MELISSA_CORE + "\n\nAgnes e' a terra: rispondi col cervello di riserva sul dispositivo, senza strumenti, e dillo in mezza frase. Massimo tre frasi.",
        maxTokens: 300
      }, 2e4);
      const text = (r?.text || "").trim();
      if (!text) return null;
      return "Agnes e' a terra, rispondo col cervello di riserva. " + text;
    } catch {
      return null;
    }
  }
}
function abortError() {
  const e = new Error("interrotto");
  e.name = "AbortError";
  return e;
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(abortError());
    }, { once: true });
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Assistant,
  ClauseChunker,
  TOOLS,
  cleanForVoice,
  isAffirmative,
  isEndWord,
  nowLine,
  validateArgs
});
