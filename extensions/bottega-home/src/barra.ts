import * as fs from 'fs';
import * as vscode from 'vscode';
import type { AssistantState } from './assistant';
import type { BrainState, Effort, Provider } from './cervelli';
import type { WorkCounts, WorkItem } from './jobs';

/** Una voce della bacheca della Memoria, per sessione. */
export interface BoardEntry {
	at: number;
	kind: string;
	summary: string;
	file?: string;
}

export interface BarraSource {
	assistant(): AssistantState | undefined;
	work(): WorkItem[];
	workCounts(): WorkCounts;
	/** Bacheca delle ultime 3 ore: puo' essere lenta (CLI della Memoria), si chiede ogni 20 s a vista aperta. */
	board(): Promise<(BoardEntry & { sessionId?: string })[]>;
	brain(): Promise<BrainState>;
	/** interruttore «racconta» (bottega.voice.racconta) */
	racconta(): boolean;
}

export interface BarraActions {
	converse(): void;
	ask(text: string): void;
	toggleVoice(): void;
	/** `sempre`: diventa il predefinito (CONTRATTI 9.8), altrimenti vale per questa conversazione */
	setBrain(provider: Provider, model: string, sempre?: boolean): Promise<void>;
	setEffort(effort: Effort): Promise<void>;
	setRacconta(on: boolean): Promise<void>;
	focusJob(id: string): void;
	writeJob(id: string, text: string): void;
	open(path: string): void;
	resume(path: string, sessionId: string): void;
	home(view?: string): void;
	command(id: string): void;
	sessionBoard(sessionId: string): Promise<BoardEntry[]>;
	/** Una riga nel registro di Melissa (diagnosi della sfera). */
	log(line: string): void;
}

/** La barra di Melissa nella barra laterale destra: il centro di controllo di tutte le sessioni Claude.
 *  Contratto: docs/CONTRATTI.md, sezione 6. */
export class BarraView implements vscode.WebviewViewProvider {
	static readonly id = 'bottega.barra';
	static readonly container = 'melissaBarra';
	private view?: vscode.WebviewView;
	private board: Record<string, BoardEntry[]> = {};
	private brain?: BrainState;
	private boardTimer?: NodeJS.Timeout;
	private lastSent = '';
	private pending?: NodeJS.Timeout;

	constructor(
		private readonly root: vscode.Uri,
		private readonly src: BarraSource,
		private readonly act: BarraActions,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.root, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'barra.css'));
		const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'barra.js'));
		const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		// la sfera unica in WebGPU, se c'e': si carica prima della barra, che la monta (vedi barra.js)
		// (motore/gpu.js e' il dispositivo condiviso e va caricato per primo)
		const gpu = ['gpu', 'sfera-gpu']
			.map(n => vscode.Uri.joinPath(media, 'motore', n + '.js'))
			.filter(u => fs.existsSync(u.fsPath))
			.map(u => `<script nonce="${nonce}" src="${view.webview.asWebviewUri(u)}"></script>`)
			.join('');
		view.webview.html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Melissa</title>
</head>
<body><main id="barra"></main>${gpu}<script nonce="${nonce}" src="${js}"></script></body>
</html>`;
		view.webview.onDidReceiveMessage((m: any) => void this.onMessage(m));
		view.onDidChangeVisibility(() => {
			void view.webview.postMessage({ type: 'visibile', visible: view.visible });
			if (view.visible) this.wake();
			else this.sleep();
		});
		// la finestra davanti o dietro: dietro la sfera si ferma, se Melissa tace (media/barra.js, aggiornaRiposo)
		const fuoco = vscode.window.onDidChangeWindowState(st => void view.webview.postMessage({ type: 'fuoco', focused: st.focused }));
		view.onDidDispose(() => {
			fuoco.dispose();
			this.sleep();
			this.view = undefined;
		});
		this.wake();
	}

	private async onMessage(m: any): Promise<void> {
		const s = (x: unknown) => (typeof x === 'string' ? x : '');
		switch (m?.type) {
			case 'ready':
				this.lastSent = '';
				void this.view?.webview.postMessage({ type: 'fuoco', focused: vscode.window.state.focused });
				await this.refreshBrain();
				return this.push(true);
			case 'converse':
				return this.act.converse();
			case 'ask':
				return s(m.text).trim() ? this.act.ask(s(m.text).trim()) : undefined;
			case 'voice.toggle':
				return this.act.toggleVoice();
			case 'brain.set':
				try {
					await this.act.setBrain(m.provider, s(m.model), m.sempre === true);
				} catch (e: any) {
					void vscode.window.showWarningMessage(e?.message ?? String(e));
				}
				await this.refreshBrain();
				return this.push(true);
			case 'racconta.set':
				await this.act.setRacconta(!!m.on);
				return this.push(true);
			case 'effort.set':
				if (['rapido', 'normale', 'profondo'].includes(m.effort)) await this.act.setEffort(m.effort);
				await this.refreshBrain();
				return this.push(true);
			case 'job.focus':
				return s(m.id) ? this.act.focusJob(s(m.id)) : undefined;
			case 'job.write':
				return s(m.id) && s(m.text).trim() ? this.act.writeJob(s(m.id), s(m.text).trim()) : undefined;
			case 'open':
				return s(m.path) ? this.act.open(s(m.path)) : undefined;
			case 'claude':
				return s(m.path) && s(m.id) ? this.act.resume(s(m.path), s(m.id)) : undefined;
			case 'home':
				return this.act.home(s(m.view) || undefined);
			case 'comando':
				return s(m.id) ? this.act.command(s(m.id)) : undefined;
			case 'sfera.diag':
				// con quale motore gira la sfera della barra, e perche' (docs/CONTRATTI.md, 7.8)
				return this.act.log(`sfera della barra su ${s(m.motore) || '?'}${s(m.motivo) ? `, motivo: ${s(m.motivo)}` : ''}`);
			case 'bacheca.sessione': {
				const sid = s(m.sessionId);
				if (!sid) return;
				// risposta a parte: la barra la tiene accanto alla sessione, il giro dei 20 s non la cancella
				const items = await this.act.sessionBoard(sid);
				void this.view?.webview.postMessage({ type: 'bacheca.sessione', sessionId: sid, items });
				return;
			}
		}
	}

	/** Vista aperta: bacheca ogni 20 s e cervello ogni 10 minuti (le rispettive cache decidono se andare in rete). */
	private wake(): void {
		if (this.boardTimer || !this.view?.visible) return;
		const tick = async () => {
			await this.refreshBoard();
			this.push(false);
		};
		void tick();
		void this.refreshBrain().then(() => this.push(false));
		this.boardTimer = setInterval(() => void tick(), 20_000);
	}

	private sleep(): void {
		clearInterval(this.boardTimer);
		this.boardTimer = undefined;
	}

	private async refreshBoard(): Promise<void> {
		try {
			const rows = await this.src.board();
			const by: Record<string, BoardEntry[]> = {};
			for (const r of rows) {
				if (!r.sessionId) continue;
				(by[r.sessionId] ??= []).push({ at: r.at, kind: r.kind, summary: r.summary, file: r.file });
			}
			for (const k of Object.keys(by)) by[k] = by[k].sort((a, b) => b.at - a.at).slice(0, 4);
			this.board = by;
		} catch {
			// la Memoria non risponde: resta la bacheca di prima
		}
	}

	private async refreshBrain(): Promise<void> {
		try {
			this.brain = await this.src.brain();
		} catch {
			// resta lo stato di prima
		}
	}

	/** Il cervello va riletto subito: il Nucleo si e' appena collegato (Apple Intelligence diventa disponibile). Prima
	 *  la barra restava fino a 10 minuti su «il Nucleo non è acceso» dopo ogni riavvio. */
	refreshBrainNow(): void {
		void this.refreshBrain().then(() => this.push(false));
	}

	/** Manda lo stato, al massimo una volta ogni 80 ms (il livello audio arriva molto spesso) e solo se e' cambiato. */
	update(): void {
		if (!this.view?.visible || this.pending) return;
		this.pending = setTimeout(() => {
			this.pending = undefined;
			this.push(false);
		}, 80);
	}

	private push(force: boolean): void {
		if (!this.view?.visible) return;
		const msg = {
			type: 'stato',
			assistant: this.src.assistant(),
			work: this.src.work(),
			workCounts: this.src.workCounts(),
			board: this.board,
			brain: this.brain,
			racconta: this.src.racconta(),
		};
		const sig = JSON.stringify(msg);
		if (!force && sig === this.lastSent) return;
		this.lastSent = sig;
		void this.view.webview.postMessage(msg);
	}

	/** Si fa vedere senza rubare il fuoco. */
	reveal(): void {
		if (this.view) this.view.show(true);
		else void vscode.commands.executeCommand(`workbench.view.extension.${BarraView.container}`);
	}

	dispose(): void {
		this.sleep();
		clearTimeout(this.pending);
	}
}
