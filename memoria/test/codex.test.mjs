import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-codex-memoria-'));
process.env.BOTTEGA_HOME = path.join(tmp, 'home');
const { Store } = await import('../lib/store.mjs');
const { importCodex } = await import('../lib/codex.mjs');
const now = Date.now();
const date = new Date(now).toISOString().slice(0, 10);
const dir = path.join(tmp, 'sessions', ...date.split('-'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `rollout-${date}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl`);
const store = new Store(path.join(tmp, 'test.db'));
const run = opts => importCodex({ store, root: path.join(tmp, 'sessions'), now, ...opts });
const line = (type, payload) => JSON.stringify({ timestamp: new Date(now).toISOString(), type, payload }) + '\n';
const meta = line('session_meta', { cwd: tmp });
const prompt = line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Context from my IDE setup:\n\n## My request:\nSistema il widget. TOKEN=segreto-finto-123456' }] });
const final = line('event_msg', { type: 'task_complete', last_agent_message: 'Widget corretto, verifica su dispositivo ancora da fare.' });
after(() => { store.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('importa richieste e risposte concluse, con date originali e redazione; ignora strumenti e contesto', () => {
 fs.writeFileSync(file, meta + prompt + line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>non importare</environment_context>' }] }) + line('response_item', { type: 'function_call_output', output: 'non importare' }) + final);
 assert.equal(run().imported, 2);
 const rows = store.recent();
 assert.equal(rows.length, 2);
 assert.ok(rows.every(r => r.createdAt === now && r.title.startsWith('Codex ·')));
 assert.ok(rows.some(r => r.text.includes('[nascosto]')));
 assert.ok(rows.every(r => !r.text.includes('segreto-finto') && !r.text.includes('Context from') && !r.text.includes('non importare')));
 assert.equal(run().imported, 0);
});

test('riga parziale, output enorme e budget limitato non bloccano gli aggiornamenti successivi', () => {
 const next = line('event_msg', { type: 'task_complete', last_agent_message: 'Seconda risposta.' });
 fs.appendFileSync(file, next.slice(0, -4));
 assert.equal(run().imported, 0);
 fs.appendFileSync(file, next.slice(-4));
 assert.equal(run().imported, 1);
 fs.appendFileSync(file, line('response_item', { type: 'function_call_output', output: 'x'.repeat(2 * 1024 * 1024) }) + line('event_msg', { type: 'task_complete', last_agent_message: 'Dopo output enorme.' }));
 let imported = 0;
 for (let i = 0; i < 8; i++) imported += run({ budget: 512 * 1024 }).imported;
 assert.equal(imported, 1);
 assert.equal(run().bytes, 0);
});

test('rotazione o riscrittura non duplica note già importate', () => {
 fs.unlinkSync(file);
 fs.writeFileSync(file, meta + prompt + final);
 assert.equal(run().imported, 0);
 assert.equal(store.recent().length, 4);
});

test('la CLI recent importa e legge il database nello stesso processo senza chiuderlo', () => {
 const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
 const env = { ...process.env, CODEX_HOME: tmp };
 for (let i = 0; i < 2; i++) {
  const results = JSON.parse(execFileSync(process.execPath, [cli, 'recent', '--json'], { env, encoding: 'utf8' }));
  assert.equal(results.length, 2);
 }
});
