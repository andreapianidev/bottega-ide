/* Cline, la riserva di Claude Code: la terza voce della barra di destra, con DeepSeek (o il fornitore scelto in Cline).
   Qui solo la logica pura: i server MCP di Claude Code tradotti per Cline, la regola globale con il contesto e la
   memoria, lo spostamento nella barra di destra. Il collegamento a VS Code sta in src/cline-host.ts.
   Contratto: docs/CONTRATTI.md, sezione 11. */

export const CLINE_ID = 'saoudrizwan.claude-dev';
/** Il contenitore che Cline dichiara nella barra delle attivita'. */
export const CLINE_CONTENITORE = 'workbench.view.extension.claude-dev-ActivityBar';
/** ViewContainerLocation.AuxiliaryBar in VS Code: la barra laterale secondaria, a destra. */
const BARRA_DESTRA = 2;

export interface ServerCline {
	type: 'stdio' | 'sse' | 'streamableHttp';
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	disabled?: boolean;
	autoApprove?: string[];
	timeout?: number;
}

/** Un server di ~/.claude.json nella forma di cline_mcp_settings.json. */
export function traduciServer(s: any): ServerCline | undefined {
	if (!s || typeof s !== 'object') return undefined;
	if (s.type === 'http' || s.type === 'sse' || (s.url && !s.command)) {
		if (typeof s.url !== 'string') return undefined;
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(s.headers ?? {})) headers[k] = String(v);
		return { type: s.type === 'sse' ? 'sse' : 'streamableHttp', url: s.url, ...(Object.keys(headers).length ? { headers } : {}) };
	}
	if (typeof s.command !== 'string') return undefined;
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(s.env ?? {})) env[k] = String(v);
	return {
		type: 'stdio',
		command: s.command,
		args: Array.isArray(s.args) ? s.args.map(String) : [],
		...(Object.keys(env).length ? { env } : {}),
		...(typeof s.cwd === 'string' ? { cwd: s.cwd } : {}),
	};
}

/** Allinea i server di Cline a quelli utente di Claude Code. Tocca solo i server che ha messo la Bottega (`gestiti`):
 *  quelli aggiunti a mano in Cline restano. Di un server gia' presente si tengono le scelte fatte in Cline (spento,
 *  strumenti approvati, timeout). I nuovi entrano senza strumenti approvati: Cline chiede conferma a ogni chiamata. */
export function allineaServer(claudeJson: any, clineSettings: any, gestiti: string[]): { settings: any; gestiti: string[] } {
	const prima: Record<string, any> = { ...(clineSettings?.mcpServers ?? {}) };
	const dopo: Record<string, any> = {};
	const nuoviGestiti: string[] = [];
	const sorgente: Record<string, any> = claudeJson?.mcpServers ?? {};
	for (const [nome, s] of Object.entries(prima)) {
		// un server della Bottega sparito da Claude Code se ne va anche da Cline
		if (gestiti.includes(nome) && !(nome in sorgente)) continue;
		dopo[nome] = s;
	}
	for (const [nome, s] of Object.entries(sorgente)) {
		const t = traduciServer(s);
		if (!t) continue;
		const cur = prima[nome];
		// un server con lo stesso nome messo a mano in Cline non si sovrascrive
		if (cur && !gestiti.includes(nome)) continue;
		dopo[nome] = {
			...t,
			disabled: cur?.disabled ?? false,
			autoApprove: Array.isArray(cur?.autoApprove) ? cur.autoApprove : [],
			...(typeof cur?.timeout === 'number' ? { timeout: cur.timeout } : {}),
		};
		nuoviGestiti.push(nome);
	}
	return { settings: { ...(clineSettings ?? {}), mcpServers: dopo }, gestiti: nuoviGestiti.sort() };
}

/** La regola globale di Cline: chi e', le regole del progetto, la memoria della Bottega e una copia delle regole
 *  globali di Andrea (~/.claude/CLAUDE.md), che Cline da solo non legge. */
export function regolaCline(claudeMd: string): string {
	const globali = claudeMd.trim();
	return [
		'# La Bottega: regole per Cline',
		'',
		'<!-- File scritto dalla Bottega e riscritto a ogni avvio: le modifiche vanno in ~/.claude/CLAUDE.md, non qui. -->',
		'',
		'Lavori come riserva di Claude Code nella Bottega: stessi progetti, stesse regole, stessa memoria. Una sessione',
		'Claude puo\' essersi fermata a meta\' lavoro perche\' e\' finito il credito: riparti da quello che dice la memoria.',
		'',
		'## Prima di ogni compito',
		'',
		'1. Leggi `CLAUDE.md` nella radice del progetto aperto, se c\'e\': sono le regole del progetto e valgono quanto queste.',
		'2. Chiama `memoria_cerca` del server MCP `bottega-memoria` con l\'argomento del compito e `progetto` uguale al nome',
		'   della cartella del progetto: cosa e\' gia\' stato fatto, cosa e\' stato deciso, cosa e\' rimasto da fare.',
		'3. Chiama `memoria_bacheca` con lo stesso `progetto`: ti dice quali sessioni Claude lavorano adesso e su quali file.',
		'   Quei file non si toccano senza chiedere.',
		'',
		'## Durante e alla fine',
		'',
		'- Una decisione da tenere (una scelta, una causa trovata, una cosa da non rifare) salvala con `memoria_ricorda`,',
		'  sempre con `progetto`.',
		'- I server MCP sono gli stessi di Claude Code. Quelli che mandano messaggi o mail, pubblicano o cancellano si usano',
		'  solo se Andrea lo chiede in modo esplicito in questo compito.',
		...(globali ? ['', '## Le regole globali di Andrea (copia di ~/.claude/CLAUDE.md)', '', globali] : []),
		'',
	].join('\n');
}

/** Lo stato della barra di destra con Cline come ultima voce. Funzione chiusa in se' stessa: il processo che la
 *  applica a Bottega chiusa ne riceve il sorgente (Function.toString), quindi niente riferimenti esterni.
 *  `customizations` e' il valore di `views.customizations`, `pinned` quello di `workbench.auxiliarybar.pinnedPanels`. */
export function spostaInBarra(customizations: any, pinned: any, contenitore: string, posizione: number): { customizations: any; pinned: any[] } {
	const vc = customizations && typeof customizations === 'object' ? { ...customizations } : {};
	vc.viewContainerLocations = { ...(vc.viewContainerLocations ?? {}), [contenitore]: posizione };
	vc.viewLocations = vc.viewLocations ?? {};
	vc.viewContainerBadgeEnablementStates = vc.viewContainerBadgeEnablementStates ?? {};
	const lista = (Array.isArray(pinned) ? pinned : []).filter((p: any) => p && p.id !== contenitore);
	const max = lista.reduce((m: number, p: any) => Math.max(m, typeof p.order === 'number' ? p.order : 0), 0);
	lista.push({ id: contenitore, pinned: true, visible: true, order: max + 1 });
	return { customizations: vc, pinned: lista };
}

/** Il programma che aspetta la chiusura della Bottega e poi scrive lo stato della barra nel database di VS Code. Va
 *  fatto a Bottega chiusa: a Bottega aperta VS Code tiene lo stato in memoria e alla chiusura lo riscriverebbe sopra.
 *  Parametri da env: BOTTEGA_PID (processo principale), BOTTEGA_DB (state.vscdb), BOTTEGA_FATTO (file segnale),
 *  BOTTEGA_LOG. */
export function programmaSpostamento(): string {
	return `
const { execFileSync } = require('child_process');
const fs = require('fs');
const sposta = ${spostaInBarra.toString()};
const pid = Number(process.env.BOTTEGA_PID), db = process.env.BOTTEGA_DB;
const log = m => { try { fs.appendFileSync(process.env.BOTTEGA_LOG, new Date().toISOString() + ' ' + m + '\\n'); } catch {} };
const vivo = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sql = s => execFileSync('/usr/bin/sqlite3', [db, s], { encoding: 'utf8' }).trim();
const leggi = k => { try { return JSON.parse(sql("select value from ItemTable where key='" + k + "'") || 'null'); } catch { return null; } };
const scrivi = (k, v) => sql("insert or replace into ItemTable(key, value) values('" + k + "', '" + JSON.stringify(v).replace(/'/g, "''") + "')");
function applica() {
	try {
		const r = sposta(leggi('views.customizations'), leggi('workbench.auxiliarybar.pinnedPanels'), ${JSON.stringify(CLINE_CONTENITORE)}, ${BARRA_DESTRA});
		scrivi('views.customizations', r.customizations);
		scrivi('workbench.auxiliarybar.pinnedPanels', r.pinned);
		fs.writeFileSync(process.env.BOTTEGA_FATTO, new Date().toISOString() + '\\n');
		log('Cline e\\' nella barra di destra, dopo le altre voci');
	} catch (e) { log('Cline non spostato: ' + (e && e.message)); }
}
log('aspetto la chiusura della Bottega (processo ' + pid + ')');
const t = setInterval(() => { if (!vivo()) { clearInterval(t); setTimeout(applica, 1000); } }, 1000);
`;
}
