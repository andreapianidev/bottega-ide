// Synthetic conversations and fake network; never the real tailnet or private queue.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const esbuild = require('esbuild');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-continuity-'));
const moduleFile = path.join(root, 'continuita.cjs');
esbuild.buildSync({ entryPoints: [path.join(__dirname, '../src/continuita.ts')], outfile: moduleFile, platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent' });
const { ContinuitaMelissa } = require(moduleFile);
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture() {
 const home = fs.mkdtempSync(path.join(root, 'fixture-'));
 const secrets = path.join(home, 'bridge.env');
 fs.writeFileSync(secrets, 'SEGRETARIA_URL=https://synthetic.invalid\nSEGRETARIA_BRIDGE_TOKEN=fake-token\n');
 const state = { pointer: 'thread-one', offline: false, loseReply: false, rows: [], accepted: new Map(), calls: [] };
 const fetch = async (url, init) => {
  state.calls.push({ url, init });
  assert.equal(init.headers.Authorization, 'Bearer fake-token');
  if (state.offline) throw new Error('offline');
  if (url.endsWith('/mem/pointer')) return { ok: true, json: async () => ({ conversation_id: state.pointer }) };
  if (url.includes('/mem/recent?')) return { ok: true, json: async () => ({ messages: state.rows }) };
  const turn = JSON.parse(init.body);
  const old = state.accepted.get(turn.event_id);
  if (old) assert.deepEqual(turn, old, 'a retry must carry the same immutable turn and conversation');
  state.accepted.set(turn.event_id, turn);
  if (state.loseReply) { state.loseReply = false; throw new Error('reply lost after acceptance'); }
  return { ok: true, json: async () => ({ id: state.accepted.size }) };
 };
 const create = () => new ContinuitaMelissa({ home, secretsFile: secrets, fetch });
 return { home, state, create };
}

test('accepted turn with a lost response survives restart and is acquired once', async () => {
 const f = fixture();
 const first = f.create();
 const scope = await first.iniziaTurno();
 f.state.loseReply = true;
 first.scrivi('melissa', 'andrea', 'Testo sintetico', 'bottega', scope);
 await first.flush();
 assert.equal(first.pendingWrites, 1);
 const restarted = f.create();
 await restarted.flush();
 assert.equal(restarted.pendingWrites, 0);
 assert.equal(f.state.accepted.size, 1);
 const turn = [...f.state.accepted.values()][0];
 assert.equal(turn.conversation_id, 'thread-one');
 assert.equal(turn.speaker, 'andrea');
 assert.equal(turn.recipient, 'melissa');
});

test('an exchange stays in its captured conversation when another app moves the pointer', async () => {
 const f = fixture(), bridge = f.create();
 const scope = await bridge.iniziaTurno();
 bridge.scrivi('krista', 'andrea', 'Domanda', 'bottega', scope);
 await bridge.flush();
 f.state.pointer = 'thread-two';
 await bridge.iniziaTurno();
 bridge.scrivi('krista', 'krista', 'Risposta', 'bottega', scope);
 await bridge.flush();
 assert.deepEqual([...f.state.accepted.values()].map(t => t.conversation_id), ['thread-one', 'thread-one']);
});

test('first-ever offline exchange resolves one durable scope for question and answer', async () => {
 const f = fixture();
 f.state.offline = true;
 const bridge = f.create(), scope = await bridge.iniziaTurno();
 assert.match(scope, /^pending:/);
 bridge.scrivi('elliot', 'andrea', 'Domanda offline', 'bottega', scope);
 bridge.scrivi('elliot', 'elliot', 'Risposta offline', 'bottega', scope);
 await bridge.flush();
 assert.equal(bridge.pendingWrites, 2);
 f.state.offline = false;
 const restarted = f.create();
 await restarted.flush();
 assert.equal(f.state.accepted.size, 2);
 assert.deepEqual([...f.state.accepted.values()].map(t => t.conversation_id), ['thread-one', 'thread-one']);
});

test('independent IDE windows cannot overwrite each other pending messages', async () => {
 const f = fixture();
 f.state.offline = true;
 const a = f.create(), b = f.create();
 a.scrivi('melissa', 'andrea', 'Finestra uno', 'bottega', 'thread-one');
 b.scrivi('krista', 'andrea', 'Finestra due', 'bottega', 'thread-one');
 await Promise.all([a.flush(), b.flush()]);
 const restarted = f.create();
 assert.equal(restarted.pendingWrites, 2);
 f.state.offline = false;
 await restarted.flush();
 assert.equal(f.state.accepted.size, 2);
});

test('identical text remains two distinct events; guest interventions retain their speaker', async () => {
 const f = fixture(), bridge = f.create();
 const scope = await bridge.iniziaTurno();
 bridge.scrivi('melissa', 'andrea', 'Ripeto', 'bottega', scope);
 bridge.scrivi('melissa', 'andrea', 'Ripeto', 'bottega', scope);
 bridge.scrivi('melissa', 'elliot', 'Intervento di Elliot', 'bottega', scope);
 await bridge.flush();
 const rows = [...f.state.accepted.values()];
 assert.equal(rows.length, 3);
 assert.equal(rows[2].speaker, 'elliot');
 assert.equal(rows[2].persona, 'melissa');
 assert.equal(rows[2].recipient, undefined, 'unknown recipient must not be invented');
});

test('memory preserves provenance and excludes another character even with an older server', () => {
 const block = ContinuitaMelissa.blocco([
  { role: 'assistant', content: 'Storico incerto', source: 'legacy' },
  { role: 'assistant', content: 'Solo Krista', persona: 'krista', speaker: 'krista' },
  { role: 'assistant', content: 'Intervento', persona: 'melissa', speaker: 'elliot', source: 'bottega' },
 ], 'melissa');
 assert.match(block, /attribuzione incerta/);
 assert.match(block, /autore non registrato/);
 assert.match(block, /fonte legacy/);
 assert.match(block, /elliot/);
 assert.doesNotMatch(block, /Solo Krista/);
});

test('a failed new-conversation read never returns cached text from the previous thread', async () => {
 const f = fixture(), bridge = f.create();
 f.state.rows = [{ role: 'user', content: 'Vecchio contesto', persona: 'melissa', speaker: 'andrea' }];
 const oldScope = await bridge.iniziaTurno();
 assert.match(await bridge.leggi('melissa', oldScope), /Vecchio contesto/);
 f.state.pointer = 'thread-two';
 const newScope = await bridge.iniziaTurno();
 f.state.offline = true;
 assert.equal(await bridge.leggi('melissa', newScope), '');
});

test('no configuration is a quiet optional integration and corrupt state is preserved', async () => {
 const home = path.join(root, 'unconfigured');
 const bridge = new ContinuitaMelissa({ home, secretsFile: path.join(root, 'absent') });
 assert.equal(bridge.available, false);
 assert.equal(await bridge.leggi('melissa'), '');
 bridge.scrivi('melissa', 'andrea', 'Nessun invio');
 assert.equal(bridge.pendingWrites, 0);
 fs.mkdirSync(path.join(home, 'continuita'), { recursive: true });
 const file = path.join(home, 'continuita', 'state.json');
 fs.writeFileSync(file, 'invalid');
 assert.throws(() => new ContinuitaMelissa({ home, secretsFile: path.join(root, 'absent') }), /conservato/);
 assert.equal(fs.readFileSync(file, 'utf8'), 'invalid');
});
