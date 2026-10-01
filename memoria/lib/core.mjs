// Il lavoro vero della Memoria: assorbire lo spool, riassumere le sessioni, preparare i contesti,
// cercare. Gira nel processo staccato, nella CLI e nel server MCP.
import fs from 'node:fs';
import path from 'node:path';
import {
	SPOOL_DIR, CONTEXT_DIR, LOCK_PATH, ensureDir, attribute, projectOf, HOME_PROJECT, log, today, listProjects,
} from './paths.mjs';
import { redact, undash, clip, cleanPrompt } from './redact.mjs';
import { openStore, blobToVec, cosine, toItem } from './store.mjs';
import { parseTranscript, findTranscript, listTranscripts, trim } from './transcript.mjs';
import { appleGenerate, agnesGenerate, embed, embedAvailable, RateLimited, nucleoPath, agnesKey } from './engines.mjs';
import { tilde } from './hook.mjs';
import { readAllBoards, readSessionInfo } from './bacheca.mjs';

// ---- spool ------------------------------------------------------------------------------

/** Porta nel database le righe nuove dello spool. Ogni riga entra una volta sola. */
export function ingest(store = openStore()) {
	let files = [];
	try {
		files = fs.readdirSync(SPOOL_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
	} catch {
		return { lines: 0, sessions: 0 };
	}
	let total = 0;
	const touchedSessions = new Set();
	for (const f of files) {
		const file = path.join(SPOOL_DIR, f);
		const off = Number(store.get('SELECT offset FROM spool_offsets WHERE file = ?', f)?.offset || 0);
		let size;
		try {
			size = fs.statSync(file).size;
		} catch {
			continue;
		}
		if (size > off) {
			const fd = fs.openSync(file, 'r');
			const buf = Buffer.alloc(size - off);
			fs.readSync(fd, buf, 0, buf.length, off);
			fs.closeSync(fd);
			const end = buf.lastIndexOf(0x0a);
			if (end >= 0) {
				const chunk = buf.subarray(0, end + 1).toString('utf8');
				store.tx(() => {
					for (const line of chunk.split('\n')) {
						if (!line) continue;
						let e;
						try {
							e = JSON.parse(line);
						} catch {
							continue;
						}
						if (!e.sid) continue;
						applySpoolEntry(store, e);
						touchedSessions.add(e.sid);
						total++;
					}
					store.run(
						'INSERT INTO spool_offsets(file, offset, at) VALUES (?, ?, ?) ON CONFLICT(file) DO UPDATE SET offset = excluded.offset, at = excluded.at',
						f,
						off + end + 1,
						Date.now(),
					);
				});
			}
		}
		// I file dei giorni passati gia' assorbiti non servono piu'.
		const consumed = Number(store.get('SELECT offset FROM spool_offsets WHERE file = ?', f)?.offset || 0);
		const ageDays = (Date.now() - Date.parse(f.slice(0, 10))) / 86_400_000;
		if (consumed >= size && ageDays > 3 && f !== `${today()}.jsonl`) {
			try {
				fs.unlinkSync(file);
				store.run('DELETE FROM spool_offsets WHERE file = ?', f);
			} catch {
				// riproviamo al prossimo giro
			}
		}
	}
	for (const sid of touchedSessions) reattribute(store, sid);
	if (total) store.meta('last_ingest', Date.now());
	return { lines: total, sessions: touchedSessions.size };
}

function applySpoolEntry(store, e) {
	store.upsertSession({ id: e.sid, cwd: e.cwd, transcriptPath: e.tp, at: e.at || Date.now() });
	if (e.ev === 'prompt') {
		const p = cleanPrompt(e.prompt);
		if (!p) return;
		store.run('INSERT INTO observations(sessionId, at, kind, input) VALUES (?, ?, ?, ?)', e.sid, e.at, 'prompt', redact(p).slice(0, 2500));
		store.run('UPDATE sessions SET prompts = prompts + 1, obsCount = obsCount + 1, title = COALESCE(title, ?) WHERE id = ?', clip(p, 80), e.sid);
		if (p.length >= 15) {
			const s = store.session(e.sid);
			const proj = s?.projectKey ? { name: s.project, path: s.projectPath, key: s.projectKey } : projectOf(e.cwd) || HOME_PROJECT;
			store.addMemory({
				kind: 'prompt',
				project: proj.name,
				projectPath: proj.path,
				projectKey: proj.key,
				sessionId: e.sid,
				title: clip(p, 80),
				text: redact(p).slice(0, 2000),
				createdAt: e.at,
			});
		}
	} else if (e.ev === 'tool') {
		store.run(
			'INSERT INTO observations(sessionId, at, kind, tool, files, input, result) VALUES (?, ?, ?, ?, ?, ?, ?)',
			e.sid,
			e.at,
			'tool',
			e.tool || '',
			(e.files || []).join('\n'),
			e.input || '',
			e.result || '',
		);
		store.run('UPDATE sessions SET tools = tools + 1, obsCount = obsCount + 1 WHERE id = ?', e.sid);
	} else if (e.ev === 'end') {
		store.run('UPDATE sessions SET endedAt = ? WHERE id = ?', e.at, e.sid);
	}
}

/** Progetto della sessione: cartella di partenza, altrimenti la maggioranza dei file toccati. */
function reattribute(store, sid) {
	const s = store.session(sid);
	if (!s) return;
	if (s.projectKey && s.projectKey !== 'home') return;
	const files = store.all("SELECT files FROM observations WHERE sessionId = ? AND files != ''", sid).flatMap(r => r.files.split('\n'));
	let p = attribute(s.cwd, files);
	if (p.key === 'home') {
		// La bacheca sa gia' su quale progetto lavora una sessione partita dalla home.
		const info = readSessionInfo(sid);
		if (info?.key && info.key !== 'home' && info.path) p = { name: info.name, path: info.path, key: info.key };
	}
	if (p.key !== s.projectKey) store.setProject(sid, p);
}

// ---- riassunti --------------------------------------------------------------------------

export const INSTRUCTIONS = `Sei la memoria di lavoro di uno sviluppatore. Ricevi la trascrizione compressa di una sessione di Claude Code: le richieste dell'utente iniziano con UTENTE, le risposte con CLAUDE, gli strumenti usati con >.
Scrivi in italiano corretto, con frasi semplici e concrete e con gli accenti giusti (è, già, più, perché, così): mai un apostrofo al posto dell'accento. Non usare mai lineette lunghe. Non usare markdown, niente grassetto.
Rispondi esattamente in questo formato:
TITOLO: al massimo 10 parole
RIASSUNTO: da 4 a 8 frasi: cosa è stato chiesto, cosa è stato fatto, i file principali toccati, com'è finita.
DECISIONI:
- una scelta tecnica o di prodotto presa nella sessione, con il motivo (al massimo 4; scrivi "- nessuna" se non ce ne sono)
FATTI:
- un fatto utile da ricordare in futuro su questo progetto: percorsi, comandi, configurazioni, problemi noti (al massimo 5)
DA FARE:
- cosa resta aperto (al massimo 4; scrivi "- niente" se è tutto chiuso)
Non inventare nulla che non sia nella trascrizione. Non riportare mai chiavi, password o token.`;

const APPLE_MAX = 7_000; // il modello sul dispositivo ha una finestra piccola
const AGNES_MAX = 12_000;

export function parseSummary(out) {
	const text = undash(String(out).replace(/\*\*/g, '').replace(/^#+\s*/gm, '')).trim();
	const sec = { TITOLO: '', RIASSUNTO: '', DECISIONI: '', FATTI: '', 'DA FARE': '' };
	let cur;
	for (const line of text.split('\n')) {
		const m = /^\s*(TITOLO|RIASSUNTO|DECISIONI|FATTI|DA FARE)\s*:\s*(.*)$/i.exec(line);
		if (m) {
			cur = m[1].toUpperCase();
			sec[cur] = m[2].trim();
			continue;
		}
		if (cur) sec[cur] += (sec[cur] ? '\n' : '') + line.trim();
	}
	const items = s =>
		s
			.split('\n')
			.map(x => x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
			.filter(x => x && !/^(nessuna|nessuno|niente|nulla)\.?$/i.test(x));
	if (!sec.RIASSUNTO && !sec.TITOLO) return { title: '', summary: clip(text, 2500), decisions: [], facts: [], todo: [] };
	return {
		title: clip(sec.TITOLO, 100),
		summary: sec.RIASSUNTO.trim(),
		decisions: items(sec.DECISIONI).slice(0, 4),
		facts: items(sec.FATTI).slice(0, 5),
		todo: items(sec['DA FARE']).slice(0, 4),
	};
}

async function generate(store, text, opts = {}) {
	// Agnes per prima: piu' veloce e riassunti migliori. Apple Intelligence (gia' dentro macOS,
	// nessun download) solo come riserva se Agnes rifiuta per quota o non risponde.
	if (agnesKey()) {
		try {
			const out = await agnesGenerate(store, INSTRUCTIONS, trim(text, AGNES_MAX), { maxWaitMs: opts.maxWaitMs });
			return { engine: 'agnes', out };
		} catch (e) {
			if (opts.soloAgnes) throw e;
			const apple = appleGenerate(INSTRUCTIONS, trim(text, APPLE_MAX));
			if (apple) return { engine: 'apple', out: apple };
			throw e;
		}
	}
	const apple = opts.soloAgnes ? null : appleGenerate(INSTRUCTIONS, trim(text, APPLE_MAX));
	if (apple) return { engine: 'apple', out: apple };
	throw new Error('chiave Agnes assente e Apple Intelligence non disponibile');
}

function observationsText(store, sid) {
	const rows = store.all('SELECT kind, tool, files, input FROM observations WHERE sessionId = ? ORDER BY at, id', sid);
	const lines = [];
	for (const r of rows) {
		if (r.kind === 'prompt') lines.push(`UTENTE: ${clip(r.input, 1500)}`);
		else {
			const f = r.files ? r.files.split('\n')[0] : '';
			lines.push(`> ${r.tool}${f ? ' ' + tilde(f) : r.input ? ': ' + clip(r.input, 140) : ''}`);
		}
	}
	return lines.join('\n');
}

/**
 * Riassume una sessione e ne ricava fatti e decisioni come memorie separate.
 * Ritorna { ok, skipped?, engine?, title? }; lancia RateLimited se Agnes chiede di aspettare.
 */
export async function summarizeSession(sid, opts = {}) {
	const store = opts.store || openStore();
	let s = store.findSession(sid);
	const tp = (s?.transcriptPath && fs.existsSync(s.transcriptPath) && s.transcriptPath) || findTranscript(s?.id || sid);
	if (!s && !tp) throw new Error(`sessione ${sid} non trovata`);
	const id = s?.id || sid;
	let parsed;
	let size = 0;
	if (tp) {
		parsed = parseTranscript(tp, { maxChars: AGNES_MAX });
		size = fs.statSync(tp).size;
	}
	if (!s) {
		store.upsertSession({ id, cwd: parsed?.cwd, transcriptPath: tp, at: parsed?.startedAt || Date.now() });
		store.run('UPDATE sessions SET lastActivity = ?, prompts = ?, tools = ? WHERE id = ?', parsed?.lastAt || Date.now(), parsed?.prompts || 0, parsed?.tools || 0, id);
		s = store.session(id);
	} else if (tp && !s.transcriptPath) {
		store.run('UPDATE sessions SET transcriptPath = ? WHERE id = ?', tp, id);
	}
	const text = parsed?.text || redact(observationsText(store, id));
	const cwd = parsed?.cwd || s.cwd;
	const obsFiles = store.all("SELECT files FROM observations WHERE sessionId = ? AND files != ''", id).flatMap(r => r.files.split('\n'));
	const project = attribute(cwd, [...(parsed?.touched || []), ...obsFiles]);
	store.setProject(id, project);
	if (parsed?.cwd && !s.cwd) store.run('UPDATE sessions SET cwd = ? WHERE id = ?', parsed.cwd, id);

	const mark = engine =>
		store.run(
			'UPDATE sessions SET summarizedAt = ?, summarizedObs = obsCount, summarizedSize = ?, engine = ?, attempts = 0, lastError = NULL, title = COALESCE(?, title) WHERE id = ?',
			Date.now(),
			size,
			engine,
			parsed?.title ?? null,
			id,
		);
	if (text.length < 300 || !(parsed?.prompts || s.prompts)) {
		mark('vuota');
		return { ok: true, skipped: 'troppo breve' };
	}

	const { engine, out } = await generate(store, text, opts);
	const r = parseSummary(out);
	const title = r.title || parsed?.title || s.title || 'Sessione';
	const edited = (parsed?.edited || []).map(f => relTo(f, project));
	const parts = [r.summary];
	if (r.decisions.length) parts.push(`Decisioni: ${r.decisions.join('; ')}`);
	if (edited.length) parts.push(`File toccati: ${edited.slice(0, 10).join(', ')}${edited.length > 10 ? ` e altri ${edited.length - 10}` : ''}`);
	if (r.todo.length) parts.push(`Da fare: ${r.todo.join('; ')}`);
	const createdAt = parsed?.lastAt || s.lastActivity || Date.now();
	const base = { project: project.name, projectPath: project.path, projectKey: project.key, sessionId: id, createdAt };
	const ids = store.tx(() => {
		store.run("DELETE FROM memories WHERE sessionId = ? AND origin = 'auto' AND kind IN ('riassunto', 'fatto', 'decisione')", id);
		const out = [store.addMemory({ ...base, kind: 'riassunto', title, text: undash(parts.filter(Boolean).join('\n')) })];
		for (const d of r.decisions) out.push(store.addMemory({ ...base, kind: 'decisione', title: clip(d, 80), text: d }));
		for (const f of r.facts) out.push(store.addMemory({ ...base, kind: 'fatto', title: clip(f, 80), text: f }));
		return out;
	});
	mark(engine);
	store.run('UPDATE sessions SET title = ? WHERE id = ?', title, id);
	writeContext(project, store);
	embedPending(store, 32);
	log(`riassunto ${id.slice(0, 8)} (${project.name}) con ${engine}: ${ids.length} memorie`);
	return { ok: true, engine, title, project: project.name, memories: ids.length };
}

function relTo(file, project) {
	if (project?.path && file.toLowerCase().startsWith(project.path.toLowerCase() + '/')) return file.slice(project.path.length + 1);
	return tilde(file);
}

// ---- contesto di inizio sessione --------------------------------------------------------

const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const giorno = ts => {
	const d = new Date(ts);
	return `${d.getDate()} ${MESI[d.getMonth()]}`;
};

/** Testo breve (al massimo ~1500 caratteri) che la prossima sessione su questo progetto legge all'avvio. */
export function buildContext(project, store = openStore()) {
	const key = project.key;
	const sums = store.all("SELECT * FROM memories WHERE projectKey = ? AND kind = 'riassunto' ORDER BY createdAt DESC LIMIT 5", key);
	const notes = store.all("SELECT * FROM memories WHERE projectKey = ? AND kind = 'nota' ORDER BY createdAt DESC LIMIT 4", key);
	const facts = store.all("SELECT * FROM memories WHERE projectKey = ? AND kind IN ('decisione', 'fatto') ORDER BY createdAt DESC, kind ASC LIMIT 8", key);
	if (!sums.length && !notes.length && !facts.length) return '';
	const LIMIT = 1500;
	const footer = "Per cercare altro nella memoria del progetto usa lo strumento memoria_cerca (server MCP bottega-memoria).";
	const label = project.key === 'home' ? 'sessioni partite dalla home' : project.name;
	const out = [`Memoria della Bottega, ${label}. Ultime sessioni, dalla piu' recente:`];
	let used = out[0].length + footer.length + 4;
	const push = line => {
		if (used + line.length + 1 > LIMIT) return false;
		out.push(line);
		used += line.length + 1;
		return true;
	};
	for (const [i, m] of sums.entries()) {
		const first = String(m.text).split('\n')[0];
		const todo = /(?:^|\n)Da fare: (.*)/.exec(m.text)?.[1];
		const line = `- ${giorno(m.createdAt)}, ${m.title}: ${clip(first, i < 2 ? 300 : 170)}${todo && i === 0 ? ` Da fare: ${clip(todo, 160)}` : ''}`;
		if (!push(line) && i >= 2) break;
	}
	const keep = [...notes, ...facts];
	if (keep.length && used + 40 < LIMIT) {
		push('Da ricordare:');
		for (const m of keep) if (!push(`- ${clip(m.text, 170)}`)) break;
	}
	out.push(footer);
	return undash(out.join('\n'));
}

export function writeContext(project, store = openStore()) {
	ensureDir(CONTEXT_DIR);
	const file = path.join(CONTEXT_DIR, `${project.key}.md`);
	const text = buildContext(project, store);
	if (!text) {
		try {
			fs.unlinkSync(file);
		} catch {
			// non c'era
		}
		return '';
	}
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, text + '\n', { mode: 0o600 });
	fs.renameSync(tmp, file);
	return text;
}

// ---- ricerca ----------------------------------------------------------------------------

/** Ricerca ibrida: parole (bm25) e, se ci sono i vettori, somiglianza di significato. */
export function search(query, { progetto, limite = 10, store = openStore() } = {}) {
	limite = Math.max(1, Math.min(50, Number(limite) || 10));
	const fts = store.ftsSearch(query, { progetto, limite: 60 });
	const scores = new Map();
	const maxS = Math.max(1e-9, ...fts.map(r => -r.rank));
	for (const r of fts) scores.set(Number(r.id), { row: r, kw: -r.rank / maxS, sem: 0 });
	let semantic = false;
	if (store.hasVectors() && embedAvailable()) {
		const qv = embed([query])?.[0];
		if (qv) {
			semantic = true;
			const q = Float32Array.from(qv);
			for (const v of store.vectorsFor(progetto)) {
				const sim = cosine(q, blobToVec(v.vec));
				const id = Number(v.memoryId);
				const cur = scores.get(id);
				if (cur) cur.sem = Math.max(0, sim);
				else if (sim >= 0.55) scores.set(id, { row: null, kw: 0, sem: sim });
			}
		}
	}
	const weight = { prompt: 0.7, riassunto: 1, decisione: 1, fatto: 0.95, nota: 1.05 };
	const out = [];
	for (const [id, s] of scores) {
		const row = s.row || store.get('SELECT * FROM memories WHERE id = ?', id);
		if (!row) continue;
		const base = semantic ? 0.55 * s.kw + 0.45 * s.sem : s.kw;
		out.push({ ...toItem(row), score: Math.round(base * (weight[row.kind] ?? 1) * 100) / 100 });
	}
	return out.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt).slice(0, limite);
}

export function remember(testo, { progetto, cwd, store = openStore() } = {}) {
	const text = undash(redact(String(testo || '').trim()));
	if (!text) throw new Error('testo vuoto');
	let project;
	if (progetto) {
		const known = store.get('SELECT project, projectPath, projectKey FROM memories WHERE lower(project) = lower(?) OR projectKey = ? ORDER BY createdAt DESC LIMIT 1', progetto, progetto);
		project = known ? { name: known.project, path: known.projectPath, key: known.projectKey } : resolveProjectName(progetto);
	} else project = projectOf(cwd || process.cwd()) || HOME_PROJECT;
	const id = store.addMemory({ kind: 'nota', project: project.name, projectPath: project.path, projectKey: project.key, title: clip(text, 80), text, origin: 'manuale' });
	writeContext(project, store);
	embedPending(store, 4);
	return store.memory(id);
}

function resolveProjectName(name) {
	if (String(name).toLowerCase() === 'home') return HOME_PROJECT;
	const hit = listProjects().find(p => p.name.toLowerCase() === String(name).toLowerCase());
	return hit || { name, path: '', key: String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-') };
}

export function sessionDetail(idOrPrefix, store = openStore()) {
	const s = store.findSession(idOrPrefix);
	if (!s) return undefined;
	const memories = store.all('SELECT * FROM memories WHERE sessionId = ? ORDER BY kind, createdAt', s.id).map(toItem);
	const obs = store.all('SELECT at, kind, tool, files, input FROM observations WHERE sessionId = ? ORDER BY at DESC, id DESC LIMIT 40', s.id).reverse();
	return { session: s, memories, observations: obs };
}

// ---- vettori ----------------------------------------------------------------------------

export function embedPending(store = openStore(), limit = 64) {
	if (!nucleoPath() || !embedAvailable()) return 0;
	const rows = store.memoriesWithoutVector(limit);
	if (!rows.length) return 0;
	const vecs = embed(rows.map(r => `${r.title || ''}. ${r.text}`));
	if (!vecs) return 0;
	store.tx(() => rows.forEach((r, i) => store.saveVector(Number(r.id), vecs[i])));
	return rows.length;
}

// ---- processo staccato ------------------------------------------------------------------

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e?.code === 'EPERM';
	}
}

function lock() {
	for (let i = 0; i < 2; i++) {
		try {
			const fd = fs.openSync(LOCK_PATH, 'wx', 0o600);
			fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
			fs.closeSync(fd);
			return true;
		} catch {
			try {
				const d = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
				const stale = !alive(d.pid) || Date.now() - d.at > 30 * 60_000;
				if (!stale) return false;
				fs.unlinkSync(LOCK_PATH);
			} catch {
				try {
					if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > 60_000) fs.unlinkSync(LOCK_PATH);
				} catch {
					// sparito: riprova
				}
			}
		}
	}
	return false;
}

function unlock() {
	try {
		const d = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
		if (d.pid === process.pid) fs.unlinkSync(LOCK_PATH);
	} catch {
		// gia' tolto
	}
}

export function enqueue(store, sid, reason) {
	if (!sid) return;
	store.run(
		`INSERT INTO queue(sessionId, reason, at) VALUES (?, ?, ?)
		 ON CONFLICT(sessionId) DO UPDATE SET
			reason = CASE WHEN queue.reason IN ('fine', 'manuale') THEN queue.reason ELSE excluded.reason END,
			at = excluded.at`,
		sid,
		reason,
		Date.now(),
	);
}

/** Decide se una sessione in coda merita un riassunto adesso. */
function worth(s, reason) {
	if (!s) return false;
	const fresh = s.obsCount - s.summarizedObs;
	if (reason === 'manuale') return true;
	if (reason === 'fine' || reason === 'inattiva') return fresh >= 1 || !s.summarizedAt;
	if (reason === 'stop') {
		if (!s.summarizedAt) return s.prompts >= 1 && s.obsCount >= 15;
		return fresh >= 25 && Date.now() - s.summarizedAt > 20 * 60_000;
	}
	return false;
}

/**
 * Il processo staccato avviato dagli hook: assorbe lo spool, mette in coda la sessione indicata,
 * e se nessun altro sta gia' lavorando svuota la coda dei riassunti.
 */
export async function runWorker({ motivo = 'stop', sessione } = {}) {
	const store = openStore();
	ingest(store);
	if (sessione) enqueue(store, sessione, motivo === 'fine' ? 'fine' : 'stop');
	if (motivo === 'avvio') {
		// Sessioni rimaste a meta' (terminale chiuso, nessun SessionEnd): fermi da 30 minuti.
		const stale = store.all(
			`SELECT id FROM sessions WHERE lastActivity < ? AND lastActivity > ? AND obsCount - summarizedObs >= 3 AND attempts < 3
			 ORDER BY lastActivity DESC LIMIT 5`,
			Date.now() - 30 * 60_000,
			Date.now() - 14 * 86_400_000,
		);
		for (const r of stale) enqueue(store, r.id, 'inattiva');
	}
	for (let round = 0; round < 2; round++) {
		if (!lock()) return { busy: true };
		try {
			await drain(store);
		} finally {
			unlock();
		}
		if (!store.get('SELECT 1 AS x FROM queue LIMIT 1')) break;
	}
	return { ok: true };
}

async function drain(store) {
	for (let guard = 0; guard < 50; guard++) {
		ingest(store);
		const item = store.get('SELECT * FROM queue ORDER BY at ASC LIMIT 1');
		if (!item) return;
		const s = store.session(item.sessionId);
		if (!worth(s, item.reason)) {
			store.run('DELETE FROM queue WHERE sessionId = ?', item.sessionId);
			continue;
		}
		try {
			await summarizeSession(item.sessionId, { store, maxWaitMs: 5 * 60_000 });
			store.run('DELETE FROM queue WHERE sessionId = ?', item.sessionId);
		} catch (e) {
			if (e instanceof RateLimited) {
				log(`worker: ${e.message}, riprovo piu' tardi`);
				return;
			}
			log(`worker: riassunto ${item.sessionId.slice(0, 8)} fallito: ${e?.message || e}`);
			store.run('UPDATE sessions SET attempts = attempts + 1, lastError = ? WHERE id = ?', String(e?.message || e).slice(0, 300), item.sessionId);
			store.run('DELETE FROM queue WHERE sessionId = ?', item.sessionId);
		}
	}
}

// ---- recupero dello storico -------------------------------------------------------------

/** Riassume le sessioni passate gia' su disco. Riprende da dove si era fermato. */
export async function backfill({ giorni = 30, max = 50, dryRun = false, onProgress = () => {} } = {}) {
	const store = openStore();
	const list = listTranscripts(Date.now() - giorni * 86_400_000).filter(t => t.size >= 2_000 && Date.now() - t.mtime > 5 * 60_000);
	let done = 0;
	let skipped = 0;
	const results = [];
	for (const t of list) {
		if (done >= max) break;
		const s = store.session(t.sessionId);
		if (s?.summarizedAt) {
			skipped++;
			continue;
		}
		if (dryRun) {
			results.push({ sessionId: t.sessionId, file: t.file, size: t.size });
			done++;
			continue;
		}
		if (!lock()) {
			onProgress({ wait: true });
			await new Promise(r => setTimeout(r, 5000));
			if (!lock()) throw new Error('un altro processo della Memoria sta riassumendo: riprova tra poco');
		}
		try {
			if (!store.session(t.sessionId)) store.upsertSession({ id: t.sessionId, transcriptPath: t.file, at: t.mtime });
			else if (!s.transcriptPath) store.run('UPDATE sessions SET transcriptPath = ? WHERE id = ?', t.file, t.sessionId);
			const r = await summarizeSession(t.sessionId, { store, maxWaitMs: 10 * 60_000 });
			results.push({ sessionId: t.sessionId, ...r });
			onProgress({ sessionId: t.sessionId, ...r });
			if (!r.skipped) done++;
		} catch (e) {
			if (e instanceof RateLimited) {
				onProgress({ error: e.message, stop: true });
				break;
			}
			store.run('UPDATE sessions SET attempts = attempts + 1, lastError = ? WHERE id = ?', String(e?.message || e).slice(0, 300), t.sessionId);
			results.push({ sessionId: t.sessionId, error: String(e?.message || e) });
			onProgress({ sessionId: t.sessionId, error: String(e?.message || e) });
		} finally {
			unlock();
		}
	}
	return { candidates: list.length, alreadyDone: skipped, done, results };
}

// ---- bacheca ----------------------------------------------------------------------------

export function board({ progetto, minuti = 60 } = {}) {
	const since = Date.now() - Math.max(1, Number(minuti) || 60) * 60_000;
	let entries = readAllBoards(since);
	if (progetto) {
		const p = String(progetto).toLowerCase();
		entries = entries.filter(e => String(e.project).toLowerCase() === p || e.key === progetto);
	}
	return entries.map(e => ({ at: e.at, sessionId: e.sessionId, project: e.project, kind: e.kind, summary: e.summary, ...(e.rel ? { file: e.rel } : {}) }));
}

export { projectOf, HOME_PROJECT };
