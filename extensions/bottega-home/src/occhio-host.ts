/* Gli occhi di Melissa sull'editor, dal lato di VS Code (la logica e' in src/occhio.ts, CONTRATTI 6). Tiene a mente
   l'ultimo file di codice guardato: quando davanti c'e' la Home, la barra di Melissa o un'immagine, activeTextEditor e'
   vuoto, e «spiegami questo» deve valere per il file che Andrea stava guardando un attimo prima. */

import * as vscode from 'vscode';
import { nomeCorto, rigaContesto, scegliFile, testoDaLeggere, VistaEditor } from './occhio';

export interface Occhio {
	vista(): VistaEditor | undefined;
	/** la riga per il prompt di sistema, o undefined senza file aperti */
	riga(): string | undefined;
	/** il codice per lo strumento codice_leggi: il file attivo, o un altro per nome */
	leggi(nome?: string): string;
}

/** Solo file veri o nuovi: non il pannello Output, non i diff di git, non le impostazioni. */
const buono = (d: vscode.TextDocument) => d.uri.scheme === 'file' || d.uri.scheme === 'untitled';

export function registraOcchio(ctx: vscode.ExtensionContext): Occhio {
	let ultimo: vscode.TextEditor | undefined = vscode.window.activeTextEditor && buono(vscode.window.activeTextEditor.document) ? vscode.window.activeTextEditor : undefined;
	ctx.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(e => {
			if (e && buono(e.document)) ultimo = e;
		}),
		vscode.window.onDidChangeTextEditorSelection(e => {
			if (buono(e.textEditor.document)) ultimo = e.textEditor;
		}),
		vscode.workspace.onDidCloseTextDocument(d => {
			if (ultimo?.document === d) ultimo = undefined;
		}),
	);

	const cartelle = () => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
	const nome = (d: vscode.TextDocument) => (d.uri.scheme === 'untitled' ? 'un file senza nome' : nomeCorto(d.uri.fsPath, cartelle()));

	const attuale = (): vscode.TextEditor | undefined => {
		const a = vscode.window.activeTextEditor;
		if (a && buono(a.document)) return a;
		// l'ultimo guardato, se e' ancora aperto (anche se la sua scheda non e' davanti)
		if (ultimo && !ultimo.document.isClosed) return ultimo;
		return vscode.window.visibleTextEditors.find(e => buono(e.document));
	};

	const vistaDi = (ed: vscode.TextEditor | undefined, doc: vscode.TextDocument): VistaEditor => {
		const r = ed?.visibleRanges ?? [];
		const sel = ed && !ed.selection.isEmpty ? ed.selection : undefined;
		return {
			file: doc.uri.fsPath,
			nome: nome(doc),
			lingua: doc.languageId,
			righe: doc.lineCount,
			schermo: r.length ? [r[0].start.line + 1, r[r.length - 1].end.line + 1] : undefined,
			cursore: (ed?.selection.active.line ?? 0) + 1,
			selezione: sel ? { da: sel.start.line + 1, a: sel.end.line + 1, testo: doc.getText(sel) } : undefined,
			accanto: vscode.window.visibleTextEditors.filter(e => e !== ed && e.document !== doc && buono(e.document)).map(e => nome(e.document)),
		};
	};

	const vista = (): VistaEditor | undefined => {
		const ed = attuale();
		return ed ? vistaDi(ed, ed.document) : undefined;
	};

	return {
		vista,
		riga: () => rigaContesto(vista()),
		leggi(nomeFile) {
			if (nomeFile && nomeFile.trim()) {
				const visibili = vscode.window.visibleTextEditors.filter(e => buono(e.document)).map(e => ({ file: e.document.uri.fsPath, ed: e as vscode.TextEditor | undefined, doc: e.document }));
				const aperti = vscode.workspace.textDocuments.filter(buono).map(d => ({ file: d.uri.fsPath, ed: undefined as vscode.TextEditor | undefined, doc: d }));
				const c = scegliFile(nomeFile, [...visibili, ...aperti]);
				if (!c) return `Non trovo "${nomeFile}" tra i file aperti nell'editor. Aperti: ${[...new Set(aperti.map(a => nome(a.doc)))].slice(0, 10).join(', ') || 'nessuno'}.`;
				return testoDaLeggere(c.doc.getText(), vistaDi(c.ed, c.doc));
			}
			const ed = attuale();
			if (!ed) return 'Nessun file di codice aperto nell\'editor.';
			return testoDaLeggere(ed.document.getText(), vistaDi(ed, ed.document));
		},
	};
}
