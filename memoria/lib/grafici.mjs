// I numeri della stanza Memoria (docs/CONTRATTI.md, 2): come lavora la memoria, giorno per giorno.
//
//   scritti     cosa entra in memoria ogni giorno: fatti (e note), decisioni, riassunti, schermate; a parte le
//               richieste di Andrea registrate (tante e brevi: nel grafico coprirebbero tutto il resto)
//   letti       quante volte Claude la legge: il contesto che ogni sessione riceve quando parte (una per sessione
//               avviata) e le ricerche che fa da sola con gli strumenti memoria_* (registrate dagli hook)
//   progetti    di quali progetti ricorda di piu' nel periodo
//   ore         quando nascono i ricordi: 7 righe (lunedi' per primo) per 24 ore, nel periodo; e `adesso`
//   totali      ricordi, sessioni, riassunte, in coda, letture degli ultimi 7 giorni
//
// Solo letture dal database, niente rete. I giorni sono quelli dell'orologio del Mac.
import { openStore } from './store.mjs';

const GIORNO = 86_400_000;
// le chiacchiere dei personaggi di Melissa non sono ricordi di lavoro: fuori dai grafici (docs/CONTRATTI.md 9.11)
const NO_PERSONAGGI = " AND origin != 'personaggio'";
const GRUPPI = { fatto: 'fatti', nota: 'fatti', decisione: 'decisioni', riassunto: 'riassunti', immagine: 'schermate', prompt: 'richieste' };

function chiave(ms) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** I giorni del periodo, dal piu' vecchio a oggi, a mezzanotte locale. */
function giorni(n, ora) {
	const oggi = new Date(ora);
	oggi.setHours(0, 0, 0, 0);
	const out = [];
	for (let i = n - 1; i >= 0; i--) {
		const d = new Date(oggi);
		d.setDate(d.getDate() - i);
		out.push(d.getTime());
	}
	return out;
}

export function grafici({ giorni: n = 30, ora = Date.now(), store = openStore() } = {}) {
	n = Math.max(7, Math.min(90, Math.floor(n) || 30));
	const inizi = giorni(n, ora);
	const da = inizi[0];
	const vuoto = () => Object.fromEntries(inizi.map(t => [chiave(t), null]));

	// scritti
	const scritti = vuoto();
	for (const k of Object.keys(scritti)) scritti[k] = { fatti: 0, decisioni: 0, riassunti: 0, schermate: 0, richieste: 0 };
	const ore = Array.from({ length: 7 }, () => Array(24).fill(0));
	for (const r of store.all(`SELECT kind, createdAt FROM memories WHERE createdAt >= ?${NO_PERSONAGGI}`, da)) {
		const g = scritti[chiave(r.createdAt)];
		if (g && GRUPPI[r.kind]) g[GRUPPI[r.kind]]++;
		// le richieste no: dicono quando scrivi, non quando la memoria impara
		if (GRUPPI[r.kind] && r.kind !== 'prompt') {
			const d = new Date(r.createdAt);
			ore[(d.getDay() + 6) % 7][d.getHours()]++;
		}
	}
	const qui = new Date(ora);

	// letti: contesto all'avvio (sessioni avviate) e ricerche con gli strumenti della memoria
	const letti = vuoto();
	for (const k of Object.keys(letti)) letti[k] = { avvio: 0, ricerche: 0, strumenti: {} };
	for (const r of store.all('SELECT startedAt FROM sessions WHERE startedAt >= ?', da)) {
		const g = letti[chiave(r.startedAt)];
		if (g) g.avvio++;
	}
	for (const r of store.all("SELECT tool, at FROM observations WHERE at >= ? AND tool LIKE 'mcp__bottega-memoria__%'", da)) {
		const g = letti[chiave(r.at)];
		if (!g) continue;
		g.ricerche++;
		const nome = String(r.tool).replace('mcp__bottega-memoria__memoria_', '');
		g.strumenti[nome] = (g.strumenti[nome] ?? 0) + 1;
	}

	// progetti
	const progetti = store
		.all(
			`SELECT COALESCE(NULLIF(project, ''), 'Fuori dai progetti') AS progetto, COUNT(*) AS ricordi
			 FROM memories WHERE createdAt >= ?${NO_PERSONAGGI} GROUP BY progetto ORDER BY ricordi DESC LIMIT 8`,
			da,
		)
		.map(r => ({ progetto: r.progetto, ricordi: r.ricordi }));

	const settimana = ora - 7 * GIORNO;
	const totali = {
		ricordi: store.get(`SELECT COUNT(*) AS n FROM memories WHERE 1 = 1${NO_PERSONAGGI}`).n,
		sessioni: store.get('SELECT COUNT(*) AS n FROM sessions').n,
		riassunte: store.get('SELECT COUNT(*) AS n FROM sessions WHERE summarizedAt IS NOT NULL').n,
		coda: store.get('SELECT COUNT(*) AS n FROM queue').n,
		lettiSettimana:
			store.get('SELECT COUNT(*) AS n FROM sessions WHERE startedAt >= ?', settimana).n +
			store.get("SELECT COUNT(*) AS n FROM observations WHERE at >= ? AND tool LIKE 'mcp__bottega-memoria__%'", settimana).n,
		ultimo: store.get(`SELECT MAX(createdAt) AS t FROM memories WHERE 1 = 1${NO_PERSONAGGI}`).t ?? null,
	};

	return {
		giorni: n,
		ora,
		scritti: Object.entries(scritti).map(([giorno, v]) => ({ giorno, ...v })),
		letti: Object.entries(letti).map(([giorno, v]) => ({ giorno, ...v })),
		progetti,
		ore,
		adesso: { giorno: (qui.getDay() + 6) % 7, ora: qui.getHours() },
		totali,
	};
}
