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
import { Assistant, AssistantState } from './assistant';
import { StatsEngine } from './stats';
import { Idee, IdeeDynamic } from './idee';
import { SferaView } from './sfera';
import { handleConnettori, registerConnettori } from './connettori-host';

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

const DEFAULT_ASSISTANT: AssistantState = { enabled: true, conversing: false, state: 'idle', log: [], brain: 'agnes' };

let snapshot: Snapshot = { projects: [], live: [], elsewhere: [], scannedAt: 0, home: os.homedir(), jobs: [], work: [], workCounts: workCounts([]), jobLimit: 3, jobLimitReason: 'valori predefiniti', system: null, nucleo: false, assistant: DEFAULT_ASSISTANT };
const changed = new vscode.EventEmitter<Snapshot>();
// Le viste ad albero vogliono un evento senza argomento: con un argomento aggiornerebbero solo quell'elemento.
const treesChanged = new vscode.EventEmitter<void>();
changed.event(() => treesChanged.fire());
let scanning: Promise<void> | undefined;

let nucleo: Nucleo | undefined;
let jobManager: JobManager | undefined;
let memoria: Memoria | undefined;
let assistant: Assistant | undefined;
let panelHost: PlanciaPanel | undefined;
let statsEngine: StatsEngine | undefined;
let idee: Idee | undefined;
let sferaView: SferaView | undefined;
let paintStatus: (() => void) | undefined;
/** Il cruscotto si calcola solo dopo che la plancia l'ha chiesto almeno una volta. */
let statsWanted = false;
let statsSent = '';

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

function withDynamic(base: Omit<Snapshot, 'jobs' | 'work' | 'workCounts' | 'jobLimit' | 'jobLimitReason' | 'system' | 'nucleo' | 'assistant' | keyof IdeeDynamic>): Snapshot {
	const setting = cfg().get<string | number>('jobs.maxParallel', 'auto');
	const stats = nucleo?.lastStats;
	const jobs = jobManager ? jobManager.list() : snapshot.jobs;
	const work = workItems(jobs, base.live, l => projectOfLive(base.projects, l), base.home);
	return {
		...base,
		jobs,
		work,
		workCounts: workCounts(work),
		jobLimit: computeLimit(setting, stats),
		jobLimitReason: limitReason(setting, stats),
		system: stats ?? null,
		nucleo: nucleo?.available ?? false,
		assistant: assistant ? assistant.getState() : snapshot.assistant,
		...(idee ? idee.dynamic() : {}),
	};
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
	panelHost?.pushSnapshot(snapshot);
	paintStatus?.();
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

class LiveTree implements vscode.TreeDataProvider<LiveSession> {
	readonly onDidChangeTreeData = treesChanged.event;
	getChildren() {
		return snapshot.live;
	}
	getTreeItem(s: LiveSession): vscode.TreeItem {
		const project = snapshot.projects.find(p => p.live.some(l => l.pid === s.pid));
		const label = project?.name ?? (s.cwd === snapshot.home ? 'home' : path.basename(s.cwd));
		const item = new vscode.TreeItem(label);
		item.description = `${STATUS[s.status] ?? s.status}, ${ago(s.statusSince)}`;
		item.tooltip = new vscode.MarkdownString(`**${s.title ?? s.name}**\n\n${s.cwd}\n\nPID ${s.pid}`);
		item.iconPath = new vscode.ThemeIcon(
			s.status === 'busy' ? 'loading~spin' : 'circle-filled',
			new vscode.ThemeColor(s.status === 'busy' ? 'bottega.sodio' : 'descriptionForeground'),
		);
		if (project) item.command = { command: 'bottega.openPlancia', title: 'Plancia', arguments: [project.path] };
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
		if (p.live.length) notes.push(p.live.length === 1 ? 'Claude attivo' : `${p.live.length} Claude attivi`);
		if (p.git?.ahead) notes.push(`${p.git.ahead} da spingere`);
		if (p.git?.changes) notes.push(`${p.git.changes} modifiche`);
		if (!notes.length) notes.push(ago(p.touchedAt));
		item.description = notes.join(', ');
		item.tooltip = p.path;
		item.contextValue = p.xcodeProject ? 'project.apple' : 'project';
		const warn = (p.git?.ahead ?? 0) > 0 || (p.git && !p.git.upstream);
		item.iconPath = p.live.length
			? new vscode.ThemeIcon('sparkle', new vscode.ThemeColor('bottega.sodio'))
			: warn
				? new vscode.ThemeIcon('cloud-upload', new vscode.ThemeColor('bottega.sodio'))
				: new vscode.ThemeIcon(p.git ? 'repo' : 'folder');
		item.command = { command: 'bottega.openPlancia', title: 'Plancia', arguments: [p.path] };
		return item;
	}
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
	if (proj.live.length) parts.push(`${proj.live.length} sessioni di Claude attive adesso`);
	const titles = proj.sessions.slice(0, 3).map(s => s.title).filter(Boolean);
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

function editorContext(): { path?: string; selection?: string } {
	const ed = vscode.window.activeTextEditor;
	if (!ed) return {};
	const text = ed.document.getText(ed.selection);
	return { path: ed.document.uri.fsPath, selection: text || undefined };
}

function showPlancia(section?: string): void {
	panelHost?.show();
	if (section) panelHost?.send({ type: 'view', view: section.toLowerCase() });
}

// ---------- cruscotto ----------

/** Calcola le statistiche (solo i file cambiati) e le manda alla plancia se sono cambiate o se
 *  la plancia le ha chieste. Contratto: docs/CONTRATTI.md, sezione 3, messaggio "stats". */
async function sendStats(force: boolean): Promise<void> {
	if (!statsEngine || !panelHost?.isOpen) return;
	if (!snapshot.scannedAt) await fullScan();
	try {
		const stats = await statsEngine.compute({ projects: snapshot.projects, live: snapshot.live });
		const sig = StatsEngine.signature(stats);
		if (!force && sig === statsSent) return;
		statsSent = sig;
		panelHost.send({ type: 'stats', stats });
	} catch (e: any) {
		panelHost.send({ type: 'stats', stats: null, error: `Non riesco a leggere le sessioni di Claude Code: ${e?.message ?? e}` });
	}
}

// ---------- messaggi dalla plancia ----------

async function onPlanciaMessage(m: PlanciaMessage): Promise<void> {
	switch (m.type) {
		case 'refresh':
			return void fullScan();
		case 'open':
			return m.path ? openProject(m.path) : undefined;
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
			const results = memoria ? (query.trim() ? await memoria.search(query, m.project) : await memoria.recent(m.project)) : [];
			const board = memoria ? await memoria.bacheca(m.project, 30) : [];
			const bacheca = board.map(r => ({ at: r.at, project: r.project, sessionId: r.sessionId, kind: r.kind, summary: r.summary }));
			// La risposta riporta sempre `query`: le risposte vecchie vengono scartate dalla plancia.
			panelHost?.send({ type: 'memoria', query, results, bacheca });
			return;
		}
		case 'memoria.remember':
			if (m.text) await memoria?.remember(m.text, m.project);
			return;
		case 'voice.toggle':
			return void assistant?.toggle();
		case 'stats.request':
			statsWanted = true;
			return void sendStats(true);
		case 'assistant.ask':
			if (m.text) await assistant?.ask(m.text);
			return;
		default:
			if (await handleConnettori(m)) return;
			await idee?.handle(m);
	}
}

/** La Home davanti, su una stanza o su un progetto. Con `activate` porta anche la Bottega in primo piano
 *  (clic dalla barra dei menu o da una notifica, quando l'app e' dietro). */
function showHome(view?: string, focusPath?: string, activate = false): void {
	panelHost?.show(focusPath);
	if (view) panelHost?.send({ type: 'view', view });
	if (activate && !vscode.window.state.focused) {
		const app = path.resolve(vscode.env.appRoot, '..', '..', '..');
		execFile('open', ['-a', app]);
	}
}

// ---------- attivazione ----------

export async function activate(ctx: vscode.ExtensionContext) {
	const extPath = ctx.extensionPath;

	nucleo = new Nucleo(extPath);
	memoria = new Memoria(extPath);
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

	assistant = new Assistant({
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
			editorContext,
			showPlancia,
			rulesSummary: p => idee?.rulesSummary(p) ?? 'Il semaforo non è pronto.',
			briefing: async () => (idee ? idee.briefingFacts() : 'Il briefing non è pronto.'),
			prepareContinue: async name => idee?.prepareForMelissa(name),
			startPrepared: (p, prompt) => void jobManager!.start(p, prompt),
			whereSolved: async q => (idee ? idee.whereSolvedText(q) : 'La ricerca non è pronta.'),
			storeSummary: () => idee?.storeSummary() ?? 'Il radar non è pronto.',
			queueNight: (p, task) => idee?.queueNight(p, task) ?? 'La coda della notte non è pronta.',
		},
		liveSessions: () => snapshot.live,
		jobs: () => (jobManager ? jobManager.list() : []),
		work: () => snapshot.work,
		systemStats: () => nucleo?.lastStats,
		projectCount: () => snapshot.projects.length,
		bacheca: async project => (memoria ? (await memoria.bacheca(project)).map(r => ({ title: r.project, text: r.summary, project: r.project })) : []),
		memoriaSearch: async (text, project) => (memoria ? (await memoria.search(text, project)).map(r => ({ title: r.title, text: r.text, project: r.project })) : []),
		memoriaRemember: async (text, project) => (memoria ? memoria.remember(text, project) : false),
		secrets: ctx.secrets,
		onState: state => {
			snapshot.assistant = state;
			panelHost?.send({ type: 'assistant', state });
			sferaView?.send(state);
		},
		onConverse: () => sferaView?.reveal(),
	});

	panelHost = new PlanciaPanel(ctx.extensionUri, () => snapshot, changed.event, m => void onPlanciaMessage(m));
	assistant.wire(ctx);

	idee = new Idee({
		projects: () => snapshot.projects,
		live: () => snapshot.live,
		workCounts: () => snapshot.workCounts,
		nucleo: nucleo!,
		memoria: memoria!,
		jobs: jobManager!,
		assistant: () => assistant,
		stats: statsEngine!,
		send: msg => panelHost?.send(msg),
		showHome: (view, focusPath) => showHome(view, focusPath, true),
		push,
		openProject: p => openProject(p),
		refresh: () => refreshDynamic(),
		log: s => console.warn(s),
	});
	idee.start(ctx);
	registerConnettori(ctx, { projects: () => snapshot.projects, send: msg => panelHost?.send(msg), showHome: view => showHome(view, undefined, true), log: s => console.warn(s) });

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
	status.command = 'bottega.openPlancia';
	const paint = () => {
		const c = snapshot.workCounts;
		const toPush = snapshot.projects.filter(p => (p.git?.ahead ?? 0) > 0).length;
		status.text = `$(sparkle) ${c.inCorso}` + (c.tiAspetta ? `  $(bell-dot) ${c.tiAspetta}` : '') + (toPush ? `  $(cloud-upload) ${toPush}` : '');
		status.tooltip =
			`${c.inCorso} al lavoro, ${c.tiAspetta} ti aspettano, ${c.vive} sessioni Claude vive in tutto` +
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
		vscode.window.registerTreeDataProvider('bottega.live', new LiveTree()),
		vscode.window.registerTreeDataProvider('bottega.projects', new ProjectTree()),
		vscode.window.registerWebviewPanelSerializer('bottega.plancia', {
			deserializeWebviewPanel: async panel => panelHost?.adopt(panel),
		}),
		vscode.commands.registerCommand('bottega.openPlancia', (focus?: string) => panelHost!.show(typeof focus === 'string' ? focus : undefined)),
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
	});
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
	// La scansione completa (git in ogni progetto) solo con la finestra davanti; tornando davanti, se e' vecchia, la
	// rifa il gestore qui sotto.
	const slow = setInterval(() => vscode.window.state.focused && void fullScan(), 120_000);
	ctx.subscriptions.push({ dispose: () => (clearInterval(tick), clearInterval(slow)) });
	ctx.subscriptions.push(
		panelHost.onDidChangeVisibility.event(visible => {
			statsPace();
			if (visible && statsWanted) void sendStats(false);
		}),
	);
	vscode.window.onDidChangeWindowState(s => s.focused && Date.now() - snapshot.scannedAt > 30_000 && void fullScan(), null, ctx.subscriptions);

	// Melissa ha la sua icona nella barra laterale: li' vive la sua sfera, dentro l'IDE.
	sferaView = new SferaView(ctx.extensionUri, () => assistant?.getState(), {
		converse: () => assistant?.toggleConversation(),
		ask: text => void assistant?.ask(text),
		open: () => showPlancia('melissa'),
		toggle: () => void assistant?.toggle(),
	});
	ctx.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SferaView.id, sferaView),
		vscode.commands.registerCommand('bottega.openVedetta', () => showPlancia('vedetta')),
		vscode.commands.registerCommand('bottega.openClienti', () => showPlancia('clienti')),
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
		vscode.commands.registerCommand('bottega.openCruscotto', () => showPlancia('cruscotto')),
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
	ensureClaudeExtension(ctx);
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

export function deactivate() {}
