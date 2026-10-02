#!/usr/bin/env node
// Banco di prova dei compiti brevi di Apple Intelligence lato estensione (src/compiti.ts): coda delle trascrizioni,
// righe di stato con cache e ritmo, frasi con i segnaposto (le cifre dai dati, mai dal modello).
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const esbuild = require('esbuild');

const OUT = path.join(__dirname, 'test-out');
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'compiti.ts')], outdir: OUT, format: 'cjs', platform: 'node', bundle: false, target: 'node20', logLevel: 'silent' });
const K = require(path.join(OUT, 'compiti.js'));

const tests = [];
const test = (n, f) => tests.push([n, f]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compiti-'));
const line = o => JSON.stringify(o);

function trascrizione(nome, righe) {
	const f = path.join(tmp, nome + '.jsonl');
	fs.writeFileSync(f, righe.map(line).join('\n') + '\n');
	return f;
}

test('coda: ultima richiesta testuale e ultimo testo di Claude, senza tag ne\' promemoria', () => {
	const f = trascrizione('a', [
		{ type: 'user', message: { content: 'vecchia richiesta' } },
		{ type: 'user', message: { content: '<cross-session-message from="x">Sistema il cruscotto</cross-session-message><system-reminder>non mostrare</system-reminder>' } },
		{ type: 'assistant', message: { content: [{ type: 'text', text: 'Ora correggo il calcolo delle ore.' }, { type: 'tool_use', name: 'Edit' }] } },
		{ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
		{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
	]);
	const c = K.codaTrascrizione(f);
	assert.equal(c.richiesta, 'Sistema il cruscotto');
	assert.equal(c.ultimoMessaggio, 'Ora correggo il calcolo delle ore.');
	assert.deepEqual(c.strumenti, ['Bash', 'Edit']);
});

test('righe di stato: una richiesta per sessione, poi niente finche\' la coda non cambia o passa il ritmo', async () => {
	let now = 1_000_000;
	const calls = [];
	const nucleo = { available: true, request: async (cmd, args) => (calls.push(args), { riga: 'Corregge il calcolo delle ore', fase: 'scrive' }) };
	const f = trascrizione('b', [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Correggo le ore.' }] } }]);
	const r = new K.RigheStato(nucleo, { transcript: () => f, now: () => now, ritmoMs: 60_000 });
	assert.equal(await r.aggiorna([{ sessionId: 's1', progetto: 'Bottega' }]), true);
	assert.equal(r.all().s1, 'Corregge il calcolo delle ore');
	assert.equal(calls[0].progetto, 'Bottega');
	await r.aggiorna([{ sessionId: 's1', progetto: 'Bottega' }]);
	assert.equal(calls.length, 1, 'dentro il ritmo non richiede');
	now += 61_000;
	await r.aggiorna([{ sessionId: 's1', progetto: 'Bottega' }]);
	assert.equal(calls.length, 1, 'coda uguale: non richiede');
	fs.appendFileSync(f, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Adesso provo i test.' }] } }) + '\n');
	now += 61_000;
	await r.aggiorna([{ sessionId: 's1', progetto: 'Bottega' }]);
	assert.equal(calls.length, 2);
	await r.aggiorna([]);
	assert.equal(r.get('s1'), undefined, 'le sessioni finite si dimenticano');
});

test('righe di stato: senza Apple Intelligence non chiede niente', async () => {
	const nucleo = { available: true, capabilities: { foundationModels: false }, request: async () => assert.fail('non doveva chiedere') };
	const r = new K.RigheStato(nucleo, { transcript: () => trascrizione('c', [{ type: 'assistant', message: { content: 'x' } }]) });
	assert.equal(await r.aggiorna([{ sessionId: 's', progetto: 'P' }]), false);
});

test('segnaposto: si riempiono; una cifra del modello o un segnaposto ignoto scartano la frase', () => {
	const v = { ore: '12 h 30 min', primo: 'Woofmap' };
	assert.equal(K.riempi('Questa settimana {ore}, soprattutto su {primo}.', v), 'Questa settimana 12 h 30 min, soprattutto su Woofmap.');
	assert.equal(K.riempi('Questa settimana 14 ore, soprattutto su {primo}.', v), null);
	assert.equal(K.riempi('Su {terzo} poco.', v), null);
});

test('fatti del cruscotto: valori all\'italiana, nessuna cifra lasciata al modello', () => {
	const stats = {
		week: { now: { you: 750 }, prevSoFar: { you: 600 } },
		periods: { '7': { peak: { n: 3 }, projects: [{ name: 'Peak', path: '/p', you: 300 }, { name: 'Woofmap', path: '/w', you: 400 }, { name: 'Fuori', path: null, you: 900 }] } },
		streak: { current: 5 }, today: { you: 95 },
	};
	const { fatti, valori } = K.fattiCruscotto(stats);
	assert.equal(valori.ore, '12 h 30 min');
	assert.equal(valori.confronto, '25%');
	assert.equal(valori.primo, 'Woofmap');
	assert.equal(valori.oggi, '1 h 35 min');
	for (const f of fatti) assert.ok(!/\d/.test(f.testo), `il testo del fatto non ha cifre: ${f.testo}`);
});

(async () => {
	let ok = 0;
	for (const [n, f] of tests) {
		try {
			await f();
			ok++;
			console.log(`ok   ${n}`);
		} catch (e) {
			console.log(`FAIL ${n}\n     ${e?.stack ?? e}`);
			process.exitCode = 1;
		}
	}
	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(`\ncompiti: ${ok}/${tests.length} superati`);
})();
