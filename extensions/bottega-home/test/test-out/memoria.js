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
var memoria_exports = {};
__export(memoria_exports, {
  Memoria: () => Memoria,
  resolveMemoriaDir: () => resolveMemoriaDir
});
module.exports = __toCommonJS(memoria_exports);
var import_child_process = require("child_process");
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var vscode = __toESM(require("vscode"));
const HOME = os.homedir();
function resolveMemoriaDir(extensionPath) {
  const candidates = [
    path.join(extensionPath, "memoria"),
    path.join(HOME, ".bottega", "memoria-app"),
    path.join(HOME, "prototipi", "Bottega", "memoria")
  ];
  for (const d of candidates) {
    if (fs.existsSync(path.join(d, "cli.mjs"))) return d;
  }
  return void 0;
}
let nodeCache;
function resolveNode() {
  if (nodeCache) return nodeCache;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = path.join(dir, "node");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      nodeCache = p;
      return p;
    } catch {
    }
  }
  const guesses = [
    path.join(HOME, ".nvm", "versions", "node")
  ];
  for (const base of guesses) {
    try {
      const versions = fs.readdirSync(base).filter((v) => v.startsWith("v")).sort().reverse();
      for (const v of versions) {
        const p = path.join(base, v, "bin", "node");
        if (fs.existsSync(p)) {
          nodeCache = p;
          return p;
        }
      }
    } catch {
    }
  }
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
    if (fs.existsSync(p)) {
      nodeCache = p;
      return p;
    }
  }
  nodeCache = "node";
  return nodeCache;
}
class Memoria {
  constructor(extensionPath) {
    this.extensionPath = extensionPath;
    this.dir = resolveMemoriaDir(extensionPath);
  }
  dir;
  get available() {
    this.dir ??= resolveMemoriaDir(this.extensionPath);
    return !!this.dir;
  }
  cli() {
    this.dir ??= resolveMemoriaDir(this.extensionPath);
    return this.dir ? path.join(this.dir, "cli.mjs") : void 0;
  }
  run(args, timeoutMs = 1e4) {
    const cli = this.cli();
    if (!cli) return Promise.reject(new Error("La Memoria non e' installata."));
    return new Promise((resolve, reject) => {
      (0, import_child_process.execFile)(resolveNode(), [cli, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || "Errore della Memoria").trim()));
        resolve(stdout);
      });
    });
  }
  async runJson(args, fallback) {
    if (!this.available) return fallback;
    try {
      const out = await this.run([...args, "--json"]);
      return JSON.parse(out);
    } catch {
      return fallback;
    }
  }
  static items(raw) {
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : Array.isArray(raw?.items) ? raw.items : [];
    return arr;
  }
  async search(query, project) {
    const args = ["search", query];
    if (project) args.push("--progetto", project);
    return Memoria.items(await this.runJson(args, []));
  }
  async recent(project) {
    const args = ["recent"];
    if (project) args.push("--progetto", project);
    return Memoria.items(await this.runJson(args, []));
  }
  async bacheca(project, minutes = 30) {
    const args = ["bacheca", "--minuti", String(minutes)];
    if (project) args.push("--progetto", project);
    return Memoria.items(await this.runJson(args, []));
  }
  async remember(text, project) {
    if (!this.available) return false;
    const args = ["remember", text];
    if (project) args.push("--progetto", project);
    try {
      await this.run(args);
      return true;
    } catch {
      return false;
    }
  }
  /** Installa gli hook di Claude Code e il server MCP, dopo conferma modale. */
  async install() {
    if (!this.available) {
      vscode.window.showWarningMessage("Non trovo la Memoria da installare: manca cli.mjs. Controlla la cartella memoria della Bottega.");
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      "Attivo la memoria per Claude Code. Modifico ~/.claude/settings.json per registrare gli hook e un server MCP, dopo averne salvato una copia di sicurezza. Procedo?",
      { modal: true, detail: "Gli hook esistenti restano: nulla di tuo viene rimosso. L'app della memoria va in ~/.bottega/memoria-app." },
      "Attiva"
    );
    if (ok !== "Attiva") return;
    const appDir = path.join(HOME, ".bottega", "memoria-app");
    try {
      await this.run(["install", "--app-dir", appDir], 6e4);
      vscode.window.showInformationMessage("Memoria attivata per Claude Code.");
    } catch (e) {
      vscode.window.showErrorMessage(`Non riesco ad attivare la memoria: ${e?.message ?? e}`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Memoria,
  resolveMemoriaDir
});
