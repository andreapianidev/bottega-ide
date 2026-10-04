#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const src = path.join(__dirname, '..', 'src', 'attivita-codex.ts');
const out = path.join(__dirname, 'test-out', 'attivita-codex.js');
esbuild.buildSync({ entryPoints: [src], outfile: out, format: 'cjs', platform: 'node', target: 'node20', logLevel: 'silent' });
const { parseCodexRollout, readCodexActivities } = require(out);

const now = Date.parse('2026-10-04T15:00:00Z');
const sid = '12345678-1234-1234-1234-123456789abc';
const filename = `rollout-2026-10-04T14-57-00-${sid}.jsonl`;
const row = (timestamp, type, payload) => JSON.stringify({ timestamp: new Date(timestamp).toISOString(), type, payload }) + '\n';
const meta = row(now - 180_000, 'session_meta', { id: sid, cwd: '/work/Bottega', timestamp: new Date(now - 180_000).toISOString() });
const start = row(now - 60_000, 'event_msg', { type: 'task_started' });
const prompt = row(now - 59_000, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Sistema la Home e lancia i test\nAltri dettagli' }] });
const command = row(now - 20_000, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', command: 'npm test -- --verbose', stdout: 'finto-dato-riservato' } });
const finish = row(now - 10_000, 'event_msg', { type: 'task_complete' });

const active = parseCodexRollout(meta, start + prompt + command, filename, now - 20_000, now);
assert.equal(active.key, `codex:${sid}`);
assert.equal(active.project, 'Bottega');
assert.equal(active.path, '/work/Bottega');
assert.equal(active.status, 'in corso');
assert.equal(active.title, 'Sistema la Home e lancia i test');
assert.deepEqual(active.steps, ['Ha eseguito npm']);
assert.ok(!JSON.stringify(active).includes('finto-dato-riservato'));

const finished = parseCodexRollout(meta, start + prompt + command + finish, filename, now - 10_000, now);
assert.equal(finished.status, 'finito');
const stale = parseCodexRollout(meta, row(now - 400_000, 'event_msg', { type: 'task_started' }), filename, now - 400_000, now);
assert.equal(stale.status, 'sconosciuto');
const aborted = parseCodexRollout(meta, start + row(now - 10_000, 'event_msg', { type: 'turn_aborted' }), filename, now - 10_000, now);
assert.equal(aborted.status, 'sconosciuto');

const ask = row(now - 10_000, 'response_item', { type: 'function_call', name: 'functions.request_user_input', call_id: 'q1' });
assert.equal(parseCodexRollout(meta, start + ask, filename, now, now).status, 'ti aspetta');
const answered = row(now, 'response_item', { type: 'function_call_output', call_id: 'q1', output: '{}' });
assert.equal(parseCodexRollout(meta, start + ask + answered, filename, now, now).status, 'in corso');
assert.equal(parseCodexRollout(meta, start + ask + finish, filename, now, now).status, 'finito');
const asyncAsk = row(now, 'response_item', { type: 'function_call', name: 'functions.request_user_input_async', call_id: 'q2' });
assert.equal(parseCodexRollout(meta, start + asyncAsk, filename, now, now).status, 'in corso');
const approval = row(now, 'event_msg', { type: 'exec_approval_request', call_id: 'cmd' });
assert.equal(parseCodexRollout(meta, start + approval, filename, now, now).status, 'ti aspetta');
assert.equal(parseCodexRollout(meta, start + approval + row(now, 'event_msg', { type: 'exec_command_begin', call_id: 'cmd' }), filename, now, now).status, 'in corso');

const secretPrompt = row(now - 59_000, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Usa il token abcdefgh12345678 per il test' }] });
const redacted = parseCodexRollout(meta, start + secretPrompt, filename, now - 20_000, now);
assert.equal(redacted.title, 'Sessione Codex');
assert.ok(!JSON.stringify(redacted).includes('abcdefgh12345678'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-codex-test-'));
try {
	const day = path.join(tmp, '2026', '10', '04');
	fs.mkdirSync(day, { recursive: true });
	const file = path.join(day, filename);
	fs.writeFileSync(file, meta + 'x'.repeat(500_000) + '\n' + start + prompt + command + finish);
	fs.utimesSync(file, new Date(now - 10_000), new Date(now - 10_000));
	const activities = readCodexActivities(tmp, now);
	assert.equal(activities.length, 1);
	assert.equal(activities[0].status, 'finito');
	assert.equal(activities[0].project, 'Bottega');
	assert.ok(!JSON.stringify(activities).includes('finto-dato-riservato'));
	// Un turno vivo con molto output dopo task_started deve ancora risultare in corso.
	fs.writeFileSync(file, meta + prompt + start + 'x'.repeat(1_400_000) + '\n' + command);
	fs.utimesSync(file, new Date(now - 20_000), new Date(now - 20_000));
	assert.equal(readCodexActivities(tmp, now)[0].status, 'in corso');
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('  ok  sessioni Codex: stato, coda limitata e testi privati');
