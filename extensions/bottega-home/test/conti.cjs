#!/usr/bin/env node
// Banco di prova dei crediti e consumi dei servizi (src/conti.ts, CONTRATTI 14): rete finta, nessuna chiave vera.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const esbuild = require('esbuild');

const OUT = path.join(__dirname, 'test-out', 'conti');
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'conti.ts')], outdir: OUT, format: 'cjs', platform: 'node', bundle: true, target: 'node20', logLevel: 'silent' });
const C = require(path.join(OUT, 'conti.js'));

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
		console.log('FAIL  ' + name + '\n      ' + String((e && e.stack) || e).split('\n').slice(0, 4).join('\n      '));
	}
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-conti-'));
const giorno = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Una rete finta: saldo DeepSeek che cambia a mano; ElevenLabs senza user_read. */
function rete(stato) {
	return async (url) => {
		const ok = (j) => ({ ok: true, status: 200, json: async () => j });
		if (url.includes('deepseek')) return ok({ is_available: stato.ds > 0, balance_infos: [{ currency: 'USD', total_balance: String(stato.ds) }] });
		if (url.includes('openrouter')) throw new Error('OpenRouter non si chiama piu\'');
		if (url.includes('elevenlabs')) return stato.voce ? ok(stato.voce) : { ok: false, status: 401, json: async () => ({}) };
		throw new Error('url inattesa ' + url);
	};
}

function nuovo(stato, now, nome, extra = {}) {
	const dir = path.join(tmp, nome);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ elevenLabsCharsByMonth: {}, elevenLabsCharsByDay: stato.giorniVoce || {} }));
	fs.writeFileSync(path.join(dir, 'spesa.json'), JSON.stringify({ giorni: stato.deleghe || {}, storico: [] }));
	fs.writeFileSync(path.join(dir, 'elevenlabs.env'), 'ELEVENLABS_API_KEY=finta\n');
	return new C.Conti({
		chiave: () => 'ds-finta',
		agnesOggi: () => stato.agnes || 0,
		file: path.join(dir, 'giorni.json'),
		usageFile: path.join(dir, 'usage.json'),
		spesaFile: path.join(dir, 'spesa.json'),
		secretsDir: dir,
		fetch: rete(stato),
		now: () => now.t,
		...extra,
	});
}

(async () => {
	delete process.env.ELEVENLABS_API_KEY;

	await test('la discesa del saldo e\' spesa, la salita una ricarica, sul giorno della lettura', () => {
		const g = {};
		C.registraSaldo(g, 'deepseek', undefined, 9.98);
		assert.deepStrictEqual(g.deepseek, { speso: 0, ricarica: 0, saldo: 9.98 });
		C.registraSaldo(g, 'deepseek', 9.98, 9.5);
		C.registraSaldo(g, 'deepseek', 9.5, 19.5);
		assert.deepStrictEqual(g.deepseek, { speso: 0.48, ricarica: 10, saldo: 19.5 });
	});

	await test('soglie: sotto 2 $ o meno di 5 giorni e\' attesa, finito e\' male, frasi senza lineette', () => {
		const a = C.statoSaldo('DeepSeek', 9.98, 0.12, true, 0);
		assert.strictEqual(a.tono, 'ok');
		assert.strictEqual(a.giorniRimasti, 83);
		assert.match(a.frase, /circa 83 giorni al ritmo attuale/);
		assert.strictEqual(C.statoSaldo('DeepSeek', 1.5, null, true, 0).tono, 'attesa');
		assert.strictEqual(C.statoSaldo('DeepSeek', 3, 1, true, 0).tono, 'attesa');
		const m = C.statoSaldo('DeepSeek', 0, 1, false, 0);
		assert.strictEqual(m.tono, 'male');
		for (const s of [a, m]) assert.ok(!/[–—]/.test(s.frase), s.frase);
	});

	await test('media: servono due giorni di dati, poi la media degli ultimi sette', () => {
		assert.strictEqual(C.mediaGiorno({ '2026-10-03': { deepseek: { speso: 1, ricarica: 0, saldo: 1 } } }, 'deepseek', '2026-10-03'), null);
		const g = {};
		for (let i = 1; i <= 9; i++) g[`2026-10-0${i}`] = { deepseek: { speso: i, ricarica: 0, saldo: 1 } };
		assert.strictEqual(C.mediaGiorno(g, 'deepseek', '2026-10-09'), (3 + 4 + 5 + 6 + 7 + 8 + 9) / 7);
	});

	await test('aggiorna: scrive giorni.json (600), saldo, voce per giorno, deleghe, Agnes; un vecchio OpenRouter sparisce del tutto', async () => {
		const now = { t: new Date(2026, 9, 3, 12, 0).getTime() };
		const oggi = giorno(now.t);
		const stato = { ds: 9.98, agnes: 7, giorniVoce: { [oggi]: 1200 }, deleghe: { [oggi]: 0.4 } };
		// un file della build 59, con OpenRouter: saldo, campione e giorni spariscono
		fs.mkdirSync(path.join(tmp, 'base'), { recursive: true });
		fs.writeFileSync(path.join(tmp, 'base', 'giorni.json'), JSON.stringify({ schema: 1, aggiornato: 1, servizi: { openrouter: { nome: 'OpenRouter', tono: 'male' } }, giorni: { '2026-10-01': { openrouter: { speso: 1, ricarica: 0, saldo: -0.13 } } }, campioni: { openrouter: { at: 1, crediti: 45, uso: 45.13 } } }));
		const c = nuovo(stato, now, 'base');
		assert.strictEqual(c.allarmi().length, 0, 'nessun avviso per OpenRouter');
		await c.aggiorna();
		stato.ds = 9.5;
		stato.agnes = 9;
		now.t += 30 * 60_000;
		const d = await c.aggiorna();
		const g = d.giorni[oggi];
		assert.deepStrictEqual(g.deepseek, { speso: 0.48, ricarica: 0, saldo: 9.5 });
		assert.strictEqual(g.openrouter, undefined);
		assert.strictEqual(d.servizi.openrouter, undefined);
		assert.strictEqual(d.campioni.openrouter, undefined);
		assert.strictEqual(d.giorni['2026-10-01'], undefined, 'anche lo storico di OpenRouter se ne va');
		assert.deepStrictEqual(g.elevenlabs, { caratteri: 1200 });
		assert.deepStrictEqual(g.agnes, { richieste: 9 });
		assert.deepStrictEqual(g.deleghe, { usd: 0.4 });
		assert.strictEqual(d.servizi.deepseek.saldo, 9.5);
		assert.strictEqual(d.servizi.elevenlabs.limiteMese, null);
		assert.match(d.servizi.elevenlabs.frase, /contati dalla Bottega/);
		const f = c.file();
		assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
		const letto = JSON.parse(fs.readFileSync(f, 'utf8'));
		assert.strictEqual(letto.schema, 1);
		assert.strictEqual(letto.giorni[oggi].deepseek.saldo, 9.5);
	});

	await test('ElevenLabs con user_read: usati, limite e rinnovo dal servizio, oltre il 90% e\' attesa', async () => {
		const now = { t: new Date(2026, 9, 3, 12, 0).getTime() };
		const stato = { ds: 9, voce: { character_count: 95000, character_limit: 100000, next_character_count_reset_unix: Math.floor(new Date(2026, 9, 20).getTime() / 1000) } };
		const d = await nuovo(stato, now, 'voce').aggiorna();
		assert.strictEqual(d.servizi.elevenlabs.usatiMese, 95000);
		assert.strictEqual(d.servizi.elevenlabs.limiteMese, 100000);
		assert.strictEqual(d.servizi.elevenlabs.rinnovo, '2026-10-20');
		assert.strictEqual(d.servizi.elevenlabs.tono, 'attesa');
		assert.match(d.servizi.elevenlabs.frase, /ne restano 5000 fino al 20\/10/);
	});

	await test('avvisi: uno al giorno per servizio, anche dopo un riavvio; il giorno dopo di nuovo', async () => {
		const now = { t: new Date(2026, 9, 3, 12, 0).getTime() };
		const stato = { ds: 1.2 };
		const c = nuovo(stato, now, 'avvisi');
		const suonati = [];
		c.onAllarmi(n => suonati.push(...n));
		await c.aggiorna();
		await c.aggiorna();
		assert.strictEqual(suonati.length, 1);
		assert.strictEqual(suonati[0].app, 'DeepSeek');
		assert.match(suonati[0].testo, /^Restano 1,20 \$.*Si ricarica su platform\.deepseek\.com\.$/);
		assert.ok(suonati[0].id.endsWith(giorno(now.t)));
		// riavvio della Bottega lo stesso giorno: non suona di nuovo
		const c2 = nuovo(stato, now, 'avvisi');
		const dopo = [];
		c2.onAllarmi(n => dopo.push(...n));
		fs.writeFileSync(c2.file(), fs.readFileSync(c.file()));
		const c3 = new C.Conti({ chiave: () => 'ds', agnesOggi: () => 0, file: c.file(), usageFile: path.join(tmp, 'avvisi', 'usage.json'), spesaFile: path.join(tmp, 'avvisi', 'spesa.json'), secretsDir: path.join(tmp, 'avvisi'), fetch: rete(stato), now: () => now.t });
		c3.onAllarmi(n => dopo.push(...n));
		await c3.aggiorna();
		assert.strictEqual(dopo.length, 0);
		now.t += 24 * 3600_000;
		await c3.aggiorna();
		assert.strictEqual(dopo.length, 1);
		// ricaricato: niente piu' avvisi
		stato.ds = 20;
		assert.strictEqual((await c3.aggiorna(), c3.allarmi().length), 0);
	});

	await test('una lettura alla volta: due chiamate insieme fanno una sola richiesta per servizio', async () => {
		const now = { t: Date.now() };
		let chiamate = 0;
		const stato = { ds: 5 };
		const c = nuovo(stato, now, 'una', { fetch: async (u, o) => (u.includes('deepseek') && chiamate++, rete(stato)(u, o)) });
		await Promise.all([c.aggiorna(), c.aggiorna()]);
		assert.strictEqual(chiamate, 1);
	});

	await test('la sezione del Cruscotto (media/conti.js): tessere, barre, ricarica, tabella, Aggiorna, niente lineette', () => {
		const { JSDOM } = require('jsdom');
		const dom = new JSDOM('<!doctype html><div id="s"></div>', { runScripts: 'outside-only' });
		const w = dom.window;
		w.eval(fs.readFileSync(path.join(__dirname, '..', 'media', 'conti.js'), 'utf8'));
		const posts = [];
		const ui = w.BottegaConti.mount(w.document.getElementById('s'), { post: m => posts.push(m), periodo: () => '7', claude: () => 123.4 });
		const oggi = giorno(Date.now());
		const ieri = giorno(Date.now() - 86_400_000);
		ui.set({
			schema: 1,
			aggiornato: Date.now(),
			servizi: {
				deepseek: C.statoSaldo('DeepSeek', 9.5, 0.24, true, Date.now()),
				elevenlabs: C.statoVoce(12000, null, null, Date.now()),
				agnes: { nome: 'Agnes', gratis: true, tono: 'ok', frase: 'gratis, 9 richieste oggi' },
			},
			giorni: {
				[ieri]: { deepseek: { speso: 0, ricarica: 10, saldo: 9.98 }, agnes: { richieste: 3 } },
				[oggi]: { deepseek: { speso: 0.48, ricarica: 0, saldo: 9.5 }, deleghe: { usd: 0.4 }, elevenlabs: { caratteri: 1200 } },
			},
		});
		const d = w.document;
		const testo = d.getElementById('s').textContent;
		assert.strictEqual(d.querySelectorAll('.cifra').length, 3);
		assert.match(testo, /9,50 \$/);
		assert.match(testo, /circa 39 giorni al ritmo attuale/);
		assert.strictEqual(d.querySelectorAll('#conti-spesa rect.cs-deepseek').length, 1);
		assert.strictEqual(d.querySelectorAll('#conti-spesa rect.cs-deleghe').length, 1);
		assert.strictEqual(d.querySelectorAll('#conti-spesa .cs-ricarica').length, 1, 'la ricarica di ieri');
		assert.strictEqual(d.querySelectorAll('#conti-voce rect.cs-voce').length, 1);
		assert.match(d.getElementById('conti-nota').textContent, /0,88 \$ di spesa vera, 10,00 \$ di ricariche e 1200 caratteri di voce/);
		assert.match(d.getElementById('conti-nota').textContent, /Claude Code a listino vale 123,40 \$/);
		assert.match(d.getElementById('conti-spesa').getAttribute('aria-label'), /ultimi 7 giorni/);
		d.querySelector('[data-conti="tabella"]').click();
		assert.strictEqual(d.querySelectorAll('#conti-tabella tbody tr').length, 2);
		d.querySelector('[data-conti="aggiorna"]').click();
		assert.strictEqual(JSON.stringify(posts), JSON.stringify([{ type: 'conti.request', aggiorna: true }]));
		assert.ok(!/[\u2013\u2014]/.test(d.getElementById('s').textContent), 'nessuna lineetta lunga o media');
		ui.set(null);
		assert.match(d.getElementById('conti-nota').textContent, /non sono ancora stati letti/);
	});

	console.log(`\n${passed} ok, ${failed} falliti`);
	if (failed) {
		console.log('Falliti: ' + fails.join(', '));
		process.exit(1);
	}
})();
