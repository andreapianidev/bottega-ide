// Gli impegni di Andrea, per Krista (docs/CONTRATTI.md 9.11, «Ognuno ha la memoria del suo mestiere»): dalle frasi che
// dice a voce ("domani faccio...", "entro venerdi'...", "dopo lo sistemo") l'impegno con la scadenza, e quando dice di
// averne fatto uno, quello diventa fatto. Estrazione sempre con DeepSeek Flash, mai Agnes (20 richieste al minuto
// condivise con tutte le app di Andrea), breve e asincrona: mai sul percorso della voce, una alla volta, e solo per le
// frasi che sembrano parlare di un impegno. Le voci vanno nello spool della Memoria come eventi `source: "mestiere"`.

import type { LlmStreamFn } from './assistant';
import { chiDelMestiere } from './personaggi';
import type { MemoriaPersonaggio, RegistraMemoria, VoceMestiere } from './memoria-personaggi';

/** Una frase che puo' contenere un impegno o la notizia di averlo fatto: le altre non costano niente. */
export const FORSE_IMPEGNO =
	/\b(?:domani|dopodomani|stasera|stanotte|stamattina|oggi pomeriggio|entro|luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica|(?:la )?settimana prossima|fine settimana|weekend|dopo (?:lo|la|li|le|ci|ne)|pi[uù] tardi|faccio|finisco|sistemo|chiudo|mando|preparo|consegno|devo|dovrei|prometto|ho fatto|l'ho fatto|fatto|finito|ho finito|ho chiuso|ho mandato|ho consegnato|ho sistemato)\b/i;

/** DeepSeek ha al piu' questo per rispondere: oltre, la frase si lascia stare. */
export const IMPEGNI_MS = 8000;

export interface ImpegniDeps {
	registra?: RegistraMemoria;
	/** lo stream di DeepSeek Flash, o undefined senza chiave DeepSeek (e allora niente impegni) */
	deepseek(): LlmStreamFn | undefined;
	/** la memoria di chi ha `impegni` (Krista), per sapere quali sono aperti */
	memoria(chi: string): Promise<MemoriaPersonaggio>;
	now?: () => number;
	log?: (riga: string) => void;
}

/** Il prompt: oggi, gli impegni aperti con il loro id, cosa estrarre. Solo JSON. */
export function promptImpegni(oggi: Date, aperti: readonly VoceMestiere[]): string {
	const data = oggi.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
	const iso = isoGiorno(oggi.getTime());
	const elenco = aperti.length ? aperti.map(v => `- ${v.id}: ${v.testo}${v.scadenza ? `, per il ${isoGiorno(v.scadenza)}` : ''}`).join('\n') : '(nessuno)';
	return `Oggi e' ${data} (${iso}). Andrea parla a voce con la sua assistente. Impegni che ha gia' preso e non ha ancora fatto (id: cosa):\n${elenco}\n` +
		'Dalla frase di Andrea decidi due cose. "nuovo": un impegno che Andrea prende lui, adesso, di fare qualcosa ("domani faccio il backup", ' +
		'"entro venerdi\' finisco la grafica", "dopo lo sistemo"): "cosa" in poche parole, all\'infinito ("fare il backup"); "scadenza" la data che dice, ' +
		'come AAAA-MM-GG ("dopo", "piu\' tardi", "stasera" valgono oggi; senza data, null). Una domanda, un desiderio vago o una cosa che deve fare ' +
		'qualcun altro non sono impegni: null. "fatti": gli id degli impegni qui sopra che Andrea dice di aver fatto ("ho fatto il backup"), ' +
		'altrimenti []. Rispondi solo con il JSON, nient\'altro: {"nuovo": {"cosa": "...", "scadenza": "AAAA-MM-GG" o null} o null, "fatti": [id]}';
}

/** "2026-10-09", ora locale. */
export function isoGiorno(at: number): string {
	const d = new Date(at);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** La risposta di DeepSeek: l'impegno nuovo (scadenza alle 23:59 di quel giorno, ora locale) e i fatti fra gli aperti. */
export function leggiImpegni(testo: string, aperti: readonly VoceMestiere[]): { nuovo: { cosa: string; scadenza: number | null } | null; fatti: VoceMestiere[] } | null {
	const j = testo.match(/\{[\s\S]*\}/)?.[0];
	if (!j) return null;
	let x: any;
	try {
		x = JSON.parse(j);
	} catch {
		return null;
	}
	if (!x || typeof x !== 'object') return null;
	const cosa = typeof x.nuovo?.cosa === 'string' ? x.nuovo.cosa.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
	const m = typeof x.nuovo?.scadenza === 'string' ? x.nuovo.scadenza.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
	const scadenza = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 0).getTime() : null;
	const ids = new Set((Array.isArray(x.fatti) ? x.fatti : []).map((v: unknown) => String(v)));
	return { nuovo: cosa ? { cosa, scadenza: Number.isFinite(scadenza) ? scadenza : null } : null, fatti: aperti.filter(v => ids.has(v.id)) };
}

export class Impegni {
	private inCorso = false;
	private prossima?: { frase: string; cwd?: string };
	private seq = 0;
	constructor(private readonly d: ImpegniDeps) {}

	/** Una frase di Andrea: se puo' parlare di un impegno, la si guarda dopo, in silenzio. Mai un errore, mai un'attesa. */
	ascolta(frase: string, cwd?: string): void {
		const t = (frase || '').replace(/\s+/g, ' ').trim();
		if (t.length < 8 || !FORSE_IMPEGNO.test(t) || !chiDelMestiere('impegni') || !this.d.deepseek()) return;
		// una alla volta: se ne arriva un'altra mentre DeepSeek pensa, si tiene l'ultima
		if (this.inCorso) {
			this.prossima = { frase: t, cwd };
			return;
		}
		this.inCorso = true;
		void this.guarda(t, cwd).catch(() => undefined).finally(() => {
			this.inCorso = false;
			const p = this.prossima;
			this.prossima = undefined;
			if (p) this.ascolta(p.frase, p.cwd);
		});
	}

	private async guarda(frase: string, cwd?: string): Promise<void> {
		const chi = chiDelMestiere('impegni');
		const stream = this.d.deepseek();
		if (!chi || !stream) return;
		const now = this.d.now?.() ?? Date.now();
		const aperti = ((await this.d.memoria(chi)).mestiere?.voci ?? []).filter(v => v.stato === 'aperto');
		const ac = new AbortController();
		let testo = '';
		let scade: ReturnType<typeof setTimeout> | undefined;
		try {
			const r = stream([{ role: 'system', content: promptImpegni(new Date(now), aperti) }, { role: 'user', content: frase }], [], dl => (testo += dl.content ?? ''), ac.signal);
			r.catch(() => undefined);
			await Promise.race([r, new Promise((_, no) => (scade = setTimeout(() => (ac.abort(), no(new Error('tempo scaduto'))), IMPEGNI_MS)))]);
		} catch {
			return;
		} finally {
			clearTimeout(scade);
		}
		const esito = leggiImpegni(testo, aperti);
		if (!esito) return;
		const scrivi = (id: string, cosa: string, stato: 'aperto' | 'fatto', scadenza: number | null) =>
			void this.d.registra?.({ source: 'mestiere', sid: chi, id, ...(cwd ? { cwd } : {}), at: now, text: cosa, tipo: 'impegno', cosa: 'impegno', stato, ...(scadenza ? { scadenza } : {}) })?.catch(() => undefined);
		if (esito.nuovo) {
			scrivi(`impegno-${now}-${++this.seq}`, esito.nuovo.cosa, 'aperto', esito.nuovo.scadenza);
			this.d.log?.(`impegni: nuovo per ${chi}, «${esito.nuovo.cosa}»${esito.nuovo.scadenza ? ` per il ${isoGiorno(esito.nuovo.scadenza)}` : ''}`);
		}
		for (const v of esito.fatti) {
			scrivi(v.id, v.testo, 'fatto', v.scadenza ?? null);
			this.d.log?.(`impegni: fatto «${v.testo}»`);
		}
	}
}
