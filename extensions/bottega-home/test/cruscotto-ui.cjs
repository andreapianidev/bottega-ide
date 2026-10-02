#!/usr/bin/env node
// Banco di prova della stanza del cruscotto (media/cruscotto.js) in jsdom, con numeri finti:
// montaggio e API, cambio di periodo, ripiego senza WebGPU (assente, adattatore negato, shader
// rotto, dispositivo perso), ciclo di vita della GPU finta (frame solo a stanza visibile, pausa,
// rilascio a stanza nascosta), riduci movimento (solo stati finali), letture che contano una volta
// per arrivo e non a ogni aggiornamento, stessi contenuti con e senza WebGPU, niente lineette lunghe.
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
		};
	};
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
			{ pid: 101, sessionId: 's1', project: NOMI[0], path: `/Users/prova/prototipi/${NOMI[0]}`, title: 'Rifinire la mappa', status: 'busy', since: now - 600_000, started: now - 3_600_000, today: 95, tokToday: 3e6 },
			{ pid: 102, sessionId: 's2', project: NOMI[2], path: `/Users/prova/prototipi/${NOMI[2]}`, title: '', status: 'idle', since: now - 120_000, started: now - 7_200_000, today: 40, tokToday: 1e6 },
		],
		prices: { note: 'Stima a prezzi API, non quello che si paga con un abbonamento.', perModel: { 'claude-opus-5-5': [4, 20, 0.2] } },
		unpricedTokens: 33000,
		...(opts.extra || {}),
	};
}

// ---------- WebGPU finto ----------

/** Un WebGPU che non disegna niente ma conta: dispositivi, frame inviati, distruzioni. */
function fintaGpu(w, opts = {}) {
	const conto = { devices: 0, submit: 0, destroyed: 0, configure: 0, unconfigure: 0, adapterOpts: null, ultimo: null };
	const device = () => {
		conto.devices++;
		let perdi;
		const lost = new Promise(r => (perdi = r));
		const d = {
			lost,
			perdi: info => perdi(info),
			createShaderModule: ({ code }) => {
				assert.ok(code.includes('@vertex fn vs_luce') && code.includes('@fragment fn fs_fondo'), 'il modulo WGSL contiene i punti di ingresso');
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

function ambiente({ gpu = null, ridotto = false, tema = 'vscode-dark', rilascio = 60 } = {}) {
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
		assert.ok(n >= 1 && n <= 3, `pochi frame, solo stati finali: ${n}`);
		await pausa(150);
		assert.strictEqual(t.conto.submit, n, 'nessun movimento continuo');
		// periodo nuovo: un disegno solo, niente migrazione
		t.click(t.$('[data-c="periodo"][data-id="7"]'));
		await pausa(80);
		assert.ok(t.conto.submit - n <= 2);
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
		const a = ambiente({ ridotto: true });
		const b = ambiente({ ridotto: true, gpu: {} });
		for (const t of [a, b]) {
			t.api.show();
			t.api.setStats(s);
		}
		await pausa(80);
		assert.strictEqual(b.$('#carta').getAttribute('data-motore'), 'gpu');
		const pulito = t => t.$('#crus-corpo').innerHTML.replace(/ data-motore="[^"]*"/g, '').replace(/<span class="motore"[^>]*>[^<]*<\/span>/, '').replace(/ class="carta( gpu)?"/, '').replace(/<canvas[^>]*>/, '');
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

	console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
