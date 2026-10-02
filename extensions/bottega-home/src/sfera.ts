import * as vscode from 'vscode';
import type { AssistantState } from './assistant';

/** Melissa nella barra laterale: una webview con la sua sfera, dentro l'IDE invece che sullo schermo.
 *  Messaggi: docs/CONTRATTI.md, 4.8. */
export class SferaView implements vscode.WebviewViewProvider {
	static readonly id = 'bottega.melissa';
	private view?: vscode.WebviewView;

	constructor(
		private readonly root: vscode.Uri,
		private readonly current: () => AssistantState | undefined,
		private readonly on: { converse(): void; ask(text: string): void; open(): void; toggle(): void },
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.root, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sfera.css'));
		const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'sfera.js'));
		const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		view.webview.html = `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Melissa</title>
</head>
<body><main id="sfera-vista"></main><script nonce="${nonce}" src="${js}"></script></body>
</html>`;
		view.webview.onDidReceiveMessage((m: any) => {
			switch (m?.type) {
				case 'ready':
					return this.send(this.current());
				case 'converse':
					return this.on.converse();
				case 'ask':
					return typeof m.text === 'string' && m.text.trim() ? this.on.ask(m.text.trim()) : undefined;
				case 'open':
					return this.on.open();
				case 'voice.toggle':
					return this.on.toggle();
			}
		});
		view.onDidDispose(() => (this.view = undefined));
		view.onDidChangeVisibility(() => view.visible && this.send(this.current()));
	}

	send(state: AssistantState | undefined): void {
		if (state && this.view?.visible) void this.view.webview.postMessage({ type: 'assistant', state });
	}

	/** Si fa vedere senza rubare il fuoco: Melissa ha cominciato ad ascoltare. */
	reveal(): void {
		if (this.view) this.view.show(true);
		else void vscode.commands.executeCommand('workbench.view.extension.melissa');
	}
}
