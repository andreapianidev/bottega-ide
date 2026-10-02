#!/usr/bin/env node
// Banco di prova di Cline nella Bottega (src/cline.ts): server MCP tradotti, regola globale, barra di destra. Lo
// spostamento gira davvero, ma su un database finto in una cartella temporanea.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { execFileSync, spawn, spawnSync } = require('child_process');
const esbuild = require('esbuild');

const OUT = path.join(__dirname, 'test-out', 'cline');
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'cline.ts')], outdir: OUT, format: 'cjs', platform: 'node', bundle: false, target: 'node20', logLevel: 'silent' });
const cl = require(path.join(OUT, 'cline.js'));

let passed = 0, failed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log('  ok  ' + name);
	} catch (e) {
		failed++;
		console.log('FAIL  ' + name + '\n      ' + String((e && e.stack) || e).split('\n').slice(0, 4).join('\n      '));
	}
}

const claude = {
	mcpServers: {
		'bottega-memoria': { type: 'stdio', command: '/x/node', args: ['/x/mcp.mjs', '--y'], env: {} },
		admob: { command: 'node', args: ['a.js'], env: { ADMOB_CREDENTIALS_PATH: '/p' } },
		remoto: { type: 'http', url: 'https://esempio.test/mcp', headers: { A: 'b' } },
		vecchio: { type: 'sse', url: 'https://esempio.test/sse' },
		rotto: { type: 'stdio' },
	},
	projects: { '/p': { mcpServers: { diProgetto: { command: 'x' } } } },
};

(async () => {
	await test('traduce stdio, http e sse nella forma di Cline', () => {
		assert.deepStrictEqual(cl.traduciServer(claude.mcpServers.admob), { type: 'stdio', command: 'node', args: ['a.js'], env: { ADMOB_CREDENTIALS_PATH: '/p' } });
		assert.deepStrictEqual(cl.traduciServer(claude.mcpServers.remoto), { type: 'streamableHttp', url: 'https://esempio.test/mcp', headers: { A: 'b' } });
		assert.deepStrictEqual(cl.traduciServer(claude.mcpServers.vecchio), { type: 'sse', url: 'https://esempio.test/sse' });
		assert.strictEqual(cl.traduciServer(claude.mcpServers.rotto), undefined);
	});

	await test('porta i server utente, non quelli di progetto, senza strumenti approvati', () => {
		const r = cl.allineaServer(claude, { mcpServers: {} }, []);
		assert.deepStrictEqual(r.gestiti, ['admob', 'bottega-memoria', 'remoto', 'vecchio']);
		assert.ok(!('diProgetto' in r.settings.mcpServers));
		assert.deepStrictEqual(r.settings.mcpServers.admob.autoApprove, []);
		assert.strictEqual(r.settings.mcpServers.admob.disabled, false);
	});

	await test('tiene le scelte fatte in Cline e i server aggiunti a mano', () => {
		const prima = {
			altro: 1,
			mcpServers: {
				admob: { type: 'stdio', command: 'vecchio', disabled: true, autoApprove: ['report'], timeout: 120 },
				mio: { type: 'stdio', command: 'mio' },
				remoto: { type: 'stdio', command: 'scritto a mano' },
			},
		};
		const r = cl.allineaServer(claude, prima, ['admob']);
		assert.strictEqual(r.settings.altro, 1);
		assert.strictEqual(r.settings.mcpServers.admob.command, 'node');
		assert.strictEqual(r.settings.mcpServers.admob.disabled, true);
		assert.deepStrictEqual(r.settings.mcpServers.admob.autoApprove, ['report']);
		assert.strictEqual(r.settings.mcpServers.admob.timeout, 120);
		assert.deepStrictEqual(r.settings.mcpServers.mio, { type: 'stdio', command: 'mio' });
		assert.strictEqual(r.settings.mcpServers.remoto.command, 'scritto a mano', 'un server omonimo messo a mano non si tocca');
		assert.ok(!r.gestiti.includes('remoto'));
	});

	await test('un server tolto da Claude Code se ne va anche da Cline, solo se era della Bottega', () => {
		const prima = { mcpServers: { tolto: { type: 'stdio', command: 'a' }, mio: { type: 'stdio', command: 'b' } } };
		const r = cl.allineaServer({ mcpServers: {} }, prima, ['tolto']);
		assert.deepStrictEqual(Object.keys(r.settings.mcpServers), ['mio']);
		assert.deepStrictEqual(r.gestiti, []);
	});

	await test('la regola porta CLAUDE.md, la memoria e niente lineette lunghe', () => {
		const t = cl.regolaCline('# Regole\n\nNiente segreti nel repository.\n');
		assert.ok(t.includes('memoria_cerca') && t.includes('memoria_bacheca') && t.includes('memoria_ricorda'));
		assert.ok(t.includes('Niente segreti nel repository.'));
		assert.ok(!/[–—]/.test(cl.regolaCline('')), 'lineette lunghe o medie nel testo della Bottega');
		assert.ok(!cl.regolaCline('').includes('copia di ~/.claude/CLAUDE.md'), 'senza CLAUDE.md niente sezione vuota');
	});

	await test('Cline va in fondo alla barra di destra, una volta sola', () => {
		const pin = [
			{ id: 'workbench.panel.chat', pinned: true, visible: false, order: 1 },
			{ id: 'workbench.view.extension.melissaBarra', pinned: true, visible: false, order: 101 },
			{ id: 'workbench.view.extension.claude-sidebar-secondary', pinned: true, visible: false, order: 102 },
		];
		const r = cl.spostaInBarra(null, pin, cl.CLINE_CONTENITORE, 2);
		assert.deepStrictEqual(r.pinned.map(p => p.id).slice(-2), ['workbench.view.extension.claude-sidebar-secondary', cl.CLINE_CONTENITORE]);
		assert.strictEqual(r.pinned.at(-1).order, 103);
		assert.strictEqual(r.customizations.viewContainerLocations[cl.CLINE_CONTENITORE], 2);
		const di_nuovo = cl.spostaInBarra(r.customizations, r.pinned, cl.CLINE_CONTENITORE, 2);
		assert.strictEqual(di_nuovo.pinned.filter(p => p.id === cl.CLINE_CONTENITORE).length, 1);
	});

	await test('il programma aspetta la chiusura e scrive il database di VS Code', async () => {
		if (spawnSync('/usr/bin/sqlite3', ['-version']).status !== 0) return console.log('      (sqlite3 assente, salto)');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-cline-'));
		const db = path.join(dir, 'state.vscdb');
		execFileSync('/usr/bin/sqlite3', [db, "create table ItemTable (key text unique on conflict replace, value blob); insert into ItemTable values('workbench.auxiliarybar.pinnedPanels', '[{\"id\":\"a\",\"order\":101},{\"id\":\"b\",\"order\":102}]'); insert into ItemTable values('views.customizations', '{\"viewContainerLocations\":{\"x\":1},\"viewLocations\":{},\"viewContainerBadgeEnablementStates\":{}}');"]);
		const finta = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)']); // la «Bottega» che si chiude
		const fatto = path.join(dir, 'fatto');
		const p = spawn(process.execPath, ['-e', cl.programmaSpostamento()], {
			env: { ...process.env, BOTTEGA_PID: String(finta.pid), BOTTEGA_DB: db, BOTTEGA_FATTO: fatto, BOTTEGA_LOG: path.join(dir, 'log') },
		});
		assert.ok(!fs.existsSync(fatto), 'non deve scrivere a Bottega aperta');
		await new Promise(r => p.on('exit', r));
		assert.ok(fs.existsSync(fatto), fs.readFileSync(path.join(dir, 'log'), 'utf8'));
		const pin = JSON.parse(execFileSync('/usr/bin/sqlite3', [db, "select value from ItemTable where key='workbench.auxiliarybar.pinnedPanels'"], { encoding: 'utf8' }));
		assert.deepStrictEqual(pin.map(x => x.id), ['a', 'b', cl.CLINE_CONTENITORE]);
		const vc = JSON.parse(execFileSync('/usr/bin/sqlite3', [db, "select value from ItemTable where key='views.customizations'"], { encoding: 'utf8' }));
		assert.deepStrictEqual(vc.viewContainerLocations, { x: 1, [cl.CLINE_CONTENITORE]: 2 });
	});

	console.log(`\ncline: ${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
