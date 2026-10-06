#!/usr/bin/env node
// Banco di prova della parte estensione della Bottega. NON spedito (vedi .vscodeignore).
// Finge il modulo "vscode", traspone i sorgenti con esbuild e li esercita:
// macchina a stati dei lavori + limite di parallelismo, quoting della shell, flusso di conferma,
// validazione argomenti dei tool, giro tool-call di Agnes con un LLM FINTO (delta in streaming,
// spezzettamento in frasi, interruzione barge-in), piu' UN solo collaudo reale contro Agnes.

const path = require('path');
const Module = require('module');
const assert = require('assert');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
// i personaggi si leggono dai file del repository, mai da ~/.bottega
process.env.BOTTEGA_PERSONAGGI = path.join(__dirname, '..', 'personaggi');
const OUT = path.join(__dirname, 'test-out');

esbuild.buildSync({
	entryPoints: ['jobs', 'assistant', 'cervello', 'nucleo', 'memoria', 'claude', 'scan', 'racconto', 'personaggi'].map(n => path.join(SRC, n + '.ts')),
	outdir: OUT,
	format: 'cjs',
	platform: 'node',
	bundle: false,
	target: 'node20',
	logLevel: 'silent',
});

// ---------- finto modulo vscode ----------

let pidSeq = 1000;
const createdTerminals = [];

function makeTerminal(opts) {
	const term = {
		name: opts.name,
		_pid: pidSeq++,
		show() {},
		sendText(t) {
			this.lastSent = t;
		},
		dispose() {
			this.disposed = true;
		},
	};
	term.processId = Promise.resolve(term._pid);
	createdTerminals.push(term);
	return term;
}

const configStore = {}; // override di impostazioni per i test
const vscodeMock = {
	window: {
		createOutputChannel: () => ({ info() {}, warn() {}, error() {}, appendLine() {}, dispose() {} }),
		terminals: createdTerminals,
		createTerminal: opts => makeTerminal(opts),
		createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} }),
		showWarningMessage: async () => 'Ferma',
		showInputBox: async () => undefined,
		showInformationMessage() {},
		showErrorMessage() {},
		showTextDocument() {},
		activeTextEditor: undefined,
		onDidCloseTerminal() {
			return { dispose() {} };
		},
	},
	workspace: {
		getConfiguration: () => ({
			get: (k, def) => (k in configStore ? configStore[k] : def),
			update: async () => {},
		}),
		onDidChangeConfiguration: () => ({ dispose() {} }),
	},
	ThemeIcon: class {
		constructor(id) {
			this.id = id;
		}
	},
	ThemeColor: class {
		constructor(id) {
			this.id = id;
		}
	},
	TerminalLocation: { Panel: 1, Editor: 2 },
	StatusBarAlignment: { Left: 1, Right: 2 },
	ConfigurationTarget: { Global: 1 },
	Uri: { file: p => ({ fsPath: p, path: p }) },
	EventEmitter: class {
		constructor() {
			this._h = [];
			this.event = h => {
				this._h.push(h);
				return { dispose() {} };
			};
		}
		fire(x) {
			this._h.forEach(h => h(x));
		}
		dispose() {}
	},
};

const origLoad = Module._load;
Module._load = function (request) {
	if (request === 'vscode') return vscodeMock;
	return origLoad.apply(this, arguments);
};

const jobs = require(path.join(OUT, 'jobs.js'));
const asst = require(path.join(OUT, 'assistant.js'));

// ---------- mini runner ----------

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log('  ok  ' + name);
	} catch (e) {
		failed++;
		failures.push(name);
		console.log('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e));
	}
}
const tick = () => new Promise(r => setImmediate(r));

// ---------- aiuti ----------

function makeNucleo(available = true) {
	const handlers = {};
	return {
		available,
		speaks: [],
		reqs: [],
		on(ev, h) {
			(handlers[ev] = handlers[ev] || []).push(h);
		},
		fire(ev, arg) {
			(handlers[ev] || []).forEach(h => h(arg));
		},
		fireAndForget(cmd, args) {
			if (cmd === 'voice.speak') this.speaks.push(args);
			this.reqs.push({ cmd, args });
		},
		request(cmd, args) {
			if (cmd === 'voice.speak') this.speaks.push(args);
			this.reqs.push({ cmd, args });
			if (cmd === 'ai.generate') return Promise.resolve({ text: 'risposta dal cervello di riserva' });
			return Promise.resolve({});
		},
	};
}

function scriptedStream(steps) {
	let i = 0;
	return async (messages, tools, onDelta, signal) => {
		const step = steps[i++];
		if (typeof step === 'function') return step(onDelta, signal);
		for (const d of step || []) onDelta(d);
	};
}

function makeAssistant(over = {}) {
	const nucleo = over.nucleo || makeNucleo(true);
	// Di default il Mac non ha Apple Intelligence: i test di prima parlano solo con Agnes finta.
	if (!('capabilities' in nucleo)) nucleo.capabilities = { foundationModels: !!over.apple };
	const rec = { gitPush: [], stopJob: [], searchProjects: [], startJob: [], writeToJob: [] };
	const actions = Object.assign(
		{
			searchProjects: t => {
				rec.searchProjects.push(t);
				return [{ name: 'Peak', path: '/p/Peak' }];
			},
			resolveProject: n => ({ name: 'Peak', path: '/p/Peak' }),
			openProject: () => {},
			projectStatus: () => 'ramo main. albero pulito.',
			liveSessions: () => [],
			startJob: (p, task) => {
				rec.startJob.push({ p, task });
				return { id: 'job-1', project: 'Peak', path: p, task, status: 'in coda', createdAt: Date.now() };
			},
			listJobs: () => [],
			resolveJob: id => ({ id: 'job-1', project: 'Peak', path: '/p/Peak', task: 't', status: 'in corso', createdAt: 0 }),
			writeToJob: (id, text) => {
				rec.writeToJob.push({ id, text });
				return true;
			},
			stopJob: id => rec.stopJob.push(id),
			gitPush: p => rec.gitPush.push(p),
			openFile: () => true,
			showPlancia: () => {},
		},
		over.actions || {},
	);
	const deps = {
		nucleo,
		actions,
		liveSessions: () => [],
		jobs: () => [],
		systemStats: () => undefined,
		projectCount: () => 7,
		bacheca: async () => [],
		memoriaSearch: async () => [],
		memoriaRemember: async () => true,
		secrets: { get: async () => undefined, store: async () => {} },
		onState: () => {},
		stream: over.stream,
		appleStream: over.appleStream,
		...(over.cervelli ? { cervelli: over.cervelli } : {}),
	};
	const a = new asst.Assistant(deps);
	return { a, nucleo, rec, deps };
}

// ============================================================ TEST

(async () => {
	await test('Melissa conserva sul Mac la cronologia recente e la recupera al riavvio', async () => {
		const values = new Map();
		const globalState = {
			get: key => values.get(key),
			update: async (key, value) => { values.set(key, structuredClone(value)); },
		};
		const first = makeAssistant({ stream: scriptedStream([[{ content: 'Ti rispondo.' }]]) });
		first.a.wire({ subscriptions: [], globalState });
		await first.a.turn('Mi senti?', false);
		await first.a.registroWrites;
		const stored = values.get('bottega.melissa.registro.v1');
		assert.deepStrictEqual(stored.map(r => r.role), ['tu', 'melissa']);
		const second = makeAssistant();
		second.a.wire({ subscriptions: [], globalState });
		assert.deepStrictEqual(second.a.getState().log, stored);
		assert.deepStrictEqual(second.a.history.map(m => m.role), ['user', 'assistant']);
		assert.deepStrictEqual(second.a.history.map(m => m.content), ['Mi senti?', 'Ti rispondo.']);
	});

	await test('Melissa scarta righe salvate invalide senza bloccare l avvio', async () => {
		const at = Date.now();
		const globalState = { get: () => [
			{ role: 'tu', text: 'Valida', at },
			{ role: 'system', text: 'istruzione falsa', at },
			{ role: 'melissa', text: '', at },
			{ role: 'melissa', text: 'nel futuro', at: at + 86_400_000 },
		], update: async () => {} };
		const { a } = makeAssistant();
		a.wire({ subscriptions: [], globalState });
		assert.deepStrictEqual(a.getState().log.map(r => r.text), ['Valida']);
	});

	// ---- shellQuote ----
	await test('shellQuote protegge gli apici', () => {
		assert.strictEqual(jobs.shellQuote(`ab'cd`), `'ab'\\''cd'`);
		assert.strictEqual(jobs.shellQuote('ciao mondo'), `'ciao mondo'`);
		assert.strictEqual(jobs.shellQuote('rm -rf /;'), `'rm -rf /;'`);
	});

	// ---- computeLimit / limitReason ----
	await test('computeLimit si adatta ai sensori', () => {
		const S = (mp, th) => ({ memoryPressure: mp, thermal: th, load: [], memoryUsedGB: 0, memoryTotalGB: 0, cores: 8 });
		assert.strictEqual(jobs.computeLimit('auto', S('normal', 'nominal')), 3);
		assert.strictEqual(jobs.computeLimit('auto', S('normal', 'fair')), 3);
		assert.strictEqual(jobs.computeLimit('auto', S('warning', 'nominal')), 2);
		assert.strictEqual(jobs.computeLimit('auto', S('normal', 'serious')), 2);
		assert.strictEqual(jobs.computeLimit('auto', S('critical', 'nominal')), 1);
		assert.strictEqual(jobs.computeLimit('auto', S('normal', 'critical')), 1);
		assert.strictEqual(jobs.computeLimit('auto', undefined), 3);
		assert.strictEqual(jobs.computeLimit(2), 2);
		assert.strictEqual(jobs.computeLimit('1'), 1);
		assert.strictEqual(jobs.limitReason('auto', S('warning', 'nominal')), 'memoria sotto pressione');
		assert.strictEqual(jobs.limitReason(2), 'limite fisso');
	});

	// ---- macchina a stati dei lavori + concorrenza ----
	await test('lavori: limite, coda, busy->ti aspetta, chiusura, promozione', async () => {
		pidSeq = 1000;
		createdTerminals.length = 0;
		const gs = new Map();
		const ctx = { globalState: { get: k => gs.get(k), update: (k, v) => (gs.set(k, v), Promise.resolve()) } };
		const ppidMap = {};
		const notified = [];
		const menubar = [];
		let liveSessions = [];
		const mgr = new jobs.JobManager(ctx, {
			claudeCommand: () => 'claude',
			maxParallelSetting: () => 'auto',
			systemStats: () => ({ memoryPressure: 'normal', thermal: 'nominal', load: [], memoryUsedGB: 0, memoryTotalGB: 0, cores: 8 }),
			liveSessions: () => liveSessions,
			notify: a => notified.push(a),
			updateMenubar: c => menubar.push(c),
			ppidOf: async pid => ppidMap[pid],
			onChange: () => {},
		});

		const j1 = mgr.start('/p/Peak', 'compito uno');
		const j2 = mgr.start('/p/Woofmap', 'compito due');
		const j3 = mgr.start('/p/Talky', 'compito tre');
		const j4 = mgr.start('/p/Fontanelle', 'compito quattro');

		let list = mgr.list();
		assert.strictEqual(list.filter(j => j.status === 'in corso').length, 3, 'tre in corso');
		assert.strictEqual(list.filter(j => j.status === 'in coda').length, 1, 'uno in coda');

		await tick();
		await tick();

		// Le tre shell create hanno pid 1000..1002 (ordine di creazione).
		const shells = createdTerminals.map(t => t._pid);
		// Associo una sessione busy a ciascun lavoro avviato, come figlia della sua shell.
		liveSessions = shells.slice(0, 3).map((shell, i) => {
			const sessPid = 5000 + i;
			ppidMap[sessPid] = shell;
			return { pid: sessPid, sessionId: 'sess-' + i, cwd: '/x', name: 'claude', status: 'busy', startedAt: Date.now(), statusSince: Date.now() };
		});
		await mgr.reconcile();
		list = mgr.list();
		assert.strictEqual(list.filter(j => j.sessionId).length, 3, 'tre associate a una sessione');
		assert.ok(list.filter(j => j.status === 'in corso').length === 3);

		// Ora quelle sessioni diventano idle: i lavori passano a "ti aspetta" e scatta la notifica.
		liveSessions = liveSessions.map(s => ({ ...s, status: 'idle' }));
		await mgr.reconcile();
		list = mgr.list();
		assert.strictEqual(list.filter(j => j.status === 'ti aspetta').length, 3, 'tre ti aspetta');
		assert.strictEqual(notified.length, 3, 'tre notifiche');
		assert.ok(notified[0].actions[0].title === 'Apri');

		// Chiudo il terminale del primo lavoro: diventa finito e la coda promuove il quarto.
		const firstTerm = createdTerminals[0];
		mgr.onTerminalClosed(firstTerm);
		list = mgr.list();
		const closed = list.find(j => j.id === j1.id);
		assert.strictEqual(closed.status, 'finito', 'primo finito');
		const fourth = list.find(j => j.id === j4.id);
		assert.ok(fourth.status === 'in corso', 'quarto promosso');
		// Mai oltre il limite: in corso + ti aspetta <= 3.
		assert.ok(list.filter(j => j.status === 'in corso' || j.status === 'ti aspetta').length <= 3);

		// Fermo un lavoro.
		mgr.stop(j2.id);
		assert.strictEqual(mgr.list().find(j => j.id === j2.id).status, 'fermato');
	});

	// ---- validazione argomenti tool ----
	await test('validateArgs controlla campi e tipi', () => {
		const spec = asst.TOOLS.progetti_cerca.spec;
		assert.strictEqual(asst.validateArgs(spec, { testo: 'peak' }), null);
		assert.ok(asst.validateArgs(spec, {}).includes('testo'));
		assert.ok(asst.validateArgs(spec, { testo: 123 }).includes('testo'));
		const sp2 = asst.TOOLS.lavoro_nuovo.spec;
		assert.ok(asst.validateArgs(sp2, { progetto: 'Peak' }).includes('compito'));
		assert.strictEqual(asst.validateArgs(sp2, { progetto: 'Peak', compito: 'fai' }), null);
		const sp3 = asst.TOOLS.progetto_apri.spec;
		assert.ok(asst.validateArgs(sp3, { progetto: 'Peak', nuovaFinestra: 'si' }).includes('nuovaFinestra'));
		assert.strictEqual(asst.validateArgs(sp3, { progetto: 'Peak', nuovaFinestra: true }), null);
	});

	// ---- ClauseChunker ----
	await test('ClauseChunker spezza in frasi complete', () => {
		const c = new asst.ClauseChunker();
		assert.deepStrictEqual(c.push('Uno. Due'), ['Uno.']);
		assert.deepStrictEqual(c.push('!'), ['Due!']);
		assert.strictEqual(c.flush(), null);
		const d = new asst.ClauseChunker();
		assert.deepStrictEqual(d.push('senza fine'), []);
		assert.strictEqual(d.flush(), 'senza fine');
	});

	// ---- giro tool-call con LLM finto in streaming ----
	await test('runAgent riassembla un tool-call spezzettato e chiude con testo', async () => {
		const stream = scriptedStream([
			[
				{ tool_call: { index: 0, id: 'c1', name: 'progetti_cerca' } },
				{ tool_call: { index: 0, arguments: '{"te' } },
				{ tool_call: { index: 0, arguments: 'sto":"peak"}' } },
			],
			[{ content: 'Ho trovato Peak.' }],
		]);
		const { a, rec } = makeAssistant({ stream });
		const ac = new AbortController();
		const out = await a.runAgent('cerca peak', false, ac.signal);
		assert.deepStrictEqual(rec.searchProjects, ['peak'], 'tool chiamato con gli argomenti riassemblati');
		assert.ok(out.includes('Peak'));
	});

	// ---- il codice davanti ad Andrea (src/occhio.ts) e il racconto mentre lavora (src/racconto.ts) ----
	await test('codice: «spiegami questo» legge il file con codice_leggi; la riga e la regola nel prompt solo con un file aperto', async () => {
		let letto = 0;
		const codice = { riga: () => 'Davanti ad Andrea nell\'editor: avo_bnb/db.py, python, 420 righe.', leggi: nome => (letto++, `File: avo_bnb/db.py\n1| import os${nome ? ' ' + nome : ''}`) };
		let prompts = [];
		const stream = async (messages, tools, onDelta) => {
			prompts.push(messages[0].content);
			if (prompts.length === 1) return onDelta({ tool_call: { index: 0, id: 'c1', name: 'codice_leggi', arguments: '{}' } });
			const toolMsg = messages.find(m => m.role === 'tool');
			onDelta({ content: toolMsg && /import os/.test(toolMsg.content) ? 'Importa os, e basta.' : 'non ho letto niente' });
		};
		const { a } = makeAssistant({ stream, actions: { codice } });
		const out = await a.runAgent('spiegami questo', false, new AbortController().signal);
		assert.strictEqual(letto, 1);
		assert.strictEqual(out, 'Importa os, e basta.');
		assert.match(prompts[0], /Davanti ad Andrea nell'editor: avo_bnb\/db\.py/);
		assert.match(prompts[0], /Sul codice: prima leggi con codice_leggi/);
		assert.ok(a.specs.some(t => t.function.name === 'codice_leggi'));
		assert.ok(!a.specs.some(t => t.function.name === 'editor_contesto'), 'lo strumento vecchio non c\'e\' piu\'');
		// senza file aperto: niente riga e niente regola, il prompt resta leggero
		const vuoto = makeAssistant({ stream: scriptedStream([[{ content: 'ok' }]]), actions: { codice: { riga: () => undefined, leggi: () => '' } } });
		assert.ok(!/Sul codice/.test(vuoto.a.systemPrompt()));
	});

	await test('terminale: ogni passo vero va in attivita, anche senza racconto; la voce non lo dice', async () => {
		const stream = scriptedStream([[{ tool_call: { index: 0, id: 'c1', name: 'progetti_cerca', arguments: '{"testo":"peak"}' } }], [{ content: 'Ho trovato Peak.' }]]);
		const t = makeAssistant({ stream });
		await t.a.turn('cerca peak', true);
		const passi = t.a.getState().attivita.map(p => `${p.stato} ${p.testo}`);
		assert.deepStrictEqual(passi, ['nota › cerca peak', 'corre Agnes pensa', 'corre Cerco i progetti su «peak».', 'fatto Trovato: Peak.', 'voce Ho trovato Peak.', 'fatto risposta pronta, la voce finisce di parlare']);
		assert.deepStrictEqual(t.nucleo.speaks.filter(s => s.append).map(s => s.text.trimEnd()), ['Ho trovato Peak.'], 'fuori dal racconto i passi non si dicono');
		assert.strictEqual(t.a.getState().raccontando, false);
	});

	await test('racconta una stanza: DeepSeek, dati attaccati alla domanda ma non alla storia, passi e risposta a voce', async () => {
		let visto;
		const ds = async (messages, tools, onDelta) => {
			visto = messages[messages.length - 1].content;
			onDelta({ content: 'Il mese va bene: 402 euro. ' });
			onDelta({ content: 'Sistema QR Scanner.' });
		};
		const cv = Object.assign(fakeCervelli({ provider: 'agnes', model: 'agnes-3.0-flash', effort: 'normale' }, { stream: ds }), { key: p => (p === 'deepseek' ? 'k' : undefined) });
		const t = makeAssistant({ stream: scriptedStream([[{ content: 'Agnes non doveva rispondere.' }]]) });
		t.a.deps.cervelli = cv;
		t.a.wire({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } });
		t.a.state.enabled = false; // a voce spenta parla lo stesso
		const out = await t.a.racconta({ tipo: 'stanza', titolo: 'la stanza App Store', testo: 'Ultimi 30 giorni: 402 € in tutto.' });
		assert.match(out, /402 euro/);
		assert.match(visto, /^Raccontami la stanza App Store\.\n\nI dati veri di la stanza App Store/);
		assert.match(visto, /Ultimi 30 giorni: 402 € in tutto\./);
		assert.ok(!t.a.history.some(m => /402 €/.test(String(m.content))), 'i dati non restano nella storia');
		assert.deepStrictEqual(t.nucleo.speaks.filter(s => s.append).map(s => s.text.trimEnd()), ['Il mese va bene: 402 euro.', 'Sistema QR Scanner.']);
		const passi = t.a.getState().attivita.map(p => p.testo);
		assert.ok(passi.includes('leggo la stanza App Store'));
		assert.ok(passi.includes('DeepSeek V4.1 Flash analizza'), passi.join(' | '));
		assert.strictEqual(t.a.getState().raccontando, true, 'il pulsante resta «ferma» mentre la voce riproduce');
		t.nucleo.fire('voice.state', { state: 'speaking' });
		assert.strictEqual(t.a.getState().raccontando, true);
		t.nucleo.fire('voice.state', { state: 'idle' });
		assert.strictEqual(t.a.getState().raccontando, false, 'dopo l audio il pulsante torna «racconta»');
	});

	await test('racconta il codice: ragiona anche se parla; niente davanti lo dice; ferma zittisce e interrompe', async () => {
		let parlato;
		let fermo;
		const ds = (messages, tools, onDelta, signal) => {
			parlato = t.a.spokenTurn;
			onDelta({ content: 'Questo file crea il database. ' });
			return new Promise((ok, ko) => {
				fermo = () => ko(Object.assign(new Error('interrotto'), { name: 'AbortError' }));
				signal.addEventListener('abort', () => fermo());
			});
		};
		const cv = Object.assign(fakeCervelli({ provider: 'agnes', model: 'agnes-3.0-flash', effort: 'normale' }, { stream: ds }), { key: () => 'k' });
		const t = makeAssistant({ stream: scriptedStream([]) });
		t.a.deps.cervelli = cv;
		const corsa = t.a.racconta({ tipo: 'codice', titolo: 'db.py', testo: 'File: db.py (python, 2 righe).\n\nIl file intero:\n1| a\n2| b' });
		await new Promise(r => setTimeout(r, 20));
		assert.strictEqual(parlato, false, 'ragiona: non e\' il turno rapido della voce');
		assert.strictEqual(t.a.getState().raccontando, true, 'durante il racconto il pulsante e\' «ferma»');
		t.a.fermaRacconto();
		await corsa;
		assert.ok(t.nucleo.reqs.some(c => c.cmd === 'voice.stopSpeaking'), 'la voce si zittisce');
		assert.strictEqual(t.a.getState().raccontando, false);
		assert.ok(t.a.getState().attivita.some(p => p.testo === 'fermata' && p.stato === 'errore'));
		await t.a.racconta(undefined);
		assert.ok(t.a.getState().attivita.some(p => /niente da raccontare/.test(p.testo)));
	});

	await test('racconta il codice fino alla terza frase e chiude la voce dopo tutto il testo', async () => {
		let domanda;
		const ds = async (messages, _tools, onDelta) => {
			domanda = messages[messages.length - 1].content;
			for (const content of ['Il file prepara i dati. ', 'Poi apre la connessione e controlla gli errori. ', 'Alla fine salva il risultato e libera le risorse.']) onDelta({ content });
		};
		const cv = Object.assign(fakeCervelli({ provider: 'agnes', model: 'agnes-3.0-flash', effort: 'normale' }, { stream: ds }), { key: () => 'k' });
		const t = makeAssistant({ stream: scriptedStream([]) });
		t.a.deps.cervelli = cv;
		t.a.wire({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } });
		await t.a.racconta({ tipo: 'codice', titolo: 'db.py', testo: 'def salva(): pass' });
		assert.match(domanda, /Racconta il file fino in fondo/);
		assert.deepStrictEqual(t.nucleo.speaks.filter(s => s.append).map(s => s.text.trimEnd()), [
			'Il file prepara i dati.',
			'Poi apre la connessione e controlla gli errori.',
			'Alla fine salva il risultato e libera le risorse.',
		]);
		assert.strictEqual(t.nucleo.speaks.at(-1).final, true);
		assert.strictEqual(t.a.getState().raccontando, true, 'la fine del testo non chiude la riproduzione');
		t.nucleo.fire('voice.state', { state: 'idle' });
		assert.strictEqual(t.a.getState().raccontando, false);
	});

	// ---- streaming dei delta + TTS frase per frase ----
	await test('turn parla frase per frase e chiude con final', async () => {
		const stream = scriptedStream([[{ content: 'Ciao fra. ' }, { content: 'Ho guardato i progetti' }, { content: ', sono tre' }, { content: '.' }]]);
		const { a, nucleo } = makeAssistant({ stream });
		await a.turn('come va', true);
		const clauses = nucleo.speaks.filter(s => s.append).map(s => s.text.trimEnd());
		assert.deepStrictEqual(clauses, ['Ciao fra.', 'Ho guardato i progetti, sono tre.']);
		assert.ok(nucleo.speaks.filter(s => s.append).every(s => s.text.endsWith(' ')), 'ogni frase mantiene il separatore richiesto dal Nucleo');
		assert.ok(nucleo.speaks.some(s => s.final === true), 'manda il final');
		assert.ok(nucleo.speaks[0].model === 'eleven_v4_turbo', 'il primo chunk porta il modello');
	});

	await test('dall\'iPhone a voce: frasi al ponte, Mac zitto, Agnes senza ragionare, fine una volta', async () => {
		const stream = scriptedStream([[{ content: 'Ciao fra. ' }, { content: 'Ho guardato i progetti' }, { content: ', sono tre.' }]]);
		const { a, nucleo } = makeAssistant({ stream });
		const frasi = [];
		let fini = 0;
		const r = await a.askRemoteVoice('come va', { frase: t => frasi.push(t), fine: () => fini++ });
		assert.deepStrictEqual(frasi, ['Ciao fra.', 'Ho guardato i progetti, sono tre.']);
		assert.strictEqual(fini, 1);
		assert.strictEqual(nucleo.speaks.length, 0, 'niente voce dal Mac');
		assert.ok(!nucleo.reqs.some(q => q.cmd === 'voice.listen' || (q.cmd === 'orb.state' && q.args.state === 'thinking')), 'il Mac non ascolta e la sfera non si muove');
		assert.ok(r.includes('sono tre'));
		assert.strictEqual(a.getState().state, 'idle');
		assert.strictEqual(a.spokenTurn, true, 'turno a voce: Agnes con reasoning_effort none');
		// il turno dopo, dal Mac, torna agli altoparlanti
		a.deps.stream = scriptedStream([[{ content: 'Sul Mac.' }]]);
		await a.turn('e adesso', true);
		assert.deepStrictEqual(nucleo.speaks.filter(x => x.append).map(x => x.text.trimEnd()), ['Sul Mac.']);
	});

	await test('mentre risponde all\'iPhone il Mac non apre turni suoi e chiudere la conversazione non tronca l\'iPhone', async () => {
		let libera;
		const { a, nucleo } = makeAssistant({ stream: async (_m, _t, onDelta) => { await new Promise(r => (libera = r)); onDelta({ content: 'Per l\'iPhone.' }); } });
		const frasi = [];
		const turno = a.askRemoteVoice('dimmi', { frase: t => frasi.push(t), fine: () => {} });
		await new Promise(r => setImmediate(r));
		assert.ok(a.busy(), 'occupata durante il turno remoto');
		assert.match(await a.ask('dal Mac'), /iPhone/, 'la barra non apre un secondo turno');
		a.state.conversing = true;
		a.stopConversation('prova');
		libera();
		const r = await turno;
		assert.ok(r.includes('Per l\'iPhone'), 'il turno dell\'iPhone arriva intero');
		assert.deepStrictEqual(frasi, ['Per l\'iPhone.']);
		assert.ok(!a.busy());
		assert.strictEqual(nucleo.speaks.length, 0);
	});

	await test('conferme numerate: la domanda ha un numero, che sparisce quando e\' chiusa', async () => {
		const { a } = makeAssistant({ stream: scriptedStream([]) });
		a.setPending({ describe: 'fare git push su X', run: () => {}, done: 'Fatto.', azione: 'push' });
		const q = a.pendingQuestion();
		assert.deepStrictEqual(q, { id: 1, testo: 'Posso fare git push su X?' });
		assert.strictEqual(a.pendingConfirmation(), 1);
		await a.askRemote('no');
		assert.strictEqual(a.pendingConfirmation(), undefined);
		a.setPending({ describe: 'fermare Y', run: () => {}, done: 'Fatto.', azione: 'stop' });
		assert.strictEqual(a.pendingConfirmation(), 2, 'la domanda dopo ha un numero nuovo');
	});

	// ---- barge-in: interruzione dello stream ----
	await test('a conversazione chiusa una frase in ritardo non diventa una domanda', async () => {
		let calls = 0;
		const stream = scriptedStream([() => { calls++; return Promise.resolve(); }]);
		const { a, nucleo } = makeAssistant({ stream });
		const ctx = { subscriptions: { push() {} }, secrets: { get: async () => undefined, store: async () => {} } };
		a.wire(ctx);
		nucleo.fire('voice.final', { text: 'apri peak', mode: 'converse' });
		nucleo.fire('voice.final', { text: 'apri peak', mode: 'push' });
		await tick();
		assert.strictEqual(calls, 0, 'nessun turno senza ascolto aperto');
		assert.strictEqual(a.getState().log.length, 0);
	});

	await test('chiudere la conversazione ferma la risposta in corso e la voce', async () => {
		const stream = scriptedStream([
			(onDelta, signal) =>
				new Promise((resolve, reject) => {
					onDelta({ content: 'Sto guardando.' });
					signal.addEventListener('abort', () => { const e = new Error('x'); e.name = 'AbortError'; reject(e); }, { once: true });
				}),
		]);
		const { a, nucleo } = makeAssistant({ stream });
		const ctx = { subscriptions: { push() {} }, secrets: { get: async () => undefined, store: async () => {} } };
		a.wire(ctx);
		nucleo.fire('hotkey.down'); nucleo.fire('hotkey.up'); // tocco: conversazione accesa
		assert.strictEqual(a.getState().conversing, true);
		nucleo.fire('voice.final', { text: 'dimmi lo stato', mode: 'converse' });
		await tick();
		nucleo.fire('hotkey.down'); nucleo.fire('hotkey.up'); // tocco: conversazione spenta
		await tick();
		const cmds = nucleo.reqs.map(r => r.cmd);
		assert.ok(cmds.includes('voice.stopSpeaking'), 'voce fermata');
		assert.ok(cmds.includes('voice.converse.stop'), 'ascolto chiuso');
		assert.strictEqual(a.getState().conversing, false);
	});

	await test('barge-in interrompe lo stream senza mandare il final', async () => {
		const stream = scriptedStream([
			(onDelta, signal) =>
				new Promise((resolve, reject) => {
					onDelta({ content: 'Sto guardando i progetti.' });
					signal.addEventListener('abort', () => {
						const e = new Error('interrotto');
						e.name = 'AbortError';
						reject(e);
					}, { once: true });
				}),
		]);
		const { a, nucleo } = makeAssistant({ stream });
		const ctx = { subscriptions: { push() {} }, secrets: { get: async () => undefined, store: async () => {} } };
		a.wire(ctx);
		const p = a.turn('dimmi lo stato', true);
		await tick();
		nucleo.fire('voice.bargein');
		const out = await p;
		assert.ok(out.includes('Sto guardando'), 'torna la risposta parziale');
		assert.ok(!nucleo.speaks.some(s => s.final === true), 'nessun final dopo il barge-in');
		assert.ok(nucleo.speaks.some(s => s.append && s.text.includes('Sto guardando')), 'ha parlato il pezzo prima dell\'interruzione');
	});

	// ---- flusso di conferma per un'azione a rischio ----
	await test('git_spingi chiede conferma e parte solo dopo un si', async () => {
		const makeStream = () => scriptedStream([[{ tool_call: { index: 0, id: 'g1', name: 'git_spingi' } }, { tool_call: { index: 0, arguments: '{"progetto":"Peak"}' } }], [{ content: 'Vuoi che spinga Peak? Confermi?' }]]);
		// Caso si'.
		{
			const { a, rec } = makeAssistant({ stream: makeStream() });
			await a.turn('spingi peak', false);
			assert.deepStrictEqual(rec.gitPush, [], 'non spinge prima della conferma');
			await a.turn('si dai', false);
			assert.deepStrictEqual(rec.gitPush, ['/p/Peak'], 'spinge dopo il si');
		}
		// Caso no.
		{
			const { a, rec } = makeAssistant({ stream: makeStream() });
			await a.turn('spingi peak', false);
			const out = await a.turn('no lascia stare', false);
			assert.deepStrictEqual(rec.gitPush, [], 'non spinge dopo il no');
			assert.ok(out.toLowerCase().includes('lasciato'));
		}
	});

	await test('la richiesta di conferma ascolta solo dopo che Melissa ha finito di parlare', async () => {
		const stream = scriptedStream([[{ tool_call: { index: 0, id: 'g1', name: 'git_spingi', arguments: '{"progetto":"Peak"}' } }], [{ content: 'Vuoi che spinga Peak? Confermi?' }]]);
		const t = makeAssistant({ stream });
		t.a.wire({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } });
		await t.a.turn('spingi peak', true);
		assert.ok(!t.nucleo.reqs.some(r => r.cmd === 'voice.listen'), 'aprire il microfono qui troncherebbe la voce');
		t.nucleo.fire('voice.state', { state: 'speaking' });
		t.nucleo.fire('voice.state', { state: 'idle' });
		assert.ok(t.nucleo.reqs.some(r => r.cmd === 'voice.listen' && r.args.mode === 'utterance'));
	});

	// ---- ripiego su Apple Intelligence quando lo stream Agnes fallisce ----
	await test('se Agnes cade risponde col Nucleo e lo dice', async () => {
		const stream = async () => {
			throw new Error('Agnes ha risposto 500.');
		};
		const { a } = makeAssistant({ stream });
		const out = await a.turn('ciao', false);
		assert.ok(out.includes('cervello di riserva'));
		assert.strictEqual(a.getState().brain, 'apple');
	});


	// ---- i due cervelli: Agnes per tutto, Apple per le cose semplici e quando Agnes cade ----
	await test('auto: tutto ad Agnes finche\' risponde, anche le liste', async () => {
		const brains = [];
		const { a } = makeAssistant({
			apple: true,
			stream: async (m, t, onDelta) => (brains.push('agnes'), onDelta({ content: 'Agnes.' })),
			appleStream: async (m, t, onDelta) => (brains.push('apple'), onDelta({ content: 'Mac.' })),
		});
		await a.turn('annota: provare il widget', false);
		await a.turn('ciao', false);
		assert.deepStrictEqual(brains, ['agnes', 'agnes']);
		assert.strictEqual(a.getState().brain, 'agnes');
	});

	await test('Agnes da 429: lo stesso turno passa al Mac con gli strumenti, lo dice una volta', async () => {
		const toolsSeen = [];
		const steps = scriptedStream([
			[{ tool_call: { index: 0, id: 'c1', name: 'progetto_stato', arguments: '{"progetto":"Peak"}' } }],
			[{ content: 'Peak e\' pulito.' }],
		]);
		const { a } = makeAssistant({
			apple: true,
			stream: async () => { throw new Error('Agnes ha risposto 429.'); },
			appleStream: (m, t, onDelta, sig) => (toolsSeen.push(t.length), steps(m, t, onDelta, sig)),
		});
		const out = await a.turn('com\'e\' messo il progetto Peak', false);
		assert.ok(toolsSeen[0] > 5 && toolsSeen[0] < 20, `Apple riceve il sottoinsieme degli strumenti: ${toolsSeen}`);
		assert.match(out, /Agnes non risponde, ti rispondo dal Mac\. Peak e' pulito\./);
		assert.strictEqual(a.getState().brain, 'apple');
		assert.ok(a.router.breakerOpen, 'interruttore aperto: i prossimi turni vanno subito al Mac');
	});


	await test('Agnes giu\': prima DeepSeek, poi il Mac; e con l\'interruttore aperto si va diretti a DeepSeek', async () => {
		const brains = [];
		let deepseekVa = true;
		const cervelli = {
			choice: () => ({ provider: 'agnes', model: 'agnes-3.0-flash', effort: 'normale' }),
			riservaDeepseek: () => ({ provider: 'deepseek', model: 'deepseek-flash', effort: 'normale' }),
			streamFor: c => (c.provider === 'deepseek' ? async (m, t, onDelta) => {
				brains.push('deepseek');
				if (!deepseekVa) throw new Error('DeepSeek ha risposto 500.');
				onDelta({ content: 'Da DeepSeek.' });
			} : undefined),
			key: () => undefined, noteAgnes: () => {}, touch: () => {}, endConversation: () => {},
		};
		const { a } = makeAssistant({
			apple: true,
			cervelli,
			stream: async () => (brains.push('agnes'), Promise.reject(new Error('Rete giu\' verso Agnes.'))),
			appleStream: async (m, t, onDelta) => (brains.push('apple'), onDelta({ content: 'Dal Mac.' })),
		});
		assert.match(await a.turn('ciao', false), /Agnes non risponde, ti rispondo con DeepSeek\. Da DeepSeek\./);
		assert.strictEqual(a.getState().brain, 'deepseek');
		assert.match(await a.turn('e adesso?', false), /Da DeepSeek\./);
		deepseekVa = false;
		assert.match(await a.turn('e ora?', false), /Neanche DeepSeek risponde, ti rispondo dal Mac\. Dal Mac\./);
		assert.deepStrictEqual(brains, ['agnes', 'deepseek', 'deepseek', 'deepseek', 'apple']);
	});

	await test('guarda_schermo: chiede al Nucleo, a Melissa arriva solo il testo; senza permesso lo dice', async () => {
		const { a, nucleo } = makeAssistant({});
		nucleo.request = (cmd, args) => {
			nucleo.reqs.push({ cmd, args });
			if (cmd === 'vision.guarda') return Promise.resolve({ testo: 'Errore 42 nel build', app: 'Xcode', finestra: 'Peak' });
			return Promise.resolve({});
		};
		const out = await asst.TOOLS.guarda_schermo.run({}, a);
		assert.ok(nucleo.reqs.some(r => r.cmd === 'vision.guarda'));
		assert.match(out, /In primo piano: Xcode, Peak\./);
		assert.match(out, /Errore 42 nel build/);
		nucleo.request = () => Promise.reject(new Error('Serve il permesso di registrazione dello schermo'));
		assert.match(await asst.TOOLS.guarda_schermo.run({}, a), /Non riesco a guardare lo schermo: Serve il permesso/);
	});

	// ---- collaudo reale contro Agnes: consuma la quota condivisa, quindi solo su richiesta ----
	// ---- il loop di Melissa: risposta detta due volte, strumenti richiamati in tondo, eco della sua voce ----
	await test('una frase gia\' detta in un passo con strumenti non si ridice al passo dopo', async () => {
		const { a, nucleo } = makeAssistant({
			stream: scriptedStream([
				[{ content: 'Apro Peak. ' }, { tool_call: { index: 0, id: 't1', name: 'progetto_apri', arguments: '{"progetto":"Peak"}' } }],
				[{ content: 'Apro Peak. Fatto, è aperta.' }],
			]),
		});
		await a.turn('apri peak', true);
		const said = nucleo.speaks.map(s => s.text?.trimEnd()).filter(Boolean);
		assert.strictEqual(said.filter(t => t === 'Apro Peak.').length, 1, `detto: ${JSON.stringify(said)}`);
		assert.ok(said.includes('Fatto, è aperta.'));
	});

	await test('lo stesso strumento con gli stessi argomenti non si riesegue e il giro si chiude', async () => {
		let opened = 0;
		const call = () => [{ tool_call: { index: 0, id: 'x' + Math.random(), name: 'progetto_apri', arguments: '{"progetto":"Peak"}' } }];
		const { a } = makeAssistant({
			actions: { openProject: () => opened++ },
			stream: scriptedStream([call(), call(), call(), call(), call(), call(), [{ content: 'mai' }]]),
		});
		const answer = await a.turn('apri peak', false);
		assert.strictEqual(opened, 1, 'aperto una volta sola');
		assert.ok(!answer.includes('mai'), 'il giro si ferma prima');
	});

	await test('in conversazione Melissa non risponde alla propria voce (eco)', async () => {
		let turns = 0;
		const { a, nucleo } = makeAssistant({ stream: async (_m, _t, onDelta) => (turns++, onDelta({ content: 'Peak ha tre commit da spingere e la build ferma.' })) });
		a.wire({ subscriptions: [] });
		nucleo.fire('orb.clicked', {});
		nucleo.fire('voice.final', { text: 'come sta peak', mode: 'converse' });
		await new Promise(r => setTimeout(r, 30));
		assert.strictEqual(turns, 1);
		nucleo.fire('voice.final', { text: 'Peak ha tre commit da spingere e la build', mode: 'converse' });
		await new Promise(r => setTimeout(r, 30));
		assert.strictEqual(turns, 1, 'l\'eco non diventa una domanda');
		nucleo.fire('voice.final', { text: 'e Fontanelle invece', mode: 'converse' });
		await new Promise(r => setTimeout(r, 30));
		assert.strictEqual(turns, 2, 'una domanda vera passa');
		assert.ok(asst.echoScore('Peak ha tre commit da spingere', 'Peak ha tre commit da spingere e la build ferma.') >= 0.6);
		assert.strictEqual(asst.echoScore('ok', 'ok va bene'), 0);
	});

	await test('la trascrizione parziale rinnova i 60 s di inattività mentre Andrea parla', () => {
		const { a, nucleo } = makeAssistant();
		const originalSet = global.setTimeout;
		const originalClear = global.clearTimeout;
		const armed = [], cleared = [];
		try {
			global.setTimeout = (fn, ms, ...args) => {
				if (ms === 60_000) {
					const token = 100_000 + armed.length;
					armed.push({ token, fn });
					return token;
				}
				return originalSet(fn, ms, ...args);
			};
			global.clearTimeout = token => {
				if (typeof token === 'number' && token >= 100_000) cleared.push(token);
				else originalClear(token);
			};
			a.wire({ subscriptions: [] });
			a.toggleConversation();
			assert.strictEqual(armed.length, 1, 'il timer iniziale parte');
			nucleo.fire('voice.partial', { text: 'Sto spiegando', mode: 'converse' });
			assert.strictEqual(armed.length, 2, 'una frase in corso rinnova il timer');
			assert.ok(cleared.includes(armed[0].token), 'il timer vecchio viene annullato');
			nucleo.fire('voice.partial', { text: 'Sto spiegando ancora', mode: 'converse' });
			assert.strictEqual(armed.length, 3);
			nucleo.fire('voice.partial', { text: 'push da ignorare', mode: 'push' });
			assert.strictEqual(armed.length, 3, 'il push non prolunga la conversazione');
			a.toggleConversation();
			assert.ok(cleared.includes(armed[2].token), 'la chiusura annulla il timer attuale');
		} finally {
			global.setTimeout = originalSet;
			global.clearTimeout = originalClear;
		}
	});

	await test('una risposta vocale lunga sospende il limite di silenzio fino alla fine dell audio', async () => {
		let finishStream;
		const { a, nucleo } = makeAssistant({ stream: async (_m, _t, onDelta) => {
			onDelta({ content: 'Prima frase. ' });
			await new Promise(resolve => { finishStream = resolve; });
			onDelta({ content: 'Seconda frase.' });
		} });
		const originalSet = global.setTimeout;
		const originalClear = global.clearTimeout;
		const armed = [], cleared = [];
		try {
			global.setTimeout = (fn, ms, ...args) => {
				if (ms === 60_000) {
					const token = 200_000 + armed.length;
					armed.push({ token, fn });
					return token;
				}
				return originalSet(fn, ms, ...args);
			};
			global.clearTimeout = token => {
				if (typeof token === 'number' && token >= 200_000) cleared.push(token);
				else originalClear(token);
			};
			a.wire({ subscriptions: [] });
			a.toggleConversation();
			assert.strictEqual(armed.length, 1);
			nucleo.fire('voice.final', { text: 'spiegami tutto', mode: 'converse' });
			await tick();
			assert.ok(finishStream, 'la risposta ha iniziato lo stream');
			assert.ok(cleared.includes(armed[0].token), 'il timer iniziale e annullato');
			assert.strictEqual(armed.length, 2, 'nessun timer nuovo durante la generazione');
			finishStream();
			await tick();
			assert.strictEqual(armed.length, 2, 'nessun timer mentre la voce riproduce');
			assert.strictEqual(a.getState().conversing, true);
			nucleo.fire('voice.state', { state: 'speaking' });
			nucleo.fire('voice.state', { state: 'idle' });
			assert.strictEqual(armed.length, 3, 'il timer torna dopo l ultima frase');
			a.toggleConversation();
		} finally {
			global.setTimeout = originalSet;
			global.clearTimeout = originalClear;
		}
	});

	// ---- i cervelli: Agnes primaria, gli altri solo se scelti, ritorno ad Agnes a ogni problema ----
	function fakeCervelli(choice, opts = {}) {
		const rec = { ended: 0, touched: 0, agnes: [] };
		return {
			rec,
			choice: () => opts.cur || choice,
			streamFor: () => opts.stream,
			touch: () => rec.touched++,
			endConversation: () => {
				rec.ended++;
				opts.cur = { provider: 'agnes', model: 'agnes-3.0-flash', effort: 'normale' };
			},
			noteAgnes: s => rec.agnes.push(s),
		};
	}

	await test('cervello scelto che risponde 402: la stessa domanda va ad Agnes, e Melissa lo dice', async () => {
		const cv = fakeCervelli({ provider: 'deepseek', model: 'deepseek-flash', effort: 'normale' }, {
			stream: async () => {
				throw new Error('senza credito');
			},
		});
		const { a } = makeAssistant({ stream: scriptedStream([[{ content: 'Ciao, sono io.' }]]) });
		a.deps.cervelli = cv;
		const answer = await a.turn('come va', false);
		assert.strictEqual(answer, 'Ciao, sono io.');
		assert.ok(a.getState().log.some(l => l.role === 'azione' && l.text === 'DeepSeek V4.1 Flash non risponde (senza credito): torno ad Agnes'));
		assert.strictEqual(cv.rec.ended, 1, 'si torna ad Agnes');
		assert.strictEqual(cv.rec.touched, 1);
	});

	await test('Apple scelto a mano: risponde il Mac CON gli strumenti, senza dire che Agnes e\' a terra', async () => {
		const cv = fakeCervelli({ provider: 'apple', model: 'apple-on-device', effort: 'normale' });
		const seen = [];
		const { a } = makeAssistant({
			apple: true,
			stream: scriptedStream([[{ content: 'non dovrei parlare io' }]]),
			appleStream: async (m, t, onDelta) => (seen.push(t.length), onDelta({ content: 'Dal Mac.' })),
		});
		a.deps.cervelli = cv;
		const answer = await a.turn('dimmi una cosa', false);
		assert.strictEqual(answer, 'Dal Mac.');
		assert.ok(seen[0] > 5, 'Apple riceve gli strumenti');
		assert.strictEqual(a.getState().brain, 'apple');
	});

	await test('Apple scelto a mano che non risponde: si torna ad Agnes e lo si dice', async () => {
		const cv = fakeCervelli({ provider: 'apple', model: 'apple-on-device', effort: 'normale' });
		const { a } = makeAssistant({
			apple: true,
			stream: scriptedStream([[{ content: 'non dovrei parlare io' }]]),
			appleStream: async () => { throw new Error('Apple Intelligence non ha risposto in tempo.'); },
		});
		a.deps.cervelli = cv;
		const answer = await a.turn('dimmi una cosa', false);
		assert.match(answer, /Apple Intelligence non risponde\. Torno ad Agnes/);
		assert.strictEqual(cv.rec.ended, 1);
	});

	await test('chiudere la conversazione riporta ad Agnes', async () => {
		const cv = fakeCervelli({ provider: 'deepseek', model: 'deepseek-flash', effort: 'normale' });
		const { a, nucleo } = makeAssistant({ stream: scriptedStream([]) });
		a.deps.cervelli = cv;
		a.wire({ subscriptions: [] });
		nucleo.fire('orb.clicked', {});
		nucleo.fire('orb.clicked', {});
		assert.strictEqual(cv.rec.ended, 1);
		assert.strictEqual(asst.brainName('deepseek-flash'), 'DeepSeek V4.1 Flash');
		assert.strictEqual(asst.brainName('deepseek-v4-pro'), 'DeepSeek V4 Pro');
		assert.strictEqual(asst.brainName('apple-on-device'), 'Apple Intelligence');
	});

	// ---------- personaggi (src/personaggi.ts): voce, passaggio di chiamata, chiamata a tre ----------

	/** Un Nucleo finto che, come quello vero, dice quando una battuta comincia e finisce di suonare: "speaking" alla
	 *  prima frase, e il turno di voce resta aperto finche' non arriva `final` o passano 20 s senza (qui 1 s, contati
	 *  in `scaduti`). */
	function nucleoCheParla() {
		const n = makeNucleo(true);
		const req = n.request.bind(n);
		let parla = false;
		let scade;
		n.scaduti = 0;
		n.request = (cmd, args) => {
			const r = req(cmd, args);
			if (cmd !== 'voice.speak' || !args) return r;
			if (args.text && !parla) {
				parla = true;
				setImmediate(() => n.fire('voice.state', { state: 'speaking' }));
			}
			clearTimeout(scade);
			if (args.final && parla) {
				parla = false;
				setImmediate(() => n.fire('voice.state', { state: 'idle' }));
			} else if (parla) {
				scade = setTimeout(() => { n.scaduti++; parla = false; n.fire('voice.state', { state: 'idle' }); }, 1000);
			}
			return r;
		};
		return n;
	}
	const finche = async (cond, ms = 3000) => {
		const t0 = Date.now();
		while (!cond()) {
			if (Date.now() - t0 > ms) throw new Error('condizione mai vera');
			await new Promise(r => setTimeout(r, 5));
		}
	};
	const ctxProva = () => ({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } });
	const DARLENE = 'vfJO9rw4YuKJJKxYo3oQ', ELLIOT = 'yUrn8DPhKREqXUFumEa0';

	await test('personaggi: «passami Darlene» le passa la chiamata, saluta e risponde con la sua voce', async () => {
		const nucleo = nucleoCheParla();
		const { a } = makeAssistant({ nucleo, stream: scriptedStream([[{ content: 'Ci penso io, fratellino.' }]]) });
		a.wire({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } });
		await a.turn('passami Darlene', true);
		assert.strictEqual(a.getState().personaggio, 'darlene');
		assert.ok(nucleo.speaks.some(x => x.voice === DARLENE), 'il saluto ha la voce di Darlene');
		nucleo.speaks.length = 0;
		await a.turn('come va il progetto?', true);
		assert.strictEqual(nucleo.speaks[0].voice, DARLENE, 'anche la risposta');
		assert.ok(a.systemPrompt().startsWith('Sei Darlene Alderson'), 'e il prompt e\' il suo');
		assert.ok(a.getState().log.some(r => r.text === 'Darlene: Ci penso io, fratellino.'));
		await a.turn('ridammi Melissa', true);
		assert.strictEqual(a.getState().personaggio, 'melissa');
		assert.ok(a.systemPrompt().startsWith('Sei Melissa Alderson'));
	});

	await test('personaggi: il segnale @elliot non si legge, Elliot risponde con la sua voce e Melissa chiude', async () => {
		const nucleo = nucleoCheParla();
		const { a } = makeAssistant({ nucleo, stream: scriptedStream([
			[{ content: 'Io dico che regge. Elliot, tu che dici? @elliot' }],
			[{ content: 'Regge finche\' nessuno guarda le chiavi.' }],
			[{ content: 'Visto? Paranoico come sempre.' }],
		]) });
		a.wire({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } });
		const detta = await a.turn('chiedi a Elliot se regge', true);
		assert.ok(!/@elliot/i.test(detta), 'il segnale non resta nella risposta');
		const testi = nucleo.speaks.map(x => x.text || '').join(' ');
		assert.ok(!/@/.test(testi), 'e non arriva alla voce');
		const suaVoce = nucleo.speaks.find(x => x.voice === ELLIOT);
		assert.ok(suaVoce && /chiavi/.test(suaVoce.text), 'Elliot parla con la sua voce');
		const ultima = nucleo.speaks.filter(x => x.text).pop();
		assert.ok(!ultima.voice && /Paranoico/.test(ultima.text), 'Melissa chiude con la sua');
		const righe = a.getState().log.map(r => r.text);
		assert.deepStrictEqual(righe.slice(-3), ['Io dico che regge. Elliot, tu che dici?', 'Elliot: Regge finche\' nessuno guarda le chiavi.', 'Visto? Paranoico come sempre.']);
		assert.strictEqual(a.getState().personaggio, 'melissa', 'la chiamata resta a Melissa');
		// il turno di voce di Melissa si chiude prima della battuta di Elliot: senza, 20 s di silenzio nel Nucleo
		const chiusa = nucleo.speaks.findIndex(x => x.final && !x.text);
		assert.ok(chiusa >= 0 && chiusa < nucleo.speaks.indexOf(suaVoce), 'il final di Melissa arriva prima della voce di Elliot');
		assert.strictEqual(nucleo.speaks.filter(x => x.final && !x.text).length, 1, 'e uno solo: niente turni vuoti dopo');
		assert.strictEqual(nucleo.scaduti, 0, 'nessun turno chiuso dal tempo massimo');
	});

	await test('personaggi: una frase detta durante le battute a tre parte dopo, senza chiudere la voce del turno nuovo', async () => {
		const nucleo = nucleoCheParla();
		let liberaElliot;
		let chiamate = 0;
		const passi = [
			[{ content: 'Regge. Elliot, tu che dici? @elliot' }],
			onDelta => new Promise(r => (liberaElliot = () => { onDelta({ content: 'Regge, ma le chiavi no.' }); r(); })),
			[{ content: 'Paranoico.' }],
			[{ content: 'Il backup e\' fatto stanotte.' }],
		];
		const giro = scriptedStream(passi);
		const { a } = makeAssistant({ nucleo, stream: (...x) => (chiamate++, giro(...x)) });
		a.wire(ctxProva());
		nucleo.fire('hotkey.down'); nucleo.fire('hotkey.up'); // tocco: conversazione accesa
		nucleo.fire('voice.final', { text: 'regge la build?', mode: 'converse' });
		await finche(() => !!liberaElliot);
		nucleo.fire('voice.final', { text: 'e il backup?', mode: 'converse' });
		await tick();
		assert.strictEqual(chiamate, 2, 'nessun secondo turno mentre Elliot pensa');
		liberaElliot();
		await finche(() => a.getState().log.some(r => /backup e' fatto/.test(r.text)));
		const righe = a.getState().log.map(r => `${r.role}: ${r.text}`);
		assert.deepStrictEqual(righe.slice(-6), [
			'tu: regge la build?', 'melissa: Regge. Elliot, tu che dici?', 'melissa: Elliot: Regge, ma le chiavi no.',
			'melissa: Paranoico.', 'tu: e il backup?', 'melissa: Il backup e\' fatto stanotte.',
		]);
		const testi = nucleo.speaks.map(x => x.text || '');
		assert.ok(testi.findIndex(t => /Paranoico/.test(t)) < testi.findIndex(t => /backup/.test(t)), 'il turno nuovo parla dopo la chiusa');
		const ultima = nucleo.speaks.length - 1;
		assert.ok(nucleo.speaks[ultima].final && !nucleo.speaks[ultima].text, 'e il suo turno di voce si chiude col suo final');
		a.stopConversation?.('fine prova');
	});

	await test('personaggi: un tocco durante le battute a tre lascia nel registro la risposta senza segnale e le battute gia\' dette', async () => {
		for (const quando of ['prima di Elliot', 'durante la chiusa']) {
			const nucleo = nucleoCheParla();
			const ferma = (onDelta, signal) => new Promise((_, no) => signal.addEventListener('abort', () => no(new Error('interrotta')), { once: true }));
			const passi = quando === 'prima di Elliot'
				? [[{ content: 'Regge. Elliot, tu che dici? @elliot' }], ferma]
				: [[{ content: 'Regge. Elliot, tu che dici? @elliot' }], [{ content: 'Regge, ma le chiavi no.' }], ferma];
			const giro = scriptedStream(passi);
			let chiamate = 0;
			const { a } = makeAssistant({ nucleo, stream: (...x) => (chiamate++, giro(...x)) });
			a.wire(ctxProva());
			const p = a.turn('regge la build?', true);
			await finche(() => chiamate === passi.length);
			nucleo.fire('voice.bargein');
			await p;
			const righe = a.getState().log.map(r => r.text);
			assert.ok(!righe.some(t => /@/.test(t)), `${quando}: nessun segnale nel registro`);
			if (quando === 'prima di Elliot') {
				assert.deepStrictEqual(righe.slice(-1), ['Regge. Elliot, tu che dici? (interrotta)']);
			} else {
				assert.deepStrictEqual(righe.slice(-2), ['Regge. Elliot, tu che dici?', 'Elliot: Regge, ma le chiavi no. (interrotta)']);
				assert.ok(a.history.some(m => m.content === 'Regge, ma le chiavi no. [interrotta da Andrea]' && m.chi === 'elliot'), 'e nella storia, come sua');
			}
		}
	});

	await test('personaggi: anche la risposta del cervello di riserva passa la parola a chi chiama', async () => {
		const nucleo = nucleoCheParla();
		const deepseek = scriptedStream([
			[{ content: 'Regge. Elliot, tu che dici? @elliot' }],
			[{ content: 'Regge, ma le chiavi no.' }],
			[{ content: 'Paranoico.' }],
		]);
		const cervelli = {
			choice: () => ({ provider: 'agnes', model: 'agnes-3.0-flash', effort: 'normale' }),
			riservaDeepseek: () => ({ provider: 'deepseek', model: 'deepseek-flash', effort: 'normale' }),
			streamFor: c => (c.provider === 'deepseek' ? deepseek : undefined),
			key: () => undefined, noteAgnes: () => {}, touch: () => {}, endConversation: () => {},
		};
		const { a } = makeAssistant({ nucleo, cervelli, stream: async () => { throw new Error('Rete giu\' verso Agnes.'); } });
		a.wire(ctxProva());
		await a.turn('regge la build?', true);
		assert.ok(nucleo.speaks.some(x => x.voice === ELLIOT && /chiavi/.test(x.text)), 'Elliot risponde, con la riserva');
		assert.ok(a.getState().log.some(r => r.text === 'Elliot: Regge, ma le chiavi no.'));
		// e il ripiego di Apple senza strumenti
		const n2 = nucleoCheParla();
		const req = n2.request;
		n2.request = (cmd, args) => (cmd === 'ai.generate'
			? (n2.reqs.push({ cmd, args }), Promise.resolve({ text: args.instructions.startsWith('Sei Elliot') ? 'Le chiavi, amico.' : /ha appena detto/.test(args.prompt) ? 'Visto?' : 'Regge. Elliot, tu che dici?' }))
			: req(cmd, args));
		const b = makeAssistant({ nucleo: n2, stream: async () => { throw new Error('Agnes ha risposto 500.'); } });
		b.a.wire(ctxProva());
		await b.a.turn('regge la build?', true);
		assert.ok(n2.speaks.some(x => x.voice === ELLIOT && /chiavi/.test(x.text)), 'Elliot risponde anche dopo il ripiego');
	});

	await test('personaggi: con la chiamata a Elliot le sue righe sono sue; tornata Melissa, sono di Elliot', async () => {
		const nucleo = nucleoCheParla();
		const visti = [];
		const giro = scriptedStream([[{ content: 'Le chiavi stanno in un posto solo.' }], [{ content: 'Lo ha detto Elliot, non io.' }]]);
		const { a } = makeAssistant({ nucleo, stream: (m, ...x) => (visti.push(m), giro(m, ...x)) });
		a.wire(ctxProva());
		await a.turn('passami Elliot', true);
		await a.turn('dove metto le chiavi?', true);
		const perElliot = visti[0].filter(m => m.role !== 'system');
		assert.ok(perElliot.some(m => m.role === 'assistant'), 'il suo saluto, per lui, e\' suo');
		await a.turn('ridammi Melissa', true);
		await a.turn('che ha detto?', true);
		const perMelissa = visti[1].filter(m => m.role !== 'system');
		assert.ok(perMelissa.some(m => m.role === 'user' && m.content === '(Elliot ha detto: Le chiavi stanno in un posto solo.)'), 'per Melissa e\' di Elliot');
		assert.ok(!perMelissa.some(m => m.role === 'assistant' && /chiavi stanno/.test(m.content)), 'e non sua');
		assert.ok(perMelissa.every(m => !('chi' in m)), 'al cervello non arriva il campo chi');
	});

	await test('personaggi: una domanda a Krista per nome, senza segnale, ha la sua risposta; un nome di passaggio no', async () => {
		const nucleo = nucleoCheParla();
		const { a } = makeAssistant({ nucleo, stream: scriptedStream([
			[{ content: 'La build e\' rotta di nuovo. Krista, che ne dici?' }],
			[{ content: 'Dico che la rimanda da tre giorni.' }],
			[{ content: 'Ecco, appunto.' }],
			[{ content: 'Darlene ti ha mai detto di no? Comunque e\' finita.' }],
		]) });
		a.wire({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } });
		await a.turn('com\'e\' andata la build?', true);
		assert.ok(nucleo.speaks.some(x => x.voice === 'CxyJefqDMJqI9Y7prMgt'), 'Krista risponde con la sua voce');
		nucleo.speaks.length = 0;
		await a.turn('e adesso?', true);
		assert.ok(!nucleo.speaks.some(x => x.voice), 'nessun\'altra voce per un nome di passaggio');
	});

	await test('personaggi: funzioni pure, stesse regole della mod e dell\'iPhone', async () => {
		const p = require(path.join(OUT, 'personaggi.js'));
		assert.strictEqual(p.chiChiede('Passami Darlene'), 'darlene');
		assert.strictEqual(p.chiChiede('voglio parlare con mr robot'), 'elliot');
		assert.strictEqual(p.chiChiede('passami il sale'), null);
		assert.strictEqual(p.ospiteChiesto('sentiamo anche Krista'), 'krista');
		assert.deepStrictEqual(p.chiamata('Va bene. @Elliot', ['elliot']), { testo: 'Va bene.', ospite: 'elliot' });
		assert.deepStrictEqual(p.chiamata('Va bene. @darlene', ['elliot']), { testo: 'Va bene.', ospite: null });
		assert.strictEqual(p.ospiteDellaFrase('ho messo la password nel README', '', 0), 'elliot');
		assert.strictEqual(p.ospiteDellaFrase('lo faccio domani', '', 0), 'krista');
		assert.strictEqual(p.ospiteDellaFrase('un film?', 'darlene', 0), 'elliot');
		assert.ok(p.invito(null, 'krista', true).startsWith('Stavolta tira dentro Krista'));
		assert.strictEqual(p.invito(null, null, true), '');
		for (const k of p.ORDINE) assert.ok(!p.cuore(p.PERSONAGGI[k], '').includes('\u2014'));
		// la domanda per nome: la regola della mod e dell'iPhone
		const casi = {
			'Ha toccato le chiavi. Elliot, tu che dici?': 'elliot',
			'Elliot... tu che dici?': 'elliot',
			'Elliot! Che dici?': 'elliot',
			'Che ne pensi, Krista?': 'krista',
			'Allora, Darlene?': 'darlene',
			'Darlene?': 'darlene',
			'Ti ricordi quando Elliot ha bucato E Corp?': null,
			'Vuoi che apra il file di Krista?': null,
			'Darlene ti ha mai detto di no? Comunque e\' finita.': null,
			'Non so. Tu che dici?': null,
		};
		for (const [t, chi] of Object.entries(casi)) assert.strictEqual(p.chiamatoPerNome(t), chi, t);
		// il segnale: solo le chiavi caricate, mai un indirizzo email
		assert.deepStrictEqual(p.chiamata('Scrivi a mario@esempio.it. Elliot, che dici? @elliot', ['elliot', 'krista']), { testo: 'Scrivi a mario@esempio.it. Elliot, che dici?', ospite: 'elliot' });
		assert.deepStrictEqual(p.chiamata('Scrivi a krista@esempio.it, fatto.', ['krista']), { testo: 'Scrivi a krista@esempio.it, fatto.', ospite: null });
		assert.strictEqual(p.senzaSegnaleInCorso('Elliot, tu che dici? @ell'), 'Elliot, tu che dici?');
		assert.strictEqual(p.dallaRiga('Krista: Niente scuse.').chi, 'krista');
		assert.strictEqual(p.esiste('constructor'), false);
		assert.strictEqual(p.nomeDi('constructor'), 'Melissa');
	});

	await test('personaggi: file con campi facoltativi, espressioni rotte e nomi strani; pubblica toglie i rimossi', async () => {
		const p = require(path.join(OUT, 'personaggi.js'));
		const fs = require('fs');
		const os = require('os');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'personaggi-'));
		const scrivi = (n, x) => fs.writeFileSync(path.join(dir, n), JSON.stringify(x));
		const base = { voce: 'v', carattere: 'Sei qualcuno.', saluti: ['Ciao.'] };
		scrivi('robot.json', { ...base, chiave: 'robot', nome: 'Mr. Robot', parole: '(chiav', parole_cronaca: 'sudo' });
		scrivi('tyrell.json', { ...base, chiave: 'tyrell', nome: 'Tyrell', ordine: 1 });
		scrivi('muto.json', { ...base, chiave: 'muto', nome: 'Muto', voce: '' });
		const avvisi = [];
		try {
			assert.strictEqual(p.carica([dir], m => avvisi.push(m)), 2, 'senza voce si scarta');
			assert.deepStrictEqual(p.ORDINE, ['tyrell', 'robot'], 'ordine 99 se manca');
			const r = p.PERSONAGGI.robot;
			assert.strictEqual(r.parole, '', 'espressione rotta: vuota');
			assert.strictEqual(r.parole_cronaca, 'sudo');
			assert.ok(avvisi.some(m => /robot\.json, `parole`/.test(m)), 'e lo dice');
			assert.ok(avvisi.some(m => /muto\.json/.test(m)));
			assert.deepStrictEqual([r.ruolo, r.ruolo_cronaca, r.errori_ripetuti, p.PERSONAGGI.tyrell.ordine], ['Mr. Robot', 'Mr. Robot', 0, 1]);
			assert.strictEqual(p.ospiteDellaFrase('le chiavi', 'tyrell', 0), 'robot', 'nessuna eccezione: senza parole valide, uno diverso dall\'ultimo');
			assert.strictEqual(p.chiamatoPerNome('Mr. Robot, tu che dici?'), 'robot', 'il punto nel nome e\' un punto');
			assert.strictEqual(p.chiamatoPerNome('Mr! Robot, tu che dici?'), null);
			assert.strictEqual(p.chiChiede('passami Mr. Robot'), 'robot');
			assert.deepStrictEqual(p.elenco(), [{ chiave: 'tyrell', nome: 'Tyrell', ruolo: 'Tyrell' }, { chiave: 'robot', nome: 'Mr. Robot', ruolo: 'Mr. Robot' }]);
			// pubblica: copia i cambiati, toglie i .json che non ci sono piu', lascia il resto
			const a = fs.mkdtempSync(path.join(os.tmpdir(), 'personaggi-mod-'));
			fs.writeFileSync(path.join(a, 'vecchio.json'), '{}');
			fs.writeFileSync(path.join(a, 'appunti.txt'), 'mio');
			p.pubblica(dir, a);
			assert.deepStrictEqual(fs.readdirSync(a).sort(), ['appunti.txt', 'muto.json', 'robot.json', 'tyrell.json']);
			assert.strictEqual(p.pubblica(dir, a), 0, 'uguali: niente da fare');
			fs.rmSync(path.join(dir, 'muto.json'));
			assert.strictEqual(p.pubblica(dir, a), 1);
			assert.ok(!fs.existsSync(path.join(a, 'muto.json')), 'il personaggio tolto sparisce anche dalla mod');
			fs.rmSync(a, { recursive: true, force: true });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			p.carica([process.env.BOTTEGA_PERSONAGGI]);
		}
	});

	// BOTTEGA_TEST_REALE=1 npm test
	if (process.env.BOTTEGA_TEST_REALE === '1') await test('REALE: Agnes chiama progetti_cerca con il vero formato tool', async () => {
		const fs = require('fs');
		const os = require('os');
		let hasKey = !!process.env.AGNES_API_KEY;
		if (!hasKey) {
			try {
				const env = fs.readFileSync(path.join(os.homedir(), '.secrets', 'agnes-ai.env'), 'utf8');
				hasKey = /^\s*AGNES_API_KEY\s*=\s*\S+/m.test(env);
			} catch {}
		}
		if (!hasKey) {
			console.log('      (saltato: nessuna chiave Agnes)');
			return;
		}
		const { a, rec } = makeAssistant({}); // stream reale (deps.stream undefined)
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 60_000);
		let out;
		try {
			out = await a.runAgent('Cerca tra i miei progetti quelli che contengono la parola peak e dimmi quali sono.', false, ac.signal);
		} finally {
			clearTimeout(timer);
		}
		assert.ok(rec.searchProjects.length >= 1, 'il modello ha chiamato progetti_cerca sul vero filo');
		assert.ok(typeof out === 'string' && out.length > 0, 'ha chiuso con una risposta');
		console.log('      risposta reale: ' + out.slice(0, 120).replace(/\s+/g, ' '));
	});

	console.log(`\n${passed} ok, ${failed} falliti` + (failures.length ? ': ' + failures.join(', ') : ''));
	process.exit(failed ? 1 : 0);
})();
