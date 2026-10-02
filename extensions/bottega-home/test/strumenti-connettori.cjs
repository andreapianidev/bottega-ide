#!/usr/bin/env node
// Banco di prova degli strumenti di Melissa sui connettori (src/strumenti-connettori.ts) e della riga del calendario
// nel briefing. NON spedito (vedi .vscodeignore). Dati tutti inventati (esempio.it): il repository e' pubblico.
// Niente server veri e niente `claude -p`: server MCP finti in una cartella temporanea, coda delle deleghe finta.

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const assert = require('assert');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'test-out', 'strumenti-connettori');
esbuild.buildSync({
	entryPoints: ['strumenti-connettori', 'connettori', 'connettori-mappa', 'delega', 'mcp', 'briefing'].map(n => path.join(SRC, n + '.ts')),
	outdir: OUT,
	format: 'cjs',
	platform: 'node',
	bundle: false,
	target: 'node20',
	logLevel: 'silent',
});

// finto modulo vscode: solo le impostazioni
const configStore = {};
const origLoad = Module._load;
Module._load = function (request) {
	if (request === 'vscode') return { workspace: { getConfiguration: () => ({ get: (k, d) => (k in configStore ? configStore[k] : d) }) } };
	return origLoad.apply(this, arguments);
};

const req = n => require(path.join(OUT, n + '.js'));
const S = req('strumenti-connettori');
const B = req('briefing');
const D = req('delega');
const K = req('connettori');

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-strumenti-'));
const DASH = /[\u2013\u2014]/;

// ---------- un server MCP finto: registra ogni avvio, risponde a tools/list e tools/call ----------

const avvii = path.join(tmp, 'avvii.log');
const server = path.join(tmp, 'server-finto.cjs');
fs.writeFileSync(
	server,
	`const fs = require('fs');
fs.appendFileSync(${JSON.stringify(avvii)}, 'avvio\\n');
let buf = '';
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', c => {
	buf += c;
	let i;
	while ((i = buf.indexOf('\\n')) >= 0) {
		const m = JSON.parse(buf.slice(0, i));
		buf = buf.slice(i + 1);
		if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'finto', version: '0' } } });
		else if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: [
			{ name: 'list_apps', description: 'Le app del conto. Seconda frase che non serve.', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, periodo: { type: 'string', enum: ['ieri', 'settimana'] } }, required: ['periodo'] } },
			{ name: 'search_reviews', description: 'Cerca nelle recensioni.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
			{ name: 'send_message', description: 'Invia un messaggio.' },
			{ name: 'revenue_trend', description: 'Andamento.' },
		] } });
		else if (m.method === 'tools/call') {
			const a = m.params.arguments || {};
			const data = a.grande ? { testo: 'x'.repeat(400), righe: Array.from({ length: 200 }, (_, k) => ({ app: 'App ' + k, nota: 'riga di prova ' + k, vuoto: '', niente: null })) } : { apps: [{ nome: 'Prova', sito: 'esempio.it', vuoto: null }], visti: a };
			out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
		}
	}
});`,
);
const claudeJson = path.join(tmp, 'claude.json');
fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'finto-mcp': { type: 'stdio', command: process.execPath, args: [server], env: { CHIAVE_FINTA: 'valore-segreto-finto' } } } }));
const quantiAvvii = () => (fs.existsSync(avvii) ? fs.readFileSync(avvii, 'utf8').trim().split('\n').filter(Boolean).length : 0);

// ---------- connettori finti e coda finta ----------

const conn = (nome, o) => ({
	nome,
	pulito: nome.toLowerCase().replace(/^claude\.ai\s+/, ''),
	tipo: 'claude.ai',
	stato: 'connesso',
	prefisso: 'mcp__' + nome.replace(/[^A-Za-z0-9_-]/g, '_') + '__',
	capacita: [],
	diretto: false,
	ambito: 'claude.ai',
	...o,
});
const CONNETTORI = [
	conn('finto-mcp', { tipo: 'locale', diretto: true, ambito: 'utente', capacita: ['pubblicita'] }),
	conn('claude.ai Gmail', { capacita: ['posta'] }),
	conn('claude.ai Google Calendar', { capacita: ['calendario'] }),
	conn('claude.ai Notion', { stato: 'da autenticare' }),
];

function fonteFinta(o = {}) {
	const dir = o.dir ?? fs.mkdtempSync(path.join(tmp, 'dir-'));
	const f = {
		dir,
		richieste: [],
		spesaOggi: o.spesaOggi ?? 0,
		tetto: o.tetto ?? 1,
		connettori: o.connettori ?? CONNETTORI,
		esito: o.esito ?? (r => ({ capacita: r.capacita, at: Date.now(), ok: true, costo: 0.2, durataMs: 30000, data: { risposta: 'Hai due mail nuove da esempio.it.' } })),
		scoperta: { stato: () => ({ aggiornatoAt: 1, aggiornando: false, connettori: f.connettori, capacita: [] }) },
		coda: {
			stato: () => ({ inCorso: null, coda: [], spesaOggi: f.spesaOggi, tetto: f.tetto, modello: 'haiku', stime: { chiedi: { secondi: 40, usd: 0.3 } } }),
			accoda: async r => {
				f.richieste.push(r);
				const e = f.esito(r);
				// come la coda vera: l'esito si salva in <dir>/<capacita>.json, file 600
				D.scriviPrivato(path.join(dir, r.capacita + '.json'), e);
				return e;
			},
		},
	};
	return f;
}

function ctxFinto() {
	const c = {
		pending: undefined,
		azioni: [],
		annunci: [],
		deps: {},
		setPending(p) {
			c.pending = p;
		},
		azione(t) {
			c.azioni.push(t);
		},
		async announce(t) {
			c.annunci.push(t);
		},
		getState() {
			return { state: 'idle' };
		},
	};
	return c;
}

const T = S.STRUMENTI_CONNETTORI;
const log = [];

(async () => {
	console.log('strumenti di Melissa sui connettori');

	await test('specifiche: tre strumenti in forma OpenAI, descrizioni in italiano senza lineette', () => {
		assert.deepStrictEqual(Object.keys(T), ['connettori_elenco', 'connettore_leggi', 'connettore_chiedi']);
		for (const [k, t] of Object.entries(T)) {
			assert.strictEqual(t.spec.type, 'function');
			assert.strictEqual(t.spec.function.name, k);
			assert.strictEqual(t.spec.function.parameters.type, 'object');
			assert.ok(!DASH.test(t.spec.function.description), k);
		}
		assert.ok(/esplicitamente/.test(T.connettore_leggi.spec.function.description), 'whatsapp e posta solo su richiesta');
		assert.ok(/admob/.test(T.connettore_leggi.spec.function.description) && /searchconsole/.test(T.connettore_leggi.spec.function.description));
		assert.strictEqual(T.connettore_chiedi.risky, true);
	});

	await test('pezzi puri: troncamento, compattazione, nomi brevi, argomenti', () => {
		const lungo = 'a'.repeat(20000);
		const t = S.tronca(lungo);
		assert.ok(t.length < 6300 && t.startsWith('a'.repeat(6000)) && /troncato: 20000 caratteri/.test(t));
		assert.strictEqual(S.tronca('corto'), 'corto');
		assert.deepStrictEqual(S.compatta({ a: null, b: '', c: [], d: { e: undefined }, f: 1, g: [null, 'x'] }), { f: 1, g: ['x'] });
		assert.strictEqual(S.nomeBreve('mcp__finto-mcp__list_apps'), 'list_apps');
		assert.strictEqual(S.descrizioneBreve('Le app del conto. Seconda frase.'), 'Le app del conto.');
		assert.strictEqual(S.argomentiBrevi({ properties: { a: { type: 'string' }, b: { enum: ['x', 'y'] } }, required: ['a'] }), 'a*: string, b: x|y');
		assert.deepStrictEqual(S.strumentiLeggibili([{ name: 'list_apps' }, { name: 'send_message' }, { name: 'get_or_create' }]).map(x => x.name), ['list_apps']);
		const noti = S.strumentiNoti(CONNETTORI[1]);
		assert.ok(noti.includes('mcp__claude_ai_Gmail__search_threads'));
		assert.ok(noti.every(n => !/send|reply|draft_create|trash/.test(n)));
	});

	await test('trova i connettori per nome, pezzo di nome o capacita\'', () => {
		const t = n => S.trovaConnettori(CONNETTORI, [n]).map(c => c.nome);
		assert.deepStrictEqual(t('Gmail'), ['claude.ai Gmail']);
		assert.deepStrictEqual(t('google calendar'), ['claude.ai Google Calendar']);
		assert.deepStrictEqual(t('calendario'), ['claude.ai Google Calendar']);
		assert.deepStrictEqual(t('finto'), ['finto-mcp']);
		assert.deepStrictEqual(t('inesistente'), []);
	});

	await test('connettore_leggi: chi scrive e\' rifiutato senza avviare il processo', async () => {
		const f = fonteFinta();
		S.registraStrumentiConnettori(f, { claudeJson, dir: f.dir, log: s => log.push(s) });
		const prima = quantiAvvii();
		for (const nome of ['send_message', 'mcp__finto-mcp__delete_message', 'revenue_trend', 'list_and_delete']) {
			const r = await T.connettore_leggi.run({ server: 'finto-mcp', strumento: nome, argomenti: {} }, ctxFinto());
			assert.ok(/^Rifiutato/.test(r), r);
		}
		assert.strictEqual(quantiAvvii(), prima, 'nessun processo avviato');
	});

	await test('connettore_leggi: legge, compatta, chiude il server, niente contenuti ne\' chiavi nei log', async () => {
		const f = fonteFinta();
		S.registraStrumentiConnettori(f, { claudeJson, dir: f.dir, log: s => log.push(s) });
		const ctx = ctxFinto();
		const prima = quantiAvvii();
		const r = await T.connettore_leggi.run({ server: 'finto-mcp', strumento: 'list_apps', argomenti: '{"periodo":"ieri"}' }, ctx);
		assert.ok(/Risultato di finto-mcp\.list_apps/.test(r), r);
		assert.ok(r.includes('"nome":"Prova"') && r.includes('"visti":{"periodo":"ieri"}'), r);
		assert.ok(!r.includes('vuoto'), 'campi vuoti tolti');
		assert.strictEqual(quantiAvvii(), prima + 1);
		assert.deepStrictEqual(ctx.azioni, ['Ho letto da finto-mcp']);
		const tutto = log.join('\n');
		assert.ok(!/Prova|esempio\.it|valore-segreto-finto|periodo/.test(tutto), tutto);
		// argomenti non validi e server sconosciuti
		assert.ok(/Argomenti non validi/.test(await T.connettore_leggi.run({ server: 'finto-mcp', strumento: 'list_apps', argomenti: '[1' }, ctx)));
		assert.ok(/connettore_chiedi/.test(await T.connettore_leggi.run({ server: 'Gmail', strumento: 'search_threads' }, ctx)));
		assert.ok(/Non trovo un server locale/.test(await T.connettore_leggi.run({ server: 'nessuno', strumento: 'list_apps' }, ctx)));
	});

	await test('connettore_leggi: risultato grande troncato a circa 6000 caratteri', async () => {
		const f = fonteFinta();
		S.registraStrumentiConnettori(f, { claudeJson, dir: f.dir, log: () => {} });
		const r = await T.connettore_leggi.run({ server: 'finto-mcp', strumento: 'search_reviews', argomenti: { grande: true } }, ctxFinto());
		assert.ok(r.length <= S.MASSIMO_CARATTERI + 300, String(r.length));
		assert.ok(/troncato/.test(r));
	});

	await test('connettori_elenco: tipi, stati e solo gli strumenti di sola lettura, con cache', async () => {
		const f = fonteFinta();
		S.registraStrumentiConnettori(f, { claudeJson, dir: f.dir, log: () => {} });
		const prima = quantiAvvii();
		const r = await T.connettori_elenco.run({}, ctxFinto());
		assert.ok(/Diretti e gratis/.test(r) && /Via Claude, a pagamento/.test(r), r);
		assert.ok(/finto-mcp \(connesso\): 2 di sola lettura: list_apps, search_reviews/.test(r), r);
		assert.ok(!/send_message|revenue_trend/.test(r));
		assert.ok(/claude\.ai Notion: da autenticare/.test(r));
		const uno = await T.connettori_elenco.run({ server: 'finto-mcp' }, ctxFinto());
		assert.ok(/list_apps\(limit: number, periodo\*: ieri\|settimana\): Le app del conto\./.test(uno), uno);
		const filtrato = await T.connettori_elenco.run({ server: 'finto-mcp', cerca: 'recension' }, ctxFinto());
		assert.ok(/search_reviews/.test(filtrato) && !/list_apps/.test(filtrato), filtrato);
		assert.strictEqual(quantiAvvii(), prima + 1, 'un solo avvio: poi la cache');
		const gm = await T.connettori_elenco.run({ server: 'gmail' }, ctxFinto());
		assert.ok(/via Claude, a pagamento/.test(gm) && /search_threads/.test(gm), gm);
		assert.ok(!DASH.test(r + uno + gm));
	});

	await test('connettore_chiedi: chiede conferma con tempo e costo, la delega parte solo dopo il si', async () => {
		const f = fonteFinta();
		S.registraStrumentiConnettori(f, { claudeJson, dir: f.dir, log: () => {} });
		const ctx = ctxFinto();
		const r = await T.connettore_chiedi.run({ compito: 'Ho mail nuove da esempio.it?', connettori: ['Gmail'] }, ctx);
		assert.ok(/confermi\?/.test(r) && /40 secondi/.test(r) && /0,30 dollari/.test(r), r);
		assert.ok(ctx.pending, 'conferma in sospeso');
		assert.strictEqual(f.richieste.length, 0, 'niente delega prima del si');
		ctx.pending.run();
		await new Promise(r => setTimeout(r, 50));
		assert.strictEqual(f.richieste.length, 1);
		const q = f.richieste[0];
		assert.strictEqual(q.capacita, 'chiedi');
		assert.ok(q.strumenti.length && q.strumenti.every(s => s.startsWith('mcp__claude_ai_Gmail__')));
		assert.ok(q.strumenti.every(s => K.soloLettura(s) && !/_(send|reply|forward|trash|label|create|update|delete)(_|$)/.test(s)), q.strumenti.join());
		assert.ok(/risposta/.test(q.schema));
		assert.deepStrictEqual(ctx.annunci, ['Da Gmail: Hai due mail nuove da esempio.it.']);
		assert.ok(/40 secondi/.test(ctx.pending.done));
	});

	await test('connettore_chiedi: tetto raggiunto, connettore da autenticare, server locale', async () => {
		const f = fonteFinta({ spesaOggi: 0.9, tetto: 1 });
		S.registraStrumentiConnettori(f, { claudeJson, dir: f.dir, log: () => {} });
		const ctx = ctxFinto();
		assert.ok(/tetto di spesa/.test(await T.connettore_chiedi.run({ compito: 'x', connettori: 'Gmail' }, ctx)));
		assert.ok(!ctx.pending);
		const f2 = fonteFinta();
		S.registraStrumentiConnettori(f2, { claudeJson, dir: f2.dir, log: () => {} });
		assert.ok(/da autenticare/.test(await T.connettore_chiedi.run({ compito: 'x', connettori: ['Notion'] }, ctx)));
		assert.ok(/connettore_leggi/.test(await T.connettore_chiedi.run({ compito: 'x', connettori: 'finto-mcp' }, ctx)));
		assert.ok(!ctx.pending);
		// una delega fallita si dice, senza eccezioni
		const f3 = fonteFinta({ esito: r => ({ capacita: r.capacita, at: Date.now(), ok: false, costo: 0, durataMs: 0, errore: 'Prompt is too long' }) });
		S.registraStrumentiConnettori(f3, { claudeJson, dir: f3.dir, log: () => {} });
		const c3 = ctxFinto();
		await T.connettore_chiedi.run({ compito: 'x', connettori: ['Gmail'] }, c3);
		c3.pending.run();
		await new Promise(r => setTimeout(r, 50));
		assert.ok(/non e' riuscita/.test(c3.annunci[0]), c3.annunci[0]);
	});

	// ---------- il calendario del briefing ----------

	const facts = now => ({ jobs: [], forgotten: [], projects: [], now });
	const MATTINA = new Date(2026, 9, 2, 8, 30).getTime();

	await test('briefing: riga del calendario dalla delega di oggi, una delega sola', async () => {
		const f = fonteFinta({
			esito: r => ({ capacita: r.capacita, at: MATTINA + 1000, ok: true, costo: 0.2, durataMs: 30000, data: { giorno: '2026-10-02', eventi: [{ ora: '16:30', titolo: 'Dentista' }, { ora: '9:00', titolo: 'Chiamata con esempio.it \u2014 preventivo' }] } }),
		});
		S.registraStrumentiConnettori(f, { claudeJson, dir: f.dir, log: () => {}, ora: () => MATTINA });
		// la prima volta non c'e' ancora: niente riga, la delega parte in background
		assert.ok(!B.briefingPoints(facts(MATTINA)).some(p => p.kind === 'calendario'));
		await new Promise(r => setTimeout(r, 50));
		assert.strictEqual(f.richieste.length, 1);
		assert.strictEqual(f.richieste[0].capacita, 'calendario');
		assert.deepStrictEqual(f.richieste[0].strumenti, ['mcp__claude_ai_Google_Calendar__list_events']);
		const file = path.join(f.dir, 'calendario.json');
		assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
		const p = B.briefingPoints(facts(MATTINA)).find(x => x.kind === 'calendario');
		assert.strictEqual(p.text, 'Oggi hai: 09:00 Chiamata con esempio.it, preventivo, 16:30 Dentista.');
		B.briefingPoints(facts(MATTINA));
		assert.strictEqual(f.richieste.length, 1, 'una delega al giorno');
	});

	await test('briefing: senza riga e senza errori quando la delega fallisce, e non riprova', async () => {
		const f = fonteFinta({ esito: r => ({ capacita: r.capacita, at: MATTINA, ok: false, costo: 0.1, durataMs: 5000, errore: 'Prompt is too long' }) });
		S.registraStrumentiConnettori(f, { claudeJson, dir: f.dir, log: () => {}, ora: () => MATTINA });
		const a = B.briefingPoints(facts(MATTINA));
		await new Promise(r => setTimeout(r, 50));
		const b = B.briefingPoints(facts(MATTINA));
		assert.ok(![...a, ...b].some(p => p.kind === 'calendario'));
		assert.strictEqual(f.richieste.length, 1);
		// anche dopo un riavvio (memoria azzerata): il file di oggi dice che si e' gia' tentato
		S.registraStrumentiConnettori(f, { claudeJson, dir: f.dir, log: () => {}, ora: () => MATTINA });
		B.briefingPoints(facts(MATTINA));
		await new Promise(r => setTimeout(r, 20));
		assert.strictEqual(f.richieste.length, 1);
		assert.ok(B.plainBriefing(b).startsWith('Buongiorno.'));
	});

	await test('briefing: niente delega prima delle 5, con l\'impostazione spenta o senza Google Calendar', async () => {
		const notte = new Date(2026, 9, 2, 3, 0).getTime();
		const f = fonteFinta();
		S.registraStrumentiConnettori(f, { claudeJson, dir: f.dir, log: () => {} });
		B.briefingPoints(facts(notte));
		configStore['briefing.calendario'] = false;
		B.briefingPoints(facts(MATTINA));
		delete configStore['briefing.calendario'];
		const g = fonteFinta({ connettori: CONNETTORI.filter(c => !/Calendar/.test(c.nome)) });
		S.registraStrumentiConnettori(g, { claudeJson, dir: g.dir, log: () => {} });
		B.briefingPoints(facts(MATTINA));
		await new Promise(r => setTimeout(r, 20));
		assert.strictEqual(f.richieste.length + g.richieste.length, 0);
		// tetto raggiunto: la coda vera rifiuta senza scrivere il file; il briefing esce lo stesso
		B.impostaFonteCalendario(() => {
			throw new Error('fonte rotta');
		});
		assert.ok(Array.isArray(B.briefingPoints(facts(MATTINA))));
	});

	await test('frase del calendario: ordine, tutto il giorno, al massimo cinque, agenda vuota', () => {
		assert.strictEqual(B.fraseCalendario([]), 'Oggi in agenda non hai niente.');
		const tanti = [1, 2, 3, 4, 5, 6, 7].map(h => ({ ora: `1${h}:00`, titolo: `Prova ${h}` }));
		assert.strictEqual(B.fraseCalendario([{ ora: 'tutto il giorno', titolo: 'Fiera' }, ...tanti]), 'Oggi hai: tutto il giorno Fiera, 11:00 Prova 1, 12:00 Prova 2, 13:00 Prova 3, 14:00 Prova 4, e altri 3.');
		assert.ok(!DASH.test(B.fraseCalendario([{ ora: '10:00', titolo: 'A \u2013 B \u2014 C' }])));
		// con Facts.calendario esplicito, la fonte non serve
		const p = B.briefingPoints({ ...facts(MATTINA), calendario: [{ ora: '10:00', titolo: 'Prova' }] });
		assert.strictEqual(p[0].text, 'Oggi hai: 10:00 Prova.');
		assert.ok(!B.briefingPoints({ ...facts(MATTINA), calendario: null }).some(x => x.kind === 'calendario'));
	});

	await test('leggiCalendario: file di ieri o rotto = assente', () => {
		const f = path.join(tmp, 'cal.json');
		assert.deepStrictEqual(S.leggiCalendario(f, '2026-10-02'), { stato: 'assente' });
		fs.writeFileSync(f, JSON.stringify({ at: new Date(2026, 9, 1, 9).getTime(), ok: true, data: { eventi: [] } }));
		assert.deepStrictEqual(S.leggiCalendario(f, '2026-10-02'), { stato: 'assente' });
		fs.writeFileSync(f, JSON.stringify({ at: MATTINA, ok: true, data: { risposta: 'forma diversa' } }));
		assert.deepStrictEqual(S.leggiCalendario(f, '2026-10-02'), { stato: 'tentato' });
		fs.writeFileSync(f, 'non json');
		assert.deepStrictEqual(S.leggiCalendario(f, '2026-10-02'), { stato: 'assente' });
	});

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(`\n${passed} ok, ${failed} falliti`);
	if (failed) {
		console.log('falliti: ' + fails.join('; '));
		process.exit(1);
	}
})();
