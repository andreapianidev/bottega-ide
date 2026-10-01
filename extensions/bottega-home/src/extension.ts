import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LiveSession, PastSession, readLiveSessions, readPastSessions, SESSIONS_DIR } from './claude';
import { Project, scanProjects } from './scan';
import { PlanciaPanel } from './panel';

export interface Snapshot {
	projects: Project[];
	live: LiveSession[];
	/** Sessioni partite dalla home o da cartelle che non sono un progetto conosciuto. */
	elsewhere: PastSession[];
	scannedAt: number;
	home: string;
}

let snapshot: Snapshot = { projects: [], live: [], elsewhere: [], scannedAt: 0, home: os.homedir() };
const changed = new vscode.EventEmitter<Snapshot>();
let scanning: Promise<void> | undefined;

function cfg() {
	return vscode.workspace.getConfiguration('bottega');
}

function attachTitles(live: LiveSession[], past: PastSession[]): LiveSession[] {
	const byId = new Map(past.map(s => [s.sessionId, s.title]));
	return live.map(s => ({ ...s, title: byId.get(s.sessionId) }));
}

async function fullScan(): Promise<void> {
	if (scanning) return scanning;
	scanning = (async () => {
		const past = readPastSessions();
		const live = attachTitles(readLiveSessions(), past);
		const projects = await scanProjects(cfg().get<string[]>('roots', []), cfg().get<string[]>('ignore', []), past, live);
		const claimed = new Set(projects.flatMap(p => p.sessions.map(s => s.sessionId)));
		snapshot = {
			projects,
			live,
			elsewhere: past.filter(s => !claimed.has(s.sessionId)).slice(0, 30),
			scannedAt: Date.now(),
			home: os.homedir(),
		};
		changed.fire(snapshot);
	})().finally(() => (scanning = undefined));
	return scanning;
}

/** Aggiornamento leggero: solo il registro delle sessioni vive, senza rileggere git. */
function liveScan(): void {
	const live = attachTitles(readLiveSessions(), [...snapshot.projects.flatMap(p => p.sessions), ...snapshot.elsewhere]);
	const norm = (p: string) => p.toLowerCase().replace(/\/+$/, '') + '/';
	for (const p of snapshot.projects) {
		const mine = new Set(p.sessions.map(x => x.sessionId));
		p.live = live.filter(s => norm(s.cwd).startsWith(norm(p.path)) || mine.has(s.sessionId));
	}
	snapshot = { ...snapshot, live };
	changed.fire(snapshot);
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

const STATUS: Record<string, string> = { busy: 'al lavoro', idle: 'in attesa', shell: 'nel terminale' };

class LiveTree implements vscode.TreeDataProvider<LiveSession> {
	readonly onDidChangeTreeData = changed.event as unknown as vscode.Event<void>;
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
	readonly onDidChangeTreeData = changed.event as unknown as vscode.Event<void>;
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

// ---------- attivazione ----------

export async function activate(ctx: vscode.ExtensionContext) {
	const panelHost = new PlanciaPanel(ctx.extensionUri, () => snapshot, changed.event, {
		open: p => openProject(p),
		here: p => openProject(p, false),
		claude: (p, id) => claudeIn(p, id),
		finder: reveal,
		xcode: openXcode,
		push,
		refresh: () => void fullScan(),
	});

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
	status.command = 'bottega.openPlancia';
	const paint = () => {
		const busy = snapshot.live.filter(s => s.status === 'busy').length;
		const toPush = snapshot.projects.filter(p => (p.git?.ahead ?? 0) > 0).length;
		status.text = `$(sparkle) ${busy}/${snapshot.live.length}` + (toPush ? `  $(cloud-upload) ${toPush}` : '');
		status.tooltip = `${busy} sessioni Claude al lavoro su ${snapshot.live.length} aperte` + (toPush ? `\n${toPush} progetti con commit da spingere` : '');
		status.show();
	};

	ctx.subscriptions.push(
		changed,
		status,
		changed.event(paint),
		vscode.window.registerTreeDataProvider('bottega.live', new LiveTree()),
		vscode.window.registerTreeDataProvider('bottega.projects', new ProjectTree()),
		vscode.commands.registerCommand('bottega.openPlancia', (focus?: string) => panelHost.show(typeof focus === 'string' ? focus : undefined)),
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
	);

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
	const tick = setInterval(liveScan, 15_000);
	const slow = setInterval(() => void fullScan(), 120_000);
	ctx.subscriptions.push({ dispose: () => (clearInterval(tick), clearInterval(slow)) });
	vscode.window.onDidChangeWindowState(s => s.focused && Date.now() - snapshot.scannedAt > 30_000 && void fullScan(), null, ctx.subscriptions);

	if (!vscode.workspace.workspaceFolders?.length && cfg().get('openOnStartup', true)) {
		panelHost.show();
	}
	await fullScan();
	ensureClaudeExtension(ctx);
}

async function ensureClaudeExtension(ctx: vscode.ExtensionContext) {
	const id = 'anthropic.claude-code';
	if (!cfg().get('installClaudeExtension', true) || vscode.extensions.getExtension(id) || ctx.globalState.get('bottega.claudeInstallTried')) {
		return;
	}
	await ctx.globalState.update('bottega.claudeInstallTried', true);
	try {
		await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
		vscode.window.showInformationMessage('Estensione Claude Code installata da Open VSX.');
	} catch (e) {
		vscode.window.showWarningMessage(`Non riesco a installare Claude Code (${id}): cercala nel pannello Estensioni.`);
	}
}

export function deactivate() {}
