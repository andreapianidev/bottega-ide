const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'test-out', 'fonti');
for (const name of ['continua', 'briefing', 'osservatorio', 'memoria-eventi', 'strumenti-stanze', 'stats', 'clienti', 'dimenticati']) esbuild.buildSync({ entryPoints: [path.join(root, 'src', name + '.ts')], outfile: path.join(out, name + '.cjs'), bundle: true, platform: 'node', external: ['vscode'], logLevel: 'silent' });
const { prepareContinuation, splitSummary } = require(path.join(out, 'continua.cjs'));
const { briefingPoints } = require(path.join(out, 'briefing.cjs'));
const { osservatorioConAttivita } = require(path.join(out, 'osservatorio.cjs'));
const { creaRegistroMemoria } = require(path.join(out, 'memoria-eventi.cjs'));
const { StatsEngine } = require(path.join(out, 'stats.cjs'));
const { buildReport } = require(path.join(out, 'clienti.cjs'));
const { findForgotten } = require(path.join(out, 'dimenticati.cjs'));
const { leggiStanza } = require(path.join(out, 'strumenti-stanze.cjs'));
(async () => {
 const now = Date.now();
 const activity = ['claude', 'codex', 'cline', 'terminale'].map((source, i) => ({ key: source + ':' + i, source, id: String(i), project: 'Faro' + i, path: '/test/Faro' + i, status: i % 2 ? 'in corso' : 'ti aspetta', updatedAt: now }));
 const facts = { jobs: [], activity, forgotten: [], projects: [], now };
 assert.match(briefingPoints(facts).find(p => p.kind === 'lavori').text, /2 lavori ti aspettano/);
 assert.ok(!briefingPoints({ ...facts, jobs: [{ status: 'ti aspetta', project: 'Vecchio' }], activity: [] }).some(p => p.kind === 'lavori'));
 const base = { computedAt: now, live: [{ project: 'Vecchio' }], periods: Object.fromEntries(['7','30','90'].map(k => [k, { days: Number(k), projects: [] }])) };
 const native = osservatorioConAttivita(base, [...activity, activity[0]]);
 assert.equal(native.live.length, 4); assert.equal(native.stats.periods['7'].projects.length, 4);
 assert.ok(native.stats.periods['7'].projects.every(p => p.observedOnly && p.you === 0));
 assert.equal(osservatorioConAttivita(base, []).live.length, 0);
 const records = [
  { kind: 'nota', title: 'Cline · Esito: aggiornamento', text: 'Corretto.\n## Da fare\n- Verifica sul Watch\n\n## Test\n- Superati', project: 'Faro', createdAt: now },
  { kind: 'riassunto', title: 'Vecchio', text: 'Da fare: attività superata', project: 'Faro', createdAt: now - 1000 },
 ];
 const memory = { recent: async (_p, opts) => records.filter(m => opts.kinds.includes(m.kind)), bacheca: async () => [] };
 const continuation = await prepareContinuation({ name: 'Faro', path: '/test/Faro' }, memory, now);
 assert.match(continuation.prompt, /Verifica sul Watch/); assert.ok(!continuation.prompt.includes('attività superata'));
 assert.deepEqual(splitSummary(records[0].text).todo, ['Verifica sul Watch']);
 const fonts = { progetto: () => ({ name: 'Faro', path: '/test/Faro' }), memoria: () => memory, ora: () => now };
 assert.match(await leggiStanza({ stanza: 'dafare', progetto: 'Faro' }, fonts), /Verifica sul Watch/);
 records[0].text = 'Tutto verificato.';
 const clean = await leggiStanza({ stanza: 'dafare', progetto: 'Faro' }, fonts);
 assert.ok(!clean.includes('attività superata')); assert.match(clean, /non è riportata/);
 const staleProject = { name: 'Faro2', path: '/test/Faro2', live: [], sessions: [], git: { changes: 1, upstream: true, lastCommitAt: now - 30 * 86400_000 } };
 assert.equal(findForgotten([staleProject], [], now).length, 1);
 assert.equal(findForgotten([staleProject], [], now, 14, activity).length, 0);
 const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-eventi-'));
 try {
  const clock = new Date(2026, 9, 4, 12).getTime();
  const date = new Date(clock).toISOString().slice(0, 10).split('-');
  const sessions = path.join(tmp, 'codex', ...date); fs.mkdirSync(sessions, { recursive: true });
  const project = { name: 'Faro', path: path.join(tmp, 'Faro'), worktrees: [{ path: path.join(tmp, 'Faro-ramo'), branch: 'ramo' }] };
  const line = (at, type, payload) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
  for (const [name, cwd] of [['main', project.path], ['branch', project.worktrees[0].path]]) fs.writeFileSync(path.join(sessions, `rollout-${name}.jsonl`), [
   line(clock - 600000, 'session_meta', { cwd }), line(clock - 600000, 'event_msg', { type: 'task_started' }), line(clock, 'event_msg', { type: 'task_complete' }),
  ].join('\n') + '\n');
  const engine = new StatsEngine({ projectsDir: path.join(tmp, 'claude-vuoto'), codexSessionsDir: path.join(tmp, 'codex') });
  const stats = await engine.compute({ projects: [project], live: [], now: clock });
  assert.equal(stats.today.you, 0); assert.equal(stats.workTime.today.minutes, 10);
  const clients = buildReport(engine.lastLedger, { rounding: 1, clients: [{ id: 'prova', nome: 'Cliente di prova', progetti: [project.path] }] }, [project], '2026-10', clock);
  assert.equal(clients.clients[0].raw, 10, 'due sessioni Codex simultanee nello stesso progetto contano una volta');
  const record = creaRegistroMemoria(tmp);
  await Promise.all(['melissa','terminale'].map(source => record({ source, sid: 'test', id: source, at: now, text: 'TOKEN=segreto-finto-123456', who: 'Esito' })));
  const file = path.join(tmp, fs.readdirSync(tmp).find(f => f.endsWith('.jsonl')));
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2); assert.ok(rows.every(r => r.ev === 'external' && !r.text.includes('segreto-finto')));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
 } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
 console.log('Fonti integrate: briefing, Osservatorio, continua, da fare, spool privato PASS');
})().catch(e => { console.error(e); process.exitCode = 1; });
