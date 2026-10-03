/* Gli occhi di Melissa sull'editor (CONTRATTI 6, «Il codice davanti ad Andrea»).

   Due cose sole:
   - una riga di contesto a ogni domanda («davanti ad Andrea: avo_bnb/db.py, python, 420 righe, sullo schermo 37-55,
     selezionate 46-50»): costa poche parole e Melissa sa sempre che c'e' un file aperto;
   - lo strumento codice_leggi, che le da' il file con i numeri di riga e prima la selezione fatta col mouse. Lo usa
     quando la domanda riguarda il codice, anche senza la parola «file».
   Quale file: quello attivo; se davanti c'e' la Home, la barra o un'immagine, l'ultimo file di codice guardato. Gli
   altri file visibili si leggono per nome. I file di segreti (.env, chiavi, ~/.secrets) non si leggono mai: il loro
   contenuto andrebbe al cervello in rete. */

import * as path from 'path';

/** Fin qui il file si legge intero (circa 1.500 righe); oltre, la parte sullo schermo e dintorni. */
export const LIMITE_FILE = 60_000;
export const LIMITE_SELEZIONE = 12_000;
const MARGINE_RIGHE = 150;

export interface VistaEditor {
	/** percorso assoluto */
	file: string;
	/** come lo si dice: relativo al progetto se si puo' */
	nome: string;
	lingua: string;
	righe: number;
	/** righe sullo schermo, da 1 */
	schermo?: [number, number];
	cursore: number;
	selezione?: { da: number; a: number; testo: string };
	/** gli altri file visibili accanto, per nome */
	accanto: string[];
}

/** File che non si mandano mai a un cervello in rete. */
export function eSegreto(file: string): boolean {
	const f = file.replace(/\\/g, '/');
	return /(^|\/)\.secrets\//.test(f) || /(^|\/)\.env(\.[\w-]+)?$/.test(f) || /\.(pem|p8|p12|key|keystore|jks|mobileprovision)$/i.test(f) || /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/.test(f) || /(^|\/)\.npmrc$|(^|\/)\.netrc$/.test(f);
}

/** Il nome da dire: relativo alla cartella di lavoro che lo contiene, con il nome della cartella davanti. */
export function nomeCorto(file: string, cartelle: string[]): string {
	const c = cartelle.filter(r => file === r || file.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0];
	return c ? path.join(path.basename(c), path.relative(c, file)) : path.join(path.basename(path.dirname(file)), path.basename(file));
}

/** La riga che entra nel prompt di sistema a ogni domanda. */
export function rigaContesto(v: VistaEditor | undefined): string | undefined {
	if (!v) return undefined;
	const pezzi = [`${v.nome}, ${v.lingua}, ${v.righe} righe`];
	if (v.schermo) pezzi.push(`sullo schermo le righe ${v.schermo[0]}-${v.schermo[1]}`);
	if (v.selezione) pezzi.push(v.selezione.da === v.selezione.a ? `selezionata la riga ${v.selezione.da}` : `selezionate le righe ${v.selezione.da}-${v.selezione.a}`);
	else pezzi.push(`cursore alla riga ${v.cursore}`);
	if (v.accanto.length) pezzi.push(`accanto: ${v.accanto.slice(0, 4).join(', ')}`);
	return `Davanti ad Andrea nell'editor: ${pezzi.join('; ')}. Se la domanda riguarda questo codice (anche «questo», «qui», «questa funzione», un errore), leggilo con codice_leggi prima di rispondere.`;
}

const numerate = (righe: string[], da: number) => righe.map((r, i) => `${da + i}| ${r}`).join('\n');

/** Il testo che lo strumento restituisce: intestazione, selezione (se c'e'), poi il file o la parte intorno allo schermo. */
export function testoDaLeggere(testo: string, v: VistaEditor, limite = LIMITE_FILE): string {
	if (eSegreto(v.file)) return `${v.nome} e' un file di segreti: non lo leggo e non lo mando a nessun cervello.`;
	const righe = testo.split(/\r?\n/);
	const out: string[] = [`File: ${v.nome} (${v.lingua}, ${righe.length} righe)${v.schermo ? `, sullo schermo le righe ${v.schermo[0]}-${v.schermo[1]}` : ''}.`];
	if (v.selezione && v.selezione.testo.trim()) {
		const sel = v.selezione.testo.length > LIMITE_SELEZIONE ? v.selezione.testo.slice(0, LIMITE_SELEZIONE) + '\n(selezione tagliata qui)' : v.selezione.testo;
		out.push(`Selezionato col mouse, righe ${v.selezione.da}-${v.selezione.a} (e' di questo che parla, se dice «questo»):\n${numerate(sel.split(/\r?\n/), v.selezione.da)}`);
	}
	if (testo.length <= limite) {
		out.push(`Il file intero:\n${numerate(righe, 1)}`);
		return out.join('\n\n');
	}
	// file lungo: la parte sullo schermo (o intorno al cursore) e un margine prima e dopo, finche' ci sta
	const centro = v.schermo ?? [v.cursore, v.cursore];
	let da = Math.max(1, centro[0] - MARGINE_RIGHE);
	let a = Math.min(righe.length, centro[1] + MARGINE_RIGHE);
	while (a > da && righe.slice(da - 1, a).join('\n').length > limite) {
		da = Math.min(da + 20, centro[0]);
		a = Math.max(a - 20, centro[1]);
		if (da === centro[0] && a === centro[1]) break;
	}
	out.push(`Il file e' lungo: qui le righe ${da}-${a} di ${righe.length}. Per il resto non inventare: di' che non l'hai letto o chiedi a che parte guardare.\n${numerate(righe.slice(da - 1, a), da)}`);
	return out.join('\n\n');
}

/** Un altro file per nome («leggi anche pipeline.py»): prima i visibili, poi gli aperti; nome intero, poi pezzo. */
export function scegliFile<T extends { file: string }>(nome: string, candidati: T[]): T | undefined {
	const n = nome.trim().toLowerCase();
	if (!n) return undefined;
	return (
		candidati.find(c => c.file.toLowerCase().endsWith('/' + n) || path.basename(c.file).toLowerCase() === n) ??
		candidati.find(c => path.basename(c.file).toLowerCase().includes(n)) ??
		candidati.find(c => c.file.toLowerCase().includes(n))
	);
}
