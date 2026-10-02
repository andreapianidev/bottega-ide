// Che tipo di lavoro e' stata una sessione: correzione, funzione, rilascio, ricerca, manutenzione,
// documentazione. La decide Apple Intelligence sul Mac (`nucleo --cli classify`, generazione guidata),
// mai Agnes: e' gratis, privata, e puo' girare in fondo senza fretta.
//
// Tabella propria, creata qui: `categorie(sessionId PK, categoria, motivo, engine, at)`.
// Retroattiva: `classifica` prende i riassunti senza categoria a pezzi da 8, con il Nucleo sotto
// nice e taskpolicy -b (priorita' di fondo: core di efficienza, I/O lento).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { openStore } from './store.mjs';
import { nucleoPath } from './engines.mjs';
import { log } from './paths.mjs';

export const CATEGORIE = ['correzione', 'funzione', 'rilascio', 'ricerca', 'manutenzione', 'documentazione'];

const SCHEMA = `CREATE TABLE IF NOT EXISTS categorie (
	sessionId TEXT PRIMARY KEY, categoria TEXT NOT NULL, motivo TEXT, engine TEXT, at INTEGER NOT NULL
);`;

function ensure(store) {
	if (!store._categorie) {
		store.db.exec(SCHEMA);
		store._categorie = true;
	}
	return store;
}

/** Sessioni con un riassunto e senza categoria, dalle piu' recenti. */
export function daClassificare(store = openStore(), limite = 8) {
	ensure(store);
	return store.all(
		`SELECT m.sessionId AS sessionId, m.title AS title, m.text AS text FROM memories m
		 LEFT JOIN categorie c ON c.sessionId = m.sessionId
		 WHERE m.kind = 'riassunto' AND m.sessionId IS NOT NULL AND m.sessionId != '' AND c.sessionId IS NULL
		 GROUP BY m.sessionId ORDER BY MAX(m.createdAt) DESC LIMIT ?`,
		limite,
	);
}

/** Lancia il Nucleo a bassa priorita'. Righe JSON {id, text} dentro, {id, categoria, motivo} fuori. */
export function classificaTesti(items, { timeoutMs = 180_000 } = {}) {
	const bin = nucleoPath();
	if (!bin || !items.length) return { code: -1, out: [] };
	const input = items.map(i => JSON.stringify({ id: i.id, text: String(i.text).slice(0, 6000) })).join('\n') + '\n';
	const taskpolicy = fs.existsSync('/usr/sbin/taskpolicy') ? ['/usr/sbin/taskpolicy', '-b'] : [];
	const cmd = [...taskpolicy, '/usr/bin/nice', '-n', '19', bin, '--cli', 'classify'];
	const r = spawnSync(cmd[0], cmd.slice(1), { input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
	if (r.error) {
		log(`classify: ${r.error.message}`);
		return { code: -1, out: [] };
	}
	const out = [];
	for (const line of (r.stdout || '').split('\n')) {
		if (!line.trim()) continue;
		try {
			const o = JSON.parse(line);
			if (o && o.id !== undefined && CATEGORIE.includes(o.categoria)) out.push(o);
		} catch {
			// riga non valida: la sessione resta da classificare
		}
	}
	return { code: r.status ?? -1, out };
}

/** Un giro di classificazione. Torna quante sessioni ha classificato; 0 se Apple Intelligence non c'e'. */
export function classifica({ limite = 8, store = openStore() } = {}) {
	ensure(store);
	const rows = daClassificare(store, limite);
	if (!rows.length) return { fatte: 0, restano: 0, code: 0 };
	const { code, out } = classificaTesti(rows.map(r => ({ id: r.sessionId, text: `${r.title || ''}\n${r.text || ''}` })));
	const now = Date.now();
	store.tx(() => {
		for (const o of out) {
			store.run(
				'INSERT OR REPLACE INTO categorie(sessionId, categoria, motivo, engine, at) VALUES (?, ?, ?, ?, ?)',
				String(o.id), o.categoria, String(o.motivo || '').slice(0, 200), 'apple', now,
			);
		}
	});
	const restano = Number(store.get(
		`SELECT COUNT(DISTINCT m.sessionId) AS n FROM memories m LEFT JOIN categorie c ON c.sessionId = m.sessionId
		 WHERE m.kind = 'riassunto' AND m.sessionId IS NOT NULL AND m.sessionId != '' AND c.sessionId IS NULL`,
	)?.n ?? 0);
	return { fatte: out.length, restano, code };
}

/** Tutte, a giri, fino a esaurimento o al primo giro a vuoto (Apple Intelligence assente o in errore). */
export function classificaTutte({ store = openStore(), massimo = 2000 } = {}) {
	let totale = 0;
	for (;;) {
		const r = classifica({ store });
		totale += r.fatte;
		if (!r.fatte || !r.restano || totale >= massimo) return { fatte: totale, restano: r.restano, code: r.code };
	}
}

/** Mappa sessione -> categoria, facoltativamente solo per le sessioni attive negli ultimi N giorni. */
export function mappa({ giorni, store = openStore() } = {}) {
	ensure(store);
	const since = giorni ? Date.now() - Number(giorni) * 86_400_000 : 0;
	const rows = store.all(
		`SELECT c.sessionId, c.categoria FROM categorie c LEFT JOIN sessions s ON s.id = c.sessionId
		 WHERE ? = 0 OR COALESCE(s.lastActivity, c.at) >= ?`,
		since, since,
	);
	const out = {};
	for (const r of rows) out[r.sessionId] = r.categoria;
	return out;
}

export function categoriaDi(sessionId, store = openStore()) {
	ensure(store);
	return store.get('SELECT categoria, motivo FROM categorie WHERE sessionId = ?', sessionId);
}
