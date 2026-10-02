#!/usr/bin/env node
// Banco di prova degli aggiornamenti (src/aggiorna.ts): rete finta, file in una cartella temporanea, nessuno script
// lanciato davvero.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const esbuild = require('esbuild');

const OUT = path.join(__dirname, 'test-out', 'aggiorna');
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'aggiorna.ts')], outdir: OUT, format: 'cjs', platform: 'node', bundle: false, target: 'node20', logLevel: 'silent' });
const ag = require(path.join(OUT, 'aggiorna.js'));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-aggiorna-'));

/** Rete finta: Open VSX con quella Claude Code, GitHub con quella VS Code. */
function rete({ claude = '2.1.288', motore = '^1.94.0', vscode = '1.141.0', giu = false } = {}) {
	const chiesti = [];
	const fetchFn = async url => {
		chiesti.push(url);
		if (giu) return { ok: false, status: 503, json: async () => ({}) };
		if (url.includes('open-vsx.org')) return { ok: true, status: 200, json: async () => ({ version: claude, engines: { vscode: motore } }) };
		if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => ({ tag_name: vscode }) };
		return { ok: false, status: 404, json: async () => ({}) };
	};
	return { fetchFn, chiesti };
}

function memoria() {
	const m = new Map();
	return { get: k => m.get(k), update: (k, v) => m.set(k, v), m };
}

function banco(opts = {}) {
	const r = rete(opts.rete);
	const notifiche = [];
	const installate = [];
	const lanciati = [];
	const dir = fs.mkdtempSync(path.join(tmp, 'b-'));
	const sorgenti = path.join(dir, 'sorgenti');
	fs.mkdirSync(path.join(sorgenti, 'scripts'), { recursive: true });
	fs.writeFileSync(path.join(sorgenti, 'bottega.json'), '{}');
	fs.writeFileSync(path.join(sorgenti, 'scripts', 'build.sh'), '');
	fs.writeFileSync(path.join(sorgenti, 'scripts', 'aggiorna-vscode.sh'), '');
	let ora = 1_000_000_000;
	let risposta = opts.risposta ?? false;
	const a = new ag.Aggiornamenti({
		installato: opts.installato ?? '1.140.0',
		sorgenti,
		fetchFn: r.fetchFn,
		claudeInstallato: () => opts.claude ?? '2.1.287',
		installaClaude: async v => installate.push(v),
		chiedi: async () => risposta,
		notifica: n => notifiche.push(n),
		log: () => {},
		stato: memoria(),
		fileEsito: path.join(dir, 'aggiornamento.json'),
		fileLog: path.join(dir, 'aggiornamento.log'),
		accesi: () => ({ vscode: true, claude: true, ...(opts.accesi || {}) }),
		now: () => ora,
		lancia: (script, tag, log) => lanciati.push({ script, tag, log }),
	});
	return { a, r, notifiche, installate, lanciati, dir, sorgenti, avanza: ms => (ora += ms), rispondi: v => (risposta = v) };
}

(async () => {
	console.log('aggiornamenti');

	await test('versioni: si leggono anche dai vincoli di engines e si confrontano per numero', () => {
		assert.deepStrictEqual(ag.versione('^1.94.0'), [1, 94, 0]);
		assert.deepStrictEqual(ag.versione('>=1.140.2'), [1, 140, 2]);
		assert.deepStrictEqual(ag.versione('1.95.x'), [1, 95, 0]);
		assert.strictEqual(ag.versione('*'), null);
		assert.ok(ag.confronta('1.140.0', '1.94.0') > 0, '140 viene dopo 94');
		assert.ok(ag.confronta('1.140.0', '1.140.1') < 0);
		assert.strictEqual(ag.confronta('1.141.0', '1.141.0'), 0);
	});

	await test('VS Code: con margine non serve niente e GitHub non si chiama', async () => {
		const r = rete({ motore: '^1.94.0' });
		const v = await ag.controllaVSCode('1.140.0', r.fetchFn);
		assert.strictEqual(v.serve, false);
		assert.strictEqual(v.minimo, '1.94.0');
		assert.strictEqual(v.claude, '2.1.288');
		assert.ok(!r.chiesti.some(u => u.includes('github')), 'GitHub solo se serve');
	});

	await test('VS Code: Claude Code chiede di piu', async () => {
		const v = await ag.controllaVSCode('1.140.0', rete({ motore: '^1.141.0', vscode: '1.142.1' }).fetchFn);
		assert.deepStrictEqual([v.serve, v.minimo, v.bersaglio], [true, '1.141.0', '1.142.1']);
		const w = await ag.controllaVSCode('1.140.0', rete({ motore: '^1.150.0', vscode: '1.142.1' }).fetchFn);
		assert.deepStrictEqual([w.serve, w.bersaglio], [true, ''], 'Microsoft non ha ancora pubblicato quella che serve');
	});

	await test('notifica con Aggiorna e Dopo; Dopo la tace per tre giorni sulla stessa versione', async () => {
		const b = banco({ rete: { motore: '^1.141.0', vscode: '1.141.2' } });
		await b.a.controllaVSCode(true);
		assert.strictEqual(b.notifiche.length, 1);
		const n = b.notifiche[0];
		assert.strictEqual(n.id, 'aggiorna:1.141.2');
		assert.deepStrictEqual(n.actions.map(x => x.id), ['aggiorna', 'dopo']);
		assert.ok(!/[\u2014\u2013]/.test(n.title + n.body), 'niente lineette lunghe');
		await b.a.clic(n.id, 'dopo');
		b.avanza(25 * 3600_000);
		await b.a.controllaVSCode(false);
		assert.strictEqual(b.notifiche.length, 1, 'rinviata: niente notifica il giorno dopo');
		b.avanza(3 * 24 * 3600_000);
		await b.a.controllaVSCode(false);
		assert.strictEqual(b.notifiche.length, 2, 'dopo tre giorni torna');
		assert.strictEqual(b.lanciati.length, 0);
	});

	await test('un controllo al giorno, non di piu', async () => {
		const b = banco({ rete: { motore: '^1.94.0' } });
		await b.a.controllaVSCode(false);
		const n = b.r.chiesti.length;
		b.avanza(3600_000);
		await b.a.controllaVSCode(false);
		assert.strictEqual(b.r.chiesti.length, n, 'dopo un\'ora non richiede');
		b.avanza(21 * 3600_000);
		await b.a.controllaVSCode(false);
		assert.ok(b.r.chiesti.length > n, 'il giorno dopo si');
	});

	await test('Aggiorna lancia lo script con la versione; il clic sul corpo chiede prima', async () => {
		const b = banco({ rete: { motore: '^1.141.0', vscode: '1.141.2' } });
		await b.a.clic('aggiorna:1.141.2', undefined);
		assert.strictEqual(b.lanciati.length, 0, 'risposta no: non parte');
		b.rispondi(true);
		await b.a.clic('aggiorna:1.141.2', undefined);
		assert.strictEqual(b.lanciati.length, 1, 'risposta si: parte');
		assert.strictEqual(b.lanciati[0].tag, '1.141.2');
		assert.strictEqual(b.lanciati[0].script, path.join(b.sorgenti, 'scripts', 'aggiorna-vscode.sh'));
		b.a.dispose();
		const c = banco();
		await c.a.clic('aggiorna:1.141.2', 'aggiorna');
		assert.strictEqual(c.lanciati.length, 1, 'il pulsante Aggiorna parte subito');
		await c.a.clic('aggiorna:1.141.2', 'dismiss');
		await c.a.clic('job:x', 'aggiorna');
		assert.strictEqual(c.lanciati.length, 1, 'chiusa o di un altro: niente');
		c.a.dispose();
	});

	await test('una versione strana non lancia niente; uno script gia in corso nemmeno', async () => {
		const b = banco();
		assert.strictEqual(b.a.avvia('1.141.0; rm -rf ~'), false);
		fs.writeFileSync(path.join(b.dir, 'aggiornamento.json'), JSON.stringify({ stato: 'in corso', tag: '1.141.0', at: 1_000_000_000 }));
		assert.strictEqual(b.a.avvia('1.141.0'), false);
		assert.strictEqual(b.lanciati.length, 0);
		assert.match(b.notifiche.at(-1).body, /gia' un aggiornamento in corso/);
		// rimasto in corso da ore: era morto, non blocca piu'
		b.avanza(4 * 3600_000);
		assert.strictEqual(b.a.avvia('1.141.0'), true);
		b.a.dispose();
	});

	await test("l'esito si dice una volta sola, poi resta segnato come detto", () => {
		const b = banco();
		const f = path.join(b.dir, 'aggiornamento.json');
		fs.writeFileSync(f, JSON.stringify({ stato: 'fallito', tag: '1.141.0', at: 1, motivo: 'patch fallita: in build/lib/extensions.ts il testo da sostituire compare 0 volte' }));
		b.a.annunciaEsito();
		assert.strictEqual(b.notifiche.length, 1);
		assert.match(b.notifiche[0].body, /resta com'era/);
		assert.match(b.notifiche[0].body, /patch fallita/);
		b.a.annunciaEsito();
		assert.strictEqual(b.notifiche.length, 1, 'la seconda volta no');
		fs.writeFileSync(f, JSON.stringify({ stato: 'fatto', tag: '1.141.0', at: 1, build: 40, push: false }));
		b.a.annunciaEsito();
		assert.strictEqual(b.notifiche[1].title, 'Bottega su VS Code 1.141.0');
		assert.match(b.notifiche[1].body, /build 40/);
		assert.match(b.notifiche[1].body, /non spinto/);
	});

	await test('Claude Code: installa la versione nuova, non quella uguale ne quella che chiede un VS Code piu nuovo', async () => {
		let b = banco({ claude: '2.1.287', rete: { claude: '2.1.288' } });
		assert.strictEqual(await b.a.controllaClaude(), '2.1.288');
		assert.deepStrictEqual(b.installate, ['2.1.288']);
		b = banco({ claude: '2.1.288', rete: { claude: '2.1.288' } });
		assert.strictEqual(await b.a.controllaClaude(), '');
		b = banco({ claude: '2.1.287', rete: { claude: '2.2.0', motore: '^1.141.0' } });
		assert.strictEqual(await b.a.controllaClaude(), '', 'chiede VS Code 1.141: ci pensa la notifica');
		b = banco({ claude: '2.1.287', accesi: { claude: false } });
		assert.strictEqual(await b.a.controllaClaude(), '', 'spento dalle impostazioni');
		b = banco({ claude: '2.1.287', rete: { giu: true } });
		assert.strictEqual(await b.a.controllaClaude(), '', 'Open VSX giu: niente, senza eccezioni');
		assert.strictEqual(b.installate.length, 0);
	});

	await test('i sorgenti: product.json, poi impostazione, poi ~/Prototipi/Bottega', () => {
		const home = fs.mkdtempSync(path.join(tmp, 'home-'));
		const app = fs.mkdtempSync(path.join(tmp, 'app-'));
		const vera = path.join(home, 'Prototipi', 'Bottega');
		fs.mkdirSync(path.join(vera, 'scripts'), { recursive: true });
		fs.writeFileSync(path.join(vera, 'bottega.json'), '{}');
		fs.writeFileSync(path.join(vera, 'scripts', 'build.sh'), '');
		assert.strictEqual(ag.trovaSorgenti(app, '', home), vera);
		const altrove = path.join(home, 'altrove');
		fs.mkdirSync(path.join(altrove, 'scripts'), { recursive: true });
		fs.writeFileSync(path.join(altrove, 'bottega.json'), '{}');
		fs.writeFileSync(path.join(altrove, 'scripts', 'build.sh'), '');
		fs.writeFileSync(path.join(app, 'product.json'), JSON.stringify({ bottegaSorgenti: altrove }));
		assert.strictEqual(ag.trovaSorgenti(app, '', home), altrove);
		fs.writeFileSync(path.join(app, 'product.json'), JSON.stringify({ bottegaSorgenti: '/non/esiste' }));
		assert.strictEqual(ag.trovaSorgenti(app, '~/altrove', home), altrove);
	});

	await test('lo script: sintassi zsh, versione controllata, commit solo di bottega.json e Version.xcconfig', () => {
		const script = path.join(__dirname, '..', '..', '..', 'scripts', 'aggiorna-vscode.sh');
		const s = fs.readFileSync(script, 'utf8');
		require('child_process').execFileSync('/bin/zsh', ['-n', script]);
		assert.ok(s.includes("^[0-9]+\\.[0-9]+\\.[0-9]+$"), 'la versione si controlla prima di usarla');
		assert.ok(/-- bottega\.json ios\/Version\.xcconfig/.test(s), 'il commit prende solo quei due file');
		assert.ok(s.includes('indietro'), 'se la compilazione si ferma bottega.json torna com\'era');
		assert.ok(!/[\u2014\u2013]/.test(s), 'niente lineette lunghe');
	});

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
