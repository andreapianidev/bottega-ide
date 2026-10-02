/* La coda della notte: lavori messi in fila di giorno che partono nella finestra notturna (default 01:00-06:00),
   uno o due alla volta, solo se il Mac e' alla corrente e la memoria e' tranquilla. Mentre ne gira almeno uno il
   Nucleo tiene un'asserzione che non fa addormentare il Mac (IOKit), rilasciata alla fine. Al mattino il resoconto
   (dalla Memoria) entra nel briefing. Contratto: docs/CONTRATTI.md, 4.1 (NightState) e 4.4 (power.*). */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Job } from './jobs';
import type { SystemStats } from './nucleo';

export interface NightConfig {
	from: string;
	to: string;
	parallel: number;
}

export interface NightReport {
	date: string;
	jobs: { id: string; project: string; task: string; status: string; summary?: string }[];
}

export interface NightState extends NightConfig {
	queued: number;
	running: number;
	ac: boolean | null;
	why: string;
	report: NightReport | null;
}

export interface NightDeps {
	jobs(): Job[];
	launch(id: string, preamble: string): boolean;
	systemStats(): SystemStats | undefined;
	/** Stato dell'alimentazione dal Nucleo; undefined se il Nucleo non risponde. */
	power(): Promise<{ ac: boolean } | undefined>;
	keepAwake(reason: string): Promise<string | undefined>;
	release(token: string): void;
	/** Riassunto della sessione dalla Memoria, se c'e'. */
	summary(sessionId: string): Promise<string | undefined>;
	onChange(): void;
	log?(s: string): void;
}

export const NIGHT_FILE = path.join(os.homedir(), '.bottega', 'notte.json');

/** Quello che ogni lavoro notturno legge prima del suo compito. */
export const NIGHT_PREAMBLE =
	'Lavoro notturno della Bottega: lavori da solo mentre Andrea dorme. Regole per stanotte: niente git push, niente ' +
	'pubblicazioni, niente deploy, niente invii a store o servizi esterni, niente messaggi a nessuno. Fai i commit in ' +
	'locale (con il numero di build che sale, se il progetto lo chiede) e alla fine scrivi in poche righe cosa hai fatto ' +
	'e cosa resta. Se ti serve una decisione di Andrea, fermati e scrivila chiaramente. Il compito:\n\n';

const DEFAULT: NightConfig = { from: '01:00', to: '06:00', parallel: 1 };

const minutesOf = (hhmm: string) => {
	const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
	return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : -1;
};

/** Vero se l'ora locale di `t` cade nella finestra (che puo' scavalcare la mezzanotte). */
export function inWindow(cfg: NightConfig, t = Date.now()): boolean {
	const d = new Date(t);
	const now = d.getHours() * 60 + d.getMinutes();
	const a = minutesOf(cfg.from);
	const b = minutesOf(cfg.to);
	if (a < 0 || b < 0 || a === b) return false;
	return a < b ? now >= a && now < b : now >= a || now < b;
}

/** La data della notte a cui appartiene un istante: un lavoro delle 02:00 del 3 ottobre e' della notte del 2. */
export function nightDate(t: number): string {
	const d = new Date(t);
	const day = d.getHours() < 12 ? new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1) : d;
	return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

export function cleanConfig(c: any): NightConfig {
	const from = minutesOf(c?.from) >= 0 ? String(c.from).padStart(5, '0') : DEFAULT.from;
	const to = minutesOf(c?.to) >= 0 ? String(c.to).padStart(5, '0') : DEFAULT.to;
	const parallel = Number(c?.parallel) === 2 ? 2 : 1;
	return { from, to, parallel };
}

export class NightScheduler {
	private cfg: NightConfig = { ...DEFAULT };
	private report: NightReport | null = null;
	private ac: boolean | null = null;
	private token?: string;
	private why = '';
	/** Lavori partiti di notte: id -> istante di partenza (per il resoconto del mattino). */
	private started: Record<string, number> = {};
	private ticking = false;

	constructor(private readonly deps: NightDeps, private readonly file = NIGHT_FILE) {
		try {
			const d = JSON.parse(fs.readFileSync(file, 'utf8'));
			this.cfg = cleanConfig(d);
			this.report = d.report ?? null;
			this.started = d.started ?? {};
		} catch {
			// prima volta
		}
	}

	private save(): void {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
			fs.writeFileSync(this.file, JSON.stringify({ ...this.cfg, report: this.report, started: this.started }, null, 2) + '\n', { mode: 0o600 });
		} catch (e) {
			this.deps.log?.(`notte: non riesco a salvare ${this.file}: ${e}`);
		}
	}

	config(): NightConfig {
		return { ...this.cfg };
	}

	setConfig(c: Partial<NightConfig>): void {
		this.cfg = cleanConfig({ ...this.cfg, ...c });
		this.save();
		this.deps.onChange();
		void this.tick();
	}

	setPower(ac: boolean | null): void {
		if (this.ac === ac) return;
		this.ac = ac;
		void this.tick();
	}

	state(now = Date.now()): NightState {
		const jobs = this.deps.jobs();
		return {
			...this.cfg,
			queued: jobs.filter(j => j.status === 'stanotte').length,
			running: jobs.filter(j => j.night && (j.status === 'in corso' || j.status === 'ti aspetta')).length,
			ac: this.ac,
			why: this.why || this.explain(now),
			report: this.report,
		};
	}

	private explain(now: number): string {
		const queued = this.deps.jobs().filter(j => j.status === 'stanotte').length;
		if (!queued) return `Nessun lavoro in fila per stanotte. La finestra va dalle ${this.cfg.from} alle ${this.cfg.to}.`;
		if (!inWindow(this.cfg, now)) return `${queued === 1 ? 'Un lavoro aspetta' : `${queued} lavori aspettano`} la notte: partono dalle ${this.cfg.from}, ${this.cfg.parallel === 1 ? 'uno alla volta' : 'due alla volta'}, se il Mac è alla corrente.`;
		return 'È notte: i lavori partono appena il Mac è pronto.';
	}

	/** Un giro: decide se far partire lavori, tiene sveglio il Mac, chiude il resoconto. Costa pochissimo. */
	async tick(now = Date.now()): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const jobs = this.deps.jobs();
			const queued = jobs.filter(j => j.status === 'stanotte').sort((a, b) => a.createdAt - b.createdAt);
			const running = jobs.filter(j => j.night && (j.status === 'in corso' || j.status === 'ti aspetta'));
			let why = '';
			if (queued.length && inWindow(this.cfg, now)) {
				const p = await this.deps.power().catch(() => undefined);
				if (p) this.ac = p.ac;
				const sys = this.deps.systemStats();
				if (!p) why = 'È notte, ma senza il Nucleo non so se il Mac è alla corrente: aspetto.';
				else if (!p.ac) why = 'È notte, ma il Mac va a batteria: i lavori aspettano la corrente.';
				else if (sys && sys.memoryPressure !== 'normal') why = 'È notte, ma la memoria è sotto pressione: aspetto che si calmi.';
				else if (sys && (sys.thermal === 'serious' || sys.thermal === 'critical')) why = 'È notte, ma il Mac scalda: aspetto che si raffreddi.';
				else {
					let free = this.cfg.parallel - running.length;
					for (const j of queued) {
						if (free <= 0) break;
						if (this.deps.launch(j.id, NIGHT_PREAMBLE)) {
							this.started[j.id] = now;
							free--;
							this.deps.log?.(`notte: partito ${j.id} su ${j.project}`);
						}
					}
					this.save();
				}
			}
			this.why = why;
			await this.holdAwake();
			await this.closeReport(now);
			this.deps.onChange();
		} finally {
			this.ticking = false;
		}
	}

	/** Lavoro notturno partito a mano («Parti adesso»). */
	startNow(id: string, now = Date.now()): boolean {
		const ok = this.deps.launch(id, NIGHT_PREAMBLE);
		if (ok) {
			this.started[id] = now;
			this.save();
			void this.holdAwake();
		}
		return ok;
	}

	private async holdAwake(): Promise<void> {
		const busy = this.deps.jobs().some(j => j.night && j.status === 'in corso' && this.started[j.id]);
		if (busy && !this.token) {
			this.token = await this.deps.keepAwake('La Bottega sta facendo un lavoro della notte').catch(() => undefined);
		} else if (!busy && this.token) {
			this.deps.release(this.token);
			this.token = undefined;
		}
	}

	/** Fuori dalla finestra, i lavori partiti nella notte appena passata diventano il resoconto del mattino. */
	private async closeReport(now: number): Promise<void> {
		if (inWindow(this.cfg, now)) return;
		const ids = Object.keys(this.started);
		if (!ids.length) return;
		const jobs = this.deps.jobs();
		// si chiude quando nessuno dei lavori della notte sta ancora lavorando
		if (ids.some(id => jobs.find(j => j.id === id)?.status === 'in corso')) return;
		const date = nightDate(Math.min(...ids.map(id => this.started[id])));
		const rows: NightReport['jobs'] = [];
		for (const id of ids) {
			const j = jobs.find(x => x.id === id);
			if (!j) continue;
			const summary = j.sessionId ? await this.deps.summary(j.sessionId).catch(() => undefined) : undefined;
			rows.push({ id, project: j.project, task: j.task.slice(0, 200), status: j.status, ...(summary ? { summary } : {}) });
		}
		this.report = { date, jobs: rows };
		this.started = {};
		this.save();
	}

	dispose(): void {
		if (this.token) this.deps.release(this.token);
		this.token = undefined;
	}
}
