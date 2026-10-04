import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-cline-memoria-'));
process.env.BOTTEGA_HOME = path.join(tmp, 'bottega');
process.env.CLINE_DATA_DIR = path.join(tmp, 'cline');
process.env.CODEX_HOME = path.join(tmp, 'codex');
const { Store } = await import('../lib/store.mjs');
const { importCline } = await import('../lib/cline.mjs');
const { ingest, board, sessionDetail, buildContext } = await import('../lib/core.mjs');
const { HOME_PROJECT } = await import('../lib/paths.mjs');
const now = Date.now();
const dir = path.join(process.env.CLINE_DATA_DIR, 'sessions', 'session-test');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'session-test.json'), JSON.stringify({ session_id: 'session-test', cwd: tmp, started_at: now }));
const file = path.join(dir, 'session-test.messages.json');
const messages = [
 { id: 'user1', role: 'user', ts: now - 1000, content: [{ type: 'text', text: '<task>Correggi il widget TOKEN=segreto-finto-123456</task><environment_details>contesto escluso</environment_details>' }, { type: 'tool_result', content: 'output escluso' }] },
 { id: 'assistant1', role: 'assistant', ts: now, content: [{ type: 'thinking', thinking: 'ragionamento escluso' }, { type: 'tool_use', name: 'attempt_completion', input: { result: 'Widget corretto.\nDa fare:\n- Prova sul telefono' } }] },
];
const write = () => fs.writeFileSync(file, JSON.stringify({ version: 1, messages }));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('Cline SDK: testi e completamenti, date originali, nessun tool result/thinking/contesto, redazione e deduplica', () => {
 write(); const store = new Store();
 assert.equal(importCline({ store }).imported, 2);
 assert.equal(importCline({ store }).imported, 0);
 const notes = store.recent(); assert.equal(notes.length, 2);
 assert.ok(notes.every(m => m.sessionId === 'cline:session-test'));
 assert.ok(!JSON.stringify(notes).includes('escluso'));
 assert.ok(!JSON.stringify(notes).includes('segreto-finto'));
 assert.equal(notes[0].createdAt, now);
 assert.equal(sessionDetail('cline:session-test', store).memories.length, 2);
 assert.ok(buildContext(HOME_PROJECT, store).includes('Widget corretto'));
 store.close();
});

test('riscritture, JSON parziale e messaggi aggiornati non perdono o duplicano note', () => {
 fs.writeFileSync(file, '{'); assert.equal(importCline().skipped, 1);
 messages[1].content[1].input.result = 'Widget corretto e verificato.'; write();
 assert.equal(importCline().imported, 0);
 const store = new Store(); assert.equal(store.recent().length, 2); assert.match(store.recent()[0].text, /verificato/); store.close();
});

test('Cline legacy acquisito anche senza indice storico; esclude comandi e dati parziali', () => {
 const legacy = path.join(tmp, 'legacy'); const dir = path.join(legacy, 'tasks', '123456'); fs.mkdirSync(dir, { recursive: true });
 fs.writeFileSync(path.join(dir, 'ui_messages.json'), JSON.stringify([
  { ts: now - 500, type: 'say', say: 'text', text: 'Richiesta legacy' },
  { ts: now, type: 'say', say: 'completion_result', text: 'Esito legacy' },
  { ts: now, type: 'say', say: 'command', text: 'non importare' },
  { ts: now, type: 'say', say: 'text', text: 'parziale', partial: true },
 ]));
 assert.equal(importCline({ legacyRoots: [legacy] }).imported, 2);
 assert.equal(importCline({ legacyRoots: [legacy] }).imported, 0);
});

test('eventi Melissa/Terminale sono idempotenti, cercabili e nella bacheca', () => {
 const spool = path.join(process.env.BOTTEGA_HOME, 'memoria', 'spool'); fs.mkdirSync(spool, { recursive: true });
 const event = { ev: 'external', source: 'terminale', sid: 'terminal-test', id: 'end', at: now, cwd: tmp, text: 'npm test\nComando completato', who: 'Esito' };
 fs.writeFileSync(path.join(spool, new Date(now).toISOString().slice(0,10) + '.jsonl'), [event, event, { ...event, source: 'melissa', sid: 'conversazione', id: 'reply', text: 'Risposta di Melissa' }].map(e => JSON.stringify(e)).join('\n') + '\n');
 const store = new Store(); ingest(store); ingest(store);
 assert.equal(store.all("SELECT * FROM memories WHERE origin='terminale'").length, 1);
 assert.ok(store.ftsSearch('Risposta Melissa').some(m => m.text === 'Risposta di Melissa'));
 assert.ok(board({ minuti: 10 }).some(e => e.kind === 'cline'));
 assert.ok(board({ minuti: 10 }).some(e => e.kind === 'terminale'));
 store.close();
});

test('CLI e MCP acquisiscono Cline senza aprire la plancia', () => {
 messages.push({ id: 'new', role: 'assistant', ts: now, content: [{ type: 'text', text: 'Risposta nuova importata dal servizio.' }] }); write();
 const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
 const result = JSON.parse(execFileSync(process.execPath, [cli, 'recent', '--json'], { encoding: 'utf8', env: process.env }));
 assert.ok(result.some(m => m.text.includes('importata dal servizio')));
 messages.push({ id: 'mcp', role: 'assistant', ts: now, content: [{ type: 'text', text: 'Acquisizione MCP riuscita.' }] }); write();
 const mcp = fileURLToPath(new URL('../mcp.mjs', import.meta.url));
 const output = execFileSync(process.execPath, [mcp], { encoding: 'utf8', env: process.env, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memoria_recenti', arguments: {} } }) + '\n' });
 assert.match(output, /Acquisizione MCP riuscita/);
});
