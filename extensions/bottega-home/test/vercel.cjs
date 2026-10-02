#!/usr/bin/env node
// Banco di prova dei siti su Vercel (src/vercel.ts) e della loro sezione nella Vedetta (media/vedetta.js).
// Niente chiamate vere: la CLI di Vercel e' finta e risponde con JSON della stessa forma di `vercel api`
// (/v6/deployments, /v13/deployments/<id>). Progetti, domini e commit inventati (esempio.it): il repository
// e' pubblico. Si prova: l'elenco chiuso dei comandi (solo lettura), il collegamento ai progetti
// (project.json, sottocartella, repo.json, repository GitHub, nome), la lettura, la cache su disco (600, niente
// variabili d'ambiente), la cadenza, gli errori senza rete, la regola rossa, l'aggancio al radar e la sezione Siti.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const MEDIA = path.join(__dirname, '..', 'media');
const OUT = path.join(__dirname, 'test-out', 'vercel');
esbuild.buildSync({
	entryPoints: ['vercel', 'radar'].map(n => path.join(SRC, n + '.ts')),
	outdir: OUT,
	format: 'cjs',
	platform: 'node',
	bundle: false,
	target: 'node20',
	logLevel: 'silent',
});
const V = require(path.join(OUT, 'vercel.js'));
const { Radar } = require(path.join(OUT, 'radar.js'));

let passed = 0, failed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log('  ok  ' + name);
	} catch (e) {
		failed++;
		console.log('FAIL  ' + name + '\n      ' + String((e && e.stack) || e).split('\n').slice(0, 5).join('\n      '));
	}
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-vercel-'));
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 10, 0, 0);
const TEAM = 'team_prova0000000000000000';

// ---------- progetti finti ----------

function progetto(nome, files = {}) {
	const dir = path.join(TMP, 'progetti', nome);
	fs.mkdirSync(dir, { recursive: true });
	for (const [f, c] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
		fs.writeFileSync(path.join(dir, f), typeof c === 'string' ? c : JSON.stringify(c));
	}
	return { name: nome, path: dir };
}

const ALFA = progetto('alfa', { '.vercel/project.json': { projectId: 'prj_alfa', orgId: TEAM, projectName: 'alfa' } });
const BETA = progetto('beta', { 'sito-web/.vercel/project.json': { projectId: 'prj_beta', orgId: TEAM, projectName: 'beta-sito' } });
const GAMMA = progetto('gamma', { '.git/config': '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:esempio/gamma-app.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' });
const DELTA = progetto('delta', { 'package.json': { name: '@esempio/delta-sito' } });
const WEB = progetto('web');
const MONO = progetto('mono', { '.vercel/repo.json': { orgId: TEAM, remoteName: 'origin', projects: [{ id: 'prj_mono1', name: 'mono-uno', directory: 'apps/uno' }] } });
const PROGETTI = [ALFA, BETA, GAMMA, DELTA, WEB, MONO];

// ---------- la CLI finta ----------

const dep = (uid, projectId, name, state, at, extra = {}) => ({
	uid,
	name,
	projectId,
	url: `${name}-${uid.slice(4, 10)}-esempio.vercel.app`,
	created: at,
	createdAt: at,
	state,
	readyState: state,
	target: 'production',
	inspectorUrl: `https://vercel.com/esempio/${name}/${uid.slice(4)}`,
	creator: { uid: 'u_finto', username: 'esempio' },
	meta: {
		githubCommitSha: 'a1b2c3d4e5f6a7b8c9d0',
		githubCommitMessage: `Sistema la pagina di ${name}\n\ncorpo lungo`,
		githubCommitRef: 'main',
		githubOrg: 'esempio',
		githubRepo: name,
	},
	...(state === 'READY' ? { ready: at + 30_000 } : {}),
	...extra,
});

function cliFinta() {
	const calls = [];
	const f = {
		calls,
		page: [
			dep('dpl_alfa2', 'prj_alfa', 'alfa', 'ERROR', T0 - 10 * MIN),
			dep('dpl_gamma1', 'prj_gamma', 'gamma-app', 'BUILDING', T0 - 2 * MIN),
			dep('dpl_delta1', 'prj_delta', 'delta-sito', 'READY', T0 - 60 * MIN),
			dep('dpl_web1', 'prj_web', 'web', 'READY', T0 - 70 * MIN),
			dep('dpl_alfa1', 'prj_alfa', 'alfa', 'READY', T0 - 3 * 24 * 60 * MIN),
		],
		singoli: {
			prj_beta: [dep('dpl_beta1', 'prj_beta', 'beta-sito', 'READY', T0 - 40 * 24 * 60 * MIN)],
			prj_mono1: [],
			prj_tolto: 404,
		},
		dettagli: {
			dpl_alfa1: { alias: ['alfa-esempio.vercel.app', 'www.alfa-esempio.it', 'alfa-esempio.it'] },
			dpl_alfa2: { alias: [], errorMessage: 'Command "npm run build" exited with 1' },
			dpl_beta1: { alias: ['beta-sito.vercel.app'] },
			dpl_delta1: { alias: ['delta.esempio.it'] },
		},
		fail: null,
		async esegui(args) {
			calls.push(args);
			if (f.fail) return f.fail;
			const ep = args[1];
			const u = new URL('https://api.invalid' + ep);
			let body;
			if (u.pathname === '/v6/deployments' && !u.searchParams.get('projectId')) {
				body = { deployments: f.page, pagination: { count: f.page.length, next: null, prev: T0 } };
			} else if (u.pathname === '/v6/deployments') {
				if (f.singoli[u.searchParams.get('projectId')] === 404) return { stdout: '', stderr: 'Error: Project not found (404)', code: 1 };
				body = { deployments: f.singoli[u.searchParams.get('projectId')] ?? [], pagination: { next: null } };
			} else if (u.pathname.startsWith('/v13/deployments/')) {
				const id = u.pathname.split('/').pop();
				// come la vera: insieme ai dettagli arrivano anche le variabili d'ambiente, che non vanno salvate
				body = { id, readyState: 'READY', env: ['SEGRETO_FINTO_123'], build: { env: ['SEGRETO_FINTO_123'] }, ...(f.dettagli[id] ?? { alias: [] }) };
			} else return { stdout: '', stderr: 'Error: endpoint sconosciuto', code: 1 };
			return { stdout: JSON.stringify(body), stderr: '', code: 0 };
		},
	};
	return f;
}

(async () => {
	console.log('Vercel: sola lettura');

	await test('comandoAmmesso lascia passare solo i comandi di lettura', () => {
		const si = [
			['whoami'],
			['ls', '--format', 'json'],
			['ls', 'alfa', '--environment', 'production', '--format=json', '--limit', '5'],
			['inspect', 'alfa-abc-esempio.vercel.app', '--format', 'json'],
			['project', 'ls', '--format', 'json'],
			['projects', 'list', '--json'],
			['api', '/v6/deployments?target=production&limit=100&teamId=team_x', '-X', 'GET', '--raw', '--non-interactive', '--no-color'],
			['api', '/v13/deployments/dpl_abc', '-X', 'GET', '--raw'],
			['api', '/v2/user', '--method', 'get'],
		];
		for (const a of si) assert.ok(V.comandoAmmesso(a), a.join(' '));
		const no = [
			[],
			['deploy'],
			['deploy', '--prod'],
			['--prod'],
			['rm', 'alfa'],
			['remove', 'dpl_abc', '--yes'],
			['env', 'ls'],
			['env', 'pull'],
			['promote', 'dpl_abc'],
			['rollback'],
			['redeploy', 'dpl_abc'],
			['alias', 'ls'],
			['domains', 'ls'],
			['link'],
			['pull'],
			['logout'],
			['project', 'rm', 'alfa'],
			['project', 'add', 'alfa'],
			['ls', '--token', 'qualcosa'],
			['ls', '-t', 'qualcosa'],
			['ls', '--format', 'text'],
			['ls', 'alfa', 'beta'],
			['inspect', 'dpl_abc', '--logs'],
			['inspect', 'dpl_abc', '--wait'],
			['api', '/v6/deployments'], // senza metodo dichiarato
			['api', '/v6/deployments', '-X', 'POST'],
			['api', '/v13/deployments/dpl_abc', '-X', 'DELETE'],
			['api', '/v13/deployments/dpl_abc', '-X', 'DELETE', '--dangerously-skip-permissions'],
			['api', '/v10/projects', '-X', 'GET', '-F', 'name=x'],
			['api', '/v10/projects', '-X', 'GET', '-f', 'name=x'],
			['api', '/v10/projects', '-X', 'GET', '--input', 'corpo.json'],
			['api', '/v9/projects/prj_abc/env', '-X', 'GET'],
			['api', '/v1/env', '-X', 'GET'],
			['api', '/v9/projects/prj_abc/domains/x', '-X', 'GET'],
			['api', 'https://api.vercel.com/v6/deployments', '-X', 'GET'],
			['api', '/v6/deployments', '/v6/deployments', '-X', 'GET'],
			['api', '/v6/deployments', '-X'],
			['api', '/v6/deployments', '-X', '--raw'],
		];
		for (const a of no) assert.ok(!V.comandoAmmesso(a), 'doveva rifiutare: ' + a.join(' '));
	});

	await test('un comando fuori elenco non lancia nemmeno il processo', async () => {
		const f = cliFinta();
		const v = new V.Vercel({ dir: path.join(TMP, 'rifiuto'), esegui: f.esegui, now: () => T0, ogniMinuti: () => 30 });
		await assert.rejects(() => v.cli(['deploy', '--prod']), /rifiutato/);
		await assert.rejects(() => v.cli(['api', '/v13/deployments/dpl_x', '-X', 'DELETE']), /rifiutato/);
		assert.strictEqual(f.calls.length, 0);
	});

	console.log('Vercel: forma dei dati');

	await test('una voce di /v6/deployments diventa una pubblicazione pulita', () => {
		const p = V.leggiPubblicazione(dep('dpl_x1', 'prj_x', 'xsito', 'READY', T0));
		assert.strictEqual(p.uid, 'dpl_x1');
		assert.strictEqual(p.state, 'READY');
		assert.strictEqual(p.at, T0);
		assert.strictEqual(p.readyAt, T0 + 30_000);
		assert.strictEqual(p.repo, 'esempio/xsito');
		assert.deepStrictEqual(p.commit, { sha: 'a1b2c3d4e5f6a7b8c9d0', message: 'Sistema la pagina di xsito', ref: 'main' });
		assert.ok(!('creator' in p) && !('meta' in p));
		// un inspectorUrl che non e' di vercel.com non passa
		assert.strictEqual(V.leggiPubblicazione({ ...dep('dpl_x2', 'prj_x', 'x', 'READY', T0), inspectorUrl: 'javascript:alert(1)' }).inspector, undefined);
		assert.strictEqual(V.leggiPubblicazione({ name: 'senza id' }), null);
	});

	await test('il dominio: prima quello vero e corto, poi vercel.app', () => {
		assert.strictEqual(V.sceltaDominio(['a-esempio.vercel.app', 'www.esempio.it', 'esempio.it']), 'esempio.it');
		assert.strictEqual(V.sceltaDominio(['lungo-esempio-team.vercel.app', 'corto.vercel.app']), 'corto.vercel.app');
		assert.strictEqual(V.sceltaDominio([]), undefined);
		assert.strictEqual(V.sceltaDominio(['<b>x</b>']), undefined);
	});

	await test('etichette e semaforo degli stati', () => {
		assert.deepStrictEqual(V.statoVercel('READY'), { label: 'pubblicata', tone: 'ok' });
		assert.deepStrictEqual(V.statoVercel('ERROR'), { label: 'fallita', tone: 'male' });
		assert.deepStrictEqual(V.statoVercel('BUILDING'), { label: 'in costruzione', tone: 'attesa' });
		assert.deepStrictEqual(V.statoVercel('QUEUED'), { label: 'in coda', tone: 'attesa' });
		assert.deepStrictEqual(V.statoVercel('CANCELED'), { label: 'annullata', tone: 'attesa' });
	});

	await test('gli errori della CLI in italiano, senza nulla che somigli a una chiave', () => {
		assert.match(V.messaggioErrore({ stdout: '', stderr: 'Error: No existing credentials found. Please run `vercel login`', code: 1 }), /vercel login/);
		assert.match(V.messaggioErrore({ stdout: '', stderr: '', timedOut: true }), /tempo scaduto/);
		assert.match(V.messaggioErrore({ stdout: '', stderr: 'Error: getaddrinfo ENOTFOUND api.vercel.com' }), /niente rete/);
		const m = V.messaggioErrore({ stdout: '', stderr: '<claude-code-hint v="1" />\n(node:1) ExperimentalWarning: x\nError: qualcosa abcdefghijklmnopqrstuvwxyz0123456789 e basta' });
		assert.ok(!/abcdefghijklmnopqrstuvwxyz/.test(m), m);
		assert.ok(!/claude-code-hint|ExperimentalWarning/.test(m), m);
		assert.match(m, /^Vercel ha risposto con un errore: Error: qualcosa \[\.\.\.\] e basta$/);
	});

	console.log('Vercel: collegamenti');

	await test('project.json, sottocartella, repo.json; GitHub e nome per gli altri; i nomi generici no', () => {
		const { espliciti, candidati } = V.collegamenti(PROGETTI);
		assert.deepStrictEqual(
			espliciti.map(l => [l.projectId, l.orgId, l.path, l.via]),
			[
				['prj_alfa', TEAM, ALFA.path, 'project.json'],
				['prj_beta', TEAM, BETA.path, 'project.json'],
				['prj_mono1', TEAM, MONO.path, 'repo.json'],
			],
		);
		const g = candidati.find(c => c.path === GAMMA.path);
		assert.strictEqual(g.repo, 'esempio/gamma-app');
		assert.deepStrictEqual(candidati.find(c => c.path === DELTA.path).names, ['delta', 'delta-sito']);
		assert.deepStrictEqual(candidati.find(c => c.path === WEB.path).names, []);
	});

	console.log('Vercel: lettura');

	const DIR = path.join(TMP, 'radar');
	const f = cliFinta();
	let now = T0;
	const v = new V.Vercel({ dir: DIR, esegui: f.esegui, now: () => now, ogniMinuti: () => 30 });
	let emessi = 0;
	v.onChange(() => emessi++);

	await test('prima lettura: una pagina, i progetti fuori uno per uno, i dettagli delle nuove', async () => {
		const st = await v.refresh(PROGETTI);
		assert.ok(!st.refreshing);
		assert.ok(emessi >= 2, 'avvisa quando parte e quando finisce');
		for (const c of f.calls) {
			assert.strictEqual(c[0], 'api');
			assert.deepStrictEqual(c.slice(2, 4), ['-X', 'GET']);
			assert.ok(V.comandoAmmesso(c));
		}
		const eps = f.calls.map(c => c[1]);
		assert.strictEqual(eps.filter(e => e.startsWith('/v6/deployments?target=')).length, 1);
		assert.ok(eps[0].includes(`teamId=${TEAM}`));
		assert.deepStrictEqual(eps.filter(e => e.includes('projectId=')).map(e => new URL('https://x' + e).searchParams.get('projectId')).sort(), ['prj_beta', 'prj_mono1']);
		assert.deepStrictEqual(eps.filter(e => e.startsWith('/v13/')).map(e => e.split('?')[0].split('/').pop()).sort(), ['dpl_alfa1', 'dpl_alfa2', 'dpl_beta1', 'dpl_delta1']);
		assert.strictEqual(st.at, T0);
		assert.strictEqual(st.error, undefined);
	});

	await test('i siti: falliti prima, poi in costruzione, poi pronti dal piu recente', () => {
		const s = v.state().sites;
		assert.deepStrictEqual(s.map(x => [x.name, x.state, x.via]), [
			['alfa', 'ERROR', 'project.json'],
			['gamma-app', 'BUILDING', 'github'],
			['delta-sito', 'READY', 'nome'],
			['beta-sito', 'READY', 'project.json'],
		]);
		const alfa = s[0];
		assert.strictEqual(alfa.projectPath, ALFA.path);
		assert.strictEqual(alfa.tone, 'male');
		assert.strictEqual(alfa.label, 'fallita');
		assert.strictEqual(alfa.domain, 'alfa-esempio.it', "il dominio viene dall'ultima pronta");
		assert.strictEqual(alfa.error, 'Command "npm run build" exited with 1');
		assert.deepStrictEqual(alfa.lastReady, { at: T0 - 3 * 24 * 60 * MIN, url: 'https://vercel.com/esempio/alfa/alfa1' });
		assert.strictEqual(alfa.url, 'https://vercel.com/esempio/alfa/alfa2');
		assert.strictEqual(alfa.commit.sha, 'a1b2c3d4e5f6a7b8c9d0');
		const gamma = s[1];
		assert.strictEqual(gamma.projectPath, GAMMA.path);
		assert.strictEqual(gamma.tone, 'attesa');
		assert.strictEqual(gamma.domain, undefined, "senza pronta nessun dominio: l'indirizzo della pubblicazione non e' il sito");
		assert.strictEqual(s[2].domain, 'delta.esempio.it');
		assert.strictEqual(s[2].projectPath, DELTA.path);
		assert.ok(!s.some(x => x.name === 'web'), 'un nome generico non collega');
		assert.ok(!s.some(x => x.projectId === 'prj_mono1'), 'senza pubblicazioni di produzione non si mostra');
	});

	await test('cache 600 in una cartella 700, senza variabili d ambiente', () => {
		const file = path.join(DIR, 'vercel.json');
		assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
		assert.strictEqual(fs.statSync(DIR).mode & 0o777, 0o700);
		const txt = fs.readFileSync(file, 'utf8');
		assert.ok(!txt.includes('SEGRETO_FINTO'), 'le env dei dettagli non finiscono su disco');
		assert.ok(!txt.includes('u_finto'), 'niente creator');
	});

	await test('la cadenza: niente prima di 30 minuti, la forzata al massimo una volta al minuto', async () => {
		const n = f.calls.length;
		now = T0 + 20 * MIN;
		await v.refresh(PROGETTI);
		await v.refresh(PROGETTI, { force: false });
		assert.strictEqual(f.calls.length, n);
		now = T0 + 20 * MIN + 30_000;
		const fatto = v.refresh(PROGETTI, { force: true });
		await fatto;
		const dopo = f.calls.length;
		assert.ok(dopo > n, 'la forzata legge');
		await v.refresh(PROGETTI, { force: true });
		assert.strictEqual(f.calls.length, dopo, 'una seconda forzata subito dopo no');
	});

	await test('a regime: una sola chiamata, i dettagli gia visti non si rileggono', async () => {
		now = T0 + 60 * MIN;
		const n = f.calls.length;
		await v.refresh(PROGETTI);
		const nuove = f.calls.slice(n).map(c => c[1]);
		assert.deepStrictEqual(nuove.map(e => e.split('?')[0]), ['/v6/deployments']);
	});

	await test('una pubblicazione nuova: si legge solo il suo dettaglio', async () => {
		f.page.unshift(dep('dpl_alfa3', 'prj_alfa', 'alfa', 'READY', T0 + 70 * MIN));
		f.dettagli.dpl_alfa3 = { alias: ['alfa-esempio.it'] };
		now = T0 + 100 * MIN;
		const n = f.calls.length;
		await v.refresh(PROGETTI);
		const nuove = f.calls.slice(n).map(c => c[1].split('?')[0]);
		assert.deepStrictEqual(nuove, ['/v6/deployments', '/v13/deployments/dpl_alfa3']);
		const alfa = v.state().sites.find(s => s.projectId === 'prj_alfa');
		assert.strictEqual(alfa.state, 'READY');
		assert.strictEqual(alfa.lastReady, undefined);
		assert.strictEqual(alfa.error, undefined);
	});

	await test('senza rete o senza login: resta l ultimo dato con la sua eta e un errore in italiano', async () => {
		f.fail = { stdout: '', stderr: 'Error: No existing credentials found. Please run `vercel login`', code: 1 };
		now = T0 + 200 * MIN;
		const st = await v.refresh(PROGETTI);
		assert.match(st.error, /vercel login/);
		assert.strictEqual(st.at, T0 + 100 * MIN);
		assert.strictEqual(st.sites.length, 4);
		f.fail = { stdout: '', stderr: '', code: 1, timedOut: true };
		now = T0 + 300 * MIN;
		assert.match((await v.refresh(PROGETTI)).error, /tempo scaduto/);
		f.fail = null;
		now = T0 + 400 * MIN;
		assert.strictEqual((await v.refresh(PROGETTI)).error, undefined);
	});

	await test('un progetto tolto da Vercel (404) non si richiede a ogni lettura', async () => {
		const TOLTO = progetto('tolto', { '.vercel/project.json': { projectId: 'prj_tolto', orgId: TEAM } });
		now += 31 * MIN;
		let n = f.calls.length;
		await v.refresh([...PROGETTI, TOLTO]);
		assert.strictEqual(f.calls.slice(n).filter(c => c[1].includes('projectId=prj_tolto')).length, 1);
		assert.strictEqual(v.state().error, undefined, 'un progetto sparito non fa fallire la lettura');
		now += 31 * MIN;
		n = f.calls.length;
		await v.refresh([...PROGETTI, TOLTO]);
		assert.strictEqual(f.calls.slice(n).filter(c => c[1].includes('projectId=prj_tolto')).length, 0);
		fs.rmSync(TOLTO.path, { recursive: true });
		now = T0 + 400 * MIN + 62 * MIN;
		await v.refresh(PROGETTI);
	});

	await test('rilegge la cache da disco', () => {
		const w = new V.Vercel({ dir: DIR, esegui: async () => assert.fail('non deve chiamare'), now: () => now, ogniMinuti: () => 30 });
		assert.strictEqual(w.state().sites.length, 4);
		assert.strictEqual(w.state().at, T0 + 462 * MIN);
	});

	await test('un progetto fuori dalle ultime pagine si rilegge da solo solo se poteva perdersi qualcosa', async () => {
		// le pagine adesso non arrivano fino in fondo: beta, letta prima della piu' vecchia vista, si rilegge
		const g = cliFinta();
		g.page = [dep('dpl_alfa9', 'prj_alfa', 'alfa', 'READY', T0 + 500 * MIN)];
		const realEsegui = g.esegui;
		g.esegui = async args => {
			const r = await realEsegui(args);
			if (args[1].startsWith('/v6/deployments?target=')) {
				const j = JSON.parse(r.stdout);
				j.pagination.next = T0 + 499 * MIN;
				r.stdout = JSON.stringify(j);
			}
			return r;
		};
		const dir = path.join(TMP, 'pagine');
		let t = T0 + 501 * MIN;
		const w = new V.Vercel({ dir, esegui: g.esegui, now: () => t, ogniMinuti: () => 30 });
		await w.refresh([ALFA, BETA]);
		const prime = g.calls.map(c => c[1].split('&')[0]);
		assert.ok(prime.some(e => e.includes('projectId=prj_beta')), 'la prima volta beta si legge');
		// la prima volta beta non e' in nessuna pagina: si sfoglia fino al tetto di tre
		assert.strictEqual(g.calls.filter(c => c[1].startsWith('/v6/deployments?target=')).length, 3);
		const n = g.calls.length;
		t += 40 * MIN;
		await w.refresh([ALFA, BETA]);
		// letta dopo la piu' vecchia vista: non si rilegge, e basta una pagina
		const dopo = g.calls.slice(n).map(c => c[1]);
		assert.ok(!dopo.some(e => e.includes('projectId=prj_beta')));
		assert.strictEqual(dopo.filter(e => e.startsWith('/v6/deployments?target=')).length, 1);
		assert.strictEqual(w.state().sites.find(s => s.projectId === 'prj_beta').state, 'READY');
	});

	console.log('Vercel: regola e radar');

	await test('una pubblicazione fallita diventa una regola rossa del progetto', () => {
		const st = {
			at: T0,
			refreshing: false,
			sites: [
				{ projectId: 'prj_alfa', name: 'alfa', projectPath: ALFA.path, via: 'project.json', state: 'ERROR', label: 'fallita', tone: 'male', at: T0, url: 'https://vercel.com/esempio/alfa/x', error: 'Build fallita', commit: { sha: 'a1b2c3d4e5', message: 'Prova' }, lastReady: { at: T0 - 86_400_000, url: 'https://vercel.com/esempio/alfa/y' } },
				{ projectId: 'prj_d', name: 'delta', projectPath: DELTA.path, via: 'nome', state: 'READY', label: 'pubblicata', tone: 'ok', at: T0, url: 'https://vercel.com/esempio/delta/z' },
			],
		};
		const h = V.vercelHits(ALFA.path, st);
		assert.strictEqual(h.length, 1);
		assert.strictEqual(h[0].id, 'vercel');
		assert.strictEqual(h[0].livello, 'rosso');
		assert.match(h[0].frase, /^L'ultima pubblicazione di alfa su Vercel è fallita \(2 ottobre\)\.$/);
		assert.match(h[0].rimedio, /Online resta quella del 1 ottobre\./);
		assert.deepStrictEqual(h[0].dettagli, ['a1b2c3d Prova', 'Build fallita', 'https://vercel.com/esempio/alfa/x']);
		assert.deepStrictEqual(V.vercelHits(DELTA.path, st), []);
		assert.deepStrictEqual(V.vercelHits(ALFA.path, undefined), []);
		for (const x of [...h[0].frase, ...h[0].rimedio]) assert.ok(!/[\u2013\u2014]/.test(x));
	});

	await test('il radar porta i siti nello stato e li spinge con il suo refresh', async () => {
		const g = cliFinta();
		let t = T0;
		const w = new V.Vercel({ dir: path.join(TMP, 'radar2'), esegui: g.esegui, now: () => t, ogniMinuti: () => 30 });
		const r = new Radar({
			dir: path.join(TMP, 'radar2'),
			now: () => t,
			ascEnvFile: path.join(TMP, 'manca.env'),
			admobDir: path.join(TMP, 'manca-admob'),
			fetch: async () => assert.fail('niente rete'),
			vercel: w,
		});
		const visti = [];
		r.onChange(s => visti.push(s));
		assert.ok(r.state().vercel, 'lo stato del radar ha i siti');
		assert.strictEqual(r.state().vercel.at, 0);
		await r.refresh([ALFA, DELTA]);
		await w.refresh([ALFA, DELTA]); // aspetta la lettura di Vercel partita dal radar
		assert.ok(g.calls.length > 0, 'il refresh del radar ha spinto Vercel');
		assert.ok(r.state().vercel.sites.length >= 1);
		assert.ok(visti.some(s => s.vercel && s.vercel.sites.length), 'quando Vercel finisce il radar avvisa la plancia');
		// con dir o fetch finti e senza un Vercel passato, il radar non tocca la CLI
		assert.strictEqual(new Radar({ dir: path.join(TMP, 'radar3') }).vercel, null);
		assert.strictEqual(new Radar({ dir: path.join(TMP, 'radar3') }).state().vercel, undefined);
	});

	// ---------- la sezione Siti della Vedetta ----------

	console.log('Vedetta: Siti');

	const dom = new JSDOM(`<!doctype html><html lang="it"><body class="vscode-dark"><main id="app"></main></body></html>`, {
		runScripts: 'outside-only',
		pretendToBeVisual: true,
		url: 'https://plancia.invalid/',
	});
	const w = dom.window;
	w.eval(fs.readFileSync(path.join(MEDIA, 'vedetta.js'), 'utf8'));
	const posts = [];
	const focused = [];
	const root = w.document.getElementById('app');
	const stanza = w.BottegaVedetta.mount(root, {
		post: m => posts.push(JSON.parse(JSON.stringify(m))),
		saved: {},
		save() {},
		reduced: { matches: true, addEventListener() {} },
		focusProject: p => focused.push(p),
	});
	const doc = w.document;
	const adesso = Date.now();
	const snap = vercel => ({ projects: [{ name: 'Alfa', path: ALFA.path }, { name: 'gamma', path: GAMMA.path }], rules: null, radar: { apps: [], totals: null, ascAt: 0, admobAt: 0, refreshing: false, ...(vercel ? { vercel } : {}) } });
	const SITI = {
		at: adesso - 5 * MIN,
		refreshing: false,
		sites: [
			{ projectId: 'prj_d', name: 'delta-sito', projectPath: DELTA.path, via: 'nome', state: 'READY', label: 'pubblicata', tone: 'ok', at: adesso - 3 * 60 * MIN, url: 'https://vercel.com/esempio/delta/z', domain: 'delta.esempio.it', commit: { sha: 'a1b2c3d4e5', message: 'Nuova pagina' } },
			{ projectId: 'prj_g', name: 'gamma', projectPath: GAMMA.path, via: 'github', state: 'BUILDING', label: 'in costruzione', tone: 'attesa', at: adesso - 2 * MIN, url: 'javascript:alert(1)' },
			{ projectId: 'prj_alfa', name: 'alfa', projectPath: ALFA.path, via: 'project.json', state: 'ERROR', label: 'fallita', tone: 'male', at: adesso - 10 * MIN, url: 'https://vercel.com/esempio/alfa/x', domain: 'alfa-esempio.it', error: 'Command "npm run build" exited with 1', lastReady: { at: adesso - 2 * 86_400_000, url: 'https://vercel.com/esempio/alfa/y' } },
		],
	};

	await test('senza Vercel nello stato: una nota, nessuna riga', () => {
		stanza.update(snap(null));
		stanza.show();
		assert.strictEqual(doc.querySelectorAll('#ved-siti > li').length, 0);
		assert.ok(!doc.getElementById('ved-siti-vuoto').hidden);
		stanza.update(snap({ sites: [], at: 0, refreshing: false }));
		assert.match(doc.getElementById('ved-siti-vuoto').textContent, /non è ancora stato letto/);
		assert.match(doc.getElementById('ved-siti-letto').textContent, /Mai letto/);
	});

	await test('una riga per sito: rossi, poi ambra, poi verdi; nome, dominio, semaforo, da quanto', () => {
		stanza.update(snap(SITI));
		const righe = [...doc.querySelectorAll('#ved-siti > li')];
		assert.deepStrictEqual(righe.map(r => r.querySelector('.ved-sito-nome').textContent), ['alfa', 'gamma', 'delta-sito']);
		assert.ok(righe[0].classList.contains('ved-sito-rosso'));
		assert.ok(righe[1].classList.contains('ved-sito-giallo'));
		assert.ok(righe[2].classList.contains('ved-sito-verde'));
		assert.ok(righe[0].querySelector('.ved-segno-rosso') && righe[1].querySelector('.ved-segno-giallo') && righe[2].querySelector('.ved-segno-verde'));
		assert.strictEqual(righe[0].querySelector('.ved-sito-dominio').textContent, 'alfa-esempio.it');
		assert.strictEqual(righe[1].querySelector('.ved-sito-dominio').textContent, 'n/d');
		assert.match(righe[0].querySelector('.ved-sito-stato').textContent, /fallita\s+10 min fa/);
		assert.match(righe[0].textContent, /npm run build/);
		assert.match(righe[0].textContent, /Online resta quella di 2 giorni fa\./);
		assert.match(righe[2].querySelector('.ved-sito-stato').textContent, /pubblicata\s+3 h fa|pubblicata\s+ieri/);
		assert.match(righe[2].textContent, /a1b2c3d Nuova pagina/);
		assert.match(doc.getElementById('ved-siti-letto').textContent, /^Vercel letto 5 min fa$/);
	});

	await test('il nome apre il dettaglio su vercel.com; un indirizzo strano no', () => {
		const a = [...doc.querySelectorAll('#ved-siti .ved-sito-nome a')];
		assert.strictEqual(a[0].getAttribute('href'), 'https://vercel.com/esempio/alfa/x');
		assert.strictEqual(a[0].getAttribute('target'), '_blank');
		assert.strictEqual(a[1].getAttribute('href'), 'https://vercel.com/dashboard');
	});

	await test('il progetto locale si mostra solo se ha un altro nome, e porta alla plancia', () => {
		const righe = [...doc.querySelectorAll('#ved-siti > li')];
		assert.strictEqual(righe[0].querySelector('.ved-app-prog'), null, 'alfa si chiama come il progetto Alfa');
		assert.strictEqual(righe[1].querySelector('.ved-app-prog'), null, 'gamma si chiama come il progetto');
		assert.strictEqual(righe[2].querySelector('.ved-app-prog').textContent, 'delta');
		posts.length = 0;
		righe[2].querySelector('.ved-app-prog').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
		assert.deepStrictEqual(focused.pop(), DELTA.path);
	});

	await test('Rileggi manda radar.refresh e dice che sta rileggendo', () => {
		posts.length = 0;
		doc.querySelector('[data-v="siti"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
		assert.deepStrictEqual(posts.pop(), { type: 'radar.refresh' });
		assert.match(doc.getElementById('ved-siti-letto').textContent, /Sto rileggendo Vercel/);
		assert.ok(doc.querySelector('[data-v="siti"]').disabled);
	});

	await test('senza rete: ultimo dato con la sua eta e l errore', () => {
		stanza.update(snap({ ...SITI, error: 'Vercel non risponde: niente rete.' }));
		assert.match(doc.getElementById('ved-siti-letto').textContent, /^Vercel senza rete: ultimo dato delle \d\d:\d\d$/);
		assert.match(doc.getElementById('ved-siti-errori').textContent, /niente rete/);
		assert.strictEqual(doc.querySelectorAll('#ved-siti > li').length, 3);
	});

	await test('nessuna lineetta lunga o media nella sezione', () => {
		const html = doc.querySelector('.ved-siti').innerHTML;
		assert.ok(!/[\u2013\u2014]/.test(html));
		for (const file of ['vedetta.js', 'vedetta.css']) assert.ok(!/[\u2013\u2014]/.test(fs.readFileSync(path.join(MEDIA, file), 'utf8')), file);
		assert.ok(!/[\u2013\u2014]/.test(fs.readFileSync(path.join(SRC, 'vercel.ts'), 'utf8')), 'vercel.ts');
	});

	w.close();
	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
