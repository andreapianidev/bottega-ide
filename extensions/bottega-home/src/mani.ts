/* Le mani di Melissa: le sessioni Claude Code. Qui si legge cosa ha fatto una sessione dalla coda della sua
   trascrizione (~/.claude/projects/<cartella>/<sessione>.jsonl): l'ultima richiesta di Andrea, l'ultima risposta di
   Claude, gli strumenti usati e i file toccati. Solo lettura, solo la coda del file (al massimo 256 KB): costa poco
   anche su trascrizioni enormi. Melissa racconta solo quello che c'e' scritto. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SessionDigest {
	sessionId: string;
	file: string;
	at: number; // ultimo evento, ms
	lastPrompt?: string; // ultima cosa scritta da Andrea
	lastReply?: string; // ultimo testo di Claude
	tools: { name: string; n: number }[]; // strumenti usati nella coda, i piu' usati prima
	files: string[]; // file toccati (Edit, Write, Read), dal piu' recente
	waiting: boolean; // l'ultima parola e' di Claude: aspetta Andrea
}

const TAIL = 256 * 1024;
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

/** Il file della trascrizione di una sessione, cercato tra le cartelle dei progetti di Claude Code. */
export function transcriptOf(sessionId: string, root = PROJECTS): string | undefined {
	if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) return undefined;
	let dirs: string[] = [];
	try {
		dirs = fs.readdirSync(root);
	} catch {
		return undefined;
	}
	for (const d of dirs) {
		const f = path.join(root, d, sessionId + '.jsonl');
		if (fs.existsSync(f)) return f;
	}
	return undefined;
}

function tail(file: string): string {
	const fd = fs.openSync(file, 'r');
	try {
		const size = fs.fstatSync(fd).size;
		const start = Math.max(0, size - TAIL);
		const buf = Buffer.alloc(size - start);
		fs.readSync(fd, buf, 0, buf.length, start);
		const text = buf.toString('utf8');
		// la prima riga puo' essere tagliata a meta'
		return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
	} finally {
		fs.closeSync(fd);
	}
}

const isPrompt = (c: any) => {
	if (typeof c === 'string') return c.trim() && !c.startsWith('<') ? c : undefined;
	if (!Array.isArray(c) || c.some(p => p?.type === 'tool_result')) return undefined;
	const t = c.find((p: any) => p?.type === 'text')?.text;
	return typeof t === 'string' && t.trim() && !t.startsWith('<') ? t : undefined;
};

export function digest(sessionId: string, root = PROJECTS): SessionDigest | undefined {
	const file = transcriptOf(sessionId, root);
	if (!file) return undefined;
	let text: string;
	try {
		text = tail(file);
	} catch {
		return undefined;
	}
	const out: SessionDigest = { sessionId, file, at: 0, tools: [], files: [], waiting: false };
	const tools = new Map<string, number>();
	const files: string[] = [];
	let lastRole = '';
	for (const line of text.split('\n')) {
		if (!line.startsWith('{')) continue;
		let d: any;
		try {
			d = JSON.parse(line);
		} catch {
			continue;
		}
		if (d.type !== 'user' && d.type !== 'assistant') continue;
		const t = Date.parse(d.timestamp ?? '') || 0;
		if (t > out.at) out.at = t;
		const c = d.message?.content;
		if (d.type === 'user') {
			const p = !d.isMeta && !d.isCompactSummary ? isPrompt(c) : undefined;
			if (p) {
				out.lastPrompt = p;
				lastRole = 'andrea';
			} else if (Array.isArray(c) && c.some((x: any) => x?.type === 'tool_result')) lastRole = 'strumento';
			continue;
		}
		if (!Array.isArray(c)) continue;
		for (const part of c) {
			if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
				out.lastReply = part.text;
				lastRole = 'claude';
			}
			if (part?.type === 'tool_use' && part.name) {
				tools.set(part.name, (tools.get(part.name) ?? 0) + 1);
				const f = part.input?.file_path ?? part.input?.notebook_path ?? part.input?.path;
				if (typeof f === 'string') files.push(f);
				lastRole = 'strumento';
			}
		}
	}
	out.tools = [...tools].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, n]) => ({ name, n }));
	out.files = [...new Set(files.reverse())].slice(0, 8);
	out.waiting = lastRole === 'claude';
	return out;
}

const clip = (s: string | undefined, n: number) => {
	if (!s) return '';
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Come lo legge Melissa: frasi brevi, percorsi accorciati. */
export function digestText(d: SessionDigest, project: string, now = Date.now()): string {
	const min = Math.round((now - d.at) / 60_000);
	const when = min < 2 ? 'adesso' : min < 60 ? `${min} minuti fa` : `${Math.round(min / 60)} ore fa`;
	const home = os.homedir();
	const lines = [`Sessione su ${project}, ultimo movimento ${when}${d.waiting ? ', aspetta Andrea' : ''}.`];
	if (d.lastPrompt) lines.push(`Ultima richiesta di Andrea: «${clip(d.lastPrompt, 240)}»`);
	if (d.lastReply) lines.push(`Ultima risposta di Claude: «${clip(d.lastReply, 400)}»`);
	if (d.tools.length) lines.push(`Strumenti usati di recente: ${d.tools.map(t => `${t.name} ${t.n}`).join(', ')}.`);
	if (d.files.length) lines.push(`File toccati: ${d.files.map(f => f.replace(home, '~')).join(', ')}.`);
	return lines.join('\n');
}
