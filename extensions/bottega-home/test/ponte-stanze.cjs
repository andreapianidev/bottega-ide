#!/usr/bin/env node
// Banco di prova delle stanze per l'iPhone (src/ponte-stanze.ts, docs/CONTRATTI.md 9.6): GET /v1/stanza dietro il
// gettone, JSON strutturato dalle stesse fonti di stanza_leggi, elenchi tagliati, posta senza indirizzi ne' numeri,
// niente nei registri del ponte. NON spedito. Dati tutti inventati (esempio.it, +34 600 000 000): il repository e'
// pubblico. Niente rete fuori da 127.0.0.1, niente vscode.

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const assert = require('assert');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'test-out', 'ponte-stanze');
esbuild.buildSync({
	entryPoints: ['ponte.ts', 'dispositivo.ts', 'ponte-stanze.ts', 'strumenti-stanze.ts', 'continua.ts'].map(f => path.join(SRC, f)),
	outdir: OUT, format: 'cjs', platform: 'node', bundle: false, target: 'node20', logLevel: 'silent',
});
const { Ponte } = require(path.join(OUT, 'ponte.js'));
const { StanzePonte, periodoParam, mittenteSicuro, contattoSicuro, anteprimaSicura } = require(path.join(OUT, 'ponte-stanze.js'));

let passed = 0;
const ok = name => (passed++, console.log('  ok  ' + name));
const DASH = /[–—]/;
const ORA = new Date(2026, 9, 3, 15, 0).getTime(); // sabato 3 ottobre 2026, 15:00
const H = 3_600_000;
const D = 24 * H;
const pad = n => String(n).padStart(2, '0');
const giornoDi = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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
		proj('Bottega', '/prove/bottega', 500 * scala, 520 * scala, Array(days).fill(60)),
		proj('Woofmap', '/prove/woofmap', 600 * scala, 400 * scala, Array(days).fill(90)),
		proj('Fuori dai progetti', null, 100 * scala, 50, Array(days).fill(10)),
	],
	edges: [], models: [], heat: [], lengths: { edges: [], bins: [], median: 30, n: 10 }, stalled: [],
});
const STATS = {
	version: 1, computedAt: ORA - 60_000, ms: 10, files: {}, gapMinutes: 15, streakMinutes: 30, tz: 'Atlantic/Canary', firstEvent: 0,
	today: { date: '2026-10-03', you: 190, claude: 300, tok: 4_200_000, sessions: 5 },
	week: { start: '2026-09-28', now: { you: 1100, claude: 1800, tok: 1 }, prevSoFar: { you: 900, claude: 1, tok: 1 }, prevFull: { you: 1200, claude: 1, tok: 1 } },
	days: Array.from({ length: 90 }, (_, i) => ({ date: giornoDi(new Date(2026, 9, 3 - 89 + i)), you: 100 + i, claude: 150 + i, sessions: 3, prompts: 1, tok: tok(1000), cost: 1 })),
	weeks: [], months: [],
	periods: { 7: periodo(7, 1), 30: periodo(30, 4), 90: periodo(90, 12) },
	streak: { current: 3, best: 9, bestEnd: null }, records: {},
	live: [{ path: '/prove/woofmap' }, { path: '/prove/bottega' }],
	prices: {}, unpricedTokens: 0, todaySessions: [], concurrency7: {},
};

const giorni = Array.from({ length: 62 }, (_, i) => giornoDi(new Date(2026, 9, 2 - 61 + i)));
const mesi = Array.from({ length: 24 }, (_, i) => { const d = new Date(2026, 9 - 23 + i, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; });
const serie = (n, admob, store, dl) => ({ admob: Array(n).fill(admob), store: Array(n).fill(store), dl: Array(n).fill(dl) });
const scheda = n => ({ imp: Array(62).fill(n * 10), vis: Array(62).fill(n), dl: Array(62).fill(n / 10), fonti: { ricerca: { imp: n * 200, vis: n * 20, dl: n * 2 }, web: { imp: 0, vis: 0, dl: 0 } } });
const abb = (attivi, prove) => ({ attivi: Array(62).fill(attivi).map((x, i) => x + Math.floor(i / 10)), prove: Array(62).fill(prove), mrr: Array(62).fill(attivi * 2.5), ritardo: Array(62).fill(1), grazia: Array(62).fill(0), eventi: { nuovi: Array(62).fill(1), disdette: Array(62).fill(0) } });
const APPSTORE = {
	aggiornatoAt: ORA - 3 * H, aggiornando: false, errori: { admob: 'AdMob non risponde — riprovo' }, valuta: 'EUR', giorni, mesi, storeFinoA: '2026-10-01', storeSenzaDati: ['2024-11'],
	abbFinoA: giorni[59], schedaFinoA: giorni[59], controlloOre: 3,
	totale: { giorni: serie(62, 12, 2, 40), mesi: serie(24, 360, 60, 1200), abbonamenti: abb(20, 4), scheda: scheda(100) },
	app: [
		{
			chiave: 'ios:2', nome: 'Woofmap', projectPath: '/prove/woofmap', projectName: 'Woofmap', piattaforma: 'ios', giorni: serie(62, 2, 0.5, 10), mesi: serie(24, 60, 20, 300), abbonamenti: abb(5, 1),
			scheda: scheda(40), admobId: 'ca-app-pub-0000000000000000~0000000001', approvazione: 'APPROVED', collegata: true,
			versioni: [{ v: '2.0', quando: giorni[20] }, { v: '2.1', quando: giorni[50] }], versioniMesi: [{ v: '2.1', quando: mesi[23] }],
			formati: [{ formato: 'interstitial', richieste: 1000, abbinate: 800, impressioni: 300, clic: 9, euro: 4.5 }, { formato: 'banner', richieste: 0, abbinate: 0, impressioni: 0, clic: 0, euro: 0 }],
			unita: [{ id: 'u1', nome: 'Pausa prova', formato: 'interstitial', richieste: 1000, impressioni: 300, euro: 4.5 }],
			acquisti: { nuovi: 3, rinnovi: 5, altri: 0, euro: 21.337 },
			repo: { path: '/prove/woofmap', letteAt: ORA - H, file: 120, sdk: true, formati: ['interstitial'], ump: false, att: true, attRichiesta: true, skan: 12, idProva: [], unita: [], storekit: true, revenuecat: false },
		},
		{ chiave: 'ios:1', nome: 'Talky', piattaforma: 'ios', giorni: serie(62, 10, 1.5, 30), mesi: serie(24, 300, 40, 900) },
		{ chiave: 'admob:3', nome: 'Ferma', piattaforma: 'android', giorni: serie(62, 0, 0, 0), mesi: serie(24, 0, 0, 0) },
	],
	paesi: [{ codice: 'IT', euro: 12.345, impressioni: 4000 }, { codice: 'ES', euro: 3, impressioni: 1500 }],
	buchi: [
		{ id: 'ios:2:ump', chiave: 'ios:2', app: 'Woofmap', gravita: 'alta', titolo: 'Manca il consenso UMP', perche: 'Senza consenso — niente annunci in Europa.', cosa: 'Aggiungi il modulo del consenso.', stima: 30, stimaNota: 'stima larga', projectPath: '/prove/woofmap', daQuando: ORA - 5 * D, tipo: 'ump', fonte: 'codice' },
		{ id: 'ios:1:fill', chiave: 'ios:1', app: 'Talky', gravita: 'media', titolo: 'Riempimento al 40%', perche: 'x', cosa: 'Controlla la mediazione.', stima: 12.4, tipo: 'fill', fonte: 'admob', misura: 0.4, soglia: 0.6, verifica: { versione: '3.2', giorno: giorni[55], prima: 0.3, dopo: 0.4, giorniDopo: 6, esito: 'meglio' } },
		{ id: 'ios:2:mostrati:interstitial', chiave: 'ios:2', app: 'Woofmap', gravita: 'media', titolo: 'Interstitial caricati e non mostrati', perche: 'y', cosa: 'Carica solo quando mostri.', projectPath: '/prove/woofmap', compito: 'Nell\'app Woofmap sistema il ciclo degli interstitial.\nUsa la skill ios-admob-integration.', tipo: 'mostrati', fonte: 'admob' },
	],
	risolti: [{ id: 'ios:1:ump', chiave: 'ios:1', app: 'Talky', titolo: 'Manca il consenso UMP', quando: ORA - 2 * D, daQuando: ORA - 9 * D, prima: 0.2, dopo: 0.7 }],
	ignorati: [{ id: 'ios:1:premio', chiave: 'ios:1', app: 'Talky', titolo: 'Annunci con premio poco visti', quando: ORA - D, daQuando: ORA - 4 * D, motivo: 'li offro solo a chi li vuole' }],
	allarmi: [{ id: 'a1', chiave: 'ios:1', app: 'Talky', testo: 'AdMob di ieri al 30% della media', at: ORA - 2 * H }],
	senzaCambio: [],
};
const REGOLE = {
	projects: {
		'/prove/bottega': { path: '/prove/bottega', livello: 'giallo', checkedAt: ORA, hits: [{ id: 'push', livello: 'giallo', frase: '2 commit da spingere.', rimedio: 'Spingili.' }] },
		'/prove/woofmap': { path: '/prove/woofmap', livello: 'rosso', checkedAt: ORA, hits: [{ id: 'segreti', livello: 'rosso', frase: 'Una chiave nei commit da spingere — subito.', rimedio: 'Toglila prima di spingere.' }, { id: 'push', livello: 'giallo', frase: '1 commit da spingere.', rimedio: 'Spingilo.' }] },
		'/prove/checkin': { path: '/prove/checkin', livello: 'verde', checkedAt: ORA, hits: [] },
	},
	global: [{ id: 'app-ads', livello: 'rosso', frase: 'app-ads.txt non è uguale sui tre siti.', rimedio: 'Ricopialo.' }], appAds: null, counts: { rosso: 1, giallo: 1, verde: 40 }, checkedAt: ORA - 10 * 60_000, running: false,
};
const RADAR = {
	apps: [], totals: null, ascAt: ORA, admobAt: ORA, refreshing: false,
	vercel: {
		at: ORA - 5 * H, refreshing: false,
		sites: [
			{ projectId: 'p2', name: 'checkin-web', projectPath: '/prove/checkin', via: 'nome', state: 'READY', label: 'pubblicata', tone: 'ok', at: ORA - 2 * H, url: 'https://vercel.com/z', domain: 'checkin.esempio.it' },
			{ projectId: 'p1', name: 'sito-prova', projectPath: '/prove/sito', via: 'nome', state: 'ERROR', label: 'fallita', tone: 'male', at: ORA - D, url: 'https://vercel.com/x', domain: 'esempio.it', error: 'Build failed – exit 1', lastReady: { at: ORA - 3 * D, url: 'https://vercel.com/y' } },
		],
	},
};
const CLIENTI = {
	month: '2026-10', months: ['2026-10', '2026-09'], rounding: 15,
	clients: [
		{ id: 'bianchi', nome: 'Bianchi Prova', minutes: 0, raw: 0, days: [], projects: [] },
		{ id: 'rossi', nome: 'Studio Prova', minutes: 375, raw: 370, amount: 312.5, days: [{ date: '2026-10-01', minutes: 180 }, { date: '2026-10-02', minutes: 195 }], projects: [{ path: '/prove/checkin', name: 'CheckIn Facile', minutes: 375 }] },
	],
	unassigned: [{ path: '/prove/bottega', name: 'Bottega', minutes: 600 }],
	config: [{ id: 'rossi', nome: 'Studio Prova', progetti: ['/prove/checkin'], tariffa: 50 }, { id: 'bianchi', nome: 'Bianchi Prova', progetti: [] }],
	projects: PROGETTI,
};
const MEMORIA = {
	recent: async (project, o) => {
		const tutti = [
			{ id: 1, kind: 'riassunto', project: 'Bottega', projectPath: '/prove/bottega', title: 'Stanze', text: 'Fatte le stanze.\nDa fare: provare la voce; scrivere il contratto; aggiornare il README', createdAt: ORA - D },
			{ id: 2, kind: 'riassunto', project: 'Woofmap', title: 'Mappa', text: 'Sistemata la mappa.\nDa fare: pubblicare la 2.1', createdAt: ORA - 3 * D },
			{ id: 3, kind: 'riassunto', project: 'Bottega', title: 'Vecchio', text: 'Da fare: cosa vecchia', createdAt: ORA - 9 * D },
			{ id: 4, kind: 'riassunto', project: 'CheckIn Facile', title: 'Fatto', text: 'Tutto chiuso.', createdAt: ORA - 2 * D },
		];
		return tutti.filter(m => (!project || m.project === project) && (!o || !o.kinds || o.kinds.includes(m.kind))).slice(0, (o && o.limit) || 10);
	},
	bacheca: async () => [],
};
const POSTA = {
	aggiornatoAt: ORA - 26 * H, giorni: 7,
	progetti: [
		{ path: '/prove/bottega', name: 'Bottega', nonLetti: 0, chatDaRispondere: 0, fili: [], chat: [] },
		{
			path: '/prove/checkin', name: 'CheckIn Facile', nonLetti: 2, chatDaRispondere: 1,
			fili: [
				{ id: 'm1', fonte: 'mail', da: 'Mario Prova <mario@esempio.it>', indirizzo: 'mario@esempio.it', oggetto: 'Preventivo – seconda parte', data: new Date(ORA - 2 * H).toISOString(), nonLetto: true, anteprima: 'testo privato che non va mostrato' },
				{ id: 'm2', fonte: 'mail', da: 'anna@esempio.it', indirizzo: 'anna@esempio.it', oggetto: 'Fattura', data: new Date(ORA - 2 * D).toISOString(), nonLetto: true, anteprima: 'altro testo privato' },
			],
			chat: [
				{ id: 'wa:1', gruppo: false, contatto: 'Mario Prova', telefono: '+34600000000', ultimo: 'Chiamami al +34 600 000 000 o scrivi a mario@esempio.it', data: new Date(ORA - H).toISOString(), mio: false },
				{ id: 'wa:2', gruppo: false, contatto: '+34 600 000 001', telefono: '+34600000001', ultimo: 'ciao', data: new Date(ORA - 3 * H).toISOString(), mio: false },
			],
		},
	],
	daAssegnare: [{}, {}, {}],
	whatsapp: { aggiornatoAt: ORA - 20 * 60_000, giorni: 7, daAssegnare: [{}] },
};
const NOTTE = { from: '01:00', to: '06:00', parallel: 1, queued: 1, running: 0, ac: true, why: 'Parte alle 01:00 se il Mac è alla corrente.', report: { date: '2026-10-03', jobs: [{ id: 'j1', project: 'Woofmap', task: 'Aggiorna le dipendenze', status: 'finito', summary: 'Aggiornate le dipendenze — tutto verde.' }] } };
const LAVORI = [
	{ key: 'job:n1', source: 'bottega', status: 'stanotte', project: 'Bottega', path: '/prove/bottega', title: 'Rifai i test', since: ORA, jobId: 'n1', night: true },
	{ key: 'job:x', source: 'bottega', status: 'in corso', project: 'Woofmap', path: '/prove/woofmap', title: 'Di giorno', since: ORA, jobId: 'x' },
];

let lenta = false;
const fonti = (extra = {}) => ({
	progetto,
	stats: async () => (lenta ? new Promise(() => undefined) : STATS),
	appStore: () => APPSTORE,
	regole: () => REGOLE,
	radar: () => RADAR,
	clienti: async () => CLIENTI,
	memoria: () => MEMORIA,
	connettori: () => ({ statoPosta: () => POSTA, statoConnettori: () => ({}) }),
	notte: () => NOTTE,
	mostra: () => undefined,
	send: () => undefined,
	ora: () => ORA,
	...extra,
});

function call(port, token, method, url, corpo) {
	return new Promise((resolve, reject) => {
		const headers = { authorization: `Bearer ${token}` };
		if (corpo !== undefined) headers['content-type'] = 'application/json';
		const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, res => {
			const parti = [];
			res.on('data', c => parti.push(c));
			res.on('end', () => {
				const t = Buffer.concat(parti).toString();
				let b = t;
				try {
					b = JSON.parse(t);
				} catch {
					// testo
				}
				resolve({ status: res.statusCode, body: b, testo: t });
			});
		});
		req.on('error', reject);
		req.end(corpo === undefined ? undefined : JSON.stringify(corpo));
	});
}

(async () => {
	// ---------- pezzi puri ----------
	assert.strictEqual(periodoParam('ieri', 30), 1);
	assert.strictEqual(periodoParam('settimana', 30), 7);
	assert.strictEqual(periodoParam('mese', 7), 30);
	assert.strictEqual(periodoParam('anno', 7), 365);
	assert.strictEqual(periodoParam('90', 7), 90);
	assert.strictEqual(periodoParam(null, 30), 30);
	assert.strictEqual(periodoParam('boh', 7), 7);
	ok('periodo a parole o in giorni');

	assert.strictEqual(mittenteSicuro('Mario Prova <mario@esempio.it>'), 'Mario Prova');
	assert.strictEqual(mittenteSicuro('"Anna" <anna@esempio.it>'), 'Anna');
	assert.strictEqual(mittenteSicuro('anna@esempio.it'), 'esempio.it');
	assert.strictEqual(mittenteSicuro(''), 'mittente senza nome');
	assert.strictEqual(contattoSicuro('+34 600 000 000', false), 'contatto senza nome');
	assert.strictEqual(contattoSicuro('', true), 'gruppo senza nome');
	assert.strictEqual(contattoSicuro('Mario Prova', false), 'Mario Prova');
	const a = anteprimaSicura('Chiamami al +34 600 000 000 o scrivi a mario@esempio.it adesso');
	assert.ok(!/600|@/.test(a), a);
	assert.ok(a.length <= 60);
	ok('mittenti, contatti e anteprime senza indirizzi ne\' numeri');

	// ---------- dentro il ponte ----------
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-stanze-'));
	const port = 20000 + Math.floor(Math.random() * 20000);
	const registro = [];
	let f = fonti();
	// le azioni finte: si guarda solo chi viene chiamato e con cosa, niente tocca i dati veri
	const chiamate = [];
	let lavoriPronti = true;
	const finte = {
		ignora: (id, motivo) => chiamate.push(['ignora', id, motivo]),
		ripristina: id => chiamate.push(['ripristina', id]),
		verifica: () => chiamate.push(['verifica']),
		lavoro: (p, compito) => (chiamate.push(['lavoro', p, compito]), lavoriPronti ? { id: 'job-7', stato: 'in coda' } : undefined),
	};
	const ponte = new Ponte({
		dir, versione: '9.9.9', porta: port,
		indirizzo: async () => ({ ip: '127.0.0.1', nome: 'mac-di-prova.tailnet.ts.net' }),
		stato: () => ({ melissa: { stato: 'idle', cervello: 'agnes', registro: [] }, lavori: [], conti: { inCorso: 0, tiAspetta: 0, inCoda: 0, vive: 0 } }),
		occupata: () => false, chiedi: async () => '', parla: async () => '', voce: async () => Buffer.alloc(0),
		scriviLavoro: () => false, registraDispositivo: () => undefined,
		log: r => registro.push(r),
		stanze: new StanzePonte({ fonti: () => f, lavori: () => LAVORI, tempoMs: 200, azioni: finte }),
	});
	await ponte.start();
	const token = JSON.parse(fs.readFileSync(path.join(dir, 'ponte.json'), 'utf8')).token;
	const get = q => call(port, token, 'GET', '/v1/stanza?' + q);
	const pulita = r => {
		assert.strictEqual(r.status, 200, r.testo);
		assert.ok(!DASH.test(r.testo), 'lineetta lunga o media: ' + r.testo.slice(0, 200));
		assert.ok(r.testo.length < 40_000, 'troppo grande: ' + r.testo.length);
		assert.strictEqual(r.body.ora, ORA);
		return r.body;
	};

	assert.strictEqual((await call(port, 'sbagliato', 'GET', '/v1/stanza?nome=appstore')).status, 401);
	assert.strictEqual((await call(port, token, 'POST', '/v1/stanza?nome=appstore')).status, 405);
	const ignota = await get('nome=cantina');
	assert.strictEqual(ignota.status, 400);
	assert.match(ignota.body.errore, /appstore, cruscotto/);
	ok('solo GET con il gettone, stanza sconosciuta 400');

	// App Store: mese, ieri, anno, un progetto
	let s = pulita(await get('nome=appstore'));
	assert.strictEqual(s.periodo, 30);
	assert.strictEqual(s.quale, 'giorni');
	assert.deepStrictEqual(s.cifre, { totale: 420, admob: 360, store: 60, download: 1200 });
	assert.deepStrictEqual(s.prima, { totale: 420, admob: 360, store: 60, download: 1200 });
	assert.strictEqual(s.grafico.length, 30);
	assert.strictEqual(s.grafico[29].chiave, '2026-10-02');
	assert.strictEqual(s.grafico[29].store, null, 'dopo storeFinoA lo Store manca, non e\' zero');
	assert.strictEqual(s.grafico[28].store, 2);
	assert.strictEqual(s.storeIncompleto, true);
	assert.deepStrictEqual(s.app.map(x => x.nome), ['Talky', 'Woofmap'], 'le app ferme non ci sono, la piu\' ricca in testa');
	assert.strictEqual(s.app[1].progetto, 'Woofmap');
	assert.strictEqual(s.buchi.length, 3);
	assert.strictEqual(s.buchi[0].progetto, 'Woofmap');
	assert.strictEqual(s.stimaTotale, 42);
	assert.strictEqual(s.allarmi.length, 1);
	assert.match(s.errori.admob, /AdMob non risponde, riprovo/);
	assert.strictEqual(s.abbonamenti.finoA, giorni[59]);
	assert.strictEqual(s.abbonamenti.attivi, 25);
	assert.strictEqual(s.abbonamenti.attiviPrima, 22);
	assert.strictEqual(s.abbonamenti.eventi.nuovi, 30);
	assert.ok(!('disdette' in s.abbonamenti.eventi), 'le categorie a zero non viaggiano');
	ok('App Store, ultimi 30 giorni: cifre, confronto, grafico con lo Store che manca, app, buchi, abbonati');

	s = pulita(await get('nome=appstore&periodo=ieri'));
	assert.strictEqual(s.etichetta, 'ieri');
	assert.strictEqual(s.cifre.totale, 14);
	assert.strictEqual(s.grafico.length, 7);
	assert.deepStrictEqual(s.grafico.map(x => x.nelPeriodo), [false, false, false, false, false, false, true]);
	s = pulita(await get('nome=appstore&periodo=anno'));
	assert.strictEqual(s.quale, 'mesi');
	assert.strictEqual(s.cifre.totale, 12 * 420);
	assert.strictEqual(s.grafico.length, 12);
	assert.strictEqual(s.storeIncompleto, false);
	s = pulita(await get('nome=appstore&periodo=anno&mese=2024-11'));
	assert.strictEqual(s.mese, '2024-11');
	assert.strictEqual(s.grafico[s.grafico.length - 1].store, null, 'un mese che Apple non da\' piu\'');
	s = pulita(await get('nome=appstore&periodo=settimana&progetto=woofmap'));
	assert.deepStrictEqual(s.cifre, { totale: 17.5, admob: 14, store: 3.5, download: 70 });
	assert.strictEqual(s.app.length, 1);
	assert.strictEqual(s.buchi.length, 2);
	assert.strictEqual(s.abbonamenti.attivi, 10);
	assert.strictEqual((await get('nome=appstore&progetto=nessuna')).status, 404);
	ok('App Store: ieri con la settimana intorno, anno a mesi, un mese preciso, un progetto');

	// App Store, i dati in piu' per l'iPhone (9.7): tendenza, versioni, scheda, paesi, buchi con il compito, chiusi
	s = pulita(await get('nome=appstore&periodo=settimana'));
	assert.strictEqual(s.controlloOre, 3);
	assert.strictEqual(s.grafico.length, 7);
	assert.strictEqual(s.grafico[0].prima.chiave, giorni[48], 'il punto del periodo prima: sette giorni indietro');
	assert.deepStrictEqual([s.grafico[0].prima.admob, s.grafico[0].prima.store], [12, 2]);
	assert.strictEqual(s.versioni.length, 0, 'senza un\'app scelta le versioni non ci sono, come sul Mac');
	assert.deepStrictEqual(s.app.map(x => [x.nome, x.totalePrima, x.buchi, x.subito]), [['Talky', 80.5, 1, 0], ['Woofmap', 17.5, 2, 1]]);
	assert.strictEqual(s.app[1].andamento.length, 7);
	assert.strictEqual(s.app[1].andamento[6], 2, 'oltre storeFinoA la scintilla non conta lo Store');
	assert.strictEqual(s.app[1].abbonati, 10);
	assert.deepStrictEqual(s.paesi[0], { codice: 'IT', euro: 12.35, impressioni: 4000 });
	assert.strictEqual(s.abbonamenti.serie.length, 7);
	assert.strictEqual(s.abbonamenti.serie[6].giorno, giorni[59]);
	assert.deepStrictEqual(s.abbonamenti.eventiPrima, { nuovi: 7 });
	assert.strictEqual(s.abbonamenti.mrrPrima, 50);
	assert.deepStrictEqual(s.abbonamenti.perApp.map(x => x.nome), ['Woofmap']);
	assert.deepStrictEqual([s.scheda.imp, s.scheda.vis, s.scheda.dl, s.scheda.impPrima, s.scheda.haPrima, s.scheda.giorni], [7000, 700, 70, 7000, true, 7]);
	assert.deepStrictEqual(s.scheda.fonti.map(x => x.fonte), ['ricerca'], 'le fonti a zero non viaggiano');
	assert.deepStrictEqual(s.scheda.perApp.map(x => [x.nome, x.imp]), [['Woofmap', 2800]]);
	const [ump, fill, mostrati] = s.buchi;
	assert.match(ump.compito, /^Nell'app Woofmap: Manca il consenso UMP\. Senza consenso, niente annunci/, 'senza compito della regola, il buco in chiaro');
	assert.strictEqual(fill.compito, undefined, 'senza progetto niente lavoro');
	assert.strictEqual(fill.verifica.esito, 'meglio');
	assert.strictEqual(fill.soglia, 0.6);
	assert.strictEqual(mostrati.compito, 'Nell\'app Woofmap sistema il ciclo degli interstitial. Usa la skill ios-admob-integration.', 'il compito della regola, su una riga');
	assert.strictEqual(ump.chiave, 'ios:2');
	assert.strictEqual(s.risolti[0].dopo, 0.7);
	assert.strictEqual(s.ignorati[0].motivo, 'li offro solo a chi li vuole');
	assert.strictEqual(s.dettaglio, null);
	ok('App Store per l\'iPhone: tendenza, abbonati giorno per giorno, scheda, paesi, buchi con il compito, risolti e ignorati');

	s = pulita(await get('nome=appstore&periodo=mese&app=ios%3A2'));
	assert.deepStrictEqual(s.app.map(x => x.chiave), ['ios:2']);
	assert.deepStrictEqual(s.versioni, [{ chiave: giorni[50], v: '2.1', app: 'Woofmap' }], 'solo le uscite dentro il grafico');
	assert.strictEqual(s.buchi.length, 2);
	assert.deepStrictEqual(s.risolti, []);
	assert.deepStrictEqual(s.paesi, []);
	const det = s.dettaglio;
	assert.strictEqual(det.nome, 'Woofmap');
	assert.strictEqual(det.suAdmob, true);
	assert.deepStrictEqual(det.formati.map(x => x.formato), ['interstitial'], 'i formati senza richieste non viaggiano');
	assert.strictEqual(det.unita[0].nome, 'Pausa prova');
	assert.strictEqual(det.acquisti.euro, 21.34);
	assert.deepStrictEqual(det.versioni.map(v => v.v), ['2.1', '2.0'], 'la piu\' recente in testa');
	assert.deepStrictEqual([det.codice.sdk, det.codice.ump, det.codice.skan, det.codice.idProva], [true, false, 12, 0]);
	assert.strictEqual(s.scheda.imp, 40 * 10 * 30);
	assert.strictEqual(s.abbonamenti.attivi, 10);
	s = pulita(await get('nome=appstore&periodo=anno&app=ios%3A2'));
	assert.deepStrictEqual(s.versioni, [{ chiave: mesi[23], v: '2.1', app: 'Woofmap' }]);
	assert.strictEqual((await get('nome=appstore&app=ios%3A99')).status, 404);
	ok('App Store, la scheda di un\'app: versioni nel grafico, formati, unita\', acquisti, codice');

	// le azioni: gettone, solo POST, elenco chiuso, il progetto viene dal buco, mai un push
	const azione = c => call(port, token, 'POST', '/v1/stanza/azione', c);
	assert.strictEqual((await call(port, 'sbagliato', 'POST', '/v1/stanza/azione', { stanza: 'appstore', azione: 'verifica' })).status, 401);
	assert.strictEqual((await call(port, token, 'GET', '/v1/stanza/azione')).status, 405);
	for (const a of ['push', 'pubblica', 'deploy', 'rilascia', '', 'lavoro ']) {
		const r = await azione({ stanza: 'appstore', azione: a, id: 'ios:2:ump' });
		assert.strictEqual(r.status, 400, a);
		assert.match(r.body.errore, /ignora, ripristina, verifica, lavoro/);
	}
	assert.strictEqual((await azione({ stanza: 'vedetta', azione: 'verifica' })).status, 400);
	assert.strictEqual(chiamate.length, 0, 'nessuna azione sconosciuta e\' arrivata ai gestori');
	ok('azioni: gettone, solo POST, elenco chiuso (niente push ne\' pubblicazioni)');

	let r = await azione({ stanza: 'appstore', azione: 'verifica' });
	assert.strictEqual(r.status, 200);
	assert.match(r.body.messaggio, /Rileggo/);
	assert.deepStrictEqual(chiamate.pop(), ['verifica']);
	r = await azione({ stanza: 'appstore', azione: 'ignora', id: 'ios:1:nessuno', motivo: 'x' });
	assert.strictEqual(r.status, 404);
	r = await azione({ stanza: 'appstore', azione: 'ignora', id: 'ios:1:fill', motivo: 'la mediazione\nla cambio a novembre' });
	assert.strictEqual(r.status, 200);
	assert.deepStrictEqual(chiamate.pop(), ['ignora', 'ios:1:fill', 'la mediazione la cambio a novembre']);
	assert.strictEqual((await azione({ stanza: 'appstore', azione: 'ripristina', id: 'ios:1:fill' })).status, 404, 'si ripristina solo un ignorato');
	r = await azione({ stanza: 'appstore', azione: 'ripristina', id: 'ios:1:premio' });
	assert.strictEqual(r.status, 200);
	assert.deepStrictEqual(chiamate.pop(), ['ripristina', 'ios:1:premio']);
	ok('azioni: verifica di nuovo, ignora con il motivo, ripristina, buchi che non ci sono 404');

	r = await azione({ stanza: 'appstore', azione: 'lavoro', id: 'ios:1:fill' });
	assert.strictEqual(r.status, 409, 'senza progetto sul Mac niente lavoro');
	assert.match(r.body.errore, /progetto/);
	lavoriPronti = false;
	assert.strictEqual((await azione({ stanza: 'appstore', azione: 'lavoro', id: 'ios:2:ump' })).status, 503);
	chiamate.pop();
	lavoriPronti = true;
	r = await azione({ stanza: 'appstore', azione: 'lavoro', id: 'ios:2:ump', path: '/etc', progetto: 'altro', compito: 'Aggiungi UMP\ncon la skill\u0007 ios-admob-integration' });
	assert.strictEqual(r.status, 200, r.testo);
	assert.deepStrictEqual([r.body.lavoro, r.body.stato, r.body.progetto], ['job-7', 'in coda', 'Woofmap']);
	const [cosa, dove, compito] = chiamate.pop();
	assert.strictEqual(cosa, 'lavoro');
	assert.strictEqual(dove, '/prove/woofmap', 'il progetto viene dal buco, non dalla richiesta');
	assert.ok(compito.startsWith('Aggiungi UMP con la skill ios-admob-integration '), compito);
	assert.ok(!/[\n\u0007]/.test(compito), 'una riga sola, senza caratteri di controllo');
	assert.match(compito, /non fare git push, non pubblicare/);
	assert.strictEqual((await azione({ stanza: 'appstore', azione: 'lavoro', id: 'ios:2:ump' })).status, 409, 'un doppio tocco non avvia due lavori');
	assert.strictEqual(chiamate.length, 0);
	r = await azione({ stanza: 'appstore', azione: 'lavoro', id: 'ios:2:mostrati:interstitial' });
	assert.strictEqual(r.status, 200);
	assert.match(chiamate.pop()[2], /^Nell'app Woofmap sistema il ciclo.*ios-admob-integration\. Questo lavoro parte dall'iPhone/, 'senza testo dall\'iPhone, il compito del buco');
	assert.ok(!registro.some(x => /UMP|interstitial|Woofmap/.test(x)), 'niente compiti nel registro del ponte');
	ok('azioni: «Fallo sistemare a Claude» sul progetto del buco, compito su una riga con il divieto di push, niente doppioni');

	// cruscotto
	s = pulita(await get('nome=cruscotto'));
	assert.strictEqual(s.periodo, 7);
	assert.strictEqual(s.cifre.tu, 1500);
	assert.strictEqual(s.prima.tu, 1300);
	assert.strictEqual(s.grafico.length, 7);
	assert.strictEqual(s.grafico[6].giorno, '2026-10-03');
	assert.deepStrictEqual(s.progetti.map(x => x.nome), ['Woofmap', 'Bottega', 'Fuori dai progetti']);
	assert.strictEqual(s.vive, 2);
	assert.strictEqual(s.settimana.tu, 1100);
	s = pulita(await get('nome=cruscotto&periodo=anno&progetto=bottega'));
	assert.strictEqual(s.periodo, 90);
	assert.ok(s.anno);
	assert.strictEqual(s.cifre.tu, 6000);
	assert.strictEqual(s.grafico.length, 90);
	assert.strictEqual(s.grafico[0].tu, 60);
	assert.strictEqual(s.grafico[0].claude, null);
	assert.strictEqual(s.progetti.length, 0);
	lenta = true;
	const lento = await get('nome=cruscotto');
	lenta = false;
	assert.strictEqual(lento.status, 503);
	assert.match(lento.body.errore, /riprova tra poco/);
	ok('cruscotto: periodo, grafico dei giorni, progetti, un progetto, calcolo lento -> 503');

	// Vedetta
	s = pulita(await get('nome=vedetta'));
	assert.deepStrictEqual(s.progetti.map(x => x.nome), ['Woofmap', 'Bottega'], 'prima i rossi, i verdi no');
	assert.match(s.progetti[0].regole[0].frase, /spingere, subito/);
	assert.strictEqual(s.globali.length, 1);
	assert.deepStrictEqual(s.siti.elenco.map(x => x.nome), ['sito-prova', 'checkin-web'], 'prima le fallite');
	assert.strictEqual(s.siti.elenco[0].onlineDal, ORA - 3 * D);
	assert.deepStrictEqual(s.siti.conti, { male: 1, attesa: 0, ok: 1 });
	s = pulita(await get('nome=vedetta&progetto=checkin'));
	assert.strictEqual(s.progetti.length, 0);
	assert.strictEqual(s.siti.elenco.length, 1);
	ok('Vedetta: semaforo con i rossi in testa e i siti su Vercel');

	// cose da fare
	s = pulita(await get('nome=dafare'));
	assert.deepStrictEqual(s.progetti.map(x => x.nome), ['Bottega', 'Woofmap']);
	assert.deepStrictEqual(s.progetti[0].cose, ['provare la voce', 'scrivere il contratto', 'aggiornare il README']);
	assert.strictEqual(s.progetti[1].path, '/prove/woofmap');
	s = pulita(await get('nome=dafare&progetto=woofmap'));
	assert.strictEqual(s.progetti.length, 1);
	ok('cose da fare: l\'ultima lista di ogni progetto');

	// posta e WhatsApp
	const rp = await get('nome=posta');
	s = pulita(rp);
	assert.ok(!/@|\+34|600 000|34600|privato/.test(rp.testo), 'indirizzi, numeri o corpi nella risposta: ' + rp.testo);
	assert.strictEqual(s.progetti.length, 1, 'i progetti senza posta non viaggiano');
	const p = s.progetti[0];
	assert.deepStrictEqual(p.mail.map(m => m.da), ['Mario Prova', 'esempio.it']);
	assert.strictEqual(p.mail[0].oggetto, 'Preventivo, seconda parte');
	assert.deepStrictEqual(p.chat.map(c => c.contatto), ['Mario Prova', 'contatto senza nome']);
	assert.match(p.chat[0].anteprima, /\[numero\]/);
	assert.deepStrictEqual(s.conti, { nonLetti: 2, chatDaRispondere: 1, mailDaAssegnare: 3, chatDaAssegnare: 1 });
	assert.strictEqual((await get('nome=posta&progetto=bottega')).body.progetti.length, 0);
	ok('posta e WhatsApp: nomi, oggetti e anteprime brevi, mai indirizzi o numeri');

	// clienti
	s = pulita(await get('nome=clienti'));
	assert.deepStrictEqual(s.clienti.map(c => c.nome), ['Studio Prova', 'Bianchi Prova']);
	assert.strictEqual(s.clienti[0].importo, 312.5);
	assert.strictEqual(s.clienti[0].tariffa, 50);
	assert.deepStrictEqual(s.totale, { minuti: 375, importo: 312.5 });
	assert.strictEqual(s.inCorso, true);
	ok('clienti: ore e importi del mese');

	// notte
	s = pulita(await get('nome=notte'));
	assert.strictEqual(s.fila.length, 1);
	assert.strictEqual(s.fila[0].titolo, 'Rifai i test');
	assert.strictEqual(s.resoconto.lavori[0].riassunto, 'Aggiornate le dipendenze, tutto verde.');
	ok('notte: finestra, fila e resoconto');

	// elenchi lunghi tagliati
	const molti = {};
	for (let i = 0; i < 400; i++) molti[`/prove/p${i}`] = { path: `/prove/p${i}`, livello: 'rosso', checkedAt: ORA, hits: Array(6).fill({ id: 'push', livello: 'giallo', frase: 'x'.repeat(500), rimedio: 'y'.repeat(500) }) };
	f = fonti({ regole: () => ({ ...REGOLE, projects: molti }) });
	const grande = await get('nome=vedetta');
	s = pulita(grande);
	assert.strictEqual(s.progetti.length, 25);
	assert.strictEqual(s.progettiTotali, 400);
	assert.strictEqual(s.progetti[0].regole.length, 3);
	assert.strictEqual(s.progetti[0].altre, 3);
	ok(`elenchi lunghi tagliati (${grande.testo.length} byte)`);

	// stanze non pronte
	f = undefined;
	assert.strictEqual((await get('nome=appstore')).status, 503);
	assert.strictEqual((await call(port, token, 'POST', '/v1/stanza/azione', { stanza: 'appstore', azione: 'verifica' })).status, 503, 'azioni con la stanza non pronta');
	f = fonti({ appStore: () => ({ ...APPSTORE, aggiornatoAt: 0, aggiornando: true }), connettori: undefined });
	const primaVolta = await get('nome=appstore');
	assert.strictEqual(primaVolta.status, 503);
	assert.match(primaVolta.body.errore, /prima volta/);
	assert.strictEqual((await get('nome=posta')).status, 503);
	ok('stanze non pronte: 503 con la frase');

	// i registri del ponte non portano dati delle stanze
	const tutto = registro.join('\n');
	assert.ok(!/Mario|esempio|Preventivo|Studio Prova/.test(tutto), 'dati nel registro: ' + tutto);
	ok('niente dati delle stanze nei registri del ponte');

	ponte.stop();
	fs.rmSync(dir, { recursive: true, force: true });
	console.log(`\n${passed} prove passate`);
})().catch(e => {
	console.error(e);
	process.exit(1);
});
