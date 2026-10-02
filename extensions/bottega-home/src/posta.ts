/* Posta per progetto.

   La rubrica ~/.bottega/rubrica.json (file 600, mai nel repository: contiene indirizzi di clienti) dice quali
   mittenti, domini, telefoni e gruppi WhatsApp appartengono a quale progetto:
       { "<percorso progetto>": { "indirizzi": ["anna@esempio.it"], "domini": ["esempio.it"],
                                  "telefoni": ["+34600000000"], "gruppi": ["120363000000000000@g.us"] } }
   `telefoni` (E.164, senza spazi) e `gruppi` ci sono solo se non vuoti: le rubriche scritte prima restano valide.

   I suggerimenti per la rubrica si imparano dalla posta: un mittente in "Da assegnare" il cui dominio sta nei file
   di un solo progetto, o il cui dominio, nome o oggetto cita il nome del progetto, viene proposto per quel progetto
   con il motivo. I domini che compaiono nei file di piu' progetti sono di fornitori, non di clienti, e si scartano.
   I mittenti automatici (noreply, notifications, newsletter...) non vanno in "Da assegnare".

   Le fonti dei fili:
   - un server MCP di posta locale (mail-mcp, Apple Mail), interrogato direttamente: istantaneo, gratis, e il
     contenuto non esce dal Mac. Si leggono solo mittente, oggetto, data e stato di lettura, mai il corpo;
   - Gmail di claude.ai, facoltativo, con UNA delega a `claude -p` (delega.ts): lenta e a pagamento.
   L'assegnazione ai progetti avviene qui, con le regole della rubrica. Chi non e' in rubrica va in "Da assegnare".
   I fili si salvano in ~/.bottega/connettori/posta-fili.json (600). Nessuna mail viene mai inviata.
   Contratto: docs/CONTRATTI.md, sezione 5. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DIR_CONNETTORI, EsitoDelega, RichiestaDelega, scriviPrivato } from './delega';

export const RUBRICA_FILE = path.join(os.homedir(), '.bottega', 'rubrica.json');
export const FILI_FILE = path.join(DIR_CONNETTORI, 'posta-fili.json');

export interface VoceRubrica {
	indirizzi: string[];
	domini: string[];
	/** Numeri di telefono in formato E.164 ("+34600000000"), per le chat WhatsApp. */
	telefoni?: string[];
	/** Gruppi WhatsApp, per JID ("<cifre>@g.us"): entrano solo se scritti qui. */
	gruppi?: string[];
}
export type Rubrica = Record<string, VoceRubrica>;

export interface Filo {
	/** "gmail:<threadId>" o "mail:<account>:<mailbox>:<id>" */
	id: string;
	fonte: 'gmail' | 'mail';
	threadId?: string;
	da: string;
	indirizzo: string;
	oggetto: string;
	/** ISO 8601 */
	data: string;
	nonLetto: boolean;
	anteprima: string;
	link?: string;
}

// ---------- indirizzi e domini ----------

/** Fornitori di posta e servizi generici: un loro dominio non identifica un cliente. */
export const POSTA_GENERICA = new Set([
	'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.it', 'hotmail.com', 'hotmail.it', 'live.com', 'live.it', 'msn.com',
	'yahoo.com', 'yahoo.it', 'icloud.com', 'me.com', 'mac.com', 'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it',
	'tim.it', 'fastwebnet.it', 'email.it', 'inwind.it', 'pec.it', 'legalmail.it', 'aruba.it', 'proton.me', 'protonmail.com',
	'gmx.com', 'gmx.it', 'aol.com',
]);

/** Domini che compaiono in tutti i progetti e non dicono niente sul cliente. */
export const DOMINI_GENERICI = new Set([
	'github.com', 'githubusercontent.com', 'github.io', 'gitlab.com', 'bitbucket.org', 'vercel.app', 'vercel.com', 'netlify.app',
	'netlify.com', 'herokuapp.com', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'supabase.co', 'supabase.com',
	'onrender.com', 'fly.dev', 'railway.app', 'apple.com', 'icloud.com', 'google.com', 'googleapis.com', 'gstatic.com', 'goo.gl',
	'youtube.com', 'youtu.be', 'npmjs.com', 'npmjs.org', 'yarnpkg.com', 'nodejs.org', 'anthropic.com', 'claude.ai', 'claude.com',
	'openai.com', 'microsoft.com', 'visualstudio.com', 'open-vsx.org', 'openvsx.org', 'mozilla.org', 'w3.org', 'schema.org',
	'shields.io', 'wikipedia.org', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'tiktok.com',
	'cloudflare.com', 'jsdelivr.net', 'unpkg.com', 'cdnjs.com', 'stripe.com', 'paypal.com', 'example.com', 'example.org',
	'esempio.it', 'localhost', 'stackoverflow.com', 'medium.com', 'swift.org', 'developer.apple.com', 'expo.dev', 'reactnative.dev',
	'tailwindcss.com', 'fonts.googleapis.com', 'openstreetmap.org', 'mapbox.com', 'sentry.io', 'docker.com', 'python.org',
	'pypi.org', 'readthedocs.io', 'creativecommons.org', 'opensource.org', 'apache.org', 'gnu.org', 'mit.edu', 'shopify.com',
	'wordpress.org', 'wordpress.com', 'gravatar.com', 'bit.ly', 'tinyurl.com', 'figma.com', 'notion.so', 'canva.com',
]);

const SECONDO_LIVELLO = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'co.nz', 'co.jp', 'com.br', 'com.mx', 'co.za', 'com.ar', 'com.es', 'com.tr']);

const RE_INDIRIZZO = /^[^@\s<>"]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const RE_DOMINIO = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function normIndirizzo(s: string): string {
	const t = String(s ?? '').trim().toLowerCase();
	return RE_INDIRIZZO.test(t) ? t : '';
}

export function normDominio(s: string): string {
	const t = String(s ?? '')
		.trim()
		.toLowerCase()
		.replace(/^[a-z]+:\/\//, '')
		.replace(/[/?#:].*$/, '')
		.replace(/^@/, '')
		.replace(/^www\./, '')
		.replace(/\.$/, '');
	return RE_DOMINIO.test(t) && /[a-z]/.test(t.split('.').pop() ?? '') ? t : '';
}

/** "Anna Rossi <anna@esempio.it>" -> "anna@esempio.it" */
export function indirizzoDa(da: string): string {
	const s = String(da ?? '');
	const m = /<([^<>\s]+@[^<>\s]+)>/.exec(s) ?? /([^\s<>"(),;:]+@[^\s<>"(),;:]+)/.exec(s);
	return m ? normIndirizzo(m[1]) : '';
}

/** Un numero di telefono in E.164: "+39 333 000 0000", "0039...", "39333..." -> "+393330000000". Le cifre senza
 *  prefisso si prendono come gia' complete del prefisso internazionale, come le scrive WhatsApp. */
export function normTelefono(s: string): string {
	let t = String(s ?? '').trim();
	if (!/^[+\d\s().\-/]{7,}$/.test(t)) return '';
	t = t.replace(/[\s().\-/]/g, '');
	if (!/^\+?\d+$/.test(t)) return '';
	if (t.startsWith('00')) t = '+' + t.slice(2);
	if (!t.startsWith('+')) t = '+' + t;
	return /^\+[1-9]\d{6,14}$/.test(t) ? t : '';
}

/** Un gruppo WhatsApp per JID: "120363000000000000@g.us" o il vecchio "<numero>-<tempo>@g.us". */
export function normGruppo(s: string): string {
	const t = String(s ?? '').trim().toLowerCase();
	return /^\d{6,25}(-\d{6,15})?@g\.us$/.test(t) ? t : '';
}

/** Mittenti automatici: non sono persone e non si propongono per la rubrica (si assegnano solo a mano). */
const RE_AUTOMATICO = /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|newsletters?|news|bounces?|alerts?|automated|system)([+._-]|$)|(^|[+._-])no-?reply([+._-]|$)/;
export function mittenteAutomatico(indirizzo: string): boolean {
	const ind = normIndirizzo(indirizzo);
	return !!ind && RE_AUTOMATICO.test(ind.split('@')[0]);
}

export const dominioDi = (indirizzo: string) => (indirizzo.includes('@') ? indirizzo.split('@').pop()! : '');

/** Il dominio registrabile: "shop.cliente.it" -> "cliente.it", "x.co.uk" resta a tre parti. */
export function dominioBase(host: string): string {
	const d = normDominio(host);
	if (!d) return '';
	const p = d.split('.');
	if (p.length <= 2) return d;
	const due = p.slice(-2).join('.');
	return SECONDO_LIVELLO.has(due) ? p.slice(-3).join('.') : due;
}

const generico = (d: string, extra: Set<string>) => {
	for (const g of [...DOMINI_GENERICI, ...extra]) if (d === g || d.endsWith('.' + g)) return true;
	return false;
};

// ---------- rubrica ----------

export function pulisciRubrica(raw: unknown): Rubrica {
	const out: Rubrica = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
	for (const [k, v] of Object.entries(raw as Record<string, any>)) {
		const p = String(k).replace(/\/+$/, '');
		if (!p.startsWith('/')) continue;
		const lista = (x: unknown, norm: (s: string) => string) => [...new Set((Array.isArray(x) ? x : []).map(norm).filter(Boolean))] as string[];
		const indirizzi = lista(v?.indirizzi, normIndirizzo);
		const domini = lista(v?.domini, normDominio);
		const telefoni = lista(v?.telefoni, normTelefono);
		const gruppi = lista(v?.gruppi, normGruppo);
		if (!indirizzi.length && !domini.length && !telefoni.length && !gruppi.length) continue;
		out[p] = { indirizzi, domini, ...(telefoni.length ? { telefoni } : {}), ...(gruppi.length ? { gruppi } : {}) };
	}
	return out;
}

/** Tutte le voci di un progetto, per i chip e per i confronti. */
export const vociDi = (v: VoceRubrica) => [...v.indirizzi, ...v.domini, ...(v.telefoni ?? []), ...(v.gruppi ?? [])];

export function leggiRubrica(file = RUBRICA_FILE): Rubrica {
	try {
		return pulisciRubrica(JSON.parse(fs.readFileSync(file, 'utf8')));
	} catch {
		return {};
	}
}

export function scriviRubrica(r: Rubrica, file = RUBRICA_FILE): Rubrica {
	const pulita = pulisciRubrica(r);
	scriviPrivato(file, pulita);
	return pulita;
}

/** Aggiunge alla voce di un progetto un gruppo WhatsApp (JID @g.us), un indirizzo (se c'e' la chiocciola),
 *  un telefono (cifre, spazi, + iniziale) o un dominio. */
export function aggiungiVoce(r: Rubrica, progetto: string, voce: string): Rubrica {
	const p = String(progetto ?? '').replace(/\/+$/, '');
	if (!p.startsWith('/')) return r;
	const v = String(voce ?? '').trim();
	const out: Rubrica = JSON.parse(JSON.stringify(r));
	const cur: VoceRubrica = out[p] ?? { indirizzi: [], domini: [] };
	const gru = normGruppo(v);
	const ind = !gru && /^[^@\s]+@/.test(v) ? normIndirizzo(v) : '';
	const tel = gru || ind ? '' : normTelefono(v);
	const dom = gru || ind || tel ? '' : normDominio(v);
	const metti = (k: 'indirizzi' | 'domini' | 'telefoni' | 'gruppi', x: string) => {
		const l = (cur[k] ??= []);
		if (!l.includes(x)) l.push(x);
	};
	if (gru) metti('gruppi', gru);
	if (ind) metti('indirizzi', ind);
	if (tel) metti('telefoni', tel);
	if (dom) metti('domini', dom);
	if (gru || ind || tel || dom) out[p] = cur;
	return out;
}

export function togliVoce(r: Rubrica, progetto: string, voce: string): Rubrica {
	const out: Rubrica = JSON.parse(JSON.stringify(r));
	const cur = out[progetto];
	if (!cur) return out;
	const v = String(voce ?? '').trim().toLowerCase();
	const tel = normTelefono(v);
	cur.indirizzi = cur.indirizzi.filter(x => x !== v);
	cur.domini = cur.domini.filter(x => x !== v);
	if (cur.telefoni) cur.telefoni = cur.telefoni.filter(x => x !== v && x !== tel);
	if (cur.gruppi) cur.gruppi = cur.gruppi.filter(x => x !== v);
	if (!cur.telefoni?.length) delete cur.telefoni;
	if (!cur.gruppi?.length) delete cur.gruppi;
	if (!vociDi(cur).length) delete out[progetto];
	return out;
}

/** I progetti di un numero di telefono (E.164) o di un gruppo WhatsApp. */
export function progettiDiTelefono(telefono: string, r: Rubrica): string[] {
	const t = normTelefono(telefono);
	return t ? Object.entries(r).filter(([, v]) => (v.telefoni ?? []).includes(t)).map(([p]) => p) : [];
}

export function progettiDiGruppo(jid: string, r: Rubrica): string[] {
	const g = normGruppo(jid);
	return g ? Object.entries(r).filter(([, v]) => (v.gruppi ?? []).includes(g)).map(([p]) => p) : [];
}

/** I progetti di un mittente: l'indirizzo esatto vince sul dominio; tra i domini vince il piu' lungo
 *  ("posta.cliente.it" batte "cliente.it"). A parita' tornano tutti. */
export function progettiDi(indirizzo: string, r: Rubrica): string[] {
	const ind = normIndirizzo(indirizzo);
	if (!ind) return [];
	const esatti = Object.entries(r).filter(([, v]) => v.indirizzi.includes(ind)).map(([p]) => p);
	if (esatti.length) return esatti;
	const dom = dominioDi(ind);
	let best = 0;
	let out: string[] = [];
	for (const [p, v] of Object.entries(r)) {
		for (const d of v.domini) {
			if (dom !== d && !dom.endsWith('.' + d)) continue;
			if (d.length > best) {
				best = d.length;
				out = [p];
			} else if (d.length === best && !out.includes(p)) out.push(p);
		}
	}
	return out;
}

export interface Assegnazione {
	perProgetto: Record<string, Filo[]>;
	daAssegnare: Filo[];
}

export function assegna(fili: Filo[], r: Rubrica): Assegnazione {
	const perProgetto: Record<string, Filo[]> = {};
	const daAssegnare: Filo[] = [];
	for (const f of fili) {
		const ps = progettiDi(f.indirizzo, r);
		if (!ps.length) daAssegnare.push(f);
		for (const p of ps) (perProgetto[p] ??= []).push(f);
	}
	return { perProgetto, daAssegnare };
}

/** "Da assegnare" raggruppato per mittente, dal piu' recente. */
export function mittentiDaAssegnare(fili: Filo[], limite = 40): { indirizzo: string; dominio: string; generico: boolean; nome: string; n: number; nonLetti: number; ultimo: Filo }[] {
	const m = new Map<string, Filo[]>();
	for (const f of fili) {
		if (!f.indirizzo) continue;
		const l = m.get(f.indirizzo) ?? [];
		l.push(f);
		m.set(f.indirizzo, l);
	}
	return [...m.entries()]
		.map(([indirizzo, l]) => {
			const ord = [...l].sort((a, b) => (b.data || '').localeCompare(a.data || ''));
			const dominio = dominioDi(indirizzo);
			const nome = (/^\s*"?([^"<]+?)"?\s*</.exec(ord[0].da)?.[1] ?? '').trim();
			return { indirizzo, dominio, generico: POSTA_GENERICA.has(dominio), nome, n: l.length, nonLetti: l.filter(f => f.nonLetto).length, ultimo: ord[0] };
		})
		.sort((a, b) => (b.ultimo.data || '').localeCompare(a.ultimo.data || ''))
		.slice(0, limite);
}

// ---------- suggerimenti dai file del progetto ----------

const FILE_SUGGERIMENTI = ['package.json', 'vercel.json', 'README.md', 'readme.md', 'README.it.md', 'CLAUDE.md'];
const RE_URL = /\bhttps?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?/gi;

/** Domini dagli URL nel testo, senza quelli generici. */
export function dominiNelTesto(testo: string, extra: Set<string> = new Set()): string[] {
	const out: string[] = [];
	for (const m of String(testo ?? '').matchAll(RE_URL)) {
		const d = dominioBase(m[1]);
		if (d && !generico(d, extra) && !POSTA_GENERICA.has(d)) out.push(d);
	}
	return out;
}

/** I domini nei file di un progetto, con il peso (frequenza, 3 per homepage e alias) e il primo file che li cita. */
export function dominiDeiFile(dir: string, ignorati: string[] = []): Map<string, { peso: number; file: string }> {
	const extra = new Set(ignorati.map(normDominio).filter(Boolean));
	const conta = new Map<string, { peso: number; file: string }>();
	let f = '';
	const add = (d: string, peso = 1) => {
		if (!d || generico(d, extra) || POSTA_GENERICA.has(d)) return;
		const cur = conta.get(d);
		conta.set(d, { peso: (cur?.peso ?? 0) + peso, file: cur?.file ?? f });
	};
	for (const nome of FILE_SUGGERIMENTI) {
		f = nome;
		let testo = '';
		try {
			const p = path.join(dir, f);
			const st = fs.statSync(p);
			if (!st.isFile() || st.size > 400_000) continue;
			testo = fs.readFileSync(p, 'utf8');
		} catch {
			continue;
		}
		if (f === 'package.json') {
			try {
				const pkg = JSON.parse(testo);
				if (typeof pkg.homepage === 'string') add(dominioBase(pkg.homepage), 3);
			} catch {
				// package.json rovinato
			}
			continue;
		}
		if (f === 'vercel.json') {
			try {
				const v = JSON.parse(testo);
				for (const a of [...(Array.isArray(v.alias) ? v.alias : []), ...(Array.isArray(v.domains) ? v.domains : [])]) add(dominioBase(String(a)), 3);
			} catch {
				// vercel.json rovinato
			}
		}
		for (const d of dominiNelTesto(testo, extra)) add(d);
	}
	return conta;
}

/** Domini suggeriti per un progetto: homepage di package.json, vercel.json, URL nel README e in CLAUDE.md.
 *  Ordinati per frequenza, senza quelli gia' in rubrica (`noti`), senza quelli ignorati e senza `esclusi`
 *  (i domini che compaiono in piu' progetti). */
export function suggerisciDomini(dir: string, noti: string[] = [], ignorati: string[] = [], esclusi: Set<string> = new Set()): string[] {
	const gia = new Set(noti.map(x => x.toLowerCase()));
	return [...dominiDeiFile(dir, ignorati).entries()]
		.filter(([d]) => !gia.has(d) && !esclusi.has(d))
		.sort((a, b) => b[1].peso - a[1].peso || a[0].localeCompare(b[0]))
		.slice(0, 6)
		.map(([d]) => d);
}

// ---------- proposte dalla posta ----------

export interface ProgettoIndice {
	path: string;
	name: string;
	/** Domini che stanno nei file di questo progetto e di nessun altro, con il file che li cita. */
	domini: Map<string, string>;
}

/** I domini dei file di tutti i progetti, senza quelli che compaiono in piu' di un progetto: quelli sono di
 *  fornitori (agnes-ai.com, elevenlabs.io, tailscale.com...), non di clienti. */
export function indiceProgetti(progetti: { path: string; name: string }[], ignorati: string[] = [], leggi = dominiDeiFile): { indice: ProgettoIndice[]; condivisi: Set<string> } {
	const per = progetti.map(p => ({ ...p, tutti: leggi(p.path, ignorati) }));
	const quanti = new Map<string, number>();
	for (const p of per) for (const d of p.tutti.keys()) quanti.set(d, (quanti.get(d) ?? 0) + 1);
	const condivisi = new Set([...quanti.entries()].filter(([, n]) => n > 1).map(([d]) => d));
	const indice = per.map(p => ({
		path: p.path,
		name: p.name,
		domini: new Map([...p.tutti.entries()].filter(([d]) => !condivisi.has(d)).map(([d, x]) => [d, x.file])),
	}));
	return { indice, condivisi };
}

/** Le parole di un nome: "CheckIn Facile" -> [checkin, facile], "ImmobiliareAI" -> [immobiliare, ai]. */
export function paroleNome(s: string): string[] {
	return String(s ?? '')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/** Vero se `testo` cita il progetto: parole intere di seguito che, attaccate, fanno il nome attaccato
 *  ("CheckIn Facile" = "checkin facile" = "checkinfacile" = "check in facile"). Nomi sotto le 4 lettere non contano. */
export function citaProgetto(testo: string, nome: string): boolean {
	const compatto = paroleNome(nome).join('');
	if (compatto.length < 4) return false;
	const t = paroleNome(testo);
	for (let i = 0; i < t.length; i++) {
		let s = '';
		for (let j = i; j < t.length && s.length < compatto.length; j++) {
			s += t[j];
			if (s === compatto) return true;
		}
	}
	return false;
}

const NOME_FILE: Record<string, string> = { 'readme.md': 'README', 'readme.it.md': 'README', 'claude.md': 'CLAUDE.md', 'package.json': 'package.json', 'vercel.json': 'vercel.json' };

export interface Proposta {
	path: string;
	name: string;
	/** Cosa aggiungere alla rubrica: il dominio se il mittente e' di un dominio proprio, altrimenti l'indirizzo. */
	voce: string;
	motivo: string;
}

/** Proposte per i mittenti in "Da assegnare", dal piu' forte: dominio nei file di un solo progetto, dominio che
 *  richiama il nome, nome del mittente che cita il progetto, oggetto che lo cita. Se a parita' di forza i
 *  progetti sono piu' d'uno, nessuna proposta. I mittenti automatici restano fuori. */
export function proposte(fili: Filo[], indice: ProgettoIndice[]): Record<string, Proposta> {
	const per = new Map<string, Filo[]>();
	for (const f of fili) if (f.indirizzo && !mittenteAutomatico(f.indirizzo)) per.set(f.indirizzo, [...(per.get(f.indirizzo) ?? []), f]);
	const out: Record<string, Proposta> = {};
	for (const [indirizzo, l] of per) {
		const dom = dominioDi(indirizzo);
		const base = dominioBase(dom);
		const proprio = !!base && !POSTA_GENERICA.has(base) && !POSTA_GENERICA.has(dom);
		const nomeMitt = (/^\s*"?([^"<]+?)"?\s*</.exec(l[0].da)?.[1] ?? '').trim();
		const livelli: ((p: ProgettoIndice) => string | undefined)[] = [
			p => {
				if (!proprio) return undefined;
				const file = p.domini.get(base) ?? p.domini.get(dom);
				return file ? `il dominio è nel ${NOME_FILE[file.toLowerCase()] ?? file}` : undefined;
			},
			p => (proprio && citaProgetto(base.replace(/\.[a-z]+$/, ''), p.name) ? `il dominio richiama ${p.name}` : undefined),
			p => (nomeMitt && citaProgetto(nomeMitt, p.name) ? `il nome del mittente cita ${p.name}` : undefined),
			p => (l.some(f => citaProgetto(f.oggetto, p.name)) ? `l'oggetto cita ${p.name}` : undefined),
		];
		for (const [i, prova] of livelli.entries()) {
			const trovati = indice.map(p => ({ p, motivo: prova(p) })).filter(x => x.motivo);
			if (!trovati.length) continue;
			if (trovati.length === 1) {
				const { p, motivo } = trovati[0];
				out[indirizzo] = { path: p.path, name: p.name, voce: proprio && i < 2 ? base : indirizzo, motivo: motivo! };
			}
			break;
		}
	}
	return out;
}

// ---------- fonti ----------

const RE_THREAD = /^[A-Za-z0-9_-]{6,64}$/;

export function linkGmail(threadId: string): string | undefined {
	return RE_THREAD.test(threadId) ? `https://mail.google.com/mail/u/0/#all/${threadId}` : undefined;
}

const testo = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function dataIso(s: unknown): string {
	const t = Date.parse(String(s ?? ''));
	return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

/** Il risultato di search_messages di mail-mcp: { messages: [{ account, mailbox, id, subject, sender, date, read }] }. */
export function filiDaMailMcp(json: any): Filo[] {
	const msgs = Array.isArray(json?.messages) ? json.messages : Array.isArray(json) ? json : [];
	const out: Filo[] = [];
	for (const m of msgs) {
		if (m?.id === undefined || m?.id === null) continue;
		const da = testo(m.sender, 200);
		out.push({
			id: `mail:${testo(m.account, 80)}:${testo(m.mailbox, 80)}:${m.id}`,
			fonte: 'mail',
			da,
			indirizzo: indirizzoDa(da),
			oggetto: testo(m.subject, 200),
			data: dataIso(m.date),
			nonLetto: m.read === false,
			anteprima: '',
		});
	}
	return out;
}

/** Il JSON della delega Gmail: [{ threadId, da, oggetto, data, nonLetto, anteprima }]. Le voci storte si scartano. */
export function filiDaGmail(data: unknown): Filo[] {
	const arr = Array.isArray(data) ? data : Array.isArray((data as any)?.fili) ? (data as any).fili : [];
	const out: Filo[] = [];
	const seen = new Set<string>();
	for (const x of arr) {
		const threadId = String(x?.threadId ?? x?.id ?? '').trim();
		if (!RE_THREAD.test(threadId) || seen.has(threadId)) continue;
		seen.add(threadId);
		const da = testo(x.da ?? x.from ?? x.sender, 200);
		out.push({
			id: `gmail:${threadId}`,
			fonte: 'gmail',
			threadId,
			da,
			indirizzo: indirizzoDa(da),
			oggetto: testo(x.oggetto ?? x.subject, 200),
			data: dataIso(x.data ?? x.date),
			nonLetto: x.nonLetto === true || x.unread === true,
			anteprima: testo(x.anteprima ?? x.snippet, 160),
			link: linkGmail(threadId),
		});
	}
	return out;
}

/** La query Gmail per la delega: i mittenti e i domini in rubrica, piu' i non letti della posta principale
 *  (da cui escono i mittenti da assegnare). */
export function queryGmail(r: Rubrica, giorni: number): { rubrica: string; sconosciuti: string } {
	const voci = new Set<string>();
	for (const v of Object.values(r)) {
		for (const i of v.indirizzi) voci.add(i);
		for (const d of v.domini) voci.add(d);
	}
	const g = Math.max(1, Math.min(90, Math.round(giorni) || 7));
	return {
		rubrica: voci.size ? `newer_than:${g}d {${[...voci].slice(0, 60).map(v => `from:${v}`).join(' ')}}` : '',
		sconosciuti: `newer_than:${g}d is:unread in:inbox category:primary`,
	};
}

export const SCHEMA_FILI = `[{"threadId": "id del filo, come lo restituisce Gmail", "da": "Nome <indirizzo@dominio>", "oggetto": "oggetto del filo", "data": "data dell'ultimo messaggio, ISO 8601", "nonLetto": true, "anteprima": "al massimo 140 caratteri dello snippet"}]`;

export function richiestaGmail(r: Rubrica, giorni: number, prefisso: string): RichiestaDelega {
	const q = queryGmail(r, giorni);
	const ricerche = [q.rubrica, q.sconosciuti].filter(Boolean);
	return {
		capacita: 'posta',
		compito:
			`Cerca i fili di posta con ${prefisso}search_threads (pageSize 25, view THREAD_VIEW_MINIMAL), ` +
			`una ricerca per ciascuna di queste query: ${ricerche.map(x => JSON.stringify(x)).join(' e ')}. ` +
			'Unisci i risultati senza doppioni (al massimo 50 fili) e per ogni filo riporta id, mittente, oggetto, data, ' +
			'se ha l\'etichetta UNREAD (nonLetto) e lo snippet. Non aprire i singoli fili.',
		schema: SCHEMA_FILI,
		strumenti: [`${prefisso}search_threads`],
	};
}

// ---------- il motore ----------

export interface FonteStato {
	nome: string;
	at: number;
	n: number;
	costo?: number;
	durataMs?: number;
	errore?: string;
	/** La fonte ha restituito il massimo che puo': i messaggi potrebbero essere di piu'. */
	pieno?: boolean;
}

/** Il massimo di messaggi che mail-mcp restituisce in un search_messages. */
export const LIMITE_LOCALE = 500;

interface FileFili {
	at: number;
	giorni: number;
	fonti: { locale?: FonteStato; gmail?: FonteStato };
	fili: Filo[];
}

export interface PostaDeps {
	file?: string;
	rubricaFile?: string;
	/** Il server di posta locale da interrogare direttamente, se c'e'. */
	serverLocale(): string | null;
	/** Il prefisso degli strumenti Gmail di claude.ai, se il connettore e' connesso. */
	prefissoGmail(): string | null;
	/** Chiama search_messages sul server locale. */
	cercaLocale(server: string, args: Record<string, unknown>): Promise<any>;
	delega(r: RichiestaDelega): Promise<EsitoDelega>;
	giorni(): number;
	onChange(): void;
	log(s: string): void;
	ora?: () => number;
}

export class MotorePosta {
	private dati: FileFili;
	aggiornando: 'locale' | 'gmail' | null = null;
	errore?: string;

	constructor(private readonly d: PostaDeps) {
		this.dati = this.leggi();
	}

	private get file(): string {
		return this.d.file ?? FILI_FILE;
	}

	private ora(): number {
		return this.d.ora ? this.d.ora() : Date.now();
	}

	private leggi(): FileFili {
		try {
			const x = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			if (x && Array.isArray(x.fili)) return { at: Number(x.at) || 0, giorni: Number(x.giorni) || 7, fonti: x.fonti ?? {}, fili: x.fili };
		} catch {
			// primo avvio
		}
		return { at: 0, giorni: 7, fonti: {}, fili: [] };
	}

	rubrica(): Rubrica {
		return leggiRubrica(this.d.rubricaFile);
	}

	salvaRubrica(r: Rubrica): Rubrica {
		return scriviRubrica(r, this.d.rubricaFile);
	}

	get fili(): Filo[] {
		return this.dati.fili;
	}

	get fonti(): FileFili['fonti'] {
		return this.dati.fonti;
	}

	get aggiornatoAt(): number {
		return this.dati.at;
	}

	private sostituisci(fonte: 'mail' | 'gmail', nuovi: Filo[], stato: FonteStato): void {
		const giorni = this.d.giorni();
		const limite = this.ora() - giorni * 24 * 3_600_000;
		const altri = this.dati.fili.filter(f => f.fonte !== fonte && (!f.data || Date.parse(f.data) >= limite));
		const fili = [...nuovi, ...altri].sort((a, b) => (b.data || '').localeCompare(a.data || '')).slice(0, 700);
		this.dati = {
			at: this.ora(),
			giorni,
			fonti: { ...this.dati.fonti, [fonte === 'mail' ? 'locale' : 'gmail']: stato },
			fili,
		};
		try {
			scriviPrivato(this.file, this.dati);
		} catch (e) {
			this.d.log(`posta: non salvo i fili (${e})`);
		}
	}

	/** Un errore resta su disco come i fili: alla riapertura la stanza lo mostra ancora. I fili di prima restano. */
	private salvaFonte(fonte: 'locale' | 'gmail', stato: FonteStato): void {
		this.dati = { ...this.dati, fonti: { ...this.dati.fonti, [fonte]: stato } };
		try {
			scriviPrivato(this.file, this.dati);
		} catch (e) {
			this.d.log(`posta: non salvo lo stato della fonte (${e})`);
		}
	}

	/** La fonte locale: un solo search_messages, solo intestazioni, mai il corpo. */
	async aggiornaLocale(): Promise<void> {
		const server = this.d.serverLocale();
		if (!server || this.aggiornando) return;
		this.aggiornando = 'locale';
		this.errore = undefined;
		this.d.onChange();
		const t0 = this.ora();
		try {
			const since = new Date(t0 - this.d.giorni() * 24 * 3_600_000).toISOString().slice(0, 10);
			const json = await this.d.cercaLocale(server, { since, limit: LIMITE_LOCALE, includeBody: false });
			const fili = filiDaMailMcp(json);
			const n = Array.isArray(json?.messages) ? json.messages.length : fili.length;
			this.sostituisci('mail', fili, { nome: server, at: this.ora(), n: fili.length, durataMs: this.ora() - t0, ...(n >= LIMITE_LOCALE ? { pieno: true } : {}) });
		} catch (e: any) {
			this.errore = `${server} non risponde: ${String(e?.message ?? e).slice(0, 200)}`;
			this.salvaFonte('locale', { nome: server, at: this.ora(), n: 0, errore: this.errore });
		} finally {
			this.aggiornando = null;
			this.d.onChange();
		}
	}

	/** Gmail: UNA delega a claude -p. */
	async aggiornaGmail(): Promise<void> {
		const prefisso = this.d.prefissoGmail();
		if (!prefisso || this.aggiornando) return;
		this.aggiornando = 'gmail';
		this.errore = undefined;
		this.d.onChange();
		try {
			const e = await this.d.delega(richiestaGmail(this.rubrica(), this.d.giorni(), prefisso));
			if (!e.ok) {
				this.errore = `Gmail: ${e.errore ?? 'la delega non e\' riuscita'}`;
				this.salvaFonte('gmail', { nome: 'Gmail', at: e.at, n: 0, costo: e.costo, durataMs: e.durataMs, errore: e.errore });
			} else {
				const fili = filiDaGmail(e.data);
				this.sostituisci('gmail', fili, { nome: 'Gmail', at: e.at, n: fili.length, costo: e.costo, durataMs: e.durataMs });
			}
		} finally {
			this.aggiornando = null;
			this.d.onChange();
		}
	}
}
