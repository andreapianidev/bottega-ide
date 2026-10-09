import { osservatorioConAttivita } from './osservatorio';
import { creaRegistroMemoria } from './memoria-eventi';
import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LiveSession, PastSession, readLiveSessions, readPastSessions, SESSIONS_DIR } from './claude';
import { canonKey, Project, projectKey, scanProjects } from './scan';
import { PlanciaPanel, PlanciaMessage } from './panel';
import { Nucleo, SystemStats } from './nucleo';
import { Job, JobManager, computeLimit, limitReason, WorkCounts, WorkItem, workCounts, workItems } from './jobs';
import { Memoria } from './memoria';
import { ContestoMemoria } from './memoria-contesto';
import { ContinuitaMelissa } from './continuita';
import { Assistant, AssistantState } from './assistant';
import { StatsEngine, summarizeObservedActivity, type Stats } from './stats';
import { Idee, IdeeDynamic } from './idee';
import { handleConnettori, registerConnettori, stanzaConnettori } from './connettori-host';
import { BarraView } from './barra';
import { brainName } from './assistant';
import { Cervelli, Effort, Provider, spokenChoice } from './cervelli';
import { digest, digestText } from './mani';
import { CategorieMinuti, Osservatorio, categorieMinuti, fraseCategorie } from './osservatorio';
import { VedettaNativa, datiVedetta } from './vedetta-nativa';
import { registerPonte } from './ponte-host';
import { registerAggiornamenti } from './aggiorna-host';
import { registerCline } from './cline-host';
import { registraSessioni } from './sessioni';
import { Aggiornamenti } from './aggiorna';
import { TOOLS } from './assistant';
import { registraStrumentiConnettori, STRUMENTI_CONNETTORI } from './strumenti-connettori';
import { registerTerminale, STRUMENTI_TERMINALE } from './terminale-host';
import type { AppStore } from './appstore';
import { Conti } from './conti';
import { Occhio, registraOcchio } from './occhio-host';
import { leggiStanza } from './strumenti-stanze';
import type { DaRaccontare } from './assistant';
import { allarmiAppStore, briefingAppStore, handleAppStore, registerAppStore, STRUMENTI_APPSTORE } from './appstore-host';
import { registraStrumentiStanze, STRUMENTI_STANZE } from './strumenti-stanze';
import { conteggiOsservati, type AgentActivity } from './attivita-tipi';
import { readCodexActivities } from './attivita-codex';
import { readClineActivities } from './attivita-cline';
import { registerTerminalActivity, TerminalActivityMonitor } from './attivita-terminale';
import { makeRegiaDigest, regiaChart, REGIA_INTERVAL, type RegiaDigest } from './regia';
import { pulisciAttivita, pulisciTesto } from './attivita-sicurezza';
import { carica as caricaPersonaggi, pubblica as pubblicaPersonaggi } from './personaggi';
import { RegiaPersonaggi } from './regia-personaggi';
import { avviaRegiaPersonaggi } from './regia-personaggi-host';
import { forzatureDalleRegole } from './forzature-regole';
import { IsolaAttivita, isolaVera } from './isola-attivita';

// Melissa usa i connettori di Claude Code in sola lettura (docs/CONTRATTI.md, 5 e 6): prima che nasca l'assistente.
Object.assign(TOOLS, STRUMENTI_CONNETTORI satisfies typeof TOOLS);
// Il terminale (docs/CONTRATTI.md, 12): «aprimi un terminale su Woofmap».
Object.assign(TOOLS, STRUMENTI_TERMINALE satisfies typeof TOOLS);
// La stanza App Store (docs/CONTRATTI.md, 13.7): «quanto hanno reso le app questa settimana».
Object.assign(TOOLS, STRUMENTI_APPSTORE satisfies typeof TOOLS);
// Le stanze della plancia lette e mostrate a voce (docs/CONTRATTI.md, 6): «quanto ho guadagnato a settembre».
Object.assign(TOOLS, STRUMENTI_STANZE satisfies typeof TOOLS);

export interface Snapshot {
	projects: Project[];
	live: LiveSession[];
	/** Sessioni partite dalla home o da cartelle che non sono un progetto conosciuto. */
	elsewhere: PastSession[];
	scannedAt: number;
	home: string;
	jobs: Job[];
	/** Tutto il lavoro in giro: lavori della Bottega e sessioni Claude vive altrove (contratto 4.9). */
	work: WorkItem[];
	/** Sessioni osservate da Claude Code, Cline, Codex e dai terminali integrati. */
	activity: AgentActivity[];
	workCounts: WorkCounts;
	jobLimit: number;
	jobLimitReason: string;
	system: SystemStats | null;
	nucleo: boolean;
	assistant: AssistantState;
	/** Sezione 4 del contratto: regole, radar, briefing, dimenticati, notte, consigli. */
	rules?: IdeeDynamic['rules'];
	radar?: IdeeDynamic['radar'];
	briefing?: IdeeDynamic['briefing'];
	forgotten?: IdeeDynamic['forgotten'];
	night?: IdeeDynamic['night'];
	advice?: IdeeDynamic['advice'];
}

const DEFAULT_ASSISTANT: AssistantState = { enabled: true, conversing: false, state: 'idle', log: [], brain: 'deepseek' };

let snapshot: Snapshot = { projects: [], live: [], elsewhere: [], scannedAt: 0, home: os.homedir(), jobs: [], work: [], activity: [], workCounts: workCounts([]), jobLimit: 3, jobLimitReason: 'valori predefiniti', system: null, nucleo: false, assistant: DEFAULT_ASSISTANT };
let lastMenuActivity = '';
const changed = new vscode.EventEmitter<Snapshot>();
// Le viste ad albero vogliono un evento senza argomento: con un argomento aggiornerebbero solo quell'elemento.
const treesChanged = new vscode.EventEmitter<void>();
changed.event(() => treesChanged.fire());
let scanning: Promise<void> | undefined;

let nucleo: Nucleo | undefined;
let jobManager: JobManager | undefined;
let memoria: Memoria | undefined;
let assistant: Assistant | undefined;
let regiaDigest: RegiaDigest | null = null;
let regiaDigestRunning: Promise<void> | undefined;
let regiaMetalOpen = false;
let regiaMetalSignature = '';
let saveRegiaDigest: ((digest: RegiaDigest) => void) | undefined;
function pushRegiaMetal(force = false): void {
	if (!regiaMetalOpen || !nucleo?.available) return;
	const data = regiaChart(snapshot, regiaDigest);
	const signature = JSON.stringify(data);
	if (!force && signature === regiaMetalSignature) return;
	regiaMetalSignature = signature;
	nucleo.fireAndForget('regia.data', { data });
}
async function refreshRegiaDigest(force = false): Promise<void> {
	if (!force && regiaDigest && Date.now() - regiaDigest.at < REGIA_INTERVAL) return;
	if (regiaDigestRunning) return regiaDigestRunning;
	if (!assistant || !snapshot.activity.length && !snapshot.work.length) return;
	regiaDigestRunning = (async () => {
		const next = await makeRegiaDigest(snapshot, (instructions, facts, max) => assistant!.compose(instructions, facts, max, false), nucleo);
		if (next) {
			regiaDigest = next;
			saveRegiaDigest?.(next);
			panelHost?.send({ type: 'regia.digest', digest: next });
			ponte?.notify();
			pushRegiaMetal();
		}
	})().finally(() => { regiaDigestRunning = undefined; });
	return regiaDigestRunning;
}
let panelHost: PlanciaPanel | undefined;
let statsEngine: StatsEngine | undefined;
let idee: Idee | undefined;
/** La stanza App Store (docs/CONTRATTI.md, 13): guadagni, vendite e buchi delle app. */
let appStore: AppStore | undefined;
let barraView: BarraView | undefined;
let cervelli: Cervelli | undefined;
let conti: Conti | undefined;
/** La stanza mostrata dalla Home (messaggio "vista" di media/plancia.js). */
let vistaHome = 'plancia';
let occhioGlobale: Occhio | undefined;
/** Apple Intelligence attiva sul Mac (capabilities del Nucleo). */
/** I lavori che aspettavano al giro prima: Melissa avvisa a voce solo dei nuovi. */
let waitingBefore = new Set<string>();
let osservatorio: Osservatorio | undefined;
let vedettaNativa: VedettaNativa | undefined;
/** L'isola segue anche Cline, Codex e i terminali integrati (src/isola-attivita.ts). */
let isolaAttivita: IsolaAttivita | undefined;
let aggiornamenti: Aggiornamenti | undefined;
let ponte: { notify(): void } | undefined;
let categorieCache: { at: number; value: CategorieMinuti | null } = { at: 0, value: null };
let paintStatus: (() => void) | undefined;
let terminalActivity: TerminalActivityMonitor | undefined;
let externalActivity: AgentActivity[] = [];
let externalReading: Promise<void> | undefined;
/** Il cruscotto si calcola solo dopo che la plancia l'ha chiesto almeno una volta. */
let statsWanted = false;
let statsSent = '';
let statsPublishedAt = 0;
let statsActivitySignature = '';
let statsActivityTimer: NodeJS.Timeout | undefined;

function cfg() {
	return vscode.workspace.getConfiguration('bottega');
}

const norm = (p: string) => p.toLowerCase().replace(/\/+$/, '');

function attachTitles(live: LiveSession[], past: PastSession[]): LiveSession[] {
	const byId = new Map(past.map(s => [s.sessionId, s.title]));
	return live.map(s => ({ ...s, title: byId.get(s.sessionId) }));
}

/** I campi dinamici (lavori, sistema, assistente) che vivono fuori dalla scansione. */
/** Il progetto di una sessione viva, come lo vede la plancia. */
function projectOfLive(projects: Project[], l: LiveSession): Project | undefined {
	return projects.find(p => p.live.some(x => x.pid === l.pid));
}

function allActivity(base: Pick<Snapshot, 'projects' | 'elsewhere' | 'live'>, work: WorkItem[]): AgentActivity[] {
	const claude = work.filter(w => w.status === 'in corso' || w.status === 'ti aspetta' || w.status === 'nel terminale').map(w => ({
		key: `claude:${w.sessionId ?? w.key}`, source: 'claude' as const, id: w.sessionId ?? w.key,
		project: w.project, path: w.path, title: w.title || 'Sessione Claude Code',
		status: w.status === 'ti aspetta' ? 'ti aspetta' as const : w.status === 'in corso' ? 'in corso' as const : 'sconosciuto' as const,
		updatedAt: w.since, evidence: w.source === 'bottega' ? 'Claude Code: lavoro avviato dalla Bottega' : 'Claude Code: registro delle sessioni vive',
	}));
	const liveIds = new Set(base.live.map(s => s.sessionId));
	const cutoff = Date.now() - 45 * 86_400_000;
	const past = [...base.projects.flatMap(p => p.sessions.map(s => ({ s, project: p.name, path: p.path }))),
		...base.elsewhere.map(s => ({ s, project: path.basename(s.cwd) || 'home', path: s.cwd }))]
		.filter(x => x.s.mtime >= cutoff && !liveIds.has(x.s.sessionId))
		.map(x => ({ key: `claude:${x.s.sessionId}`, source: 'claude' as const, id: x.s.sessionId,
			project: x.project, path: x.path, title: x.s.title || 'Sessione Claude Code', status: 'finito' as const,
			updatedAt: x.s.mtime, evidence: 'Claude Code: trascrizione locale, nessun processo vivo nel registro',
		}));
	const byKey = new Map<string, AgentActivity>();
	for (const item of [...past, ...claude, ...externalActivity, ...(terminalActivity?.activities() ?? [])]) {
		const cleaned = pulisciAttivita(item);
		const prev = byKey.get(cleaned.key);
		if (!prev || cleaned.updatedAt >= prev.updatedAt || cleaned.status === 'in corso') byKey.set(cleaned.key, cleaned);
	}
	return [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function withDynamic(base: Omit<Snapshot, 'jobs' | 'work' | 'activity' | 'workCounts' | 'jobLimit' | 'jobLimitReason' | 'system' | 'nucleo' | 'assistant' | keyof IdeeDynamic>): Snapshot {
	const setting = cfg().get<string | number>('jobs.maxParallel', 'auto');
	const stats = nucleo?.lastStats;
	const jobs = jobManager ? jobManager.list() : snapshot.jobs;
	const work = workItems(jobs, base.live, l => projectOfLive(base.projects, l), base.home);
	const activity = allActivity(base, work);
	return {
		...base,
		jobs,
		work,
		activity,
		workCounts: conteggiOsservati(activity, workCounts(work)),
		jobLimit: computeLimit(setting, stats),
		jobLimitReason: limitReason(setting, stats),
		system: stats ?? null,
		nucleo: nucleo?.available ?? false,
		assistant: assistant ? assistant.getState() : snapshot.assistant,
		...(idee ? idee.dynamic() : {}),
	};
}

async function updateExternalActivity(): Promise<void> {
	if (externalReading) return externalReading;
	externalReading = (async () => {
		const [codex, cline] = await Promise.allSettled([
			Promise.resolve().then(() => readCodexActivities()), readClineActivities(),
		]);
		externalActivity = [...(codex.status === 'fulfilled' ? codex.value : externalActivity.filter(a => a.source === 'codex')),
			...(cline.status === 'fulfilled' ? cline.value : externalActivity.filter(a => a.source === 'cline'))];
		refreshDynamic();
	})().finally(() => (externalReading = undefined));
	return externalReading;
}

async function fullScan(): Promise<void> {
	if (scanning) return scanning;
	scanning = (async () => {
		const past = await readPastSessions();
		const live = attachTitles(readLiveSessions(), past);
		const projects = await scanProjects(cfg().get<string[]>('roots', []), cfg().get<string[]>('ignore', []), past, live);
		const claimed = new Set(projects.flatMap(p => p.sessions.map(s => s.sessionId)));
		snapshot = withDynamic({
			projects,
			live,
			elsewhere: past.filter(s => !claimed.has(s.sessionId)).slice(0, 30),
			scannedAt: Date.now(),
			home: os.homedir(),
		});
		changed.fire(snapshot);
		void jobManager?.reconcile();
		idee?.afterScan();
		// Il cruscotto legge centinaia di MB di registri: si ricalcola solo se la Home e' davanti.
		if (statsWanted && panelHost?.isVisible) void sendStats(false);
		statsPace();
	})().finally(() => (scanning = undefined));
	return scanning;
}

/** Aggiornamento leggero: solo il registro delle sessioni vive, senza rileggere git. */
function liveScan(): void {
	const live = attachTitles(readLiveSessions(), [...snapshot.projects.flatMap(p => p.sessions), ...snapshot.elsewhere]);
	for (const p of snapshot.projects) {
		const mine = new Set(p.sessions.map(x => x.sessionId));
		p.live = live.filter(s => canonKey(s.cwd).startsWith(projectKey(p.path)) || mine.has(s.sessionId));
	}
	snapshot = withDynamic({ ...snapshot, live });
	changed.fire(snapshot);
	void jobManager?.reconcile();
}

/** Ricalcola solo i campi dinamici e li manda alla plancia, senza ripassare git e trees. */
function refreshDynamic(): void {
	snapshot = withDynamic(snapshot);
	idee?.activityChanged();
	isolaAttivita?.aggiorna(snapshot.activity);
	panelHost?.pushSnapshot(snapshot);
	pushRegiaMetal();
	vedettaNativa?.push();
	const activitySignature = snapshot.activity.map(a => `${a.key}:${a.status}:${a.updatedAt}`).join('|');
	if (activitySignature !== statsActivitySignature) {
		statsActivitySignature = activitySignature;
		treesChanged.fire();
		clearTimeout(statsActivityTimer);
		statsActivityTimer = setTimeout(() => {
			if (statsWanted && panelHost?.isVisible) void sendStats(false);
			else void osservatorio?.push();
		}, 2_000);
	}
	ponte?.notify();
	const menuActivity = snapshot.activity.filter(a => a.status === 'in corso' || a.status === 'ti aspetta')
		.map(a => `${a.key}:${a.status}`).sort().join('|');
	if (menuActivity !== lastMenuActivity) {
		lastMenuActivity = menuActivity;
		idee?.paintMenubar();
	}
	paintStatus?.();
	barraView?.update();
	announceWaiting();
}

/** In conversazione Melissa dice, una volta, quando un lavoro comincia ad aspettare Andrea. */
function announceWaiting(): void {
	const now = new Set(snapshot.activity.filter(w => w.status === 'ti aspetta').map(w => w.key));
	const fresh = snapshot.activity.filter(w => w.status === 'ti aspetta' && !waitingBefore.has(w.key));
	const first = waitingBefore.size === 0 && !snapshot.scannedAt;
	waitingBefore = now;
	const a = assistant?.getState();
	if (first || !fresh.length || !a?.conversing || a.state === 'speaking' || a.state === 'thinking') return;
	const names = [...new Set(fresh.map(w => w.project))];
	void assistant?.announce(names.length === 1 ? `${names[0]} ti aspetta.` : `${names.join(' e ')} ti aspettano.`);
}

// ---------- la barra di Melissa: cervello, sessioni, cruscotto a voce ----------

async function switchBrain(cervello?: string, impegno?: string): Promise<string> {
	if (!cervelli) return 'I cervelli non sono pronti.';
	const out: string[] = [];
	const asked = spokenChoice(`${cervello ?? ''} ${impegno ?? ''}`);
	const effort = (['rapido', 'normale', 'profondo'] as Effort[]).find(e => e === impegno) ?? asked.effort;
	if (effort) {
		await cervelli.setEffort(effort);
		out.push(`impegno ${effort}`);
	}
	// Claude, Gemini e GPT passavano da OpenRouter, tolto il 3/10/2026
	if (!asked.provider && /\b(claude|opus|sonnet|gemini|google|gpt|openai|chat ?gpt|openrouter)\b/i.test(cervello ?? '')) {
		out.push('Claude, Gemini e GPT non ci sono più: penso con Agnes o con DeepSeek');
	}
	if (asked.provider) {
		try {
			const c = await cervelli.set(asked.provider as Provider);
			// si torna al predefinito: Agnes, salvo una scelta «sempre» (CONTRATTI 9.8)
			const base = { agnes: 'ad Agnes', deepseek: 'a DeepSeek', apple: 'ad Apple Intelligence' }[cervelli.defaultProvider()];
			out.push(!cervelli.temporary() ? `torno ${base}` : `penso con ${brainName(c.model)} per questa conversazione, poi torno ${base}`);
		} catch (e: any) {
			return `${e?.message ?? e} Resto con Agnes.`;
		}
	}
	barraView?.update();
	return out.length ? cap(out.join(', ')) + '.' : 'Non ho capito quale cervello vuoi.';
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function readSession(project: string): string {
	const other = snapshot.activity.filter(a => a.source !== 'claude' && a.project.toLowerCase().includes(project.toLowerCase()));
	const detail = other.slice(0, 3).map(a => activityDetail(a.key)).join('\n');
	return detail ? detail + '\n\nDettaglio Claude Code: ' + readClaudeSession(project) : readClaudeSession(project);
}

function readClaudeSession(project: string): string {
	const k = project.toLowerCase();
	const items = snapshot.work.filter(w => w.sessionId && (w.project.toLowerCase() === k || w.project.toLowerCase().includes(k)));
	if (!items.length) {
		const p = resolveProject(project);
		const past = p ? projectFor(p.path)?.sessions?.[0] : undefined;
		const d = past ? digest(past.sessionId) : undefined;
		return d ? `Nessuna sessione viva su ${p!.name}; l'ultima:\n${safeDigest(digestText(d, p!.name))}` : `Non trovo sessioni su "${project}".`;
	}
	return items
		.slice(0, 3)
		.map(w => {
			const d = digest(w.sessionId!);
			const where = w.source === 'altrove' ? ' (aperta fuori dalla Bottega: sola lettura)' : '';
			return d ? safeDigest(digestText(d, w.project)) + where : `Sessione su ${w.project}: ${w.status}, non trovo la sua trascrizione.`;
		})
		.join('\n\n');
}

function safeDigest(raw: string): string {
	return raw.split('\n').slice(0, 30).map(line => pulisciTesto(line, 500)).filter(Boolean).join('\n').slice(0, 6_000);
}

function activityList(source?: string, project?: string, status?: string): string {
	const q = (project ?? '').trim().toLowerCase();
	const rows = snapshot.activity.filter(a => (!source || a.source === source.toLowerCase()) &&
		(!q || a.project.toLowerCase().includes(q) || a.path?.toLowerCase().includes(q)) &&
		(!status || (status === 'attive' ? a.status === 'in corso' || a.status === 'ti aspetta' : a.status === status.toLowerCase())));
	if (!rows.length) return 'Nessuna attività osservata con questi criteri.';
	return rows.slice(0, 80).map(a => `${a.key} · ${a.source} · ${a.project} · ${a.status} · ${a.title}`).join('\n') +
		(rows.length > 80 ? `\nAltre ${rows.length - 80} attività: specifica fonte o progetto.` : '');
}

function activityDetail(query: string): string {
	const q = query.trim().toLowerCase();
	const rows = snapshot.activity.filter(a => a.key.toLowerCase() === q || a.id.toLowerCase() === q ||
		a.project.toLowerCase().includes(q) || a.title.toLowerCase().includes(q)).slice(0, 3);
	if (!q || !rows.length) return 'Non trovo questa attività. Usa attivita_elenco per vedere le chiavi disponibili.';
	return rows.map(a => `${a.key}: ${a.source}, ${a.project}, ${a.status}. ${a.title}. ${a.summary ?? ''}\n` +
		`Ultimo segnale: ${new Date(a.updatedAt).toLocaleString('it-IT')}. Evidenza: ${a.evidence}.` +
		(a.steps?.length ? `\nPassi: ${a.steps.join('; ')}` : '')).join('\n\n');
}

function terminalOutput(key: string): string {
	const d = terminalActivity?.detail(key);
	if (!d) return 'Terminale non trovato in questa finestra.';
	if (!d.captured) return 'La shell integration non ha fornito l’output di questo terminale. Posso mostrarne solo lo stato osservato.';
	return `${d.activity.title}: ${d.activity.status}. ${d.truncated ? 'Ultime righe disponibili (precedenti omesse).' : 'Righe disponibili.'}\n${d.output || 'Nessuna riga acquisita.'}`;
}

function showCruscotto(project?: string, period?: number): string {
	const p = project ? resolveProject(project) : undefined;
	const days = period && period <= 7 ? 7 : period && period > 30 ? 90 : period ? 30 : undefined;
	panelHost?.show();
	panelHost?.send({ type: 'view', view: 'cruscotto' });
	panelHost?.send({ type: 'crus.focus', ...(p ? { path: p.path } : {}), ...(days ? { period: days } : {}) });
	if (project && !p) return `Ho aperto il cruscotto, ma non trovo il progetto "${project}".`;
	return `Cruscotto aperto${p ? ` su ${p.name}` : ''}${days ? `, ultimi ${days} giorni` : ''}. Per dire le cifre chiama stanza_leggi con stanza cruscotto, stesso progetto e periodo.`;
}

/** Statistiche di sistema ogni 10 s se servono (Home davanti, o lavori in corso o in coda che dipendono dalla
 *  memoria libera), ogni 60 s se no. */
function statsPace(): void {
	const busy = (jobManager?.list() ?? []).some(j => j.status === 'in corso' || j.status === 'in coda');
	nucleo?.setStatsInterval(panelHost?.isVisible || busy ? 10_000 : 60_000);
}

export function projectFor(p: string): Project | undefined {
	return snapshot.projects.find(x => x.path === p);
}

// ---------- azioni ----------

export function openProject(p: string, newWindow = true) {
	vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: newWindow });
}

export function claudeIn(cwd: string, resumeId?: string) {
	const cmd = cfg().get<string>('claudeCommand', 'claude');
	const name = path.basename(cwd) || '~';
	const term = vscode.window.createTerminal({
		name: resumeId ? `Claude ${name} (ripresa)` : `Claude ${name}`,
		cwd,
		location: vscode.TerminalLocation.Editor,
		iconPath: new vscode.ThemeIcon('sparkle'),
	});
	term.show();
	term.sendText(resumeId ? `${cmd} --resume ${resumeId}` : cmd);
}

export function reveal(p: string) {
	execFile('open', [p]);
}

export function openXcode(p: string) {
	const proj = projectFor(p)?.xcodeProject;
	if (proj) execFile('open', ['-a', 'Xcode', proj]);
}

export function push(p: string) {
	const term = vscode.window.createTerminal({ name: `git push ${path.basename(p)}`, cwd: p });
	term.show();
	term.sendText('git push');
	// Il conteggio dei commit da spingere cambia dopo il push: si riguarda tra poco.
	setTimeout(() => void fullScan(), 8000);
}

// ---------- viste laterali ----------

function ago(ms: number): string {
	if (!ms) return '';
	const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return 'adesso';
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min fa`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} h fa`;
	const d = Math.round(h / 24);
	return d === 1 ? 'ieri' : `${d} giorni fa`;
}

const STATUS: Record<string, string> = { busy: 'al lavoro', idle: 'ti aspetta', shell: 'nel terminale' };

class LiveTree implements vscode.TreeDataProvider<AgentActivity> {
	readonly onDidChangeTreeData = treesChanged.event;
	getChildren() { return snapshot.activity.filter(a => a.status === 'in corso' || a.status === 'ti aspetta'); }
	getTreeItem(a: AgentActivity): vscode.TreeItem {
		const item = new vscode.TreeItem(a.project);
		item.description = `${a.source}, ${a.status}, ${ago(a.updatedAt)}`;
		item.tooltip = `${a.title}\n${a.path || ''}\n${a.evidence}`;
		item.iconPath = new vscode.ThemeIcon(a.status === 'in corso' ? 'loading~spin' : 'circle-filled', new vscode.ThemeColor('bottega.sodio'));
		item.command = { command: 'bottega.openPlancia', title: 'Plancia', arguments: [a.path] };
		return item;
	}
}

class ProjectTree implements vscode.TreeDataProvider<Project> {
	readonly onDidChangeTreeData = treesChanged.event;
	getChildren() {
		return snapshot.projects;
	}
	getTreeItem(p: Project): vscode.TreeItem {
		const item = new vscode.TreeItem(p.name);
		const notes: string[] = [];
		const active = snapshot.activity.filter(a => a.path === p.path && (a.status === 'in corso' || a.status === 'ti aspetta'));
		if (active.length) notes.push(`${active.length} attività attive`);
		if (p.git?.ahead) notes.push(`${p.git.ahead} da spingere`);
		if (p.git?.changes) notes.push(`${p.git.changes} modifiche`);
		if (!notes.length) notes.push(ago(p.touchedAt));
		item.description = notes.join(', ');
		item.tooltip = p.path;
		item.contextValue = p.xcodeProject ? 'project.apple' : 'project';
		const warn = (p.git?.ahead ?? 0) > 0 || (p.git && !p.git.upstream);
		item.iconPath = active.length
			? new vscode.ThemeIcon('sparkle', new vscode.ThemeColor('bottega.sodio'))
			: warn
				? new vscode.ThemeIcon('cloud-upload', new vscode.ThemeColor('bottega.sodio'))
				: new vscode.ThemeIcon(p.git ? 'repo' : 'folder');
		item.command = { command: 'bottega.openPlancia', title: 'Plancia', arguments: [p.path] };
		return item;
	}
}

class CruscottoTree implements vscode.TreeDataProvider<vscode.TreeItem> {
	readonly onDidChangeTreeData = treesChanged.event;
	getChildren(): vscode.TreeItem[] {
		const rows: [string, string, string][] = [
			['Progetti', String(snapshot.projects.length), 'folder-library'],
			['Agenti al lavoro', String(snapshot.activity.filter(a => a.status === 'in corso').length), 'pulse'],
			['Richieste in attesa', String(snapshot.workCounts.tiAspetta), 'bell'],
			['Lavori in coda', String(snapshot.workCounts.inCoda), 'list-ordered'],
		];
		return rows.map(([label, value, icon]) => {
			const item = new vscode.TreeItem(label);
			item.description = value;
			item.iconPath = new vscode.ThemeIcon(icon);
			item.command = { command: 'bottega.openCruscotto', title: 'Apri il cruscotto' };
			return item;
		});
	}
	getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
}

function roomView(id: string, provider: vscode.TreeDataProvider<any>, room: string): vscode.Disposable[] {
	const view = vscode.window.createTreeView(id, { treeDataProvider: provider });
	return [view, view.onDidChangeVisibility(e => { if (e.visible) showPlancia(room); })];
}

// ---------- azioni per l'assistente ----------

function searchProjects(text: string): { name: string; path: string }[] {
	const q = (text || '').toLowerCase();
	return snapshot.projects
		.filter(p => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
		.map(p => ({ name: p.name, path: p.path }));
}

function resolveProject(nameOrPath: string): { name: string; path: string } | undefined {
	const q = norm(nameOrPath || '');
	const p =
		snapshot.projects.find(x => norm(x.path) === q) ||
		snapshot.projects.find(x => x.name.toLowerCase() === q) ||
		snapshot.projects.find(x => path.basename(x.path).toLowerCase() === q) ||
		snapshot.projects.find(x => x.name.toLowerCase().includes(q));
	return p ? { name: p.name, path: p.path } : undefined;
}

function projectStatus(p: string): string {
	const proj = projectFor(p);
	if (!proj) return 'Progetto sconosciuto.';
	const parts: string[] = [];
	const g = proj.git;
	if (g) {
		parts.push(`ramo ${g.branch}`);
		if (g.ahead) parts.push(`${g.ahead} commit da spingere`);
		if (g.changes) parts.push(`${g.changes} modifiche non salvate`);
		if (!g.ahead && !g.changes) parts.push('albero pulito');
		if (g.lastCommitSubject) parts.push(`ultimo commit "${g.lastCommitSubject}" ${ago(g.lastCommitAt)}`);
	} else {
		parts.push('non e\' un repository git');
	}
	if (proj.build) parts.push(`build ${proj.build.number ?? '?'}${proj.build.marketing ? ', versione ' + proj.build.marketing : ''}`);
	const observed = snapshot.activity.filter(a => a.path && norm(a.path) === norm(p));
	const active = observed.filter(a => a.status === 'in corso' || a.status === 'ti aspetta');
	if (active.length) parts.push(`${active.length} attività attive adesso`);
	const titles = observed.slice(0, 3).map(a => `${a.source}: ${a.title} (${a.status})`);
	if (titles.length) parts.push('ultime sessioni: ' + titles.join('; '));
	return parts.join('. ') + '.';
}

function openFile(p: string): boolean {
	if (!p || !path.isAbsolute(p)) return false;
	const known = snapshot.projects.some(pr => norm(p) === norm(pr.path) || norm(p).startsWith(norm(pr.path) + '/'));
	if (!known) return false;
	try {
		if (!fs.existsSync(p)) return false;
	} catch {
		return false;
	}
	void vscode.window.showTextDocument(vscode.Uri.file(p));
	return true;
}


function showPlancia(section?: string): void {
	panelHost?.show();
	if (section) panelHost?.view(section.toLowerCase());
}

// ---------- «racconta»: cosa c'e' davanti ad Andrea (CONTRATTI 6) ----------

const NOMI_VISTE: Record<string, string> = {
	plancia: 'la Plancia', regia: 'la Regia', lavori: 'i Lavori', memoria: 'la Memoria', melissa: 'la Plancia', cruscotto: 'il Cruscotto',
	vercel: 'la stanza Vercel', vedetta: 'la Vedetta', appstore: 'la stanza App Store', clienti: 'la stanza Clienti', connettori: 'i Connettori',
};

/** Il file di codice nella scheda attiva, oppure la stanza che la Home sta mostrando, gia' letti. */
async function daRaccontare(): Promise<DaRaccontare | undefined> {
	const o = occhioGlobale;
	const davanti = o?.davanti() ?? (panelHost?.isOpen ? 'home' : undefined);
	if (davanti === 'file' && o) {
		const r = o.racconto();
		if (r) return { tipo: 'codice', ...r };
	}
	if (davanti !== 'home' && !(davanti === undefined && panelHost?.isOpen)) return undefined;
	const view = vistaHome in NOMI_VISTE ? vistaHome : 'plancia';
	const titolo = NOMI_VISTE[view];
	let testo: string;
	if (view === 'plancia' || view === 'melissa') testo = idee ? await idee.briefingFacts() : 'Il briefing non è pronto.';
	else if (view === 'lavori' || view === 'regia') testo = activityList() +
		(snapshot.work.some(w => w.status === 'in coda' || w.status === 'stanotte')
			? '\nLavori della Bottega in fila: ' + snapshot.work.filter(w => w.status === 'in coda' || w.status === 'stanotte').map(w => `${w.project}: ${w.status}`).join('; ')
			: '');
	else testo = await leggiStanza({ stanza: view });
	return { tipo: 'stanza', titolo, testo };
}

// ---------- crediti e consumi dei servizi (CONTRATTI 14) ----------

/** Il registro dei conti: una lettura poco dopo l'avvio e poi ogni 30 minuti; gli avvisi di ricarica sul Mac. */
function registraConti(ctx: vscode.ExtensionContext): Conti {
	const c = new Conti({
		chiave: () => cervelli?.key('deepseek'),
		agnesOggi: () => cervelli?.agnesOggi() ?? 0,
		log: s => console.warn(s),
	});
	c.onAllarmi(nuovi => {
		for (const a of nuovi) nucleo?.fireAndForget('notify', { id: `bottega:${a.id}`, title: a.app, body: a.testo, actions: [{ id: 'apri', title: 'Apri i conti' }], sound: false });
	});
	nucleo?.on('notify.clicked', (x: any) => {
		if (String(x?.id ?? '').startsWith('bottega:conti:') && x.action !== 'dismiss') void vscode.commands.executeCommand('bottega.apriConti');
	});
	const giro = () => void c.aggiorna().then(d => panelHost?.isOpen && panelHost.send({ type: 'conti', conti: d }));
	const primo = setTimeout(giro, 20_000);
	const ogni = setInterval(giro, 30 * 60_000);
	ctx.subscriptions.push({ dispose: () => (clearTimeout(primo), clearInterval(ogni)) });
	return c;
}

// ---------- cruscotto ----------

/** Calcola le statistiche (solo i file cambiati) e le manda alla plancia se sono cambiate o se
 *  la plancia le ha chieste. Contratto: docs/CONTRATTI.md, sezione 3, messaggio "stats". */
async function sendStats(force: boolean): Promise<void> {
	if (!statsEngine || !panelHost?.isOpen) return;
	if (!snapshot.scannedAt) await fullScan();
	try {
		const computed = await statsEngine.compute({ projects: snapshot.projects, live: snapshot.live });
		await publishStats(computed, force);
	} catch (e: any) {
		panelHost.send({ type: 'stats', stats: null, error: `Non riesco a leggere le sessioni di Claude Code: ${e?.message ?? e}` });
	}
}

/** Home e widget condividono l'ultimo calcolo, anche quando la finestra non ha il focus. */
async function publishStats(computed: Stats, force = false): Promise<void> {
	idee?.acceptStats(computed);
	if (!panelHost?.isOpen) return;
	const categorie = await categorieDelLavoro();
	const stats = {
		...computed,
		...(categorie ? { categorie, categorieFrase: fraseCategorie(categorie) } : {}),
		observedActivity: summarizeObservedActivity(snapshot.activity),
	};
	const sig = StatsEngine.signature(stats);
	if (computed.computedAt < statsPublishedAt) return;
	if (!force && sig === statsSent && computed.computedAt - statsPublishedAt < 60_000) return;
	statsSent = sig;
	statsPublishedAt = computed.computedAt;
	panelHost.send({ type: 'stats', stats });
	void osservatorio?.push();
}

/** Minuti per categoria (correzione, funzione, ...): categorie decise sul Mac sessione per sessione
 *  (memoria/lib/categorie.mjs), pesate con gli intervalli del cruscotto. Rilette al massimo ogni 5 minuti. */
async function categorieDelLavoro(): Promise<CategorieMinuti | null> {
	if (!memoria || !statsEngine) return null;
	if (Date.now() - categorieCache.at < 5 * 60_000) return categorieCache.value;
	const map = await memoria.categorie(90).catch(() => ({} as Record<string, string>));
	const value = Object.keys(map).length ? categorieMinuti(statsEngine.sessionSpans(), map) : null;
	categorieCache = { at: Date.now(), value };
	return value;
}

/** I numeri dell'Osservatorio nativo: lo Stats del cruscotto, le sessioni vive, le categorie. */
async function datiOsservatorio(): Promise<Record<string, any> | null> {
	if (!statsEngine) return null;
	if (!snapshot.scannedAt) await fullScan();
	const stats = await statsEngine.compute({ projects: snapshot.projects, live: snapshot.live });
	return { ...osservatorioConAttivita(stats, snapshot.activity), categorie: await categorieDelLavoro() };
}

// ---------- messaggi dalla plancia ----------

async function onPlanciaMessage(m: PlanciaMessage): Promise<void> {
	switch (m.type) {
		case 'regia.digest':
			if (regiaDigest) panelHost?.send({ type: 'regia.digest', digest: regiaDigest });
			void refreshRegiaDigest();
			return;
		case 'regia.refresh':
			void refreshRegiaDigest(true);
			return;
		case 'regia.metal':
			if (!nucleo?.available) return void vscode.window.showWarningMessage('Il Nucleo nativo non è acceso: non posso aprire il cruscotto Metal.');
			try {
				await nucleo.request('regia.open', { data: regiaChart(snapshot, regiaDigest) }, 15_000);
				regiaMetalOpen = true;
				regiaMetalSignature = JSON.stringify(regiaChart(snapshot, regiaDigest));
			} catch (e: any) { vscode.window.showWarningMessage(e?.message ?? String(e)); }
			return;
		case 'refresh':
			return void fullScan();
		case 'open':
			return m.path ? openProject(m.path) : undefined;
		case 'activity.new': {
			const activity = snapshot.activity?.find(a => a.key === m.id);
			if (!activity?.path) return void vscode.window.showWarningMessage('La cartella di questa attività non è disponibile.');
			return void await vscode.commands.executeCommand('bottega.nuovaSessione', activity.source, activity.path);
		}
		case 'session.new':
			return void await vscode.commands.executeCommand('bottega.nuovaSessione');
		case 'here':
			return m.path ? openProject(m.path, false) : undefined;
		case 'claude':
			return m.path ? claudeIn(m.path, m.id) : undefined;
		case 'finder':
			return m.path ? reveal(m.path) : undefined;
		case 'xcode':
			return m.path ? openXcode(m.path) : undefined;
		case 'push':
			return m.path ? push(m.path) : undefined;
		case 'job.new':
			if (m.path && m.task) jobManager?.start(m.path, m.task, { night: !!m.night });
			return;
		case 'job.focus':
			if (m.id) jobManager?.focus(m.id);
			return;
		case 'job.stop': {
			if (!m.id) return;
			const job = jobManager?.list().find(j => j.id === m.id);
			const ok = await vscode.window.showWarningMessage(
				`Fermo il lavoro su ${job?.project ?? m.id}?`,
				{ modal: true, detail: 'Chiudo il suo terminale: la sessione di Claude viene interrotta.' },
				'Ferma',
			);
			if (ok === 'Ferma') jobManager?.stop(m.id);
			return;
		}
		case 'job.remove':
			if (m.id) jobManager?.remove(m.id);
			return;
		case 'memoria.search': {
			// `project` qui e' il NOME del progetto. Query vuota = memorie recenti.
			const query = m.query ?? '';
			// senza testo: gli ultimi ricordi, quanti ne chiede la plancia («Mostra altri ricordi»)
			const limit = Math.max(10, Math.min(200, Number(m.limite) || 10));
			try {
				if (!memoria?.available) throw new Error('Memoria non disponibile');
				const results = query.trim() ? await memoria.search(query, m.project, true) : await memoria.recent(m.project, { limit, strict: true });
				const board = await memoria.bacheca(m.project, 30);
				const bacheca = board.map(r => ({ at: r.at, project: r.project, sessionId: r.sessionId, kind: r.kind, summary: r.summary }));
				panelHost?.send({ type: 'memoria', query, project: m.project || '', results, bacheca, checkedAt: Date.now() });
			} catch {
				panelHost?.send({ type: 'memoria', query, project: m.project || '', error: 'Aggiornamento della memoria non riuscito. Riprovo tra un minuto.' });
			}
			return;
		}
		case 'memoria.grafici': {
			const dati = memoria ? await memoria.grafici(30) : null;
			panelHost?.send({ type: 'memoria.grafici', dati });
			return;
		}
		case 'memoria.remember':
			if (m.text) await memoria?.remember(m.text, m.project);
			return;
		case 'voice.toggle':
			return void assistant?.toggle();
		case 'vista':
			// la stanza che la Home sta mostrando: «racconta» con la Home davanti racconta quella
			if (typeof m.view === 'string') vistaHome = m.view;
			return;
		case 'stats.request':
			statsWanted = true;
			return void sendStats(true);
		case 'conti.request':
			panelHost?.send({ type: 'conti', conti: conti?.stato() ?? null });
			if (m.aggiorna || !conti?.stato().aggiornato || Date.now() - conti.stato().aggiornato > 10 * 60_000) void conti?.aggiorna().then(c => panelHost?.send({ type: 'conti', conti: c }));
			return;
		case 'assistant.ask':
			if (m.text) await assistant?.ask(m.text);
			return;
		case 'osservatorio.open':
			return void vscode.commands.executeCommand('bottega.openOsservatorio');
		case 'vedetta.nativa.open':
			return void vscode.commands.executeCommand('bottega.openVedettaMetal');
		case 'cielo.diag':
		case 'sfera.diag': {
			// Perche' il cielo del cruscotto o la sfera non usano WebGPU (docs/CONTRATTI.md, 7.7): una riga nel registro.
			const d = m as any;
			console.warn(`Bottega: ${m.type === 'cielo.diag' ? 'cielo del cruscotto' : 'sfera di Melissa'} su ${d.motore}${d.motivo ? `, motivo: ${d.motivo}` : ''} (gpu ${!!d.gpu}, secure ${!!d.isSecureContext}, coi ${!!d.crossOriginIsolated})`);
			return;
		}
		default:
			if (handleAppStore(m, { send: msg => panelHost?.send(msg) })) return;
			if (await handleConnettori(m)) return;
			await idee?.handle(m);
	}
}

/** La Home davanti, su una stanza o su un progetto. Con `activate` porta anche la Bottega in primo piano
 *  (clic dalla barra dei menu o da una notifica, quando l'app e' dietro). */
function showHome(view?: string, focusPath?: string, activate = false): void {
	panelHost?.show(focusPath);
	if (view) panelHost?.view(view);
	if (activate && !vscode.window.state.focused) {
		const app = path.resolve(vscode.env.appRoot, '..', '..', '..');
		execFile('open', ['-a', app]);
	}
}

// ---------- attivazione ----------

export async function activate(ctx: vscode.ExtensionContext) {
	const extPath = ctx.extensionPath;
	// i personaggi di Melissa: un file ciascuno in personaggi/, copiati in ~/.bottega/personaggi per la mod melissa
	try {
		caricaPersonaggi([path.join(extPath, 'personaggi')], s => console.warn(s));
		pubblicaPersonaggi(path.join(extPath, 'personaggi'));
	} catch (e) {
		console.warn(`personaggi: non copiati in ~/.bottega (${(e as Error).message})`);
	}
	registraSessioni(ctx);
	const registraMemoria = creaRegistroMemoria();
	terminalActivity = registerTerminalActivity(ctx, () => refreshDynamic(), a => {
		void registraMemoria({ source: 'terminale', sid: `${process.pid}:${a.id}:${a.startedAt}`, id: 'esito', at: a.updatedAt, cwd: a.path, who: 'Esito', text: `${a.title}
${a.evidence}` }).catch(() => console.warn('Memoria: registrazione terminale non riuscita'));
	});

	nucleo = new Nucleo(extPath);
	memoria = new Memoria(extPath);
	// Il motore dei riassunti: all'avvio e a ogni cambio dell'impostazione (08/10/2026).
	const syncMotore = () => void memoria?.setMotore(cfg().get<string>('memoria.motore', 'deepseek')).catch(() => console.warn('Memoria: motore dei riassunti non impostato'));
	syncMotore();
	ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('bottega.memoria.motore')) syncMotore();
	}));
	const syncMemory = () => void memoria?.sync().catch(() => console.warn('Memoria: acquisizione delle fonti non riuscita'));
	syncMemory();
	const memoryTick = setInterval(syncMemory, 60_000);
	ctx.subscriptions.push({ dispose: () => clearInterval(memoryTick) });
	statsEngine = new StatsEngine({ storageDir: ctx.globalStorageUri.fsPath, log: s => console.warn(s) });

	jobManager = new JobManager(ctx, {
		claudeCommand: () => cfg().get<string>('claudeCommand', 'claude'),
		maxParallelSetting: () => cfg().get<string | number>('jobs.maxParallel', 'auto'),
		systemStats: () => nucleo?.lastStats,
		liveSessions: () => snapshot.live,
		notify: args => nucleo?.fireAndForget('notify', args),
		updateMenubar: counts => (idee ? idee.paintMenubar(counts) : nucleo?.fireAndForget('menubar.update', { busy: counts.busy, waiting: counts.waiting, queued: counts.queued })),
		onChange: () => refreshDynamic(),
	});

	// Apple Intelligence: l'ultimo dato vero del Nucleo, che lo rilegge da solo (src/nucleo.ts, readCapabilities)
	cervelli = new Cervelli({
		memento: ctx.globalState,
		appleAvailable: () => !!nucleo?.available && !!nucleo.capabilities?.foundationModels,
		appleReason: () => (nucleo?.available ? nucleo.capabilities?.foundationModelsReason : 'il Nucleo non è acceso'),
		log: s => console.warn(s),
		// cambiato dalla barra, a voce o dall'iPhone: la barra e l'iPhone lo mostrano subito (CONTRATTI 9.8)
		onChange: () => setTimeout(() => (barraView?.refreshBrainNow(), ponte?.notify()), 0),
	});
	conti = registraConti(ctx);
	// gli occhi di Melissa sul codice dell'editor (src/occhio-host.ts)
	const occhio = registraOcchio(ctx);
	occhioGlobale = occhio;

	// cosa fa Andrea, dalla memoria: per Melissa e i personaggi il progetto attivo (il file davanti, o la prima cartella
	// del workspace), per l'iPhone il progetto piu' recente (CONTRATTI 9.11)
	const contestoMemoria = new ContestoMemoria();
	const cartellaAttiva = (): string => {
		const file = vscode.window.activeTextEditor?.document.uri;
		return (file?.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(file) : undefined)?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
	};
	let continuita: ContinuitaMelissa | undefined;
	try {
		continuita = new ContinuitaMelissa({ log: message => console.warn(message) });
		void continuita.leggi('melissa').catch(() => undefined);
	} catch {
		console.warn('Continuità: stato privato non leggibile, file conservato; la Bottega continua senza ponte memoria.');
	}
	assistant = new Assistant({
		continuita,
		contesto: () => contestoMemoria.testo(cartellaAttiva()),
		// la memoria dei personaggi nella Memoria della Bottega (CONTRATTI 9.11)
		registraMemoria: e => registraMemoria({ ...e, cwd: e.cwd ?? cartellaAttiva() }),
		// le regole della Vedetta per gli strumenti dei personaggi (CONTRATTI 9.11)
		regole: () => idee?.rules.state(),
		onMemory: row => {
			const file = vscode.window.activeTextEditor?.document.uri;
			const cwd = row.restored ? undefined : (file ? vscode.workspace.getWorkspaceFolder(file) : undefined)?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			void registraMemoria({ source: 'melissa', sid: 'conversazione', id: `${row.at}:${row.role}`, at: row.at, cwd, who: row.role === 'tu' ? 'Richiesta' : 'Risposta', text: row.text }).catch(() => console.warn('Memoria: registrazione Melissa non riuscita'));
		},
		nucleo: nucleo!,
		actions: {
			searchProjects,
			resolveProject,
			openProject: (p, nw) => openProject(p, nw),
			projectStatus,
			liveSessions: () => snapshot.live,
			startJob: (p, task) => jobManager!.start(p, task),
			listJobs: () => jobManager!.list(),
			resolveJob: id => jobManager!.resolve(id),
			writeToJob: (id, text) => jobManager!.write(id, text),
			stopJob: id => jobManager!.stop(id),
			gitPush: p => push(p),
			openFile,
			codice: occhio,
			showPlancia,
			rulesSummary: p => idee?.rulesSummary(p) ?? 'Il semaforo non è pronto.',
			briefing: async () => (idee ? idee.briefingFacts() : 'Il briefing non è pronto.'),
			prepareContinue: async name => idee?.prepareForMelissa(name),
			startPrepared: (p, prompt) => void jobManager!.start(p, prompt),
			whereSolved: async q => (idee ? idee.whereSolvedText(q) : 'La ricerca non è pronta.'),
			storeSummary: () => idee?.storeSummary() ?? 'Il radar non è pronto.',
			queueNight: (p, task) => idee?.queueNight(p, task) ?? 'La coda della notte non è pronta.',
			switchBrain,
			readSession,
			activityList,
			activityDetail,
			terminalOutput,
			showCruscotto,
		},
		liveSessions: () => snapshot.live,
		jobs: () => (jobManager ? jobManager.list() : []),
		work: () => snapshot.work,
		cervelli,
		systemStats: () => nucleo?.lastStats,
		projectCount: () => snapshot.projects.length,
		bacheca: async project => (memoria ? (await memoria.bacheca(project)).map(r => ({ title: r.project, text: r.summary, project: r.project })) : []),
		memoriaSearch: async (text, project) => (memoria ? (await memoria.search(text, project)).map(r => ({ title: r.title, text: r.text, project: r.project })) : []),
		memoriaRemember: async (text, project) => (memoria ? memoria.remember(text, project) : false),
		secrets: ctx.secrets,
		onState: state => {
			snapshot.assistant = state;
			panelHost?.send({ type: 'assistant', state });
			barraView?.update();
			ponte?.notify();
		},
		onConverse: () => barraView?.reveal(),
	});

	panelHost = new PlanciaPanel(ctx.extensionUri, () => snapshot, changed.event, m => void onPlanciaMessage(m));
	assistant.wire(ctx);
	// la regia dei personaggi per la mod melissa: decide qui chi parla, sul socket locale (CONTRATTI 9.11)
	const melissa = assistant;
	const regiaMod = avviaRegiaPersonaggi(new RegiaPersonaggi({ chiVuole: f => melissa.chiVuole(f), ascolta: f => melissa.impegni.ascolta(f), strumenti: melissa.strumenti, log: r => melissa.scriviRegistro(r) }), r => melissa.scriviRegistro(r));
	ctx.subscriptions.push({ dispose: () => regiaMod.chiudi() });
	// l'isola nella tacca segue anche Cline, Codex e i terminali integrati, sempre (CONTRATTI 1, Andrea 6/10/2026)
	isolaAttivita = new IsolaAttivita({ ...isolaVera(), log: r => melissa.scriviRegistro(r) });
	ctx.subscriptions.push({ dispose: () => isolaAttivita?.dispose() });
	const savedRegia = ctx.globalState.get<RegiaDigest>('regia.digest');
	if (savedRegia?.text && Number.isFinite(savedRegia.at)) regiaDigest = savedRegia;
	saveRegiaDigest = digest => { void ctx.globalState.update('regia.digest', digest); };
	const regiaSchedule = setInterval(() => void refreshRegiaDigest(), 60 * 60_000);
	const regiaFirst = setTimeout(() => void refreshRegiaDigest(), 15_000);
	ctx.subscriptions.push({ dispose: () => { clearInterval(regiaSchedule); clearTimeout(regiaFirst); } });
	nucleo.on('regia.closed', () => { regiaMetalOpen = false; regiaMetalSignature = ''; });
	nucleo.on('down', () => { regiaMetalOpen = false; regiaMetalSignature = ''; });

	// La Bottega per iPhone: Melissa e i lavori raggiungibili dalla rete Tailscale (src/ponte.ts).
	ponte = registerPonte(ctx, {
		assistant: () => assistant,
		nucleo: () => nucleo,
		ready: () => snapshot.scannedAt > 0,
		work: () => snapshot.work,
		activity: () => snapshot.activity,
		regiaDigest: () => regiaDigest,
		memoria: () => contestoMemoria.subito(),
		counts: () => snapshot.workCounts,
		writeJob: (id, text) => !!jobManager?.write(id, text),
		// la scheda di sessione dall'iPhone (CONTRATTI 9.5)
		projects: () => snapshot.projects.map(p => p.path),
		writeJobRaw: (id, data, invio) => !!jobManager?.type(id, data, invio),
		cervelli: () => cervelli,
		jobTerminal: id => jobManager?.terminal(id),
		regole: () => {
			const r = idee?.rules.state();
			if (!r?.checkedAt) return null;
			return Object.values(r.projects).map(p => ({
				path: p.path,
				progetto: snapshot.projects.find(x => x.path === p.path)?.name ?? path.basename(p.path),
				livello: p.livello,
				frase: p.hits.find(h => h.livello === 'rosso')?.frase,
			}));
		},
		// gli allarmi della stanza App Store: all'iPhone quando Andrea e' lontano (CONTRATTI 13.7)
		// in piu' gli avvisi di ricarica dei servizi (src/conti.ts, CONTRATTI 14)
		negozio: () => {
			const a = allarmiAppStore();
			const c = conti?.allarmi() ?? [];
			return a === null && !c.length ? null : [...(a ?? []), ...c];
		},
	});
	ctx.subscriptions.push(changed.event(() => ponte?.notify()));

	idee = new Idee({
		projects: () => snapshot.projects,
		live: () => snapshot.live,
		workCounts: () => snapshot.workCounts,
		work: () => snapshot.work,
		activity: () => snapshot.activity,
		nucleo: nucleo!,
		memoria: memoria!,
		jobs: jobManager!,
		assistant: () => assistant,
		stats: statsEngine!,
		statsUpdated: stats => { void publishStats(stats).catch(e => console.warn(`ore: ${e}`)); },
		send: msg => panelHost?.send(msg),
		showHome: (view, focusPath) => showHome(view, focusPath, true),
		push,
		openProject: p => openProject(p),
		refresh: () => refreshDynamic(),
		log: s => console.warn(s),
		appstore: briefingAppStore,
	});
	// le regole rosse della Vedetta come forzature, per chi ha quel mestiere (Darlene, CONTRATTI 9.11)
	idee.rules.onChange(s => forzatureDalleRegole(s, registraMemoria));
	idee.start(ctx);
	ctx.subscriptions.push(changed.event(() => idee?.activityChanged()));
	appStore = registerAppStore(ctx, {
		radar: () => idee?.radar,
		projects: () => snapshot.projects,
		send: msg => panelHost?.send(msg),
		nucleo: () => nucleo,
		showHome: view => showHome(view, undefined, true),
		log: s => console.warn(s),
	});
	registraStrumentiConnettori(registerConnettori(ctx, { projects: () => snapshot.projects, send: msg => panelHost?.send(msg), showHome: view => showHome(view, undefined, true), log: s => console.warn(s) }));
	// Melissa legge le stanze dagli stessi stati della plancia (src/strumenti-stanze.ts)
	const calcolaStats = async () => {
		if (!snapshot.scannedAt) await fullScan();
		return statsEngine ? { ...await statsEngine.compute({ projects: snapshot.projects, live: snapshot.live }), observedActivity: summarizeObservedActivity(snapshot.activity) } : null;
	};
	registraStrumentiStanze({
		progetto: resolveProject, stats: calcolaStats, appStore: () => appStore?.state(), regole: () => idee?.rules.state(), radar: () => idee?.radar.state(),
		rileggiStack: async () => { await Promise.all([idee?.radar.vercel?.refresh(snapshot.projects, { force: true }), idee?.github.refresh(true)]); },
		clienti: async mese => ((await calcolaStats()) && idee ? idee.clientReport(mese) : null),
		memoria: () => memoria, connettori: stanzaConnettori, notte: () => idee?.night.state(),
		mostra: (view, p) => showHome(view, p), send: msg => panelHost?.send(msg), osservatorio: () => vscode.commands.executeCommand('bottega.openOsservatorio'),
	});

	// La parte nativa (docs/CONTRATTI.md, 7 e 8): Osservatorio, bacheca viva, categorie del lavoro (Apple
	// Intelligence), schermate delle trascrizioni lette con Vision e rese cercabili nella Memoria.
	osservatorio = new Osservatorio(nucleo!, datiOsservatorio, s => console.warn(s));
	vedettaNativa = new VedettaNativa(
		nucleo!,
		() => datiVedetta(snapshot.projects, snapshot.rules),
		p => showHome('vedetta', p, true),
		() => void idee?.rules.check(snapshot.projects, { force: true }),
	);
	ctx.subscriptions.push(changed.event(() => vedettaNativa?.push()));
	const inFondo = () => {
		if (nucleo?.capabilities?.foundationModels !== false) memoria?.classificaInFondo();
		memoria?.immaginiInFondo();
	};
	nucleo!.on('capabilities', () => {
		nucleo?.fireAndForget('bacheca.live', { on: true });
		inFondo();
	});
	const classifica = setInterval(inFondo, 30 * 60_000);
	ctx.subscriptions.push({ dispose: () => clearInterval(classifica) });

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
	status.command = 'bottega.openPlancia';
	const paint = () => {
		const c = snapshot.workCounts;
		const attive = snapshot.activity.filter(a => a.status === 'in corso' || a.status === 'ti aspetta');
		const inCorso = attive.filter(a => a.status === 'in corso').length;
		const tiAspetta = attive.length - inCorso;
		const toPush = snapshot.projects.filter(p => (p.git?.ahead ?? 0) > 0).length;
		status.text = `$(sparkle) ${inCorso}` + (tiAspetta ? `  $(bell-dot) ${tiAspetta}` : '') + (toPush ? `  $(cloud-upload) ${toPush}` : '');
		status.tooltip =
			`${inCorso} attività al lavoro, ${tiAspetta} ti aspettano; Claude Code, Cline, Codex e terminali integrati` +
			(c.inCoda ? `, ${c.inCoda} in coda` : '') + (c.stanotte ? `, ${c.stanotte} per stanotte` : '') +
			(toPush ? `\n${toPush} progetti con commit da spingere` : '');
		status.show();
	};
	paintStatus = paint;

	ctx.subscriptions.push(
		changed,
		treesChanged,
		status,
		changed.event(paint),
		{ dispose: () => nucleo?.dispose() },
		{ dispose: () => jobManager?.dispose() },
		...roomView('bottega.live', new LiveTree(), 'regia'),
		...roomView('bottega.cruscotto', new CruscottoTree(), 'cruscotto'),
		...roomView('bottega.projects', new ProjectTree(), 'plancia'),
		vscode.window.registerWebviewPanelSerializer('bottega.plancia', {
			deserializeWebviewPanel: async panel => panelHost?.adopt(panel),
		}),
		vscode.commands.registerCommand('bottega.openPlancia', (focus?: string) => panelHost!.show(typeof focus === 'string' ? focus : undefined)),
		vscode.commands.registerCommand('bottega.openRegia', () => showPlancia('regia')),
		vscode.commands.registerCommand('bottega.refresh', () => fullScan()),
		vscode.commands.registerCommand('bottega.claudeHere', (uri?: vscode.Uri) => {
			const cwd = uri?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
			claudeIn(cwd);
		}),
		vscode.commands.registerCommand('bottega.openProject', async () => {
			const pick = await vscode.window.showQuickPick(
				snapshot.projects.map(p => ({ label: p.name, description: ago(p.touchedAt), detail: p.path })),
				{ placeHolder: 'Quale progetto apro?', matchOnDetail: true },
			);
			if (pick?.detail) openProject(pick.detail);
		}),
		vscode.commands.registerCommand('bottega.item.open', (p: Project) => openProject(p.path)),
		vscode.commands.registerCommand('bottega.item.claude', (p: Project) => claudeIn(p.path)),
		vscode.commands.registerCommand('bottega.item.finder', (p: Project) => reveal(p.path)),
		vscode.commands.registerCommand('bottega.item.xcode', (p: Project) => openXcode(p.path)),
		vscode.commands.registerCommand('bottega.voice.toggle', () => assistant!.toggle()),
		vscode.commands.registerCommand('bottega.assistant.ask', async () => {
			const text = await vscode.window.showInputBox({ title: 'Chiedi a Melissa', prompt: 'Cosa le chiedi?', ignoreFocusOut: true });
			if (text) await assistant!.ask(text);
		}),
		vscode.commands.registerCommand('bottega.memoria.install', () => memoria!.install()),
		vscode.window.onDidCloseTerminal(t => jobManager?.onTerminalClosed(t)),
	);

	// Eventi del Nucleo.
	nucleo.on('system.stats', (s: SystemStats) => {
		snapshot.system = s;
		jobManager?.kick();
		refreshDynamic();
	});
	nucleo.on('system.pressure', () => jobManager?.kick());
	nucleo.on('notify.clicked', (m: any) => {
		if (typeof m?.id === 'string' && m.id.startsWith('job:')) jobManager?.focus(m.id.slice(4));
		if (typeof m?.id === 'string' && m.id.startsWith('aggiorna:')) void aggiornamenti?.clic(m.id, m.action);
	});
	// VS Code solo quando Claude Code lo chiede, Claude Code sempre aggiornato (src/aggiorna.ts)
	aggiornamenti = registerAggiornamenti(ctx, () => nucleo);
	// Il Nucleo (embedding, Metal, scorciatoia di Melissa) parte qualche secondo dopo: i primi secondi sono della
	// finestra e di Claude Code.
	const nucleoStart = setTimeout(() => nucleo?.start(), 3000);
	ctx.subscriptions.push({ dispose: () => clearTimeout(nucleoStart) });

	// Il registro delle sessioni vive cambia spesso: lo si osserva, con un piccolo ritardo
	// perche' Claude Code riscrive il file in piu' passate.
	let t: NodeJS.Timeout | undefined;
	try {
		const w = fs.watch(SESSIONS_DIR, () => {
			clearTimeout(t);
			t = setTimeout(liveScan, 400);
		});
		ctx.subscriptions.push({ dispose: () => w.close() });
	} catch {
		// Claude Code non ha ancora creato la cartella: resta il giro periodico
	}
	// Il registro delle sessioni lo segue gia' il watcher: il giro periodico e' solo una rete di sicurezza.
	const tick = setInterval(liveScan, 60_000);
	const otherTick = setInterval(() => void updateExternalActivity(), 20_000);
	// La scansione completa (git in ogni progetto) solo con la finestra davanti; tornando davanti, se e' vecchia, la
	// rifa il gestore qui sotto.
	const slow = setInterval(() => vscode.window.state.focused && void fullScan(), 120_000);
	ctx.subscriptions.push({ dispose: () => (clearInterval(tick), clearInterval(slow), clearInterval(otherTick)) });
	ctx.subscriptions.push(
		panelHost.onDidChangeVisibility.event(visible => {
			statsPace();
			if (visible && statsWanted) void sendStats(false);
		}),
	);
	vscode.window.onDidChangeWindowState(s => s.focused && Date.now() - snapshot.scannedAt > 30_000 && void fullScan(), null, ctx.subscriptions);

	// Melissa vive nella barra laterale destra: sfera, conversazione, tutte le sessioni, cervello e conti.
	barraView = new BarraView(
		ctx.extensionUri,
		{
			assistant: () => assistant?.getState(),
			work: () => snapshot.work,
			activity: () => snapshot.activity,
			workCounts: () => snapshot.workCounts,
			board: async () => (memoria ? memoria.bacheca(undefined, 180) : []),
			brain: async () => cervelli!.state(),
		},
		{
			converse: () => assistant?.toggleConversation(),
			ask: text => void assistant?.ask(text),
			toggleVoice: () => void assistant?.toggle(),
			setPersonaggio: chi => void assistant?.setPersonaggio(chi),
			setBrain: async (p, m, sempre) => void (await cervelli!.set(p, m, sempre)),
			setEffort: async e => void (await cervelli!.setEffort(e)),
			focusJob: id => jobManager?.focus(id),
			writeJob: (id, text) => {
				if (!jobManager?.write(id, text)) void vscode.window.showWarningMessage('Quel lavoro non ha più un terminale aperto.');
			},
			open: p => openProject(p),
			resume: (p, id) => claudeIn(p, id),
			home: view => showPlancia(view ?? 'plancia'),
			command: id => {
				const map: Record<string, () => unknown> = {
					briefing: () => vscode.commands.executeCommand('bottega.briefing'),
					regole: () => showPlancia('vedetta'),
					lavori: () => showPlancia('lavori'),
					cruscotto: () => showPlancia('cruscotto'),
					conti: () => vscode.commands.executeCommand('bottega.apriConti'),
					racconta: () => vscode.commands.executeCommand('bottega.racconta'),
					'racconta.ferma': () => assistant?.fermaRacconto(),
					continua: () => vscode.commands.executeCommand('bottega.continua'),
					cerca: () => vscode.commands.executeCommand('bottega.cerca'),
				};
				void map[id]?.();
			},
			log: line => assistant?.note(line),
			sessionBoard: async sid => (memoria ? (await memoria.bacheca(undefined, 180)).filter(r => r.sessionId === sid).slice(0, 12) : []),
		},
	);
	// il Nucleo ha detto cosa sa fare (anche dopo un riavvio): Apple Intelligence si rilegge subito nell'elenco dei cervelli
	nucleo?.on('capabilities', () => barraView?.refreshBrainNow());
	ctx.subscriptions.push(
		vscode.window.registerWebviewViewProvider(BarraView.id, barraView),
		{ dispose: () => barraView?.dispose() },
		changed.event(() => barraView?.update()),
		vscode.commands.registerCommand('bottega.barra.apri', () => barraView?.reveal()),
		vscode.commands.registerCommand('bottega.openVedetta', () => showPlancia('vedetta')),
		vscode.commands.registerCommand('bottega.openVedettaMetal', async () => {
			try {
				await vedettaNativa?.show();
			} catch (e: any) {
				vscode.window.showWarningMessage(e?.message ?? String(e));
			}
		}),
		vscode.commands.registerCommand('bottega.openVercel', () => showPlancia('vercel')),
		vscode.commands.registerCommand('bottega.openClienti', () => showPlancia('clienti')),
		vscode.commands.registerCommand('bottega.openAppStore', () => showPlancia('appstore')),
		vscode.commands.registerCommand('bottega.briefing', () => {
			showPlancia('plancia');
			void idee?.listen();
		}),
		vscode.commands.registerCommand('bottega.regole.controlla', () => void idee?.rules.check(snapshot.projects, { force: true })),
		vscode.commands.registerCommand('bottega.cerca', async () => {
			const q = await vscode.window.showInputBox({ title: 'Dove l\'ho già risolto?', prompt: 'Cerca nella memoria e nel codice di tutti i progetti', ignoreFocusOut: true });
			if (!q) return;
			showPlancia('memoria');
			panelHost?.send({ type: 'ricerca.avvia', query: q });
		}),
		vscode.commands.registerCommand('bottega.continua', async () => {
			const pick = await vscode.window.showQuickPick(
				snapshot.projects.map(p => ({ label: p.name, description: ago(p.touchedAt), detail: p.path })),
				{ placeHolder: 'Quale progetto riprendo?', matchOnDetail: true },
			);
			if (pick?.detail) await idee?.handle({ type: 'continua.prepare', path: pick.detail }).then(() => showPlancia('plancia'));
		}),
		vscode.commands.registerCommand('bottega.openMelissa', () => showPlancia('melissa')),
		// «racconta» (barra) e «Spiega con Melissa» (editor): quello che Andrea ha davanti, letto, analizzato da DeepSeek e
		// raccontato con la voce ElevenLabs; il terminale della barra mostra i passi
		vscode.commands.registerCommand('bottega.racconta', async () => {
			barraView?.reveal();
			if (assistant?.getState().raccontando) return assistant.fermaRacconto();
			void assistant?.racconta(await daRaccontare());
		}),
		vscode.commands.registerCommand('bottega.spiegaCodice', () => {
			barraView?.reveal();
			const r = occhio.racconto();
			void assistant?.racconta(r ? { tipo: 'codice', ...r } : undefined);
		}),
		vscode.commands.registerCommand('bottega.raccontaFerma', () => assistant?.fermaRacconto()),
		// i conti dei servizi: il Cruscotto, sulla sezione «Servizi» (dalla barra di Melissa e dagli avvisi di ricarica)
		vscode.commands.registerCommand('bottega.apriConti', () => {
			showPlancia('cruscotto');
			panelHost?.send({ type: 'conti.mostra' });
		}),
		vscode.commands.registerCommand('bottega.openCruscotto', () => showPlancia('cruscotto')),
		vscode.commands.registerCommand('bottega.openOsservatorio', async () => {
			try {
				await osservatorio?.show();
			} catch (e: any) {
				vscode.window.showWarningMessage(e?.message ?? String(e));
			}
		}),
		vscode.commands.registerCommand('bottega.voice.converse', () => assistant?.toggleConversation()),
	);

	// VS Code compilato dai sorgenti non ha il verificatore di firme di Microsoft: con la verifica
	// accesa ogni estensione da Open VSX si fermerebbe su "cannot verify the extension signature".
	const ext = vscode.workspace.getConfiguration('extensions');
	if (ext.get<boolean>('verifySignature') !== false) {
		void ext.update('verifySignature', false, vscode.ConfigurationTarget.Global);
	}

	// La Home e' fissa: si apre sempre, anche con una cartella aperta (senza rubare il fuoco).
	if (cfg().get('openOnStartup', true)) {
		panelHost.show(undefined, { preserveFocus: !!vscode.workspace.workspaceFolders?.length });
	}
	// Senza await: l'attivazione finisce subito e la scansione (ormai asincrona) riempie la Home quando e' pronta.
	void fullScan();
	void updateExternalActivity();
	// La prima volta la barra di Melissa si apre da sola, poi il fuoco torna all'editor; dopo decide Andrea.
	if (!ctx.globalState.get('bottega.barraAperta')) {
		await ctx.globalState.update('bottega.barraAperta', true);
		await vscode.commands.executeCommand(`workbench.view.extension.${BarraView.container}`).then(undefined, () => undefined);
		await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup').then(undefined, () => undefined);
	}
	ensureClaudeExtension(ctx);
	registerCline(ctx);
	registerTerminale(ctx, {
		cartellaLavoro: t => jobManager?.list().find(j => jobManager!.terminal(j.id) === t)?.path,
		// Agnes nel terminale (docs/CONTRATTI.md, 12): gli stessi cervelli di Melissa, Apple dal Nucleo
		agnes: {
			cervelli: cervelli!,
			nucleo: () => nucleo,
			apple: () => !!nucleo?.available && !!nucleo.capabilities?.foundationModels,
			// una domanda scritta nel terminale («quanto abbiamo guadagnato ieri?») va a Melissa, muta, con i suoi strumenti
			melissa: async domanda => {
				if (!assistant) throw new Error('Melissa non e\' ancora pronta');
				if (assistant.busy()) throw new Error('Melissa sta gia\' rispondendo, riprova tra un attimo');
				// la risposta si legge nel terminale, non si ascolta: cifre e non numeri in lettere, poche righe
				return assistant.askRemote(`${domanda}\n\n(Scritta nel terminale: rispondi per scritto, breve, con le cifre in numeri e gli euro col simbolo €.)`);
			},
		},
	});
	ensureItalian(ctx);
}

/** La Bottega parla italiano: al primo avvio installa il pacchetto di lingua da Open VSX e imposta la
 *  lingua in argv.json. Una volta sola, cosi' chi rimette l'inglese non se lo vede ricambiare. */
async function ensureItalian(ctx: vscode.ExtensionContext) {
	if (!cfg().get('italiano', true) || vscode.env.language.startsWith('it') || ctx.globalState.get('bottega.italianoFatto')) {
		return;
	}
	await ctx.globalState.update('bottega.italianoFatto', true);
	const id = 'MS-CEINTL.vscode-language-pack-it';
	try {
		if (!vscode.extensions.getExtension(id)) {
			await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
		}
		const argv = path.join(os.homedir(), '.bottega', 'argv.json');
		let text = fs.existsSync(argv) ? fs.readFileSync(argv, 'utf8') : '{\n}\n';
		text = /"locale"\s*:/.test(text)
			? text.replace(/"locale"\s*:\s*"[^"]*"/, '"locale": "it"')
			: text.replace('{', '{\n\t"locale": "it",');
		fs.writeFileSync(argv, text);
		const choice = await vscode.window.showInformationMessage('La Bottega sara\' in italiano dal prossimo avvio.', 'Riavvia adesso');
		if (choice) {
			// La lingua cambia solo riaprendo l'app: un processo staccato la riapre dopo la chiusura.
			const app = path.resolve(vscode.env.appRoot, '..', '..', '..');
			spawn('/bin/sh', ['-c', `sleep 3; open -a "${app}"`], { detached: true, stdio: 'ignore' }).unref();
			await vscode.commands.executeCommand('workbench.action.quit').then(undefined, () => undefined);
		}
	} catch {
		vscode.window.showWarningMessage('Non riesco a installare il pacchetto italiano: cercalo nelle estensioni come "Italian Language Pack".');
	}
}

/** L'estensione ufficiale Claude Code da Open VSX. Si riprova a ogni avvio finche' non c'e' (al massimo tre
 *  tentativi al giorno), e solo dopo aver spento la verifica delle firme: con la verifica accesa ogni estensione da
 *  Open VSX si ferma su "cannot verify the extension signature" (e' cosi' che il primo tentativo era caduto). */
async function ensureClaudeExtension(ctx: vscode.ExtensionContext) {
	const id = 'anthropic.claude-code';
	if (!cfg().get('installClaudeExtension', true) || vscode.extensions.getExtension(id)) return;
	const day = new Date().toISOString().slice(0, 10);
	const tries = ctx.globalState.get<{ day: string; n: number }>('bottega.claudeInstall');
	const n = tries?.day === day ? tries.n : 0;
	if (n >= 3) return;
	await ctx.globalState.update('bottega.claudeInstall', { day, n: n + 1 });
	const ext = vscode.workspace.getConfiguration('extensions');
	if (ext.get<boolean>('verifySignature') !== false) {
		await ext.update('verifySignature', false, vscode.ConfigurationTarget.Global);
	}
	try {
		await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
		vscode.window.showInformationMessage('Ho installato l\'estensione Claude Code da Open VSX.');
	} catch (e: any) {
		const why = String(e?.message ?? e ?? '').split('\n')[0].slice(0, 200);
		const choice = await vscode.window.showWarningMessage(
			`Non riesco a installare l'estensione Claude Code (tentativo ${n + 1} di 3 oggi), riprovo al prossimo avvio.${why ? ` Motivo: ${why}` : ''}`,
			'Apri le estensioni',
		);
		if (choice) void vscode.commands.executeCommand('workbench.extensions.search', id);
	}
}

export function deactivate() {
	clearTimeout(statsActivityTimer);
}
