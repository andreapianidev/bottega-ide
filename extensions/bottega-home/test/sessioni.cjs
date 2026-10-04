#!/usr/bin/env node
// Sessioni indipendenti: nessun terminale, CLI o profilo reale viene aperto.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const esbuild = require('esbuild');
const { indirizzo } = require('../shell/cline-session.cjs');

function banco({ folders = ['/projects/Uno'], pick, missing = [] } = {}) {
	const commands = new Map(), terminals = [], errors = [];
	const dirs = new Set(['/projects/Uno', '/projects/Due con spazi', '/fake/home']);
	const fakeFs = {
		constants: fs.constants,
		accessSync(file) { if (!['claude', 'cline', 'codex'].includes(path.basename(file)) || missing.includes(path.basename(file))) throw Error('ENOENT'); },
		statSync(file) { if (!dirs.has(file) && !['claude', 'cline', 'codex'].includes(path.basename(file))) throw Error('ENOENT'); return { isDirectory: () => dirs.has(file), isFile: () => !dirs.has(file) }; },
	};
	const vscode = {
		TerminalLocation: { Panel: 1, Editor: 2 },
		commands: { registerCommand(id, callback) { commands.set(id, callback); return { dispose() { commands.delete(id); } }; } },
		workspace: { workspaceFolders: folders.map(fsPath => ({ uri: { fsPath } })) },
		window: {
			terminals,
			showQuickPick: async () => pick,
			showErrorMessage: async message => errors.push(message),
			createTerminal(options) { const terminal = { name: options.name, options, shown: false, show() { this.shown = true; } }; terminals.push(terminal); return terminal; },
		},
	};
	const code = esbuild.transformSync(fs.readFileSync(path.join(__dirname, '../src/sessioni.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'node20' }).code;
	const module = { exports: {} };
	vm.runInNewContext(code, { module, exports: module.exports, process: { env: { PATH: '/fake/bin' }, execPath: '/fake/Bottega Helper' }, require: name => name === 'vscode' ? vscode : name === 'fs' ? fakeFs : name === 'os' ? { homedir: () => '/fake/home' } : require(name) });
	const ctx = { extensionPath: '/extensions/Bottega Home', subscriptions: [] };
	module.exports.registraSessioni(ctx);
	return { ...module.exports, run: commands.get('bottega.nuovaSessione'), terminals, errors, ctx, commands };
}

test('ogni apertura crea una sessione indipendente nel Panel, con cwd e nomi distinti', async () => {
	const b = banco();
	await b.run('codex', '/projects/Due con spazi');
	await b.run('codex', '/projects/Due con spazi');
	assert.equal(b.terminals.length, 2);
	assert.notEqual(b.terminals[0], b.terminals[1]);
	assert.equal(b.terminals[0].name, 'Codex · Due con spazi');
	assert.equal(b.terminals[1].name, 'Codex · Due con spazi · 2');
	for (const t of b.terminals) {
		assert.equal(t.options.cwd, '/projects/Due con spazi');
		assert.equal(t.options.location, 1);
		assert.equal(t.options.shellPath, '/fake/bin/codex');
		assert.equal(t.options.shellArgs.length, 0);
		assert.equal(t.shown, true);
	}
	assert.equal(b.errors.length, 0);
});

test('terminale semplice usa shell configurata e cartella corrente o home', async () => {
	const b = banco();
	await b.run('terminale');
	assert.equal(b.terminals[0].options.cwd, '/projects/Uno');
	assert.equal(b.terminals[0].options.shellPath, undefined);
	const empty = banco({ folders: [] });
	await empty.run('terminale');
	assert.equal(empty.terminals[0].options.cwd, '/fake/home');
});

test('scelta fonte e annullamento non modificano sessioni precedenti', async () => {
	const b = banco({ pick: { id: 'claude', label: 'Claude Code' } });
	await b.run();
	assert.equal(b.terminals[0].options.shellPath, '/fake/bin/claude');
	const canceled = banco();
	await canceled.run();
	assert.equal(canceled.terminals.length, 0);
	assert.equal(canceled.errors.length, 0);
});

test('input non valido o CLI assente non apre processi', async () => {
	for (const [source, cwd] of [['constructor', '/projects/Uno'], ['__proto__', '/projects/Uno'], ['codex', 'relative'], ['codex', '/missing'], ['codex', '/fake/bin/codex']]) {
		const b = banco();
		await b.run(source, cwd);
		assert.equal(b.terminals.length, 0);
		assert.equal(b.errors.length, 1);
	}
	const b = banco({ missing: ['claude'] });
	await b.run('claude');
	assert.equal(b.terminals.length, 0);
	assert.match(b.errors[0], /non è installato/);
});

test('Cline usa wrapper dedicato con argomenti separati e runtime Electron Node', async () => {
	const b = banco();
	await b.run('cline');
	const options = b.terminals[0].options;
	assert.equal(options.location, 1);
	assert.equal(options.shellPath, '/fake/Bottega Helper');
	assert.deepEqual(Array.from(options.shellArgs), ['/extensions/Bottega Home/shell/cline-session.cjs', '/fake/bin/cline']);
	assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
	assert.equal(options.cwd, '/projects/Uno');
});

test('registrazione viene disposta con estensione e nomi preesistenti sono rispettati', () => {
	const b = banco();
	assert.equal(b.opzioniSessione('cline', '/projects/Uno', ['Cline · Uno', 'Cline · Uno · 2']).name, 'Cline · Uno · 3');
	assert.throws(() => b.opzioniSessione('toString', '/projects/Uno', []), /non riconosciuto/);
	for (const sub of b.ctx.subscriptions) sub.dispose();
	assert.equal(b.commands.size, 0);
});

test('indirizzo Cline accetta solo endpoint loopback dalla riga Address', () => {
	assert.equal(indirizzo('Instance created\n Address: 127.0.0.1:34567\nReady'), '127.0.0.1:34567');
	assert.equal(indirizzo('Address: 127.0.0.1:1234\r\n'), '127.0.0.1:1234');
	for (const text of ['', 'Address: evil.example:123', 'Address: 0.0.0.0:1234', 'prefix Address: 127.0.0.1:1234', 'Address: 127.0.0.1:1234; rm x']) assert.throws(() => indirizzo(text), /indirizzo/);
});

async function wrapper({ creation = { status: 0, stdout: 'Address: 127.0.0.1:34567\n' } } = {}) {
	const { EventEmitter } = require('node:events');
	const proc = new EventEmitter(), child = new EventEmitter();
	const calls = [], messages = [], signals = [];
	Object.assign(proc, { env: { PATH: '/fake/bin', ELECTRON_RUN_AS_NODE: '1', KEEP_THIS: 'yes' }, argv: ['node', 'wrapper', '/fake/cline/bin/cline'], exit(code) { this.exitCode = code; this.emit('exit', code); } });
	child.kill = signal => signals.push(signal);
	const fakeFs = { realpathSync: p => p, readdirSync: () => [], existsSync: () => true };
	const childProcess = {
		spawnSync(bin, args, options) {
			calls.push({ type: 'sync', bin, args: Array.from(args), options });
			if (args[0] === '-e') return { status: 0 };
			if (args[0] === 'instance' && args[1] === 'new') return creation;
			if (args[0] === 'instance' && args[1] === 'kill') return { status: 0 };
			throw Error('Unexpected process');
		},
		spawn(bin, args, options) { calls.push({ type: 'async', bin, args: Array.from(args), options }); return child; },
	};
	const module = { exports: {} };
	const mockRequire = name => name === 'node:fs' ? fakeFs : name === 'node:child_process' ? childProcess : name === 'node:os' ? { homedir: () => '/fake/home' } : require(name);
	mockRequire.main = module;
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../shell/cline-session.cjs'), 'utf8'), { module, require: mockRequire, process: proc, console: { log: m => messages.push(m), error: m => messages.push(m) } });
	await Promise.resolve();
	return { proc, child, calls, messages, signals, kills: () => calls.filter(c => c.args[0] === 'instance' && c.args[1] === 'kill') };
}

test('wrapper crea core privato, collega solo quell’indirizzo e lo pulisce una volta', async () => {
	const b = await wrapper();
	assert.equal(b.calls.filter(c => c.args[0] === 'instance' && c.args[1] === 'new').length, 1);
	const launch = b.calls.find(c => c.type === 'async');
	assert.deepEqual(launch.args, ['--address', '127.0.0.1:34567']);
	assert.equal(launch.options.stdio, 'inherit');
	assert.equal(launch.options.env.KEEP_THIS, 'yes');
	assert.equal(launch.options.env.ELECTRON_RUN_AS_NODE, undefined);
	b.child.emit('exit', 3);
	b.proc.emit('exit', 3);
	assert.equal(b.proc.exitCode, 3);
	assert.equal(b.kills().length, 1);
	assert.deepEqual(b.kills()[0].args, ['instance', 'kill', '127.0.0.1:34567']);
});

test('chiudere terminale o errore del figlio pulisce solo il core della sessione', async () => {
	for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) {
		const b = await wrapper();
		b.proc.emit(signal);
		b.child.emit('exit', 0);
		assert.deepEqual(b.signals, [signal]);
		assert.equal(b.kills().length, 1);
		assert.deepEqual(b.kills()[0].args, ['instance', 'kill', '127.0.0.1:34567']);
	}
	const b = await wrapper();
	b.child.emit('error', Error('launch failed'));
	b.proc.emit('exit', 1);
	assert.equal(b.proc.exitCode, 1);
	assert.equal(b.kills().length, 1);
});

test('creazione fallita o output senza indirizzo non avvia client e non chiude altre istanze', async () => {
	for (const creation of [{ status: 1, stdout: '' }, { status: 0, stdout: 'Unexpected output' }]) {
		const b = await wrapper({ creation });
		b.proc.emit('exit', 1);
		assert.equal(b.proc.exitCode, 1);
		assert.equal(b.calls.filter(c => c.type === 'async').length, 0);
		assert.equal(b.kills().length, 0);
		assert.equal(b.messages.length, 2);
	}
});
