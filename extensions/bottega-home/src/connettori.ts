/* I connettori: la Bottega non tiene chiavi di Gmail, Vercel e simili. Usa quelli che l'utente ha gia'
   configurato nel proprio Claude Code, di due tipi:

   - connettori di claude.ai (Gmail, Google Calendar, Vercel...): le credenziali le tiene Claude, quindi si usano
     solo delegando a `claude -p` (delega.ts), lento e a pagamento;
   - server MCP locali (~/.claude.json, chiave mcpServers): la Bottega li interroga da sola come client MCP stdio
     (mcp.ts), istantaneo e gratis, e solo con strumenti di sola lettura.

   Qui: lettura di `claude mcp list` (lento: si lancia in background, al massimo una volta al giorno, con cache in
   globalStorage), lettura della configurazione locale (solo nomi e forma: i valori `env` non escono mai da qui),
   mappa sulle capacita' e filtro degli strumenti di sola lettura. Niente vscode in questo file.
   Contratto: docs/CONTRATTI.md, sezione 5. */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CAPACITA, MAPPA_BASE } from './connettori-mappa';

export type StatoConnettore = 'connesso' | 'da autenticare' | 'non configurato' | 'errore' | 'sconosciuto';
export type TipoConnettore = 'claude.ai' | 'plugin' | 'locale' | 'remoto';

export interface Connettore {
	/** Il nome come lo scrive Claude Code ("claude.ai Gmail", "mail-mcp"). */
	nome: string;
	/** Minuscolo, senza "claude.ai " e "plugin:<nome>:": la chiave della mappa. */
	pulito: string;
	tipo: TipoConnettore;
	stato: StatoConnettore;
	/** Prefisso dei suoi strumenti in Claude Code: mcp__claude_ai_Gmail__ */
	prefisso: string;
	capacita: string[];
	/** Server locale stdio: la Bottega lo interroga direttamente, senza Claude. */
	diretto: boolean;
	ambito: 'claude.ai' | 'utente' | 'progetto' | 'plugin';
	/** Per i server configurati solo in alcuni progetti. */
	progetti?: string[];
	/** Una nota sullo stato, per esempio quando e' scaduto solo il controllo degli strumenti. */
	avviso?: string;
	/** Per i server remoti: schema e host dell'indirizzo ("https://gmailmcp.googleapis.com"), mai percorso o query,
	 *  che possono contenere chiavi. Serve alla delega per caricare solo quel server. */
	origine?: string;
}

export interface StatoCapacita {
	id: string;
	nome: string;
	cosa: string;
	accesa: boolean;
	/** Nomi dei connettori che la accendono, prima i diretti. */
	fonti: string[];
}

export interface ConnettoriStato {
	/** Ultima lettura di `claude mcp list` (0 = mai). */
	aggiornatoAt: number;
	aggiornando: boolean;
	errore?: string;
	connettori: Connettore[];
	capacita: StatoCapacita[];
}

export const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const GIORNO = 24 * 3_600_000;

// ---------- percorsi dei comandi ----------

/** PATH della Bottega aperta dal Finder: quello di sistema e' corto, mancano Homebrew e ~/.local/bin. */
export function pathEsteso(base = process.env.PATH ?? ''): string {
	const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), '/usr/bin', '/bin'];
	const parts = base.split(':').filter(Boolean);
	for (const e of extra) if (!parts.includes(e)) parts.push(e);
	return parts.join(':');
}

/** Il percorso assoluto di un comando, cercato nel PATH esteso. Se non lo trova, il nome com'e'. */
export function trovaComando(cmd: string, extra: string[] = []): string {
	if (!cmd || cmd.includes('/')) return cmd;
	const dirs = [...pathEsteso().split(':'), ...extra];
	for (const d of dirs) {
		const p = path.join(d, cmd);
		try {
			fs.accessSync(p, fs.constants.X_OK);
			return p;
		} catch {
			// avanti
		}
	}
	return cmd;
}

export function trovaClaude(setting = 'claude'): string {
	const first = (setting || 'claude').trim().split(/\s+/)[0];
	return trovaComando(first, [path.join(os.homedir(), '.claude', 'local')]);
}

// ---------- nomi e mappa ----------

export function nomePulito(nome: string): string {
	return nome
		.trim()
		.toLowerCase()
		.replace(/^claude\.ai\s+/, '')
		.replace(/^plugin:[^:]+:/, '')
		.trim();
}

/** Claude Code chiama gli strumenti mcp__<server>__<tool>, con i caratteri fuori da [A-Za-z0-9_-] sostituiti da _. */
export function prefissoStrumenti(nome: string): string {
	return `mcp__${nome.replace(/[^A-Za-z0-9_-]/g, '_')}__`;
}

/** La mappa base piu' quella dell'impostazione (le voci si aggiungono, non sostituiscono). */
export function unisciMappa(extra?: unknown): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [k, v] of Object.entries(MAPPA_BASE)) out[k] = [...v];
	if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
		for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
			const id = String(k).trim().toLowerCase();
			if (!id) continue;
			const list = (Array.isArray(v) ? v : [v]).map(x => String(x ?? '').trim()).filter(Boolean);
			out[id] = [...(out[id] ?? []), ...list];
		}
	}
	return out;
}

function corrisponde(pulito: string, voce: string): boolean {
	const m = /^\/(.+)\/([a-z]*)$/.exec(voce);
	if (m) {
		try {
			return new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i').test(pulito);
		} catch {
			return false;
		}
	}
	return pulito === voce.toLowerCase();
}

export function capacitaDi(pulito: string, mappa: Record<string, string[]> = MAPPA_BASE): string[] {
	return Object.entries(mappa)
		.filter(([, voci]) => voci.some(v => corrisponde(pulito, v)))
		.map(([id]) => id);
}

// ---------- strumenti di sola lettura ----------

/** Verbi e nomi di lettura. Possono stare in qualunque posizione: asc-mcp e google-play mettono l'oggetto prima
 *  del verbo (apps_list, reviews_list, builds_get_processing_state). */
const LEGGE = new Set([
	'search', 'list', 'get', 'read', 'query', 'fetch', 'find', 'count', 'check', 'inspect', 'analyze', 'analyse',
	'analysis', 'compare', 'comparison', 'explore', 'trend', 'trends', 'stats', 'report', 'summary', 'overview',
	'breakdown', 'status',
]);
/** Parole che scrivono, inviano, cancellano o spendono: vincono sempre, anche su readOnlyHint e sui permessi. */
const SCRIVE = new Set([
	'send', 'reply', 'forward', 'delete', 'remove', 'trash', 'untrash', 'move', 'set', 'update', 'create', 'write',
	'upload', 'save', 'add', 'edit', 'patch', 'put', 'post', 'submit', 'release', 'cancel', 'buy', 'purchase',
	'invite', 'revoke', 'share', 'copy', 'run', 'execute', 'start', 'stop', 'rollback', 'promote', 'pause',
	'unpause', 'label', 'unlabel', 'mark', 'unmark', 'apply', 'draft', 'respond', 'accept', 'approve', 'deploy',
	'sign', 'issue', 'assign', 'merge', 'transfer', 'change', 'rerequest', 'invalidate', 'restore', 'record',
	'kill', 'exchange', 'join', 'replace', 'attach', 'generate', 'duplicate', 'token', 'secret', 'decrypt',
	// con il verbo di lettura in qualunque posizione servono piu' parole che scrivono da escludere
	'switch', 'refresh', 'register', 'enable', 'disable', 'activate', 'deactivate', 'commit', 'reorder', 'rollout',
	'rebrand', 'redeliver', 'ping', 'clear', 'triage', 'install', 'uninstall', 'reset', 'resolve', 'authorize',
	'authenticate', 'login', 'logout', 'lock', 'unlock', 'close', 'extend', 'increment', 'decrement', 'overwrite',
	'reindex', 'rebuild', 'fork', 'clone', 'mint', 'withdraw', 'pin', 'unpin', 'star', 'unstar', 'mute', 'unmute',
	'download', 'export', 'import', 'compute', 'compile', 'transcribe', 'publish', 'unpublish', 'schedule',
	'archive', 'unarchive', 'purge', 'destroy', 'erase', 'wipe', 'grant', 'block', 'unblock', 'ban',
	'subscribe', 'unsubscribe', 'follow', 'unfollow', 'like', 'react', 'comment', 'connect', 'disconnect', 'sync',
	'push', 'pull', 'notify', 'trigger', 'dispatch', 'launch', 'rename', 'toggle', 'reject', 'decline', 'confirm',
	'complete', 'rotate', 'renew', 'revert', 'insert', 'append', 'upsert', 'modify', 'store', 'pay', 'charge',
	'refund', 'password', 'credential', 'credentials',
]);

/** Le parole del nome breve di uno strumento: "search_threads" -> [search, threads], "getThread" -> [get, thread]. */
export function paroleStrumento(nome: string): string[] {
	const breve = nome.includes('__') ? nome.slice(nome.lastIndexOf('__') + 2) : nome;
	return breve
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[\s_\-.]+/)
		.map(w => w.toLowerCase())
		.filter(Boolean);
}

/** Strumenti permessi a mano per server (bottega.connettori.letturaPermessa), per i server di sola analisi i cui
 *  nomi non hanno un verbo (admob: top_apps, wow_revenue). Chiave: nome del server, esatto o /regex/; valori: nomi
 *  brevi degli strumenti, esatti o /regex/. SCRIVE vince comunque. Il default e' quello del package.json. */
export const LETTURA_PERMESSA_BASE: Record<string, string[]> = { admob: ['/.*/'], searchconsole: ['/.*/'], 'keyword-suggest': ['/.*/'] };
let letturaPermessa: Record<string, string[]> = LETTURA_PERMESSA_BASE;

export function impostaLetturaPermessa(v: unknown): void {
	const out: Record<string, string[]> = {};
	if (v && typeof v === 'object' && !Array.isArray(v)) {
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
			const l = (Array.isArray(x) ? x : [x]).map(y => String(y ?? '').trim()).filter(Boolean);
			if (k.trim() && l.length) out[k.trim().toLowerCase()] = l;
		}
	}
	letturaPermessa = out;
}

/** Il server di un nome completo: "mcp__admob__top_apps" -> "admob", "mcp__claude_ai_Gmail__x" -> "gmail". */
function serverDiNome(nome: string): string {
	const i = nome.lastIndexOf('__');
	if (!nome.startsWith('mcp__') || i <= 5) return '';
	return nome.slice(5, i).replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '').replace(/_/g, ' ').toLowerCase();
}

function permesso(server: string, breve: string): boolean {
	if (!server) return false;
	const srv = nomePulito(server);
	for (const [k, voci] of Object.entries(letturaPermessa)) {
		if (!corrisponde(srv, k) && !corrisponde(srv.replace(/\s+/g, '_'), k)) continue;
		if (voci.some(v => corrisponde(breve.toLowerCase(), v))) return true;
	}
	return false;
}

/** Letture che restano fuori comunque: codici promozionali riscattabili, certificati, firme dei webhook. Non scrivono,
 *  ma il loro contenuto finirebbe nel contesto di Melissa e del suo cervello. */
const SENSIBILI = /one_time_code_values|certificate|verify_signature|parse_payload|secret|credential|password/i;

/** Vero solo per gli strumenti che leggono e non contengono parole che scrivono, inviano o cancellano
 *  (get_or_create, list_and_delete, auth_generate_token restano fuori, readOnlyHint o no). Legge chi ha un verbo
 *  di lettura in qualunque posizione, oppure `readOnlyHint: true` nelle annotazioni di tools/list, oppure il
 *  permesso a mano per il suo server (`server`, o il prefisso mcp__<server>__ del nome). */
export function soloLettura(nome: string, annotazioni?: { readOnlyHint?: boolean } | null, server?: string): boolean {
	const w = paroleStrumento(nome);
	if (!w.length || w.some(x => SCRIVE.has(x)) || SENSIBILI.test(nome)) return false;
	if (w.some(x => LEGGE.has(x))) return true;
	if (annotazioni?.readOnlyHint === true) return true;
	const breve = nome.includes('__') ? nome.slice(nome.lastIndexOf('__') + 2) : nome;
	return permesso(server ?? serverDiNome(nome), breve);
}

// ---------- `claude mcp list` ----------

/** Lo stato dalla coda della riga. "Connected" vince su "fail" e "timed out": la riga
 *  "! Connected · tools fetch failed, Request timed out" e' un server collegato il cui controllo degli strumenti e'
 *  scaduto, non un server rotto. "Disconnected" e "Failed to connect" restano errori. */
export function statoDa(testo: string): { stato: StatoConnettore; avviso?: string } {
	const t = testo.toLowerCase();
	if (/needs? auth/.test(t)) return { stato: 'da autenticare' };
	if (/not configured/.test(t)) return { stato: 'non configurato' };
	if (/(^|[^a-z])connected/.test(t)) {
		if (/timed? ?out/.test(t)) return { stato: 'connesso', avviso: 'collegato, il controllo degli strumenti è scaduto' };
		if (/fail|error/.test(t)) return { stato: 'connesso', avviso: 'collegato, il controllo degli strumenti non è riuscito' };
		return { stato: 'connesso' };
	}
	if (/fail|error|disconnect|timed? ?out/.test(t)) return { stato: 'errore' };
	return { stato: 'sconosciuto' };
}

/** Schema e host di un indirizzo, senza percorso ne' query. */
export function origineDi(dest: string): string | undefined {
	const m = /\b(https?):\/\/([a-z0-9.-]+(?::\d+)?)/i.exec(String(dest ?? ''));
	return m ? `${m[1].toLowerCase()}://${m[2].toLowerCase()}` : undefined;
}

/** Interpreta l'uscita di `claude mcp list`: una riga per server, "<nome>: <destinazione> - <icona> <stato>".
 *  Il nome puo' contenere spazi e due punti senza spazio ("plugin:design:gmail"). */
export function parseMcpList(text: string, mappa: Record<string, string[]> = MAPPA_BASE): Connettore[] {
	const out: Connettore[] = [];
	const seen = new Set<string>();
	for (const raw of String(text ?? '').split('\n')) {
		const line = raw.replace(/\r$/, '').trim();
		const colon = line.indexOf(': ');
		const dash = line.lastIndexOf(' - ');
		if (colon <= 0 || dash < colon) continue;
		const nome = line.slice(0, colon).trim();
		if (!nome || /^checking/i.test(nome) || seen.has(nome)) continue;
		const dest = line.slice(colon + 2, dash);
		const { stato, avviso } = statoDa(line.slice(dash + 3));
		const origine = origineDi(dest);
		const tipo: TipoConnettore = /^claude\.ai\s/i.test(nome) ? 'claude.ai' : /^plugin:/i.test(nome) ? 'plugin' : /\((HTTP|SSE)\)/i.test(dest) || /^\s*https?:\/\//i.test(dest) ? 'remoto' : 'locale';
		const pulito = nomePulito(nome);
		seen.add(nome);
		out.push({
			nome,
			pulito,
			tipo,
			stato,
			prefisso: prefissoStrumenti(nome),
			capacita: capacitaDi(pulito, mappa),
			diretto: tipo === 'locale',
			ambito: tipo === 'claude.ai' ? 'claude.ai' : tipo === 'plugin' ? 'plugin' : 'utente',
			...(avviso ? { avviso } : {}),
			...(origine && tipo !== 'locale' ? { origine } : {}),
		});
	}
	return out;
}

// ---------- configurazione locale (~/.claude.json) ----------

export interface ServerLocale {
	nome: string;
	trasporto: 'stdio' | 'http' | 'sse';
	ambito: 'utente' | 'progetto';
	progetti: string[];
}

/** Solo i nomi e la forma dei server: comandi, argomenti ed env restano nel file. */
export function serverLocali(claudeJson: any): ServerLocale[] {
	const byName = new Map<string, ServerLocale>();
	const add = (nome: string, s: any, progetto?: string) => {
		if (!nome || !s || typeof s !== 'object') return;
		const trasporto = s.type === 'http' || s.type === 'sse' ? s.type : s.url ? 'http' : 'stdio';
		const key = `${nome}|${trasporto}|${progetto ? 'p' : 'u'}`;
		const cur = byName.get(key);
		if (cur) {
			if (progetto && !cur.progetti.includes(progetto)) cur.progetti.push(progetto);
			return;
		}
		byName.set(key, { nome, trasporto, ambito: progetto ? 'progetto' : 'utente', progetti: progetto ? [progetto] : [] });
	};
	for (const [n, s] of Object.entries(claudeJson?.mcpServers ?? {})) add(n, s);
	for (const [p, pv] of Object.entries<any>(claudeJson?.projects ?? {})) {
		for (const [n, s] of Object.entries(pv?.mcpServers ?? {})) add(n, s, p);
	}
	// un server di progetto con lo stesso nome di uno utente e' lo stesso per la Bottega
	return [...byName.values()].filter(s => s.ambito === 'utente' || ![...byName.values()].some(u => u.ambito === 'utente' && u.nome === s.nome));
}

export interface AvvioServer {
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
}

/** Come si avvia un server locale stdio. Resta in memoria: non va mai scritto in cache, log o messaggi. */
export function avvioServer(nome: string, file = CLAUDE_JSON, progetto?: string): AvvioServer | undefined {
	let d: any;
	try {
		d = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
	const s = d?.mcpServers?.[nome] ?? (progetto ? d?.projects?.[progetto]?.mcpServers?.[nome] : undefined);
	if (!s || typeof s.command !== 'string' || s.type === 'http' || s.type === 'sse' || s.url) return undefined;
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(s.env ?? {})) env[k] = String(v);
	return { command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], env, ...(progetto ? { cwd: progetto } : {}) };
}

/** Unisce l'elenco di `claude mcp list` con i server locali: quelli che l'elenco non ha visto (di progetto, o mai
 *  controllati) entrano con stato "sconosciuto". */
export function unisci(lista: Connettore[], locali: ServerLocale[], mappa: Record<string, string[]> = MAPPA_BASE): Connettore[] {
	const out = lista.map(c => ({ ...c }));
	for (const s of locali) {
		const c = out.find(x => x.nome === s.nome && x.tipo !== 'claude.ai' && x.tipo !== 'plugin');
		if (c) {
			c.diretto = s.trasporto === 'stdio';
			if (s.ambito === 'progetto') {
				c.ambito = 'progetto';
				c.progetti = s.progetti;
			}
			continue;
		}
		const pulito = nomePulito(s.nome);
		out.push({
			nome: s.nome,
			pulito,
			tipo: s.trasporto === 'stdio' ? 'locale' : 'remoto',
			stato: 'sconosciuto',
			prefisso: prefissoStrumenti(s.nome),
			capacita: capacitaDi(pulito, mappa),
			diretto: s.trasporto === 'stdio',
			ambito: s.ambito,
			...(s.ambito === 'progetto' ? { progetti: s.progetti } : {}),
		});
	}
	return out;
}

/** Utilizzabile: connesso, oppure locale diretto non ancora controllato (la configurazione c'e'). */
export const utilizzabile = (c: Connettore) => c.stato === 'connesso' || (c.diretto && c.stato === 'sconosciuto' && c.ambito === 'utente');

export function statoCapacita(connettori: Connettore[]): StatoCapacita[] {
	return CAPACITA.map(k => {
		const fonti = connettori
			.filter(c => c.capacita.includes(k.id) && utilizzabile(c))
			.sort((a, b) => Number(b.diretto) - Number(a.diretto))
			.map(c => c.nome);
		return { id: k.id, nome: k.nome, cosa: k.cosa, accesa: fonti.length > 0, fonti };
	});
}

// ---------- la scoperta, con cache ----------

interface Cache {
	at: number;
	testo: string;
}

export interface ScopertaOpts {
	/** File di cache (in globalStorage). */
	cacheFile: string;
	claudeJson?: string;
	claudeCommand: () => string;
	mappa: () => Record<string, string[]>;
	onChange: () => void;
	log: (s: string) => void;
	/** Per i test: sostituisce l'esecuzione di `claude mcp list`. */
	esegui?: () => Promise<string>;
}

export class ScopertaConnettori {
	private cache: Cache = { at: 0, testo: '' };
	private locali: ServerLocale[] = [];
	private corsa?: Promise<void>;
	private errore?: string;

	constructor(private readonly o: ScopertaOpts) {
		try {
			const c = JSON.parse(fs.readFileSync(o.cacheFile, 'utf8'));
			if (c && typeof c.testo === 'string') this.cache = { at: Number(c.at) || 0, testo: c.testo };
		} catch {
			// prima volta
		}
		this.leggiLocali();
	}

	private leggiLocali(): void {
		fs.readFile(this.o.claudeJson ?? CLAUDE_JSON, 'utf8', (err, txt) => {
			if (err) return;
			try {
				this.locali = serverLocali(JSON.parse(txt));
				this.o.onChange();
			} catch {
				this.o.log('connettori: ~/.claude.json non si legge');
			}
		});
	}

	stato(): ConnettoriStato {
		const mappa = this.o.mappa();
		const connettori = unisci(parseMcpList(this.cache.testo, mappa), this.locali, mappa);
		return {
			aggiornatoAt: this.cache.at,
			aggiornando: !!this.corsa,
			...(this.errore ? { errore: this.errore } : {}),
			connettori,
			capacita: statoCapacita(connettori),
		};
	}

	/** Lancia `claude mcp list` in background. Senza `force`, solo se l'ultima lettura ha piu' di un giorno. */
	aggiorna(force = false): Promise<void> {
		if (this.corsa) return this.corsa;
		if (!force && this.cache.at && Date.now() - this.cache.at < GIORNO) return Promise.resolve();
		this.corsa = (async () => {
			this.o.onChange();
			try {
				const testo = await (this.o.esegui ? this.o.esegui() : this.eseguiMcpList());
				this.cache = { at: Date.now(), testo };
				this.errore = undefined;
				fs.mkdirSync(path.dirname(this.o.cacheFile), { recursive: true });
				fs.writeFileSync(this.o.cacheFile, JSON.stringify(this.cache), { mode: 0o600 });
			} catch (e: any) {
				this.errore = `Non riesco a leggere i connettori di Claude Code: ${e?.message ?? e}`;
				this.o.log(`connettori: ${this.errore}`);
			}
			this.leggiLocali();
		})().finally(() => {
			this.corsa = undefined;
			this.o.onChange();
		});
		return this.corsa;
	}

	private eseguiMcpList(): Promise<string> {
		return new Promise((resolve, reject) => {
			const claude = trovaClaude(this.o.claudeCommand());
			// dalla home: i server di progetto si leggono da ~/.claude.json, qui servono quelli utente e claude.ai
			const p = spawn('nice', ['-n', '10', claude, 'mcp', 'list'], {
				cwd: os.homedir(),
				env: { ...process.env, PATH: pathEsteso() },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let out = '';
			let err = '';
			const t = setTimeout(() => {
				p.kill('SIGTERM');
				reject(new Error('nessuna risposta in 2 minuti'));
			}, 120_000);
			p.stdout.on('data', c => (out += c));
			p.stderr.on('data', c => (err += c));
			p.on('error', e => {
				clearTimeout(t);
				reject(e);
			});
			p.on('close', code => {
				clearTimeout(t);
				if (code === 0 || out.includes(' - ')) resolve(out);
				else reject(new Error(err.split('\n')[0] || `uscito con ${code}`));
			});
		});
	}
}
