// Retry durevole: SQLite temporaneo, provider finto, Nucleo non disponibile.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-queue-'));
process.env.BOTTEGA_HOME = path.join(tmp, 'bottega');
process.env.DEEPSEEK_API_KEY = 'fixture-deepseek';
process.env.BOTTEGA_NUCLEO = path.join(tmp, 'nucleo');
fs.writeFileSync(process.env.BOTTEGA_NUCLEO, '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const { Store } = await import('../lib/store.mjs');
const { drain, enqueue } = await import('../lib/core.mjs');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; fs.rmSync(tmp, { recursive: true, force: true }); });

function queued() {
    const store = new Store(path.join(tmp, `${Math.random()}.db`));
    const id = '00000000-0000-4000-8000-000000000001';
    store.upsertSession({ id, cwd: tmp, at: Date.now() });
    store.run('UPDATE sessions SET prompts = 1, obsCount = 1 WHERE id = ?', id);
    store.run('INSERT INTO observations(sessionId, at, kind, input) VALUES (?, ?, ?, ?)', id, Date.now(), 'prompt', 'Sessione sintetica da conservare nella coda anche senza collegamento. '.repeat(12));
    enqueue(store, id, 'fine');
    return { store, id };
}

for (const failure of ['network', 408, 429, 500, 503, 401, 402, 'invalid-json', 'empty']) {
    test(`errore recuperabile ${failure} conserva il lavoro, poi riesce senza duplicati`, async () => {
        const { store, id } = queued();
        let calls = 0;
        globalThis.fetch = async () => {
            calls++;
            if (failure === 'network') throw new TypeError('rete sintetica non disponibile');
            if (failure === 'invalid-json') return { ok: true, json: async () => { throw new SyntaxError('synthetic'); } };
            if (failure === 'empty') return { ok: true, json: async () => ({ choices: [] }) };
            return { ok: false, status: failure, text: async () => 'synthetic' };
        };
        try {
            assert.deepEqual(await drain(store), { deferred: true });
            assert.equal(calls, 1);
            assert.equal(store.get('SELECT COUNT(*) AS n FROM queue').n, 1);
            assert.equal(store.session(id).attempts, 0);
            assert.equal(store.session(id).summarizedAt, null);
            store.meta('deepseek_blocked_until', 0);
            globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'TITOLO: Recupero\nRIASSUNTO: Lavoro sintetico recuperato.' } }] }) });
            await drain(store);
            assert.equal(store.get('SELECT COUNT(*) AS n FROM queue').n, 0);
            assert.ok(store.session(id).summarizedAt);
            assert.equal(store.get("SELECT COUNT(*) AS n FROM memories WHERE kind = 'riassunto'").n, 1);
        } finally { store.close(); }
    });
}

test('richiesta permanente HTTP 400 termina con errore e non resta in retry infinito', async () => {
    const { store, id } = queued();
    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'synthetic invalid request' });
    try {
        await drain(store);
        assert.equal(store.get('SELECT COUNT(*) AS n FROM queue').n, 0);
        assert.equal(store.session(id).attempts, 1);
        assert.match(store.session(id).lastError, /HTTP 400/);
    } finally { store.close(); }
});
