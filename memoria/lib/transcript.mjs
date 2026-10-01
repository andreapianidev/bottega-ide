// Lettura delle trascrizioni di Claude Code (~/.claude/projects/<cartella>/<sessione>.jsonl) e
// riduzione a un testo breve da riassumere: richieste, risposte, strumenti con i percorsi.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './paths.mjs';
import { redact, clip, cleanPrompt } from './redact.mjs';
import { tilde } from './hook.mjs';

export const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const MAX_READ = 40 * 1024 * 1024;

export function findTranscript(sessionId) {
	let dirs = [];
	try {
		dirs = fs.readdirSync(PROJECTS_DIR);
	} catch {
		return undefined;
	}
	for (const d of dirs) {
		const f = path.join(PROJECTS_DIR, d, `${sessionId}.jsonl`);
		if (fs.existsSync(f)) return f;
	}
	return undefined;
}

/** Tutte le trascrizioni principali (non quelle dei sotto-agenti) piu' recenti di `sinceMs`. */
export function listTranscripts(sinceMs) {
	const out = [];
	let dirs = [];
	try {
		dirs = fs.readdirSync(PROJECTS_DIR);
	} catch {
		return out;
	}
	for (const d of dirs) {
		let files = [];
		try {
			files = fs.readdirSync(path.join(PROJECTS_DIR, d)).filter(f => f.endsWith('.jsonl'));
		} catch {
			continue;
		}
		for (const f of files) {
			const file = path.join(PROJECTS_DIR, d, f);
			try {
				const st = fs.statSync(file);
				if (st.mtimeMs >= sinceMs) out.push({ file, sessionId: f.slice(0, -6), mtime: st.mtimeMs, size: st.size });
			} catch {
				// sparito nel frattempo
			}
		}
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

function readText(file) {
	const st = fs.statSync(file);
	if (st.size <= MAX_READ) return fs.readFileSync(file, 'utf8');
	// Trascrizione enorme: inizio e fine bastano per capire cosa e' successo.
	const fd = fs.openSync(file, 'r');
	try {
		const head = Buffer.alloc(2 * 1024 * 1024);
		const tail = Buffer.alloc(MAX_READ - head.length);
		fs.readSync(fd, head, 0, head.length, 0);
		fs.readSync(fd, tail, 0, tail.length, st.size - tail.length);
		return head.toString('utf8') + '\n' + tail.toString('utf8');
	} finally {
		fs.closeSync(fd);
	}
}

function toolLine(name, input = {}) {
	const p = input.file_path || input.notebook_path;
	if (p) return `> ${name} ${tilde(p)}`;
	if (name === 'Bash') return `> Bash: ${clip(input.description || input.command, 140)}`;
	if (name === 'Grep' || name === 'Glob') return `> ${name} ${clip(input.pattern, 80)}`;
	if (name === 'Task' || name === 'Agent') return `> Agente: ${clip(input.description || input.prompt, 120)}`;
	if (name === 'WebFetch') return `> WebFetch ${clip(input.url, 120)}`;
	if (name === 'WebSearch') return `> WebSearch ${clip(input.query, 120)}`;
	if (name === 'TodoWrite' || name === 'ToolSearch') return '';
	return `> ${name}`;
}

/**
 * Analizza una trascrizione. `text` e' gia' ripulito dalle chiavi e tagliato a `maxChars`,
 * tenendo la prima richiesta e la parte finale della sessione.
 */
export function parseTranscript(file, { maxChars = 12_000 } = {}) {
	const raw = readText(file);
	const out = {
		sessionId: path.basename(file, '.jsonl'),
		cwd: undefined,
		title: undefined,
		firstPrompt: undefined,
		prompts: 0,
		tools: 0,
		startedAt: undefined,
		lastAt: undefined,
		touched: [],
		edited: [],
		text: '',
	};
	const touched = new Set();
	const edited = new Set();
	const lines = [];
	let lastTool = '';
	for (const l of raw.split('\n')) {
		if (!l || l[0] !== '{') continue;
		let d;
		try {
			d = JSON.parse(l);
		} catch {
			continue;
		}
		if (d.type === 'ai-title' && d.aiTitle) out.title = d.aiTitle;
		if (d.type !== 'user' && d.type !== 'assistant') continue;
		if (d.isSidechain) continue;
		if (d.cwd && !out.cwd) out.cwd = d.cwd;
		if (d.cwd && touched.size < 2000) touched.add(d.cwd);
		const at = d.timestamp ? Date.parse(d.timestamp) : undefined;
		if (at) {
			out.startedAt ??= at;
			out.lastAt = at;
		}
		const c = d.message?.content;
		if (d.type === 'user') {
			if (d.isMeta) continue;
			if (d.isCompactSummary) {
				lines.push(`RIASSUNTO DELLA PARTE PRECEDENTE: ${clip(String(c), 1800)}`);
				continue;
			}
			const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter(p => p?.type === 'text').map(p => p.text) : [];
			for (const t of texts) {
				const p = cleanPrompt(t);
				if (!p) continue;
				out.prompts++;
				out.firstPrompt ??= clip(p, 300);
				lines.push(`UTENTE: ${clip(p, 1500)}`);
				lastTool = '';
			}
			continue;
		}
		if (!Array.isArray(c)) continue;
		for (const part of c) {
			if (part?.type === 'text' && part.text?.trim()) {
				lines.push(`CLAUDE: ${clip(part.text, 700)}`);
				lastTool = '';
			} else if (part?.type === 'tool_use') {
				out.tools++;
				const input = part.input || {};
				const fp = input.file_path || input.notebook_path;
				if (fp && touched.size < 2000) touched.add(fp);
				if (fp && /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(part.name)) edited.add(fp);
				const tl = toolLine(part.name, input);
				if (tl && tl !== lastTool) lines.push(tl);
				lastTool = tl;
			}
		}
	}
	out.touched = [...touched];
	out.edited = [...edited];
	out.title = out.title || out.firstPrompt?.slice(0, 80);
	out.text = trim(redact(lines.join('\n')), maxChars);
	return out;
}

/** Tiene l'inizio (la prima richiesta) e la fine della sessione, che e' la parte che conta di piu'. */
export function trim(text, maxChars) {
	if (text.length <= maxChars) return text;
	const headLen = Math.min(1800, Math.floor(maxChars * 0.15));
	const head = text.slice(0, headLen);
	const tail = text.slice(text.length - (maxChars - headLen - 40));
	return `${head}\n[... parte centrale omessa ...]\n${tail.slice(tail.indexOf('\n') + 1)}`;
}
