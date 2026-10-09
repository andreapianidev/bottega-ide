// Migrazione provider e riserva locale: rete e Nucleo finti, mai dati reali.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-provider-'));
process.env.BOTTEGA_HOME = path.join(tmp, 'bottega');
process.env.DEEPSEEK_API_KEY = 'fixture-deepseek';
process.env.AGNES_API_KEY = 'fixture-retired';
process.env.BOTTEGA_NUCLEO = path.join(tmp, 'nucleo');
fs.writeFileSync(process.env.BOTTEGA_NUCLEO, '#!/bin/sh\nif [ "$2" = "generate" ]; then echo "TITOLO: Prova locale\nRIASSUNTO: Riserva locale riuscita."; else echo "{}"; fi\n', { mode: 0o700 });
const { Store } = await import('../lib/store.mjs');
const { summarizeSession } = await import('../lib/core.mjs');
const { chosenEngine, agnesGenerate, agnesKey, appleGenerate, nucleoPath } = await import('../lib/engines.mjs');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; fs.rmSync(tmp, { recursive: true, force: true }); });

function session() {
    const store = new Store(path.join(tmp, `${Math.random()}.db`));
    const id = '00000000-0000-4000-8000-000000000001';
    store.upsertSession({ id, cwd: tmp, at: Date.now() });
    store.run('UPDATE sessions SET prompts = 1, obsCount = 1 WHERE id = ?', id);
    store.run('INSERT INTO observations(sessionId, at, kind, input) VALUES (?, ?, ?, ?)', id, Date.now(), 'prompt', 'Verifica del progetto e delle decisioni documentate. '.repeat(20));
    return { store, id };
}

test('preferenza legacy migra a DeepSeek; Apple esplicito resta locale', () => {
    const { store } = session();
    try {
        store.meta('motore_riassunti', 'agnes');
        assert.equal(chosenEngine(store), 'deepseek');
        store.meta('motore_riassunti', 'apple');
        assert.equal(chosenEngine(store), 'apple');
        assert.equal(agnesKey(), undefined);
    } finally { store.close(); }
});

test('il riassunto legacy usa chiave e modello DeepSeek', async () => {
    const { store, id } = session();
    store.meta('motore_riassunti', 'agnes');
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'TITOLO: Prova\nRIASSUNTO: Riassunto verificato.' } }] }) };
    };
    try {
        const result = await summarizeSession(id, { store });
        assert.equal(result.engine, 'deepseek');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
        assert.equal(JSON.parse(calls[0].init.body).model, 'deepseek-flash');
        assert.equal(calls[0].init.headers.authorization, 'Bearer fixture-deepseek');
    } finally { store.close(); }
});

test('il Nucleo finto genera testo', () => { assert.equal(nucleoPath(), process.env.BOTTEGA_NUCLEO); assert.match(appleGenerate('fixture', 'fixture') ?? '', /Riserva locale/); });

test('402 passa al Nucleo e non invia mai credenziali ad Agnes', async () => {
    const { store, id } = session();
    const calls = [];
    globalThis.fetch = async url => { calls.push(url); return { ok: false, status: 402 }; };
    try {
        const result = await summarizeSession(id, { store });
        assert.equal(result.engine, 'apple');
        assert.deepEqual(calls, ['https://api.deepseek.com/chat/completions']);
        assert.ok(Number(store.meta('deepseek_blocked_until')) > Date.now());
        await assert.rejects(() => agnesGenerate(), /ritirato/);
    } finally { store.close(); }
});

test('Apple esplicito non chiama rete; flag Agnes rifiutato', async () => {
    const { store, id } = session();
    store.meta('motore_riassunti', 'apple');
    globalThis.fetch = async () => { throw new Error('rete vietata'); };
    try {
        assert.equal((await summarizeSession(id, { store })).engine, 'apple');
        await assert.rejects(() => summarizeSession(id, { store, soloAgnes: true }), /ritirato/);
    } finally { store.close(); }
});
