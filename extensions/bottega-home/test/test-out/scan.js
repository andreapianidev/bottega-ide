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
var scan_exports = {};
__export(scan_exports, {
  expand: () => expand,
  scanProjects: () => scanProjects
});
module.exports = __toCommonJS(scan_exports);
var import_child_process = require("child_process");
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
function expand(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}
function run(cwd, args) {
  return new Promise((resolve) => {
    (0, import_child_process.execFile)("git", args, { cwd, timeout: 8e3, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : stdout));
  });
}
async function gitInfo(dir) {
  const status = await run(dir, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]);
  if (!status) {
    return void 0;
  }
  let branch = "?";
  let ahead = 0;
  let behind = 0;
  let upstream = false;
  let changes = 0;
  for (const line of status.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      branch = line.slice(14);
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = true;
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = +m[1];
        behind = +m[2];
      }
    } else if (line && !line.startsWith("#")) {
      changes++;
    }
  }
  const log = (await run(dir, ["log", "-1", "--format=%ct%x09%s"])).trim();
  const [ct, ...subj] = log.split("	");
  return { branch, ahead, behind, upstream, changes, lastCommitAt: (+ct || 0) * 1e3, lastCommitSubject: subj.join("	") };
}
function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
function detect(dir) {
  const top = list(dir);
  const kinds = /* @__PURE__ */ new Set();
  let xcodeProject;
  const look = (entries, base) => {
    for (const e of entries) {
      if (e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace")) {
        kinds.add("apple");
        if (!xcodeProject || e.endsWith(".xcworkspace")) {
          xcodeProject = path.join(base, e);
        }
      }
      if (e === "Package.swift") kinds.add("swiftpm");
      if (e === "package.json" || e === "next.config.js" || e === "next.config.ts" || e === "vite.config.ts" || e === "index.html") kinds.add("web");
      if (e === "build.gradle" || e === "build.gradle.kts" || e === "settings.gradle.kts") kinds.add("android");
      if (e === "pyproject.toml" || e === "requirements.txt") kinds.add("python");
    }
  };
  look(top, dir);
  if (!kinds.size) {
    for (const e of top) {
      if (e.startsWith(".") || e === "node_modules") continue;
      const sub = path.join(dir, e);
      try {
        if (fs.statSync(sub).isDirectory()) look(list(sub), sub);
      } catch {
      }
    }
  }
  if (!kinds.size && top.some((e) => e.endsWith(".md"))) kinds.add("docs");
  if (!kinds.size) kinds.add("altro");
  return { kinds: [...kinds], xcodeProject };
}
function readBuild(dir, xcodeProject) {
  if (xcodeProject) {
    const proj = xcodeProject.endsWith(".xcworkspace") ? list(path.dirname(xcodeProject)).filter((e) => e.endsWith(".xcodeproj")).map((e) => path.join(path.dirname(xcodeProject), e))[0] : xcodeProject;
    if (proj) {
      try {
        const pbx = fs.readFileSync(path.join(proj, "project.pbxproj"), "utf8");
        const number = /CURRENT_PROJECT_VERSION = ([^;]+);/.exec(pbx)?.[1]?.replace(/"/g, "");
        const marketing = /MARKETING_VERSION = ([^;]+);/.exec(pbx)?.[1]?.replace(/"/g, "");
        if (number || marketing) return { number, marketing, source: "xcode" };
      } catch {
      }
    }
  }
  for (const g of ["app/build.gradle.kts", "app/build.gradle"]) {
    try {
      const s = fs.readFileSync(path.join(dir, g), "utf8");
      const number = /versionCode\s*=?\s*(\d+)/.exec(s)?.[1];
      const marketing = /versionName\s*=?\s*"([^"]+)"/.exec(s)?.[1];
      if (number || marketing) return { number, marketing, source: "android" };
    } catch {
    }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    if (pkg.version) return { marketing: pkg.version, source: "npm" };
  } catch {
  }
  return void 0;
}
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}
const norm = (p) => p.toLowerCase().replace(/\/+$/, "");
async function scanProjects(roots, ignore, past, live) {
  const ignoreRe = ignore.map((s) => new RegExp(s, "i"));
  const seen = /* @__PURE__ */ new Set();
  const candidates = [];
  for (const r of roots.map(expand)) {
    for (const name of list(r)) {
      if (ignoreRe.some((re) => re.test(name))) continue;
      const p = path.join(r, name);
      try {
        if (!fs.statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      const key = norm(fs.realpathSync(p));
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ name, path: p, root: r });
    }
  }
  const keys = candidates.map((c) => norm(c.path) + "/");
  const owner = /* @__PURE__ */ new Map();
  for (const s of past) {
    const start = keys.find((k) => (norm(s.cwd) + "/").startsWith(k));
    if (start) {
      owner.set(s.sessionId, start);
      continue;
    }
    const hits = /* @__PURE__ */ new Map();
    for (const t of s.touched) {
      const k = keys.find((k2) => (norm(t) + "/").startsWith(k2));
      if (k) hits.set(k, (hits.get(k) ?? 0) + 1);
    }
    const best = [...hits].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 2) owner.set(s.sessionId, best[0]);
  }
  const projects = await pool(candidates, 6, async (c) => {
    const { kinds, xcodeProject } = detect(c.path);
    const git = await gitInfo(c.path);
    const key = norm(c.path) + "/";
    const sessions = past.filter((s) => owner.get(s.sessionId) === key);
    const liveHere = live.filter((s) => (norm(s.cwd) + "/").startsWith(key) || owner.get(s.sessionId) === key);
    let mtime = 0;
    try {
      mtime = fs.statSync(c.path).mtimeMs;
    } catch {
    }
    const project = {
      ...c,
      kinds,
      git,
      build: readBuild(c.path, xcodeProject),
      hasClaudeMd: fs.existsSync(path.join(c.path, "CLAUDE.md")),
      xcodeProject,
      sessions,
      live: liveHere,
      touchedAt: Math.max(git?.lastCommitAt ?? 0, sessions[0]?.mtime ?? 0, mtime)
    };
    return project;
  });
  return projects.sort((a, b) => b.touchedAt - a.touchedAt);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  expand,
  scanProjects
});
