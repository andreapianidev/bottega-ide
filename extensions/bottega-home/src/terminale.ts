/* Il terminale nella Bottega: la quarta voce della barra di destra (dopo Melissa, Claude Code e Cline), la cartella
   giusta per un terminale nuovo, il profilo «Bottega» di iTerm2 con i colori e il carattere del tema e il comando che
   apre iTerm2 (o Terminale) nella stessa cartella. Qui solo la logica pura, provata da test/terminale.cjs; il
   collegamento a VS Code sta in src/terminale-host.ts.
   Contratto: docs/CONTRATTI.md, sezione 12. */

import * as path from 'path';
import { spostaInBarra } from './cline';

/** Il contenitore del terminale di VS Code: sta nel pannello in basso e ha lo stesso id della sua vista. */
export const TERMINALE_CONTENITORE = 'terminal';
/** ViewContainerLocation.AuxiliaryBar in VS Code: la barra laterale secondaria, a destra. */
const BARRA_DESTRA = 2;
export const PROFILO_ITERM = 'Bottega';
/** Guid fisso: iTerm2 riconosce lo stesso profilo anche quando il file cambia. */
export const GUID_ITERM = 'bottega-terminale-andreapiani';

// ---------- la cartella giusta ----------

export interface ContestoCartella {
	/** La cartella della sessione nella scheda attiva, se la scheda e' un terminale (un lavoro, Claude, una shell). */
	sessione?: string;
	/** Il file attivo nell'editor, solo se sta su disco. */
	file?: string;
	/** Le cartelle aperte nella finestra. */
	workspace: string[];
	home: string;
}

const dentro = (p: string, radice: string) => p === radice || p.startsWith(radice.endsWith(path.sep) ? radice : radice + path.sep);

/** La radice del repository (o del worktree, dove `.git` e' un file) che contiene `dir`. La home non conta: una home
 *  con i dotfile sotto git renderebbe «repository» ogni cartella di Andrea. */
export function radiceGit(dir: string, home: string, esiste: (p: string) => boolean): string | undefined {
	let d = path.resolve(dir);
	for (;;) {
		if (d !== home && esiste(path.join(d, '.git'))) return d;
		const su = path.dirname(d);
		if (su === d) return undefined;
		d = su;
	}
}

/** Dove nasce un terminale nuovo: la sessione della scheda attiva; altrimenti la cartella di lavoro del file attivo
 *  (la piu' interna tra la radice git e la cartella del workspace che lo contiene, poi la cartella del file);
 *  altrimenti la prima cartella del workspace; altrimenti la home. */
export function cartellaCorrente(c: ContestoCartella, esiste: (p: string) => boolean): string {
	if (c.sessione && esiste(c.sessione)) return c.sessione;
	if (c.file) {
		const dir = path.dirname(c.file);
		const git = radiceGit(dir, c.home, esiste);
		const ws = c.workspace.filter(w => dentro(c.file!, w)).sort((a, b) => b.length - a.length)[0];
		const scelta = [git, ws].filter((x): x is string => !!x).sort((a, b) => b.length - a.length)[0];
		if (scelta) return scelta;
		if (esiste(dir)) return dir;
	}
	return c.workspace[0] ?? c.home;
}

/** La cartella di una voce dell'Explorer o di una scheda: una cartella resta se stessa, un file da' la sua. */
export function cartellaDi(p: string, eCartella: boolean): string {
	return eCartella ? p : path.dirname(p);
}

// ---------- la voce nella barra di destra ----------

/** Il programma che aspetta la chiusura della Bottega e poi porta il terminale nella barra di destra come ultima
 *  voce, con `spostaInBarra` di src/cline.ts (stesso meccanismo di Cline, docs/CONTRATTI.md 11). Se alla stessa
 *  chiusura sposta anche Cline (BOTTEGA_ASPETTA = il suo file segnale), aspetta che abbia finito, fino a 30 secondi:
 *  due programmi che scrivono insieme le stesse chiavi si pestano, e il terminale deve venire dopo Cline.
 *  Parametri da env: BOTTEGA_PID, BOTTEGA_DB, BOTTEGA_FATTO, BOTTEGA_LOG, BOTTEGA_ASPETTA (facoltativo). */
export function programmaTerminale(): string {
	return `
const { execFileSync } = require('child_process');
const fs = require('fs');
const sposta = ${spostaInBarra.toString()};
const pid = Number(process.env.BOTTEGA_PID), db = process.env.BOTTEGA_DB, aspetta = process.env.BOTTEGA_ASPETTA || '';
const log = m => { try { fs.appendFileSync(process.env.BOTTEGA_LOG, new Date().toISOString() + ' ' + m + '\\n'); } catch {} };
const vivo = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sql = s => execFileSync('/usr/bin/sqlite3', [db, s], { encoding: 'utf8' }).trim();
const leggi = k => { try { return JSON.parse(sql("select value from ItemTable where key='" + k + "'") || 'null'); } catch { return null; } };
const scrivi = (k, v) => sql("insert or replace into ItemTable(key, value) values('" + k + "', '" + JSON.stringify(v).replace(/'/g, "''") + "')");
function applica() {
	try {
		const r = sposta(leggi('views.customizations'), leggi('workbench.auxiliarybar.pinnedPanels'), ${JSON.stringify(TERMINALE_CONTENITORE)}, ${BARRA_DESTRA});
		scrivi('views.customizations', r.customizations);
		scrivi('workbench.auxiliarybar.pinnedPanels', r.pinned);
		fs.writeFileSync(process.env.BOTTEGA_FATTO, new Date().toISOString() + '\\n');
		log('il terminale e\\' nella barra di destra, ultima voce');
	} catch (e) { log('terminale non spostato: ' + (e && e.message)); }
}
function dopoCline(n) {
	if (!aspetta || fs.existsSync(aspetta) || n >= 30) {
		if (aspetta && n >= 30) log('Cline non ha finito in 30 secondi: sposto lo stesso');
		return setTimeout(applica, 500);
	}
	setTimeout(() => dopoCline(n + 1), 1000);
}
log('aspetto la chiusura della Bottega (processo ' + pid + ')' + (aspetta ? ', poi Cline' : ''));
const t = setInterval(() => { if (!vivo()) { clearInterval(t); setTimeout(() => dopoCline(0), 1000); } }, 1000);
`;
}

// ---------- iTerm2 e Terminale ----------

export type Esterno = 'iterm2' | 'terminal';

/** Lo script di iTerm2: una finestra nuova con il profilo «Bottega», poi `cd` nella cartella. Cartella e profilo
 *  arrivano come argomenti (argv), mai dentro il testo dello script; `quoted form of` li cita per la shell. */
export const SCRIPT_ITERM = [
	'on run argv',
	'set cartella to item 1 of argv',
	'set profilo to item 2 of argv',
	'tell application "iTerm"',
	'activate',
	'set w to (create window with profile profilo)',
	'tell current session of w to write text "cd " & quoted form of cartella & " && clear"',
	'end tell',
	'end run',
];

/** Cosa lanciare (con execFile, senza shell) per aprire il terminale esterno nella cartella. Senza iTerm2 si apre
 *  Terminale, e `avviso` dice perche'. */
export function comandoEsterno(scelta: Esterno, cartella: string, itermInstallato: boolean): { file: string; args: string[]; app: string; avviso?: string } {
	if (scelta === 'iterm2' && itermInstallato) {
		return { file: '/usr/bin/osascript', args: [...SCRIPT_ITERM.flatMap(r => ['-e', r]), cartella, PROFILO_ITERM], app: 'iTerm2' };
	}
	return {
		file: '/usr/bin/open',
		args: ['-a', 'Terminal', cartella],
		app: 'Terminale',
		...(scelta === 'iterm2' ? { avviso: 'iTerm2 non e\' installato: ho aperto Terminale.' } : {}),
	};
}

export interface ColoreIterm {
	'Red Component': number;
	'Green Component': number;
	'Blue Component': number;
	'Alpha Component': number;
	'Color Space': 'sRGB';
}

const hex = (s: string): [number, number, number, number] | undefined => {
	const m = /^#([0-9a-f]{3,8})$/i.exec(String(s ?? '').trim());
	if (!m) return undefined;
	let h = m[1];
	if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
	if (h.length !== 6 && h.length !== 8) return undefined;
	const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
	return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
};

const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** Un colore del tema per iTerm2. Un colore trasparente si fonde sullo sfondo: iTerm2 non lo mescola da solo. */
export function coloreIterm(colore: string, sfondo = '#000000'): ColoreIterm | undefined {
	const c = hex(colore);
	if (!c) return undefined;
	const s = hex(sfondo) ?? [0, 0, 0, 1];
	const a = c[3];
	const mix = (i: number) => r4(c[i] * a + s[i] * (1 - a));
	return { 'Red Component': mix(0), 'Green Component': mix(1), 'Blue Component': mix(2), 'Alpha Component': 1, 'Color Space': 'sRGB' };
}

const NOMI_FONT: Record<string, string> = {
	'sf mono': 'SFMono-Regular',
	menlo: 'Menlo-Regular',
	monaco: 'Monaco',
	'jetbrains mono': 'JetBrainsMono-Regular',
	'fira code': 'FiraCode-Regular',
	'source code pro': 'SourceCodePro-Regular',
	'courier new': 'CourierNewPSMT',
	monospace: 'Menlo-Regular',
};

/** Il carattere di VS Code ("'SF Mono', Menlo, monospace") nel formato di iTerm2: nome PostScript e dimensione. */
export function fontIterm(famiglia: string | undefined, dimensione: number | undefined): string {
	const prima = String(famiglia ?? '').split(',')[0].trim().replace(/^['"]|['"]$/g, '').trim();
	const nome = NOMI_FONT[prima.toLowerCase()] ?? (prima ? prima.replace(/\s+/g, '') + '-Regular' : 'Menlo-Regular');
	const d = typeof dimensione === 'number' && dimensione > 0 ? Math.round(dimensione * 10) / 10 : 13;
	return `${nome} ${d}`;
}

const ANSI = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];

/** Il Dynamic Profile «Bottega» di iTerm2 dai colori del tema (chiavi `terminal.*` di VS Code) e dal carattere del
 *  terminale; con `comando`, la shell da lanciare (lo zsh della Bottega con Agnes). Testo stabile: si riscrive il file
 *  solo se cambia. */
export function profiloIterm(colori: Record<string, string>, carattere: { famiglia?: string; dimensione?: number; altezzaRiga?: number; cursore?: string }, comando?: string): string {
	const sfondo = colori['terminal.background'] ?? colori['editor.background'] ?? '#000000';
	const testo = colori['terminal.foreground'] ?? colori['editor.foreground'] ?? '#ffffff';
	const p: Record<string, unknown> = {
		Name: PROFILO_ITERM,
		Guid: GUID_ITERM,
		Tags: ['Bottega'],
		'Normal Font': fontIterm(carattere.famiglia, carattere.dimensione),
		'Use Non-ASCII Font': false,
		'Vertical Spacing': typeof carattere.altezzaRiga === 'number' && carattere.altezzaRiga >= 1 ? Math.round(carattere.altezzaRiga * 100) / 100 : 1,
		'Horizontal Spacing': 1,
		'Cursor Type': carattere.cursore === 'block' ? 2 : carattere.cursore === 'underline' ? 0 : 1,
		'Blinking Cursor': true,
		'Use Bold Font': true,
	};
	// lo stesso zsh dei terminali della Bottega, con Agnes (src/terminale-agnes.ts, comandoIterm)
	if (comando) {
		p['Custom Command'] = 'Yes';
		p.Command = comando;
	}
	const metti = (chiave: string, colore: string | undefined) => {
		const c = colore ? coloreIterm(colore, sfondo) : undefined;
		if (c) p[chiave] = c;
	};
	metti('Background Color', sfondo);
	metti('Foreground Color', testo);
	metti('Bold Color', testo);
	metti('Cursor Color', colori['terminalCursor.foreground'] ?? colori['editorCursor.foreground'] ?? testo);
	metti('Cursor Text Color', colori['terminalCursor.background'] ?? sfondo);
	metti('Selection Color', colori['terminal.selectionBackground'] ?? colori['editor.selectionBackground']);
	metti('Selected Text Color', colori['terminal.selectionForeground'] ?? testo);
	metti('Link Color', colori['textLink.foreground']);
	ANSI.forEach((nome, i) => {
		metti(`Ansi ${i} Color`, colori[`terminal.ansi${nome}`]);
		metti(`Ansi ${i + 8} Color`, colori[`terminal.ansiBright${nome}`]);
	});
	return JSON.stringify({ Profiles: [p] }, null, 2) + '\n';
}

/** I colori che valgono: quelli del tema, poi `workbench.colorCustomizations` generale e quella del tema. */
export function coloriEffettivi(tema: Record<string, string>, personalizzati: any, nomeTema: string): Record<string, string> {
	const out: Record<string, string> = { ...tema };
	const pers = personalizzati && typeof personalizzati === 'object' ? personalizzati : {};
	for (const [k, v] of Object.entries(pers)) if (typeof v === 'string') out[k] = v;
	const delTema = pers[`[${nomeTema}]`];
	if (delTema && typeof delTema === 'object') for (const [k, v] of Object.entries(delTema)) if (typeof v === 'string') out[k] = v;
	return out;
}
