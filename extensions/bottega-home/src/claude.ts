import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/** Sessione Claude Code in esecuzione adesso (registro ~/.claude/sessions/<pid>.json). */
export interface LiveSession {
	pid: number;
	sessionId: string;
	cwd: string;
	name: string;
	status: string; // busy | idle | shell | ...
	startedAt: number;
	statusSince: number;
	title?: string;
}

/** Sessione salvata su disco (~/.claude/projects/<cwd codificata>/<id>.jsonl). */
export interface PastSession {
	sessionId: string;
	cwd: string;
	title: string;
	mtime: number;
	/** Cartelle e file toccati durante la sessione: servono ad attribuire al progetto giusto
	 *  le sessioni partite dalla home. */
	touched: string[];
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === 'EPERM';
	}
}

export function readLiveSessions(): LiveSession[] {
	let files: string[] = [];
	try {
		files = fs.readdirSync(SESSIONS_DIR).filter(f => /^\d+\.json$/.test(f));
	} catch {
		return [];
	}
	const out: LiveSession[] = [];
	for (const f of files) {
		try {
			const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
			if (!d.pid || !alive(d.pid)) {
				continue;
			}
			out.push({
				pid: d.pid,
				sessionId: d.sessionId,
				cwd: d.cwd,
				name: d.name ?? '',
				status: d.status ?? 'idle',
				startedAt: d.startedAt ?? 0,
				statusSince: d.statusUpdatedAt ?? d.updatedAt ?? d.startedAt ?? 0,
			});
		} catch {
			// file scritto a meta' mentre lo leggiamo: lo riprendiamo al prossimo giro
		}
	}
	return out.sort((a, b) => b.statusSince - a.statusSince);
}

function readHead(file: string, bytes: number): string {
	const fd = fs.openSync(file, 'r');
	try {
		const buf = Buffer.alloc(bytes);
		const n = fs.readSync(fd, buf, 0, bytes, 0);
		return buf.subarray(0, n).toString('utf8');
	} finally {
		fs.closeSync(fd);
	}
}

function readTail(file: string, bytes: number, size: number): string {
	const fd = fs.openSync(file, 'r');
	try {
		const start = Math.max(0, size - bytes);
		const buf = Buffer.alloc(Math.min(bytes, size));
		const n = fs.readSync(fd, buf, 0, buf.length, start);
		return buf.subarray(0, n).toString('utf8');
	} finally {
		fs.closeSync(fd);
	}
}

function firstUserText(head: string): string | undefined {
	for (const line of head.split('\n')) {
		if (!line.includes('"type":"user"')) {
			continue;
		}
		try {
			const d = JSON.parse(line);
			const c = d?.message?.content;
			const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((p: any) => p?.type === 'text')?.text : undefined;
			if (text && !text.startsWith('<')) {
				return text.replace(/\s+/g, ' ').slice(0, 90);
			}
		} catch {
			// riga troncata dal limite di lettura
		}
	}
	return undefined;
}

/** Cache per file: rileggere solo i jsonl cambiati dall'ultimo giro. */
const cache = new Map<string, { mtime: number; session: PastSession }>();

export function readPastSessions(maxAgeDays = 45): PastSession[] {
	const cutoff = Date.now() - maxAgeDays * 86_400_000;
	const out: PastSession[] = [];
	let dirs: string[] = [];
	try {
		dirs = fs.readdirSync(PROJECTS_DIR);
	} catch {
		return [];
	}
	for (const dir of dirs) {
		const full = path.join(PROJECTS_DIR, dir);
		let files: string[];
		try {
			files = fs.readdirSync(full).filter(f => f.endsWith('.jsonl'));
		} catch {
			continue;
		}
		for (const f of files) {
			const file = path.join(full, f);
			let st: fs.Stats;
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
				const title = titles.length ? JSON.parse(`"${titles[titles.length - 1][1]}"`) : firstUserText(head) ?? 'Sessione senza titolo';
				const touched = new Set<string>();
				for (const m of (head + tail).matchAll(/"(?:cwd|file_path|notebook_path)":"(\/(?:[^"\\]|\\.)*)"/g)) {
					if (touched.size >= 400) break;
					touched.add(m[1]);
				}
				const session: PastSession = {
					sessionId: f.replace(/\.jsonl$/, ''),
					cwd: JSON.parse(`"${cwd}"`),
					title,
					mtime: st.mtimeMs,
					touched: [...touched],
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
