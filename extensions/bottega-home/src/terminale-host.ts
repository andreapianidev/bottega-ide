/* Il terminale nella Bottega, collegato a VS Code:
   - la quarta voce della barra di destra: il terminale vero di VS Code (contenitore `terminal`) passa dal pannello in
     basso alla barra di destra, dopo Melissa, Claude Code e Cline, alla prossima chiusura della Bottega, una volta
     sola, con lo stesso meccanismo di Cline (src/cline-host.ts);
   - la cartella giusta: un terminale nuovo nasce nella sessione della scheda attiva (lavoro della Bottega, Claude, un
     worktree) o nella cartella di lavoro del file attivo. Anche quello che VS Code crea da solo quando si apre la voce
     vuota: se e' nato nella cartella sbagliata lo si sostituisce subito con uno nella cartella giusta;
   - `bottega.terminaleQui`, `bottega.terminaleEsterno` (iTerm2 con il profilo «Bottega», o Terminale) e lo strumento
     di Melissa `terminale_apri`;
   - Agnes nel terminale (bottega.terminale.agnes): ZDOTDIR=~/.bottega/zsh in tutti i terminali della Bottega (variabile
     d'ambiente dell'estensione, i file veri di Andrea restano intatti), il socket ~/.bottega/terminale.sock e il comando
     «Terminale: comandi consentiti». Logica in src/terminale-agnes.ts, widget in shell/agnes.zsh.
   Logica pura in src/terminale.ts. Contratto: docs/CONTRATTI.md, sezione 12. */

import { ChildProcess, execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Assistant, ToolSpec } from './assistant';
import type { NucleoBridge } from './cervello';
import type { Cervelli } from './cervelli';
import { CLINE_ID } from './cline';
import { cartellaCorrente, cartellaDi, coloriEffettivi, comandoEsterno, Esterno, profiloIterm, programmaTerminale } from './terminale';
import { apriSportello, CervelloTerminale, comandoIterm, installaZsh, leggiConsentiti, Modo, pensatore, scriviConsentiti, Sportello } from './terminale-agnes';

const CASA = os.homedir();
const TEMA_ID = 'andreapiani.bottega-theme';

export interface TerminaleDeps {
	/** La cartella di un lavoro della Bottega, se il terminale e' suo (src/jobs.ts). */
	cartellaLavoro(t: vscode.Terminal): string | undefined;
	/** Per i test: execFile finto e percorsi in una cartella temporanea. */
	esegui?: (file: string, args: string[], fatto: (err: Error | null) => void) => void;
	bottega?: string;
	iterm?: string;
	profilo?: string;
	/** Agnes nel terminale: i cervelli di Melissa e il Nucleo per Apple Intelligence. Senza, niente Agnes. */
	agnes?: { cervelli: Cervelli; nucleo(): NucleoBridge | undefined; apple(): boolean };
}

export interface TerminaleApi {
	/** Un terminale nuovo nella Bottega, nella cartella data o in quella corrente. */
	qui(cartella?: string): string;
	/** iTerm2 (o Terminale) nella cartella data o in quella corrente. */
	esterno(cartella?: string, scelta?: Esterno): Promise<string>;
}

let api: TerminaleApi | undefined;

const esiste = (p: string) => {
	try {
		fs.statSync(p);
		return true;
	} catch {
		return false;
	}
};
const eCartella = (p: string) => {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
};
const norma = (p: string) => path.resolve(p).replace(/\/+$/, '');
const cwdDi = (t: vscode.Terminal): string | undefined => {
	const c = (t.creationOptions as vscode.TerminalOptions).cwd;
	return typeof c === 'string' ? c : c?.fsPath;
};

export function registerTerminale(ctx: vscode.ExtensionContext, deps: TerminaleDeps): TerminaleApi {
	const out = vscode.window.createOutputChannel('Bottega, terminale', { log: true });
	const cfg = () => vscode.workspace.getConfiguration('bottega.terminale');
	const nato = Date.now();
	const nostri = new WeakSet<vscode.Terminal>();
	const BOTTEGA = deps.bottega ?? path.join(CASA, '.bottega');
	const FATTO = path.join(BOTTEGA, 'terminale-in-barra');
	const CLINE_FATTO = path.join(BOTTEGA, 'cline-in-barra');
	const ITERM_APP = deps.iterm ?? '/Applications/iTerm.app';
	const PROFILO = deps.profilo ?? path.join(CASA, 'Library', 'Application Support', 'iTerm2', 'DynamicProfiles', 'bottega.json');
	const esegui = deps.esegui ?? ((file, args, fatto) => void execFile(file, args, { timeout: 15_000 }, err => fatto(err)));
	ctx.subscriptions.push(out);

	// ---------- la cartella corrente ----------

	/** I terminali attivi, il piu' recente per primo: serve a riconoscere la scheda attiva quando due hanno lo stesso nome. */
	let recenti: vscode.Terminal[] = vscode.window.activeTerminal ? [vscode.window.activeTerminal] : [];
	ctx.subscriptions.push(
		vscode.window.onDidChangeActiveTerminal(t => {
			if (t) recenti = [t, ...recenti.filter(x => x !== t)].slice(0, 20);
		}),
		vscode.window.onDidCloseTerminal(t => (recenti = recenti.filter(x => x !== t))),
	);

	const schedaAttiva = () => vscode.window.tabGroups.activeTabGroup.activeTab;
	const schedeTerminale = () => vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputTerminal).length;

	/** La cartella della sessione nella scheda attiva, se e' un terminale nell'editor. */
	const sessioneAttiva = (escludi?: vscode.Terminal): string | undefined => {
		const tab = schedaAttiva();
		if (!(tab?.input instanceof vscode.TabInputTerminal)) return undefined;
		const candidati = vscode.window.terminals.filter(t => t !== escludi && t.name === tab.label);
		const t = candidati.sort((a, b) => (recenti.indexOf(a) + 1 || 99) - (recenti.indexOf(b) + 1 || 99))[0];
		if (!t) return undefined;
		return deps.cartellaLavoro(t) ?? t.shellIntegration?.cwd?.fsPath ?? cwdDi(t);
	};

	const corrente = (escludi?: vscode.Terminal): string => {
		const doc = vscode.window.activeTextEditor?.document;
		return cartellaCorrente(
			{
				sessione: sessioneAttiva(escludi),
				file: doc?.uri.scheme === 'file' ? doc.uri.fsPath : undefined,
				workspace: (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath),
				home: CASA,
			},
			esiste,
		);
	};

	/** La cartella di un argomento di comando (Explorer, scheda), se e' un file su disco. */
	const daUri = (uri: unknown): string | undefined => {
		if (!(uri instanceof vscode.Uri) || uri.scheme !== 'file') return undefined;
		return cartellaDi(uri.fsPath, eCartella(uri.fsPath));
	};

	const nuovo = (cartella: string): vscode.Terminal => {
		const t = vscode.window.createTerminal({ cwd: cartella, location: vscode.TerminalLocation.Panel });
		nostri.add(t);
		t.show();
		return t;
	};

	// Il terminale che VS Code crea da solo quando si apre la voce (o Ctrl+`) senza terminali: nasce nella prima cartella
	// del workspace o nella home. Se la cartella giusta e' un'altra, lo si sostituisce subito.
	ctx.subscriptions.push(
		vscode.window.onDidOpenTerminal(t => {
			if (nostri.has(t) || Date.now() - nato < 10_000) return; // i terminali ripristinati all'avvio restano
			const o = t.creationOptions as vscode.TerminalOptions & { pty?: unknown };
			if (o.pty || o.name || o.cwd || o.shellPath) return;
			if (String(vscode.workspace.getConfiguration('terminal.integrated').get('cwd') ?? '').trim()) return; // scelta di Andrea
			setTimeout(() => {
				if (t.exitStatus) return;
				// solo il primo terminale fuori dall'editor, e non uno nuovo aperto nell'editor
				if (vscode.window.terminals.length - schedeTerminale() !== 1) return;
				const tab = schedaAttiva();
				if (tab?.input instanceof vscode.TabInputTerminal && tab.label === t.name) return;
				const voluta = corrente(t);
				const predefinita = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? CASA;
				if (norma(voluta) === norma(predefinita)) return;
				nuovo(voluta);
				t.dispose();
				out.info(`terminale nuovo nella cartella corrente: ${voluta}`);
			}, 200);
		}),
	);

	// ---------- Agnes nel terminale ----------

	const ZDOT = path.join(BOTTEGA, 'zsh');
	const SOCK = path.join(BOTTEGA, 'terminale.sock');
	const CONSENTITI = path.join(BOTTEGA, 'terminale-consentiti.json');
	const agnesAccesa = () => !!deps.agnes && cfg().get<boolean>('agnes', true);
	const cervelloScelto = (): CervelloTerminale => (cfg().get<string>('cervello', 'agnes') === 'deepseek' ? 'deepseek' : 'agnes');
	const modo = (): Modo => {
		const m = cfg().get<string>('agnesModo', 'chiedi');
		return m === 'proponi' || m === 'auto' ? m : 'chiedi';
	};
	let sportello: Sportello | undefined;
	let zshPronto = false;
	/** Accesa: i file di zsh in ~/.bottega/zsh, ZDOTDIR nei terminali nuovi, il socket. Spenta: niente di tutto questo. */
	const agnes = () => {
		if (!deps.agnes) return;
		const ambiente = ctx.environmentVariableCollection;
		if (!agnesAccesa()) {
			ambiente.delete('ZDOTDIR');
			ambiente.delete('BOTTEGA_ZDOTDIR_UTENTE');
			zshPronto = false;
			if (sportello) out.info('Agnes nel terminale spenta');
			void sportello?.chiudi();
			sportello = undefined;
			return;
		}
		try {
			const scritti = installaZsh(path.join(ctx.extensionPath, 'shell'), ZDOT, cervelloScelto());
			if (scritti.length) out.info(`file di zsh aggiornati in ${ZDOT}: ${scritti.join(', ')}`);
		} catch (e: any) {
			// senza i file ZDOTDIR non si tocca: un terminale con ZDOTDIR in una cartella vuota perderebbe l'ambiente
			out.warn(`file di zsh non scritti, Agnes nel terminale resta spenta: ${e?.message ?? e}`);
			return;
		}
		zshPronto = true;
		// solo per questa sessione: si rimette a ogni avvio, dopo aver scritto i file
		ambiente.persistent = false;
		ambiente.description = 'La Bottega: scrivi in italiano cosa vuoi fare e Agnes propone il comando';
		ambiente.replace('ZDOTDIR', ZDOT);
		const suo = process.env.ZDOTDIR;
		if (suo && path.resolve(suo) !== ZDOT && !suo.startsWith(os.tmpdir()) && esiste(path.join(suo, '.zshrc'))) ambiente.replace('BOTTEGA_ZDOTDIR_UTENTE', suo);
		sportello ??= apriSportello({
			percorso: SOCK,
			modo,
			cervello: cervelloScelto,
			pensa: pensatore(deps.agnes!),
			consentiti: CONSENTITI,
			home: CASA,
			log: m => out.info(`agnes: ${m}`),
		});
	};
	agnes();
	ctx.subscriptions.push(
		{ dispose: () => void sportello?.chiudi() },
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('bottega.terminale.agnes') || e.affectsConfiguration('bottega.terminale.cervello')) {
				agnes();
				aggiornaProfilo();
			}
		}),
		vscode.commands.registerCommand('bottega.terminaleConsentiti', () => {
			const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
			qp.title = 'Comandi consentiti nel terminale';
			qp.placeholder = 'Questi Agnes li esegue senza chiedere. La x li toglie.';
			const togli = { iconPath: new vscode.ThemeIcon('close'), tooltip: 'Togli' };
			const carica = () => {
				const forme = leggiConsentiti(CONSENTITI);
				qp.items = forme.length
					? forme.map(label => ({ label, buttons: [togli] }))
					: [{ label: 'Nessun comando consentito', description: 'si aggiungono con s alla domanda «eseguo?»' }];
			};
			qp.onDidTriggerItemButton(e => {
				scriviConsentiti(CONSENTITI, leggiConsentiti(CONSENTITI).filter(f => f !== e.item.label));
				out.info(`consentiti: tolto ${e.item.label}`);
				carica();
			});
			qp.onDidHide(() => qp.dispose());
			carica();
			qp.show();
		}),
	);

	// ---------- iTerm2 ----------

	const itermInstallato = () => esiste(ITERM_APP);

	/** I colori del tema attivo: Bottega Notte o Calima dal file del tema, con le personalizzazioni di Andrea. */
	const coloriTema = (): Record<string, string> => {
		const chiaro = [vscode.ColorThemeKind.Light, vscode.ColorThemeKind.HighContrastLight].includes(vscode.window.activeColorTheme.kind);
		const nome = chiaro ? 'Bottega Calima' : 'Bottega Notte';
		let colori: Record<string, string> = {};
		const est = vscode.extensions.getExtension(TEMA_ID);
		const voce = (est?.packageJSON?.contributes?.themes ?? []).find((t: any) => t.label === nome);
		if (est && voce) {
			try {
				colori = JSON.parse(fs.readFileSync(path.join(est.extensionPath, voce.path), 'utf8')).colors ?? {};
			} catch (e: any) {
				out.warn(`tema ${nome} non letto: ${e?.message ?? e}`);
			}
		}
		return coloriEffettivi(colori, vscode.workspace.getConfiguration('workbench').get('colorCustomizations'), nome);
	};

	/** Scrive il profilo «Bottega» di iTerm2 solo se cambia: iTerm2 lo rilegge da solo a ogni modifica. */
	const aggiornaProfilo = () => {
		if (!itermInstallato()) return;
		try {
			const ti = vscode.workspace.getConfiguration('terminal.integrated');
			const ed = vscode.workspace.getConfiguration('editor');
			const testo = profiloIterm(coloriTema(), {
				famiglia: ti.get<string>('fontFamily') || ed.get<string>('fontFamily'),
				dimensione: ti.get<number>('fontSize') || ed.get<number>('fontSize'),
				altezzaRiga: ti.get<number>('lineHeight'),
				cursore: ti.get<string>('cursorStyle'),
			}, agnesAccesa() && zshPronto ? comandoIterm(ZDOT, process.env.SHELL) : undefined);
			try {
				if (fs.readFileSync(PROFILO, 'utf8') === testo) return;
			} catch {}
			fs.mkdirSync(path.dirname(PROFILO), { recursive: true });
			fs.writeFileSync(PROFILO, testo);
			out.info(`profilo Bottega di iTerm2 aggiornato: ${PROFILO}`);
		} catch (e: any) {
			out.warn(`profilo di iTerm2 non scritto: ${e?.message ?? e}`);
		}
	};
	aggiornaProfilo();
	ctx.subscriptions.push(
		vscode.window.onDidChangeActiveColorTheme(aggiornaProfilo),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (['terminal.integrated', 'editor.fontFamily', 'editor.fontSize', 'workbench.colorCustomizations'].some(s => e.affectsConfiguration(s))) aggiornaProfilo();
		}),
	);

	const esterno = (cartella: string, scelta?: Esterno): Promise<string> => {
		const sc: Esterno = scelta ?? (cfg().get<string>('esterno', 'iterm2') === 'terminal' ? 'terminal' : 'iterm2');
		if (sc === 'iterm2') aggiornaProfilo();
		const c = comandoEsterno(sc, cartella, itermInstallato());
		return new Promise(ok => {
			esegui(c.file, c.args, err => {
				if (err) {
					out.warn(`${c.app} non aperto: ${String(err.message).split('\n')[0]}`);
					void vscode.window.showWarningMessage(`${c.app} non si e' aperto: ${String(err.message).split('\n')[0]}`);
					return ok(`${c.app} non si e' aperto.`);
				}
				if (c.avviso) void vscode.window.showInformationMessage(c.avviso);
				ok(c.avviso ?? `${c.app} aperto in ${cartella}.`);
			});
		});
	};

	// ---------- la voce nella barra di destra ----------

	let attesa: ChildProcess | undefined;
	let attesaCline = false;
	/** Una volta sola: alla prossima chiusura della Bottega il terminale passa nella barra di destra, ultima voce. Se poi
	 *  Andrea lo sposta altrove, la Bottega non lo riporta indietro. */
	const prenota = () => {
		if (!cfg().get<boolean>('barra', true) || fs.existsSync(FATTO)) return;
		const pid = process.ppid; // l'host delle estensioni e' figlio del processo principale della Bottega
		// Cline sposta la sua voce alla stessa chiusura? Allora si aspetta lui (docs/CONTRATTI.md 11 e 12).
		const cline = vscode.workspace.getConfiguration('bottega.cline').get<boolean>('attivo', true) && !!vscode.extensions.getExtension(CLINE_ID) && !fs.existsSync(CLINE_FATTO);
		const prenotato = ctx.globalState.get<number>('bottega.terminale.prenotato');
		if (attesa && attesa.exitCode === null) {
			if (attesaCline === cline) return;
		} else if (prenotato === pid) return; // gia' in attesa per questa apertura (ricarica della finestra)
		const db = path.join(path.dirname(ctx.globalStorageUri.fsPath), 'state.vscdb');
		if (!fs.existsSync(db)) return void out.warn(`stato di VS Code non trovato: ${db}`);
		try {
			attesa?.kill();
		} catch {}
		attesa = spawn(process.execPath, ['-e', programmaTerminale()], {
			detached: true,
			stdio: 'ignore',
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: '1',
				BOTTEGA_PID: String(pid),
				BOTTEGA_DB: db,
				BOTTEGA_FATTO: FATTO,
				BOTTEGA_LOG: path.join(BOTTEGA, 'terminale.log'),
				BOTTEGA_ASPETTA: cline ? CLINE_FATTO : '',
			},
		});
		attesa.unref();
		attesaCline = cline;
		void ctx.globalState.update('bottega.terminale.prenotato', pid);
		out.info(`il terminale passa nella barra di destra alla prossima chiusura della Bottega (processo ${pid}${cline ? ', dopo Cline' : ''})`);
		if (prenotato === pid) return; // il messaggio e' gia' stato dato
		void vscode.window
			.showInformationMessage('Dalla prossima apertura della Bottega il terminale sara\' l\'ultima voce della barra di destra, dopo Melissa, Claude Code e Cline.', 'Riavvia adesso')
			.then(scelta => {
				if (!scelta) return;
				const app = path.resolve(vscode.env.appRoot, '..', '..', '..');
				spawn('/bin/sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 1; done; sleep 4; open -a "$2"', 'sh', String(pid), app], { detached: true, stdio: 'ignore' }).unref();
				void vscode.commands.executeCommand('workbench.action.quit');
			});
	};
	prenota();
	// Cline installato adesso: il programma deve aspettare anche lui.
	ctx.subscriptions.push(vscode.extensions.onDidChange(() => prenota()));

	// ---------- comandi ----------

	const qui = (cartella?: string): string => {
		const c = cartella && eCartella(cartella) ? cartella : corrente();
		nuovo(c);
		return c;
	};

	ctx.subscriptions.push(
		vscode.commands.registerCommand('bottega.terminale', () => {
			// c'e' gia' un terminale fuori dall'editor: si apre la voce; se no, uno nuovo nella cartella corrente
			if (vscode.window.terminals.length > schedeTerminale()) return vscode.commands.executeCommand('workbench.action.terminal.focus');
			qui();
		}),
		vscode.commands.registerCommand('bottega.terminaleQui', (uri?: vscode.Uri) => qui(daUri(uri))),
		vscode.commands.registerCommand('bottega.terminaleEsterno', (uri?: vscode.Uri) => esterno(daUri(uri) ?? corrente())),
		// dal titolo della voce Terminale: la cartella del terminale che si sta guardando
		vscode.commands.registerCommand('bottega.terminaleEsternoDaQui', () => {
			const t = vscode.window.activeTerminal;
			const c = t ? deps.cartellaLavoro(t) ?? t.shellIntegration?.cwd?.fsPath ?? cwdDi(t) : undefined;
			return esterno(c && eCartella(c) ? c : corrente());
		}),
	);

	api = { qui, esterno: (cartella, scelta) => esterno(cartella && eCartella(cartella) ? cartella : corrente(), scelta) };
	return api;
}

// ---------- lo strumento di Melissa ----------

/** La stessa forma di ToolDef in assistant.ts: extension.ts lo verifica con `satisfies`. */
export interface StrumentoTerminale {
	spec: ToolSpec;
	risky?: boolean;
	run(args: any, ctx: Assistant): Promise<string> | string;
}

export const STRUMENTI_TERMINALE: Record<string, StrumentoTerminale> = {
	terminale_apri: {
		spec: {
			type: 'function',
			function: {
				name: 'terminale_apri',
				description:
					'Apre un terminale nella cartella di un progetto (o, senza progetto, nella cartella corrente): nella Bottega, nella voce Terminale della barra di destra, oppure fuori in iTerm2 con esterno true.',
				parameters: {
					type: 'object',
					properties: {
						progetto: { type: 'string', description: 'nome del progetto, per esempio Woofmap' },
						esterno: { type: 'boolean', description: 'true per aprirlo in iTerm2 (o Terminale) invece che nella Bottega' },
					},
					required: [],
					additionalProperties: false,
				},
			},
		},
		run: async (a, ctx) => {
			if (!api) return 'Il terminale della Bottega non e\' pronto.';
			let cartella: string | undefined;
			let nome = 'la cartella corrente';
			if (a?.progetto) {
				const p = ctx.deps.actions.resolveProject(String(a.progetto));
				if (!p) return `Non trovo il progetto "${a.progetto}".`;
				cartella = p.path;
				nome = p.name;
			}
			if (a?.esterno) return api.esterno(cartella);
			const c = api.qui(cartella);
			return `Terminale aperto su ${nome} (${c}).`;
		},
	},
};
