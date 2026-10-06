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
// la Bottega di prova, mai ~/.bottega: la memoria dei personaggi si legge da un finto cli.mjs qui dentro
process.env.BOTTEGA_HOME = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'bottega-home-'));
const OUT = path.join(__dirname, 'test-out');

esbuild.buildSync({
	entryPoints: ['jobs', 'assistant', 'cervello', 'nucleo', 'memoria', 'claude', 'scan', 'racconto', 'personaggi', 'riempitivi', 'memoria-contesto', 'memoria-personaggi'].map(n => path.join(SRC, n + '.ts')),
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

/** Un finto cli della Memoria nella Bottega di prova (BOTTEGA_HOME): bin/node e' il Node dei test, memoria-app/cli.mjs
 *  risponde `risposte[chiave]` a `personaggio <chiave>` e annota gli argomenti. `modo`: 'lento' (oltre 1,5 s) o
 *  'sconosciuto' (una Memoria installata che non conosce ancora il comando). Mai ~/.bottega. */
function fintoCli(risposte = {}, modo = '') {
	const fs = require('fs');
	const h = process.env.BOTTEGA_HOME;
	fs.mkdirSync(path.join(h, 'bin'), { recursive: true });
	fs.mkdirSync(path.join(h, 'memoria-app'), { recursive: true });
	const node = path.join(h, 'bin', 'node');
	fs.rmSync(node, { force: true });
	fs.symlinkSync(process.execPath, node);
	const log = path.join(h, 'cli-chiamate.jsonl');
	fs.rmSync(log, { force: true });
	fs.writeFileSync(path.join(h, 'memoria-app', 'cli.mjs'), [
		"import fs from 'node:fs';",
		'const a = process.argv.slice(2);',
		`fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');`,
		modo === 'sconosciuto' || a0Diverso() ? "if (a[0] !== 'personaggio' || " + JSON.stringify(modo === 'sconosciuto') + ") { console.error('comando sconosciuto'); process.exit(1); }" : '',
		modo === 'lento' ? 'await new Promise(r => setTimeout(r, 4000));' : '',
		`const r = ${JSON.stringify(risposte)};`,
		'process.stdout.write(JSON.stringify(r[a[1]] ?? { ultime: [], ricordi: [] }));',
	].join('\n'));
	return {
		chiamate: () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); } catch { return []; } },
		togli: () => { fs.rmSync(path.join(h, 'memoria-app'), { recursive: true, force: true }); fs.rmSync(node, { force: true }); fs.rmSync(log, { force: true }); },
	};
	function a0Diverso() { return true; }
}

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
		...(over.registraMemoria ? { registraMemoria: over.registraMemoria } : {}),
	};
	const a = new asst.Assistant(deps);
	// di default nessun ospite passa la parola a un altro (il 40%, CONTRATTI 9.11): chi lo prova fissa il suo caso
	a.caso = () => 0.9;
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
		// contano le risposte di Melissa, non le battute di un ospite che lei invita
		const { a, nucleo } = makeAssistant({ stream: async (m, _t, onDelta) => (m[0].content.startsWith('Sei Melissa') && turns++, onDelta({ content: 'Peak ha tre commit da spingere e la build ferma.' })) });
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
	/** La chiamata allo strumento passa_parola, come la manda il modello in streaming (CONTRATTI 9.11). */
	const PASSA = (chi, index = 0) => ({ tool_call: { index, id: `passa-${chi}`, name: 'passa_parola', arguments: JSON.stringify({ a: chi }) } });

	/** Cervelli finti: Agnes per la risposta (deps.stream), e `chiVuole` sempre da DeepSeek Flash, che qui risponde `json`.
	 *  `chiave`: se c'e' la chiave DeepSeek (senza, chiVuole non parte e mai su Agnes). */
	function cervelliChiVuole(json, viste = [], chiave = true) {
		return {
			choice: () => ({ provider: 'agnes', model: 'agnes-3.0-flash', effort: 'normale' }),
			riservaDeepseek: () => undefined,
			streamFor: (c, extra) => async (messages, tools, onDelta) => {
				viste.push({ c, extra, messages });
				if (json === null) return new Promise(() => {}); // non risponde mai
				onDelta({ content: json });
			},
			key: p => (chiave && p === 'deepseek' ? 'chiave-finta' : undefined), noteAgnes: () => {}, touch: () => {}, endConversation: () => {},
		};
	}

	/** Un cervello finto che risponde secondo chi parla: la risposta di Melissa aspetta (e si ferma quando lei dirige),
	 *  la regia e i personaggi rispondono subito. `visti`: i messaggi di ogni richiesta. */
	function cervelloDiProva(visti, righe) {
		return (messages, tools, onDelta, signal) => {
			visti.push(messages);
			const sys = messages[0].content;
			const user = messages[messages.length - 1].content;
			for (const [chi, testo] of Object.entries(righe)) {
				const vale = chi === 'regia' ? /Una frase breve, al massimo due, nel tuo stile/.test(user)
					: chi === 'somme' ? /Tira le somme tu/.test(user)
					: chi === 'chiusa' ? /Chiudi tu in una o due frasi/.test(user)
					: sys.startsWith(`Sei ${chi}`);
				if (vale) {
					onDelta({ content: testo });
					return Promise.resolve();
				}
			}
			// la risposta di Melissa: quella che poteva essere un rifiuto, e che non si dice
			return new Promise((_, no) => signal.addEventListener('abort', () => no(new Error('interrotta')), { once: true }));
		};
	}

	await test('chi vuole: «passami la nostra amica psicologa» capita dal modello: regia di Melissa, poi la chiamata passa a Krista', async () => {
		const nucleo = nucleoCheParla();
		const viste = [];
		const visti = [];
		const registro = [];
		const { a } = makeAssistant({ nucleo, cervelli: cervelliChiVuole('{"passa": "krista", "chiede": null}', viste), stream: cervelloDiProva(visti, { regia: 'Ok, ti passo Krista.' }) });
		a.out = { info: x => registro.push(x), warn() {}, error() {} };
		a.wire(ctxProva());
		a.state.conversing = true;
		await a.turn('Passami la nostra amica psicologa', true);
		assert.strictEqual(a.getState().personaggio, 'krista');
		assert.ok(nucleo.speaks.some(x => !x.voice && /ti passo Krista/.test(x.text)), 'la regia con la voce di Melissa');
		assert.ok(nucleo.speaks.some(x => x.voice === 'CxyJefqDMJqI9Y7prMgt'), 'saluta con la sua voce');
		const regia = visti.find(m => /Una frase breve/.test(m[m.length - 1].content));
		assert.ok(/Andrea vuole parlare con Krista: passagli la chiamata/.test(regia[1].content), regia[1].content);
		assert.ok(regia[0].content.includes(require(path.join(OUT, "personaggi.js")).REGOLA_REGIA), 'nel carattere di Melissa: non si rifiuta mai');
		assert.ok(!a.getState().log.some(r => /interrotta/.test(r.text)), 'la risposta fermata non resta come interrotta');
		assert.ok(registro.some(x => /^chi vuole: passa krista \(\d+ ms\)$/.test(x)), registro.join(' | '));
		assert.deepStrictEqual(viste[0].extra, { max_tokens: 40, temperature: 0 });
		// sempre DeepSeek Flash, anche con Agnes come cervello scelto (CONTRATTI 9.11)
		assert.deepStrictEqual(viste[0].c, { provider: 'deepseek', model: 'deepseek-flash', effort: 'rapido' });
		assert.ok(/solo con il JSON/.test(viste[0].messages[0].content) && /- krista: Krista, la psicologa/.test(viste[0].messages[0].content), 'il prompt elenca chi c\'e\'');
		assert.ok(/siamo io te e altri» = \{"passa": "elliot", "chiede": \[\], "tutti": true\}/.test(viste[0].messages[0].content), 'il primo esempio vero');
		assert.ok(/parla con gli altri» = \{"passa": null, "chiede": \["krista"\], "tutti": true\}/.test(viste[0].messages[0].content), 'il secondo');
		assert.strictEqual(viste[0].messages[1].content, 'Passami la nostra amica psicologa');
		a.stopConversation?.('fine prova');
	});

	await test('chi vuole: «tutti» porta la regia di Melissa, poi una battuta di ognuno dal suo campo, poi le somme', async () => {
		const nucleo = nucleoCheParla();
		const visti = [];
		const registro = [];
		const { a } = makeAssistant({
			nucleo,
			cervelli: cervelliChiVuole('{"passa": null, "chiede": ["krista"], "tutti": true}'),
			stream: cervelloDiProva(visti, { regia: 'Sentiamo tutti: Krista, comincia tu.', 'Krista Gordon': 'Chiediti perche\' la vuoi.', 'Darlene Alderson': 'Fatti la birra.', 'Elliot Alderson': 'Niente telefono acceso.', somme: 'Insomma: birra si\', canna dopo.' }),
		});
		a.out = { info: x => registro.push(x), warn() {}, error() {} };
		a.wire(ctxProva());
		a.state.conversing = true;
		await a.turn("Melissa c'e' la psicologa se mi fumo una canna, parla con gli altri", true);
		assert.ok(registro.some(x => /^chi vuole: chiede krista, tutti \(\d+ ms\)$/.test(x)), registro.join(' | '));
		const voci = nucleo.speaks.filter(x => x.text && x.final);
		const ordine = voci.map(x => x.voice || 'melissa');
		const K = 'CxyJefqDMJqI9Y7prMgt';
		// la regia, Krista (chiesta) per prima, poi gli altri in ordine, poi Melissa che tira le somme
		const da = ordine.indexOf('melissa');
		assert.deepStrictEqual(ordine.slice(da, da + 5), ['melissa', K, DARLENE, ELLIOT, 'melissa'], JSON.stringify(voci.map(x => [x.voice, x.text])));
		assert.ok(/Sentiamo tutti/.test(voci[da].text) && /canna dopo/.test(voci[da + 4].text));
		// ognuno dal suo campo; chi viene dopo sa cosa hanno detto quelli prima
		const di = n => visti.find(m => m[0].content.startsWith(`Sei ${n}`));
		assert.ok(/solo dal tuo campo \(il lato umano[\s\S]*il lato umano anche di un fatto tecnico/.test(di('Krista Gordon')[1].content));
		assert.ok(/Krista: Chiediti perche' la vuoi\.[\s\S]*non ripeterlo, aggiungi la tua/.test(di('Elliot Alderson')[1].content));
		assert.ok(di('Darlene Alderson')[0].content.includes(require(path.join(OUT, "personaggi.js")).NON_RIPETERE), 'nessuno ripete quello che ha detto un altro');
		// nel registro tutte le battute, col nome davanti
		const log = a.getState().log.map(r => r.text);
		for (const t of ['Krista: Chiediti', 'Darlene: Fatti la birra.', 'Elliot: Niente telefono acceso.', 'Insomma: birra']) assert.ok(log.some(x => x.startsWith(t)), t);
		assert.strictEqual(a.getState().personaggio, 'melissa');
		a.stopConversation?.('fine prova');
	});

	await test('chi vuole: con «chiede» Melissa glielo chiede e lui risponde; JSON rotto o tempo scaduto valgono null', async () => {
		const nucleo = nucleoCheParla();
		const visti = [];
		const { a } = makeAssistant({ nucleo, cervelli: cervelliChiVuole('{"passa": null, "chiede": "elliot"}'), stream: cervelloDiProva(visti, { regia: 'Elliot, dì la tua.', 'Elliot Alderson': 'Le chiavi stanno in un posto solo.', chiusa: 'Visto?' }) });
		a.caso = () => 0.9;
		a.wire(ctxProva());
		a.state.conversing = true;
		await a.turn('e il nostro hacker cosa ne dice?', true);
		assert.ok(nucleo.speaks.some(x => x.voice === ELLIOT && /chiavi/.test(x.text)), 'Elliot risponde');
		assert.ok(nucleo.speaks.some(x => !x.voice && /dì la tua/.test(x.text || '')), 'Melissa glielo chiede');
		assert.strictEqual(a.getState().personaggio, 'melissa');
		a.stopConversation?.('fine prova');
		const giro = scriptedStream([[{ content: 'Ci penso io.' }]]);
		// le risposte che non valgono
		const registro = [];
		for (const [json, atteso] of [['niente JSON qui', null], ['{"passa": "krista"', null], ['{"passa": "tyrell", "chiede": "melissa"}', { passa: null, chiede: [], tutti: false }], ['Ecco: {"passa": "melissa", "chiede": null}', { passa: 'melissa', chiede: [], tutti: false }], ['{"chiede": "elliot"}', { passa: null, chiede: ['elliot'], tutti: false }], ['{"chiede": ["Elliot", "krista", "trenton"], "tutti": "si"}', { passa: null, chiede: ['elliot', 'krista'], tutti: false }]]) {
			const b = makeAssistant({ cervelli: cervelliChiVuole(json) });
			assert.deepStrictEqual(await b.a.chiVuole('passami qualcuno'), atteso, json);
		}
		const lento = makeAssistant({ cervelli: cervelliChiVuole(null) });
		lento.a.out = { info: x => registro.push(x), warn() {}, error() {} };
		const t0 = Date.now();
		assert.strictEqual(await lento.a.chiVuole('passami Cristal Vista'), null, 'tempo scaduto');
		assert.ok(Date.now() - t0 >= 2400 && Date.now() - t0 < 3500, `${Date.now() - t0} ms`);
		assert.ok(/^chi vuole: nessuno \(\d+ ms\)$/.test(registro[0]), registro[0]);
		// senza cervelli e con il cervello finto dei test non parte niente (mai la rete)
		assert.strictEqual(await makeAssistant({ stream: giro }).a.chiVuole('passami Krista'), null);
		// senza chiave DeepSeek nessuna richiesta: mai Agnes al suo posto
		const senza = [];
		assert.strictEqual(await makeAssistant({ cervelli: cervelliChiVuole('{"passa": "krista"}', senza, false) }).a.chiVuole('passami Krista'), null);
		assert.strictEqual(senza.length, 0);
		// una chiave scritta con la maiuscola vale lo stesso
		assert.deepStrictEqual(await makeAssistant({ cervelli: cervelliChiVuole('{"passa": "Krista", "chiede": null}') }).a.chiVuole('passami Cristal'), { passa: 'krista', chiede: [], tutti: false });
	});

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

	await test('personaggi: Melissa da\' la parola a Elliot con passa_parola, Elliot risponde con la sua voce e Melissa chiude', async () => {
		const nucleo = nucleoCheParla();
		const strumenti = [];
		const giro = scriptedStream([
			[{ content: 'Io dico che regge. Elliot, tu che dici?' }, PASSA('elliot')],
			[{ content: 'Regge finche\' nessuno guarda le chiavi.' }],
			[{ content: 'Visto? Paranoico come sempre.' }],
		]);
		const { a } = makeAssistant({ nucleo, stream: (m, tools, ...x) => (strumenti.push(tools.map(t => t.function.name)), giro(m, tools, ...x)) });
		a.wire({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } });
		const detta = await a.turn('regge la build?', true);
		assert.strictEqual(detta, 'Io dico che regge. Elliot, tu che dici?', 'la chiamata non finisce nel testo');
		assert.ok(strumenti[0].includes('passa_parola'), 'Melissa ha lo strumento');
		assert.strictEqual(strumenti.length, 3, 'nessun passo in piu\' del modello dopo passa_parola');
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
			[{ content: 'Regge. Elliot, tu che dici?' }, PASSA('elliot')],
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

	await test('personaggi: un tocco durante le battute a tre lascia nel registro la risposta e le battute gia\' dette', async () => {
		for (const quando of ['prima di Elliot', 'durante la chiusa']) {
			const nucleo = nucleoCheParla();
			const ferma = (onDelta, signal) => new Promise((_, no) => signal.addEventListener('abort', () => no(new Error('interrotta')), { once: true }));
			const passi = quando === 'prima di Elliot'
				? [[{ content: 'Regge. Elliot, tu che dici?' }, PASSA('elliot')], ferma]
				: [[{ content: 'Regge. Elliot, tu che dici?' }, PASSA('elliot')], [{ content: 'Regge, ma le chiavi no.' }], ferma];
			const giro = scriptedStream(passi);
			let chiamate = 0;
			const { a } = makeAssistant({ nucleo, stream: (...x) => (chiamate++, giro(...x)) });
			a.wire(ctxProva());
			const p = a.turn('regge la build?', true);
			await finche(() => chiamate === passi.length);
			nucleo.fire('voice.bargein');
			await p;
			const righe = a.getState().log.map(r => r.text);
			assert.ok(!righe.some(t => /passa_parola/.test(t)), `${quando}: la chiamata non entra nel registro`);
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
			[{ content: 'Regge. Elliot, tu che dici?' }, PASSA('elliot')],
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
		assert.ok(!n2.speaks.some(x => x.voice === ELLIOT), 'col ripiego di Apple, senza strumenti, nessuno viene chiamato');
		assert.ok(n2.speaks.some(x => !x.voice && /Regge/.test(x.text || '')), 'e Melissa parla da sola, senza errori');
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

	await test('personaggi: risponde chi riceve la parola con passa_parola; un nome nel testo, anche con una domanda, no', async () => {
		const nucleo = nucleoCheParla();
		const { a } = makeAssistant({ nucleo, stream: scriptedStream([
			[{ content: 'La build e\' rotta di nuovo. Krista, che ne dici?' }, PASSA('krista')],
			[{ content: 'Dico che la rimanda da tre giorni.' }],
			[{ content: 'Ecco, appunto.' }],
			[{ content: 'Darlene, tu che dici?' }],
		]) });
		a.wire({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } });
		await a.turn('com\'e\' andata la build?', true);
		assert.ok(nucleo.speaks.some(x => x.voice === 'CxyJefqDMJqI9Y7prMgt'), 'Krista risponde con la sua voce');
		nucleo.speaks.length = 0;
		await a.turn('e adesso?', true);
		assert.ok(!nucleo.speaks.some(x => x.voice), 'nessun\'altra voce senza la chiamata');
	});

	// ---------- riempitivi (CONTRATTI 9.11): cosa si dice mentre il modello pensa ----------

	const PG = require(path.join(OUT, 'personaggi.js'));

	await test('riempitivi: col cervello lento parte a 900 ms con la voce di chi ha la chiamata, non dopo la prima frase', async () => {
		const nucleo = nucleoCheParla();
		let libera;
		const lento = onDelta => new Promise(r => setTimeout(() => {
			onDelta({ content: 'Allora, ci penso io. ' });
			libera = () => { onDelta({ content: 'Fatto.' }); r(); };
		}, 1100));
		const { a } = makeAssistant({ nucleo, stream: scriptedStream([lento]) });
		a.wire(ctxProva());
		await a.turn('passami Darlene', true);
		nucleo.speaks.length = 0;
		const p = a.turn('come va il progetto?', true);
		await finche(() => !!libera, 3000);
		const riempitivi = nucleo.speaks.filter(x => x.text && x.final && !x.append);
		assert.strictEqual(riempitivi.length, 1, 'un riempitivo prima della risposta');
		assert.strictEqual(riempitivi[0].voice, DARLENE, 'con la voce di Darlene');
		assert.ok(PG.PERSONAGGI.darlene.riempitivi.domanda.includes(riempitivi[0].text.trim()), 'dal suo gruppo domanda');
		assert.ok(!('model' in riempitivi[0]), 'col modello del Nucleo, quello delle frasi gia\' pronte');
		const prima = nucleo.speaks.find(x => x.append);
		assert.strictEqual(prima.text, 'Ci penso io. ', 'la risposta perde il suo «Allora,»');
		assert.strictEqual(prima.voice, DARLENE, 'e apre un turno di voce suo, con la voce di Darlene');
		assert.strictEqual(a.riempiTimer.length, 0, 'gli altri tempi sono fermi alla prima frase');
		libera();
		await p;
		const detto = riempitivi[0].text.trim();
		assert.ok(a.recentSpeech.some(x => x.text === detto), 'entra nel filtro dell\'eco');
		assert.ok(!a.getState().log.some(r => r.text.includes(detto)), 'non entra nel registro');
		assert.ok(!a.history.some(m => (m.content || '').includes(detto)), 'ne\' nella storia');
		assert.strictEqual(a.getState().log.pop().text, 'Darlene: Ci penso io. Fatto.');
		// il turno dopo, stessa voce: non la stessa frase
		nucleo.speaks.length = 0;
		let libera2;
		a.deps.stream = scriptedStream([onDelta => new Promise(r => setTimeout(() => { libera2 = r; onDelta({ content: 'Si.' }); }, 1000))]);
		const p2 = a.turn('e la build?', true);
		await finche(() => !!libera2, 3000);
		libera2();
		await p2;
		const secondo = nucleo.speaks.find(x => x.text && x.final && !x.append);
		assert.ok(secondo && secondo.text.trim() !== detto, 'la memoria resta tra un turno e l\'altro');
	});

	await test('riempitivi: niente se la risposta parla subito, e Melissa ha la sua voce', async () => {
		const nucleo = nucleoCheParla();
		const { a } = makeAssistant({ nucleo, stream: scriptedStream([[{ content: 'Subito.' }]]) });
		a.wire(ctxProva());
		await a.turn('come va?', true);
		await new Promise(r => setTimeout(r, 950));
		assert.ok(!nucleo.speaks.some(x => x.text && x.final && !x.append), 'nessun riempitivo dopo la fine del turno');
		let libera;
		a.deps.stream = scriptedStream([onDelta => new Promise(r => setTimeout(() => { libera = r; onDelta({ content: 'Eccomi.' }); }, 1000))]);
		const p = a.turn('fammi vedere i lavori', true);
		await finche(() => !!libera, 3000);
		libera();
		await p;
		const r = nucleo.speaks.find(x => x.text && x.final && !x.append);
		assert.ok(r && !r.voice && PG.RIEMPITIVI_MELISSA.ordine.includes(r.text.trim()), 'un ordine, con la voce di Melissa');
	});

	await test('riempitivi: uno strumento lento a risposta partita dice una frase di lunga, una volta', async () => {
		const nucleo = nucleoCheParla();
		const { a, deps } = makeAssistant({ nucleo, stream: scriptedStream([
			[{ content: 'Guardo la bacheca.' }, { tool_call: { index: 0, id: 'c1', name: 'memoria_bacheca', arguments: '{}' } }],
			[{ content: 'Nessuno al lavoro.' }],
		]) });
		deps.bacheca = () => new Promise(r => setTimeout(() => r([]), 1700));
		a.wire(ctxProva());
		await a.turn('chi lavora?', true);
		const testi = nucleo.speaks.filter(x => x.text).map(x => x.text.trim());
		const lunghe = testi.filter(t => PG.RIEMPITIVI_MELISSA.lunga.includes(t));
		assert.strictEqual(lunghe.length, 1, testi.join(' | '));
		assert.ok(!testi.includes('Un attimo.'));
		assert.ok(nucleo.speaks.find(x => x.text && x.text.trim() === lunghe[0]).append, 'nel turno di voce gia\' aperto');
		assert.ok(!a.getState().log.some(r => r.text.includes(lunghe[0])), 'e non nel registro');
	});

	await test('riempitivi: all\'avvio il Nucleo prepara le frasi di ogni voce, una volta', async () => {
		const nucleo = makeNucleo(true);
		const { a } = makeAssistant({ nucleo });
		a.wire(ctxProva());
		nucleo.fire('available');
		const sc = nucleo.reqs.filter(r => r.cmd === 'voice.scalda');
		assert.strictEqual(sc.length, 1);
		const voci = sc[0].args.voci;
		assert.deepStrictEqual(voci.map(v => v.voce), ['', DARLENE, ELLIOT, 'CxyJefqDMJqI9Y7prMgt']);
		assert.ok(voci.every(v => v.testi.length > 10 && v.testi.every(t => !t.includes('{x}'))), 'l\'eco no');
		// un Nucleo che non la conosce: niente si rompe, e si riprova al collegamento dopo
		const vecchio = makeNucleo(true);
		vecchio.request = (cmd, args) => (vecchio.reqs.push({ cmd, args }), cmd === 'voice.scalda' ? Promise.reject(new Error('comando sconosciuto')) : Promise.resolve({}));
		const b = makeAssistant({ nucleo: vecchio });
		b.a.wire(ctxProva());
		await tick();
		vecchio.fire('available');
		assert.strictEqual(vecchio.reqs.filter(r => r.cmd === 'voice.scalda').length, 2);
	});

	await test('personaggi: la chiusa di Melissa non ha lo strumento: la parola torna ad Andrea', async () => {
		const nucleo = nucleoCheParla();
		const sistemi = [];
		const giro = scriptedStream([
			[{ content: 'Regge. Elliot, tu che dici?' }, PASSA('elliot')],
			[{ content: 'Regge, ma le chiavi no.' }],
			[{ content: 'Paranoico. Krista, tu che dici?' }, PASSA('krista')],
			[{ content: 'Dico che la rimanda.' }],
			[{ content: 'Questa non deve arrivare.' }],
		]);
		const { a } = makeAssistant({ nucleo, stream: (m, ...x) => (sistemi.push(m.map(y => y.content).join('\n')), giro(m, ...x)) });
		a.caso = () => 0.9; // nessun passaggio di parola fra loro: col 40% l'altro risponderebbe davvero
		a.wire(ctxProva());
		await a.turn('regge la build?', true);
		assert.strictEqual(sistemi.length, 3, 'Melissa, Elliot, la chiusa: la chiamata della chiusa non conta');
		assert.ok(/senza fare domande a Elliot/.test(sistemi[2]), 'il prompt della chiusa lo chiede');
		assert.ok(/Adesso e' /.test(sistemi[1]), 'con data e ora');
		assert.ok(!nucleo.speaks.some(x => x.voice === 'CxyJefqDMJqI9Y7prMgt'), 'Krista non risponde');
		assert.deepStrictEqual(a.getState().log.map(r => r.text).slice(-2), ['Elliot: Regge, ma le chiavi no.', 'Paranoico. Krista, tu che dici?']);
	});

	await test('personaggi: Andrea si rivolge a Elliot per nome: niente espressioni regolari, lo capisce chiVuole', async () => {
		// senza chiVuole (nessuna chiave DeepSeek) il nome detto da Andrea non chiama nessuno: risponde Melissa
		const nucleo = nucleoCheParla();
		const { a } = makeAssistant({ nucleo, stream: scriptedStream([[{ content: 'Ha sempre ragione lui.' }]]) });
		a.wire(ctxProva());
		await a.turn("Vabbe' Elliot, e tu?", true);
		assert.ok(!nucleo.speaks.some(x => x.voice), 'nessun\'altra voce');
		// con chiVuole, anche col tasto (fuori dalla conversazione): Melissa glielo chiede, ed Elliot risponde
		const n2 = nucleoCheParla();
		const visti = [];
		const b = makeAssistant({ nucleo: n2, cervelli: cervelliChiVuole('{"passa": null, "chiede": ["elliot"], "tutti": false}'), stream: cervelloDiProva(visti, { regia: 'Elliot, dice a te.', Elliot: 'Lo so, amico.', chiusa: 'Visto?' }) });
		b.a.wire(ctxProva());
		await b.a.turn("Vabbe' Elliot, e tu?", true);
		assert.ok(n2.speaks.some(x => x.voice === ELLIOT && /amico/.test(x.text)), 'Elliot risponde');
	});

	await test('personaggi: in conversazione un ospite e\' offerto da subito; deciso solo per argomento o dopo due risposte', async () => {
		for (const [frase, atteso] of [['un film stasera?', "Con te c'e' anche"], ['ho messo la password nel README', 'Stavolta tira dentro Elliot'], ['che palle, la build non va', 'Stavolta tira dentro Krista']]) {
			const nucleo = nucleoCheParla();
			const visti = [];
			const giro = scriptedStream([[{ content: 'Va bene.' }]]);
			const { a } = makeAssistant({ nucleo, stream: (m, ...x) => (visti.push(m[0].content), giro(m, ...x)) });
			a.wire(ctxProva());
			nucleo.fire('hotkey.down'); nucleo.fire('hotkey.up');
			nucleo.fire('voice.final', { text: frase, mode: 'converse' });
			// con l'invito deciso l'ospite entra anche se il modello non chiama passa_parola: conta la prima richiesta
			await finche(() => visti.length >= 1);
			assert.ok(visti[0].includes(atteso), frase);
			a.stopConversation?.('fine prova');
		}
	});

	await test('personaggi: parlano fra loro, chi e\' chiamato da un altro risponde una volta, poi Melissa chiude con tutto il giro', async () => {
		const nucleo = nucleoCheParla();
		const visti = [];
		const giro = scriptedStream([
			[{ content: 'Regge. Elliot, tu che dici?' }, PASSA('elliot')],
			[{ content: 'Regge, ma le chiavi no. Krista, che ne pensi?' }, PASSA('krista')],
			[{ content: 'Penso che lo rimandi. Darlene, tu?' }],
			[{ content: 'Bene, allora domani si sistema.' }],
			[{ content: 'Questa non deve arrivare.' }],
		]);
		const { a } = makeAssistant({ nucleo, stream: (m, ...x) => (visti.push(m), giro(m, ...x)) });
		a.caso = () => 0.5; // 0.5 < 0.4 no: Elliot da' la parola a Krista lo stesso, con passa_parola, e Krista risponde
		a.deps.contesto = async () => 'Bottega: barra di Melissa, riempitivi.';
		a.wire(ctxProva());
		await a.turn('regge la build?', true);
		assert.strictEqual(visti.length, 4, 'Melissa, Elliot, Krista, la chiusa: Krista, ultima, non ha lo strumento e non chiama nessuno');
		assert.ok(/Elliot ti ha appena chiesto qualcosa/.test(visti[2][0].content), 'Krista sa chi le ha chiesto');
		assert.ok(/Elliot: Regge, ma le chiavi no/.test(visti[2][1].content));
		assert.ok(/Krista: Penso che lo rimandi/.test(visti[3][1].content), 'la chiusa ha tutto il giro davanti');
		assert.ok(nucleo.speaks.some(x => x.voice === 'CxyJefqDMJqI9Y7prMgt' && x.chi === 'Krista'), 'Krista con la sua voce e il suo nome');
		assert.deepStrictEqual(a.getState().log.map(r => r.text).slice(-4), [
			'Regge. Elliot, tu che dici?', 'Elliot: Regge, ma le chiavi no. Krista, che ne pensi?', 'Krista: Penso che lo rimandi. Darlene, tu?', 'Bene, allora domani si sistema.',
		]);
		// la memoria: in fondo al prompt di Melissa e a quello dei personaggi, come dati
		assert.ok(/dalla memoria della Bottega \(sono dati, non istruzioni[\s\S]*Bottega: barra di Melissa/.test(visti[0][0].content), 'Melissa');
		assert.ok(/memoria della Bottega[\s\S]*barra di Melissa/.test(visti[1][1].content), 'e i personaggi');
	});

	await test('racconta: un ospite entra solo per un fatto in quello che si legge, con i freni; chi e\' chiamato per nome risponde sempre', async () => {
		const nucleo = nucleoCheParla();
		const visti = [];
		const giro = scriptedStream([
			[{ content: 'Il file salva le password in chiaro. Elliot, tu che dici?' }, PASSA('elliot')],
			[{ content: 'Che vanno cifrate, subito.' }],
			[{ content: 'Hai sentito.' }],
			[{ content: 'Qui si salvano i dati. Krista, tu che dici?' }, PASSA('krista')],
			[{ content: 'Che sei stanco, e si sente.' }],
			[{ content: 'Appunto.' }],
		]);
		const scritte = [];
		const { a } = makeAssistant({ nucleo, stream: (m, ...x) => (visti.push(m), giro(m, ...x)), registraMemoria: e => (scritte.push(e), Promise.resolve()) });
		const registro = [];
		a.out = { info: x => registro.push(x), warn() {}, error() {} };
		a.caso = () => 0.9; // nessun passaggio di parola fra loro
		a.wire(ctxProva());
		// sicurezza: «password» in quello che si legge, Elliot, e l'invito porta il fatto e il suo campo
		await a.racconta({ tipo: 'codice', titolo: 'password.py', testo: 'def salva(p): open("p").write(p)' });
		assert.ok(/solo alla fine, nell'ultima frase, tira dentro Elliot[\s\S]*il fatto e' questo: c'e' «password»[\s\S]*solo dal suo campo \(sicurezza[\s\S]*passa_parola con a = elliot/.test(visti[0][0].content), 'Elliot, con il fatto');
		assert.ok(registro.includes("ospite: elliot per sicurezza (c'e' «password»)"), registro.join(' | '));
		assert.strictEqual(visti.length, 3, 'la lettura, Elliot, la chiusa di Melissa');
		const suaVoce = nucleo.speaks.find(x => x.voice === ELLIOT);
		assert.ok(suaVoce && /cifrate/.test(suaVoce.text), 'Elliot parla con la sua voce');
		assert.ok(!nucleo.speaks.some(x => /passa_parola/.test(x.text || '')), 'la chiamata non si legge');
		// la memoria, nello spool della Memoria: l'intervento e la chiusa si ricordano, la lettura lunga no
		assert.ok(scritte.some(e => e.source === 'personaggio' && e.sid === 'elliot' && e.who === 'elliot' && e.text === 'Che vanno cifrate, subito.'));
		assert.ok(scritte.some(e => e.sid === 'melissa' && e.text === 'Hai sentito.'));
		assert.ok(!scritte.some(e => /salva le password/.test(e.text)), 'la lettura di «racconta» no');
		// entro un minuto dall'ultimo ospite la fine della lettura non basta: niente invito, e il registro lo dice
		await finche(() => !a.getState().raccontando);
		await a.racconta({ tipo: 'codice', titolo: 'db.py', testo: 'def salva(d): pass' });
		assert.ok(!/passa_parola con a/.test(visti[3][0].content), 'nessun invito');
		assert.ok(registro.includes("ospite: niente, fine fermato da pausa di 60 s dall'ultimo ospite"), registro.join(' | '));
		assert.ok(nucleo.speaks.some(x => x.voice === 'CxyJefqDMJqI9Y7prMgt' && /stanco/.test(x.text)), 'ma Krista, che riceve la parola, risponde');
		// passato il minuto, la fine della lettura e' un fatto: Darlene, l'unica con `fine`
		const altri = [];
		const fine = scriptedStream([[{ content: 'Salva i dati.' }]]);
		const b = makeAssistant({ nucleo: nucleoCheParla(), stream: (m, ...x) => (altri.push(m), fine(m, ...x)) });
		b.a.wire(ctxProva());
		await b.a.racconta({ tipo: 'codice', titolo: 'db.py', testo: 'def salva(d): pass' });
		assert.ok(/tira dentro Darlene[\s\S]*la lettura di db\.py e' finita[\s\S]*passa_parola con a = darlene/.test(altri[0][0].content), 'Darlene per la fine');
	});

	await test('ospiti dai fatti: occasione(), un caso per tipo, la precedenza, a turno fra i tre, ognuno col suo campo', async () => {
		// a mezzogiorno, se non si dice altro: di notte entrerebbe Krista per l'umore
		const o = (ap, st = {}) => {
			const r = PG.occasione(ap, { ora: 12, ...st });
			return r && `${r.tipo} ${r.chi}`;
		};
		const ko = "Claude lancia npm test\nNon e' andata: npm test ha dato errore";
		const ko3 = `${ko}\n${ko}\n${ko}`;
		// un caso per tipo
		assert.strictEqual(o('Claude legge il file .env'), 'sicurezza elliot');
		assert.strictEqual(o(`${ko}\n${ko}`), 'errore elliot', 'due errori di fila: Elliot (errori_ripetuti 2)');
		assert.strictEqual(o('Claude lancia vercel deploy --prod'), 'rischio darlene');
		assert.strictEqual(o('Claude scrive: Ho finito. Vuoi che faccia il commit?'), 'scelta darlene');
		assert.strictEqual(o('Claude legge a.ts', { fine: 'Claude ha finito il turno' }), 'fine darlene');
		assert.strictEqual(o('', { richiesta: 'che palle, non va niente' }), 'umore krista', 'uno sfogo');
		assert.strictEqual(o('', { richiesta: 'lo sistemo domani' }), 'umore krista', 'le sue parole');
		assert.strictEqual(o('', { silenzioMs: 25_000 }), 'attesa darlene');
		// null quando non c'e' niente
		assert.strictEqual(o('Claude legge a.ts'), null);
		assert.strictEqual(o('', { silenzioMs: 24_999 }), null);
		assert.strictEqual(o(ko), null, 'un errore solo');
		assert.strictEqual(o(`${ko}\n${ko.split('\n')[0]}\nClaude legge a.ts`), null, 'gli errori si contano dall\'ultima azione andata a buon fine');
		assert.strictEqual(o('Claude scrive: Tutto chiaro?'), null, 'una domanda senza scelta');
		assert.strictEqual(o('', { richiesta: 'aggiungi un test al parser' }), null, 'una richiesta qualunque');
		// "firma", "token", "certificat", "permess" non chiamano piu' Elliot
		assert.strictEqual(o('Claude controlla la firma del certificato, il token di accesso e i permessi'), null);
		assert.strictEqual(o('Claude rinnova il token', { fine: 'finito' }), 'fine darlene');
		// la precedenza: vince il primo che c'e'
		const tutto = `Claude lancia sudo rm -rf build\n${ko}\n${ko}\nClaude lancia vercel deploy\nClaude scrive: Procedo?`;
		assert.strictEqual(o(tutto, { fine: 'finito', silenzioMs: 30_000, ora: 2 }), 'sicurezza elliot');
		assert.strictEqual(o(`${ko}\n${ko}\nClaude lancia vercel deploy`), 'errore elliot', 'errore prima di rischio');
		assert.strictEqual(o('Claude lancia psql -c "drop table utenti"\nClaude scrive: Quale preferisci?'), 'rischio darlene', 'rischio prima di scelta');
		assert.strictEqual(o('Claude scrive: Procedo con la migrazione?', { fine: 'finito' }), 'scelta darlene', 'scelta prima di fine');
		assert.strictEqual(o('', { fine: 'finito', ora: 2 }), 'fine darlene', 'fine prima di umore');
		assert.strictEqual(o('', { silenzioMs: 30_000, ora: 2 }), 'umore krista', 'umore prima di attesa');
		// a turno fra chi ha il tipo, sempre diverso dall'ultimo ospite
		const giro = (ap, st = {}) => {
			const recenti = [];
			for (let i = 0; i < 6; i++) recenti.push(PG.occasione(ap, { ora: 12, ...st, recenti }).chi);
			return recenti.join(' ');
		};
		assert.strictEqual(giro('Claude scrive: Quale preferisci?'), 'darlene elliot krista darlene elliot krista', 'scelta: tutti e tre');
		assert.strictEqual(giro('', { silenzioMs: 30_000 }), 'darlene elliot krista darlene elliot krista', 'attesa: tutti e tre');
		assert.strictEqual(giro('', { fine: 'finito' }), 'darlene krista darlene krista darlene krista');
		assert.strictEqual(giro(ko3), 'elliot krista elliot krista elliot krista', 'errore: Krista dal terzo di fila');
		assert.strictEqual(giro('Claude lancia vercel deploy'), 'darlene elliot darlene elliot darlene elliot');
		assert.strictEqual(o('Claude scrive: Quale preferisci?', { recenti: ['elliot', 'darlene'] }), 'scelta krista', 'prima chi non e\' ancora entrato');
		assert.strictEqual(o('Claude scrive: Quale preferisci?', { recenti: ['krista', 'elliot', 'darlene'] }), 'scelta krista', 'poi chi e\' entrato da piu\' tempo');
		assert.strictEqual(o('Claude lancia vercel deploy', { ultimo: 'krista' }), 'rischio darlene', 'con il solo ultimo, a parita\' l\'ordine');
		// rischio guarda solo le azioni, non la prosa
		assert.strictEqual(o('Claude scrive: dopo facciamo il deploy in produzione.'), null);
		assert.strictEqual(o('def deploy(): run("rm -rf build")'.replace('rm -rf', 'cancella')), null, 'il testo di un file non e\' un\'azione');
		assert.strictEqual(o(`${ko}\n${ko}`, { erroriDiFila: 1 }), null, 'gli errori contati da chi chiama');
		assert.strictEqual(o('Claude legge .env', { ultimo: 'elliot' }), 'sicurezza elliot', 'uno solo: anche se era l\'ultimo');
		// rischio e sicurezza non vanno mai a Krista, che non li ha
		for (const ultimo of ['', 'elliot', 'darlene', 'krista']) {
			for (const ap of ['Claude lancia git reset --hard', 'Claude lancia vercel deploy', 'Claude legge il file .env', 'Claude lancia sudo make']) {
				assert.ok(!/krista/.test(o(ap, { ultimo }) || ''), `${ap} con ultimo ${ultimo}`);
			}
		}
		// Krista per uno sfogo e di notte (ora locale >= 23 o < 6), al massimo una volta ogni 20 minuti
		assert.strictEqual(o('Claude legge a.ts', { ora: 23 }), 'umore krista');
		assert.strictEqual(o('Claude legge a.ts', { ora: 5 }), 'umore krista');
		assert.strictEqual(o('Claude legge a.ts', { ora: 6 }), null);
		assert.strictEqual(o('Claude legge a.ts', { ora: 22 }), null);
		assert.strictEqual(o('', { ora: 2, dallUmoreMs: 19 * 60_000 }), null, 'entro 20 minuti no');
		assert.strictEqual(o('', { ora: 2, dallUmoreMs: 20 * 60_000 }), 'umore krista');
		assert.strictEqual(o('', { richiesta: 'odio questo progetto', dallUmoreMs: 60_000, silenzioMs: 30_000 }), 'attesa darlene', 'si passa al fatto dopo');
		// il fatto, per l'invito e il registro
		assert.strictEqual(PG.occasione('Claude lancia sudo make install', { ora: 12 }).fatto, "c'e' «sudo»");
		assert.strictEqual(PG.occasione(ko3, { ora: 12 }).fatto, 'terzo errore di fila', 'come nella mod e nel contratto');
		assert.strictEqual(PG.occasione('', { silenzioMs: 31_000, ora: 12 }).fatto, 'nessun appunto nuovo da 31 s');
		assert.strictEqual(PG.occasione('', { ora: 2 }).fatto, "sono le 2 e Andrea e' ancora al lavoro");
		// i freni
		assert.strictEqual(PG.ATTESA_MS, 25_000);
		assert.ok(PG.frenoOspite('fine', 59_000));
		assert.strictEqual(PG.frenoOspite('rischio', 60_000), null);
		assert.strictEqual(PG.frenoOspite('sicurezza', 30_000), null, 'per sicurezza bastano 30 s');
		assert.ok(PG.frenoOspite('errore', 29_000));
		// l'invito: a ognuno si chiede dal suo campo; a Krista, anche su un errore o una scelta, il lato umano
		const perKrista = PG.invitoRacconto('krista', '3 errori di fila');
		assert.ok(perKrista.includes(`solo dal suo campo (${PG.PERSONAGGI.krista.ruolo_cronaca}): il lato umano anche di un fatto tecnico, mai dettagli di file, errori o comandi`), perKrista);
		assert.ok(/il fatto e' questo: 3 errori di fila[\s\S]*passa_parola con a = krista/.test(perKrista));
		const perElliot = PG.invitoRacconto('elliot', '3 errori di fila');
		assert.ok(perElliot.includes(`solo dal suo campo (${PG.PERSONAGGI.elliot.ruolo_cronaca})`) && !/lato umano/.test(perElliot));
		assert.ok(/lato umano/.test(PG.invito('krista', true)), 'anche nella chiacchierata');
		for (const k of PG.ORDINE) assert.ok(!/[–—]/.test(PG.invitoRacconto(k, 'x') + PG.invito(k, true) + PG.invito(k, false) + PG.chiamaCon(k)));
	});

	await test('chiacchierata: senza le sue parole l\'ospite e chi riceve la parola hanno `chiacchiera`; uno sfogo sceglie Krista', async () => {
		assert.deepStrictEqual(PG.daChiacchiera(), ['darlene', 'elliot', 'krista']);
		assert.deepStrictEqual(PG.daChiacchiera(['elliot']), ['darlene', 'krista'], 'a chi Elliot passa la parola');
		assert.deepStrictEqual([0, 0.6].map(c => PG.ospiteDellaFrase('un film stasera?', 'darlene', c)), ['elliot', 'krista'], 'a caso, diverso dall\'ultimo');
		assert.strictEqual(PG.ospiteDellaFrase('lo faccio domani', 'krista', 0), 'krista', 'per le sue parole');
		assert.strictEqual(PG.ospiteDellaFrase('che palle, la build non va', 'darlene', 0), 'krista', 'e per uno sfogo');
		assert.strictEqual(PG.perSfogo('che palle, la build non va'), 'krista');
		assert.strictEqual(PG.perSfogo('come va la build?'), null);
		// nel giro: Melissa chiama Darlene, che al 40% passa la parola a uno degli altri due
		const nucleo = nucleoCheParla();
		const visti = [];
		const giro = scriptedStream([[{ content: 'Darlene, tu che dici?' }, PASSA('darlene')], [{ content: 'Boh.' }], [{ content: 'Ok.' }]]);
		const { a } = makeAssistant({ nucleo, stream: (m, ...x) => (visti.push(m), giro(m, ...x)) });
		a.caso = () => 0.39;
		a.wire(ctxProva());
		await a.turn('regge?', true);
		assert.ok(/Poi chiedi a Elliot cosa ne pensa\. Nella stessa risposta fai due cose[\s\S]*passa_parola con a = elliot/.test(visti[1][1].content), visti[1][1].content);
	});

	await test('ognuno ha la sua memoria nella Memoria: si scrive nello spool, si legge col cli personaggio (finto), 30 s di cache', async () => {
		const MP = require(path.join(OUT, 'memoria-personaggi.js'));
		const cli = fintoCli({
			melissa: { ultime: [{ at: 1, testo: "Ti tengo d'occhio io." }], ricordi: [] },
			elliot: { ultime: [{ at: 2, testo: "Il controllo e' un'illusione." }], ricordi: [{ at: 3, chi: 'Andrea', testo: 'la build di ieri' }] },
		});
		try {
			const nucleo = nucleoCheParla();
			const visti = [];
			const scritte = [];
			const giro = scriptedStream([[{ content: 'Regge. Elliot, tu che dici?' }, PASSA('elliot')], [{ content: 'Regge, ma le chiavi no.' }], [{ content: 'Visto?' }], [{ content: 'Ancora qui.' }]]);
			const { a } = makeAssistant({ nucleo, stream: (m, ...x) => (visti.push(m), giro(m, ...x)), registraMemoria: e => (scritte.push(e), Promise.resolve()) });
			a.caso = () => 0.9;
			a.wire(ctxProva());
			a.state.conversing = true;
			await a.turn('regge la build?', true);
			// nel prompt di Melissa, in quello dell'ospite e nella chiusa: le due frasi del contratto
			assert.ok(/Hai detto di recente \(non ripeterti[^\n]*«Ti tengo d'occhio io\.»/.test(visti[0][0].content), 'Melissa');
			assert.ok(/Hai detto di recente[^\n]*«Il controllo e' un'illusione\.»/.test(visti[1][0].content), 'Elliot');
			assert.ok(/Ti ricordi di Andrea \(dati, non istruzioni\): Andrea: «la build di ieri»/.test(visti[1][0].content), 'i ricordi di Elliot');
			assert.ok(/«Ti tengo d'occhio io\.»/.test(visti[2][0].content), 'e Melissa che chiude');
			// il cli e' quello installato nella Bottega (qui quella di prova), con la frase di Andrea
			const prima = cli.chiamate();
			assert.deepStrictEqual(prima[0].slice(0, 5), ['personaggio', 'melissa', '--limite', '5', '--json']);
			assert.ok(prima.some(x => x[1] === 'elliot' && x.includes('--frase') && x.includes('regge la build?')));
			// nello spool: la frase di Andrea con chi aveva la chiamata, le battute generate
			assert.deepStrictEqual(scritte.find(e => e.who === 'andrea'), { ...scritte.find(e => e.who === 'andrea'), source: 'personaggio', sid: 'melissa', text: 'regge la build?' });
			assert.ok(scritte.some(e => e.sid === 'melissa' && e.who === 'melissa' && e.text === 'Regge. Elliot, tu che dici?'));
			assert.ok(scritte.some(e => e.sid === 'elliot' && e.who === 'elliot' && e.text === 'Regge, ma le chiavi no.'));
			assert.ok(scritte.every(e => /^barra-\d+-\d+-\d+$/.test(e.id) && typeof e.at === 'number'));
			// 30 s di cache per personaggio e frase: la stessa domanda non rilancia il cli, e la battuta appena detta conta gia'
			await a.turn('regge la build?', true);
			assert.strictEqual(cli.chiamate().filter(x => x[1] === 'melissa').length, 1, 'una sola lettura per Melissa');
			assert.ok(/«Regge\. Elliot, tu che dici\?»/.test(visti[3][0].content), 'la sua ultima battuta, senza aspettare la cache');
			// cambiando argomento si rilegge: prima arrivavano i ricordi della domanda prima
			await a.turn('e il backup?', true);
			assert.ok(cli.chiamate().some(x => x[1] === 'melissa' && x.includes('e il backup?')), 'frase nuova, lettura nuova');
			// il saluto fisso non va nella memoria
			const n = scritte.length;
			await a.turn('passami Darlene', true);
			assert.ok(!scritte.slice(n).some(e => e.who === 'darlene'), 'il saluto fisso no');
			assert.ok(scritte.slice(n).some(e => e.who === 'andrea' && e.sid === 'darlene'), 'la frase di Andrea, con chi ha chiamato');
		} finally {
			cli.togli();
		}
		// una Memoria che non conosce ancora il comando, o lenta: niente, in silenzio, entro 1,5 s
		const ignoto = fintoCli({}, 'sconosciuto');
		try {
			assert.strictEqual(await new MP.MemoriaPersonaggi().leggi('elliot', 'ciao'), '');
		} finally {
			ignoto.togli();
		}
		const lento = fintoCli({ elliot: { ultime: [{ at: 1, testo: 'tardi' }], ricordi: [] } }, 'lento');
		try {
			const t0 = Date.now();
			assert.strictEqual(await new MP.MemoriaPersonaggi().leggi('elliot', 'ciao'), '');
			assert.ok(Date.now() - t0 < 2200, `${Date.now() - t0} ms`);
		} finally {
			lento.togli();
		}
		// senza cli: niente, e senza chi scrive nessun errore
		const m = new MP.MemoriaPersonaggi();
		assert.strictEqual(await m.leggi('krista'), '');
		m.scrivi('krista', 'krista', 'ciao');
		assert.deepStrictEqual(MP.leggiMemoriaPersonaggio('rotto'), { ultime: [], ricordi: [] });
	});

	await test('personaggi: nel 40% dei casi l\'ospite riceve l\'invito a passare la parola a un altro', async () => {
		const nucleo = nucleoCheParla();
		const visti = [];
		const giro = scriptedStream([[{ content: 'Elliot, tu che dici?' }, PASSA('elliot')], [{ content: 'Boh. Darlene?' }], [{ content: 'Io dico di si.' }], [{ content: 'Ok.' }]]);
		const { a } = makeAssistant({ nucleo, stream: (m, ...x) => (visti.push(m), giro(m, ...x)) });
		a.caso = () => 0.1;
		a.wire(ctxProva());
		await a.turn('regge?', true);
		assert.ok(/Poi chiedi a Darlene cosa ne pensa\. Nella stessa risposta/.test(visti[1][1].content), visti[1][1].content);
		// la parola a Darlene l'ha decisa il codice: risponde anche se Elliot non ha chiamato lo strumento
		assert.strictEqual(visti.length, 4, 'Melissa, Elliot, Darlene, la chiusa');
		assert.ok(nucleo.speaks.some(x => x.voice === DARLENE && /si/.test(x.text)));
	});

	await test('etichette: chi parla e\' il personaggio, nel giro a tre e col Nucleo che lo dice', async () => {
		const nucleo = nucleoCheParla();
		const stati = [];
		const giro = scriptedStream([[{ content: 'Elliot, tu che dici?' }, PASSA('elliot')], [{ content: 'Le chiavi.' }], [{ content: 'Visto?' }]]);
		const { a, deps } = makeAssistant({ nucleo, stream: giro });
		deps.onState = st => stati.push(st.parla);
		a.caso = () => 0.9; // nessun passaggio di parola fra loro: col 40% l'altro risponderebbe davvero
		a.wire(ctxProva());
		await a.turn('regge?', true);
		assert.deepStrictEqual(stati.filter((x, i) => x && x !== stati[i - 1]), ['melissa', 'elliot', 'melissa'], 'si cambia quando parte la battuta');
		assert.ok(nucleo.speaks.filter(x => x.text).every(x => x.chi), 'ogni turno di voce porta il nome di chi parla');
		// un Nucleo che dice chi suona: da li' in poi conta lui
		nucleo.fire('voice.spoken', { text: 'x', chi: 'Elliot' });
		assert.strictEqual(a.getState().parla, 'elliot');
		a.direCon('altro', undefined, 'melissa');
		assert.strictEqual(a.getState().parla, 'elliot', 'accodata non basta');
		nucleo.fire('voice.spoken', { text: 'altro', chi: 'Melissa' });
		assert.strictEqual(a.getState().parla, 'melissa');
	});

	await test('personaggi: funzioni pure, stesse regole dell\'iPhone', async () => {
		const p = require(path.join(OUT, 'personaggi.js'));
		assert.strictEqual(p.chiChiede('Passami Darlene'), 'darlene');
		assert.strictEqual(p.chiChiede('voglio parlare con mr robot'), 'elliot');
		assert.strictEqual(p.chiChiede('passami il sale'), null);
		assert.strictEqual(p.chiChiede('ridammi Melissa'), 'melissa');
		assert.strictEqual(p.ospiteDellaFrase('ho messo la password nel README', '', 0), 'elliot');
		assert.strictEqual(p.ospiteDellaFrase('lo faccio domani', '', 0), 'krista');
		assert.strictEqual(p.ospiteDellaFrase('un film?', 'darlene', 0), 'elliot');
		assert.ok(p.invito('krista', true).startsWith('Stavolta tira dentro Krista'));
		assert.ok(p.invito('krista', false).startsWith("Con te c'e' anche Krista"));
		assert.strictEqual(p.invito(null, true), '');
		for (const k of p.ORDINE) assert.ok(!p.cuore(p.PERSONAGGI[k], '').includes('\u2014'));
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
			assert.deepStrictEqual(r.occasioni, [], 'senza occasioni non entra da solo');
			assert.strictEqual(p.occasione('Claude scrive: Vuoi che lo faccia?', { fine: 'finito', silenzioMs: 99_000, ora: 2, richiesta: 'che palle' }), null);
			assert.deepStrictEqual(p.occasione('Claude lancia sudo make'), { tipo: 'sicurezza', chi: 'robot', fatto: "c'e' «sudo»" }, 'sicurezza va a chi ha le parole, anche senza occasioni');
			assert.strictEqual(p.ospiteDellaFrase('le chiavi', 'tyrell', 0), null, 'nessuna eccezione: senza parole valide e senza `chiacchiera`, nessuno');
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
