// La bacheca: cosa stanno facendo adesso le sessioni Claude, progetto per progetto.
// File piccoli, solo append, letti dagli hook: niente database.
import fs from 'node:fs';
import path from 'node:path';
import { BOARD_DIR, BOARD_SESSIONS_DIR, ensureDir, projectOf, listProjects } from './paths.mjs';
import { clip } from './redact.mjs';
import { tilde } from './hook.mjs';

const MAX_BYTES = 120_000; // circa 400 righe
const KEEP_LINES = 200;

const safe = s => String(s || '').replace(/[^A-Za-z0-9_.-]/g, '_');
const boardFile = key => path.join(BOARD_DIR, `${safe(key)}.jsonl`);
const sessionFile = sid => path.join(BOARD_SESSIONS_DIR, `${safe(sid)}.json`);

export function readSessionInfo(sid) {
	try {
		return JSON.parse(fs.readFileSync(sessionFile(sid), 'utf8'));
	} catch {
		return undefined;
	}
}

/** Ricorda a quale progetto sta lavorando una sessione e con quale prima richiesta. */
export function writeSessionInfo(sid, patch) {
	if (!sid) return;
	const cur = readSessionInfo(sid) || {};
	const next = { ...cur, ...patch, at: Date.now() };
	if (cur.key === next.key && cur.title === next.title && cur.at && Date.now() - cur.at < 60_000) return;
	ensureDir(BOARD_SESSIONS_DIR);
	fs.writeFileSync(sessionFile(sid), JSON.stringify(next), { mode: 0o600 });
}

/** Progetto di un evento: cartella di lavoro, poi file toccato, poi quello gia' noto per la sessione. */
export function boardProject({ sid, cwd, files = [], prompt }) {
	const fromCwd = projectOf(cwd);
	if (fromCwd) return { ...fromCwd, how: 'cwd' };
	for (const f of files) {
		const p = projectOf(f);
		if (p) return { ...p, how: 'file' };
	}
	const known = readSessionInfo(sid);
	if (known?.key && known.key !== 'home') return { name: known.name, path: known.path, key: known.key, how: 'sessione' };
	if (prompt) {
		// Una sessione partita dalla home che nomina un progetto nella richiesta.
		const text = prompt.toLowerCase();
		const hit = listProjects()
			.filter(p => p.name.length >= 4)
			.sort((a, b) => b.name.length - a.name.length)
			.find(p => new RegExp(`(^|[^a-z0-9])${p.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text));
		if (hit) return { ...hit, how: 'nome' };
	}
	return undefined;
}

export function rel(file, projectPath) {
	if (!file) return '';
	if (projectPath && file.toLowerCase().startsWith(projectPath.toLowerCase() + '/')) return file.slice(projectPath.length + 1);
	return tilde(file);
}

export function appendBoard(project, entry) {
	ensureDir(BOARD_DIR);
	const file = boardFile(project.key);
	const line = JSON.stringify({ at: Date.now(), project: project.name, ...entry }) + '\n';
	fs.appendFileSync(file, line, { mode: 0o600 });
	try {
		if (fs.statSync(file).size > MAX_BYTES) {
			const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-KEEP_LINES);
			const tmp = `${file}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
			fs.renameSync(tmp, file);
		}
	} catch {
		// un altro processo ha appena riscritto il file: va bene lo stesso
	}
}

export function readBoard(key, sinceMs) {
	let raw = '';
	try {
		raw = fs.readFileSync(boardFile(key), 'utf8');
	} catch {
		return [];
	}
	const out = [];
	for (const l of raw.split('\n')) {
		if (!l) continue;
		try {
			const e = JSON.parse(l);
			if (!sinceMs || e.at >= sinceMs) out.push({ ...e, key });
		} catch {
			// riga a meta'
		}
	}
	return out;
}

/** Tutte le bacheche toccate dopo `sinceMs` (per la home e per lo strumento MCP). */
export function readAllBoards(sinceMs) {
	let names = [];
	try {
		names = fs.readdirSync(BOARD_DIR).filter(n => n.endsWith('.jsonl'));
	} catch {
		return [];
	}
	const out = [];
	for (const n of names) {
		try {
			if (fs.statSync(path.join(BOARD_DIR, n)).mtimeMs < sinceMs) continue;
		} catch {
			continue;
		}
		out.push(...readBoard(n.slice(0, -6), sinceMs));
	}
	return out.sort((a, b) => a.at - b.at);
}

export function ago(ms) {
	const m = Math.round(ms / 60_000);
	if (m < 1) return 'meno di un minuto fa';
	if (m === 1) return '1 min fa';
	if (m < 60) return `${m} min fa`;
	const h = Math.round(m / 60);
	return h === 1 ? "un'ora fa" : `${h} ore fa`;
}

function sessionLabel(sid) {
	const info = readSessionInfo(sid);
	const short = String(sid || '').slice(0, 8);
	return info?.title ? `"${clip(info.title, 40)}" (${short})` : `la sessione ${short}`;
}

/** Raggruppa le voci per sessione, la piu' recente prima. */
function bySession(entries) {
	const map = new Map();
	for (const e of entries) {
		const s = map.get(e.sessionId) || { sid: e.sessionId, last: 0, edits: [], bash: [], prompts: [], reads: 0 };
		s.last = Math.max(s.last, e.at);
		if (e.kind === 'edit' || e.kind === 'write') {
			if (e.rel && !s.edits.includes(e.rel)) s.edits.push(e.rel);
		} else if (e.kind === 'bash') s.bash.push(e.cmd || e.summary);
		else if (e.kind === 'prompt') s.prompts.push(e.text || e.summary);
		else if (e.kind === 'read') s.reads++;
		map.set(e.sessionId, s);
	}
	return [...map.values()].sort((a, b) => b.last - a.last);
}

function describe(s, now) {
	const parts = [];
	if (s.edits.length) parts.push(`ha modificato ${s.edits.slice(-4).join(', ')}${s.edits.length > 4 ? ` e altri ${s.edits.length - 4}` : ''}`);
	if (s.bash.length) parts.push(`ha lanciato ${clip(s.bash[s.bash.length - 1], 70)}`);
	if (s.prompts.length) parts.push(`ultima richiesta: "${clip(s.prompts[s.prompts.length - 1], 90)}"`);
	if (!parts.length && s.reads) parts.push(`sta leggendo il codice (${s.reads} file)`);
	return `${sessionLabel(s.sid)}, ${ago(now - s.last)}: ${parts.join('; ') || 'attiva'}`;
}

/**
 * Riassunto per UserPromptSubmit: cosa hanno fatto le ALTRE sessioni sullo stesso progetto
 * negli ultimi 30 minuti, piu' un avviso se toccano un file citato nella richiesta.
 */
export function digest({ project, sid, prompt = '', minutes = 30, max = 800 }) {
	const now = Date.now();
	const others = readBoard(project.key, now - minutes * 60_000).filter(e => e.sessionId && e.sessionId !== sid);
	if (!others.length) return '';
	const lines = [];
	const text = prompt.toLowerCase();
	for (const e of others) {
		if ((e.kind !== 'edit' && e.kind !== 'write') || now - e.at > 10 * 60_000 || !e.rel) continue;
		const base = path.basename(e.rel).toLowerCase();
		if (base.length >= 4 && (text.includes(e.rel.toLowerCase()) || text.includes(base))) {
			const w = `Attenzione: ${sessionLabel(e.sessionId)} ha modificato ${e.rel} ${ago(now - e.at)}, e la tua richiesta lo cita. Rileggilo prima di cambiarlo.`;
			if (!lines.includes(w)) lines.push(w);
		}
	}
	const head = `Nel frattempo, su ${project.name}, altre sessioni Claude stanno lavorando:`;
	const body = bySession(others).slice(0, 4).map(s => `- ${describe(s, now)}`);
	let out = [...lines.slice(0, 2), head, ...body].join('\n');
	const tail = '\nDettagli con lo strumento memoria_bacheca.';
	if (out.length + tail.length > max) out = out.slice(0, max - tail.length - 1) + '…';
	return out + tail;
}

/** Una riga per SessionStart: chi lavora adesso sullo stesso progetto (o ovunque, dalla home). */
export function activeLine({ project, sid, minutes = 30 }) {
	const now = Date.now();
	const since = now - minutes * 60_000;
	if (project && project.key !== 'home') {
		const sessions = bySession(readBoard(project.key, since).filter(e => e.sessionId && e.sessionId !== sid));
		if (!sessions.length) return '';
		return `Sessioni attive adesso su ${project.name}: ${sessions
			.slice(0, 3)
			.map(s => describe(s, now))
			.join(' | ')}`.slice(0, 600);
	}
	const all = readAllBoards(since).filter(e => e.sessionId !== sid);
	if (!all.length) return '';
	const per = new Map();
	for (const e of all) {
		const p = per.get(e.project) || new Set();
		p.add(e.sessionId);
		per.set(e.project, p);
	}
	return `Sessioni Claude attive adesso sul Mac: ${[...per].map(([p, s]) => `${p} (${s.size})`).join(', ')}. Dettagli con memoria_bacheca.`;
}

/** Avviso per PostToolUse: questo file l'ha appena toccato un'altra sessione. */
export function conflictNote({ project, sid, file }) {
	if (!file) return '';
	const now = Date.now();
	const hits = readBoard(project.key, now - 10 * 60_000).filter(
		e => e.sessionId !== sid && (e.kind === 'edit' || e.kind === 'write') && e.file === file,
	);
	if (!hits.length) return '';
	const last = hits[hits.length - 1];
	return `Attenzione: anche ${sessionLabel(last.sessionId)} ha modificato ${rel(file, project.path)} ${ago(now - last.at)}. Controlla di non sovrascrivere il suo lavoro.`;
}
