#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const out = path.join(__dirname, 'test-out', 'attivita-cline');
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'attivita-cline.ts')], outdir: out, format: 'cjs', platform: 'node', bundle: false, target: 'node20', logLevel: 'silent' });
const { readClineActivities } = require(path.join(out, 'attivita-cline.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-activity-cline-'));
const now = Date.parse('2026-10-04T15:00:00Z');
const dataDir = path.join(tmp, 'data');
const legacy = path.join(tmp, 'legacy');

function write(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data));
}
function sdk(id, status, pid, prompt, messages) {
	const dir = path.join(dataDir, 'sessions', id);
	write(path.join(dir, `${id}.json`), {
		session_id: id, source: 'vscode', pid, status, prompt,
		cwd: '/tmp/Progetto', workspace_root: '/tmp/Progetto',
		started_at: '2026-10-04T14:00:00Z', ended_at: status === 'running' ? null : '2026-10-04T14:10:00Z',
	});
	write(path.join(dir, `${id}.messages.json`), { version: 1, updated_at: '2026-10-04T14:11:00Z', messages });
}

(async () => {
	try {
		sdk('sdk_running', 'running', process.pid, 'Controlla build', [
			{ role: 'assistant', content: [{ type: 'thinking', thinking: 'privato' }, { type: 'tool_use', name: 'execute_command', input: { command: 'pwd' } }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'Build avviata' }] },
		]);
		sdk('sdk_dead', 'running', 99999999, 'Task interrotto', []);
		sdk('sdk_failed', 'failed', 99999999, 'Task fallito', [{ role: 'assistant', content: [{ type: 'text', text: 'Tentativo terminato' }] }]);
		write(path.join(legacy, 'tasks', 'taskHistory.json'), [
			{ id: 'legacy_done', ts: now - 1000, task: 'Correggi test', cwdOnTaskInitialization: '/tmp/Altro' },
			{ id: 'legacy_ask', ts: now - 2000, task: 'Serve risposta', cwdOnTaskInitialization: '/tmp/Altro' },
			{ id: 'sdk_failed', ts: now - 3000, task: 'Duplicato vecchio', cwdOnTaskInitialization: '/tmp/Altro' },
		]);
		write(path.join(legacy, 'tasks', 'legacy_done', 'ui_messages.json'), [
			{ type: 'say', say: 'api_req_started', text: 'Richiesta completa da non mostrare' },
			{ type: 'say', say: 'completion_result', text: 'Test corretti' },
		]);
		write(path.join(legacy, 'tasks', 'legacy_ask', 'ui_messages.json'), [{ type: 'ask', ask: 'tool', text: 'attendo' }]);
		const activities = await readClineActivities({ dataDir, legacyRoots: [legacy], now });
		assert.equal(activities.length, 5);
		const byId = Object.fromEntries(activities.map(a => [a.id, a]));
		assert.equal(byId.sdk_running.status, 'in corso');
		assert.equal(byId.sdk_dead.status, 'sconosciuto');
		assert.equal(byId.sdk_failed.status, 'errore');
		assert.equal(byId.sdk_failed.project, 'Progetto');
		assert.equal(byId.sdk_running.summary, 'Build avviata');
		assert.deepEqual(byId.sdk_running.steps, ['Strumento: execute_command', 'Build avviata']);
		assert.equal(byId.legacy_done.status, 'finito');
		assert.equal(byId.legacy_ask.status, 'sconosciuto');
		assert.ok(!JSON.stringify(activities).includes('Richiesta completa'));
		assert.ok(!JSON.stringify(activities).includes('privato'));
		assert.ok(byId.sdk_failed.evidence.startsWith('Cline SDK:'));
		console.log('attivita-cline: ok');
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
})().catch(e => { console.error(e); process.exitCode = 1; });
