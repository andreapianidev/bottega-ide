#!/usr/bin/env node
// Banco di prova della stanza del cruscotto (media/cruscotto.js) in jsdom, con numeri finti:
// montaggio e API, cambio di periodo, ripiego senza WebGPU (assente, adattatore negato, shader
// rotto, dispositivo perso), ciclo di vita della GPU finta (frame solo a stanza visibile, pausa,
// rilascio a stanza nascosta), riduci movimento (solo stati finali), letture che contano una volta
// per arrivo e non a ogni aggiornamento, stessi contenuti con e senza WebGPU, niente lineette lunghe.
// Il banco: i blocchi nuovi (oggi, parallelo, chi sale, durate, adesso), le due colonne che finiscono
// insieme a ogni larghezza (misurate o stimate), la classifica che si allunga accanto al cielo.
// Nessun dato vero: il repository e' pubblico. Progetti e numeri sono inventati.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const MEDIA = path.join(__dirname, '..', 'media');
const JS = fs.readFileSync(path.join(MEDIA, 'cruscotto.js'), 'utf8');

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

// ---------- numeri finti ----------

const NOMI = ['faro-di-prova', 'orto-digitale', 'mappa-lenta', 'quaderno', 'vela-bianca', 'telaio', 'bussola', 'archivio-sonoro', 'lanterna', 'pendolo', 'cometa', 'radice'];
const sum4 = t => t[0] + t[1] + t[2] + t[3];

function rnd(seed) {
	return () => {
		seed = (seed * 1664525 + 1013904223) % 4294967296;
		return seed / 4294967296;
	};
}

function key(d) {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function totali(r, scala) {
	const tok = [Math.round(2e5 * scala * r()), Math.round(9e5 * scala * r()), Math.round(4e7 * scala * r()), Math.round(3e6 * scala * r())];
	return { you: Math.round(600 * scala * (0.5 + r())), claude: Math.round(1300 * scala * (0.5 + r())), tok, cost: 40 * scala * (0.5 + r()), sessions: Math.round(30 * scala), prompts: Math.round(180 * scala), activeDays: Math.min(90, Math.round(5 * scala)) };
}

function fintiStats(opts = {}) {
	const r = rnd(opts.seme || 7);
	const now = opts.now || Date.now();
	const oggi = new Date(now);
	const days = [];
	for (let i = 89; i >= 0; i--) {
		const d = new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate() - i);
		const you = i % 7 === 5 ? 0 : Math.round(60 + 300 * r());
		const tok = [Math.round(3e3 * r()), Math.round(2e4 * r()), Math.round(2e6 * r()), Math.round(1e5 * r())];
		days.push({ date: key(d), you, claude: Math.round(you * (1.4 + r())), sessions: Math.round(you / 40), prompts: Math.round(you / 6), tok, cost: sum4(tok) / 5e5 });
	}
	const weeks = [];
	for (let i = 0; i < 14; i++) {
		const a = new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate() - 7 * (13 - i) - ((oggi.getDay() + 6) % 7));
		const z = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6);
		weeks.push({ key: `2026-W${String(27 + i).padStart(2, '0')}`, start: key(a), end: key(z > oggi ? oggi : z), ...totali(r, 7) });
	}
	const months = [0, 1, 2, 3].map(i => {
		const a = new Date(oggi.getFullYear(), oggi.getMonth() - 3 + i, 1);
		const z = new Date(a.getFullYear(), a.getMonth() + 1, 0);
		return { key: `${a.getFullYear()}-${String(a.getMonth() + 1).padStart(2, '0')}`, start: key(a), end: key(z > oggi ? oggi : z), ...totali(r, 30) };
	});
	const periodo = n => {
		const scala = n / 7;
		const projects = NOMI.slice(0, n === 7 ? 6 : n === 30 ? 9 : 12).map((name, i) => {
			const hours = Array.from({ length: 24 }, (_, h) => (h >= 8 + (i % 5) && h <= 13 + (i % 7) ? Math.round(30 * r()) : 0));
			const you = Math.round((900 / (i + 1)) * scala * (0.6 + r()));
			const tok = [Math.round(1e4 * r()), Math.round(1e5 * r()), Math.round(5e6 * r()), Math.round(2e5 * r())];
			return {
				name,
				path: `/Users/prova/prototipi/${name}`,
				you,
				claude: Math.round(you * 1.8),
				tok,
				cost: sum4(tok) / 4e5,
				sessions: 3 + i,
				prev: { you: i === 3 ? 0 : Math.round(you * 0.8), claude: Math.round(you * 1.2), tok: Math.round(sum4(tok) * 0.7), cost: 1 },
				last: now - i * 0.7 * 86_400_000 - 3_600_000,
				daily: Array.from({ length: n }, () => Math.round(60 * r())),
				hours,
				live: i === 0 || i === 2 ? 1 : 0,
			};
		});
		projects.push({ name: 'Fuori dai progetti', path: null, you: 95, claude: 120, tok: [1, 2, 3, 4], cost: 0.1, sessions: 2, prev: { you: 50, claude: 60, tok: 5, cost: 0.1 }, last: now - 86_400_000 * 2, daily: [], hours: Array.from({ length: 24 }, (_, h) => (h === 22 ? 95 : 0)), live: 0 });
		const heat = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d < 5 && h >= 9 && h <= 19 ? Math.round(40 * r() * scala) : h === 23 ? 5 : 0)));
		const bins = [2, 5, 9, 11, 7, 3, 1].map(v => Math.round(v * scala));
		return {
			...totali(r, scala),
			days: n,
			from: days[90 - n].date,
			avgSession: 47,
			peak: { n: 3, at: now - 86_400_000 },
			prev: totali(r, scala * 0.8),
			projects,
			edges: [
				{ a: NOMI[0], b: NOMI[1], minutes: 95 },
				{ a: NOMI[0], b: NOMI[2], minutes: 35 },
				{ a: NOMI[3], b: NOMI[4], minutes: 22 },
			],
			models: [
				{ id: 'claude-opus-5-5', name: 'Opus 5.5', tok: [1e5, 2e5, 3e7, 2e6], messages: 900, cost: 120 },
				{ id: 'modello-x', name: 'Modello X', tok: [1e3, 2e3, 3e4, 0], messages: 10, cost: null },
			],
			heat,
			lengths: { edges: [5, 15, 30, 60, 120, 240], bins, median: 38.5, n: bins.reduce((a, b) => a + b, 0) },
			stalled: n === 7 ? [] : [{ name: 'ponte-sospeso', path: '/Users/prova/prototipi/ponte-sospeso', prev: 340, last: now - 12 * 86_400_000 }],
		};
	};
	const ora0 = new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate(), oggi.getHours() - 167).getTime();
	const avg = [], peak = [], busy = [];
	for (let i = 0; i < 168; i++) {
		const h = new Date(ora0 + i * 3_600_000).getHours();
		const lavora = h >= 9 && h <= 19 && i % 24 !== 5;
		const b = lavora ? Math.round(20 + 40 * r()) : 0;
		const p = lavora ? 1 + Math.floor(4 * r()) : 0;
		busy.push(b);
		peak.push(p);
		avg.push(lavora ? Math.round((1 + (p - 1) * r()) * 10) / 10 : 0);
	}
	// la giornata: minuti dalla mezzanotte, finiti entro adesso
	const nowMin = Math.max(400, oggi.getHours() * 60 + oggi.getMinutes());
	const m0 = nowMin - 380;
	const todaySessions = [
		{ sid: 't1', project: NOMI[0], path: `/Users/prova/prototipi/${NOMI[0]}`, title: 'Rifinire la mappa', where: '', spans: [m0, m0 + 70, m0 + 110, m0 + 160], tok: 2e6, live: false },
		{ sid: 't2', project: NOMI[0], path: `/Users/prova/prototipi/${NOMI[0]}`, title: 'Le idee nuove', where: 'copia faro-idee, ramo idee', spans: [m0 + 40, m0 + 130], tok: 9e5, live: false },
		{ sid: 't3', project: NOMI[2], path: `/Users/prova/prototipi/${NOMI[2]}`, title: '', where: 'cartella sito', spans: [m0 + 150, m0 + 240], tok: 4e5, live: false },
		{ sid: 't4', project: NOMI[0], path: `/Users/prova/prototipi/${NOMI[0]}`, title: 'Sistemare il cruscotto', where: '', spans: [m0 + 250, nowMin - 30], tok: 3e6, live: true },
		{ sid: 't5', project: 'Fuori dai progetti', path: null, title: 'Una domanda veloce', where: 'dalla home', spans: [m0 + 300, m0 + 320], tok: 1e4, live: false },
	];
	return {
		version: 1,
		computedAt: now,
		ms: 812,
		files: { total: 40, read: 3, cached: 37, mb: 12.5 },
		gapMinutes: 15,
		streakMinutes: 30,
		tz: 'Atlantic/Canary',
		firstEvent: now - 200 * 86_400_000,
		today: { date: key(oggi), you: opts.oggi ?? 185, claude: 290, tok: 4e6, sessions: 4 },
		week: { start: days[84].date, now: { you: 1210, claude: 2100, tok: 3e7 }, prevSoFar: { you: 900, claude: 1500, tok: 2e7 }, prevFull: { you: 1900, claude: 3000, tok: 5e7 } },
		days,
		weeks,
		months,
		periods: { 7: periodo(7), 30: periodo(30), 90: periodo(90) },
		streak: { current: 4, best: 11, bestEnd: days[40].date },
		records: { busiestDay: { date: days[50].date, you: 610 }, longestStint: { start: now - 20 * 86_400_000, minutes: 245 }, tokenDay: { date: days[60].date, tok: 9e7 } },
		live: [
			{ pid: 101, sessionId: 's1', project: NOMI[0], path: `/Users/prova/prototipi/${NOMI[0]}`, title: 'Rifinire la mappa', status: 'busy', since: now - 600_000, started: now - 3_600_000, today: 95, tokToday: 3e6, cwd: `/Users/prova/prototipi/${NOMI[0]}`, where: '' },
			{ pid: 102, sessionId: 's2', project: NOMI[2], path: `/Users/prova/prototipi/${NOMI[2]}`, title: '', status: 'idle', since: now - 120_000, started: now - 7_200_000, today: 40, tokToday: 1e6, cwd: `/Users/prova/prototipi/${NOMI[2]}`, where: '' },
			{ pid: 103, sessionId: 's3', project: NOMI[0], path: `/Users/prova/prototipi/${NOMI[0]}`, title: 'Le idee nuove', status: 'busy', since: now - 60_000, started: now - 1_800_000, today: 25, tokToday: 5e5, cwd: '/Users/prova/prototipi/faro-idee', where: 'copia faro-idee, ramo idee' },
		],
		todaySessions,
		concurrency7: { start: ora0, avg, peak, busy },
		prices: { note: 'Stima a prezzi API, non quello che si paga con un abbonamento.', perModel: { 'claude-opus-5-5': [4, 20, 0.2] } },
		unpricedTokens: 33000,
		...(opts.extra || {}),
	};
}

// ---------- WebGPU finto ----------

/** Un WebGPU che non disegna niente ma conta: dispositivi, frame inviati, distruzioni. */
function fintaGpu(w, opts = {}) {
	const conto = { devices: 0, submit: 0, destroyed: 0, configure: 0, unconfigure: 0, adapterOpts: null, ultimo: null, moduli: [] };
	const device = () => {
		conto.devices++;
		let perdi;
		const lost = new Promise(r => (perdi = r));
		const d = {
			lost,
			perdi: info => perdi(info),
			createShaderModule: ({ code }) => {
				const cielo = code.includes('@vertex fn vs_luce') && code.includes('@fragment fn fs_fondo');
				const fiume = code.includes('@fragment fn fs_fiume') && code.includes('@vertex fn vs_goccia');
				assert.ok(cielo || fiume, 'il modulo WGSL contiene i punti di ingresso');
				conto.moduli.push(cielo ? 'cielo' : 'corrente');
				return { getCompilationInfo: async () => ({ messages: opts.wgslRotto ? [{ type: 'error', lineNum: 12, message: 'finto errore' }] : [] }) };
			},
			createRenderPipelineAsync: async desc => {
				assert.strictEqual(desc.layout, 'auto');
				return { getBindGroupLayout: () => ({}) };
			},
			createBuffer: desc => ({ size: desc.size, destroy() {} }),
			createTexture: () => ({ createView: () => ({}), destroy() {} }),
			createBindGroup: () => ({}),
			createCommandEncoder: () => ({
				beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() {}, end() {} }),
				finish: () => ({}),
			}),
			queue: {
				writeBuffer() {},
				submit() {
					conto.submit++;
				},
			},
			destroy() {
				conto.destroyed++;
				perdi({ reason: 'destroyed', message: '' });
			},
			addEventListener() {},
		};
		conto.ultimo = d;
		return d;
	};
	const gpu = {
		requestAdapter: async o => {
			conto.adapterOpts = o;
			if (opts.rifiuta) throw new Error('rifiutato');
			return opts.senzaAdattatore ? null : { requestDevice: async () => device() };
		},
		getPreferredCanvasFormat: () => 'bgra8unorm',
	};
	Object.defineProperty(w.navigator, 'gpu', { value: gpu, configurable: true });
	w.HTMLCanvasElement.prototype.getContext = function (k) {
		return k === 'webgpu'
			? {
					configure() {
						conto.configure++;
					},
					unconfigure() {
						conto.unconfigure++;
					},
					getCurrentTexture: () => ({ createView: () => ({}) }),
				}
			: null;
	};
	return conto;
}

// ---------- ambiente ----------

function ambiente({ gpu = null, ridotto = false, tema = 'vscode-dark', rilascio = 60, adesso = 0, larghezza = 0, alti = null } = {}) {
	const dom = new JSDOM(`<!doctype html><html lang="it"><body class="${tema}"><main id="app"></main></body></html>`, {
		runScripts: 'outside-only',
		pretendToBeVisual: true,
		url: 'https://plancia.invalid/',
	});
	const w = dom.window;
	const errori = [];
	const avvisi = [];
	w.console.error = (...a) => errori.push(a.map(String).join(' '));
	w.console.warn = (...a) => avvisi.push(a.map(String).join(' '));
	const conto = gpu ? fintaGpu(w, gpu) : null;
	if (adesso) w.Date.now = () => adesso;
	// misure finte: jsdom non impagina. `larghezza` e' quella del banco, `alti` le altezze per id
	if (larghezza) Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.id === 'banco' ? larghezza : 0; } });
	if (alti) Object.defineProperty(w.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { const v = alti[this.id] ?? (this.tagName === 'LI' && this.closest('#classifica') ? alti['riga'] : 0); return typeof v === 'function' ? v() : v || 0; } });
	w.eval(JS);
	const posts = [];
	const salvati = [];
	const focused = [];
	const ascoltatori = [];
	const reduced = { matches: ridotto, addEventListener: (_, f) => ascoltatori.push(f) };
	const root = w.document.getElementById('app');
	const api = w.BottegaCruscotto.mount(root, {
		post: m => posts.push(JSON.parse(JSON.stringify(m))),
		saved: {},
		save: o => salvati.push(JSON.parse(JSON.stringify(o))),
		reduced,
		focusProject: p => focused.push(p),
		rilascioGpu: rilascio,
	});
	const $ = s => root.querySelector(s);
	const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
	return { dom, w, root, api, posts, salvati, focused, $, click, conto, errori, avvisi, reduced, ascoltatori };
}

/** Testo e attributi del DOM: nessuna lineetta lunga U+2014 o media U+2013. */
function senzaLineette(root) {
	const html = root.innerHTML;
	const i = html.search(/[\u2013\u2014]/);
	assert.ok(i < 0, `lineetta nel DOM intorno a "${html.slice(Math.max(0, i - 50), i + 50)}"`);
}

const lettura = (t, k) => t.$(`.lettura[data-k="${k}"]`).textContent;
const finale = (t, k) => t.$(`.cifra[data-k="${k}"] dd > .sr`).textContent;

(async () => {
	console.log('cruscotto, la sala di controllo');

	await test('montaggio: API intatta, attesa, poi corpo con cifre, cielo e tabelle', async () => {
		const t = ambiente({ ridotto: true });
		for (const m of ['setStats', 'render', 'show', 'hide', 'pause', 'resume']) assert.strictEqual(typeof t.api[m], 'function', m);
		assert.ok(!t.$('#crus-attesa').hidden);
		t.api.show();
		assert.deepStrictEqual(t.posts.at(-1), { type: 'stats.request', period: 30 });
		const s = fintiStats();
		t.api.setStats(s);
		assert.ok(t.$('#crus-attesa').hidden);
		assert.ok(!t.$('#crus-corpo').hidden);
		assert.strictEqual(t.root.querySelectorAll('.cifra').length, 5);
		assert.strictEqual(t.root.querySelectorAll('.traccia-mini').length, 5, 'una traccia per cifra');
		const stelle = s.periods['30'].projects.filter(p => p.you >= 1).length;
		assert.strictEqual(t.root.querySelectorAll('#carta-svg .stella').length, stelle);
		assert.ok(t.root.querySelectorAll('#carta-svg .corona path').length > 0, 'corona delle ore');
		assert.ok(t.$('#carta-svg .lancetta-asta').getAttribute('x2'), 'lancetta di adesso');
		assert.ok(t.$('#calore .adesso-cella'), 'la casella di adesso nella settimana');
		assert.match(t.$('#carta-conto').textContent, /stelle, 3 legami, due vive/);
		assert.match(t.$('#crus-frase').textContent, /Questa settimana hai lavorato/);
		assert.deepStrictEqual(t.errori, []);
	});

	await test('senza WebGPU: motore SVG, luci dell\'SVG al loro posto, nessun errore', async () => {
		const t = ambiente({ ridotto: true });
		t.api.show();
		t.api.setStats(fintiStats());
		await pausa(30);
		assert.strictEqual(t.$('#carta').getAttribute('data-motore'), 'svg');
		assert.ok(!t.$('#carta').classList.contains('gpu'));
		assert.strictEqual(t.$('#carta-motore').textContent, 'SVG');
		assert.ok(t.root.querySelectorAll('#carta-svg .campo circle').length === 140);
		assert.ok(t.root.querySelectorAll('#carta-svg .nucleo').length > 0);
		assert.ok(t.root.querySelectorAll('#carta-svg .anello').length === 2, 'anelli delle due sessioni vive');
		assert.deepStrictEqual(t.errori, []);
	});

	await test('adattatore negato, richiesta rifiutata o WGSL rotto: ripiego sull\'SVG, una sola volta', async () => {
		for (const gpu of [{ senzaAdattatore: true }, { rifiuta: true }, { wgslRotto: true }]) {
			const t = ambiente({ gpu, ridotto: true });
			t.api.show();
			t.api.setStats(fintiStats());
			await pausa(40);
			assert.strictEqual(t.$('#carta').getAttribute('data-motore'), 'svg', JSON.stringify(gpu));
			assert.ok(!t.$('#carta').classList.contains('gpu'));
			assert.strictEqual(t.conto.adapterOpts.powerPreference, 'low-power');
			assert.ok(t.avvisi.some(a => /ripiego/.test(a)), 'un avviso in console spiega perche"');
			assert.ok(/WebGPU non è partito/.test(t.$('#carta-motore').title));
			// tornare nella stanza non riprova
			t.api.hide();
			t.api.show();
			await pausa(20);
			assert.ok(t.conto.devices <= 1);
			assert.strictEqual(t.$('#carta').getAttribute('data-motore'), 'svg');
			assert.deepStrictEqual(t.errori, []);
		}
	});

	await test('WebGPU finto: si accende, disegna a stanza visibile, si ferma in pausa e nascosta', async () => {
		const t = ambiente({ gpu: {} });
		t.api.show();
		t.api.setStats(fintiStats());
		await pausa(120);
		assert.strictEqual(t.$('#carta').getAttribute('data-motore'), 'gpu');
		assert.ok(t.$('#carta').classList.contains('gpu'));
		assert.strictEqual(t.$('#carta-motore').textContent, 'WebGPU su Metal');
		assert.ok(t.conto.submit >= 2, `frame inviati: ${t.conto.submit}`);
		assert.strictEqual(t.conto.devices, 1, 'un solo dispositivo per cielo e corrente');
		assert.deepStrictEqual(t.conto.moduli.slice().sort(), ['cielo', 'corrente']);
		assert.strictEqual(t.$('#corrente').getAttribute('data-motore'), 'gpu');
		assert.ok(t.$('#corrente').classList.contains('gpu'));
		// pausa (finestra nascosta): niente frame
		t.api.pause();
		let n = t.conto.submit;
		await pausa(150);
		assert.strictEqual(t.conto.submit, n, 'in pausa non si disegna');
		t.api.resume();
		await pausa(150);
		assert.ok(t.conto.submit > n, 'alla ripresa si ridisegna');
		// stanza nascosta: niente frame, poi la GPU si libera (anche una pausa lunga la libera)
		t.api.hide();
		n = t.conto.submit;
		const distrutti = t.conto.destroyed;
		const dispositivi = t.conto.devices;
		await pausa(30);
		assert.strictEqual(t.conto.submit, n, 'a stanza nascosta non si disegna');
		await pausa(80);
		assert.strictEqual(t.conto.destroyed, distrutti + 1, 'GPU liberata dopo il rilascio');
		assert.strictEqual(t.$('#carta').getAttribute('data-motore'), 'spento');
		assert.strictEqual(t.$('#corrente').getAttribute('data-motore'), 'spento');
		assert.ok(!t.$('#carta').classList.contains('gpu'), 'liberata la GPU, si vede l\'SVG');
		// tornando, si riaccende
		t.api.show();
		await pausa(80);
		assert.strictEqual(t.conto.devices, dispositivi + 1);
		assert.strictEqual(t.$('#carta').getAttribute('data-motore'), 'gpu');
		t.api.hide();
		await pausa(100);
		assert.deepStrictEqual(t.errori, []);
	});

	await test('tornare nella stanza prima del rilascio non riaccende la GPU', async () => {
		const t = ambiente({ gpu: {}, rilascio: 400 });
		t.api.show();
		t.api.setStats(fintiStats());
		await pausa(60);
		t.api.hide();
		await pausa(40);
		t.api.show();
		await pausa(60);
		assert.strictEqual(t.conto.devices, 1);
		assert.strictEqual(t.conto.destroyed, 0);
		t.api.hide();
		await pausa(450);
		assert.strictEqual(t.conto.destroyed, 1);
	});

	await test('dispositivo perso: ripiego sull\'SVG, frame fermi', async () => {
		const t = ambiente({ gpu: {} });
		t.api.show();
		t.api.setStats(fintiStats());
		await pausa(80);
		assert.strictEqual(t.$('#carta').getAttribute('data-motore'), 'gpu');
		t.conto.ultimo.perdi({ reason: 'unknown', message: 'GPU azzerata' });
		await pausa(20);
		assert.strictEqual(t.$('#carta').getAttribute('data-motore'), 'svg');
		assert.ok(!t.$('#carta').classList.contains('gpu'));
		assert.match(t.$('#carta-motore').title, /dispositivo perso/);
		assert.strictEqual(t.$('#corrente').getAttribute('data-motore'), 'svg', 'anche la corrente torna all\'SVG');
		const n = t.conto.submit;
		await pausa(120);
		assert.strictEqual(t.conto.submit, n);
		assert.deepStrictEqual(t.errori, []);
	});

	await test('riduci movimento: valori finali subito, niente rivelazione, la GPU disegna e si ferma', async () => {
		const t = ambiente({ gpu: {}, ridotto: true });
		t.api.show();
		const s = fintiStats();
		t.api.setStats(s);
		for (const k of ['tu', 'claude', 'sessioni', 'token', 'valore']) assert.strictEqual(lettura(t, k), finale(t, k), k);
		assert.ok(!t.$('#crus').classList.contains('rivela'));
		assert.ok(!t.$('#crus-frase').classList.contains('glitch'));
		assert.ok(!t.$('#curva').classList.contains('traccia'));
		await pausa(120);
		const n = t.conto.submit;
		assert.ok(n >= 1 && n <= 5, `pochi frame, solo stati finali (cielo e corrente): ${n}`);
		await pausa(150);
		assert.strictEqual(t.conto.submit, n, 'nessun movimento continuo');
		// periodo nuovo: un disegno solo, niente migrazione
		t.click(t.$('[data-c="periodo"][data-id="7"]'));
		await pausa(80);
		assert.ok(t.conto.submit - n <= 2, 'un frame per il cielo; la corrente ha gli stessi dati e non ridisegna');
		assert.strictEqual(t.root.querySelectorAll('#carta-svg .vecchia').length, 0);
		t.api.hide();
	});

	await test('arrivo dei dati: rivelazione e conteggio una volta; l\'aggiornamento periodico segnala e basta', async () => {
		const t = ambiente();
		t.api.show();
		const s = fintiStats();
		t.api.setStats(s);
		assert.ok(t.$('#crus').classList.contains('rivela'), 'la scansione parte');
		assert.ok(t.$('#crus-frase').classList.contains('glitch'), 'interferenza breve sulla frase');
		assert.ok(t.$('#curva').classList.contains('traccia'));
		assert.notStrictEqual(lettura(t, 'token'), finale(t, 'token'), 'la lettura parte da zero');
		await pausa(1400);
		for (const k of ['tu', 'claude', 'sessioni', 'token', 'valore']) assert.strictEqual(lettura(t, k), finale(t, k), `${k} si assesta`);
		await pausa(1600);
		assert.ok(!t.$('#crus').classList.contains('rivela'));
		// due minuti dopo: numeri un po' diversi, nessuna rivelazione, nessun conteggio
		const s2 = fintiStats({ now: s.computedAt + 120_000 });
		s2.periods['30'].you += 25;
		t.api.setStats(s2);
		assert.ok(!t.$('#crus').classList.contains('rivela'), 'niente nuova rivelazione');
		assert.ok(!t.$('#crus-cifre').classList.contains('traccia'));
		assert.strictEqual(lettura(t, 'tu'), finale(t, 'tu'), 'nessun conteggio da zero');
		assert.ok(t.$('.cifra[data-k="tu"]').classList.contains('cambiata'), 'la cifra cambiata si segnala');
		// Aggiorna, chiesto da Andrea: rivelazione di nuovo
		t.click(t.$('[data-c="aggiorna"]'));
		t.api.setStats(fintiStats({ now: s.computedAt + 130_000 }));
		assert.ok(t.$('#crus').classList.contains('rivela'));
		t.api.hide();
		assert.strictEqual(lettura(t, 'tu'), finale(t, 'tu'), 'nascondendo, le letture vanno al valore finale');
		assert.deepStrictEqual(t.errori, []);
	});

	await test('dati arrivati a stanza nascosta: la rivelazione aspetta che la stanza si veda', async () => {
		const t = ambiente();
		t.api.setStats(fintiStats());
		assert.ok(!t.$('#crus').classList.contains('rivela'));
		t.api.show();
		assert.ok(t.$('#crus').classList.contains('rivela'));
		t.api.hide();
	});

	await test('cambio di periodo: stato salvato, stelle che migrano, cifre che scorrono dai valori di prima', async () => {
		const t = ambiente();
		t.api.show();
		const s = fintiStats();
		t.api.setStats(s);
		await pausa(1200);
		const prima = lettura(t, 'tu');
		t.click(t.$('[data-c="periodo"][data-id="7"]'));
		assert.strictEqual(t.$('[data-c="periodo"][data-id="7"]').getAttribute('aria-pressed'), 'true');
		assert.strictEqual(t.salvati.at(-1).period, '7');
		assert.match(t.$('#classifica-nota').textContent, /negli ultimi 7 giorni/);
		assert.ok(t.$('#crus').classList.contains('ritraccia'));
		assert.strictEqual(lettura(t, 'tu'), prima, 'la lettura parte dal valore del periodo di prima');
		assert.ok(t.root.querySelectorAll('#carta-svg .vecchia').length > 0, 'le stelle che c\'erano scivolano');
		// il raggruppamento non valido per 7 giorni torna a "per giorno"
		assert.ok(t.$('[data-c="gruppo"][data-id="settimana"]').disabled);
		await pausa(1200);
		assert.strictEqual(lettura(t, 'tu'), finale(t, 'tu'));
		t.click(t.$('[data-c="periodo"][data-id="90"]'));
		t.click(t.$('[data-c="gruppo"][data-id="mese"]'));
		assert.ok(t.root.querySelectorAll('#curva .pila').length >= 3, 'colonne per mese');
		assert.ok(t.$('#curva').classList.contains('traccia'));
		t.api.hide();
		assert.deepStrictEqual(t.errori, []);
	});

	await test('stessi contenuti con e senza WebGPU', async () => {
		const s = fintiStats();
		const a = ambiente({ ridotto: true, adesso: s.computedAt });
		const b = ambiente({ ridotto: true, gpu: {}, adesso: s.computedAt });
		for (const t of [a, b]) {
			t.api.show();
			t.api.setStats(s);
		}
		await pausa(80);
		assert.strictEqual(b.$('#carta').getAttribute('data-motore'), 'gpu');
		assert.strictEqual(b.$('#corrente').getAttribute('data-motore'), 'gpu');
		const pulito = t =>
			t.$('#crus-corpo').innerHTML
				.replace(/ data-motore="[^"]*"/g, '')
				.replace(/<span class="motore"[^>]*>[^<]*<\/span>/g, '')
				.replace(/ class="(carta|corrente)( gpu)?"/g, '')
				.replace(/<canvas[^>]*>/g, '');
		assert.strictEqual(pulito(a), pulito(b));
		a.api.hide();
		b.api.hide();
	});

	await test('mouse e tastiera: mirino sulla stella, frecce sui grafici, tabelle', async () => {
		const t = ambiente({ ridotto: true, gpu: {} });
		t.api.show();
		t.api.setStats(fintiStats());
		await pausa(60);
		const presa = t.$('#carta-svg .presa');
		presa.dispatchEvent(new t.w.MouseEvent('pointermove', { bubbles: true }));
		const mira = t.$('#carta-svg .mira');
		assert.ok(!mira.hasAttribute('hidden'), 'il mirino aggancia la stella');
		assert.match(mira.querySelector('path').getAttribute('d'), /^M-/);
		assert.ok(!t.$('#crus-tip').hidden);
		t.$('#carta-svg').dispatchEvent(new t.w.MouseEvent('pointerleave'));
		assert.ok(mira.hasAttribute('hidden'));
		// classifica col tab
		t.$('.riga-progetto').dispatchEvent(new t.w.FocusEvent('focusin', { bubbles: true }));
		assert.ok(!t.$('#carta-svg .mira').hasAttribute('hidden'));
		// grafico da tastiera
		const curva = t.$('#curva');
		curva.dispatchEvent(new t.w.FocusEvent('focus'));
		curva.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		assert.match(t.$('#crus-tip .tip-titolo').textContent, /\d/);
		// tutte le tabelle aperte, in tutti i periodi: niente lineette lunghe
		for (const b of t.root.querySelectorAll('[data-c="tabella"]')) t.click(b);
		assert.ok(t.root.querySelectorAll('table').length >= 4);
		for (const p of ['7', '30', '90']) {
			t.click(t.$(`[data-c="periodo"][data-id="${p}"]`));
			senzaLineette(t.root);
		}
		t.api.hide();
		assert.deepStrictEqual(t.errori, []);
	});

	await test('tema chiaro, errore e riprova: nessuna lineetta, nessun errore', async () => {
		const t = ambiente({ tema: 'vscode-light' });
		t.api.show();
		t.api.setStats(null, 'I registri non si leggono.');
		assert.ok(!t.$('#crus-errore').hidden);
		senzaLineette(t.root);
		t.click(t.$('[data-c="riprova"]'));
		assert.strictEqual(t.posts.at(-1).type, 'stats.request');
		t.api.setStats(fintiStats({ oggi: 0 }));
		assert.ok(t.$('#crus-errore').hidden);
		senzaLineette(t.root);
		t.api.hide();
		assert.deepStrictEqual(t.errori, []);
	});

	// ---------- il banco ----------

	await test('oggi, sessione per sessione: corsie per progetto, sovrapposte, aperta tratteggiata, tastiera', async () => {
		// alle 15, qualunque ora sia davvero: l'orologio della stanza e' fermo li'
		const d = new Date();
		const s = fintiStats({ now: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 15, 0).getTime() });
		const t = ambiente({ ridotto: true, adesso: s.computedAt });
		t.api.show();
		t.api.setStats(s);
		const svg = t.$('#oggi svg');
		assert.ok(svg, 'la linea del tempo c\'e\'');
		const nomi = [...svg.querySelectorAll('.corsia-nome')].map(x => x.textContent);
		assert.deepStrictEqual(nomi, ['Tu', 'faro-di-prova', 'mappa-lenta', 'Fuori dai progetti'], 'una corsia per progetto, in ordine di inizio');
		assert.strictEqual(svg.querySelectorAll('.barra-s').length, 6, 'una barra per intervallo');
		assert.ok(svg.querySelectorAll('.barra-tu').length >= 1, 'le tue ore: l\'unione');
		assert.strictEqual(svg.querySelectorAll('.pausa').length, 1, 'la pausa dentro la stessa sessione');
		assert.strictEqual(svg.querySelectorAll('.ancora').length, 1, 'la sessione aperta arriva fino ad adesso');
		assert.ok(svg.querySelector('.adesso-linea'));
		// t1 e t2 si sovrappongono nella stessa corsia: due righe diverse
		const y = i => +svg.querySelector(`.barra-s[data-s="${i}"]`).getAttribute('y');
		assert.notStrictEqual(y(0), y(1));
		assert.strictEqual(y(0), y(3), 't4 parte dopo la fine di t1: torna nella prima riga');
		assert.match(t.$('#oggi-nota').textContent, /Oggi cinque sessioni su tre progetti, dalle \d+:\d\d\. Per .+ ne hai fatte girare almeno due insieme\./);
		// tastiera: frecce da una sessione all'altra, il lettore di schermo sente titolo, progetto e copia
		const og = t.$('#oggi');
		og.dispatchEvent(new t.w.FocusEvent('focus'));
		og.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		og.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		assert.strictEqual(t.$('#crus-tip .tip-titolo').textContent, 'Le idee nuove');
		assert.match(t.$('#crus-tip').textContent, /faro-di-prova, copia faro-idee, ramo idee/);
		assert.ok(svg.querySelector('.barra-s[data-s="1"]').classList.contains('acceso'));
		await pausa(30);
		assert.match(t.$('#crus-voce').textContent, /Le idee nuove, faro-di-prova, copia faro-idee/);
		// tabella
		t.click(t.$('[data-c="tabella"][data-id="oggi"]'));
		assert.strictEqual(t.root.querySelectorAll('#oggi-tabella tbody tr').length, 5);
		t.api.hide();
		assert.deepStrictEqual(t.errori, []);
	});

	await test('adesso: titolo davanti, copia di lavoro e ora di apertura distinguono le sessioni, PID nel suggerimento', () => {
		const t = ambiente({ ridotto: true });
		t.api.show();
		t.api.setStats(fintiStats());
		const li = [...t.root.querySelectorAll('#adesso li')];
		assert.strictEqual(li.length, 3);
		assert.deepStrictEqual(li.map(x => x.querySelector('b').textContent), ['Rifinire la mappa', 'mappa-lenta', 'Le idee nuove']);
		assert.strictEqual(li[2].querySelector('.dove').textContent, 'faro-di-prova, copia faro-idee, ramo idee');
		assert.ok(li[2].querySelector('.dove').classList.contains('copia'));
		assert.match(li[2].title, /^PID 103, cartella \/Users\/prova\/prototipi\/faro-idee$/);
		assert.match(li[0].textContent, /aperta alle \d\d:\d\d/);
		t.api.hide();
	});

	await test('lavoro in parallelo: fascia, massimi, giorni, frecce e tabella; la corrente parte con WebGPU', async () => {
		const t = ambiente({ gpu: {}, ridotto: true });
		t.api.show();
		const s = fintiStats();
		t.api.setStats(s);
		await pausa(80);
		const svg = t.$('#parallelo svg');
		assert.ok(svg.querySelector('.fascia'), 'la fascia c\'e\' anche con WebGPU: la nasconde il CSS, i dati restano');
		assert.ok(svg.querySelector('.massimo'));
		assert.strictEqual(svg.querySelectorAll('linearGradient stop').length, 168);
		assert.ok(svg.querySelectorAll('.giorno').length >= 6, 'un filo per mezzanotte');
		assert.match(t.$('#parallelo-nota').textContent, /Nelle ore in cui lavori girano in media \d+,\d sessioni insieme\. Al massimo ne hai avute (quattro|tre|due) insieme/);
		assert.match(t.$('#corrente-conto').textContent, /ore con sessioni, \d+ con almeno due/);
		assert.strictEqual(t.$('#corrente-motore').textContent, 'WebGPU su Metal');
		const el = t.$('#parallelo');
		el.dispatchEvent(new t.w.FocusEvent('focus'));
		assert.ok(!svg.querySelector('.mirino').hasAttribute('hidden'));
		el.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		assert.match(t.$('#crus-tip .tip-titolo').textContent, /, dalle \d+ alle \d+$/);
		t.click(t.$('[data-c="tabella"][data-id="parallelo"]'));
		assert.strictEqual(t.root.querySelectorAll('#parallelo-tabella tbody tr').length, s.concurrency7.busy.filter(b => b > 0).length);
		t.api.hide();
		assert.deepStrictEqual(t.errori, []);
	});

	await test('chi sale e chi scende: ore tue prima e adesso, i progetti fermi inclusi, clic apre il progetto', () => {
		const t = ambiente({ ridotto: true });
		t.api.show();
		const s = fintiStats();
		t.api.setStats(s);
		const tit = [...t.root.querySelectorAll('#sale h3')].map(x => x.textContent);
		assert.deepStrictEqual(tit, ['Salgono', 'Si stanno fermando']);
		const giu = [...t.root.querySelectorAll('#sale ol')[1].querySelectorAll('.riga-sale')];
		assert.ok(giu.some(b => /ponte-sospeso/.test(b.textContent)), 'il progetto fermo, che non e\' tra i progetti del periodo');
		const ponte = giu.find(b => /ponte-sospeso/.test(b.textContent));
		assert.match(ponte.textContent, /nessuna ora adesso, ultima volta 12 giorni fa/);
		assert.strictEqual(parseFloat(ponte.querySelector('.ora').style.left), 0, 'adesso a zero ore');
		assert.ok(parseFloat(ponte.querySelector('.prima').style.left) > 0, 'prima, piu\' a destra');
		assert.strictEqual(parseFloat(ponte.querySelector('.tratto').style.width), parseFloat(ponte.querySelector('.prima').style.left), 'il tratto va da adesso a prima');
		assert.match(ponte.getAttribute('aria-label'), /in meno\. Apri nella plancia\.$/);
		assert.match(t.$('#sale-nota').textContent, /^Sale soprattutto [a-z-]+, .+ in più dei 30 giorni prima; poi [a-z-]+\. Si sta fermando ponte-sospeso: .+, nessuna ora in questi, l'ultima volta 12 giorni fa\.$/);
		t.click(ponte);
		assert.strictEqual(t.focused.at(-1), '/Users/prova/prototipi/ponte-sospeso');
		// senza registri prima: lo dice, niente righe
		const s2 = fintiStats({ extra: { firstEvent: Date.now() - 5 * 86_400_000 } });
		t.api.setStats(s2);
		assert.strictEqual(t.root.querySelectorAll('#sale .riga-sale').length, 0);
		assert.match(t.$('#sale-nota').textContent, /servono dei registri anche nei 30 giorni prima/);
		t.api.hide();
	});

	await test('quanto dura una sessione: fasce, mediana, frase e tabella', () => {
		const t = ambiente({ ridotto: true });
		t.api.show();
		t.api.setStats(fintiStats());
		const svg = t.$('#durata svg');
		assert.strictEqual(svg.querySelectorAll('.col-claude').length, 7);
		assert.ok(svg.querySelector('.mediana'));
		assert.match(svg.querySelector('.mediana-t').textContent, /^metà sotto 39 min$/);
		assert.match(t.$('#durata-nota').textContent, /^Metà delle 163 sessioni degli ultimi 30 giorni dura meno di 39 minuti\. \d+ durano più di due ore e \d+ meno di un quarto d'ora\.$/);
		const el = t.$('#durata');
		el.dispatchEvent(new t.w.FocusEvent('focus'));
		el.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		assert.strictEqual(t.$('#crus-tip .tip-titolo').textContent, 'meno di 5 minuti');
		t.click(t.$('[data-c="tabella"][data-id="durata"]'));
		assert.strictEqual(t.root.querySelectorAll('#durata-tabella tbody tr').length, 7);
		t.api.hide();
	});

	await test('dati di prima (senza i campi nuovi): i blocchi lo dicono, nessun errore', () => {
		const t = ambiente({ ridotto: true });
		t.api.show();
		const s = fintiStats();
		delete s.todaySessions;
		delete s.concurrency7;
		for (const k of ['7', '30', '90']) {
			delete s.periods[k].lengths;
			delete s.periods[k].stalled;
		}
		t.api.setStats(s);
		assert.match(t.$('#oggi-nota').textContent, /nessuna sessione/);
		assert.match(t.$('#parallelo-nota').textContent, /prossimo aggiornamento/);
		assert.match(t.$('#durata-nota').textContent, /prossimo aggiornamento/);
		assert.ok(t.root.querySelectorAll('#sale .riga-sale').length > 0, 'chi sale usa i dati di sempre');
		senzaLineette(t.root);
		t.api.hide();
		assert.deepStrictEqual(t.errori, []);
	});

	await test('dividi: la divisione migliore tra tutte, i fissi rispettati, niente salti per pochi pixel', () => {
		const t = ambiente();
		const { dividi } = t.w.BottegaCruscotto;
		const pref = [0, 1, 0, 1, 0, 1, 1];
		const r = rnd(11);
		for (let k = 0; k < 200; k++) {
			const h = Array.from({ length: 7 }, () => Math.round(120 + 500 * r()));
			const d = dividi(h, 48, [0, -1, -1, -1, -1, -1, -1], pref, null);
			// forza bruta indipendente: lo scarto minimo possibile con il primo blocco a sinistra
			let min = Infinity;
			for (let m = 0; m < 128; m += 2) {
				const a = [0, 0], n = [0, 0];
				for (let i = 0; i < 7; i++) {
					a[(m >> i) & 1] += h[i];
					n[(m >> i) & 1]++;
				}
				for (const c of [0, 1]) if (n[c] > 1) a[c] += 48 * (n[c] - 1);
				min = Math.min(min, Math.abs(a[0] - a[1]));
			}
			assert.ok(d.scarto <= min + 6 * 7, `scarto ${d.scarto}, minimo ${min}`);
			assert.strictEqual(d.colonne[0], 0);
		}
		const h = [400, 300, 330, 330, 380, 320, 400];
		const d1 = dividi(h, 48, [0, -1, -1, -1, -1, -1, -1], pref, null);
		const fisso = dividi(h, 48, [0, -1, -1, -1, -1, 0, -1], pref, null);
		assert.strictEqual(fisso.colonne[5], 0, 'un blocco fisso resta nella sua colonna');
		// una divisione appena peggiore della migliore resta: niente blocchi che saltano
		const quasi = d1.colonne.slice();
		const h2 = h.slice();
		h2[2] += 20;
		const d2 = dividi(h2, 48, [0, -1, -1, -1, -1, -1, -1], pref, quasi);
		assert.deepStrictEqual(d2.colonne, quasi);
	});

	await test('banco: due colonne pari a 1280, 1600 e 1920 px (stesso contenuto, 1160), una colonna a 600', async () => {
		// <main> si ferma a 1240 px con 40 px di margine: da 1280 in su il banco e' largo 1160
		for (const larghezza of [1160, 980, 840]) {
			const t = ambiente({ ridotto: true, larghezza });
			t.api.show();
			t.api.setStats(fintiStats());
			const b = t.$('#banco');
			assert.ok(!b.classList.contains('una'), `${larghezza}: due colonne`);
			const div = b.getAttribute('data-divisione');
			assert.match(div, /^0[01]{6}$/, 'oggi sempre a sinistra');
			assert.ok(div.includes('1'), 'la colonna destra non e\' vuota');
			assert.ok(+b.getAttribute('data-scarto') <= 60, `${larghezza}: scarto ${b.getAttribute('data-scarto')} px`);
			assert.strictEqual(t.$('#banco-a').children.length + t.$('#banco-b').children.length, 7);
			t.api.hide();
		}
		// 600 px di finestra: 520 di banco, una colonna nell'ordine di lettura
		const t = ambiente({ ridotto: true, larghezza: 520 });
		t.api.show();
		t.api.setStats(fintiStats());
		assert.ok(t.$('#banco').classList.contains('una'));
		assert.deepStrictEqual([...t.$('#banco-a').children].map(e => e.id), ['b-oggi', 'b-adesso', 'b-parallelo', 'b-calore', 'b-sale', 'b-durata', 'b-registro']);
		assert.strictEqual(t.$('#banco-b').children.length, 0);
		t.api.hide();
	});

	await test('banco con le altezze vere: si pareggia, e un blocco con la tabella aperta non scappa', async () => {
		const alti = { 'b-oggi': 420, 'b-adesso': 260, 'b-parallelo': 330, 'b-calore': 330, 'b-sale': 380, 'b-durata': 320, 'b-registro': 400 };
		const t = ambiente({ ridotto: true, larghezza: 1160, alti });
		t.api.show();
		t.api.setStats(fintiStats());
		const { dividi } = t.w.BottegaCruscotto;
		const h = ['b-oggi', 'b-adesso', 'b-parallelo', 'b-calore', 'b-sale', 'b-durata', 'b-registro'].map(id => alti[id]);
		const atteso = dividi(h, 48, [0, -1, -1, -1, -1, -1, -1], [0, 1, 0, 1, 0, 1, 1], null);
		assert.strictEqual(t.$('#banco').getAttribute('data-divisione'), atteso.colonne.join(''));
		assert.strictEqual(+t.$('#banco').getAttribute('data-scarto'), atteso.scarto, 'misurate, non stimate');
		const col = id => (t.$('#' + id).parentElement.id === 'banco-a' ? 0 : 1);
		const prima = col('b-durata');
		// Andrea apre la tabella delle durate: il blocco cresce di 360 px ma resta dov'e'
		alti['b-durata'] = 680;
		t.click(t.$('[data-c="tabella"][data-id="durata"]'));
		assert.strictEqual(col('b-durata'), prima);
		// gli altri si ridistribuiscono attorno
		t.api.setStats(fintiStats({ now: Date.now() + 120_000 }));
		assert.strictEqual(col('b-durata'), prima);
		t.api.hide();
	});

	await test('la classifica si allunga fino in fondo al cielo, non oltre i progetti che ci sono', () => {
		const alti = { carta: 900, 'classifica-col': 560, riga: 46 };
		const t = ambiente({ ridotto: true, alti });
		t.api.show();
		t.api.setStats(fintiStats());
		t.click(t.$('[data-c="periodo"][data-id="90"]'));
		// 10 righe + (900 - 560) / 46 = 17, ma nei 90 giorni i progetti sono 13: tutti, senza bottone
		assert.strictEqual(t.root.querySelectorAll('#classifica li').length, 13);
		assert.strictEqual(t.$('#classifica-piede').textContent, '');
		t.api.hide();
	});

	await test('banco: tutte le tabelle aperte, chiaro e scuro, nessuna lineetta lunga o media', () => {
		for (const tema of ['vscode-dark', 'vscode-light']) {
			const t = ambiente({ ridotto: true, tema });
			t.api.show();
			t.api.setStats(fintiStats());
			for (const b of t.root.querySelectorAll('[data-c="tabella"]')) t.click(b);
			for (const p of ['7', '30', '90']) {
				t.click(t.$(`[data-c="periodo"][data-id="${p}"]`));
				senzaLineette(t.root);
			}
			assert.ok(t.root.querySelectorAll('table').length >= 8, 'cielo, ore, token, oggi, parallelo, settimana, chi sale, durate');
			t.api.hide();
			assert.deepStrictEqual(t.errori, []);
		}
		const src = JS + fs.readFileSync(path.join(MEDIA, 'cruscotto.css'), 'utf8');
		assert.ok(!/[\u2013\u2014]/.test(src), 'nessuna lineetta nei sorgenti della stanza');
	});

	console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
