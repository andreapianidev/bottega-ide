/* Cosa si dice mentre il modello pensa (docs/CONTRATTI.md, 9.11): l'intenzione di quello che Andrea ha detto, il
   nome da riprendere per l'eco, la frase da dire senza ripetere le ultime, e la risposta senza il suo intercalare
   iniziale. Modulo puro, senza vscode ne' file: le frasi stanno in personaggi/*.json (campo `riempitivi`) e le legge
   src/personaggi.ts; il giro e i tempi in assistant.ts. Stesse regole, regex comprese, della mod melissa
   (hooks/melissa.ts) e dell'iPhone (Voce/Riempitivi.swift). */

export type Gruppo = 'domanda' | 'ordine' | 'sfogo' | 'battuta' | 'chiacchiera' | 'lunga' | 'eco';
export type Intento = 'domanda' | 'ordine' | 'sfogo' | 'battuta' | 'chiacchiera';
export type Riempitivi = Partial<Record<Gruppo, string[]>>;

export const GRUPPI: readonly Gruppo[] = ['domanda', 'ordine', 'sfogo', 'battuta', 'chiacchiera', 'lunga', 'eco'];

/** Quando arriva un riempitivo, da quando la domanda parte verso il modello: il primo, poi due di `lunga`. */
export const RIEMPI_TEMPI = [900, 5000, 10000] as const;
/** Uno strumento che dura di piu', a risposta gia' partita, dice una frase di `lunga` (una volta per turno). */
export const RIEMPI_STRUMENTO_MS = 1500;
/** Quante frasi recenti si ricordano per ogni voce (ne bastano 3 per l'anti-ripetizione). */
export const RIEMPI_MEMORIA = 6;
/** Il Nucleo non tiene pronte le frasi piu' lunghe di cosi' (VoceCache.maxCaratteri). */
export const RIEMPI_MAX_CARATTERI = 120;

/** Il campo `riempitivi` di un file: solo i gruppi noti, solo testi non vuoti; undefined se non resta niente. */
export function leggiRiempitivi(x: unknown): Riempitivi | undefined {
	if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined;
	const r: Riempitivi = {};
	for (const g of GRUPPI) {
		const l = (x as Record<string, unknown>)[g];
		if (!Array.isArray(l)) continue;
		const frasi = l.filter((f): f is string => typeof f === 'string').map(f => f.trim()).filter(Boolean);
		if (frasi.length) r[g] = frasi;
	}
	return Object.keys(r).length ? r : undefined;
}

/** Le frasi che il Nucleo puo' tenere gia' pronte: tutti i gruppi tranne `eco` (cambia ogni volta), non troppo lunghe. */
export function daScaldare(r: Riempitivi | undefined): string[] {
	return GRUPPI.filter(g => g !== 'eco')
		.flatMap(g => r?.[g] ?? [])
		.filter(f => f.trim() && f.length <= RIEMPI_MAX_CARATTERI);
}

// \b in JavaScript e' solo ASCII: "perché" o "sì" non chiuderebbero mai una parola
const I = '(?<![\\p{L}\\p{N}])';
const F = '(?![\\p{L}\\p{N}])';
const SFOGO = new RegExp(`${I}(?:cazz|merd|porc[aoi]|orco|vaffa|che palle|non funziona|non va${F}|si e' rotto|si è rotto|odio|che schifo|stufo|incazz)`, 'iu');
const BATTUTA = new RegExp(`${I}(?:ah(?:ah)+|ha(?:ha)+|lol|scherz|rid[oei]${F}|battuta)`, 'iu');
const ORDINE = new RegExp(
	`^(?:\\p{L}+,\\s*)?(?:(?:dai|allora|ok|okay|senti|ehi|ascolta)[,\\s]+)*(?:fai|fammi|apri|metti|controlla|scrivi|lancia|manda|cerca|trova|leggi|dimmi|spiega|spiegami|ricordami|prepara|aggiungi|togli|cambia|sistema|guarda|chiama|prova|ferma|crea|calcola|traduci|riassumi|puoi|potresti|devi|voglio che|vorrei che|mi serve)${F}`,
	'iu',
);
const DOMANDA = new RegExp(
	`^(?:(?:e|ma|allora|senti)\\s+)?(?:come|perch[eé]|cosa|che cosa|quando|dove|quale|quali|quanto|quanti|quante|chi|sai|secondo te|ti ricordi|hai mai|c'e'|c'è|esiste)${F}`,
	'iu',
);

/** Cos'e' quello che Andrea ha detto, per il riempitivo che gli risponde: la prima regola che vale. */
export function intento(testo: string): Intento {
	const t = testo.trim().toLowerCase();
	if (SFOGO.test(t)) return 'sfogo';
	if (BATTUTA.test(t)) return 'battuta';
	if (ORDINE.test(t)) return 'ordine';
	if (t.endsWith('?') || DOMANDA.test(t)) return 'domanda';
	return 'chiacchiera';
}

/**
 * Il nome che Andrea ha tirato fuori, per un riempitivo che lo riprende («Talky? Mh, vediamo.»): la prima parola con
 * l'iniziale maiuscola che non apre una frase (il riconoscimento di Apple scrive i nomi propri con la maiuscola), di
 * almeno tre lettere, e nessuno di `esclusi` (Melissa, Andrea, i personaggi).
 */
export function tema(testo: string, esclusi: readonly string[] = []): string | null {
	const no = new Set(esclusi.map(x => x.toLowerCase()));
	for (const frase of testo.split(/(?<=[.!?…])\s+/)) {
		const parole = frase.trim().split(/\s+/);
		for (const p of parole.slice(1)) {
			const w = p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
			if (/^\p{Lu}[\p{L}\p{N}]{2,}$/u.test(w) && !no.has(w.toLowerCase())) return w;
		}
	}
	return null;
}

/**
 * Il riempitivo da dire adesso, con la voce di chi ha la chiamata: il suo gruppo dell'intenzione (o `lunga`), se e'
 * vuoto il suo `chiacchiera`, poi lo stesso gruppo di Melissa e il suo `chiacchiera`. Si escludono le ultime
 * min(3, n - 1) dette da quella voce (`recenti`: per l'eco, il modello). `caso` sceglie; con un nome in quello che
 * Andrea ha detto (solo per domanda, ordine e chiacchiera) e `caso2` < 0.25 e' un'eco. null se non c'e' niente da dire.
 */
export function scegliRiempitivo(
	propri: Riempitivi | undefined,
	diMelissa: Riempitivi,
	gruppo: Intento | 'lunga',
	recenti: readonly string[],
	o: { testo?: string; esclusi?: readonly string[]; caso?: number; caso2?: number } = {},
): { frase: string; modello: string } | null {
	const piena = (l: string[] | undefined) => (l ?? []).filter(x => x.trim().length > 0);
	const x = gruppo !== 'lunga' && gruppo !== 'sfogo' && gruppo !== 'battuta' ? tema(o.testo ?? '', o.esclusi) : null;
	const eco = piena(propri?.eco).length ? piena(propri?.eco) : piena(diMelissa.eco);
	let lista: string[];
	if (x && eco.length && (o.caso2 ?? Math.random()) < 0.25) lista = eco;
	else {
		lista = piena(propri?.[gruppo]);
		if (!lista.length) lista = piena(propri?.chiacchiera);
		if (!lista.length) lista = piena(diMelissa[gruppo]);
		if (!lista.length) lista = piena(diMelissa.chiacchiera);
	}
	if (!lista.length) return null;
	const k = Math.min(3, lista.length - 1);
	const fuori = k > 0 ? recenti.slice(-k) : [];
	const candidati = lista.filter(f => !fuori.includes(f));
	const da = candidati.length ? candidati : lista;
	const modello = da[Math.min(da.length - 1, Math.floor((o.caso ?? Math.random()) * da.length))]!;
	return { frase: x ? modello.replace(/\{x\}/g, x) : modello, modello };
}

const ATTACCO = /^(?:mh+|m+h|uhm+|ehm+|allora|dunque|vediamo|ok|okay|beh|be'|bah|ah|eh|oh|ecco|si|sì)\s*[,.!…:]+\s*/iu;

/** Dopo un riempitivo, la risposta senza il suo «Allora,» o «Mh.» iniziale: sarebbe detto due volte. */
export function senzaAttacco(testo: string): string {
	let t = testo.trim();
	for (let i = 0; i < 2; i++) t = t.replace(ATTACCO, '');
	if (!/[\p{L}\p{N}]/u.test(t)) return testo;
	return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Vero per una frase fatta solo di intercalare («Mh.», «Allora, vediamo.»): nella voce, che va a frasi, dopo un
 *  riempitivo si salta e l'intercalare si toglie dalla frase dopo. */
export function soloAttacco(testo: string): boolean {
	let t = testo.trim();
	for (let i = 0; i < 2; i++) t = t.replace(ATTACCO, '');
	return t !== testo.trim() && !/[\p{L}\p{N}]/u.test(t);
}
