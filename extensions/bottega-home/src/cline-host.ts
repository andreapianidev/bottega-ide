/* Cline nella Bottega: lo installa da Open VSX se manca, lo porta nella barra di destra come terza voce (dopo Melissa e
   Claude Code) e lo tiene allineato a Claude Code: stessi server MCP, regola globale con le regole di Andrea e la
   memoria. Gli aggiornamenti li fa VS Code da solo (aggiornamento automatico delle estensioni da Open VSX).
   Contratto: docs/CONTRATTI.md, sezione 11. */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { allineaServer, CLINE_ID, programmaSpostamento, regolaCline } from './cline';

const CASA = os.homedir();
const BOTTEGA = path.join(CASA, '.bottega');
const STATO = path.join(BOTTEGA, 'cline.json');
const FATTO = path.join(BOTTEGA, 'cline-in-barra');
const CLAUDE_JSON = path.join(CASA, '.claude.json');
const CLAUDE_MD = path.join(CASA, '.claude', 'CLAUDE.md');
const DATI_CLINE = process.env.CLINE_DATA_DIR?.trim() || path.join(CASA, '.cline', 'data');
const MCP_CLINE = path.join(DATI_CLINE, 'settings', 'cline_mcp_settings.json');
const REGOLA = path.join(CASA, 'Documents', 'Cline', 'Rules', 'bottega.md');

const leggiJson = (f: string): any => {
	try {
		return JSON.parse(fs.readFileSync(f, 'utf8'));
	} catch {
		return undefined;
	}
};

/** Scrive solo se cambia: Cline ricarica i server MCP a ogni modifica del suo file. */
function scriviSeCambia(f: string, testo: string, mode?: number): boolean {
	try {
		if (fs.readFileSync(f, 'utf8') === testo) return false;
	} catch {}
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, testo, mode ? { mode } : undefined);
	if (mode) fs.chmodSync(f, mode);
	return true;
}

export function registerCline(ctx: vscode.ExtensionContext) {
	const out = vscode.window.createOutputChannel('Bottega, Cline', { log: true });
	const cfg = () => vscode.workspace.getConfiguration('bottega.cline');
	ctx.subscriptions.push(out);
	if (!cfg().get<boolean>('attivo', true)) return;

	/** Server MCP e regola globale. I valori (comandi, env) passano da un file all'altro senza finire nei registri. */
	const allinea = () => {
		try {
			const claude = leggiJson(CLAUDE_JSON);
			if (claude) {
				const stato = leggiJson(STATO) ?? {};
				const r = allineaServer(claude, leggiJson(MCP_CLINE) ?? { mcpServers: {} }, Array.isArray(stato.gestiti) ? stato.gestiti : []);
				if (scriviSeCambia(MCP_CLINE, JSON.stringify(r.settings, null, 2) + '\n', 0o600))
					out.info(`server MCP per Cline: ${r.gestiti.join(', ') || 'nessuno'}`);
				scriviSeCambia(STATO, JSON.stringify({ ...stato, gestiti: r.gestiti }, null, 2) + '\n');
			}
			let md = '';
			try {
				md = fs.readFileSync(CLAUDE_MD, 'utf8');
			} catch {}
			if (scriviSeCambia(REGOLA, regolaCline(md))) out.info(`regola globale di Cline aggiornata: ${REGOLA}`);
		} catch (e: any) {
			out.warn(`allineamento di Cline non riuscito: ${e?.message ?? e}`);
		}
	};

	/** Una volta sola: alla prossima chiusura della Bottega, Cline passa nella barra di destra come ultima voce. Se poi
	 *  Andrea lo sposta altrove, la Bottega non lo riporta indietro. */
	const prenotaSpostamento = () => {
		if (fs.existsSync(FATTO)) return;
		const pid = process.ppid; // l'host delle estensioni e' figlio del processo principale della Bottega
		const prenotato = ctx.globalState.get<number>('bottega.cline.prenotato');
		if (prenotato === pid) return; // gia' in attesa per questa apertura (ricarica della finestra)
		// User/globalStorage/<estensione> accanto a User/globalStorage/state.vscdb (profilo predefinito)
		const db = path.join(path.dirname(ctx.globalStorageUri.fsPath), 'state.vscdb');
		if (!fs.existsSync(db)) return void out.warn(`stato di VS Code non trovato: ${db}`);
		const p = spawn(process.execPath, ['-e', programmaSpostamento()], {
			detached: true,
			stdio: 'ignore',
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BOTTEGA_PID: String(pid), BOTTEGA_DB: db, BOTTEGA_FATTO: FATTO, BOTTEGA_LOG: path.join(BOTTEGA, 'cline.log') },
		});
		p.unref();
		void ctx.globalState.update('bottega.cline.prenotato', pid);
		out.info(`Cline passa nella barra di destra alla prossima chiusura della Bottega (processo ${pid})`);
		void vscode.window
			.showInformationMessage('Cline sara\' la terza voce della barra di destra, accanto a Melissa e Claude Code, dalla prossima apertura della Bottega.', 'Riavvia adesso')
			.then(scelta => {
				if (!scelta) return;
				const app = path.resolve(vscode.env.appRoot, '..', '..', '..');
				spawn('/bin/sh', ['-c', `while kill -0 ${pid} 2>/dev/null; do sleep 1; done; sleep 4; open -a "${app}"`], { detached: true, stdio: 'ignore' }).unref();
				void vscode.commands.executeCommand('workbench.action.quit');
			});
	};

	const installa = async () => {
		const day = new Date().toISOString().slice(0, 10);
		const t = ctx.globalState.get<{ day: string; n: number }>('bottega.cline.installa');
		const n = t?.day === day ? t.n : 0;
		if (n >= 3) return;
		await ctx.globalState.update('bottega.cline.installa', { day, n: n + 1 });
		try {
			await vscode.commands.executeCommand('workbench.extensions.installExtension', CLINE_ID);
			out.info('Cline installato da Open VSX');
		} catch (e: any) {
			out.warn(`Cline non installato (tentativo ${n + 1} di 3 oggi): ${String(e?.message ?? e).split('\n')[0]}`);
		}
	};

	const pronto = () => {
		allinea();
		prenotaSpostamento();
	};

	if (vscode.extensions.getExtension(CLINE_ID)) pronto();
	else void installa();
	ctx.subscriptions.push(
		vscode.extensions.onDidChange(() => {
			if (vscode.extensions.getExtension(CLINE_ID)) pronto();
		}),
	);

	// Un server aggiunto in Claude Code o una regola cambiata in CLAUDE.md arrivano a Cline senza riavviare.
	let timer: NodeJS.Timeout | undefined;
	const piu_tardi = () => {
		clearTimeout(timer);
		timer = setTimeout(allinea, 2000);
	};
	for (const f of [CLAUDE_JSON, CLAUDE_MD]) {
		fs.watchFile(f, { interval: 10000 }, piu_tardi);
		ctx.subscriptions.push({ dispose: () => fs.unwatchFile(f, piu_tardi) });
	}
	ctx.subscriptions.push({ dispose: () => clearTimeout(timer) });
}
