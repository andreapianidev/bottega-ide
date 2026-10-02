import * as vscode from 'vscode';
import type { Snapshot } from './extension';

/** Un messaggio dalla plancia all'estensione (contratto, sezione 3). */
export interface PlanciaMessage {
	type: string;
	path?: string;
	id?: string;
	task?: string;
	query?: string;
	project?: string;
	text?: string;
	section?: string;
	/** stats.request: periodo che la plancia sta guardando (7, 30, 90 giorni). */
	period?: number;
	/** Campi dei messaggi della sezione 4 del contratto (rule.fix, notte.config, clients.*, ...). */
	[k: string]: any;
}

export class PlanciaPanel {
	private panel?: vscode.WebviewPanel;

	constructor(
		private readonly root: vscode.Uri,
		private readonly current: () => Snapshot,
		onChange: vscode.Event<Snapshot>,
		private readonly onMessage: (msg: PlanciaMessage) => void,
	) {
		onChange(s => this.pushSnapshot(s));
	}

	/** Chi deve sapere quando la Home compare o sparisce (statistiche, cruscotto). */
	readonly onDidChangeVisibility = new vscode.EventEmitter<boolean>();
	/** Una istantanea arrivata con la Home nascosta: la si manda quando torna davanti. */
	private stale = false;

	get isOpen(): boolean {
		return !!this.panel;
	}

	get isVisible(): boolean {
		return !!this.panel?.visible;
	}

	/** L'istantanea completa pesa circa 100 KB e fa ridisegnare la plancia: con la Home nascosta si rimanda. */
	pushSnapshot(s: Snapshot) {
		if (!this.panel) return;
		if (!this.panel.visible) {
			this.stale = true;
			return;
		}
		this.stale = false;
		this.send({ type: 'snapshot', snapshot: s });
	}

	/** La Home: si apre (o torna davanti) come prima scheda appuntata del primo gruppo. `preserveFocus` la
	 *  apre senza togliere il fuoco a cio' che Andrea sta facendo (avvio con una cartella aperta). */
	show(focus?: string, opts: { preserveFocus?: boolean } = {}) {
		if (this.panel) {
			this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.One, opts.preserveFocus);
		} else {
			this.create(opts.preserveFocus);
		}
		this.send({ type: 'snapshot', snapshot: this.current() });
		if (focus) this.send({ type: 'focus', path: focus });
	}

	/** Ripristino al riavvio: VS Code ridà la scheda (gia' appuntata) e qui la si riempie. */
	adopt(panel: vscode.WebviewPanel) {
		if (this.panel && this.panel !== panel) {
			panel.dispose();
			return;
		}
		this.setup(panel);
	}

	private async pin(panel: vscode.WebviewPanel) {
		// pinEditor agisce sull'editor attivo: la Home lo e' appena creata, anche con preserveFocus
		if (!panel.active) return;
		await vscode.commands.executeCommand('workbench.action.pinEditor').then(undefined, () => undefined);
	}

	/** Manda un messaggio alla plancia (snapshot, focus, memoria, assistant). */
	send(msg: unknown) {
		this.panel?.webview.postMessage(msg);
	}

	private create(preserveFocus = false) {
		const media = vscode.Uri.joinPath(this.root, 'media');
		const panel = vscode.window.createWebviewPanel('bottega.plancia', 'Home', { viewColumn: vscode.ViewColumn.One, preserveFocus }, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [media],
		});
		this.setup(panel);
		void this.pin(panel);
	}

	private setup(panel: vscode.WebviewPanel) {
		const media = vscode.Uri.joinPath(this.root, 'media');
		panel.title = 'Home';
		panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
		panel.iconPath = vscode.Uri.joinPath(media, 'activity.svg');
		const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'plancia.css'));
		const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'plancia.js'));
		// cruscotto, vedetta e clienti stanno in file loro; i loro script vanno caricati prima di plancia.js, che li monta
		const rooms = ['cruscotto', 'vedetta', 'clienti', 'connettori'];
		const css2 = rooms.map(r => `<link rel="stylesheet" href="${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, r + '.css'))}">`).join('\n');
		const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		panel.webview.html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
${css2}
<title>Bottega</title>
</head>
<body>
<main id="app"></main>
${rooms.map(r => `<script nonce="${nonce}" src="${panel.webview.asWebviewUri(vscode.Uri.joinPath(media, r + '.js'))}"></script>`).join('\n')}
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
		panel.webview.onDidReceiveMessage((m: PlanciaMessage) => {
			if (m.type === 'ready') {
				this.send({ type: 'snapshot', snapshot: this.current() });
				return;
			}
			this.onMessage(m);
		});
		panel.onDidChangeViewState(e => {
			const visible = e.webviewPanel.visible;
			if (visible && this.stale) this.pushSnapshot(this.current());
			this.onDidChangeVisibility.fire(visible);
		});
		panel.onDidDispose(() => {
			this.panel = undefined;
			this.onDidChangeVisibility.fire(false);
		});
		this.panel = panel;
	}
}
