// L'aspetto della sfera per chi parla (CONTRATTI 9.11, «La sfera di chi parla»). Melissa e' una sfera con i colori di
// sempre; ogni personaggio ha una forma e un colore suoi, dal campo `sfera` del suo file in personaggi/, o, se manca,
// scelti dalla chiave in modo deterministico (mai la sfera, che e' di Melissa). L'emozione della battuta da' un valore
// di agitazione da 0 a 1: forma, rotazione e luce lo seguono.
// Le stesse regole stanno nel Nucleo (nucleo/Sources/Voice/ChiParla.swift, SferaAspetto) e in Avo Agency AI: chi le
// cambia qui le cambia anche li'.

export const FORME = ['sfera', 'cubo', 'rombo', 'stella'] as const;
export type Forma = (typeof FORME)[number];

export interface AspettoSfera {
	forma: Forma;
	/** '#RRGGBB', maiuscolo */
	colore: string;
}

/** L'agitazione di una battuta senza emozioni riconosciute. */
export const AGITAZIONE_NEUTRA = 0.3;

/** FNV-1a a 32 bit sui byte UTF-8: lo stesso numero nel Nucleo e in Avo. */
export function fnv1a(t: string): number {
	let h = 0x811c9dc5;
	for (const b of Buffer.from(t, 'utf8')) {
		h ^= b;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/** Tonalita' 0..360, saturazione e valore 0..1 -> '#RRGGBB'. */
function hsvHex(tono: number, s: number, v: number): string {
	const c = v * s;
	const x = c * (1 - Math.abs(((tono / 60) % 2) - 1));
	const m = v - c;
	const [r, g, b] = tono < 60 ? [c, x, 0] : tono < 120 ? [x, c, 0] : tono < 180 ? [0, c, x] : tono < 240 ? [0, x, c] : tono < 300 ? [x, 0, c] : [c, 0, x];
	const h2 = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0').toUpperCase();
	return `#${h2(r)}${h2(g)}${h2(b)}`;
}

/** Per un personaggio senza campo `sfera`: forma = [cubo, rombo, stella][h % 3], tonalita' = (h >> 8) % 360, saturazione
 *  0,75, valore 1, con h = fnv1a(chiave). */
export function aspettoPredefinito(chiave: string): AspettoSfera {
	const h = fnv1a(chiave);
	const forme = ['cubo', 'rombo', 'stella'] as const;
	return { forma: forme[h % 3]!, colore: hsvHex((h >>> 8) % 360, 0.75, 1) };
}

/** Il campo `sfera` di un file: quello che e' valido si tiene, il resto viene dalla chiave. */
export function leggiSfera(x: any, chiave: string): AspettoSfera {
	const def = aspettoPredefinito(chiave);
	if (!x || typeof x !== 'object') return def;
	const forma = (FORME as readonly string[]).includes(x.forma) ? (x.forma as Forma) : def.forma;
	const colore = typeof x.colore === 'string' && /^#[0-9a-f]{6}$/i.test(x.colore.trim()) ? x.colore.trim().toUpperCase() : def.colore;
	return { forma, colore };
}

/** I tag audio di ElevenLabs e quanto agitano: alti allegria, eccitazione e allarme, bassi tristezza e sospiro. */
const TAG: Record<string, number> = {
	laughs: 0.85, laughing: 0.85, laugh: 0.85, giggles: 0.8, chuckles: 0.75, excited: 0.85, cheerful: 0.8, happy: 0.8,
	surprised: 0.85, gasps: 0.9, gasp: 0.9, shouts: 0.95, shouting: 0.95, angry: 0.95, furious: 0.95,
	sad: 0.05, crying: 0.05, sighs: 0.1, sigh: 0.1, exhales: 0.1, whispers: 0.1, whispering: 0.1, tired: 0.1,
};
const PAROLE_ALTE = /\b(?:ah(?:ah)+|evviva|fantastico|wow|urr[aà]|aiuto|attento|attenzione|allarme|cazzo)\b|!{2,}/i;
const PAROLE_BASSE = /\b(?:purtroppo|mi dispiace|che peccato|triste|uff+)\b/i;

/** L'agitazione di una battuta, 0..1: il primo tag audio che dice un'emozione, se no le parole (la prima che compare),
 *  se no AGITAZIONE_NEUTRA. */
export function agitazioneDi(testo: string): number {
	for (const m of String(testo || '').matchAll(/\[([a-z ]+)\]/gi)) {
		const v = TAG[m[1]!.trim().toLowerCase()];
		if (v !== undefined) return v;
	}
	const t = String(testo || '');
	const a = t.search(PAROLE_ALTE);
	const b = t.search(PAROLE_BASSE);
	if (a >= 0 && (b < 0 || a <= b)) return 0.75;
	if (b >= 0) return 0.1;
	return AGITAZIONE_NEUTRA;
}
