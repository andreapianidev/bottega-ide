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
// la chiave di OpenRouter resta nel vault (non si cancella niente): la Bottega deve ignorarla

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
		if (url.includes('openrouter')) throw new Error('OpenRouter non si chiama piu\'');
		if (url.includes('user/balance')) return { ok: true, status: 200, json: async () => opts.dsBalance ?? { is_available: false, balance_infos: [{ currency: 'USD', total_balance: '-0.01' }] } };
		if (url.includes('deepseek')) return { ok: opts.dsStatus === 200, status: opts.dsStatus ?? 402, body: null };
		if (opts.chatStatus && opts.chatStatus !== 200) return { ok: false, status: opts.chatStatus, body: null };
		return { ok: true, status: 200, body: sse(opts.events ?? [{ content: 'Ciao ' }, { content: 'Andrea.' }]) };
	};
	f.calls = calls;
	return f;
}

(async () => {
	await test('niente OpenRouter: neanche con la chiave nel vault compare tra i cervelli o nei conti, e non si chiama', async () => {
		const f = fakeFetch({ dsStatus: 200 });
		const c = new cv.Cervelli({ memento: memento(), fetch: f, secretsDir: secrets, appleAvailable: () => true });
		const st = await c.state();
		assert.deepStrictEqual(st.options.map(o => o.provider), ['agnes', 'apple', 'deepseek']);
		assert.ok(!st.accounts.some(a => a.id === 'openrouter'));
		assert.ok(!('credit' in st));
		assert.ok(!f.calls.some(x => x.url.includes('openrouter')));
		assert.strictEqual(c.key('openrouter'), undefined);
	});

	await test('impegno tradotto per ogni provider; DeepSeek: Flash senza e con poco ragionamento, a fondo V4 Pro', () => {
		const msgs = [{ role: 'user', content: 'x' }];
		assert.strictEqual(cv.requestBody({ provider: 'agnes', model: 'agnes-3.0-flash', effort: 'rapido' }, msgs, []).reasoning_effort, 'none');
		assert.strictEqual(cv.requestBody({ provider: 'agnes', model: 'agnes-3.0-flash', effort: 'profondo' }, msgs, []).reasoning_effort, 'high');
		const ds = e => cv.requestBody({ provider: 'deepseek', model: 'deepseek-flash', effort: e }, msgs, []);
		assert.deepStrictEqual([ds('rapido').model, ds('rapido').reasoning_effort], ['deepseek-flash', 'none']);
		assert.deepStrictEqual([ds('normale').model, ds('normale').reasoning_effort], ['deepseek-flash', 'low']);
		assert.deepStrictEqual([ds('profondo').model, ds('profondo').reasoning_effort], ['deepseek-v4-pro', 'high']);
		const withTools = cv.requestBody({ provider: 'agnes', model: 'a', effort: 'normale' }, msgs, [{ type: 'function', function: { name: 't', description: '', parameters: {} } }]);
		assert.strictEqual(withTools.tool_choice, 'auto');
		assert.ok(!('tools' in cv.requestBody({ provider: 'agnes', model: 'a', effort: 'normale' }, msgs, [])), 'senza strumenti niente tools ne\' tool_choice');
	});

	await test('a voce: «usa DeepSeek», «pensa piu\' a fondo», «torna ad Agnes», «rispondi veloce»; Claude e Gemini non ci sono piu\'', () => {
		assert.deepStrictEqual(cv.spokenChoice('Melissa, usa DeepSeek'), { provider: 'deepseek' });
		assert.deepStrictEqual(cv.spokenChoice('passa a deep seek e pensa più a fondo'), { provider: 'deepseek', effort: 'profondo' });
		assert.deepStrictEqual(cv.spokenChoice('torna ad Agnes'), { provider: 'agnes' });
		assert.deepStrictEqual(cv.spokenChoice('rispondi veloce'), { effort: 'rapido' });
		assert.deepStrictEqual(cv.spokenChoice('usa Claude'), {});
		assert.deepStrictEqual(cv.spokenChoice('usa gemini'), {});
	});

	await test('stato: opzioni, DeepSeek senza credito (402) disabilitato, scelta ricordata', async () => {
		const f = fakeFetch();
		const c = new cv.Cervelli({ memento: memento(), fetch: f, secretsDir: secrets, appleAvailable: () => true });
		const st = await c.state();
		assert.strictEqual(st.current.provider, 'agnes');
		const ds = st.options.find(o => o.provider === 'deepseek');
		assert.strictEqual(ds.available, false);
		assert.strictEqual(ds.why, 'senza credito');
		assert.strictEqual(ds.label, 'DeepSeek V4.1 Flash');
		await c.set('apple');
		await c.setEffort('profondo');
		assert.deepStrictEqual(c.choice(), { provider: 'apple', model: 'apple-on-device', effort: 'profondo' });
		await assert.rejects(() => c.set('deepseek'), /senza credito/);
		c.endConversation();
		assert.deepStrictEqual(c.choice(), { provider: 'agnes', model: 'agnes-3.0-flash', effort: 'profondo' }, 'fine conversazione: Agnes, l\'impegno resta');
	});

	await test('Agnes sempre primaria: la scelta manuale non si salva, scade dopo 15 minuti senza domande, non sopravvive al riavvio', async () => {
		let now = 1_000_000;
		const m = memento();
		const c = new cv.Cervelli({ memento: m, fetch: fakeFetch({ dsStatus: 200 }), secretsDir: secrets, now: () => now });
		await c.set('deepseek');
		assert.strictEqual(c.choice().provider, 'deepseek');
		assert.strictEqual(c.choice().model, 'deepseek-flash');
		now += 10 * 60_000;
		c.touch();
		now += 10 * 60_000;
		assert.strictEqual(c.choice().provider, 'deepseek', 'una domanda allunga la scelta');
		now += 16 * 60_000;
		assert.strictEqual(c.choice().provider, 'agnes', 'dopo 15 minuti senza domande si torna ad Agnes');
		await c.set('deepseek');
		const dopo = new cv.Cervelli({ memento: m, fetch: fakeFetch({ dsStatus: 200 }), secretsDir: secrets, now: () => now });
		assert.strictEqual(dopo.choice().provider, 'agnes', 'al riavvio si riparte da Agnes');
	});

	await test('«sempre»: il predefinito si ricorda, la fine della conversazione torna li\', Agnes lo toglie, un cervello a terra ripiega su Agnes', async () => {
		const m = memento();
		let cambi = 0;
		let apple = false;
		const conCredito = { dsStatus: 200, dsBalance: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '5.00' }] } };
		const c = new cv.Cervelli({ memento: m, fetch: fakeFetch(conCredito), secretsDir: secrets, appleAvailable: () => apple, onChange: () => cambi++ });
		assert.strictEqual(c.defaultProvider(), 'agnes');
		await c.set('deepseek', undefined, true);
		assert.deepStrictEqual([c.choice().provider, c.temporary(), c.defaultProvider()], ['deepseek', false, 'deepseek']);
		assert.ok(cambi >= 1, 'chi mostra il cervello lo sa');
		const dopo = new cv.Cervelli({ memento: m, fetch: fakeFetch(conCredito), secretsDir: secrets });
		assert.strictEqual(dopo.choice().provider, 'deepseek', 'sopravvive al riavvio');
		await c.set('agnes');
		assert.deepStrictEqual([c.choice().provider, c.temporary()], ['agnes', true], 'Agnes per questa conversazione');
		let st = await c.state();
		assert.deepStrictEqual([st.current.provider, st.temporary, st.defaultProvider], ['agnes', true, 'deepseek']);
		c.endConversation();
		assert.strictEqual(c.choice().provider, 'deepseek', 'a fine conversazione si torna al predefinito');
		await c.set('deepseek');
		assert.strictEqual(c.temporary(), false, 'scegliere il predefinito non e\' una scelta a tempo');
		c.markDown('deepseek', 'senza credito');
		assert.strictEqual(c.choice().provider, 'agnes', 'predefinito a terra: Agnes');
		st = await c.state();
		assert.deepStrictEqual([st.current.provider, st.defaultProvider], ['agnes', 'deepseek']);
		await c.set('agnes', undefined, true);
		assert.strictEqual(c.defaultProvider(), 'agnes');
		assert.strictEqual(m.get('bottega.cervello.predefinito'), undefined, 'Agnes «sempre» toglie la chiave');
		// Apple come predefinito: solo quando il Nucleo lo dice disponibile
		await assert.rejects(() => c.set('apple', undefined, true), /non è disponibile/);
		apple = true;
		await c.set('apple', undefined, true);
		assert.strictEqual(c.choice().provider, 'apple');
		apple = false;
		assert.strictEqual(c.choice().provider, 'agnes', 'Nucleo spento: Agnes');
		const n = cambi;
		await c.setEffort('rapido');
		assert.strictEqual(cambi, n + 1, 'anche l\'impegno avvisa');
		await c.setEffort('rapido');
		assert.strictEqual(cambi, n + 1, 'niente avviso se non cambia niente');
	});

	await test('conti: Agnes senza saldo ma con richieste e 429, DeepSeek solo mentre si usa, ElevenLabs contato in locale', async () => {
		let now = Date.UTC(2026, 9, 2, 9);
		const usage = path.join(tmp, 'usage.json');
		fs.writeFileSync(usage, JSON.stringify({ elevenLabsCharsByMonth: { '2026-10': 801 } }));
		const c = new cv.Cervelli({ memento: memento(), fetch: fakeFetch({ dsStatus: 200, dsBalance: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '9.98' }] } }), secretsDir: secrets, usageFile: usage, now: () => now });
		c.noteAgnes(200);
		c.noteAgnes(200);
		assert.strictEqual(c.agnesOggi(), 2);
		let st = await c.state();
		const by = id => st.accounts.find(a => a.id === id);
		assert.strictEqual(by('agnes').text, 'gratis, nessun saldo da controllare; 2 richieste oggi dalla Bottega');
		assert.strictEqual(by('agnes').local, true);
		assert.strictEqual(by('deepseek'), undefined, 'con Agnes il saldo di DeepSeek non compare');
		assert.ok(by('elevenlabs').text.startsWith('801 caratteri di voce a ottobre, contati dalla Bottega'));
		await c.set('deepseek');
		st = await c.state();
		assert.strictEqual(by('deepseek').text, 'restano 9,98 $');
		c.endConversation();
		c.noteAgnes(429);
		now += 60_000;
		st = await c.state();
		assert.strictEqual(by('agnes').tone, 'attesa');
		assert.ok(by('agnes').text.startsWith('al limite di circa 20 richieste al minuto (un 429'));
		assert.ok(!st.accounts.some(a => /[—–]/.test(a.text)));
	});

	await test('Apple Intelligence: segue il dato del Nucleo in diretta e dice il motivo vero', async () => {
		let ok = false;
		let motivo = 'Il modello di Apple Intelligence non e\' ancora pronto.';
		const c = new cv.Cervelli({ memento: memento(), fetch: fakeFetch(), secretsDir: secrets, cacheFile: path.join(tmp, 'c-apple.json'), appleAvailable: () => ok, appleReason: () => motivo });
		let a = (await c.options()).find(o => o.provider === 'apple');
		assert.strictEqual(a.available, false);
		assert.strictEqual(a.why, motivo, 'il motivo del Nucleo, non una frase generica');
		ok = true;
		motivo = undefined;
		a = (await c.options()).find(o => o.provider === 'apple');
		assert.strictEqual(a.available, true, 'quando il Nucleo risponde, senza riavviare');
		assert.strictEqual(a.why, undefined);
	});

	await test('stream: testo e strumenti a pezzi, chiave dal vault, DeepSeek con modello e impegno', async () => {
		const calls = [];
		const pezzi = [{ content: 'Apro ' }, { tool_calls: [{ index: 0, id: 'c1', function: { name: 'progetto_apri', arguments: '{"prog' } }] }, { tool_calls: [{ index: 0, function: { arguments: 'etto":"Peak"}' } }] }];
		const c = new cv.Cervelli({
			memento: memento(),
			secretsDir: secrets,
			fetch: async (url, init = {}) => {
				calls.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
				return { ok: true, status: 200, body: sse(pezzi) };
			},
		});
		const got = [];
		await c.streamFor({ provider: 'deepseek', model: 'deepseek-flash', effort: 'profondo' })([{ role: 'user', content: 'apri peak' }], [], d => got.push(d), new AbortController().signal);
		assert.deepStrictEqual(got[0], { content: 'Apro ' });
		assert.strictEqual(got.filter(d => d.tool_call).map(d => d.tool_call.arguments).join(''), '{"progetto":"Peak"}');
		const call = calls.find(x => x.url.includes('api.deepseek.com/chat'));
		assert.strictEqual(call.headers.authorization, 'Bearer chiave-finta-ds');
		assert.strictEqual(call.body.model, 'deepseek-v4-pro');
		assert.strictEqual(call.body.reasoning_effort, 'high');
		assert.strictEqual(c.streamFor({ provider: 'apple', model: 'x', effort: 'normale' }), undefined, 'Apple passa dal Nucleo');
	});

	await test('402 durante una risposta: errore chiaro, cervello da parte per un\'ora, scelta tornata ad Agnes', async () => {
		let n = 0;
		// la prova di DeepSeek (options) passa, la risposta vera dice 402
		const f = fakeFetch({ dsStatus: 200 });
		const c = new cv.Cervelli({ memento: memento(), fetch: async (u, i) => (u.includes('api.deepseek.com/chat') && n++ > 0 ? { ok: false, status: 402, body: null } : f(u, i)), secretsDir: secrets });
		await c.set('deepseek');
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
