// Un core Cline per terminale: non azzera il task dell'estensione o di altre sessioni.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

function runtime(bin) {
	const root = path.dirname(path.dirname(fs.realpathSync(bin)));
	const sqlite = path.join(root, 'node_modules/better-sqlite3');
	const nvm = path.join(os.homedir(), '.nvm/versions/node');
	const dirs = [...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/opt/node@20/bin', '/opt/homebrew/opt/node@22/bin'];
	try { dirs.push(...fs.readdirSync(nvm).map(v => path.join(nvm, v, 'bin'))); } catch {}
	for (const dir of [...new Set(dirs.filter(Boolean))]) {
		const node = path.join(dir, 'node');
		if (!fs.existsSync(node)) continue;
		const probe = spawnSync(node, ['-e', 'new (require(process.argv[1]))(":memory:").close()', sqlite], { stdio: 'ignore', timeout: 5000 });
		if (probe.status === 0) {
			const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH || ''}` };
			delete env.ELECTRON_RUN_AS_NODE;
			return env;
		}
	}
	throw new Error('Cline richiede un Node compatibile con il suo database. Ripara l’installazione della CLI Cline.');
}

function indirizzo(output) {
	const address = output.match(/^\s*Address:\s*(127\.0\.0\.1:\d+)\s*$/m)?.[1];
	if (!address) throw new Error('Cline non ha restituito l’indirizzo della nuova sessione.');
	return address;
}

async function main(bin) {
	if (!bin) throw new Error('Comando Cline mancante.');
	const env = runtime(bin);
	let address, child;
	let cleaned = false;
	const cleanup = () => {
		if (cleaned || !address) return;
		cleaned = true;
		spawnSync(bin, ['instance', 'kill', address], { env, stdio: 'ignore', timeout: 10000 });
	};
	process.on('exit', cleanup);
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { child?.kill(signal); cleanup(); process.exit(0); });
	console.log('Preparo una sessione Cline indipendente…');
	const created = spawnSync(bin, ['instance', 'new'], { env, encoding: 'utf8', timeout: 45000 });
	if (created.status !== 0) throw new Error('Cline non riesce ad aprire una nuova istanza. Controlla i log di Cline.');
	address = indirizzo(created.stdout);
	child = spawn(bin, ['--address', address], { env, stdio: 'inherit' });
	child.on('error', () => { console.error('La sessione Cline non si avvia.'); process.exitCode = 1; cleanup(); });
	child.on('exit', code => { process.exitCode = code ?? 0; cleanup(); });
}

module.exports = { indirizzo };
if (require.main === module) main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
