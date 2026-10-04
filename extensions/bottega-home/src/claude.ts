import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
/** Cartella di lavoro delle deleghe dei Connettori (delega.ts, DIR_CONNETTORI): chi lavora li' e' un `claude -p`
 *  della Bottega, non una sessione di Andrea. Nel registro una delega e' `kind: interactive`, `entrypoint: sdk-cli`,
 *  come qualunque programma fatto con l'SDK: la cartella e' l'unico segno sicuro. */
const DELEGHE_DIR = path.join(os.homedir(), '.bottega', 'connettori');
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
	/** Nessun messaggio ancora: il pannello di Claude Code nell'editor avvia il processo appena si apre, e il registro
	 *  lo dice `idle` anche se Andrea non ha scritto niente. Il jsonl della sessione nasce col primo messaggio. */
	empty?: boolean;
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

export function isDelega(cwd: unknown): boolean {
	return typeof cwd === 'string' && (cwd === DELEGHE_DIR || cwd.startsWith(DELEGHE_DIR + path.sep));
}

/** Il jsonl di una sessione: Claude Code mette la cartella sotto ~/.claude/projects con ogni carattere non
 *  alfanumerico cambiato in '-'. Oltre 200 caratteri la tronca e aggiunge un hash: li' non sappiamo, quindi undefined. */
function transcriptExists(cwd: string, sessionId: string): boolean | undefined {
	const dir = String(cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-');
	if (!dir || !sessionId || dir.length > 200) return undefined;
	return fs.existsSync(path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`));
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
			if (!d.pid || !alive(d.pid) || isDelega(d.cwd)) {
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
				...(transcriptExists(d.cwd, d.sessionId) === false ? { empty: true } : {}),
			});
		} catch {
			// file scritto a meta' mentre lo leggiamo: lo riprendiamo al prossimo giro
		}
	}
	return out.sort((a, b) => b.statusSince - a.statusSince);
}

/** Legge `bytes` byte da `start` senza bloccare il processo delle estensioni, che e' lo stesso di Claude Code. */
async function readAt(file: string, start: number, bytes: number): Promise<string> {
	const fh = await fs.promises.open(file, 'r');
	try {
		const buf = Buffer.alloc(Math.max(0, bytes));
		const { bytesRead } = await fh.read(buf, 0, buf.length, start);
		return buf.subarray(0, bytesRead).toString('utf8');
	} finally {
		await fh.close();
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

const TITLE_RE = /"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g;
const TOUCHED_RE = /"(?:cwd|file_path|notebook_path)":"(\/(?:[^"\\]|\\.)*)"/g;
const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 256 * 1024;

function lastTitle(text: string): string | undefined {
	const titles = [...text.matchAll(TITLE_RE)];
	return titles.length ? JSON.parse(`"${titles[titles.length - 1][1]}"`) : undefined;
}

function addTouched(touched: Set<string>, text: string): void {
	for (const m of text.matchAll(TOUCHED_RE)) {
		if (touched.size >= 400) break;
		touched.add(m[1]);
	}
}

/** Cache per file: un jsonl che non cambia non si rilegge; uno che cresce (la sessione e' viva) si legge solo
 *  nella parte nuova, per il titolo piu' recente e i file toccati. */
const cache = new Map<string, { mtime: number; size: number; session: PastSession }>();

async function readSession(file: string, st: fs.Stats): Promise<PastSession | undefined> {
	const hit = cache.get(file);
	if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) {
		return hit.session;
	}
	if (hit && st.size > hit.size) {
		const added = st.size - hit.size;
		const chunk = await readAt(file, Math.max(hit.size, st.size - TAIL_BYTES), Math.min(added, TAIL_BYTES));
		const touched = new Set(hit.session.touched);
		addTouched(touched, chunk);
		const session: PastSession = { ...hit.session, title: lastTitle(chunk) ?? hit.session.title, mtime: st.mtimeMs, touched: [...touched] };
		cache.set(file, { mtime: st.mtimeMs, size: st.size, session });
		return session;
	}
	const head = await readAt(file, 0, Math.min(HEAD_BYTES, st.size));
	const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
	if (!cwd) {
		return undefined;
	}
	const tail = st.size > HEAD_BYTES ? await readAt(file, Math.max(0, st.size - TAIL_BYTES), Math.min(TAIL_BYTES, st.size)) : '';
	const title = lastTitle(tail + head) ?? firstUserText(head) ?? 'Sessione senza titolo';
	const touched = new Set<string>();
	addTouched(touched, head + tail);
	const session: PastSession = {
		sessionId: path.basename(file).replace(/\.jsonl$/, ''),
		cwd: JSON.parse(`"${cwd}"`),
		title,
		mtime: st.mtimeMs,
		touched: [...touched],
	};
	cache.set(file, { mtime: st.mtimeMs, size: st.size, session });
	return session;
}

export async function readPastSessions(maxAgeDays = 45): Promise<PastSession[]> {
	const cutoff = Date.now() - maxAgeDays * 86_400_000;
	const out: PastSession[] = [];
	let dirs: string[] = [];
	try {
		dirs = await fs.promises.readdir(PROJECTS_DIR);
	} catch {
		return [];
	}
	for (const dir of dirs) {
		const full = path.join(PROJECTS_DIR, dir);
		let files: string[];
		try {
			files = (await fs.promises.readdir(full)).filter(f => f.endsWith('.jsonl'));
		} catch {
			continue;
		}
		for (const f of files) {
			const file = path.join(full, f);
			try {
				const st = await fs.promises.stat(file);
				if (st.mtimeMs < cutoff || st.size < 200) {
					continue;
				}
				const session = await readSession(file, st);
				if (session) out.push(session);
			} catch {
				continue;
			}
		}
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}
