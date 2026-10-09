import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash, randomUUID } from 'crypto';

export type WorkerOperation = 'embeddings' | 'ocr';
export interface WorkerCapability { operation: WorkerOperation; implementation: string; revision: number; dimension?: number }
export interface WorkerProfile {
	id: string; capacity: 1; available?: boolean; version?: string; device?: string; thermal?: string;
	capabilities: WorkerCapability[];
}
export interface WorkerSubmission {
	id?: string; origin: 'bottega' | 'avo'; operation: WorkerOperation;
	input: { texts: string[] } | { imageBase64: string; mimeType: 'image/png' | 'image/jpeg' };
}
export type WorkerThermal = 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
export interface WorkerMetrics {
	cpuMs: number; elapsedMs: number; inputBytes: number; outputBytes: number;
	peakResidentBytes?: number; thermalStart?: WorkerThermal; thermalEnd?: WorkerThermal;
}
export interface WorkerJobView {
	id: string; origin: 'bottega' | 'avo'; operation: WorkerOperation;
	implementation: string; revision: number; dimension?: number;
	state: 'queued' | 'leased' | 'completed' | 'cancelled' | 'failed';
	createdAt: number; updatedAt: number; attempts: number; failures: number; inputBytes: number; error?: string;
	outputBytes?: number; completedAt?: number; metrics?: WorkerMetrics; result?: object;
}
export interface WorkerLease {
	id: string; origin: 'bottega' | 'avo'; operation: WorkerOperation; input: WorkerSubmission['input'];
	implementation: string; revision: number; dimension?: number;
	leaseToken: string; attempt: number; leaseExpiresAt: number;
}
interface Lease { token: string; workerID: string; attempt: number; expiresAt: number }
interface Job extends WorkerJobView {
	input?: WorkerSubmission['input']; submissionHash: string; workUnits: number; lease?: Lease;
	completion?: { token: string; attempt: number; hash: string }; lastReleaseReason?: string;
}
export interface WorkerPresence extends WorkerProfile { lastSeenAt: number; online: boolean }
export interface WorkerStatus {
	available: true;
	counts: { queued: number; leased: number; completed: number; cancelled: number; failed: number };
	workers: WorkerPresence[];
	metrics: { completed: number; cpuMs: number; elapsedMs: number; inputBytes: number; outputBytes: number;
		texts: number; images: number; throughputPerMinute: number; firstCompletedAt?: number; lastCompletedAt?: number };
	active: WorkerJobView[]; recent: WorkerJobView[];
}
interface Presence extends WorkerProfile { lastSeenAt: number }
interface State { version: 1; jobs: Job[]; workers: Presence[] }
interface Options { home?: string; now?: () => number }
export class WorkerError extends Error {
	constructor(readonly status: number, readonly code: string) { super(code); this.name = 'WorkerError'; }
}
const LEASE_MS = 120_000;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const requireThat = (condition: unknown, status = 422, code = 'invalid_request'): void => { if (!condition) throw new WorkerError(status, code); };
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const model = (operation: WorkerOperation): WorkerCapability => operation === 'embeddings'
	? { operation, implementation: 'apple-nl-it', revision: 1, dimension: 640 }
	: { operation, implementation: 'apple-vision', revision: 3 };

/** Local, durable coordinator. No VM, LLM, timer or network; callers own transport/auth.
 * Every transaction rereads disk under an exclusive lock, including across IDE windows.
 * A failed atomic write never acknowledges submission or completion. */
export class WorkerQueue {
	private readonly directory: string;
	private readonly file: string;
	private readonly lockFile: string;
	private readonly now: () => number;
	private readonly listeners = new Set<() => void>();
	private watcher?: fs.FSWatcher;

	constructor(options: Options = {}) {
		this.directory = path.join(options.home ?? process.env.BOTTEGA_HOME ?? path.join(os.homedir(), '.bottega'), 'worker');
		this.file = path.join(this.directory, 'state.json');
		this.lockFile = path.join(this.directory, 'state.lock');
		this.now = options.now ?? Date.now;
		fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		fs.chmodSync(this.directory, 0o700);
		// Validate an existing state immediately; preserve corrupt files for recovery.
		this.read();
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		if (!this.watcher) this.watcher = fs.watch(this.directory, { persistent: false }, (_event, name) => {
			if (name?.toString() === 'state.json') this.notify();
		});
		return () => {
			this.listeners.delete(listener);
			if (!this.listeners.size) { this.watcher?.close(); this.watcher = undefined; }
		};
	}
	private notify(): void { for (const listener of this.listeners) { try { listener(); } catch { /* caller isolation */ } } }

	private read(): State {
		if (!fs.existsSync(this.file)) return { version: 1, jobs: [], workers: [] };
		try {
			requireThat(fs.statSync(this.file).size <= MAX_STATE_BYTES);
			const state = JSON.parse(fs.readFileSync(this.file, 'utf8')) as State;
			requireThat(state.version === 1 && Array.isArray(state.jobs) && state.jobs.length <= 1000 && Array.isArray(state.workers));
			const ids = new Set<string>();
			for (const job of state.jobs) {
				requireThat(idPattern.test(job.id) && !ids.has(job.id)); ids.add(job.id);
				requireThat(['queued', 'leased', 'completed', 'cancelled', 'failed'].includes(job.state));
				requireThat(/^[a-f0-9]{64}$/.test(job.submissionHash) && ['bottega', 'avo'].includes(job.origin));
				requireThat(['embeddings', 'ocr'].includes(job.operation) && Number.isInteger(job.workUnits) && job.workUnits >= 1 && job.workUnits <= 6);
				const expected = model(job.operation);
				requireThat(job.implementation === expected.implementation && job.revision === expected.revision && job.dimension === expected.dimension);
				if (job.state === 'queued' || job.state === 'leased') requireThat(job.input && job.submissionHash === hash(this.submission({ id: job.id, origin: job.origin, operation: job.operation, input: job.input }).identity));
				requireThat(Number.isFinite(job.createdAt) && Number.isFinite(job.updatedAt) && Number.isInteger(job.attempts));
				if (job.state === 'leased') requireThat(job.lease && idPattern.test(job.lease.token) && Number.isFinite(job.lease.expiresAt));
				if (job.state === 'completed') requireThat(job.result && job.metrics && job.completion);
			}
			return state;
		} catch { throw new WorkerError(503, 'worker_state_unreadable_preserved'); }
	}

	private persist(state: State): void {
		const encoded = JSON.stringify(state);
		requireThat(Buffer.byteLength(encoded) <= MAX_STATE_BYTES, 429, 'worker_storage_full');
		const temp = path.join(this.directory, 'state-' + randomUUID() + '.tmp');
		let fd: number | undefined;
		try {
			fd = fs.openSync(temp, 'wx', 0o600);
			fs.writeFileSync(fd, encoded, 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
			fs.renameSync(temp, this.file);
			// The file contents are durable before acknowledgement; persist its rename too.
			const dir = fs.openSync(this.directory, 'r');
			try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
		} catch { throw new WorkerError(503, 'worker_persistence_failed'); }
		finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
	}

	private createLock(file: string): number {
		// Publish an already-written owner atomically. A crash between open/write
		// cannot leave an empty lock that nobody can identify on restart.
		const temporary = path.join(this.directory, 'lock-' + randomUUID() + '.tmp');
		const fd = fs.openSync(temporary, 'wx', 0o600);
		try {
			fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }), 'utf8');
			fs.fsyncSync(fd);
			fs.linkSync(temporary, file);
			return fd;
		} catch (error) { fs.closeSync(fd); throw error; }
		finally { try { fs.unlinkSync(temporary); } catch {} }
	}

	private transaction<T>(change: (state: State, now: number) => T): T {
		let lock: number;
		try { lock = this.createLock(this.lockFile); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new WorkerError(503, 'worker_lock_failed');
			// Serialize recovery itself: two restarted IDE windows must not both
			// remove a dead lock and accidentally steal the newly acquired live one.
			const recoveryFile = this.lockFile + '.recovery';
			let recovery: number;
			try { recovery = this.createLock(recoveryFile); }
			catch { throw new WorkerError(409, 'worker_busy'); }
			try {
				const owner = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
				requireThat(Number.isInteger(owner.pid) && owner.pid > 0, 409, 'worker_busy');
				try { process.kill(owner.pid, 0); throw new WorkerError(409, 'worker_busy'); }
				catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw new WorkerError(409, 'worker_busy'); }
				fs.unlinkSync(this.lockFile);
				lock = this.createLock(this.lockFile);
			} catch { throw new WorkerError(409, 'worker_busy'); }
			finally { fs.closeSync(recovery); try { fs.unlinkSync(recoveryFile); } catch {} }
		}
		let changed = false;
		try {
			const state = this.read(); const previous = JSON.stringify(state); const now = this.now();
			for (const job of state.jobs) if (job.state === 'leased' && job.lease!.expiresAt <= now) {
				this.retryOrFail(job, now, 'lease_expired');
			}
			const result = change(state, now);
			if (JSON.stringify(state) !== previous) { this.persist(state); changed = true; }
			return copy(result);
		} finally {
			fs.closeSync(lock); try { fs.unlinkSync(this.lockFile); } catch {}
			if (changed) this.notify();
		}
	}

	private submission(request: WorkerSubmission): { id: string; identity: object; input: WorkerSubmission['input']; inputBytes: number } {
		requireThat(request && typeof request === 'object');
		const id = request.id ?? randomUUID(); requireThat(typeof id === 'string' && idPattern.test(id));
		requireThat(['bottega', 'avo'].includes(request.origin));
		requireThat(['embeddings', 'ocr'].includes(request.operation));
		const input = request.input as any; requireThat(input && typeof input === 'object');
		let normalized: WorkerSubmission['input']; let inputBytes: number;
		if (request.operation === 'embeddings') {
			requireThat(Array.isArray(input.texts) && input.texts.length >= 1 && input.texts.length <= 6);
			requireThat(input.texts.every((text: unknown) => typeof text === 'string' && text.trim().length > 0 && text.length <= 2000));
			normalized = { texts: [...input.texts] }; inputBytes = bytes(normalized);
		} else {
			requireThat(typeof input.imageBase64 === 'string' && input.imageBase64.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4);
			requireThat(['image/png', 'image/jpeg'].includes(input.mimeType));
			requireThat(input.imageBase64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(input.imageBase64));
			const image = Buffer.from(input.imageBase64, 'base64');
			requireThat(image.length > 8 && image.length <= MAX_IMAGE_BYTES && image.toString('base64') === input.imageBase64);
			const validHeader = input.mimeType === 'image/png' ? image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : image[0] === 255 && image[1] === 216 && image[2] === 255;
			requireThat(validHeader, 422, 'invalid_image_header');
			normalized = { imageBase64: image.toString('base64'), mimeType: input.mimeType }; inputBytes = image.length;
		}
		return { id, identity: { origin: request.origin, input: normalized, ...model(request.operation) }, input: normalized, inputBytes };
	}

	private view(job: Job, includeResult = true): WorkerJobView {
		const { input, submissionHash, workUnits, lease, completion, lastReleaseReason, ...view } = job;
		if (!includeResult) delete view.result;
		return view;
	}
	private job(state: State, id: string): Job {
		requireThat(typeof id === 'string' && idPattern.test(id));
		const job = state.jobs.find(item => item.id === id);
		if (!job) throw new WorkerError(404, 'worker_job_not_found');
		return job;
	}

	enqueue(request: WorkerSubmission): WorkerJobView {
		const submission = this.submission(request); const digest = hash(submission.identity);
		return this.transaction((state, now) => {
			const old = state.jobs.find(item => item.id === submission.id);
			if (old) { requireThat(old.submissionHash === digest, 409, 'worker_job_id_conflict'); return this.view(old); }
			requireThat(state.jobs.filter(item => ['queued', 'leased'].includes(item.state)).length < 32, 429, 'worker_queue_full');
			requireThat(state.jobs.length < 1000, 429, 'worker_history_full');
			const job: Job = { id: submission.id, origin: request.origin, ...model(request.operation), input: submission.input,
				submissionHash: digest, workUnits: request.operation === 'embeddings' ? (submission.input as { texts: string[] }).texts.length : 1, state: 'queued', createdAt: now, updatedAt: now, attempts: 0, failures: 0, inputBytes: submission.inputBytes };
			state.jobs.push(job); return this.view(job);
		});
	}
	get(id: string): WorkerJobView { return this.transaction(state => this.view(this.job(state, id))); }
	cancel(id: string): WorkerJobView {
		return this.transaction((state, now) => {
			const job = this.job(state, id);
			requireThat(job.state !== 'completed', 409, 'worker_job_already_completed');
			job.state = 'cancelled'; job.updatedAt = now; delete job.lease; delete job.input;
			return this.view(job);
		});
	}

	private profile(state: State, worker: WorkerProfile, now: number): Presence {
		requireThat(worker && typeof worker === 'object' && typeof worker.id === 'string' && idPattern.test(worker.id));
		requireThat(worker.capacity === 1 && (worker.available === undefined || typeof worker.available === 'boolean'));
		requireThat(Array.isArray(worker.capabilities) && worker.capabilities.length <= 8);
		const capabilities = worker.capabilities.map(cap => {
			requireThat(cap && ['embeddings', 'ocr'].includes(cap.operation));
			requireThat(typeof cap.implementation === 'string' && cap.implementation.length <= 80 && Number.isInteger(cap.revision) && cap.revision > 0);
			requireThat(cap.dimension === undefined || (Number.isInteger(cap.dimension) && cap.dimension > 0 && cap.dimension <= 4096));
			return { operation: cap.operation, implementation: cap.implementation, revision: cap.revision, ...(cap.dimension === undefined ? {} : { dimension: cap.dimension }) };
		});
		const presence: Presence = { id: worker.id, capacity: 1, available: worker.available ?? true, capabilities, lastSeenAt: now };
		for (const key of ['version', 'device', 'thermal'] as const) if (worker[key] !== undefined) {
			requireThat(typeof worker[key] === 'string' && worker[key]!.length <= 100); presence[key] = worker[key];
		}
		state.workers = state.workers.filter(item => item.id !== worker.id).slice(-31);
		state.workers.push(presence);
		// A long poll can be cancelled after assignment but before the phone receives
		// its lease. An explicit pause releases this worker's orphan without penalty.
		if (!presence.available) for (const job of state.jobs) if (job.state === 'leased' && job.lease?.workerID === worker.id) this.retryOrFail(job, now, 'paused', false);
		return presence;
	}
	presence(worker: WorkerProfile): WorkerPresence { return this.transaction((state, now) => ({ ...this.profile(state, worker, now), online: worker.available !== false })); }
	claim(request: { worker: WorkerProfile }): { job: WorkerLease | null } {
		return this.transaction((state, now) => {
			const worker = this.profile(state, request?.worker, now);
			if (!worker.available || state.jobs.some(item => item.state === 'leased')) return { job: null };
			const job = state.jobs.filter(item => item.state === 'queued').sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt)
				.find(item => worker.capabilities.some(cap => cap.operation === item.operation && cap.implementation === item.implementation && cap.revision === item.revision && cap.dimension === item.dimension));
			if (!job) return { job: null };
			job.state = 'leased'; job.updatedAt = now; job.attempts++;
			job.lease = { token: randomUUID(), workerID: worker.id, attempt: job.attempts, expiresAt: now + LEASE_MS };
			return { job: { id: job.id, origin: job.origin, operation: job.operation, input: job.input!, implementation: job.implementation,
				revision: job.revision, ...(job.dimension ? { dimension: job.dimension } : {}), leaseToken: job.lease.token, attempt: job.attempts, leaseExpiresAt: job.lease.expiresAt } };
		});
	}
	private retryOrFail(job: Job, now: number, reason: string, countsAsFailure = true): void {
		if (countsAsFailure) job.failures = (job.failures ?? 0) + 1;
		job.state = job.failures >= 3 ? 'failed' : 'queued';
		job.updatedAt = now; job.lastReleaseReason = reason; delete job.lease;
		if (job.state === 'failed') { job.error = reason; delete job.input; }
	}
	private validLease(job: Job, token: string, attempt: number): void {
		requireThat(job.state === 'leased' && job.lease?.token === token && job.lease.attempt === attempt, 409, 'worker_stale_lease');
	}
	complete(request: { jobId: string; leaseToken: string; attempt: number; result: any; metrics: Pick<WorkerMetrics, 'cpuMs' | 'elapsedMs' | 'peakResidentBytes' | 'thermalStart' | 'thermalEnd'> }): { job: WorkerJobView; duplicate: boolean } {
		return this.transaction((state, now) => {
			const job = this.job(state, request?.jobId);
			const result = request.result;
			requireThat(result && result.implementation === job.implementation && result.revision === job.revision, 422, 'worker_result_model_mismatch');
			let normalized: object;
			if (job.operation === 'embeddings') {
				requireThat(result.dimension === 640 && Array.isArray(result.vectors) && result.vectors.length === job.workUnits, 422, 'worker_invalid_vectors');
				requireThat(result.vectors.every((vector: unknown) => Array.isArray(vector) && vector.length === 640 && vector.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e6) && vector.some(value => value !== 0)), 422, 'worker_invalid_vectors');
				normalized = { vectors: result.vectors, implementation: result.implementation, revision: result.revision, dimension: 640 };
			} else {
				requireThat(typeof result.text === 'string' && Buffer.byteLength(result.text) <= 128 * 1024, 422, 'worker_invalid_ocr');
				normalized = { text: result.text, implementation: result.implementation, revision: result.revision };
			}
			const metrics = request.metrics;
			requireThat(metrics && [metrics.cpuMs, metrics.elapsedMs].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3_600_000), 422, 'worker_invalid_metrics');
			const measured: WorkerMetrics = { cpuMs: metrics.cpuMs, elapsedMs: metrics.elapsedMs, inputBytes: job.inputBytes, outputBytes: bytes(normalized) };
			if (metrics.peakResidentBytes !== undefined) {
				requireThat(Number.isSafeInteger(metrics.peakResidentBytes) && metrics.peakResidentBytes >= 0 && metrics.peakResidentBytes <= 1024 ** 4, 422, 'worker_invalid_metrics');
				measured.peakResidentBytes = metrics.peakResidentBytes;
			}
			for (const key of ['thermalStart', 'thermalEnd'] as const) if (metrics[key] !== undefined) {
				requireThat(['nominal', 'fair', 'serious', 'critical', 'unknown'].includes(metrics[key]!), 422, 'worker_invalid_metrics');
				measured[key] = metrics[key];
			}
			const digest = hash({ result: normalized, metrics: measured });
			if (job.state === 'completed') {
				requireThat(job.completion?.token === request.leaseToken && job.completion.attempt === request.attempt && job.completion.hash === digest, 409, 'worker_completion_conflict');
				return { job: this.view(job), duplicate: true };
			}
			this.validLease(job, request.leaseToken, request.attempt);
			job.state = 'completed'; job.result = normalized; job.metrics = measured; job.outputBytes = measured.outputBytes;
			job.completedAt = now; job.updatedAt = now;
			job.completion = { token: request.leaseToken, attempt: request.attempt, hash: digest }; delete job.lease; delete job.input;
			return { job: this.view(job), duplicate: false };
		});
	}
	release(request: { jobId: string; leaseToken: string; attempt: number; reason?: string }): WorkerJobView {
		return this.transaction((state, now) => {
			const job = this.job(state, request?.jobId); this.validLease(job, request.leaseToken, request.attempt);
			requireThat(request.reason === undefined || (typeof request.reason === 'string' && request.reason.length <= 100));
			this.retryOrFail(job, now, request.reason ?? 'execution_failed', !['paused', 'thermal', 'stopped', 'cancelled'].includes(request.reason ?? ''));
			return this.view(job);
		});
	}
	status(): WorkerStatus {
		return this.transaction((state, now) => {
			const counts = { queued: 0, leased: 0, completed: 0, cancelled: 0, failed: 0 };
			const metrics = { completed: 0, cpuMs: 0, elapsedMs: 0, inputBytes: 0, outputBytes: 0, texts: 0, images: 0, throughputPerMinute: 0,
				firstCompletedAt: undefined as number | undefined, lastCompletedAt: undefined as number | undefined };
			let firstCreatedAt: number | undefined;
			for (const job of state.jobs) {
				counts[job.state]++;
				if (job.state !== 'completed' || !job.metrics) continue;
				metrics.completed++;
				if (job.operation === 'embeddings') metrics.texts += job.workUnits;
				else metrics.images++;
				metrics.cpuMs += job.metrics.cpuMs; metrics.elapsedMs += job.metrics.elapsedMs;
				metrics.inputBytes += job.metrics.inputBytes; metrics.outputBytes += job.metrics.outputBytes;
				metrics.firstCompletedAt = Math.min(metrics.firstCompletedAt ?? Infinity, job.completedAt!);
				metrics.lastCompletedAt = Math.max(metrics.lastCompletedAt ?? 0, job.completedAt!);
				firstCreatedAt = Math.min(firstCreatedAt ?? Infinity, job.createdAt);
			}
			if (firstCreatedAt !== undefined && now > firstCreatedAt) metrics.throughputPerMinute = metrics.completed * 60_000 / (now - firstCreatedAt);
			return { available: true, counts, workers: state.workers.map(worker => ({ ...worker, online: worker.available !== false && now - worker.lastSeenAt < 45_000 })), metrics,
				active: state.jobs.filter(job => job.state === 'queued' || job.state === 'leased').map(job => this.view(job, false)),
				recent: state.jobs.filter(job => job.state === 'completed' || job.state === 'cancelled' || job.state === 'failed').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20).map(job => this.view(job, false)) };
		});
	}
}
