import * as vscode from 'vscode';
import type { WorkItem } from './jobs';
import { FonteTerminale, SessioniPonte } from './ponte-sessioni';

/* La scheda di sessione dentro la Bottega (docs/CONTRATTI.md, 9.5): crea SessioniPonte con il lavoro in giro e i
   terminali dei lavori. L'uscita di un terminale si legge con l'API stabile della shell integration di VS Code:
   si ricorda quale comando sta girando in ogni terminale (onDidStartTerminalShellExecution, nessun costo) e solo
   quando l'iPhone guarda si apre `execution.read()`, che da' l'uscita da quel momento in poi. Niente patch a
   VS Code, niente su disco. */

export interface SessioniHostDeps {
	work(): WorkItem[];
	projects(): string[];
	writeJobRaw?(id: string, data: string, invio: boolean): boolean;
	jobTerminal?(id: string): vscode.Terminal | undefined;
	cambiato(): void;
	log(riga: string): void;
}

export function creaSessioni(ctx: vscode.ExtensionContext, d: SessioniHostDeps): SessioniPonte {
	const esecuzioni = new Map<vscode.Terminal, vscode.TerminalShellExecution>();
	ctx.subscriptions.push(
		vscode.window.onDidStartTerminalShellExecution(e => esecuzioni.set(e.terminal, e.execution)),
		vscode.window.onDidEndTerminalShellExecution(e => {
			if (esecuzioni.get(e.terminal) === e.execution) esecuzioni.delete(e.terminal);
		}),
		vscode.window.onDidCloseTerminal(t => esecuzioni.delete(t)),
	);

	const fonte = (jobId: string): FonteTerminale | undefined => {
		const term = d.jobTerminal?.(jobId);
		if (!term) return undefined;
		return {
			ascolta(dati, fine) {
				const ex = esecuzioni.get(term);
				if (!ex) {
					return term.shellIntegration
						? 'Il comando di questo lavoro e\' partito prima che la Bottega lo potesse seguire (per esempio prima dell\'ultima apertura): l\'uscita non si puo\' leggere.'
						: 'Questo terminale non ha la shell integration di VS Code: l\'uscita non si puo\' leggere da qui.';
				}
				const it = ex.read()[Symbol.asyncIterator]();
				let fermo = false;
				void (async () => {
					try {
						while (!fermo) {
							const r = await it.next();
							if (r.done) break;
							if (!fermo) dati(r.value);
						}
					} catch {
						// il terminale si e' chiuso mentre si leggeva
					}
					if (!fermo) fine();
				})();
				return () => {
					fermo = true;
					void it.return?.();
				};
			},
		};
	};

	const sessioni = new SessioniPonte({
		lavori: d.work,
		progetti: d.projects,
		scrivi: d.writeJobRaw,
		terminale: d.jobTerminal ? fonte : undefined,
		cambiato: d.cambiato,
		log: d.log,
	});
	ctx.subscriptions.push({ dispose: () => sessioni.dispose() });
	return sessioni;
}
