#!/usr/bin/env node
// Exercise the real Idee lifecycle offline: virtual clock, in-memory filesystem,
// fake native process and no Home. No network, real timers or personal files.
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const source = process.env.BOTTEGA_IDEE_SOURCE || path.join(__dirname, '../src/idee.ts');
const code = esbuild.buildSync({ entryPoints: [source], bundle: true, external: ['*'],
	platform: 'node', format: 'cjs', target: 'node20', write: false, logLevel: 'silent' }).outputFiles[0].text;
const epoch = new Date(2026, 9, 4, 12).getTime();
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture() {
	let now = epoch, nextTimer = 0, computeCount = 0, homeOpened = 0, focusListener;
	const tasks = new Map(), files = new Map(), writes = [], reloads = [], published = [], logs = [], events = new Map();
	const day = () => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
	function stats(minutes = 147, computedAt = now) {
		return { computedAt, today: { date: day(), you: 11 }, week: { now: { you: 22 } },
			days: [{ date: day(), you: 11 }], workTime: { sources: ['claude', 'codex'],
				today: { date: day(), minutes }, weekMinutes: minutes + 100,
				days: [{ date: '2026-10-03', minutes: 100 }, { date: day(), minutes }] } };
	}
	let compute = () => Promise.resolve(stats());
	const schedule = (fn, delay, interval = false) => {
		const id = ++nextTimer; tasks.set(id, { fn, at: now + delay, delay, interval }); return id;
	};
	const fs = {
		mkdirSync() {},
		writeFileSync(file, data) { assert.ok(file.startsWith('/fixture/.bottega/stato.json.')); files.set(file, data); },
		renameSync(from, to) { assert.equal(to, '/fixture/.bottega/stato.json'); assert.ok(files.has(from)); files.set(to, files.get(from)); files.delete(from); writes.push(JSON.parse(files.get(to))); },
	};
	class RulesEngine { onChange() {} state() { return { projects: {}, counts: { rosso: 1, giallo: 2, verde: 3 }, checkedAt: 0 }; } }
	class Radar { onChange() {} state() { return { totals: null, apps: [] }; } async refresh() {} }
	class NightScheduler { async tick() {} dispose() {} }
	const vscode = { window: { state: { focused: false },
		registerUriHandler: () => ({ dispose() {} }),
		onDidChangeWindowState(fn) { focusListener = fn; return { dispose() {} }; } },
		workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) } };
	const modules = { fs, os: { homedir: () => '/fixture' }, path, vscode, child_process: {},
		'./regole': { RulesEngine }, './radar': { Radar }, './notte': { NightScheduler },
		'./briefing': { readBriefing: () => ({ briefing: null }), today: day },
		'./clienti': {}, './continua': {}, './dimenticati': { findForgotten: () => [] }, './ricerca': {} };
	const module = { exports: {} };
	class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
	vm.runInNewContext(code, { module, exports: module.exports, Date: ClockDate, URLSearchParams,
		process: { pid: 1234 }, console,
		require(name) { assert.ok(Object.hasOwn(modules, name), `unexpected import ${name}`); return modules[name]; },
		setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => tasks.delete(id),
		setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: id => tasks.delete(id),
	}, { filename: 'idee-offline.cjs' });
	const host = {
		projects: () => [], live: () => [], work: () => [],
		workCounts: () => ({ inCorso: 1, tiAspetta: 0, nelTerminale: 0, inCoda: 0, stanotte: 0, vive: 1 }),
		nucleo: { available: true, on: (name, fn) => events.set(name, fn),
			fireAndForget: name => { if (name === 'widget.reload') reloads.push(now); } },
		stats: { compute: input => { computeCount++; assert.deepEqual(JSON.parse(JSON.stringify(input)), { projects: [], live: [] }); return compute(); } },
		statsUpdated: value => published.push(value), jobs: { list: () => [] }, memoria: {},
		assistant: () => undefined, send() {}, showHome() { homeOpened++; }, refresh() {}, log: line => logs.push(line),
	};
	const idee = new module.exports.Idee(host);
	const context = { subscriptions: [] };
	return {
		idee, host, stats, writes, reloads, published, logs, tasks,
		get now() { return now; }, get computeCount() { return computeCount; }, get homeOpened() { return homeOpened; },
		setCompute(fn) { compute = fn; }, start() { idee.start(context); },
		ready() { events.get('ready')(); }, blur() { focusListener({ focused: false }); },
		async advance(ms) {
			const end = now + ms;
			for (;;) {
				const due = [...tasks].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
				if (!due) break;
				const [id, timer] = due; now = timer.at;
				if (timer.interval) timer.at += timer.delay; else tasks.delete(id);
				timer.fn(); await flush();
			}
			now = end; await flush();
		},
	};
}

let passed = 0, failed = 0;
async function test(name, run) {
	try { await run(); passed++; console.log(`  ok  ${name}`); }
	catch (error) { failed++; console.error(`FAIL  ${name}\n${error.stack}`); }
}
(async () => {
	await test('background refresh continues with no Home and an unfocused window', async () => {
		const f = fixture(); f.start(); f.blur(); await f.advance(2_000);
		assert.equal(f.writes.length, 1); assert.equal(f.computeCount, 1);
		await f.advance(180_000);
		assert.ok(f.writes.length >= 4); assert.ok(f.computeCount >= 3);
		assert.equal(f.homeOpened, 0); assert.ok(f.published.length >= 3);
		assert.equal(f.writes.at(-1).ore.aggiornato, f.published.at(-1).computedAt);
		f.idee.dispose();
	});
	await test('Home and widget receive the same workTime union, never the Claude-only you field', async () => {
		const f = fixture(), shared = f.stats(223); f.setCompute(() => Promise.resolve(shared)); f.start();
		await f.advance(2_000); assert.equal(f.published[0], shared);
		assert.deepEqual(f.writes[0].ore, { aggiornato: shared.computedAt, fonti: ['claude', 'codex'],
			oggi: 223, ieri: 100, settimana: 323, giorni: [{ date: '2026-10-03', minuti: 100 }, { date: '2026-10-04', minuti: 223 }] });
		const accepted = f.stats(251); f.idee.acceptStats(accepted); await f.advance(2_000);
		assert.equal(f.computeCount, 1); assert.equal(f.writes.at(-1).ore.oggi, 251);
		f.idee.acceptStats(f.stats(1, accepted.computedAt - 1)); await f.advance(2_000);
		assert.equal(f.writes.at(-1).ore.oggi, 251); f.idee.dispose();
	});
	await test('continuous agent events coalesce without postponing state forever', async () => {
		const f = fixture(); f.start();
		for (let i = 0; i < 8; i++) { f.idee.activityChanged(); await f.advance(500); }
		assert.equal(f.writes.length, 2); assert.equal(f.computeCount, 1); f.idee.dispose();
	});
	await test('widget work includes Codex, Cline and terminal activity while preserving local queues', async () => {
		const f = fixture();
		const item = (source, status, index) => ({ key: `${source}:${index}`, source, status,
			project: 'Fixture', path: '/fixture/project', title: `Task ${index}`, updatedAt: f.now - index * 1_000 });
		let activity = [item('claude', 'in corso', 1), item('codex', 'in corso', 2),
			item('codex', 'ti aspetta', 3), item('cline', 'ti aspetta', 4),
			item('terminale', 'in corso', 5), item('codex', 'finito', 6)];
		f.host.activity = () => activity;
		f.host.workCounts = () => ({ inCorso: 9, tiAspetta: 9, nelTerminale: 2, inCoda: 3, stanotte: 4, vive: 18 });
		f.start(); await f.advance(2_000);
		const { voci, ...counts } = f.writes.at(-1).lavori;
		assert.deepEqual(counts, { inCorso: 3, tiAspetta: 2, nelTerminale: 2, inCoda: 3, stanotte: 4, vive: 5 });
		assert.deepEqual(voci.map(x => x.key), ['codex:3', 'cline:4', 'claude:1', 'codex:2', 'terminale:5']);
		assert.equal(voci[0].da, activity[2].updatedAt);
		activity = []; f.idee.activityChanged(); await f.advance(2_000);
		assert.equal(f.writes.at(-1).lavori.inCorso, 0); assert.equal(f.writes.at(-1).lavori.tiAspetta, 0);
		assert.equal(f.writes.at(-1).lavori.inCoda, 3); assert.deepEqual(f.writes.at(-1).lavori.voci, []);
		f.idee.dispose();
	});
	await test('heartbeat timestamps do not spend the widget budget; changed content reloads after five minutes', async () => {
		const f = fixture(); f.start(); await f.advance(2_000); assert.equal(f.reloads.length, 1);
		await f.advance(360_000); assert.equal(f.reloads.length, 1);
		f.idee.acceptStats(f.stats(200)); await f.advance(2_000); assert.equal(f.reloads.length, 2);
		f.idee.acceptStats(f.stats(201)); await f.advance(2_000); assert.equal(f.reloads.length, 2);
		f.setCompute(() => Promise.resolve(f.stats(201)));
		await f.advance(360_000); assert.equal(f.reloads.length, 3);
		for (let i = 1; i < f.reloads.length; i++) assert.ok(f.reloads[i] - f.reloads[i - 1] >= 300_000);
		f.idee.dispose();
	});
	await test('native process readiness retries identical state despite the previous reload throttle', async () => {
		const f = fixture(); f.start(); await f.advance(2_000); assert.equal(f.reloads.length, 1);
		f.ready(); await f.advance(2_000); assert.equal(f.reloads.length, 2); f.idee.dispose();
	});
	await test('unavailable native process does not consume a reload that must be retried when ready', async () => {
		const f = fixture(); f.host.nucleo.available = false; f.start(); await f.advance(2_000);
		assert.equal(f.writes.length, 1); assert.equal(f.reloads.length, 0);
		f.host.nucleo.available = true; f.ready(); await f.advance(2_000);
		assert.equal(f.reloads.length, 1); f.idee.dispose();
	});
	await test('dispose cancels the pending write and every background timer', async () => {
		const f = fixture(); f.start(); f.idee.activityChanged(); f.idee.dispose(); await f.advance(900_000);
		assert.equal(f.tasks.size, 0); assert.equal(f.computeCount, 0); assert.equal(f.writes.length, 0);
		f.idee.activityChanged(); f.idee.acceptStats(f.stats()); await f.advance(5_000); assert.equal(f.writes.length, 0);
	});
	await test('dispose during an in-flight compute prevents writes and Home publication', async () => {
		const f = fixture(), pending = deferred(); f.setCompute(() => pending.promise); f.start(); await f.advance(2_000);
		assert.equal(f.computeCount, 1); f.idee.dispose(); pending.resolve(f.stats()); await flush();
		assert.equal(f.writes.length, 0); assert.equal(f.published.length, 0); assert.equal(f.reloads.length, 0);
	});
	await test('overlapping refresh triggers share one in-flight compute', async () => {
		const f = fixture(), pending = deferred(); f.setCompute(() => pending.promise); f.start(); await f.advance(2_000);
		f.idee.activityChanged(); await f.advance(120_000); assert.equal(f.computeCount, 1);
		pending.resolve(f.stats()); await flush(); assert.equal(f.writes.length, 1); f.idee.dispose();
	});
	await test('failed compute keeps the previous hours timestamp and reports the error', async () => {
		const f = fixture(); f.start(); await f.advance(2_000); const previous = f.writes[0].ore;
		f.setCompute(() => Promise.reject(new Error('fixture unavailable'))); await f.advance(120_000);
		assert.deepEqual(f.writes.at(-1).ore, previous); assert.ok(f.writes.at(-1).aggiornato > previous.aggiornato);
		assert.ok(f.logs.some(line => line.includes('fixture unavailable'))); f.idee.dispose();
	});
	await test('an older in-flight result cannot overwrite a newer snapshot accepted from the Home', async () => {
		const f = fixture(), pending = deferred(), old = f.stats(10); f.setCompute(() => pending.promise); f.start();
		await f.advance(2_000); const latest = f.stats(200); f.idee.acceptStats(latest);
		pending.resolve(old); await flush(); await f.advance(2_000);
		assert.equal(f.writes.at(-1).ore.oggi, 200); assert.equal(f.writes.at(-1).ore.aggiornato, latest.computedAt);
		assert.ok(f.published.every(value => value.computedAt >= latest.computedAt)); f.idee.dispose();
	});
	console.log(`Stato refresh: ${passed} passed, ${failed} failed`);
	process.exitCode = failed ? 1 : 0;
})();
