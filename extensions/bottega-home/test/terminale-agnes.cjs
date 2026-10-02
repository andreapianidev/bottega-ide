#!/usr/bin/env node
// Banco di prova di Agnes nel terminale (src/terminale-agnes.ts e shell/*.zsh): le regole su cosa si esegue da solo
// (paletti, consentiti, tre modi), la lettura della risposta, il socket con un cervello finto in una cartella
// temporanea, la fila dei cervelli, i file di zsh (sintassi, ordine di caricamento con e senza la shell integration di
// VS Code, mai i file veri di Andrea), il riconoscimento comando o frase (tabella di righe vere) e il widget dentro un
// terminale vero (pty con python3). Nessuna chiamata ad Agnes: con BOTTEGA_TEST_REALE=1 al massimo UNA richiesta vera.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
const SHELL = path.join(__dirname, '..', 'shell');
const OUT = path.join(__dirname, 'test-out', 'terminale-agnes');
esbuild.buildSync({ entryPoints: ['terminale-agnes', 'cervello', 'cervelli'].map(n => path.join(SRC, n + '.ts')), outdir: OUT, format: 'cjs', platform: 'node', bundle: false, target: 'node20', logLevel: 'silent' });
const A = require(path.join(OUT, 'terminale-agnes.js'));

// percorso corto: un socket unix sta in 104 caratteri
const TMP = fs.mkdtempSync(path.join('/tmp', 'bta-'));
const ZSH = '/bin/zsh';
const PY = '/usr/bin/python3';

let passed = 0, failed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log('  ok  ' + name);
	} catch (e) {
		failed++;
		console.log('FAIL  ' + name + '\n      ' + String((e && e.stack) || e).split('\n').slice(0, 6).join('\n      '));
	}
}
const attendi = ms => new Promise(r => setTimeout(r, ms));
const casa = path.join(TMP, 'casa');
const progetto = path.join(casa, 'prototipi', 'Esempio');
fs.mkdirSync(progetto, { recursive: true });
const D = (cmd, modo = 'chiedi', consentiti = []) => A.decidi(cmd, { modo, consentiti, cartella: progetto, home: casa });

/** Un terminale vero: python3 apre un pty, scrive i tasti nei tempi dati, torna tutto quello che zsh ha scritto. */
const GUIDA = `
import json, os, pty, select, sys, time
passi = json.loads(sys.argv[1])
argv = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
out = b''
inizio = time.time()
fine = (passi[-1][0] if passi else 0) / 1000 + 1.2
i = 0
while time.time() - inizio < fine:
    t = (time.time() - inizio) * 1000
    while i < len(passi) and passi[i][0] <= t:
        os.write(fd, passi[i][1].encode())
        i += 1
    r, _, _ = select.select([fd], [], [], 0.02)
    if r:
        try:
            d = os.read(fd, 65536)
        except OSError:
            break
        if not d:
            break
        out += d
try:
    os.kill(pid, 9)
except Exception:
    pass
sys.stdout.write(out.decode('utf8', 'replace'))
`;
fs.writeFileSync(path.join(TMP, 'guida.py'), GUIDA);
const pulisci = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
function terminale(passi, env) {
	return new Promise(ok => {
		const p = spawn(PY, [path.join(TMP, 'guida.py'), JSON.stringify(passi), ZSH, '-i', '-l'], { env, cwd: progetto });
		let out = '';
		p.stdout.on('data', d => (out += d));
		p.on('close', () => ok(pulisci(out)));
	});
}

(async () => {
	// ---------- le regole ----------

	await test('la riga divisa in parti: virgolette, catene, pipe, redirezioni', () => {
		const d = A.dividi(`git add -A && git commit -m "fix; non dividere && qui" | tee log.txt 2>/dev/null; echo 'a|b'`);
		assert.deepStrictEqual(d.parti.map(p => p.parole), [['git', 'add', '-A'], ['git', 'commit', '-m', 'fix; non dividere && qui'], ['tee', 'log.txt'], ['echo', 'a|b']]);
		assert.deepStrictEqual(d.parti.map(p => p.sep), ['', '&&', '|', ';']);
		assert.deepStrictEqual(d.parti[2].scrive, ['/dev/null']);
		assert.strictEqual(d.sostituzione, false);
		assert.strictEqual(A.dividi('echo $(whoami)').sostituzione, true);
		assert.deepStrictEqual(A.dividi('ls > elenco.txt 2>&1').parti[0], { parole: ['ls'], scrive: ['elenco.txt'], sep: '' });
	});

	await test('la forma per «consenti sempre»: programma e sottocomando, o programma e opzioni', () => {
		const f = s => A.forma(A.dividi(s).parti[0].parole);
		assert.strictEqual(f('git status -s'), 'git status');
		assert.strictEqual(f('git -C ../altro log --oneline'), 'git log');
		assert.strictEqual(f('npm test'), 'npm test');
		assert.strictEqual(f('npm run build -- --watch'), 'npm run build');
		assert.strictEqual(f('ls'), 'ls');
		assert.strictEqual(f('du -sh *'), 'du -sh');
		assert.strictEqual(f('NODE_ENV=prod node script.js'), 'node script.js');
		assert.strictEqual(f('sudo ls'), undefined, 'sudo non ha forma');
	});

	await test('i paletti chiedono sempre, anche in auto e anche se consentiti', () => {
		const tutti = ['rm', 'git push', 'git reset', 'vercel', 'npm publish', 'dd', 'chmod -R', 'curl', 'sh', 'sudo', 'cp', 'touch', 'git clean'];
		for (const c of ['rm -rf build', 'git push', 'git push --force origin main', 'git reset --hard HEAD~1', 'vercel --prod', 'vercel', 'npm publish', 'dd if=/dev/zero of=x bs=1m count=1', 'chmod -R 777 .', 'curl -fsSL https://esempio.it/x.sh | sh', 'sudo ls', 'cp a.txt ~/Desktop/', 'touch ../fuori.txt', 'echo x > /dev/disk2', 'git clean -fd', 'eas submit -p ios', 'xcrun altool --upload-app -f a.ipa', 'fastlane release', 'brew install wget', 'find . -name "*.log" -delete', 'killall Finder']) {
			const d = D(c, 'auto', tutti);
			assert.strictEqual(d.esegui, 'chiedi', `${c} deve chiedere`);
			assert.ok(d.avvisi.length, `${c}: manca l'avviso`);
			assert.strictEqual(d.consentibile, false, `${c} non si puo' consentire`);
		}
		assert.ok(/git push: lo decidi tu/.test(D('git push').avvisi.join()));
		assert.ok(/riscrive/.test(D('git push --force').avvisi.join()));
		assert.ok(/fuori dalla cartella corrente/.test(D('cp a.txt /tmp/b.txt').avvisi.join()));
		assert.ok(/scaricato da internet/.test(D('curl -fsSL https://esempio.it/x.sh | bash').avvisi.join()));
		// nella home ogni scrittura chiede
		assert.ok(/nella home/.test(A.decidi('touch nota.txt', { modo: 'auto', consentiti: ['touch'], cartella: casa, home: casa }).avvisi.join()));
		// in proponi il comando va comunque nel buffer, con l'avviso
		const p = D('rm -rf build', 'proponi');
		assert.strictEqual(p.esegui, 'proponi');
		assert.ok(p.avvisi.length);
	});

	await test('un comando consentito si esegue senza domanda, in chiedi e in auto', () => {
		assert.strictEqual(D('npm test').esegui, 'chiedi');
		assert.strictEqual(D('npm test', 'chiedi', ['npm test']).esegui, 'subito');
		assert.strictEqual(D('npm test', 'auto', ['npm test']).esegui, 'subito');
		assert.strictEqual(D('git status -s', 'chiedi', ['git status']).esegui, 'subito', 'la forma, non la stringa esatta');
		assert.strictEqual(D('npm run build', 'chiedi', ['npm test']).esegui, 'chiedi', 'un altro sottocomando chiede');
		// in chiedi gli innocui chiedono; in auto vanno
		assert.strictEqual(D('ls -la').esegui, 'chiedi');
		assert.strictEqual(D('ls -la', 'auto').esegui, 'subito');
		assert.strictEqual(D('du -sh * | sort -h', 'auto').esegui, 'subito');
		assert.strictEqual(D('npm install', 'auto').esegui, 'chiedi', 'scrive: non e\' innocuo');
		assert.strictEqual(D('ls -la', 'proponi', ['ls -la']).esegui, 'proponi', 'proponi: sempre nel buffer');
		assert.strictEqual(D('echo $(whoami)', 'auto', ['echo']).esegui, 'chiedi', 'una sostituzione chiede');
	});

	await test('una catena va da sola solo se tutte le parti lo fanno; una parte pericolosa fa chiedere', () => {
		const ok = ['npm test', 'git status'];
		assert.strictEqual(D('cd sotto && npm test', 'chiedi', ok).esegui, 'subito');
		assert.strictEqual(D('npm test && git status', 'chiedi', ok).esegui, 'subito');
		assert.strictEqual(D('npm test && npm run build', 'chiedi', ok).esegui, 'chiedi');
		const d = D('npm test && git push', 'auto', [...ok, 'git push']);
		assert.strictEqual(d.esegui, 'chiedi');
		assert.strictEqual(d.consentibile, false);
		assert.strictEqual(D('git status; rm -rf node_modules', 'auto', [...ok, 'rm -rf']).esegui, 'chiedi');
		// cd cambia la cartella delle parti dopo
		assert.ok(/fuori/.test(D('cd .. && touch x.txt', 'auto').avvisi.join()));
		assert.deepStrictEqual(D('npm test && git status -s').forme, ['npm test', 'git status']);
	});

	await test('la risposta del modello: comando pulito, spiegazioni a parte', () => {
		assert.deepStrictEqual(A.leggiProposta('```bash\n$ du -sh * | sort -h\n```'), { comando: 'du -sh * | sort -h', spiega: [] });
		assert.deepStrictEqual(A.leggiProposta('# manca il pacchetto\n# va installato\nnpm install'), { comando: 'npm install', spiega: ['manca il pacchetto', 'va installato'] });
		assert.deepStrictEqual(A.leggiProposta('<think>uhm</think>`ls -la`'), { comando: 'ls -la', spiega: [] });
		assert.strictEqual(A.leggiProposta('').comando, '');
	});

	await test('il protocollo: andata e ritorno, comando su piu\' righe', () => {
		const r = { esito: 'ok', esegui: 'chiedi', consentibile: false, avvisi: ['cancella file'], spiega: ['due\nrighe'], note: ['n'], comando: 'for f in *; do\n  echo $f\ndone' };
		const d = A.decodifica(A.codifica(r));
		assert.deepStrictEqual(d, { ...r, spiega: ['due righe'] });
		assert.deepStrictEqual(A.leggiRichiesta('tipo comando\ncomando a\x1eb\nrichiesta trova i file\n\nresto'), { tipo: 'comando', comando: 'a\nb', richiesta: 'trova i file' });
	});

	// ---------- il socket e i cervelli ----------

	const SOCK = path.join(TMP, 'terminale.sock');
	const CONS = path.join(TMP, 'consentiti.json');
	const fila = [];
	let risposte = {};
	let modo = 'chiedi';
	let tempo = 1_000_000;
	const pensa = async (c, sis, ute) => {
		fila.push({ c, sis, ute });
		const r = risposte[c];
		if (r instanceof Error) throw r;
		if (typeof r === 'function') return r(ute);
		if (r === undefined) throw new Error('rete giu\'');
		return r;
	};
	const sportello = A.apriSportello({
		percorso: SOCK,
		modo: () => modo,
		cervello: () => 'agnes',
		pensa,
		consentiti: CONS,
		home: casa,
		sistema: async () => 'macOS 27.0',
		git: async c => (c === progetto ? { ramo: 'main', stato: ' M a.ts' } : undefined),
		ora: () => tempo,
	});
	const chiedi = campi =>
		new Promise((ok, ko) => {
			const net = require('net');
			const s = net.connect(SOCK);
			let out = '';
			s.setEncoding('utf8');
			s.on('data', d => (out += d));
			s.on('end', () => ok(A.decodifica(out)));
			s.on('error', ko);
			s.write(Object.entries(campi).map(([k, v]) => `${k} ${String(v).replace(/\n/g, '\x1e')}`).join('\n') + '\n\n');
		});
	for (let i = 0; i < 50 && !sportello.attivo; i++) await attendi(20);

	await test('il socket: 600, una proposta con contesto e decisione', async () => {
		assert.ok(sportello.attivo);
		assert.strictEqual(fs.statSync(SOCK).mode & 0o777, 0o600);
		risposte = { agnes: 'du -sh * | sort -h' };
		const r = await chiedi({ azione: 'proponi', tipo: 'comando', origine: 'auto', cartella: progetto, zsh: '5.9', richiesta: 'quanto pesa ogni cartella qui', ultimo: 'ls', codice: '0' });
		assert.strictEqual(r.esito, 'ok');
		assert.strictEqual(r.comando, 'du -sh * | sort -h');
		assert.strictEqual(r.esegui, 'chiedi');
		assert.strictEqual(r.consentibile, true);
		const u = fila[0].ute;
		assert.ok(u.includes('macOS 27.0') && u.includes('zsh 5.9') && u.includes(progetto) && u.includes('ramo main') && u.includes(' M a.ts'), u);
		assert.ok(!u.includes('Ultimo comando'), 'una richiesta nuova non porta l\'ultimo comando');
		assert.ok(/SOLO con il comando/.test(fila[0].sis) && /BSD/.test(fila[0].sis) && /sudo/.test(fila[0].sis));
	});

	await test('Agnes una richiesta ogni 3 secondi; da riserva si salta', async () => {
		fila.length = 0;
		tempo += 1000;
		const r = await chiedi({ azione: 'proponi', tipo: 'comando', cartella: progetto, richiesta: 'ancora' });
		assert.strictEqual(r.esito, 'aspetta');
		assert.ok(/aspetta un attimo/.test(r.errore));
		assert.strictEqual(fila.length, 0);
		// DeepSeek scelto al volo (#! deepseek): niente pausa, e se fallisce Agnes appena usata si salta, poi Apple
		risposte = { deepseek: new Error('senza credito'), apple: 'ls -la' };
		const d = await chiedi({ azione: 'proponi', tipo: 'comando', cervello: 'deepseek', cartella: progetto, richiesta: 'elenca' });
		assert.deepStrictEqual(fila.map(f => f.c), ['deepseek', 'apple']);
		assert.strictEqual(d.comando, 'ls -la');
		assert.deepStrictEqual(d.note, ['DeepSeek non risponde, ha risposto Apple Intelligence.']);
	});

	await test('la fila dei cervelli: Agnes, poi DeepSeek, poi Apple, con la riga grigia', async () => {
		fila.length = 0;
		tempo += 5000;
		risposte = { agnes: new Error('risposta 500'), deepseek: 'git status' };
		const r = await chiedi({ azione: 'proponi', tipo: 'comando', cartella: progetto, richiesta: 'stato' });
		assert.deepStrictEqual(fila.map(f => f.c), ['agnes', 'deepseek']);
		assert.deepStrictEqual(r.note, ['Agnes non risponde, ha risposto DeepSeek.']);
		fila.length = 0;
		tempo += 5000;
		risposte = {};
		const n = await chiedi({ azione: 'proponi', tipo: 'comando', cartella: progetto, richiesta: 'stato' });
		assert.strictEqual(n.esito, 'errore');
		assert.ok(/nessun cervello risponde: Agnes \(rete giu'\), DeepSeek/.test(n.errore), n.errore);
	});

	await test('?? spiega l\'ultimo errore con il codice d\'uscita', async () => {
		fila.length = 0;
		tempo += 5000;
		risposte = { agnes: '# manca la cartella node_modules\n# le dipendenze non sono installate\nnpm install' };
		const r = await chiedi({ azione: 'proponi', tipo: 'perche', cartella: progetto, richiesta: '', ultimo: 'npm test', codice: '127' });
		assert.deepStrictEqual(r.spiega, ['manca la cartella node_modules', 'le dipendenze non sono installate']);
		assert.strictEqual(r.comando, 'npm install');
		assert.ok(fila[0].ute.includes('Ultimo comando: npm test (codice d\'uscita 127)'));
		assert.ok(/due righe/.test(fila[0].sis));
		assert.strictEqual((await chiedi({ azione: 'proponi', tipo: 'perche', cartella: progetto })).esito, 'errore', 'senza ultimo comando');
	});

	await test('una richiesta alla volta', async () => {
		tempo += 5000;
		let libera;
		risposte = { agnes: () => new Promise(r => (libera = () => r('ls'))) };
		const prima = chiedi({ azione: 'proponi', tipo: 'comando', cartella: progetto, richiesta: 'uno' });
		await attendi(50);
		const seconda = await chiedi({ azione: 'proponi', tipo: 'comando', cervello: 'deepseek', cartella: progetto, richiesta: 'due' });
		assert.strictEqual(seconda.esito, 'aspetta');
		libera();
		assert.strictEqual((await prima).comando, 'ls');
	});

	await test('consenti: solo cio\' che si puo\', file 600; poi si esegue senza domanda', async () => {
		const r = await chiedi({ azione: 'consenti', cartella: progetto, comando: 'npm test && git status -s' });
		assert.strictEqual(r.esito, 'ok');
		assert.deepStrictEqual(A.leggiConsentiti(CONS), ['git status', 'npm test']);
		assert.strictEqual(fs.statSync(CONS).mode & 0o777, 0o600);
		const no = await chiedi({ azione: 'consenti', cartella: progetto, comando: 'git push' });
		assert.strictEqual(no.esito, 'errore');
		assert.ok(/non si puo' consentire/.test(no.errore));
		assert.deepStrictEqual(A.leggiConsentiti(CONS), ['git status', 'npm test']);
		tempo += 5000;
		risposte = { agnes: 'npm test' };
		assert.strictEqual((await chiedi({ azione: 'proponi', tipo: 'comando', cartella: progetto, richiesta: 'lancia i test' })).esegui, 'subito');
		tempo += 5000;
		modo = 'auto';
		risposte = { agnes: 'npm test && git push' };
		const p = await chiedi({ azione: 'proponi', tipo: 'comando', cartella: progetto, richiesta: 'test e push' });
		assert.strictEqual(p.esegui, 'chiedi');
		assert.ok(p.avvisi.some(a => /git push/.test(a)));
		modo = 'chiedi';
	});

	await test('il pensatore vero: Agnes senza ragionamento, Apple dal Nucleo', async () => {
		const chiesti = [];
		const cervelli = {
			streamFor: c => {
				chiesti.push(c);
				return async (msgs, tools, onDelta) => {
					assert.deepStrictEqual(tools, []);
					assert.deepStrictEqual(msgs.map(m => m.role), ['system', 'user']);
					onDelta({ content: 'ls ' });
					onDelta({ content: '-la' });
				};
			},
		};
		const eventi = {};
		const nucleo = {
			available: true,
			request: async (cmd, args) => (assert.strictEqual(cmd, 'ai.agent'), assert.deepStrictEqual(args.tools, []), { text: 'pwd' }),
			fireAndForget() {},
			on: (e, h) => (eventi[e] = h),
			off() {},
		};
		const p = A.pensatore({ cervelli, nucleo: () => nucleo, apple: () => true });
		const s = new AbortController().signal;
		assert.strictEqual(await p('agnes', 's', 'u', s), 'ls -la');
		assert.deepStrictEqual(chiesti[0], { provider: 'agnes', model: 'agnes-3.0-flash', effort: 'rapido' });
		await p('deepseek', 's', 'u', s);
		assert.strictEqual(chiesti[1].provider, 'deepseek');
		assert.strictEqual(await p('apple', 's', 'u', s), 'pwd');
		await assert.rejects(A.pensatore({ cervelli, nucleo: () => undefined, apple: () => false })('apple', 's', 'u', s));
		// la richiesta che arriva davvero ad Agnes (cervelli.ts): reasoning_effort none, niente strumenti
		const C = require(path.join(OUT, 'cervelli.js'));
		const body = C.requestBody({ provider: 'agnes', model: 'agnes-3.0-flash', effort: 'rapido' }, [], []);
		assert.strictEqual(body.reasoning_effort, 'none');
		assert.strictEqual(body.tools, undefined);
	});

	// ---------- i file di zsh ----------

	const ZD = path.join(TMP, 'zsh');
	await test('i file di zsh: sintassi, copia in una cartella 700 con file 600, solo se cambiano', () => {
		for (const f of Object.keys(A.FILE_ZSH)) {
			const r = spawnSync(ZSH, ['-n', path.join(SHELL, f)], { encoding: 'utf8' });
			assert.strictEqual(r.status, 0, `${f}: ${r.stderr}`);
		}
		const scritti = A.installaZsh(SHELL, ZD, 'agnes');
		assert.deepStrictEqual(scritti.sort(), ['.zlogin', '.zprofile', '.zshenv', '.zshrc', 'agnes.zsh', 'cervello']);
		assert.strictEqual(fs.statSync(ZD).mode & 0o777, 0o700);
		for (const f of scritti) assert.strictEqual(fs.statSync(path.join(ZD, f)).mode & 0o777, 0o600, f);
		assert.deepStrictEqual(A.installaZsh(SHELL, ZD, 'agnes'), []);
		assert.deepStrictEqual(A.installaZsh(SHELL, ZD, 'deepseek'), ['cervello']);
		assert.strictEqual(fs.readFileSync(path.join(ZD, 'cervello'), 'utf8'), 'DeepSeek\n');
		A.installaZsh(SHELL, ZD, 'agnes');
		for (const f of Object.keys(A.FILE_ZSH)) {
			const t = fs.readFileSync(path.join(SHELL, f), 'utf8');
			assert.ok(!/[\u2013\u2014]/.test(t), `${f}: lineette lunghe o medie`);
			assert.ok(!/sk-|AGNES_API_KEY|DEEPSEEK_API_KEY/.test(t), `${f}: niente chiavi`);
		}
		assert.strictEqual(A.comandoIterm(ZD, '/bin/zsh'), `/usr/bin/env ZDOTDIR=${ZD} /bin/zsh -l`);
		assert.strictEqual(A.comandoIterm('/tmp/con spazi', '/bin/zsh'), undefined);
		assert.strictEqual(A.comandoIterm(ZD, '/opt/homebrew/bin/fish'), undefined);
	});

	// una home finta: i file "di Andrea" scrivono l'ordine in cui vengono caricati
	const finta = path.join(TMP, 'home');
	fs.mkdirSync(finta);
	for (const f of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) fs.writeFileSync(path.join(finta, f), `print -r -- "${f} ZDOTDIR=$ZDOTDIR" >> $HOME/ordine\n${f === '.zshrc' ? "PS1='P> '\nexport DAL_ZSHRC=si\nzzprova() { print -r -- ZZ-FINTO $@ }\n" : ''}`);
	const envBase = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', HOME: finta, LANG: 'it_IT.UTF-8', TERM: 'xterm-256color', USER: os.userInfo().username, TMPDIR: TMP + '/' };
	const STATO = 'print -r -- "FINE ZDOTDIR=$ZDOTDIR HISTFILE=$HISTFILE DAL=$DAL_ZSHRC W=$widgets[accept-line] P=${precmd_functions[1]}"';

	await test('senza shell integration (iTerm2): i file veri nell\'ordine di sempre, poi Agnes, ZDOTDIR torna a casa', () => {
		fs.rmSync(path.join(finta, 'ordine'), { force: true });
		const r = spawnSync(ZSH, ['-i', '-l', '-c', STATO], { encoding: 'utf8', env: { ...envBase, ZDOTDIR: ZD }, cwd: finta });
		const ordine = fs.readFileSync(path.join(finta, 'ordine'), 'utf8').trim().split('\n');
		assert.deepStrictEqual(ordine, ['.zshenv', '.zprofile', '.zshrc', '.zlogin'].map(f => `${f} ZDOTDIR=${finta}`));
		const fine = r.stdout.split('\n').map(l => l.slice(Math.max(0, l.indexOf('FINE')))).find(l => l.startsWith('FINE')) ?? '';
		assert.strictEqual(fine, `FINE ZDOTDIR=${finta} HISTFILE=${finta}/.zsh_history DAL=si W=user:__bottega_accetta P=__bottega_precmd`, r.stdout + r.stderr);
	});

	await test('con la shell integration di VS Code: convivono, la storia resta a casa, VS Code carica i nostri file', () => {
		const script = ['/Applications/Bottega.app', '/Applications/Visual Studio Code.app']
			.map(a => path.join(a, 'Contents/Resources/app/out/vs/workbench/contrib/terminal/common/scripts'))
			.find(d => fs.existsSync(path.join(d, 'shellIntegration-rc.zsh')));
		if (!script) return console.log('      (script della shell integration di VS Code assenti, salto)');
		const vsc = path.join(TMP, 'vscode-zsh');
		fs.mkdirSync(vsc, { recursive: true });
		for (const [da, a] of [['rc', '.zshrc'], ['profile', '.zprofile'], ['env', '.zshenv'], ['login', '.zlogin']]) fs.copyFileSync(path.join(script, `shellIntegration-${da}.zsh`), path.join(vsc, a));
		fs.rmSync(path.join(finta, 'ordine'), { force: true });
		// come terminalEnvironment.ts: ZDOTDIR = la sua cartella, USER_ZDOTDIR = quella che il terminale aveva (la nostra)
		const env = { ...envBase, ZDOTDIR: vsc, USER_ZDOTDIR: ZD, VSCODE_INJECTION: '1', TERM_PROGRAM: 'vscode' };
		const r = spawnSync(ZSH, ['-i', '-l', '-c', STATO + '; print -r -- "VSC=${+functions[__vsc_precmd]} ULTIMO=${precmd_functions[-1]}"'], { encoding: 'utf8', env, cwd: finta });
		const ordine = fs.readFileSync(path.join(finta, 'ordine'), 'utf8').trim().split('\n');
		assert.deepStrictEqual(ordine.map(o => o.split(' ')[0]), ['.zshenv', '.zprofile', '.zshrc', '.zlogin'], r.stderr);
		assert.ok(ordine.every(o => o.endsWith(`ZDOTDIR=${finta}`)), ordine.join('\n'));
		const fine = r.stdout.split('\n').map(l => l.slice(Math.max(0, l.indexOf('FINE')))).find(l => l.startsWith('FINE')) ?? '';
		assert.ok(fine.includes(`HISTFILE=${finta}/.zsh_history`) && fine.includes('DAL=si') && fine.includes('W=user:__bottega_accetta') && fine.includes('P=__bottega_precmd'), r.stdout + r.stderr);
		assert.ok(/VSC=1 ULTIMO=__vsc_precmd/.test(r.stdout), 'la shell integration c\'e\', e il suo precmd viene dopo il nostro');
	});

	await test('una shell non interattiva (attivita\', script) legge solo .zshenv e torna subito a casa', () => {
		fs.rmSync(path.join(finta, 'ordine'), { force: true });
		const r = spawnSync(ZSH, ['-c', 'print -r -- "Z=$ZDOTDIR F=${+functions[__bottega_naturale]}"'], { encoding: 'utf8', env: { ...envBase, ZDOTDIR: ZD } });
		assert.strictEqual(r.stdout.trim(), `Z=${finta} F=0`);
		assert.deepStrictEqual(fs.readFileSync(path.join(finta, 'ordine'), 'utf8').trim().split('\n'), [`.zshenv ZDOTDIR=${finta}`]);
	});

	// ---------- comando o frase? ----------

	const CASI = [
		// comandi
		['git status', 'C'], ['ls -la', 'C'], ['cd ..', 'C'], ['npm run build', 'C'], ['for f in *.js; do echo $f; done', 'C'],
		['echo "ciao a tutti"', 'C'], ['VAR=1 node x.js', 'C'], ['', 'C'], ['   ', 'C'], ['ls', 'C'], ['pwd', 'C'],
		['git commit -m "fix: il login non va"', 'C'], ['./scripts/build.sh --package', 'C'], ['/usr/bin/true', 'C'],
		['~/bin/script.sh di con', 'C'], ['cat package.json | jq .version', 'C'], ['echo ciao a tutti quanti', 'C'],
		['grep -rn "TODO" src', 'C'], ['noglob git log --oneline', 'C'], ['FOO=bar', 'C'], ['ciao', 'C'], ['prova() { echo la mia prova; }', 'C'], ['x=(uno due tre)', 'C'],
		['make', 'C'], ['du -sh * | sort -h', 'C'], ['git log --since=ieri', 'C'], ['if true; then echo si; fi', 'C'],
		['cp a.txt b.txt', 'C'], ['ls src/la/cartella', 'C'], ['open .', 'C'], ['git checkout -b la-mia-prova', 'C'],
		['find . -name "*.ts"', 'C'], ['ls -la \\', 'C'], ['npm test && git status', 'C'],
		// frasi
		['trova i file più grandi qui', 'F'], ["trova i file piu' grandi di 100 MB qui", 'F'], ['git mi fai un commit con tutto', 'F'],
		['quanto spazio occupa questa cartella?', 'F'], ['apri il progetto in vscode', 'F'], ['ls tutti i file modificati oggi', 'F'],
		['find i file grossi', 'F'], ['comprimi questa cartella in zip', 'F'], ['dimmi su quale ramo sono', 'F'],
		['su quale ramo sono?', 'F'], ['elimina i file .DS_Store da tutte le sottocartelle', 'F'], ['mostrami i processi che usano più memoria', 'F'],
		['cancella node_modules e reinstalla', 'F'], ["perche' non parte il server?", 'F'], ['git annulla l\'ultimo commit per favore', 'F'],
		['file più grandi di questa cartella', 'F'], ['gti status', 'F'], ['converti tutte le immagini in webp', 'F'], ['quale porta usa il server?', 'F'],
	];

	await test(`comando o frase: ${CASI.length} righe vere`, () => {
		assert.ok(CASI.length >= 40);
		const script = `BOTTEGA_SOLO_RICONOSCIMENTO=1; source ${JSON.stringify(path.join(ZD, 'agnes.zsh'))}; for r in "$@"; do if __bottega_naturale "$r"; then print -r -- F; else print -r -- C; fi; done`;
		const r = spawnSync(ZSH, ['-f', '-c', script, 'zsh', ...CASI.map(c => c[0])], { encoding: 'utf8', env: { ...envBase, PATH: process.env.PATH } });
		const esiti = r.stdout.trim().split('\n');
		const sbagliati = CASI.filter((c, i) => esiti[i] !== c[1]).map(c => `«${c[0]}» doveva essere ${c[1] === 'F' ? 'frase' : 'comando'}`);
		assert.deepStrictEqual(sbagliati, [], r.stderr);
	});

	await test('il riconoscimento sta sotto il millisecondo (si fa a ogni tasto per l\'indizio)', () => {
		const script = `zmodload zsh/datetime; BOTTEGA_SOLO_RICONOSCIMENTO=1; source ${JSON.stringify(path.join(ZD, 'agnes.zsh'))}
			local -F t=$EPOCHREALTIME; local -i i
			for i in {1..300}; do __bottega_naturale "trova i file più grandi di 100 MB in questa cartella"; __bottega_naturale "git status --short"; __bottega_noti=(); done
			print $(( (EPOCHREALTIME - t) / 600 * 1000 ))`;
		const r = spawnSync(ZSH, ['-f', '-c', script], { encoding: 'utf8', env: { ...envBase, PATH: process.env.PATH } });
		const ms = Number(r.stdout.trim());
		assert.ok(ms > 0 && ms < 1, `${ms} ms a riga, senza cache dei comandi ${r.stderr}`);
		console.log(`      ${ms.toFixed(3)} ms a riga`);
	});

	// ---------- il widget in un terminale vero ----------

	const python = fs.existsSync(PY) && spawnSync(PY, ['-c', 'import pty']).status === 0;
	const envTerm = { ...envBase, ZDOTDIR: ZD, PATH: process.env.PATH };
	await test('nel terminale: frase, «Agnes pensa…», la domanda, n annulla, m modifica', async () => {
		if (!python) return console.log('      (python3 assente, salto)');
		modo = 'chiedi';
		tempo += 5000;
		risposte = { agnes: 'echo PROPOSTA-$((40+2))' };
		const out = await terminale([[700, 'trova i file più grandi qui\r'], [1600, 'n'], [1900, 'echo dopo\r']], envTerm);
		assert.ok(out.includes('Agnes pensa…'), out);
		assert.ok(/eseguo\? \[invio\] sì, \[n\]o, \[m\]odifica, \[esc\] la tua riga com'era/.test(out), out);
		assert.ok(out.includes('annullato'), out);
		assert.ok(!out.includes('PROPOSTA-42'), 'annullato: non eseguito');
		assert.ok(/\ndopo\n/.test(out), 'la shell continua normale');
		tempo += 5000;
		const mod = await terminale([[700, '# scrivi la proposta\r'], [1600, 'm'], [1900, ' FATTO\r']], envTerm);
		assert.ok(mod.includes('PROPOSTA-42 FATTO'), mod);
	});

	await test('nel terminale: invio esegue la proposta e la scrive nella storia, esc esegue la riga com\'era', async () => {
		if (!python) return console.log('      (python3 assente, salto)');
		tempo += 5000;
		risposte = { agnes: 'echo PROPOSTA-$((40+2))' };
		const out = await terminale([[700, 'stampa la risposta di prova qui\r'], [2200, '\r'], [2600, 'fc -ln -2\r']], envTerm);
		assert.ok(/\nPROPOSTA-42\n/.test(out), out);
		assert.ok(out.includes('stampa la risposta di prova qui') && /echo PROPOSTA-\$\(\(40\+2\)\)\n/.test(out), 'richiesta e comando nella storia');
		tempo += 5000;
		const esc = await terminale([[700, 'stampa la risposta di prova qui\r'], [1700, '\x1b'], [2600, 'echo dopo\r']], envTerm);
		assert.ok(/command not found: stampa/.test(esc), esc);
		assert.ok(!/non e' un comando: lo chiedo/.test(esc), 'eseguita com\'era: non torna ad Agnes');
	});

	await test('nel terminale: consentito si esegue senza domanda; in auto un paletto chiede in ambra', async () => {
		if (!python) return console.log('      (python3 assente, salto)');
		tempo += 5000;
		// un programma finto (funzione nel .zshrc finto), consentito a mano
		A.scriviConsentiti(CONS, [...A.leggiConsentiti(CONS), 'zzprova']);
		risposte = { agnes: 'zzprova test' };
		const env = envTerm;
		const out = await terminale([[700, 'lancia i test del progetto\r']], env);
		assert.ok(out.includes("eseguo, e' tra i consentiti") && out.includes('ZZ-FINTO test'), out);
		assert.ok(!out.includes('eseguo? '), 'nessuna domanda');
		modo = 'auto';
		tempo += 5000;
		risposte = { agnes: 'rm -rf build' };
		const p = await terminale([[700, 'butta via la cartella build\r'], [1600, 'n']], env);
		assert.ok(p.includes('attenzione: cancella file e cartelle senza chiedere') && p.includes('eseguo? [invio] sì, [n]o'), p);
		assert.ok(!p.includes('[s]empre'), 'un paletto non si consente');
		modo = 'chiedi';
	});

	await test('nel terminale: doppio invio veloce esegue la riga com\'era; comando normale non passa da Agnes', async () => {
		if (!python) return console.log('      (python3 assente, salto)');
		tempo += 5000;
		fila.length = 0;
		risposte = { agnes: () => attendi(400).then(() => 'echo NON-QUESTO') };
		const out = await terminale([[700, 'stampa la risposta di prova qui\r\r'], [2200, 'echo normale\r']], envTerm);
		assert.ok(/doppio invio/.test(out) && /command not found: stampa/.test(out), out);
		assert.ok(!out.includes('NON-QUESTO\n'), out);
		assert.strictEqual(fila.length, 1, 'echo normale non chiede niente ad Agnes');
	});

	await test('nel terminale: command not found con una frase la passa ad Agnes; senza socket «la Bottega e\' chiusa»', async () => {
		if (!python) return console.log('      (python3 assente, salto)');
		tempo += 5000;
		fila.length = 0;
		risposte = { agnes: 'echo DAL-GESTORE' };
		// il socket compare dopo il prompt (la Bottega si apre adesso): il riconoscimento non e' acceso, la riga va a zsh,
		// zsh non trova il comando e il gestore la passa ad Agnes; al prompt dopo parte la domanda
		const tardi = path.join(TMP, 'tardi.sock');
		setTimeout(() => fs.symlinkSync(SOCK, tardi), 500);
		const out = await terminale([[900, 'zzfrase fammi qualcosa\r'], [2200, '\r']], { ...envTerm, BOTTEGA_TERMINALE_SOCK: tardi });
		assert.ok(/zzfrase non e' un comando: lo chiedo a Agnes/.test(out), out);
		assert.strictEqual(fila.length, 1);
		assert.ok(fila[0].ute.includes('Richiesta: zzfrase fammi qualcosa'));
		assert.ok(/\nDAL-GESTORE\n/.test(out), out);
		const senza = await terminale([[700, '# trova i file\r'], [1200, 'echo dopo\r']], { ...envTerm, BOTTEGA_TERMINALE_SOCK: path.join(TMP, 'nessuno.sock') });
		assert.ok(/la Bottega e' chiusa/.test(senza), senza);
	});

	fs.rmSync(path.join(TMP, 'tardi.sock'), { force: true });
	await sportello.chiudi();
	await test('chiuso lo sportello il socket non c\'e\' piu\'', () => assert.ok(!fs.existsSync(SOCK)));

	// ---------- il collegamento a VS Code (src/terminale-host.ts) con un vscode finto ----------

	await test('VS Code: acceso scrive i file e mette ZDOTDIR; spento toglie tutto; iTerm2 usa lo stesso zsh', async () => {
		esbuild.buildSync({ entryPoints: ['terminale', 'terminale-host', 'cline'].map(n => path.join(SRC, n + '.ts')), outdir: OUT, format: 'cjs', platform: 'node', bundle: false, target: 'node20', logLevel: 'silent' });
		const Module = require('module');
		const nulla = () => ({ dispose() {} });
		const config = { 'bottega.terminale': { agnes: true, barra: false, cervello: 'agnes', agnesModo: 'chiedi' } };
		const ascolti = [];
		const comandi = {};
		const ambiente = new Map();
		const vscode = {
			Uri: { file: p => ({ fsPath: p, scheme: 'file' }) },
			ThemeIcon: class {},
			TabInputTerminal: class {},
			TerminalLocation: { Panel: 1 },
			ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
			env: { appRoot: TMP },
			window: {
				createOutputChannel: () => ({ info() {}, warn() {}, dispose() {} }),
				activeTerminal: undefined,
				terminals: [],
				activeColorTheme: { kind: 2 },
				tabGroups: { activeTabGroup: {}, all: [] },
				onDidChangeActiveTerminal: nulla,
				onDidCloseTerminal: nulla,
				onDidOpenTerminal: nulla,
				onDidChangeActiveColorTheme: nulla,
			},
			workspace: {
				workspaceFolders: [],
				getConfiguration: sez => ({ get: (k, d) => (config[sez] && k in config[sez] ? config[sez][k] : d) }),
				onDidChangeConfiguration: f => (ascolti.push(f), nulla()),
			},
			extensions: { getExtension: () => undefined, onDidChange: nulla },
			commands: { registerCommand: (id, f) => ((comandi[id] = f), nulla()), executeCommand: async () => undefined },
		};
		const orig = Module._load;
		Module._load = function (r) {
			return r === 'vscode' ? vscode : orig.apply(this, arguments);
		};
		const H = require(path.join(OUT, 'terminale-host.js'));
		Module._load = orig;
		const bottega = path.join(TMP, 'b');
		const profilo = path.join(TMP, 'iterm', 'bottega.json');
		fs.mkdirSync(path.join(TMP, 'iTerm.app'), { recursive: true });
		const ctx = {
			subscriptions: [],
			extensionPath: path.join(__dirname, '..'),
			globalStorageUri: { fsPath: path.join(TMP, 'gs', 'x') },
			globalState: { get: () => undefined, update: async () => undefined },
			environmentVariableCollection: { replace: (k, v) => ambiente.set(k, v), delete: k => ambiente.delete(k), persistent: true, description: '' },
		};
		H.registerTerminale(ctx, {
			cartellaLavoro: () => undefined,
			bottega,
			iterm: path.join(TMP, 'iTerm.app'),
			profilo,
			agnes: { cervelli: { streamFor: () => async () => undefined }, nucleo: () => undefined, apple: () => false },
		});
		const zd = path.join(bottega, 'zsh');
		assert.strictEqual(ambiente.get('ZDOTDIR'), zd);
		assert.strictEqual(ctx.environmentVariableCollection.persistent, false);
		assert.ok(fs.existsSync(path.join(zd, '.zshrc')) && fs.existsSync(path.join(zd, 'agnes.zsh')));
		const p = JSON.parse(fs.readFileSync(profilo, 'utf8')).Profiles[0];
		assert.strictEqual(p['Custom Command'], 'Yes');
		assert.ok(p.Command.startsWith(`/usr/bin/env ZDOTDIR=${zd} `) && p.Command.endsWith(' -l'), p.Command);
		for (let i = 0; i < 50 && !fs.existsSync(path.join(bottega, 'terminale.sock')); i++) await attendi(20);
		assert.ok(fs.existsSync(path.join(bottega, 'terminale.sock')));
		assert.ok(typeof comandi['bottega.terminaleConsentiti'] === 'function');
		// spento
		config['bottega.terminale'].agnes = false;
		for (const f of ascolti) f({ affectsConfiguration: s => s === 'bottega.terminale.agnes' });
		await attendi(50);
		assert.strictEqual(ambiente.has('ZDOTDIR'), false);
		assert.ok(!fs.existsSync(path.join(bottega, 'terminale.sock')));
		assert.strictEqual(JSON.parse(fs.readFileSync(profilo, 'utf8')).Profiles[0]['Custom Command'], undefined);
		for (const d of ctx.subscriptions) d.dispose?.();
	});

	if (process.env.BOTTEGA_TEST_REALE === '1') {
		await test('UNA richiesta vera ad Agnes', async () => {
			const C = require(path.join(OUT, 'cervelli.js'));
			const memo = new Map();
			const cervelli = new C.Cervelli({ memento: { get: k => memo.get(k), update: (k, v) => void memo.set(k, v) }, cacheFile: path.join(TMP, 'c.json') });
			const p = A.pensatore({ cervelli, nucleo: () => undefined, apple: () => false });
			const t = Date.now();
			const testo = await p('agnes', A.promptSistema('comando'), A.promptUtente('trova i file piu\' grandi di 100 MB qui', { sistema: 'macOS 27', zsh: '5.9', cartella: '/tmp' }, 'comando'), AbortSignal.timeout(15000));
			const pr = A.leggiProposta(testo);
			console.log(`      ${Date.now() - t} ms: ${pr.comando}`);
			assert.ok(/find/.test(pr.comando));
		});
	}

	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
