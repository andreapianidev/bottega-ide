// Percorsi, configurazione e attribuzione dei progetti.
// Questo modulo e' caricato anche dagli hook: solo fs/path/os, niente database, niente lavoro pesante.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();
export const BOTTEGA_HOME = process.env.BOTTEGA_HOME || path.join(HOME, '.bottega');
export const MEM_DIR = path.join(BOTTEGA_HOME, 'memoria');
export const SPOOL_DIR = path.join(MEM_DIR, 'spool');
export const CONTEXT_DIR = path.join(MEM_DIR, 'contesto');
export const BOARD_DIR = path.join(MEM_DIR, 'bacheca');
export const BOARD_SESSIONS_DIR = path.join(BOARD_DIR, 'sessioni');
export const DB_PATH = path.join(MEM_DIR, 'memoria.db');
export const LOG_PATH = path.join(MEM_DIR, 'memoria.log');
export const LOCK_PATH = path.join(MEM_DIR, 'worker.lock');
export const CONFIG_PATH = path.join(MEM_DIR, 'config.json');

/** Cartella dell'app (quella che contiene cli.mjs), da qualunque modulo di lib/ o hooks/. */
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_PATH = path.join(APP_DIR, 'cli.mjs');

export const DEFAULT_ROOTS = [
	'~/prototipi',
	'~/Library/Mobile Documents/com~apple~CloudDocs/Prototipi',
	'~/Library/Mobile Documents/com~apple~CloudDocs/Avo Agency',
	'~/Library/Mobile Documents/com~apple~CloudDocs/Progetti xCode',
];
export const DEFAULT_IGNORE = ['^_', '^\\.', 'backup', 'node_modules'];

export function expand(p) {
	return p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;
}

export function ensureDir(dir) {
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch {
		// esiste gia' o non si puo' creare: chi scrive dopo se ne accorge
	}
}

let cfgCache;
export function config() {
	if (cfgCache) return cfgCache;
	let user = {};
	try {
		user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
	} catch {
		// nessuna configurazione: valori predefiniti
	}
	cfgCache = {
		roots: (Array.isArray(user.roots) && user.roots.length ? user.roots : DEFAULT_ROOTS).map(expand),
		ignore: (Array.isArray(user.ignore) ? user.ignore : DEFAULT_IGNORE).map(s => new RegExp(s, 'i')),
	};
	return cfgCache;
}

const norm = p => String(p || '').toLowerCase().replace(/\/+$/, '');

/** FNV-1a a 32 bit, in esadecimale: basta per distinguere due cartelle con lo stesso nome. */
function fnv(s) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

export function projectKey(name, projectPath) {
	if (!projectPath || name === 'home') return 'home';
	const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'progetto';
	return `${slug}-${fnv(norm(projectPath))}`;
}

/**
 * Progetto che contiene un percorso: la sottocartella diretta di una delle radici.
 * Ritorna undefined per la home, per una radice stessa e per tutto cio' che sta fuori.
 */
export function projectOf(p) {
	if (!p || typeof p !== 'string' || !p.startsWith('/')) return undefined;
	const target = norm(p) + '/';
	const { roots, ignore } = config();
	for (const r of roots) {
		const rk = norm(r) + '/';
		if (!target.startsWith(rk)) continue;
		const rest = p.slice(rk.length).split('/').filter(Boolean);
		if (!rest.length) return undefined;
		const name = rest[0];
		if (ignore.some(re => re.test(name))) return undefined;
		// Le maiuscole come le ha scritte chi chiama (il disco non le distingue), la chiave senza.
		const projectPath = p.slice(0, rk.length) + name;
		return { name, path: projectPath, key: projectKey(name, projectPath) };
	}
	return undefined;
}

export const HOME_PROJECT = { name: 'home', path: HOME, key: 'home' };

/**
 * Attribuzione di una sessione, come fa scan.ts nella plancia: la cartella di partenza se sta in un
 * progetto, altrimenti il progetto in cui ha toccato piu' file (almeno due), altrimenti "home".
 */
export function attribute(cwd, touched = []) {
	const start = projectOf(cwd);
	if (start) return start;
	const hits = new Map();
	for (const t of touched) {
		const p = projectOf(t);
		if (!p) continue;
		const h = hits.get(p.key) || { p, n: 0 };
		h.n++;
		hits.set(p.key, h);
	}
	const best = [...hits.values()].sort((a, b) => b.n - a.n)[0];
	if (best && best.n >= 2) return best.p;
	return HOME_PROJECT;
}

/** Elenco dei progetti sotto le radici (per riconoscere un progetto nominato in un prompt). */
export function listProjects() {
	const out = [];
	const { roots, ignore } = config();
	for (const r of roots) {
		let names = [];
		try {
			names = fs.readdirSync(r, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
		} catch {
			continue;
		}
		for (const name of names) {
			if (ignore.some(re => re.test(name))) continue;
			const projectPath = path.join(r, name);
			out.push({ name, path: projectPath, key: projectKey(name, projectPath) });
		}
	}
	return out;
}

export function today(ts = Date.now()) {
	const d = new Date(ts);
	const pad = n => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function log(msg) {
	try {
		ensureDir(MEM_DIR);
		const line = `${new Date().toISOString()} [${process.pid}] ${msg}\n`;
		fs.appendFileSync(LOG_PATH, line, { mode: 0o600 });
		const st = fs.statSync(LOG_PATH);
		if (st.size > 2_000_000) {
			const tail = fs.readFileSync(LOG_PATH, 'utf8').slice(-500_000);
			fs.writeFileSync(LOG_PATH, tail, { mode: 0o600 });
		}
	} catch {
		// il log non deve mai far fallire niente
	}
}
