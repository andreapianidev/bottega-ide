// Prove di memoria/lib/immagini.mjs: trascrizioni finte, Nucleo finto, database di prova.
// Mai il database vero: BOTTEGA_HOME e BOTTEGA_CLAUDE_PROJECTS puntano a una cartella temporanea
// prima di caricare qualunque modulo della Memoria. Si lancia con `node --test memoria/test/`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-immagini-'));
const PROJECTS = path.join(TMP, 'projects');
const ROOT = path.join(TMP, 'radice');
const OCR_LOG = path.join(TMP, 'ocr.log');
const FAKE = path.join(TMP, 'nucleo-finto');
process.env.BOTTEGA_HOME = path.join(TMP, 'home');
process.env.BOTTEGA_CLAUDE_PROJECTS = PROJECTS;
process.env.BOTTEGA_NUCLEO = FAKE;
process.env.FAKE_OCR_LOG = OCR_LOG;
delete process.env.FAKE_OCR_MODE;

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');

// Un Nucleo finto che parla il protocollo `--cli ocr`: il "testo riconosciuto" e' il base64 decodificato.
fs.writeFileSync(
	FAKE,
	`#!${process.execPath}
const fs = require('fs');
const mode = process.env.FAKE_OCR_MODE || 'ok';
if (process.argv[2] !== '--cli' || process.argv[3] !== 'ocr' || mode === '64') { process.stderr.write('uso: comando sconosciuto\\n'); process.exit(64); }
require('readline').createInterface({ input: process.stdin }).on('line', l => {
	const o = JSON.parse(l);
	const t = Buffer.from(o.base64, 'base64').toString('utf8');
	if (process.env.FAKE_OCR_LOG) fs.appendFileSync(process.env.FAKE_OCR_LOG, o.id + ' ' + o.mime + '\\n');
	if (t.startsWith('DORMI')) return;
	if (t.startsWith('ERRORE')) return process.stdout.write(JSON.stringify({ id: o.id, error: 'immagine illeggibile' }) + '\\n');
	process.stdout.write(JSON.stringify({ id: o.id, testo: t, ms: 7 }) + '\\n');
});
`,
	{ mode: 0o755 },
);

// Radici dei progetti di prova: Alfa e un suo worktree (le sessioni del worktree vanno ad Alfa).
fs.mkdirSync(path.join(process.env.BOTTEGA_HOME, 'memoria'), { recursive: true });
fs.writeFileSync(path.join(process.env.BOTTEGA_HOME, 'memoria', 'config.json'), JSON.stringify({ roots: [ROOT] }));
fs.mkdirSync(path.join(ROOT, 'Alfa', '.git', 'worktrees', 'prova'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'Alfa-prova'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'Alfa-prova', '.git'), `gitdir: ${path.join(ROOT, 'Alfa')}/.git/worktrees/prova\n`);
fs.mkdirSync(path.join(ROOT, 'Beta'), { recursive: true });

const { Store } = await import('../lib/store.mjs');
const { DB_PATH } = await import('../lib/paths.mjs');
const I = await import('../lib/immagini.mjs');

assert.ok(DB_PATH.startsWith(TMP), 'il database delle prove deve stare nella cartella temporanea');

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const img = (testo, mime = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: mime, data: b64(testo) } });
const TS = '2026-10-01T10:00:00.000Z';
const SID = '11111111-aaaa-bbbb-cccc-000000000001';
const SID2 = '22222222-aaaa-bbbb-cccc-000000000002';

const TESTO_A = 'Errore di compilazione nel file ContentView.swift alla riga 42: tipo non trovato';
const TESTO_CHIAVE = 'Impostazioni del servizio, chiave ANTHROPIC sk-ant-api03-FINTAfintaFINTAfinta1234567890 da non mostrare';
const TESTO_TOOL = 'Schermata del simulatore: pulsante Accedi, campo email, campo parola d\'ordine';
const TESTO_CODA1 = 'Prima immagine in coda mentre Claude lavorava, tabella con tre colonne';
const TESTO_CODA2 = 'Seconda immagine in coda: grafico delle vendite di settembre per settimana';
const TESTO_SUB = 'Pagina di prova aperta dal sotto agente con il titolo Benvenuto nella bottega';

const righe = {
	incollata: { type: 'user', sessionId: SID, cwd: path.join(ROOT, 'Alfa-prova'), timestamp: TS, message: { role: 'user', content: [{ type: 'text', text: 'guarda qui' }, img(TESTO_A, 'image/jpeg')] } },
	doppione: { type: 'user', sessionId: SID, cwd: path.join(ROOT, 'Alfa-prova'), timestamp: TS, message: { role: 'user', content: [img(TESTO_A, 'image/jpeg')] } },
	chiave: { type: 'user', sessionId: SID, cwd: path.join(ROOT, 'Alfa-prova'), timestamp: TS, message: { role: 'user', content: [img(TESTO_CHIAVE)] } },
	strumento: {
		type: 'user', sessionId: SID, cwd: path.join(ROOT, 'Alfa-prova'), timestamp: TS,
		message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }, img(TESTO_TOOL)] }] },
		toolUseResult: [img(TESTO_TOOL)],
	},
	coda: {
		type: 'attachment', sessionId: SID, cwd: path.join(ROOT, 'Alfa-prova'), timestamp: TS,
		attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'anche queste' }, img(TESTO_CODA1, 'image/jpeg'), img(TESTO_CODA2, 'image/webp')], imagePasteIds: [7, 8] },
	},
	breve: { type: 'user', sessionId: SID, cwd: path.join(ROOT, 'Alfa-prova'), timestamp: TS, message: { role: 'user', content: [img('OK 12')] } },
	errore: { type: 'user', sessionId: SID, cwd: path.join(ROOT, 'Alfa-prova'), timestamp: TS, message: { role: 'user', content: [img('ERRORE di lettura simulato')] } },
	finta: { type: 'assistant', sessionId: SID, timestamp: TS, message: { role: 'assistant', content: [{ type: 'text', text: 'il blocco "type":"image" vive in message.content' }] } },
};

const jsonl = list => list.map(o => JSON.stringify(o)).join('\n') + '\n';
const ocrCalls = () => (fs.existsSync(OCR_LOG) ? fs.readFileSync(OCR_LOG, 'utf8').split('\n').filter(Boolean).length : 0);

const dirA = path.join(PROJECTS, '-tmp-radice-Alfa-prova');
const fileA = path.join(dirA, `${SID}.jsonl`);
const fileSub = path.join(dirA, SID2, 'subagents', 'agent-abc.jsonl');

before(() => {
	fs.mkdirSync(path.dirname(fileSub), { recursive: true });
	fs.writeFileSync(fileA, jsonl([righe.incollata, righe.finta, righe.doppione, righe.chiave, righe.strumento, righe.coda, righe.breve, righe.errore]));
	fs.writeFileSync(
		fileSub,
		jsonl([{ type: 'user', isSidechain: true, sessionId: SID2, cwd: path.join(ROOT, 'Beta'), timestamp: TS, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't9', content: [img(TESTO_SUB)] }] } }]),
	);
});

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

test('estrazione: incollate, dentro tool_result, in coda (attachment); niente da toolUseResult o dal testo', () => {
	assert.deepEqual(I.immaginiDi(righe.incollata).map(i => [i.fonte, i.mime]), [['incollata', 'image/jpeg']]);
	assert.deepEqual(I.immaginiDi(righe.strumento).map(i => i.fonte), ['strumento']);
	assert.deepEqual(I.immaginiDi(righe.coda).map(i => [i.fonte, i.mime]), [['incollata', 'image/jpeg'], ['incollata', 'image/webp']]);
	assert.deepEqual(I.immaginiDi(righe.finta), []);
	assert.deepEqual(I.immaginiDi({ type: 'user', message: { content: 'solo testo' } }), []);
	assert.deepEqual(I.immaginiDi({ type: 'user', message: { content: [{ type: 'image', source: { type: 'url', url: 'https://x' } }] } }), []);
	assert.equal(I.sessioneDelFile(fileSub), SID2);
	assert.equal(I.sessioneDelFile(fileA), SID);
});

test('giro: deduplica per hash, pulizia della chiave, progetto del worktree, ricordi cercabili', async () => {
	const store = new Store(path.join(TMP, 'giro.db'));
	const r = await I.giro({ store, limite: 40 });
	// 8 immagini nelle righe, una e' lo stesso screenshot incollato due volte: 7 diverse + 1 del sotto-agente.
	assert.equal(r.trovate, 8);
	assert.equal(r.nucleo, 'ok');
	assert.equal(r.lette, 8);
	assert.equal(ocrCalls(), 8, 'ogni immagine diversa passa dall\'OCR una volta sola');
	assert.equal(r.nuove, 6);
	assert.equal(r.saltate, 1);
	assert.equal(r.errori, 1);
	assert.equal(r.restano, 0);
	assert.ok(r.ms >= 0);

	const mem = store.all("SELECT * FROM memories WHERE kind = 'immagine' ORDER BY id");
	assert.equal(mem.length, 6);
	for (const m of mem) {
		assert.equal(m.origin, 'auto');
		assert.match(m.title, /^Schermata: /);
		assert.match(m.text, /\n\nDa una schermata (incollata|vista da Claude) nella sessione [0-9a-f]{8} \(riga \d+\), 1 ottobre 2026\.$/);
		assert.ok(!/[\u2013\u2014]/.test(m.text + m.title));
	}
	const tutto = mem.map(m => m.text + m.title).join('\n');
	assert.ok(!tutto.includes('sk-ant'), 'la chiave finta non deve arrivare nella Memoria');
	assert.ok(tutto.includes('[chiave nascosta]'));

	const alfa = mem.filter(m => m.sessionId === SID);
	assert.equal(alfa.length, 5);
	for (const m of alfa) assert.equal(m.project, 'Alfa', 'il worktree Alfa-prova appartiene ad Alfa');
	const sub = mem.find(m => m.sessionId === SID2);
	assert.equal(sub.project, 'Beta');
	assert.match(sub.text, /vista da Claude/);

	const prima = mem.find(m => m.text.startsWith('Errore di compilazione'));
	assert.match(prima.text, /incollata nella sessione 11111111 \(riga 1\)/);
	assert.equal(prima.title, 'Schermata: Errore compilazione nel file ContentView.swift alla riga tipo');

	const trovati = store.ftsSearch('ContentView compilazione');
	assert.ok(trovati.some(t => t.kind === 'immagine'), 'il ricordo entra in FTS');

	const stati = I.riepilogo(store);
	assert.deepEqual(stati, { errore: 1, letta: 6, vuota: 1 });
	const rigaChiave = store.get("SELECT * FROM immagini WHERE stato = 'letta' AND riga = 4");
	assert.equal(rigaChiave.fonte, 'incollata');
	assert.ok(rigaChiave.memoryId > 0);
	assert.equal(store.get("SELECT errore FROM immagini WHERE stato = 'errore'").errore, 'immagine illeggibile');
	store.close();
});

test('incrementale: la seconda passata non rilegge; una riga a meta\' si legge quando e\' completa', async () => {
	const store = new Store(path.join(TMP, 'incrementale.db'));
	fs.writeFileSync(OCR_LOG, '');
	const file = path.join(dirA, '33333333-aaaa-bbbb-cccc-000000000003.jsonl');
	const sid = '33333333-aaaa-bbbb-cccc-000000000003';
	const riga = t => JSON.stringify({ type: 'user', sessionId: sid, cwd: path.join(ROOT, 'Beta'), timestamp: TS, message: { content: [img(t)] } });
	fs.writeFileSync(file, riga('Prima schermata della sessione incrementale, con abbastanza testo') + '\n');
	await I.giro({ store });
	const dopoPrima = ocrCalls();

	const r2 = await I.giro({ store });
	assert.equal(r2.trovate, 0);
	assert.equal(r2.lette, 0);
	assert.equal(ocrCalls(), dopoPrima, 'nessuna rilettura alla seconda passata');
	const off = store.get('SELECT offset, size FROM immagini_file WHERE file = ?', file);
	assert.equal(Number(off.offset), fs.statSync(file).size);

	// Claude sta ancora scrivendo la riga: senza a capo non si legge.
	const nuova = riga('Seconda schermata aggiunta dopo, testo leggibile e abbastanza lungo');
	fs.appendFileSync(file, nuova.slice(0, 50));
	const r3 = await I.giro({ store });
	assert.equal(r3.trovate, 0);
	fs.appendFileSync(file, nuova.slice(50) + '\n');
	const r4 = await I.giro({ store });
	assert.equal(r4.trovate, 1);
	assert.equal(r4.nuove, 1);
	assert.equal(ocrCalls(), dopoPrima + 1);
	const m = store.get("SELECT text FROM memories WHERE kind = 'immagine' AND sessionId = ? ORDER BY id DESC LIMIT 1", sid);
	assert.match(m.text, /^Seconda schermata/);
	assert.match(m.text, /\(riga 2\)/);
	store.close();
});

test('limite per giro e file piu\' vecchi di N giorni saltati', async () => {
	const store = new Store(path.join(TMP, 'limite.db'));
	const r = await I.giro({ store, limite: 2 });
	assert.equal(r.lette, 2);
	assert.ok(r.restano > 0);
	// Le incollate passano per prime.
	const lette = store.all("SELECT fonte FROM immagini WHERE stato != 'da_leggere'");
	assert.ok(lette.every(x => x.fonte === 'incollata'));

	const vecchio = path.join(PROJECTS, '-vecchio', '44444444-aaaa-bbbb-cccc-000000000004.jsonl');
	fs.mkdirSync(path.dirname(vecchio), { recursive: true });
	fs.writeFileSync(vecchio, jsonl([{ ...righe.incollata, sessionId: '44444444', message: { content: [img('Schermata di quattro mesi fa, non si legge piu')] } }]));
	const old = (Date.now() - 120 * 86_400_000) / 1000;
	fs.utimesSync(vecchio, old, old);
	const s = I.scansiona({ store, giorni: 90 });
	assert.equal(store.get('SELECT COUNT(*) AS n FROM immagini_file WHERE file = ?', vecchio).n, 0);
	assert.equal(s.trovate, 0);
	store.close();
});

test('Nucleo senza il comando ocr (exit 64): il giro si ferma pulito e non tocca gli stati', async () => {
	const store = new Store(path.join(TMP, 'senza-ocr.db'));
	process.env.FAKE_OCR_MODE = '64';
	try {
		const r = await I.giro({ store });
		assert.equal(r.nucleo, 'senza-ocr');
		assert.equal(r.lette, 0);
		assert.equal(r.errori, 0);
		assert.equal(r.restano, r.trovate);
		assert.equal(store.get("SELECT COUNT(*) AS n FROM immagini WHERE stato != 'da_leggere'").n, 0);
		assert.equal(store.get("SELECT COUNT(*) AS n FROM memories WHERE kind = 'immagine'").n, 0);
	} finally {
		delete process.env.FAKE_OCR_MODE;
	}
	// Quando il Nucleo impara `ocr`, le stesse immagini si leggono al giro dopo.
	const r2 = await I.giro({ store });
	assert.equal(r2.nucleo, 'ok');
	assert.ok(r2.nuove > 0);
	store.close();
});

test('tempo scaduto: l\'immagine va in errore e il giro si ferma; --riprova la rimette in coda', async () => {
	const store = new Store(path.join(TMP, 'tempo.db'));
	const file = path.join(TMP, 'projects-lento', '-lento', '55555555-aaaa-bbbb-cccc-000000000005.jsonl');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, jsonl([{ ...righe.incollata, sessionId: '55555555', message: { content: [img('DORMI per sempre su questa immagine')] } }]));
	const r = await I.giro({ store, projectsDir: path.dirname(path.dirname(file)), timeoutMs: 300 });
	assert.equal(r.errori, 1);
	assert.equal(r.nuove, 0);
	assert.equal(store.get('SELECT errore FROM immagini').errore, 'tempo scaduto');
	const r2 = await I.giro({ store, projectsDir: path.dirname(path.dirname(file)), timeoutMs: 300, limite: 0, riprova: true });
	assert.equal(r2.restano, 1);
	store.close();
});

test('comando: node cli.mjs immagini --json stampa i campi del giro', () => {
	const env = { ...process.env, BOTTEGA_HOME: path.join(TMP, 'home-cli') };
	fs.mkdirSync(path.join(env.BOTTEGA_HOME, 'memoria'), { recursive: true });
	fs.writeFileSync(path.join(env.BOTTEGA_HOME, 'memoria', 'config.json'), JSON.stringify({ roots: [ROOT] }));
	const r = spawnSync(process.execPath, [CLI, 'immagini', '--limite', '3', '--json'], { env, encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	const o = JSON.parse(r.stdout);
	for (const k of ['lette', 'nuove', 'saltate', 'errori', 'restano', 'ms', 'trovate', 'nucleo']) assert.ok(k in o, k);
	assert.equal(o.lette, 3);
	assert.ok(fs.existsSync(path.join(env.BOTTEGA_HOME, 'memoria', 'memoria.db')));

	const t = spawnSync(process.execPath, [CLI, 'immagini', '--limite', '1'], { env: { ...env, FAKE_OCR_MODE: '64' }, encoding: 'utf8' });
	assert.equal(t.status, 0);
	assert.match(t.stdout, /non sa ancora leggere le immagini/);
	assert.ok(!/[\u2013\u2014]/.test(t.stdout));
});
