/* Gli aggiornamenti dentro la Bottega: collega src/aggiorna.ts a VS Code, al Nucleo (notifiche) e al comando
   «Aggiorna VS Code della Bottega». Contratto: docs/CONTRATTI.md, sezione 10. */

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Aggiornamenti, Notifica, trovaSorgenti } from './aggiorna';
import { Nucleo } from './nucleo';

const CLAUDE = 'anthropic.claude-code';

export function registerAggiornamenti(ctx: vscode.ExtensionContext, nucleo: () => Nucleo | undefined): Aggiornamenti {
	const out = vscode.window.createOutputChannel('Bottega, aggiornamenti', { log: true });
	const cfg = () => vscode.workspace.getConfiguration('bottega.aggiornamenti');
	const dir = path.join(os.homedir(), '.bottega');

	/** Notifica di macOS dal Nucleo; senza Nucleo, quella della Bottega con gli stessi pulsanti. */
	const notifica = (n: Notifica) => {
		const ripiego = () => {
			const titoli = (n.actions ?? []).map(a => a.title);
			void vscode.window.showInformationMessage(`${n.title}. ${n.body}`, ...titoli).then(scelta => {
				const a = n.actions?.find(x => x.title === scelta);
				if (a) void agg.clic(n.id, a.id);
			});
		};
		const nu = nucleo();
		if (!nu) return ripiego();
		nu.request('notify', { ...n }, 8000).catch(ripiego);
	};

	const agg: Aggiornamenti = new Aggiornamenti({
		installato: vscode.version,
		sorgenti: trovaSorgenti(vscode.env.appRoot, cfg().get<string>('sorgenti', ''), os.homedir()),
		fetchFn: (url, init) => fetch(url, init),
		claudeInstallato: () => String(vscode.extensions.getExtension(CLAUDE)?.packageJSON?.version ?? ''),
		installaClaude: v => vscode.commands.executeCommand('workbench.extensions.installExtension', `${CLAUDE}@${v}`) as Promise<unknown>,
		chiedi: async tag => {
			const si = 'Aggiorna';
			const r = await vscode.window.showInformationMessage(
				`Ricompilo la Bottega su VS Code ${tag}?`,
				{ modal: true, detail: 'Ci vogliono da 30 a 60 minuti, con il Mac carico. Alla fine la Bottega si chiude e si riapre da sola: salva i file prima.' },
				si,
			);
			return r === si;
		},
		notifica,
		log: r => out.info(r),
		stato: ctx.globalState,
		fileEsito: path.join(dir, 'aggiornamento.json'),
		fileLog: path.join(dir, 'aggiornamento.log'),
		accesi: () => ({ vscode: cfg().get<boolean>('vscode', true), claude: cfg().get<boolean>('claudeCode', true) }),
	});

	ctx.subscriptions.push(
		out,
		{ dispose: () => agg.dispose() },
		vscode.commands.registerCommand('bottega.aggiornaVSCode', async () => {
			const v = await agg.controllaVSCode(true);
			if (!v) return void vscode.window.showWarningMessage('Non riesco a sapere cosa chiede Claude Code: Open VSX o GitHub non rispondono.');
			if (!v.serve)
				return void vscode.window.showInformationMessage(`Niente da fare: la Bottega e' su VS Code ${v.installato}, Claude Code ${v.claude} chiede ${v.minimo} o successivo.`);
			if (!v.bersaglio) return void vscode.window.showWarningMessage(`Claude Code chiede VS Code ${v.minimo}, ma Microsoft non l'ha ancora pubblicato.`);
			// la notifica con «Aggiorna» e' gia' partita
		}),
	);
	agg.start();
	return agg;
}
