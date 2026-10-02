/* La memoria della stanza App Store (docs/CONTRATTI.md, 13.6): quando e' comparso ogni buco, quali sono stati
   risolti (e con che numeri prima e dopo), quali Andrea ha deciso di ignorare e perche', e gli allarmi gia' dati.
   Funzioni pure sul file ~/.bottega/appstore/storia.json, provate da test/appstore.cjs.

   Un buco sparisce in due modi diversi: perche' e' stato risolto, o perche' la sua fonte non ha risposto (AdMob giu',
   report di Apple non arrivato). Il secondo caso non e' una soluzione: un buco si chiude solo se la sua fonte e' stata
   letta in questo giro. */

export type FonteBuco = 'admob' | 'store' | 'codice' | 'abbonamenti' | 'scheda';

export interface VoceStoria {
	id: string;
	chiave: string;
	app: string;
	titolo: string;
	fonte: FonteBuco;
	projectPath?: string;
	primaVolta: number;
	ultimaVolta: number;
	stato: 'aperto' | 'risolto' | 'ignorato';
	/** La misura del buco quando e' comparso (una quota tra 0 e 1, per i buchi che ne hanno una). */
	misuraPrima?: number;
	misuraDopo?: number;
	/** Quando e' stato risolto o ignorato. */
	quando?: number;
	motivo?: string;
}

export interface Storia {
	schema: 1;
	voci: Record<string, VoceStoria>;
	/** Lo stato di approvazione di ogni app su AdMob all'ultima lettura: un cambio verso il peggio e' un allarme. */
	approvazioni: Record<string, string>;
	/** Allarmi gia' dati: id -> quando. Non si ripetono per 7 giorni. */
	allarmi: Record<string, number>;
	/** La prima lettura: i buchi trovati quel giorno c'erano gia', non sono «nuovi» per il briefing. */
	natoAt?: number;
}

export const storiaVuota = (): Storia => ({ schema: 1, voci: {}, approvazioni: {}, allarmi: {} });

/** Quello che serve di un buco per la storia (la forma completa e' Buco in appstore.ts). */
export interface BucoMinimo {
	id: string;
	chiave: string;
	app: string;
	titolo: string;
	fonte: FonteBuco;
	misura?: number;
	projectPath?: string;
	daQuando?: number;
}

export interface BucoChiuso {
	id: string;
	chiave: string;
	app: string;
	titolo: string;
	quando: number;
	daQuando: number;
	motivo?: string;
	prima?: number;
	dopo?: number;
	projectPath?: string;
}

const GIORNO = 86_400_000;

/** Aggiorna la storia con i buchi trovati adesso. Restituisce i buchi da mostrare (senza gli ignorati, con
 *  daQuando), i risolti degli ultimi 60 giorni e gli ignorati. `misure` sono le misure attuali per id, anche dei
 *  buchi che non scattano piu': servono a dire «dal 9% al 41%». */
export function applicaStoria<T extends BucoMinimo>(
	buchi: T[],
	storia: Storia,
	now: number,
	fontiLette: Set<FonteBuco>,
	misure: Record<string, number> = {},
): { buchi: T[]; risolti: BucoChiuso[]; ignorati: BucoChiuso[] } {
	storia.natoAt ??= now;
	const visti = new Set<string>();
	const mostrati: T[] = [];
	for (const b of buchi) {
		visti.add(b.id);
		let v = storia.voci[b.id];
		if (!v || v.stato === 'risolto') {
			// nuovo, o tornato dopo essere stato risolto: riparte da adesso
			v = { id: b.id, chiave: b.chiave, app: b.app, titolo: b.titolo, fonte: b.fonte, projectPath: b.projectPath, primaVolta: now, ultimaVolta: now, stato: 'aperto', misuraPrima: b.misura };
			storia.voci[b.id] = v;
		}
		v.ultimaVolta = now;
		v.titolo = b.titolo;
		v.app = b.app;
		v.projectPath = b.projectPath;
		b.daQuando = v.primaVolta;
		if (v.stato !== 'ignorato') mostrati.push(b);
	}
	for (const v of Object.values(storia.voci)) {
		if (v.stato !== 'aperto' || visti.has(v.id) || !fontiLette.has(v.fonte)) continue;
		v.stato = 'risolto';
		v.quando = now;
		if (misure[v.id] !== undefined) v.misuraDopo = misure[v.id];
	}
	// i risolti vecchi si dimenticano; gli ignorati restano finche' Andrea non li ripristina
	for (const [id, v] of Object.entries(storia.voci)) if (v.stato === 'risolto' && now - (v.quando ?? 0) > 120 * GIORNO) delete storia.voci[id];
	for (const [id, t] of Object.entries(storia.allarmi)) if (now - t > 30 * GIORNO) delete storia.allarmi[id];

	const chiuso = (v: VoceStoria): BucoChiuso => ({
		id: v.id,
		chiave: v.chiave,
		app: v.app,
		titolo: v.titolo,
		quando: v.quando ?? v.ultimaVolta,
		daQuando: v.primaVolta,
		motivo: v.motivo,
		prima: v.misuraPrima,
		dopo: v.misuraDopo,
		projectPath: v.projectPath,
	});
	const tutte = Object.values(storia.voci);
	return {
		buchi: mostrati,
		risolti: tutte
			.filter(v => v.stato === 'risolto' && now - (v.quando ?? 0) <= 60 * GIORNO)
			.sort((a, b) => (b.quando ?? 0) - (a.quando ?? 0))
			.map(chiuso),
		ignorati: tutte.filter(v => v.stato === 'ignorato').sort((a, b) => (b.quando ?? 0) - (a.quando ?? 0)).map(chiuso),
	};
}

/** Andrea ignora un buco, con il motivo. Il buco deve essere nella storia (lo e' appena mostrato). */
export function ignora(storia: Storia, id: string, motivo: string, now: number): boolean {
	const v = storia.voci[id];
	if (!v) return false;
	v.stato = 'ignorato';
	v.motivo = motivo.trim().slice(0, 300) || undefined;
	v.quando = now;
	return true;
}

/** Un buco ignorato torna tra quelli da guardare (se c'e' ancora, ricompare alla prossima lettura). */
export function ripristina(storia: Storia, id: string): boolean {
	const v = storia.voci[id];
	if (!v || v.stato !== 'ignorato') return false;
	v.stato = 'aperto';
	v.motivo = undefined;
	v.quando = undefined;
	return true;
}

export interface Allarme {
	id: string;
	chiave: string;
	app: string;
	testo: string;
}

/** Gli allarmi nuovi: quelli che non sono stati dati negli ultimi 7 giorni. Li segna come dati. */
export function allarmiNuovi(allarmi: Allarme[], storia: Storia, now: number): Allarme[] {
	const out: Allarme[] = [];
	for (const a of allarmi) {
		const prima = storia.allarmi[a.id];
		if (prima !== undefined && now - prima < 7 * GIORNO) continue;
		storia.allarmi[a.id] = now;
		out.push(a);
	}
	return out;
}
