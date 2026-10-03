#!/usr/bin/env node
// Banco di prova del racconto di Melissa mentre lavora (src/racconto.ts): frasi fisse, vere, brevi.

const path = require('path');
const assert = require('assert');
const esbuild = require('esbuild');

const OUT = path.join(__dirname, 'test-out', 'racconto');
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'racconto.ts')], outdir: OUT, format: 'cjs', platform: 'node', bundle: true, target: 'node20', logLevel: 'silent' });
const R = require(path.join(OUT, 'racconto.js'));

let passed = 0, failed = 0;
function test(name, fn) {
	try {
		fn();
		passed++;
		console.log('  ok  ' + name);
	} catch (e) {
		failed++;
		console.log('FAIL  ' + name + '\n      ' + String((e && e.stack) || e).split('\n').slice(0, 4).join('\n      '));
	}
}

test('frasi con gli argomenti: file, progetto, stanza, testo', () => {
	assert.strictEqual(R.fraseInizio('codice_leggi', {}), 'Leggo il codice che hai davanti.');
	assert.strictEqual(R.fraseInizio('codice_leggi', { file: 'avo_bnb/pipeline.py' }), 'Leggo pipeline.py.');
	assert.strictEqual(R.fraseInizio('lavoro_nuovo', { progetto: 'Woofmap', compito: 'x' }), 'Avvio un lavoro di Claude su Woofmap.');
	assert.strictEqual(R.fraseInizio('stanza_leggi', { stanza: 'appstore' }), 'Leggo la stanza appstore.');
	assert.strictEqual(R.fraseInizio('memoria_cerca', { testo: 'pipeline' }), 'Cerco nella memoria «pipeline».');
});

test('testi lunghi tagliati, niente per gli strumenti che si vedono gia\' dalla risposta', () => {
	const f = R.fraseInizio('memoria_cerca', { testo: 'x'.repeat(200) });
	assert.ok(f.length < 70, f);
	assert.match(f, /…»\.$/);
	for (const t of ['cervello_cambia', 'memoria_ricorda', 'lavoro_scrivi', 'lavoro_ferma', 'sconosciuto']) assert.strictEqual(R.fraseInizio(t, {}), undefined, t);
});

test('nessuna lineetta, nessun apostrofo al posto dell\'accento, una frase d\'attesa per tutti', () => {
	const nomi = ['codice_leggi', 'guarda_schermo', 'progetti_cerca', 'progetto_stato', 'progetto_apri', 'file_apri', 'sessioni_attive', 'sessione_leggi', 'lavori_elenco', 'lavoro_nuovo', 'lavoro_stanotte', 'memoria_cerca', 'memoria_bacheca', 'dove_risolto', 'regole_controlla', 'briefing', 'sistema_stato', 'store_soldi', 'app_guadagni', 'stanza_leggi', 'stanza_mostra', 'connettori_elenco', 'connettore_leggi', 'connettore_chiedi', 'git_spingi'];
	const a = { file: 'a.py', progetto: 'P', testo: 't', percorso: '/x/a.py', stanza: 's', app: 'A', server: 'admob' };
	for (const n of nomi) {
		for (const f of [R.fraseInizio(n, a), R.fraseAttesa(n)]) {
			assert.ok(f, n);
			assert.ok(!/[–—]/.test(f), f);
			assert.ok(!/\b(gia|e|perche|piu|cosi)'/.test(f), f);
		}
	}
	assert.strictEqual(R.ATTESA_MS, 8000);
});

test('cosa ha trovato, dal risultato vero: righe lette, selezione, conti, stanze, errori', () => {
	assert.strictEqual(R.fraseFine('codice_leggi', {}, 'File: avo_bnb/db.py (python, 420 righe), sullo schermo le righe 37-55.\n\nSelezionato col mouse, righe 46-50 (e\' di questo...):\n46| x\n\nIl file intero:\n1| a'), 'Ho letto 420 righe, la parte selezionata è la 46-50.');
	assert.strictEqual(R.fraseFine('codice_leggi', {}, "File: big.ts (typescript, 5000 righe).\n\nIl file e' lungo: qui le righe 1850-2190 di 5000. Per il resto"), 'Ho letto le righe 1850-2190 di 5000.');
	assert.strictEqual(R.fraseFine('codice_leggi', {}, "env e' un file di segreti: non lo leggo e non lo mando a nessun cervello."), 'È un file di segreti: non lo leggo.');
	assert.strictEqual(R.fraseFine('progetti_cerca', {}, 'Peak (/p/Peak)\nWoofmap (/p/Woofmap)\nTalky (/p/Talky)'), 'Trovati 3 progetti.');
	assert.strictEqual(R.fraseFine('progetti_cerca', {}, 'Peak (/p/Peak)'), 'Trovato: Peak.');
	assert.strictEqual(R.fraseFine('progetti_cerca', {}, 'Nessun progetto trovato per "zzz".'), 'Nessun progetto trovato per "zzz".');
	assert.strictEqual(R.fraseFine('sessioni_attive', {}, 'Peak: al lavoro\nBottega: ti aspetta'), '2 sessioni aperte, una ti aspetta.');
	assert.strictEqual(R.fraseFine('memoria_cerca', {}, '[Peak] a: b\n[Peak] c: d'), 'La memoria ha 2 ricordi su questo.');
	assert.strictEqual(R.fraseFine('stanza_leggi', { stanza: 'appstore' }, 'Ultimi 30 giorni: 402 € in tutto, 104 € da AdMob e 299 € dallo Store, 5480 download nuovi. Lo Store ha i dati fino al 1 ottobre.'), 'La stanza App Store dice: Ultimi 30 giorni: 402 € in tutto, 104 € da AdMob e 299 € dallo Store, 5480 download nuovi. Ora te lo spiego.');
	assert.strictEqual(R.fraseFine('lavoro_nuovo', {}, 'Lavoro avviato su Peak (stato: in coda).'), 'Il lavoro è partito.');
	assert.strictEqual(R.fraseFine('cervello_cambia', {}, 'Impegno profondo.'), undefined, 'niente per chi si vede gia\' dalla risposta');
	assert.strictEqual(R.fraseFine('progetti_cerca', {}, ''), undefined);
	for (const f of ['codice_leggi', 'stanza_leggi', 'sessioni_attive']) assert.ok(!/[–—]/.test(R.fraseFine(f, { stanza: 'appstore' }, 'Peak: ti aspetta') || ''));
});

console.log(`\n${passed} ok, ${failed} falliti`);
process.exit(failed ? 1 : 0);
