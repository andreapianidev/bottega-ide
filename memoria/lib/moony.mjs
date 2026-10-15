// Una memoria sola (15/10/2026). Moony (Melissa) parla dal telefono, dalla casa e da Avo anche a Mac
// addormentato, quindi conversazioni, fatti, eventi e riassunti nascono nella meta' sempre accesa di
// bottega-mem: memory.db di `segretaria` sulla VM1. Qui li si porta nel database della Memoria e non si
// cancellano mai, anche se sulla VM spariscono; in cambio la VM riceve decisioni, fatti, riassunti e note
// del lavoro, che Moony ritrova nella sua ricerca. Contratto: docs/CONTRATTI.md, "Memoria e Moony".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME_PROJECT } from './paths.mjs';
import { saveExternal, PERSONAGGIO, chiavePersonaggio } from './esterne.mjs';
import { redact, clip } from './redact.mjs';

const SECRETS = process.env.BOTTEGA_SEGRETARIA_ENV || path.join(os.homedir(), '.secrets', 'segretaria-bridge.env');
const PAGINE = 20; // pagine da 500 righe per tabella a ogni giro: il resto al giro dopo
const FINESTRA_MS = 5 * 60_000; // la stessa frase entro 5 minuti e' la stessa battuta
const TIPI_LAVORO = ['fatto', 'decisione', 'riassunto', 'nota'];
const ORIGINI_LAVORO = ['auto', 'manuale'];

/** URL e gettone di segretaria, dallo stesso file che usa la continuita' della Bottega. */
export function configMoony(file = SECRETS) {
	const env = {};
	try {
		for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
			const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
			if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
		}
	} catch {
		return null;
	}
	let url = '';
	try {
		const u = new URL(env.SEGRETARIA_URL ?? '');
		if (['http:', 'https:'].includes(u.protocol)) url = u.toString().replace(/\/$/, '');
	} catch {
		// indirizzo assente o non valido
	}
	return url && env.SEGRETARIA_BRIDGE_TOKEN ? { url, token: env.SEGRETARIA_BRIDGE_TOKEN } : null;
}

function ensure(store) {
	if (store._moony) return;
	// Copia fedele delle righe della VM, come JSON: lo schema di memory.db puo' crescere senza toccare qui.
	store.db.exec(`CREATE TABLE IF NOT EXISTS moony_messages (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, row TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS moony_facts (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, row TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS moony_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, row TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS moony_summaries (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, row TEXT NOT NULL);
	CREATE INDEX IF NOT EXISTS moony_events_at ON moony_events(at);
	CREATE TABLE IF NOT EXISTS moony_memorie (chiave TEXT PRIMARY KEY, memoryId INTEGER NOT NULL);`);
	store._moony = true;
}

// Chiave di una frase per riconoscere la stessa battuta salvata da due parti: Avo la manda sia alla VM sia
// alla Bottega, e le due copie differiscono per tag di voce, punteggiatura o coda tagliata (59 doppioni al
// primo giro con il confronto esatto). Bastano le prime 50 lettere e cifre.
const norma = s =>
	redact(String(s || ''))
		.toLowerCase()
		.replace(/\[[^\]]*\]/g, '')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^\p{L}\p{N}]+/gu, '')
		.slice(0, 50);
const ms = secondi => Math.round(Number(secondi) * 1000);

/** Fatti e riassunti di Moony diventano memorie cercabili; una per riga della VM, aggiornata se cambia. */
function memoria(store, chiave, m) {
	const old = store.get('SELECT memoryId FROM moony_memorie WHERE chiave = ?', chiave);
	if (old) {
		store.run('UPDATE memories SET title = ?, text = ? WHERE id = ? AND (title != ? OR text != ?)', m.title, m.text, old.memoryId, m.title, m.text);
		return 0;
	}
	const id = store.addMemory({ ...m, origin: 'moony', project: HOME_PROJECT.name, projectPath: HOME_PROJECT.path, projectKey: HOME_PROJECT.key });
	store.run('INSERT INTO moony_memorie VALUES (?, ?)', chiave, id);
	return 1;
}

function fatto(store, f) {
	const text = redact(String(f.content || '')).trim();
	if (!text) return 0;
	const stato = f.status && f.status !== 'active' ? ` (stato sulla VM: ${f.status})` : '';
	return memoria(store, `fatto:${f.id}`, {
		kind: 'fatto',
		sessionId: 'moony:fatti',
		title: `Moony · ${f.category || 'fatto'}: ${clip(text, 100)}`,
		text: text + stato,
		createdAt: ms(f.created_at) || Date.now(),
	});
}

function riassunto(store, s) {
	const text = redact(String(s.content || '')).trim();
	if (!text) return 0;
	const cosa = s.scope === 'giornata' ? 'la giornata' : 'la conversazione';
	return memoria(store, `riassunto:${s.id}`, {
		kind: 'nota',
		sessionId: 'moony:riassunti',
		title: `Moony · ${cosa}: ${clip(text, 100)}`,
		text,
		createdAt: ms(s.covers_to || s.created_at) || Date.now(),
	});
}

/** La Bottega salva gia' da se' le battute dette sul Mac: la stessa frase vicina nel tempo non si ripete. */
function giaDetta(store, sql, args, at, text) {
	try {
		const t = norma(text);
		return !!t && store.all(sql, ...args, at - FINESTRA_MS, at + FINESTRA_MS).some(r => norma(r.text) === t);
	} catch {
		return false; // tabella dei personaggi non ancora creata
	}
}

function battuta(store, m) {
	if (m.role !== 'user' && m.role !== 'assistant') return 0;
	const at = ms(m.created_at);
	const text = String(m.content || '');
	const persona = chiavePersonaggio(m.persona);
	const chi = chiavePersonaggio(m.speaker);
	if (persona) {
		if (chi && giaDetta(store, `SELECT m.text FROM personaggi_battute p JOIN memories m ON m.id = p.memoryId
			WHERE p.chiave = ? AND p.chi = ? AND p.at BETWEEN ? AND ?`, [persona, chi], at, text)) return 0;
		return saveExternal(store, { source: PERSONAGGIO, sid: persona, who: chi, recipient: m.recipient, id: `vm-${m.id}`, event_id: m.event_id || `vm-${m.id}`, surface: `vm:${m.source}`, at, text });
	}
	if (giaDetta(store, `SELECT text FROM memories WHERE origin = 'melissa' AND createdAt BETWEEN ? AND ?`, [], at, text)) return 0;
	return saveExternal(store, { source: 'melissa', sid: m.conversation_id || 'default', id: `vm-${m.id}`, who: m.role === 'user' ? 'Andrea' : 'Moony', at, text });
}

async function chiedi(cfg, percorso, opzioni = {}) {
	const r = await fetch(cfg.url + percorso, {
		...opzioni,
		headers: { Authorization: `Bearer ${cfg.token}`, ...(opzioni.body ? { 'Content-Type': 'application/json' } : {}) },
		signal: AbortSignal.timeout(10_000),
	});
	if (!r.ok) throw new Error(`segretaria ${percorso.split('?')[0]}: HTTP ${r.status}`);
	return r.json();
}

/** Dalla VM al Mac: la copia fedele e le memorie cercabili. Riprende dai cursori in `meta`. */
async function scarica(store, cfg) {
	const out = { messaggi: 0, fatti: 0, eventi: 0, riassunti: 0, nuove: 0 };
	for (let pagina = 0; pagina < PAGINE; pagina++) {
		const c = {
			messages: Number(store.meta('moony_messaggi') || 0),
			facts: Number(store.meta('moony_fatti_at') || 0),
			facts_id: Number(store.meta('moony_fatti_id') || 0),
			events: Number(store.meta('moony_eventi') || 0),
			summaries: Number(store.meta('moony_riassunti') || 0),
		};
		const d = await chiedi(cfg, '/bottega/export?' + new URLSearchParams({ ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v)])), limit: '500' }));
		store.tx(() => {
			for (const m of d.messages) {
				store.run('INSERT OR REPLACE INTO moony_messages VALUES (?, ?, ?)', m.id, ms(m.created_at), JSON.stringify(m));
				out.nuove += battuta(store, m);
				out.messaggi++;
				store.meta('moony_messaggi', m.id);
			}
			for (const f of d.facts) {
				store.run('INSERT OR REPLACE INTO moony_facts VALUES (?, ?, ?)', f.id, ms(f.updated_at), JSON.stringify(f));
				out.nuove += fatto(store, f);
				out.fatti++;
				store.meta('moony_fatti_at', f.updated_at);
				store.meta('moony_fatti_id', f.id);
			}
			for (const e of d.events) {
				store.run('INSERT OR REPLACE INTO moony_events VALUES (?, ?, ?)', e.id, ms(e.created_at), JSON.stringify(e));
				out.eventi++;
				store.meta('moony_eventi', e.id);
			}
			for (const s of d.summaries) {
				store.run('INSERT OR REPLACE INTO moony_summaries VALUES (?, ?, ?)', s.id, ms(s.created_at), JSON.stringify(s));
				out.nuove += riassunto(store, s);
				out.riassunti++;
				store.meta('moony_riassunti', s.id);
			}
		});
		if (!Object.values(d.more || {}).some(Boolean)) break;
	}
	return out;
}

/** Dal Mac alla VM: la memoria del lavoro, perche' Moony sappia cosa e' stato deciso e fatto. */
async function manda(store, cfg) {
	let mandate = 0;
	for (let giro = 0; giro < 10; giro++) {
		const dopo = Number(store.meta('moony_mandate') || 0);
		const items = store.all(
			`SELECT id, kind, project, title, text, createdAt, origin FROM memories
			 WHERE id > ? AND kind IN (${TIPI_LAVORO.map(() => '?').join(',')}) AND origin IN (${ORIGINI_LAVORO.map(() => '?').join(',')})
			 ORDER BY id LIMIT 200`,
			dopo,
			...TIPI_LAVORO,
			...ORIGINI_LAVORO,
		).map(r => ({ ...r, id: Number(r.id), createdAt: Number(r.createdAt) }));
		if (!items.length) break;
		await chiedi(cfg, '/bottega/memories', { method: 'POST', body: JSON.stringify({ items }) });
		store.meta('moony_mandate', items[items.length - 1].id);
		mandate += items.length;
	}
	return mandate;
}

/** Un giro completo. Non lancia mai: a VM irraggiungibile restituisce l'errore e riprova al giro dopo. */
export async function syncMoony(store, { cfg = configMoony() } = {}) {
	if (!cfg) return { ok: false, errore: 'configurazione assente (~/.secrets/segretaria-bridge.env)' };
	ensure(store);
	const esito = { ok: true };
	try {
		esito.scaricate = await scarica(store, cfg);
		esito.mandate = await manda(store, cfg);
	} catch (e) {
		esito.ok = false;
		esito.errore = String(e?.message || e);
	}
	store.meta('moony_ultimo', JSON.stringify({ at: Date.now(), ok: esito.ok, ...(esito.errore ? { errore: esito.errore } : {}) }));
	return esito;
}

/** Quanto di Moony c'e' in bottega-mem, e com'e' andato l'ultimo giro. */
export function statoMoony(store) {
	ensure(store);
	const n = t => Number(store.get(`SELECT COUNT(*) AS n FROM ${t}`).n);
	let ultimo = null;
	try {
		ultimo = JSON.parse(store.meta('moony_ultimo') || 'null');
	} catch {
		// valore rovinato: lo riscrive il prossimo giro
	}
	return {
		copia: { messaggi: n('moony_messages'), fatti: n('moony_facts'), eventi: n('moony_events'), riassunti: n('moony_summaries') },
		memorie: n('moony_memorie'),
		mandateFinoA: Number(store.meta('moony_mandate') || 0),
		ultimo,
	};
}
