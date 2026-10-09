// La memoria dei personaggi di Melissa (docs/CONTRATTI.md 9.11): le battute arrivano dallo spool, si trovano con la
// ricerca e con `cli.mjs personaggio`, e restano fuori da contesto, bacheca, recent, grafici e sessione.
// Mai il database vero: BOTTEGA_HOME, Cline e Codex puntano a una cartella temporanea prima di importare lo store.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-personaggi-'));
process.env.BOTTEGA_HOME = path.join(TMP, 'bottega');
process.env.CLINE_DATA_DIR = path.join(TMP, 'cline');
process.env.CODEX_HOME = path.join(TMP, 'codex');
const MEM = path.join(process.env.BOTTEGA_HOME, 'memoria');
const PROGETTI = path.join(TMP, 'progetti');
const FARO = path.join(PROGETTI, 'Faro');
fs.mkdirSync(FARO, { recursive: true });
fs.mkdirSync(path.join(MEM, 'spool'), { recursive: true });
fs.writeFileSync(path.join(MEM, 'config.json'), JSON.stringify({ roots: [PROGETTI] }));
// Krista ha il suo file con un nome diverso dalla chiave; Elliot e Darlene no.
fs.mkdirSync(path.join(process.env.BOTTEGA_HOME, 'personaggi'), { recursive: true });
fs.writeFileSync(path.join(process.env.BOTTEGA_HOME, 'personaggi', 'krista.json'), JSON.stringify({ chiave: 'krista', nome: 'Krista Prova' }));

const { openStore, Store } = await import('../lib/store.mjs');
const { ingest, board, sessionDetail, buildContext, search } = await import('../lib/core.mjs');
const { grafici } = await import('../lib/grafici.mjs');
const { projectOf } = await import('../lib/paths.mjs');
const { saveExternal, memoriaPersonaggio } = await import('../lib/esterne.mjs');

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const MCP = fileURLToPath(new URL('../mcp.mjs', import.meta.url));
const cli = (...args) => JSON.parse(execFileSync(process.execPath, [CLI, ...args, '--json'], { encoding: 'utf8', env: process.env }));
const mcp = (name, args) =>
	execFileSync(process.execPath, [MCP], { encoding: 'utf8', env: process.env, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n' });

const ORA = Date.now();
const MIN = 60_000;
const ev = (id, sid, who, text, minutiFa, extra = {}) => ({ ev: 'external', source: 'personaggio', sid, id, cwd: FARO, at: ORA - minutiFa * MIN, text, who, ...extra });
const spool = righe => fs.appendFileSync(path.join(MEM, 'spool', `${new Date(ORA).toISOString().slice(0, 10)}.jsonl`), righe.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('un evento personaggio dello spool diventa una nota, una volta sola, col nome dal file del personaggio', () => {
	const prima = ev('k1', 'krista', 'krista', 'Il lunedi del faro ti aspetta, smettila di rimandare la lanterna.', 50);
	spool([
		prima,
		prima,
		ev('a1', 'krista', 'andrea', 'Domani sistemo la lanterna del faro, promesso.', 49),
		ev('e1', 'elliot', 'elliot', 'La lanterna e solo un sintomo, il problema e il sistema.', 48),
		ev('x1', '../fuori', 'andrea', 'chiave non valida', 47),
		// una nota di lavoro sullo stesso progetto, per confronto
		{ ev: 'external', source: 'melissa', sid: 'conversazione', id: 'm1', cwd: FARO, at: ORA - 46 * MIN, text: 'Lanterna del faro: build pronta da provare.', who: 'Melissa' },
	]);
	const store = openStore();
	ingest(store);
	ingest(store);
	const note = store.all("SELECT * FROM memories WHERE origin = 'personaggio' ORDER BY createdAt");
	assert.equal(note.length, 3, 'doppione e chiave non valida non entrano');
	assert.equal(note[0].kind, 'nota');
	assert.equal(note[0].sessionId, 'personaggio:krista');
	assert.equal(note[0].projectKey, projectOf(FARO).key);
	assert.match(note[0].title, /^Krista Prova · Krista Prova: Il lunedi del faro/);
	assert.match(note[1].title, /^Krista Prova · Andrea: Domani sistemo/);
	assert.match(note[2].title, /^Elliot · Elliot: La lanterna/, 'senza file del personaggio, la chiave con la maiuscola');
});

test('le note dei personaggi non entrano in contesto, bacheca, recent, grafici e sessione, ma si trovano con la ricerca', () => {
	const store = openStore();
	const faro = projectOf(FARO);
	const ctx = buildContext(faro, store);
	assert.match(ctx, /build pronta da provare/, 'la nota di lavoro si');
	assert.doesNotMatch(ctx, /lunedi del faro|Domani sistemo|sintomo/);
	const ctxCli = cli('context', FARO).text;
	assert.match(ctxCli, /build pronta/);
	assert.doesNotMatch(ctxCli, /lunedi del faro|Domani sistemo|sintomo/);

	const b = board({ minuti: 120 });
	assert.ok(b.some(e => e.kind === 'melissa'));
	assert.ok(!b.some(e => e.kind === 'personaggio' || /Krista|Elliot/.test(e.summary)));
	assert.ok(!cli('bacheca', '--minuti', '120').some(e => /Krista|Elliot/.test(e.summary)));

	const tutti = [...store.recent({ limite: 50 }), ...store.recent({ limite: 50, kinds: ['nota'] }), ...store.recent({ progetto: 'Faro', limite: 50 })];
	assert.ok(tutti.some(m => /build pronta/.test(m.text)));
	assert.ok(!tutti.some(m => m.sessionId.startsWith('personaggio:')));
	assert.ok(!cli('recent', '--limite', '50').some(m => m.sessionId.startsWith('personaggio:')));
	assert.ok(!cli('recent', '--tipo', 'riassunto,nota').some(m => m.sessionId.startsWith('personaggio:')));

	const g = grafici({ giorni: 7, store });
	assert.equal(g.totali.ricordi, 1, 'solo la nota di Melissa');
	assert.equal(g.scritti.reduce((a, d) => a + d.fatti, 0), 1);
	assert.equal(g.ore.flat().reduce((a, b) => a + b, 0), 1);
	assert.deepEqual(g.progetti, [{ progetto: 'Faro', ricordi: 1 }]);

	assert.equal(sessionDetail('personaggio:krista', store), undefined);

	assert.ok(search('lanterna', { store }).some(m => m.sessionId === 'personaggio:krista'));
	assert.ok(cli('search', 'lunedi faro').some(m => m.sessionId === 'personaggio:krista'));

	assert.doesNotMatch(mcp('memoria_recenti', { limite: 50 }), /personaggio:|Krista|Elliot/);
	assert.match(mcp('memoria_cerca', { query: 'lanterna' }), /sessione personaggio:krista/);
});

test('personaggio: ultime battute e ricordi, senza doppioni e solo di quel personaggio', () => {
	spool([
		ev('k2', 'krista', 'krista', 'Respira. Poi dimmi davvero perche hai paura del rilascio.', 30),
		ev('k3', 'krista', 'krista', 'Quella build non si pubblica da sola, Andrea.', 20),
		ev('k4', 'krista', 'krista', 'Va bene, oggi niente prediche.', 10),
		ev('a2', 'elliot', 'andrea', 'La lanterna la sistemo io, Elliot.', 9),
	]);
	const r = cli('personaggio', 'krista', '--frase', 'hai finito con la lanterna del faro?', '--limite', '2');
	assert.deepEqual(r.ultime.map(u => u.testo), ['Va bene, oggi niente prediche.', 'Quella build non si pubblica da sola, Andrea.'], 'dalla piu recente');
	assert.ok(r.ultime.every(u => u.at > 0));
	const testi = r.ricordi.map(u => u.testo);
	assert.ok(testi.includes('Il lunedi del faro ti aspetta, smettila di rimandare la lanterna.'));
	// Andrea con lei: nelle sue ultime frasi (`andrea`) o nei ricordi, mai in tutti e due
	const conLei = [...r.andrea.map(u => u.testo), ...r.ricordi.filter(u => u.chi === 'andrea').map(u => u.testo)];
	assert.ok(conLei.some(t => /Domani sistemo/.test(t)), 'anche Andrea con lei');
	assert.equal(new Set(conLei).size, conLei.length, 'niente doppioni fra andrea e ricordi');
	assert.ok(r.andrea.every(u => u.at > 0));
	assert.ok(!r.andrea.some(u => /la sistemo io/.test(u.testo)), 'niente Andrea con Elliot');
	assert.ok(!testi.some(t => /sintomo|la sistemo io/.test(t)), 'niente Elliot ne Andrea con Elliot');
	assert.ok(r.ricordi.length <= 3);

	// una battuta gia in `ultime` non torna nei ricordi
	const s = cli('personaggio', 'krista', '--frase', 'prediche', '--limite', '5');
	assert.ok(s.ultime.some(u => /prediche/.test(u.testo)));
	assert.ok(!s.ricordi.some(u => /prediche/.test(u.testo)));

	assert.deepEqual(cli('personaggio', 'krista').ricordi, [], 'senza frase nessun ricordo');
	assert.equal(cli('personaggio', 'krista').ultime.length, 4, 'tutte e quattro, sotto il limite predefinito di 5');
	assert.equal(cli('personaggio', 'krista', '--limite', '1').ultime.length, 1);
	assert.equal(cli('personaggio', 'KRISTA', '--limite', '3').ultime.length, 3, 'la chiave senza maiuscole');
});

test('un personaggio senza file e senza battute non rompe niente', () => {
	assert.deepEqual(cli('personaggio', 'darlene', '--frase', 'lanterna'), { ultime: [], andrea: [], ricordi: [] });
	assert.equal(cli('personaggio', 'elliot', '--frase', 'sistema').ultime[0].testo, 'La lanterna e solo un sintomo, il problema e il sistema.');
	const male = spawnSync(process.execPath, [CLI, 'personaggio', '../etc', '--json'], { encoding: 'utf8', env: process.env });
	assert.equal(male.status, 1);
	assert.match(JSON.parse(male.stdout).error, /chiave del personaggio non valida/);
	// il file del personaggio rotto: resta la chiave
	fs.writeFileSync(path.join(process.env.BOTTEGA_HOME, 'personaggi', 'darlene.json'), '{rotto');
	spool([ev('d1', 'darlene', 'darlene', 'Ciao, sono io.', 5)]);
	assert.equal(cli('personaggio', 'darlene').ultime[0].testo, 'Ciao, sono io.');
	assert.match(openStore().get("SELECT title FROM memories WHERE sessionId = 'personaggio:darlene'").title, /^Darlene · Darlene: /);
});

test('personaggio resta sotto 1,5 s con qualche migliaio di note', () => {
	const file = path.join(TMP, 'grande');
	const env = { ...process.env, BOTTEGA_HOME: file };
	fs.mkdirSync(path.join(file, 'memoria'), { recursive: true });
	const store = new Store(path.join(file, 'memoria', 'memoria.db'));
	const parole = ['lanterna', 'faro', 'build', 'rilascio', 'paura', 'codice', 'notte', 'caffe', 'server', 'mare', 'vento', 'test'];
	const frase = i => Array.from({ length: 14 }, (_, j) => parole[(i * 7 + j * 3) % parole.length]).join(' ') + ` numero ${i}.`;
	store.tx(() => {
		for (let i = 0; i < 6000; i++)
			store.addMemory({ kind: i % 3 ? 'nota' : 'riassunto', project: 'Faro', projectKey: 'faro', sessionId: `s${i % 50}`, title: frase(i).slice(0, 80), text: frase(i), createdAt: ORA - i * MIN });
		const chi = ['krista', 'elliot', 'darlene', 'andrea'];
		for (let i = 0; i < 3000; i++)
			saveExternal(store, { source: 'personaggio', sid: chi[i % 3], who: chi[i % 4], id: `g${i}`, cwd: FARO, at: ORA - i * MIN, text: frase(i + 7) });
	});
	store.close();
	const t0 = performance.now();
	const r = JSON.parse(execFileSync(process.execPath, [CLI, 'personaggio', 'krista', '--frase', 'hai ancora paura del rilascio della lanterna?', '--json'], { encoding: 'utf8', env }));
	const ms = performance.now() - t0;
	console.log(`# personaggio su 9000 note: ${Math.round(ms)} ms`);
	assert.equal(r.ultime.length, 5);
	assert.equal(r.ricordi.length, 3);
	assert.ok(ms < 1500, `${Math.round(ms)} ms`);
	// in processo, senza l'avvio di node
	const s2 = new Store(path.join(file, 'memoria', 'memoria.db'));
	const t1 = performance.now();
	memoriaPersonaggio(s2, 'krista', { frase: 'paura del rilascio della lanterna', limite: 5 });
	console.log(`# lettura nel processo: ${(performance.now() - t1).toFixed(1)} ms`);
	s2.close();
});
