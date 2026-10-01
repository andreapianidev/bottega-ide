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
const OUT = path.join(__dirname, 'test-out');

esbuild.buildSync({
	entryPoints: ['jobs', 'assistant', 'nucleo', 'memoria', 'claude', 'scan'].map(n => path.join(SRC, n + '.ts')),
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
			editorContext: () => ({}),
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
	};
	const a = new asst.Assistant(deps);
	return { a, nucleo, rec, deps };
}

// ============================================================ TEST

(async () => {
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

	// ---- streaming dei delta + TTS frase per frase ----
	await test('turn parla frase per frase e chiude con final', async () => {
		const stream = scriptedStream([[{ content: 'Ciao fra. ' }, { content: 'Ho guardato i progetti' }, { content: ', sono tre' }, { content: '.' }]]);
		const { a, nucleo } = makeAssistant({ stream });
		await a.turn('come va', true);
		const clauses = nucleo.speaks.filter(s => s.append).map(s => s.text);
		assert.deepStrictEqual(clauses, ['Ciao fra.', 'Ho guardato i progetti, sono tre.']);
		assert.ok(nucleo.speaks.some(s => s.final === true), 'manda il final');
		assert.ok(nucleo.speaks[0].model === 'eleven_v4_turbo', 'il primo chunk porta il modello');
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

	// ---- collaudo reale contro Agnes: consuma la quota condivisa, quindi solo su richiesta ----
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
