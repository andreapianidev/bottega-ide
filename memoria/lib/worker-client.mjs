// Explicit background/manual memory offload, never imported by the 150 ms hooks.
// Only the Mac's own bridge is allowed; no VM, external endpoint or LLM fallback.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BOTTEGA_HOME } from './paths.mjs';

const fingerprint = row => createHash('sha256').update(JSON.stringify([Number(row.id), row.title || '', row.text || ''])).digest('hex');
const textFor = row => `${row.title || ''}. ${row.text || ''}`.replace(/\s+/g, ' ').slice(0, 2000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function atomic(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = file + '.' + randomUUID() + '.tmp';
	try {
		const fd = fs.openSync(temp, 'wx', 0o600);
		try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		fs.renameSync(temp, file);
		const directory = fs.openSync(path.dirname(file), 'r');
		try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
	} finally { try { fs.unlinkSync(temp); } catch {} }
}
function configuration(home) {
	try {
		const connection = JSON.parse(fs.readFileSync(path.join(home, 'workerconnection.json'), 'utf8'));
		const token = JSON.parse(fs.readFileSync(path.join(home, 'ponte.json'), 'utf8')).token;
		const url = new URL(connection.url);
		const local = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
		for (const values of Object.values(os.networkInterfaces())) for (const item of values || []) local.add(item.address);
		if (connection.version !== 1 || !['http:', 'https:'].includes(url.protocol) || !local.has(url.hostname)
			|| url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')
			|| typeof token !== 'string' || token.length < 32) return undefined;
		return { url: url.origin, token };
	} catch { return undefined; }
}
function validVectors(result, count) {
	return result?.implementation === 'apple-nl-it' && result.revision === 1 && result.dimension === 640
		&& Array.isArray(result.vectors) && result.vectors.length === count
		&& result.vectors.every(v => Array.isArray(v) && v.length === 640
			&& v.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 1e6) && v.some(x => x !== 0));
}
async function compatible(text, vector) {
	// The Mac's search uses its local NLEmbedding. Check one real batch text rather
	// than mixing equal-dimensional but different-language/revision vector spaces.
	const { embed } = await import('./engines.mjs');
	const own = embed([text])?.[0];
	if (!own || own.length !== vector.length) return false;
	let dot = 0, a = 0, b = 0;
	for (let i = 0; i < own.length; i++) { dot += own[i] * vector[i]; a += own[i] ** 2; b += vector[i] ** 2; }
	return a > 0 && b > 0 && dot / Math.sqrt(a * b) > 0.999;
}

/** One real batch of <=6 missing vectors. Stable manifest survives a crash between
 * submission/response/application. Changed or deleted memory rows are never updated.
 * waitMs=0 submits/resumes without waiting; CLI --wait watches this work, not a benchmark.
 * verifyModel is injectable only for isolated tests. Production checks the local model. */
export async function processMemoryEmbeddings(store, options = {}) {
	const home = options.home || BOTTEGA_HOME;
	const directory = path.join(home, 'worker');
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const lockFile = path.join(directory, 'memory-client.lock');
	let lock;
	try { lock = fs.openSync(lockFile, 'wx', 0o600); }
	catch (error) {
		if (error.code !== 'EEXIST') throw error;
		try {
			const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
			if (!Number.isInteger(owner.pid) || owner.pid <= 0) return { state: 'busy', submitted: 0, applied: 0 };
			try { process.kill(owner.pid, 0); return { state: 'busy', submitted: 0, applied: 0 }; }
			catch (check) { if (check.code !== 'ESRCH') return { state: 'busy', submitted: 0, applied: 0 }; }
			fs.unlinkSync(lockFile); lock = fs.openSync(lockFile, 'wx', 0o600);
		} catch { return { state: 'busy', submitted: 0, applied: 0 }; }
	}
	try {
		fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
		return await processBatch(store, options);
	} finally { fs.closeSync(lock); try { fs.unlinkSync(lockFile); } catch {} }
}

async function processBatch(store, options) {
	const home = options.home || BOTTEGA_HOME;
	const config = configuration(home);
	if (!config) return { state: 'unavailable', submitted: 0, applied: 0 };
	const file = path.join(home, 'worker', 'memory-batch.json');
	let batch;
	try {
		batch = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (batch.version !== 1 || typeof batch.id !== 'string' || !/^memory-[a-f0-9-]{36}$/.test(batch.id)
			|| !Array.isArray(batch.rows) || batch.rows.length < 1 || batch.rows.length > 6
			|| !Array.isArray(batch.texts) || batch.texts.length !== batch.rows.length
			|| !batch.rows.every(row => Number.isInteger(row.id) && /^[a-f0-9]{64}$/.test(row.hash))
			|| !batch.texts.every(text => typeof text === 'string' && text.length > 0 && text.length <= 2000)) throw new Error('invalid manifest');
	} catch {
		if (fs.existsSync(file)) throw new Error('worker_memory_manifest_unreadable_preserved');
		const rows = store.memoriesWithoutVector(6);
		if (!rows.length) return { state: 'empty', submitted: 0, applied: 0 };
		batch = { version: 1, id: 'memory-' + randomUUID(), rows: rows.map(row => ({ id: Number(row.id), hash: fingerprint(row) })), texts: rows.map(textFor) };
		atomic(file, batch);
	}
	const fetcher = options.fetch || fetch;
	async function request(route, data) {
		const response = await fetcher(config.url + '/v1/worker' + route, {
			method: data ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(1500),
			headers: { Authorization: 'Bearer ' + config.token, ...(data ? { 'Content-Type': 'application/json' } : {}) },
			...(data ? { body: JSON.stringify(data) } : {}),
		});
		if (!response.ok) throw new Error('worker_http_' + response.status);
		const encoded = await response.text();
		if (Buffer.byteLength(encoded) > 512 * 1024) throw new Error('worker_response_too_large');
		return JSON.parse(encoded).job;
	}
	let job = await request('/jobs', { id: batch.id, origin: 'bottega', operation: 'embeddings', input: { texts: batch.texts } });
	const deadline = Date.now() + Math.min(40000, Math.max(0, Number.isFinite(options.waitMs) ? options.waitMs : 0));
	while (['queued', 'leased'].includes(job?.state) && Date.now() < deadline) {
		await pause(Math.min(1000, Math.max(0, deadline - Date.now())));
		job = await request('/jobs/' + encodeURIComponent(batch.id));
	}
	if (job?.state === 'failed' || job?.state === 'cancelled') {
		fs.unlinkSync(file); return { state: job.state, jobID: batch.id, submitted: batch.rows.length, applied: 0 };
	}
	if (job?.state !== 'completed') return { state: job?.state || 'queued', jobID: batch.id, submitted: batch.rows.length, applied: 0 };
	if (!validVectors(job.result, batch.rows.length)) throw new Error('worker_memory_invalid_result');
	const unchanged = batch.rows.map((row, index) => {
		const current = store.memory(row.id);
		return current && fingerprint(current) === row.hash ? index : -1;
	}).filter(index => index >= 0);
	if (unchanged.length && !await (options.verifyModel || compatible)(batch.texts[unchanged[0]], job.result.vectors[unchanged[0]])) {
		return { state: 'incompatible_local_model', jobID: batch.id, submitted: batch.rows.length, applied: 0 };
	}
	let applied = 0;
	store.tx(() => {
		for (const index of unchanged) {
			const row = batch.rows[index], current = store.memory(row.id);
			if (!current || fingerprint(current) !== row.hash) continue;
			store.saveVector(row.id, job.result.vectors[index]); applied++;
		}
	});
	fs.unlinkSync(file);
	return { state: 'completed', jobID: batch.id, submitted: batch.rows.length, applied, skipped: batch.rows.length - applied };
}

function invokedAsMain() {
	if (!process.argv[1]) return false;
	try {
		// Node resolves the imported module through installation symlinks, while
		// argv[1] retains ~/.bottega/memoria-app. Compare physical paths on both sides.
		return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
	} catch { return false; }
}

if (invokedAsMain()) {
	try {
		const { openStore } = await import('./store.mjs');
		const waitFlag = process.argv.indexOf('--wait-ms');
		const requested = waitFlag >= 0 ? Number(process.argv[waitFlag + 1]) : process.argv.includes('--wait') ? 40000 : 0;
		const waitMs = Number.isFinite(requested) ? Math.min(40000, Math.max(0, requested)) : 0;
		const result = await processMemoryEmbeddings(openStore(), { waitMs });
		console.log(JSON.stringify(result));
	} catch {
		// No input, tokens or endpoint details in user-visible errors.
		console.error('Il lavoro della memoria non è terminato; lo stato è conservato per riprovare.'); process.exitCode = 1;
	}
}
