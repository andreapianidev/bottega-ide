import { execFile } from 'child_process';
import { Invio, Push, tokenMorto } from './apns';
import type { CampoToken, Dispositivo } from './dispositivo';
import type { WorkItem } from './jobs';
import type { Livello } from './tipi';

/* Quando e cosa mandare all'iPhone (docs/CONTRATTI.md, 9.4). Una classe senza rete ne' orologio propri: riceve
   istantanee del lavoro, di Melissa e del semaforo, e produce invii attraverso `Invio` (il client APNs, o un finto
   nei test). Il primo minuto e' la linea di partenza: quello che c'e' gia' quando la Bottega si apre (le sessioni
   arrivano con la prima scansione, non subito) non suona.

     ATTESA    una sessione passa a «ti aspetta»     una volta per passaggio, non piu' di una ogni 10 min per sessione
     FINITO    un lavoro della Bottega esce dalla lista mentre era «in corso»
     CONFERMA  Melissa aspetta un si' o un no
     REGOLA    un progetto passa a rosso nel semaforo
     NEGOZIO   un allarme della stanza App Store: crollo dei guadagni, riempimento a picco, app non piu' approvata
   Le notifiche partono solo con Andrea lontano dal Mac (bottega.iphone.avvisi). Con Andrea al Mac ATTESA, FINITO e
   REGOLA le ha gia' viste (allontanandosi non gli arriva una raffica per ogni sessione ferma); solo CONFERMA aspetta
   che si allontani, finche' la domanda resta aperta, e porta il suo numero: l'app lo rimanda col si' o col no.
   Live Activity e widget seguono il lavoro anche con Andrea al Mac. La Live Activity vive finche' ci sono sessioni
   AL LAVORO: le sessioni ferme in attesa contano come «ti aspetta» tutto il giorno e non la terrebbero mai chiusa.

   I testi passano dai server di Apple: nome del progetto e una frase breve, mai codice. */

export type ModoAvvisi = 'lontano' | 'sempre' | 'mai';

export interface RegolaProgetto {
	path: string;
	progetto: string;
	livello: Livello;
	/** La frase del primo problema rosso. */
	frase?: string;
}

export interface Istantanea {
	lavori: WorkItem[];
	conti: { inCorso: number; tiAspetta: number; vive: number };
	/** La domanda di Melissa in attesa di un si' o un no, con il suo numero. */
	conferma?: { id: number; testo: string };
	/** La sessione che Andrea segue dalla scheda dell'iPhone (9.5): il suo ultimo passo va nella Live Activity. */
	segui?: { progetto: string; passo: string; stato: string };
	/** Il semaforo; null finche' non ha fatto il primo controllo. */
	regole?: RegolaProgetto[] | null;
	/** Gli allarmi della stanza App Store delle ultime 48 ore; null finche' non ha letto (src/appstore.ts). */
	negozio?: AllarmeNegozio[] | null;
}

/** Un allarme della stanza App Store: l'id cambia a ogni fatto nuovo (contiene il giorno), quindi suona una volta. */
export interface AllarmeNegozio {
	id: string;
	app: string;
	testo: string;
}

export interface AvvisiDeps {
	istantanea(): Istantanea;
	invio: Invio;
	dispositivo(): Dispositivo | null;
	togliToken(campo: CampoToken, token: string): void;
	modo(): ModoAvvisi;
	/** Millisecondi dall'ultimo tasto o movimento del mouse. */
	inattivoMs(): Promise<number>;
	/** Il nome del Mac, negli attributi della Live Activity. */
	mac: string;
	ora?: () => number;
	log?: (riga: string) => void;
	/** Quanto dura la linea di partenza (60 s): i passaggi visti in questo tempo non suonano. */
	quieteMs?: number;
}

export const LONTANO_MS = 2 * 60_000;
export const ATTESA_OGNI_MS = 10 * 60_000;
export const LA_OGNI_MS = 15_000;
export const LA_RINFRESCO_MS = 10 * 60_000;
export const LA_STALE_MS = 15 * 60_000;
export const LA_FINE_MS = 2 * 60_000;
export const LA_CONGEDO_MS = 5 * 60_000;
/** iOS chiude una Live Activity dopo 8 ore. APNs risponde 200 anche al token di un'attivita' chiusa: oltre questo
 *  tempo il token si considera morto e si riparte con quello di avvio. */
export const LA_VITA_MS = 8 * 60 * 60_000;
/** Un token di attivita' arrivato entro questo tempo da un nostro push-to-start e' di un'attivita' partita da qui. */
const LA_NOSTRA_MS = 10 * 60_000;
export const WIDGET_OGNI_MS = 5 * 60_000;

/** Testo per una notifica: niente lineette lunghe o medie, niente apici del codice, spazi raccolti, corto. */
export function pulisci(s: string, max = 90): string {
	const t = String(s ?? '')
		.replace(/\s*[\u2014\u2013]\s*/g, ', ')
		.replace(/`+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

interface Attesa {
	avvisata: boolean;
}

export class Avvisi {
	private nato?: number;
	private prec = new Map<string, WorkItem>();
	private readonly attese = new Map<string, Attesa>();
	private readonly ultimaAttesa = new Map<string, number>();
	private conferma?: { id: number; testo: string; avvisata: boolean };
	/** Dopo un invio fallito (non per un token morto) le notifiche si riprovano, ma non prima di un minuto. */
	private pausaFino = -Infinity;
	private livelli?: Map<string, Livello>;
	private allarmiVisti?: Set<string>;
	private la = { avviata: false, tentata: -Infinity, ultimoInvio: -Infinity, firma: '', tiAspetta: -1, vuotoDal: undefined as number | undefined, token: '', da: 0, nostra: false };
	private wg = { ultimo: -Infinity, inCorso: 0, tiAspetta: 0 };
	private corsa?: Promise<void>;
	private ancora = false;
	private readonly ora: () => number;
	private readonly log: (riga: string) => void;

	constructor(private readonly d: AvvisiDeps) {
		this.ora = d.ora ?? Date.now;
		this.log = d.log ?? (() => undefined);
	}

	/** Il ponte si riaccende dopo essere stato spento: il primo minuto torna a fare da linea di partenza, cosi' non
	 *  suona tutto quello che e' cambiato nel frattempo. */
	riparti(): void {
		this.nato = undefined;
	}

	/** Un giro sull'istantanea di adesso. Mai due insieme: se ne arriva un altro durante, si rifa' alla fine. */
	aggiorna(): Promise<void> {
		if (this.corsa) {
			this.ancora = true;
			return this.corsa;
		}
		this.corsa = (async () => {
			do {
				this.ancora = false;
				try {
					await this.giro();
				} catch (e: any) {
					this.log(`avvisi: ${e?.message ?? e}`);
				}
			} while (this.ancora);
			this.corsa = undefined;
		})();
		return this.corsa;
	}

	private async giro(): Promise<void> {
		const now = this.ora();
		const ist = this.d.istantanea();
		this.nato ??= now;
		const primo = now === this.nato || now - this.nato < (this.d.quieteMs ?? 60_000);

		// --- cosa e' successo dall'ultimo giro ---
		const ora = new Map(ist.lavori.map(w => [w.key, w]));
		for (const w of ist.lavori) {
			if (w.status !== 'ti aspetta') this.attese.delete(w.key);
			else if (!this.attese.has(w.key)) this.attese.set(w.key, { avvisata: primo });
		}
		for (const k of [...this.attese.keys()]) if (!ora.has(k)) this.attese.delete(k);
		const finiti = primo ? [] : [...this.prec.values()].filter(w => w.source === 'bottega' && w.status === 'in corso' && !ora.has(w.key));
		this.prec = ora;

		if (!ist.conferma) this.conferma = undefined;
		else if (ist.conferma.id !== this.conferma?.id) this.conferma = { ...ist.conferma, avvisata: primo };

		const rossi: RegolaProgetto[] = [];
		if (ist.regole) {
			if (this.livelli && !primo) for (const r of ist.regole) if (r.livello === 'rosso' && this.livelli.get(r.path) !== 'rosso') rossi.push(r);
			this.livelli = new Map(ist.regole.map(r => [r.path, r.livello]));
		}
		// gli allarmi del negozio: suona quello che non c'era al giro prima (alla partenza nessuno)
		const negozio: AllarmeNegozio[] = [];
		if (ist.negozio) {
			if (this.allarmiVisti && !primo) for (const a of ist.negozio) if (!this.allarmiVisti.has(a.id)) negozio.push(a);
			this.allarmiVisti = new Set(ist.negozio.map(a => a.id));
		}

		const disp = this.d.dispositivo();
		if (primo) this.wg = { ultimo: -Infinity, inCorso: ist.conti.inCorso, tiAspetta: ist.conti.tiAspetta };
		if (!disp) return;
		await this.notifiche(disp, ist, now, finiti, rossi, negozio);
		await this.attivita(this.d.dispositivo() ?? disp, ist, now);
		await this.widget(this.d.dispositivo() ?? disp, ist, now);
	}

	// ---------- notifiche ----------

	private async notifiche(disp: Dispositivo, ist: Istantanea, now: number, finiti: WorkItem[], rossi: RegolaProgetto[], negozio: AllarmeNegozio[] = []): Promise<void> {
		const modo = this.d.modo();
		if (modo === 'mai' || !disp.token || now < this.pausaFino) return;
		const attese = ist.lavori.filter(w => {
			const a = this.attese.get(w.key);
			return a && !a.avvisata && now - (this.ultimaAttesa.get(w.key) ?? -Infinity) >= ATTESA_OGNI_MS;
		});
		const conferma = this.conferma && !this.conferma.avvisata ? this.conferma : undefined;
		if (!attese.length && !conferma && !finiti.length && !rossi.length && !negozio.length) return;
		if (modo === 'lontano' && (await this.d.inattivoMs()) <= LONTANO_MS) {
			// al Mac: chi ti aspetta lo vedi li', FINITO e REGOLA pure; NEGOZIO e' gia' una notifica del Mac; resta solo la CONFERMA
			for (const w of attese) this.attese.get(w.key)!.avvisata = true;
			return;
		}

		const token = disp.token;
		/** Vero se si puo' continuare; un errore di rete rimette in coda quello che non e' partito. */
		const manda = async (payload: object, scadenza: number, annulla: () => void) => {
			const e = await this.manda('token', { tipo: 'alert', token, ambiente: disp.ambiente, priorita: 10, scadenza: Math.floor(scadenza / 1000), payload });
			if (e.ok) return true;
			if (!tokenMorto(e)) {
				annulla();
				this.pausaFino = now + 60_000;
			}
			return false;
		};
		if (conferma) {
			conferma.avvisata = true;
			const vivo = await manda(
				{ aps: { alert: { title: 'Melissa', body: pulisci(conferma.testo, 160) }, sound: 'default', category: 'CONFERMA', 'interruption-level': 'time-sensitive' }, conferma: conferma.id },
				now + 10 * 60_000,
				() => (conferma.avvisata = false),
			);
			if (!vivo) return;
		}
		for (const w of attese) {
			const a = this.attese.get(w.key)!;
			const prima = this.ultimaAttesa.get(w.key);
			a.avvisata = true;
			this.ultimaAttesa.set(w.key, now);
			const progetto = pulisci(w.project, 40) || 'Bottega';
			const titolo = pulisci(w.title, 80);
			const vivo = await manda(
				{
					aps: { alert: { title: progetto, body: titolo ? `Ti aspetta: ${titolo}` : 'Una sessione ti aspetta' }, sound: 'default', category: 'ATTESA', 'thread-id': progetto, 'interruption-level': 'time-sensitive' },
					chiave: w.key,
					...(w.jobId ? { jobId: w.jobId } : {}),
				},
				now + 60 * 60_000,
				() => {
					a.avvisata = false;
					if (prima === undefined) this.ultimaAttesa.delete(w.key);
					else this.ultimaAttesa.set(w.key, prima);
				},
			);
			if (!vivo) return;
		}
		for (const w of finiti) {
			const progetto = pulisci(w.project, 40) || 'Bottega';
			const titolo = pulisci(w.title, 80);
			const vivo = await manda({ aps: { alert: { title: progetto, body: titolo ? `Ha finito: ${titolo}` : 'Il lavoro ha finito' }, category: 'FINITO', 'thread-id': progetto } }, now + 60 * 60_000, () => undefined);
			if (!vivo) return;
		}
		for (const r of rossi) {
			const vivo = await manda({ aps: { alert: { title: pulisci(r.progetto, 40), body: pulisci(r.frase || 'Il semaforo è rosso.', 140) }, category: 'REGOLA' } }, now + 24 * 3600_000, () => undefined);
			if (!vivo) return;
		}
		for (const a of negozio.slice(0, 3)) {
			const vivo = await manda({ aps: { alert: { title: pulisci(a.app, 40), body: pulisci(a.testo, 160) }, 'thread-id': 'appstore' } }, now + 24 * 3600_000, () => undefined);
			if (!vivo) return;
		}
	}

	// ---------- Live Activity ----------

	private async attivita(disp: Dispositivo, ist: Istantanea, now: number): Promise<void> {
		// una sessione seguita dall'iPhone tiene viva l'attivita' anche quando aspetta (o e' l'unica)
		const attive = ist.conti.inCorso + (ist.segui ? 1 : 0);
		if (attive > 0) this.la.vuotoDal = undefined;
		else this.la.vuotoDal ??= now;
		const finita = this.la.vuotoDal !== undefined && now - this.la.vuotoDal >= LA_FINE_MS;
		const sec = Math.floor(now / 1000);
		const stato = this.contenuto(ist, now);
		const firma = JSON.stringify({ ...stato, aggiornato: 0 });

		// Il token dell'attivita' e' cambiato. Se l'iPhone toglie quello di un'attivita' che non abbiamo fatto partire
		// noi (ereditata dal file: app reinstallata, Bottega riaperta) si puo' ripartire subito; solo un'attivita'
		// partita da qui e chiusa a mano da Andrea aspetta un giro senza sessioni.
		const tok = disp.attivita ?? '';
		if (tok !== this.la.token) {
			if (this.la.token && !tok && !this.la.nostra) this.la.avviata = false;
			this.la.nostra = !!tok && now - this.la.tentata < LA_NOSTRA_MS;
			this.la.token = tok;
			this.la.da = now;
		}
		if (disp.attivita && now - this.la.da >= LA_VITA_MS) {
			// oltre le 8 ore iOS l'ha gia' chiusa: il token non serve piu', si riparte con quello di avvio
			this.log(`avvisi: la Live Activity ha passato le 8 ore, ne faccio partire una nuova`);
			this.d.togliToken('attivita', disp.attivita);
			this.la = { ...this.la, avviata: false, firma: '', tiAspetta: -1, ultimoInvio: -Infinity, token: '', nostra: false };
			return;
		}

		if (disp.attivita) {
			this.la.avviata = true;
			if (finita) {
				if (now - this.la.ultimoInvio < LA_OGNI_MS) return;
				this.la.ultimoInvio = now;
				const vuoto = { inCorso: 0, tiAspetta: 0, vive: ist.conti.vive, righe: [], aggiornato: now };
				const e = await this.manda('attivita', {
					tipo: 'liveactivity', token: disp.attivita, ambiente: disp.ambiente, priorita: 10,
					payload: { aps: { timestamp: sec, event: 'end', 'content-state': vuoto, 'dismissal-date': Math.floor((now + LA_CONGEDO_MS) / 1000) } },
				});
				if (!e.ok) return; // rete giu': si riprova tra 15 s (un token morto e' gia' stato tolto)
				this.d.togliToken('attivita', disp.attivita); // dopo la fine quel token non serve piu'
				this.la = { ...this.la, avviata: false, firma: '', tiAspetta: -1, ultimoInvio: -Infinity };
				return;
			}
			const cambiata = firma !== this.la.firma || now - this.la.ultimoInvio >= LA_RINFRESCO_MS;
			if (!cambiata || now - this.la.ultimoInvio < LA_OGNI_MS) return;
			const priorita = stato.tiAspetta !== this.la.tiAspetta ? 10 : 5;
			this.la.ultimoInvio = now;
			const e = await this.manda('attivita', {
				tipo: 'liveactivity', token: disp.attivita, ambiente: disp.ambiente, priorita,
				payload: { aps: { timestamp: sec, event: 'update', 'content-state': stato, 'stale-date': Math.floor((now + LA_STALE_MS) / 1000) } },
			});
			// solo se e' arrivato: un errore di rete riprova al giro dopo i 15 s
			if (e.ok) {
				this.la.firma = firma;
				this.la.tiAspetta = stato.tiAspetta;
			}
			return;
		}

		if (finita) this.la.avviata = false; // un giro senza sessioni chiude il ciclo: la prossima volta riparte
		if (attive === 0 || !disp.avvio || this.la.avviata || now - this.la.tentata < LA_FINE_MS) return;
		this.la.tentata = now;
		const n = ist.conti.inCorso;
		const e = await this.manda('avvio', {
			tipo: 'liveactivity', token: disp.avvio, ambiente: disp.ambiente, priorita: 10,
			payload: {
				aps: {
					timestamp: sec, event: 'start', 'content-state': stato, 'attributes-type': 'BottegaAttivita', attributes: { mac: this.d.mac },
					alert: { title: 'Bottega', body: n === 0 && ist.segui ? `Segui ${pulisci(ist.segui.progetto, 40)}` : n === 1 ? '1 sessione Claude al lavoro' : `${n} sessioni Claude al lavoro` },
				},
			},
		});
		if (e.ok) {
			// chiusa a mano dall'iPhone mentre il lavoro continua, non riparte: solo dopo un giro senza sessioni
			this.la.avviata = true;
			this.la.ultimoInvio = now;
			this.la.firma = firma;
			this.la.tiAspetta = stato.tiAspetta;
		}
	}

	private contenuto(ist: Istantanea, now: number) {
		const righe = ist.lavori
			.filter(w => w.status === 'ti aspetta' || w.status === 'in corso')
			.sort((a, b) => (a.status === b.status ? 0 : a.status === 'ti aspetta' ? -1 : 1))
			.slice(0, 3)
			.map(w => ({ progetto: pulisci(w.project, 40), stato: w.status, da: w.since }));
		// `segui` e' facoltativo: le Live Activity di prima lo ignorano
		const segui = ist.segui ? { segui: { progetto: pulisci(ist.segui.progetto, 40), passo: pulisci(ist.segui.passo, 60), stato: ist.segui.stato } } : {};
		return { inCorso: ist.conti.inCorso, tiAspetta: ist.conti.tiAspetta, vive: ist.conti.vive, righe, ...segui, aggiornato: now };
	}

	// ---------- widget ----------

	private async widget(disp: Dispositivo, ist: Istantanea, now: number): Promise<void> {
		if (!disp.widget) return;
		const { inCorso, tiAspetta } = ist.conti;
		if (inCorso === this.wg.inCorso && tiAspetta === this.wg.tiAspetta) return;
		if (now - this.wg.ultimo < WIDGET_OGNI_MS && tiAspetta <= this.wg.tiAspetta) return;
		const e = await this.manda('widget', {
			tipo: 'widgets', token: disp.widget, ambiente: disp.ambiente, priorita: 5, scadenza: Math.floor((now + 15 * 60_000) / 1000),
			payload: { aps: { 'content-changed': true } },
		});
		this.wg = e.ok ? { ultimo: now, inCorso, tiAspetta } : { ...this.wg, ultimo: now };
	}

	private async manda(campo: CampoToken, p: Push) {
		const e = await this.d.invio.manda(p);
		if (tokenMorto(e)) {
			this.log(`avvisi: APNs dice che il token ${campo} non vale piu' (${e.status} ${e.reason ?? ''}), lo tolgo`);
			this.d.togliToken(campo, p.token);
		}
		return e;
	}
}

/** Da quanto non si tocca tastiera o mouse (HIDIdleTime, in nanosecondi), letto al massimo ogni 20 secondi. */
export function inattivitaHID(ora: () => number = Date.now): () => Promise<number> {
	let letto = -Infinity;
	let valore = 0;
	let incorso: Promise<number> | undefined;
	return () => {
		if (ora() - letto < 20_000) return Promise.resolve(valore);
		incorso ??= new Promise<number>(resolve => {
			execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 4000, maxBuffer: 8 << 20 }, (err, out) => {
				const m = err ? null : /"HIDIdleTime"\s*=\s*(\d+)/.exec(out);
				// senza lettura si fa come se Andrea fosse al Mac: meglio una notifica in meno che una di troppo
				valore = m ? Number(m[1]) / 1e6 : 0;
				letto = ora();
				incorso = undefined;
				resolve(valore);
			});
		});
		return incorso;
	};
}
