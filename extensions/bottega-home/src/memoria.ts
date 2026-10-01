import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// Involucro attorno alla CLI della Memoria (Node 22, solo built-in). Se la CLI non c'e'
// (non ancora costruita, o non installata) tutto risponde vuoto senza piantarsi.

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
function resolveNode(): string {
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

	async search(query: string, project?: string): Promise<MemoryItem[]> {
		const args = ['search', query];
		if (project) args.push('--progetto', project);
		return Memoria.items(await this.runJson<any>(args, []));
	}

	async recent(project?: string): Promise<MemoryItem[]> {
		const args = ['recent'];
		if (project) args.push('--progetto', project);
		return Memoria.items(await this.runJson<any>(args, []));
	}

	async bacheca(project?: string, minutes = 30): Promise<MemoryItem[]> {
		const args = ['bacheca', '--minuti', String(minutes)];
		if (project) args.push('--progetto', project);
		return Memoria.items(await this.runJson<any>(args, []));
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
