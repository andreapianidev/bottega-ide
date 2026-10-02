/* Le otto idee messe insieme: regole, radar, briefing, consigli, continua, clienti, notte, dimenticati e ricerca,
   piu' quello che le porta fuori dalla webview (barra dei menu, notifiche, Spotlight, stato per App Intents e
   widget, schema URL bottega://). extension.ts crea un'istanza e la chiama in pochi punti.
   Contratto: docs/CONTRATTI.md, sezione 4. */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Assistant } from './assistant';
import {
	ADVICE_INSTRUCTIONS, Advice, adviceCandidates, adviceFacts, Briefing, BRIEFING_INSTRUCTIONS, BriefingMemory, briefingPoints,
	Facts, factsForModel, parseAdvice, briefingFrame, briefingText, readBriefing, ruleAdvice, storeMemory, today, writeBriefing,
} from './briefing';
import { buildReport, monthName, readClients, toCsv, toMarkdown, writeClients } from './clienti';
import { prepareContinuation } from './continua';
import { findForgotten, Forgotten } from './dimenticati';
import type { Job, JobManager } from './jobs';
import type { Memoria } from './memoria';
import { NightScheduler, NightState } from './notte';
import type { Nucleo } from './nucleo';
import { Radar } from './radar';
import { RulesEngine } from './regole';
import { whereSolved } from './ricerca';
import type { Project } from './scan';
import type { Stats, StatsEngine } from './stats';
import type { RadarState, RuleAction, RulesState } from './tipi';

export interface IdeeDynamic {
	rules: RulesState;
	radar: RadarState;
	briefing: Briefing | null;
	forgotten: Forgotten[];
	night: NightState;
	advice: Advice | null;
}

export interface IdeeHost {
	projects(): Project[];
	live(): { pid: number; sessionId: string; cwd: string; status: string; statusSince: number; startedAt: number; title?: string; name?: string }[];
	/** I conteggi del lavoro in giro (jobs.ts, workCounts): la stessa fonte della Home e di Melissa. */
	workCounts(): import('./jobs').WorkCounts;
	/** Tutto il lavoro in giro, prima chi ti aspetta (jobs.ts, workItems): per il widget e per Siri. */
	work?(): import('./jobs').WorkItem[];
	nucleo: Nucleo;
	memoria: Memoria;
	jobs: JobManager;
	assistant: () => Assistant | undefined;
	stats: StatsEngine;
	/** Manda un messaggio alla Home (se aperta). */
	send(msg: unknown): void;
	/** Apre la Home, eventualmente su una stanza o un progetto. */
	showHome(view?: string, focusPath?: string): void;
	push(path: string): void;
	openProject(path: string): void;
	refresh(): void;
	log(s: string): void;
	/** I soldi delle app dalla stanza App Store, per il briefing (null se i dati sono vecchi). */
	appstore?(): import('./appstore').BriefingAppStore | null;
}

const URI_AUTHORITY = 'andreapiani.bottega-home';
export const bottegaUrl = (route: string, q: Record<string, string> = {}) => {
	const qs = new URLSearchParams(q).toString();
	return `bottega://${URI_AUTHORITY}/${route}${qs ? '?' + qs : ''}`;
};

const STATO_FILE = path.join(os.homedir(), '.bottega', 'stato.json');
const HOUR = 3_600_000;
const cfg = () => vscode.workspace.getConfiguration('bottega');

function money(n: number, cur = 'USD'): string {
	return n.toLocaleString('it-IT', { style: 'currency', currency: cur, maximumFractionDigits: n < 100 ? 2 : 0 });
}

export class Idee {
	readonly rules: RulesEngine;
	readonly radar: Radar;
	readonly night: NightScheduler;
	private briefing: Briefing | null;
	private briefingMemory?: BriefingMemory;
	private advice: Advice | null;
	private forgotten: Forgotten[] = [];
	private making = false;
	private advising = false;
	private menubarCounts = { busy: 0, waiting: 0, queued: 0 };
	private spotlightSig = '';
	private memoriesIndexedAt = 0;
	private writeTimer?: NodeJS.Timeout;
	private timers: NodeJS.Timeout[] = [];
	private lastStats: Stats | null = null;
	private rulesSig = '';
	private rulesAt = 0;

	constructor(private readonly h: IdeeHost) {
		this.rules = new RulesEngine({ log: h.log, radar: () => this.radar?.state() });
		this.radar = new Radar({ log: h.log });
		this.night = new NightScheduler({
			jobs: () => h.jobs.list(),
			launch: (id, preamble) => {
				const mode = cfg().get<string>('notte.permessi', 'acceptEdits');
				return h.jobs.launchNight(id, preamble, mode === 'default' ? undefined : mode);
			},
			systemStats: () => h.nucleo.lastStats,
			power: async () => (h.nucleo.available ? h.nucleo.request<{ ac: boolean }>('power.status', {}, 4000) : undefined),
			keepAwake: async reason => (await h.nucleo.request<{ token: string }>('power.keepAwake', { reason }, 4000))?.token,
			release: token => h.nucleo.fireAndForget('power.release', { token }),
			summary: async sid => {
				const d = await h.memoria.session(sid);
				const r = d?.memories.find(m => m.kind === 'riassunto');
				return r ? `${r.title}. ${r.text.split('\n')[0].slice(0, 300)}` : undefined;
			},
			onChange: () => this.changed(),
			log: h.log,
		});
		const saved = readBriefing();
		this.briefing = saved.briefing;
		this.briefingMemory = saved.memory;
		this.advice = saved.advice ?? null;
		this.rules.onChange(() => this.changed());
		this.radar.onChange(() => {
			this.changed();
			// lo stato di una versione su App Store Connect entra nella regola del rilascio
			void this.rules.check(h.projects());
		});
	}

	start(ctx: vscode.ExtensionContext): void {
		const n = this.h.nucleo;
		n.on('power.changed', (m: any) => this.night.setPower(typeof m?.ac === 'boolean' ? m.ac : null));
		n.on('notify.clicked', (m: any) => {
			if (m?.id !== 'bottega:briefing' || m.action === 'dismiss') return;
			this.h.showHome('plancia');
			if (m.action === 'ascolta' || !m.action) void this.listen();
		});
		n.on('menubar.clicked', (m: any) => {
			const item = String(m?.item ?? '');
			if (item === 'regole' || item === 'soldi') this.h.showHome('vedetta');
			else if (item === 'briefing') {
				this.h.showHome('plancia');
				void this.listen();
			} else if (item === 'open') this.h.showHome('plancia');
		});
		this.timers.push(
			setInterval(() => void this.night.tick(), 5 * 60_000),
			// il radar si aggiorna da solo ogni 45 minuti (il controllo vero lo fa Radar.refresh)
			setInterval(() => void this.radar.refresh(this.h.projects()), 15 * 60_000),
		);
		ctx.subscriptions.push(
			{ dispose: () => this.dispose() },
			vscode.window.registerUriHandler({ handleUri: uri => void this.handleUri(uri) }),
			vscode.window.onDidChangeWindowState(s => s.focused && void this.ensureBriefing()),
		);
		void this.night.tick();
	}

	dispose(): void {
		for (const t of this.timers) clearInterval(t);
		this.night.dispose();
	}

	dynamic(): IdeeDynamic {
		return {
			rules: this.rules.state(),
			radar: this.radar.state(),
			briefing: this.briefing,
			forgotten: this.forgotten,
			night: this.night.state(),
			advice: this.advice,
		};
	}

	private changed(): void {
		this.h.refresh();
		this.paintMenubar();
		clearTimeout(this.writeTimer);
		this.writeTimer = setTimeout(() => this.writeStato(), 2000);
	}

	/** Dopo ogni scansione dei progetti: regole (incrementali), radar (si limita da solo), dimenticati, Spotlight. */
	afterScan(): void {
		const projects = this.h.projects();
		this.forgotten = findForgotten(projects, this.h.jobs.list());
		// Le regole git dipendono solo da commit, upstream e commit da spingere: si ricontrolla quando uno di
		// questi cambia in un progetto, altrimenti al massimo ogni 15 minuti (app-ads, GitHub e radar hanno le loro cache).
		const sig = projects.map(p => `${p.path}:${p.git?.lastCommitAt ?? 0}:${p.git?.ahead ?? 0}:${p.git?.upstream ? 1 : 0}`).join('|');
		const due = sig !== this.rulesSig || Date.now() - this.rulesAt > 15 * 60_000;
		if (due) {
			this.rulesSig = sig;
			this.rulesAt = Date.now();
		}
		void (due ? this.rules.check(projects) : Promise.resolve(this.rules.state())).then(() => {
			void this.ensureBriefing();
			void this.maybeAdvice(false);
		});
		void this.radar.refresh(projects);
		void this.indexSpotlight(projects);
		this.changed();
	}

	// ---------- barra dei menu e stato per App Intents e widget ----------

	/** I numeri della barra dei menu vengono dal lavoro in giro (tutte le sessioni vive, non solo i lavori
	 *  della Bottega): gli stessi della Home e di Melissa. `_counts` (dal gestore dei lavori) e' ignorato. */
	paintMenubar(_counts?: { busy: number; waiting: number; queued: number }): void {
		const w = this.h.workCounts();
		this.menubarCounts = { busy: w.inCorso, waiting: w.tiAspetta, queued: w.inCoda + w.stanotte };
		const r = this.rules.state();
		const lines: { id?: string; title: string; tone?: string }[] = [];
		if (r.counts.rosso || r.counts.giallo) {
			lines.push({
				id: 'regole',
				title: r.counts.rosso ? `${r.counts.rosso === 1 ? 'Una regola rossa' : `${r.counts.rosso} regole rosse`}${r.counts.giallo ? `, ${r.counts.giallo} in giallo` : ''}` : `${r.counts.giallo === 1 ? 'Un progetto' : `${r.counts.giallo} progetti`} in giallo`,
				tone: r.counts.rosso ? 'rosso' : 'giallo',
			});
		}
		const t = this.radar.state().totals;
		if (t) lines.push({ id: 'soldi', title: `AdMob ieri ${money(t.yesterday, t.currency)}, sette giorni ${money(t.last7, t.currency)}` });
		if (this.briefing && this.briefing.date === today()) lines.push({ id: 'briefing', title: this.briefing.heard ? 'Riascolta il briefing' : 'Ascolta il briefing di oggi' });
		const tone = r.counts.rosso ? 'rosso' : r.counts.giallo ? 'giallo' : null;
		this.h.nucleo.fireAndForget('menubar.update', { ...this.menubarCounts, lines, tone });
	}

	private writeStato(): void {
		// Le ore del giorno vengono dal cruscotto: ricalcolate al massimo ogni 5 minuti (solo i file cambiati).
		if (!this.lastStats || Date.now() - this.lastStats.computedAt > 5 * 60_000) {
			this.h.stats.compute({ projects: this.h.projects(), live: this.h.live() })
				.then(st => (this.lastStats = st), () => undefined)
				.finally(() => this.writeStatoNow());
			return;
		}
		this.writeStatoNow();
	}

	private writeStatoNow(): void {
		const r = this.rules.state();
		const voci: { progetto: string; livello: string; frase: string }[] = [];
		for (const pr of Object.values(r.projects)) {
			for (const hit of pr.hits) voci.push({ progetto: this.h.projects().find(p => p.path === pr.path)?.name ?? path.basename(pr.path), livello: hit.livello, frase: hit.frase });
		}
		voci.sort((a, b) => (a.livello === b.livello ? 0 : a.livello === 'rosso' ? -1 : 1));
		const rad = this.radar.state();
		const w = this.h.workCounts();
		const st = this.lastStats;
		const round = (n: number | undefined) => Math.round(n ?? 0);
		const data = {
			aggiornato: Date.now(),
			briefing: this.briefing ? { date: this.briefing.date, text: this.briefing.text } : null,
			regole: { ...r.counts, voci: voci.slice(0, 12) },
			soldi: rad.totals ? { ieri: rad.totals.yesterday, sette: rad.totals.last7, valuta: rad.totals.currency, aggiornato: rad.admobAt } : null,
			lavori: {
				inCorso: w.inCorso, tiAspetta: w.tiAspetta, nelTerminale: w.nelTerminale, inCoda: w.inCoda, stanotte: w.stanotte, vive: w.vive,
				// Widget "Oggi" e Siri (CosaMiAspetta, LavoroEntity): docs/CONTRATTI.md, 7.5.
				voci: (this.h.work?.() ?? []).slice(0, 20).map(x => ({ key: x.key, progetto: x.project, path: x.path, titolo: x.title, stato: x.status, da: x.since })),
			},
			ore: st ? {
				oggi: round(st.today.you),
				ieri: round(st.days[st.days.length - 2]?.you),
				settimana: round(st.week.now.you),
				giorni: st.days.slice(-7).map(d => ({ date: d.date, minuti: round(d.you) })),
			} : null,
			progetti: this.h.projects().filter(p => p.git).map(p => ({
				nome: p.name, path: p.path, ramo: p.git!.branch, daSpingere: p.git!.ahead, modifiche: p.git!.changes,
				livello: r.projects[p.path]?.livello ?? null, ultima: p.touchedAt,
			})),
		};
		try {
			fs.mkdirSync(path.dirname(STATO_FILE), { recursive: true, mode: 0o700 });
			const tmp = STATO_FILE + '.tmp';
			fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
			fs.renameSync(tmp, STATO_FILE);
			this.h.nucleo.fireAndForget('widget.reload');
		} catch (e) {
			this.h.log(`stato.json: ${e}`);
		}
	}

	// ---------- Spotlight ----------

	private async indexSpotlight(projects: Project[]): Promise<void> {
		if (!this.h.nucleo.available) return;
		const sig = projects.map(p => p.path).join('|');
		if (sig !== this.spotlightSig) {
			this.spotlightSig = sig;
			const items = projects.map(p => ({
				id: p.path,
				kind: 'progetto',
				title: p.name,
				text: `Progetto nella Bottega, ${p.path.replace(os.homedir(), '~')}`,
				url: bottegaUrl('progetto', { path: p.path }),
				keywords: [p.name, 'Bottega', ...p.kinds],
				date: p.touchedAt,
			}));
			await this.h.nucleo.request('spotlight.index', { items, replace: true }, 15_000).catch(e => this.h.log(`spotlight progetti: ${e?.message ?? e}`));
		}
		if (Date.now() - this.memoriesIndexedAt < 6 * HOUR) return;
		this.memoriesIndexedAt = Date.now();
		const mems = await this.h.memoria.recent(undefined, { kinds: ['riassunto', 'decisione'], limit: 300 });
		if (!mems.length) return;
		const items = mems.map(m => ({
			id: String(m.id),
			kind: 'ricordo',
			title: `${m.project}: ${m.title}`,
			text: m.text.slice(0, 400),
			url: bottegaUrl('ricordo', { id: String(m.id), q: m.title }),
			keywords: [m.project, 'Bottega', 'memoria'],
			date: m.createdAt,
		}));
		await this.h.nucleo.request('spotlight.index', { items, replace: true }, 20_000).catch(e => this.h.log(`spotlight ricordi: ${e?.message ?? e}`));
	}

	// ---------- fatti, briefing e consigli ----------

	private async facts(): Promise<Facts> {
		try {
			this.lastStats = await this.h.stats.compute({ projects: this.h.projects(), live: this.h.live() });
		} catch {
			// senza registri di Claude Code il briefing va avanti senza ore
		}
		return {
			stats: this.lastStats,
			jobs: this.h.jobs.list(),
			radar: this.radar.state(),
			rules: this.rules.state(),
			forgotten: this.forgotten,
			night: this.night.state(),
			projects: this.h.projects().map(p => ({ name: p.name, path: p.path })),
			seen: this.briefingMemory,
			appstore: this.h.appstore?.() ?? null,
		};
	}

	/** Una volta al giorno, dalle 5 del mattino, quando i dati ci sono: fa il briefing e lo dice (una volta). */
	async ensureBriefing(): Promise<void> {
		const now = new Date();
		if (this.briefing?.date === today() || now.getHours() < 5 || this.making) return;
		if (!this.h.projects().length || !this.rules.state().checkedAt) return;
		await this.makeBriefing(true);
	}

	async makeBriefing(announce: boolean): Promise<Briefing | null> {
		if (this.making) return this.briefing;
		this.making = true;
		try {
			const f = await this.facts();
			const points = briefingPoints(f);
			const a = this.h.assistant();
			const composed = a ? await a.compose(BRIEFING_INSTRUCTIONS, factsForModel(points), 120) : null;
			const text = briefingText(points, composed ? briefingFrame(composed.text) : null);
			this.briefing = { date: today(), at: Date.now(), text, points, heard: false };
			this.briefingMemory = storeMemory(this.radar.state());
			writeBriefing({ briefing: this.briefing, memory: this.briefingMemory, advice: this.advice });
			this.changed();
			if (announce) {
				if (vscode.window.state.focused && cfg().get('briefing.voce', true) && cfg().get('voice.enabled', true)) {
					void this.listen();
				} else {
					this.h.nucleo.fireAndForget('notify', {
						id: 'bottega:briefing',
						title: 'Il briefing di oggi è pronto',
						body: points[0]?.text ?? 'Niente di urgente.',
						actions: [{ id: 'ascolta', title: 'Ascolta' }],
						sound: false,
					});
				}
			}
			return this.briefing;
		} finally {
			this.making = false;
		}
	}

	async listen(): Promise<void> {
		const b = this.briefing ?? (await this.makeBriefing(false));
		if (!b) return;
		this.setHeard(true);
		await this.h.assistant()?.announce(b.text);
	}

	setHeard(v: boolean): void {
		if (!this.briefing) return;
		this.briefing = { ...this.briefing, heard: v };
		writeBriefing({ briefing: this.briefing, memory: this.briefingMemory, advice: this.advice });
		this.changed();
	}

	private adviceSig(): string {
		const r = this.rules.state().counts;
		const jobs = this.h.jobs.list();
		return [r.rosso, r.giallo, jobs.filter(j => j.status === 'ti aspetta').length, this.forgotten.length, Math.round(this.radar.state().totals?.yesterday ?? 0)].join(':');
	}
	private adviceSigAt = '';

	/** Consigli della Home: Apple Intelligence sul Mac, al massimo ogni 3 ore o quando il quadro cambia molto. */
	async maybeAdvice(force: boolean): Promise<void> {
		if (this.advising) return;
		const sig = this.adviceSig();
		const age = this.advice ? Date.now() - this.advice.at : Infinity;
		if (!force && (age < 20 * 60_000 || (age < 3 * HOUR && sig === this.adviceSigAt))) return;
		if (!this.rules.state().checkedAt) return;
		this.advising = true;
		try {
			const f = await this.facts();
			const cands = adviceCandidates(f, briefingPoints(f));
			let items: Advice['items'] = [];
			let engine: Advice['engine'] = 'regole';
			if (cands.length && cfg().get('consigli.apple', true) && this.h.nucleo.available) {
				try {
					const r = await this.h.nucleo.request<{ text: string }>('ai.generate', { prompt: adviceFacts(cands), instructions: ADVICE_INSTRUCTIONS, maxTokens: 60 }, 40_000);
					items = parseAdvice(r?.text ?? '', cands);
					if (items.length >= 2) engine = 'apple';
				} catch (e: any) {
					this.h.log(`consigli: Apple Intelligence non risponde (${e?.message ?? e})`);
				}
			}
			if (engine !== 'apple') items = ruleAdvice(cands);
			this.advice = { at: Date.now(), engine, items };
			this.adviceSigAt = sig;
			writeBriefing({ briefing: this.briefing, memory: this.briefingMemory, advice: this.advice });
			this.changed();
		} finally {
			this.advising = false;
		}
	}

	// ---------- messaggi dalla Home ----------

	/** Vero se il messaggio era di una delle otto idee. */
	async handle(m: any): Promise<boolean> {
		const projects = this.h.projects();
		const byPath = (p?: string) => projects.find(x => x.path === p);
		switch (m.type) {
			case 'rules.refresh':
				void this.rules.check(projects, { force: true });
				return true;
			case 'rule.fix':
				if (m.rule === 'rilascio' && m.path) await this.fixRelease(m.path);
				return true;
			case 'job.prepare':
				this.h.showHome('lavori');
				this.h.send({ type: 'composer', path: m.path, task: m.task ?? '' });
				return true;
			case 'radar.refresh':
				void this.radar.refresh(projects, { force: true });
				return true;
			case 'briefing.listen':
				void this.listen();
				return true;
			case 'briefing.make':
				void this.makeBriefing(false);
				return true;
			case 'briefing.dismiss':
				this.setHeard(true);
				return true;
			case 'advice.refresh':
				void this.maybeAdvice(true);
				return true;
			case 'continua.prepare': {
				const p = byPath(m.path);
				if (!p) return true;
				const c = await prepareContinuation(p, { recent: (name, o) => this.h.memoria.recent(name, o) });
				this.h.send({ type: 'continua', ...c });
				return true;
			}
			case 'notte.config':
				this.night.setConfig({ from: m.from, to: m.to, parallel: Number(m.parallel) });
				return true;
			case 'notte.now':
				if (m.id) this.night.startNow(m.id);
				return true;
			case 'clients.request':
			case 'clients.save': {
				if (m.type === 'clients.save' && Array.isArray(m.clients)) writeClients(m.clients);
				await this.ensureLedger();
				this.h.send({ type: 'clients', report: buildReport(this.h.stats.lastLedger, readClients(), projects, m.month) });
				return true;
			}
			case 'clients.export':
				await this.exportClients(m.month, m.format === 'md' ? 'md' : 'csv');
				return true;
			case 'ricerca': {
				const q = String(m.query ?? '').trim();
				if (!q) return true;
				const r = await whereSolved(q, projects.map(p => ({ name: p.name, path: p.path })), qq => this.h.memoria.searchMany(qq, 20));
				this.h.send({ type: 'ricerca', ...r });
				return true;
			}
			case 'bacheca.sessione': {
				const sid = String(m.sessionId ?? '');
				const items = (await this.h.memoria.bacheca(undefined, 180)).filter(r => r.sessionId === sid).slice(0, 12);
				this.h.send({ type: 'bacheca.sessione', sessionId: sid, items });
				return true;
			}
			case 'file.open': {
				const p = String(m.path ?? '');
				if (!projects.some(x => p.startsWith(x.path + '/')) || !fs.existsSync(p)) return true;
				const line = Math.max(0, (Number(m.line) || 1) - 1);
				await vscode.window.showTextDocument(vscode.Uri.file(p), { selection: new vscode.Range(line, 0, line, 0), preview: true });
				return true;
			}
			case 'view':
				if (m.view) this.h.send({ type: 'view', view: m.view });
				return true;
			case 'focus':
				if (m.path) this.h.send({ type: 'focus', path: m.path });
				return true;
			case 'filter':
				if (m.filter) this.h.send({ type: 'filter', filter: m.filter });
				return true;
		}
		return false;
	}

	private async ensureLedger(): Promise<void> {
		if (this.h.stats.lastLedger.size) return;
		try {
			await this.h.stats.compute({ projects: this.h.projects(), live: this.h.live() });
		} catch {
			// nessun registro: report vuoto
		}
	}

	private async exportClients(month: string | undefined, format: 'csv' | 'md'): Promise<void> {
		await this.ensureLedger();
		const report = buildReport(this.h.stats.lastLedger, readClients(), this.h.projects(), month);
		const name = `ore-clienti-${report.month}.${format}`;
		const target = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads', name)),
			title: `Esporta le ore di ${monthName(report.month)}`,
			filters: format === 'csv' ? { CSV: ['csv'] } : { Markdown: ['md'] },
		});
		if (!target) return;
		fs.writeFileSync(target.fsPath, format === 'csv' ? toCsv(report) : toMarkdown(report));
		execFile('open', ['-R', target.fsPath]);
		this.h.send({ type: 'clients.exported', path: target.fsPath });
	}

	private async fixRelease(projectPath: string): Promise<void> {
		const p = this.h.projects().find(x => x.path === projectPath);
		const app = this.radar.state().apps.find(a => a.projectPath === projectPath);
		const ok = await vscode.window.showWarningMessage(
			`Metto ${app?.name ?? p?.name ?? 'questa app'} ${app?.version?.string ?? ''} in rilascio automatico?`,
			{ modal: true, detail: 'Su App Store Connect la versione verrà pubblicata appena Apple la approva (releaseType AFTER_APPROVAL), come vuole la regola.' },
			'Metti in automatico',
		);
		if (ok !== 'Metti in automatico') return;
		try {
			const msg = await this.radar.setAutomaticRelease(projectPath);
			vscode.window.showInformationMessage(msg);
			await this.radar.refresh(this.h.projects(), { force: true });
			await this.rules.check(this.h.projects(), { force: true });
		} catch (e: any) {
			vscode.window.showErrorMessage(`App Store Connect non ha accettato la modifica: ${e?.message ?? e}`);
		}
	}

	// ---------- schema URL bottega:// ----------

	private async handleUri(uri: vscode.Uri): Promise<void> {
		const q = new URLSearchParams(uri.query);
		const route = uri.path.replace(/^\/+/, '');
		const projects = this.h.projects();
		const find = (s: string | null) => {
			if (!s) return undefined;
			const k = s.toLowerCase();
			return projects.find(p => p.path === s) ?? projects.find(p => p.name.toLowerCase() === k) ?? projects.find(p => p.name.toLowerCase().includes(k));
		};
		switch (route) {
			case 'progetto': {
				const p = find(q.get('path'));
				this.h.showHome('plancia', p?.path);
				return;
			}
			case 'ricordo':
				this.h.showHome('memoria');
				this.h.send({ type: 'memoria.cerca', query: q.get('q') ?? '' });
				return;
			case 'cerca':
				this.h.showHome('memoria');
				this.h.send({ type: 'ricerca.avvia', query: q.get('q') ?? '' });
				return;
			case 'chiedi': {
				const t = (q.get('testo') ?? '').trim();
				this.h.showHome('melissa');
				if (t) await this.h.assistant()?.ask(t);
				return;
			}
			case 'lavoro': {
				// Un link non avvia mai un lavoro da solo: lo si mostra e si chiede.
				const p = find(q.get('progetto'));
				const task = (q.get('compito') ?? '').trim().slice(0, 4000);
				if (!q.get('progetto')) {
					// "Nuovo lavoro" dal widget o dal Centro di Controllo: il compositore vuoto.
					this.h.showHome('lavori');
					this.h.send({ type: 'composer', path: '', task: '' });
					return;
				}
				if (!p) {
					vscode.window.showWarningMessage(`Non trovo il progetto "${q.get('progetto') ?? ''}".`);
					return;
				}
				const ok = task
					? await vscode.window.showWarningMessage(`Avvio un lavoro Claude su ${p.name}?`, { modal: true, detail: task }, 'Avvia')
					: undefined;
				if (ok === 'Avvia') this.h.jobs.start(p.path, task);
				else {
					this.h.showHome('lavori');
					this.h.send({ type: 'composer', path: p.path, task });
				}
				return;
			}
			case 'briefing':
				this.h.showHome('plancia');
				void this.listen();
				return;
			case 'vedetta':
				this.h.showHome('vedetta');
				return;
			// Dal widget, dal Centro di Controllo e da Siri (docs/CONTRATTI.md, 7.5).
			case 'melissa':
				this.h.showHome('melissa');
				if (!this.h.assistant()?.getState().conversing) void vscode.commands.executeCommand('bottega.voice.converse');
				return;
			case 'plancia':
				this.h.showHome('plancia');
				return;
			case 'osservatorio':
				void vscode.commands.executeCommand('bottega.openOsservatorio');
				return;
			case 'continua': {
				const p = find(q.get('progetto'));
				if (!p) return;
				this.h.showHome('plancia', p.path);
				const c = await prepareContinuation(p, { recent: (name, o) => this.h.memoria.recent(name, o) });
				this.h.send({ type: 'continua', ...c });
				return;
			}
			default:
				this.h.showHome('plancia');
		}
	}

	// ---------- per Melissa ----------

	rulesSummary(projectPath?: string): string {
		const r = this.rules.state();
		if (!r.checkedAt) return 'Le regole non sono ancora state controllate: il primo giro sta partendo.';
		const name = (p: string) => this.h.projects().find(x => x.path === p)?.name ?? path.basename(p);
		if (projectPath) {
			const pr = r.projects[projectPath];
			if (!pr || !pr.hits.length) return `${name(projectPath)} è in verde: nessuna regola violata.`;
			return `${name(projectPath)} è in ${pr.livello}. ` + pr.hits.map(h => `${h.frase} Rimedio: ${h.rimedio}`).join(' ');
		}
		const lines = [`Rossi ${r.counts.rosso}, gialli ${r.counts.giallo}, verdi ${r.counts.verde}.`];
		for (const g of r.global) lines.push(`Globale: ${g.frase}`);
		const bad = Object.values(r.projects).filter(p => p.hits.length).sort((a, b) => (a.livello === 'rosso' ? -1 : 1) - (b.livello === 'rosso' ? -1 : 1));
		for (const p of bad.slice(0, 8)) lines.push(`${name(p.path)} (${p.livello}): ${p.hits.map(h => h.frase).join(' ')}`);
		return lines.join('\n');
	}

	async briefingFacts(): Promise<string> {
		const f = await this.facts();
		return factsForModel(briefingPoints(f));
	}

	storeSummary(): string {
		const r = this.radar.state();
		if (!r.ascAt && !r.admobAt) return `Non ho ancora dati dallo Store.${r.ascError ? ' ' + r.ascError : ''}`;
		const lines: string[] = [];
		if (r.totals) lines.push(`AdMob: ieri ${money(r.totals.yesterday, r.totals.currency)}, ultimi sette giorni ${money(r.totals.last7, r.totals.currency)}.`);
		for (const a of r.apps.slice(0, 12)) {
			const v = a.version ? `${a.version.string} ${a.version.label}` : a.live ? `${a.live} pubblicata` : 'nessuna versione';
			const stars = a.reviews.length ? `, ultime recensioni ${a.reviews.slice(0, 3).map(x => x.stars).join(', ')} stelle` : '';
			const soldi = a.money ? `, ieri ${money(a.money.yesterday, a.money.currency)}` : '';
			lines.push(`${a.name}: ${v}${stars}${soldi}.`);
		}
		const age = Math.round((Date.now() - Math.max(r.ascAt, r.admobAt)) / 60_000);
		lines.push(`Dati di ${age < 2 ? 'adesso' : age < 90 ? `${age} minuti fa` : `${Math.round(age / 60)} ore fa`}.`);
		return lines.join('\n');
	}

	async prepareForMelissa(nameOrPath: string): Promise<{ name: string; path: string; prompt: string } | undefined> {
		const k = nameOrPath.toLowerCase();
		const projects = this.h.projects();
		const p = projects.find(x => x.path === nameOrPath) ?? projects.find(x => x.name.toLowerCase() === k) ?? projects.find(x => x.name.toLowerCase().includes(k));
		if (!p) return undefined;
		const c = await prepareContinuation(p, { recent: (name, o) => this.h.memoria.recent(name, o) });
		this.h.showHome('plancia', p.path);
		this.h.send({ type: 'continua', ...c });
		return { name: p.name, path: p.path, prompt: c.prompt };
	}

	async whereSolvedText(query: string): Promise<string> {
		const r = await whereSolved(query, this.h.projects().map(p => ({ name: p.name, path: p.path })), q => this.h.memoria.searchMany(q, 10));
		this.h.send({ type: 'ricerca', ...r });
		const out: string[] = [];
		if (r.memoria.length) out.push('Nella memoria:', ...r.memoria.slice(0, 5).map(m => `[${m.project}] ${m.title}: ${m.text.split('\n')[0].slice(0, 160)}`));
		if (r.codice.length) out.push('Nel codice:', ...r.codice.slice(0, 8).map(c => `${c.project} ${c.file} riga ${c.line}: ${c.text.slice(0, 110)}`));
		if (!out.length) return `Non trovo niente su "${query}", né nella memoria né nel codice.`;
		return out.join('\n') + '\n(I risultati sono anche nella stanza Memoria della Home.)';
	}

	queueNight(projectPath: string, task: string): string {
		const job: Job = this.h.jobs.start(projectPath, task, { night: true });
		const c = this.night.config();
		return `In fila per stanotte su ${job.project}: parte dalle ${c.from}, se il Mac è alla corrente. Di notte niente push né pubblicazioni.`;
	}
}

export type { RuleAction };
