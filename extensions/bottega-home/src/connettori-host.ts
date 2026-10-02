/* La stanza Connettori dentro l'estensione: tiene insieme la scoperta (connettori.ts), le deleghe (delega.ts),
   il client MCP diretto (mcp.ts), la posta per progetto (posta.ts) e le chat WhatsApp (whatsapp.ts), e risponde
   ai messaggi della plancia. Agli altri moduli offre stanzaConnettori() e StanzaConnettori.serverDiretto(nome).
   extension.ts la crea e le passa i messaggi che non sono suoi: un solo aggancio.
   Contratto: docs/CONTRATTI.md, sezione 5. */

import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { AvvioServer, avvioServer, Connettore, ConnettoriStato, impostaLetturaPermessa, LETTURA_PERMESSA_BASE, ScopertaConnettori, unisciMappa, utilizzabile } from './connettori';
import { CodaDeleghe, StatoDeleghe } from './delega';
import { conServer, testoRisultato } from './mcp';
import {
	aggiungiVoce, assegna, citaProgetto, Filo, FonteStato, indiceProgetti, mittenteAutomatico, mittentiDaAssegnare, MotorePosta,
	ProgettoIndice, Proposta, proposte, togliVoce, VoceRubrica,
} from './posta';
import { assegnaChat, ChatWa, FonteWa, FonteWaStato, linkWhatsapp, MotoreWhatsapp } from './whatsapp';

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
	progetti: { path: string; name: string; voce: VoceRubrica; fili: Filo[]; nonLetti: number; chat: ChatWa[]; chatDaRispondere: number }[];
	/** Mittenti fuori rubrica, senza quelli automatici; con la proposta di progetto quando c'e' un motivo forte. */
	daAssegnare: (ReturnType<typeof mittentiDaAssegnare>[number] & { proposta?: Proposta })[];
	/** Quanti mittenti automatici (noreply, notifications...) sono stati tolti da "Da assegnare". */
	automatici: number;
	/** Suggerimenti deboli: domini che stanno nei file di un solo progetto. La stanza li tiene chiusi in fondo. */
	suggerimenti: { path: string; name: string; domini: string[] }[];
	whatsapp: WhatsappStato;
	/** Tutti i progetti, per le tendine (la stanza non legge lo snapshot). */
	tuttiProgetti: { path: string; name: string }[];
}

export interface WhatsappStato {
	aggiornatoAt: number;
	aggiornando: boolean;
	errore?: string;
	giorni: number;
	fonti: Partial<Record<FonteWa, FonteWaStato>>;
	/** I server WhatsApp interrogabili adesso. */
	disponibili: string[];
	/** Chat fuori rubrica: del numero business, e di quello personale solo con bottega.whatsapp.personaleDaAssegnare. */
	daAssegnare: (ChatWa & { proposta?: { path: string; name: string; motivo: string } })[];
}

const cfg = () => vscode.workspace.getConfiguration('bottega');

let stanza: StanzaConnettori | undefined;

/** La stanza di adesso, per gli altri moduli dell'estensione (undefined prima dell'attivazione). */
export function stanzaConnettori(): StanzaConnettori | undefined {
	return stanza;
}

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
	readonly whatsapp: MotoreWhatsapp;
	private timers: NodeJS.Timeout[] = [];
	private indiceCache?: { at: number; sig: string; v: ReturnType<typeof indiceProgetti> };
	private lastGmailAuto = 0;
	private sendTimer?: NodeJS.Timeout;

	constructor(ctx: vscode.ExtensionContext, private readonly h: ConnettoriHost) {
		const changed = () => this.cambiato();
		impostaLetturaPermessa(cfg().get('connettori.letturaPermessa', LETTURA_PERMESSA_BASE));
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
			// per caricare solo il server della delega: nome, prefisso e origine, mai comandi o env
			server: () => this.connettori().map(c => ({ nome: c.nome, prefisso: c.prefisso, tipo: c.tipo, ...(c.origine ? { origine: c.origine } : {}) })),
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
		this.whatsapp = new MotoreWhatsapp({
			server: () => this.serverWhatsapp(),
			apri: (server, fn) => {
				const d = this.serverDiretto(server);
				if (!d) return Promise.reject(new Error('configurazione non trovata in ~/.claude.json'));
				return conServer(server, d.avvio, fn, 60_000);
			},
			rubrica: () => this.posta.rubrica(),
			giorni: () => this.giorniWa(),
			personaleDaAssegnare: () => cfg().get<boolean>('whatsapp.personaleDaAssegnare', false) === true,
			onChange: changed,
			log: h.log,
		});

		ctx.subscriptions.push(
			{ dispose: () => this.dispose() },
			vscode.commands.registerCommand('bottega.openConnettori', () => h.showHome('connettori')),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('bottega.posta') || e.affectsConfiguration('bottega.connettori') || e.affectsConfiguration('bottega.whatsapp')) {
					this.indiceCache = undefined;
					impostaLetturaPermessa(cfg().get('connettori.letturaPermessa', LETTURA_PERMESSA_BASE));
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

	/** Aggiornamento automatico della posta: locale e WhatsApp ogni N minuti; Gmail (a pagamento) al massimo ogni
	 *  due ore. */
	private programma(): void {
		if (this.auto) clearInterval(this.auto);
		this.auto = undefined;
		const n = Number(cfg().get<number>('posta.aggiornaOgniMinuti', 0)) || 0;
		if (n <= 0) return;
		this.auto = setInterval(() => {
			void this.posta.aggiornaLocale().then(async () => {
				await this.whatsapp.aggiorna();
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

	/** I server WhatsApp (capacita' messaggi) interrogabili direttamente. */
	private serverWhatsapp(): string[] {
		return this.connettori()
			.filter(c => c.diretto && c.capacita.includes('messaggi') && utilizzabile(c))
			.map(c => c.nome);
	}

	private giorniWa(): number {
		return Math.max(1, Math.min(90, Number(cfg().get<number>('whatsapp.giorni', 7)) || 7));
	}

	/** Un server locale stdio utilizzabile, con il modo di avviarlo, per chi lo vuole interrogare direttamente
	 *  con ClientMcp o conServer. L'avvio contiene comando ed env: resta in memoria, mai in log, cache o messaggi. */
	serverDiretto(nome: string): { nome: string; avvio: AvvioServer } | undefined {
		const c = this.connettori().find(x => x.nome === nome && x.diretto && utilizzabile(x));
		if (!c) return undefined;
		const avvio = avvioServer(c.nome);
		return avvio ? { nome: c.nome, avvio } : undefined;
	}

	private gmail(): Connettore | undefined {
		return this.connettori().find(c => c.tipo === 'claude.ai' && c.pulito === 'gmail' && c.stato === 'connesso');
	}

	private async cercaLocale(server: string, args: Record<string, unknown>): Promise<any> {
		const avvio = this.serverDiretto(server)?.avvio ?? avvioServer(server);
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

	/** I domini dei file di ogni progetto, senza quelli condivisi da piu' progetti. Rileggere i file costa: si tiene
	 *  dieci minuti, e si rifa' se cambiano i progetti o i domini ignorati. */
	private indice(): ProgettoIndice[] {
		const projects = this.h.projects();
		const ignorati = cfg().get<string[]>('posta.dominiIgnorati', []) ?? [];
		const sig = JSON.stringify([projects.map(p => p.path), ignorati]);
		if (!this.indiceCache || this.indiceCache.sig !== sig || Date.now() - this.indiceCache.at > 10 * MINUTO) {
			this.indiceCache = { at: Date.now(), sig, v: indiceProgetti(projects, ignorati) };
		}
		return this.indiceCache.v.indice;
	}

	/** I suggerimenti deboli: domini nei file di un solo progetto, non ancora in rubrica. */
	private suggerimenti(indice: ProgettoIndice[], rubrica: Record<string, VoceRubrica>): PostaStato['suggerimenti'] {
		const noti = new Set(Object.values(rubrica).flatMap(v => v.domini));
		return indice
			.map(p => ({ path: p.path, name: p.name, domini: [...p.domini.keys()].filter(d => !noti.has(d)).slice(0, 4) }))
			.filter(s => s.domini.length)
			.slice(0, 40);
	}

	private statoWhatsapp(rubrica: Record<string, VoceRubrica>, indice: ProgettoIndice[]): { stato: WhatsappStato; perProgetto: Record<string, ChatWa[]> } {
		const personale = cfg().get<boolean>('whatsapp.personaleDaAssegnare', false) === true;
		const { perProgetto, daAssegnare } = assegnaChat(this.whatsapp.chat, rubrica, personale);
		const propostaPer = (c: ChatWa) => {
			if (c.gruppo || !c.contatto) return undefined;
			const t = indice.filter(p => citaProgetto(c.contatto, p.name));
			return t.length === 1 ? { path: t[0].path, name: t[0].name, motivo: `il nome del contatto cita ${t[0].name}` } : undefined;
		};
		return {
			perProgetto,
			stato: {
				aggiornatoAt: this.whatsapp.aggiornatoAt,
				aggiornando: this.whatsapp.aggiornando,
				...(this.whatsapp.errore ? { errore: this.whatsapp.errore } : {}),
				giorni: this.giorniWa(),
				fonti: this.whatsapp.fonti,
				disponibili: this.serverWhatsapp(),
				daAssegnare: daAssegnare.slice(0, 30).map(c => {
					const proposta = propostaPer(c);
					return proposta ? { ...c, proposta } : c;
				}),
			},
		};
	}

	statoPosta(): PostaStato {
		const rubrica = this.posta.rubrica();
		const indice = this.indice();
		const { perProgetto, daAssegnare } = assegna(this.posta.fili, rubrica);
		const wa = this.statoWhatsapp(rubrica, indice);
		const nomi = new Map(this.h.projects().map(p => [p.path, p.name]));
		const recente = (x: { fili: Filo[]; chat: ChatWa[] }) => [x.fili[0]?.data ?? '', x.chat[0]?.data ?? ''].sort().pop() ?? '';
		const progetti = Object.entries(rubrica)
			.map(([p, voce]) => {
				const fili = perProgetto[p] ?? [];
				const chat = wa.perProgetto[p] ?? [];
				return {
					path: p,
					name: nomi.get(p) ?? path.basename(p),
					voce,
					fili: fili.slice(0, 30),
					nonLetti: fili.filter(f => f.nonLetto).length,
					chat: chat.slice(0, 20),
					chatDaRispondere: chat.filter(c => !c.mio).length,
				};
			})
			.sort((a, b) => b.nonLetti - a.nonLetti || recente(b).localeCompare(recente(a)) || a.name.localeCompare(b.name));
		const umani = daAssegnare.filter(f => !mittenteAutomatico(f.indirizzo));
		const automatici = new Set(daAssegnare.filter(f => mittenteAutomatico(f.indirizzo)).map(f => f.indirizzo)).size;
		const prop = proposte(umani, indice);
		const mittenti = mittentiDaAssegnare(umani, 60)
			.map(m => (prop[m.indirizzo] ? { ...m, proposta: prop[m.indirizzo] } : m))
			// prima chi ha una proposta: e' quello che si sistema con un clic
			.sort((a, b) => Number(!!(b as any).proposta) - Number(!!(a as any).proposta))
			.slice(0, 40);
		return {
			aggiornatoAt: this.posta.aggiornatoAt,
			aggiornando: this.posta.aggiornando,
			...(this.posta.errore ? { errore: this.posta.errore } : {}),
			giorni: Math.max(1, Math.min(90, cfg().get<number>('posta.giorni', 7))),
			fonti: this.posta.fonti,
			disponibili: { locale: this.serverPostaLocale()?.nome ?? null, gmail: !!this.gmail() },
			deleghe: this.coda.stato(),
			progetti,
			daAssegnare: mittenti,
			automatici,
			suggerimenti: this.suggerimenti(indice, rubrica),
			whatsapp: wa.stato,
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
			case 'whatsapp.refresh':
				void this.whatsapp.aggiorna();
				return true;
			case 'whatsapp.apri': {
				const c = this.whatsapp.chat.find(x => x.id === m.id);
				const link = c ? linkWhatsapp(c) : undefined;
				// apre la chat in WhatsApp, senza scrivere niente; per i gruppi e i numeri sconosciuti non fa nulla
				if (link) execFile('open', [link], () => undefined);
				return true;
			}
			case 'rubrica.add':
			case 'rubrica.remove': {
				const p = String(m.path ?? '');
				if (!this.h.projects().some(x => x.path === p)) return true;
				const r = this.posta.rubrica();
				this.posta.salvaRubrica(m.type === 'rubrica.add' ? aggiungiVoce(r, p, String(m.voce ?? '')) : togliVoce(r, p, String(m.voce ?? '')));
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
