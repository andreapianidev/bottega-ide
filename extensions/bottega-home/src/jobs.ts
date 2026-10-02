import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { LiveSession } from './claude';
import { SystemStats } from './nucleo';

// I "Lavori": sessioni Claude avviate dalla Bottega in una scheda del terminale, con un
// limite di parallelismo che rispetta il Mac di Andrea (Air M2 16 GB).

export type JobStatus = 'in coda' | 'stanotte' | 'in corso' | 'ti aspetta' | 'finito' | 'fermato';

export interface Job {
	id: string;
	project: string;
	path: string;
	task: string;
	status: JobStatus;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	sessionId?: string;
	pid?: number;
	lastActivity?: number;
	/** Lavoro della coda della notte (src/notte.ts): parte solo nella finestra notturna. */
	night?: boolean;
}

export interface JobDeps {
	claudeCommand(): string;
	maxParallelSetting(): string | number;
	systemStats(): SystemStats | undefined;
	liveSessions(): LiveSession[];
	/** Notifica nativa con azione "Apri"; no-op se il Nucleo manca. */
	notify(args: { id: string; title: string; body: string; actions?: { id: string; title: string }[] }): void;
	updateMenubar(counts: { busy: number; waiting: number; queued: number }): void;
	/** ppid di un processo via `ps`; iniettabile nei test, altrimenti usa `ps`. */
	ppidOf?(pid: number): Promise<number | undefined>;
	onChange(): void;
}

const GLOBAL_KEY = 'bottega.jobs';
const active = new Set<JobStatus>(['in coda', 'stanotte', 'in corso', 'ti aspetta']);

/** Mette una stringa fra apici singoli per la shell, in sicurezza. */
export function shellQuote(s: string): string {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Il limite di lavori in parallelo: numero fisso dall'impostazione, oppure "auto" dai sensori. */
export function computeLimit(setting: string | number, stats?: SystemStats): number {
	if (typeof setting === 'number' && Number.isFinite(setting)) return Math.max(1, Math.floor(setting));
	if (typeof setting === 'string' && setting !== 'auto') {
		const n = parseInt(setting, 10);
		if (!Number.isNaN(n)) return Math.max(1, n);
	}
	if (!stats) return 3;
	const p = stats.memoryPressure;
	const t = stats.thermal;
	if (p === 'critical' || t === 'critical') return 1;
	if (p === 'warning' || t === 'serious') return 2;
	return 3;
}

/** Una frase in italiano che spiega perche' il limite e' quello che e', per la plancia. */
export function limitReason(setting: string | number, stats?: SystemStats): string {
	if (typeof setting === 'number' && Number.isFinite(setting)) return 'limite fisso';
	if (typeof setting === 'string' && setting !== 'auto' && !Number.isNaN(parseInt(setting, 10))) return 'limite fisso';
	if (!stats) return 'valori predefiniti';
	if (stats.memoryPressure === 'critical' || stats.thermal === 'critical') return 'Mac sotto sforzo';
	if (stats.memoryPressure === 'warning') return 'memoria sotto pressione';
	if (stats.thermal === 'serious') return 'Mac caldo';
	return 'memoria tranquilla';
}

function defaultPpidOf(pid: number): Promise<number | undefined> {
	return new Promise(resolve => {
		execFile('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 4000 }, (err, stdout) => {
			if (err) return resolve(undefined);
			const n = parseInt(stdout.trim(), 10);
			resolve(Number.isNaN(n) ? undefined : n);
		});
	});
}

const norm = (p: string) => p.toLowerCase().replace(/\/+$/, '');

export class JobManager {
	private jobs: Job[] = [];
	private readonly terminals = new Map<string, vscode.Terminal>();
	private readonly shellPids = new Map<string, number>();
	/** Chi era occupato almeno una volta: serve per il passaggio busy -> "ti aspetta". */
	private readonly wasBusy = new Set<string>();
	private readonly ppidCache = new Map<number, number | undefined>();
	private readonly notified = new Set<string>();
	private seq = 0;

	constructor(
		private readonly ctx: vscode.ExtensionContext,
		private readonly deps: JobDeps,
	) {
		if (!this.deps.ppidOf) {
			(this.deps as any).ppidOf = defaultPpidOf;
		}
		this.restore();
	}

	list(): Job[] {
		return this.jobs.map(j => ({ ...j }));
	}

	private persist(): void {
		const data = {
			jobs: this.jobs,
			shellPids: Object.fromEntries(this.shellPids),
			wasBusy: [...this.wasBusy],
		};
		void this.ctx.globalState.update(GLOBAL_KEY, data);
	}

	private changed(): void {
		this.persist();
		this.deps.onChange();
		this.paintMenubar();
	}

	private paintMenubar(): void {
		const busy = this.jobs.filter(j => j.status === 'in corso').length;
		const waiting = this.jobs.filter(j => j.status === 'ti aspetta').length;
		const queued = this.jobs.filter(j => j.status === 'in coda').length;
		this.deps.updateMenubar({ busy, waiting, queued });
	}

	private restore(): void {
		const data = this.ctx.globalState.get<any>(GLOBAL_KEY);
		if (!data || !Array.isArray(data.jobs)) return;
		this.jobs = data.jobs as Job[];
		for (const [k, v] of Object.entries(data.shellPids ?? {})) this.shellPids.set(k, v as number);
		for (const id of data.wasBusy ?? []) this.wasBusy.add(id);
		const maxSeq = this.jobs.reduce((m, j) => Math.max(m, parseInt(j.id.split('-')[1] || '0', 10) || 0), 0);
		this.seq = maxSeq;
		// Ricollega i terminali ancora vivi, altrimenti segna "finito".
		void this.reattach();
	}

	private async reattach(): Promise<void> {
		const terms = vscode.window.terminals;
		const pids = await Promise.all(terms.map(async t => [t, await t.processId] as const));
		for (const job of this.jobs) {
			if (!active.has(job.status)) continue;
			if (job.status === 'in coda' || job.status === 'stanotte') continue; // non era ancora partito: lo ripromuoveremo
			const shellPid = this.shellPids.get(job.id);
			const hit = shellPid ? pids.find(([, p]) => p === shellPid) : undefined;
			if (hit) {
				this.terminals.set(job.id, hit[0]);
			} else {
				job.status = 'finito';
				job.endedAt = job.endedAt ?? Date.now();
			}
		}
		this.changed();
		this.promote();
	}

	private newId(): string {
		return `job-${++this.seq}`;
	}

	/** Avvia un lavoro (o lo mette in coda se non c'e' uno slot libero). */
	start(projectPath: string, task: string, opts: { night?: boolean } = {}): Job {
		const job: Job = {
			id: this.newId(),
			project: path.basename(projectPath) || '~',
			path: projectPath,
			task,
			status: opts.night ? 'stanotte' : 'in coda',
			createdAt: Date.now(),
			...(opts.night ? { night: true } : {}),
		};
		this.jobs.unshift(job);
		this.changed();
		this.promote();
		return job;
	}

	private runningCount(): number {
		return this.jobs.filter(j => j.status === 'in corso' || j.status === 'ti aspetta').length;
	}

	/** Fa partire i lavori in coda finche' ci sono slot liberi. */
	private promote(): void {
		const limit = computeLimit(this.deps.maxParallelSetting(), this.deps.systemStats());
		// La coda parte dai piu' vecchi.
		const queue = this.jobs.filter(j => j.status === 'in coda').sort((a, b) => a.createdAt - b.createdAt);
		for (const job of queue) {
			if (this.runningCount() >= limit) break;
			this.launch(job);
		}
		this.paintMenubar();
	}

	/** Fa partire adesso un lavoro della notte, con il suo preambolo e il modo di permessi della notte. */
	launchNight(id: string, preamble: string, permissionMode?: string): boolean {
		const job = this.jobs.find(j => j.id === id && j.status === 'stanotte');
		if (!job) return false;
		this.launch(job, preamble, permissionMode);
		return true;
	}

	private launch(job: Job, preamble = '', permissionMode?: string): void {
		const cmd = this.deps.claudeCommand() + (permissionMode ? ` --permission-mode ${shellQuote(permissionMode)}` : '');
		const term = vscode.window.createTerminal({
			name: `Lavoro ${job.project}`,
			cwd: job.path,
			location: vscode.TerminalLocation.Editor,
			iconPath: new vscode.ThemeIcon('tools'),
		});
		this.terminals.set(job.id, term);
		term.show();
		term.sendText(`${cmd} ${shellQuote(preamble + job.task)}`);
		job.status = 'in corso';
		job.startedAt = Date.now();
		void term.processId.then(pid => {
			if (typeof pid === 'number') this.shellPids.set(job.id, pid);
			this.persist();
		});
		this.changed();
	}

	/** Riconcilia stato dei lavori con il registro delle sessioni vive. */
	async reconcile(): Promise<void> {
		const live = this.deps.liveSessions();
		const claimed = new Set(this.jobs.map(j => j.sessionId).filter(Boolean));
		let dirty = false;

		for (const job of this.jobs) {
			if (job.status !== 'in corso' && job.status !== 'ti aspetta') continue;

			// Associa a una sessione se non lo e' ancora.
			if (!job.sessionId) {
				const match = await this.matchSession(job, live, claimed);
				if (match) {
					job.sessionId = match.sessionId;
					job.pid = match.pid;
					claimed.add(match.sessionId);
					dirty = true;
				}
			}

			const session = job.sessionId ? live.find(s => s.sessionId === job.sessionId) : undefined;
			if (session) {
				job.lastActivity = session.statusSince || job.lastActivity;
				if (session.status === 'busy') {
					this.wasBusy.add(job.id);
					if (job.status !== 'in corso') {
						job.status = 'in corso';
						this.notified.delete(job.id);
						dirty = true;
					}
				} else if (this.wasBusy.has(job.id) && job.status === 'in corso') {
					// Era occupato, ora e' fermo: aspetta Andrea.
					job.status = 'ti aspetta';
					dirty = true;
					this.announceWaiting(job);
				}
			}
		}

		if (dirty) this.changed();
	}

	private async matchSession(job: Job, live: LiveSession[], claimed: Set<string | undefined>): Promise<LiveSession | undefined> {
		const shellPid = this.shellPids.get(job.id);
		// Via maestra: la sessione il cui processo ha come padre la shell del terminale.
		if (shellPid) {
			for (const s of live) {
				if (claimed.has(s.sessionId)) continue;
				const ppid = await this.ppid(s.pid);
				if (ppid === shellPid) return s;
			}
		}
		// Ripiego: stessa cartella, partita dopo il lancio del lavoro.
		const startedAfter = (job.startedAt ?? 0) - 2000;
		const candidates = live
			.filter(s => !claimed.has(s.sessionId) && norm(s.cwd) === norm(job.path) && (s.startedAt ?? 0) >= startedAfter)
			.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
		return candidates[0];
	}

	private async ppid(pid: number): Promise<number | undefined> {
		if (this.ppidCache.has(pid)) return this.ppidCache.get(pid);
		const fn = this.deps.ppidOf ?? defaultPpidOf;
		const v = await fn(pid);
		this.ppidCache.set(pid, v);
		return v;
	}

	/** Da chiamare quando cambia la pressione del sistema: puo' liberare uno slot per la coda. */
	kick(): void {
		this.promote();
	}

	private announceWaiting(job: Job): void {
		if (this.notified.has(job.id)) return;
		this.notified.add(job.id);
		this.deps.notify({
			id: `job:${job.id}`,
			title: `Il lavoro su ${job.project} ti aspetta`,
			body: job.task.length > 100 ? job.task.slice(0, 100) + '...' : job.task,
			actions: [{ id: 'apri', title: 'Apri' }],
		});
	}

	/** Scrive nel terminale di un lavoro (solo lavori della Bottega). Falso se non c'e'. */
	write(id: string, text: string): boolean {
		const term = this.terminals.get(id);
		if (!term) return false;
		term.show();
		term.sendText(text);
		return true;
	}

	/** Trova un lavoro per id esatto o per nome progetto (preferendo quelli attivi). */
	resolve(idOrProject: string): Job | undefined {
		const exact = this.jobs.find(j => j.id === idOrProject);
		if (exact) return exact;
		const key = idOrProject.toLowerCase();
		const byProject = this.jobs.filter(j => j.project.toLowerCase() === key);
		return byProject.find(j => active.has(j.status)) ?? byProject[0];
	}

	/** Chiamato quando l'utente clicca l'azione della notifica o "job.focus". */
	focus(id: string): void {
		const term = this.terminals.get(id);
		if (term) {
			term.show();
		}
	}

	/** Terminale chiuso dall'utente: il lavoro e' finito. */
	onTerminalClosed(term: vscode.Terminal): void {
		for (const [id, t] of this.terminals) {
			if (t !== term) continue;
			const job = this.jobs.find(j => j.id === id);
			if (job && active.has(job.status)) {
				job.status = 'finito';
				job.endedAt = Date.now();
			}
			this.terminals.delete(id);
			this.changed();
			this.promote();
			return;
		}
	}

	/** Ferma un lavoro: chiude il terminale. La conferma la gestisce il chiamante. */
	stop(id: string): void {
		const job = this.jobs.find(j => j.id === id);
		if (!job) return;
		const term = this.terminals.get(id);
		if (term) {
			try {
				term.dispose();
			} catch {
				// gia' chiuso
			}
			this.terminals.delete(id);
		}
		if (active.has(job.status)) {
			job.status = 'fermato';
			job.endedAt = Date.now();
		}
		this.notified.delete(id);
		this.changed();
		this.promote();
	}

	/** Toglie dall'elenco un lavoro gia' terminato. */
	remove(id: string): void {
		const job = this.jobs.find(j => j.id === id);
		if (!job) return;
		if (active.has(job.status)) this.stop(id);
		this.jobs = this.jobs.filter(j => j.id !== id);
		this.shellPids.delete(id);
		this.wasBusy.delete(id);
		this.notified.delete(id);
		this.changed();
	}

	dispose(): void {
		this.persist();
	}
}

// ---------- il lavoro in giro: una sola fonte di verita' ----------

/** Per Andrea ogni sessione Claude viva e' un lavoro: quelle avviate dalla Bottega (lavori) e quelle aperte
 *  altrove (un terminale, un'altra app). Plancia, Lavori, navigazione, barra dei menu, barra di stato e Melissa
 *  contano tutte da qui. Contratto: docs/CONTRATTI.md, 4.9. */
export interface WorkItem {
	key: string; // "job:<id>" oppure "sess:<sessionId>"
	source: 'bottega' | 'altrove';
	status: 'in corso' | 'ti aspetta' | 'nel terminale' | 'in coda' | 'stanotte';
	project: string;
	path: string;
	title: string;
	since: number;
	jobId?: string;
	sessionId?: string;
	pid?: number;
	night?: boolean;
}

export interface WorkCounts {
	inCorso: number;
	tiAspetta: number;
	nelTerminale: number;
	inCoda: number;
	stanotte: number;
	/** sessioni Claude vive in tutto il Mac (in corso + ti aspetta + nel terminale) */
	vive: number;
}

const LIVE_STATUS: Record<string, WorkItem['status']> = { busy: 'in corso', idle: 'ti aspetta', shell: 'nel terminale' };

export function workItems(
	jobs: Job[],
	live: LiveSession[],
	projectOfLive: (s: LiveSession) => { name: string; path: string } | undefined,
	home = '',
): WorkItem[] {
	const out: WorkItem[] = [];
	const claimed = new Set<string>();
	for (const j of jobs) {
		if (!active.has(j.status)) continue;
		if (j.sessionId) claimed.add(j.sessionId);
		const s = j.sessionId ? live.find(x => x.sessionId === j.sessionId) : undefined;
		out.push({
			key: `job:${j.id}`,
			source: 'bottega',
			status: j.status as WorkItem['status'],
			project: j.project,
			path: j.path,
			title: j.task.split('\n')[0].slice(0, 140),
			since: j.status === 'in coda' || j.status === 'stanotte' ? j.createdAt : j.lastActivity || j.startedAt || j.createdAt,
			jobId: j.id,
			...(j.sessionId ? { sessionId: j.sessionId } : {}),
			...(s ? { pid: s.pid } : j.pid ? { pid: j.pid } : {}),
			...(j.night ? { night: true } : {}),
		});
	}
	// un lavoro appena partito non ha ancora la sua sessione: quella nella stessa cartella, nata dopo, e' sua
	const pending = jobs.filter(j => !j.sessionId && (j.status === 'in corso' || j.status === 'ti aspetta'));
	for (const s of live) {
		if (claimed.has(s.sessionId)) continue;
		if (pending.some(j => norm(s.cwd) === norm(j.path) && (s.startedAt ?? 0) >= (j.startedAt ?? 0) - 2000)) continue;
		const p = projectOfLive(s);
		out.push({
			key: `sess:${s.sessionId}`,
			source: 'altrove',
			status: LIVE_STATUS[s.status] ?? 'nel terminale',
			project: p ? p.name : s.cwd === home ? 'home' : path.basename(s.cwd),
			path: p ? p.path : s.cwd,
			title: s.title ?? s.name ?? '',
			since: s.statusSince || s.startedAt || 0,
			sessionId: s.sessionId,
			pid: s.pid,
		});
	}
	const order: Record<WorkItem['status'], number> = { 'ti aspetta': 0, 'in corso': 1, 'nel terminale': 2, 'in coda': 3, stanotte: 4 };
	return out.sort((a, b) => order[a.status] - order[b.status] || b.since - a.since);
}

export function workCounts(items: WorkItem[]): WorkCounts {
	const c: WorkCounts = { inCorso: 0, tiAspetta: 0, nelTerminale: 0, inCoda: 0, stanotte: 0, vive: 0 };
	for (const w of items) {
		if (w.status === 'in corso') c.inCorso++;
		else if (w.status === 'ti aspetta') c.tiAspetta++;
		else if (w.status === 'nel terminale') c.nelTerminale++;
		else if (w.status === 'in coda') c.inCoda++;
		else if (w.status === 'stanotte') c.stanotte++;
		if (w.status === 'in corso' || w.status === 'ti aspetta' || w.status === 'nel terminale') c.vive++;
	}
	return c;
}
