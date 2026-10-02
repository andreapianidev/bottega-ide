/* WhatsApp per progetto: le chat dei contatti di ogni progetto, accanto ai fili di posta.

   Le fonti sono i server MCP locali stdio whatsapp-business e whatsapp-personal (capacita' `messaggi` nella mappa),
   interrogati direttamente con il client MCP (mcp.ts): istantaneo, gratis, niente esce dal Mac. Strumenti usati,
   solo di lettura: `list_chats` (una riga JSON per chat: jid, name, last_message_time, last_message, last_sender,
   last_is_from_me) e `search_contacts` (phone_number, name, jid), che serve a trovare il numero delle chat con JID
   "@lid", dove il numero non c'e'. Il server non dice se una chat e' da leggere: `nonLetto` c'e' solo se lo dice.

   Si tengono solo intestazioni: contatto, numero in E.164, ultimo messaggio tagliato a 120 caratteri, data, chi
   ha scritto per ultimo. Mai altri messaggi. File ~/.bottega/connettori/whatsapp.json (600).

   Privacy: le chat di whatsapp-personal entrano solo se il numero (o il gruppo) e' in rubrica, salvo
   bottega.whatsapp.personaleDaAssegnare; non vengono nemmeno scritte su disco. I gruppi solo se in rubrica, quelli
   del numero business anche in "Da assegnare". Le chat di stato, i canali e i bot non entrano mai.
   Contratto: docs/CONTRATTI.md, sezione 5. */

import * as fs from 'fs';
import * as path from 'path';
import { DIR_CONNETTORI, scriviPrivato } from './delega';
import { normGruppo, normTelefono, progettiDiGruppo, progettiDiTelefono, Rubrica } from './posta';

export const WA_FILE = path.join(DIR_CONNETTORI, 'whatsapp.json');
export const ANTEPRIMA_WA = 120;

export type FonteWa = 'business' | 'personale';

export interface ChatWa {
	/** "wa:<fonte>:<jid>" */
	id: string;
	fonte: FonteWa;
	/** Nome del server MCP da cui viene. */
	server: string;
	jid: string;
	gruppo: boolean;
	contatto: string;
	/** E.164 ("+34600000000"); vuoto per i gruppi e per le chat di cui non si trova il numero. */
	telefono: string;
	/** Ultimo messaggio, al massimo 120 caratteri. */
	ultimo: string;
	/** ISO 8601 */
	data: string;
	/** L'ultimo messaggio l'ha scritto Andrea. */
	mio: boolean;
	nonLetto?: boolean;
}

export interface FonteWaStato {
	nome: string;
	at: number;
	n: number;
	durataMs?: number;
	errore?: string;
}

interface FileWa {
	at: number;
	giorni: number;
	fonti: Partial<Record<FonteWa, FonteWaStato>>;
	chat: ChatWa[];
}

export const fonteDi = (server: string): FonteWa => (/business/i.test(server) ? 'business' : 'personale');

/** Il testo di un risultato: una riga JSON per voce (come fanno i server WhatsApp), o un elenco JSON. */
export function righeJson(testo: string): any[] {
	const t = String(testo ?? '').trim();
	if (!t) return [];
	try {
		const x = JSON.parse(t);
		return Array.isArray(x) ? x : [x];
	} catch {
		// una per riga
	}
	const out: any[] = [];
	for (const l of t.split('\n')) {
		try {
			const x = JSON.parse(l);
			if (x && typeof x === 'object') out.push(x);
		} catch {
			// riga non JSON
		}
	}
	return out;
}

const breve = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function dataIso(s: unknown): string {
	const t = Date.parse(String(s ?? ''));
	return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

export type TipoJid = 'persona' | 'lid' | 'gruppo' | 'altro';
export function tipoJid(jid: string): TipoJid {
	if (/^\d{6,20}@s\.whatsapp\.net$/.test(jid)) return 'persona';
	if (/^\d{6,25}@lid$/.test(jid)) return 'lid';
	if (normGruppo(jid)) return 'gruppo';
	return 'altro';
}

/** Le chat di list_chats in forma comune, solo quelle dopo `daMs`. Il numero delle chat "@lid" lo mette dopo
 *  `numeriLid` (jid -> telefono). Stato, canali e bot si scartano. */
export function chatDaLista(voci: any[], o: { fonte: FonteWa; server: string; daMs: number; numeriLid?: Map<string, string> }): ChatWa[] {
	const out: ChatWa[] = [];
	const visti = new Set<string>();
	for (const v of voci) {
		const jid = String(v?.jid ?? '').trim().toLowerCase();
		const tipo = tipoJid(jid);
		if (tipo === 'altro' || visti.has(jid)) continue;
		const data = dataIso(v.last_message_time);
		if (!data || Date.parse(data) < o.daMs) continue;
		visti.add(jid);
		const telefono = tipo === 'persona' ? normTelefono(jid.split('@')[0]) : tipo === 'lid' ? (o.numeriLid?.get(jid) ?? '') : '';
		const nonLetto = v.unread === true || Number(v.unread_count) > 0 ? true : undefined;
		out.push({
			id: `wa:${o.fonte}:${jid}`,
			fonte: o.fonte,
			server: o.server,
			jid,
			gruppo: tipo === 'gruppo',
			contatto: breve(v.name, 80) || telefono,
			telefono,
			ultimo: breve(v.last_message, ANTEPRIMA_WA),
			data,
			mio: v.last_is_from_me === 1 || v.last_is_from_me === true,
			...(nonLetto ? { nonLetto } : {}),
		});
	}
	return out.sort((a, b) => b.data.localeCompare(a.data));
}

/** Il numero di un contatto "@lid" dai risultati di search_contacts: la voce con lo stesso jid. */
export function numeroDaContatti(voci: any[], jid: string): string {
	const c = voci.find(x => String(x?.jid ?? '').toLowerCase() === jid);
	return c ? normTelefono(String(c.phone_number ?? '')) : '';
}

/** La regola di privacy, prima di scrivere su disco e prima di mostrare. */
export function ammessa(c: ChatWa, r: Rubrica, personaleDaAssegnare = false): boolean {
	const inRubrica = c.gruppo ? progettiDiGruppo(c.jid, r).length > 0 : progettiDiTelefono(c.telefono, r).length > 0;
	if (inRubrica) return true;
	if (c.fonte === 'business') return true;
	return personaleDaAssegnare && !c.gruppo;
}

export interface AssegnazioneWa {
	perProgetto: Record<string, ChatWa[]>;
	daAssegnare: ChatWa[];
}

export function assegnaChat(chat: ChatWa[], r: Rubrica, personaleDaAssegnare = false): AssegnazioneWa {
	const perProgetto: Record<string, ChatWa[]> = {};
	const daAssegnare: ChatWa[] = [];
	for (const c of chat) {
		if (!ammessa(c, r, personaleDaAssegnare)) continue;
		const ps = c.gruppo ? progettiDiGruppo(c.jid, r) : progettiDiTelefono(c.telefono, r);
		if (!ps.length) {
			// senza numero non si puo' assegnare: resta fuori anche da "Da assegnare"
			if (c.gruppo || c.telefono) daAssegnare.push(c);
			continue;
		}
		for (const p of ps) (perProgetto[p] ??= []).push(c);
	}
	return { perProgetto, daAssegnare };
}

// ---------- il motore ----------

/** Quello che serve del client MCP (mcp.ts): solo chiamate di lettura. */
export interface LettoreMcp {
	chiama(nome: string, args: Record<string, unknown>): Promise<{ isError?: boolean; content?: { type: string; text?: string }[] }>;
}

export interface WhatsappDeps {
	file?: string;
	/** I server WhatsApp utilizzabili adesso (capacita' messaggi, locali diretti). */
	server(): string[];
	/** Apre il server, fa il lavoro e lo chiude (conServer). */
	apri<T>(server: string, fn: (c: LettoreMcp) => Promise<T>): Promise<T>;
	rubrica(): Rubrica;
	giorni(): number;
	personaleDaAssegnare(): boolean;
	onChange(): void;
	log(s: string): void;
	ora?: () => number;
}

const testoDi = (r: { isError?: boolean; content?: { type: string; text?: string }[] }) => {
	const t = (r?.content ?? []).filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
	if (r?.isError) throw new Error(t.slice(0, 200) || 'errore del server');
	return t;
};

/** Legge le chat degli ultimi giorni da un server: list_chats a pagine da 100 (al massimo 5), poi
 *  search_contacts per il numero delle chat "@lid". */
export async function leggiChat(c: LettoreMcp, server: string, daMs: number): Promise<ChatWa[]> {
	const fonte = fonteDi(server);
	const voci: any[] = [];
	for (let page = 0; page < 5; page++) {
		const r = righeJson(testoDi(await c.chiama('list_chats', { limit: 100, page, include_last_message: true, sort_by: 'last_active' })));
		voci.push(...r);
		const vecchia = r.some(v => Date.parse(String(v?.last_message_time ?? '')) < daMs);
		if (r.length < 100 || vecchia) break;
	}
	const numeriLid = new Map<string, string>();
	for (const v of voci) {
		const jid = String(v?.jid ?? '').toLowerCase();
		if (tipoJid(jid) !== 'lid' || numeriLid.has(jid) || !(Date.parse(String(v.last_message_time ?? '')) >= daMs)) continue;
		try {
			const cs = righeJson(testoDi(await c.chiama('search_contacts', { query: jid.split('@')[0] })));
			numeriLid.set(jid, numeroDaContatti(cs, jid));
		} catch {
			numeriLid.set(jid, '');
		}
	}
	return chatDaLista(voci, { fonte, server, daMs, numeriLid });
}

export class MotoreWhatsapp {
	private dati: FileWa;
	aggiornando = false;
	errore?: string;

	constructor(private readonly d: WhatsappDeps) {
		this.dati = this.leggi();
	}

	private get file(): string {
		return this.d.file ?? WA_FILE;
	}

	private ora(): number {
		return this.d.ora ? this.d.ora() : Date.now();
	}

	private leggi(): FileWa {
		try {
			const x = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			if (x && Array.isArray(x.chat)) return { at: Number(x.at) || 0, giorni: Number(x.giorni) || 7, fonti: x.fonti ?? {}, chat: x.chat };
		} catch {
			// primo avvio
		}
		return { at: 0, giorni: 7, fonti: {}, chat: [] };
	}

	get chat(): ChatWa[] {
		return this.dati.chat;
	}

	get fonti(): FileWa['fonti'] {
		return this.dati.fonti;
	}

	get aggiornatoAt(): number {
		return this.dati.at;
	}

	/** Legge tutti i server WhatsApp, uno dopo l'altro. Ogni server sostituisce solo le sue chat. */
	async aggiorna(): Promise<void> {
		const servers = this.d.server();
		if (!servers.length || this.aggiornando) return;
		this.aggiornando = true;
		this.errore = undefined;
		this.d.onChange();
		const giorni = this.d.giorni();
		const daMs = this.ora() - giorni * 24 * 3_600_000;
		try {
			for (const server of servers) {
				const fonte = fonteDi(server);
				const t0 = this.ora();
				let stato: FonteWaStato;
				let nuove: ChatWa[] | undefined;
				try {
					const tutte = await this.d.apri(server, c => leggiChat(c, server, daMs));
					// privacy prima del disco: le chat personali fuori rubrica non vengono scritte
					const r = this.d.rubrica();
					nuove = tutte.filter(c => ammessa(c, r, this.d.personaleDaAssegnare()));
					stato = { nome: server, at: this.ora(), n: nuove.length, durataMs: this.ora() - t0 };
				} catch (e: any) {
					this.errore = `${server} non risponde: ${String(e?.message ?? e).slice(0, 200)}`;
					stato = { nome: server, at: this.ora(), n: 0, errore: this.errore };
				}
				const altre = this.dati.chat.filter(c => (nuove ? c.server !== server : true) && Date.parse(c.data) >= daMs);
				this.dati = {
					at: this.ora(),
					giorni,
					fonti: { ...this.dati.fonti, [fonte]: stato },
					chat: [...(nuove ?? []), ...altre].sort((a, b) => b.data.localeCompare(a.data)).slice(0, 600),
				};
				try {
					scriviPrivato(this.file, this.dati);
				} catch (e) {
					this.d.log(`whatsapp: non salvo le chat (${e})`);
				}
			}
		} finally {
			this.aggiornando = false;
			this.d.onChange();
		}
	}
}

/** Il comando per aprire una chat in WhatsApp sul Mac: solo per le chat con un numero. */
export function linkWhatsapp(c: Pick<ChatWa, 'telefono' | 'gruppo'>): string | undefined {
	return !c.gruppo && /^\+[1-9]\d{6,14}$/.test(c.telefono) ? `whatsapp://send?phone=${c.telefono.slice(1)}` : undefined;
}
