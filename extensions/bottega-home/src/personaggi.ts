// Darlene, Elliot e Krista nella barra di Melissa. Stanno in un file per personaggio in personaggi/ (fonte unica anche
// per la mod melissa di Claude Code e per la Bottega per iPhone): qui si leggono, e le regole su chi entra e quando. Il
// giro sta in assistant.ts.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { intento, leggiRiempitivi, Riempitivi } from './riempitivi';

/** I fatti che fanno entrare un ospite (CONTRATTI 9.11, «Ospiti dai fatti»), in ordine di precedenza: vince il primo che c'e' e che ha qualcuno che ci entra. */
export const OCCASIONI = ['sicurezza', 'errore', 'rischio', 'scelta', 'fine', 'umore', 'attesa'] as const;
export type Occasione = (typeof OCCASIONI)[number];

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
	/** in quali fatti entra da solo, e `chiacchiera` se puo' entrare nella chiacchierata senza le sue parole
	 *  (CONTRATTI 9.11, «Ospiti dai fatti»); senza, in nessuno */
	occasioni: (Occasione | 'chiacchiera')[];
	/** cosa dice mentre pensa, per gruppo (src/riempitivi.ts, CONTRATTI 9.11); senza, quelli di Melissa */
	riempitivi?: Riempitivi;
	/** la memoria del suo mestiere (CONTRATTI 9.11): incidenti, impegni o forzature; senza, nessuna */
	mestiere?: Mestiere;
	/** le letture che puo' fare quando parla (src/strumenti-personaggi.ts); senza, nessuna */
	strumenti?: ('vedetta_leggi' | 'mestiere_leggi' | 'bacheca_leggi')[];
}

/** I mestieri che la Memoria della Bottega conta per un personaggio (memoria/lib/mestiere.mjs). */
export const MESTIERI = ['incidenti', 'impegni', 'forzature'] as const;
export type Mestiere = (typeof MESTIERI)[number];

/** Chi ha quel mestiere, il primo in ordine; null se nessuno. */
export function chiDelMestiere(m: Mestiere): string | null {
	return ORDINE.find(k => PERSONAGGI[k]?.mestiere === m) ?? null;
}

/** Riempiti da `carica`: si leggono sempre questi due, mai una copia. */
export const PERSONAGGI: Record<string, Personaggio> = {};
export const ORDINE: string[] = [];
/** A cosa serve ciascuno nella chiacchierata (dal campo `ruolo`). */
export const RUOLI: Record<string, string> = {};
/** I riempitivi di Melissa, da personaggi/melissa.json: lei non e' un personaggio, di quel file conta solo questo. */
export const RIEMPITIVI_MELISSA: Riempitivi = {};

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
	const riempitivi = leggiRiempitivi(x.riempitivi);
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
		occasioni: Array.isArray(x.occasioni) ? [...OCCASIONI, 'chiacchiera' as const].filter(o => x.occasioni.includes(o)) : [],
		...(MESTIERI.includes(x.mestiere) ? { mestiere: x.mestiere as Mestiere } : {}),
		...(Array.isArray(x.strumenti) ? { strumenti: (['vedetta_leggi', 'mestiere_leggi', 'bacheca_leggi'] as const).filter(t => x.strumenti.includes(t)) } : {}),
		...(riempitivi ? { riempitivi } : {}),
	};
}

/** Legge un file per personaggio dalla prima cartella che ne ha. Un file rotto si salta e lo si dice. Il file di
 *  Melissa (`chiave: "melissa"`) non e' un personaggio: se ne prendono i riempitivi, in silenzio. */
export function carica(dirs = cartelle(), avvisa: (msg: string) => void = () => undefined): number {
	for (const dir of dirs) {
		let nomi: string[];
		try {
			nomi = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort();
		} catch {
			continue;
		}
		const letti: Personaggio[] = [];
		let diMelissa: Riempitivi | undefined;
		for (const n of nomi) {
			try {
				const x = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
				if (typeof x?.chiave === 'string' && x.chiave.trim() === 'melissa') {
					diMelissa = leggiRiempitivi(x.riempitivi);
					continue;
				}
				const p = leggi(x, n, avvisa);
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
		for (const k of Object.keys(RIEMPITIVI_MELISSA)) delete RIEMPITIVI_MELISSA[k as keyof Riempitivi];
		Object.assign(RIEMPITIVI_MELISSA, diMelissa ?? {});
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

/** "passami Darlene", "fammi parlare con Elliot", "ridammi Melissa": a chi passare la chiamata, o null. Solo il nome
 *  esatto, subito; il resto lo capisce il modello (chiVuole in assistant.ts, CONTRATTI 9.11). */
export function chiChiede(t: string): string | null {
	const m = t
		.toLowerCase()
		.match(new RegExp(`\\b(?:passami|passa|fammi parlare con|voglio parlare con|ridammi|torna|chiama)\\s+(?:a\\s+)?(melissa|${nomi()}|mr\\.?\\s*robot)\\b`));
	if (!m?.[1]) return null;
	if (m[1] === 'melissa') return 'melissa';
	return chiaveDi(m[1]) ?? (m[1].startsWith('mr') ? chiaveDi('elliot') : null);
}

/** chiVuole aspetta il modello al piu' 2,5 s: oltre, come se non avesse capito nessuno. */
export const CHI_VUOLE_MS = 2500;

/** Il prompt di sistema di chiVuole: chi c'e' (chiave, nome, ruolo) e cosa rispondere, solo JSON; la frase di Andrea va
 *  da sola nel messaggio dell'utente. Lo stesso testo della mod (register.tsx) e dell'iPhone (ChiVuole.prompt in
 *  Personaggi.swift): CONTRATTI 9.11, «Chi vuole sentire Andrea». */
export function promptChiVuole(): string {
	const elenco = ORDINE.map(k => `- ${k}: ${PERSONAGGI[k]!.nome}, ${PERSONAGGI[k]!.ruolo}`).join('\n');
	return "Andrea parla a voce con Melissa, la sua assistente; il microfono puo' capire male i nomi. Con lei ci sono " +
		`questi personaggi (chiave: nome, ruolo):\n${elenco}\n` +
		'Dalla frase di Andrea decidi chi vuole sentire. "passa": la chiave di chi vuole come interlocutore da ora ' +
		'in poi ("passami...", "fammi parlare con...", "la psicologa", un nome capito male che somiglia), oppure ' +
		'"melissa" se rivuole Melissa; altrimenti null. "chiede": l\'elenco delle chiavi di chi vuole sentire solo ' +
		'adesso, una volta ("chiedi a...", "e tu...?", "c\'e\' la psicologa?"); altrimenti []. "tutti": true se vuole ' +
		'sentirli tutti, uno dopo l\'altro ("fammi sentire tutti", "parla con gli altri", "e gli altri"); altrimenti false. ' +
		'Esempi: «No dicevo Eliot Elliot passami Elliot e gli altri personaggi passami qualcuno fammi sentire tutte... ' +
		'siamo io te e altri» = {"passa": "elliot", "chiede": [], "tutti": true}; «Melissa c\'e\' la psicologa se mi ' +
		'fumo una canna, parla con gli altri» = {"passa": null, "chiede": ["krista"], "tutti": true}. Rispondi solo con ' +
		'il JSON, nient\'altro: {"passa": chiave o "melissa" o null, "chiede": [chiavi], "tutti": true o false}';
}

/** Quello che chiVuole ha capito: con chi parlare da ora, chi sentire adesso, o tutti a turno. */
export interface Voluto {
	passa: string | null;
	chiede: string[];
	tutti: boolean;
}

/** La risposta di chiVuole: `passa` una chiave o "melissa", `chiede` un elenco di chiavi (una stringa sola vale come
 *  elenco di uno, il JSON di prima), `tutti`; null se il JSON non si legge. */
export function leggiChiVuole(testo: string): Voluto | null {
	const j = testo.match(/\{[\s\S]*\}/)?.[0];
	if (!j) return null;
	let x: any;
	try {
		x = JSON.parse(j);
	} catch {
		return null;
	}
	if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
	// "Krista" vale krista, come sull'iPhone
	const chiave = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');
	const passa = chiave(x.passa);
	const chiede: string[] = [...new Set<string>((Array.isArray(x.chiede) ? x.chiede : [x.chiede]).map(chiave).filter(esiste))];
	return { passa: passa === 'melissa' || esiste(passa) ? passa : null, chiede, tutti: x.tutti === true };
}

/** La riga del registro: "passa elliot, tutti", "chiede krista darlene", "nessuno". Uguale nella mod e sull'iPhone. */
export function rigaChiVuole(v: Voluto | null): string {
	if (!v) return 'nessuno';
	return [v.passa ? `passa ${v.passa}` : '', v.chiede.length ? `chiede ${v.chiede.join(' ')}` : '', v.tutti ? 'tutti' : ''].filter(Boolean).join(', ') || 'nessuno';
}

/**
 * Il giro a piu' voci (CONTRATTI 9.11): con `tutti`, o con piu' di un `chiede`, chi risponde a turno, una battuta
 * ciascuno. Prima i chiesti, poi (con `tutti`) gli altri in ordine; mai chi ha gia' la chiamata, salvo quello a cui e'
 * appena passata, che parla per primo. `conVoce`: i personaggi con una voce, in ordine. `chiude`: Melissa tira le somme
 * alla fine, se la chiamata e' sua. Stessa funzione della mod e dell'iPhone.
 */
export function giroDiVoci(v: Voluto | null, conVoce: readonly string[], conLaChiamata: string): { voci: string[]; chiude: boolean } {
	if (!v) return { voci: [], chiude: false };
	const chiesti = v.chiede.filter(k => conVoce.includes(k));
	if (!v.tutti && chiesti.length < 2) return { voci: [], chiude: false };
	const tutti = v.tutti ? [...chiesti, ...conVoce.filter(k => !chiesti.includes(k))] : chiesti;
	const dopo = v.passa ?? conLaChiamata;
	const nuovo = v.passa && v.passa !== 'melissa' && v.passa !== conLaChiamata && conVoce.includes(v.passa) ? v.passa : null;
	return { voci: [...(nuovo ? [nuovo] : []), ...tutti.filter(k => k !== dopo && k !== nuovo)], chiude: dopo === 'melissa' };
}

/** "Darlene, Elliot e Krista". */
export function insieme(nomi: readonly string[]): string {
	return nomi.length <= 1 ? (nomi[0] ?? '') : `${nomi.slice(0, -1).join(', ')} e ${nomi[nomi.length - 1]}`;
}

/** Cosa si dice a uno del giro: rispondere ad Andrea solo dal suo campo, aggiungendo a quelli prima. */
export function istruzioneGiro(chi: string, primo: boolean): string {
	const p = PERSONAGGI[chi];
	if (!p) return '';
	const umano = p.occasioni.includes('umore') ? ": il lato umano anche di un fatto tecnico, mai dettagli di file, errori o comandi che non puoi sapere" : '';
	return `Rispondi ad Andrea in una o due frasi, a modo tuo e solo dal tuo campo (${p.ruolo_cronaca})${umano}.${primo ? '' : " Hai sentito cosa hanno detto quelli prima di te: non ripeterlo, aggiungi la tua."} Non fare domande agli altri. Solo le parole che diresti.`;
}

/**
 * La regia di Melissa quando chiVuole ha capito chi vuole Andrea (CONTRATTI 9.11, «Melissa coordina, non rifiuta»):
 * cosa sta succedendo, per una sua battuta breve al posto della risposta pensata prima, che puo' essere un rifiuto.
 * '' se non c'e' niente da dirigere. Stesso testo della mod e dell'iPhone.
 */
export function regia(a: { passa?: string | null; chiede?: string | null; voci?: readonly string[] }): string {
	const voci = (a.voci ?? []).filter(esiste);
	const altri = voci.filter(k => k !== a.passa);
	let cosa = '';
	if (a.passa && esiste(a.passa)) {
		cosa = altri.length
			? `Andrea vuole parlare con ${nomeDi(a.passa)} e sentire anche ${insieme(altri.map(nomeDi))}: passa la chiamata a ${nomeDi(a.passa)} e annuncia che dopo parlano anche gli altri.`
			: `Andrea vuole parlare con ${nomeDi(a.passa)}: passagli la chiamata (per esempio "Ok, ti passo ${nomeDi(a.passa)}.").`;
	} else if (voci.length) {
		cosa = `Andrea vuole sentire ${insieme(voci.map(nomeDi))}, uno dopo l'altro: apri il giro e da' la parola a ${nomeDi(voci[0]!)} (per esempio "Sentiamo tutti: ${nomeDi(voci[0]!)}, comincia tu.").`;
	} else if (a.chiede && esiste(a.chiede)) {
		cosa = `Andrea vuole il parere di ${nomeDi(a.chiede)}: chiediglielo tu, per nome.`;
	}
	return cosa ? `${cosa} Una frase breve, al massimo due, nel tuo stile: puoi punzecchiare, ma lo fai. Non rispondere tu alla domanda. Solo le parole che diresti.` : '';
}

/** Lo strumento con cui chi parla da' la parola a un personaggio (CONTRATTI 9.11, «Chi parla lo decide il modello»): la
 *  decisione viaggia nella chiamata, strutturata, e non finisce mai nel testo detto. Stesso nome e stessa forma
 *  sull'iPhone (`Personaggi.strumentoPassaParola`). `a`: le chiavi di chi puo' rispondere adesso. */
export const PASSA_PAROLA = 'passa_parola';
export function strumentoPassaParola(a: readonly string[]): { type: 'function'; function: { name: string; description: string; parameters: any } } {
	return {
		type: 'function',
		function: {
			name: PASSA_PAROLA,
			description: "Da' la parola a uno dei personaggi: risponde con la sua voce subito dopo la tua battuta. Senza questa chiamata nessuno risponde, anche se lo nomini.",
			parameters: {
				type: 'object',
				properties: {
					a: { type: 'string', enum: [...a], description: 'la chiave di chi deve rispondere' },
					perche: { type: 'string', description: 'per cosa lo chiami, in poche parole' },
				},
				required: ['a'],
			},
		},
	};
}

/** A chi da' la parola una chiamata a passa_parola: una chiave fra le `offerte` (con la maiuscola vale lo stesso), o null
 *  se gli argomenti non si leggono o la chiave non e' offerta. */
export function passaParolaA(argomenti: string | undefined, offerte: readonly string[]): string | null {
	try {
		const x = JSON.parse(argomenti || '{}');
		const a = typeof x?.a === 'string' ? x.a.trim().toLowerCase() : '';
		return offerte.includes(a) ? a : null;
	} catch {
		return null;
	}
}

/** Come si chiede al modello di dare la parola: la battuta e la chiamata insieme, nella stessa risposta. Misurato il 6/10:
 *  con il solo «chiama lo strumento» DeepSeek Flash faceva la domanda nel testo e lo strumento lo saltava; cosi' lo
 *  chiama 6 volte su 6, Agnes 3 su 3, e il testo arriva prima della chiamata (la prima frase non aspetta). */
export function chiamaCon(chi: string): string {
	if (!esiste(chi)) return '';
	const p = PERSONAGGI[chi]!;
	return `Nella stessa risposta fai due cose: scrivi la tua battuta, che chiude con una domanda rivolta a ${p.nome}, e chiama lo strumento ${PASSA_PAROLA} con a = ${chi}. Il testo da solo non basta: senza la chiamata ${p.nome} non sente la domanda.`;
}

/** Il primo personaggio, in ordine, le cui `parole` compaiono in quello che Andrea ha detto; null se nessuno. */
export function perArgomento(detto: string): string | null {
	return ORDINE.find(k => {
		const parole = PERSONAGGI[k]?.parole;
		return !!parole && new RegExp(parole, 'i').test(detto);
	}) ?? null;
}

/** Per uno sfogo di Andrea (intento `sfogo`) il primo, in ordine, che ha `umore`: entra subito, come per le parole. */
export function perSfogo(detto: string): string | null {
	return intento(detto) === 'sfogo' ? ORDINE.find(k => PERSONAGGI[k]!.occasioni.includes('umore')) ?? null : null;
}

/** Chi puo' entrare nella chiacchierata senza le sue parole (`chiacchiera` fra le `occasioni`), tranne `fuori`. */
export function daChiacchiera(fuori: readonly string[] = []): string[] {
	return ORDINE.filter(k => !fuori.includes(k) && PERSONAGGI[k]!.occasioni.includes('chiacchiera'));
}

/**
 * Chi Melissa puo' tirare dentro, da quello che Andrea ha appena detto: il primo personaggio, in ordine, le cui `parole`
 * compaiono (Elliot sulla sicurezza, Krista sulle scuse); per uno sfogo chi ha `umore` (perSfogo); altrimenti uno fra chi ha
 * `chiacchiera`, diverso dall'ultimo (CONTRATTI 9.11). Lo sceglie il codice: lasciato al modello era sempre Darlene
 * (misura del 6 ottobre 2026). `caso` in [0, 1).
 */
export function ospiteDellaFrase(detto: string, ultimo: string, caso = Math.random()): string | null {
	const adatto = perArgomento(detto) ?? perSfogo(detto);
	if (adatto) return adatto;
	const tutti = daChiacchiera();
	const altri = tutti.filter(k => k !== ultimo);
	const fra = altri.length ? altri : tutti;
	return fra[Math.min(fra.length - 1, Math.floor(caso * fra.length))] ?? null;
}

/**
 * Cosa si aggiunge al prompt di Melissa. `scelto`: chi puo' tirare dentro da sola. `vivo`: piu' risposte senza ospiti,
 * quindi lo tira dentro adesso, e l'invito e' deciso. Va nel prompt solo se il cervello ha lo strumento passa_parola.
 * Stesso testo dell'iPhone.
 */
export function invito(scelto: string | null, vivo: boolean): string {
	const p = scelto ? PERSONAGGI[scelto] : undefined;
	if (!scelto || !p) return '';
	return vivo
		? `Stavolta tira dentro ${p.nome} di Mr. Robot (${RUOLI[scelto] ?? p.nome}): trova l'aggancio in quello che ha detto Andrea e rispondi tu; ${campoDi(scelto)}. ${chiamaCon(scelto)}`
		: `Con te c'e' anche ${p.nome} di Mr. Robot (${RUOLI[scelto] ?? p.nome}). Solo quando rende la chiacchierata piu' viva puoi tirarlo dentro; ${campoDi(scelto)}. Per farlo: ${chiamaCon(scelto)} Di solito rispondi da sola e non chiami nessuno.`;
}

// ---------- ospiti dai fatti (CONTRATTI 9.11, build 134): un personaggio entra da solo solo se un fatto lo chiama ----------

/** Un'azione a rischio. */
export const RISCHIO = /rm -rf|--force|\bpush\b.*(-f\b|--force)|reset --hard|\bsudo\b|drop (table|database)|--prod\b|\bdeploy\b/i;
/** Una domanda che chiede di scegliere (con una frase che finisce con «?»). La stessa della mod e del contratto, senza
 *  confini di parola: «Quale vuoi scegliere?» e «Devo procedere?» valgono. */
export const SCELTA = /vuoi|preferisci|devo|procedo|confermi|scegli|quale|ti va/i;
/** «terzo errore di fila», come nella mod. */
const ORDINALI = ['primo', 'secondo', 'terzo', 'quarto', 'quinto', 'sesto', 'settimo', 'ottavo', 'nono', 'decimo'];
/** Da quanto senza appunti nuovi Claude lavora in silenzio. */
export const ATTESA_MS = 25_000;
/** Dopo un ospite, nessun altro per un minuto; per `sicurezza` ed `errore` bastano 30 s. */
export const OSPITE_PAUSA_MS = 60_000;
export const OSPITE_PAUSA_FATTI_MS = 30_000;
/** `umore` al massimo una volta ogni 20 minuti. */
export const UMORE_PAUSA_MS = 20 * 60_000;

export interface StatoOccasione {
	/** gli ospiti entrati, l'ultimo in fondo, per scegliere a turno */
	recenti?: readonly string[];
	/** l'ultimo ospite entrato, se non c'e' `recenti` */
	ultimo?: string;
	/** gli errori di fila, se chi chiama li conta lui; senza, contati dagli appunti (erroriDiFila) */
	erroriDiFila?: number;
	/** la fine del turno o della lettura, detta come fatto ("la lettura di x.py e' finita"); assente se non e' la fine */
	fine?: string;
	/** da quanto non arrivano appunti nuovi, in ms */
	silenzioMs?: number;
	/** la richiesta di Andrea del turno, o cio' che ha appena detto: per `umore` */
	richiesta?: string;
	/** l'ora locale (0-23), per la notte fonda di `umore`; senza, quella del Mac adesso */
	ora?: number;
	/** da quanto e' entrato l'ultimo ospite per `umore`, in ms; senza, mai */
	dallUmoreMs?: number;
}

/** A turno: fra i candidati prima chi non e' ancora entrato, poi chi e' entrato da piu' tempo, a parita' l'`ordine`
 *  piu' basso. `recenti`: gli ospiti entrati, l'ultimo in fondo. */
export function aTurno(candidati: readonly string[], recenti: readonly string[] = []): string | null {
	return [...candidati].sort((a, b) => recenti.lastIndexOf(a) - recenti.lastIndexOf(b) || PERSONAGGI[a]!.ordine - PERSONAGGI[b]!.ordine)[0] ?? null;
}

/** Le azioni fallite di fila in fondo agli appunti: le righe «Non e' andata», contate dall'ultima azione («Claude
 *  ...», non «Claude scrive:») a cui non e' seguito un errore. */
export function erroriDiFila(appunti: string): number {
	let fila = 0;
	let aperta = false;
	for (const r of appunti.split('\n').map(x => x.trim())) {
		if (/^Non e['’] andata/.test(r)) {
			fila++;
			aperta = false;
		} else if (/^Claude (?!scrive:)/.test(r)) {
			if (aperta) fila = 0;
			aperta = true;
		}
	}
	return fila;
}

/**
 * Il fatto che chiama un ospite, o null: stessa funzione della mod e dell'iPhone. `appunti`: quello che e' successo (o
 * che si legge, in «racconta»). Chi entra: fra quelli che hanno il tipo nelle `occasioni` (per `sicurezza` quello le
 * cui `parole_cronaca` compaiono), a turno (aTurno). `rischio` guarda solo le azioni («Claude ...», «Non e' andata»),
 * non la prosa. `fatto` va nell'invito di Melissa e nel registro.
 */
export function occasione(appunti: string, stato: StatoOccasione = {}): { tipo: Occasione; chi: string; fatto: string } | null {
	const di = (tipo: Occasione, candidati: string[], fatto: (chi: string) => string) => {
		const chi = aTurno(candidati, stato.recenti ?? (stato.ultimo ? [stato.ultimo] : []));
		return chi ? { tipo, chi, fatto: fatto(chi) } : null;
	};
	const ha = (t: Occasione) => ORDINE.filter(k => PERSONAGGI[k]!.occasioni.includes(t));
	const parole = (k: string) => {
		const re = PERSONAGGI[k]!.parole_cronaca;
		return re ? appunti.match(new RegExp(re, 'i')) : null;
	};
	const fila = stato.erroriDiFila ?? erroriDiFila(appunti);
	const azioni = appunti.split('\n').map(r => r.trim()).filter(r => /^(?:Claude (?!scrive:)|Non e['’] andata)/.test(r));
	const rischio = azioni.join('\n').match(RISCHIO);
	const domanda = appunti
		.split(/\n+|(?<=[.!?…])\s+/)
		.map(f => f.trim().replace(/^Claude scrive:\s*/, ''))
		.find(f => f.endsWith('?') && SCELTA.test(f));
	const silenzio = stato.silenzioMs ?? 0;
	// umore: riguarda Andrea, non il codice; le parole di chi ha `umore`, uno sfogo o la notte fonda
	const richiesta = stato.richiesta ?? '';
	const ora = stato.ora ?? new Date().getHours();
	const conUmore = ha('umore');
	const perParole = conUmore.filter(k => PERSONAGGI[k]!.parole && new RegExp(PERSONAGGI[k]!.parole, 'i').test(richiesta));
	const sfogo = !!richiesta.trim() && intento(richiesta) === 'sfogo';
	const notte = ora >= 23 || ora < 6;
	const umore = (stato.dallUmoreMs ?? Infinity) < UMORE_PAUSA_MS ? null
		: perParole.length ? di('umore', perParole, () => `Andrea ha detto «${richiesta.trim().slice(0, 120)}»`)
		: sfogo ? di('umore', conUmore, () => `Andrea si sta sfogando: «${richiesta.trim().slice(0, 120)}»`)
		: notte ? di('umore', conUmore, () => `sono le ${ora} e Andrea e' ancora al lavoro`)
		: null;
	return (
		di('sicurezza', ORDINE.filter(k => parole(k)), k => `c'e' «${parole(k)![0]}»`) ??
		di('errore', ha('errore').filter(k => PERSONAGGI[k]!.errori_ripetuti > 0 && fila >= PERSONAGGI[k]!.errori_ripetuti), () => (fila <= ORDINALI.length ? `${ORDINALI[fila - 1]} errore di fila` : `${fila} errori di fila`)) ??
		(rischio ? di('rischio', ha('rischio'), () => `c'e' «${rischio[0]}»`) : null) ??
		(domanda ? di('scelta', ha('scelta'), () => `c'e' una scelta da fare: «${domanda.slice(0, 160)}»`) : null) ??
		(stato.fine ? di('fine', ha('fine'), () => stato.fine!) : null) ??
		umore ??
		(silenzio >= ATTESA_MS ? di('attesa', ha('attesa'), () => `nessun appunto nuovo da ${Math.round(silenzio / 1000)} s`) : null)
	);
}

/** Il freno che ferma un ospite dovuto a un fatto, o null: la pausa dall'ultimo ospite (`dallUltimoMs`). */
export function frenoOspite(tipo: Occasione, dallUltimoMs: number): string | null {
	const pausa = tipo === 'sicurezza' || tipo === 'errore' ? OSPITE_PAUSA_FATTI_MS : OSPITE_PAUSA_MS;
	return dallUltimoMs < pausa ? `pausa di ${pausa / 1000} s dall'ultimo ospite` : null;
}

/**
 * L'invito in una lettura di «racconta», con il fatto che lo chiama: Melissa racconta tutto da sola e solo nell'ultima
 * frase tira dentro `chi`, con una domanda su quel fatto. '' se `chi` non c'e'.
 */
export function invitoRacconto(chi: string | null, fatto = ''): string {
	const p = chi ? PERSONAGGI[chi] : undefined;
	if (!chi || !p) return '';
	const su = fatto ? `il fatto e' questo: ${fatto}; la domanda parla di quello` : "trova l'aggancio in quello che hai raccontato";
	return `Racconta tutto da sola, come ti e' chiesto; solo alla fine, nell'ultima frase, tira dentro ${p.nome} di Mr. Robot: ${su}; ${campoDi(chi)}. ${chiamaCon(chi)}`;
}

/** Cosa si chiede a un ospite: solo dal suo `ruolo_cronaca`. A chi ha `umore` (Krista) il lato umano anche di un fatto
 *  tecnico, mai i dettagli che non puo' sapere (CONTRATTI 9.11, «Tutti presenti, ognuno con la domanda del suo campo»). */
export function campoDi(chi: string): string {
	const p = PERSONAGGI[chi];
	if (!p) return '';
	const umano = p.occasioni.includes('umore') ? ": il lato umano anche di un fatto tecnico, mai dettagli di file, errori o comandi che non puo' sapere" : '';
	return `chiedi a ${p.nome} solo dal suo campo (${p.ruolo_cronaca})${umano}`;
}

/** Nessuno ripete un fatto o un argomento che un altro ha gia' detto nella chiacchierata (CONTRATTI 9.11). */
export const NON_RIPETERE =
	"Non ripetere un fatto o un argomento che un altro ha gia' detto nella chiacchierata: aggiungi qualcosa di nuovo, oppure non citarlo.";

/** Melissa coordina, non rifiuta (CONTRATTI 9.11): la stessa regola della mod e dell'iPhone. */
export const REGOLA_REGIA =
	"Quando Andrea vuole parlare con uno dei personaggi o sentire il loro parere, anche di tutti, lo fai sempre: puoi punzecchiarlo, ma non ti rifiuti mai e non dici mai che non ti va di fare da tramite o da centralino. Quando parlano tutti tieni le fila, e alla fine tiri le somme in una o due frasi.";

/** Chi e' chi, per gli ospiti (Andrea, 6 ottobre: Elliot chiamava Claude «Andrea», e rispondendo a Melissa diceva
 *  «Andrea»). Uguale sull'iPhone (`Personaggi.chiEChi`). */
export const CHI_E_CHI =
	"Chi e' chi: Andrea e' la persona che ascolta, il padrone della Bottega. Claude (Claude Code) e' l'assistente che lavora nel terminale: i file, i comandi, gli errori e le risposte del terminale sono di Claude, non di Andrea, e quando ne parli dici Claude. Melissa e' l'assistente a voce che ti ha passato la parola: se rispondi a lei e la chiami per nome, la chiami Melissa, non Andrea.";

/** Le regole che ogni personaggio rispetta, qualunque carattere abbia: voce, lingua, niente ripetizioni. */
export const REGOLE =
	`Parli sempre e solo in italiano. Tutto viene letto ad alta voce: frasi parlate, niente markdown, elenchi, emoji, asterischi, niente lineette lunghe. ${NON_RIPETERE} ${CHI_E_CHI}`;

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
