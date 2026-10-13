#!/usr/bin/env node
// Banco di prova dell'avviso di fine (src/avviso-fine.ts) e del suo uso nell'isola (src/isola-attivita.ts):
// l'interruttore condiviso con la mod melissa, quali lavori meritano la voce, le frasi, e cosa arriva all'isola.
// Isola, rete e file sono finti: niente socket veri, niente DeepSeek, una cartella temporanea.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const esbuild = require('esbuild');

const OUT = path.join(__dirname, 'test-out', 'avviso-fine');
for (const f of ['avviso-fine', 'isola-attivita']) {
	esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', `${f}.ts`)], outdir: OUT, format: 'cjs', platform: 'node', bundle: true, target: 'node20', logLevel: 'silent' });
}
const A = require(path.join(OUT, 'avviso-fine.js'));
const I = require(path.join(OUT, 'isola-attivita.js'));

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
const cartella = () => fs.mkdtempSync(path.join(os.tmpdir(), 'avviso-fine-'));
const att = (over = {}) => ({ key: 'codex:1', source: 'codex', id: '1', project: 'Peak', title: 'sistema il login', status: 'in corso', updatedAt: 0, evidence: 'prova', ...over });

(async () => {
	await test('file condiviso: assente vale {}, vuoto o rotto non si legge (la mod lo sta scrivendo)', () => {
		const d = cartella();
		const f = path.join(d, 'nucleo', 'cronaca.json');
		assert.deepStrictEqual(A.leggiCondiviso(f), {});
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, '');
		assert.strictEqual(A.leggiCondiviso(f), null);
		fs.writeFileSync(f, '{"sessione": "ab');
		assert.strictEqual(A.leggiCondiviso(f), null);
		fs.writeFileSync(f, '[]');
		assert.strictEqual(A.leggiCondiviso(f), null);
	});

	await test('scriviAvviso cambia solo avviso, lascia cronaca e chiacchierata della mod, file 600', async () => {
		const d = cartella();
		const f = path.join(d, 'nucleo', 'cronaca.json');
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, JSON.stringify({ sessione: 'abc', conversa: { sessione: 'x', at: 5 } }));
		await A.scriviAvviso(f, true);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { sessione: 'abc', conversa: { sessione: 'x', at: 5 }, avviso: true });
		assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
		assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['cronaca.json'], 'niente file temporanei lasciati');
		await A.scriviAvviso(f, false);
		assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).avviso, false);
	});

	await test('scriviAvviso non azzera un file che non si legge: riprova, poi si arrende senza scrivere', async () => {
		const d = cartella();
		const f = path.join(d, 'cronaca.json');
		fs.writeFileSync(f, '');
		setTimeout(() => fs.writeFileSync(f, JSON.stringify({ sessione: 'abc' })), 60);
		await A.scriviAvviso(f, true);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { sessione: 'abc', avviso: true }, 'aspetta la fine della scrittura della mod');
		fs.writeFileSync(f, '{rotto');
		await assert.rejects(A.scriviAvviso(f, false));
		assert.strictEqual(fs.readFileSync(f, 'utf8'), '{rotto', 'il file non si tocca');
	});

	await test('interruttore: segue il file cambiato da fuori (la mod), e la chiacchierata della mod', async () => {
		const d = cartella();
		const f = path.join(d, 'nucleo', 'cronaca.json');
		const visti = [];
		const i = new A.InterruttoreAvviso(f, v => visti.push(v), 50);
		try {
			assert.strictEqual(i.acceso, false);
			fs.writeFileSync(f, JSON.stringify({ avviso: true, conversa: { sessione: 's', at: Date.now() } }));
			for (let k = 0; k < 40 && !i.acceso; k++) await pausa(25);
			assert.strictEqual(i.acceso, true);
			assert.deepStrictEqual(visti, [true]);
			assert.strictEqual(i.conversaAltrove(), true);
			assert.strictEqual(i.conversaAltrove(Date.now() + 4 * 60_000), false, 'una chiacchierata ferma da 4 minuti e\' finita');
			// un file a meta' scrittura non spegne l'avviso
			fs.writeFileSync(f, '');
			i.rileggi();
			assert.strictEqual(i.acceso, true);
			// la mod finisce di scrivere: ora si puo' spegnere
			fs.writeFileSync(f, JSON.stringify({ avviso: true }));
			await i.imposta(false);
			assert.strictEqual(i.acceso, false);
		} finally {
			i.dispose();
		}
	});

	await test('comandi: si avvisa la fine di un build, non di ssh, vim, un server o claude', () => {
		for (const c of ['npm run build', 'swift test', 'xcodebuild -scheme Peak build', './scripts/package.sh', 'python3 genera.py', 'FOO=1 sudo make', 'docker compose up -d', 'vite build']) {
			assert.strictEqual(A.comandoChiuso(c), true, c);
		}
		for (const c of ['ssh server-prova', 'vim a.ts', 'claude', 'python3', 'node', 'npm run dev', 'npm start', 'yarn dev', 'tsc --watch', 'tail -f log.txt', 'docker compose up', 'vite', 'python3 -m http.server 8000', '/opt/homebrew/bin/htop']) {
			assert.strictEqual(A.comandoChiuso(c), false, c);
		}
	});

	await test('comando detto: il programma e le prime parole, mai percorsi, opzioni o valori', () => {
		assert.strictEqual(A.comandoDetto('npm run build'), 'npm run build');
		assert.strictEqual(A.comandoDetto('xcodebuild -scheme Peak build'), 'xcodebuild');
		assert.strictEqual(A.comandoDetto('./scripts/package.sh --stage-only'), 'package.sh');
		assert.strictEqual(A.comandoDetto('FOO=1 sudo swift test --filter X'), 'swift test');
		assert.strictEqual(A.comandoDetto('git push origin main'), 'git push origin');
		assert.strictEqual(A.comandoDetto('Comando riservato'), 'un comando');
	});

	await test('daAvvisare: almeno 15 s, una fine vera, e non un Ctrl+C', () => {
		const fin = att({ status: 'finito' });
		assert.strictEqual(A.daAvvisare(fin, 14_999), false);
		assert.strictEqual(A.daAvvisare(fin, 15_000), true);
		assert.strictEqual(A.daAvvisare(att({ status: 'ti aspetta' }), 20_000), true);
		assert.strictEqual(A.daAvvisare(att({ status: 'sconosciuto' }), 20_000), false);
		assert.strictEqual(A.daAvvisare(att({ source: 'claude', status: 'finito' }), 20_000), false, 'Claude Code lo avvisa la mod');
		const term = { source: 'terminale', title: 'npm test' };
		assert.strictEqual(A.daAvvisare(att({ ...term, status: 'errore', evidence: 'VS Code: comando terminato con codice 1' }), 20_000), true);
		assert.strictEqual(A.daAvvisare(att({ ...term, status: 'errore', evidence: 'VS Code: comando terminato con codice 130' }), 20_000), false);
		assert.strictEqual(A.daAvvisare(att({ ...term, title: 'npm run dev', status: 'finito', evidence: 'codice 0' }), 20_000), false);
	});

	await test('frasi fisse: chi, progetto, stato; niente lineette', () => {
		assert.strictEqual(A.fraseRiserva(att({ status: 'finito' })), 'Codex ha finito su Peak.');
		assert.strictEqual(A.fraseRiserva(att({ status: 'ti aspetta', source: 'cline' })), 'Cline ti aspetta su Peak: guarda cosa ti chiede.');
		assert.strictEqual(A.fraseRiserva(att({ status: 'errore' })), "Codex si e' fermato con un errore su Peak.");
		assert.strictEqual(A.fraseRiserva(att({ source: 'terminale', title: 'swift test --parallel', status: 'errore', project: 'Cartella sconosciuta' })), "Il comando swift test e' fallito.");
		assert.strictEqual(A.fraseRiserva(att({ source: 'terminale', title: 'npm run build', status: 'finito' })), 'Il comando npm run build su Peak ha finito.');
	});

	await test('prompt: lo stato, l\'ultima risposta senza credenziali, il compito della mod', () => {
		const p = A.promptAvviso(att({ status: 'ti aspetta', summary: 'Fatto. La chiave e\' sk-abcdefghijklmnop1234, confermi il deploy?' }));
		assert.ok(p.includes("Codex si e' fermato e aspetta Andrea"));
		assert.ok(p.includes('[chiave]') && !p.includes('sk-abcdefghijklmnop1234'));
		assert.ok(p.includes('digli chiaro cosa gli serve'));
		assert.ok(!/[–—]/.test(p));
	});

	await test('perVoce: niente markdown e lineette, al piu\' quattro frasi', () => {
		assert.strictEqual(A.perVoce('**Codex** ha finito — tutto `ok`.\n- fatto'), 'Codex ha finito, tutto ok. fatto');
		assert.strictEqual(A.perVoce('Uno. Due. Tre. Quattro. Cinque. Sei?'), 'Uno. Due. Tre. Sei?');
	});

	await test('DeepSeek: chiamata giusta, testo per la voce; senza chiave o in errore null', async () => {
		let chiesto;
		const fetchFinto = async (url, o) => {
			chiesto = { url, body: JSON.parse(o.body), auth: o.headers.authorization };
			return { ok: true, json: async () => ({ choices: [{ message: { content: 'Codex ha finito — e ti chiede il **deploy**.' } }] }) };
		};
		assert.strictEqual(await A.pensaDeepseek('k', 'sis', 'pr', fetchFinto), 'Codex ha finito, e ti chiede il deploy.');
		assert.strictEqual(chiesto.body.model, 'deepseek-flash');
		assert.deepStrictEqual(chiesto.body.thinking, { type: 'disabled' });
		assert.strictEqual(chiesto.auth, 'Bearer k');
		assert.strictEqual(await A.pensaDeepseek(undefined, 's', 'p', fetchFinto), null);
		assert.strictEqual(await A.pensaDeepseek('k', 's', 'p', async () => ({ ok: false })), null);
		assert.strictEqual(await A.pensaDeepseek('k', 's', 'p', async () => { throw new Error('rete'); }), null);
	});

	await test('fraseAvviso: il comando non chiede al cervello, Codex si; cervello muto = frase fissa', async () => {
		let chiamate = 0;
		const pensa = async () => (chiamate++, 'Codex ha finito, ti chiede il deploy.');
		assert.strictEqual(await A.fraseAvviso(att({ source: 'terminale', title: 'npm test', status: 'finito' }), pensa), 'Il comando npm test su Peak ha finito.');
		assert.strictEqual(chiamate, 0);
		assert.strictEqual(await A.fraseAvviso(att({ status: 'finito', summary: 'fatto' }), pensa), 'Codex ha finito, ti chiede il deploy.');
		assert.strictEqual(await A.fraseAvviso(att({ status: 'finito', summary: 'fatto' }), async () => null), 'Codex ha finito su Peak.');
		assert.strictEqual(await A.fraseAvviso(att({ status: 'finito' }), pensa), 'Codex ha finito su Peak.', 'senza niente da riassumere');
	});

	// ---------- l'isola: cosa riceve ----------

	function isolaFinta(o = {}) {
		const chiamate = [];
		const deps = {
			manda: async (p, corpo) => {
				chiamate.push([p, corpo]);
				if (p === '/ping') return { ok: true, parla: false, ascolta: o.ascolta ? o.ascolta() : false };
				if (p === '/parla') return { ok: true, ...(o.inCoda ? { inCoda: true } : {}) };
				return { ok: true };
			},
			accendi: async () => undefined,
			avvisoAcceso: () => (o.acceso ? o.acceso() : true),
			occupata: () => (o.occupata ? o.occupata() : false),
			frase: async a => `frase di ${a.source}`,
			pausa: async () => undefined,
			log: () => undefined,
		};
		return { deps, chiamate, dette: () => chiamate.filter(c => c[0] === '/parla').map(c => c[1]), scritte: () => chiamate.filter(c => c[0] === '/stato').map(c => c[1]) };
	}
	let adesso = 1_000_000;
	const realNow = Date.now;
	Date.now = () => adesso;
	const zero = { codex: 0, cline: 0, terminale: 0 };
	async function giro(fin, durata, o) {
		const f = isolaFinta(o);
		const isola = new I.IsolaAttivita(f.deps, zero);
		try {
			isola.aggiorna([att({ status: 'in corso' })]);
			await pausa(5);
			adesso += durata;
			isola.aggiorna([att(fin)]);
			await pausa(20);
		} finally {
			isola.dispose();
		}
		return f;
	}

	await test('isola: con l\'avviso acceso la fine lunga si dice a voce, nella fila delle sessioni', async () => {
		const f = await giro({ status: 'finito', summary: 'fatto' }, 20_000);
		assert.deepStrictEqual(f.dette(), [{ sessione: I.SESSIONE_AVVISI, testo: 'frase di codex', final: true }]);
		assert.deepStrictEqual(f.scritte(), [{ stato: 'pensa', testo: 'Codex: sistema il login, Peak' }], 'la fine non si scrive anche');
	});

	await test('isola: avviso spento o lavoro breve, solo la riga scritta di sempre', async () => {
		let f = await giro({ status: 'finito' }, 20_000, { acceso: () => false });
		assert.deepStrictEqual(f.dette(), []);
		assert.deepStrictEqual(f.scritte().map(s => s.stato), ['pensa', 'pronto']);
		f = await giro({ status: 'finito' }, 5_000);
		assert.deepStrictEqual(f.dette(), []);
		assert.deepStrictEqual(f.scritte().map(s => s.stato), ['pensa', 'pronto']);
	});

	await test('isola: aspetta la chiacchierata e il microfono, poi parla', async () => {
		let n = 0;
		const f = await giro({ status: 'ti aspetta' }, 20_000, { occupata: () => n++ < 3, ascolta: () => n < 5 });
		assert.strictEqual(f.dette().length, 1, 'detta dopo l\'attesa');
		assert.ok(n >= 5);
	});

	await test('isola: occupata per sempre, dopo 5 minuti resta la riga scritta', async () => {
		const f = await giro({ status: 'finito' }, 20_000, { occupata: () => true });
		assert.deepStrictEqual(f.dette(), []);
		assert.deepStrictEqual(f.scritte().map(s => s.stato), ['pensa', 'pronto']);
	});

	Date.now = realNow;
	console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
