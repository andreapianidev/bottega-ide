/* Crediti e consumi dei servizi, giorno per giorno (CONTRATTI, sezione 14).

   I servizi non danno lo storico con le chiavi che abbiamo: DeepSeek solo il saldo (/user/balance), ElevenLabs il
   conteggio del mese solo con il permesso user_read. Quindi la Bottega legge il saldo ogni 30 minuti mentre e' aperta
   e tiene lei i giorni: quanto e' sceso il saldo e' la spesa, quanto e' salito e' una ricarica. OpenRouter c'era fino
   alla build 60: tolto insieme ai suoi cervelli. Se la Bottega resta chiusa per giorni, la spesa di quei giorni cade sul giorno della lettura
   dopo. In piu': i caratteri di voce per giorno (il Nucleo, usage.json), le richieste ad Agnes (contate dalla Bottega)
   e la spesa delle deleghe a Claude (~/.bottega/connettori/spesa.json).

   Il file ~/.bottega/conti/giorni.json lo leggono anche i widget dell'iPhone: si scrive intero, tmp + rename, 600.
   Sotto 2 $ o con meno di 5 giorni al ritmo attuale il servizio va in "attesa" e parte un avviso, uno al giorno,
   sul Mac e sull'iPhone (come gli allarmi della stanza App Store). */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { giornoLocale, scriviPrivato } from './delega';

export type ServizioId = 'deepseek' | 'elevenlabs' | 'agnes';
export type Tono = 'ok' | 'attesa' | 'male';

export interface ServizioSaldo {
	nome: string;
	valuta: 'USD';
	saldo: number;
	letto: number;
	/** spesa media al giorno sugli ultimi 7 giorni con dati; null con meno di 2 giorni */
	mediaGiorno: number | null;
	giorniRimasti: number | null;
	tono: Tono;
	frase: string;
}

export interface ServizioVoce {
	nome: string;
	unita: 'caratteri';
	usatiMese: number;
	limiteMese: number | null;
	rinnovo: string | null;
	tono: Tono;
	frase: string;
}

export interface ServizioGratis {
	nome: string;
	gratis: true;
	tono: Tono;
	frase: string;
}

export interface GiornoConti {
	deepseek?: { speso: number; ricarica: number; saldo: number };
	elevenlabs?: { caratteri: number };
	agnes?: { richieste: number };
	deleghe?: { usd: number };
}

export interface ContiFile {
	schema: 1;
	aggiornato: number;
	servizi: { deepseek?: ServizioSaldo; elevenlabs?: ServizioVoce; agnes?: ServizioGratis };
	giorni: Record<string, GiornoConti>;
	/** l'ultima lettura di ogni saldo: da li' si conta la prossima differenza */
	campioni?: { deepseek?: { at: number; saldo: number } };
}

/** Un avviso di ricarica: stessa forma degli allarmi del negozio (avvisi.ts), l'id contiene il giorno. */
export interface AllarmeConto {
	id: string;
	app: string;
	testo: string;
}

export interface ContiOpzioni {
	chiave(p: 'deepseek'): string | undefined;
	/** richieste ad Agnes di oggi, contate dalla Bottega (cervelli.ts) */
	agnesOggi(): number;
	file?: string;
	spesaFile?: string;
	usageFile?: string;
	secretsDir?: string;
	fetch?: typeof fetch;
	now?: () => number;
	log?: (s: string) => void;
}

export const SOGLIA_USD = 2;
export const SOGLIA_GIORNI = 5;
const GIORNI_TENUTI = 400;
const RICARICHE: Record<'deepseek', string> = { deepseek: 'platform.deepseek.com' };

const tondo = (n: number) => Math.round(n * 10000) / 10000;
export const dollari = (n: number) => `${n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

function leggiJson(file: string): any {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

function leggiEnv(file: string): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		for (const r of fs.readFileSync(file, 'utf8').split('\n')) {
			const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(r);
			if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
		}
	} catch {
		// niente file, niente chiave
	}
	return out;
}

/** Media di spesa al giorno sugli ultimi 7 giorni che hanno dati per quel servizio (oggi compreso). */
export function mediaGiorno(giorni: Record<string, GiornoConti>, id: 'deepseek', oggi: string): number | null {
	const chiavi = Object.keys(giorni).filter(k => k <= oggi && giorni[k][id]).sort().slice(-7);
	if (chiavi.length < 2) return null;
	const tot = chiavi.reduce((s, k) => s + (giorni[k][id]!.speso || 0), 0);
	return tot / chiavi.length;
}

/** Saldo, ritmo e tono di un servizio a consumo, con la frase per la barra e per l'avviso. */
export function statoSaldo(nome: string, saldo: number, media: number | null, disponibile: boolean, letto: number): ServizioSaldo {
	const giorniRimasti = media && media > 0 ? Math.floor(saldo / media) : null;
	let tono: Tono = 'ok';
	if (!disponibile || saldo <= 0) tono = 'male';
	else if (saldo < SOGLIA_USD || (giorniRimasti !== null && giorniRimasti < SOGLIA_GIORNI)) tono = 'attesa';
	let frase: string;
	if (tono === 'male') frase = saldo <= 0 ? `saldo ${dollari(saldo)}: va ricaricato` : `restano ${dollari(saldo)} ma non è disponibile: va ricaricato`;
	else {
		frase = `restano ${dollari(saldo)}`;
		if (giorniRimasti !== null) frase += giorniRimasti < 1 ? ', meno di un giorno al ritmo attuale' : `, circa ${giorniRimasti === 1 ? 'un giorno' : `${giorniRimasti} giorni`} al ritmo attuale`;
	}
	return { nome, valuta: 'USD', saldo: tondo(saldo), letto, mediaGiorno: media === null ? null : tondo(media), giorniRimasti, tono, frase };
}

/** Una lettura nuova del saldo: la discesa e' spesa, la salita una ricarica, sul giorno della lettura. */
export function registraSaldo(g: GiornoConti, id: 'deepseek', prima: number | undefined, ora: number, speso?: number, ricarica?: number): void {
	const v = g[id] ?? { speso: 0, ricarica: 0, saldo: ora };
	if (speso !== undefined || ricarica !== undefined) {
		v.speso = tondo(v.speso + Math.max(0, speso ?? 0));
		v.ricarica = tondo(v.ricarica + Math.max(0, ricarica ?? 0));
	} else if (prima !== undefined) {
		const d = prima - ora;
		if (d > 0) v.speso = tondo(v.speso + d);
		else if (d < 0) v.ricarica = tondo(v.ricarica - d);
	}
	v.saldo = tondo(ora);
	g[id] = v;
}

export class Conti {
	private readonly fetchFn: typeof fetch;
	private readonly now: () => number;
	private dati: ContiFile;
	private corsa: Promise<ContiFile> | undefined;
	private ascoltatori: ((nuovi: AllarmeConto[]) => void)[] = [];
	private allarmiVisti = new Set<string>();

	constructor(private readonly o: ContiOpzioni) {
		this.fetchFn = o.fetch ?? fetch;
		this.now = o.now ?? Date.now;
		const d = leggiJson(this.file());
		this.dati = d && d.schema === 1 && d.giorni ? d : { schema: 1, aggiornato: 0, servizi: {}, giorni: {} };
		// OpenRouter tolto (build 61): via saldo, campione e giorni dal file scritto dalla build 59 e 60
		delete (this.dati.servizi as any).openrouter;
		if (this.dati.campioni) delete (this.dati.campioni as any).openrouter;
		for (const [k, g] of Object.entries(this.dati.giorni)) {
			delete (g as any).openrouter;
			if (!Object.keys(g).length) delete this.dati.giorni[k];
		}
		// gli avvisi di oggi gia' dati prima di un riavvio non suonano di nuovo
		for (const a of this.allarmi()) this.allarmiVisti.add(a.id);
	}

	file(): string {
		return this.o.file ?? path.join(os.homedir(), '.bottega', 'conti', 'giorni.json');
	}

	stato(): ContiFile {
		return this.dati;
	}

	/** Chi vuole sapere degli avvisi nuovi (la notifica del Mac). */
	onAllarmi(cb: (nuovi: AllarmeConto[]) => void): void {
		this.ascoltatori.push(cb);
	}

	/** Gli avvisi di oggi: un servizio a pagamento in attesa o senza credito, la voce oltre il 90% del mese. */
	allarmi(): AllarmeConto[] {
		const oggi = giornoLocale(this.now());
		const out: AllarmeConto[] = [];
		for (const id of ['deepseek'] as const) {
			const s = this.dati.servizi[id];
			if (s && s.tono !== 'ok') out.push({ id: `conti:${id}:${oggi}`, app: s.nome, testo: `${cap(s.frase)}. Si ricarica su ${RICARICHE[id]}.` });
		}
		const v = this.dati.servizi.elevenlabs;
		if (v && v.tono !== 'ok') out.push({ id: `conti:elevenlabs:${oggi}`, app: v.nome, testo: `${cap(v.frase)}.` });
		return out;
	}

	/** Legge i saldi e i contatori, aggiorna i giorni, scrive il file. Una lettura alla volta. */
	aggiorna(): Promise<ContiFile> {
		this.corsa ??= this.leggiTutto().finally(() => (this.corsa = undefined));
		return this.corsa;
	}

	private async leggiTutto(): Promise<ContiFile> {
		const now = this.now();
		const oggi = giornoLocale(now);
		const d = this.dati;
		const g = (d.giorni[oggi] ??= {});
		d.campioni ??= {};

		// DeepSeek
		const kd = this.o.chiave('deepseek');
		if (kd) {
			try {
				const r = await this.fetchFn('https://api.deepseek.com/user/balance', { headers: { authorization: `Bearer ${kd}` } });
				const j: any = r.ok ? await r.json() : null;
				const usd = j?.balance_infos?.find((x: any) => x.currency === 'USD') ?? j?.balance_infos?.[0];
				if (usd) {
					const saldo = Number(usd.total_balance);
					registraSaldo(g, 'deepseek', d.campioni.deepseek?.saldo, saldo);
					d.campioni.deepseek = { at: now, saldo };
					d.servizi.deepseek = statoSaldo('DeepSeek', saldo, mediaGiorno(d.giorni, 'deepseek', oggi), !!j.is_available, now);
				}
			} catch (e: any) {
				this.o.log?.(`conti: DeepSeek non risponde (${e?.message ?? e})`);
			}
		}

		// ElevenLabs: i caratteri per giorno li conta il Nucleo; il mese vero dal servizio, se la chiave puo' leggerlo
		const u = leggiJson(this.o.usageFile ?? path.join(os.homedir(), '.bottega', 'nucleo', 'usage.json'));
		const perGiorno: Record<string, number> = u?.elevenLabsCharsByDay ?? {};
		for (const [k, n] of Object.entries(perGiorno)) if (Number(n) > 0) (d.giorni[k] ??= {}).elevenlabs = { caratteri: Number(n) };
		const mese = oggi.slice(0, 7);
		let usatiMese = Number(u?.elevenLabsCharsByMonth?.[mese] ?? 0);
		let limiteMese: number | null = null;
		let rinnovo: string | null = null;
		const kv = process.env.ELEVENLABS_API_KEY || leggiEnv(path.join(this.o.secretsDir ?? path.join(os.homedir(), '.secrets'), 'elevenlabs.env')).ELEVENLABS_API_KEY;
		if (kv) {
			try {
				const r = await this.fetchFn('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': kv } });
				// 401 senza il permesso user_read: resta il conteggio della Bottega
				if (r.ok) {
					const j: any = await r.json();
					if (Number.isFinite(Number(j.character_count))) usatiMese = Number(j.character_count);
					if (Number(j.character_limit) > 0) limiteMese = Number(j.character_limit);
					if (j.next_character_count_reset_unix) rinnovo = giornoLocale(Number(j.next_character_count_reset_unix) * 1000);
				}
			} catch {
				// senza rete resta il conteggio della Bottega
			}
		}
		if (kv || usatiMese) d.servizi.elevenlabs = statoVoce(usatiMese, limiteMese, rinnovo, now);

		// Agnes: gratis, si contano le richieste
		const richieste = this.o.agnesOggi();
		if (richieste > 0) g.agnes = { richieste: Math.max(richieste, g.agnes?.richieste ?? 0) };
		const n = g.agnes?.richieste ?? 0;
		d.servizi.agnes = { nome: 'Agnes', gratis: true, tono: 'ok', frase: `gratis, ${n === 1 ? 'una richiesta' : `${n} richieste`} oggi` };

		// le deleghe a Claude (claude -p), spesa vera in dollari
		const spesa = leggiJson(this.o.spesaFile ?? path.join(os.homedir(), '.bottega', 'connettori', 'spesa.json'));
		for (const [k, usd] of Object.entries<number>(spesa?.giorni ?? {})) if (Number(usd) > 0) (d.giorni[k] ??= {}).deleghe = { usd: tondo(Number(usd)) };

		if (!Object.keys(g).length) delete d.giorni[oggi];
		const chiavi = Object.keys(d.giorni).sort();
		for (const k of chiavi.slice(0, Math.max(0, chiavi.length - GIORNI_TENUTI))) delete d.giorni[k];
		d.aggiornato = now;
		try {
			scriviPrivato(this.file(), d);
		} catch (e: any) {
			this.o.log?.(`conti: non riesco a scrivere ${this.file()}: ${e?.message ?? e}`);
		}

		const nuovi = this.allarmi().filter(a => !this.allarmiVisti.has(a.id));
		for (const a of nuovi) this.allarmiVisti.add(a.id);
		if (nuovi.length) for (const cb of this.ascoltatori) cb(nuovi);
		return d;
	}
}

export function statoVoce(usatiMese: number, limiteMese: number | null, rinnovo: string | null, now: number): ServizioVoce {
	const mese = new Date(now).toLocaleDateString('it-IT', { month: 'long' });
	const usati = usatiMese.toLocaleString('it-IT');
	let tono: Tono = 'ok';
	let frase = `${usati} caratteri di voce a ${mese}`;
	if (limiteMese) {
		const resto = Math.max(0, limiteMese - usatiMese);
		frase = `${usati} caratteri su ${limiteMese.toLocaleString('it-IT')} a ${mese}, ne restano ${resto.toLocaleString('it-IT')}`;
		if (rinnovo) frase += ` fino al ${rinnovo.slice(8, 10).replace(/^0/, '')}/${rinnovo.slice(5, 7).replace(/^0/, '')}`;
		if (resto <= 0) tono = 'male';
		else if (usatiMese / limiteMese > 0.9) tono = 'attesa';
	} else frase += ', contati dalla Bottega';
	return { nome: 'ElevenLabs', unita: 'caratteri', usatiMese, limiteMese, rinnovo, tono, frase };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
