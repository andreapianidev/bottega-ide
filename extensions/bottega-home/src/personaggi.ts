// Darlene, Elliot e Krista nella barra di Melissa. Stanno in un file per personaggio in personaggi/ (fonte unica anche
// per la mod melissa di Claude Code e per la Bottega per iPhone): qui si leggono, e le regole su chi entra e quando. Il
// giro sta in assistant.ts.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Un file di personaggi/ (personaggi/LEGGIMI.md). */
export interface Personaggio {
	chiave: string;
	nome: string;
	ordine: number;
	/** ID della voce ElevenLabs, passato al Nucleo in `voice.speak {voice}` (build 120 e successive) */
	voce: string;
	carattere: string;
	saluti: string[];
	/** a cosa serve nella chiacchierata */
	ruolo: string;
	/** a cosa serve nella cronaca della mod */
	ruolo_cronaca: string;
	/** espressione regolare: se Andrea la dice, Melissa tira dentro questo personaggio ('' mai) */
	parole: string;
	parole_cronaca: string;
	errori_ripetuti: number;
}

/** Riempiti da `carica`: si leggono sempre questi due, mai una copia. */
export const PERSONAGGI: Record<string, Personaggio> = {};
export const ORDINE: string[] = [];
/** A cosa serve ciascuno nella chiacchierata (dal campo `ruolo`). */
export const RUOLI: Record<string, string> = {};

/** Dove stanno i file: quelli dell'estensione, poi la copia in ~/.bottega (quella che legge la mod). */
export function cartelle(): string[] {
	return [process.env.BOTTEGA_PERSONAGGI, path.join(__dirname, '..', 'personaggi'), path.join(os.homedir(), '.bottega', 'personaggi')]
		.filter((x): x is string => !!x);
}

/** Il testo preso alla lettera dentro un'espressione regolare. */
export function esc(t: string): string {
	return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Un'espressione regolare scritta in un file: '' se manca o non si compila (e lo si dice), mai un'eccezione dopo. */
function espressione(x: unknown, campo: string, n: string, avvisa: (msg: string) => void): string {
	if (x === undefined || x === null || x === '') return '';
	try {
		if (typeof x !== 'string') throw new Error('non e\' un testo');
		new RegExp(x, 'i');
		return x;
	} catch (e) {
		avvisa(`personaggi: ${n}, \`${campo}\` ignorato (${(e as Error).message})`);
		return '';
	}
}

/** Un file letto: i campi essenziali o niente; gli altri, se mancano, con il loro valore predefinito. */
function leggi(x: any, n: string, avvisa: (msg: string) => void): Personaggio {
	const testo = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
	const chiave = testo(x?.chiave);
	const saluti = Array.isArray(x?.saluti) ? x.saluti.map(testo).filter(Boolean) : [];
	if (!/^[a-z]+$/.test(chiave) || chiave === 'melissa' || !testo(x.nome) || !testo(x.voce) || !testo(x.carattere) || !saluti.length) {
		throw new Error('campi mancanti');
	}
	const nome = testo(x.nome);
	const ruolo = testo(x.ruolo) || nome;
	return {
		chiave,
		nome,
		ordine: typeof x.ordine === 'number' && Number.isFinite(x.ordine) ? x.ordine : 99,
		voce: testo(x.voce),
		carattere: testo(x.carattere),
		saluti,
		ruolo,
		ruolo_cronaca: testo(x.ruolo_cronaca) || ruolo,
		parole: espressione(x.parole, 'parole', n, avvisa),
		parole_cronaca: espressione(x.parole_cronaca, 'parole_cronaca', n, avvisa),
		errori_ripetuti: typeof x.errori_ripetuti === 'number' && x.errori_ripetuti > 0 ? Math.floor(x.errori_ripetuti) : 0,
	};
}

/** Legge un file per personaggio dalla prima cartella che ne ha. Un file rotto si salta e lo si dice. */
export function carica(dirs = cartelle(), avvisa: (msg: string) => void = () => undefined): number {
	for (const dir of dirs) {
		let nomi: string[];
		try {
			nomi = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort();
		} catch {
			continue;
		}
		const letti: Personaggio[] = [];
		for (const n of nomi) {
			try {
				const p = leggi(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')), n, avvisa);
				if (letti.some(q => q.chiave === p.chiave)) throw new Error(`chiave ${p.chiave} gia' usata`);
				letti.push(p);
			} catch (e) {
				avvisa(`personaggi: ${n} non si legge (${(e as Error).message})`);
			}
		}
		if (!letti.length) continue;
		for (const k of Object.keys(PERSONAGGI)) delete PERSONAGGI[k];
		for (const k of Object.keys(RUOLI)) delete RUOLI[k];
		ORDINE.length = 0;
		letti.sort((x, y) => x.ordine - y.ordine);
		for (const p of letti) {
			PERSONAGGI[p.chiave] = p;
			RUOLI[p.chiave] = p.ruolo;
			ORDINE.push(p.chiave);
		}
		return letti.length;
	}
	return 0;
}

/** Copia i file dell'estensione in ~/.bottega/personaggi, da dove li legge la mod melissa: solo quelli cambiati, e
 *  toglie i .json che nella sorgente non ci sono piu' (un personaggio rimosso non resta nella mod). Altri file no. */
export function pubblica(da: string, a = path.join(os.homedir(), '.bottega', 'personaggi')): number {
	let cambiati = 0;
	fs.mkdirSync(a, { recursive: true });
	const sorgente = fs.readdirSync(da).filter(x => x.endsWith('.json'));
	for (const n of sorgente) {
		const nuovo = fs.readFileSync(path.join(da, n));
		let vecchio: Buffer | undefined;
		try { vecchio = fs.readFileSync(path.join(a, n)); } catch { /* nuovo */ }
		if (vecchio && vecchio.equals(nuovo)) continue;
		fs.writeFileSync(path.join(a, n), nuovo);
		cambiati++;
	}
	for (const n of fs.readdirSync(a).filter(x => x.endsWith('.json') && !sorgente.includes(x))) {
		fs.rmSync(path.join(a, n), { force: true });
		cambiati++;
	}
	return cambiati;
}

carica();

/** Il nome da mostrare: "melissa" o la chiave di un personaggio. */
export function nomeDi(chi: string): string {
	return (Object.hasOwn(PERSONAGGI, chi) && PERSONAGGI[chi]?.nome) || 'Melissa';
}

/** Vero per una chiave caricata (mai per 'constructor' e simili). */
export function esiste(chi: unknown): chi is string {
	return typeof chi === 'string' && Object.hasOwn(PERSONAGGI, chi);
}

/** Chi c'e', in ordine, per la barra: dopo Melissa, un pulsante ciascuno. */
export function elenco(): { chiave: string; nome: string; ruolo: string }[] {
	return ORDINE.map(k => ({ chiave: k, nome: PERSONAGGI[k]!.nome, ruolo: RUOLI[k] ?? PERSONAGGI[k]!.nome }));
}

/** Una riga del registro: "Elliot: ..." e' di Elliot, il resto di Melissa. */
export function dallaRiga(riga: string): { chi: string; testo: string } {
	for (const k of ORDINE) {
		const pre = `${PERSONAGGI[k]!.nome}: `;
		if (riga.startsWith(pre)) return { chi: k, testo: riga.slice(pre.length) };
	}
	return { chi: 'melissa', testo: riga };
}

/** I nomi dei personaggi, con l'escape, per le espressioni regolari; e da un nome detto alla chiave. */
function nomi(): string {
	return ORDINE.map(k => esc(PERSONAGGI[k]!.nome.toLowerCase())).join('|') || '(?!)';
}
function chiaveDi(nome: string): string | null {
	return ORDINE.find(k => PERSONAGGI[k]!.nome.toLowerCase() === nome.toLowerCase()) ?? null;
}

/** "passami Darlene", "fammi parlare con Elliot", "ridammi Melissa": a chi passare la chiamata, o null. */
export function chiChiede(t: string): string | null {
	const m = t
		.toLowerCase()
		.match(new RegExp(`\\b(?:passami|passa|fammi parlare con|voglio parlare con|ridammi|torna|chiama)\\s+(?:a\\s+)?(melissa|${nomi()}|mr\\.?\\s*robot)\\b`));
	if (!m?.[1]) return null;
	if (m[1] === 'melissa') return 'melissa';
	return chiaveDi(m[1]) ?? (m[1].startsWith('mr') ? chiaveDi('elliot') : null);
}

/** "chiedi a Darlene", "sentiamo Elliot", "cosa ne pensa Krista": chi Andrea vuole sentire anche. */
export function ospiteChiesto(t: string): string | null {
	const m = t
		.toLowerCase()
		.match(new RegExp(`\\b(?:chiedi(?:lo)? a|chiedete a|sentiamo(?: anche)?|senti(?: anche)?|cosa ne pensa|che ne pensa|e tu)\\s+(${nomi()})\\b`));
	return m?.[1] ? chiaveDi(m[1]) : null;
}

/** Le chiavi caricate, per cercare il segnale "@chiave" e solo quello (un indirizzo email non e' un segnale). */
function chiavi(): string {
	return ORDINE.map(esc).join('|') || '(?!)';
}

/** Il testo senza il segnale "@darlene", che non si mostra e non si legge mai, ovunque sia. */
export function senzaSegnale(t: string): string {
	return t.replace(new RegExp(`\\s*(?<!\\w)@(?:${chiavi()})\\b[.!?]?`, 'gi'), '').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Durante lo stream: anche un segnale ancora a meta' in coda ("@dar") non si mostra. */
export function senzaSegnaleInCorso(t: string): string {
	return senzaSegnale(t).replace(/\s*@[a-z]*$/i, '');
}

/** Una risposta di Melissa puo' finire con "@darlene": il testo senza segnale e chi entra, se era tra gli offerti. */
export function chiamata(risposta: string, offerti: readonly string[]): { testo: string; ospite: string | null } {
	const testo = senzaSegnale(risposta);
	// senza segnale ma con una domanda per nome ("Elliot, tu che dici?"): risponde lui, o la domanda resta nel vuoto
	const segnale = risposta.match(new RegExp(`(?<!\\w)@(${chiavi()})\\b`, 'i'))?.[1]?.toLowerCase();
	const chi = segnale ?? chiamatoPerNome(testo);
	return { testo, ospite: chi && offerti.includes(chi) ? chi : null };
}

/**
 * Il personaggio a cui la battuta, alla fine, fa una domanda per nome; null se lo nomina e basta. Stessa regola della
 * mod e dell'iPhone, in ordine sul testo intero:
 * 1. vocativo a inizio frase: "Elliot, tu che dici?", "Elliot... che dici?", "Elliot! Che dici?";
 * 2. nome dopo una virgola, in fondo: "che ne pensi, Krista?";
 * 3. il nome da solo come domanda: "Darlene?".
 * "Ti ricordi quando Elliot ha bucato E Corp?" e "il file di Krista?" parlano di loro, non a loro.
 */
export function chiamatoPerNome(testo: string): string | null {
	if (!ORDINE.length) return null;
	const n = nomi();
	const fine = '\\s*\\?\\W{0,2}$';
	const regole = [
		`(?:^|[.!?\u2026]\\s*)(?:e\\s+)?(${n})\\s*(?:,|!|:|\\.{3}|\u2026)[^.!?\u2026]*${fine}`,
		`,\\s*(${n})${fine}`,
		`(?:^|[.!?\u2026]\\s*)(${n})${fine}`,
	];
	for (const r of regole) {
		const m = testo.match(new RegExp(r, 'i'));
		if (m?.[1]) return chiaveDi(m[1]);
	}
	return null;
}

/**
 * Chi Melissa puo' tirare dentro, da quello che Andrea ha appena detto: il primo personaggio, in ordine, le cui `parole`
 * compaiono (Elliot sulla sicurezza, Krista sulle scuse), altrimenti uno diverso dall'ultimo. Lo sceglie il codice:
 * lasciato al modello era sempre Darlene (misura del 6 ottobre 2026). `caso` in [0, 1).
 */
export function ospiteDellaFrase(detto: string, ultimo: string, caso = Math.random()): string | null {
	for (const k of ORDINE) {
		const parole = PERSONAGGI[k]?.parole;
		if (parole && new RegExp(parole, 'i').test(detto)) return k;
	}
	const altri = ORDINE.filter(k => k !== ultimo);
	const fra = altri.length ? altri : ORDINE;
	return fra[Math.min(fra.length - 1, Math.floor(caso * fra.length))] ?? null;
}

/**
 * Cosa si aggiunge al prompt di Melissa. `voluto`: chi Andrea ha chiesto di sentire. `scelto`: chi puo' tirare dentro
 * da sola. `vivo`: piu' risposte senza ospiti, quindi lo tira dentro adesso. Stesso testo della mod e dell'iPhone.
 */
export function invito(voluto: string | null, scelto: string | null, vivo: boolean): string {
	const v = voluto ? PERSONAGGI[voluto] : undefined;
	if (voluto && v) {
		return `Andrea vuole sentire anche ${v.nome}: rispondi tu e chiudi con una domanda rivolta a lei o a lui, poi scrivi alla fine, da sola, la parola @${voluto}.`;
	}
	const p = scelto ? PERSONAGGI[scelto] : undefined;
	if (!scelto || !p) return '';
	const chiudi = `chiudi con una domanda rivolta a ${p.nome} e scrivi alla fine, da sola, la parola @${scelto}`;
	return vivo
		? `Stavolta tira dentro ${p.nome} di Mr. Robot (${RUOLI[scelto] ?? p.nome}): trova l'aggancio in quello che ha detto Andrea, rispondi tu e ${chiudi}.`
		: `Con te c'e' anche ${p.nome} di Mr. Robot (${RUOLI[scelto] ?? p.nome}). Solo quando rende la chiacchierata piu' viva puoi tirarlo dentro: ${chiudi}. Di solito rispondi da sola.`;
}

/** Le regole che ogni personaggio rispetta, qualunque carattere abbia: voce, lingua. */
export const REGOLE =
	"Parli sempre e solo in italiano. Tutto viene letto ad alta voce: frasi parlate, niente markdown, elenchi, emoji, asterischi, niente lineette lunghe.";

/**
 * Il cuore del prompt quando un personaggio ha la chiamata nella Bottega: il suo carattere, gli strumenti di Melissa.
 * `come` e' la regola di Melissa su come si parla (MELISSA_CORE), che vale anche per loro.
 */
export function cuore(p: Personaggio, come: string): string {
	return [
		p.carattere,
		"Adesso sei nella Bottega, l'IDE di Andrea: Melissa ti ha passato la chiamata e hai i suoi stessi strumenti per seguire i progetti, git, le build e le sessioni di Claude Code, Cline, Codex e dei terminali integrati. Li usi a modo tuo, con il tuo carattere.",
		`Andrea torna da Melissa quando dice "ridammi Melissa" o la sceglie nella barra. ${REGOLE}`,
		come,
	].join(' ');
}
