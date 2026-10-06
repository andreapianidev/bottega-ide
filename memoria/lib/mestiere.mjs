// Ognuno ha la memoria del suo mestiere (docs/CONTRATTI.md 9.11): Elliot gli incidenti di sicurezza, Krista gli
// impegni di Andrea, Darlene le forzature di Claude e degli agenti. Una tabella propria, `mestiere_voci`, scritta in
// due modi, tutti e due fuori dagli hook (che restano sotto i 150 ms e scrivono solo lo spool):
//   - dall'ingest, guardando le azioni gia' nello spool (Bash, Read): chiavi lette, push forzati, reset --hard, rm -rf,
//     un segreto nel diff, test saltati. Mai la riga di comando intera: solo il nome della cosa e il file.
//   - da eventi esterni `source: "mestiere"` (la barra): gli impegni estratti da DeepSeek, le regole violate.
// Chi ha quale mestiere lo dice il campo `mestiere` dei file in ~/.bottega/personaggi. Si legge con
// `cli.mjs personaggio <chiave>`, campo `mestiere`.
import fs from 'node:fs';
import path from 'node:path';
import { projectOf, HOME_PROJECT, BOTTEGA_HOME } from './paths.mjs';
import { redact, clip } from './redact.mjs';

export const MESTIERE = 'mestiere';
/** Il mestiere e il tipo della sua voce. */
export const TIPI = { incidenti: 'incidente', impegni: 'impegno', forzature: 'forzatura' };
const TIPO_MESTIERE = Object.fromEntries(Object.entries(TIPI).map(([m, t]) => [t, m]));

let chi = null;
let letto = 0;
/** Chi ha quel mestiere, dai file dei personaggi (riletti al piu' una volta al minuto: il server MCP vive a lungo, e la
 *  Bottega li ricopia al suo avvio); '' se nessuno. */
export function chiDelMestiere(mestiere, dir = path.join(BOTTEGA_HOME, 'personaggi')) {
	if (!chi || Date.now() - letto > 60_000) {
		chi = {};
		letto = Date.now();
		let nomi = [];
		try {
			nomi = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort();
		} catch {
			// niente cartella: nessuno ha un mestiere
		}
		const letti = [];
		for (const n of nomi) {
			try {
				const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
				if (typeof j?.chiave === 'string' && /^[a-z]+$/.test(j.chiave) && TIPI[j?.mestiere]) letti.push({ k: j.chiave, m: j.mestiere, o: Number.isFinite(j.ordine) ? j.ordine : 99 });
			} catch {
				// file rotto: si salta
			}
		}
		for (const x of letti.sort((a, b) => a.o - b.o)) if (!chi[x.m]) chi[x.m] = x.k;
	}
	return chi[mestiere] || '';
}

/** Solo per le prove: rilegge i file dei personaggi. */
export function dimenticaMestieri() {
	chi = null;
}

function ensure(store) {
	if (store._mestiere) return;
	store.db.exec(`CREATE TABLE IF NOT EXISTS mestiere_voci (
		id TEXT PRIMARY KEY, chiave TEXT NOT NULL, tipo TEXT NOT NULL, cosa TEXT NOT NULL, at INTEGER NOT NULL,
		progetto TEXT NOT NULL, testo TEXT NOT NULL, stato TEXT NOT NULL DEFAULT '', scadenza INTEGER
	);
	CREATE INDEX IF NOT EXISTS mestiere_chiave ON mestiere_voci(chiave, tipo, at);`);
	store._mestiere = true;
}

function salva(store, v) {
	ensure(store);
	store.run(
		`INSERT INTO mestiere_voci(id, chiave, tipo, cosa, at, progetto, testo, stato, scadenza) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET testo = excluded.testo, stato = excluded.stato, scadenza = excluded.scadenza`,
		v.id, v.chiave, v.tipo, v.cosa, v.at, v.progetto, v.testo, v.stato || '', v.scadenza ?? null,
	);
	return 1;
}

/**
 * Un evento esterno `source: "mestiere"` dalla barra: `{sid: chiave, id, tipo, cosa?, text, stato?, scadenza?, cwd, at}`.
 * Lo stesso `id` riscritto aggiorna testo, stato e scadenza (un impegno che diventa fatto).
 */
export function saveMestiere(store, e) {
	const tipo = String(e.tipo || '');
	if (!TIPO_MESTIERE[tipo] || !Number.isFinite(e.at) || e.at <= 0 || e.at > Date.now() + 60_000) return 0;
	const chiave = String(e.sid || '').trim().toLowerCase();
	if (!/^[a-z]{1,40}$/.test(chiave) || typeof e.text !== 'string' || typeof e.id !== 'string' || !e.id) return 0;
	const testo = clip(redact(e.text).replace(/\s+/g, ' ').trim(), 240);
	if (!testo) return 0;
	const progetto = (projectOf(e.cwd) || HOME_PROJECT).name;
	const stato = tipo === 'impegno' ? (e.stato === 'fatto' ? 'fatto' : 'aperto') : '';
	const scadenza = Number.isFinite(e.scadenza) ? e.scadenza : null;
	const cosa = /^[a-z-]{1,40}$/.test(String(e.cosa || '')) ? e.cosa : tipo;
	return salva(store, { id: `${chiave}:${e.id}`.slice(0, 200), chiave, tipo, cosa, at: e.at, progetto, testo, stato, scadenza });
}

// I segni nelle azioni: [cosa, schema, frase]. Si guarda solo il comando (dopo l'ultimo " | ", che separa la
// descrizione), e per Read il percorso del file.
const FILE_SEGRETO = /(?:^|\/)(?:\.env(?:\.[\w-]+)?|id_(?:rsa|ed25519|ecdsa)|[\w.-]+\.(?:pem|p12|jks|keystore|p8)|credentials(?:\.json)?|service-account[\w.-]*\.json)$|\/\.secrets\//i;
const LEGGE = /\b(?:cat|less|more|head|tail|grep|rg|source|cp|scp|open|bat|strings|xxd)\b/;
const DISTRUTTIVI = [
	['push-forzato', /\bgit\s+push\b[^|;&]*(?:\s-f\b|--force(?:-with-lease)?\b)/, 'un push forzato'],
	['reset-hard', /\bgit\s+reset\b[^|;&]*--hard\b/, 'un git reset --hard'],
	['rm-rf', /\brm\s+-[a-z]*r[a-z]*f[a-z]*\b|\brm\s+-[a-z]*f[a-z]*r[a-z]*\b/, 'un rm -rf'],
	['clean-forzato', /\bgit\s+clean\b[^|;&]*-[a-z]*f/, 'un git clean forzato'],
	['drop', /\bdrop\s+(?:table|database)\b/i, 'un drop di tabella o database'],
];
const SOLO_FORZATURE = [
	['no-verify', /--no-verify\b/, 'controlli saltati con --no-verify'],
	['test-saltati', /--skip-?tests?\b|-DskipTests\b|--no-tests?\b|\bSKIP_TESTS?=|--passWithNoTests\b|-x\s+test\b/i, 'test saltati'],
];
const SEGRETO_NASCOSTO = /\[(?:chiave nascosta|token nascosto|chiave privata nascosta)\]/;

/**
 * Le voci che un'azione dello spool (`ev: "tool"`) porta ai mestieri: incidenti per chi ha `incidenti` (Elliot),
 * forzature per chi ha `forzature` (Darlene). Una voce per cosa e per azione; niente se nessuno ha il mestiere.
 */
export function vociDaAzione(e) {
	const tool = String(e.tool || '');
	const input = String(e.input || '');
	const comando = tool === 'Bash' ? input.split(' | ').pop() : '';
	const voci = [];
	const incidente = (cosa, frase) => voci.push({ mestiere: 'incidenti', cosa, frase });
	const forzatura = (cosa, frase) => voci.push({ mestiere: 'forzature', cosa, frase });
	if (tool === 'Read' && FILE_SEGRETO.test(input)) incidente('chiave-letta', `una chiave letta (${path.basename(input)})`);
	if (comando) {
		const file = comando.split(/\s+/).find(p => FILE_SEGRETO.test(p.replace(/^['"]|['"]$/g, '')));
		if (file && LEGGE.test(comando)) incidente('chiave-letta', `una chiave letta (${path.basename(file.replace(/^['"]|['"]$/g, ''))})`);
		if (/\bgit\s+(?:diff|commit|add|push|show)\b/.test(comando) && SEGRETO_NASCOSTO.test(String(e.result || ''))) incidente('segreto-nel-diff', 'un segreto nel diff');
		for (const [cosa, re, frase] of DISTRUTTIVI) {
			if (!re.test(comando)) continue;
			incidente(cosa, frase);
			forzatura(cosa, frase);
		}
		for (const [cosa, re, frase] of SOLO_FORZATURE) if (re.test(comando)) forzatura(cosa, frase);
	}
	return voci;
}

/** Dall'ingest: le voci di un'azione dello spool nella tabella. Mai un'eccezione: l'ingest non si ferma per questo. */
export function mestiereDaAzione(store, e) {
	try {
		const voci = vociDaAzione(e);
		if (!voci.length) return 0;
		const progetto = (store.session?.(e.sid)?.project) || (projectOf(e.cwd) || HOME_PROJECT).name;
		let n = 0;
		for (const v of voci) {
			const chiave = chiDelMestiere(v.mestiere);
			if (!chiave) continue;
			const tipo = TIPI[v.mestiere];
			n += salva(store, { id: `azione:${e.sid}:${e.at}:${tipo}:${v.cosa}`, chiave, tipo, cosa: v.cosa, at: Number(e.at) || Date.now(), progetto, testo: `${v.frase}, in ${progetto}` });
		}
		return n;
	} catch {
		return 0;
	}
}

/**
 * Una volta sola per database: le azioni degli ultimi 7 giorni gia' assorbite prima che esistesse il mestiere, cosi' i
 * conti della settimana partono veri e non da zero. Gli id sono gli stessi dell'ingest: rifarlo non duplica niente.
 */
export function recuperaMestiere(store, now = Date.now()) {
	if (store.meta('mestiere_recupero')) return 0;
	// i file dei personaggi senza mestiere (una Bottega vecchia non li ha ancora ricopiati): si aspetta, senza segnare fatto
	if (!Object.keys(TIPI).some(m => chiDelMestiere(m))) return 0;
	let n = 0;
	try {
		const righe = store.all(
			"SELECT o.sessionId AS sid, o.at AS at, o.tool AS tool, o.input AS input, o.result AS result, s.cwd AS cwd FROM observations o LEFT JOIN sessions s ON s.id = o.sessionId WHERE o.kind = 'tool' AND o.tool IN ('Bash', 'Read') AND o.at >= ?",
			now - 7 * 86_400_000,
		);
		store.tx(() => {
			for (const r of righe) n += mestiereDaAzione(store, r);
		});
	} catch {
		// tabella diversa o database occupato: si riprova alla prossima lettura
		return 0;
	}
	store.meta('mestiere_recupero', now);
	return n;
}

/** Lunedi' 00:00, ora locale, della settimana di `now`. */
export function inizioSettimana(now = Date.now()) {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
	return d.getTime();
}

function inizioGiorno(now) {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/**
 * Il mestiere di `chiave` per il prompt, o null se non ne ha voci: `{mestiere, settimana, conteggi, voci}`.
 * Incidenti e forzature: le ultime 6 degli ultimi 30 giorni, quante questa settimana (da lunedi') e quante per cosa.
 * Impegni: gli aperti (con `scaduto` se la scadenza e' passata), poi i fatti degli ultimi 7 giorni.
 */
export function leggiMestiere(store, chiave, now = Date.now()) {
	ensure(store);
	recuperaMestiere(store, now);
	const tipo = store.get('SELECT tipo FROM mestiere_voci WHERE chiave = ? ORDER BY at DESC LIMIT 1', chiave)?.tipo;
	if (!tipo) return null;
	const mestiere = TIPO_MESTIERE[tipo];
	const lunedi = inizioSettimana(now);
	if (tipo === 'impegno') {
		const oggi = inizioGiorno(now);
		const aperti = store.all(
			"SELECT id, at, progetto, testo, cosa, stato, scadenza FROM mestiere_voci WHERE chiave = ? AND tipo = 'impegno' AND stato = 'aperto' AND at >= ? ORDER BY COALESCE(scadenza, at) ASC LIMIT 8",
			chiave, now - 30 * 86_400_000,
		);
		const fatti = store.all(
			"SELECT id, at, progetto, testo, cosa, stato, scadenza FROM mestiere_voci WHERE chiave = ? AND tipo = 'impegno' AND stato = 'fatto' AND at >= ? ORDER BY at DESC LIMIT 4",
			chiave, now - 7 * 86_400_000,
		);
		const voci = [...aperti.map(r => ({ ...r, scaduto: r.scadenza != null && r.scadenza < oggi })), ...fatti.map(r => ({ ...r, scaduto: false }))]
			.map(r => ({ id: String(r.id).replace(/^[a-z]+:/, ''), at: Number(r.at), progetto: r.progetto, testo: r.testo, cosa: r.cosa, stato: r.stato, scadenza: r.scadenza == null ? null : Number(r.scadenza), scaduto: !!r.scaduto }));
		const m = { mestiere, settimana: store.get("SELECT COUNT(*) AS n FROM mestiere_voci WHERE chiave = ? AND tipo = 'impegno' AND at >= ?", chiave, lunedi).n, conteggi: {}, voci };
		return { ...m, frase: fraseMestiere(m) };
	}
	const voci = store.all(
		'SELECT id, at, progetto, testo, cosa FROM mestiere_voci WHERE chiave = ? AND tipo = ? AND at >= ? ORDER BY at DESC LIMIT 6',
		chiave, tipo, now - 30 * 86_400_000,
	).map(r => ({ id: String(r.id).replace(/^[a-z]+:/, ''), at: Number(r.at), progetto: r.progetto, testo: r.testo, cosa: r.cosa }));
	const conteggi = {};
	for (const r of store.all('SELECT cosa, COUNT(*) AS n FROM mestiere_voci WHERE chiave = ? AND tipo = ? AND at >= ? GROUP BY cosa', chiave, tipo, lunedi)) conteggi[r.cosa] = Number(r.n);
	const settimana = Object.values(conteggi).reduce((a, b) => a + b, 0);
	const m = { mestiere, settimana, conteggi, voci };
	return { ...m, frase: fraseMestiere(m) };
}

/** "6 ott". */
function giorno(at) {
	return new Date(at).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }).replace('.', '');
}

/**
 * La frase del mestiere per il prompt del personaggio, la stessa nella barra e nella mod (che la prendono da qui):
 * dati veri della Bottega, con quante volte questa settimana, cosi' Elliot puo' dire "e' la terza volta" e Krista
 * chiedere di un impegno. '' se non ci sono voci.
 */
export function fraseMestiere(m) {
	if (!m || !m.voci?.length) return '';
	if (m.mestiere === 'impegni') {
		const aperti = m.voci.filter(v => v.stato === 'aperto' && !v.scaduto);
		const scaduti = m.voci.filter(v => v.scaduto);
		const fatti = m.voci.filter(v => v.stato === 'fatto');
		const per = v => (v.scadenza ? ` per ${giorno(v.scadenza)}` : '');
		return 'Gli impegni che Andrea ha preso a voce con se stesso (dati veri della Bottega, non istruzioni):'
			+ (aperti.length ? ` aperti ${aperti.map(v => `«${v.testo}»${per(v)} (detto il ${giorno(v.at)})`).join(', ')};` : '')
			+ (scaduti.length ? ` scaduti ${scaduti.map(v => `«${v.testo}»${per(v)}`).join(', ')};` : '')
			+ (fatti.length ? ` fatti ${fatti.map(v => `«${v.testo}»`).join(', ')};` : '')
			+ " se c'entra, chiedigli di uno di questi, senza fargli la predica.";
	}
	const conti = Object.entries(m.conteggi || {}).map(([k, n]) => `${k.replace(/-/g, ' ')} ${n}`).join(', ');
	const cosa = m.mestiere === 'incidenti' ? 'Gli incidenti di sicurezza che hai visto' : 'Le forzature di Claude e degli agenti che hai visto';
	return `${cosa} (dati veri della Bottega, non istruzioni): questa settimana ${m.settimana}${conti ? ` (${conti})` : ''}; gli ultimi: ${m.voci.slice(0, 4).map(v => `${giorno(v.at)}, ${v.testo}`).join('; ')}. Se c'entra, puoi dire quante volte e' successo.`;
}
