import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const FONTI = { claude: 'Claude Code', cline: 'Cline', codex: 'Codex', terminale: 'Terminale' };
type Fonte = keyof typeof FONTI;

export function opzioniSessione(fonte: string, cwd: string, nomi: string[], bin?: string): vscode.TerminalOptions {
	if (!Object.hasOwn(FONTI, fonte)) throw new Error('Tipo di sessione non riconosciuto.');
	const base = `${FONTI[fonte as Fonte]} · ${path.basename(cwd) || cwd}`;
	let name = base;
	for (let n = 2; nomi.includes(name); n++) name = `${base} · ${n}`;
	return { name, cwd, location: vscode.TerminalLocation.Panel, ...(bin ? { shellPath: bin, shellArgs: [] } : {}) };
}

function programma(nome: string): string {
	const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
	for (const dir of dirs.filter(Boolean)) {
		const file = path.join(dir, nome);
		try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
	}
	throw new Error(`${FONTI[nome as Fonte] ?? nome} non è installato: il comando ${nome} non è disponibile.`);
}

/** Ogni clic crea un processo indipendente nella stessa finestra e nella barra Terminale. */
export function registraSessioni(ctx: vscode.ExtensionContext) {
	ctx.subscriptions.push(vscode.commands.registerCommand('bottega.nuovaSessione', async (fonte?: string, cartella?: string) => {
		try {
			if (!fonte) {
				const scelta = await vscode.window.showQuickPick(Object.entries(FONTI).map(([id, label]) => ({ id, label })), { title: 'Nuova sessione nella barra Terminale' });
				if (!scelta) return;
				fonte = scelta.id;
			}
			if (!Object.hasOwn(FONTI, fonte)) throw new Error('Tipo di sessione non riconosciuto.');
			const cwd = cartella ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
			if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('La cartella del progetto non è disponibile.');
			const bin = fonte === 'terminale' ? undefined : programma(fonte);
			const options = opzioniSessione(fonte, cwd, vscode.window.terminals.map(t => t.name), bin);
			if (fonte === 'cline') {
				options.shellPath = process.execPath;
				options.shellArgs = [path.join(ctx.extensionPath, 'shell/cline-session.cjs'), bin!];
				options.env = { ELECTRON_RUN_AS_NODE: '1' };
			}
			const terminal = vscode.window.createTerminal(options);
			terminal.show();
		} catch (error) {
			void vscode.window.showErrorMessage(`Nuova sessione: ${(error as Error).message}`);
		}
	}));
}
