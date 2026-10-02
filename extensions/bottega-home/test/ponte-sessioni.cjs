#!/usr/bin/env node
// Banco di prova della scheda di sessione per l'iPhone (src/ponte-sessioni.ts, docs/CONTRATTI.md 9.5): passi in
// chiaro, domanda in primo piano, risposta nel terminale solo per i lavori della Bottega, git in sola lettura dentro
// il progetto, diretta che si ferma quando nessuno guarda, terminale ripulito, segui, riassunto. Tutto finto:
// trascrizioni, registro e repository inventati in una cartella temporanea.

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const assert = require('assert');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'test-out', 'ponte-sessioni');
esbuild.buildSync({
	entryPoints: ['ponte.ts', 'dispositivo.ts', 'ponte-sessioni.ts', 'mani.ts', 'schermo.ts', 'sessione-lettura.ts', 'avvisi.ts', 'apns.ts'].map(f => path.join(SRC, f)),
	outdir: OUT, format: 'cjs', platform: 'node', bundle: false, target: 'node20', logLevel: 'silent',
});
const { Ponte } = require(path.join(OUT, 'ponte.js'));
const { SessioniPonte, testoRiassunto } = require(path.join(OUT, 'ponte-sessioni.js'));
const { Schermo } = require(path.join(OUT, 'schermo.js'));
const { Avvisi } = require(path.join(OUT, 'avvisi.js'));
const { leggiCoda, domandaDi, passoBreve, nuovoConto, contaToken, totaleToken } = require(path.join(OUT, 'sessione-lettura.js'));

let passed = 0;
const ok = name => (passed++, console.log('  ok  ' + name));
const attendi = ms => new Promise(r => setTimeout(r, ms));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-sessioni-')));
const radice = path.join(tmp, 'projects');
const registro = path.join(tmp, 'sessions');
const progetto = path.join(tmp, 'progetto-prova');
const fuori = path.join(tmp, 'altrove');
for (const d of [radice, registro, progetto, fuori, path.join(radice, '-tmp-progetto-prova')]) fs.mkdirSync(d, { recursive: true });

// un repository finto: un file cambiato, uno nuovo, uno ignorato con un segreto inventato
const git = (...a) => execFileSync('git', a, { cwd: progetto, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
git('init', '-q');
git('config', 'user.email', 'prova@esempio.it');
git('config', 'user.name', 'Prova');
fs.writeFileSync(path.join(progetto, 'ponte.ts'), 'riga uno\nriga due\nriga tre\n');
fs.writeFileSync(path.join(progetto, '.gitignore'), '.env\n');
git('add', '.');
git('commit', '-q', '-m', 'primo');
fs.writeFileSync(path.join(progetto, 'ponte.ts'), 'riga uno\nriga DUE\nriga tre\nriga quattro\n');
fs.writeFileSync(path.join(progetto, 'nuovo.md'), 'ciao\nmondo\n');
fs.writeFileSync(path.join(progetto, '.env'), 'CHIAVE=finta-non-deve-uscire\n');
fs.writeFileSync(path.join(fuori, 'segreto.txt'), 'contenuto-esterno\n');

const SID = '11111111-2222-3333-4444-555555555555';
const SID2 = '66666666-7777-8888-9999-000000000000';
const jsonl = path.join(radice, '-tmp-progetto-prova', SID + '.jsonl');
const ora = Date.parse('2026-10-02T10:00:00Z');
const ts = s => new Date(ora + s * 1000).toISOString();
const riga = o => JSON.stringify(o) + '\n';
const usage = (i, o) => ({ input_tokens: i, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: o });
fs.writeFileSync(jsonl,
	riga({ type: 'user', cwd: progetto, timestamp: ts(0), message: { role: 'user', content: 'Sistema il ponte e lancia i test' } }) +
	riga({ type: 'assistant', cwd: progetto, timestamp: ts(5), uuid: 'a1', message: { id: 'm1', usage: usage(100, 20), content: [{ type: 'text', text: 'Comincio dal ponte.' }] } }) +
	riga({ type: 'assistant', cwd: progetto, timestamp: ts(6), uuid: 'a2', message: { id: 'm1', usage: usage(100, 20), content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: path.join(progetto, 'ponte.ts') } }] } }) +
	riga({ type: 'user', cwd: progetto, timestamp: ts(7), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }) +
	riga({ type: 'assistant', cwd: progetto, timestamp: ts(8), uuid: 'a3', message: { id: 'm2', usage: usage(50, 30), content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'SEGRETO=x npm test -- --watch=false', description: 'Lancia i test' } }] } }),
);
// la sessione aspetta il permesso per Bash (campo waitingFor del registro di Claude Code)
const scriviRegistro = (pid, extra) => fs.writeFileSync(path.join(registro, `${pid}.json`), JSON.stringify({ pid, sessionId: pid === 4242 ? SID : SID2, cwd: progetto, startedAt: ora - 600_000, status: 'waiting', ...extra }));
scriviRegistro(4242, { waitingFor: 'approve Bash: SEGRETO=x npm test -- --watch=false' });

const lavori = [
	{ key: 'job:job-1', source: 'bottega', status: 'ti aspetta', project: 'progetto-prova', path: progetto, title: 'Sistema il ponte', since: ora, jobId: 'job-1', sessionId: SID, pid: 4242 },
	{ key: `sess:${SID2}`, source: 'altrove', status: 'ti aspetta', project: 'progetto-prova', path: progetto, title: 'Sessione in iTerm', since: ora, sessionId: SID2, pid: 4343 },
	{ key: 'sess:fuori', source: 'altrove', status: 'in corso', project: 'altrove', path: fuori, title: 'Fuori', since: ora, sessionId: 'abcdefab-0000-0000-0000-000000000000', pid: 1 },
];
fs.writeFileSync(path.join(radice, '-tmp-progetto-prova', SID2 + '.jsonl'),
	riga({ type: 'user', cwd: progetto, timestamp: ts(0), message: { content: 'Va bene il nome?' } }) +
	riga({ type: 'assistant', cwd: progetto, timestamp: ts(3), uuid: 'b1', message: { id: 'n1', usage: usage(10, 5), content: [{ type: 'text', text: 'Ho finito. Vuoi che faccia anche il commit?' }] } }));
scriviRegistro(4343, { status: 'idle' });

function call(port, token, method, url, body) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
		const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { authorization: `Bearer ${token}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, res => {
			const parti = [];
			res.on('data', c => parti.push(c));
			res.on('end', () => {
				const t = Buffer.concat(parti).toString();
				let b = t;
				try {
					b = JSON.parse(t);
				} catch {
					// ndjson o testo
				}
				resolve({ status: res.statusCode, body: b, testo: t });
			});
		});
		req.on('error', reject);
		if (data) req.write(data);
		req.end();
	});
}

/** Un flusso SSE: raccoglie gli oggetti `data:` finche' non lo si chiude. */
function flusso(port, token, url) {
	const dati = [];
	let req;
	const pronto = new Promise((resolve, reject) => {
		req = http.request({ host: '127.0.0.1', port, path: url, headers: { authorization: `Bearer ${token}` } }, res => {
			let buf = '';
			res.on('data', c => {
				buf += c;
				let i;
				while ((i = buf.indexOf('\n\n')) >= 0) {
					const ev = buf.slice(0, i);
					buf = buf.slice(i + 2);
					if (ev.startsWith('data: ')) dati.push(JSON.parse(ev.slice(6)));
				}
			});
			resolve(res.statusCode);
		});
		req.on('error', reject);
		req.end();
	});
	return { dati, pronto, chiudi: () => req.destroy() };
}

(async () => {
	// ---------- lettura pura ----------
	const l = leggiCoda(fs.readFileSync(jsonl, 'utf8'));
	assert.strictEqual(l.richiesta, 'Sistema il ponte e lancia i test');
	assert.strictEqual(l.risposta, 'Comincio dal ponte.');
	assert.deepStrictEqual(l.passi.map(p => p.testo), ['ha modificato ponte.ts', 'sta lanciando Lancia i test']);
	assert.ok(l.passi[1].inCorso && !l.passi[0].inCorso);
	assert.strictEqual(l.aperti.length, 1);
	ok('passi in chiaro, al passato e in corso');

	const d = domandaDi(l, { status: 'waiting', waitingFor: 'approve Bash: SEGRETO=x npm test -- --watch=false' }, true, SID);
	assert.strictEqual(d.tipo, 'permesso');
	assert.strictEqual(d.strumento, 'Bash');
	assert.strictEqual(d.comando, 'SEGRETO=x npm test -- --watch=false');
	assert.strictEqual(d.testo, 'Lancia i test');
	const d2 = domandaDi(l, { status: 'waiting', waitingFor: 'approve Bash: altro comando' }, true, SID);
	assert.notStrictEqual(d.id, d2.id, 'domanda nuova, id nuovo');
	assert.strictEqual(domandaDi(l, { status: 'waiting', waitingFor: 'dialog open' }, true, SID).tipo, 'finestra');
	assert.strictEqual(domandaDi(l, { status: 'busy' }, false, SID), undefined, 'al lavoro: nessuna domanda');
	ok('domanda: permesso dal registro, finestra, niente se lavora');

	// per la Live Activity: mai argomenti o percorsi
	assert.strictEqual(passoBreve('Bash', { command: 'SEGRETO=x npm test -- --watch=false' }, true), 'lancia npm');
	assert.strictEqual(passoBreve('Bash', { command: 'curl -H "Authorization: x" https://esempio.it' }, false), 'ha lanciato curl');
	assert.strictEqual(passoBreve('Edit', { file_path: '/Users/prova/segreti/ponte.ts' }, false), 'ha modificato ponte.ts');
	ok('passo breve per APNs: solo programma o nome del file');

	const conto = nuovoConto();
	const tutto = fs.readFileSync(jsonl);
	contaToken(conto, tutto.subarray(0, 300).toString(), 300);
	contaToken(conto, tutto.subarray(300).toString(), tutto.length - 300);
	const tk = totaleToken(conto);
	assert.deepStrictEqual(tk, { entrata: 110 + 60, uscita: 20 + 30, contesto: 60 + 1000 }, 'm1 contato una volta sola');
	ok('token: una volta per messaggio, anche spezzati tra due letture');

	const sch = new Schermo();
	sch.scrivi('\x1b[31mriga uno\x1b[0m\r\nriga due\r\n> scrivo');
	sch.scrivi('\x1b[2K\r> ho\x1b');
	sch.scrivi('[1A\rscritto sopra\x1b[K\x1b]0;titolo\x07');
	assert.deepStrictEqual(sch.testo(), ['riga uno', 'scritto sopra', '> ho']);
	const s2 = new Schermo();
	s2.scrivi('a\r\nb\r\nc\x1b[2A\x1b[0J\x1b[1Gnuovo');
	assert.deepStrictEqual(s2.testo(), ['nuovo']);
	ok('schermo: colori via, riga cancellata, cursore su, sequenze spezzate, titoli scartati');

	// ---------- il ponte con la scheda ----------
	const scritti = [];
	let cambi = 0;
	let terminaleAperto = 0;
	let datiTerminale;
	let fineTerminale;
	const sessioni = new SessioniPonte({
		lavori: () => lavori,
		progetti: () => [progetto],
		scrivi: (id, dati, invio) => (id === 'job-1' ? (scritti.push([dati, invio]), true) : false),
		terminale: id => (id === 'job-1' ? {
			ascolta(dati, fine) {
				terminaleAperto++;
				datiTerminale = dati;
				fineTerminale = fine;
				return () => terminaleAperto--;
			},
		} : undefined),
		cambiato: () => cambi++,
		log: () => undefined,
		radice, registro,
		ogniMs: 60, seguiOgniMs: 60, pausaEsc: 5,
	});
	let occupata = false;
	const domande = [];
	const port = 20000 + Math.floor(Math.random() * 20000);
	const dir = path.join(tmp, 'bottega');
	const ponte = new Ponte({
		dir, versione: '0', porta: port,
		indirizzo: async () => ({ ip: '127.0.0.1', nome: 'mac-di-prova.tailnet.ts.net' }),
		stato: () => ({ melissa: { stato: 'idle', cervello: 'agnes', registro: [] }, lavori: [], conti: { inCorso: 0, tiAspetta: 0, inCoda: 0, vive: 0 } }),
		occupata: () => occupata,
		chiedi: async () => '',
		parla: async (t, emetti) => {
			domande.push(t);
			emetti({ tipo: 'voce', ok: true });
			emetti({ tipo: 'frase', testo: 'Sta sistemando il ponte.' });
			return 'Sta sistemando il ponte. Aspetta il tuo permesso per i test.';
		},
		voce: async () => Buffer.alloc(0),
		scriviLavoro: () => false,
		registraDispositivo: () => undefined,
		sessioni,
		log: () => undefined,
	});
	await ponte.start();
	const token = JSON.parse(fs.readFileSync(path.join(dir, 'ponte.json'), 'utf8')).token;
	const get = u => call(port, token, 'GET', u);
	const post = (u, b) => call(port, token, 'POST', u, b);

	assert.strictEqual((await call(port, 'sbagliato'.repeat(5), 'GET', '/v1/sessione?chiave=job:job-1')).status, 401);
	ok('le rotte nuove passano dal gettone');

	const s = (await get('/v1/sessione?chiave=job:job-1')).body;
	assert.strictEqual(s.progetto, 'progetto-prova');
	assert.strictEqual(s.richiesta, 'Sistema il ponte e lancia i test');
	assert.strictEqual(s.domanda.tipo, 'permesso');
	assert.strictEqual(s.iniziata, ora - 600_000);
	assert.deepStrictEqual(s.file, ['ponte.ts']);
	assert.ok(s.scrivibile && s.terminale && s.modifiche);
	assert.strictEqual(s.token.uscita, 50);
	assert.strictEqual((await get('/v1/sessione?chiave=sess:nessuna')).status, 404);
	ok('scheda di un lavoro della Bottega');

	const e = (await get(`/v1/sessione?chiave=sess:${SID2}`)).body;
	assert.strictEqual(e.origine, 'altrove');
	assert.strictEqual(e.domanda.tipo, 'domanda');
	assert.ok(e.domanda.chiede);
	assert.ok(!e.scrivibile && !e.terminale);
	const vietato = await post('/v1/sessione/rispondi', { chiave: `sess:${SID2}`, domanda: e.domanda.id, risposta: 'si' });
	assert.strictEqual(vietato.status, 403);
	assert.match(vietato.body.errore, /altra app/);
	assert.strictEqual(scritti.length, 0);
	assert.strictEqual((await get('/v1/sessione/terminale?chiave=' + encodeURIComponent(`sess:${SID2}`))).status, 403);
	ok('sessione aperta altrove: si legge, non si scrive');

	// rispondere: si' = invio, no = Esc, testo = Esc e poi il testo; una domanda vecchia non passa
	assert.strictEqual((await post('/v1/sessione/rispondi', { chiave: 'job:job-1', domanda: 'vecchia', risposta: 'si' })).status, 409);
	assert.strictEqual((await post('/v1/sessione/rispondi', { chiave: 'job:job-1', domanda: s.domanda.id, risposta: 'si' })).status, 200);
	assert.deepStrictEqual(scritti.splice(0), [['', true]]);
	await post('/v1/sessione/rispondi', { chiave: 'job:job-1', domanda: s.domanda.id, risposta: 'no' });
	assert.deepStrictEqual(scritti.splice(0), [['\x1b', false]]);
	await post('/v1/sessione/rispondi', { chiave: 'job:job-1', domanda: s.domanda.id, risposta: 'testo', testo: 'usa\nnode test/ponte.cjs' });
	assert.deepStrictEqual(scritti.splice(0), [['\x1b', false], ['usa node test/ponte.cjs', true]]);
	assert.strictEqual((await post('/v1/sessione/rispondi', { chiave: 'job:job-1', domanda: s.domanda.id, risposta: 'forse' })).status, 400);
	ok('risposta al permesso: invio, Esc, Esc e testo; domanda cambiata 409');

	// le modifiche: numstat + file nuovi, mai i file ignorati, mai fuori dal progetto
	const m = (await get('/v1/sessione/modifiche?chiave=job:job-1')).body;
	const per = Object.fromEntries(m.file.map(f => [f.percorso, f]));
	assert.deepStrictEqual([per['ponte.ts'].aggiunte, per['ponte.ts'].tolte, per['ponte.ts'].tipo], [2, 1, 'modificato']);
	assert.deepStrictEqual([per['nuovo.md'].aggiunte, per['nuovo.md'].tipo], [2, 'nuovo']);
	assert.ok(!per['.env'], 'il file ignorato non compare');
	const df = (await get('/v1/sessione/diff?chiave=job:job-1&file=ponte.ts')).body;
	assert.match(df.diff, /^-riga due$/m);
	assert.match(df.diff, /^\+riga quattro$/m);
	assert.match((await get('/v1/sessione/diff?chiave=job:job-1&file=nuovo.md')).body.diff, /^\+mondo$/m);
	for (const f of ['.env', '../altrove/segreto.txt', path.join(fuori, 'segreto.txt'), '', 'non-esiste.txt']) {
		const r = await get('/v1/sessione/diff?chiave=job:job-1&file=' + encodeURIComponent(f));
		assert.ok(r.status >= 400 && r.status < 500, `${f} -> ${r.status}`);
		assert.ok(!r.testo.includes('finta-non-deve-uscire') && !r.testo.includes('contenuto-esterno'));
	}
	assert.strictEqual((await get('/v1/sessione/modifiche?chiave=sess:fuori')).status, 403, 'cartella fuori dai progetti');
	ok('modifiche e diff: dentro il progetto, niente ignorati, niente fuori');

	// la diretta: un aggiornamento quando la trascrizione cresce, timer spenti quando nessuno guarda
	const f1 = flusso(port, token, `/v1/sessione/eventi?chiave=${encodeURIComponent('job:job-1')}`);
	assert.strictEqual(await f1.pronto, 200);
	await attendi(100);
	assert.strictEqual(f1.dati.length, 1);
	fs.appendFileSync(jsonl, riga({ type: 'user', timestamp: ts(20), message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } }));
	scriviRegistro(4242, { status: 'busy' });
	lavori[0].status = 'in corso';
	await attendi(300);
	const ultima = f1.dati[f1.dati.length - 1];
	assert.ok(f1.dati.length >= 2);
	assert.strictEqual(ultima.passi[ultima.passi.length - 1].testo, 'ha lanciato Lancia i test');
	assert.strictEqual(ultima.domanda, undefined);
	assert.ok(sessioni.giro, 'il giro gira mentre qualcuno guarda');
	f1.chiudi();
	await attendi(100);
	assert.strictEqual(sessioni.giro, undefined, 'nessuno guarda: nessun timer');
	assert.strictEqual(sessioni.ping, undefined);
	ok('diretta: aggiornamento al cambio, niente timer senza spettatori');

	// il terminale: righe ripulite, la lettura si ferma quando l'iPhone chiude
	const ft = flusso(port, token, `/v1/sessione/terminale?chiave=${encodeURIComponent('job:job-1')}`);
	assert.strictEqual(await ft.pronto, 200);
	assert.strictEqual(terminaleAperto, 1);
	datiTerminale('\x1b[32m✓ 12 prove passate\x1b[0m\r\n> ');
	await attendi(400);
	assert.deepStrictEqual(ft.dati[ft.dati.length - 1].righe, ['✓ 12 prove passate', '>']);
	ft.chiudi();
	await attendi(80);
	assert.strictEqual(terminaleAperto, 0, 'smesso di leggere');
	const ft2 = flusso(port, token, `/v1/sessione/terminale?chiave=${encodeURIComponent('job:job-1')}`);
	await ft2.pronto;
	fineTerminale();
	await attendi(80);
	assert.strictEqual(ft2.dati[ft2.dati.length - 1].vivo, false);
	ok('terminale: ANSI via, lettura solo mentre si guarda, fine del comando');

	// segui sulla Live Activity
	assert.strictEqual((await post('/v1/sessione/segui', { chiave: 'job:job-1' })).body.seguita, 'job:job-1');
	await attendi(150);
	assert.deepStrictEqual(sessioni.seguito(), { chiave: 'job:job-1', progetto: 'progetto-prova', passo: 'ha lanciato npm', stato: 'in corso' });
	assert.ok(cambi >= 1);
	assert.ok((await get('/v1/sessione?chiave=job:job-1')).body.seguita);
	await post('/v1/sessione/segui', { chiave: '' });
	assert.strictEqual(sessioni.seguito(), undefined);
	assert.strictEqual(sessioni.seguiTimer, undefined);
	ok('segui: passo breve per la Live Activity, e si smette');

	// riassumimelo: la scheda va a Melissa, il flusso e' quello di /v1/parla
	const r = await post('/v1/sessione/riassunto', { chiave: 'job:job-1' });
	const righe = r.testo.trim().split('\n').map(x => JSON.parse(x));
	assert.deepStrictEqual(righe.map(x => x.tipo), ['voce', 'frase', 'fine']);
	assert.match(domande[0], /due frasi/);
	assert.match(domande[0], /progetto-prova/);
	assert.ok(domande[0].length < 2000);
	occupata = true;
	assert.strictEqual((await post('/v1/sessione/riassunto', { chiave: 'job:job-1' })).status, 409);
	occupata = false;
	assert.ok(testoRiassunto({ ...s, richiesta: 'x'.repeat(5000), risposta: 'y'.repeat(5000) }).length < 2000);
	ok('riassunto a voce');

	// la Live Activity porta la sessione seguita come campo facoltativo `segui` del content-state
	const inviati = [];
	const av = new Avvisi({
		istantanea: () => ({ lavori: [lavori[0]], conti: { inCorso: 1, tiAspetta: 0, vive: 1 }, segui: { progetto: 'progetto-prova', passo: 'lancia npm', stato: 'in corso' } }),
		invio: { manda: async p => (inviati.push(p), { ok: true, status: 200 }) },
		dispositivo: () => ({ ambiente: 'sviluppo', attivita: 'ab'.repeat(40), aggiornato: 1 }),
		togliToken: () => undefined, modo: () => 'mai', inattivoMs: async () => 0, mac: 'mac-di-prova', ora: () => ora,
	});
	await av.aggiorna();
	assert.deepStrictEqual(inviati[0].payload.aps['content-state'].segui, { progetto: 'progetto-prova', passo: 'lancia npm', stato: 'in corso' });
	ok('Live Activity: campo segui nel content-state');

	// il ponte si chiude: si chiudono anche i flussi della scheda
	const f3 = flusso(port, token, `/v1/sessione/eventi?chiave=${encodeURIComponent('job:job-1')}`);
	await f3.pronto;
	ponte.stop();
	// sotto carico la chiusura del socket puo' arrivare dopo: si aspetta fino a 2 s, non un tempo fisso
	for (let i = 0; i < 40 && sessioni.flussi.size > 0; i++) await attendi(50);
	assert.strictEqual(sessioni.flussi.size, 0);
	ok('chiusura del ponte');

	console.log(`\n${passed} prove passate`);
	fs.rmSync(tmp, { recursive: true, force: true });
	process.exit(0);
})().catch(e => {
	console.error(e);
	process.exit(1);
});
