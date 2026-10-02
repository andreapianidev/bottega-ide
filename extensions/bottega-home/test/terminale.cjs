#!/usr/bin/env node
// Banco di prova del terminale nella Bottega (src/terminale.ts e src/terminale-host.ts): la cartella giusta, il
// profilo di iTerm2, lo script che apre iTerm2 (provato senza aprire iTerm2: execFile finto), lo spostamento nella
// barra di destra (su un database finto in una cartella temporanea) e i colori dei temi. Dati inventati.

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const assert = require('assert');
const { execFileSync, spawn, spawnSync } = require('child_process');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'test-out', 'terminale');
esbuild.buildSync({ entryPoints: ['terminale', 'terminale-host', 'terminale-agnes', 'cervello', 'cervelli', 'cline'].map(n => path.join(SRC, n + '.ts')), outdir: OUT, format: 'cjs', platform: 'node', bundle: false, target: 'node20', logLevel: 'silent' });

const TEMI = path.join(__dirname, '..', '..', 'bottega-theme');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-terminale-'));

// ---------- finto modulo vscode ----------
class Uri {
	constructor(fsPath, scheme = 'file') {
		this.fsPath = fsPath;
		this.scheme = scheme;
	}
	static file(p) {
		return new Uri(p);
	}
}
class TabInputTerminal {}
const mondo = {
	config: {},
	comandi: {},
	creati: [],
	messaggi: [],
	terminali: [],
	cartelle: [],
	editor: undefined,
	schedaAttiva: undefined,
	tema: 2,
	aperto: undefined,
};
const nulla = () => ({ dispose() {} });
const vscode = {
	Uri,
	TabInputTerminal,
	TerminalLocation: { Panel: 1, Editor: 2 },
	ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
	env: { appRoot: path.join(TMP, 'Bottega.app', 'Contents', 'Resources', 'app') },
	window: {
		createOutputChannel: () => ({ info() {}, warn() {}, dispose() {} }),
		get activeTerminal() {
			return undefined;
		},
		get terminals() {
			return mondo.terminali;
		},
		get activeTextEditor() {
			return mondo.editor;
		},
		get activeColorTheme() {
			return { kind: mondo.tema };
		},
		tabGroups: {
			get activeTabGroup() {
				return { activeTab: mondo.schedaAttiva };
			},
			get all() {
				return [{ tabs: mondo.schedaAttiva ? [mondo.schedaAttiva] : [] }];
			},
		},
		onDidChangeActiveTerminal: nulla,
		onDidCloseTerminal: nulla,
		onDidOpenTerminal: fn => ((mondo.aperto = fn), nulla()),
		onDidChangeActiveColorTheme: nulla,
		createTerminal(o) {
			const t = { name: 'zsh', creationOptions: o, show() {}, dispose() {} };
			mondo.creati.push(o);
			mondo.terminali.push(t);
			return t;
		},
		showInformationMessage: m => (mondo.messaggi.push(m), Promise.resolve(undefined)),
		showWarningMessage: m => (mondo.messaggi.push(m), Promise.resolve(undefined)),
	},
	workspace: {
		getConfiguration: sez => ({ get: (k, d) => (`${sez}.${k}` in mondo.config ? mondo.config[`${sez}.${k}`] : d) }),
		get workspaceFolders() {
			return mondo.cartelle.map(p => ({ uri: Uri.file(p) }));
		},
		onDidChangeConfiguration: nulla,
	},
	extensions: {
		getExtension: id => (id === 'andreapiani.bottega-theme' ? { extensionPath: TEMI, packageJSON: JSON.parse(fs.readFileSync(path.join(TEMI, 'package.json'), 'utf8')) } : undefined),
		onDidChange: nulla,
	},
	commands: {
		registerCommand: (id, fn) => ((mondo.comandi[id] = fn), nulla()),
		executeCommand: () => Promise.resolve(),
	},
};
const origLoad = Module._load;
Module._load = function (request) {
	if (request === 'vscode') return vscode;
	return origLoad.apply(this, arguments);
};

const T = require(path.join(OUT, 'terminale.js'));
const H = require(path.join(OUT, 'terminale-host.js'));

let passed = 0, failed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log('  ok  ' + name);
	} catch (e) {
		failed++;
		console.log('FAIL  ' + name + '\n      ' + String((e && e.stack) || e).split('\n').slice(0, 4).join('\n      '));
	}
}
const attendi = ms => new Promise(r => setTimeout(r, ms));
const sql = (db, s) => execFileSync('/usr/bin/sqlite3', [db, s], { encoding: 'utf8' }).trim();

(async () => {
	// un piccolo albero finto: un repository, un suo worktree, una cartella senza git, una home con i dotfile sotto git
	const casa = path.join(TMP, 'casa');
	const repo = path.join(casa, 'prototipi', 'Esempio');
	const wt = path.join(repo, '.claude', 'worktrees', 'agente');
	const libera = path.join(casa, 'appunti');
	for (const d of [path.join(repo, '.git'), path.join(repo, 'src', 'viste'), path.join(wt, 'src'), libera]) fs.mkdirSync(d, { recursive: true });
	fs.mkdirSync(path.join(casa, '.git'));
	fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../../../.git/worktrees/agente\n');
	const esiste = p => fs.existsSync(p);

	await test('la radice git: repository, worktree, e mai la home', () => {
		assert.strictEqual(T.radiceGit(path.join(repo, 'src', 'viste'), casa, esiste), repo);
		assert.strictEqual(T.radiceGit(path.join(wt, 'src'), casa, esiste), wt, 'un worktree e\' la sua cartella, non il repository principale');
		assert.strictEqual(T.radiceGit(libera, casa, esiste), undefined, 'la home con .git non conta');
	});

	await test('la cartella corrente: sessione, poi file, poi workspace, poi home', () => {
		const base = { workspace: [], home: casa };
		assert.strictEqual(T.cartellaCorrente({ ...base, sessione: wt, file: path.join(repo, 'src', 'viste', 'a.swift') }, esiste), wt);
		assert.strictEqual(T.cartellaCorrente({ ...base, file: path.join(repo, 'src', 'viste', 'a.swift') }, esiste), repo);
		assert.strictEqual(T.cartellaCorrente({ ...base, file: path.join(wt, 'src', 'b.ts') }, esiste), wt);
		// workspace aperto su una sottocartella del repository: vince la piu' interna
		assert.strictEqual(T.cartellaCorrente({ ...base, workspace: [path.join(repo, 'src')], file: path.join(repo, 'src', 'viste', 'a.swift') }, esiste), path.join(repo, 'src'));
		assert.strictEqual(T.cartellaCorrente({ ...base, file: path.join(libera, 'nota.md') }, esiste), libera);
		assert.strictEqual(T.cartellaCorrente({ ...base, workspace: [repo, libera] }, esiste), repo);
		assert.strictEqual(T.cartellaCorrente({ ...base, sessione: path.join(TMP, 'sparita') }, esiste), casa, 'una sessione in una cartella sparita non vale');
		assert.strictEqual(T.cartellaDi(path.join(repo, 'src'), true), path.join(repo, 'src'));
		assert.strictEqual(T.cartellaDi(path.join(repo, 'src', 'x.ts'), false), path.join(repo, 'src'));
	});

	await test('iTerm2 con execFile e argomenti: la cartella non entra mai nello script', () => {
		const strana = "/tmp/Esempio con spazi/l'apostrofo $(rm -rf ~) `x`; echo";
		const c = T.comandoEsterno('iterm2', strana, true);
		assert.strictEqual(c.file, '/usr/bin/osascript');
		assert.deepStrictEqual(c.args.slice(-2), [strana, 'Bottega']);
		assert.ok(c.args.slice(0, -2).every((a, i) => (i % 2 === 0 ? a === '-e' : !a.includes(strana))));
		assert.ok(c.args.includes('set w to (create window with profile profilo)'));
		const senza = T.comandoEsterno('iterm2', strana, false);
		assert.deepStrictEqual([senza.file, ...senza.args], ['/usr/bin/open', '-a', 'Terminal', strana]);
		assert.ok(/iTerm2 non e' installato/.test(senza.avviso));
		assert.strictEqual(T.comandoEsterno('terminal', strana, true).avviso, undefined, 'Terminale scelto: niente avviso');
	});

	await test('la citazione dello script regge spazi, apostrofi e $(...) (osascript senza iTerm2, sh senza cd)', () => {
		if (spawnSync('/usr/bin/osascript', ['-e', 'return 1']).status !== 0) return console.log('      (osascript assente, salto)');
		const strana = "/tmp/Esempio con spazi/l'apostrofo $(echo BUCATO) `echo BUCATO`; echo BUCATO";
		// lo stesso script, con il blocco di iTerm2 sostituito da un return del testo che verrebbe scritto
		const righe = T.SCRIPT_ITERM.filter(r => !/application "iTerm"|^activate$|create window|^end tell$/.test(r)).map(r =>
			r.startsWith('tell current session') ? r.replace(/^tell current session of w to write text /, 'return ') : r,
		);
		const testo = execFileSync('/usr/bin/osascript', [...righe.flatMap(r => ['-e', r]), strana, 'Bottega'], { encoding: 'utf8' }).trim();
		assert.ok(testo.startsWith('cd ') && testo.endsWith(' && clear'), testo);
		const parola = testo.slice(3, -' && clear'.length);
		const eco = execFileSync('/bin/sh', ['-c', `printf %s ${parola}`], { encoding: 'utf8' });
		assert.strictEqual(eco, strana, 'la shell deve vedere la cartella tale e quale');
	});

	await test('colori e carattere per iTerm2', () => {
		assert.deepStrictEqual(T.coloreIterm('#ff8000'), { 'Red Component': 1, 'Green Component': 0.502, 'Blue Component': 0, 'Alpha Component': 1, 'Color Space': 'sRGB' });
		const mezzo = T.coloreIterm('#ffffff80', '#000000');
		assert.ok(Math.abs(mezzo['Red Component'] - 0.502) < 0.001, 'il trasparente si fonde sullo sfondo');
		assert.strictEqual(T.coloreIterm('rosso'), undefined);
		assert.strictEqual(T.fontIterm("'SF Mono', Menlo, monospace", 12.5), 'SFMono-Regular 12.5');
		assert.strictEqual(T.fontIterm('Menlo', undefined), 'Menlo-Regular 13');
		assert.strictEqual(T.fontIterm('"Iosevka Term"', 14), 'IosevkaTerm-Regular 14');
	});

	await test('il profilo Bottega ha i 16 colori ANSI, il cursore ambra e il carattere del tema', () => {
		const notte = JSON.parse(fs.readFileSync(path.join(TEMI, 'themes', 'bottega-notte.json'), 'utf8')).colors;
		const testo = T.profiloIterm(notte, { famiglia: "'SF Mono', Menlo", dimensione: 12.5, altezzaRiga: 1.15, cursore: 'line' });
		const p = JSON.parse(testo).Profiles[0];
		assert.strictEqual(p.Name, 'Bottega');
		assert.strictEqual(p.Guid, T.GUID_ITERM);
		for (let i = 0; i < 16; i++) assert.ok(p[`Ansi ${i} Color`], `manca Ansi ${i}`);
		assert.deepStrictEqual(p['Cursor Color'], T.coloreIterm('#f4ab3c'));
		assert.strictEqual(p['Normal Font'], 'SFMono-Regular 12.5');
		assert.strictEqual(p['Vertical Spacing'], 1.15);
		assert.strictEqual(p['Cursor Type'], 1);
		assert.strictEqual(T.profiloIterm(notte, { famiglia: 'Menlo' }), T.profiloIterm(notte, { famiglia: 'Menlo' }), 'testo stabile');
		const pers = T.coloriEffettivi(notte, { 'terminal.background': '#000001', '[Bottega Notte]': { 'terminal.foreground': '#000002' }, '[Bottega Calima]': { 'terminal.foreground': '#000003' } }, 'Bottega Notte');
		assert.strictEqual(pers['terminal.background'], '#000001');
		assert.strictEqual(pers['terminal.foreground'], '#000002');
	});

	await test('i temi Notte e Calima definiscono tutti i colori del terminale', () => {
		const chiavi = ['terminal.background', 'terminal.foreground', 'terminalCursor.foreground', 'terminalCursor.background', 'terminal.selectionBackground', 'terminal.inactiveSelectionBackground', 'terminal.border', 'terminal.findMatchBackground', 'terminalCommandDecoration.successBackground', 'terminalCommandDecoration.errorBackground'];
		for (const n of ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White']) chiavi.push(`terminal.ansi${n}`, `terminal.ansiBright${n}`);
		for (const f of ['bottega-notte.json', 'bottega-calima.json']) {
			const c = JSON.parse(fs.readFileSync(path.join(TEMI, 'themes', f), 'utf8')).colors;
			for (const k of chiavi) assert.ok(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c[k] ?? ''), `${f}: ${k}`);
			assert.notStrictEqual(c['terminal.ansiBlack'].toLowerCase(), c['terminal.background'].toLowerCase());
		}
		const notte = JSON.parse(fs.readFileSync(path.join(TEMI, 'themes', 'bottega-notte.json'), 'utf8')).colors;
		assert.strictEqual(notte['terminalCursor.foreground'], '#f4ab3c', 'la lampada al sodio');
		const pkg = JSON.parse(fs.readFileSync(path.join(TEMI, 'package.json'), 'utf8')).contributes.configurationDefaults;
		for (const k of ['fontFamily', 'fontSize', 'lineHeight', 'cursorStyle']) assert.ok(pkg[`terminal.integrated.${k}`] !== undefined, k);
	});

	await test('niente lineette lunghe o medie nei testi del terminale', () => {
		for (const f of ['terminale.ts', 'terminale-host.ts']) assert.ok(!/[–—]/.test(fs.readFileSync(path.join(SRC, f), 'utf8')), f);
		const pkg = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
		assert.ok(!/[–—]/.test(pkg), 'package.json');
	});

	await test('il programma aspetta la chiusura e Cline, poi mette il terminale per ultimo', async () => {
		if (spawnSync('/usr/bin/sqlite3', ['-version']).status !== 0) return console.log('      (sqlite3 assente, salto)');
		const dir = fs.mkdtempSync(path.join(TMP, 'db-'));
		const db = path.join(dir, 'state.vscdb');
		const cline = 'workbench.view.extension.claude-dev-ActivityBar';
		sql(db, "create table ItemTable (key text unique on conflict replace, value blob); insert into ItemTable values('workbench.auxiliarybar.pinnedPanels', '[{\"id\":\"melissa\",\"order\":101},{\"id\":\"claude\",\"order\":102}]'); insert into ItemTable values('views.customizations', '{\"viewContainerLocations\":{},\"viewLocations\":{},\"viewContainerBadgeEnablementStates\":{}}');");
		const finta = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)']); // la «Bottega» che si chiude
		const segnaleCline = path.join(dir, 'cline-in-barra');
		const fatto = path.join(dir, 'terminale-in-barra');
		const p = spawn(process.execPath, ['-e', T.programmaTerminale()], {
			stdio: 'ignore',
			env: { ...process.env, BOTTEGA_PID: String(finta.pid), BOTTEGA_DB: db, BOTTEGA_FATTO: fatto, BOTTEGA_LOG: path.join(dir, 'log'), BOTTEGA_ASPETTA: segnaleCline },
		});
		await attendi(4000);
		assert.ok(!fs.existsSync(fatto), 'senza Cline finito non deve scrivere');
		// Cline scrive la sua voce e il suo segnale
		sql(db, `insert or replace into ItemTable(key, value) values('workbench.auxiliarybar.pinnedPanels', '[{"id":"melissa","order":101},{"id":"claude","order":102},{"id":"${cline}","order":103}]')`);
		fs.writeFileSync(segnaleCline, 'x');
		await new Promise(r => p.on('exit', r));
		const pin = JSON.parse(sql(db, "select value from ItemTable where key='workbench.auxiliarybar.pinnedPanels'"));
		assert.deepStrictEqual(pin.map(x => x.id), ['melissa', 'claude', cline, 'terminal']);
		assert.strictEqual(pin.at(-1).order, 104);
		const vc = JSON.parse(sql(db, "select value from ItemTable where key='views.customizations'"));
		assert.strictEqual(vc.viewContainerLocations.terminal, 2);
		assert.ok(fs.existsSync(fatto));
	});

	// ---------- il collegamento a VS Code, con il vscode finto ----------
	const esecuzioni = [];
	const profilo = path.join(TMP, 'DynamicProfiles', 'bottega.json');
	const itermFinto = path.join(TMP, 'iTerm.app');
	fs.mkdirSync(itermFinto);
	const ctx = { subscriptions: [], globalState: { get: () => undefined, update: () => Promise.resolve() }, globalStorageUri: { fsPath: path.join(TMP, 'User', 'globalStorage', 'andreapiani.bottega-home') } };
	const lavori = new Map();
	const api = H.registerTerminale(ctx, {
		cartellaLavoro: t => lavori.get(t),
		esegui: (file, args, fatto) => (esecuzioni.push([file, ...args]), fatto(null)),
		bottega: path.join(TMP, 'bottega'),
		iterm: itermFinto,
		profilo,
	});

	await test('il profilo di iTerm2 si scrive all\'avvio e solo se cambia', async () => {
		const p = JSON.parse(fs.readFileSync(profilo, 'utf8')).Profiles[0];
		assert.strictEqual(p.Name, 'Bottega');
		const prima = fs.statSync(profilo).mtimeMs;
		await attendi(20);
		await mondo.comandi['bottega.terminaleEsterno'](Uri.file(repo));
		assert.strictEqual(fs.statSync(profilo).mtimeMs, prima, 'stesso tema, stesso file');
	});

	await test('«Apri in iTerm2» dall\'Explorer: osascript con la cartella, su un file la sua cartella', async () => {
		esecuzioni.length = 0;
		await mondo.comandi['bottega.terminaleEsterno'](Uri.file(path.join(repo, 'src', 'viste')));
		assert.strictEqual(esecuzioni[0][0], '/usr/bin/osascript');
		assert.deepStrictEqual(esecuzioni[0].slice(-2), [path.join(repo, 'src', 'viste'), 'Bottega']);
		fs.writeFileSync(path.join(repo, 'src', 'viste', 'a.swift'), '');
		await mondo.comandi['bottega.terminaleEsterno'](Uri.file(path.join(repo, 'src', 'viste', 'a.swift')));
		assert.deepStrictEqual(esecuzioni[1].slice(-2), [path.join(repo, 'src', 'viste'), 'Bottega']);
		mondo.config['bottega.terminale.esterno'] = 'terminal';
		await mondo.comandi['bottega.terminaleEsterno'](Uri.file(repo));
		assert.deepStrictEqual(esecuzioni[2], ['/usr/bin/open', '-a', 'Terminal', repo]);
		delete mondo.config['bottega.terminale.esterno'];
	});

	await test('«Terminale qui» e la sessione della scheda attiva', () => {
		mondo.creati.length = 0;
		mondo.comandi['bottega.terminaleQui'](Uri.file(libera));
		assert.strictEqual(mondo.creati[0].cwd, libera);
		assert.strictEqual(mondo.creati[0].location, 1, 'nella voce Terminale, non nell\'editor');
		// la scheda attiva e' il terminale di un lavoro della Bottega nel worktree
		const lavoro = { name: 'Lavoro Esempio', creationOptions: { cwd: repo }, show() {}, dispose() {} };
		lavori.set(lavoro, wt);
		mondo.terminali.push(lavoro);
		const tab = Object.assign(new TabInputTerminal(), {});
		mondo.schedaAttiva = { label: 'Lavoro Esempio', input: tab };
		// (qui la home e' quella vera: si usa una cartella fuori dalla casa finta, che ha .git)
		const fuori = path.join(TMP, 'fuori');
		fs.mkdirSync(fuori);
		mondo.editor = { document: { uri: Uri.file(path.join(fuori, 'nota.md')) } };
		mondo.comandi['bottega.terminaleQui']();
		assert.strictEqual(mondo.creati[1].cwd, wt);
		mondo.schedaAttiva = undefined;
		mondo.comandi['bottega.terminaleQui']();
		assert.strictEqual(mondo.creati[2].cwd, fuori, 'senza sessione, la cartella del file attivo');
	});

	await test('Melissa: terminale_apri su un progetto, dentro o in iTerm2', async () => {
		const S = H.STRUMENTI_TERMINALE.terminale_apri;
		const assistente = { deps: { actions: { resolveProject: n => (n.toLowerCase() === 'esempio' ? { name: 'Esempio', path: repo } : undefined) } } };
		mondo.creati.length = 0;
		esecuzioni.length = 0;
		assert.ok(/Terminale aperto su Esempio/.test(await S.run({ progetto: 'esempio' }, assistente)));
		assert.strictEqual(mondo.creati[0].cwd, repo);
		assert.ok(/iTerm2 aperto/.test(await S.run({ progetto: 'esempio', esterno: true }, assistente)));
		assert.deepStrictEqual(esecuzioni[0].slice(-2), [repo, 'Bottega']);
		assert.ok(/Non trovo/.test(await S.run({ progetto: 'sconosciuto' }, assistente)));
		assert.deepStrictEqual(S.spec.function.parameters.required, []);
	});

	await test('il primo terminale creato da VS Code nella cartella sbagliata si sostituisce', async () => {
		assert.ok(api && mondo.aperto);
		mondo.terminali.length = 0;
		mondo.creati.length = 0;
		mondo.cartelle = [];
		mondo.editor = { document: { uri: Uri.file(path.join(repo, 'src', 'viste', 'a.swift')) } };
		let chiuso = false;
		const auto = { name: 'zsh', creationOptions: {}, show() {}, dispose: () => (chiuso = true) };
		mondo.terminali.push(auto);
		const vero = Date.now;
		Date.now = () => vero() + 60_000; // oltre i primi secondi dell'avvio
		mondo.aperto(auto);
		Date.now = vero;
		await attendi(300);
		assert.ok(chiuso, 'quello nella home va via');
		assert.strictEqual(mondo.creati[0].cwd, repo);
	});

	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
