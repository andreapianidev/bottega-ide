// Il database della Memoria: SQLite di Node (node:sqlite) con indice FTS5.
// Solo per il processo staccato, la CLI e il server MCP: gli hook non lo aprono mai.
import fs from 'node:fs';
import { DB_PATH, MEM_DIR, ensureDir } from './paths.mjs';

// node:sqlite stampa un avviso "sperimentale" a ogni avvio: non deve finire nell'output di nessuno.
process.removeAllListeners('warning');
const { DatabaseSync } = await import('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	project TEXT, projectPath TEXT, projectKey TEXT,
	cwd TEXT, transcriptPath TEXT, title TEXT,
	startedAt INTEGER, lastActivity INTEGER, endedAt INTEGER,
	prompts INTEGER NOT NULL DEFAULT 0, tools INTEGER NOT NULL DEFAULT 0, obsCount INTEGER NOT NULL DEFAULT 0,
	summarizedAt INTEGER, summarizedObs INTEGER NOT NULL DEFAULT 0, summarizedSize INTEGER NOT NULL DEFAULT 0,
	engine TEXT, attempts INTEGER NOT NULL DEFAULT 0, lastError TEXT
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(projectKey, lastActivity);
CREATE TABLE IF NOT EXISTS observations (
	id INTEGER PRIMARY KEY,
	sessionId TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
	tool TEXT, files TEXT, input TEXT, result TEXT
);
CREATE INDEX IF NOT EXISTS observations_session ON observations(sessionId, at);
CREATE TABLE IF NOT EXISTS memories (
	id INTEGER PRIMARY KEY,
	kind TEXT NOT NULL,
	project TEXT, projectPath TEXT, projectKey TEXT,
	sessionId TEXT, title TEXT, text TEXT NOT NULL,
	createdAt INTEGER NOT NULL,
	origin TEXT NOT NULL DEFAULT 'auto'
);
CREATE INDEX IF NOT EXISTS memories_project ON memories(projectKey, createdAt);
CREATE INDEX IF NOT EXISTS memories_session ON memories(sessionId);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
	title, text, project,
	content='memories', content_rowid='id',
	tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
	INSERT INTO memories_fts(rowid, title, text, project) VALUES (new.id, new.title, new.text, new.project);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
	INSERT INTO memories_fts(memories_fts, rowid, title, text, project) VALUES ('delete', old.id, old.title, old.text, old.project);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
	INSERT INTO memories_fts(memories_fts, rowid, title, text, project) VALUES ('delete', old.id, old.title, old.text, old.project);
	INSERT INTO memories_fts(rowid, title, text, project) VALUES (new.id, new.title, new.text, new.project);
END;
CREATE TABLE IF NOT EXISTS vectors (memoryId INTEGER PRIMARY KEY, dim INTEGER NOT NULL, vec BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS queue (sessionId TEXT PRIMARY KEY, reason TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS spool_offsets (file TEXT PRIMARY KEY, offset INTEGER NOT NULL, at INTEGER);
CREATE TABLE IF NOT EXISTS agnes_calls (at INTEGER NOT NULL);
`;

export class Store {
	constructor(file = DB_PATH) {
		ensureDir(MEM_DIR);
		const fresh = !fs.existsSync(file);
		this.db = new DatabaseSync(file);
		if (fresh) {
			try {
				fs.chmodSync(file, 0o600);
			} catch {
				// permessi non modificabili: resta la cartella a 700
			}
		}
		this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=OFF;');
		this.db.exec(SCHEMA);
		this.cache = new Map();
	}

	q(sql) {
		let st = this.cache.get(sql);
		if (!st) {
			st = this.db.prepare(sql);
			this.cache.set(sql, st);
		}
		return st;
	}
	all(sql, ...a) {
		return this.q(sql).all(...a);
	}
	get(sql, ...a) {
		return this.q(sql).get(...a);
	}
	run(sql, ...a) {
		return this.q(sql).run(...a);
	}

	/** Transazione con BEGIN IMMEDIATE: piu' processi (worker, MCP, CLI) possono scrivere insieme. */
	tx(fn) {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const r = fn();
			this.db.exec('COMMIT');
			return r;
		} catch (e) {
			try {
				this.db.exec('ROLLBACK');
			} catch {
				// gia' annullata
			}
			throw e;
		}
	}

	meta(k, v) {
		if (v === undefined) return this.get('SELECT v FROM meta WHERE k = ?', k)?.v;
		this.run('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));
	}

	close() {
		try {
			this.db.close();
		} catch {
			// gia' chiuso
		}
	}

	// ---- sessioni -------------------------------------------------------------------------

	session(id) {
		return this.get('SELECT * FROM sessions WHERE id = ?', id);
	}

	/** Sessione per id completo o per prefisso (almeno 6 caratteri). */
	findSession(idOrPrefix) {
		const exact = this.session(idOrPrefix);
		if (exact) return exact;
		if (String(idOrPrefix).length < 6) return undefined;
		return this.get('SELECT * FROM sessions WHERE id LIKE ? ORDER BY lastActivity DESC LIMIT 1', `${idOrPrefix}%`);
	}

	upsertSession(s) {
		this.run(
			`INSERT INTO sessions(id, cwd, transcriptPath, startedAt, lastActivity)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
				cwd = COALESCE(sessions.cwd, excluded.cwd),
				transcriptPath = COALESCE(excluded.transcriptPath, sessions.transcriptPath),
				startedAt = MIN(COALESCE(sessions.startedAt, excluded.startedAt), excluded.startedAt),
				lastActivity = MAX(COALESCE(sessions.lastActivity, 0), excluded.lastActivity)`,
			s.id,
			s.cwd ?? null,
			s.transcriptPath ?? null,
			s.at,
			s.at,
		);
	}

	setProject(sessionId, project) {
		this.run('UPDATE sessions SET project = ?, projectPath = ?, projectKey = ? WHERE id = ?', project.name, project.path, project.key, sessionId);
		this.run('UPDATE memories SET project = ?, projectPath = ?, projectKey = ? WHERE sessionId = ? AND origin = ?', project.name, project.path, project.key, sessionId, 'auto');
	}

	// ---- memorie --------------------------------------------------------------------------

	addMemory(m) {
		const r = this.run(
			'INSERT INTO memories(kind, project, projectPath, projectKey, sessionId, title, text, createdAt, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
			m.kind,
			m.project ?? null,
			m.projectPath ?? null,
			m.projectKey ?? null,
			m.sessionId ?? null,
			m.title ?? null,
			m.text,
			m.createdAt ?? Date.now(),
			m.origin ?? 'auto',
		);
		return Number(r.lastInsertRowid);
	}

	projectFilter(progetto) {
		if (!progetto) return { sql: '', args: [] };
		return { sql: ' AND (lower(m.project) = lower(?) OR m.projectKey = ?)', args: [progetto, progetto] };
	}

	recent({ progetto, limite = 10, kinds = ['riassunto', 'fatto', 'decisione', 'nota'] } = {}) {
		const f = this.projectFilter(progetto);
		const ks = kinds.map(() => '?').join(',');
		return this.all(
			// mai le note dei personaggi di Melissa: si trovano solo con la ricerca (docs/CONTRATTI.md 9.11)
			`SELECT m.* FROM memories m WHERE m.kind IN (${ks}) AND m.origin != 'personaggio'${f.sql} ORDER BY m.createdAt DESC, m.id DESC LIMIT ?`,
			...kinds,
			...f.args,
			Math.max(1, Math.min(200, limite)),
		).map(toItem);
	}

	/** Ricerca a parole (FTS5, bm25). Restituisce anche il punteggio grezzo per l'ibrido. */
	ftsSearch(query, { progetto, limite = 10 } = {}) {
		const words = [...String(query).toLowerCase().matchAll(/[\p{L}\p{N}_]{2,}/gu)].map(m => m[0]).slice(0, 12);
		if (!words.length) return [];
		const f = this.projectFilter(progetto);
		const run = joiner => {
			const match = words.map(w => `"${w.replace(/"/g, '')}"*`).join(joiner);
			try {
				return this.all(
					`SELECT m.*, bm25(memories_fts, 4.0, 1.0, 0.5) AS rank
					 FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
					 WHERE memories_fts MATCH ?${f.sql}
					 ORDER BY rank LIMIT ?`,
					match,
					...f.args,
					limite,
				);
			} catch {
				return [];
			}
		};
		let rows = run(' AND ');
		if (rows.length < Math.min(3, limite) && words.length > 1) {
			const seen = new Set(rows.map(r => r.id));
			rows = rows.concat(run(' OR ').filter(r => !seen.has(r.id)));
		}
		return rows;
	}

	vectorsFor(progetto) {
		const f = this.projectFilter(progetto);
		return this.all(`SELECT v.memoryId, v.dim, v.vec FROM vectors v JOIN memories m ON m.id = v.memoryId WHERE 1 = 1${f.sql} ORDER BY m.createdAt DESC LIMIT 20000`, ...f.args);
	}

	hasVectors() {
		return !!this.get('SELECT 1 AS x FROM vectors LIMIT 1');
	}

	memory(id) {
		const r = this.get('SELECT * FROM memories m WHERE m.id = ?', id);
		return r ? toItem(r) : undefined;
	}

	saveVector(memoryId, vec) {
		const f32 = Float32Array.from(vec);
		this.run('INSERT OR REPLACE INTO vectors(memoryId, dim, vec) VALUES (?, ?, ?)', memoryId, f32.length, new Uint8Array(f32.buffer));
	}

	memoriesWithoutVector(limit = 64) {
		return this.all(
			`SELECT m.id, m.title, m.text FROM memories m LEFT JOIN vectors v ON v.memoryId = m.id
			 WHERE v.memoryId IS NULL AND m.kind != 'prompt' ORDER BY m.createdAt DESC LIMIT ?`,
			limit,
		);
	}
}

export function toItem(r) {
	return {
		id: Number(r.id),
		kind: r.kind,
		project: r.project ?? 'home',
		projectPath: r.projectPath ?? '',
		sessionId: r.sessionId ?? '',
		title: r.title ?? '',
		text: r.text ?? '',
		createdAt: Number(r.createdAt),
		...(r.score !== undefined ? { score: r.score } : {}),
	};
}

export function blobToVec(blob) {
	const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
	return new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
}

export function cosine(a, b) {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

let shared;
export function openStore() {
	if (!shared) shared = new Store();
	return shared;
}
