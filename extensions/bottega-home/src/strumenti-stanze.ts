/* Gli strumenti di Melissa sulle stanze della plancia: legge e mostra quello che Andrea vede, senza costi.

   - `stanza_leggi {stanza, progetto?, periodo?, mese?}`: un riassunto gia' pronto per la voce (frasi corte, numeri
     arrotondati, al massimo ~1200 caratteri, i cinque elementi che contano di piu'), letto dallo stesso stato che la
     plancia mostra: cruscotto (stats.ts), App Store (appstore.ts), Vedetta e siti (regole e radar), clienti
     (clienti.ts), cose da fare e memoria (riassunti della Memoria, continua.ts), posta e WhatsApp (stanza
     Connettori), connettori e notte. Nessuna chiamata di rete, nessuna delega: se i dati sono vecchi lo dice con l'eta';
   - `stanza_mostra {stanza, progetto?}`: porta la Home su quella stanza (Osservatorio compreso), come cruscotto_mostra.

   Posta e WhatsApp danno solo nome del contatto, progetto, oggetto o un'anteprima breve, e solo se Andrea lo chiede.
   Quello che Melissa legge va al suo cervello (Agnes, o quello scelto per la conversazione).
   Gli strumenti entrano nell'elenco di Melissa (TOOLS di assistant.ts) da extension.ts, che chiama anche
   `registraStrumentiStanze` con le fonti. Contratto: docs/CONTRATTI.md, sezione 6. */

import type { Assistant, ToolSpec } from './assistant';
import type { ClientReport } from './clienti';
import { splitSummary, isSessionOutcome } from './continua';
import type { BoardItem, MemoryItem } from './memoria';
import type { NightState } from './notte';
import type { Stats, StatsPeriod } from './stats';
import type { RadarState, RulesState, VercelSito } from './tipi';

// ---------- le fonti, passate da extension.ts ----------

/** Una serie dell'App Store: euro AdMob, euro dello Store, download nuovi (appstore.ts, Serie). */
export interface SerieStore {
	admob: number[];
	store: number[];
	dl: number[];
}

/** Il minimo che serve di AppStoreStato (appstore.ts, CONTRATTI 13.2): cosi' i campi nuovi non rompono niente. */
export interface StatoStore {
	aggiornatoAt: number;
	aggiornando?: boolean;
	errori?: { store?: string; admob?: string };
	giorni: string[];
	mesi: string[];
	storeFinoA?: string;
	totale: { giorni: SerieStore; mesi: SerieStore };
	app: { chiave: string; nome: string; projectPath?: string; projectName?: string; giorni: SerieStore; mesi: SerieStore }[];
	buchi: { chiave: string; app: string; gravita: string; titolo: string; cosa: string; stima?: number; projectPath?: string }[];
}

/** Il minimo della posta per progetto (connettori-host.ts, PostaStato, CONTRATTI 5.8). */
export interface StatoPostaMinimo {
	aggiornatoAt: number;
	errore?: string;
	giorni: number;
	progetti: {
		path: string;
		name: string;
		fili: { da: string; oggetto: string; data: string; nonLetto: boolean }[];
		nonLetti: number;
		chat: { contatto: string; gruppo: boolean; ultimo: string; data: string; mio: boolean }[];
		chatDaRispondere: number;
	}[];
	daAssegnare: unknown[];
	whatsapp: { aggiornatoAt: number; errore?: string; giorni: number; daAssegnare: unknown[] };
}

/** Il minimo dei connettori (connettori-host.ts, statoConnettori). */
export interface StatoConnettoriMinimo {
	aggiornatoAt: number;
	aggiornando?: boolean;
	errore?: string;
	connettori: { nome: string; stato: string; diretto: boolean }[];
	deleghe: { inCorso: string | null; coda: string[]; spesaOggi: number; tetto: number };
}

export interface FontiStanze {
	/** La risoluzione del nome di extension.ts (resolveProject): nome, cartella o pezzo di nome. */
	progetto(nome: string): { name: string; path: string } | undefined;
	/** Il calcolo del cruscotto (incrementale, in locale): lo stesso che riceve la plancia. */
	stats?(): Promise<Stats | null>;
	appStore?(): StatoStore | undefined;
	regole?(): RulesState | undefined;
	radar?(): RadarState | undefined;
	rileggiStack?(): Promise<void>;
	/** Le ore per cliente del mese (YYYY-MM, default quello in corso), come nella stanza Clienti. */
	clienti?(mese?: string): Promise<ClientReport | null>;
	memoria?(): { recent(project?: string, opts?: { kinds?: string[]; limit?: number }): Promise<MemoryItem[]>; bacheca(project?: string, minutes?: number): Promise<BoardItem[]> } | undefined;
	connettori?(): { statoPosta(): StatoPostaMinimo; statoConnettori(): StatoConnettoriMinimo } | undefined;
	notte?(): NightState | undefined;
	/** La Home davanti su una stanza, eventualmente puntata su un progetto. */
	mostra(view: string, path?: string): void;
	/** Un messaggio alla plancia (per il cruscotto: crus.focus). */
	send(msg: unknown): void;
	osservatorio?(): unknown;
	ora?(): number;
}

/** La stessa forma di ToolDef in assistant.ts: extension.ts lo verifica con `satisfies`. */
export interface StrumentoStanza {
	spec: ToolSpec;
	risky?: boolean;
	run(args: any, ctx: Assistant): Promise<string> | string;
}

let fonti: FontiStanze | undefined;

/** L'aggancio in extension.ts, all'attivazione. */
export function registraStrumentiStanze(f: FontiStanze): void {
	fonti = f;
}

/** Le stesse fonti per il ponte verso l'iPhone (src/ponte-stanze.ts, CONTRATTI 9.6): undefined finche' non ci sono. */
export function fontiStanze(): FontiStanze | undefined {
	return fonti;
}

export const STANZE = ['cruscotto', 'appstore', 'vedetta', 'siti', 'clienti', 'posta', 'whatsapp', 'dafare', 'memoria', 'connettori', 'notte'] as const;
export type Stanza = (typeof STANZE)[number];
export const MASSIMO_VOCE = 1200;
const TEMPO_MASSIMO = 20_000;
const MIN = 60_000;
const GIORNO = 86_400_000;

// ---------- pezzi puri: numeri e frasi per la voce ----------

const norma = (s: string) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const somma = (v: number[]) => v.reduce((s, x) => s + (Number(x) || 0), 0);
const nf = (n: number, dec = 0) => n.toLocaleString('it-IT', { maximumFractionDigits: dec, minimumFractionDigits: 0 });

/** Una stanza detta a parole, con i sinonimi che un cervello potrebbe usare. */
export function stanzaDa(v: unknown): Stanza | 'osservatorio' | 'plancia' | 'lavori' | 'melissa' | undefined {
	const k = norma(String(v ?? ''));
	const alias: Record<string, string> = {
		ore: 'cruscotto', token: 'cruscotto', statistiche: 'cruscotto',
		store: 'appstore', appstore: 'appstore', admob: 'appstore', guadagni: 'appstore', soldi: 'appstore', vendite: 'appstore',
		regole: 'vedetta', semaforo: 'vedetta',
		vercel: 'siti', sito: 'siti', pubblicazioni: 'siti',
		cliente: 'clienti', fatture: 'clienti', fatturare: 'clienti',
		mail: 'posta', email: 'posta', gmail: 'posta',
		messaggi: 'whatsapp', chat: 'whatsapp',
		todo: 'dafare', cosedafare: 'dafare',
		ricordi: 'memoria', bacheca: 'memoria',
		deleghe: 'connettori',
		coda: 'notte', stanotte: 'notte',
		progetti: 'plancia', sessioni: 'plancia', home: 'plancia',
	};
	const s = alias[k] ?? k;
	return (STANZE as readonly string[]).includes(s) || ['osservatorio', 'plancia', 'lavori', 'melissa'].includes(s) ? (s as any) : undefined;
}

/** Minuti detti a voce: "45 minuti", "2 ore e 15 minuti", "circa 40 ore". */
export function ore(minuti: number): string {
	const m = Math.max(0, Number(minuti) || 0);
	if (m < 1) return 'meno di un minuto';
	if (m < 59.5) {
		const r = Math.round(m);
		return r === 1 ? '1 minuto' : `${r} minuti`;
	}
	if (m >= 20 * 60) return `circa ${Math.round(m / 60)} ore`;
	let h = Math.floor(m / 60);
	let r = Math.round((m - h * 60) / 5) * 5;
	if (r === 60) (h++, (r = 0));
	const testa = h === 1 ? '1 ora' : `${h} ore`;
	return r ? `${testa} e ${r} minuti` : testa;
}

export function euro(n: number): string {
	const v = Number(n) || 0;
	if (Math.abs(v) < 0.005) return '0 euro';
	return Math.abs(v) < 10 ? `${nf(v, 2)} euro` : `${nf(Math.round(v))} euro`;
}

/** Gli importi da fatturare: al centesimo. */
const euroEsatti = (n: number) => `${(Number(n) || 0).toLocaleString('it-IT', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })} euro`;

const dollari = (n: number) => {
	const v = Number(n) || 0;
	return Math.abs(v) < 10 ? `${nf(v, 2)} dollari` : `${nf(Math.round(v))} dollari`;
};

export function token(n: number): string {
	const v = Math.max(0, Number(n) || 0);
	if (v >= 1e9) return `${nf(v / 1e9, 1)} miliardi di token`;
	if (v >= 1e6) return `${nf(v / 1e6, v < 1e7 ? 1 : 0)} milioni di token`;
	if (v >= 1e3) return `${nf(Math.round(v / 1e3))} mila token`;
	return `${Math.round(v)} token`;
}

/** "il 12% in piu'", "il 30% in meno", "piu' o meno uguale"; vuoto se non c'e' un termine di paragone. */
export function variazione(adesso: number, prima: number): string {
	if (!(prima > 0)) return '';
	const p = Math.round(((adesso - prima) / prima) * 100);
	if (Math.abs(p) < 3) return 'più o meno uguale';
	return `il ${Math.abs(p)}% in ${p > 0 ? 'più' : 'meno'}`;
}

/** L'eta' di un dato, detta solo quando conta (oltre mezz'ora): «Dati di 3 ore fa.». */
export function eta(at: number, now: number): string {
	if (!at) return '';
	const m = (now - at) / MIN;
	if (m < 30) return '';
	if (m < 90) return `Dati di ${Math.round(m)} minuti fa.`;
	const h = Math.round(m / 60);
	if (h < 36) return h === 1 ? 'Dati di un\'ora fa.' : `Dati di ${h} ore fa.`;
	const d = Math.round(h / 24);
	return `Dati di ${d} giorni fa.`;
}

const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

const pad = (n: number) => String(n).padStart(2, '0');
const chiaveMese = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const chiaveGiorno = (d: Date) => `${chiaveMese(d)}-${pad(d.getDate())}`;

/** "2026-09" detto a voce: "settembre 2026". */
export function meseDetto(m: string): string {
	const [y, n] = m.split('-').map(Number);
	return MESI[n - 1] ? `${MESI[n - 1]} ${y}` : m;
}

/** Un mese da come lo dice Andrea: "2026-09", "settembre", "settembre 2025", "questo mese", "mese scorso". */
export function meseDa(v: unknown, now: number): string | undefined {
	const t = String(v ?? '').trim().toLowerCase();
	if (!t) return undefined;
	if (/^\d{4}-\d{2}$/.test(t)) return t;
	const oggi = new Date(now);
	if (/quest|corrente|in corso/.test(t)) return chiaveMese(oggi);
	if (/scors|passat|precedent/.test(t)) return chiaveMese(new Date(oggi.getFullYear(), oggi.getMonth() - 1, 1));
	const i = MESI.findIndex(n => t.includes(n));
	if (i < 0) return undefined;
	const anno = /\b(20\d\d)\b/.exec(t)?.[1];
	if (anno) return `${anno}-${pad(i + 1)}`;
	// senza anno: l'ultimo mese con quel nome, fino a questo
	const y = i <= oggi.getMonth() ? oggi.getFullYear() : oggi.getFullYear() - 1;
	return `${y}-${pad(i + 1)}`;
}

/** Il periodo in giorni, ricondotto a quelli che le stanze conoscono: 1, 7, 30, 90, 365. */
export function periodoDa(v: unknown, predefinito: number): number {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return predefinito;
	if (n <= 1) return 1;
	if (n <= 7) return 7;
	if (n <= 31) return 30;
	if (n <= 120) return 90;
	return 365;
}

/** Quando, a voce: "oggi", "ieri", "3 giorni fa", "il 12 settembre". */
export function quando(t: number, now: number): string {
	if (!t) return '';
	const mezzanotte = (x: number) => {
		const d = new Date(x);
		return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	};
	const g = Math.round((mezzanotte(now) - mezzanotte(t)) / GIORNO);
	if (g <= 0) return 'oggi';
	if (g === 1) return 'ieri';
	if (g < 7) return `${g} giorni fa`;
	const d = new Date(t);
	return `il ${d.getDate()} ${MESI[d.getMonth()]}`;
}

const quandoIso = (iso: string, now: number) => quando(Date.parse(iso) || 0, now);
const giornoDetto = (k: string) => {
	const [, m, d] = k.split('-').map(Number);
	return `${d} ${MESI[m - 1] ?? ''}`.trim();
};

/** Toglie a capo, lineette lunghe e medie e spazi doppi; accorcia a `max`. */
export function pulisci(s: string, max = 0): string {
	let t = String(s ?? '').replace(/\s*[\u2013\u2014]\s*/g, ', ').replace(/\s+/g, ' ').trim();
	if (max && t.length > max) t = t.slice(0, max - 3).replace(/\s+\S*$/, '') + '...';
	return t;
}

/** Mette insieme le frasi fino al massimo per la voce; quello che non ci sta viene detto, non tagliato a meta'. */
export function componi(frasi: (string | undefined | false)[], max = MASSIMO_VOCE): string {
	const coda = ' Il resto è nella stanza: chiedimi i dettagli.';
	const out: string[] = [];
	let n = 0;
	const tutte = frasi.filter((f): f is string => !!f && !!f.trim()).map(f => pulisci(f));
	for (let i = 0; i < tutte.length; i++) {
		const f = tutte[i];
		const spazio = out.length ? 1 : 0;
		const riserva = i < tutte.length - 1 ? coda.length : 0;
		if (n + spazio + f.length + riserva > max) {
			if (!out.length) return pulisci(f, max);
			return (out.join(' ') + coda).slice(0, max);
		}
		out.push(f);
		n += spazio + f.length;
	}
	return out.join(' ');
}

const elenco = (v: string[]) => (v.length <= 1 ? v.join('') : `${v.slice(0, -1).join(', ')} e ${v[v.length - 1]}`);

async function conTempo<T>(p: Promise<T>, ms = TEMPO_MASSIMO): Promise<T | 'tempo'> {
	let t: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([p, new Promise<'tempo'>(ok => (t = setTimeout(() => ok('tempo'), ms)))]);
	} finally {
		clearTimeout(t);
	}
}

// ---------- le stanze ----------

interface Richiesta {
	progetto?: string;
	periodo?: number;
	mese?: string;
}

type Progetto = { name: string; path: string };

function risolvi(f: FontiStanze, nome?: string): Progetto | undefined {
	return nome ? f.progetto(String(nome)) : undefined;
}

const periodoFrase = (g: number) => (g === 1 ? 'oggi' : g === 365 ? "nell'ultimo anno" : `negli ultimi ${g} giorni`);
const totTok = (t: number[] | number) => (Array.isArray(t) ? somma(t) : Number(t) || 0);

// --- cruscotto ---

async function leggiCruscotto(f: FontiStanze, a: Richiesta, now: number): Promise<string> {
	if (!f.stats) return 'Il cruscotto non è disponibile.';
	const r = await conTempo(f.stats().catch(() => null));
	if (r === 'tempo') return 'Sto ancora leggendo le sessioni di Claude Code: riprova tra poco.';
	if (!r) return 'Il cruscotto non è pronto: non riesco a leggere le sessioni di Claude Code.';
	const s = r;
	const p = risolvi(f, a.progetto);
	if (a.progetto && !p) return `Non trovo il progetto "${a.progetto}".`;

	if (s.workTime && !p) {
		const month = meseDa(a.mese, now);
		const days = periodoDa(a.periodo, 7);
		const rows = month ? s.workTime.days.filter(d => d.date.startsWith(month)) : s.workTime.days.slice(-Math.min(days, 90));
		if (month && !rows.length) return `Il cruscotto tiene solo gli ultimi 90 giorni: ${meseDetto(month)} non c'è.`;
		const measured = rows.reduce((sum, d) => sum + d.minutes, 0);
		const observed = s.observedActivity;
		return componi([
			`Tempo osservato di Claude Code e Codex ${month ? 'a ' + meseDetto(month) : periodoFrase(days)}: ${ore(measured)}. Le sessioni parallele contano una volta.`,
			observed ? `Attività osservate di Claude Code, Codex, Cline e terminali: ${observed.sources.map(x => `${x.source}: ${x.inCorso} in corso, ${x.tiAspetta} in attesa, ${x.sconosciuto} da verificare`).join('; ')}.` : undefined,
			'Le durate di Cline e dei terminali non sono disponibili in questo conteggio.',
			s.sourceMetrics ? Object.entries(s.sourceMetrics[String(days <= 7 ? 7 : days <= 30 ? 30 : 90) as '7' | '30' | '90']).map(([source, v]) => `${source}: ${v.tokens === null ? 'token non disponibili' : token(v.tokens)}, ${v.cost === null ? 'costo non disponibile' : dollari(v.cost)}.`).join(' ') : undefined,
		]);
	}

	// un mese preciso: i mesi del cruscotto, senza dettaglio per progetto
	const mese = meseDa(a.mese, now);
	if (mese) {
		const b = s.months.find(x => x.key === mese);
		if (!b) return `Il cruscotto tiene solo gli ultimi 90 giorni: ${meseDetto(mese)} non c'è.`;
		return componi([
			p ? `Per ${meseDetto(mese)} ho solo il totale, non quello di ${p.name}: per un progetto chiedimi 7, 30 o 90 giorni.` : undefined,
			`A ${meseDetto(mese)} hai lavorato ${ore(b.you)} in ${b.activeDays} giorni, Claude ${ore(b.claude)} contando le sessioni in parallelo, ${b.sessions} sessioni.`,
			`Token: ${token(totTok(b.tok))}, valore a listino ${dollari(b.cost)}.`,
			s.days[0] && b.start < s.days[0].date ? `Il conto parte dal ${giornoDetto(s.days[0].date)}: prima il cruscotto non ha dati.` : undefined,
		]);
	}

	const g = periodoDa(a.periodo, 7);
	const k = g === 1 ? 7 : g === 365 ? 90 : g;
	const per: StatsPeriod = s.periods[String(k) as '7' | '30' | '90'];
	const lunedi = (daily: number[]) => {
		const giorniDaLunedi = ((new Date(now).getDay() + 6) % 7) + 1;
		return daily.length >= giorniDaLunedi ? somma(daily.slice(-giorniDaLunedi)) : undefined;
	};
	const anno = g === 365 ? 'Il cruscotto tiene gli ultimi 90 giorni: ti dico quelli.' : undefined;

	if (p) {
		const pr = per.projects.find(x => x.path === p.path);
		if (g === 1) {
			const oggi = pr ? pr.daily[pr.daily.length - 1] ?? 0 : 0;
			const vive = s.live.filter(l => l.path === p.path).length;
			return componi([
				oggi ? `Oggi su ${p.name} hai lavorato ${ore(oggi)}.` : `Oggi su ${p.name} non risultano ore Claude Code.`,
				vive ? `Adesso ci sono ${vive === 1 ? 'una sessione aperta' : `${vive} sessioni aperte`}.` : undefined,
			]);
		}
		if (!pr) {
			const fermo = per.stalled.find(x => x.path === p.path);
			const ultimo = s.periods['90'].projects.find(x => x.path === p.path)?.last;
			return componi([
				anno,
				`Su ${p.name} ${periodoFrase(k)} non risultano ore Claude Code.`,
				fermo ? `Nei ${k} giorni prima ci avevi lavorato ${ore(fermo.prev)}.` : undefined,
				ultimo ? `L'ultima volta: ${quando(ultimo, now)}.` : undefined,
			]);
		}
		const dl = k === 7 ? lunedi(pr.daily) : undefined;
		const v = variazione(pr.you, pr.prev.you);
		return componi([
			anno,
			`${p.name}, ${periodoFrase(k)}: ${ore(pr.you)} tue, ${ore(pr.claude)} di Claude, ${pr.sessions} ${pr.sessions === 1 ? 'sessione' : 'sessioni'}.`,
			dl !== undefined ? `Da lunedì: ${ore(dl)}.` : undefined,
			per.you > 0 ? `È il ${Math.round((pr.you / per.you) * 100)}% delle tue ore.` : undefined,
			`Token: ${token(totTok(pr.tok))}, valore a listino ${dollari(pr.cost)}.`,
			v ? `Rispetto ai ${k} giorni prima: ${v} (allora ${ore(pr.prev.you)}).` : pr.prev.you === 0 ? `Nei ${k} giorni prima non risultavano ore Claude Code.` : undefined,
			pr.live ? `Adesso ${pr.live === 1 ? "c'è una sessione aperta" : `ci sono ${pr.live} sessioni aperte`}.` : `Ultima attività: ${quando(pr.last, now)}.`,
		]);
	}

	if (g === 1) {
		const t = s.today;
		const top = per.projects
			.map(x => ({ n: x.name, m: x.daily[x.daily.length - 1] ?? 0 }))
			.filter(x => x.m >= 1)
			.sort((x, y) => y.m - x.m)
			.slice(0, 5);
		return componi([
			t.you ? `Oggi hai lavorato ${ore(t.you)}, Claude ${ore(t.claude)} contando le sessioni in parallelo, ${t.sessions} sessioni, ${token(t.tok)}.` : 'Oggi non hai ancora lavorato con Claude.',
			top.length ? `Progetti: ${elenco(top.map(x => `${x.n} ${ore(x.m)}`))}.` : undefined,
			s.live.length ? `Adesso ${s.live.length === 1 ? "c'è una sessione aperta" : `ci sono ${s.live.length} sessioni aperte`}.` : undefined,
		]);
	}
	const v = variazione(per.you, per.prev.you);
	const top = [...per.projects].sort((x, y) => y.you - x.you).slice(0, 5);
	const dl = k === 7 ? s.week.now.you : undefined;
	return componi([
		anno,
		`${cap(periodoFrase(k))} hai lavorato ${ore(per.you)} in ${per.activeDays} giorni. Claude ${ore(per.claude)}, contando le sessioni in parallelo, in ${per.sessions} sessioni.`,
		dl !== undefined ? `Da lunedì: ${ore(dl)}, oggi ${ore(s.today.you)}.` : undefined,
		`Token: ${token(totTok(per.tok))}, valore a listino ${dollari(per.cost)}, che non è quello che paghi con l'abbonamento.`,
		v ? `Rispetto ai ${k} giorni prima: ${v}.` : undefined,
		top.length ? `Progetti: ${elenco(top.map(x => `${x.name} ${ore(x.you)}`))}.` : undefined,
		s.live.length ? `Adesso ${s.live.length === 1 ? "c'è una sessione aperta" : `ci sono ${s.live.length} sessioni aperte`}.` : undefined,
	]);
}

// --- App Store ---

interface Somma {
	admob: number;
	store: number;
	dl: number;
}

function sommaIndici(s: SerieStore, idx: number[]): Somma {
	const v = (a: number[]) => idx.reduce((t, i) => t + (Number(a?.[i]) || 0), 0);
	return { admob: v(s.admob), store: v(s.store), dl: v(s.dl) };
}

const tutto = (x: Somma) => x.admob + x.store;
const range = (da: number, a: number) => Array.from({ length: Math.max(0, a - da) }, (_, i) => da + i);

function leggiAppStore(f: FontiStanze, a: Richiesta, now: number): string {
	const st = f.appStore?.();
	if (!st) return 'La stanza App Store non è pronta.';
	if (!st.aggiornatoAt) return st.aggiornando ? 'La stanza App Store sta leggendo i dati per la prima volta: riprova tra un minuto.' : 'La stanza App Store non ha ancora letto i dati: aprila e si aggiorna da sola.';

	// quali serie: giorni (ieri, 7, 30) o mesi (90 = 3 mesi, anno = 12 mesi, o un mese preciso)
	const mese = meseDa(a.mese, now);
	let quale: 'giorni' | 'mesi';
	let idx: number[];
	let prima: number[];
	let etichetta: string;
	let primaFrase: string;
	if (mese) {
		const i = st.mesi.indexOf(mese);
		if (i < 0) return `Non ho i numeri di ${meseDetto(mese)}: la stanza tiene gli ultimi 24 mesi.`;
		quale = 'mesi';
		idx = [i];
		prima = i > 0 ? [i - 1] : [];
		etichetta = `a ${meseDetto(mese)}${mese === chiaveMese(new Date(now)) ? ', fin qui' : ''}`;
		primaFrase = 'Rispetto al mese prima';
	} else {
		const g = periodoDa(a.periodo, 30);
		if (g <= 30) {
			quale = 'giorni';
			const n = st.giorni.length;
			idx = range(n - g, n);
			prima = range(Math.max(0, n - 2 * g), n - g);
			etichetta = g === 1 ? 'ieri' : `negli ultimi ${g} giorni`;
			primaFrase = g === 1 ? "Rispetto all'altro ieri" : `Rispetto ai ${g} giorni prima`;
		} else {
			quale = 'mesi';
			const k = g === 90 ? 3 : 12;
			const n = st.mesi.length;
			idx = range(n - k, n);
			prima = range(Math.max(0, n - 2 * k), n - k);
			etichetta = `negli ultimi ${k} mesi, compreso questo`;
			primaFrase = `Rispetto ai ${k} mesi prima`;
		}
	}

	// il filtro: le app del progetto, oppure un'app per nome
	let app = st.app;
	let chi = '';
	if (a.progetto) {
		const p = risolvi(f, a.progetto);
		const q = norma(a.progetto);
		const delProgetto = p ? st.app.filter(x => x.projectPath === p.path) : [];
		app = delProgetto.length ? delProgetto : st.app.filter(x => q && (norma(x.nome).includes(q) || norma(x.projectName ?? '').includes(q)));
		if (!app.length) return `Non trovo app di "${a.progetto}" nella stanza App Store.`;
		chi = app.length === 1 ? app[0].nome : `${p?.name ?? a.progetto} (${app.length} app)`;
	}
	const serie = (x: { giorni: SerieStore; mesi: SerieStore }) => (quale === 'giorni' ? x.giorni : x.mesi);
	const tot = (ix: number[]) =>
		a.progetto
			? app.reduce<Somma>((t, x) => {
					const s = sommaIndici(serie(x), ix);
					return { admob: t.admob + s.admob, store: t.store + s.store, dl: t.dl + s.dl };
				}, { admob: 0, store: 0, dl: 0 })
			: sommaIndici(serie(st.totale), ix);
	const ora = tot(idx);
	const prec = prima.length === idx.length ? tot(prima) : undefined;
	const v = prec ? variazione(tutto(ora), tutto(prec)) : '';

	// lo Store pubblica i giorni con un ritardo: lo si dice quando il periodo arriva oltre
	const ultimoGiorno = quale === 'giorni' ? st.giorni[idx[idx.length - 1]] : undefined;
	const storeIndietro = st.storeFinoA && ((ultimoGiorno && ultimoGiorno > st.storeFinoA) || (quale === 'mesi' && st.mesi[idx[idx.length - 1]] >= st.storeFinoA.slice(0, 7) && st.storeFinoA < chiaveGiorno(new Date(now - GIORNO))));

	const frasi: (string | undefined)[] = [];
	frasi.push(`${chi ? `${chi}, ` : ''}${chi ? etichetta : cap(etichetta)}: ${euro(tutto(ora))} in tutto, ${euro(ora.admob)} da AdMob e ${euro(ora.store)} dallo Store, ${nf(Math.round(ora.dl))} download nuovi.`);
	if (v) frasi.push(`${primaFrase}: ${v}.`);
	if (storeIndietro) frasi.push(`Lo Store ha i dati fino al ${giornoDetto(st.storeFinoA!)}.`);
	if (!a.progetto) {
		const migliori = st.app
			.map(x => ({ n: x.nome, e: tutto(sommaIndici(serie(x), idx)) }))
			.filter(x => x.e >= 0.5)
			.sort((x, y) => y.e - x.e)
			.slice(0, 5);
		if (migliori.length) frasi.push(`Le app che rendono di più: ${elenco(migliori.map(x => `${x.n} ${euro(x.e)}`))}.`);
	}
	const chiavi = new Set(app.map(x => x.chiave));
	const buchi = a.progetto ? st.buchi.filter(b => chiavi.has(b.chiave)) : st.buchi;
	if (buchi.length) {
		const alte = buchi.filter(b => b.gravita === 'alta').length;
		frasi.push(buchi.length === 1 ? `Da sistemare: un punto${alte ? ' importante' : ''}.` : `Da sistemare: ${buchi.length} punti${alte ? `, ${alte === 1 ? 'uno importante' : `${alte} importanti`}` : ''}.`);
		for (const b of buchi.slice(0, a.progetto ? 3 : 2)) {
			const stima = b.stima && b.stima >= 1 ? `, circa ${euro(b.stima)} al mese` : '';
			frasi.push(`${a.progetto ? '' : `${b.app}: `}${pulisci(b.titolo, 120)}${stima}.${a.progetto ? ` ${pulisci(b.cosa, 160)}` : ''}`);
		}
	} else if (a.progetto) frasi.push('Nessun buco da sistemare.');
	if (st.errori?.admob) frasi.push(`AdMob: ${pulisci(st.errori.admob, 120)}`);
	if (st.errori?.store) frasi.push(`Store: ${pulisci(st.errori.store, 120)}`);
	frasi.push(eta(st.aggiornatoAt, now));
	return componi(frasi);
}

// --- Vedetta e siti ---

function nomeDi(f: FontiStanze, p: string): string {
	return f.progetto(p)?.name ?? p.split('/').filter(Boolean).pop() ?? p;
}

function leggiVedetta(f: FontiStanze, a: Richiesta, now: number): string {
	const r = f.regole?.();
	if (!r?.checkedAt) return 'Le regole non sono ancora state controllate: il primo giro sta partendo.';
	const radar = f.radar?.();
	if (a.progetto) {
		const p = risolvi(f, a.progetto);
		if (!p) return `Non trovo il progetto "${a.progetto}".`;
		const pr = r.projects[p.path];
		const app = radar?.apps.find(x => x.projectPath === p.path);
		const siti = radar?.vercel?.sites.filter(x => x.projectPath === p.path) ?? [];
		return componi([
			!pr || !pr.hits.length ? `${p.name} è in verde: nessuna regola violata.` : `${p.name} è in ${pr.livello}.`,
			...(pr?.hits ?? []).slice(0, 3).map(h => `${h.frase} ${h.rimedio}`),
			app ? `Su App Store: ${app.version ? `versione ${app.version.string}, ${app.version.label}` : app.live ? `pubblicata la ${app.live}` : 'nessuna versione'}.` : undefined,
			...siti.slice(0, 2).map(s => `Il sito ${s.name}: ultima pubblicazione ${s.label}, ${quando(s.at, now)}.`),
			eta(r.checkedAt, now),
		]);
	}
	const brutti = Object.values(r.projects)
		.filter(x => x.hits.length)
		.sort((x, y) => Number(y.livello === 'rosso') - Number(x.livello === 'rosso') || y.hits.length - x.hits.length);
	const c = r.counts;
	return componi([
		`Semaforo: ${c.rosso} ross${c.rosso === 1 ? 'o' : 'i'}, ${c.giallo} giall${c.giallo === 1 ? 'o' : 'i'}, ${c.verde} verd${c.verde === 1 ? 'e' : 'i'}.`,
		...r.global.slice(0, 2).map(h => `Per tutti: ${h.frase}`),
		...brutti.slice(0, 5).map(x => `${nomeDi(f, x.path)}, ${x.livello}: ${x.hits[0].frase}${x.hits.length > 1 ? ` E altre ${x.hits.length - 1}.` : ''}`),
		eta(r.checkedAt, now),
	]);
}

function sitoDetto(s: VercelSito, now: number, dettagli: boolean): string {
	const dove = s.domain ? `, su ${s.domain}` : '';
	const base = `${s.name}: ultima pubblicazione ${s.label}, ${quando(s.at, now)}${dove}.`;
	if (!dettagli) return base;
	const commit = s.commit?.message ? ` Commit: «${pulisci(s.commit.message.split('\n')[0], 80)}».` : '';
	const errore = s.error ? ` Errore: ${pulisci(s.error, 160)}` : '';
	const online = s.lastReady && s.state !== 'READY' ? ` Online resta quella di ${quando(s.lastReady.at, now)}.` : '';
	return base + commit + errore + online;
}

function leggiSiti(f: FontiStanze, a: Richiesta, now: number): string {
	const v = f.radar?.()?.vercel;
	if (!v) return 'Non leggo i siti su Vercel: il radar non è collegato a Vercel.';
	if (v.catalog) {
		const p = a.progetto ? risolvi(f, a.progetto) : undefined;
		const q = a.progetto ? norma(a.progetto) : '';
		const rows = v.catalog.filter(x => !q || norma(x.name).includes(q) || (p && x.localPaths.includes(p.path)));
		return componi([
			`Vercel: ${rows.length} progetti${a.progetto ? ' trovati' : ''}.`,
			...rows.slice().sort((a, b) => Number(b.tone === 'male') - Number(a.tone === 'male')).slice(0, 5)
				.map(x => `${x.name}: ${x.label}${x.domain ? ', su ' + x.domain : ''}.${x.localPaths.length ? '' : ' Cartella locale non rilevata.'}`),
			'Guardo lo stato delle pubblicazioni, non se i siti rispondono in questo momento.',
			v.catalogError ?? v.error, v.catalogPartial ? 'Inventario parziale.' : undefined, eta(v.catalogAt ?? 0, now),
		]);
	}
	if (!v.at) return v.refreshing ? 'Sto leggendo i siti su Vercel per la prima volta: riprova tra un minuto.' : `Non ho ancora letto i siti su Vercel.${v.error ? ` ${pulisci(v.error, 160)}` : ''}`;
	const onesta = 'Guardo lo stato delle pubblicazioni, non se i siti rispondono in questo momento.';
	if (a.progetto) {
		const p = risolvi(f, a.progetto);
		const q = norma(a.progetto);
		const siti = v.sites.filter(s => (p && s.projectPath === p.path) || (q && norma(s.name).includes(q)));
		if (!siti.length) return `${p?.name ?? a.progetto} non ha un sito collegato su Vercel.`;
		return componi([...siti.slice(0, 3).map(s => sitoDetto(s, now, true)), eta(v.at, now)]);
	}
	const male = v.sites.filter(s => s.tone === 'male');
	const attesa = v.sites.filter(s => s.tone === 'attesa');
	const ok = v.sites.filter(s => s.tone === 'ok');
	const recenti = [...ok].sort((x, y) => y.at - x.at).slice(0, 3);
	return componi([
		`Siti su Vercel: ${v.sites.length} collegati. ${male.length ? `${male.length === 1 ? 'Uno ha' : `${male.length} hanno`} l'ultima pubblicazione fallita` : 'Nessuna pubblicazione fallita'}${attesa.length ? `, ${attesa.length} in corso` : ''}, gli altri sono pubblicati.`,
		...male.slice(0, 3).map(s => sitoDetto(s, now, true)),
		...attesa.slice(0, 2).map(s => sitoDetto(s, now, false)),
		recenti.length ? `Gli ultimi pubblicati: ${elenco(recenti.map(s => `${s.name} ${quando(s.at, now)}`))}.` : undefined,
		onesta,
		v.error ? `L'ultima lettura non è riuscita: ${pulisci(v.error, 120)}` : undefined,
		eta(v.at, now),
	]);
}

// --- clienti ---

async function leggiClienti(f: FontiStanze, a: Richiesta, now: number): Promise<string> {
	if (!f.clienti) return 'La stanza Clienti non è disponibile.';
	const mese = meseDa(a.mese, now);
	const r = await conTempo(f.clienti(mese).catch(() => null));
	if (r === 'tempo') return 'Sto ancora leggendo le sessioni di Claude Code: riprova tra poco.';
	if (!r) return 'Le ore dei clienti non sono pronte.';
	if (!r.config.length) return 'Non hai ancora clienti: si impostano nella stanza Clienti, collegando i progetti a ogni cliente.';
	const quale = meseDetto(r.month);
	const inCorso = r.month === chiaveMese(new Date(now));
	const nota = "Ore arrotondate al quarto d'ora, giorno per giorno.";
	if (a.progetto) {
		const q = norma(a.progetto);
		const p = risolvi(f, a.progetto);
		const c =
			r.clients.find(x => norma(x.nome) === q) ??
			r.clients.find(x => q.length >= 3 && norma(x.nome).includes(q)) ??
			(p ? r.clients.find(x => r.config.find(k => k.id === x.id)?.progetti.some(pp => pp.replace(/\/+$/, '') === p.path.replace(/\/+$/, ''))) : undefined);
		if (!c) {
			if (p) {
				const fuori = r.unassigned.find(u => u.path === p.path);
				return `${p.name} non è di nessun cliente${fuori ? `: a ${quale} ci hai lavorato ${ore(fuori.minutes)}` : ''}. Lo colleghi a un cliente nella stanza Clienti.`;
			}
			return `Non trovo il cliente "${a.progetto}". Ci sono: ${elenco(r.clients.map(x => x.nome).slice(0, 8))}.`;
		}
		const tariffa = r.config.find(k => k.id === c.id)?.tariffa;
		return componi([
			c.minutes
				? `${c.nome}, ${quale}${inCorso ? ' fin qui' : ''}: ${ore(c.minutes)} in ${c.days.length} ${c.days.length === 1 ? 'giorno' : 'giorni'}${c.amount !== undefined ? `, ${euroEsatti(c.amount)} da fatturare` : ', senza tariffa impostata'}.`
				: `${c.nome}: a ${quale} non risultano ore Claude Code.`,
			tariffa && c.minutes ? `Tariffa ${euroEsatti(tariffa)} l'ora.` : undefined,
			c.projects.length > 1 ? `Progetti: ${elenco(c.projects.slice(0, 4).map(x => `${x.name} ${ore(x.minutes)}`))}.` : undefined,
			c.minutes ? nota : undefined,
		]);
	}
	const conOre = r.clients.filter(c => c.minutes > 0);
	const minuti = somma(conOre.map(c => c.minutes));
	const importi = conOre.filter(c => c.amount !== undefined);
	const fuori = somma(r.unassigned.map(u => u.minutes));
	return componi([
		conOre.length ? `${cap(quale)}${inCorso ? ', fin qui' : ''}: ${elenco(conOre.slice(0, 5).map(c => `${c.nome} ${ore(c.minutes)}${c.amount !== undefined ? `, ${euroEsatti(c.amount)}` : ''}`))}.` : `A ${quale} non risultano ore per i clienti.`,
		conOre.length > 1 ? `In tutto ${ore(minuti)}${importi.length ? `, ${euroEsatti(somma(importi.map(c => c.amount ?? 0)))} da fatturare` : ''}.` : undefined,
		fuori ? `Fuori dai clienti: ${ore(fuori)}, soprattutto ${elenco(r.unassigned.slice(0, 2).map(u => u.name))}.` : undefined,
		conOre.length ? nota : undefined,
	]);
}

// --- posta e WhatsApp ---

type ProgettoPosta = StatoPostaMinimo['progetti'][number];

function progettoPosta(f: FontiStanze, st: StatoPostaMinimo, nome: string): { p?: Progetto; pp?: ProgettoPosta } {
	const p = risolvi(f, nome);
	const q = norma(nome);
	const pp = (p && st.progetti.find(x => x.path === p.path)) || st.progetti.find(x => q && norma(x.name).includes(q));
	return { p, pp };
}

const mittente = (da: string) => pulisci(da, 40) || 'un mittente senza nome';
const contatto = (c: { contatto: string; gruppo: boolean }) => (pulisci(c.contatto, 40) || (c.gruppo ? 'un gruppo' : 'un contatto senza nome')) + (c.gruppo ? ' (gruppo)' : '');

function frasiChat(pp: ProgettoPosta, now: number, anteprima: boolean): string[] {
	if (!pp.chat.length) return [];
	const out = [`Su WhatsApp: ${pp.chat.length === 1 ? 'una chat' : `${pp.chat.length} chat`}${pp.chatDaRispondere ? `, ${pp.chatDaRispondere} aspettano una tua risposta` : ''}.`];
	for (const c of pp.chat.slice(0, anteprima ? 4 : 3)) {
		const ultimo = c.mio ? 'hai scritto tu per ultimo' : anteprima && c.ultimo ? `ultimo: «${pulisci(c.ultimo, 60)}»` : 'ha scritto per ultimo';
		out.push(`${cap(contatto(c))}, ${quandoIso(c.data, now)}, ${ultimo}.`);
	}
	return out;
}

function leggiPosta(f: FontiStanze, a: Richiesta, now: number): string {
	const c = f.connettori?.();
	if (!c) return 'La stanza Connettori non è partita: la posta non è disponibile.';
	const st = c.statoPosta();
	if (!st.aggiornatoAt && !st.whatsapp.aggiornatoAt) return 'La posta non è ancora stata letta: aggiornala dalla stanza Connettori.';
	if (a.progetto) {
		const { p, pp } = progettoPosta(f, st, a.progetto);
		if (!pp) return `${p?.name ?? a.progetto} non ha indirizzi né numeri in rubrica: si aggiungono nella stanza Connettori.`;
		return componi([
			pp.fili.length
				? `Per ${pp.name}, negli ultimi ${st.giorni} giorni: ${pp.fili.length === 1 ? 'una mail' : `${pp.fili.length} mail`}${pp.nonLetti ? `, ${pp.nonLetti === 1 ? 'una non letta' : `${pp.nonLetti} non lette`}` : ''}.`
				: `Per ${pp.name} nessuna mail negli ultimi ${st.giorni} giorni.`,
			...pp.fili.slice(0, 4).map(x => `${cap(mittente(x.da))}, «${pulisci(x.oggetto, 70) || 'senza oggetto'}», ${quandoIso(x.data, now)}${x.nonLetto ? ', non letta' : ''}.`),
			...frasiChat(pp, now, false),
			st.errore ? `L'ultima lettura della posta non è riuscita: ${pulisci(st.errore, 100)}` : undefined,
			eta(st.aggiornatoAt, now),
		]);
	}
	const nonLetti = st.progetti.filter(x => x.nonLetti > 0);
	const fili = st.progetti
		.flatMap(x => x.fili.filter(m => m.nonLetto).map(m => ({ ...m, progetto: x.name })))
		.sort((x, y) => y.data.localeCompare(x.data));
	const conMail = st.progetti.filter(x => x.fili.length);
	return componi([
		nonLetti.length
			? `Mail non lette dei progetti, ultimi ${st.giorni} giorni: ${elenco(nonLetti.slice(0, 5).map(x => `${x.name} ${x.nonLetti}`))}.`
			: conMail.length
				? `Nessuna mail non letta dei progetti negli ultimi ${st.giorni} giorni.`
				: `Nessuna mail dei progetti negli ultimi ${st.giorni} giorni.`,
		...fili.slice(0, 4).map(x => `${cap(mittente(x.da))} per ${x.progetto}, «${pulisci(x.oggetto, 60) || 'senza oggetto'}», ${quandoIso(x.data, now)}.`),
		!nonLetti.length && conMail.length ? `Le ultime: ${elenco(conMail.slice(0, 3).map(x => `${x.name}, da ${mittente(x.fili[0].da)}`))}.` : undefined,
		st.daAssegnare.length ? `${st.daAssegnare.length === 1 ? 'Un mittente' : `${st.daAssegnare.length} mittenti`} da assegnare a un progetto.` : undefined,
		st.errore ? `L'ultima lettura non è riuscita: ${pulisci(st.errore, 100)}` : undefined,
		eta(st.aggiornatoAt, now),
	]);
}

function leggiWhatsapp(f: FontiStanze, a: Richiesta, now: number): string {
	const c = f.connettori?.();
	if (!c) return 'La stanza Connettori non è partita: WhatsApp non è disponibile.';
	const st = c.statoPosta();
	const wa = st.whatsapp;
	if (!wa.aggiornatoAt) return wa.errore ? `Le chat WhatsApp non si leggono: ${pulisci(wa.errore, 120)}` : 'Le chat WhatsApp non sono ancora state lette: aggiornale dalla stanza Connettori.';
	if (a.progetto) {
		const { p, pp } = progettoPosta(f, st, a.progetto);
		if (!pp) return `${p?.name ?? a.progetto} non ha numeri né gruppi in rubrica: si aggiungono nella stanza Connettori.`;
		const frasi = frasiChat(pp, now, true);
		return componi([frasi.length ? undefined : `Per ${pp.name} nessuna chat negli ultimi ${wa.giorni} giorni.`, ...frasi, eta(wa.aggiornatoAt, now)]);
	}
	const aspettano = st.progetti.filter(x => x.chatDaRispondere > 0);
	const ultime = st.progetti
		.flatMap(x => x.chat.filter(ch => !ch.mio).map(ch => ({ ...ch, progetto: x.name })))
		.sort((x, y) => y.data.localeCompare(x.data));
	return componi([
		aspettano.length ? `Chat che aspettano una tua risposta: ${elenco(aspettano.slice(0, 5).map(x => `${x.name} ${x.chatDaRispondere}`))}.` : `Nessuna chat dei progetti aspetta una risposta, negli ultimi ${wa.giorni} giorni.`,
		...ultime.slice(0, 3).map(x => `${cap(contatto(x))} per ${x.progetto}, ${quandoIso(x.data, now)}.`),
		wa.daAssegnare.length ? `${wa.daAssegnare.length === 1 ? 'Una chat' : `${wa.daAssegnare.length} chat`} da assegnare a un progetto.` : undefined,
		wa.errore ? `L'ultima lettura non è riuscita: ${pulisci(wa.errore, 100)}` : undefined,
		eta(wa.aggiornatoAt, now),
	]);
}

// --- cose da fare e memoria ---

async function leggiDaFare(f: FontiStanze, a: Richiesta, now: number): Promise<string> {
	const m = f.memoria?.();
	if (!m) return 'La Memoria non è disponibile.';
	if (a.progetto) {
		const p = risolvi(f, a.progetto);
		if (!p) return `Non trovo il progetto "${a.progetto}".`;
		const r = await conTempo(m.recent(p.name, { kinds: ['riassunto', 'nota'], limit: 3 }).catch(() => [] as MemoryItem[]));
		const sums = r === 'tempo' ? [] : r.filter(isSessionOutcome);
		if (!sums.length) return `La Memoria non ha ancora un riassunto di ${p.name}.`;
		const conLista = sums[0] && splitSummary(sums[0].text).todo.length ? sums[0] : undefined;
		if (!conLista) return `Nell'ultimo riassunto di ${p.name}, di ${quando(sums[0].createdAt, now)}, non è riportata una lista esplicita di cose da fare.`;
		const todo = splitSummary(conLista.text).todo;
		return componi([
			`${p.name}, dal riassunto di ${quando(conLista.createdAt, now)}: ${todo.length === 1 ? 'resta una cosa' : `restano ${todo.length} cose`}.`,
			...todo.slice(0, 5).map((t, i) => `${i + 1}: ${pulisci(t, 140)}${/[.!?]$/.test(t) ? '' : '.'}`),
			conLista !== sums[0] ? `Il riassunto dopo, di ${quando(sums[0].createdAt, now)}, non ha una lista.` : undefined,
		]);
	}
	const r = await conTempo(m.recent(undefined, { kinds: ['riassunto', 'nota'], limit: 60 }).catch(() => [] as MemoryItem[]));
	const tutti = r === 'tempo' ? [] : r.filter(isSessionOutcome);
	// l'ultimo riassunto di ogni progetto: la lista che conta e' quella
	const visti = new Set<string>();
	const righe: { progetto: string; at: number; todo: string[] }[] = [];
	for (const s of [...tutti].sort((x, y) => y.createdAt - x.createdAt)) {
		if (!s.project || visti.has(s.project)) continue;
		visti.add(s.project);
		const todo = splitSummary(s.text).todo;
		if (todo.length) righe.push({ progetto: s.project, at: s.createdAt, todo });
	}
	if (!righe.length) return tutti.length ? 'Negli ultimi riassunti della Memoria non è riportata una lista esplicita di cose da fare.' : 'La Memoria non ha ancora riassunti.';
	return componi([
		`Cose da fare in ${righe.length === 1 ? 'un progetto' : `${righe.length} progetti`}, dagli ultimi riassunti.`,
		...righe.slice(0, 5).map(x => `${x.progetto} (${quando(x.at, now)}): ${x.todo.slice(0, 2).map(t => pulisci(t, 90)).join('; ')}${x.todo.length > 2 ? `, e altre ${x.todo.length - 2}` : ''}.`),
	]);
}

async function leggiMemoria(f: FontiStanze, a: Richiesta, now: number): Promise<string> {
	const m = f.memoria?.();
	if (!m) return 'La Memoria non è disponibile.';
	const p = risolvi(f, a.progetto);
	if (a.progetto && !p) return `Non trovo il progetto "${a.progetto}".`;
	const [dec, bac] = await Promise.all([
		conTempo(m.recent(p?.name, { kinds: ['decisione', 'nota'], limit: 5 }).catch(() => [] as MemoryItem[])),
		conTempo(m.bacheca(p?.name, 120).catch(() => [] as BoardItem[])),
	]);
	const decisioni = dec === 'tempo' ? [] : dec;
	const bacheca = bac === 'tempo' ? [] : bac;
	const perProgetto = new Map<string, BoardItem>();
	for (const b of [...bacheca].sort((x, y) => y.at - x.at)) if (!perProgetto.has(b.project)) perProgetto.set(b.project, b);
	return componi([
		bacheca.length
			? `Nelle ultime due ore ${p ? `su ${p.name} ` : ''}le sessioni hanno scritto ${bacheca.length} ${bacheca.length === 1 ? 'nota' : 'note'} sulla bacheca.`
			: `Nelle ultime due ore nessuna sessione ${p ? `su ${p.name} ` : ''}ha scritto sulla bacheca.`,
		...[...perProgetto.values()].slice(0, 3).map(b => `${p ? 'Ultima' : `${b.project}, ultima`}: ${pulisci(b.summary, 120)}`),
		decisioni.length ? `Decisioni e note recenti${p ? '' : ' di tutti i progetti'}:` : undefined,
		...decisioni.slice(0, 4).map(d => `${p ? '' : `${d.project}, `}${quando(d.createdAt, now)}: ${pulisci(d.title || d.text.split('\n')[0], 120)}.`),
	]);
}

// --- connettori e notte ---

function leggiConnettori(f: FontiStanze, _a: Richiesta, now: number): string {
	const c = f.connettori?.();
	if (!c) return 'La stanza Connettori non è partita.';
	const st = c.statoConnettori();
	if (!st.connettori.length) return st.aggiornando ? 'Sto leggendo i connettori di Claude Code: riprova tra poco.' : 'Non vedo connettori in Claude Code.';
	const connessi = st.connettori.filter(x => x.stato === 'connesso');
	const altri = st.connettori.filter(x => x.stato !== 'connesso' && x.stato !== 'sconosciuto');
	const d = st.deleghe;
	return componi([
		`Connettori: ${st.connettori.length}, ${connessi.length} connessi, ${st.connettori.filter(x => x.diretto).length} diretti e gratis.`,
		altri.length ? `Da sistemare: ${elenco(altri.slice(0, 5).map(x => `${x.nome} ${x.stato}`))}.` : 'Nessuno da sistemare.',
		`Deleghe a Claude oggi: spesi ${dollari(d.spesaOggi)} su ${dollari(d.tetto)}${d.inCorso ? ', una in corso' : ''}${d.coda.length ? `, ${d.coda.length} in coda` : ''}.`,
		st.errore ? `L'ultima lettura non è riuscita: ${pulisci(st.errore, 100)}` : undefined,
		st.aggiornatoAt && now - st.aggiornatoAt > GIORNO ? eta(st.aggiornatoAt, now) : undefined,
	]);
}

function leggiNotte(f: FontiStanze): string {
	const n = f.notte?.();
	if (!n) return 'La coda della notte non è disponibile.';
	const r = n.report;
	return componi([
		`La notte va dalle ${n.from} alle ${n.to}, ${n.parallel === 1 ? 'un lavoro' : `${n.parallel} lavori`} alla volta.`,
		n.queued || n.running ? `In fila: ${n.queued}, in corso: ${n.running}.` : 'Nessun lavoro in fila per stanotte.',
		n.why ? pulisci(n.why, 160) : undefined,
		r && r.jobs.length ? `L'ultima notte, ${giornoDetto(r.date)}: ${elenco(r.jobs.slice(0, 4).map(j => `${j.project} ${j.status}`))}.` : undefined,
		...(r?.jobs ?? []).filter(j => j.summary).slice(0, 2).map(j => `${j.project}: ${pulisci(j.summary!, 140)}`),
	]);
}

// ---------- i due strumenti ----------

export async function leggiStanza(a: { stanza: unknown; progetto?: string; periodo?: number; mese?: string }, f: FontiStanze | undefined = fonti): Promise<string> {
	if (!f) return 'Le stanze non sono pronte.';
	const now = f.ora ? f.ora() : Date.now();
	const s = stanzaDa(a.stanza);
	const r: Richiesta = { progetto: a.progetto ? String(a.progetto).trim() || undefined : undefined, periodo: a.periodo, mese: a.mese };
	try {
		switch (s) {
			case 'cruscotto': return await leggiCruscotto(f, r, now);
			case 'appstore': return leggiAppStore(f, r, now);
			case 'vedetta': return leggiVedetta(f, r, now);
			case 'siti': return leggiSiti(f, r, now);
			case 'clienti': return await leggiClienti(f, r, now);
			case 'posta': return leggiPosta(f, r, now);
			case 'whatsapp': return leggiWhatsapp(f, r, now);
			case 'dafare': return await leggiDaFare(f, r, now);
			case 'memoria': return await leggiMemoria(f, r, now);
			case 'connettori': return leggiConnettori(f, r, now);
			case 'notte': return leggiNotte(f);
			default:
				return `Non conosco la stanza "${a.stanza}". Ci sono: ${STANZE.join(', ')}.`;
		}
	} catch (e: any) {
		return `Non sono riuscita a leggere la stanza: ${pulisci(String(e?.message ?? e), 160)}`;
	}
}

/** La vista della plancia di ogni stanza (media/plancia.js, VIEWS) e come si chiama a voce. */
const VISTE: Record<string, [view: string, nome: string]> = {
	cruscotto: ['cruscotto', 'il cruscotto'],
	appstore: ['appstore', 'la stanza App Store'],
	vedetta: ['vedetta', 'la Vedetta'],
	siti: ['vercel', 'la stanza Vercel'],
	clienti: ['clienti', 'la stanza Clienti'],
	posta: ['connettori', 'i Connettori, con la posta'],
	whatsapp: ['connettori', 'i Connettori, con WhatsApp'],
	connettori: ['connettori', 'i Connettori'],
	dafare: ['plancia', 'la plancia'],
	memoria: ['memoria', 'la Memoria'],
	notte: ['lavori', 'i Lavori, con la coda della notte'],
	lavori: ['lavori', 'i Lavori'],
	plancia: ['plancia', 'la plancia'],
	melissa: ['melissa', 'la stanza di Melissa'],
};

export async function mostraStanza(a: { stanza: unknown; progetto?: string }, f: FontiStanze | undefined = fonti): Promise<string> {
	if (!f) return 'Le stanze non sono pronte.';
	const s = stanzaDa(a.stanza);
	if (s === 'osservatorio') {
		if (!f.osservatorio) return "L'Osservatorio non è disponibile.";
		await f.osservatorio();
		return "Ho aperto l'Osservatorio.";
	}
	const v = s ? VISTE[s] : undefined;
	if (!v) return `Non conosco la stanza "${a.stanza}". Ci sono: ${Object.keys(VISTE).join(', ')}, osservatorio.`;
	const p = risolvi(f, a.progetto);
	if (s === 'cruscotto') {
		f.mostra('cruscotto');
		if (p) f.send({ type: 'crus.focus', path: p.path });
	} else {
		f.mostra(v[0], p && v[0] === 'plancia' ? p.path : undefined);
	}
	const su = p && (s === 'cruscotto' || v[0] === 'plancia') ? ` su ${p.name}` : '';
	const nonTrovato = a.progetto && !p ? ` Non trovo il progetto "${a.progetto}".` : '';
	return `Ho aperto ${v[1]}${su}.${nonTrovato}`;
}

// ---------- le specifiche per Melissa ----------

function obj(properties: any, required: string[] = []): any {
	return { type: 'object', properties, required, additionalProperties: false };
}

export const STRUMENTI_STANZE: Record<string, StrumentoStanza> = {
	stanza_leggi: {
		spec: {
			type: 'function',
			function: {
				name: 'stanza_leggi',
				description:
					'Legge una stanza della plancia e restituisce un riassunto gia\' pronto da dire a voce, dagli stessi dati che Andrea vede: gratis, subito, nessuna chiamata di rete. Ripeti i numeri come arrivano, senza aggiungerne. ' +
					'Stanze: cruscotto (ore tue e di Claude, sessioni, token, valore a listino, per progetto e periodo), appstore (solo per un mese preciso, "a settembre", "il mese scorso": per ieri, la settimana, il mese o l\'anno in corso e per i buchi da sistemare usa app_guadagni), ' +
					'vedetta (semaforo delle regole), siti (pubblicazioni su Vercel), clienti (ore per cliente e quanto fatturare nel mese), dafare (le cose rimaste da fare, dai riassunti della Memoria), memoria (decisioni recenti, cosa scrivono le sessioni), ' +
					'posta e whatsapp (chi ha scritto per un progetto), connettori (stato e spesa delle deleghe), notte (coda e resoconto della notte). ' +
					'Esempi: "quante ore ho fatto su Woofmap questa settimana" (cruscotto, Woofmap, 7), "quanto ho guadagnato a settembre" (appstore, mese settembre), ' +
					'"cosa mi resta da fare sulla Bottega" (dafare, Bottega), "chi mi ha scritto per CheckIn Facile" (posta, CheckIn Facile), "quali mail non lette ho dei clienti" (posta), ' +
					'"quanto devo fatturare a quel cliente questo mese" (clienti, con il nome del cliente o di un suo progetto), "i siti sono tutti su?" (siti). ' +
					'posta e whatsapp SOLO se Andrea chiede esplicitamente di mail, messaggi o di chi gli ha scritto, mai di tua iniziativa: danno nomi, oggetti e anteprime brevi. Se vuole anche vedere, chiama stanza_mostra.',
				parameters: obj(
					{
						stanza: { type: 'string', enum: [...STANZE], description: 'quale stanza leggere' },
						progetto: { type: 'string', description: 'un progetto, un\'app (per appstore) o un cliente (per clienti); senza, il quadro di tutto' },
						periodo: { type: 'number', description: 'giorni: 1 (oggi; ieri per appstore), 7, 30, 90 o 365. Predefinito 7 per il cruscotto, 30 per appstore' },
						mese: { type: 'string', description: 'un mese preciso per appstore, clienti e cruscotto: "2026-09", "settembre", "mese scorso"' },
					},
					['stanza'],
				),
			},
		},
		run: a => leggiStanza(a),
	},
	stanza_mostra: {
		spec: {
			type: 'function',
			function: {
				name: 'stanza_mostra',
				description:
					'Porta la Home su una stanza: cruscotto, appstore, vedetta, siti, clienti, posta, whatsapp, connettori, dafare, memoria, notte, lavori, plancia, melissa, oppure apre l\'Osservatorio (osservatorio). ' +
					'Con progetto il cruscotto si accende su quel progetto e la plancia lo mette in evidenza. Usalo per "fammi vedere l\'App Store", "apri la Vedetta", "mostrami i clienti", "apri l\'Osservatorio". Solo la vista: per dire le cifre usa stanza_leggi.',
				parameters: obj({ stanza: { type: 'string', description: 'la stanza da mostrare' }, progetto: { type: 'string', description: 'un progetto da mettere in evidenza' } }, ['stanza']),
			},
		},
		run: async (a, ctx) => {
			const r = await mostraStanza(a);
			if (r.startsWith('Ho aperto')) ctx?.azione?.(r.split('.')[0]);
			return r;
		},
	},
};
