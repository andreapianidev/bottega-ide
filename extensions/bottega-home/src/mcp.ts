/* Client MCP stdio minimo, per interrogare direttamente i server locali di Claude Code (mail-mcp, asc-mcp...):
   istantaneo e gratis, senza passare da `claude -p`.

   Protocollo: JSON-RPC 2.0, un messaggio per riga su stdin e stdout. `initialize`, poi la notifica
   `notifications/initialized`, poi `tools/list` e `tools/call`. Il server parte con `nice`, con il suo comando,
   i suoi argomenti e il suo env presi da ~/.claude.json (connettori.ts, avvioServer), e si chiude a fine lavoro.

   Sicurezza: `chiama` rifiuta qualsiasi strumento che non sia di sola lettura (soloLettura), prima ancora di
   avviare il processo. L'env del server non finisce mai nei log: nei messaggi d'errore solo il nome del server. */

import { ChildProcess, spawn } from 'child_process';
import { AvvioServer, pathEsteso, soloLettura, trovaComando } from './connettori';

export interface StrumentoMcp {
	name: string;
	description?: string;
	inputSchema?: any;
	/** Suggerimenti del server: readOnlyHint vero allarga soloLettura (le parole che scrivono vincono comunque). */
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown };
}

export interface RisultatoMcp {
	isError?: boolean;
	content?: { type: string; text?: string }[];
	structuredContent?: any;
}

/** Il testo di un risultato di tools/call, interpretato come JSON se lo e'. */
export function testoRisultato(r: RisultatoMcp | undefined): { testo: string; json?: any; errore?: string } {
	const testo = (r?.content ?? []).filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
	if (r?.isError) return { testo, errore: testo.replace(/^Error:\s*/i, '').slice(0, 300) || 'errore del server' };
	if (r?.structuredContent !== undefined) return { testo, json: r.structuredContent };
	try {
		return { testo, json: JSON.parse(testo) };
	} catch {
		return { testo };
	}
}

export class ClientMcp {
	private p?: ChildProcess;
	private buf = '';
	private seq = 0;
	private attese = new Map<number, { ok: (v: any) => void; ko: (e: Error) => void; t: NodeJS.Timeout }>();
	private pronto?: Promise<void>;
	/** Le annotazioni di tools/list, per nome: chiama le passa a soloLettura quando le conosce. */
	private annotazioni = new Map<string, StrumentoMcp['annotations']>();

	constructor(
		private readonly nome: string,
		private readonly avvio: AvvioServer,
		private readonly timeoutMs = 120_000,
	) {}

	private avvia(): Promise<void> {
		if (this.pronto) return this.pronto;
		this.pronto = new Promise<void>((resolve, reject) => {
			const cmd = trovaComando(this.avvio.command);
			const p = spawn('nice', ['-n', '10', cmd, ...this.avvio.args], {
				cwd: this.avvio.cwd,
				env: { ...process.env, PATH: pathEsteso(), ...this.avvio.env },
				stdio: ['pipe', 'pipe', 'ignore'],
			});
			this.p = p;
			p.on('error', e => {
				this.chiudiTutto(new Error(`${this.nome} non parte: ${e.message}`));
				reject(new Error(`${this.nome} non parte: ${e.message}`));
			});
			p.on('exit', code => this.chiudiTutto(new Error(`${this.nome} si e' chiuso (${code ?? 'segnale'})`)));
			p.stdout!.setEncoding('utf8');
			p.stdout!.on('data', (c: string) => this.ricevi(c));
			this.richiesta('initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'bottega', version: '1' },
			})
				.then(() => {
					this.notifica('notifications/initialized');
					resolve();
				})
				.catch(reject);
		});
		return this.pronto;
	}

	private ricevi(chunk: string): void {
		this.buf += chunk;
		let i: number;
		while ((i = this.buf.indexOf('\n')) >= 0) {
			const line = this.buf.slice(0, i).trim();
			this.buf = this.buf.slice(i + 1);
			if (!line) continue;
			let m: any;
			try {
				m = JSON.parse(line);
			} catch {
				continue; // righe di log del server
			}
			if (m && m.method && m.id !== undefined) {
				// richiesta dal server (ping, roots/list...): si risponde il minimo
				const result = m.method === 'ping' ? {} : m.method === 'roots/list' ? { roots: [] } : undefined;
				this.scrivi(result ? { jsonrpc: '2.0', id: m.id, result } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'non supportato' } });
				continue;
			}
			const a = m && typeof m.id === 'number' ? this.attese.get(m.id) : undefined;
			if (!a) continue;
			this.attese.delete(m.id);
			clearTimeout(a.t);
			if (m.error) a.ko(new Error(String(m.error.message ?? 'errore').slice(0, 300)));
			else a.ok(m.result);
		}
	}

	private scrivi(o: unknown): void {
		this.p?.stdin?.write(JSON.stringify(o) + '\n');
	}

	private notifica(method: string, params?: unknown): void {
		this.scrivi({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
	}

	private richiesta(method: string, params?: unknown): Promise<any> {
		const id = ++this.seq;
		return new Promise((ok, ko) => {
			const t = setTimeout(() => {
				this.attese.delete(id);
				ko(new Error(`${this.nome}: nessuna risposta a ${method}`));
			}, this.timeoutMs);
			this.attese.set(id, { ok, ko, t });
			this.scrivi({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
		});
	}

	private chiudiTutto(e: Error): void {
		for (const a of this.attese.values()) {
			clearTimeout(a.t);
			a.ko(e);
		}
		this.attese.clear();
	}

	async strumenti(): Promise<StrumentoMcp[]> {
		await this.avvia();
		const r = await this.richiesta('tools/list', {});
		const tools: StrumentoMcp[] = Array.isArray(r?.tools) ? r.tools : [];
		for (const t of tools) if (t && typeof t.name === 'string' && t.annotations && typeof t.annotations === 'object') this.annotazioni.set(t.name, t.annotations);
		return tools;
	}

	/** Chiama uno strumento, solo se e' di sola lettura: per nome, per le annotazioni viste in tools/list o per
	 *  il permesso a mano sul server (soloLettura). */
	async chiama(nome: string, args: Record<string, unknown> = {}): Promise<RisultatoMcp> {
		if (!soloLettura(nome, this.annotazioni.get(nome), this.nome)) throw new Error(`${nome} non e' di sola lettura: la Bottega non lo usa`);
		await this.avvia();
		return this.richiesta('tools/call', { name: nome, arguments: args });
	}

	chiudi(): void {
		this.chiudiTutto(new Error('chiuso'));
		try {
			this.p?.stdin?.end();
			this.p?.kill('SIGTERM');
		} catch {
			// gia' chiuso
		}
		this.p = undefined;
		this.pronto = undefined;
	}
}

/** Apre un server, fa il lavoro e lo chiude sempre. */
export async function conServer<T>(nome: string, avvio: AvvioServer, fn: (c: ClientMcp) => Promise<T>, timeoutMs?: number): Promise<T> {
	const c = new ClientMcp(nome, avvio, timeoutMs);
	try {
		return await fn(c);
	} finally {
		c.chiudi();
	}
}
