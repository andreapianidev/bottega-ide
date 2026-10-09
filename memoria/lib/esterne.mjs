// Una nota per evento originale, condivisa da Cline e dalle funzioni integrate.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectOf, HOME_PROJECT, BOTTEGA_HOME } from './paths.mjs';
import { redact, clip } from './redact.mjs';
import { MESTIERE, saveMestiere } from './mestiere.mjs';

// I personaggi di Melissa (docs/CONTRATTI.md 9.11): le loro note si trovano con la ricerca ma restano fuori da
// contesto, bacheca, riassunti, grafici, categorie, recent e sessione. Sono chiacchiere, non lavoro.
export const PERSONAGGIO = 'personaggio';
const PERSONAGGI_DIR = path.join(BOTTEGA_HOME, 'personaggi');

/** Chiave di un personaggio, o '' se non e' una chiave valida (finisce in un percorso: niente barre o punti). */
export function chiavePersonaggio(k) {
	const s = String(k ?? '').trim().toLowerCase();
	return /^[a-z0-9_-]{1,40}$/.test(s) ? s : '';
}

const nomi = new Map();
/** Il nome da `~/.bottega/personaggi/<chiave>.json`; se il file manca o non si legge, la chiave con l'iniziale maiuscola. */
export function nomePersonaggio(chiave) {
	const k = chiavePersonaggio(chiave);
	if (!k) return String(chiave || 'Personaggio');
	if (k === 'andrea') return 'Andrea';
	if (nomi.has(k)) return nomi.get(k);
	let nome = k.charAt(0).toUpperCase() + k.slice(1);
	try {
		const j = JSON.parse(fs.readFileSync(path.join(PERSONAGGI_DIR, `${k}.json`), 'utf8'));
		if (typeof j?.nome === 'string' && j.nome.trim()) nome = j.nome.trim().slice(0, 40);
	} catch {
		// file assente o rotto: resta la chiave
	}
	nomi.set(k, nome);
	return nome;
}

/** Chi ha detto una battuta di personaggio, per `cli.mjs personaggio`. Tabella propria, creata qui. */
function ensurePersonaggi(store) {
	if (store._personaggi) return;
	store.db.exec(`CREATE TABLE IF NOT EXISTS personaggi_battute (
		memoryId INTEGER PRIMARY KEY, chiave TEXT NOT NULL, chi TEXT NOT NULL, at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS personaggi_chi ON personaggi_battute(chi, at);
	CREATE INDEX IF NOT EXISTS personaggi_chiave ON personaggi_battute(chiave, at);`);
	store._personaggi = true;
}

export function saveExternal(store, e) {
	// il mestiere dei personaggi ha la sua tabella, non e' una nota (lib/mestiere.mjs)
	if (e.source === MESTIERE) return saveMestiere(store, e);
	const names = { cline: 'Cline', terminale: 'Terminale', melissa: 'Melissa', [PERSONAGGIO]: true };
	if (!names[e.source] || typeof e.text !== 'string' || !Number.isFinite(e.at) || e.at <= 0 || e.at > Date.now() + 60_000) return 0;
	const personaggio = e.source === PERSONAGGIO;
	const chiave = personaggio ? chiavePersonaggio(e.sid) : '';
	if (personaggio && !chiave) return 0;
	const chi = personaggio ? (String(e.who || '').trim().toLowerCase() === 'andrea' ? 'andrea' : chiavePersonaggio(e.who) || chiave) : '';
	const text = redact(e.text).trim().slice(0, 8000);
	if (!text) return 0;
	store.db.exec('CREATE TABLE IF NOT EXISTS external_events (event TEXT PRIMARY KEY, memoryId INTEGER)');
	if (personaggio) ensurePersonaggi(store);
	const sid = personaggio ? chiave : e.sid;
	const event = createHash('sha256').update(`${e.source}:${sid}:${e.id}`).digest('hex');
	const old = store.get('SELECT memoryId FROM external_events WHERE event = ?', event);
	const project = projectOf(e.cwd) || HOME_PROJECT;
	const title = personaggio
		? `${nomePersonaggio(chiave)} · ${nomePersonaggio(chi)}: ${clip(text, 100)}`
		: `${names[e.source]} · ${e.who || 'Attività'}: ${clip(text, 100)}`;
	if (old) {
		store.run('UPDATE memories SET title = ?, text = ? WHERE id = ? AND (title != ? OR text != ?)', title, text, old.memoryId, title, text);
		return 0;
	}
	const id = store.addMemory({ kind: 'nota', origin: e.source, sessionId: `${e.source}:${sid}`, project: project.name, projectPath: project.path, projectKey: project.key, title, text, createdAt: e.at });
	store.run('INSERT INTO external_events VALUES (?, ?)', event, id);
	if (personaggio) store.run('INSERT OR REPLACE INTO personaggi_battute(memoryId, chiave, chi, at) VALUES (?, ?, ?, ?)', id, chiave, chi, e.at);
	return 1;
}

// ---- lettura per i personaggi (cli.mjs personaggio) -----------------------------------------------

// Parole troppo comuni per dire qualcosa su un ricordo: con l'OR dell'FTS troverebbero tutto.
const VUOTE = new Set(
	('che chi non per con una uno gli dei del della delle dello degli nel nella nei sul sulla sui come cosa sei sono hai '
		+ 'ho ha abbiamo avete hanno era ero mio mia tuo tua suo sua mi ti si ci vi lo la le li ma se poi anche ancora gia '
		+ 'piu molto tutto tutti questo questa quello quella qui qua dove quando perche allora dai ok eh ah oh beh sai fai '
		+ 'dimmi senti ecco proprio cosi solo ora adesso oggi').split(' '),
);

function paroleFrase(frase) {
	const out = [];
	for (const m of String(frase || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').matchAll(/[\p{L}\p{N}_]{3,}/gu)) {
		if (!VUOTE.has(m[0]) && !out.includes(m[0])) out.push(m[0]);
		if (out.length >= 12) break;
	}
	return out;
}

/**
 * La memoria di un personaggio (docs/CONTRATTI.md 9.11): `ultime` le sue ultime battute, di qualunque giorno;
 * `andrea` le ultime frasi di Andrea in chiacchierata con lui; `ricordi` fino a 3 note sue o di Andrea con lui che
 * rispondono a `frase` (FTS), senza quelle gia' in `ultime` o in `andrea`.
 */
export function memoriaPersonaggio(store, chiave, { frase = '', limite = 5 } = {}) {
	const k = chiavePersonaggio(chiave);
	if (!k) throw new Error('chiave del personaggio non valida');
	ensurePersonaggi(store);
	const n = Math.max(1, Math.min(50, Math.floor(Number(limite)) || 5));
	const ultimeRows = store.all(
		`SELECT p.memoryId AS id, p.at AS at, m.text AS testo FROM personaggi_battute p JOIN memories m ON m.id = p.memoryId
		 WHERE p.chi = ? ORDER BY p.at DESC, p.memoryId DESC LIMIT ?`,
		k,
		n,
	);
	const ultime = ultimeRows.map(r => ({ at: Number(r.at), testo: r.testo }));
	// Le ultime frasi di Andrea in chiacchierata con lui (09/10/2026, per Avo Agency AI): senza, un personaggio
	// ricorda solo le proprie battute, e «martedi' eri giu'» torna solo se la frase di adesso usa le stesse parole.
	const andreaRows = store.all(
		`SELECT p.memoryId AS id, p.at AS at, m.text AS testo FROM personaggi_battute p JOIN memories m ON m.id = p.memoryId
		 WHERE p.chi = 'andrea' AND p.chiave = ? ORDER BY p.at DESC, p.memoryId DESC LIMIT ?`,
		k,
		n,
	);
	const andrea = andreaRows.map(r => ({ at: Number(r.at), testo: r.testo }));
	const ricordi = [];
	const parole = paroleFrase(frase);
	if (parole.length) {
		const visti = new Set([...ultimeRows, ...andreaRows].map(r => Number(r.id)));
		const testi = new Set([...ultimeRows, ...andreaRows].map(r => norma(r.testo)));
		let rows = [];
		try {
			// CROSS JOIN: prima l'indice FTS, poi le battute. Lasciato al pianificatore, SQLite parte dalle battute e
			// rifa' il MATCH per ognuna: 430 ms su 3000 battute invece di 2.
			rows = store.all(
				`SELECT m.id AS id, p.at AS at, p.chi AS chi, m.text AS testo
				 FROM memories_fts CROSS JOIN personaggi_battute p ON p.memoryId = memories_fts.rowid CROSS JOIN memories m ON m.id = p.memoryId
				 WHERE memories_fts MATCH ? AND m.origin = '${PERSONAGGIO}' AND (p.chi = ? OR (p.chi = 'andrea' AND p.chiave = ?))
				 ORDER BY bm25(memories_fts, 4.0, 1.0, 0.5) LIMIT ?`,
				parole.map(w => `"${w}"*`).join(' OR '),
				k,
				k,
				3 + visti.size + 6,
			);
		} catch {
			rows = [];
		}
		for (const r of rows) {
			const t = norma(r.testo);
			if (visti.has(Number(r.id)) || testi.has(t)) continue;
			visti.add(Number(r.id));
			testi.add(t);
			ricordi.push({ at: Number(r.at), chi: r.chi, testo: r.testo });
			if (ricordi.length >= 3) break;
		}
	}
	return { ultime, andrea, ricordi };
}

const norma = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
