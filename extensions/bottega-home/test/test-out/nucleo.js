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
var nucleo_exports = {};
__export(nucleo_exports, {
  Nucleo: () => Nucleo,
  parseHotkey: () => parseHotkey,
  resolveNucleoPath: () => resolveNucleoPath
});
module.exports = __toCommonJS(nucleo_exports);
var import_child_process = require("child_process");
var import_events = require("events");
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var vscode = __toESM(require("vscode"));
const HOME = os.homedir();
function resolveNucleoPath(extensionPath) {
  const configured = vscode.workspace.getConfiguration("bottega").get("nucleoPath");
  const candidates = [
    configured,
    path.join(extensionPath, "nucleo", "Bottega Nucleo.app", "Contents", "MacOS", "BottegaNucleo"),
    path.join(HOME, "prototipi", "Bottega", "nucleo", "build", "Bottega Nucleo.app", "Contents", "MacOS", "BottegaNucleo")
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return void 0;
}
class Nucleo extends import_events.EventEmitter {
  constructor(extensionPath) {
    super();
    this.extensionPath = extensionPath;
    this.setMaxListeners(50);
  }
  proc;
  buffer = "";
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  backoff = 500;
  restartTimer;
  statsTimer;
  stopped = false;
  execPath;
  _available = false;
  _capabilities;
  _lastStats;
  get available() {
    return this._available;
  }
  get capabilities() {
    return this._capabilities;
  }
  get lastStats() {
    return this._lastStats;
  }
  /** Avvia il Nucleo. Se l'eseguibile non c'e', resta spento senza rilanciare in loop. */
  start() {
    this.stopped = false;
    this.execPath = resolveNucleoPath(this.extensionPath);
    if (!this.execPath) {
      this._available = false;
      this.emit("unavailable", "Il Nucleo nativo non e' installato: la voce e le funzioni native sono spente.");
      return;
    }
    this.spawnProc();
  }
  spawnProc() {
    if (this.stopped || !this.execPath) return;
    let proc;
    try {
      proc = (0, import_child_process.spawn)(this.execPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      this.scheduleRestart();
      return;
    }
    this.proc = proc;
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk) => this.onStdout(chunk));
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk) => this.emit("stderr", chunk));
    proc.on("error", () => {
    });
    proc.on("exit", () => this.onExit());
    this.onReady();
  }
  async onReady() {
    this._available = true;
    this.backoff = 500;
    this.emit("available");
    try {
      const caps = await this.request("capabilities", {}, 5e3);
      this._capabilities = caps;
      this.emit("capabilities", caps);
    } catch {
    }
    const hotkey = vscode.workspace.getConfiguration("bottega").get("voice.hotkey", "option+space");
    const { key, modifiers } = parseHotkey(hotkey);
    this.request("hotkey.register", { key, modifiers }, 5e3).catch(() => void 0);
    this.startStatsLoop();
  }
  startStatsLoop() {
    clearInterval(this.statsTimer);
    const tick = async () => {
      try {
        const stats = await this.request("system.stats", {}, 5e3);
        this._lastStats = stats;
        this.emit("system.stats", stats);
      } catch {
      }
    };
    void tick();
    this.statsTimer = setInterval(tick, 1e4);
  }
  onStdout(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }
  dispatch(msg) {
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === false) p.reject(new Error(msg.error || "Errore dal Nucleo"));
      else p.resolve(msg);
      return;
    }
    if (typeof msg.event === "string") {
      if (msg.event === "system.pressure" && (msg.memoryPressure || msg.thermal) && this._lastStats) {
        this._lastStats = { ...this._lastStats, memoryPressure: msg.memoryPressure ?? this._lastStats.memoryPressure, thermal: msg.thermal ?? this._lastStats.thermal };
      }
      this.emit(msg.event, msg);
      this.emit("event", msg);
      return;
    }
    if (msg.log) this.emit("log", msg.log);
  }
  onExit() {
    this.proc = void 0;
    this._available = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Il Nucleo si e' chiuso prima di rispondere."));
    }
    this.pending.clear();
    clearInterval(this.statsTimer);
    this.emit("down");
    this.scheduleRestart();
  }
  scheduleRestart() {
    if (this.stopped) return;
    clearTimeout(this.restartTimer);
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 3e4);
    this.restartTimer = setTimeout(() => this.spawnProc(), wait);
  }
  /** Richiesta con id e timeout. Se il Nucleo non c'e', rifiuta con un messaggio chiaro. */
  request(cmd, args = {}, timeoutMs = 15e3) {
    if (!this.proc || !this.proc.stdin?.writable) {
      return Promise.reject(new Error("Il Nucleo nativo non e' disponibile adesso."));
    }
    const id = this.nextId++;
    const line = JSON.stringify({ id, cmd, ...args }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Il Nucleo non ha risposto a "${cmd}" in tempo.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(line);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("Non riesco a scrivere al Nucleo."));
      }
    });
  }
  /** Comando a cui non interessa la risposta: se il Nucleo manca, si ignora in silenzio. */
  fireAndForget(cmd, args = {}) {
    this.request(cmd, args, 8e3).catch(() => void 0);
  }
  dispose() {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    clearInterval(this.statsTimer);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Bottega in chiusura."));
    }
    this.pending.clear();
    try {
      this.proc?.kill();
    } catch {
    }
    this.proc = void 0;
    this._available = false;
  }
}
function parseHotkey(hotkey) {
  const parts = hotkey.toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
  const mods = /* @__PURE__ */ new Set(["option", "alt", "cmd", "command", "ctrl", "control", "shift"]);
  const modifiers = [];
  let key = "space";
  for (const p of parts) {
    if (mods.has(p)) {
      modifiers.push(p === "alt" ? "option" : p === "command" ? "cmd" : p === "control" ? "ctrl" : p);
    } else {
      key = p;
    }
  }
  return { key, modifiers: modifiers.length ? modifiers : ["option"] };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Nucleo,
  parseHotkey,
  resolveNucleoPath
});
