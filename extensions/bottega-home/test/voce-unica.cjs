#!/usr/bin/env node
// Banco di prova di «chi ha la voce» (src/voce-unica.ts, CONTRATTI 4.11): una Melissa sola sul Mac. Una cartella
// temporanea al posto di ~/.bottega/voce, niente isola vera.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const esbuild = require('esbuild');

const OUT = path.join(__dirname, 'test-out', 'voce-unica');
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'voce-unica.ts')], outdir: OUT, format: 'cjs', platform: 'node', bundle: true, target: 'node20', logLevel: 'silent' });
const V = require(path.join(OUT, 'voce-unica.js'));

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
const pausa = ms => new Promise(r => setTimeout(r, ms));

(async () => {
	await test('regole: si tace solo per la presa piu\' recente di un altro', () => {
		assert.ok(V.deveTacere('bottega', { chi: 'avo', pid: 1, at: 200 }, 100));
		assert.ok(!V.deveTacere('bottega', { chi: 'bottega', pid: 1, at: 200 }, 100));
		assert.ok(!V.deveTacere('bottega', { chi: '', pid: 1, at: 200 }, 100));
		assert.ok(!V.deveTacere('bottega', { chi: 'avo', pid: 1, at: 100 }, 100));
	});

	await test('regole: si lascia solo la voce propria', () => {
		assert.ok(V.daLasciare('bottega', 7, { chi: 'bottega', pid: 7, at: 1 }));
		assert.ok(!V.daLasciare('bottega', 7, { chi: 'bottega', pid: 8, at: 1 }));
		assert.ok(!V.daLasciare('bottega', 7, { chi: 'avo', pid: 7, at: 1 }));
		assert.ok(!V.daLasciare('bottega', 7, undefined));
	});

	await test('prendi, lascia e la presa di Avo che fa tacere la barra', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voce-unica-'));
		const sentite = [];
		let zittite = 0;
		const v = new V.VoceUnica(p => sentite.push(p), () => zittite++, dir);
		try {
			v.prendi('darlene');
			const mia = V.leggiPresa(dir);
			assert.strictEqual(mia.chi, 'bottega');
			assert.strictEqual(mia.personaggio, 'darlene');
			assert.strictEqual(zittite, 1, 'chi prende la voce zittisce l\'isola');
			v.rileggi();
			assert.strictEqual(sentite.length, 0, 'la propria presa non fa tacere');

			V.scriviPresa({ chi: 'avo', pid: 99999, at: Date.now() / 1000 + 1, personaggio: 'krista' }, dir);
			await pausa(300);
			v.rileggi();
			assert.strictEqual(sentite.length, 1, 'la presa di Avo arriva una volta sola');
			assert.strictEqual(sentite[0].chi, 'avo');

			v.lascia();
			assert.strictEqual(V.leggiPresa(dir).chi, 'avo', 'la presa di un altro non si cancella');
			v.prendi();
			v.lascia();
			assert.strictEqual(V.leggiPresa(dir).chi, '', 'la propria voce torna libera');
		} finally {
			v.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
