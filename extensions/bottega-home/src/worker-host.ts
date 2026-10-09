import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { resolveNode } from './memoria';
import * as vscode from 'vscode';
import type { WorkerQueue } from './worker';

/** One visible instrument for the shared queue. No polling or browser network access. */
export function registerWorkerPanel(ctx: vscode.ExtensionContext, queue: WorkerQueue): void {
	let panel: vscode.WebviewPanel | undefined;
	let selected: string | undefined;
	let timer: NodeJS.Timeout | undefined;
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 25);
	status.command = 'bottega.openWorker';
	const refresh = () => {
		let data;
		try { data = queue.status(); } catch { return; }
		const online = data.workers.some(w => w.online && w.available !== false);
		status.text = `$(device-mobile) iPhone: ${online ? `${data.counts.leased} in corso` : 'in attesa'}`;
		status.tooltip = 'Calcolo condiviso con Avo: apri lavori e contributo reale dell’iPhone';
		let job;
		try { job = selected ? queue.get(selected) : undefined; } catch { selected = undefined; }
		if (panel?.visible) void panel.webview.postMessage({ type: 'status', data, job });
	};
	const visibility = () => {
		clearInterval(timer); timer = undefined;
		if (panel?.visible) { refresh(); timer = setInterval(refresh, 2000); }
	};
	const submit = async (message: any) => {
		try {
			if (message.type === 'ready') return refresh();
			if (message.type === 'select' && typeof message.id === 'string') { selected = message.id; return refresh(); }
			if (message.type === 'cancel' && selected) { queue.cancel(selected); return refresh(); }
			if (message.type === 'memory') {
				const cli = [path.join(ctx.extensionPath, 'memoria/lib/worker-client.mjs'), path.join(os.homedir(), '.bottega/memoria-app/lib/worker-client.mjs')].find(p => fs.existsSync(p));
				if (!cli) throw new Error('Il componente Memoria non è installato.');
				const output = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Indicizzo fino a 6 memorie sull’iPhone' }, () => new Promise<string>((resolve, reject) => {
					execFile(resolveNode(), [cli, '--wait-ms', '30000'], { timeout: 35000, maxBuffer: 64 * 1024 }, (error, stdout) => error ? reject(new Error('Indicizzazione sospesa: il lavoro rimane recuperabile.')) : resolve(stdout));
				}));
				const result = JSON.parse(output);
				void vscode.window.showInformationMessage(`Memoria: ${result.applied || 0} vettori applicati. Stato: ${result.state}.`);
				return refresh();
			}
			let input: any;
			let operation: 'embeddings' | 'ocr';
			if (message.type === 'embeddings') {
				operation = 'embeddings'; input = { texts: [String(message.text ?? '')] };
			} else if (message.type === 'ocr') {
				const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Immagini: ['png', 'jpg', 'jpeg'] }, title: 'Leggi un’immagine sull’iPhone' });
				if (!files?.[0]) return;
				const file = files[0].fsPath;
				if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('Scegli un’immagine entro 4 MB.');
				operation = 'ocr'; input = { imageBase64: fs.readFileSync(file).toString('base64'), mimeType: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg' };
			} else return;
			const job = queue.enqueue({ origin: 'bottega', operation, input });
			selected = job.id;
			refresh();
		} catch (error) {
			void panel?.webview.postMessage({ type: 'error', message: (error as Error).message });
		}
	};
	ctx.subscriptions.push(status, { dispose: () => { clearInterval(timer); panel?.dispose(); } });
	const unsubscribe = queue.onChange(refresh);
	ctx.subscriptions.push({ dispose: unsubscribe });
	ctx.subscriptions.push(vscode.commands.registerCommand('bottega.openWorker', () => {
		if (panel) return panel.reveal();
		panel = vscode.window.createWebviewPanel('bottega.worker', 'Calcolo condiviso', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
		panel.webview.html = html();
		panel.webview.onDidReceiveMessage(message => void submit(message), undefined, ctx.subscriptions);
		panel.onDidChangeViewState(visibility, undefined, ctx.subscriptions);
		panel.onDidDispose(() => { panel = undefined; clearInterval(timer); timer = undefined; });
		visibility();
	}));
	refresh(); status.show();
}

function html(): string {
	const nonce = crypto.randomBytes(20).toString('base64');
	return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<title>Calcolo condiviso</title><style nonce="${nonce}">
:root{color-scheme:dark light}*{box-sizing:border-box}body{margin:0;padding:36px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);line-height:1.5}main{max-width:1080px;margin:auto}h1{font-size:30px;font-weight:550;margin:0 0 6px}h2{font-size:18px;font-weight:550;margin:0 0 18px}p{max-width:72ch}.muted{color:var(--vscode-descriptionForeground)}.line{display:flex;align-items:center;gap:20px;flex-wrap:wrap;border-block:1px solid var(--vscode-panel-border);padding:20px 0;margin:28px 0}.line strong{font-size:20px;font-weight:550}.line span{display:block}.instrument{display:grid;grid-template-columns:minmax(230px,1fr) minmax(320px,2fr);gap:36px}textarea{width:100%;min-height:140px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));padding:12px;font:inherit}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:9px 13px;font:inherit;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:focus-visible,textarea:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:3px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 28px}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:10px 6px;border-bottom:1px solid var(--vscode-panel-border);font-weight:400}th{color:var(--vscode-descriptionForeground)}td button{background:transparent;color:var(--vscode-textLink-foreground);padding:0;text-align:left}#result{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;padding:16px;background:var(--vscode-textCodeBlock-background);margin-top:20px}#error{color:var(--vscode-errorForeground)}#connection{color:var(--vscode-textLink-foreground)}@media(max-width:740px){body{padding:20px}.instrument{grid-template-columns:1fr;gap:16px}.line{gap:14px}}
</style></head><body><main><h1>Calcolo condiviso</h1><p id="connection">Leggo il collegamento dell’iPhone.</p><p class="muted">Bottega e Avo affidano lavori allo stesso telefono. Attiva «Aiuta il Mac» nella Bottega sull’iPhone e tieni l’app aperta.</p>
<div class="line" aria-label="Contributo misurato"><div><strong id="completed">0</strong><span>Lavori completati</span></div><div><strong id="compute">0 ms</strong><span>Calcolo sull’iPhone</span></div><div><strong id="cpu">0 ms</strong><span>Tempo CPU dell’app</span></div><div><strong id="throughput">0</strong><span>Lavori al minuto</span></div></div>
<div class="instrument"><section><h2>Affida un lavoro</h2><label for="text">Testo da indicizzare</label><textarea id="text" maxlength="2000" placeholder="Una nota o un testo da trasformare in un vettore di ricerca."></textarea><div class="actions"><button id="embed">Indicizza sull’iPhone</button><button id="ocr" class="secondary">Leggi un’immagine</button></div><div class="actions"><button id="memory" class="secondary">Indicizza memorie in attesa</button></div><p class="muted">Il testo riconosciuto e i vettori tornano al Mac. I dati restano fra questo Mac e l’iPhone.</p><p id="error" role="alert"></p></section>
<section><h2>Lavori delle due app</h2><table><thead><tr><th>Origine e lavoro</th><th>Stato</th><th>Calcolo</th></tr></thead><tbody id="jobs"></tbody></table><div id="result" hidden></div><div class="actions"><button id="cancel" class="secondary" hidden>Annulla il lavoro</button></div><p class="muted">I tempi sono misurati sul lavoro eseguito. Non rappresentano la percentuale totale di GPU o Neural Engine del telefono.</p></section></div>
<script nonce="${nonce}">
const api=acquireVsCodeApi(),by=id=>document.getElementById(id),n=x=>Number(x||0).toLocaleString('it-IT',{maximumFractionDigits:1}),ms=x=>x>=1000?n(x/1000)+' s':n(x)+' ms';
by('memory').onclick=()=>api.postMessage({type:'memory'});by('embed').onclick=()=>{by('error').textContent='';api.postMessage({type:'embeddings',text:by('text').value})};by('ocr').onclick=()=>{by('error').textContent='';api.postMessage({type:'ocr'})};by('cancel').onclick=()=>api.postMessage({type:'cancel'});
window.addEventListener('message',e=>{const m=e.data;if(m.type==='error'){by('error').textContent=m.message;return}if(m.type!=='status')return;const d=m.data,w=d.workers.filter(x=>x.online&&x.available!==false);by('connection').textContent=w.length?'iPhone collegato. '+d.counts.leased+' lavori in corso, '+d.counts.queued+' in coda.':'iPhone in attesa. Apri Bottega sul telefono e attiva Aiuta il Mac.';by('completed').textContent=n(d.metrics.completed);by('compute').textContent=ms(d.metrics.elapsedMs);by('cpu').textContent=ms(d.metrics.cpuMs);by('throughput').textContent=n(d.metrics.throughputPerMinute);by('jobs').replaceChildren();const labels={queued:'In coda',leased:'Sull’iPhone',completed:'Completato',cancelled:'Annullato',failed:'Non riuscito'};for(const j of [...d.active,...d.recent]){const tr=document.createElement('tr'),a=document.createElement('td'),b=document.createElement('td'),c=document.createElement('td'),button=document.createElement('button');button.textContent=(j.origin==='avo'?'Avo':'Bottega')+' / '+(j.operation==='ocr'?'Lettura immagine':'Indicizzazione');button.onclick=()=>api.postMessage({type:'select',id:j.id});a.append(button);b.textContent=labels[j.state]||j.state;c.textContent=j.metrics?ms(j.metrics.elapsedMs):'In attesa';tr.append(a,b,c);by('jobs').append(tr)}const j=m.job;by('result').hidden=!j;by('cancel').hidden=!j||!['queued','leased'].includes(j.state);if(j){by('result').textContent=j.result?(j.operation==='ocr'?j.result.text:j.result.vectors.length+' vettori da '+j.result.dimension+' dimensioni.\\n'+JSON.stringify(j.result.vectors[0].slice(0,8))):(j.error||labels[j.state]||j.state)}});api.postMessage({type:'ready'});
</script></main></body></html>`;
}
