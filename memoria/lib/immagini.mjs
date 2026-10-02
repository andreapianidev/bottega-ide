// Le schermate delle sessioni Claude diventano cercabili: le immagini base64 delle trascrizioni
// (~/.claude/projects/<cartella>/<sessione>.jsonl e <sessione>/subagents/*.jsonl) passano dall'OCR del
// Nucleo (Vision, tutto sul Mac) e il testo, ripulito dai segreti, entra nella Memoria come ricordo
// `immagine`: FTS e ricerca esistenti lo trovano senza modifiche.
//
// Dove stanno le immagini (forme verificate sulle trascrizioni vere, ottobre 2026):
//   riga `user`, message.content[] {type:'image', source:{type:'base64', media_type, data}}      incollata
//   riga `user`, message.content[] {type:'tool_result', content:[{type:'image', ...}]}          strumento
//   riga `attachment`, attachment.prompt[] {type:'image', ...} (incollata mentre Claude lavorava) incollata
// (`toolUseResult` ripete le stesse immagini dei tool_result: non si legge.)
//
// Tabelle proprie, create qui:
//   immagini(hash PK, sessionId, file, riga, pos, at, fonte, mime, memoryId, stato, ms, caratteri, errore)
//     hash = sha1 del testo base64: la stessa immagine incollata due volte si legge una volta.
//     stato: da_leggere, letta (ricordo scritto), vuota (meno di 20 caratteri utili), errore, sparita.
//     Il base64 non si salva mai: `file` + `pos` (byte d'inizio della riga) bastano per rileggerla.
//   immagini_file(file PK, size, offset, righe, at): fin dove e' stata letta ogni trascrizione.
//
// Un giro: scansione incrementale (solo i byte nuovi, file toccati negli ultimi N giorni), poi al massimo
// `limite` immagini all'OCR, una alla volta, con un solo Nucleo `--cli ocr` lanciato sotto
// `taskpolicy -b` e `nice -n 19`. Se il Nucleo non conosce `ocr` (exit 64) il giro si ferma pulito.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { openStore } from './store.mjs';
import { nucleoPath } from './engines.mjs';
import { HOME, MEM_DIR, ensureDir, projectOf, HOME_PROJECT, log } from './paths.mjs';
import { redact, undash, clip } from './redact.mjs';

export const PROJECTS_DIR = process.env.BOTTEGA_CLAUDE_PROJECTS || path.join(HOME, '.claude', 'projects');
export const MIN_UTILI = 20;
export const MAX_TESTO = 4000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS immagini (
	hash TEXT PRIMARY KEY, sessionId TEXT, file TEXT NOT NULL, riga INTEGER NOT NULL, pos INTEGER NOT NULL,
	at INTEGER NOT NULL, fonte TEXT NOT NULL, mime TEXT, memoryId INTEGER,
	stato TEXT NOT NULL DEFAULT 'da_leggere', ms INTEGER, caratteri INTEGER, errore TEXT
);
CREATE INDEX IF NOT EXISTS immagini_stato ON immagini(stato, at);
CREATE TABLE IF NOT EXISTS immagini_file (
	file TEXT PRIMARY KEY, size INTEGER NOT NULL, offset INTEGER NOT NULL, righe INTEGER NOT NULL, at INTEGER
);`;

function ensure(store) {
	if (!store._immagini) {
		store.db.exec(SCHEMA);
		store._immagini = true;
	}
	return store;
}

// ---- estrazione -----------------------------------------------------------------------------

const isImage = b => b && b.type === 'image' && b.source && b.source.type === 'base64' && typeof b.source.data === 'string' && b.source.data.length > 0;

/** Le immagini di una riga di trascrizione gia' letta come JSON: [{data, mime, fonte}]. */
export function immaginiDi(d) {
	const out = [];
	if (!d || typeof d !== 'object') return out;
	const add = (b, fonte) => out.push({ data: b.source.data, mime: b.source.media_type || 'image/png', fonte });
	if (d.type === 'user' && Array.isArray(d.message?.content)) {
		for (const b of d.message.content) {
			if (isImage(b)) add(b, d.isSidechain ? 'strumento' : 'incollata');
			else if (b && b.type === 'tool_result' && Array.isArray(b.content)) for (const c of b.content) if (isImage(c)) add(c, 'strumento');
		}
	} else if (d.type === 'attachment' && Array.isArray(d.attachment?.prompt)) {
		for (const b of d.attachment.prompt) if (isImage(b)) add(b, 'incollata');
	}
	return out;
}

export const hashOf = data => crypto.createHash('sha1').update(data).digest('hex');

/** Sessione di un file: <sessione>.jsonl, oppure <sessione>/subagents/<agente>.jsonl. */
export function sessioneDelFile(file) {
	const dir = path.dirname(file);
	if (path.basename(dir) === 'subagents') return path.basename(path.dirname(dir));
	return path.basename(file, '.jsonl');
}

/** Trascrizioni (anche dei sotto-agenti) toccate dopo `sinceMs`. */
export function elencaTrascrizioni(projectsDir = PROJECTS_DIR, sinceMs = 0) {
	const out = [];
	const push = file => {
		try {
			const st = fs.statSync(file);
			if (st.isFile() && st.mtimeMs >= sinceMs) out.push({ file, size: st.size, mtime: st.mtimeMs });
		} catch {
			// sparito nel frattempo
		}
	};
	let dirs = [];
	try {
		dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(d => d.isDirectory());
	} catch {
		return out;
	}
	for (const d of dirs) {
		const pd = path.join(projectsDir, d.name);
		let entries = [];
		try {
			entries = fs.readdirSync(pd, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.isFile() && e.name.endsWith('.jsonl')) push(path.join(pd, e.name));
			else if (e.isDirectory()) {
				const sub = path.join(pd, e.name, 'subagents');
				let files = [];
				try {
					files = fs.readdirSync(sub).filter(f => f.endsWith('.jsonl'));
				} catch {
					continue;
				}
				for (const f of files) push(path.join(sub, f));
			}
		}
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

const MARKS = [Buffer.from('"type":"image"'), Buffer.from('"type": "image"')];
const CHUNK = 8 * 1024 * 1024;
const MAX_LINE = 160 * 1024 * 1024;

/**
 * Legge le righe complete di `file` da `from` a `size` e chiama `onLine(json, riga, pos)` solo per quelle
 * che contengono un'immagine. Torna l'offset dopo l'ultima riga completa e quante righe ha contato.
 */
function leggiRighe(file, from, size, righeStart, onLine) {
	let fd;
	try {
		fd = fs.openSync(file, 'r');
	} catch {
		return { offset: from, righe: righeStart };
	}
	let pos = from;
	let carry = Buffer.alloc(0);
	let carryStart = from;
	let skipping = false;
	let riga = righeStart;
	let offset = from;
	try {
		while (pos < size) {
			const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
			const n = fs.readSync(fd, buf, 0, buf.length, pos);
			if (n <= 0) break;
			pos += n;
			const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
			const dataStart = carryStart;
			let start = 0;
			for (;;) {
				const nl = data.indexOf(10, start);
				if (nl === -1) break;
				riga++;
				if (!skipping) {
					const line = data.subarray(start, nl);
					if (MARKS.some(m => line.indexOf(m) !== -1)) {
						try {
							onLine(JSON.parse(line.toString('utf8')), riga, dataStart + start);
						} catch {
							// riga non valida: si va avanti
						}
					}
				}
				skipping = false;
				start = nl + 1;
				offset = dataStart + start;
			}
			carry = data.subarray(start);
			carryStart = dataStart + start;
			if (carry.length > MAX_LINE) {
				// Riga enorme: si salta fino al prossimo a capo.
				skipping = true;
				carryStart += carry.length;
				carry = Buffer.alloc(0);
			}
		}
	} finally {
		fs.closeSync(fd);
	}
	return { offset, righe: riga };
}

/** Rilegge la riga che comincia al byte `pos`. */
export function rigaA(file, pos) {
	let fd;
	try {
		fd = fs.openSync(file, 'r');
	} catch {
		return undefined;
	}
	try {
		const parts = [];
		let p = pos;
		let total = 0;
		for (;;) {
			const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
			const n = fs.readSync(fd, buf, 0, buf.length, p);
			if (n <= 0) break;
			const nl = buf.subarray(0, n).indexOf(10);
			if (nl !== -1) {
				parts.push(buf.subarray(0, nl));
				break;
			}
			parts.push(buf.subarray(0, n));
			p += n;
			total += n;
			if (total > MAX_LINE) return undefined;
		}
		return JSON.parse(Buffer.concat(parts).toString('utf8'));
	} catch {
		return undefined;
	} finally {
		fs.closeSync(fd);
	}
}

/** Scansione incrementale: registra le immagini nuove come `da_leggere`. Torna {file, trovate, byte}. */
export function scansiona({ store = openStore(), giorni = 90, projectsDir = PROJECTS_DIR } = {}) {
	ensure(store);
	const since = Date.now() - giorni * 86_400_000;
	let trovate = 0;
	let letti = 0;
	let nFile = 0;
	for (const t of elencaTrascrizioni(projectsDir, since)) {
		const prev = store.get('SELECT size, offset, righe FROM immagini_file WHERE file = ?', t.file);
		let from = prev ? Number(prev.offset) : 0;
		let righe = prev ? Number(prev.righe) : 0;
		if (prev && t.size < Number(prev.offset)) {
			// Trascrizione riscritta piu' corta: si riparte da capo (gli hash evitano i doppioni).
			from = 0;
			righe = 0;
		}
		if (prev && t.size === Number(prev.size) && from === Number(prev.offset)) continue;
		if (t.size <= from) continue;
		nFile++;
		const sessione = sessioneDelFile(t.file);
		const found = [];
		const r = leggiRighe(t.file, from, t.size, righe, (d, riga, pos) => {
			const imgs = immaginiDi(d);
			if (!imgs.length) return;
			const at = Date.parse(d.timestamp || d.attachment?.timestamp || '') || Math.round(t.mtime);
			const sid = typeof d.sessionId === 'string' && d.sessionId ? d.sessionId : sessione;
			for (const im of imgs) found.push({ hash: hashOf(im.data), sid, riga, pos, at, fonte: im.fonte, mime: im.mime });
		});
		letti += r.offset - from;
		store.tx(() => {
			for (const f of found) {
				const ins = store.run(
					'INSERT OR IGNORE INTO immagini(hash, sessionId, file, riga, pos, at, fonte, mime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
					f.hash, f.sid, t.file, f.riga, f.pos, f.at, f.fonte, f.mime,
				);
				trovate += Number(ins.changes || 0);
			}
			store.run(
				'INSERT INTO immagini_file(file, size, offset, righe, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET size = excluded.size, offset = excluded.offset, righe = excluded.righe, at = excluded.at',
				t.file, t.size, r.offset, r.righe, Date.now(),
			);
		});
	}
	return { file: nFile, trovate, byte: letti };
}

// ---- OCR con il Nucleo ------------------------------------------------------------------------

/** Il Nucleo `--cli ocr`, lanciato una volta per giro: una riga JSON dentro, una fuori, una alla volta. */
class Lettore {
	constructor(bin) {
		const taskpolicy = fs.existsSync('/usr/sbin/taskpolicy') ? ['/usr/sbin/taskpolicy', '-b'] : [];
		const nice = fs.existsSync('/usr/bin/nice') ? ['/usr/bin/nice', '-n', '19'] : [];
		const cmd = [...taskpolicy, ...nice, bin, '--cli', 'ocr'];
		this.exit = undefined;
		this.waiting = undefined;
		this.child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
		this.child.stdin.on('error', () => {
			// il Nucleo e' uscito: se ne accorge chi aspetta la risposta
		});
		this.child.stderr.on('data', () => {
			// l'uso o gli errori del Nucleo non servono qui: l'uscita dice gia' tutto
		});
		const done = code => {
			if (this.exit !== undefined) return;
			this.exit = code ?? -1;
			const w = this.waiting;
			this.waiting = undefined;
			w?.reject(Object.assign(new Error(`nucleo uscito con ${this.exit}`), { exit: this.exit }));
		};
		this.child.on('error', () => done(-1));
		this.child.on('exit', code => done(code));
		createInterface({ input: this.child.stdout }).on('line', line => {
			let o;
			try {
				o = JSON.parse(line);
			} catch {
				return;
			}
			if (this.waiting && o && String(o.id) === this.waiting.id) {
				const w = this.waiting;
				this.waiting = undefined;
				w.resolve(o);
			}
		});
	}

	leggi(id, base64, mime, timeoutMs) {
		if (this.exit !== undefined) return Promise.reject(Object.assign(new Error('nucleo uscito'), { exit: this.exit }));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiting = undefined;
				reject(Object.assign(new Error('tempo scaduto'), { timeout: true }));
			}, timeoutMs);
			this.waiting = {
				id: String(id),
				resolve: v => (clearTimeout(timer), resolve(v)),
				reject: e => (clearTimeout(timer), reject(e)),
			};
			this.child.stdin.write(JSON.stringify({ id: String(id), base64, mime }) + '\n');
		});
	}

	chiudi() {
		try {
			this.child.stdin.end();
		} catch {
			// gia' chiuso
		}
		if (this.exit === undefined) {
			const t = setTimeout(() => this.child.kill('SIGKILL'), 2000);
			t.unref();
			this.child.once('exit', () => clearTimeout(t));
		}
	}
}

// ---- ricordo ----------------------------------------------------------------------------------

const utili = s => (String(s).match(/[\p{L}\p{N}]/gu) || []).length;

export function titoloDi(testo) {
	const parole = (String(testo).match(/[\p{L}\p{N}][\p{L}\p{N}'’._-]*/gu) || []).filter(w => /\p{L}/u.test(w) && w.length >= 3);
	return clip(`Schermata: ${parole.slice(0, 8).join(' ') || 'senza parole'}`, 80);
}

const dataLunga = ts => new Date(ts).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });

/** Testo del ricordo: testo riconosciuto ripulito e tagliato, piu' la riga che dice da dove viene. */
export function testoRicordo(pulito, { sessionId, riga, at, fonte }) {
	const corpo = pulito.length > MAX_TESTO ? pulito.slice(0, MAX_TESTO - 1) + '…' : pulito;
	const come = fonte === 'incollata' ? 'incollata' : 'vista da Claude';
	return `${corpo}\n\nDa una schermata ${come} nella sessione ${String(sessionId || '').slice(0, 8)} (riga ${riga}), ${dataLunga(at)}.`;
}

/** Progetto come per le altre memorie: quello della sessione se gia' noto, altrimenti la cartella (worktree compresi). */
function progettoDi(store, sessionId, cwd) {
	const s = sessionId ? store.session(sessionId) : undefined;
	if (s?.projectKey && s.projectKey !== 'home') return { name: s.project, path: s.projectPath, key: s.projectKey };
	return projectOf(cwd) || HOME_PROJECT;
}

// ---- giro -------------------------------------------------------------------------------------

const LOCK = () => path.join(MEM_DIR, 'immagini.lock');

function prendiLock() {
	ensureDir(MEM_DIR);
	try {
		const d = JSON.parse(fs.readFileSync(LOCK(), 'utf8'));
		if (d.pid !== process.pid && Date.now() - d.at < 30 * 60_000) {
			process.kill(d.pid, 0);
			return false;
		}
	} catch {
		// nessun giro in corso (o il processo che lo teneva non c'e' piu')
	}
	fs.writeFileSync(LOCK(), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
	return true;
}

function lasciaLock() {
	try {
		const d = JSON.parse(fs.readFileSync(LOCK(), 'utf8'));
		if (d.pid === process.pid) fs.unlinkSync(LOCK());
	} catch {
		// gia' tolto
	}
}

/**
 * Un giro completo. Torna {lette, nuove, saltate, errori, restano, ms, trovate, nucleo}:
 * lette = immagini passate all'OCR, nuove = ricordi scritti, saltate = meno di 20 caratteri utili
 * (o immagine non piu' trovata nella trascrizione), errori = OCR fallito o scaduto, restano = ancora
 * da leggere, trovate = immagini nuove viste dalla scansione, nucleo = ok | senza-ocr | assente | occupato.
 */
export async function giro({ limite = 40, giorni = 90, riprova = false, store = openStore(), projectsDir = PROJECTS_DIR, timeoutMs = 30_000, timeoutPrimoMs = 120_000 } = {}) {
	const t0 = Date.now();
	ensure(store);
	const r = { lette: 0, nuove: 0, saltate: 0, errori: 0, restano: 0, ms: 0, trovate: 0, nucleo: 'ok' };
	if (!prendiLock()) {
		r.nucleo = 'occupato';
		r.ms = Date.now() - t0;
		return r;
	}
	let lettore;
	try {
		if (riprova) store.run("UPDATE immagini SET stato = 'da_leggere', errore = NULL WHERE stato = 'errore'");
		r.trovate = scansiona({ store, giorni, projectsDir }).trovate;
		const since = Date.now() - giorni * 86_400_000;
		const rows = store.all(
			"SELECT * FROM immagini WHERE stato = 'da_leggere' AND at >= ? ORDER BY (fonte = 'incollata') DESC, at DESC LIMIT ?",
			since, Math.max(0, limite),
		);
		const bin = rows.length ? nucleoPath() : undefined;
		if (rows.length && !bin) r.nucleo = 'assente';
		const segna = (hash, stato, extra = {}) =>
			store.run(
				'UPDATE immagini SET stato = ?, ms = ?, caratteri = ?, errore = ?, memoryId = COALESCE(?, memoryId) WHERE hash = ?',
				stato, extra.ms ?? null, extra.caratteri ?? null, extra.errore ?? null, extra.memoryId ?? null, hash,
			);
		for (const row of bin ? rows : []) {
			const d = rigaA(row.file, Number(row.pos));
			const im = immaginiDi(d).find(i => hashOf(i.data) === row.hash);
			if (!im) {
				segna(row.hash, 'sparita');
				r.saltate++;
				continue;
			}
			if (!lettore) lettore = new Lettore(bin);
			let o;
			try {
				// La prima immagine del giro carica i modelli di Vision: a freddo, sotto carico, misurati 43 s.
				const limite = lettore.fatte ? timeoutMs : Math.max(timeoutMs, timeoutPrimoMs);
				lettore.fatte = (lettore.fatte ?? 0) + 1;
				o = await lettore.leggi(row.hash.slice(0, 12), im.data, im.mime, limite);
			} catch (e) {
				if (e.timeout) {
					segna(row.hash, 'errore', { errore: 'tempo scaduto', ms: timeoutMs });
					r.errori++;
					r.lette++;
					log(`immagini: OCR scaduto dopo ${timeoutMs} ms, giro fermato`);
				} else if (e.exit === 64 || e.exit === 2) {
					r.nucleo = 'senza-ocr';
				} else {
					r.nucleo = `uscito-${e.exit}`;
					log(`immagini: il Nucleo e' uscito con ${e.exit}`);
				}
				break;
			}
			r.lette++;
			if (o.error !== undefined || typeof o.testo !== 'string') {
				segna(row.hash, 'errore', { errore: clip(String(o.error ?? 'risposta senza testo'), 200), ms: Number(o.ms) || null });
				r.errori++;
				continue;
			}
			const pulito = undash(redact(o.testo)).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
			const n = utili(pulito);
			if (n < MIN_UTILI) {
				segna(row.hash, 'vuota', { ms: Number(o.ms) || null, caratteri: n });
				r.saltate++;
				continue;
			}
			const p = progettoDi(store, row.sessionId, d.cwd);
			const memoryId = store.addMemory({
				kind: 'immagine',
				project: p.name,
				projectPath: p.path,
				projectKey: p.key,
				sessionId: row.sessionId,
				title: titoloDi(pulito),
				text: testoRicordo(pulito, { sessionId: row.sessionId, riga: Number(row.riga), at: Number(row.at), fonte: row.fonte }),
				createdAt: Number(row.at),
				origin: 'auto', // come i riassunti: segue la sessione se cambia progetto (il riassunto cancella solo riassunto, fatto, decisione)
			});
			segna(row.hash, 'letta', { ms: Number(o.ms) || null, caratteri: n, memoryId });
			r.nuove++;
		}
		r.restano = Number(store.get("SELECT COUNT(*) AS n FROM immagini WHERE stato = 'da_leggere' AND at >= ?", since)?.n ?? 0);
	} finally {
		lettore?.chiudi();
		lasciaLock();
	}
	r.ms = Date.now() - t0;
	return r;
}

/** Quante immagini ci sono e in che stato (per `status` e per la diagnosi). */
export function riepilogo(store = openStore()) {
	ensure(store);
	const out = {};
	for (const row of store.all('SELECT stato, COUNT(*) AS n FROM immagini GROUP BY stato')) out[row.stato] = Number(row.n);
	return out;
}
