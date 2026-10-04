#!/usr/bin/env node
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

const events = { open: [], close: [], start: [], end: [] };
const listen = kind => fn => {
	events[kind].push(fn);
	return { dispose: () => { events[kind] = events[kind].filter(x => x !== fn); } };
};
const emit = (kind, event) => events[kind].forEach(fn => fn(event));
const existing = { name: 'Ripristinato', creationOptions: { cwd: '/tmp/Vecchio' } };
const vscode = { window: {
	terminals: [existing],
	onDidOpenTerminal: listen('open'),
	onDidCloseTerminal: listen('close'),
	onDidStartTerminalShellExecution: listen('start'),
	onDidEndTerminalShellExecution: listen('end'),
} };
const originalLoad = Module._load;
Module._load = function (name) { return name === 'vscode' ? vscode : originalLoad.apply(this, arguments); };
const src = path.join(__dirname, '..', 'src', 'attivita-terminale.ts');
const out = path.join(__dirname, 'test-out', 'attivita-terminale.js');
esbuild.buildSync({ entryPoints: [src], outfile: out, format: 'cjs', platform: 'node', target: 'node20', logLevel: 'silent' });
const { registerTerminalActivity, redactTerminalLine } = require(out);

class Stream {
	constructor() { this.queue = []; this.waiters = []; this.closed = false; }
	push(value) { const w = this.waiters.shift(); if (w) w({ done: false, value }); else this.queue.push(value); }
	next() {
		if (this.queue.length) return Promise.resolve({ done: false, value: this.queue.shift() });
		if (this.closed) return Promise.resolve({ done: true });
		return new Promise(resolve => this.waiters.push(resolve));
	}
	return() { this.closed = true; for (const w of this.waiters.splice(0)) w({ done: true }); return Promise.resolve({ done: true }); }
	[Symbol.asyncIterator]() { return this; }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {
	const ctx = { subscriptions: [] };
	let changes = 0;
	const monitor = registerTerminalActivity(ctx, () => changes++);
	const prior = monitor.activities()[0];
	assert.equal(prior.status, 'sconosciuto');
	assert.equal(prior.project, 'Vecchio');
	assert.equal(monitor.detail(prior.key).captured, false);

	const terminal = { name: 'Terminale Bottega', creationOptions: { cwd: '/tmp/Bottega' } };
	emit('open', terminal);
	const stream = new Stream();
	let reads = 0;
	const execution = { commandLine: { value: 'npm test' }, cwd: { scheme: 'file', fsPath: '/tmp/Bottega' }, read() { reads++; return stream; } };
	emit('start', { terminal, execution });
	assert.equal(reads, 1, 'read() chiamato subito all’avvio');
	const current = monitor.activities().find(a => a.project === 'Bottega');
	assert.equal(current.status, 'in corso');
	assert.equal(current.title, 'npm test');

	stream.push('Primo test ok\nTOKEN=');
	stream.push('abcd1234\n');
	stream.push('Secondo test ok\n');
	await tick();
	let detail = monitor.detail(current.key);
	assert.match(detail.output, /Primo test ok/);
	assert.match(detail.output, /Secondo test ok/);
	assert.doesNotMatch(detail.output, /abcd1234/);
	assert.deepEqual(Object.keys(current).includes('output'), false, 'la Home non riceve output');
	assert.equal(detail.captured, true);

	stream.push('riga normale\n'.repeat(1000));
	await tick();
	detail = monitor.detail(current.key);
	assert.ok(Buffer.byteLength(detail.output) <= 8192);
	assert.equal(detail.truncated, true);
	emit('end', { terminal, execution, exitCode: 1 });
	assert.equal(monitor.detail(current.key).activity.status, 'errore');
	emit('close', terminal);
	assert.equal(monitor.detail(current.key).activity.status, 'errore');
	assert.match(monitor.detail(current.key).activity.evidence, /chiuso/);

	const terminal2 = { name: 'Nuovo', creationOptions: {} };
	emit('open', terminal2);
	const stream2 = new Stream();
	const exec2 = { commandLine: { value: 'export API_KEY=not-real' }, read() { return stream2; } };
	emit('start', { terminal: terminal2, execution: exec2 });
	const second = monitor.activities().find(a => a.project === 'Cartella sconosciuta');
	assert.equal(second.title, 'Comando riservato');
	emit('end', { terminal: terminal2, execution: exec2, exitCode: undefined });
	assert.equal(monitor.detail(second.key).activity.status, 'sconosciuto');
	assert.equal(redactTerminalLine('mail me at test@example.com'), 'mail me at [email]');
	assert.equal(redactTerminalLine('Bearer abcdefg'), '[riga riservata omessa]');
	for (let i = 0; i < 35; i++) emit('open', { name: `Terminale ${i}`, creationOptions: {} });
	assert.equal(monitor.activities().length, 30, 'il monitor mantiene al massimo 30 terminali');

	await new Promise(resolve => setTimeout(resolve, 300));
	assert.ok(changes >= 1 && changes <= 3, 'aggiornamenti aggregati');
	monitor.dispose();
	assert.equal(events.start.length, 0);
	console.log('  ok  monitor terminali: stati, output limitato, segreti e chiusura');
})().catch(error => { console.error(error); process.exitCode = 1; });
