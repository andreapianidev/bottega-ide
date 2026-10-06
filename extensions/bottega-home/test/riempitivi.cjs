#!/usr/bin/env node
// Banco di prova di chi risponde quando Melissa chiama e di cosa si dice mentre il modello pensa (docs/CONTRATTI.md,
// 9.11): src/riempitivi.ts (puro) e la regola di chiamata di src/personaggi.ts, con i file veri di personaggi/.
// Gli stessi casi stanno nei test della mod melissa e dell'iPhone.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const esbuild = require('esbuild');

const DIR = path.join(__dirname, '..', 'personaggi');
// i personaggi si leggono dai file del repository, mai da ~/.bottega
process.env.BOTTEGA_PERSONAGGI = DIR;
const OUT = path.join(__dirname, 'test-out', 'riempitivi');
esbuild.buildSync({
	entryPoints: ['riempitivi', 'personaggi', 'memoria-contesto'].map(n => path.join(__dirname, '..', 'src', n + '.ts')),
	outdir: OUT, format: 'cjs', platform: 'node', bundle: true, target: 'node20', logLevel: 'silent',
});
const R = require(path.join(OUT, 'riempitivi.js'));
const P = require(path.join(OUT, 'personaggi.js'));
const M = require(path.join(OUT, 'memoria-contesto.js'));

let passed = 0, failed = 0;
const prove = [];
function test(name, fn) {
	prove.push([name, fn]);
}

test('chi risponde: tutti i casi della tabella della 9.11', () => {
	const casi = [
		['Elliot, tu che dici?', 'elliot'],
		['Che ne pensi, Krista?', 'krista'],
		['Allora, Darlene?', 'darlene'],
		['Elliot... tu che dici?', 'elliot'],
		['Dai Krista, diglielo tu.', 'krista'],
		['E tu Krista che ne dici?', 'krista'],
		['Tocca a te, Krista.', 'krista'],
		["Krista, che ne pensi? Io dico di si'.", 'krista'],
		['Ehi Darlene ascolta questa.', 'darlene'],
		['Ok Elliot, ma tu cosa faresti?', 'elliot'],
		['Ti ricordi quando Elliot ha bucato E Corp?', null],
		['Vuoi che apra il file di Krista?', null],
		['Krista direbbe che sei pigro.', null],
		["Darlene, al posto tuo, avrebbe gia' litigato.", null],
		["Darlene ti ha mai detto di no? Comunque e' finita.", null],
		['Non so. Tu che dici?', null],
		["Krista te lo sta dicendo da mezz'ora e tu fai lo gnorri.", null],
		['Sono sicura che Krista avrebbe qualcosa da dirti.', null],
	];
	for (const [t, chi] of casi) assert.strictEqual(P.chiamatoPerNome(t), chi, t);
	assert.strictEqual(P.chiamatoPerNome('Sono sicura che Krista avrebbe qualcosa da dirti.', 'krista'), 'krista', 'l\'invitato, nominato ovunque');
	assert.strictEqual(P.chiamatoPerNome('Sono sicura che Krista avrebbe qualcosa da dirti.', 'elliot'), null, 'un altro invitato non conta');
});

test('chi risponde: segnale, invitato, ultime due frasi, offerti', () => {
	assert.deepStrictEqual(P.chiamata('Ti ricordi Elliot? Parliamone @darlene', ['darlene', 'elliot']), { testo: 'Ti ricordi Elliot? Parliamone', ospite: 'darlene' }, 'il segnale vince, ovunque');
	assert.deepStrictEqual(P.chiamata('Sono sicura che Krista avrebbe qualcosa da dirti.', ['krista'], 'krista'), { testo: 'Sono sicura che Krista avrebbe qualcosa da dirti.', ospite: 'krista' });
	assert.deepStrictEqual(P.chiamata('Elliot, tu che dici?', []), { testo: 'Elliot, tu che dici?', ospite: null }, 'solo tra gli offerti');
	assert.strictEqual(P.chiamatoPerNome('Elliot, tu che dici? Ok. Va bene. Basta.'), null, 'il vocativo sta nelle ultime due frasi');
	assert.strictEqual(P.chiamatoPerNome('Ho aperto il .env di prova. Elliot, che ne pensi?'), 'elliot', '".env" non spezza la frase');
	assert.strictEqual(P.chiamatoPerNome('Il file .env? Lo guardo io. Darlene, dimmi.'), 'darlene');
	assert.strictEqual(P.chiamatoPerNome('Ehi Krista! Sì, tu.'), 'krista', 'la parola finisce anche dopo una lettera accentata');
	assert.strictEqual(P.chiamatoPerNome('Krista'), null, 'il nome da solo non si rivolge a nessuno');
	assert.strictEqual(P.chiamatoPerNome('Mandalo a @krista, poi vediamo.', 'krista'), null, 'l\'invitato non conta dentro un segnale');
});

test('anche Andrea chiama: il nome da vocativo in qualunque frase, senza domanda', () => {
	assert.strictEqual(P.chiamatoPerNome("Vabbe' Elliot, hai ragione.", null, true), 'elliot');
	assert.strictEqual(P.chiamatoPerNome('Ieri Elliot mi ha detto che la VPN non regge.', null, true), null);
	assert.strictEqual(P.chiamatoPerNome('Grazie Krista. Comunque domani lo faccio. Poi vediamo.', null, true), 'krista', 'anche nella prima frase');
	assert.strictEqual(P.chiamatoPerNome('Vabbè Darlene, come vuoi.', null, true), 'darlene');
	assert.strictEqual(P.chiamatoPerNome('Ciao Elliot.', null, true), 'elliot');
	assert.strictEqual(P.chiamatoPerNome('Scusa Krista, non volevo.', null, true), 'krista');
	assert.strictEqual(P.chiamatoPerNome('Beh Darlene, ci provo.', null, true), 'darlene');
	assert.strictEqual(P.chiamatoPerNome("Vabbe' Elliot, hai ragione."), null, 'per Melissa la battuta deve rivolgersi a qualcuno');
	assert.strictEqual(P.chiamatoPerNome("Vabbe' Elliot, tu che dici?"), 'elliot', 'e vabbe\' vale anche per lei');
});

test('intenzione di quello che Andrea ha detto: la prima regola che vale', () => {
	const casi = [
		['che palle, non funziona niente', 'sfogo'],
		['si è rotto di nuovo il build', 'sfogo'],
		['odio quando succede', 'sfogo'],
		['ahahah sei pessima', 'battuta'],
		['dai che scherzo', 'battuta'],
		['rido da solo', 'battuta'],
		['apri il progetto Peak', 'ordine'],
		['Melissa, dai, fammi vedere i lavori', 'ordine'],
		['ok allora controlla la build', 'ordine'],
		['puoi guardare le sessioni?', 'ordine'],
		['voglio che tu scriva un test', 'ordine'],
		['come sta il progetto', 'domanda'],
		['perché è lento', 'domanda'],
		['e quando esce la build', 'domanda'],
		["c'è qualcosa di nuovo", 'domanda'],
		['la build è verde?', 'domanda'],
		['oggi ho dormito poco', 'chiacchiera'],
		['fainomeno', 'chiacchiera'],
		['ridotto il prezzo', 'chiacchiera'],
		['non vado da nessuna parte', 'chiacchiera'],
	];
	for (const [t, i] of casi) assert.strictEqual(R.intento(t), i, t);
});

test('tema per l\'eco: la prima parola maiuscola che non apre la frase, non un nome di casa', () => {
	const esclusi = ['Melissa', 'Andrea', 'Darlene', 'Elliot', 'Krista'];
	assert.strictEqual(R.tema('come va il progetto Talky?', esclusi), 'Talky');
	assert.strictEqual(R.tema('Talky come va?', esclusi), null, 'a inizio frase non conta');
	assert.strictEqual(R.tema('Ok. Talky come va?', esclusi), null, 'nemmeno a inizio della seconda');
	assert.strictEqual(R.tema('senti Melissa, apri Woofmap', esclusi), 'Woofmap');
	assert.strictEqual(R.tema('chiedi a Elliot della VPN', esclusi), 'VPN');
	assert.strictEqual(R.tema('apri Io e Peak', esclusi), 'Peak', 'almeno tre lettere');
	assert.strictEqual(R.tema('guarda «Àncora» domani', esclusi), 'Àncora', 'maiuscola accentata e virgolette');
	assert.strictEqual(R.tema('', esclusi), null);
});

test('scelta: gruppo della voce, poi il suo chiacchiera, poi quello di Melissa; mai le ultime min(3, n - 1)', () => {
	const melissa = { domanda: ['M1', 'M2'], chiacchiera: ['Mc'], lunga: ['L1', 'L2', 'L3', 'L4', 'L5'], eco: ['{x}? Mh.'] };
	assert.strictEqual(R.scegliRiempitivo({ domanda: ['D'] }, melissa, 'domanda', [], { caso: 0 }).frase, 'D');
	assert.strictEqual(R.scegliRiempitivo({ chiacchiera: ['C'] }, melissa, 'domanda', [], { caso: 0 }).frase, 'C', 'gruppo vuoto: il suo chiacchiera');
	assert.strictEqual(R.scegliRiempitivo({ domanda: ['  '] }, melissa, 'domanda', [], { caso: 0.99 }).frase, 'M2', 'senza: quello di Melissa');
	assert.strictEqual(R.scegliRiempitivo(undefined, melissa, 'sfogo', [], { caso: 0 }).frase, 'Mc', 'e alla fine il chiacchiera di Melissa');
	assert.strictEqual(R.scegliRiempitivo(undefined, {}, 'domanda', []), null, 'niente da dire');
	// anti-ripetizione: con 5 frasi fuori le ultime 3, con 2 l'ultima, con 1 nessuna
	const fuori = ['L3', 'L4', 'L5'];
	for (let c = 0; c < 1; c += 0.1) assert.ok(['L1', 'L2'].includes(R.scegliRiempitivo(undefined, melissa, 'lunga', ['L1', ...fuori], { caso: c }).frase));
	assert.strictEqual(R.scegliRiempitivo(undefined, melissa, 'domanda', ['M1'], { caso: 0 }).frase, 'M2');
	assert.strictEqual(R.scegliRiempitivo({ domanda: ['Solo'] }, melissa, 'domanda', ['Solo'], { caso: 0 }).frase, 'Solo');
	// giri di fila con la stessa memoria: mai la stessa frase entro tre
	const r = { lunga: ['a', 'b', 'c', 'd', 'e'] };
	let recenti = [];
	for (let i = 0; i < 40; i++) {
		const s = R.scegliRiempitivo(r, melissa, 'lunga', recenti, { caso: (i * 0.37) % 1 });
		assert.ok(!recenti.slice(-3).includes(s.modello), `giro ${i}`);
		recenti = [...recenti, s.modello].slice(-R.RIEMPI_MEMORIA);
	}
});

test('eco: con un tema, per domanda, ordine e chiacchiera, e caso2 sotto 0.25; conta il modello', () => {
	const melissa = { domanda: ['M'], sfogo: ['S'], eco: ['{x}? Mh.', 'Ah, {x}.'] };
	const o = { testo: 'come sta il progetto Talky?', caso: 0, caso2: 0.1 };
	assert.deepStrictEqual(R.scegliRiempitivo(undefined, melissa, 'domanda', [], o), { frase: 'Talky? Mh.', modello: '{x}? Mh.' });
	assert.strictEqual(R.scegliRiempitivo(undefined, melissa, 'domanda', ['{x}? Mh.'], o).frase, 'Ah, Talky.', 'il modello appena detto non torna');
	assert.strictEqual(R.scegliRiempitivo(undefined, melissa, 'domanda', [], { ...o, caso2: 0.25 }).frase, 'M');
	assert.strictEqual(R.scegliRiempitivo(undefined, melissa, 'sfogo', [], o).frase, 'S', 'mai per uno sfogo');
	assert.strictEqual(R.scegliRiempitivo(undefined, melissa, 'lunga', [], o), null, 'ne\' per l\'attesa lunga');
	assert.strictEqual(R.scegliRiempitivo({ domanda: ['P'], eco: ['{x}!'] }, melissa, 'domanda', [], o).frase, 'Talky!', 'prima l\'eco della voce');
});

test('senza intercalare: fino a due, la maiuscola rimessa, e se non resta niente la risposta com\'era', () => {
	assert.strictEqual(R.senzaAttacco('Allora, la build è verde.'), 'La build è verde.');
	assert.strictEqual(R.senzaAttacco('Mh. Ok, ci penso io.'), 'Ci penso io.');
	assert.strictEqual(R.senzaAttacco('Mmh... allora, vediamo: tre lavori.'), 'Vediamo: tre lavori.', 'due e non di piu\'');
	assert.strictEqual(R.senzaAttacco('Sì, è pronta.'), 'È pronta.');
	assert.strictEqual(R.senzaAttacco('Ecco!'), 'Ecco!');
	assert.strictEqual(R.senzaAttacco('Allora ci vediamo domani.'), 'Allora ci vediamo domani.', 'senza punteggiatura non e\' un intercalare');
	assert.strictEqual(R.senzaAttacco('Okay la build'), 'Okay la build');
	assert.ok(R.soloAttacco('Mh.') && R.soloAttacco('Allora, vediamo.'));
	assert.ok(!R.soloAttacco('Allora, la build.') && !R.soloAttacco('Ciao.'));
});

test('tempi', () => {
	assert.deepStrictEqual([...R.RIEMPI_TEMPI], [900, 5000, 10000]);
	assert.strictEqual(R.RIEMPI_STRUMENTO_MS, 1500);
});

test('i file: melissa.json e\' solo riempitivi, i personaggi li hanno, niente avvisi', () => {
	const avvisi = [];
	assert.strictEqual(P.carica([DIR], m => avvisi.push(m)), 3);
	assert.deepStrictEqual(avvisi, [], 'melissa.json non e\' un file rotto');
	assert.deepStrictEqual(P.ORDINE, ['darlene', 'elliot', 'krista']);
	assert.ok(!P.esiste('melissa') && !P.elenco().some(x => x.chiave === 'melissa'));
	assert.deepStrictEqual(Object.keys(P.RIEMPITIVI_MELISSA).sort(), [...R.GRUPPI].sort());
	for (const k of P.ORDINE) assert.deepStrictEqual(Object.keys(P.PERSONAGGI[k].riempitivi).sort(), [...R.GRUPPI].sort(), k);
	assert.deepStrictEqual(R.leggiRiempitivi({ domanda: ['  Mh. ', '', 3], lunga: [], altro: ['x'] }), { domanda: ['Mh.'] }, 'testi vuoti e gruppi ignoti fuori');
	assert.strictEqual(R.leggiRiempitivi({ lunga: [''] }), undefined);
	assert.strictEqual(R.leggiRiempitivi(['x']), undefined);
	const scalda = R.daScaldare(P.RIEMPITIVI_MELISSA);
	assert.ok(scalda.length > 20 && scalda.every(f => !f.includes('{x}') && f.length <= 120), 'l\'eco non si scalda');
	assert.deepStrictEqual(R.daScaldare({ lunga: ['x'.repeat(121), 'ok'], eco: ['{x}'] }), ['ok']);
});

test('i file: un personaggio senza riempitivi, e pubblica copia anche melissa.json', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riempitivi-'));
	const a = fs.mkdtempSync(path.join(os.tmpdir(), 'riempitivi-mod-'));
	try {
		fs.writeFileSync(path.join(dir, 'tyrell.json'), JSON.stringify({ chiave: 'tyrell', nome: 'Tyrell', voce: 'v', carattere: 'Sei Tyrell.', saluti: ['Ciao.'] }));
		fs.writeFileSync(path.join(dir, 'melissa.json'), JSON.stringify({ chiave: 'melissa', riempitivi: { chiacchiera: ['Mh.'] } }));
		const avvisi = [];
		assert.strictEqual(P.carica([dir], m => avvisi.push(m)), 1);
		assert.deepStrictEqual(avvisi, []);
		assert.strictEqual(P.PERSONAGGI.tyrell.riempitivi, undefined);
		assert.deepStrictEqual({ ...P.RIEMPITIVI_MELISSA }, { chiacchiera: ['Mh.'] }, 'sostituiti, non sommati');
		assert.strictEqual(R.scegliRiempitivo(P.PERSONAGGI.tyrell.riempitivi, P.RIEMPITIVI_MELISSA, 'domanda', [], { caso: 0 }).frase, 'Mh.');
		P.pubblica(dir, a);
		assert.deepStrictEqual(fs.readdirSync(a).sort(), ['melissa.json', 'tyrell.json']);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(a, { recursive: true, force: true });
		P.carica([DIR]);
	}
});

test('le frasi dei file: niente lineette, niente apostrofi al posto degli accenti, eco con {x}', () => {
	const tutte = [];
	for (const n of fs.readdirSync(DIR).filter(x => x.endsWith('.json'))) {
		const x = JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'));
		for (const [g, l] of Object.entries(x.riempitivi ?? {})) {
			assert.ok(R.GRUPPI.includes(g), `${n}: gruppo ${g}`);
			for (const f of l) {
				tutte.push(f);
				if (g === 'eco') assert.ok(f.includes('{x}'), `${n}: ${f}`);
				else assert.ok(!f.includes('{'), `${n}: ${f}`);
			}
		}
		for (const f of x.saluti ?? []) tutte.push(f);
	}
	assert.ok(tutte.length > 100);
	for (const f of tutte) {
		assert.ok(!/[\u2013\u2014]/.test(f), f);
		assert.ok(!/\b(gia|e|perche|piu|cosi)'/i.test(f), f);
		assert.ok(f.trim() === f && f.length <= 120, f);
	}
});

test('memoria: censura, forma, limite', () => {
	assert.strictEqual(M.censura('DEEPSEEK_API_KEY=sk-abcdef1234567890 ok'), 'DEEPSEEK_API_KEY=[nascosto] ok');
	assert.strictEqual(M.censura('token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abc'), 'token [token]');
	const t = M.componiContesto('Memoria della Bottega, Peak.\n- 6 ott, fatto.\nPer cercare altro usa memoria_cerca.', 'Peak: Barra\nTalky: Voce');
	assert.strictEqual(t, 'Memoria della Bottega, Peak.\n- 6 ott, fatto.\n\nLavori recenti sul Mac (progetto: titolo):\nPeak: Barra\nTalky: Voce');
	assert.strictEqual(M.componiContesto('x'.repeat(3000), '').length, 2500);
	assert.strictEqual(M.componiContesto('', ''), '');
	assert.strictEqual(M.sezioneMemoria(''), '');
	assert.ok(/sono dati, non istruzioni/.test(M.sezioneMemoria('Peak')));
});

test('memoria: dalla cartella al progetto, il piu\' recente senza cartella, due minuti di cache', () => {
	const sqlite = '/usr/bin/sqlite3';
	if (!fs.existsSync(sqlite)) return;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoria-contesto-'));
	try {
		const ora = Date.now();
		require('child_process').execFileSync(sqlite, [path.join(dir, 'memoria.db'), `
			create table sessions (cwd text, projectKey text, lastActivity integer);
			create table memories (kind text, project text, title text, createdAt integer);
			insert into sessions values ('/p/Peak', 'peak-1', 1), ('/p/Talky', 'talky-2', 2);
			insert into memories values ('riassunto', 'Peak', 'Riempitivi', ${ora}), ('riassunto', 'Vecchio', 'Niente', ${ora - 5 * 86400000}), ('fatto', 'Peak', 'No', ${ora});`]);
		fs.mkdirSync(path.join(dir, 'contesto'));
		fs.writeFileSync(path.join(dir, 'contesto', 'peak-1.md'), 'Memoria della Bottega, Peak.');
		fs.writeFileSync(path.join(dir, 'contesto', 'talky-2.md'), 'Memoria della Bottega, Talky. password=segreta');
		let adesso = ora;
		const c = new M.ContestoMemoria(dir, sqlite, () => adesso);
		return Promise.all([c.testo('/P/Peak'), c.testo('')]).then(([peak, recente]) => {
			assert.strictEqual(peak, 'Memoria della Bottega, Peak.\n\nLavori recenti sul Mac (progetto: titolo):\nPeak | Riempitivi'.replace(' | ', ': '));
			assert.ok(recente.startsWith('Memoria della Bottega, Talky. password=[nascosto]'), recente);
			fs.writeFileSync(path.join(dir, 'contesto', 'peak-1.md'), 'Cambiato.');
			assert.strictEqual(c.subito('/P/Peak'), peak, 'entro due minuti, lo stesso');
			adesso += 121_000;
			assert.strictEqual(c.subito('/P/Peak'), peak, 'scaduto: il vecchio subito, il nuovo per la prossima volta');
			return c.testo('/P/Peak').then(n => assert.ok(n.startsWith('Cambiato.')));
		}).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
	} catch (e) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw e;
	}
});

(async () => {
	for (const [name, fn] of prove) {
		try {
			await fn();
			passed++;
			console.log('  ok  ' + name);
		} catch (e) {
			failed++;
			console.log('FAIL  ' + name + '\n      ' + String((e && e.stack) || e).split('\n').slice(0, 4).join('\n      '));
		}
	}
	console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
