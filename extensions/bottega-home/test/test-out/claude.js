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
var claude_exports = {};
__export(claude_exports, {
  SESSIONS_DIR: () => SESSIONS_DIR,
  readLiveSessions: () => readLiveSessions,
  readPastSessions: () => readPastSessions
});
module.exports = __toCommonJS(claude_exports);
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SESSIONS_DIR = path.join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}
function readLiveSessions() {
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
      if (!d.pid || !alive(d.pid)) {
        continue;
      }
      out.push({
        pid: d.pid,
        sessionId: d.sessionId,
        cwd: d.cwd,
        name: d.name ?? "",
        status: d.status ?? "idle",
        startedAt: d.startedAt ?? 0,
        statusSince: d.statusUpdatedAt ?? d.updatedAt ?? d.startedAt ?? 0
      });
    } catch {
    }
  }
  return out.sort((a, b) => b.statusSince - a.statusSince);
}
function readHead(file, bytes) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
function readTail(file, bytes, size) {
  const fd = fs.openSync(file, "r");
  try {
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, size));
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
function firstUserText(head) {
  for (const line of head.split("\n")) {
    if (!line.includes('"type":"user"')) {
      continue;
    }
    try {
      const d = JSON.parse(line);
      const c = d?.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.find((p) => p?.type === "text")?.text : void 0;
      if (text && !text.startsWith("<")) {
        return text.replace(/\s+/g, " ").slice(0, 90);
      }
    } catch {
    }
  }
  return void 0;
}
const cache = /* @__PURE__ */ new Map();
function readPastSessions(maxAgeDays = 45) {
  const cutoff = Date.now() - maxAgeDays * 864e5;
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return [];
  }
  for (const dir of dirs) {
    const full = path.join(PROJECTS_DIR, dir);
    let files;
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(full, f);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff || st.size < 200) {
        continue;
      }
      const hit = cache.get(file);
      if (hit && hit.mtime === st.mtimeMs) {
        out.push(hit.session);
        continue;
      }
      try {
        const head = readHead(file, 96 * 1024);
        const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
        if (!cwd) {
          continue;
        }
        const tail = readTail(file, 256 * 1024, st.size);
        const titles = [...(tail + head).matchAll(/"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g)];
        const title = titles.length ? JSON.parse(`"${titles[titles.length - 1][1]}"`) : firstUserText(head) ?? "Sessione senza titolo";
        const touched = /* @__PURE__ */ new Set();
        for (const m of (head + tail).matchAll(/"(?:cwd|file_path|notebook_path)":"(\/(?:[^"\\]|\\.)*)"/g)) {
          if (touched.size >= 400) break;
          touched.add(m[1]);
        }
        const session = {
          sessionId: f.replace(/\.jsonl$/, ""),
          cwd: JSON.parse(`"${cwd}"`),
          title,
          mtime: st.mtimeMs,
          touched: [...touched]
        };
        cache.set(file, { mtime: st.mtimeMs, session });
        out.push(session);
      } catch {
        continue;
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SESSIONS_DIR,
  readLiveSessions,
  readPastSessions
});
