#!/usr/bin/env node
// Banco di prova della Bottega nativa, lato estensione: il router dei cervelli di Melissa, il turno con
// Apple Intelligence e gli strumenti (con un Nucleo FINTO che fa tool.call), le categorie del lavoro.
// Il Nucleo vero si prova a parte (nucleo --cli agent-prova, classify, embed-ctx).
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');
const esbuild = require('esbuild');

const OUT = path.join(__dirname, 'test-out');
esbuild.buildSync({
	entryPoints: ['cervello', 'osservatorio'].map(n => path.join(__dirname, '..', 'src', n + '.ts')),
	outdir: OUT, format: 'cjs', platform: 'node', bundle: false, target: 'node20', logLevel: 'silent',
});
const C = require(path.join(OUT, 'cervello.js'));
const O = require(path.join(OUT, 'osservatorio.js'));

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------- router ----------

test('auto: Agnes per tutto finche\' risponde, anche le domande brevi e le liste', () => {
	const r = new C.BrainRouter({ mode: () => 'auto', appleAvailable: () => true });
	for (const q of ['ciao', 'che ore sono?', 'annota: provare il widget', 'apri Peak']) assert.equal(r.choose(q).brain, 'agnes', q);
});

test('interruttore: 429 e rete aprono, il barge-in no; dopo 2 minuti si richiude', () => {
	let now = 1_000_000;
	const r = new C.BrainRouter({ mode: () => 'auto', appleAvailable: () => true, now: () => now });
	assert.equal(r.choose('dimmi lo stato dei lavori').brain, 'agnes');
	r.agnesFailed(Object.assign(new Error('aborted'), { name: 'AbortError' }));
	assert.equal(r.breakerOpen, false);
	r.agnesFailed(new Error('Agnes continua a rispondere 429.'));
	assert.deepEqual(r.choose('dimmi lo stato dei lavori'), { brain: 'apple', why: 'interruttore' });
	now += 121_000;
	assert.equal(r.choose('dimmi lo stato dei lavori').brain, 'agnes');
	r.agnesFailed(new Error('fetch failed'));
	assert.equal(r.breakerOpen, true);
	r.agnesOk();
	assert.equal(r.breakerOpen, false);
});

test('impostazione e Apple assente', () => {
	const mk = (mode, apple) => new C.BrainRouter({ mode: () => mode, appleAvailable: () => apple });
	assert.equal(mk('apple', true).choose('apri Peak').brain, 'apple');
	assert.equal(mk('apple', false).choose('ciao').brain, 'agnes');
	assert.equal(mk('agnes', true).choose('ciao').brain, 'agnes');
	assert.equal(mk('auto', false).choose('ciao').brain, 'agnes');
});

test('Melissa dice il cervello solo quando cambia', () => {
	const r = new C.BrainRouter({ mode: () => 'auto', appleAvailable: () => true });
	assert.equal(r.announce('agnes', 'principale'), null); // il primo non si dice
	assert.equal(r.announce('agnes', 'principale'), null);
	assert.match(r.announce('apple', 'interruttore'), /Agnes non risponde/);
	assert.equal(r.announce('apple', 'interruttore'), null);
	assert.match(r.announce('agnes', 'principale'), /tornata/);
	for (const s of [r.announce('apple', 'forzato'), 'Agnes e\' tornata.']) assert.ok(!/[–—]/.test(s));
});

test('strumenti per Apple: sottoinsieme ordinato, solo quelli che esistono', () => {
	const all = ['memoria_cerca', 'progetti_cerca', 'boh', 'lavori_elenco'].map(n => ({ type: 'function', function: { name: n, description: '', parameters: {} } }));
	assert.deepEqual(C.appleToolSpecs(all).map(t => t.function.name), ['progetti_cerca', 'lavori_elenco', 'memoria_cerca']);
});

// ---------- turno Apple con un Nucleo finto ----------

class FakeNucleo extends EventEmitter {
	constructor(script) {
		super();
		this.available = true;
		this.sent = [];
		this.script = script;
	}
	fireAndForget(cmd, args) {
		this.sent.push([cmd, args]);
		if (cmd === 'tool.result') this.emit('_result', args);
	}
	async request(cmd, args) {
		this.sent.push([cmd, args]);
		assert.equal(cmd, 'ai.agent');
		return this.script(this, args);
	}
}

test('tool.call -> exec -> tool.result, delta in streaming, eventi di altri turni ignorati', async () => {
	const nucleo = new FakeNucleo(async (n, args) => {
		assert.ok(args.req && args.tools.length === 1 && args.history.length <= 6);
		n.emit('ai.delta', { req: 'altro', text: 'NO' });
		const got = new Promise(res => n.once('_result', res));
		n.emit('tool.call', { req: args.req, call: 'c1', name: 'lavori_elenco', args: { filtro: 'aspetta' } });
		const r = await got;
		assert.equal(r.call, 'c1');
		n.emit('ai.delta', { req: args.req, text: 'Ti aspetta ' });
		n.emit('ai.delta', { req: args.req, text: 'Peak.' });
		return { text: 'Ti aspetta Peak.', toolCalls: [{ name: 'lavori_elenco', args: {} }], ms: 812 };
	});
	const calls = [];
	let spoken = '';
	const r = await C.runAppleTurn(nucleo, {
		instructions: 'x', prompt: 'chi mi aspetta?', history: Array(10).fill({ role: 'user', content: 'a' }),
		tools: [{ type: 'function', function: { name: 'lavori_elenco', description: 'd', parameters: {} } }],
		exec: async (name, json) => (calls.push([name, JSON.parse(json)]), 'Peak: ti aspetta'),
		onDelta: t => (spoken += t),
	});
	assert.deepEqual(calls, [['lavori_elenco', { filtro: 'aspetta' }]]);
	assert.equal(spoken, 'Ti aspetta Peak.');
	assert.equal(r.text, 'Ti aspetta Peak.');
	assert.equal(nucleo.listenerCount('tool.call'), 0, 'ascoltatori rimossi');
	const res = nucleo.sent.find(s => s[0] === 'tool.result')[1];
	assert.equal(res.result, 'Peak: ti aspetta');
});

test('uno strumento che esplode torna come testo, non rompe il turno', async () => {
	const nucleo = new FakeNucleo(async (n, args) => {
		const got = new Promise(res => n.once('_result', res));
		n.emit('tool.call', { req: args.req, call: 'c9', name: 'git_spingi', args: {} });
		return { text: (await got).result };
	});
	const r = await C.runAppleTurn(nucleo, { instructions: '', prompt: 'p', history: [], tools: [], exec: async () => { throw new Error('niente rete'); } });
	assert.match(r.text, /git_spingi ha dato errore: niente rete/);
});

test('barge-in: abort manda ai.cancel con lo stesso req', async () => {
	const ac = new AbortController();
	const nucleo = new FakeNucleo(async (n, args) => {
		ac.abort();
		const cancel = n.sent.find(s => s[0] === 'ai.cancel');
		assert.equal(cancel[1].req, args.req);
		return { text: 'mezza' };
	});
	await assert.rejects(C.runAppleTurn(nucleo, { instructions: '', prompt: 'p', history: [], tools: [], exec: async () => '', signal: ac.signal }), /aborted/);
});

test('istruzioni per il Mac: persona accorciata, niente lineette lunghe', () => {
	const s = C.appleInstructions('Sei Melissa. '.repeat(200), 'Adesso sono le 10.');
	assert.ok(s.length < 1600, `troppo lunghe: ${s.length}`);
	assert.ok(!/[–—]/.test(s));
});

// ---------- categorie ----------

test('categorie: minuti per finestra, sessioni ignote in altro, frase della settimana', () => {
	const now = Date.UTC(2026, 9, 2, 12);
	const h = 3_600_000, d = 86_400_000;
	const sessions = [
		{ sid: 'a', spans: [now - 2 * h, now - h] },            // 60 min, correzione
		{ sid: 'b', spans: [now - 3 * d, now - 3 * d + 0.5 * h] }, // 30 min, funzione
		{ sid: 'c', spans: [now - 20 * d, now - 20 * d + h] },   // 60 min, solo nei 30
		{ sid: 'x', spans: [now - h, now - 0.5 * h] },           // 30 min, senza categoria
	];
	const c = O.categorieMinuti(sessions, { a: 'correzione', b: 'funzione', c: 'rilascio', x: 'boh' }, now);
	assert.deepEqual(c['7'], { correzione: 60, funzione: 30, altro: 30 });
	assert.equal(c['30'].rilascio, 60);
	assert.equal(O.fraseCategorie(c), 'Questa settimana 67% correzioni.');
	assert.equal(O.fraseCategorie({ '7': { funzione: 10 } }), null);
});

test('Osservatorio: dati alla prima apertura, poi solo se cambiano', async () => {
	const n = new EventEmitter();
	n.available = true;
	n.sent = [];
	n.request = async (cmd, args) => (n.sent.push([cmd, args]), {});
	n.fireAndForget = (cmd, args) => n.sent.push([cmd, args]);
	let v = 1;
	const o = new O.Osservatorio(n, async () => ({ computedAt: Date.now(), today: { you: v } }));
	await o.show();
	assert.equal(n.sent[0][0], 'osservatorio.open');
	assert.equal(n.sent[0][1].data.today.you, 1);
	await o.push();
	assert.equal(n.sent.length, 1, 'niente di nuovo, niente invio');
	v = 2;
	await o.push();
	assert.equal(n.sent[1][0], 'osservatorio.data');
	n.emit('osservatorio.closed');
	v = 3;
	await o.push();
	assert.equal(n.sent.length, 2, 'finestra chiusa, niente invio');
});

test('Apple come provider OpenAI: passo con tool_call, ripresa con il messaggio tool, stessa sessione', async () => {
	const n = new EventEmitter();
	n.available = true;
	const sent = [];
	let agents = 0;
	n.fireAndForget = (cmd, args) => {
		sent.push([cmd, args]);
		if (cmd === 'tool.result') setImmediate(() => {
			n.emit('ai.delta', { req: n.req, text: 'Peak ti aspetta.' });
			n.resolve({ text: 'Peak ti aspetta.' });
		});
	};
	n.request = (cmd, args) => new Promise(res => {
		agents++;
		n.req = args.req;
		n.resolve = res;
		assert.equal(args.effort, 'rapido');
		assert.equal(args.messages[0].role, 'system');
		setImmediate(() => {
			n.emit('ai.delta', { req: args.req, text: 'Guardo. ' });
			n.emit('tool.call', { req: args.req, call: 'c1', id: 'c1', name: 'lavori_elenco', args: {} });
		});
	});
	const stream = C.appleOpenAiStream(n, { effort: () => 'rapido' });
	const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'chi mi aspetta?' }];
	const d1 = [];
	await stream(msgs, [], d => d1.push(d), new AbortController().signal);
	assert.deepEqual(d1[0], { content: 'Guardo. ' });
	assert.equal(d1[1].tool_call.name, 'lavori_elenco');
	assert.equal(d1[1].tool_call.id, 'c1');
	msgs.push({ role: 'assistant', content: 'Guardo. ', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lavori_elenco', arguments: '{}' } }] });
	msgs.push({ role: 'tool', tool_call_id: 'c1', name: 'lavori_elenco', content: 'Peak: ti aspetta' });
	const d2 = [];
	await stream(msgs, [], d => d2.push(d), new AbortController().signal);
	assert.equal(agents, 1, 'una sola sessione per il turno');
	assert.deepEqual(sent.find(s => s[0] === 'tool.result')[1], { call: 'c1', result: 'Peak: ti aspetta' });
	assert.deepEqual(d2, [{ content: 'Peak ti aspetta.' }]);
});

(async () => {
	for (const [name, fn] of tests) {
		try {
			await fn();
			passed++;
			console.log(`ok   ${name}`);
		} catch (e) {
			console.log(`FAIL ${name}\n     ${e?.stack ?? e}`);
			process.exitCode = 1;
		}
	}
	console.log(`\nnativo: ${passed}/${tests.length} superati`);
})();
