// Vettori contestuali (NLContextualEmbedding, `nucleo --cli embed-ctx`): un modello che legge la frase
// intera invece di sommare le parole. Tabella propria `vettori_ctx`, accanto a `vectors` (embedding di
// frase), cosi' le due ricerche si possono confrontare (memoria/test/valuta-ricerca.mjs) e si tiene
// quella che trova meglio.
import { spawnSync } from 'node:child_process';
import { openStore, blobToVec, cosine } from './store.mjs';
import { nucleoPath } from './engines.mjs';
import { log } from './paths.mjs';

const SCHEMA = 'CREATE TABLE IF NOT EXISTS vettori_ctx (memoryId INTEGER PRIMARY KEY, dim INTEGER NOT NULL, vec BLOB NOT NULL);';
let missing = false;

function ensure(store) {
	if (!store._ctx) {
		store.db.exec(SCHEMA);
		store._ctx = true;
	}
	return store;
}

/** Vettori contestuali, uno per testo; undefined se il Nucleo non c'e' o non li sa fare. */
export function embedCtx(texts, { timeoutMs = 60_000 } = {}) {
	if (!texts.length || missing) return undefined;
	const bin = nucleoPath();
	if (!bin) return undefined;
	const input = texts.map(t => String(t).replace(/\s+/g, ' ').slice(0, 4000)).join('\n') + '\n';
	const r = spawnSync(bin, ['--cli', 'embed-ctx'], { input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
	if (r.error || r.status !== 0) {
		if (r.status === 64 || r.status === 2) missing = true; // Nucleo vecchio o modello assente
		if (r.error) log(`embed-ctx: ${r.error.message}`);
		return undefined;
	}
	try {
		const d = JSON.parse(r.stdout);
		if (Array.isArray(d.vectors) && d.vectors.length === texts.length) return d.vectors;
	} catch {
		// uscita non valida
	}
	return undefined;
}

export function hasCtx(store = openStore()) {
	ensure(store);
	return !!store.get('SELECT 1 AS x FROM vettori_ctx LIMIT 1');
}

/** Riempie i vettori contestuali mancanti, a pezzi. Torna quanti ne ha scritti. */
export function embedCtxPending(store = openStore(), limit = 64) {
	ensure(store);
	const rows = store.all(
		`SELECT m.id, m.title, m.text FROM memories m LEFT JOIN vettori_ctx v ON v.memoryId = m.id
		 WHERE v.memoryId IS NULL AND m.kind != 'prompt' ORDER BY m.createdAt DESC LIMIT ?`,
		limit,
	);
	if (!rows.length) return 0;
	const vecs = embedCtx(rows.map(r => `${r.title || ''}. ${r.text}`));
	if (!vecs) return 0;
	store.tx(() => rows.forEach((r, i) => {
		const f32 = Float32Array.from(vecs[i]);
		store.run('INSERT OR REPLACE INTO vettori_ctx(memoryId, dim, vec) VALUES (?, ?, ?)', Number(r.id), f32.length, new Uint8Array(f32.buffer));
	}));
	return rows.length;
}

/** Somiglianze contestuali della domanda con tutti i ricordi (filtrati per progetto): Map id -> coseno. */
export function ctxScores(query, { progetto, store = openStore() } = {}) {
	ensure(store);
	const qv = embedCtx([query])?.[0];
	if (!qv) return undefined;
	const q = Float32Array.from(qv);
	const f = store.projectFilter(progetto);
	const out = new Map();
	for (const v of store.all(`SELECT v.memoryId, v.vec FROM vettori_ctx v JOIN memories m ON m.id = v.memoryId WHERE 1 = 1${f.sql} LIMIT 20000`, ...f.args)) {
		out.set(Number(v.memoryId), cosine(q, blobToVec(v.vec)));
	}
	return out;
}
