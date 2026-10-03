#!/usr/bin/env node
// Banco di prova degli occhi di Melissa sull'editor (src/occhio.ts): solo funzioni pure, niente VS Code.

const path = require('path');
const assert = require('assert');
const esbuild = require('esbuild');

const OUT = path.join(__dirname, 'test-out', 'occhio');
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'occhio.ts')], outdir: OUT, format: 'cjs', platform: 'node', bundle: true, target: 'node20', logLevel: 'silent' });
const O = require(path.join(OUT, 'occhio.js'));

let passed = 0, failed = 0;
const fails = [];
function test(name, fn) {
	try {
		fn();
		passed++;
		console.log('  ok  ' + name);
	} catch (e) {
		failed++;
		fails.push(name);
		console.log('FAIL  ' + name + '\n      ' + String((e && e.stack) || e).split('\n').slice(0, 4).join('\n      '));
	}
}

const vista = (o = {}) => ({ file: '/u/p/avo_bnb/db.py', nome: 'avo_bnb/db.py', lingua: 'python', righe: 3, schermo: [1, 3], cursore: 2, accanto: [], ...o });
const LINEETTE = /[–—]/;

test('riga di contesto: file, righe, schermo, cursore o selezione, file accanto; niente senza file', () => {
	assert.strictEqual(O.rigaContesto(undefined), undefined);
	const r = O.rigaContesto(vista({ righe: 420, schermo: [37, 55], cursore: 46, accanto: ['avo_bnb/pipeline.py'] }));
	assert.match(r, /^Davanti ad Andrea nell'editor: avo_bnb\/db\.py, python, 420 righe; sullo schermo le righe 37-55; cursore alla riga 46; accanto: avo_bnb\/pipeline\.py\./);
	assert.match(r, /codice_leggi/);
	assert.match(O.rigaContesto(vista({ selezione: { da: 46, a: 50, testo: 'x' } })), /selezionate le righe 46-50/);
	assert.match(O.rigaContesto(vista({ selezione: { da: 7, a: 7, testo: 'x' } })), /selezionata la riga 7/);
	assert.ok(!LINEETTE.test(r));
});

test('file corto: intero con i numeri di riga; la selezione viene prima ed e\' «questo»', () => {
	const t = O.testoDaLeggere('a = 1\nb = 2\nc = 3', vista({ selezione: { da: 2, a: 2, testo: 'b = 2' } }));
	assert.match(t, /^File: avo_bnb\/db\.py \(python, 3 righe\), sullo schermo le righe 1-3\./);
	assert.ok(t.indexOf('Selezionato col mouse, righe 2-2') < t.indexOf('Il file intero'));
	assert.match(t, /Selezionato[^\n]*\n2\| b = 2/);
	assert.match(t, /Il file intero:\n1\| a = 1\n2\| b = 2\n3\| c = 3$/);
});

test('file lungo: la parte sullo schermo con il margine, il resto dichiarato non letto', () => {
	const righe = Array.from({ length: 5000 }, (_, i) => `riga numero ${i + 1} con un po' di testo dentro`);
	const t = O.testoDaLeggere(righe.join('\n'), vista({ righe: 5000, schermo: [2000, 2040], cursore: 2010 }), 20_000);
	assert.match(t, /Il file e' lungo: qui le righe \d+-\d+ di 5000/);
	assert.match(t, /2000\| riga numero 2000 /);
	assert.match(t, /2040\| riga numero 2040 /);
	assert.ok(!/\n1\| riga numero 1 /.test(t), 'non parte dall\'inizio');
	assert.ok(t.length < 24_000, `stava nel limite: ${t.length}`);
	assert.match(t, /non inventare/);
});

test('file di segreti: mai letti ne\' mandati al cervello', () => {
	for (const f of ['/u/.secrets/agnes-ai.env', '/u/p/.env', '/u/p/.env.local', '/u/p/key.p8', '/u/p/release.jks', '/u/.ssh/id_ed25519', '/u/.npmrc']) {
		assert.ok(O.eSegreto(f), f);
		const t = O.testoDaLeggere('AGNES_API_KEY=segreta', vista({ file: f, nome: path.basename(f) }));
		assert.ok(!/segreta/.test(t), f);
		assert.match(t, /file di segreti/);
	}
	for (const f of ['/u/p/db.py', '/u/p/env.ts', '/u/p/environment.swift', '/u/p/keys.md']) assert.ok(!O.eSegreto(f), f);
});

test('nome corto: relativo alla cartella di lavoro che lo contiene, altrimenti cartella e file', () => {
	assert.strictEqual(O.nomeCorto('/u/p/avo/avo_bnb/db.py', ['/u/p/avo', '/u/p']), 'avo/avo_bnb/db.py');
	assert.strictEqual(O.nomeCorto('/altrove/x/db.py', ['/u/p']), 'x/db.py');
});

test('un altro file per nome: nome intero, poi pezzo del nome, poi pezzo del percorso', () => {
	const c = [{ file: '/u/p/avo_bnb/db.py' }, { file: '/u/p/avo_bnb/pipeline.py' }, { file: '/u/p/web/pipeline_test.py' }];
	assert.strictEqual(O.scegliFile('pipeline.py', c).file, '/u/p/avo_bnb/pipeline.py');
	assert.strictEqual(O.scegliFile('Pipeline_TEST', c).file, '/u/p/web/pipeline_test.py');
	assert.strictEqual(O.scegliFile('web/', c).file, '/u/p/web/pipeline_test.py');
	assert.strictEqual(O.scegliFile('niente.rs', c), undefined);
	assert.strictEqual(O.scegliFile('  ', c), undefined);
});

console.log(`\n${passed} ok, ${failed} falliti`);
if (failed) {
	console.log('Falliti: ' + fails.join(', '));
	process.exit(1);
}
