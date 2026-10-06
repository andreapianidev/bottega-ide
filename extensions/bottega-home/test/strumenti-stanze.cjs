#!/usr/bin/env node
// Banco di prova degli strumenti di Melissa sulle stanze (src/strumenti-stanze.ts): stanza_leggi e stanza_mostra.
// NON spedito (vedi .vscodeignore). Dati tutti inventati (esempio.it, +34 600 000 000): il repository e' pubblico.
// Niente rete, niente vscode: stati finti per ogni stanza, passati come fonti.

const path = require('path');
const assert = require('assert');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'test-out', 'strumenti-stanze');
esbuild.buildSync({
	entryPoints: ['strumenti-stanze', 'continua'].map(n => path.join(SRC, n + '.ts')),
	outdir: OUT,
	format: 'cjs',
	platform: 'node',
	bundle: false,
	target: 'node20',
	logLevel: 'silent',
});
const S = require(path.join(OUT, 'strumenti-stanze.js'));

let passed = 0, failed = 0;
const fails = [];
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log('  ok  ' + name);
	} catch (e) {
		failed++;
		fails.push(name);
		console.log('FAIL  ' + name + '\n      ' + String((e && e.stack) || e).split('\n').slice(0, 5).join('\n      '));
	}
}
const DASH = /[–—]/;
const ORA = new Date(2026, 9, 3, 15, 0).getTime(); // sabato 3 ottobre 2026, 15:00
const H = 3_600_000;
const D = 24 * H;

// ---------- gli stati finti ----------

const PROGETTI = [
	{ name: 'Woofmap', path: '/prove/woofmap' },
	{ name: 'Bottega', path: '/prove/bottega' },
	{ name: 'CheckIn Facile', path: '/prove/checkin' },
	{ name: 'Sito Prova', path: '/prove/sito' },
];
const progetto = q => {
	const k = String(q || '').toLowerCase();
	return PROGETTI.find(p => p.path === q) || PROGETTI.find(p => p.name.toLowerCase() === k) || PROGETTI.find(p => p.name.toLowerCase().includes(k));
};

const tok = n => [n * 0.1, n * 0.1, n * 0.7, n * 0.1];
const proj = (name, p, you, prevYou, daily) => ({ name, path: p, you, claude: you * 1.6, tok: tok(you * 20000), cost: you * 0.2, sessions: Math.round(you / 40), prev: { you: prevYou, claude: prevYou * 1.5, tok: 0, cost: 0 }, last: ORA - 2 * H, daily, hours: [], live: p === '/prove/woofmap' ? 1 : 0 });
const periodo = (days, scala) => ({
	days, from: '2026-09-27', you: 1500 * scala, claude: 2600 * scala, tok: tok(30_000_000 * scala), cost: 310 * scala, sessions: 48 * scala, prompts: 300, activeDays: Math.min(days, 6 * scala),
	avgSession: 40, peak: { n: 4, at: ORA - D }, prev: { you: 1300 * scala, claude: 2000 * scala, tok: tok(1), cost: 1, sessions: 30, prompts: 1, activeDays: 5 },
	projects: [
		proj('Woofmap', '/prove/woofmap', 600 * scala, 400 * scala, [30, 60, 120, 90, 100, 120, 80]),
		proj('Bottega', '/prove/bottega', 500 * scala, 520 * scala, [60, 60, 60, 60, 60, 100, 100]),
		proj('Fuori dai progetti', null, 100 * scala, 50, [10, 10, 10, 10, 20, 20, 20]),
	],
	edges: [], models: [], heat: [], lengths: { edges: [], bins: [], median: 30, n: 10 },
	stalled: [{ name: 'Sito Prova', path: '/prove/sito', prev: 95, last: ORA - 20 * D }],
});
const STATS = {
	version: 1, computedAt: ORA - 60_000, ms: 10, files: {}, gapMinutes: 15, streakMinutes: 30, tz: 'Atlantic/Canary', firstEvent: 0,
	today: { date: '2026-10-03', you: 190, claude: 300, tok: 4_200_000, sessions: 5 },
	week: { start: '2026-09-28', now: { you: 1100, claude: 1800, tok: 1 }, prevSoFar: { you: 900, claude: 1, tok: 1 }, prevFull: { you: 1200, claude: 1, tok: 1 } },
	days: [{ date: '2026-07-06' }],
	weeks: [],
	months: [
		{ key: '2026-07', start: '2026-07-01', end: '2026-07-31', you: 2000, claude: 3000, tok: tok(1e8), cost: 900, sessions: 120, prompts: 1, activeDays: 20 },
		{ key: '2026-09', start: '2026-09-01', end: '2026-09-30', you: 5400, claude: 9000, tok: tok(4e8), cost: 2100, sessions: 210, prompts: 1, activeDays: 27 },
	],
	periods: { 7: periodo(7, 1), 30: periodo(30, 4), 90: periodo(90, 12) },
	streak: { current: 3, best: 9, bestEnd: null }, records: {},
	live: [{ path: '/prove/woofmap' }, { path: '/prove/bottega' }],
	prices: {}, unpricedTokens: 0, todaySessions: [], concurrency7: {},
};

const giorni = Array.from({ length: 62 }, (_, i) => { const d = new Date(2026, 9, 2 - 61 + i); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
const mesi = Array.from({ length: 24 }, (_, i) => { const d = new Date(2026, 9 - 23 + i, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
const serie = (nG, admob, store, dl) => ({ admob: Array(nG).fill(admob), store: Array(nG).fill(store), dl: Array(nG).fill(dl) });
const sett = mesi.indexOf('2026-09');
const mesiTalky = serie(24, 300, 40, 900);
mesiTalky.admob[sett] = 412.3;
const APPSTORE = {
	aggiornatoAt: ORA - 3 * H, aggiornando: false, errori: {}, valuta: 'EUR', giorni, mesi, storeFinoA: '2026-10-01', storeSenzaDati: [],
	totale: { giorni: serie(62, 12, 2, 40), mesi: serie(24, 360, 60, 1200) },
	app: [
		{ chiave: 'ios:1', nome: 'Talky', piattaforma: 'ios', giorni: serie(62, 10, 1.5, 30), mesi: mesiTalky, formati: [], unita: [], acquisti: {} },
		{ chiave: 'ios:2', nome: 'Woofmap', projectPath: '/prove/woofmap', projectName: 'Woofmap', piattaforma: 'ios', giorni: serie(62, 2, 0.5, 10), mesi: serie(24, 60, 20, 300), formati: [], unita: [], acquisti: {} },
	],
	paesi: [],
	buchi: [
		{ id: 'b1', chiave: 'ios:2', app: 'Woofmap', gravita: 'alta', titolo: 'Manca il consenso UMP', perche: 'x', cosa: 'Aggiungi il modulo del consenso prima di caricare gli annunci.', stima: 30, projectPath: '/prove/woofmap' },
		{ id: 'b2', chiave: 'ios:1', app: 'Talky', gravita: 'media', titolo: 'Riempimento al 40%', perche: 'x', cosa: 'Controlla la mediazione.', stima: 12 },
	],
	senzaCambio: [],
};

const REGOLE = {
	projects: {
		'/prove/woofmap': { path: '/prove/woofmap', livello: 'rosso', checkedAt: ORA, hits: [{ id: 'segreti', livello: 'rosso', frase: 'Una chiave nei commit da spingere.', rimedio: 'Toglila prima di spingere.' }] },
		'/prove/bottega': { path: '/prove/bottega', livello: 'giallo', checkedAt: ORA, hits: [{ id: 'push', livello: 'giallo', frase: '2 commit da spingere.', rimedio: 'Spingili.' }] },
	},
	global: [], appAds: null, counts: { rosso: 1, giallo: 1, verde: 40 }, checkedAt: ORA - 10 * 60_000, running: false,
};
const RADAR = {
	apps: [{ ascId: '2', bundleId: 'com.esempio.woof', name: 'Woofmap', projectPath: '/prove/woofmap', version: { string: '2.1', state: 'IN_REVIEW', label: 'in revisione', tone: 'attesa' }, reviews: [] }],
	totals: null, ascAt: ORA, admobAt: ORA, refreshing: false,
	vercel: {
		at: ORA - 5 * H, refreshing: false,
		sites: [
			{ projectId: 'p1', name: 'sito-prova', projectPath: '/prove/sito', via: 'nome', state: 'ERROR', label: 'fallita', tone: 'male', at: ORA - D, url: 'https://vercel.com/x', domain: 'esempio.it', commit: { sha: 'abc', message: 'Sistema la home — versione nuova' }, error: 'Build failed – exit 1', lastReady: { at: ORA - 3 * D, url: 'https://vercel.com/y' } },
			{ projectId: 'p2', name: 'checkin-web', projectPath: '/prove/checkin', via: 'nome', state: 'READY', label: 'pubblicata', tone: 'ok', at: ORA - 2 * H, url: 'https://vercel.com/z', domain: 'checkin.esempio.it' },
		],
	},
};
const CLIENTI = {
	month: '2026-10', months: ['2026-10', '2026-09'], rounding: 15,
	clients: [
		{ id: 'rossi', nome: 'Studio Rossi', minutes: 375, raw: 370, amount: 312.5, days: [{ date: '2026-10-01', minutes: 180 }, { date: '2026-10-02', minutes: 195 }], projects: [{ path: '/prove/checkin', name: 'CheckIn Facile', minutes: 375 }] },
		{ id: 'bianchi', nome: 'Bianchi Srl', minutes: 0, raw: 0, days: [], projects: [] },
	],
	unassigned: [{ path: '/prove/bottega', name: 'Bottega', minutes: 600 }, { path: '/prove/woofmap', name: 'Woofmap', minutes: 300 }],
	config: [{ id: 'rossi', nome: 'Studio Rossi', progetti: ['/prove/checkin'], tariffa: 50 }, { id: 'bianchi', nome: 'Bianchi Srl', progetti: [] }],
	projects: PROGETTI,
};
const MEMORIA = {
	recent: async (project, o) => {
		const tutti = [
			{ id: 1, kind: 'riassunto', project: 'Bottega', title: 'Stanze', text: 'Fatte le stanze.\nFile toccati: a.ts, b.ts\nDa fare: provare la voce; scrivere il contratto; aggiornare il README', createdAt: ORA - D },
			{ id: 2, kind: 'riassunto', project: 'Woofmap', title: 'Mappa', text: 'Sistemata la mappa.\nDa fare: pubblicare la 2.1', createdAt: ORA - 3 * D },
			{ id: 3, kind: 'riassunto', project: 'Bottega', title: 'Vecchio', text: 'Da fare: cosa vecchia', createdAt: ORA - 9 * D },
			{ id: 4, kind: 'decisione', project: 'Bottega', title: 'Agnes resta il cervello primario', text: 'x', createdAt: ORA - 2 * D },
		];
		return tutti.filter(m => (!project || m.project === project) && (!o || !o.kinds || o.kinds.includes(m.kind))).slice(0, (o && o.limit) || 10);
	},
	bacheca: async project => [{ at: ORA - 600_000, sessionId: 's1', project: 'Bottega', kind: 'modifica', summary: 'Scrive strumenti-stanze.ts' }].filter(b => !project || b.project === project),
};
const POSTA = {
	aggiornatoAt: ORA - 26 * H, giorni: 7, fonti: {}, disponibili: {}, deleghe: {}, automatici: 2, suggerimenti: [], tuttiProgetti: PROGETTI,
	progetti: [
		{
			path: '/prove/checkin', name: 'CheckIn Facile', voce: {}, nonLetti: 2, chatDaRispondere: 1,
			fili: [
				{ id: 'm1', fonte: 'mail', da: 'Mario Prova', indirizzo: 'mario@esempio.it', oggetto: 'Preventivo – seconda parte', data: new Date(ORA - 2 * H).toISOString(), nonLetto: true, anteprima: 'testo privato che non va detto' },
				{ id: 'm2', fonte: 'mail', da: 'Anna Esempio', indirizzo: 'anna@esempio.it', oggetto: 'Fattura', data: new Date(ORA - 2 * D).toISOString(), nonLetto: true, anteprima: 'altro testo privato' },
			],
			chat: [{ id: 'wa:business:1', fonte: 'business', server: 'whatsapp-business', jid: '34600000000@s.whatsapp.net', gruppo: false, contatto: 'Mario Prova', telefono: '+34600000000', ultimo: 'Ci sentiamo domani per le chiavi', data: new Date(ORA - H).toISOString(), mio: false }],
		},
		{ path: '/prove/bottega', name: 'Bottega', voce: {}, nonLetti: 0, chatDaRispondere: 0, fili: [], chat: [] },
	],
	daAssegnare: [{}, {}, {}],
	whatsapp: { aggiornatoAt: ORA - 20 * 60_000, aggiornando: false, giorni: 7, fonti: {}, disponibili: ['whatsapp-business'], daAssegnare: [{}] },
};
const CONNETTORI = {
	aggiornatoAt: ORA - H, aggiornando: false, capacita: [],
	connettori: [
		{ nome: 'admob', stato: 'connesso', diretto: true },
		{ nome: 'claude.ai Gmail', stato: 'connesso', diretto: false },
		{ nome: 'claude.ai Vercel', stato: 'da autenticare', diretto: false },
	],
	deleghe: { inCorso: null, coda: [], spesaOggi: 0.16, tetto: 1, modello: 'haiku', stime: {} },
};
const NOTTE = { from: '01:00', to: '06:00', parallel: 1, queued: 1, running: 0, ac: true, why: 'Parte alle 01:00 se il Mac e\' alla corrente.', report: { date: '2026-10-03', jobs: [{ id: 'j1', project: 'Woofmap', task: 'x', status: 'finito', summary: 'Aggiornate le dipendenze.' }] } };

const mostrati = [];
const inviati = [];
let osservatorio = 0;
const fonti = (extra = {}) => ({
	progetto,
	stats: async () => STATS,
	appStore: () => APPSTORE,
	regole: () => REGOLE,
	radar: () => RADAR,
	clienti: async mese => (mese && mese !== CLIENTI.month ? { ...CLIENTI, month: mese, clients: CLIENTI.clients.map(c => ({ ...c, minutes: 0, days: [], projects: [], amount: c.amount === undefined ? undefined : 0 })) } : CLIENTI),
	memoria: () => MEMORIA,
	connettori: () => ({ statoPosta: () => POSTA, statoConnettori: () => CONNETTORI }),
	notte: () => NOTTE,
	mostra: (view, p) => mostrati.push([view, p]),
	send: m => inviati.push(m),
	osservatorio: () => void osservatorio++,
	ora: () => ORA,
	...extra,
});
const leggi = (a, f = fonti()) => S.leggiStanza(a, f);
const buona = t => {
	assert.ok(typeof t === 'string' && t.length > 10, 'testo vuoto: ' + t);
	assert.ok(t.length <= S.MASSIMO_VOCE, `troppo lungo (${t.length}): ${t}`);
	assert.ok(!DASH.test(t), 'lineetta: ' + t);
	return t;
};

(async () => {
	// ---------- pezzi puri ----------

	await test('ore, euro, token e variazione si dicono a voce', () => {
		assert.strictEqual(S.ore(0.4), 'meno di un minuto');
		assert.strictEqual(S.ore(45), '45 minuti');
		assert.strictEqual(S.ore(60), '1 ora');
		assert.strictEqual(S.ore(137), '2 ore e 15 minuti');
		assert.strictEqual(S.ore(178), '3 ore');
		assert.strictEqual(S.ore(2500), 'circa 42 ore');
		assert.strictEqual(S.euro(3.456), '3,46 euro');
		assert.strictEqual(S.euro(1234.4), '1234 euro');
		assert.strictEqual(S.token(1_250_000), '1,3 milioni di token');
		assert.strictEqual(S.token(350_400), '350 mila token');
		assert.strictEqual(S.variazione(112, 100), 'il 12% in più');
		assert.strictEqual(S.variazione(70, 100), 'il 30% in meno');
		assert.strictEqual(S.variazione(101, 100), 'più o meno uguale');
		assert.strictEqual(S.variazione(5, 0), '');
	});

	await test('periodo e mese da come li dice Andrea', () => {
		assert.strictEqual(S.periodoDa(undefined, 7), 7);
		assert.strictEqual(S.periodoDa(1, 7), 1);
		assert.strictEqual(S.periodoDa(14, 7), 30);
		assert.strictEqual(S.periodoDa(60, 7), 90);
		assert.strictEqual(S.periodoDa(400, 7), 365);
		assert.strictEqual(S.meseDa('2026-09', ORA), '2026-09');
		assert.strictEqual(S.meseDa('settembre', ORA), '2026-09');
		assert.strictEqual(S.meseDa('dicembre', ORA), '2025-12');
		assert.strictEqual(S.meseDa('marzo 2025', ORA), '2025-03');
		assert.strictEqual(S.meseDa('mese scorso', ORA), '2026-09');
		assert.strictEqual(S.meseDa('questo mese', ORA), '2026-10');
		assert.strictEqual(S.meseDa('boh', ORA), undefined);
		assert.strictEqual(S.stanzaDa('App Store'), 'appstore');
		assert.strictEqual(S.stanzaDa('da fare'), 'dafare');
		assert.strictEqual(S.stanzaDa('vercel'), 'siti');
		assert.strictEqual(S.stanzaDa('cucina'), undefined);
	});

	await test("l'eta' si dice solo quando i dati sono vecchi", () => {
		assert.strictEqual(S.eta(ORA - 10 * 60_000, ORA), '');
		assert.strictEqual(S.eta(ORA - 45 * 60_000, ORA), 'Dati di 45 minuti fa.');
		assert.strictEqual(S.eta(ORA - 3 * H, ORA), 'Dati di 3 ore fa.');
		assert.strictEqual(S.eta(ORA - 3 * D, ORA), 'Dati di 3 giorni fa.');
	});

	await test('componi resta sotto il massimo e dice che c\'e\' dell\'altro', () => {
		const t = S.componi(Array.from({ length: 80 }, (_, i) => `Frase numero ${i} con qualche parola in piu—per allungare.`));
		buona(t);
		assert.ok(/chiedimi i dettagli\.$/.test(t), t);
		assert.strictEqual(S.componi(['Una.', undefined, false, '', 'Due.']), 'Una. Due.');
	});

	// ---------- ogni stanza ----------

	await test('cruscotto: il quadro dei 7 giorni, con i progetti e da lunedi\'', async () => {
		const t = buona(await leggi({ stanza: 'cruscotto' }));
		assert.ok(t.startsWith('Negli ultimi 7 giorni hai lavorato circa 25 ore in 6 giorni'), t);
		assert.ok(/Da lunedì: 18 ore e 20 minuti, oggi 3 ore e 10 minuti/.test(t), t);
		assert.ok(/Woofmap 10 ore/.test(t) && /Bottega/.test(t), t);
		assert.ok(/il 15% in più/.test(t), t);
		assert.ok(!/Dati di/.test(t), 'dati appena calcolati: niente eta\'');
	});

	await test('cruscotto filtrato su un progetto', async () => {
		const t = buona(await leggi({ stanza: 'cruscotto', progetto: 'woofmap', periodo: 7 }));
		assert.ok(t.startsWith('Woofmap, negli ultimi 7 giorni: 10 ore tue'), t);
		assert.ok(!/Bottega/.test(t), 'filtro: ' + t);
		assert.ok(/il 50% in più/.test(t), t);
		assert.ok(/Da lunedì: 9 ore e 30 minuti/.test(t), t); // sabato: gli ultimi 6 giorni
		const fermo = buona(await leggi({ stanza: 'cruscotto', progetto: 'Sito Prova', periodo: 7 }));
		assert.ok(/non risultano ore/.test(fermo) && /1 ora e 35 minuti/.test(fermo), fermo);
		assert.ok(/Non trovo il progetto/.test(await leggi({ stanza: 'cruscotto', progetto: 'Inesistente' })));
	});

	await test('cruscotto: oggi, un mese, un anno', async () => {
		const oggi = buona(await leggi({ stanza: 'cruscotto', periodo: 1 }));
		assert.ok(/Oggi hai lavorato 3 ore e 10 minuti/.test(oggi), oggi);
		const sett = buona(await leggi({ stanza: 'cruscotto', mese: 'settembre' }));
		assert.ok(/A settembre 2026 hai lavorato circa 90 ore in 27 giorni/.test(sett), sett);
		const lug = buona(await leggi({ stanza: 'cruscotto', mese: '2026-07' }));
		assert.ok(/Il conto parte dal 6 luglio/.test(lug), lug);
		assert.ok(/non c'è/.test(await leggi({ stanza: 'cruscotto', mese: '2025-01' })));
		const anno = buona(await leggi({ stanza: 'cruscotto', periodo: 365 }));
		assert.ok(/ultimi 90 giorni/.test(anno), anno);
	});

	await test('appstore: il mese, le app migliori, i buchi e l\'eta\'', async () => {
		const t = buona(await leggi({ stanza: 'appstore' }));
		assert.ok(t.startsWith('Negli ultimi 30 giorni: 420 euro in tutto, 360 euro da AdMob e 60 euro dallo Store, 1200 download nuovi.'), t);
		assert.ok(/Le app che rendono di più: Talky 345 euro e Woofmap 75 euro/.test(t), t);
		assert.ok(/Da sistemare: 2 punti, uno importante/.test(t) && /Woofmap: Manca il consenso UMP, circa 30 euro al mese/.test(t), t);
		assert.ok(/Lo Store ha i dati fino al 1 ottobre/.test(t), t);
		assert.ok(/Dati di 3 ore fa\.$/.test(t), t);
	});

	await test('appstore: un mese preciso, l\'anno e un\'app sola', async () => {
		const sett = buona(await leggi({ stanza: 'appstore', mese: 'settembre' }));
		assert.ok(sett.startsWith('A settembre 2026: 420 euro in tutto'), sett);
		const talky = buona(await leggi({ stanza: 'appstore', progetto: 'Talky', mese: 'settembre' }));
		assert.ok(talky.startsWith('Talky, a settembre 2026: 452 euro in tutto, 412 euro da AdMob'), talky);
		assert.ok(/Riempimento al 40%/.test(talky) && !/UMP/.test(talky), 'solo i buchi di Talky: ' + talky);
		const woof = buona(await leggi({ stanza: 'appstore', progetto: 'Woofmap', periodo: 7 }));
		assert.ok(woof.startsWith('Woofmap, negli ultimi 7 giorni: 18 euro in tutto') && /Da sistemare: un punto importante\./.test(woof), woof);
		assert.ok(/Aggiungi il modulo del consenso/.test(woof), woof);
		const anno = buona(await leggi({ stanza: 'appstore', periodo: 365 }));
		assert.ok(anno.startsWith("Negli ultimi 12 mesi, compreso questo: 5040 euro"), anno);
		assert.ok(/Non trovo app/.test(await leggi({ stanza: 'appstore', progetto: 'Nessuna' })));
		const fresco = await leggi({ stanza: 'appstore' }, fonti({ appStore: () => ({ ...APPSTORE, aggiornatoAt: ORA - 60_000 }) }));
		assert.ok(!/Dati di/.test(fresco), fresco);
		assert.ok(/non ha ancora letto/.test(await leggi({ stanza: 'appstore' }, fonti({ appStore: () => ({ ...APPSTORE, aggiornatoAt: 0 }) }))));
	});

	await test('vedetta: il semaforo e un progetto', async () => {
		const t = buona(await leggi({ stanza: 'vedetta' }));
		assert.ok(t.startsWith('Semaforo: 1 rosso, 1 giallo, 40 verdi.'), t);
		assert.ok(t.indexOf('Woofmap') < t.indexOf('Bottega'), 'prima i rossi: ' + t);
		const w = buona(await leggi({ stanza: 'vedetta', progetto: 'Woofmap' }));
		assert.ok(/Woofmap è in rosso/.test(w) && /versione 2\.1, in revisione/.test(w) && !/Bottega/.test(w), w);
		const v = buona(await leggi({ stanza: 'vedetta', progetto: 'CheckIn' }));
		assert.ok(/CheckIn Facile è in verde/.test(v) && /checkin-web: ultima pubblicazione pubblicata/.test(v), v);
	});

	await test('siti: le fallite prima, l\'onesta\' e l\'eta\'', async () => {
		const t = buona(await leggi({ stanza: 'siti' }));
		assert.ok(/2 collegati\. Uno ha l'ultima pubblicazione fallita/.test(t), t);
		assert.ok(/sito-prova: ultima pubblicazione fallita, ieri, su esempio\.it/.test(t), t);
		assert.ok(/Sistema la home, versione nuova/.test(t), 'lineetta tolta dal commit: ' + t);
		assert.ok(/non se i siti rispondono/.test(t) && /Dati di 5 ore fa\./.test(t), t);
		const c = buona(await leggi({ stanza: 'siti', progetto: 'CheckIn Facile' }));
		assert.ok(/checkin-web/.test(c) && !/sito-prova/.test(c), c);
		assert.ok(/non ha un sito/.test(await leggi({ stanza: 'siti', progetto: 'Bottega' })));
	});

	await test('clienti: il mese, un cliente, un progetto senza cliente', async () => {
		const t = buona(await leggi({ stanza: 'clienti' }));
		assert.ok(t.startsWith('Ottobre 2026, fin qui: Studio Rossi 6 ore e 15 minuti, 312,50 euro.'), t);
		assert.ok(/Fuori dai clienti: 15 ore, soprattutto Bottega e Woofmap/.test(t), t);
		const r = buona(await leggi({ stanza: 'clienti', progetto: 'rossi' }));
		assert.ok(/Studio Rossi, ottobre 2026 fin qui: 6 ore e 15 minuti in 2 giorni, 312,50 euro da fatturare/.test(r) && /Tariffa 50 euro l'ora/.test(r), r);
		const viaProgetto = buona(await leggi({ stanza: 'clienti', progetto: 'CheckIn Facile' }));
		assert.ok(/Studio Rossi/.test(viaProgetto), viaProgetto);
		const senza = buona(await leggi({ stanza: 'clienti', progetto: 'Woofmap' }));
		assert.ok(/Woofmap non è di nessun cliente: a ottobre 2026 ci hai lavorato 5 ore/.test(senza), senza);
		const sett = buona(await leggi({ stanza: 'clienti', mese: 'settembre' }));
		assert.ok(/settembre 2026 non risultano ore/.test(sett), sett);
	});

	await test('posta: solo nomi, oggetti e progetti, mai indirizzi o testi', async () => {
		const t = buona(await leggi({ stanza: 'posta' }));
		assert.ok(t.startsWith('Mail non lette dei progetti, ultimi 7 giorni: CheckIn Facile 2.'), t);
		assert.ok(/Mario Prova per CheckIn Facile, «Preventivo, seconda parte», oggi/.test(t), t);
		assert.ok(/3 mittenti da assegnare/.test(t) && /Dati di 26 ore fa\./.test(t), t);
		const c = buona(await leggi({ stanza: 'posta', progetto: 'checkin' }));
		assert.ok(/Per CheckIn Facile, negli ultimi 7 giorni: 2 mail, 2 non lette/.test(c), c);
		assert.ok(/Anna Esempio, «Fattura», 2 giorni fa, non letta/.test(c), c);
		assert.ok(/Su WhatsApp: una chat, 1 aspettano una tua risposta/.test(c), c);
		for (const x of [t, c]) {
			assert.ok(!/@|\+34|privato|chiavi/.test(x), 'dati che non devono uscire: ' + x);
		}
		assert.ok(/non ha indirizzi/.test(await leggi({ stanza: 'posta', progetto: 'Woofmap' })));
	});

	await test('whatsapp: chi aspetta una risposta e l\'anteprima breve solo per progetto', async () => {
		const t = buona(await leggi({ stanza: 'whatsapp' }));
		assert.ok(/Chat che aspettano una tua risposta: CheckIn Facile 1/.test(t) && /Mario Prova per CheckIn Facile, oggi/.test(t), t);
		assert.ok(!/Ci sentiamo/.test(t) && !/\+34/.test(t) && !/Dati di/.test(t), t);
		const c = buona(await leggi({ stanza: 'whatsapp', progetto: 'CheckIn Facile' }));
		assert.ok(/ultimo: «Ci sentiamo domani per le chiavi»/.test(c) && !/\+34/.test(c), c);
	});

	await test('dafare: un progetto e tutti', async () => {
		const b = buona(await leggi({ stanza: 'dafare', progetto: 'Bottega' }));
		assert.ok(b.startsWith('Bottega, dal riassunto di ieri: restano 3 cose.'), b);
		assert.ok(/1: provare la voce\. 2: scrivere il contratto\./.test(b) && !/cosa vecchia/.test(b), b);
		const tutti = buona(await leggi({ stanza: 'dafare' }));
		assert.ok(/Cose da fare in 2 progetti/.test(tutti) && /Bottega \(ieri\): provare la voce; scrivere il contratto, e altre 1/.test(tutti) && /Woofmap \(3 giorni fa\): pubblicare la 2\.1/.test(tutti), tutti);
		assert.ok(/non ha ancora un riassunto/.test(await leggi({ stanza: 'dafare', progetto: 'Sito Prova' })));
	});

	await test('memoria, connettori e notte', async () => {
		const m = buona(await leggi({ stanza: 'memoria', progetto: 'Bottega' }));
		assert.ok(/Scrive strumenti-stanze\.ts/.test(m) && /Agnes resta il cervello primario/.test(m), m);
		const k = buona(await leggi({ stanza: 'connettori' }));
		assert.ok(/Connettori: 3, 2 connessi, 1 diretti/.test(k) && /claude\.ai Vercel da autenticare/.test(k) && /0,16 dollari su 1 dollari/.test(k), k);
		const n = buona(await leggi({ stanza: 'notte' }));
		assert.ok(/dalle 01:00 alle 06:00/.test(n) && /Woofmap finito/.test(n) && /Aggiornate le dipendenze/.test(n), n);
	});

	await test('stanze che mancano o non partite: frasi oneste', async () => {
		const vuote = fonti({ stats: undefined, appStore: () => undefined, regole: () => undefined, radar: () => undefined, clienti: undefined, memoria: () => undefined, connettori: () => undefined, notte: () => undefined });
		for (const stanza of S.STANZE) buona(await leggi({ stanza }, vuote));
		assert.ok(/Non conosco la stanza/.test(await leggi({ stanza: 'cucina' })));
		assert.strictEqual(await S.leggiStanza({ stanza: 'cruscotto' }, undefined), 'Le stanze non sono pronte.');
		const lento = fonti({ stats: () => new Promise(() => {}) });
		// il tempo massimo vero e' 20 secondi: qui basta che una promessa che non finisce non blocchi un errore
		const errore = await leggi({ stanza: 'cruscotto' }, fonti({ stats: async () => { throw new Error('rotto'); } }));
		assert.ok(/non è pronto/.test(errore), errore);
		void lento;
	});

	await test('tutto sotto i 1200 caratteri anche con tanti dati', async () => {
		const tante = Array.from({ length: 40 }, (_, i) => ({ ...POSTA.progetti[0], path: '/prove/p' + i, name: 'Progetto ' + i }));
		const t = buona(await leggi({ stanza: 'posta' }, fonti({ connettori: () => ({ statoPosta: () => ({ ...POSTA, progetti: tante }), statoConnettori: () => CONNETTORI }) })));
		assert.ok(t.length > 200, t);
		const molte = { ...APPSTORE, buchi: Array.from({ length: 30 }, (_, i) => ({ ...APPSTORE.buchi[0], titolo: 'Un buco con un titolo piuttosto lungo numero ' + i })) };
		buona(await leggi({ stanza: 'appstore', progetto: 'Woofmap' }, fonti({ appStore: () => molte })));
	});

	// ---------- stanza_mostra ----------

	await test('stanza_mostra porta la Home sulla stanza giusta', async () => {
		mostrati.length = 0;
		inviati.length = 0;
		const f = fonti();
		assert.strictEqual(await S.mostraStanza({ stanza: 'cruscotto', progetto: 'Woofmap' }, f), 'Ho aperto il cruscotto su Woofmap.');
		assert.deepStrictEqual(mostrati.pop(), ['cruscotto', undefined]);
		assert.deepStrictEqual(inviati.pop(), { type: 'crus.focus', path: '/prove/woofmap' });
		assert.strictEqual(await S.mostraStanza({ stanza: 'App Store' }, f), 'Ho aperto la stanza App Store.');
		assert.deepStrictEqual(mostrati.pop(), ['appstore', undefined]);
		await S.mostraStanza({ stanza: 'siti' }, f);
		assert.deepStrictEqual(mostrati.pop(), ['vercel', undefined]);
		await S.mostraStanza({ stanza: 'posta' }, f);
		assert.deepStrictEqual(mostrati.pop(), ['connettori', undefined]);
		await S.mostraStanza({ stanza: 'dafare', progetto: 'Bottega' }, f);
		assert.deepStrictEqual(mostrati.pop(), ['plancia', '/prove/bottega']);
		assert.strictEqual(await S.mostraStanza({ stanza: 'osservatorio' }, f), "Ho aperto l'Osservatorio.");
		assert.strictEqual(osservatorio, 1);
		assert.ok(/Non conosco la stanza/.test(await S.mostraStanza({ stanza: 'cantina' }, f)));
		assert.ok(/Non trovo il progetto "Nulla"/.test(await S.mostraStanza({ stanza: 'cruscotto', progetto: 'Nulla' }, f)));
	});

	await test('le specifiche per Melissa: nomi, enum, esempi, privacy, niente lineette', () => {
		const L = S.STRUMENTI_STANZE.stanza_leggi.spec.function;
		const M = S.STRUMENTI_STANZE.stanza_mostra.spec.function;
		assert.strictEqual(L.name, 'stanza_leggi');
		assert.strictEqual(M.name, 'stanza_mostra');
		assert.deepStrictEqual(L.parameters.properties.stanza.enum, [...S.STANZE]);
		assert.deepStrictEqual(L.parameters.required, ['stanza']);
		assert.strictEqual(L.parameters.properties.periodo.type, 'number');
		for (const q of ['quante ore ho fatto su Woofmap questa settimana', 'quanto ho guadagnato a settembre', 'cosa mi resta da fare sulla Bottega', 'chi mi ha scritto per CheckIn Facile', 'quanto devo fatturare a quel cliente questo mese', 'i siti sono tutti su?']) {
			assert.ok(L.description.includes(q), 'manca l\'esempio: ' + q);
		}
		assert.ok(/SOLO se Andrea chiede esplicitamente/.test(L.description));
		assert.ok(/Osservatorio/.test(M.description));
		for (const d of [L.description, M.description]) assert.ok(!DASH.test(d));
	});

	console.log(`\n${passed} ok, ${failed} falliti`);
	if (failed) {
		console.log('falliti: ' + fails.join('; '));
		process.exit(1);
	}
})();
