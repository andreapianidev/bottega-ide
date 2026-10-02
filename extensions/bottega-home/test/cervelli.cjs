#!/usr/bin/env node
// Banco di prova dei cervelli di Melissa (src/cervelli.ts) e delle sue mani (src/mani.ts): rete finta, nessuna chiave
// vera, nessuna trascrizione vera (il repository e' pubblico).

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const esbuild = require('esbuild');

const OUT = path.join(__dirname, 'test-out', 'cervelli');
esbuild.buildSync({ entryPoints: ['cervelli', 'mani'].map(n => path.join(__dirname, '..', 'src', n + '.ts')), outdir: OUT, format: 'cjs', platform: 'node', bundle: false, target: 'node20', logLevel: 'silent' });
const cv = require(path.join(OUT, 'cervelli.js'));
const mani = require(path.join(OUT, 'mani.js'));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-cervelli-'));
const secrets = path.join(tmp, 'secrets');
fs.mkdirSync(secrets);
fs.writeFileSync(path.join(secrets, 'agnes-ai.env'), 'AGNES_API_KEY=chiave-finta-agnes\n');
fs.writeFileSync(path.join(secrets, 'openrouter-vision.env'), 'OPENROUTER_API_KEY=chiave-finta-or\n');
fs.writeFileSync(path.join(secrets, 'deepseek-harness.env'), 'DEEPSEEK_API_KEY=chiave-finta-ds\n');
for (const k of ['AGNES_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY']) delete process.env[k];

const MODELS = [
	{ id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', created: 30, pricing: { prompt: '0.000002', completion: '0.00001' }, supported_parameters: ['tools', 'reasoning'] },
	{ id: 'anthropic/claude-sonnet-5', name: 'Anthropic: Claude Sonnet 5', created: 20, pricing: { prompt: '0.000002', completion: '0.00001' }, supported_parameters: ['tools'] },
	{ id: 'anthropic/claude-sonnet-5.5:batch', created: 31, supported_parameters: ['tools'] },
	{ id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', created: 25, pricing: { prompt: '0.000004', completion: '0.00002' }, supported_parameters: ['tools'] },
	{ id: 'google/gemini-3.8-flash', name: 'Google: Gemini 3.8 Flash', created: 28, pricing: { prompt: '0.00000075', completion: '0.00000375' }, supported_parameters: ['tools'] },
	{ id: 'openai/gpt-6.1-sol', name: 'OpenAI: GPT-6.1 Sol', created: 29, pricing: { prompt: '0.000002', completion: '0.00001' }, supported_parameters: ['tools'] },
	{ id: 'openai/gpt-6.1-sol-pro', created: 32, supported_parameters: ['tools'] },
	{ id: 'openai/gpt-6-luna', created: 33, supported_parameters: ['tools'] },
];

function memento() {
	const m = new Map();
	return { get: k => m.get(k), update: (k, v) => void m.set(k, v) };
}

function sse(events) {
	const enc = new TextEncoder();
	const lines = events.map(e => `data: ${JSON.stringify({ choices: [{ delta: e }] })}\n`).join('') + 'data: [DONE]\n';
	return new ReadableStream({ start(c) { c.enqueue(enc.encode(lines.slice(0, 40))); c.enqueue(enc.encode(lines.slice(40))); c.close(); } });
}

function fakeFetch(opts = {}) {
	const calls = [];
	const f = async (url, init = {}) => {
		calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
		if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: MODELS }) };
		if (url.endsWith('/credits')) return { ok: true, status: 200, json: async () => ({ data: opts.credit ?? { total_credits: 10, total_usage: 7.5 } }) };
		if (url.includes('user/balance')) return { ok: true, status: 200, json: async () => opts.dsBalance ?? { is_available: false, balance_infos: [{ currency: 'USD', total_balance: '-0.01' }] } };
		if (url.includes('deepseek')) return { ok: opts.dsStatus === 200, status: opts.dsStatus ?? 402, body: null };
		if (opts.chatStatus && opts.chatStatus !== 200) return { ok: false, status: opts.chatStatus, body: null };
		return { ok: true, status: 200, body: sse(opts.events ?? [{ content: 'Ciao ' }, { content: 'Andrea.' }]) };
	};
	f.calls = calls;
	return f;
}

(async () => {
	await test('OpenRouter: il modello piu\' recente per famiglia, con strumenti, senza :batch, -pro, -luna; prezzi per milione', () => {
		const o = cv.pickOpenRouter(MODELS);
		assert.deepStrictEqual(o.map(x => x.model), ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'google/gemini-3.8-flash', 'openai/gpt-6.1-sol']);
		assert.strictEqual(o[0].label, 'Claude Sonnet 5.5');
		assert.deepStrictEqual(o[0].price, { in: 2, out: 10 });
		assert.deepStrictEqual(o[2].price, { in: 0.75, out: 3.75 });
	});

	await test('impegno tradotto per ogni provider', () => {
		const msgs = [{ role: 'user', content: 'x' }];
		assert.strictEqual(cv.requestBody({ provider: 'agnes', model: 'agnes-3.0-flash', effort: 'rapido' }, msgs, []).reasoning_effort, 'none');
		assert.strictEqual(cv.requestBody({ provider: 'agnes', model: 'agnes-3.0-flash', effort: 'profondo' }, msgs, []).reasoning_effort, 'high');
		assert.deepStrictEqual(cv.requestBody({ provider: 'openrouter', model: 'x', effort: 'normale' }, msgs, []).reasoning, { effort: 'medium' });
		assert.strictEqual(cv.requestBody({ provider: 'deepseek', model: 'deepseek-chat', effort: 'profondo' }, msgs, []).model, 'deepseek-reasoner');
		const withTools = cv.requestBody({ provider: 'agnes', model: 'a', effort: 'normale' }, msgs, [{ type: 'function', function: { name: 't', description: '', parameters: {} } }]);
		assert.strictEqual(withTools.tool_choice, 'auto');
		assert.ok(!('tools' in cv.requestBody({ provider: 'agnes', model: 'a', effort: 'normale' }, msgs, [])), 'senza strumenti niente tools ne\' tool_choice');
	});

	await test('a voce: «usa Claude», «pensa piu\' a fondo», «torna ad Agnes», «rispondi veloce»', () => {
		assert.deepStrictEqual(cv.spokenChoice('Melissa, usa Claude'), { provider: 'openrouter', family: 0 });
		assert.deepStrictEqual(cv.spokenChoice('passa a Opus e pensa più a fondo'), { provider: 'openrouter', family: 1, effort: 'profondo' });
		assert.deepStrictEqual(cv.spokenChoice('torna ad Agnes'), { provider: 'agnes' });
		assert.deepStrictEqual(cv.spokenChoice('rispondi veloce'), { effort: 'rapido' });
		assert.deepStrictEqual(cv.spokenChoice('usa gemini'), { provider: 'openrouter', family: 2 });
	});

	await test('stato: opzioni, credito, DeepSeek senza credito (402) disabilitato, scelta ricordata', async () => {
		const f = fakeFetch();
		const c = new cv.Cervelli({ memento: memento(), fetch: f, secretsDir: secrets, cacheFile: path.join(tmp, 'c1.json'), appleAvailable: () => true });
		const st = await c.state();
		assert.strictEqual(st.current.provider, 'agnes');
		assert.deepStrictEqual(st.credit, { openrouter: 2.5 });
		const ds = st.options.find(o => o.provider === 'deepseek');
		assert.strictEqual(ds.available, false);
		assert.strictEqual(ds.why, 'senza credito');
		await c.set('openrouter', 'anthropic/claude-opus-5.5');
		await c.setEffort('profondo');
		assert.deepStrictEqual(c.choice(), { provider: 'openrouter', model: 'anthropic/claude-opus-5.5', effort: 'profondo' });
		await assert.rejects(() => c.set('deepseek'), /senza credito/);
		c.endConversation();
		assert.deepStrictEqual(c.choice(), { provider: 'agnes', model: 'agnes-3.0-flash', effort: 'profondo' }, 'fine conversazione: Agnes, l\'impegno resta');
		assert.ok(fs.existsSync(path.join(tmp, 'c1.json')), 'elenco dei modelli in cache');
	});

	await test('Agnes sempre primaria: la scelta manuale non si salva, scade dopo 15 minuti senza domande, non sopravvive al riavvio', async () => {
		let now = 1_000_000;
		const m = memento();
		const c = new cv.Cervelli({ memento: m, fetch: fakeFetch(), secretsDir: secrets, cacheFile: path.join(tmp, 'c5.json'), now: () => now });
		await c.set('openrouter', 'google/gemini-3.8-flash');
		assert.strictEqual(c.choice().provider, 'openrouter');
		now += 10 * 60_000;
		c.touch();
		now += 10 * 60_000;
		assert.strictEqual(c.choice().provider, 'openrouter', 'una domanda allunga la scelta');
		now += 16 * 60_000;
		assert.strictEqual(c.choice().provider, 'agnes', 'dopo 15 minuti senza domande si torna ad Agnes');
		await c.set('openrouter', 'google/gemini-3.8-flash');
		const dopo = new cv.Cervelli({ memento: m, fetch: fakeFetch(), secretsDir: secrets, cacheFile: path.join(tmp, 'c5.json'), now: () => now });
		assert.strictEqual(dopo.choice().provider, 'agnes', 'al riavvio si riparte da Agnes');
	});

	await test('saldo OpenRouter negativo: si mostra, ma il cervello resta usabile finche\' l\'API non dice 402', async () => {
		const c = new cv.Cervelli({ memento: memento(), fetch: fakeFetch({ credit: { total_credits: 45, total_usage: 45.13 } }), secretsDir: secrets, cacheFile: path.join(tmp, 'c2.json') });
		await c.set('openrouter', 'anthropic/claude-sonnet-5.5');
		const st = await c.state();
		assert.deepStrictEqual(st.credit, { openrouter: -0.13 });
		assert.strictEqual(st.current.provider, 'openrouter');
		assert.ok(st.options.filter(o => o.provider === 'openrouter').every(o => o.available));
	});

	await test('conti: Agnes senza saldo ma con richieste e 429, OpenRouter e DeepSeek dai loro endpoint, ElevenLabs contato in locale', async () => {
		let now = Date.UTC(2026, 9, 2, 9);
		const usage = path.join(tmp, 'usage.json');
		fs.writeFileSync(usage, JSON.stringify({ elevenLabsCharsByMonth: { '2026-10': 801 } }));
		const c = new cv.Cervelli({ memento: memento(), fetch: fakeFetch({ credit: { total_credits: 45, total_usage: 45.13 } }), secretsDir: secrets, cacheFile: path.join(tmp, 'c6.json'), usageFile: usage, now: () => now });
		c.noteAgnes(200);
		c.noteAgnes(200);
		let st = await c.state();
		const by = id => st.accounts.find(a => a.id === id);
		assert.strictEqual(by('agnes').text, 'gratis, nessun saldo da controllare; 2 richieste oggi dalla Bottega');
		assert.strictEqual(by('agnes').local, true);
		assert.strictEqual(by('openrouter').text, 'saldo -0,13 $: va ricaricato');
		assert.strictEqual(by('openrouter').tone, 'male');
		assert.strictEqual(by('deepseek').text, 'saldo -0,01 $: senza credito');
		assert.ok(by('elevenlabs').text.startsWith('801 caratteri di voce a ottobre, contati dalla Bottega'));
		c.noteAgnes(429);
		now += 60_000;
		st = await c.state();
		assert.strictEqual(by('agnes').tone, 'attesa');
		assert.ok(by('agnes').text.startsWith('al limite di circa 20 richieste al minuto (un 429'));
		assert.ok(!st.accounts.some(a => /[\u2014\u2013]/.test(a.text)));
	});

	await test('stream: testo e strumenti a pezzi, intestazioni di OpenRouter, chiave dal vault', async () => {
		const f = fakeFetch({ events: [{ content: 'Apro ' }, { tool_calls: [{ index: 0, id: 'c1', function: { name: 'progetto_apri', arguments: '{"prog' } }] }, { tool_calls: [{ index: 0, function: { arguments: 'etto":"Peak"}' } }] }] });
		const c = new cv.Cervelli({ memento: memento(), fetch: f, secretsDir: secrets, cacheFile: path.join(tmp, 'c3.json') });
		const got = [];
		await c.streamFor({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', effort: 'rapido' })([{ role: 'user', content: 'apri peak' }], [], d => got.push(d), new AbortController().signal);
		assert.deepStrictEqual(got[0], { content: 'Apro ' });
		assert.strictEqual(got.filter(d => d.tool_call).map(d => d.tool_call.arguments).join(''), '{"progetto":"Peak"}');
		const call = f.calls.find(x => x.url.includes('chat/completions'));
		assert.strictEqual(call.headers.authorization, 'Bearer chiave-finta-or');
		assert.strictEqual(call.headers['X-Title'], 'Bottega');
		assert.deepStrictEqual(call.body.reasoning, { effort: 'low' });
		assert.strictEqual(c.streamFor({ provider: 'apple', model: 'x', effort: 'normale' }), undefined, 'Apple passa dal Nucleo');
	});

	await test('402 durante una risposta: errore chiaro, cervello da parte per un\'ora, scelta tornata ad Agnes', async () => {
		const c = new cv.Cervelli({ memento: memento(), fetch: fakeFetch({ chatStatus: 402 }), secretsDir: secrets, cacheFile: path.join(tmp, 'c4.json') });
		await c.set('openrouter', 'google/gemini-3.8-flash');
		await assert.rejects(() => c.streamFor()([{ role: 'user', content: 'x' }], [], () => {}, new AbortController().signal), e => e.status === 402 && /senza credito/.test(e.message));
		assert.strictEqual(c.choice().provider, 'agnes');
	});

	await test('mani: la coda di una trascrizione racconta richiesta, risposta, strumenti, file e se aspetta', () => {
		const root = path.join(tmp, 'projects', '-p-demo');
		fs.mkdirSync(root, { recursive: true });
		const sid = 'a1b2c3d4-0000-4000-8000-000000000001';
		const t = (s, o) => JSON.stringify({ timestamp: new Date(Date.UTC(2026, 9, 2, 8, s)).toISOString(), ...o });
		fs.writeFileSync(path.join(root, sid + '.jsonl'), [
			t(0, { type: 'user', message: { content: 'sistema le notifiche push' } }),
			t(1, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/p/demo/a.swift' } }] } }),
			t(2, { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
			t(3, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/p/demo/b.swift' } }, { type: 'text', text: 'Fatto: le notifiche partono da APNs. Vuoi che alzi la build?' }] } }),
			'{"type":"user", riga rotta',
		].join('\n') + '\n');
		const d = mani.digest(sid, path.join(tmp, 'projects'));
		assert.strictEqual(d.lastPrompt, 'sistema le notifiche push');
		assert.ok(d.lastReply.startsWith('Fatto: le notifiche'));
		assert.deepStrictEqual(d.files, ['/p/demo/b.swift', '/p/demo/a.swift']);
		assert.deepStrictEqual(d.tools.map(x => x.name).sort(), ['Edit', 'Read']);
		assert.strictEqual(d.waiting, true);
		const txt = mani.digestText(d, 'demo', Date.UTC(2026, 9, 2, 8, 10));
		assert.ok(txt.startsWith('Sessione su demo, ultimo movimento 7 minuti fa, aspetta Andrea.'));
		assert.ok(!/[—–]/.test(txt));
		assert.strictEqual(mani.digest('non-un-id', path.join(tmp, 'projects')), undefined);
	});

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(`\n${passed} ok, ${failed} falliti${fails.length ? ': ' + fails.join(', ') : ''}`);
	process.exit(failed ? 1 : 0);
})();
