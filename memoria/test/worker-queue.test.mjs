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
const { drain, enqueue, classifyFailure, giveUpTransient, lockStale, QUEUE_MAX_TRIES, QUEUE_MAX_FAIL_MS, LOCK_STALE_MS } = await import('../lib/core.mjs');
const { RetryableGenerationError, RateLimited } = await import('../lib/engines.mjs');
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

test('classifyFailure: i passeggeri restano in coda, i definitivi no', () => {
    const conCodice = (code, cause) => Object.assign(new Error('x'), cause ? { cause: { code } } : { code });
    for (const e of [
        new RetryableGenerationError('DeepSeek non raggiungibile'),
        new RateLimited('aspetta'),
        Object.assign(new Error('fermato'), { name: 'AbortError' }),
        Object.assign(new Error('scaduto'), { name: 'TimeoutError' }),
        conCodice('ECONNRESET'),
        conCodice('ENOTFOUND', true),
        conCodice('UND_ERR_CONNECT_TIMEOUT', true),
        Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }),
        Object.assign(new Error('qualcosa'), { code: 'ERR_SQLITE_ERROR', errcode: 517 }),
        new Error('DeepSeek HTTP 503: occupato'),
        new Error('DeepSeek HTTP 429: piano'),
    ]) assert.equal(classifyFailure(e), 'transitorio', String(e.message));
    for (const e of [
        new Error('sessione 1234 non trovata'),
        new Error('DeepSeek HTTP 400: richiesta non valida'),
        new Error('DeepSeek HTTP 413: troppo lungo'),
        conCodice('ENOENT'),
        Object.assign(new Error('constraint'), { code: 'ERR_SQLITE_ERROR', errcode: 19 }),
        new TypeError('undefined is not a function'),
        undefined,
    ]) assert.equal(classifyFailure(e), 'definitivo', String(e?.message));
});

test('giveUpTransient: servono sia i tentativi sia l eta del primo fallimento', () => {
    const now = 10 * QUEUE_MAX_FAIL_MS;
    assert.equal(giveUpTransient({ tries: QUEUE_MAX_TRIES, firstFailAt: now - QUEUE_MAX_FAIL_MS }, now), true);
    assert.equal(giveUpTransient({ tries: QUEUE_MAX_TRIES - 1, firstFailAt: 0 }, now), false, 'tanti giorni ma pochi tentativi: Mac spento');
    assert.equal(giveUpTransient({ tries: 1000, firstFailAt: now - 60_000 }, now), false, 'tanti tentativi in poco tempo: rete giu');
    assert.equal(giveUpTransient({ tries: 1000, firstFailAt: null }, now), false);
    assert.equal(giveUpTransient({}, now), false);
});

test('fallimento passeggero: conta il tentativo e manda l elemento in fondo alla coda', async () => {
    const { store, id } = queued();
    const other = '00000000-0000-4000-8000-000000000002';
    store.run('INSERT INTO queue(sessionId, reason, at) VALUES (?, ?, ?)', other, 'fine', 2);
    store.run('UPDATE queue SET at = 1 WHERE sessionId = ?', id);
    globalThis.fetch = async () => { throw new TypeError('rete sintetica non disponibile'); };
    try {
        assert.deepEqual(await drain(store), { deferred: true });
        const row = store.get('SELECT * FROM queue WHERE sessionId = ?', id);
        assert.equal(row.tries, 1);
        assert.ok(row.firstFailAt > 0);
        assert.equal(store.get('SELECT sessionId FROM queue ORDER BY at ASC LIMIT 1').sessionId, other);
        assert.equal(store.session(id).attempts, 0);
    } finally { store.close(); }
});

test('fallimento passeggero oltre il limite: l elemento esce e il tentativo resta scritto', async () => {
    const { store, id } = queued();
    store.run('UPDATE queue SET tries = ?, firstFailAt = ? WHERE sessionId = ?', QUEUE_MAX_TRIES - 1, Date.now() - QUEUE_MAX_FAIL_MS - 1, id);
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'synthetic' });
    try {
        assert.deepEqual(await drain(store), { deferred: true });
        assert.equal(store.get('SELECT COUNT(*) AS n FROM queue').n, 0);
        assert.equal(store.session(id).attempts, 1);
        assert.match(store.session(id).lastError, /abbandonato dopo/);
    } finally { store.close(); }
});

test('lockStale: vale il battito, non l eta del lucchetto', () => {
    const now = 100 * LOCK_STALE_MS;
    const vivo = () => true;
    const morto = () => false;
    assert.equal(lockStale({ pid: 1, at: now - 60 * 60_000, beat: now - 60_000 }, now, vivo), false, 'lavoro lungo ma battito fresco');
    assert.equal(lockStale({ pid: 1, at: now - 60_000, beat: now - LOCK_STALE_MS - 1 }, now, vivo), true, 'battito fermo');
    assert.equal(lockStale({ pid: 1, at: now, beat: now }, now, morto), true, 'processo sparito');
    assert.equal(lockStale({ pid: 1, at: now - 10 * 60_000 }, now, vivo), false, 'lucchetto di una versione senza battito');
    assert.equal(lockStale({ pid: 1, at: now - 31 * 60_000 }, now, vivo), true);
    assert.equal(lockStale(null, now, vivo), true);
});
