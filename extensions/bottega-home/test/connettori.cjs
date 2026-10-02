#!/usr/bin/env node
// Banco di prova dei connettori e della posta per progetto. NON spedito (vedi .vscodeignore).
// Dati tutti inventati (esempio.it e simili): il repository e' pubblico, niente nomi o indirizzi veri.
// Niente chiamate reali: `claude -p`, `claude mcp list` e i server di posta sono finti. L'unica prova vera
// (una delega Gmail che chiede solo un conteggio) parte con BOTTEGA_TEST_REALE=1.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'test-out', 'connettori');
esbuild.buildSync({
	entryPoints: ['connettori', 'connettori-mappa', 'delega', 'posta', 'mcp', 'claude'].map(n => path.join(SRC, n + '.ts')),
	outdir: OUT,
	format: 'cjs',
	platform: 'node',
	bundle: false,
	target: 'node20',
	logLevel: 'silent',
});
const req = n => require(path.join(OUT, n + '.js'));
const K = req('connettori');
const D = req('delega');
const P = req('posta');
const M = req('mcp');

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-connettori-'));
const mode = f => fs.statSync(f).mode & 0o777;
const DASH = /[\u2013\u2014]/;

// Un'uscita di `claude mcp list` inventata, con tutte le forme viste: claude.ai, plugin, locali, http, stati diversi.
const MCP_LIST = `Checking MCP server health…

claude.ai Gmail: https://gmail.esempio.invalid/mcp - ✔ Connected
claude.ai Google Calendar: https://calendar.esempio.invalid/mcp - ✔ Connected
claude.ai Vercel: https://vercel.esempio.invalid/mcp - ✔ Connected
claude.ai Notion: https://notion.esempio.invalid/mcp - ! Needs authentication
plugin:sales:gmail:  (HTTP) - - Not configured
plugin:design:slack: https://slack.esempio.invalid/mcp (HTTP) - ! Needs authentication
posta-locale: node /Users/prova/posta-locale/index.js - ✔ Connected
asc-mcp: /Users/prova/.mint/bin/asc-mcp  - ✔ Connected
admob: node /Users/prova/admob-mcp/server.js - ✗ Failed to connect
gare-pubbliche: https://gare.esempio.invalid/mcp (HTTP) - ✔ Connected
`;

const MAPPA_PROVA = K.unisciMappa({ posta: ['posta-locale'], calendario: '/^agenda/' });

(async () => {
	console.log('connettori e posta');

	// ---------- scoperta ----------

	await test('claude mcp list: nomi, tipi, stati, prefissi degli strumenti', () => {
		const c = K.parseMcpList(MCP_LIST, MAPPA_PROVA);
		assert.strictEqual(c.length, 10);
		const by = n => c.find(x => x.nome === n);
		assert.deepStrictEqual(
			[by('claude.ai Gmail').tipo, by('claude.ai Gmail').stato, by('claude.ai Gmail').prefisso],
			['claude.ai', 'connesso', 'mcp__claude_ai_Gmail__'],
		);
		assert.strictEqual(by('claude.ai Google Calendar').prefisso, 'mcp__claude_ai_Google_Calendar__');
		assert.strictEqual(by('claude.ai Notion').stato, 'da autenticare');
		assert.strictEqual(by('plugin:sales:gmail').stato, 'non configurato');
		assert.strictEqual(by('plugin:sales:gmail').tipo, 'plugin');
		assert.strictEqual(by('plugin:sales:gmail').pulito, 'gmail');
		assert.strictEqual(by('plugin:design:slack').prefisso, 'mcp__plugin_design_slack__');
		assert.strictEqual(by('posta-locale').tipo, 'locale');
		assert.strictEqual(by('posta-locale').diretto, true);
		assert.strictEqual(by('admob').stato, 'errore');
		assert.strictEqual(by('gare-pubbliche').tipo, 'remoto');
		assert.strictEqual(by('gare-pubbliche').diretto, false);
		// mappa: base piu' impostazione
		assert.deepStrictEqual(by('claude.ai Gmail').capacita, ['posta']);
		assert.deepStrictEqual(by('posta-locale').capacita, ['posta']);
		assert.deepStrictEqual(by('claude.ai Vercel').capacita, ['deploy']);
		assert.deepStrictEqual(by('asc-mcp').capacita, ['store']);
		assert.deepStrictEqual(by('gare-pubbliche').capacita, []);
	});

	await test('mappa: voci esatte, espressioni regolari, impostazione che si aggiunge', () => {
		assert.strictEqual(K.nomePulito('claude.ai Google Drive'), 'google drive');
		assert.strictEqual(K.nomePulito('plugin:marketing:canva'), 'canva');
		assert.deepStrictEqual(K.capacitaDi('google drive'), ['file']);
		assert.deepStrictEqual(K.capacitaDi('agenda-casa', MAPPA_PROVA), ['calendario']);
		assert.deepStrictEqual(K.capacitaDi('mail'), ['posta']);
		assert.deepStrictEqual(K.capacitaDi('mailchimp'), []);
		// un'espressione rotta non fa cadere niente
		assert.deepStrictEqual(K.capacitaDi('x', K.unisciMappa({ posta: ['/[/'] })), []);
		// la mappa base non viene toccata
		assert.ok(!K.unisciMappa({}).posta.includes('posta-locale'));
	});

	await test('configurazione locale: nomi e forma, mai i valori env', () => {
		const cfg = {
			mcpServers: {
				'posta-locale': { type: 'stdio', command: 'node', args: ['/x/index.js'], env: { CHIAVE_FINTA: 'valore-segreto-finto' } },
				'gare-pubbliche': { type: 'http', url: 'https://gare.esempio.invalid/mcp' },
			},
			projects: {
				'/Users/prova/prototipi/alfa': { mcpServers: { vercel: { type: 'http', url: 'https://v.esempio.invalid' }, 'posta-locale': { command: 'node' } } },
				'/Users/prova/prototipi/beta': { mcpServers: { vercel: { type: 'http', url: 'https://v.esempio.invalid' } } },
			},
		};
		const s = K.serverLocali(cfg);
		assert.ok(!JSON.stringify(s).includes('valore-segreto-finto'));
		assert.ok(!JSON.stringify(s).includes('index.js'));
		const v = s.find(x => x.nome === 'vercel');
		assert.deepStrictEqual(v, { nome: 'vercel', trasporto: 'http', ambito: 'progetto', progetti: ['/Users/prova/prototipi/alfa', '/Users/prova/prototipi/beta'] });
		assert.strictEqual(s.filter(x => x.nome === 'posta-locale').length, 1, 'il server utente copre quello di progetto con lo stesso nome');
		// avvio: solo in memoria, con env
		const f = path.join(tmp, 'claude.json');
		fs.writeFileSync(f, JSON.stringify(cfg));
		const a = K.avvioServer('posta-locale', f);
		assert.deepStrictEqual(a, { command: 'node', args: ['/x/index.js'], env: { CHIAVE_FINTA: 'valore-segreto-finto' } });
		assert.strictEqual(K.avvioServer('gare-pubbliche', f), undefined, 'un server http non si avvia');
		// unione con l'elenco: i server non visti entrano come "sconosciuto"
		const tutti = K.unisci(K.parseMcpList(MCP_LIST, MAPPA_PROVA), s, MAPPA_PROVA);
		const vv = tutti.find(x => x.nome === 'vercel');
		assert.strictEqual(vv.stato, 'sconosciuto');
		assert.strictEqual(vv.ambito, 'progetto');
		assert.deepStrictEqual(vv.capacita, ['deploy']);
		const caps = K.statoCapacita(tutti);
		const posta = caps.find(c => c.id === 'posta');
		assert.strictEqual(posta.accesa, true);
		assert.deepStrictEqual(posta.fonti, ['posta-locale', 'claude.ai Gmail'], 'prima i diretti');
		assert.strictEqual(caps.find(c => c.id === 'pubblicita').accesa, false, 'admob non risponde: spenta');
		assert.strictEqual(caps.find(c => c.id === 'pagamenti').accesa, false);
	});

	await test('scoperta: cache, al massimo una volta al giorno, file 600', async () => {
		let corse = 0;
		const cacheFile = path.join(tmp, 'gs', 'connettori-mcp-list.json');
		const mk = () =>
			new K.ScopertaConnettori({
				cacheFile,
				claudeJson: path.join(tmp, 'non-esiste.json'),
				claudeCommand: () => 'claude',
				mappa: () => MAPPA_PROVA,
				onChange() {},
				log() {},
				esegui: async () => (corse++, MCP_LIST),
			});
		const s = mk();
		assert.strictEqual(s.stato().aggiornatoAt, 0);
		await s.aggiorna(false);
		assert.strictEqual(corse, 1);
		assert.strictEqual(s.stato().connettori.length, 10);
		assert.strictEqual(mode(cacheFile), 0o600);
		await s.aggiorna(false);
		assert.strictEqual(corse, 1, 'entro il giorno non si rilancia');
		const s2 = mk();
		assert.strictEqual(s2.stato().connettori.length, 10, 'la cache sopravvive al riavvio');
		await s2.aggiorna(true);
		assert.strictEqual(corse, 2, 'su richiesta si rilancia');
	});

	// ---------- sola lettura ----------

	await test('strumenti di sola lettura: si leggono search, list, get, read; il resto no', () => {
		const si = ['mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread', 'mcp__claude_ai_Gmail__list_labels', 'search_messages', 'read_message', 'list_mailboxes', 'mcp__claude_ai_Vercel__list_deployments', 'getThread'];
		const no = [
			'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__create_draft', 'mcp__claude_ai_Gmail__trash_thread', 'mcp__claude_ai_Gmail__label_thread',
			'reply_message', 'forward_message', 'delete_message', 'move_message', 'set_flags', 'save_attachment', 'update_event', 'create_event',
			'get_or_create_label', 'list_and_delete', 'get_auth_token', 'mcp__claude_ai_Vercel__create_deployment', 'buy_domain', 'search_and_replace', 'respond_to_event', '',
		];
		for (const s of si) assert.ok(K.soloLettura(s), s);
		for (const s of no) assert.ok(!K.soloLettura(s), s);
		assert.deepStrictEqual(
			D.strumentiConsentiti(['mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__search_threads', 'Bash', 'mcp__x__get_y; rm -rf']),
			['mcp__claude_ai_Gmail__search_threads'],
		);
	});

	// ---------- delega ----------

	await test('delega: argomenti, prompt solo JSON con lo schema, niente prompt negli argomenti', () => {
		const a = D.argomentiDelega({ modello: 'haiku', strumenti: ['mcp__claude_ai_Gmail__search_threads'], budgetUsd: 0.86 });
		assert.deepStrictEqual(a.slice(0, 1), ['-p']);
		const val = k => a[a.indexOf(k) + 1];
		assert.strictEqual(val('--output-format'), 'json');
		assert.strictEqual(val('--model'), 'haiku');
		assert.strictEqual(val('--permission-mode'), 'dontAsk');
		assert.strictEqual(val('--allowedTools'), 'mcp__claude_ai_Gmail__search_threads');
		assert.strictEqual(val('--tools'), '');
		assert.strictEqual(val('--max-budget-usd'), '0.86');
		assert.ok(a.includes('--no-session-persistence'));
		const r = P.richiestaGmail({ '/p/alfa': { indirizzi: ['anna@esempio.it'], domini: ['cliente-alfa.it'] } }, 7, 'mcp__claude_ai_Gmail__');
		const pr = D.promptDelega(r, D.strumentiConsentiti(r.strumenti));
		assert.match(pr, /SOLO con JSON valido/);
		assert.match(pr, /"threadId"/);
		assert.match(pr, /Non inviare/);
		assert.match(pr, /newer_than:7d \{from:anna@esempio\.it from:cliente-alfa\.it\}/);
		assert.match(pr, /is:unread in:inbox/);
		assert.ok(!a.some(x => x.includes('Compito')), 'il prompt passa da stdin');
	});

	await test('delega: il JSON dentro la risposta, anche con blocchi di codice e testo intorno', () => {
		assert.deepStrictEqual(D.estraiJson('[{"a":1}]'), [{ a: 1 }]);
		assert.deepStrictEqual(D.estraiJson('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
		assert.deepStrictEqual(D.estraiJson('Ecco i fili: [{"a":1},{"a":2}] fine.'), [{ a: 1 }, { a: 2 }]);
		assert.deepStrictEqual(D.estraiJson('{"n": 3}'), { n: 3 });
		assert.throws(() => D.estraiJson('niente da fare'));
		const ok = D.leggiUscita(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '```json\n[{"threadId":"abc123xyz"}]\n```', total_cost_usd: 0.1412, num_turns: 3 }));
		assert.deepStrictEqual(ok, { ok: true, costo: 0.1412, turni: 3, data: [{ threadId: 'abc123xyz' }] });
		const ko = D.leggiUscita(JSON.stringify({ subtype: 'error_max_budget_usd', is_error: true, result: '', total_cost_usd: 0.5 }));
		assert.strictEqual(ko.ok, false);
		assert.strictEqual(ko.costo, 0.5);
		assert.match(ko.errore, /budget/);
		assert.strictEqual(D.leggiUscita('non json').ok, false);
		const senza = D.leggiUscita(JSON.stringify({ subtype: 'success', is_error: false, result: 'Non ho trovato niente.', total_cost_usd: 0.02 }));
		assert.strictEqual(senza.ok, false);
		assert.strictEqual(senza.costo, 0.02, 'il costo si conta anche se la risposta e\' storta');
	});

	await test('coda: una alla volta, in ordine, costo sommato per giorno, tetto, file 600', async () => {
		const dir = path.join(tmp, 'deleghe');
		let attive = 0, max = 0;
		const ordine = [];
		let tetto = 1;
		const coda = new D.CodaDeleghe({
			dir,
			claudeCommand: () => 'claude',
			modello: () => 'haiku',
			tetto: () => tetto,
			onChange() {},
			log() {},
			esegui: async (args, stdin) => {
				attive++;
				max = Math.max(max, attive);
				ordine.push(/Compito: (\w+)/.exec(stdin)[1]);
				await new Promise(r => setTimeout(r, 15));
				attive--;
				return { stdout: JSON.stringify({ subtype: 'success', is_error: false, result: '[]', total_cost_usd: 0.3, num_turns: 2 }), code: 0 };
			},
		});
		const r = c => ({ capacita: 'prova', compito: c, schema: '[]', strumenti: ['mcp__claude_ai_Gmail__search_threads'] });
		const es = await Promise.all([coda.accoda(r('uno')), coda.accoda(r('due')), coda.accoda(r('tre')), coda.accoda(r('quattro'))]);
		assert.strictEqual(max, 1, 'mai due insieme');
		assert.deepStrictEqual(ordine, ['uno', 'due', 'tre']);
		assert.deepStrictEqual(es.map(e => e.ok), [true, true, true, false]);
		assert.match(es[3].errore, /tetto di spesa/);
		assert.strictEqual(coda.spesaOggi(), 0.9);
		assert.strictEqual(mode(path.join(dir, 'spesa.json')), 0o600);
		assert.strictEqual(mode(path.join(dir, 'prova.json')), 0o600);
		const salvato = JSON.parse(fs.readFileSync(path.join(dir, 'prova.json'), 'utf8'));
		assert.strictEqual(salvato.costo, 0.3);
		assert.ok(salvato.at > 0);
		assert.deepStrictEqual(coda.stato().stime.prova.usd, 0.3, 'la stima impara dallo storico');
		// strumenti che scrivono: la delega non parte nemmeno
		tetto = 5;
		const w = await coda.accoda({ capacita: 'prova', compito: 'x', schema: '[]', strumenti: ['mcp__claude_ai_Gmail__send_message'] });
		assert.strictEqual(w.ok, false);
		assert.match(w.errore, /sola lettura/);
		assert.strictEqual(ordine.length, 3);
	});

	// ---------- rubrica ----------

	await test('rubrica: indirizzi e domini puliti, aggiungi e togli, file 600', () => {
		assert.strictEqual(P.normIndirizzo(' Anna@Esempio.IT '), 'anna@esempio.it');
		assert.strictEqual(P.normIndirizzo('non-un-indirizzo'), '');
		assert.strictEqual(P.normDominio('https://www.Cliente-Alfa.it/contatti'), 'cliente-alfa.it');
		assert.strictEqual(P.normDominio('@esempio.it'), 'esempio.it');
		assert.strictEqual(P.normDominio('1.2.3.4'), '');
		assert.strictEqual(P.indirizzoDa('"Anna Rossi" <anna@esempio.it>'), 'anna@esempio.it');
		assert.strictEqual(P.indirizzoDa('mario@cliente-alfa.it'), 'mario@cliente-alfa.it');
		let r = {};
		r = P.aggiungiVoce(r, '/p/alfa/', 'Anna@esempio.it');
		r = P.aggiungiVoce(r, '/p/alfa', 'cliente-alfa.it');
		r = P.aggiungiVoce(r, '/p/alfa', 'cliente-alfa.it');
		r = P.aggiungiVoce(r, 'relativo', 'x.it');
		r = P.aggiungiVoce(r, '/p/beta', 'spazzatura');
		assert.deepStrictEqual(r, { '/p/alfa': { indirizzi: ['anna@esempio.it'], domini: ['cliente-alfa.it'] } });
		const f = path.join(tmp, 'b', 'rubrica.json');
		P.scriviRubrica(r, f);
		assert.strictEqual(mode(f), 0o600);
		assert.deepStrictEqual(P.leggiRubrica(f), r);
		r = P.togliVoce(r, '/p/alfa', 'anna@esempio.it');
		r = P.togliVoce(r, '/p/alfa', 'cliente-alfa.it');
		assert.deepStrictEqual(r, {}, 'una voce vuota sparisce');
		assert.deepStrictEqual(P.pulisciRubrica({ '/p/x': { indirizzi: ['ok@esempio.it', 'no'], domini: ['Esempio.it', ''] } }), { '/p/x': { indirizzi: ['ok@esempio.it'], domini: ['esempio.it'] } });
	});

	const RUB = {
		'/p/alfa': { indirizzi: [], domini: ['cliente-alfa.it'] },
		'/p/alfa-shop': { indirizzi: [], domini: ['shop.cliente-alfa.it'] },
		'/p/beta': { indirizzi: ['anna@cliente-alfa.it'], domini: ['beta-studio.com'] },
		'/p/gamma': { indirizzi: [], domini: ['beta-studio.com'] },
	};

	await test('regole della rubrica: l\'indirizzo vince sul dominio, il dominio piu\' lungo vince, parita\' a tutti', () => {
		assert.deepStrictEqual(P.progettiDi('anna@cliente-alfa.it', RUB), ['/p/beta']);
		assert.deepStrictEqual(P.progettiDi('mario@cliente-alfa.it', RUB), ['/p/alfa']);
		assert.deepStrictEqual(P.progettiDi('ordini@shop.cliente-alfa.it', RUB), ['/p/alfa-shop']);
		assert.deepStrictEqual(P.progettiDi('x@posta.cliente-alfa.it', RUB), ['/p/alfa']);
		assert.deepStrictEqual(P.progettiDi('luca@beta-studio.com', RUB), ['/p/beta', '/p/gamma']);
		assert.deepStrictEqual(P.progettiDi('qualcuno@altro.it', RUB), []);
		assert.deepStrictEqual(P.progettiDi('x@nocliente-alfa.it', RUB), [], 'un suffisso senza punto non conta');
		const fili = [
			{ id: 'mail:a:INBOX:1', fonte: 'mail', da: 'Mario <mario@cliente-alfa.it>', indirizzo: 'mario@cliente-alfa.it', oggetto: 'Preventivo', data: '2026-09-30T08:00:00.000Z', nonLetto: true, anteprima: '' },
			{ id: 'mail:a:INBOX:2', fonte: 'mail', da: 'Ignoto <chi@altro.it>', indirizzo: 'chi@altro.it', oggetto: 'Ciao', data: '2026-09-29T08:00:00.000Z', nonLetto: false, anteprima: '' },
			{ id: 'mail:a:INBOX:3', fonte: 'mail', da: 'Ignoto <chi@altro.it>', indirizzo: 'chi@altro.it', oggetto: 'Di nuovo', data: '2026-10-01T08:00:00.000Z', nonLetto: true, anteprima: '' },
			{ id: 'mail:a:INBOX:4', fonte: 'mail', da: 'Pippo <pippo@gmail.com>', indirizzo: 'pippo@gmail.com', oggetto: 'Domanda', data: '2026-09-28T08:00:00.000Z', nonLetto: false, anteprima: '' },
		];
		const a = P.assegna(fili, RUB);
		assert.deepStrictEqual(Object.keys(a.perProgetto), ['/p/alfa']);
		assert.strictEqual(a.daAssegnare.length, 3);
		const m = P.mittentiDaAssegnare(a.daAssegnare);
		assert.deepStrictEqual(m.map(x => [x.indirizzo, x.n, x.nonLetti, x.generico, x.nome]), [['chi@altro.it', 2, 1, false, 'Ignoto'], ['pippo@gmail.com', 1, 0, true, 'Pippo']]);
		assert.strictEqual(m[0].ultimo.oggetto, 'Di nuovo');
	});

	await test('suggerimenti: domini dai file del progetto, senza i generici e senza quelli gia\' in rubrica', () => {
		const dir = path.join(tmp, 'progetto-alfa');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'alfa', homepage: 'https://www.cliente-alfa.it' }));
		fs.writeFileSync(path.join(dir, 'vercel.json'), JSON.stringify({ alias: ['shop.negozio-beta.com'] }));
		fs.writeFileSync(
			path.join(dir, 'README.md'),
			'Sito su https://alfa.vercel.app, codice su https://github.com/prova/alfa, API su https://api.cliente-alfa.it/v1, ' +
				'documenti in https://developer.apple.com e https://www.google.com/maps, mail mario@gmail.com, http://localhost:3000, https://studio-gamma.co.uk/x',
		);
		fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Produzione: https://cliente-alfa.it e https://mio-sito.es');
		const s = P.suggerisciDomini(dir, [], ['mio-sito.es']);
		assert.deepStrictEqual(s, ['cliente-alfa.it', 'negozio-beta.com', 'studio-gamma.co.uk']);
		assert.deepStrictEqual(P.suggerisciDomini(dir, ['cliente-alfa.it'], ['mio-sito.es']), ['negozio-beta.com', 'studio-gamma.co.uk']);
		assert.deepStrictEqual(P.suggerisciDomini(path.join(tmp, 'non-esiste')), []);
		assert.strictEqual(P.dominioBase('a.b.esempio.it'), 'esempio.it');
	});

	// ---------- fonti ----------

	await test('fili dal server locale e da Gmail: forma comune, voci storte scartate, link a Gmail', () => {
		const loc = P.filiDaMailMcp({
			count: 2,
			messages: [
				{ account: 'Lavoro', mailbox: 'INBOX', id: 41, subject: 'Preventivo  sito', sender: 'Mario Bianchi <mario@cliente-alfa.it>', date: '2026-09-30T10:00:00Z', read: false },
				{ account: 'Lavoro', mailbox: 'INBOX', subject: 'senza id' },
			],
		});
		assert.deepStrictEqual(loc, [{ id: 'mail:Lavoro:INBOX:41', fonte: 'mail', da: 'Mario Bianchi <mario@cliente-alfa.it>', indirizzo: 'mario@cliente-alfa.it', oggetto: 'Preventivo sito', data: '2026-09-30T10:00:00.000Z', nonLetto: true, anteprima: '' }]);
		const gm = P.filiDaGmail([
			{ threadId: '18f2a9c0d1e2f3a4', da: 'Anna <anna@esempio.it>', oggetto: 'Logo', data: '2026-10-01', nonLetto: true, anteprima: 'x'.repeat(400) },
			{ threadId: '18f2a9c0d1e2f3a4', da: 'doppio' },
			{ threadId: '../../etc', da: 'storto' },
			{ id: 'abcdef123', from: 'z@esempio.it', subject: 'Altro nome dei campi', snippet: 'ok' },
			null,
		]);
		assert.strictEqual(gm.length, 2);
		assert.strictEqual(gm[0].link, 'https://mail.google.com/mail/u/0/#all/18f2a9c0d1e2f3a4');
		assert.strictEqual(gm[0].anteprima.length, 160);
		assert.strictEqual(gm[1].indirizzo, 'z@esempio.it');
		assert.strictEqual(P.linkGmail('a/b'), undefined);
		assert.deepStrictEqual(P.filiDaGmail({ fili: [{ threadId: 'abcdef123' }] }).length, 1);
		assert.deepStrictEqual(P.queryGmail({}, 7), { rubrica: '', sconosciuti: 'newer_than:7d is:unread in:inbox category:primary' });
	});

	await test('motore della posta: locale e Gmail si sommano, ognuna sostituisce solo i suoi fili, file 600', async () => {
		const file = path.join(tmp, 'm', 'posta-fili.json');
		const rubricaFile = path.join(tmp, 'm', 'rubrica.json');
		P.scriviRubrica({ '/p/alfa': { indirizzi: [], domini: ['cliente-alfa.it'] } }, rubricaFile);
		const now = Date.parse('2026-10-02T12:00:00Z');
		const chiamate = [];
		let locali = [{ account: 'A', mailbox: 'INBOX', id: 1, subject: 'Uno', sender: 'm@cliente-alfa.it', date: '2026-10-01T10:00:00Z', read: true }];
		const m = new P.MotorePosta({
			file,
			rubricaFile,
			serverLocale: () => 'posta-locale',
			prefissoGmail: () => 'mcp__claude_ai_Gmail__',
			cercaLocale: async (server, args) => (chiamate.push([server, args]), { messages: locali }),
			delega: async r => ({ capacita: r.capacita, at: now, ok: true, costo: 0.12, durataMs: 50_000, data: [{ threadId: 'gmail0001', da: 'x@altro.it', oggetto: 'Da Gmail', data: '2026-10-02T09:00:00Z', nonLetto: true }] }),
			giorni: () => 7,
			onChange() {},
			log() {},
			ora: () => now,
		});
		await m.aggiornaLocale();
		assert.deepStrictEqual(chiamate[0], ['posta-locale', { since: '2026-09-25', limit: 300, includeBody: false }], 'mai il corpo');
		await m.aggiornaGmail();
		assert.deepStrictEqual(m.fili.map(f => f.oggetto), ['Da Gmail', 'Uno']);
		assert.strictEqual(m.fonti.gmail.costo, 0.12);
		locali = [];
		await m.aggiornaLocale();
		assert.deepStrictEqual(m.fili.map(f => f.oggetto), ['Da Gmail'], 'la fonte locale sostituisce solo i suoi');
		assert.strictEqual(mode(file), 0o600);
		const m2 = new P.MotorePosta({ file, rubricaFile, serverLocale: () => null, prefissoGmail: () => null, cercaLocale: async () => ({}), delega: async () => ({}), giorni: () => 7, onChange() {}, log() {} });
		assert.strictEqual(m2.fili.length, 1, 'i fili sopravvivono al riavvio');
		await m2.aggiornaLocale();
		await m2.aggiornaGmail();
		assert.strictEqual(m2.aggiornando, null, 'senza fonti non succede niente');
	});

	// ---------- client MCP diretto, contro un server finto ----------

	await test('client MCP stdio: initialize, tools/list, tools/call; chi scrive e\' rifiutato prima di partire', async () => {
		const server = path.join(tmp, 'server-finto.cjs');
		const registro = path.join(tmp, 'server-finto.log');
		fs.writeFileSync(
			server,
			`const fs = require('fs');
let buf = '';
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('data', c => {
	buf += c;
	let i;
	while ((i = buf.indexOf('\\n')) >= 0) {
		const m = JSON.parse(buf.slice(0, i));
		buf = buf.slice(i + 1);
		fs.appendFileSync(${JSON.stringify(registro)}, m.method + '\\n');
		if (m.method === 'initialize') { console.log('riga di log che non e\\' JSON'); out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'finto', version: '0' } } }); out({ jsonrpc: '2.0', id: 99, method: 'ping' }); }
		else if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'search_messages' }, { name: 'send_message' }] } });
		else if (m.method === 'tools/call') out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ messages: [{ id: 1, subject: 'Prova', sender: 'a@esempio.it', read: true }], visto: m.params }) }] } });
	}
});`,
		);
		const avvio = { command: process.execPath, args: [server], env: { VARIABILE_FINTA: 'x' } };
		const r = await M.conServer('finto', avvio, async c => {
			const tools = await c.strumenti();
			assert.deepStrictEqual(tools.map(t => t.name), ['search_messages', 'send_message']);
			await assert.rejects(() => c.chiama('send_message', { to: ['a@esempio.it'] }), /sola lettura/);
			return M.testoRisultato(await c.chiama('search_messages', { limit: 1 }));
		});
		assert.strictEqual(r.json.messages[0].subject, 'Prova');
		assert.deepStrictEqual(r.json.visto, { name: 'search_messages', arguments: { limit: 1 } });
		const log = fs.readFileSync(registro, 'utf8').trim().split('\n');
		assert.deepStrictEqual(log.filter(x => x !== 'undefined'), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
		assert.ok(!log.some(x => /send/.test(x)));
		// un rifiuto senza mai avviare il processo
		const c2 = new M.ClientMcp('finto', { command: '/non/esiste', args: [], env: {} });
		await assert.rejects(() => c2.chiama('delete_message', {}), /sola lettura/);
		c2.chiudi();
		// un errore del server diventa un errore leggibile
		assert.deepStrictEqual(M.testoRisultato({ isError: true, content: [{ type: 'text', text: 'Error: Mail non risponde' }] }).errore, 'Mail non risponde');
	});

	// ---------- la stanza nella plancia (jsdom) ----------

	await test('stanza Connettori in jsdom: schede, posta per progetto, da assegnare, messaggi, niente lineette', () => {
		const { JSDOM } = require('jsdom');
		const dom = new JSDOM('<!doctype html><body><main id="r"></main></body>', { runScripts: 'outside-only', url: 'https://plancia.prova/' });
		const w = dom.window;
		const errors = [];
		w.addEventListener('error', e => errors.push(e.error || e.message));
		w.eval(fs.readFileSync(path.join(__dirname, '..', 'media', 'connettori.js'), 'utf8'));
		const posted = [];
		let saved = {};
		const room = w.BottegaConnettori.mount(w.document.getElementById('r'), { post: m => posted.push(JSON.parse(JSON.stringify(m))), saved: {}, save: o => (saved = JSON.parse(JSON.stringify(o))) });
		const $ = s => w.document.querySelector(s);
		const $$ = s => [...w.document.querySelectorAll(s)];
		const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
		room.show();
		assert.deepStrictEqual(posted.shift(), { type: 'connettori.request' });
		const NOW = Date.now();
		const filo = (id, oggetto, nonLetto, extra = {}) => ({ id, fonte: 'mail', da: 'Mario <mario@cliente-alfa.it>', indirizzo: 'mario@cliente-alfa.it', oggetto, data: new Date(NOW - 3600e3).toISOString(), nonLetto, anteprima: '', ...extra });
		room.message({
			type: 'posta',
			stato: {
				aggiornatoAt: NOW - 120e3,
				aggiornando: null,
				giorni: 7,
				fonti: { locale: { nome: 'posta-locale', at: NOW - 120e3, n: 40 } },
				disponibili: { locale: 'posta-locale', gmail: true },
				deleghe: { inCorso: null, coda: [], spesaOggi: 0.28, tetto: 1, modello: 'haiku', stime: { posta: { secondi: 68, usd: 0.14 } } },
				progetti: [{ path: '/p/alfa', name: 'Alfa', voce: { indirizzi: [], domini: ['cliente-alfa.it'] }, fili: [filo('mail:A:INBOX:1', 'Preventivo <b>', true), filo('gmail:abc123def', 'Logo', false, { fonte: 'gmail', link: 'https://mail.google.com/mail/u/0/#all/abc123def' })], nonLetti: 1 }],
				daAssegnare: [{ indirizzo: 'chi@altro.it', dominio: 'altro.it', generico: false, nome: 'Ignoto', n: 2, nonLetti: 1, ultimo: filo('mail:A:INBOX:3', 'Di nuovo', true) }, { indirizzo: 'pippo@gmail.com', dominio: 'gmail.com', generico: true, nome: '', n: 1, nonLetti: 0, ultimo: filo('mail:A:INBOX:4', 'Domanda', false) }],
				suggerimenti: [{ path: '/p/beta', name: 'Beta', domini: ['negozio-beta.com'] }],
				tuttiProgetti: [{ path: '/p/alfa', name: 'Alfa' }, { path: '/p/beta', name: 'Beta' }],
			},
		});
		assert.match($('#con-frase').textContent, /1 filo non letto in 1 progetto/);
		assert.match($('#con-sotto').textContent, /0,28 \$ su un tetto giornaliero di 1,00 \$/);
		assert.ok($('.con-oggetto').innerHTML.includes('&lt;b&gt;'), 'testo dei dati sfuggito');
		assert.match($('#con-comandi').textContent, /circa 68 secondi e 0,14 \$/);
		// pulsanti
		click($('[data-k="posta"]'));
		click($('[data-k="gmail"]'));
		click($('[data-k="apri"]'));
		click($('[data-k="aggiungi"]'));
		click($('[data-k="togli"]'));
		assert.deepStrictEqual(posted.splice(0), [
			{ type: 'posta.refresh', fonte: 'locale' },
			{ type: 'posta.refresh', fonte: 'gmail' },
			{ type: 'posta.apri', id: 'mail:A:INBOX:1' },
			{ type: 'rubrica.add', path: '/p/beta', voce: 'negozio-beta.com' },
			{ type: 'rubrica.remove', path: '/p/alfa', voce: 'cliente-alfa.it' },
		]);
		// da assegnare: senza progetto scelto i pulsanti sono spenti; per gmail.com niente "tutto il dominio"
		const liberi = $$('.con-libero');
		assert.strictEqual(liberi.length, 2);
		assert.strictEqual(liberi[1].querySelectorAll('[data-k="assegna"]').length, 1);
		const sel = liberi[0].querySelector('select');
		sel.value = '/p/beta';
		sel.dispatchEvent(new w.Event('change', { bubbles: true }));
		const dom2 = liberi[0].querySelectorAll('[data-k="assegna"]')[1];
		assert.strictEqual(dom2.disabled, false);
		click(dom2);
		assert.deepStrictEqual(posted.splice(0), [{ type: 'rubrica.add', path: '/p/beta', voce: 'altro.it' }]);
		// nuovo progetto in rubrica
		$('#con-nuovo-voce').value = 'non valido';
		$('#con-nuovo').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
		assert.match($('#con-esito').textContent, /Scegli prima il progetto/);
		const np = $('#con-nuovo-progetto');
		np.value = '/p/beta';
		np.dispatchEvent(new w.Event('change', { bubbles: true }));
		$('#con-nuovo').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
		assert.match($('#con-esito').textContent, /Scrivi un indirizzo/);
		$('#con-nuovo-voce').value = 'anna@esempio.it';
		$('#con-nuovo').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
		assert.deepStrictEqual(posted.splice(0), [{ type: 'rubrica.add', path: '/p/beta', voce: 'anna@esempio.it' }]);
		// scheda Connettori
		room.message({
			type: 'connettori',
			stato: {
				aggiornatoAt: NOW - 3600e3,
				aggiornando: false,
				connettori: K.unisci(K.parseMcpList(MCP_LIST, MAPPA_PROVA), [], MAPPA_PROVA),
				capacita: K.statoCapacita(K.unisci(K.parseMcpList(MCP_LIST, MAPPA_PROVA), [], MAPPA_PROVA)),
				deleghe: { spesaOggi: 0, tetto: 1, stime: {} },
			},
		});
		click($('[data-k="scheda"][data-v="connettori"]'));
		assert.deepStrictEqual(saved, { scheda: 'connettori' });
		assert.strictEqual($('#con-posta').hidden, true);
		assert.strictEqual($('#con-elenco').hidden, false);
		assert.match($('#con-frase').textContent, /6 connettori collegati/);
		assert.strictEqual($$('.con-k-accesa').length, 4);
		assert.ok($$('#con-lista .con-c-nome').some(x => x.textContent === 'claude.ai Gmail'));
		assert.ok($$('#con-altri .con-c-nome').some(x => x.textContent === 'plugin:sales:gmail'));
		click($('[data-k="elenco"]'));
		assert.deepStrictEqual(posted.splice(0), [{ type: 'connettori.refresh' }]);
		// mentre aggiorna, il pulsante e' spento; alla fine l'esito lo dice
		room.message({ type: 'connettori', stato: { ...{ aggiornatoAt: 0, connettori: [], capacita: [] }, aggiornando: true } });
		assert.strictEqual($('[data-k="elenco"]').disabled, true);
		room.message({ type: 'connettori', stato: { aggiornatoAt: NOW, aggiornando: false, connettori: [], capacita: [] } });
		assert.match($('#con-esito').textContent, /aggiornato/);
		const bad = /[\u2013\u2014]/;
		assert.ok(!bad.test(w.document.body.textContent));
		click($('[data-k="scheda"][data-v="posta"]'));
		assert.ok(!bad.test(w.document.body.textContent));
		assert.deepStrictEqual(errors, []);
	});

	await test('nessuna lineetta lunga o media nei testi dei sorgenti nuovi', () => {
		for (const f of ['src/connettori.ts', 'src/connettori-mappa.ts', 'src/delega.ts', 'src/posta.ts', 'src/mcp.ts', 'src/connettori-host.ts', 'media/connettori.js', 'media/connettori.css']) {
			const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
			assert.ok(!DASH.test(t), f);
		}
	});

	// ---------- prova reale, solo su richiesta ----------

	await test('deleghe: gli hook della Memoria escono subito senza scrivere, le sessioni vive le ignorano', async () => {
		const { spawnSync } = require('child_process');
		const HOOKS = path.join(__dirname, '..', '..', '..', 'memoria', 'hooks');
		const prova = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-delega-'));
		const payload = JSON.stringify({ session_id: 'sessione-prova', cwd: prova, prompt: 'ciao', hook_event_name: 'UserPromptSubmit' });
		const corri = (hook, delega) => spawnSync(process.execPath, [path.join(HOOKS, hook)], {
			input: payload,
			env: { ...process.env, HOME: prova, BOTTEGA_HOME: path.join(prova, 'bh'), BOTTEGA_DELEGA: delega ? '1' : '' },
			timeout: 5000,
		});
		for (const hook of fs.readdirSync(HOOKS).filter(f => f.endsWith('.mjs'))) {
			const r = corri(hook, true);
			assert.strictEqual(r.status, 0, `${hook} deve uscire con 0`);
			assert.ok(!fs.existsSync(path.join(prova, 'bh')), `${hook} con BOTTEGA_DELEGA=1 non deve scrivere niente`);
		}
		// controprova: senza la variabile lo stesso hook scrive nello spool, quindi il test sopra misura davvero qualcosa
		const r = corri('user-prompt.mjs', false);
		assert.strictEqual(r.status, 0);
		assert.ok(fs.existsSync(path.join(prova, 'bh', 'memoria', 'spool')), 'senza delega lo spool si crea');
		fs.rmSync(prova, { recursive: true, force: true });

		const C = require(path.join(OUT, 'claude.js'));
		const dir = path.join(os.homedir(), '.bottega', 'connettori');
		assert.ok(C.isDelega(dir));
		assert.ok(C.isDelega(path.join(dir, 'sotto')));
		assert.ok(!C.isDelega(dir + '-altro'));
		assert.ok(!C.isDelega(path.join(os.homedir(), 'prototipi', 'Bottega')));
		assert.ok(!C.isDelega(undefined));
	});

	if (process.env.BOTTEGA_TEST_REALE === '1') {
		await test('REALE: una delega Gmail che chiede solo quanti fili non letti ci sono da ieri', async () => {
			const coda = new D.CodaDeleghe({
				dir: path.join(tmp, 'reale'),
				claudeCommand: () => 'claude',
				modello: () => 'haiku',
				tetto: () => 0.5,
				onChange() {},
				log: s => console.log('      ' + s),
			});
			const e = await coda.accoda({
				capacita: 'prova-reale',
				compito: 'Con mcp__claude_ai_Gmail__search_threads (pageSize 50, view THREAD_VIEW_METADATA_ONLY, query "newer_than:1d is:unread in:inbox") conta i fili. Riporta solo il numero, nessun oggetto ne\' mittente.',
				schema: '{"fili": 0}',
				strumenti: ['mcp__claude_ai_Gmail__search_threads'],
			});
			console.log(`      ok=${e.ok} costo=${e.costo} durata=${Math.round(e.durataMs / 1000)}s turni=${e.turni} ${e.ok ? 'fili=' + (e.data && e.data.fili) : 'errore=' + e.errore}`);
			assert.ok(e.ok, e.errore);
			assert.strictEqual(typeof e.data.fili, 'number');
		});
	}

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(`\n${passed} ok, ${failed} falliti${failed ? ': ' + fails.join('; ') : ''}`);
	process.exit(failed ? 1 : 0);
})();
