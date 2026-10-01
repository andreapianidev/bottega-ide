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
}

export class PlanciaPanel {
	private panel?: vscode.WebviewPanel;

	constructor(
		private readonly root: vscode.Uri,
		private readonly current: () => Snapshot,
		onChange: vscode.Event<Snapshot>,
		private readonly onMessage: (msg: PlanciaMessage) => void,
	) {
		onChange(s => this.send({ type: 'snapshot', snapshot: s }));
	}

	get isOpen(): boolean {
		return !!this.panel;
	}

	show(focus?: string) {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
		} else {
			this.create();
		}
		this.send({ type: 'snapshot', snapshot: this.current() });
		if (focus) this.send({ type: 'focus', path: focus });
	}

	/** Manda un messaggio alla plancia (snapshot, focus, memoria, assistant). */
	send(msg: unknown) {
		this.panel?.webview.postMessage(msg);
	}

	private create() {
		const media = vscode.Uri.joinPath(this.root, 'media');
		const panel = vscode.window.createWebviewPanel('bottega.plancia', 'Bottega', vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [media],
		});
		panel.iconPath = vscode.Uri.joinPath(media, 'activity.svg');
		const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'plancia.css'));
		const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'plancia.js'));
		const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		panel.webview.html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Bottega</title>
</head>
<body>
<main id="app"></main>
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
		panel.onDidDispose(() => (this.panel = undefined));
		this.panel = panel;
	}
}
