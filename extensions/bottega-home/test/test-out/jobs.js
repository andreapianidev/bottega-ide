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
var jobs_exports = {};
__export(jobs_exports, {
  JobManager: () => JobManager,
  computeLimit: () => computeLimit,
  limitReason: () => limitReason,
  shellQuote: () => shellQuote
});
module.exports = __toCommonJS(jobs_exports);
var import_child_process = require("child_process");
var path = __toESM(require("path"));
var vscode = __toESM(require("vscode"));
const GLOBAL_KEY = "bottega.jobs";
const active = /* @__PURE__ */ new Set(["in coda", "in corso", "ti aspetta"]);
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
function computeLimit(setting, stats) {
  if (typeof setting === "number" && Number.isFinite(setting)) return Math.max(1, Math.floor(setting));
  if (typeof setting === "string" && setting !== "auto") {
    const n = parseInt(setting, 10);
    if (!Number.isNaN(n)) return Math.max(1, n);
  }
  if (!stats) return 3;
  const p = stats.memoryPressure;
  const t = stats.thermal;
  if (p === "critical" || t === "critical") return 1;
  if (p === "warning" || t === "serious") return 2;
  return 3;
}
function limitReason(setting, stats) {
  if (typeof setting === "number" && Number.isFinite(setting)) return "limite fisso";
  if (typeof setting === "string" && setting !== "auto" && !Number.isNaN(parseInt(setting, 10))) return "limite fisso";
  if (!stats) return "valori predefiniti";
  if (stats.memoryPressure === "critical" || stats.thermal === "critical") return "Mac sotto sforzo";
  if (stats.memoryPressure === "warning") return "memoria sotto pressione";
  if (stats.thermal === "serious") return "Mac caldo";
  return "memoria tranquilla";
}
function defaultPpidOf(pid) {
  return new Promise((resolve) => {
    (0, import_child_process.execFile)("ps", ["-o", "ppid=", "-p", String(pid)], { timeout: 4e3 }, (err, stdout) => {
      if (err) return resolve(void 0);
      const n = parseInt(stdout.trim(), 10);
      resolve(Number.isNaN(n) ? void 0 : n);
    });
  });
}
const norm = (p) => p.toLowerCase().replace(/\/+$/, "");
class JobManager {
  constructor(ctx, deps) {
    this.ctx = ctx;
    this.deps = deps;
    if (!this.deps.ppidOf) {
      this.deps.ppidOf = defaultPpidOf;
    }
    this.restore();
  }
  jobs = [];
  terminals = /* @__PURE__ */ new Map();
  shellPids = /* @__PURE__ */ new Map();
  /** Chi era occupato almeno una volta: serve per il passaggio busy -> "ti aspetta". */
  wasBusy = /* @__PURE__ */ new Set();
  ppidCache = /* @__PURE__ */ new Map();
  notified = /* @__PURE__ */ new Set();
  seq = 0;
  list() {
    return this.jobs.map((j) => ({ ...j }));
  }
  persist() {
    const data = {
      jobs: this.jobs,
      shellPids: Object.fromEntries(this.shellPids),
      wasBusy: [...this.wasBusy]
    };
    void this.ctx.globalState.update(GLOBAL_KEY, data);
  }
  changed() {
    this.persist();
    this.deps.onChange();
    this.paintMenubar();
  }
  paintMenubar() {
    const busy = this.jobs.filter((j) => j.status === "in corso").length;
    const waiting = this.jobs.filter((j) => j.status === "ti aspetta").length;
    const queued = this.jobs.filter((j) => j.status === "in coda").length;
    this.deps.updateMenubar({ busy, waiting, queued });
  }
  restore() {
    const data = this.ctx.globalState.get(GLOBAL_KEY);
    if (!data || !Array.isArray(data.jobs)) return;
    this.jobs = data.jobs;
    for (const [k, v] of Object.entries(data.shellPids ?? {})) this.shellPids.set(k, v);
    for (const id of data.wasBusy ?? []) this.wasBusy.add(id);
    const maxSeq = this.jobs.reduce((m, j) => Math.max(m, parseInt(j.id.split("-")[1] || "0", 10) || 0), 0);
    this.seq = maxSeq;
    void this.reattach();
  }
  async reattach() {
    const terms = vscode.window.terminals;
    const pids = await Promise.all(terms.map(async (t) => [t, await t.processId]));
    for (const job of this.jobs) {
      if (!active.has(job.status)) continue;
      if (job.status === "in coda") continue;
      const shellPid = this.shellPids.get(job.id);
      const hit = shellPid ? pids.find(([, p]) => p === shellPid) : void 0;
      if (hit) {
        this.terminals.set(job.id, hit[0]);
      } else {
        job.status = "finito";
        job.endedAt = job.endedAt ?? Date.now();
      }
    }
    this.changed();
    this.promote();
  }
  newId() {
    return `job-${++this.seq}`;
  }
  /** Avvia un lavoro (o lo mette in coda se non c'e' uno slot libero). */
  start(projectPath, task) {
    const job = {
      id: this.newId(),
      project: path.basename(projectPath) || "~",
      path: projectPath,
      task,
      status: "in coda",
      createdAt: Date.now()
    };
    this.jobs.unshift(job);
    this.changed();
    this.promote();
    return job;
  }
  runningCount() {
    return this.jobs.filter((j) => j.status === "in corso" || j.status === "ti aspetta").length;
  }
  /** Fa partire i lavori in coda finche' ci sono slot liberi. */
  promote() {
    const limit = computeLimit(this.deps.maxParallelSetting(), this.deps.systemStats());
    const queue = this.jobs.filter((j) => j.status === "in coda").sort((a, b) => a.createdAt - b.createdAt);
    for (const job of queue) {
      if (this.runningCount() >= limit) break;
      this.launch(job);
    }
    this.paintMenubar();
  }
  launch(job) {
    const cmd = this.deps.claudeCommand();
    const term = vscode.window.createTerminal({
      name: `Lavoro ${job.project}`,
      cwd: job.path,
      location: vscode.TerminalLocation.Editor,
      iconPath: new vscode.ThemeIcon("tools")
    });
    this.terminals.set(job.id, term);
    term.show();
    term.sendText(`${cmd} ${shellQuote(job.task)}`);
    job.status = "in corso";
    job.startedAt = Date.now();
    void term.processId.then((pid) => {
      if (typeof pid === "number") this.shellPids.set(job.id, pid);
      this.persist();
    });
    this.changed();
  }
  /** Riconcilia stato dei lavori con il registro delle sessioni vive. */
  async reconcile() {
    const live = this.deps.liveSessions();
    const claimed = new Set(this.jobs.map((j) => j.sessionId).filter(Boolean));
    let dirty = false;
    for (const job of this.jobs) {
      if (job.status !== "in corso" && job.status !== "ti aspetta") continue;
      if (!job.sessionId) {
        const match = await this.matchSession(job, live, claimed);
        if (match) {
          job.sessionId = match.sessionId;
          job.pid = match.pid;
          claimed.add(match.sessionId);
          dirty = true;
        }
      }
      const session = job.sessionId ? live.find((s) => s.sessionId === job.sessionId) : void 0;
      if (session) {
        job.lastActivity = session.statusSince || job.lastActivity;
        if (session.status === "busy") {
          this.wasBusy.add(job.id);
          if (job.status !== "in corso") {
            job.status = "in corso";
            this.notified.delete(job.id);
            dirty = true;
          }
        } else if (this.wasBusy.has(job.id) && job.status === "in corso") {
          job.status = "ti aspetta";
          dirty = true;
          this.announceWaiting(job);
        }
      }
    }
    if (dirty) this.changed();
  }
  async matchSession(job, live, claimed) {
    const shellPid = this.shellPids.get(job.id);
    if (shellPid) {
      for (const s of live) {
        if (claimed.has(s.sessionId)) continue;
        const ppid = await this.ppid(s.pid);
        if (ppid === shellPid) return s;
      }
    }
    const startedAfter = (job.startedAt ?? 0) - 2e3;
    const candidates = live.filter((s) => !claimed.has(s.sessionId) && norm(s.cwd) === norm(job.path) && (s.startedAt ?? 0) >= startedAfter).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    return candidates[0];
  }
  async ppid(pid) {
    if (this.ppidCache.has(pid)) return this.ppidCache.get(pid);
    const fn = this.deps.ppidOf ?? defaultPpidOf;
    const v = await fn(pid);
    this.ppidCache.set(pid, v);
    return v;
  }
  /** Da chiamare quando cambia la pressione del sistema: puo' liberare uno slot per la coda. */
  kick() {
    this.promote();
  }
  announceWaiting(job) {
    if (this.notified.has(job.id)) return;
    this.notified.add(job.id);
    this.deps.notify({
      id: `job:${job.id}`,
      title: `Il lavoro su ${job.project} ti aspetta`,
      body: job.task.length > 100 ? job.task.slice(0, 100) + "..." : job.task,
      actions: [{ id: "apri", title: "Apri" }]
    });
  }
  /** Scrive nel terminale di un lavoro (solo lavori della Bottega). Falso se non c'e'. */
  write(id, text) {
    const term = this.terminals.get(id);
    if (!term) return false;
    term.show();
    term.sendText(text);
    return true;
  }
  /** Trova un lavoro per id esatto o per nome progetto (preferendo quelli attivi). */
  resolve(idOrProject) {
    const exact = this.jobs.find((j) => j.id === idOrProject);
    if (exact) return exact;
    const key = idOrProject.toLowerCase();
    const byProject = this.jobs.filter((j) => j.project.toLowerCase() === key);
    return byProject.find((j) => active.has(j.status)) ?? byProject[0];
  }
  /** Chiamato quando l'utente clicca l'azione della notifica o "job.focus". */
  focus(id) {
    const term = this.terminals.get(id);
    if (term) {
      term.show();
    }
  }
  /** Terminale chiuso dall'utente: il lavoro e' finito. */
  onTerminalClosed(term) {
    for (const [id, t] of this.terminals) {
      if (t !== term) continue;
      const job = this.jobs.find((j) => j.id === id);
      if (job && active.has(job.status)) {
        job.status = "finito";
        job.endedAt = Date.now();
      }
      this.terminals.delete(id);
      this.changed();
      this.promote();
      return;
    }
  }
  /** Ferma un lavoro: chiude il terminale. La conferma la gestisce il chiamante. */
  stop(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return;
    const term = this.terminals.get(id);
    if (term) {
      try {
        term.dispose();
      } catch {
      }
      this.terminals.delete(id);
    }
    if (active.has(job.status)) {
      job.status = "fermato";
      job.endedAt = Date.now();
    }
    this.notified.delete(id);
    this.changed();
    this.promote();
  }
  /** Toglie dall'elenco un lavoro gia' terminato. */
  remove(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return;
    if (active.has(job.status)) this.stop(id);
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.shellPids.delete(id);
    this.wasBusy.delete(id);
    this.notified.delete(id);
    this.changed();
  }
  dispose() {
    this.persist();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  JobManager,
  computeLimit,
  limitReason,
  shellQuote
});
