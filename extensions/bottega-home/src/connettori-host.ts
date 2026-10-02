/* La stanza Connettori dentro l'estensione: tiene insieme la scoperta (connettori.ts), le deleghe (delega.ts),
   il client MCP diretto (mcp.ts) e la posta per progetto (posta.ts), e risponde ai messaggi della plancia.
   extension.ts la crea e le passa i messaggi che non sono suoi: un solo aggancio.
   Contratto: docs/CONTRATTI.md, sezione 5. */

import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { avvioServer, Connettore, ConnettoriStato, ScopertaConnettori, unisciMappa, utilizzabile } from './connettori';
import { CodaDeleghe, StatoDeleghe } from './delega';
import { conServer, testoRisultato } from './mcp';
import { aggiungiVoce, Filo, MotorePosta, mittentiDaAssegnare, assegna, suggerisciDomini, togliVoce, VoceRubrica, FonteStato } from './posta';

export interface ConnettoriHost {
	projects(): { path: string; name: string }[];
	send(msg: unknown): void;
	showHome(view?: string): void;
	log(s: string): void;
}

export interface PostaStato {
	aggiornatoAt: number;
	aggiornando: 'locale' | 'gmail' | null;
	errore?: string;
	giorni: number;
	fonti: { locale?: FonteStato; gmail?: FonteStato };
	/** Cosa si puo' interrogare adesso. */
	disponibili: { locale: string | null; gmail: boolean };
	deleghe: StatoDeleghe;
	progetti: { path: string; name: string; voce: VoceRubrica; fili: Filo[]; nonLetti: number }[];
	daAssegnare: ReturnType<typeof mittentiDaAssegnare>;
	suggerimenti: { path: string; name: string; domini: string[] }[];
	/** Tutti i progetti, per le tendine (la stanza non legge lo snapshot). */
	tuttiProgetti: { path: string; name: string }[];
}

const cfg = () => vscode.workspace.getConfiguration('bottega');

let stanza: StanzaConnettori | undefined;

/** L'unico aggancio in extension.ts, all'attivazione. */
export function registerConnettori(ctx: vscode.ExtensionContext, h: ConnettoriHost): StanzaConnettori {
	stanza = new StanzaConnettori(ctx, h);
	ctx.subscriptions.push({ dispose: () => (stanza = undefined) });
	return stanza;
}

/** Il secondo aggancio, nel ramo default dei messaggi della plancia: vero se il messaggio era dei connettori. */
export async function handleConnettori(m: unknown): Promise<boolean> {
	return stanza ? stanza.handle(m) : false;
}
const MINUTO = 60_000;

export class StanzaConnettori {
	readonly scoperta: ScopertaConnettori;
	readonly coda: CodaDeleghe;
	readonly posta: MotorePosta;
	private timers: NodeJS.Timeout[] = [];
	private suggCache?: { at: number; sig: string; v: PostaStato['suggerimenti'] };
	private lastGmailAuto = 0;
	private sendTimer?: NodeJS.Timeout;

	constructor(ctx: vscode.ExtensionContext, private readonly h: ConnettoriHost) {
		const changed = () => this.cambiato();
		this.scoperta = new ScopertaConnettori({
			cacheFile: path.join(ctx.globalStorageUri.fsPath, 'connettori-mcp-list.json'),
			claudeCommand: () => cfg().get<string>('claudeCommand', 'claude'),
			mappa: () => unisciMappa(cfg().get('connettori.mappa')),
			onChange: changed,
			log: h.log,
		});
		this.coda = new CodaDeleghe({
			claudeCommand: () => cfg().get<string>('claudeCommand', 'claude'),
			modello: () => cfg().get<string>('connettori.modello', 'haiku'),
			tetto: () => cfg().get<number>('connettori.tettoGiornalieroUsd', 1),
			onChange: changed,
			log: h.log,
		});
		this.posta = new MotorePosta({
			serverLocale: () => this.serverPostaLocale()?.nome ?? null,
			prefissoGmail: () => this.gmail()?.prefisso ?? null,
			cercaLocale: (server, args) => this.cercaLocale(server, args),
			delega: r => this.coda.accoda(r),
			giorni: () => Math.max(1, Math.min(90, cfg().get<number>('posta.giorni', 7))),
			onChange: changed,
			log: h.log,
		});

		ctx.subscriptions.push(
			{ dispose: () => this.dispose() },
			vscode.commands.registerCommand('bottega.openConnettori', () => h.showHome('connettori')),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('bottega.posta') || e.affectsConfiguration('bottega.connettori')) {
					this.programma();
					this.cambiato();
				}
			}),
		);
		// `claude mcp list` e' lento: si guarda un minuto dopo l'avvio, e solo se la cache ha piu' di un giorno
		this.timers.push(setTimeout(() => void this.scoperta.aggiorna(false), MINUTO));
		this.programma();
	}

	private auto?: NodeJS.Timeout;

	/** Aggiornamento automatico della posta: locale ogni N minuti; Gmail (a pagamento) al massimo ogni due ore. */
	private programma(): void {
		if (this.auto) clearInterval(this.auto);
		this.auto = undefined;
		const n = Number(cfg().get<number>('posta.aggiornaOgniMinuti', 0)) || 0;
		if (n <= 0) return;
		this.auto = setInterval(() => {
			void this.posta.aggiornaLocale().then(() => {
				const g = Number(cfg().get<number>('posta.gmailOgniMinuti', 0)) || 0;
				if (g > 0 && Date.now() - this.lastGmailAuto >= Math.max(120, g) * MINUTO) {
					this.lastGmailAuto = Date.now();
					void this.posta.aggiornaGmail();
				}
			});
		}, Math.max(5, n) * MINUTO);
	}

	dispose(): void {
		for (const t of this.timers) clearTimeout(t);
		if (this.auto) clearInterval(this.auto);
		clearTimeout(this.sendTimer);
	}

	// ---------- scelte delle fonti ----------

	private connettori(): Connettore[] {
		return this.scoperta.stato().connettori;
	}

	/** Il server di posta locale interrogabile direttamente (oggi: mail-mcp o un server con search_messages). */
	private serverPostaLocale(): Connettore | undefined {
		return this.connettori().find(c => c.diretto && c.capacita.includes('posta') && utilizzabile(c));
	}

	private gmail(): Connettore | undefined {
		return this.connettori().find(c => c.tipo === 'claude.ai' && c.pulito === 'gmail' && c.stato === 'connesso');
	}

	private async cercaLocale(server: string, args: Record<string, unknown>): Promise<any> {
		const avvio = avvioServer(server);
		if (!avvio) throw new Error('configurazione non trovata in ~/.claude.json');
		return conServer(server, avvio, async c => {
			const tools = await c.strumenti();
			if (!tools.some(t => t.name === 'search_messages')) throw new Error('non ha lo strumento search_messages');
			const r = testoRisultato(await c.chiama('search_messages', args));
			if (r.errore) throw new Error(r.errore);
			return r.json;
		});
	}

	// ---------- stati per la plancia ----------

	statoConnettori(): ConnettoriStato & { deleghe: StatoDeleghe } {
		return { ...this.scoperta.stato(), deleghe: this.coda.stato() };
	}

	private suggerimenti(rubrica: Record<string, VoceRubrica>): PostaStato['suggerimenti'] {
		const projects = this.h.projects();
		const ignorati = cfg().get<string[]>('posta.dominiIgnorati', []) ?? [];
		const sig = JSON.stringify([projects.map(p => p.path), rubrica, ignorati]);
		if (this.suggCache && this.suggCache.sig === sig && Date.now() - this.suggCache.at < 10 * MINUTO) return this.suggCache.v;
		const noti = Object.values(rubrica).flatMap(v => v.domini);
		const v = projects
			.map(p => ({ path: p.path, name: p.name, domini: suggerisciDomini(p.path, noti, ignorati) }))
			.filter(s => s.domini.length)
			.slice(0, 40);
		this.suggCache = { at: Date.now(), sig, v };
		return v;
	}

	statoPosta(): PostaStato {
		const rubrica = this.posta.rubrica();
		const { perProgetto, daAssegnare } = assegna(this.posta.fili, rubrica);
		const nomi = new Map(this.h.projects().map(p => [p.path, p.name]));
		const progetti = Object.entries(rubrica)
			.map(([p, voce]) => {
				const fili = perProgetto[p] ?? [];
				return { path: p, name: nomi.get(p) ?? path.basename(p), voce, fili: fili.slice(0, 30), nonLetti: fili.filter(f => f.nonLetto).length };
			})
			.sort((a, b) => b.nonLetti - a.nonLetti || (b.fili[0]?.data ?? '').localeCompare(a.fili[0]?.data ?? '') || a.name.localeCompare(b.name));
		return {
			aggiornatoAt: this.posta.aggiornatoAt,
			aggiornando: this.posta.aggiornando,
			...(this.posta.errore ? { errore: this.posta.errore } : {}),
			giorni: Math.max(1, Math.min(90, cfg().get<number>('posta.giorni', 7))),
			fonti: this.posta.fonti,
			disponibili: { locale: this.serverPostaLocale()?.nome ?? null, gmail: !!this.gmail() },
			deleghe: this.coda.stato(),
			progetti,
			daAssegnare: mittentiDaAssegnare(daAssegnare),
			suggerimenti: this.suggerimenti(rubrica),
			tuttiProgetti: this.h.projects().map(p => ({ path: p.path, name: p.name })),
		};
	}

	/** Manda i due stati alla plancia, raggruppando gli aggiornamenti vicini. */
	private cambiato(): void {
		clearTimeout(this.sendTimer);
		this.sendTimer = setTimeout(() => {
			this.h.send({ type: 'connettori', stato: this.statoConnettori() });
			this.h.send({ type: 'posta', stato: this.statoPosta() });
		}, 150);
	}

	// ---------- messaggi dalla plancia ----------

	/** Vero se il messaggio era della stanza Connettori. */
	async handle(m: any): Promise<boolean> {
		switch (m?.type) {
			case 'connettori.request':
				this.h.send({ type: 'connettori', stato: this.statoConnettori() });
				this.h.send({ type: 'posta', stato: this.statoPosta() });
				void this.scoperta.aggiorna(false);
				return true;
			case 'connettori.refresh':
				void this.scoperta.aggiorna(true);
				return true;
			case 'posta.refresh':
				if (m.fonte === 'gmail') void this.posta.aggiornaGmail();
				else void this.posta.aggiornaLocale();
				return true;
			case 'rubrica.add':
			case 'rubrica.remove': {
				const p = String(m.path ?? '');
				if (!this.h.projects().some(x => x.path === p)) return true;
				const r = this.posta.rubrica();
				this.posta.salvaRubrica(m.type === 'rubrica.add' ? aggiungiVoce(r, p, String(m.voce ?? '')) : togliVoce(r, p, String(m.voce ?? '')));
				this.suggCache = undefined;
				this.cambiato();
				return true;
			}
			case 'posta.apri': {
				const f = this.posta.fili.find(x => x.id === m.id);
				if (!f) return true;
				if (f.link && f.link.startsWith('https://mail.google.com/')) void vscode.env.openExternal(vscode.Uri.parse(f.link));
				else if (f.fonte === 'mail') execFile('open', ['-b', 'com.apple.mail']);
				return true;
			}
		}
		return false;
	}
}
