#!/usr/bin/env node
// Real filesystem, synthetic payloads, fake clock; never reads ~/.bottega or uses network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const esbuild = require('esbuild');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-worker-test-'));
const compiled = path.join(root, 'worker.cjs');
esbuild.buildSync({ entryPoints: [path.join(__dirname, '../src/worker.ts')], outfile: compiled, platform: 'node', format: 'cjs', target: 'node20' });
const { WorkerQueue, WorkerError } = require(compiled);
after(() => fs.rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function fixture() {
	const home = path.join(root, 'case-' + (++sequence)); let now = 1000000;
	const options = { home, now: () => now };
	return { queue: new WorkerQueue(options), home, options, advance: ms => now += ms };
}
const capabilities = [
	{ operation: 'embeddings', implementation: 'apple-nl-it', revision: 1, dimension: 640 },
	{ operation: 'ocr', implementation: 'apple-vision', revision: 3 },
];
const phone = id => ({ id, capacity: 1, capabilities });
const submit = (id, origin = 'bottega') => ({ id, origin, operation: 'embeddings', input: { texts: ['Testo tecnico sintetico.'] } });
const vector = () => Array.from({ length: 640 }, (_, i) => i === 0 ? 0.25 : 0);
const completion = job => ({ jobId: job.id, leaseToken: job.leaseToken, attempt: job.attempt,
	result: { vectors: [vector()], implementation: 'apple-nl-it', revision: 1, dimension: 640 }, metrics: { cpuMs: 12, elapsedMs: 40 } });
const isError = (status, code) => error => error instanceof WorkerError && error.status === status && (!code || error.code === code);

test('immutable submissions survive restart, two origins share one phone lease', () => {
	const f = fixture(); const q = f.queue;
	q.enqueue(submit('memory-1')); q.enqueue(submit('avo-1', 'avo'));
	assert.equal(q.enqueue(submit('memory-1')).id, 'memory-1');
	assert.throws(() => q.enqueue({ ...submit('memory-1'), input: { texts: ['different'] } }), isError(409));
	const restarted = new WorkerQueue(f.options);
	assert.equal(restarted.status().counts.queued, 2);
	const first = q.claim({ worker: phone('iphone-1') }).job;
	assert.equal(first.id, 'memory-1'); assert.equal(first.attempt, 1);
	assert.equal(restarted.claim({ worker: phone('iphone-2') }).job, null);
	q.complete(completion(first));
	assert.equal(restarted.claim({ worker: phone('iphone-1') }).job.origin, 'avo');
});

test('expired leases reassign after restart; stale result cannot overwrite new work', () => {
	const f = fixture(); f.queue.enqueue(submit('expiry'));
	const old = f.queue.claim({ worker: phone('iphone') }).job;
	f.advance(120000);
	const restored = new WorkerQueue(f.options); const current = restored.claim({ worker: phone('iphone') }).job;
	assert.equal(current.id, old.id); assert.equal(current.attempt, 2); assert.notEqual(current.leaseToken, old.leaseToken);
	assert.throws(() => restored.complete(completion(old)), isError(409, 'worker_stale_lease'));
	assert.equal(restored.complete(completion(current)).job.state, 'completed');
});

test('completion retry is idempotent, conflicting completion does not inflate metrics', () => {
	const f = fixture(); f.queue.enqueue(submit('done'));
	const lease = f.queue.claim({ worker: phone('iphone') }).job;
	f.advance(500);
	const done = completion(lease);
	assert.equal(f.queue.complete(done).duplicate, false);
	f.advance(180000);
	assert.equal(new WorkerQueue(f.options).complete(done).duplicate, true);
	assert.throws(() => f.queue.complete({ ...done, metrics: { cpuMs: 13, elapsedMs: 40 } }), isError(409, 'worker_completion_conflict'));
	const status = f.queue.status();
	assert.equal(status.metrics.completed, 1); assert.equal(status.metrics.cpuMs, 12); assert.equal(status.metrics.texts, 1);
	assert.equal(status.recent[0].result, undefined);
	assert.equal(JSON.stringify(status).includes('Testo tecnico'), false);
});

test('capabilities match exact implementation, revision, language and vector dimensions', () => {
	const f = fixture(); f.queue.enqueue(submit('capability'));
	for (const wrong of [{ ...capabilities[0], revision: 2 }, { ...capabilities[0], dimension: 512 }, { ...capabilities[0], implementation: 'apple-nl-en' }]) {
		assert.equal(f.queue.claim({ worker: { ...phone('iphone'), capabilities: [wrong] } }).job, null);
	}
	assert.ok(f.queue.claim({ worker: phone('iphone') }).job);
});

test('invalid vectors and model provenance are rejected without consuming the lease', () => {
	const f = fixture(); f.queue.enqueue(submit('vectors'));
	const lease = f.queue.claim({ worker: phone('iphone') }).job;
	const done = completion(lease);
	for (const result of [{ ...done.result, revision: 2 }, { ...done.result, vectors: [[1]] }, { ...done.result, vectors: [Array(640).fill(0)] }, { ...done.result, vectors: [[NaN, ...Array(639).fill(0)]] }]) {
		assert.throws(() => f.queue.complete({ ...done, result }), isError(422));
	}
	assert.equal(f.queue.get('vectors').state, 'leased');
	assert.equal(f.queue.complete(done).job.state, 'completed');
});

test('cancel invalidates in-flight completion and keeps stable terminal identity', () => {
	const f = fixture(); f.queue.enqueue(submit('cancel'));
	const lease = f.queue.claim({ worker: phone('iphone') }).job;
	assert.equal(f.queue.cancel('cancel').state, 'cancelled');
	assert.throws(() => f.queue.complete(completion(lease)), isError(409));
	assert.equal(f.queue.enqueue(submit('cancel')).state, 'cancelled');
	assert.equal(f.queue.claim({ worker: phone('iphone') }).job, null);
});

test('three execution failures become terminal; intentional pauses remain retryable', () => {
	const f = fixture(); f.queue.enqueue(submit('retry'));
	for (let i = 0; i < 4; i++) {
		const lease = f.queue.claim({ worker: phone('iphone') }).job;
		assert.equal(f.queue.release({ jobId: lease.id, leaseToken: lease.leaseToken, attempt: lease.attempt, reason: 'paused' }).failures, 0);
	}
	for (let i = 1; i <= 3; i++) {
		const lease = f.queue.claim({ worker: phone('iphone') }).job;
		const job = f.queue.release({ jobId: lease.id, leaseToken: lease.leaseToken, attempt: lease.attempt, reason: 'execution_failed' });
		assert.equal(job.failures, i); assert.equal(job.state, i === 3 ? 'failed' : 'queued');
	}
	assert.equal(f.queue.claim({ worker: phone('iphone') }).job, null);
	assert.equal(f.queue.status().counts.failed, 1);
});

test('three abandoned leases are terminal, never an infinite crash loop', () => {
	const f = fixture(); f.queue.enqueue(submit('abandoned'));
	for (let i = 0; i < 3; i++) { assert.ok(f.queue.claim({ worker: phone('iphone') }).job); f.advance(120000); }
	assert.equal(new WorkerQueue(f.options).status().counts.failed, 1);
	assert.equal(f.queue.get('abandoned').error, 'lease_expired');
});

test('presence false is visible immediately and never claims work', () => {
	const f = fixture(); f.queue.enqueue(submit('presence'));
	assert.equal(f.queue.claim({ worker: { ...phone('iphone'), available: false } }).job, null);
	assert.equal(f.queue.status().workers[0].online, false);
	f.queue.presence(phone('iphone')); assert.equal(f.queue.status().workers[0].online, true);
	f.advance(45000); assert.equal(f.queue.status().workers[0].online, false);
});

test('durable submission/completion are not acknowledged if disk replacement fails', () => {
	const f = fixture(); f.queue.enqueue(submit('original'));
	const lease = f.queue.claim({ worker: phone('iphone') }).job;
	const rename = fs.renameSync;
	try {
		fs.renameSync = () => { const error = new Error('synthetic write failure'); error.code = 'EACCES'; throw error; };
		assert.throws(() => f.queue.enqueue(submit('not-durable')), isError(503, 'worker_persistence_failed'));
		assert.throws(() => f.queue.complete(completion(lease)), isError(503, 'worker_persistence_failed'));
	} finally { fs.renameSync = rename; }
	const restarted = new WorkerQueue(f.options);
	assert.throws(() => restarted.get('not-durable'), isError(404));
	assert.equal(restarted.get('original').state, 'leased');
	assert.equal(restarted.complete(completion(lease)).job.state, 'completed');
});

test('corrupt state is preserved, never replaced with an empty queue', () => {
	const f = fixture(); f.queue.enqueue(submit('corrupt'));
	const file = path.join(f.home, 'worker/state.json'); const damaged = '{invalid-json'; fs.writeFileSync(file, damaged);
	assert.throws(() => new WorkerQueue(f.options), isError(503, 'worker_state_unreadable_preserved'));
	assert.equal(fs.readFileSync(file, 'utf8'), damaged);
});

test('private durable state and lock ownership across processes', () => {
	const f = fixture(); f.queue.enqueue(submit('lock'));
	const dir = path.join(f.home, 'worker');
	assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
	assert.equal(fs.statSync(path.join(dir, 'state.json')).mode & 0o777, 0o600);
	const lock = path.join(dir, 'state.lock'); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
	assert.throws(() => f.queue.status(), isError(409, 'worker_busy'));
	fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647 }));
	assert.equal(f.queue.status().counts.queued, 1);
	assert.equal(fs.existsSync(lock), false);
});

test('payloads and outstanding queue are bounded', () => {
	const f = fixture();
	assert.throws(() => f.queue.enqueue({ ...submit('big'), input: { texts: Array(7).fill('x') } }), isError(422));
	assert.throws(() => f.queue.enqueue({ ...submit('long'), input: { texts: ['x'.repeat(2001)] } }), isError(422));
	assert.throws(() => f.queue.enqueue({ ...submit('empty'), input: { texts: ['  '] } }), isError(422));
	for (let i = 0; i < 32; i++) f.queue.enqueue(submit('bounded-' + i));
	assert.throws(() => f.queue.enqueue(submit('overflow')), isError(429));
});

test('OCR validates image signature, text bounds and records actual image contribution', () => {
	const f = fixture();
	assert.throws(() => f.queue.enqueue({ id: 'bad-image', origin: 'avo', operation: 'ocr', input: { imageBase64: Buffer.from('not an image at all').toString('base64'), mimeType: 'image/png' } }), isError(422));
	const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(16)]);
	f.queue.enqueue({ id: 'ocr', origin: 'avo', operation: 'ocr', input: { imageBase64: png.toString('base64'), mimeType: 'image/png' } });
	const lease = f.queue.claim({ worker: phone('iphone') }).job;
	f.advance(50);
	const done = { jobId: lease.id, leaseToken: lease.leaseToken, attempt: lease.attempt, result: { text: 'Synthetic OCR', implementation: 'apple-vision', revision: 3 }, metrics: { cpuMs: 20, elapsedMs: 50 } };
	assert.throws(() => f.queue.complete({ ...done, result: { ...done.result, text: 'x'.repeat(128 * 1024 + 1) } }), isError(422));
	assert.equal(f.queue.complete(done).job.result.text, 'Synthetic OCR');
	assert.equal(f.queue.status().metrics.images, 1);
	assert.equal(f.queue.status().metrics.inputBytes, png.length);
});

test('onChange wakes pending transport immediately and watches another queue instance', async () => {
	const f = fixture(); let local = 0;
	const dispose = f.queue.onChange(() => local++);
	f.queue.enqueue(submit('wake')); assert.ok(local >= 1); dispose();
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { stop(); reject(new Error('missing filesystem change')); }, 2000);
		const stop = f.queue.onChange(() => { clearTimeout(timer); stop(); resolve(); });
		new WorkerQueue(f.options).enqueue(submit('external-wake'));
	});
});

test('a pause recovers an assigned-but-undelivered lease without failure', () => {
	const f = fixture(); f.queue.enqueue(submit('lost-claim'));
	const abandoned = f.queue.claim({ worker: phone('iphone') }).job;
	f.queue.presence({ ...phone('iphone'), available: false });
	assert.equal(f.queue.get('lost-claim').state, 'queued');
	assert.equal(f.queue.get('lost-claim').failures, 0);
	assert.throws(() => f.queue.complete(completion(abandoned)), isError(409));
	assert.equal(f.queue.claim({ worker: phone('iphone') }).job.attempt, 2);
});

test('terminal jobs erase raw input but retain idempotency and durable results', () => {
	const f = fixture(); const request = submit('erased');
	f.queue.enqueue(request);
	const lease = f.queue.claim({ worker: phone('iphone') }).job;
	const done = completion(lease); f.queue.complete(done);
	const raw = fs.readFileSync(path.join(f.home, 'worker/state.json'), 'utf8');
	assert.equal(raw.includes('Testo tecnico sintetico.'), false);
	const restored = new WorkerQueue(f.options);
	assert.equal(restored.enqueue(request).state, 'completed');
	assert.equal(restored.complete(done).duplicate, true);
	assert.equal(restored.status().metrics.texts, 1);
	assert.equal(restored.get('erased').result.vectors[0].length, 640);
	assert.throws(() => restored.enqueue({ ...request, origin: 'avo' }), isError(409));
});

async function memoryFixture() {
	const f = fixture();
	fs.writeFileSync(path.join(f.home, 'workerconnection.json'), JSON.stringify({ version: 1, url: 'http://127.0.0.1:7790' }));
	fs.writeFileSync(path.join(f.home, 'ponte.json'), JSON.stringify({ token: 'synthetic-'.repeat(5) }));
	const rows = [{ id: 1, title: 'Titolo sintetico', text: 'Memoria tecnica uno.' }, { id: 2, title: 'Altro titolo', text: 'Memoria tecnica due.' }];
	const vectors = new Map();
	const store = { memoriesWithoutVector: limit => rows.filter(row => !vectors.has(row.id)).slice(0, limit), memory: id => rows.find(row => row.id === id), saveVector: (id, vector) => vectors.set(id, vector), tx: fn => fn() };
	const fetch = async (url, options) => {
		assert.ok(url.startsWith('http://127.0.0.1:7790/v1/worker/jobs'));
		assert.equal(options.redirect, 'error');
		let job;
		if (options.method === 'POST') job = f.queue.enqueue(JSON.parse(options.body));
		else job = f.queue.get(decodeURIComponent(url.split('/').pop()));
		return { ok: true, status: 200, text: async () => JSON.stringify({ job }) };
	};
	const client = await import(path.join(__dirname, '../../../memoria/lib/worker-client.mjs'));
	return { ...f, rows, vectors, store, fetch, process: client.processMemoryEmbeddings };
}

test('real-memory adapter survives restart and never applies changed/deleted rows', async () => {
	const f = await memoryFixture();
	const options = { home: f.home, fetch: f.fetch, verifyModel: async () => true };
	const queued = await f.process(f.store, options); assert.equal(queued.submitted, 2); assert.equal(queued.state, 'queued');
	const resumed = await f.process(f.store, options); assert.equal(resumed.jobID, queued.jobID); assert.equal(f.queue.status().counts.queued, 1);
	const lease = f.queue.claim({ worker: phone('iphone') }).job;
	const done = completion(lease); done.result.vectors = [vector(), vector()];
	f.queue.complete(done);
	f.rows[0].text = 'Changed after dispatch';
	const applied = await f.process(f.store, options);
	assert.equal(applied.applied, 1); assert.equal(applied.skipped, 1);
	assert.equal(f.vectors.has(1), false); assert.equal(f.vectors.get(2).length, 640);
	assert.equal(fs.existsSync(path.join(f.home, 'worker/memory-batch.json')), false);
});

test('memory adapter refuses incompatible local models and retains result for recovery', async () => {
	const f = await memoryFixture(); const options = { home: f.home, fetch: f.fetch, verifyModel: async () => false };
	await f.process(f.store, options);
	const lease = f.queue.claim({ worker: phone('iphone') }).job;
	const done = completion(lease); done.result.vectors = [vector(), vector()]; f.queue.complete(done);
	assert.equal((await f.process(f.store, options)).state, 'incompatible_local_model');
	assert.equal(f.vectors.size, 0); assert.equal(fs.existsSync(path.join(f.home, 'worker/memory-batch.json')), true);
	assert.equal((await f.process(f.store, { ...options, verifyModel: async () => true })).applied, 2);
});

test('memory adapter preserves manifest on transport failure and refuses a nonlocal endpoint', async () => {
	const f = await memoryFixture();
	await assert.rejects(f.process(f.store, { home: f.home, fetch: async () => { throw new Error('offline'); } }));
	assert.equal(fs.existsSync(path.join(f.home, 'worker/memory-batch.json')), true);
	fs.writeFileSync(path.join(f.home, 'workerconnection.json'), JSON.stringify({ version: 1, url: 'https://example.com' }));
	const result = await f.process(f.store, { home: f.home, fetch: () => { throw new Error('must not fetch external URL'); } });
	assert.equal(result.state, 'unavailable'); assert.equal(f.vectors.size, 0);
});

test('maximum supported OCR input does not overflow RegExp stack and is erased on cancel', () => {
	const f = fixture();
	const image = Buffer.alloc(4 * 1024 * 1024); image.set([137,80,78,71,13,10,26,10]);
	assert.equal(f.queue.enqueue({ id: 'maximum-image', origin: 'avo', operation: 'ocr', input: { imageBase64: image.toString('base64'), mimeType: 'image/png' } }).inputBytes, image.length);
	f.queue.cancel('maximum-image');
	assert.ok(fs.statSync(path.join(f.home, 'worker/state.json')).size < 1024);
});

test('actual memory and thermal metrics survive completion/restart and participate in idempotency', () => {
	const f = fixture(); f.queue.enqueue(submit('measured-memory'));
	const done = completion(f.queue.claim({ worker: phone('iphone') }).job);
	done.metrics = { ...done.metrics, peakResidentBytes: 160 * 1024 * 1024, thermalStart: 'nominal', thermalEnd: 'fair' };
	for (const invalid of [{ peakResidentBytes: -1 }, { peakResidentBytes: 1.5 }, { peakResidentBytes: Number.MAX_SAFE_INTEGER }, { thermalStart: 'cold' }, { thermalEnd: null }]) {
		assert.throws(() => f.queue.complete({ ...done, metrics: { ...done.metrics, ...invalid } }), isError(422, 'worker_invalid_metrics'));
	}
	const first = f.queue.complete(done);
	assert.equal(first.job.metrics.peakResidentBytes, 160 * 1024 * 1024);
	assert.equal(first.job.metrics.thermalStart, 'nominal'); assert.equal(first.job.metrics.thermalEnd, 'fair');
	const restarted = new WorkerQueue(f.options);
	assert.equal(restarted.get(done.jobId).metrics.thermalEnd, 'fair');
	assert.equal(restarted.status().recent[0].metrics.peakResidentBytes, 160 * 1024 * 1024);
	assert.equal(restarted.complete(done).duplicate, true);
	assert.throws(() => restarted.complete({ ...done, metrics: { ...done.metrics, thermalEnd: 'serious' } }), isError(409, 'worker_completion_conflict'));
});

test('installed memory CLI emits the same JSON through a symlink and its physical path', () => {
	const f = fixture();
	const { spawnSync } = require('node:child_process');
	const physical = path.resolve(__dirname, '../../../memoria/lib/worker-client.mjs');
	const link = path.join(f.home, 'memory-worker-symlink.mjs');
	fs.symlinkSync(physical, link);
	const env = { ...process.env, BOTTEGA_HOME: f.home, CLINE_DATA_DIR: path.join(f.home, 'cline'), CODEX_HOME: path.join(f.home, 'codex') };
	const run = filename => {
		const result = spawnSync(process.execPath, [filename, '--wait-ms', '0'], { env, encoding: 'utf8', timeout: 10000 });
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout.trim(), 'CLI entry point must run through the installation symlink');
		return JSON.parse(result.stdout);
	};
	const direct = run(physical), linked = run(link);
	assert.equal(direct.state, 'unavailable');
	assert.deepEqual(linked, direct);
	assert.ok(fs.existsSync(path.join(f.home, 'memoria/memoria.db')));
});
