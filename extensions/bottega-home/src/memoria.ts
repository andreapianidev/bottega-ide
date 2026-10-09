import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// Involucro attorno alla CLI della Memoria (Node 22, solo built-in). Se la CLI non c'e'
// (non ancora costruita, o non installata) tutto risponde vuoto senza piantarsi.

export interface BoardItem {
	at: number;
	sessionId: string;
	project: string;
	kind: string;
	summary: string;
	file?: string;
}

export interface MemoryItem {
	id: number;
	kind: 'riassunto' | 'fatto' | 'decisione' | 'nota' | 'prompt' | string;
	project: string;
	projectPath?: string;
	sessionId?: string;
	title: string;
	text: string;
	createdAt: number;
	score?: number;
}

const HOME = os.homedir();

/** La cartella dell'app Memoria (quella con cli.mjs), nell'ordine del contratto. */
export function resolveMemoriaDir(extensionPath: string): string | undefined {
	const candidates = [
		path.join(extensionPath, 'memoria'),
		path.join(HOME, '.bottega', 'memoria-app'),
		path.join(HOME, 'prototipi', 'Bottega', 'memoria'),
	];
	for (const d of candidates) {
		if (fs.existsSync(path.join(d, 'cli.mjs'))) return d;
	}
	return undefined;
}

let nodeCache: string | undefined;
/** `node` dell'utente (Node 22), serve `node:sqlite`. NON process.execPath (quello di Electron). */
export function resolveNode(): string {
	if (nodeCache) return nodeCache;
	// Prima da PATH.
	for (const dir of (process.env.PATH ?? '').split(':')) {
		if (!dir) continue;
		const p = path.join(dir, 'node');
		try {
			fs.accessSync(p, fs.constants.X_OK);
			nodeCache = p;
			return p;
		} catch {
			// prossimo
		}
	}
	// Poi le posizioni note (nvm, Homebrew).
	const guesses = [
		path.join(HOME, '.nvm', 'versions', 'node'),
	];
	for (const base of guesses) {
		try {
			const versions = fs.readdirSync(base).filter(v => v.startsWith('v')).sort().reverse();
			for (const v of versions) {
				const p = path.join(base, v, 'bin', 'node');
				if (fs.existsSync(p)) {
					nodeCache = p;
					return p;
				}
			}
		} catch {
			// nessun nvm
		}
	}
	for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
		if (fs.existsSync(p)) {
			nodeCache = p;
			return p;
		}
	}
	nodeCache = 'node';
	return nodeCache;
}

export class Memoria {
	private dir?: string;
	private syncing?: Promise<void>;

	constructor(private readonly extensionPath: string) {
		this.dir = resolveMemoriaDir(extensionPath);
	}

	get available(): boolean {
		this.dir ??= resolveMemoriaDir(this.extensionPath);
		return !!this.dir;
	}

	private cli(): string | undefined {
		this.dir ??= resolveMemoriaDir(this.extensionPath);
		return this.dir ? path.join(this.dir, 'cli.mjs') : undefined;
	}

	private run(args: string[], timeoutMs = 10_000): Promise<string> {
		const cli = this.cli();
		if (!cli) return Promise.reject(new Error('La Memoria non e\' installata.'));
		return new Promise((resolve, reject) => {
			execFile(resolveNode(), [cli, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
				if (err) return reject(new Error((stderr || err.message || 'Errore della Memoria').trim()));
				resolve(stdout);
			});
		});
	}

	private async runJson<T>(args: string[], fallback: T): Promise<T> {
		if (!this.available) return fallback;
		try {
			const out = await this.run([...args, '--json']);
			return JSON.parse(out) as T;
		} catch {
			return fallback;
		}
	}

	private static items(raw: any): MemoryItem[] {
		const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.results) ? raw.results : Array.isArray(raw?.items) ? raw.items : [];
		return arr as MemoryItem[];
	}

	/** Continua l'importazione anche quando la stanza Memoria e' chiusa. */
	sync(): Promise<void> {
		return this.syncing ??= this.run(['import-all', '--json'], 30_000).then(() => undefined).finally(() => { this.syncing = undefined; });
	}

	async search(query: string, project?: string, strict = false): Promise<MemoryItem[]> {
		const args = ['search', query];
		if (project) args.push('--progetto', project);
		return Memoria.items(strict ? JSON.parse(await this.run([...args, '--json'])) : await this.runJson<any>(args, []));
	}

	async recent(project?: string, opts: { kinds?: string[]; limit?: number; strict?: boolean } = {}): Promise<MemoryItem[]> {
		const args = ['recent'];
		if (project) args.push('--progetto', project);
		if (opts.kinds?.length) args.push('--tipo', opts.kinds.join(','));
		if (opts.limit) args.push('--limite', String(opts.limit));
		return Memoria.items(opts.strict ? JSON.parse(await this.run([...args, '--json'])) : await this.runJson<any>(args, []));
	}

	/** I numeri della stanza Memoria: scritti e letti per giorno, progetti, totali (memoria/lib/grafici.mjs). */
	async grafici(giorni = 30): Promise<any | null> {
		return this.runJson<any>(['grafici', '--giorni', String(giorni)], null);
	}

	/** Dettaglio di una sessione (ricordi e ultime osservazioni), o undefined se la Memoria non la conosce. */
	async session(id: string): Promise<{ session: any; memories: MemoryItem[] } | undefined> {
		const raw = await this.runJson<any>(['sessione', id], null);
		return raw && raw.session ? { session: raw.session, memories: Memoria.items(raw.memories) } : undefined;
	}

	/** Ricerca con piu' risultati (fino a 50), per «Dove l'ho gia' risolto?». */
	async searchMany(query: string, limit = 20): Promise<MemoryItem[]> {
		return Memoria.items(await this.runJson<any>(['search', query, '--limite', String(limit)], []));
	}

	/** Attivita' in diretta delle sessioni. Forma della CLI (contratto, sezione 2):
	 *  {at, sessionId, project, kind, summary, file?}: non e' un MemoryItem, non va letta come tale. */
	async bacheca(project?: string, minutes = 30): Promise<BoardItem[]> {
		const args = ['bacheca', '--minuti', String(minutes)];
		if (project) args.push('--progetto', project);
		const raw = await this.runJson<any>(args, []);
		return (Array.isArray(raw) ? raw : [])
			.filter(r => r && typeof r.summary === 'string' && r.summary.trim())
			.map(r => ({ at: Number(r.at) || 0, sessionId: String(r.sessionId ?? ''), project: String(r.project ?? ''), kind: String(r.kind ?? ''), summary: String(r.summary), file: r.file ? String(r.file) : undefined }));
	}

	/** Sessione -> categoria (correzione, funzione, ...), decisa da Apple Intelligence: memoria/lib/categorie.mjs. */
	async categorie(giorni = 90): Promise<Record<string, string>> {
		return this.runJson<Record<string, string>>(['categorie', '--giorni', String(giorni)], {});
	}

	/** Classifica in fondo, a bassa priorita', le sessioni riassunte che non hanno ancora una categoria. */
	classificaInFondo(): void {
		this.run(['classifica', '--json', '--limite', '8'], 300_000).catch(() => undefined);
	}

	/** Legge in fondo (Vision sul Mac) le schermate delle trascrizioni non ancora lette: memoria/lib/immagini.mjs. */
	immaginiInFondo(): void {
		this.run(['immagini', '--json', '--limite', '40'], 600_000).catch(() => undefined);
	}

	async remember(text: string, project?: string): Promise<boolean> {
		if (!this.available) return false;
		const args = ['remember', text];
		if (project) args.push('--progetto', project);
		try {
			await this.run(args);
			return true;
		} catch {
			return false;
		}
	}

	/** Il motore dei riassunti (impostazione bottega.memoria.motore): la Memoria lo tiene nel suo database. */
	async setMotore(motore: string): Promise<void> {
		if (!this.available || !['deepseek', 'agnes'].includes(motore)) return;
		await this.run(['motore', motore]);
	}

	/** Installa gli hook di Claude Code e il server MCP, dopo conferma modale. */
	async install(): Promise<void> {
		if (!this.available) {
			vscode.window.showWarningMessage('Non trovo la Memoria da installare: manca cli.mjs. Controlla la cartella memoria della Bottega.');
			return;
		}
		const ok = await vscode.window.showWarningMessage(
			'Attivo la memoria per Claude Code. Modifico ~/.claude/settings.json per registrare gli hook e un server MCP, dopo averne salvato una copia di sicurezza. Procedo?',
			{ modal: true, detail: 'Gli hook esistenti restano: nulla di tuo viene rimosso. L\'app della memoria va in ~/.bottega/memoria-app.' },
			'Attiva',
		);
		if (ok !== 'Attiva') return;
		const appDir = path.join(HOME, '.bottega', 'memoria-app');
		try {
			await this.run(['install', '--app-dir', appDir], 60_000);
			vscode.window.showInformationMessage('Memoria attivata per Claude Code.');
		} catch (e: any) {
			vscode.window.showErrorMessage(`Non riesco ad attivare la memoria: ${e?.message ?? e}`);
		}
	}
}
