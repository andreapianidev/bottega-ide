import * as vscode from 'vscode';
import type { Snapshot } from './extension';

export interface PlanciaActions {
	open(p: string): void;
	here(p: string): void;
	claude(p: string, resumeId?: string): void;
	finder(p: string): void;
	xcode(p: string): void;
	push(p: string): void;
	refresh(): void;
}

export class PlanciaPanel {
	private panel?: vscode.WebviewPanel;

	constructor(
		private readonly root: vscode.Uri,
		private readonly current: () => Snapshot,
		onChange: vscode.Event<Snapshot>,
		private readonly actions: PlanciaActions,
	) {
		onChange(s => this.post({ type: 'snapshot', snapshot: s }));
	}

	show(focus?: string) {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
		} else {
			this.create();
		}
		this.post({ type: 'snapshot', snapshot: this.current() });
		if (focus) this.post({ type: 'focus', path: focus });
	}

	private post(msg: unknown) {
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
<main id="app" aria-live="polite"></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
		panel.webview.onDidReceiveMessage((m: { type: keyof PlanciaActions | 'ready'; path?: string; id?: string }) => {
			if (m.type === 'ready') {
				this.post({ type: 'snapshot', snapshot: this.current() });
				return;
			}
			if (m.type === 'refresh') return this.actions.refresh();
			if (!m.path) return;
			if (m.type === 'claude') return this.actions.claude(m.path, m.id);
			this.actions[m.type](m.path);
		});
		panel.onDidDispose(() => (this.panel = undefined));
		this.panel = panel;
	}
}
