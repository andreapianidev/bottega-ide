const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const esbuild = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../src/vedetta-nativa.ts'), 'utf8');
const compiled = esbuild.transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const target = { exports: {} };
new Function('module', 'exports', compiled)(target, target.exports);
const { datiVedetta, VedettaNativa } = target.exports;

async function run() {
	const projects = [{ path: '/p', name: 'Primo' }, { path: '/q', name: 'Secondo' }];
	let rules;
	let data = datiVedetta(projects, rules);
	assert.deepEqual(data.projects.map(p => p.livello), ['sconosciuto', 'sconosciuto']);

	class FakeNucleo extends EventEmitter {
		available = true;
		calls = [];
		async request(cmd, args) { this.calls.push([cmd, args]); return { ok: true }; }
		fireAndForget(cmd, args) { this.calls.push([cmd, args]); }
	}
	const nucleo = new FakeNucleo();
	let selected, refreshes = 0;
	const bridge = new VedettaNativa(nucleo, () => data, p => { selected = p; }, () => { refreshes++; });
	await bridge.show();
	assert.equal(nucleo.calls[0][0], 'vedetta.open');
	assert.equal(nucleo.calls[0][1].data.projects.length, 2);
	bridge.push();
	assert.equal(nucleo.calls.length, 1, 'unchanged data is not sent again');

	rules = {
		projects: { '/p': { path: '/p', livello: 'rosso', checkedAt: 10,
			hits: [{ id: 'build', livello: 'rosso', frase: 'Build', rimedio: 'Alzala' }] } },
		global: [], checkedAt: 10, running: false,
	};
	data = datiVedetta(projects, rules);
	assert.deepEqual(data.projects.map(p => p.livello), ['rosso', 'sconosciuto']);
	bridge.push();
	assert.equal(nucleo.calls[1][0], 'vedetta.data');
	assert.equal(nucleo.calls[1][1].data.projects[0].hits[0].frase, 'Build');

	nucleo.emit('vedetta.project', { path: '/p' });
	nucleo.emit('vedetta.refresh');
	assert.equal(selected, '/p');
	assert.equal(refreshes, 1);
	nucleo.emit('vedetta.closed');
	bridge.push(true);
	assert.equal(nucleo.calls.length, 2, 'closed window receives no updates');
	console.log('Vedetta nativa: dati sconosciuti, sincronizzazione e azioni PASS');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
