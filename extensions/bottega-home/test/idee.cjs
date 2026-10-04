#!/usr/bin/env node
// Banco di prova delle idee (clienti, dimenticati, continua, notte, briefing e consigli, lavoro unificato,
// worktree, ricerca nel codice). Dati tutti finti: il repository e' pubblico, niente nomi di clienti veri.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'test-out', 'idee');
esbuild.buildSync({
	entryPoints: ['clienti', 'dimenticati', 'continua', 'notte', 'briefing', 'jobs', 'scan', 'ricerca', 'stats', 'claude'].map(n => path.join(SRC, n + '.ts')),
	outdir: OUT,
	format: 'cjs',
	platform: 'node',
	bundle: false,
	target: 'node20',
	logLevel: 'silent',
});
// jobs.ts importa vscode solo per i tipi e i terminali: un finto minimo basta
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
	if (req === 'vscode') return { window: {}, ThemeIcon: class {}, TerminalLocation: {} };
	return origLoad.call(this, req, ...rest);
};
const req = n => require(path.join(OUT, n + '.js'));
const clienti = req('clienti');
const { findForgotten } = req('dimenticati');
const { splitSummary, prepareContinuation } = req('continua');
const notte = req('notte');
const briefing = req('briefing');
const { workItems, workCounts } = req('jobs');
const scan = req('scan');
const ricerca = req('ricerca');

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
		console.log('FAIL  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n      '));
	}
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-idee-'));
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const DASH = /[—–]/;

(async () => {
	// ---------- clienti ----------
	await test('ore per cliente: unione tra progetti, quarto d\'ora per giorno, totale dalla somma dei giorni', () => {
		const ledger = new Map([
			['/p/alfa-app', { name: 'alfa-app', spans: [at(2026, 9, 3, 9), at(2026, 9, 3, 10, 7), at(2026, 9, 4, 15), at(2026, 9, 4, 15, 20)] }],
			// sessione in parallelo su un secondo progetto dello stesso cliente: 9:30-10:30, si sovrappone
			['/p/alfa-sito', { name: 'alfa-sito', spans: [at(2026, 9, 3, 9, 30), at(2026, 9, 3, 10, 30)] }],
			['/p/mio', { name: 'mio', spans: [at(2026, 9, 3, 14), at(2026, 9, 3, 14, 50)] }],
			[null, { name: 'Fuori dai progetti', spans: [at(2026, 8, 30, 10), at(2026, 8, 30, 11)] }],
		]);
		const cfg = { version: 1, rounding: 15, clients: [{ id: 'alfa', nome: 'Cliente Alfa', progetti: ['/p/alfa-app', '/p/alfa-sito'], tariffa: 40 }] };
		const r = clienti.buildReport(ledger, cfg, [{ path: '/p/alfa-app', name: 'alfa-app' }], '2026-09', at(2026, 9, 20, 12));
		const c = r.clients[0];
		// 3 settembre: unione 9:00-10:30 = 90 min; 4 settembre: 20 min -> 15
		assert.deepStrictEqual(c.days, [{ date: '2026-09-03', minutes: 90 }, { date: '2026-09-04', minutes: 15 }]);
		assert.strictEqual(c.minutes, 105);
		assert.strictEqual(c.amount, 70);
		assert.strictEqual(r.unassigned[0].name, 'mio');
		assert.strictEqual(r.unassigned[0].minutes, 45);
		assert.ok(r.months.includes('2026-08') && r.months.includes('2026-09'));
		assert.strictEqual(clienti.roundTo(7, 15), 0);
		assert.strictEqual(clienti.roundTo(7.5, 15), 15);
	});

	await test('clienti: CSV con punto e virgola, Markdown leggibile, niente lineette lunghe', () => {
		const ledger = new Map([['/p/a', { name: 'a', spans: [at(2026, 9, 3, 9), at(2026, 9, 3, 11)] }]]);
		const r = clienti.buildReport(ledger, { version: 1, rounding: 15, clients: [{ id: 'x', nome: 'Cliente; con punto e virgola', progetti: ['/p/a'] }] }, [], '2026-09', at(2026, 9, 20, 12));
		const csv = clienti.toCsv(r);
		assert.ok(csv.startsWith('cliente;data;minuti;ore;importo\n'));
		assert.ok(csv.includes('"Cliente; con punto e virgola";2026-09-03;120;2,00;'));
		const md = clienti.toMarkdown(r);
		assert.ok(md.includes('# Ore per cliente, settembre 2026'));
		assert.ok(md.includes('**2 h**'));
		assert.ok(!DASH.test(md) && !DASH.test(csv));
	});

	await test('clienti: il file si scrive 600 e un progetto appartiene a un solo cliente', () => {
		const f = path.join(tmp, 'clienti.json');
		const d = clienti.writeClients([{ nome: 'Uno', progetti: ['/p/a', '/p/b/'] }, { nome: 'Due', progetti: ['/p/b'] }, { nome: '  ' }], f);
		assert.strictEqual(d.clients.length, 2);
		assert.deepStrictEqual(d.clients[0].progetti, ['/p/a']);
		assert.deepStrictEqual(d.clients[1].progetti, ['/p/b']);
		assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
		assert.deepStrictEqual(clienti.readClients(f).clients.map(c => c.id), ['uno', 'due']);
	});

	// ---------- dimenticati ----------
	await test('dimenticati: fermi da due settimane con qualcosa a meta\', i vivi no', () => {
		const now = at(2026, 10, 2, 9);
		const old = now - 20 * 86400000;
		const P = (name, git, extra = {}) => ({ name, path: '/p/' + name, git, sessions: [], live: [], ...extra });
		const ps = [
			P('fermo-sporco', { changes: 3, ahead: 0, upstream: true, lastCommitAt: old }),
			P('fermo-pulito', { changes: 0, ahead: 0, upstream: true, lastCommitAt: old }),
			P('fresco', { changes: 5, ahead: 1, upstream: true, lastCommitAt: now - 86400000 }),
			P('solo-qui', { changes: 0, ahead: 0, upstream: false, lastCommitAt: old }),
			P('vivo', { changes: 2, ahead: 0, upstream: true, lastCommitAt: old }, { live: [{ pid: 1 }] }),
		];
		const f = findForgotten(ps, [{ id: 'job-1', path: '/p/fermo-pulito', status: 'fermato' }], now);
		assert.deepStrictEqual(f.map(x => x.name).sort(), ['fermo-pulito', 'fermo-sporco', 'solo-qui']);
		assert.ok(f.find(x => x.name === 'fermo-sporco').reasons[0].includes('3 modifiche'));
		assert.ok(f.find(x => x.name === 'fermo-pulito').reasons[0].includes('lavoro lasciato a metà'));
	});

	await test('dimenticati: una copia di lavoro (worktree) ferma con modifiche non sparisce dentro un progetto vivo', () => {
		const now = at(2026, 10, 2, 9);
		const p = {
			name: 'Meteo', path: '/p/Meteo', sessions: [], live: [],
			git: { changes: 0, ahead: 0, upstream: true, lastCommitAt: now - 2 * 86400000 },
			worktrees: [
				{ path: '/p/Meteo-realce', branch: 'realce', changes: 4, ahead: 0, upstream: false, lastCommitAt: now - 49 * 86400000 },
				{ path: '/p/Meteo-pulita', branch: 'pulita', changes: 0, ahead: 0, upstream: false, lastCommitAt: now - 49 * 86400000 },
				{ path: '/p/Meteo-fresca', branch: 'fresca', changes: 3, ahead: 0, upstream: false, lastCommitAt: now - 86400000 },
			],
		};
		const f = findForgotten([p], [], now);
		assert.strictEqual(f.length, 1);
		assert.deepStrictEqual(f[0].reasons, ['copia Meteo-realce (ramo realce), ferma da 49 giorni: 4 modifiche fuori da un commit']);
		assert.strictEqual(f[0].idleDays, 49);
	});

	// ---------- continua ----------
	await test('continua: riparte dall\'ultimo riassunto con le cose da fare e le decisioni', async () => {
		const now = at(2026, 10, 2, 9);
		const sum = { id: 1, kind: 'riassunto', project: 'Demo', title: 'notifiche push', text: 'Sistemate le notifiche.\nFile toccati: a.swift, b.swift\nDa fare: provare su iPhone; alzare la build', createdAt: now - 2 * 3600000 };
		const dec = { id: 2, kind: 'decisione', project: 'Demo', title: 'x', text: 'Le notifiche passano da APNs diretto', createdAt: now - 3600000 };
		assert.deepStrictEqual(splitSummary(sum.text).todo, ['provare su iPhone', 'alzare la build']);
		const c = await prepareContinuation({ name: 'Demo', path: '/p/demo' }, { recent: async (_p, o) => (o.kinds.includes('riassunto') ? [sum] : [dec]) }, now);
		assert.ok(c.prompt.startsWith('Riprendi il lavoro su Demo'));
		assert.ok(c.prompt.includes('- provare su iPhone'));
		assert.ok(c.prompt.includes('APNs diretto'));
		assert.ok(c.prompt.includes('a.swift'));
		assert.ok(c.sources[0].includes('2 ore fa'));
		const empty = await prepareContinuation({ name: 'Nuovo', path: '/p/n' }, { recent: async () => [] }, now);
		assert.ok(empty.prompt.includes('non ha un riassunto'));
	});

	// ---------- notte ----------
	await test('notte: finestra che scavalca la mezzanotte e configurazione pulita', () => {
		const cfg = { from: '23:30', to: '05:00', parallel: 1 };
		assert.ok(notte.inWindow(cfg, at(2026, 10, 2, 23, 45)));
		assert.ok(notte.inWindow(cfg, at(2026, 10, 3, 2)));
		assert.ok(!notte.inWindow(cfg, at(2026, 10, 3, 5)));
		assert.ok(notte.inWindow({ from: '01:00', to: '06:00', parallel: 1 }, at(2026, 10, 3, 1)));
		assert.deepStrictEqual(notte.cleanConfig({ from: 'x', to: '7:00', parallel: 5 }), { from: '01:00', to: '07:00', parallel: 1 });
		assert.strictEqual(notte.nightDate(at(2026, 10, 3, 2)), '2026-10-02');
	});

	await test('notte: parte solo di notte, alla corrente, con memoria tranquilla; sveglia tenuta e rilasciata; resoconto', async () => {
		const jobs = [
			{ id: 'job-1', project: 'demo', path: '/p/demo', task: 'rifai i test', status: 'stanotte', night: true, createdAt: 1 },
			{ id: 'job-2', project: 'altro', path: '/p/altro', task: 'pulisci', status: 'stanotte', night: true, createdAt: 2 },
		];
		let ac = false;
		const launched = [];
		const held = [];
		const released = [];
		const s = new notte.NightScheduler({
			jobs: () => jobs,
			launch: (id, pre) => {
				launched.push(id);
				assert.ok(pre.includes('niente git push'));
				const j = jobs.find(x => x.id === id);
				j.status = 'in corso';
				j.sessionId = 'sess-' + id;
				return true;
			},
			systemStats: () => ({ memoryPressure: 'normal', thermal: 'nominal' }),
			power: async () => ({ ac }),
			keepAwake: async () => (held.push(1), 'tok'),
			release: t => released.push(t),
			summary: async sid => `Riassunto di ${sid}`,
			onChange: () => {},
		}, path.join(tmp, 'notte.json'));
		await s.tick(at(2026, 10, 2, 15));
		assert.strictEqual(launched.length, 0, 'di giorno non parte');
		await s.tick(at(2026, 10, 3, 2));
		assert.strictEqual(launched.length, 0, 'a batteria non parte');
		assert.ok(s.state(at(2026, 10, 3, 2)).why.includes('batteria'));
		ac = true;
		await s.tick(at(2026, 10, 3, 2, 5));
		assert.deepStrictEqual(launched, ['job-1'], 'uno alla volta');
		assert.strictEqual(held.length, 1);
		jobs[0].status = 'finito';
		await s.tick(at(2026, 10, 3, 2, 10));
		assert.deepStrictEqual(launched, ['job-1', 'job-2']);
		jobs[1].status = 'ti aspetta';
		await s.tick(at(2026, 10, 3, 7));
		assert.deepStrictEqual(released, ['tok'], 'sveglia rilasciata quando nessuno lavora');
		const rep = s.state().report;
		assert.strictEqual(rep.date, '2026-10-02');
		assert.deepStrictEqual(rep.jobs.map(j => [j.id, j.status, j.summary]), [['job-1', 'finito', 'Riassunto di sess-job-1'], ['job-2', 'ti aspetta', 'Riassunto di sess-job-2']]);
	});

	// ---------- briefing e consigli ----------
	const facts = now => ({
		now,
		jobs: [{ id: 'job-3', project: 'demo', path: '/p/demo', task: 't', status: 'ti aspetta', createdAt: 1 }],
		rules: {
			projects: { '/p/demo': { path: '/p/demo', livello: 'rosso', hits: [{ id: 'segreti', livello: 'rosso', frase: 'Una chiave nei commit non spinti.', rimedio: 'Toglila.' }], checkedAt: 1 } },
			global: [],
			appAds: null,
			counts: { rosso: 1, giallo: 2, verde: 10 },
			checkedAt: 1,
			running: false,
		},
		radar: {
			apps: [{ ascId: '1', bundleId: 'com.esempio.demo', name: 'Demo App', reviews: [{ stars: 1, title: 'no', body: '', at: now - 3600000 }], version: { string: '2.0', state: 'REJECTED', label: 'rifiutata', tone: 'male' } }],
			totals: { yesterday: 12.5, last7: 80, daily: [], currency: 'USD' },
			ascAt: now,
			admobAt: now,
			refreshing: false,
		},
		forgotten: [{ path: '/p/vecchio', name: 'vecchio', idleDays: 30, reasons: ['2 commit da spingere'] }],
		night: null,
		projects: [{ name: 'demo', path: '/p/demo' }, { name: 'vecchio', path: '/p/vecchio' }],
		stats: null,
		seen: { at: now - 86400000, states: {} },
	});
	await test('briefing: punti dai soli fatti, in ordine, senza lineette lunghe', () => {
		const now = at(2026, 10, 2, 8);
		const pts = briefing.briefingPoints(facts(now));
		assert.deepStrictEqual(pts.map(p => p.kind), ['regole', 'lavori', 'store', 'soldi', 'dimenticati']);
		assert.ok(pts[0].text.startsWith('Una regola rossa: demo, una chiave'));
		assert.ok(pts[2].text.includes('Demo App 2.0 è rifiutata') && pts[2].text.includes('una con due stelle o meno'));
		assert.ok(!pts.some(p => p.text.includes('com.esempio')), 'mai il bundle id');
		assert.ok(!DASH.test(briefing.plainBriefing(pts)));
		assert.strictEqual(briefing.spokenMinutes(135), 'due ore e un quarto'.replace('due', '2'));
	});

	await test('briefing: al primo giro un\'app pubblicata da tempo non e\' una novita\', un cambio di stato si', () => {
		const now = at(2026, 10, 2, 8);
		const f = facts(now);
		f.radar.apps = [{ ascId: '9', bundleId: 'x', name: 'Mappe', reviews: [], version: { string: '10.5', state: 'READY_FOR_SALE', label: 'pubblicata', tone: 'ok' } }];
		f.seen = undefined;
		assert.ok(!briefing.briefingPoints(f).some(p => p.kind === 'store'));
		f.seen = { at: now - 86400000, states: { '9': 'IN_REVIEW:10.5' } };
		assert.ok(briefing.briefingPoints(f).find(p => p.kind === 'store').text.includes('Mappe 10.5 è pubblicata'));
	});

	await test('briefing: Melissa apre e chiude, i fatti restano esatti; frasi con numeri scartate', () => {
		const pts = [{ kind: 'soldi', text: 'AdMob ieri ha reso 2,14 euro.' }];
		const fr = briefing.briefingFrame('Sveglia, fratellino.\n\nOra muoviti, che il caffè non basta.');
		assert.deepStrictEqual(fr, { intro: 'Sveglia, fratellino.', outro: 'Ora muoviti, che il caffè non basta.' });
		assert.deepStrictEqual(briefing.briefingFrame('Sveglia, fratellino. Ora muoviti, che il caffè non basta.'), fr, 'anche senza righe');
		assert.strictEqual(briefing.briefingText(pts, fr), 'Sveglia, fratellino. AdMob ieri ha reso 2,14 euro. Ora muoviti, che il caffè non basta.');
		assert.strictEqual(briefing.briefingFrame('Hai lavorato 12 ore.\n\nBrava.'), null, 'niente numeri inventati');
		assert.ok(briefing.briefingText(pts, null).startsWith('Buongiorno. AdMob'));
	});

	await test('consigli: il modello sceglie e ordina i fatti, il testo e\' sempre il rimedio esatto; ripiego senza modello', () => {
		const f = facts(at(2026, 10, 2, 8));
		const cands = briefing.adviceCandidates(f, briefing.briefingPoints(f));
		assert.ok(cands[0].fact.startsWith('(rosso) demo'));
		const last = cands[cands.length - 1];
		const items = briefing.parseAdvice(`Ecco: [${last.n}] [1] [1] [99] testo inventato`, cands);
		assert.deepStrictEqual(items.map(i => i.text), ['vecchio: riprendilo con «Continua da dove eri», oppure chiudi il lavoro rimasto con un commit e un push.', 'demo: toglila.']);
		assert.deepStrictEqual(items[0].act, { act: 'focus', label: 'Apri vecchio', args: { path: '/p/vecchio' } });
		assert.deepStrictEqual(briefing.parseAdvice('nessun numero', cands), []);
		const rb = briefing.ruleAdvice(cands);
		assert.ok(rb.length >= 2 && rb.length <= 4);
		assert.strictEqual(rb[0].text, 'demo: toglila.');
		assert.ok(!items.concat(rb).some(i => DASH.test(i.text)));
	});

	await test('consigli: violazioni uguali in piu\' progetti diventano un solo consiglio con il rimedio al plurale', () => {
		const f = facts(at(2026, 10, 2, 8));
		f.rules.projects = {};
		for (const n of ['a', 'b', 'c']) f.rules.projects['/p/' + n] = { path: '/p/' + n, livello: 'giallo', hits: [{ id: 'build', livello: 'giallo', frase: 'Build non salita.', rimedio: 'Alzala.' }], checkedAt: 1 };
		f.projects.push(...['a', 'b', 'c'].map(n => ({ name: n, path: '/p/' + n })));
		const cands = briefing.adviceCandidates(f, []);
		const build = cands.filter(c => c.fact.includes('build'));
		assert.strictEqual(build.length, 1);
		assert.strictEqual(build[0].subject, '3 progetti con build non salita');
		assert.ok(build[0].remedy.startsWith('Fai salire il numero di build'));
	});

	// ---------- lavoro unificato ----------
	await test('lavoro in giro: lavori della Bottega e sessioni vive altrove, contati una volta', () => {
		const jobs = [
			{ id: 'job-1', project: 'demo', path: '/p/demo', task: 'compito', status: 'in corso', sessionId: 's1', createdAt: 1, startedAt: 1000 },
			{ id: 'job-2', project: 'demo', path: '/p/demo', task: 'vecchio', status: 'finito', createdAt: 1 },
			{ id: 'job-3', project: 'notte', path: '/p/notte', task: 'n', status: 'stanotte', night: true, createdAt: 5 },
			{ id: 'job-4', project: 'nuovo', path: '/p/nuovo', task: 'appena partito', status: 'in corso', createdAt: 9, startedAt: 5000 },
		];
		const live = [
			{ pid: 1, sessionId: 's1', cwd: '/p/demo', status: 'busy', statusSince: 10, startedAt: 1000 },
			{ pid: 2, sessionId: 's2', cwd: '/p/altro', status: 'idle', statusSince: 20, startedAt: 10, title: 'altrove' },
			{ pid: 3, sessionId: 's3', cwd: '/Users/x', status: 'shell', statusSince: 30, startedAt: 10 },
			{ pid: 4, sessionId: 's4', cwd: '/p/nuovo', status: 'busy', statusSince: 40, startedAt: 6000 },
		];
		const w = workItems(jobs, live, s => (s.cwd === '/p/altro' ? { name: 'Altro', path: '/p/altro' } : undefined), '/Users/x');
		assert.deepStrictEqual(w.map(x => [x.key, x.status, x.source]), [
			['sess:s2', 'ti aspetta', 'altrove'],
			['job:job-4', 'in corso', 'bottega'],
			['job:job-1', 'in corso', 'bottega'],
			['sess:s3', 'nel terminale', 'altrove'],
			['job:job-3', 'stanotte', 'bottega'],
		]);
		assert.strictEqual(w.find(x => x.key === 'sess:s3').project, 'home');
		assert.deepStrictEqual(workCounts(w), { inCorso: 2, tiAspetta: 1, nelTerminale: 1, inCoda: 0, stanotte: 1, vive: 4 });
	});

	await test('un pannello di Claude Code aperto e mai usato non ti aspetta', () => {
		const live = [
			{ pid: 5, sessionId: 's5', cwd: '/p/vuoto', status: 'idle', statusSince: 50, startedAt: 10, empty: true },
			{ pid: 6, sessionId: 's6', cwd: '/p/usato', status: 'idle', statusSince: 60, startedAt: 10 },
		];
		const w = workItems([], live, () => undefined, '/Users/x');
		assert.deepStrictEqual(w.map(x => [x.key, x.status]), [['sess:s6', 'ti aspetta']]);
		assert.deepStrictEqual(workCounts(w), { inCorso: 0, tiAspetta: 1, nelTerminale: 0, inCoda: 0, stanotte: 0, vive: 1 });
	});

	// ---------- worktree ----------
	await test('worktree: non e\' un progetto, sta dentro il principale, e le sue sessioni vanno li\'', async () => {
		const root = path.join(tmp, 'radice');
		const main = path.join(root, 'Principale');
		fs.mkdirSync(main, { recursive: true });
		const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
		git(main, 'init', '-q', '-b', 'main');
		fs.writeFileSync(path.join(main, 'a.txt'), 'a');
		git(main, 'add', '.');
		git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'uno');
		git(main, 'worktree', 'add', '-q', path.join(root, 'Principale-ramo'), '-b', 'ramo');
		const past = [{ sessionId: 'w1', cwd: path.join(root, 'Principale-ramo', 'src'), touched: [], mtime: Date.now(), title: 't' }];
		const ps = await scan.scanProjects([root], [], past, [{ pid: 9, sessionId: 'w2', cwd: path.join(root, 'Principale-ramo'), status: 'busy', statusSince: 1, startedAt: 1 }]);
		assert.deepStrictEqual(ps.map(p => p.name), ['Principale']);
		assert.strictEqual(ps[0].worktrees.length, 1);
		assert.strictEqual(ps[0].worktrees[0].branch, 'ramo');
		assert.deepStrictEqual(ps[0].sessions.map(s => s.sessionId), ['w1']);
		assert.deepStrictEqual(ps[0].live.map(s => s.sessionId), ['w2']);
		assert.strictEqual(scan.sessionOwner([scan.projectKey(main)], path.join(root, 'Principale-ramo'), []), scan.projectKey(main));
	});

	// ---------- ricerca ----------
	await test('ricerca nel codice: frase, poi parola chiave; file relativi al progetto; niente node_modules', async () => {
		const a = path.join(tmp, 'cerca', 'Uno');
		const b = path.join(tmp, 'cerca', 'Due');
		fs.mkdirSync(path.join(a, 'src'), { recursive: true });
		fs.mkdirSync(path.join(b, 'node_modules', 'x'), { recursive: true });
		fs.writeFileSync(path.join(a, 'src', 'push.swift'), 'let x = 1\n// registra le notifiche push qui\n');
		fs.writeFileSync(path.join(b, 'node_modules', 'x', 'i.js'), '// notifiche push\n');
		fs.writeFileSync(path.join(b, 'note.md'), 'Le NOTIFICHE arrivano tardi\n');
		const projects = [{ name: 'Uno', path: a }, { name: 'Due', path: b }];
		const hits = await ricerca.searchCode('notifiche push', projects);
		assert.ok(hits.some(h => h.project === 'Uno' && h.file === 'src/push.swift' && h.line === 2));
		assert.ok(hits.some(h => h.project === 'Due' && h.file === 'note.md'), 'secondo passo con la parola chiave');
		assert.ok(!hits.some(h => h.file.includes('node_modules')));
		const r = await ricerca.whereSolved('notifiche push', projects, async () => [{ id: 1, title: 'x' }]);
		assert.strictEqual(r.memoria.length, 1);
		assert.ok(r.codice.length >= 2);
		// tetto per progetto: un progetto con molti file non copre gli altri
		const big = path.join(tmp, 'cerca', 'Tanti');
		fs.mkdirSync(big, { recursive: true });
		for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(big, `doc${i}.md`), 'notifiche push\n');
		const capped = await ricerca.searchCode('notifiche push', [...projects, { name: 'Tanti', path: big }]);
		assert.strictEqual(capped.filter(h => h.project === 'Tanti').length, 8);
		assert.ok(capped.some(h => h.project === 'Uno'));
		assert.deepStrictEqual(ricerca.keyWords('come registrare le notifiche push'), ['registrare', 'notifiche', 'push']);
	});

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(`\n${passed} ok, ${failed} falliti${fails.length ? ': ' + fails.join(', ') : ''}`);
	process.exit(failed ? 1 : 0);
})();
