#!/usr/bin/env node
// Banco di prova del cruscotto (src/stats.ts) su registri finti scritti in una cartella temporanea:
// regola dei 15 minuti, unione contro somma, sottoagenti che riempiono i buchi, risposte doppie,
// attribuzione delle sessioni partite dalla home, lettura che riprende un file cresciuto, cache su disco.
// Nessun dato vero: il repository e' pubblico.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'test-out', 'stats');
esbuild.buildSync({
	entryPoints: ['stats', 'scan', 'claude'].map(n => path.join(SRC, n + '.ts')),
	outdir: OUT,
	format: 'cjs',
	platform: 'node',
	bundle: false,
	target: 'node20',
	logLevel: 'silent',
});
const { StatsEngine, mergeSpans, minutesIn, costOf } = require(path.join(OUT, 'stats.js'));

let passed = 0, failed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log('  ok  ' + name);
	} catch (e) {
		failed++;
		console.log('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e));
	}
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-cruscotto-'));
const ROOT = path.join(TMP, 'projects');
const STORE = path.join(TMP, 'store');
const A = path.join(TMP, 'lavori', 'progetto-a');
const Bp = path.join(TMP, 'lavori', 'progetto-b');
const HOME = path.join(TMP, 'casa');

// ieri alle 10 locali: dentro tutte le finestre, lontano dalla mezzanotte
const d0 = new Date();
const BASE = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - 1, 10, 0).getTime();
const NOW = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 12, 0).getTime();
const at = min => new Date(BASE + min * 60_000).toISOString();

const user = (min, cwd, text = 'fai una cosa') => JSON.stringify({ type: 'user', timestamp: at(min), cwd, sessionId: 'x', message: { role: 'user', content: text } });
const toolResult = (min, cwd) => JSON.stringify({ type: 'user', timestamp: at(min), cwd, toolUseResult: { ok: true }, message: { role: 'user', content: [{ type: 'tool_result', content: 'fatto' }] } });
const asst = (min, cwd, id, usage, extra = {}) =>
	JSON.stringify({
		type: 'assistant',
		timestamp: at(min),
		cwd,
		requestId: 'req-' + id,
		message: { id: 'msg-' + id, model: 'claude-opus-5-5', role: 'assistant', content: extra.content || [{ type: 'text', text: 'ok' }], usage },
	});
const U = (i, o, cr = 0, cw = 0, cw1 = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, cache_creation: { ephemeral_1h_input_tokens: cw1, ephemeral_5m_input_tokens: cw - cw1 } });

function write(dir, file, lines, trailingNewline = true) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, file), lines.join('\n') + (trailingNewline ? '\n' : ''));
}

const dirA = path.join(ROOT, '-progetto-a');
const dirB = path.join(ROOT, '-progetto-b');
const dirH = path.join(ROOT, '-casa');
// sessione A: 10:00-10:10 e 10:40-10:50 nel file principale, il sottoagente lavora 10:20-10:30
write(dirA, 'sess-a.jsonl', [
	JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 'sess-a' }),
	user(0, A),
	asst(5, A, 1, U(10, 3, 1000, 200, 200)),
	asst(5, A, 1, U(10, 116, 1000, 200, 200)), // stessa risposta, blocco successivo: output cresciuto
	toolResult(10, A),
	user(40, A),
	asst(50, A, 2, U(5, 50, 2000, 0)),
	JSON.stringify({ type: 'ai-title', aiTitle: 'Sistemare il login', sessionId: 'sess-a' }),
]);
write(path.join(dirA, 'sess-a', 'subagents'), 'agent-1.jsonl', [asst(20, A, 3, U(1, 10)), asst(30, A, 4, U(1, 10))]);
// sessione B: in parallelo, 10:05-10:20
write(dirB, 'sess-b.jsonl', [user(5, Bp), asst(20, Bp, 5, U(2, 20))]);
// sessione C: partita da casa, ha toccato due file di B
write(dirH, 'sess-c.jsonl', [
	user(100, HOME),
	asst(105, HOME, 6, U(1, 1), { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(Bp, 'uno.ts') } }] }),
	asst(110, HOME, 7, U(1, 1), { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(Bp, 'due.ts') } }] }),
]);

const input = {
	projects: [
		{ name: 'progetto-a', path: A, sessions: [] },
		{ name: 'progetto-b', path: Bp, sessions: [] },
	],
	live: [{ pid: 42, sessionId: 'sess-b', cwd: Bp, status: 'busy', statusSince: NOW - 60_000, startedAt: BASE }],
	now: NOW,
};
const day = new Date(BASE);
const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;

(async () => {
	console.log('cruscotto');
	let s1;

	await test('intervalli: fusione con il buco e minuti in una finestra', () => {
		assert.deepStrictEqual(mergeSpans([0, 0, 5, 10, 30, 30], 15), [0, 10, 30, 30]);
		assert.deepStrictEqual(mergeSpans([30, 40, 0, 10, 10, 20], 0), [0, 20, 30, 40]);
		assert.strictEqual(minutesIn([0, 120_000, 300_000, 360_000], 60_000, 330_000), 1.5);
	});

	await test('prezzi: Opus 5.5 a listino, modello sconosciuto senza prezzo', () => {
		// 1 M input a 4 $, 1 M output a 20 $, 1 M letti a 0,20 $, 1 M scritti 1 h a 8 $
		assert.strictEqual(costOf('claude-opus-5-5', [1e6, 1e6, 1e6, 0, 1e6]).toFixed(2), '32.20');
		assert.strictEqual(costOf('modello-misterioso', [1, 1, 1, 1, 1]), null);
	});

	await test('primo giro: ore, sottoagenti, unione e somma', async () => {
		const e = new StatsEngine({ projectsDir: ROOT, storageDir: STORE });
		s1 = await e.compute(input);
		assert.strictEqual(s1.files.total, 4);
		assert.strictEqual(s1.files.read, 4);
		const d = s1.days.find(x => x.date === key);
		// A: 10:00-10:50 continuo grazie al sottoagente = 50; B: 15; C: 11:40-11:50 = 10
		assert.strictEqual(d.claude, 75, 'somma delle sessioni');
		// unione: 10:00-10:50 (A copre B) + 11:40-11:50 (C) = 60
		assert.strictEqual(d.you, 60, 'unione');
		assert.strictEqual(d.sessions, 3);
		assert.strictEqual(d.prompts, 4 - 0, 'quattro messaggi scritti (il risultato di uno strumento non conta)');
	});

	await test('token: la risposta doppia conta una volta, col valore piu alto', () => {
		const p = s1.periods['7'];
		const a = p.projects.find(x => x.name === 'progetto-a');
		// input 10+5+1+1, output 116+50+10+10, letti 1000+2000, scritti 200
		assert.deepStrictEqual(a.tok, [17, 186, 3000, 200]);
		const m = p.models.find(x => x.id === 'claude-opus-5-5');
		assert.strictEqual(m.messages, 7);
	});

	await test('attribuzione: la sessione partita da casa va al progetto dei file toccati', () => {
		const p = s1.periods['7'];
		const b = p.projects.find(x => x.name === 'progetto-b');
		assert.strictEqual(b.sessions, 2);
		assert.strictEqual(b.claude, 25);
		assert.ok(!p.projects.some(x => x.path === null), 'nessuna sessione fuori dai progetti');
		assert.strictEqual(b.live, 1);
	});

	await test('parallelo: costellazione A con B, picco di due sessioni', () => {
		const p = s1.periods['7'];
		assert.deepStrictEqual(p.edges, [], '15 minuti insieme: sotto la soglia di 20, nessuna linea');
		assert.strictEqual(p.peak.n, 2);
		const a = p.projects.find(x => x.name === 'progetto-a');
		assert.strictEqual(a.hours[10], 50);
		assert.strictEqual(s1.live[0].project, 'progetto-b');
		assert.strictEqual(s1.records.longestStint.minutes, 50);
	});

	await test('caldo: un motore nuovo legge la cache dal disco e non riapre i file', async () => {
		const e = new StatsEngine({ projectsDir: ROOT, storageDir: STORE });
		const s2 = await e.compute(input);
		assert.strictEqual(s2.files.read, 0);
		assert.strictEqual(s2.files.cached, 4);
		assert.strictEqual(StatsEngine.signature(s2), StatsEngine.signature(s1));
	});

	await test('file cresciuto: riprende dal punto lasciato, la riga a meta aspetta', async () => {
		const e = new StatsEngine({ projectsDir: ROOT, storageDir: STORE });
		await e.compute(input);
		const f = path.join(dirB, 'sess-b.jsonl');
		const size0 = fs.statSync(f).size;
		// due eventi nuovi, l'ultimo senza a capo (Claude Code lo sta ancora scrivendo)
		fs.appendFileSync(f, asst(25, Bp, 8, U(3, 30)) + '\n' + asst(30, Bp, 9, U(4, 40)));
		const s3 = await e.compute(input);
		assert.strictEqual(s3.files.read, 1);
		const b = s3.periods['7'].projects.find(x => x.name === 'progetto-b');
		assert.strictEqual(b.claude, 30, 'B ora arriva alle 10:25 (20 min) + C 10');
		assert.ok(s3.files.mb * 1048576 < fs.statSync(f).size - size0 + 1024, 'letti solo i byte nuovi');
		fs.appendFileSync(f, '\n');
		const s4 = await e.compute(input);
		assert.strictEqual(s4.periods['7'].projects.find(x => x.name === 'progetto-b').claude, 35, 'completata la riga, conta anche le 10:30');
	});

	await test('file riscritto da capo: si rilegge tutto', async () => {
		const e = new StatsEngine({ projectsDir: ROOT, storageDir: STORE });
		write(dirB, 'sess-b.jsonl', [user(5, Bp), asst(6, Bp, 10, U(1, 1))]);
		const s5 = await e.compute(input);
		assert.strictEqual(s5.periods['7'].projects.find(x => x.name === 'progetto-b').claude, 11);
	});

	await test('nessuna lineetta lunga nei testi del motore', () => {
		const src = fs.readFileSync(path.join(SRC, 'stats.ts'), 'utf8');
		assert.ok(!/[\u2013\u2014]/.test(src));
	});

	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
