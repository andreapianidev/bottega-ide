#!/usr/bin/env node
// Banco di prova di due stanze della plancia, la Vedetta (media/vedetta.js) e i Clienti
// (media/clienti.js), caricate in jsdom con snapshot e report finti: montaggio, rosso, giallo e verde,
// pulsanti che mandano i messaggi giusti, mese, salvataggio ed esportazione dei clienti, niente
// lineette lunghe nel DOM, aggiornamenti che non perdono il fuoco.
// Nessun dato vero: il repository e' pubblico. Clienti, progetti e app sono inventati.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const MEDIA = path.join(__dirname, '..', 'media');
const HOME = '/Users/prova';
const P = n => `${HOME}/prototipi/${n}`;

let passed = 0, failed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log('  ok  ' + name);
	} catch (e) {
		failed++;
		console.log('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e));
	}
}

const pausa = ms => new Promise(r => setTimeout(r, ms));

function ambiente(file, nome) {
	const dom = new JSDOM(`<!doctype html><html lang="it"><body class="vscode-dark"><main id="app"></main></body></html>`, {
		runScripts: 'outside-only',
		pretendToBeVisual: true,
		url: 'https://plancia.invalid/',
	});
	const w = dom.window;
	w.eval(fs.readFileSync(path.join(MEDIA, file), 'utf8'));
	const posts = [];
	const focused = [];
	const salvati = [];
	const root = w.document.getElementById('app');
	const stanza = w[nome].mount(root, {
		// i messaggi nascono nel mondo di jsdom: si portano in questo per confrontarli
		post: m => posts.push(JSON.parse(JSON.stringify(m))),
		saved: {},
		save: o => salvati.push(JSON.parse(JSON.stringify(o))),
		reduced: { matches: true, addEventListener() {} },
		focusProject: p => focused.push(p),
	});
	return { dom, w, doc: w.document, root, stanza, posts, focused, salvati };
}

/** Testo e attributi del DOM: nessuna lineetta lunga U+2014 o media U+2013. */
function senzaLineette(root) {
	const html = root.innerHTML;
	const bad = html.match(/[\u2013\u2014]/g);
	assert.ok(!bad, `lineette nel DOM: ${bad && bad.length}, intorno a "${html.slice(Math.max(0, html.search(/[\u2013\u2014]/) - 40), html.search(/[\u2013\u2014]/) + 40)}"`);
}

const click = (w, el) => {
	assert.ok(el, 'elemento da premere mancante');
	el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
};
const scegli = (w, sel, value) => {
	sel.value = value;
	sel.dispatchEvent(new w.Event('change', { bubbles: true }));
};
const scrivi = (w, input, value) => {
	input.value = value;
	input.dispatchEvent(new w.Event('input', { bubbles: true }));
};

// ---------- dati finti ----------

const ORA = Date.now();
const MIN = 60_000;

function snapshot(over = {}) {
	const projects = ['Alfa', 'Beta', 'Gamma', 'Delta'].map(n => ({ name: n, path: P(n.toLowerCase()), kinds: [], sessions: [], live: [], touchedAt: ORA }));
	const rules = {
		projects: {
			[P('alfa')]: {
				path: P('alfa'),
				livello: 'rosso',
				checkedAt: ORA - 5 * MIN,
				hits: [
					{ id: 'push', livello: 'giallo', frase: 'Due commit non sono stati spinti.', rimedio: 'Spingili su GitHub.', azione: { act: 'push', label: 'Spingi', args: { path: P('alfa') } } },
					{
						id: 'segreti',
						livello: 'rosso',
						frase: 'Una chiave è finita in un commit non ancora spinto.',
						rimedio: 'Toglila dal commit prima di spingere.',
						dettagli: ['src/config.ts: chiave di un servizio', 'a1b2c3d Sistema la configurazione'],
					},
				],
			},
			[P('beta')]: {
				path: P('beta'),
				livello: 'giallo',
				checkedAt: ORA - 6 * MIN,
				hits: [
					{
						id: 'build',
						livello: 'giallo',
						frase: 'Tre commit cambiano il codice senza alzare il numero di build.',
						rimedio: 'Alza la build nel prossimo commit.',
						azione: { act: 'job.prepare', label: 'Prepara il lavoro', args: { path: P('beta'), task: 'Alza il numero di build' } },
						dettagli: ['d4e5f6a Cambia il colore', 'b7c8d9e Nuova schermata', 'f0a1b2c Ripara il login'],
					},
				],
			},
			[P('gamma')]: { path: P('gamma'), livello: 'verde', checkedAt: ORA, hits: [] },
			[P('delta')]: { path: P('delta'), livello: 'verde', checkedAt: ORA, hits: [] },
		},
		global: [{ id: 'app-ads', livello: 'rosso', frase: 'app-ads.txt non è uguale sui tre siti.', rimedio: 'Copia la fonte sugli altri due.' }],
		appAds: {
			checkedAt: ORA - 2 * 60 * MIN,
			identical: false,
			hosts: [
				{ host: 'www.andreapiani.com', md5: '0123456789abcdef0123456789abcdef' },
				{ host: 'privacypolicyhub.vercel.app', md5: '0123456789abcdef0123456789abcdef' },
				{ host: 'walkie-talky.vercel.app', md5: 'fedcba9876543210fedcba9876543210' },
			],
		},
		counts: { rosso: 1, giallo: 1, verde: 2 },
		checkedAt: ORA - 5 * MIN,
		running: false,
	};
	const radar = {
		apps: [
			{
				ascId: '1000000001',
				bundleId: 'com.esempio.alfa',
				name: 'Alfa Mappe',
				projectPath: P('alfa'),
				version: { string: '2.3', state: 'WAITING_FOR_REVIEW', label: 'In attesa di revisione', tone: 'attesa', build: '45', releaseType: 'AFTER_APPROVAL' },
				live: '2.2',
				reviews: [
					{ stars: 4, title: 'Utile', body: 'Fa quello che promette.', territory: 'ITA', at: ORA - 26 * 60 * MIN },
					{ stars: 2, title: 'Lenta', body: 'Ci mette molto ad aprirsi.', at: ORA - 3 * 24 * 60 * MIN },
				],
				money: { yesterday: 1.2, last7: 8.4, daily: [1, 1.1, 1.3, 1.4, 1.2, 1.2, 1.2], currency: 'USD' },
			},
			{
				ascId: '1000000002',
				bundleId: 'com.esempio.beta',
				name: 'Beta Note',
				version: { string: '1.0', state: 'REJECTED', label: 'Rifiutata', tone: 'male' },
				reviews: [],
			},
		],
		totals: { yesterday: 1.2, last7: 8.4, daily: [1, 1.1, 1.3, 1.4, 1.2, 1.2, 1.2], currency: 'USD' },
		ascAt: ORA - 40 * MIN,
		admobAt: ORA - 40 * MIN,
		refreshing: false,
	};
	return { home: HOME, projects, rules, radar, ...over };
}

function report(over = {}) {
	const days = (spec) => spec.map(([d, m]) => ({ date: `2026-09-${String(d).padStart(2, '0')}`, minutes: m, raw: m }));
	return {
		month: '2026-09',
		months: ['2026-09', '2026-08', '2026-07'],
		rounding: 15,
		clients: [
			{ id: 'a', nome: 'Cliente Alfa', minutes: 1200, raw: 1193, amount: 800, days: days([[1, 240], [2, 480], [3, 480]]), projects: [{ path: P('alfa'), name: 'Alfa', minutes: 1200 }] },
			{ id: 'b', nome: 'Cliente Beta', minutes: 765, raw: 765, days: days([[8, 765]]), projects: [{ path: P('beta'), name: 'Beta', minutes: 765 }] },
			{ id: 'g', nome: 'Cliente Gamma', minutes: 450, raw: 452, days: days([[10, 450]]), projects: [{ path: P('gamma'), name: 'Gamma', minutes: 450 }] },
			{ id: 'd', nome: 'Cliente Delta', minutes: 120, raw: 118, days: days([[12, 120]]), projects: [{ path: P('delta'), name: 'Delta', minutes: 120 }] },
		],
		unassigned: [
			{ path: P('epsilon'), name: 'Epsilon', minutes: 300 },
			{ path: null, name: 'Fuori dai progetti', minutes: 60 },
		],
		config: [
			{ id: 'a', nome: 'Cliente Alfa', progetti: [P('alfa')], tariffa: 40 },
			{ id: 'b', nome: 'Cliente Beta', progetti: [P('beta')] },
			{ id: 'g', nome: 'Cliente Gamma', progetti: [P('gamma')] },
			{ id: 'd', nome: 'Cliente Delta', progetti: [P('delta')] },
		],
		projects: ['Alfa', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'].map(n => ({ path: P(n.toLowerCase()), name: n })),
		...over,
	};
}

(async () => {
	console.log('Vedetta');
	const V = ambiente('vedetta.js', 'BottegaVedetta');

	await test('si monta e restituisce update, message, show, hide, pause, resume', () => {
		for (const k of ['update', 'message', 'show', 'hide', 'pause', 'resume']) assert.strictEqual(typeof V.stanza[k], 'function', k);
		V.stanza.update(snapshot());
		V.stanza.show();
		assert.ok(V.doc.getElementById('ved-frase').textContent.length > 10);
	});

	await test('la frase dice rosso, giallo, verde e app-ads.txt', () => {
		const t = V.doc.getElementById('ved-frase').textContent;
		assert.match(t, /^Un progetto va sistemato subito, uno ha qualcosa da mettere a posto\. Gli altri due sono in regola\. E app-ads\.txt non è uguale sui tre siti\.$/, t);
	});

	await test('rossi prima dei gialli, verdi in una riga contabile', () => {
		const righe = [...V.doc.querySelectorAll('#ved-lista > li')];
		assert.deepStrictEqual(righe.map(r => r.getAttribute('data-path')), [P('alfa'), P('beta')]);
		assert.ok(righe[0].classList.contains('ved-prog-rosso'));
		assert.ok(righe[1].classList.contains('ved-prog-giallo'));
		assert.match(righe[0].querySelector('.ved-prog-livello').textContent, /subito/);
		assert.match(righe[1].querySelector('.ved-prog-livello').textContent, /da sistemare/);
		// dentro Alfa la violazione rossa viene prima di quella gialla
		const hits = [...righe[0].querySelectorAll('.ved-hit')];
		assert.ok(hits[0].classList.contains('ved-hit-rosso') && hits[1].classList.contains('ved-hit-giallo'));
		assert.match(V.doc.getElementById('ved-verdi').textContent, /Altri 2 progetti in regola/);
		assert.strictEqual(V.doc.querySelectorAll('#ved-lista .ved-nome')[0].textContent, 'Alfa');
	});

	await test('il crinale ha una luce per progetto, del colore giusto', () => {
		const svg = V.doc.querySelector('#ved-crinale-svg svg');
		assert.ok(svg);
		assert.strictEqual(svg.querySelectorAll('.ved-luce-rosso').length, 1);
		assert.strictEqual(svg.querySelectorAll('.ved-luce-giallo').length, 1);
		assert.strictEqual(svg.querySelectorAll('.ved-luce-verde').length, 2);
		assert.strictEqual(V.doc.getElementById('ved-crinale-svg').getAttribute('aria-hidden'), 'true');
		assert.match(V.doc.getElementById('ved-legenda').textContent, /1 subito.*1 da sistemare.*2 in regola/s);
	});

	await test('app-ads.txt: tre siti, impronte abbreviate, quello diverso segnato', () => {
		const righe = [...V.doc.querySelectorAll('.ved-host tbody tr')];
		assert.strictEqual(righe.length, 3);
		assert.strictEqual(righe[0].querySelector('code').textContent, '01234567');
		assert.ok(righe[2].classList.contains('ved-diverso'));
		assert.ok(!righe[0].classList.contains('ved-diverso'));
		assert.match(V.doc.getElementById('ved-globali').textContent, /Non è identico/);
	});

	await test('i pulsanti mandano i messaggi giusti', () => {
		V.posts.length = 0;
		click(V.w, V.doc.querySelector('[data-v="ricontrolla"]'));
		assert.deepStrictEqual(V.posts.pop(), { type: 'rules.refresh' });
		click(V.w, V.doc.querySelector('[data-v="radar"]'));
		assert.deepStrictEqual(V.posts.pop(), { type: 'radar.refresh' });
		const az = [...V.doc.querySelectorAll('[data-v="azione"]')];
		const spingi = az.find(b => b.textContent === 'Spingi');
		click(V.w, spingi);
		assert.deepStrictEqual(V.posts.pop(), { type: 'push', path: P('alfa') });
		const prepara = az.find(b => b.textContent === 'Prepara il lavoro');
		click(V.w, prepara);
		assert.deepStrictEqual(V.posts.pop(), { type: 'job.prepare', path: P('beta'), task: 'Alza il numero di build' });
		// il pulsante resta in attesa per qualche secondo: niente doppi invii
		const dopo = [...V.doc.querySelectorAll('[data-v="azione"]')].find(b => /Chiesto/.test(b.textContent));
		assert.ok(dopo && dopo.disabled);
		click(V.w, V.doc.querySelector('#ved-lista .ved-nome'));
		assert.strictEqual(V.focused.pop(), P('alfa'));
	});

	await test('rule.fix manda path e regola', () => {
		const s = snapshot();
		s.rules.projects[P('alfa')].hits.push({ id: 'rilascio', livello: 'rosso', frase: 'La versione 2.3 uscirà solo a mano.', rimedio: 'Mettila in rilascio automatico.', azione: { act: 'rule.fix', label: 'Metti in automatico', args: { path: P('alfa'), rule: 'rilascio' } } });
		V.stanza.update(s);
		V.posts.length = 0;
		click(V.w, [...V.doc.querySelectorAll('[data-v="azione"]')].find(b => b.textContent === 'Metti in automatico'));
		assert.deepStrictEqual(V.posts.pop(), { type: 'rule.fix', path: P('alfa'), rule: 'rilascio' });
		V.stanza.update(snapshot());
	});

	await test('i dettagli si aprono e si richiudono, e restano aperti dopo un aggiornamento', () => {
		const b = [...V.doc.querySelectorAll('[data-v="dettagli"]')].find(x => /3 dettagli/.test(x.textContent));
		assert.ok(b, 'pulsante dei commit di Beta');
		assert.strictEqual(b.getAttribute('aria-expanded'), 'false');
		click(V.w, b);
		const b2 = V.doc.querySelector('[data-fk="v:det:' + P('beta') + '|build|0"]');
		assert.strictEqual(b2.getAttribute('aria-expanded'), 'true');
		const lista = V.doc.getElementById(b2.getAttribute('aria-controls'));
		assert.ok(lista && !lista.hidden);
		assert.match(lista.textContent, /d4e5f6a Cambia il colore/);
		V.stanza.update(snapshot({ rules: { ...snapshot().rules, checkedAt: ORA - MIN } }));
		const b3 = V.doc.querySelector('[data-fk="v:det:' + P('beta') + '|build|0"]');
		assert.strictEqual(b3.getAttribute('aria-expanded'), 'true');
		assert.ok(V.salvati.length && V.salvati.at(-1).aperti.includes('d:' + P('beta') + '|build|0'));
	});

	await test('un aggiornamento che cambia la riga non perde il fuoco', () => {
		const b = V.doc.querySelector('[data-fk="v:det:' + P('beta') + '|build|0"]');
		b.focus();
		assert.strictEqual(V.doc.activeElement, b);
		const s = snapshot();
		s.rules.projects[P('beta')].checkedAt = ORA - 30 * MIN; // la riga di Beta cambia davvero
		s.rules.projects[P('beta')].hits[0].frase = 'Quattro commit cambiano il codice senza alzare il numero di build.';
		V.stanza.update(s);
		const a = V.doc.activeElement;
		assert.notStrictEqual(a, b, 'la riga doveva essere riscritta');
		assert.strictEqual(a.getAttribute('data-fk'), 'v:det:' + P('beta') + '|build|0');
		// e una riga che non cambia resta proprio lo stesso elemento
		const alfa = V.doc.querySelector('#ved-lista > li');
		V.stanza.update(s);
		assert.strictEqual(V.doc.querySelector('#ved-lista > li'), alfa);
	});

	await test('tutto verde: frase di quiete, nessuna riga da sistemare', () => {
		const s = snapshot();
		for (const p of Object.values(s.rules.projects)) (p.livello = 'verde'), (p.hits = []);
		s.rules.global = [];
		s.rules.appAds.identical = true;
		s.rules.appAds.hosts[2].md5 = s.rules.appAds.hosts[0].md5;
		s.rules.counts = { rosso: 0, giallo: 0, verde: 4 };
		V.stanza.update(s);
		assert.strictEqual(V.doc.getElementById('ved-frase').textContent, 'Tutte le regole sono rispettate, in 4 progetti.');
		assert.strictEqual(V.doc.querySelectorAll('#ved-lista > li').length, 0);
		assert.ok(!V.doc.getElementById('ved-vuoto').hidden);
		V.stanza.update(snapshot());
	});

	await test('radar: nome da App Store Connect, mai il bundle id; progetto cliccabile', () => {
		const txt = V.doc.getElementById('ved-app').textContent;
		assert.match(txt, /Alfa Mappe/);
		assert.ok(!/com\.esempio/.test(V.root.textContent), 'il bundle id non si mostra');
		const righe = [...V.doc.querySelectorAll('#ved-app > li')];
		assert.strictEqual(righe[0].querySelector('.ved-app-nome').textContent, 'Beta Note', 'le app rifiutate vengono prima');
		assert.ok(righe[0].querySelector('.ved-stato-rosso'));
		assert.ok(righe[1].querySelector('.ved-stato-giallo'));
		assert.match(righe[1].textContent, /Versione 2\.3, build 45, in vendita la 2\.2, esce da sola/);
		V.focused.length = 0;
		click(V.w, righe[1].querySelector('[data-v="progetto"]'));
		assert.strictEqual(V.focused.pop(), P('alfa'));
	});

	await test('recensioni con stelle accessibili, le altre richiudibili', () => {
		const st = V.doc.querySelector('#ved-app .ved-stelle');
		assert.strictEqual(st.getAttribute('role'), 'img');
		assert.strictEqual(st.getAttribute('aria-label'), '4 stelle su 5');
		const altre = V.doc.querySelector('[data-fk="v:rec:1000000001"]');
		assert.match(altre.textContent, /altra recensione/);
		click(V.w, altre);
		const box = V.doc.getElementById(V.doc.querySelector('[data-fk="v:rec:1000000001"]').getAttribute('aria-controls'));
		assert.ok(!box.hidden);
		assert.strictEqual(box.querySelector('.ved-stelle').getAttribute('aria-label'), '2 stelle su 5');
	});

	await test('soldi: totale in alto, ieri e 7 giorni, serie con testo per i lettori di schermo', () => {
		const tot = V.doc.getElementById('ved-totali').textContent;
		assert.match(tot, /Ieri\s*1,20\s*\$/);
		assert.match(tot, /Ultimi 7 giorni\s*8,40\s*\$/);
		const sr = V.doc.querySelector('#ved-totali .ved-serie .sr').textContent;
		assert.match(sr, /^Ultimi sette giorni, dal più vecchio: /);
		assert.strictEqual(sr.split(';').length, 7);
		assert.strictEqual(V.doc.querySelectorAll('#ved-totali .ved-col-ieri').length, 1);
		assert.match(V.doc.getElementById('ved-letto').textContent, /App Store letto 40 min fa, AdMob letto 40 min fa/);
	});

	await test('senza rete: età del dato ed errore in chiaro', () => {
		const s = snapshot();
		s.radar.ascError = 'la richiesta non ha avuto risposta';
		s.radar.ascAt = ORA - 26 * 60 * MIN;
		V.stanza.update(s);
		assert.match(V.doc.getElementById('ved-letto').textContent, /App Store senza rete: ultimo dato (di ieri|di \d+ giorni fa|delle \d\d:\d\d)/);
		assert.match(V.doc.getElementById('ved-errori').textContent, /App Store Connect non risponde: la richiesta non ha avuto risposta/);
		V.stanza.update(snapshot());
		assert.strictEqual(V.doc.getElementById('ved-errori').textContent, '');
	});

	await test('nessuna lineetta lunga nella Vedetta', () => senzaLineette(V.root));

	await test('nascosta si ferma, riaperta riprende', () => {
		V.stanza.hide();
		assert.ok(V.doc.getElementById('ved').classList.contains('ved-fermo'));
		const prima = V.doc.getElementById('ved-frase').innerHTML;
		const s = snapshot();
		s.rules.counts = { rosso: 0, giallo: 1, verde: 3 };
		s.rules.projects[P('alfa')].livello = 'verde';
		s.rules.projects[P('alfa')].hits = [];
		V.stanza.update(s);
		assert.strictEqual(V.doc.getElementById('ved-frase').innerHTML, prima, 'a schermo nascosto non si ridisegna');
		V.stanza.show();
		assert.ok(!V.doc.getElementById('ved').classList.contains('ved-fermo'));
		assert.match(V.doc.getElementById('ved-frase').textContent, /^Niente di urgente/);
	});

	console.log('Clienti');
	const C = ambiente('clienti.js', 'BottegaClienti');
	C.stanza.update({ home: HOME });

	await test('si monta e su show chiede il mese', () => {
		for (const k of ['update', 'message', 'show', 'hide', 'pause', 'resume']) assert.strictEqual(typeof C.stanza[k], 'function', k);
		C.stanza.show();
		assert.deepStrictEqual(C.posts.pop(), { type: 'clients.request' });
	});

	await test('la frase dice ore, clienti e ore non assegnate', () => {
		C.stanza.message({ type: 'clients', report: report() });
		const t = C.doc.getElementById('cli-frase').textContent;
		assert.match(t, /^A settembre( 2026)? hai lavorato 42 ore e un quarto per quattro clienti, più 6 ore non assegnate\.$/, t);
		assert.match(C.doc.getElementById('cli-sottofrase').textContent, /Da fatturare: 800,00\s€ ai clienti con la tariffa\./);
	});

	await test('una riga per cliente, ore in italiano, importo, progetti, calendario', () => {
		const righe = [...C.doc.querySelectorAll('#cli-clienti > li')];
		assert.strictEqual(righe.length, 4);
		assert.strictEqual(righe[0].querySelector('.cli-nome').textContent, 'Cliente Alfa');
		assert.strictEqual(righe[0].querySelector('.cli-ore b').textContent, '20 h');
		assert.match(righe[0].querySelector('.cli-importo').textContent, /^800,00\s€$/);
		assert.strictEqual(righe[1].querySelector('.cli-ore b').textContent, '12 h 45 min');
		assert.ok(!righe[1].querySelector('.cli-importo'), 'senza tariffa niente importo');
		assert.strictEqual(righe[0].querySelectorAll('.cli-g:not(.cli-g-fuori)').length, 30, 'settembre ha 30 giorni');
		assert.strictEqual(righe[0].querySelectorAll('.cli-l5').length, 2, 'due giorni da 8 ore');
		assert.match(righe[0].querySelector('.cli-cal .sr').textContent, /^Giorni lavorati: martedì 1, 4 h; mercoledì 2, 8 h/);
		assert.strictEqual(righe[0].querySelector('.cli-barra i').style.getPropertyValue('--cli-w'), '1');
		assert.match(C.doc.getElementById('cli-regola').textContent, /^Ogni giorno di ogni cliente è arrotondato al quarto d'ora più vicino; due sessioni insieme contano una volta\.$/);
	});

	await test('scelta del mese: tendina e frecce chiedono il mese giusto', () => {
		const sel = C.doc.getElementById('cli-mese');
		assert.deepStrictEqual([...sel.options].map(o => o.value), ['2026-09', '2026-08', '2026-07']);
		assert.match(sel.options[0].textContent, /^Settembre 2026$/);
		C.posts.length = 0;
		scegli(C.w, sel, '2026-08');
		assert.deepStrictEqual(C.posts.pop(), { type: 'clients.request', month: '2026-08' });
		C.stanza.message({ type: 'clients', report: report() });
		click(C.w, C.doc.querySelector('[data-c="prima"]'));
		assert.deepStrictEqual(C.posts.pop(), { type: 'clients.request', month: '2026-08' });
		assert.ok(C.doc.querySelector('[data-c="dopo"]').disabled, 'settembre e il mese piu recente');
		C.stanza.message({ type: 'clients', report: report() });
	});

	await test('esportazione: CSV e Markdown, poi il percorso salvato', () => {
		C.posts.length = 0;
		click(C.w, C.doc.querySelector('[data-c="esporta"][data-f="csv"]'));
		assert.deepStrictEqual(C.posts.pop(), { type: 'clients.export', month: '2026-09', format: 'csv' });
		C.stanza.message({ type: 'clients.exported', path: `${HOME}/Documents/ore-2026-09.csv` });
		assert.strictEqual(C.doc.getElementById('cli-esito').textContent, 'Salvato in ~/Documents/ore-2026-09.csv');
		click(C.w, C.doc.querySelector('[data-c="esporta"][data-f="md"]'));
		assert.deepStrictEqual(C.posts.pop(), { type: 'clients.export', month: '2026-09', format: 'md' });
		C.stanza.message({ type: 'clients.exported', path: '' });
		assert.strictEqual(C.doc.getElementById('cli-esito').textContent, 'Esportazione annullata.');
	});

	await test('ore di nessuno: assegnare un progetto salva i clienti', () => {
		const righe = [...C.doc.querySelectorAll('#cli-liberi-lista > li')];
		assert.strictEqual(righe.length, 2);
		assert.match(righe[1].textContent, /non si possono assegnare/);
		const sel = righe[0].querySelector('select');
		const btn = righe[0].querySelector('[data-c="assegna"]');
		assert.ok(btn.disabled, 'senza scelta il pulsante e spento');
		scegli(C.w, sel, 'b');
		assert.ok(!btn.disabled);
		C.posts.length = 0;
		click(C.w, btn);
		const m = C.posts.pop();
		assert.strictEqual(m.type, 'clients.save');
		const beta = m.clients.find(c => c.id === 'b');
		assert.deepStrictEqual(beta.progetti, [P('beta'), P('epsilon')]);
		assert.strictEqual(m.clients.find(c => c.id === 'a').tariffa, 40);
		assert.ok(!('_t' in beta), 'niente campi interni nel file');
	});

	await test('un report nuovo non perde il fuoco sulla tendina di assegnazione', () => {
		C.stanza.message({ type: 'clients', report: report() });
		const sel = C.doc.querySelector('#cli-liberi-lista select');
		sel.focus();
		const r = report();
		r.clients[3].minutes = 135; // cambia un'altra riga
		r.unassigned[0].minutes = 315; // e anche la riga col fuoco
		C.stanza.message({ type: 'clients', report: r });
		assert.strictEqual(C.doc.activeElement.getAttribute('data-fk'), 'c:sc:' + P('epsilon'));
		assert.strictEqual(C.doc.querySelector('#cli-clienti > li:nth-child(4) .cli-ore b').textContent, '2 h 15 min');
		C.stanza.message({ type: 'clients', report: report() });
	});

	await test("l'editor: rinomina, tariffa, nuovo cliente con un progetto, salva", () => {
		click(C.w, C.doc.getElementById('cli-modifica'));
		const ed = C.doc.getElementById('cli-editor');
		assert.ok(!ed.hidden);
		assert.strictEqual(C.doc.getElementById('cli-modifica').getAttribute('aria-expanded'), 'true');
		assert.match(ed.textContent, /~\/\.bottega\/clienti\.json/);
		scrivi(C.w, C.doc.querySelector('[data-fk="c:n:b"]'), 'Cliente Beta Due');
		scrivi(C.w, C.doc.querySelector('[data-fk="c:t:b"]'), '35,5');
		// un report che arriva mentre scrivi non tocca i campi
		const campo = C.doc.querySelector('[data-fk="c:n:b"]');
		campo.focus();
		C.stanza.message({ type: 'clients', report: report() });
		assert.strictEqual(C.doc.activeElement, campo);
		assert.strictEqual(campo.value, 'Cliente Beta Due');

		click(C.w, C.doc.querySelector('[data-c="nuovo"]'));
		const nuovi = [...C.doc.querySelectorAll('#cli-ed-lista > li')];
		assert.strictEqual(nuovi.length, 5);
		const id = nuovi[4].getAttribute('data-key');
		assert.strictEqual(C.doc.activeElement, nuovi[4].querySelector('input'), 'il fuoco va sul nome del nuovo cliente');
		scrivi(C.w, nuovi[4].querySelector('[data-c-in="nome"]'), 'Cliente Epsilon');
		scegli(C.w, nuovi[4].querySelector('[data-c-in="aggiungi"]'), P('zeta'));
		const chip = C.doc.querySelector(`[data-key="${id}"] .cli-chips`);
		assert.match(chip.textContent, /Zeta/);
		assert.strictEqual(C.doc.querySelector(`[data-key="${id}"] input`).value, 'Cliente Epsilon', 'il nome scritto resta dopo il ridisegno');

		C.posts.length = 0;
		click(C.w, C.doc.querySelector('[data-c="salva"]'));
		const m = C.posts.pop();
		assert.strictEqual(m.type, 'clients.save');
		assert.strictEqual(m.clients.length, 5);
		const b = m.clients.find(c => c.id === 'b');
		assert.strictEqual(b.nome, 'Cliente Beta Due');
		assert.strictEqual(b.tariffa, 35.5);
		const e = m.clients.find(c => c.id === id);
		assert.deepStrictEqual(e, { id, nome: 'Cliente Epsilon', progetti: [P('zeta')] });
		assert.ok(C.doc.getElementById('cli-editor').hidden, "dopo il salvataggio l'editor si chiude");
		C.stanza.message({ type: 'clients', report: report() });
		assert.strictEqual(C.doc.getElementById('cli-esito').textContent, 'Clienti salvati.');
	});

	await test("l'editor: un nome vuoto non si salva, togliere un cliente chiede due pressioni", () => {
		click(C.w, C.doc.getElementById('cli-modifica'));
		scrivi(C.w, C.doc.querySelector('[data-fk="c:n:a"]'), '  ');
		C.posts.length = 0;
		click(C.w, C.doc.querySelector('[data-c="salva"]'));
		assert.strictEqual(C.posts.length, 0);
		assert.match(C.doc.getElementById('cli-ed-esito').textContent, /bisogno di un nome/);
		scrivi(C.w, C.doc.querySelector('[data-fk="c:n:a"]'), 'Cliente Alfa');
		const togli = () => C.doc.querySelector('[data-fk="c:tc:d"]');
		click(C.w, togli());
		assert.match(togli().textContent, /Premi di nuovo/);
		click(C.w, togli());
		assert.ok(!togli(), 'tolto alla seconda pressione');
		// spostare un progetto da un cliente all'altro
		scegli(C.w, C.doc.querySelector('[data-fk="c:add:a"]'), P('beta'));
		click(C.w, C.doc.querySelector('[data-c="salva"]'));
		const m = C.posts.pop();
		assert.deepStrictEqual(m.clients.map(c => c.id), ['a', 'b', 'g']);
		assert.deepStrictEqual(m.clients[0].progetti, [P('alfa'), P('beta')]);
		assert.deepStrictEqual(m.clients[1].progetti, []);
		C.stanza.message({ type: 'clients', report: report() });
	});

	await test('nessun cliente: frase e invito ad aggiungerne uno', () => {
		C.stanza.message({ type: 'clients', report: report({ clients: [], config: [], unassigned: [{ path: P('alfa'), name: 'Alfa', minutes: 90 }] }) });
		assert.match(C.doc.getElementById('cli-frase').textContent, /hai lavorato un'ora e mezza, ma non hai ancora clienti a cui darle\.$/);
		assert.ok(!C.doc.getElementById('cli-vuoto').hidden);
		C.stanza.message({ type: 'clients', report: report() });
	});

	await test('nessuna lineetta lunga nei Clienti, editor aperto compreso', () => {
		senzaLineette(C.root);
		click(C.w, C.doc.getElementById('cli-modifica'));
		senzaLineette(C.root);
		click(C.w, C.doc.querySelector('[data-c="annulla"]'));
		assert.ok(C.doc.getElementById('cli-editor').hidden);
	});

	await test('i file delle due stanze non contengono testo con lineette', () => {
		for (const f of ['vedetta.js', 'vedetta.css', 'clienti.js', 'clienti.css']) {
			const src = fs.readFileSync(path.join(MEDIA, f), 'utf8');
			assert.ok(!/[\u2013\u2014]/.test(src), f);
		}
	});

	await pausa(50);
	V.w.close();
	C.w.close();
	console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
