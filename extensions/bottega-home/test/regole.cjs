#!/usr/bin/env node
// Banco di prova del semaforo delle regole (src/regole.ts) e del radar (src/radar.ts).
// Regole: repository git finti in una cartella temporanea (build non salita, build salita nello stesso
// commit, merge, push, remoto, upstream, segreti, pubblico con gh finto, cache per HEAD, app-ads.txt
// con fetch finto, rilascio dal radar). Radar: fetch finto per App Store Connect e AdMob (JWT ES256
// verificato con la chiave pubblica di una coppia generata qui, lettura delle risposte, cache su disco,
// eta' senza rete, rilascio automatico). Nessun dato vero: il repository e' pubblico.
// Con BOTTEGA_TEST_REALE=1, UN solo collaudo reale: legge App Store Connect e AdMob e stampa solo conteggi.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'test-out', 'regole');
esbuild.buildSync({
	entryPoints: ['regole', 'radar', 'scan'].map(n => path.join(SRC, n + '.ts')),
	outdir: OUT,
	format: 'cjs',
	platform: 'node',
	bundle: true,
	target: 'node20',
	logLevel: 'silent',
});
const { RulesEngine, defaultRun, githubRepo } = require(path.join(OUT, 'regole.js'));
const { Radar, ascToken, projectBundleIds } = require(path.join(OUT, 'radar.js'));
const { scanProjects } = require(path.join(OUT, 'scan.js'));

let passed = 0, failed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log('  ok  ' + name);
	} catch (e) {
		failed++;
		console.log('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n      ') : e));
	}
}

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-regole-')));
const ROOT = path.join(TMP, 'lavori');
const REMOTES = path.join(TMP, 'remoti');
fs.mkdirSync(ROOT);
fs.mkdirSync(REMOTES);
const ENV = {
	...process.env,
	GIT_AUTHOR_NAME: 'Prova', GIT_AUTHOR_EMAIL: 'prova@example.com', GIT_COMMITTER_NAME: 'Prova', GIT_COMMITTER_EMAIL: 'prova@example.com',
	GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const put = (dir, file, text) => {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), text);
};
function repo(name) {
	const dir = path.join(ROOT, name);
	fs.mkdirSync(dir);
	git(dir, 'init', '-q', '-b', 'main');
	return dir;
}
function commit(dir, msg, files) {
	for (const [f, t] of Object.entries(files)) put(dir, f, t);
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', msg);
	return git(dir, 'rev-parse', 'HEAD');
}
function withRemote(dir, push = true) {
	const bare = path.join(REMOTES, path.basename(dir) + '.git');
	git(REMOTES, 'init', '-q', '--bare', '-b', 'main', bare);
	git(dir, 'remote', 'add', 'origin', bare);
	if (push) git(dir, 'push', '-q', '-u', 'origin', 'main');
}

// ---------- i repository finti ----------

const A = repo('app-build');
commit(A, 'Inizio', { 'bottega.json': '{\n  "build": 1\n}\n', 'src/a.ts': 'export const a = 1;\n' });
const shaSenza = commit(A, 'Codice senza build', { 'src/a.ts': 'export const a = 2;\n' });
commit(A, 'Solo documenti', { 'README.md': '# prova\n' });
commit(A, 'Script senza build nel posto giusto', { 'package.json': '{ "scripts": { "build": "x" } }\n', 'src/b.ts': 'export const b = 1;\n' });
git(A, 'checkout', '-q', '-b', 'ramo');
commit(A, 'Codice con build sul ramo', { 'src/a.ts': 'export const a = 3;\n', 'bottega.json': '{\n  "build": 2\n}\n' });
git(A, 'checkout', '-q', 'main');
git(A, 'merge', '-q', '--no-ff', '-m', 'Unione del ramo', 'ramo');
const shaPkg = git(A, 'rev-parse', 'HEAD^1');
commit(A, 'Uscita compilata', { 'test/test-out/a.js': 'var a = 1;\n' });
commit(A, 'Build con XcodeGen', { 'project.yml': 'settings:\n  CURRENT_PROJECT_VERSION: "3"\n', 'Sources/X.swift': 'let x = 1\n' });
withRemote(A);

const OK = repo('app-ok');
commit(OK, 'Inizio', { 'bottega.json': '{"build": 1}\n', 'Sources/App.swift': 'let x = 1\n' });
commit(OK, 'Codice e build insieme', { 'bottega.json': '{"build": 2}\n', 'Sources/App.swift': 'let x = 2\n' });
withRemote(OK);

const P = repo('da-spingere');
commit(P, 'Primo', { 'note.md': 'uno\n' });
withRemote(P);
commit(P, 'Secondo, non spinto', { 'note.md': 'due\n' });

const NR = repo('senza-remoto');
commit(NR, 'Primo', { 'note.md': 'uno\n' });

const NU = repo('senza-upstream');
commit(NU, 'Primo', { 'note.md': 'uno\n' });
withRemote(NU, false);

const FINTA = 'sk-test' + 'Q7wZ'.repeat(8); // chiave finta, costruita qui per non lasciarla intera nel sorgente
const S = repo('con-chiave');
commit(S, 'Primo', { 'note.md': 'uno\n' });
withRemote(S);
commit(S, 'Configurazione', {
	'src/config.ts': `export const key = "${FINTA}";\n`,
	'.env.locale': 'API_TOKEN=abcdef123456\n',
	'src/altro.ts': 'const token = getToken();\nconst password = nuovaPassword;\n',
});

const PUB = repo('pubblico');
commit(PUB, 'Primo', { 'note.md': 'uno\n' });
git(PUB, 'remote', 'add', 'origin', 'https://github.com/prova/pubblico.git');
const SCELTO = repo('scelto');
commit(SCELTO, 'Primo', { 'note.md': 'uno\n' });
git(SCELTO, 'remote', 'add', 'origin', 'git@github.com:prova/scelto.git');
const PRIV = repo('privato');
commit(PRIV, 'Primo', { 'note.md': 'uno\n' });
git(PRIV, 'remote', 'add', 'origin', 'git@github.com:Prova/Privato');
const ALTRUI = repo('clone-altrui');
commit(ALTRUI, 'Primo', { 'note.md': 'uno\n' });
git(ALTRUI, 'remote', 'add', 'origin', 'https://github.com/altri/strumento');

fs.mkdirSync(path.join(ROOT, 'non-git'));
put(path.join(ROOT, 'non-git'), 'note.md', 'niente git\n');

// ---------- strumenti finti ----------

const calls = [];
const ghAnswers = { 'repos/prova/pubblico': 'false true', 'repos/prova/scelto': 'false true', 'repos/Prova/Privato': 'true true', 'repos/altri/strumento': 'false false' };
const run = async (cmd, args, cwd, o) => {
	calls.push({ cmd, sub: cmd === 'git' ? args.find(a => !a.startsWith('-') && !a.includes('=')) : args[1], cwd });
	if (cmd === 'gh') {
		const v = ghAnswers[args[1]];
		return v ? { code: 0, stdout: v + '\n' } : { code: 1, stdout: '' };
	}
	return defaultRun(cmd, args, cwd, o);
};
const ADS = { 'www.andreapiani.com': 'google.com, pub-0, DIRECT\n', 'privacypolicyhub.vercel.app': 'google.com, pub-0, DIRECT\n', 'walkie-talky.vercel.app': 'google.com, pub-0, DIRECT\n' };
let adsFetches = 0;
const adsFetch = async url => {
	adsFetches++;
	const host = new URL(url).host;
	if (!(host in ADS)) throw new Error('rete finta: host sconosciuto');
	if (ADS[host] === null) throw new Error('getaddrinfo ENOTFOUND');
	return new Response(ADS[host], { status: 200 });
};
let NOW = Date.now();
const now = () => NOW;
const CACHE = path.join(TMP, 'casa', 'regole-cache.json');
const CONFIG = path.join(TMP, 'casa', 'regole.json');
put(path.dirname(CONFIG), 'regole.json', JSON.stringify({ pubbliciPerScelta: ['prova/scelto'], commitDaControllare: 10 }));
let radarState;
const engine = () => new RulesEngine({ cacheFile: CACHE, configFile: CONFIG, run, fetch: adsFetch, now, radar: () => radarState });
const hit = (st, dir, id) => st.projects[dir]?.hits.find(h => h.id === id);

(async () => {
	const projects = await scanProjects([ROOT], [], [], []);
	let e = engine();
	let s1;

	await test('primo controllo: tutti i repository, nessun progetto senza git', async () => {
		s1 = await e.check(projects);
		assert.strictEqual(Object.keys(s1.projects).length, 10);
		assert.ok(!s1.projects[path.join(ROOT, 'non-git')]);
		assert.strictEqual(s1.running, false);
		console.log(`      primo giro: ${e.lastTiming.ms} ms, ${e.lastTiming.commands} comandi, ${e.lastTiming.recomputed} ricalcolati`);
	});

	await test('build non salita: solo il commit di codice senza versione, merge esclusi', () => {
		const h = hit(s1, A, 'build');
		assert.ok(h, 'manca la regola build');
		assert.strictEqual(h.livello, 'giallo');
		assert.deepStrictEqual(h.dettagli.map(d => d.slice(0, 7)).sort(), [shaSenza.slice(0, 7), shaPkg.slice(0, 7)].sort());
		assert.ok(h.dettagli.some(d => d === `${shaSenza.slice(0, 7)} Codice senza build`));
		assert.match(h.frase, /^2 commit su 7 toccano il codice/);
		assert.strictEqual(h.azione.act, 'job.prepare');
		assert.strictEqual(h.azione.args.path, A);
		assert.match(h.azione.args.task, /build/);
		assert.strictEqual(s1.projects[A].livello, 'giallo');
	});

	await test('build salita nello stesso commit: verde', () => {
		assert.deepStrictEqual(s1.projects[OK].hits, []);
		assert.strictEqual(s1.projects[OK].livello, 'verde');
	});

	await test('push: commit non spinti, con azione', () => {
		const h = hit(s1, P, 'push');
		assert.ok(h);
		assert.strictEqual(h.frase, '1 commit non spinto su main.');
		assert.deepStrictEqual(h.azione, { act: 'push', label: 'Spingi', args: { path: P } });
		assert.ok(!hit(s1, P, 'build'), 'senza bottega.json ne Xcode la build non si controlla');
	});

	await test('remoto: senza remoto e senza upstream', () => {
		assert.strictEqual(hit(s1, NR, 'remoto').frase, 'Il repository non ha un remoto.');
		assert.strictEqual(hit(s1, NU, 'remoto').frase, 'Il ramo main non ha un upstream.');
	});

	await test('segreti: file e tipo, mai il valore; niente falsi allarmi nel codice; push senza azione', async () => {
		const h = hit(s1, S, 'segreti');
		assert.ok(h, 'manca la regola segreti');
		assert.strictEqual(h.livello, 'rosso');
		assert.ok(h.dettagli.includes('src/config.ts: chiave sk- (OpenAI, Anthropic e simili)'), h.dettagli.join(' | '));
		assert.ok(h.dettagli.includes('.env.locale: variabile segreta'), h.dettagli.join(' | '));
		assert.ok(!h.dettagli.some(d => d.startsWith('src/altro.ts')), 'getToken() non e\' una chiave');
		assert.strictEqual(s1.projects[S].livello, 'rosso');
		const p = hit(s1, S, 'push');
		assert.ok(p && !p.azione, 'con una chiave nei commit il pulsante Spingi non c\'e\'');
		const all = JSON.stringify(s1) + fs.readFileSync(CACHE, 'utf8');
		assert.ok(!all.includes(FINTA) && !all.includes('Q7wZQ7wZ') && !all.includes('abcdef123456'), 'il valore non deve uscire');
	});

	await test('pubblico: rosso salvo i pubblici per scelta; privati verdi', () => {
		assert.strictEqual(hit(s1, PUB, 'pubblico').frase, 'Il repository prova/pubblico su GitHub è pubblico.');
		assert.strictEqual(s1.projects[PUB].livello, 'rosso');
		assert.ok(!hit(s1, SCELTO, 'pubblico'));
		assert.ok(!hit(s1, PRIV, 'pubblico'));
		assert.ok(!hit(s1, ALTRUI, 'pubblico'), 'il clone di un progetto altrui non e\' una scelta di Andrea');
		assert.strictEqual(githubRepo('https://github.com/a/b.git'), 'a/b');
		assert.strictEqual(githubRepo('git@gitlab.com:a/b.git'), undefined);
	});

	await test('app-ads identico: niente regola globale; conteggi', () => {
		assert.strictEqual(s1.appAds.identical, true);
		assert.strictEqual(s1.appAds.hosts.length, 3);
		assert.deepStrictEqual(s1.global, []);
		const c = s1.counts;
		assert.strictEqual(c.rosso + c.giallo + c.verde, 10);
		assert.deepStrictEqual(c, { rosso: 2, giallo: 7, verde: 1 });
	});

	await test('cache per HEAD: secondo giro senza log, diff ne gh, solo comandi leggeri', async () => {
		calls.length = 0;
		const ads0 = adsFetches;
		const s2 = await e.check(projects);
		const heavy = calls.filter(c => c.cmd === 'gh' || c.sub === 'log' || c.sub === 'diff');
		assert.deepStrictEqual(heavy, []);
		assert.strictEqual(e.lastTiming.recomputed, 0);
		assert.strictEqual(e.lastTiming.commands, 20, 'due comandi per repository');
		assert.strictEqual(adsFetches, ads0, 'app-ads.txt al massimo ogni 6 ore');
		assert.deepStrictEqual(s2.counts, s1.counts);
		console.log(`      secondo giro: ${e.lastTiming.ms} ms, ${e.lastTiming.commands} comandi leggeri`);
	});

	await test('commit nuovo: si ricalcola solo quel progetto', async () => {
		commit(A, 'Ancora codice', { 'src/a.ts': 'export const a = 4;\n' });
		const ps = await scanProjects([ROOT], [], [], []);
		calls.length = 0;
		const s3 = await e.check(ps);
		assert.strictEqual(e.lastTiming.recomputed, 1);
		assert.ok(calls.filter(c => c.sub === 'log').every(c => c.cwd === A));
		assert.strictEqual(hit(s3, A, 'build').dettagli.length, 3);
		assert.ok(hit(s3, A, 'push'), 'ora c\'e\' un commit da spingere');
	});

	await test('visibilita GitHub dopo 24 ore e app-ads dopo 6: si richiedono', async () => {
		const ps = await scanProjects([ROOT], [], [], []);
		NOW += 7 * 3_600_000;
		calls.length = 0;
		const ads0 = adsFetches;
		ADS['walkie-talky.vercel.app'] = 'google.com, pub-1, DIRECT\n';
		const s = await e.check(ps);
		assert.strictEqual(adsFetches - ads0, 3);
		assert.strictEqual(calls.filter(c => c.cmd === 'gh').length, 0, 'gh non ancora');
		assert.strictEqual(s.appAds.identical, false);
		assert.strictEqual(s.global.length, 1);
		assert.strictEqual(s.global[0].id, 'app-ads');
		assert.strictEqual(s.global[0].frase, 'app-ads.txt non è identico sui 3 siti.');
		assert.strictEqual(s.counts.rosso, 3, 'la regola globale conta tra i rossi');
		NOW += 18 * 3_600_000;
		ADS['walkie-talky.vercel.app'] = null;
		const s4 = await e.check(ps);
		assert.strictEqual(calls.filter(c => c.cmd === 'gh').length, 4);
		assert.strictEqual(s4.global[0].frase, 'app-ads.txt non risponde su walkie-talky.vercel.app.');
		ADS['walkie-talky.vercel.app'] = ADS['www.andreapiani.com'];
	});

	await test('rilascio dal radar: rosso con azione rule.fix', async () => {
		radarState = {
			apps: [{ ascId: '1', bundleId: 'com.esempio.ok', name: 'App di prova', projectPath: OK, reviews: [],
				version: { string: '2.0', state: 'WAITING_FOR_REVIEW', label: 'in attesa di revisione', tone: 'attesa', releaseType: 'MANUAL' } }],
			totals: null, ascAt: 1, admobAt: 0, refreshing: false,
		};
		const s = await e.check(projects);
		const h = hit(s, OK, 'rilascio');
		assert.ok(h);
		assert.strictEqual(h.livello, 'rosso');
		assert.strictEqual(h.frase, 'La versione 2.0 di App di prova è in attesa di revisione con il rilascio manuale.');
		assert.deepStrictEqual(h.azione, { act: 'rule.fix', label: 'Metti in rilascio automatico', args: { path: OK, rule: 'rilascio' } });
		radarState.apps[0].version.releaseType = 'AFTER_APPROVAL';
		const s2 = await e.check(projects);
		assert.ok(!hit(s2, OK, 'rilascio'));
		radarState = undefined;
	});

	await test('stato dal disco prima del primo controllo; un controllo alla volta', async () => {
		const e2 = engine();
		const st = e2.state();
		assert.ok(st.checkedAt > 0);
		assert.ok(hit(st, A, 'build'));
		assert.strictEqual(st.running, false);
		let seen = 0;
		e2.onChange(() => seen++);
		const [x, y] = await Promise.all([e2.check(projects), e2.check(projects)]);
		assert.strictEqual(x, y);
		assert.ok(seen >= 2);
	});

	await test('force rifa tutto', async () => {
		calls.length = 0;
		await e.check(projects, { force: true });
		assert.strictEqual(e.lastTiming.recomputed, 10);
		assert.ok(calls.some(c => c.cmd === 'gh'));
	});

	// ---------- radar ----------

	const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const KEYFILE = path.join(TMP, 'chiave-finta.p8');
	fs.writeFileSync(KEYFILE, privateKey.export({ type: 'pkcs8', format: 'pem' }));
	const ENVFILE = path.join(TMP, 'asc.env');
	fs.writeFileSync(ENVFILE, `# finto\nASC_KEY_ID=PROVA12345\nASC_ISSUER_ID="00000000-0000-0000-0000-000000000000"\nASC_PRIVATE_KEY_PATH=${KEYFILE}\n`);
	const ADMOB = path.join(TMP, 'admob');
	put(ADMOB, 'secrets/client_secret.json', JSON.stringify({ installed: { client_id: 'id-finto', client_secret: 'segreto-finto' } }));
	const TOKEN_JSON = JSON.stringify({ access_token: 'scaduto-finto', refresh_token: 'rinnovo-finto', expiry_date: 1, scope: 'x', token_type: 'Bearer' });
	put(ADMOB, 'secrets/token.json', TOKEN_JSON);
	const XC = path.join(TMP, 'xcode', 'app-finta');
	put(XC, 'AppFinta.xcodeproj/project.pbxproj', [
		'PRODUCT_BUNDLE_IDENTIFIER = com.esempio.finta.widget;',
		'PRODUCT_BUNDLE_IDENTIFIER = "com.esempio.finta";',
		'PRODUCT_BUNDLE_IDENTIFIER = "$(PRODUCT_BUNDLE_IDENTIFIER).tests";',
	].join('\n'));
	const proj = { name: 'app-finta', path: XC, root: path.dirname(XC), kinds: ['apple'], xcodeProject: path.join(XC, 'AppFinta.xcodeproj'), hasClaudeMd: false, sessions: [], live: [], touchedAt: 0 };

	const d0 = new Date(NOW);
	const dayKey = k => {
		const d = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - k);
		return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
	};
	const row = (k, app, micros) => ({ row: { dimensionValues: { DATE: { value: dayKey(k) }, APP: { value: app } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: String(micros) } } } });
	const version = (id, v, state, extra = {}) => ({ type: 'appStoreVersions', id, attributes: { platform: 'IOS', versionString: v, appStoreState: state, createdDate: extra.at || '2026-01-01T00:00:00Z', releaseType: extra.rt || 'AFTER_APPROVAL' } });
	const V1 = version('v1', '1.0', 'READY_FOR_SALE');
	const V2 = version('v2', '1.1', 'WAITING_FOR_REVIEW', { at: '2026-09-01T00:00:00Z', rt: 'MANUAL' });
	const V3 = version('v3', '3.2', 'READY_FOR_SALE');
	const reqs = [];
	const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
	const fakeFetch = async (url, init = {}) => {
		const u = new URL(url);
		const method = init.method || 'GET';
		reqs.push({ method, host: u.host, path: u.pathname, search: u.search, auth: init.headers?.Authorization, body: init.body });
		if (u.host === 'oauth2.googleapis.com') return json({ access_token: 'accesso-finto', expires_in: 3600 });
		if (u.host === 'admob.googleapis.com') {
			if (u.pathname === '/v1/accounts') return json({ account: [{ name: 'accounts/pub-0000000000000000' }] });
			if (u.pathname.endsWith('/apps')) return json({ apps: [
				{ appId: 'ca-app-pub-0~1', platform: 'IOS', linkedAppInfo: { appStoreId: '1000000001' } },
				{ appId: 'ca-app-pub-0~2', platform: 'ANDROID', linkedAppInfo: { androidAppStoreId: 'com.esempio.android' } },
			] });
			if (u.pathname.endsWith('networkReport:generate')) return json([
				{ header: { localizationSettings: { currencyCode: 'EUR' } } },
				row(1, 'ca-app-pub-0~1', 1500000), row(3, 'ca-app-pub-0~1', 250000), row(1, 'ca-app-pub-0~2', 1000000),
				{ footer: { matchingRowCount: '3' } },
			]);
		}
		if (u.host === 'api.appstoreconnect.apple.com') {
			const p = u.pathname;
			if (p === '/v1/apps') return json({
				data: [
					{ type: 'apps', id: '1000000001', attributes: { name: 'Finta', bundleId: 'com.esempio.finta' }, relationships: { appStoreVersions: { data: [{ type: 'appStoreVersions', id: 'v1' }, { type: 'appStoreVersions', id: 'v2' }] } } },
					{ type: 'apps', id: '1000000002', attributes: { name: 'Vecchia', bundleId: 'com.esempio.vecchia' }, relationships: { appStoreVersions: { data: [{ type: 'appStoreVersions', id: 'v3' }] } } },
					{ type: 'apps', id: '1000000003', attributes: { name: 'Mai uscita', bundleId: 'com.esempio.mai' }, relationships: { appStoreVersions: { data: [] } } },
				],
				included: [V1, V2, V3],
				links: {},
			});
			if (p === '/v1/appStoreVersions/v2/build') return json({ data: { type: 'builds', id: 'b', attributes: { version: '42' } } });
			if (p === '/v1/apps/1000000001/customerReviews') return json({ data: [{ type: 'customerReviews', id: 'r', attributes: { rating: 5, title: 'Bella', body: 'Funziona', createdDate: '2026-09-20T10:00:00Z', territory: 'ITA' } }] });
			if (p === '/v1/apps/1000000002/customerReviews') return json({ data: [] });
			if (p === '/v1/apps/1000000001/appStoreVersions') return json({ data: [V1, V2] });
			if (p === '/v1/appStoreVersions/v2' && method === 'PATCH') return json({ data: { type: 'appStoreVersions', id: 'v2' } });
		}
		return json({ errors: [{ title: 'non previsto' }] }, 404);
	};
	const RDIR = path.join(TMP, 'casa', 'radar');
	const radarOpts = { dir: RDIR, fetch: fakeFetch, now, ascEnvFile: ENVFILE, admobDir: ADMOB };
	const radar = new Radar(radarOpts);
	let r1;

	await test('radar: bundle id dal pbxproj, il piu corto prima, senza variabili', () => {
		assert.deepStrictEqual(projectBundleIds(proj), ['com.esempio.finta', 'com.esempio.finta.widget']);
	});

	await test('radar: JWT ES256 ben formato e verificabile con la chiave pubblica', () => {
		const t = ascToken('PROVA12345', 'emittente', privateKey.export({ type: 'pkcs8', format: 'pem' }), 1_790_000_000_000);
		const [h, p, s] = t.split('.');
		assert.deepStrictEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'PROVA12345', typ: 'JWT' });
		const pl = JSON.parse(Buffer.from(p, 'base64url'));
		assert.deepStrictEqual(pl, { iss: 'emittente', iat: 1_790_000_000, exp: 1_790_001_200, aud: 'appstoreconnect-v1' });
		const sig = Buffer.from(s, 'base64url');
		assert.strictEqual(sig.length, 64);
		assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig));
	});

	await test('radar: lettura completa con fetch finto', async () => {
		const before = radar.state();
		assert.deepStrictEqual(before.apps, []);
		assert.strictEqual(before.ascAt, 0);
		r1 = await radar.refresh([proj]);
		assert.strictEqual(r1.ascError, undefined, r1.ascError);
		assert.strictEqual(r1.admobError, undefined, r1.admobError);
		assert.strictEqual(r1.apps.length, 2, 'la mai uscita non si mostra');
		const a = r1.apps[0];
		assert.strictEqual(a.name, 'Finta');
		assert.strictEqual(a.projectPath, XC);
		assert.deepStrictEqual(
			{ ...a.version, at: undefined },
			{ string: '1.1', state: 'WAITING_FOR_REVIEW', label: 'in attesa di revisione', tone: 'attesa', build: '42', releaseType: 'MANUAL', at: undefined },
		);
		assert.strictEqual(a.live, '1.0');
		assert.deepStrictEqual(a.reviews, [{ stars: 5, title: 'Bella', body: 'Funziona', territory: 'ITA', at: Date.parse('2026-09-20T10:00:00Z') }]);
		assert.deepStrictEqual(a.money, { yesterday: 1.5, last7: 1.75, daily: [0, 0, 0, 0, 0.25, 0, 1.5], currency: 'EUR' });
		assert.deepStrictEqual(r1.totals, { yesterday: 2.5, last7: 2.75, daily: [0, 0, 0, 0, 0.25, 0, 2.5], currency: 'EUR' });
		const b = r1.apps[1];
		assert.strictEqual(b.projectPath, undefined);
		assert.strictEqual(b.version.label, 'pubblicata');
		assert.strictEqual(b.version.tone, 'ok');
		assert.strictEqual(b.money, undefined);
		assert.strictEqual(r1.ascAt, NOW);
		assert.strictEqual(r1.admobAt, NOW);
		const asc = reqs.filter(r => r.host === 'api.appstoreconnect.apple.com');
		assert.strictEqual(asc.length, 4, 'elenco, una build, due recensioni');
		const [h, p] = asc[0].auth.replace('Bearer ', '').split('.');
		assert.strictEqual(JSON.parse(Buffer.from(h, 'base64url')).kid, 'PROVA12345');
		assert.strictEqual(JSON.parse(Buffer.from(p, 'base64url')).aud, 'appstoreconnect-v1');
		assert.ok(reqs.some(r => r.host === 'oauth2.googleapis.com' && /grant_type=refresh_token/.test(r.body)));
	});

	await test('radar: cache 700/600 su disco, senza segreti; token.json di admob-mcp intatto', () => {
		const f = path.join(RDIR, 'stato.json');
		assert.strictEqual(fs.statSync(RDIR).mode & 0o777, 0o700);
		assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
		const raw = fs.readFileSync(f, 'utf8');
		for (const s of ['accesso-finto', 'rinnovo-finto', 'segreto-finto', 'PRIVATE KEY', 'Bearer']) assert.ok(!raw.includes(s), s);
		assert.strictEqual(fs.readFileSync(path.join(ADMOB, 'secrets/token.json'), 'utf8'), TOKEN_JSON);
	});

	await test('radar: 45 minuti tra due letture, salvo force', async () => {
		const n = reqs.length;
		NOW += 10 * 60_000;
		await radar.refresh([proj]);
		assert.strictEqual(reqs.length, n);
	});

	await test('radar: senza rete mostra l\'ultimo dato con la sua eta e l\'errore in italiano', async () => {
		const ascAt = r1.ascAt;
		const off = new Radar({ ...radarOpts, fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
		const st = off.state();
		assert.strictEqual(st.apps.length, 2);
		assert.strictEqual(st.ascAt, ascAt);
		const s = await off.refresh([proj], { force: true });
		assert.match(s.ascError, /^App Store Connect non risponde/);
		assert.match(s.admobError, /^AdMob non risponde/);
		assert.strictEqual(s.apps.length, 2);
		assert.strictEqual(s.ascAt, ascAt);
		assert.strictEqual(s.apps[0].money.yesterday, 1.5, 'i soldi restano quelli dell\'ultima lettura');
		assert.ok(!/[–—]/.test(s.ascError + s.admobError));
	});

	await test('radar e regole: la versione in attesa senza rilascio automatico accende il rosso', async () => {
		const live = new Radar(radarOpts);
		const xrepo = git(path.dirname(XC), 'init', '-q', XC);
		commit(XC, 'Primo', { 'note.md': 'uno\n' });
		const ps = (await scanProjects([path.dirname(XC)], [], [], []));
		const e3 = new RulesEngine({ cacheFile: path.join(TMP, 'casa', 'regole-2.json'), configFile: CONFIG, run, fetch: adsFetch, now, radar: () => live.state() });
		const s = await e3.check(ps);
		const h = hit(s, XC, 'rilascio');
		assert.ok(h, JSON.stringify(s.projects[XC]));
		assert.strictEqual(h.frase, 'La versione 1.1 di Finta è in attesa di revisione con il rilascio manuale.');
		void xrepo;
	});

	await test('radar: rilascio automatico con PATCH sulla versione in lavorazione', async () => {
		const n = reqs.length;
		const frase = await radar.setAutomaticRelease(XC);
		assert.strictEqual(frase, 'La versione 1.1 di Finta uscirà da sola appena approvata.');
		const patch = reqs.slice(n).find(r => r.method === 'PATCH');
		assert.ok(patch);
		assert.strictEqual(patch.path, '/v1/appStoreVersions/v2');
		assert.deepStrictEqual(JSON.parse(patch.body), { data: { type: 'appStoreVersions', id: 'v2', attributes: { releaseType: 'AFTER_APPROVAL' } } });
		assert.strictEqual(radar.state().apps[0].version.releaseType, 'AFTER_APPROVAL');
		await assert.rejects(radar.setAutomaticRelease(path.join(TMP, 'nessuno')), /non è collegato/);
	});

	await test('nessuna lineetta lunga nei testi di regole e radar', () => {
		for (const f of ['regole.ts', 'radar.ts']) assert.ok(!/[\u2013\u2014]/.test(fs.readFileSync(path.join(SRC, f), 'utf8')), f);
	});

	// ---------- collaudo reale (facoltativo) ----------

	if (process.env.BOTTEGA_TEST_REALE === '1') {
		await test('REALE: App Store Connect e AdMob, solo conteggi', async () => {
			const pkg = require(path.join(__dirname, '..', 'package.json'));
			const roots = pkg.contributes.configuration.properties['bottega.roots'].default;
			const ignore = pkg.contributes.configuration.properties['bottega.ignore'].default;
			const ps = await scanProjects(roots, ignore, [], []);
			const real = new Radar({ dir: path.join(TMP, 'radar-reale') });
			const t0 = Date.now();
			const s = await real.refresh(ps, { force: true });
			const ms = Date.now() - t0;
			const working = s.apps.filter(a => a.version && !['READY_FOR_SALE', 'REPLACED_WITH_NEW_VERSION'].includes(a.version.state));
			console.log(`      progetti ${ps.length}, app mostrate ${s.apps.length}, collegate a un progetto ${s.apps.filter(a => a.projectPath).length}, ` +
				`in lavorazione ${working.length}, senza rilascio automatico ${working.filter(a => a.version.releaseType !== 'AFTER_APPROVAL').length}, ` +
				`recensioni ${s.apps.reduce((n, a) => n + a.reviews.length, 0)}, app con guadagni ${s.apps.filter(a => a.money).length}, ` +
				`giorni di guadagni ${s.totals ? s.totals.daily.filter(x => x > 0).length : 0}/7, ${ms} ms`);
			assert.strictEqual(s.ascError, undefined, s.ascError);
			assert.strictEqual(s.admobError, undefined, s.admobError);
			assert.ok(s.apps.length > 0);
			assert.ok(s.totals && s.totals.daily.length === 7);
		});
	}

	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
