/* Le stanze della plancia per l'iPhone (docs/CONTRATTI.md, 9.6): una rotta sola, in sola lettura, chiamata da
   src/ponte.ts dopo il gettone.

     GET /v1/stanza?nome=<appstore|cruscotto|vedetta|dafare|posta|clienti|notte|servizi|consigli>&periodo=..&progetto=..&mese=..

   Restituisce JSON strutturato (numeri, elenchi corti), non le frasi per la voce: l'app disegna grafici e righe.
   Legge le stesse fonti che usa Melissa per `stanza_leggi` (src/strumenti-stanze.ts, `fontiStanze()`), cioe' lo
   stato che la plancia mostra: AppStore.state(), il calcolo del cruscotto, regole e radar, ore per cliente, Memoria,
   posta della stanza Connettori, notte. Nessuna chiamata di rete, nessuna delega, nessuna scrittura. Gli elenchi
   sono tagliati: una risposta sta sotto qualche decina di KB.

   Posta e WhatsApp: solo nome del contatto, progetto, oggetto e un'anteprima breve; mai indirizzi, numeri o corpi
   delle mail (un mittente senza nome diventa il dominio, un contatto che e' solo un numero diventa «contatto senza nome»,
   un indirizzo o un telefono dentro l'oggetto diventa «[indirizzo]» o «[numero]»).
   Niente di quello che passa di qui finisce nei registri del ponte.

   Due stanze in piu' per i widget dell'iPhone: `servizi` (i crediti di DeepSeek, ElevenLabs e Agnes dal
   file dei conti, ~/.bottega/conti/giorni.json, CONTRATTI 14) e `consigli` (la cosa piu' utile da fare adesso: il
   buco piu' grosso dell'App Store, una regola rossa, un lavoro che ti aspetta, le cose da fare della Memoria, i
   consigli della Home). Niente posta ne' WhatsApp: finiscono in un widget.

   Una sola rotta che scrive, la stanza App Store (CONTRATTI 9.7):

     POST /v1/stanza/azione {stanza: 'appstore', azione: ignora|ripristina|verifica|lavoro, id?, motivo?, compito?}

   Un elenco chiuso di azioni, gli stessi gestori della plancia (handleAppStore di appstore-host.ts) e, per
   «Fallo sistemare a Claude», lo stesso avvio dei lavori di Melissa (lavoro_nuovo). Il progetto viene sempre dal
   buco, mai dall'iPhone. Push e pubblicazioni da qui non partono: non sono nell'elenco, e ogni compito porta in
   fondo la frase che lo dice a Claude. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BucoChiuso, FormatoApp, RepoEsito, Scheda, UnitaApp, Verifica } from './appstore';
import { readBriefing } from './briefing';
import { splitSummary } from './continua';
import type { WorkItem } from './jobs';
import type { RotteStanze } from './ponte';
import { FontiStanze, meseDa, periodoDa, pulisci, SerieStore, StatoStore } from './strumenti-stanze';

export const STANZE_PONTE = ['appstore', 'cruscotto', 'vedetta', 'dafare', 'posta', 'clienti', 'notte', 'servizi', 'consigli'] as const;
export type StanzaPonte = (typeof STANZE_PONTE)[number];

export interface StanzeDeps {
	/** Le fonti di Melissa (fontiStanze di strumenti-stanze.ts): undefined finche' la Bottega non le ha registrate. */
	fonti(): FontiStanze | undefined;
	/** Il lavoro in giro: per la notte, i lavori in fila per stanotte. */
	lavori?(): WorkItem[];
	ora?(): number;
	/** Quanto aspettare un calcolo lento (cruscotto, clienti, Memoria). */
	tempoMs?: number;
	/** Il file dei conti dei servizi (CONTRATTI 14); predefinito ~/.bottega/conti/giorni.json. */
	contiFile?: string;
	/** I consigli della Home (src/idee.ts, Advice); predefinito quelli salvati in ~/.bottega/briefing.json. */
	consigliHome?(): { at: number; engine: string; items: { text: string }[] } | null | undefined;
	/** Le azioni della stanza App Store (POST /v1/stanza/azione); senza, la rotta risponde 503. */
	azioni?: AzioniAppStore;
}

/** Le azioni che l'iPhone puo' chiedere alla stanza App Store: un elenco chiuso. */
export const AZIONI_APPSTORE = ['ignora', 'ripristina', 'verifica', 'lavoro'] as const;

/** Chi esegue le azioni: ponte-host.ts le gira agli stessi gestori della plancia e di Melissa. */
export interface AzioniAppStore {
	/** «Ignora», con il motivo (appstore.ignora della plancia). */
	ignora(id: string, motivo: string): void;
	/** «Ripristina» un buco ignorato (appstore.ripristina). */
	ripristina(id: string): void;
	/** «Verifica di nuovo»: rilegge AdMob e lo Store adesso, come «Aggiorna» nella stanza (appstore.refresh). */
	verifica(): void;
	/** Un lavoro Claude sul progetto, come lavoro_nuovo di Melissa; undefined se i lavori non sono pronti. */
	lavoro(path: string, compito: string): { id: string; stato: string } | undefined;
}

const errore = (status: number, msg: string) => Object.assign(new Error(msg), { status });
const norma = (s: string) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
const somma = (v: number[]) => v.reduce((s, x) => s + (Number(x) || 0), 0);
const tondo = (n: number, dec = 2) => Math.round((Number(n) || 0) * 10 ** dec) / 10 ** dec;
const range = (da: number, a: number) => Array.from({ length: Math.max(0, a - da) }, (_, i) => da + i);
const pad = (n: number) => String(n).padStart(2, '0');
const chiaveMese = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const baseNome = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const testo = (s: unknown, max: number) => pulisci(String(s ?? ''), max);

/** «ieri», «settimana», «mese», «anno» o i giorni (1, 7, 30, 90, 365). */
export function periodoParam(v: string | null, predefinito: number): number {
	const t = norma(v ?? '');
	const nomi: Record<string, number> = { oggi: 1, ieri: 1, giorno: 1, settimana: 7, mese: 30, trimestre: 90, anno: 365 };
	return nomi[t] ?? periodoDa(t ? Number(t) : NaN, predefinito);
}

/** Un mittente senza indirizzo: il nome se c'e', altrimenti il dominio. */
export function mittenteSicuro(da: string): string {
	const s = String(da ?? '');
	const nome = s.replace(/<[^>]*>/g, ' ').replace(/["']/g, '').replace(/\S+@\S+/g, ' ').replace(/\s+/g, ' ').trim();
	if (nome && !/^[+\d\s().\-/]+$/.test(nome)) return testo(nome, 40);
	const dominio = /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(s)?.[1];
	return dominio ? dominio.toLowerCase() : 'mittente senza nome';
}

/** Un contatto WhatsApp senza numero: se il nome e' solo un numero di telefono non esce. */
export function contattoSicuro(c: string, gruppo: boolean): string {
	const t = String(c ?? '').trim();
	if (!t || /^[+\d\s().\-/]{5,}$/.test(t) || /@/.test(t)) return gruppo ? 'gruppo senza nome' : 'contatto senza nome';
	return testo(t, 40);
}

/** Un'anteprima breve, senza indirizzi ne' numeri lunghi dentro il testo. */
export function anteprimaSicura(s: string, max = 60): string {
	const t = String(s ?? '')
		.replace(/\S+@\S+\.\S+/g, '[indirizzo]')
		.replace(/\+?\d[\d\s().\-/]{6,}\d/g, '[numero]');
	return testo(t, max);
}

/** L'oggetto di una mail: senza indirizzi ne' numeri di telefono, ma con date, versioni e numeri d'ordine intatti
 *  (un oggetto vero puo' contenere un indirizzo: «Inoltro da mario@...»). */
export function oggettoSicuro(s: string, max = 90): string {
	const t = String(s ?? '')
		.replace(/[\w.+%-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi, '[indirizzo]')
		.replace(/\+\d[\d\s().\-/]{6,}\d|\b\d(?:[ .]?\d){8,}\b/g, '[numero]');
	return testo(t, max);
}

async function conTempo<T>(p: Promise<T>, ms: number): Promise<T | 'tempo'> {
	let t: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([p, new Promise<'tempo'>(ok => (t = setTimeout(() => ok('tempo'), ms)))]);
	} finally {
		clearTimeout(t);
	}
}

interface Domanda {
	periodo: string | null;
	progetto?: string;
	mese?: string;
	/** Per appstore: la chiave di un'app (ios:<id>, android:<pacchetto>, admob:<id>), la sua scheda. */
	app?: string;
}

// ---------- App Store ----------

/** I campi di AppStoreStato (CONTRATTI 13.2) oltre il minimo di strumenti-stanze: tutti facoltativi, cosi' uno
 *  stato vecchio o parziale non rompe la rotta. */
interface Abbonamenti {
	attivi: number[];
	prove: number[];
	mrr: number[];
	ritardo: number[];
	grazia: number[];
	eventi: Record<string, number[]>;
}
type BucoStore = StatoStore['buchi'][number] & {
	id?: string;
	perche?: string;
	stimaNota?: string;
	daQuando?: number;
	compito?: string;
	tipo?: string;
	fonte?: string;
	misura?: number;
	soglia?: number;
	verifica?: Verifica;
};
type AppStoreRiga = StatoStore['app'][number] & {
	piattaforma?: string;
	bundleId?: string;
	admobId?: string;
	approvazione?: string;
	collegata?: boolean;
	abbonamenti?: Abbonamenti;
	scheda?: Scheda;
	formati?: FormatoApp[];
	unita?: UnitaApp[];
	acquisti?: { nuovi: number; rinnovi: number; altri: number; euro: number };
	repo?: RepoEsito;
	versioni?: { v: string; quando: string }[];
	versioniMesi?: { v: string; quando: string }[];
};
type StatoStoreRicco = Omit<StatoStore, 'app' | 'buchi' | 'totale'> & {
	fase?: string;
	storeSenzaDati?: string[];
	abbFinoA?: string;
	schedaFinoA?: string;
	controlloOre?: number;
	totale: StatoStore['totale'] & { abbonamenti?: Abbonamenti; scheda?: Scheda };
	app: AppStoreRiga[];
	buchi: BucoStore[];
	paesi?: { codice: string; euro: number; impressioni: number }[];
	risolti?: BucoChiuso[];
	ignorati?: BucoChiuso[];
	allarmi?: { chiave?: string; app: string; testo: string; at: number }[];
};

interface Cifre {
	totale: number;
	admob: number;
	store: number;
	download: number;
}

function cifre(s: SerieStore[], idx: number[]): Cifre {
	const v = (k: keyof SerieStore) => s.reduce((t, x) => t + idx.reduce((u, i) => u + (Number(x[k]?.[i]) || 0), 0), 0);
	const admob = v('admob');
	const store = v('store');
	return { totale: tondo(admob + store), admob: tondo(admob), store: tondo(store), download: Math.round(v('dl')) };
}

function sommaAbbonamenti(l: Abbonamenti[]): Abbonamenti | undefined {
	if (!l.length) return undefined;
	if (l.length === 1) return l[0];
	const n = Math.max(...l.map(a => a.attivi.length));
	const somme = (k: 'attivi' | 'prove' | 'mrr' | 'ritardo' | 'grazia') => range(0, n).map(i => somma(l.map(a => a[k]?.[i] ?? 0)));
	const eventi: Record<string, number[]> = {};
	for (const a of l) for (const [k, v] of Object.entries(a.eventi ?? {})) eventi[k] = range(0, n).map(i => (eventi[k]?.[i] ?? 0) + (Number(v[i]) || 0));
	return { attivi: somme('attivi'), prove: somme('prove'), mrr: somme('mrr'), ritardo: somme('ritardo'), grazia: somme('grazia'), eventi };
}

function sommaScheda(l: Scheda[]): Scheda | undefined {
	if (l.length <= 1) return l[0];
	const n = Math.max(...l.map(s => s.imp.length));
	const somme = (k: 'imp' | 'vis' | 'dl') => range(0, n).map(i => somma(l.map(s => s[k]?.[i] ?? 0)));
	const fonti: Scheda['fonti'] = {};
	for (const s of l) {
		for (const [k, v] of Object.entries(s.fonti ?? {})) {
			const t = (fonti[k] ??= { imp: 0, vis: 0, dl: 0 });
			t.imp += v.imp || 0;
			t.vis += v.vis || 0;
			t.dl += v.dl || 0;
		}
	}
	return { imp: somme('imp'), vis: somme('vis'), dl: somme('dl'), fonti };
}

/** La scheda dello Store nella finestra che finisce all'ultimo giorno con dati (Apple li prepara con due o tre giorni
 *  di ritardo), e lo stesso tratto prima: come finestraScheda di media/appstore.js (per l'anno, 30 giorni). */
function finestraScheda(sc: Scheda | undefined, giorni: string[], finoA: string | undefined, g: number) {
	if (!sc || !finoA) return null;
	const fine = giorni.indexOf(finoA);
	if (fine < 0) return null;
	const k = g > 30 ? 30 : Math.max(g, 7);
	const da = Math.max(0, fine + 1 - k);
	const p = Math.max(0, da - k);
	const t = (a: number[], x: number, y: number) => Math.round(somma((a ?? []).slice(x, y)));
	return {
		finoA,
		giorni: fine + 1 - da,
		imp: t(sc.imp, da, fine + 1),
		vis: t(sc.vis, da, fine + 1),
		dl: t(sc.dl, da, fine + 1),
		impPrima: t(sc.imp, p, da),
		visPrima: t(sc.vis, p, da),
		dlPrima: t(sc.dl, p, da),
		haPrima: (sc.imp ?? []).slice(p, da).some(Boolean),
	};
}

/** Il compito per un lavoro Claude: quello scritto dalla regola del buco o, se la regola non ne ha uno, il buco stesso
 *  in chiaro. Una riga sola: arriva al terminale come argomento di claude. */
export function compitoBuco(b: { app: string; titolo: string; perche?: string; cosa: string; compito?: string }): string {
	if (b.compito) return pulisci(b.compito, 3000);
	return pulisci(`Nell'app ${b.app}: ${b.titolo}. ${b.perche ? `${b.perche} ` : ''}Cosa fare: ${b.cosa} Prima di cambiare il codice guarda come è fatto adesso e dimmi cosa cambi.`, 3000);
}

/** In coda a ogni compito partito dall'iPhone: un push o una pubblicazione da qui non partono mai. */
export const CODA_COMPITO = 'Questo lavoro parte dall\'iPhone: non fare git push, non pubblicare e non mandare niente in revisione. Quello lo decide Andrea dal Mac.';

/** Il compito scritto (o corretto) da Andrea sull'iPhone: una riga, senza caratteri di controllo, al massimo 3000. */
export function compitoPulito(s: unknown): string {
	return pulisci(String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' '), 3000);
}

function appStore(f: FontiStanze, d: Domanda, now: number) {
	const st = f.appStore?.() as StatoStoreRicco | undefined;
	if (!st) throw errore(503, 'La stanza App Store non è pronta.');
	if (!st.aggiornatoAt) {
		throw errore(503, st.aggiornando ? 'La stanza App Store sta leggendo i dati per la prima volta: riprova tra un minuto.' : 'La stanza App Store non ha ancora letto i dati: aprila sul Mac e si aggiorna da sola.');
	}
	const g = periodoParam(d.periodo, 30);
	const mese = meseDa(d.mese, now);

	// il filtro: un'app precisa (la sua scheda sull'iPhone), le app del progetto, oppure un'app per nome (come stanza_leggi)
	let app = st.app;
	if (d.app) {
		app = st.app.filter(x => x.chiave === d.app);
		if (!app.length) throw errore(404, 'Questa app non c\'è più nella stanza App Store.');
	} else if (d.progetto) {
		const p = f.progetto(d.progetto);
		const q = norma(d.progetto);
		const delProgetto = p ? st.app.filter(x => x.projectPath === p.path) : [];
		app = delProgetto.length ? delProgetto : st.app.filter(x => q && (norma(x.nome).includes(q) || norma(x.projectName ?? '').includes(q)));
		if (!app.length) throw errore(404, `Non trovo app di «${testo(d.progetto, 60)}» nella stanza App Store.`);
	}
	const filtrato = !!(d.app || d.progetto);

	let quale: 'giorni' | 'mesi';
	let idx: number[];
	let prima: number[];
	let grafico: number[];
	let etichetta: string;
	if (mese) {
		const i = st.mesi.indexOf(mese);
		if (i < 0) throw errore(404, 'Quel mese non c\'è: la stanza tiene gli ultimi 24 mesi.');
		quale = 'mesi';
		idx = [i];
		prima = i > 0 ? [i - 1] : [];
		grafico = range(Math.max(0, i - 11), i + 1);
		etichetta = mese;
	} else if (g <= 30) {
		quale = 'giorni';
		const n = st.giorni.length;
		idx = range(n - g, n);
		prima = range(Math.max(0, n - 2 * g), n - g);
		// per ieri il grafico mostra la settimana, con ieri in fondo
		grafico = g === 1 ? range(Math.max(0, n - 7), n) : idx;
		etichetta = g === 1 ? 'ieri' : `ultimi ${g} giorni`;
	} else {
		quale = 'mesi';
		const k = g === 90 ? 3 : 12;
		const n = st.mesi.length;
		idx = range(n - k, n);
		prima = range(Math.max(0, n - 2 * k), n - k);
		grafico = range(Math.max(0, n - 12), n);
		etichetta = `ultimi ${k} mesi, compreso questo`;
	}
	const chiavi = quale === 'giorni' ? st.giorni : st.mesi;
	const serie = (x: { giorni: SerieStore; mesi: SerieStore }) => (quale === 'giorni' ? x.giorni : x.mesi);
	const tutte = filtrato ? app.map(serie) : [serie(st.totale)];
	const senzaStore = new Set(st.storeSenzaDati ?? []);
	const storeManca = (k: string) => (quale === 'giorni' ? !!st.storeFinoA && k > st.storeFinoA : senzaStore.has(k));
	const nelGrafico = new Set(grafico.map(i => chiavi[i]));
	const conPrima = prima.length === idx.length;

	const buchiDi = (chiave: string) => st.buchi.filter(b => b.chiave === chiave);
	const iAbb = (a: Abbonamenti) => (st.abbFinoA && st.giorni.includes(st.abbFinoA) ? st.giorni.indexOf(st.abbFinoA) : a.attivi.length - 1);

	// le app che hanno reso o scaricato nel periodo, la piu' ricca in testa: per il confronto e per aprirle una per una
	const migliori = app
		.map(x => ({ x, c: cifre([serie(x)], idx) }))
		.filter(({ c }) => c.totale >= 0.5 || c.download > 0)
		.sort((a, b) => b.c.totale - a.c.totale || b.c.download - a.c.download)
		.slice(0, 25)
		.map(({ x, c }) => {
			const s = serie(x);
			const suoi = buchiDi(x.chiave);
			return {
				chiave: x.chiave,
				nome: testo(x.nome, 60),
				piattaforma: x.piattaforma,
				path: x.projectPath,
				progetto: x.projectName ?? (x.projectPath ? f.progetto(x.projectPath)?.name : undefined),
				...c,
				totalePrima: conPrima ? cifre([s], prima).totale : null,
				buchi: suoi.length,
				subito: suoi.filter(b => b.gravita === 'alta').length,
				abbonati: x.abbonamenti?.attivi.length ? x.abbonamenti.attivi[iAbb(x.abbonamenti)] ?? 0 : undefined,
				// la scintilla della riga: gli euro del grafico, lo Store solo dove c'e'
				andamento: grafico.map(i => tondo((Number(s.admob[i]) || 0) + (storeManca(chiavi[i]) ? 0 : Number(s.store[i]) || 0))),
			};
		});

	const dentro = new Set(app.map(x => x.chiave));
	const buchi = filtrato ? st.buchi.filter(b => dentro.has(b.chiave)) : st.buchi;

	// abbonati: l'ultimo giorno con il report, contro lo stesso numero di giorni prima
	const abb = filtrato ? sommaAbbonamenti(app.map(x => x.abbonamenti).filter((a): a is Abbonamenti => !!a)) : st.totale.abbonamenti;
	let abbonamenti: Record<string, unknown> | undefined;
	if (abb && abb.attivi.length) {
		const i = iAbb(abb);
		// gli eventi sui giorni del periodo (al massimo 30), il confronto con almeno una settimana prima
		const lung = Math.min(g, 30);
		const finestra = range(Math.max(0, i - lung + 1), i + 1);
		const finestraPrima = range(Math.max(0, i - 2 * lung + 1), Math.max(0, i - lung + 1));
		const primaIntera = finestraPrima.length === finestra.length;
		const passo = Math.min(Math.max(lung, 7), i);
		const eventi: Record<string, number> = {};
		const eventiPrima: Record<string, number> = {};
		for (const [k, v] of Object.entries(abb.eventi ?? {})) {
			const n = finestra.reduce((t, j) => t + (Number(v[j]) || 0), 0);
			const p = primaIntera ? finestraPrima.reduce((t, j) => t + (Number(v[j]) || 0), 0) : 0;
			if (n) eventi[k] = n;
			if (p) eventiPrima[k] = p;
		}
		if ((abb.attivi[i] ?? 0) + (abb.prove[i] ?? 0) + somma(Object.values(eventi)) > 0) {
			// la serie del grafico: la settimana, il mese o tutti i giorni che Apple tiene (per l'anno)
			const lungSerie = g > 30 ? i + 1 : Math.max(g, 7);
			abbonamenti = {
				finoA: st.abbFinoA ?? st.giorni[i],
				attivi: abb.attivi[i] ?? 0,
				prove: abb.prove[i] ?? 0,
				mrr: tondo(abb.mrr[i] ?? 0),
				ritardo: abb.ritardo[i] ?? 0,
				grazia: abb.grazia?.[i] ?? 0,
				attiviPrima: passo > 0 ? (abb.attivi[i - passo] ?? null) : null,
				mrrPrima: passo > 0 ? tondo(abb.mrr[i - passo] ?? 0) : null,
				giorniPrima: passo,
				eventi,
				eventiPrima: primaIntera ? eventiPrima : null,
				serie: range(Math.max(0, i - lungSerie + 1), i + 1).map(j => ({ giorno: st.giorni[j], attivi: abb.attivi[j] ?? 0, prove: abb.prove[j] ?? 0 })),
				perApp: filtrato
					? []
					: st.app
							.filter(x => x.abbonamenti && (x.abbonamenti.attivi[i] || x.abbonamenti.prove[i]))
							.map(x => ({ chiave: x.chiave, nome: testo(x.nome, 60), attivi: x.abbonamenti!.attivi[i] ?? 0, prove: x.abbonamenti!.prove[i] ?? 0, mrr: tondo(x.abbonamenti!.mrr[i] ?? 0) }))
							.sort((a, b) => b.mrr - a.mrr || b.attivi - a.attivi)
							.slice(0, 12),
			};
		}
	}

	// la scheda dello Store: impressioni, visite, download nuovi e da dove arrivano
	const sc = filtrato ? sommaScheda(app.map(x => x.scheda).filter((s): s is Scheda => !!s)) : st.totale.scheda;
	const fsc = finestraScheda(sc, st.giorni, st.schedaFinoA, g);
	const scheda =
		sc && fsc && fsc.imp
			? {
					...fsc,
					fonti: Object.entries(sc.fonti ?? {})
						.filter(([, v]) => v.dl || v.imp)
						.sort((a, b) => b[1].dl - a[1].dl)
						.map(([k, v]) => ({ fonte: testo(k, 30), imp: Math.round(v.imp), vis: Math.round(v.vis), dl: Math.round(v.dl) })),
					perApp: filtrato
						? []
						: st.app
								.map(x => ({ x, w: finestraScheda(x.scheda, st.giorni, st.schedaFinoA, g) }))
								.filter(({ w }) => w && w.imp)
								.sort((a, b) => b.w!.imp - a.w!.imp)
								.slice(0, 12)
								.map(({ x, w }) => ({ chiave: x.chiave, nome: testo(x.nome, 60), imp: w!.imp, vis: w!.vis, dl: w!.dl })),
				}
			: null;

	// le versioni uscite dentro il grafico, per le app scelte (sul Mac le tacche compaiono solo con un'app scelta)
	const versioni = filtrato
		? app.flatMap(x =>
				((quale === 'giorni' ? x.versioni : x.versioniMesi) ?? [])
					.filter(v => nelGrafico.has(v.quando))
					.map(v => ({ chiave: v.quando, v: testo(v.v, 20), app: testo(x.nome, 60) })),
			)
		: [];

	const chiuso = (b: BucoChiuso) => ({ id: b.id, chiave: b.chiave, app: testo(b.app, 60), titolo: testo(b.titolo, 140), quando: b.quando, daQuando: b.daQuando });

	return {
		stanza: 'appstore',
		ora: now,
		aggiornatoAt: st.aggiornatoAt,
		aggiornando: !!st.aggiornando,
		fase: st.aggiornando && st.fase ? testo(st.fase, 120) : undefined,
		controlloOre: st.controlloOre ?? null,
		valuta: 'EUR',
		periodo: mese ? 30 : g,
		mese: mese ?? null,
		quale,
		etichetta,
		progetto: d.progetto ? testo(d.progetto, 60) : null,
		cifre: cifre(tutte, idx),
		prima: conPrima ? cifre(tutte, prima) : null,
		grafico: grafico.map(i => {
			const c = cifre(tutte, [i]);
			// lo stesso punto del periodo prima, per la tendenza: tanti giorni (o mesi) indietro quanti ne ha il grafico
			const j = i - grafico.length;
			const p = j >= 0 ? cifre(tutte, [j]) : null;
			return {
				chiave: chiavi[i],
				admob: c.admob,
				store: storeManca(chiavi[i]) ? null : c.store,
				download: c.download,
				nelPeriodo: idx.includes(i),
				prima: p ? { chiave: chiavi[j], admob: p.admob, store: storeManca(chiavi[j]) ? null : p.store, download: p.download } : null,
			};
		}),
		versioni,
		storeFinoA: st.storeFinoA ?? null,
		// il periodo arriva oltre l'ultimo report dello Store: la sua cifra e' parziale, non zero
		storeIncompleto: idx.some(i => storeManca(chiavi[i])),
		abbonamenti: abbonamenti ?? null,
		scheda,
		app: migliori,
		buchi: buchi.slice(0, 50).map(b => ({
			id: b.id ?? `${b.chiave}:${norma(b.titolo).slice(0, 24)}`,
			chiave: b.chiave,
			app: testo(b.app, 60),
			gravita: b.gravita,
			titolo: testo(b.titolo, 140),
			perche: b.perche ? testo(b.perche, 600) : undefined,
			cosa: testo(b.cosa, 600),
			stima: b.stima && b.stima >= 1 ? Math.round(b.stima) : undefined,
			stimaNota: b.stimaNota ? testo(b.stimaNota, 200) : undefined,
			path: b.projectPath,
			progetto: b.projectPath ? f.progetto(b.projectPath)?.name ?? baseNome(b.projectPath) : undefined,
			daQuando: b.daQuando,
			tipo: b.tipo,
			fonte: b.fonte,
			soglia: b.soglia,
			verifica: b.verifica
				? { versione: testo(b.verifica.versione, 20), giorno: b.verifica.giorno, prima: b.verifica.prima, dopo: b.verifica.dopo, giorniDopo: b.verifica.giorniDopo, esito: b.verifica.esito }
				: undefined,
			// «Fallo sistemare a Claude»: il compito gia' scritto, da mostrare e correggere sull'iPhone prima di partire
			compito: b.projectPath ? compitoBuco(b) : undefined,
		})),
		buchiTotali: buchi.length,
		stimaTotale: Math.round(somma(buchi.map(b => (b.stima && b.stima >= 1 ? b.stima : 0)))),
		risolti: (st.risolti ?? [])
			.filter(b => !filtrato || dentro.has(b.chiave))
			.slice(0, 20)
			.map(b => ({ ...chiuso(b), prima: b.prima, dopo: b.dopo })),
		ignorati: (st.ignorati ?? [])
			.filter(b => !filtrato || dentro.has(b.chiave))
			.slice(0, 30)
			.map(b => ({ ...chiuso(b), motivo: b.motivo ? testo(b.motivo, 300) : undefined })),
		allarmi: (st.allarmi ?? [])
			.filter(a => !filtrato || !a.chiave || dentro.has(a.chiave))
			.slice(0, 10)
			.map(a => ({ app: testo(a.app, 60), chiave: a.chiave, testo: testo(a.testo, 200), at: a.at })),
		// i paesi sono di tutte le app insieme (AdMob, 30 giorni): con un filtro non ci sono
		paesi: filtrato ? [] : (st.paesi ?? []).slice(0, 12).map(p => ({ codice: testo(p.codice, 4), euro: tondo(p.euro), impressioni: Math.round(p.impressioni) })),
		dettaglio: d.app ? dettaglioApp(app[0], f) : null,
		errori: { store: st.errori?.store ? testo(st.errori.store, 160) : undefined, admob: st.errori?.admob ? testo(st.errori.admob, 160) : undefined },
	};
}

/** La scheda di un'app sull'iPhone: annunci per formato e per unita' (30 giorni), acquisti, versioni uscite e cosa c'e'
 *  nel codice, come il dettaglio di «App per app» nella stanza del Mac. */
function dettaglioApp(x: AppStoreRiga, f: FontiStanze) {
	const r = x.repo;
	const versione = (v: { v: string; quando: string }) => ({ v: testo(v.v, 20), quando: v.quando });
	return {
		chiave: x.chiave,
		nome: testo(x.nome, 60),
		piattaforma: x.piattaforma,
		progetto: x.projectName ?? (x.projectPath ? f.progetto(x.projectPath)?.name : undefined),
		path: x.projectPath,
		bundleId: x.bundleId,
		approvazione: x.approvazione,
		collegata: x.collegata,
		suAdmob: !!x.admobId,
		formati: (x.formati ?? [])
			.filter(v => v.richieste || v.impressioni)
			.map(v => ({ formato: v.formato, richieste: v.richieste, abbinate: v.abbinate, impressioni: v.impressioni, clic: v.clic, euro: tondo(v.euro) })),
		unita: [...(x.unita ?? [])]
			.sort((a, b) => b.euro - a.euro || b.richieste - a.richieste)
			.slice(0, 12)
			.map(u => ({ nome: testo(u.nome, 60), formato: u.formato, richieste: u.richieste, impressioni: u.impressioni, euro: tondo(u.euro) })),
		acquisti: x.acquisti ? { nuovi: x.acquisti.nuovi, rinnovi: x.acquisti.rinnovi, altri: x.acquisti.altri, euro: tondo(x.acquisti.euro) } : null,
		versioni: (x.versioni ?? []).slice(-8).reverse().map(versione),
		versioniMesi: (x.versioniMesi ?? []).slice(-8).reverse().map(versione),
		codice: r
			? { letteAt: r.letteAt, file: r.file, sdk: r.sdk, ump: r.ump, att: r.att, attRichiesta: r.attRichiesta, skan: r.skan, storekit: r.storekit, revenuecat: r.revenuecat, formati: r.formati ?? [], idProva: (r.idProva ?? []).length }
			: null,
	};
}

// ---------- cruscotto ----------

const totTok = (t: number[] | number) => (Array.isArray(t) ? somma(t) : Number(t) || 0);

async function cruscotto(f: FontiStanze, d: Domanda, now: number, tempo: number) {
	if (!f.stats) throw errore(503, 'Il cruscotto non è disponibile.');
	const r = await conTempo(f.stats().catch(() => null), tempo);
	if (r === 'tempo') throw errore(503, 'Sto ancora leggendo le sessioni di Claude Code: riprova tra poco.');
	if (!r) throw errore(503, 'Il cruscotto non è pronto: non riesco a leggere le sessioni di Claude Code.');
	const s = r;
	const p = d.progetto ? f.progetto(d.progetto) : undefined;
	if (d.progetto && !p) throw errore(404, `Non trovo il progetto «${testo(d.progetto, 60)}».`);
	const g = periodoParam(d.periodo, 7);
	const k = g <= 7 ? 7 : g <= 30 ? 30 : 90;
	const per = s.periods[String(k) as '7' | '30' | '90'];
	const giorni = s.days.slice(-k);
	const pr = p ? per.projects.find(x => x.path === p.path) : undefined;

	const cifre = p
		? pr
			? { tu: pr.you, claude: pr.claude, sessioni: pr.sessions, token: totTok(pr.tok), valore: tondo(pr.cost), giorniAttivi: pr.daily.filter(x => x > 0).length }
			: { tu: 0, claude: 0, sessioni: 0, token: 0, valore: 0, giorniAttivi: 0 }
		: { tu: per.you, claude: per.claude, sessioni: per.sessions, token: totTok(per.tok), valore: tondo(per.cost), giorniAttivi: per.activeDays };
	const prima = p
		? pr ? { tu: pr.prev.you, claude: pr.prev.claude, token: pr.prev.tok, valore: tondo(pr.prev.cost) } : null
		: { tu: per.prev.you, claude: per.prev.claude, token: totTok(per.prev.tok), valore: tondo(per.prev.cost) };
	// il grafico: un punto per giorno del periodo; per un progetto solo le tue ore (il cruscotto non tiene le sue di Claude per giorno)
	const grafico = giorni.map((x, i) => {
		const tuP = pr ? pr.daily[pr.daily.length - giorni.length + i] ?? 0 : undefined;
		return { giorno: x.date, tu: Math.round(tuP ?? x.you), claude: p ? null : Math.round(x.claude) };
	});
	return {
		stanza: 'cruscotto',
		ora: now,
		aggiornatoAt: s.computedAt,
		periodo: k,
		progetto: p ? { nome: p.name, path: p.path } : null,
		cifre,
		prima,
		oggi: p
			? { tu: pr ? pr.daily[pr.daily.length - 1] ?? 0 : 0, claude: null, sessioni: null, token: null }
			: { tu: s.today.you, claude: s.today.claude, sessioni: s.today.sessions, token: s.today.tok },
		settimana: p ? null : { tu: s.week.now.you, claude: s.week.now.claude, primaFinOra: s.week.prevSoFar.you, inizio: s.week.start },
		grafico,
		progetti: p
			? []
			: [...per.projects]
					.sort((a, b) => b.you - a.you)
					.slice(0, 8)
					.map(x => ({ nome: testo(x.name, 60), path: x.path, tu: x.you, claude: x.claude, sessioni: x.sessions, token: totTok(x.tok), valore: tondo(x.cost), vive: x.live, ultimo: x.last })),
		vive: p ? s.live.filter(l => l.path === p.path).length : s.live.length,
		anno: g === 365 ? 'Il cruscotto tiene gli ultimi 90 giorni.' : undefined,
	};
}

// ---------- Vedetta ----------

function vedetta(f: FontiStanze, d: Domanda, now: number) {
	const r = f.regole?.();
	if (!r?.checkedAt) throw errore(503, 'Le regole non sono ancora state controllate: il primo giro sta partendo.');
	const nome = (p: string) => f.progetto(p)?.name ?? baseNome(p);
	const hit = (h: { id: string; livello: string; frase: string; rimedio: string }) => ({ id: h.id, livello: h.livello, frase: testo(h.frase, 200), rimedio: testo(h.rimedio, 200) });
	const p = d.progetto ? f.progetto(d.progetto) : undefined;
	if (d.progetto && !p) throw errore(404, `Non trovo il progetto «${testo(d.progetto, 60)}».`);
	const tutti = Object.values(r.projects)
		.filter(x => x.hits.length && (!p || x.path === p.path))
		.sort((a, b) => Number(b.livello === 'rosso') - Number(a.livello === 'rosso') || b.hits.length - a.hits.length);
	const radar = f.radar?.();
	const v = radar?.vercel;
	const ordine = { male: 0, attesa: 1, ok: 2 } as Record<string, number>;
	const siti = (v?.sites ?? [])
		.filter(s => !p || s.projectPath === p.path)
		.sort((a, b) => (ordine[a.tone] ?? 3) - (ordine[b.tone] ?? 3) || b.at - a.at);
	return {
		stanza: 'vedetta',
		ora: now,
		aggiornatoAt: r.checkedAt,
		conti: r.counts,
		globali: p ? [] : r.global.slice(0, 4).map(hit),
		progetti: tutti.slice(0, 25).map(x => ({ path: x.path, nome: nome(x.path), livello: x.livello, regole: x.hits.slice(0, 3).map(hit), altre: Math.max(0, x.hits.length - 3) })),
		progettiTotali: tutti.length,
		siti: v
			? {
					aggiornatoAt: v.at,
					errore: v.error ? testo(v.error, 160) : undefined,
					conti: { male: siti.filter(s => s.tone === 'male').length, attesa: siti.filter(s => s.tone === 'attesa').length, ok: siti.filter(s => s.tone === 'ok').length },
					elenco: siti.slice(0, 25).map(s => ({
						nome: testo(s.name, 60),
						path: s.projectPath,
						progetto: nome(s.projectPath),
						stato: s.state,
						etichetta: s.label,
						tono: s.tone,
						at: s.at,
						dominio: s.domain,
						errore: s.error ? testo(s.error, 160) : undefined,
						onlineDal: s.state !== 'READY' ? s.lastReady?.at : undefined,
					})),
				}
			: null,
	};
}

// ---------- cose da fare ----------

async function daFare(f: FontiStanze, d: Domanda, now: number, tempo: number) {
	const m = f.memoria?.();
	if (!m) throw errore(503, 'La Memoria non è disponibile.');
	const p = d.progetto ? f.progetto(d.progetto) : undefined;
	if (d.progetto && !p) throw errore(404, `Non trovo il progetto «${testo(d.progetto, 60)}».`);
	// 25 e non di piu': la CLI della Memoria esce prima di aver scritto tutto e oltre 64 KB (circa 35 riassunti) il
	// JSON arriva tagliato, cioe' vuoto (prova vera del 3/10/2026)
	const r = await conTempo(m.recent(p?.name, { kinds: ['riassunto'], limit: p ? 5 : 25 }).catch(() => null), tempo);
	if (r === 'tempo') throw errore(503, 'La Memoria non risponde: riprova tra poco.');
	if (!r) throw errore(503, 'La Memoria non si legge adesso.');
	// l'ultimo riassunto di ogni progetto con una lista: e' quella che conta
	const visti = new Set<string>();
	const progetti: { nome: string; path?: string; at: number; cose: string[]; altre: number }[] = [];
	for (const s of [...r].sort((a, b) => b.createdAt - a.createdAt)) {
		if (!s.project || visti.has(s.project)) continue;
		const todo = splitSummary(s.text).todo;
		if (!todo.length) continue;
		visti.add(s.project);
		const path = s.projectPath ?? f.progetto(s.project)?.path;
		progetti.push({ nome: testo(s.project, 60), path, at: s.createdAt, cose: todo.slice(0, 8).map(t => testo(t, 200)), altre: Math.max(0, todo.length - 8) });
	}
	return {
		stanza: 'dafare',
		ora: now,
		aggiornatoAt: progetti.length ? Math.max(...progetti.map(x => x.at)) : 0,
		progetti: progetti.slice(0, 25),
		riassunti: r.length,
	};
}

// ---------- posta e WhatsApp ----------

function posta(f: FontiStanze, d: Domanda, now: number) {
	const c = f.connettori?.();
	if (!c) throw errore(503, 'La stanza Connettori non è partita: la posta non è disponibile.');
	const st = c.statoPosta();
	if (!st.aggiornatoAt && !st.whatsapp.aggiornatoAt) throw errore(503, 'La posta non è ancora stata letta: aggiornala dalla stanza Connettori sul Mac.');
	const p = d.progetto ? f.progetto(d.progetto) : undefined;
	const q = norma(d.progetto ?? '');
	const scelti = d.progetto ? st.progetti.filter(x => (p && x.path === p.path) || (q && norma(x.name).includes(q))).slice(0, 1) : st.progetti;
	if (d.progetto && !scelti.length) throw errore(404, 'Quel progetto non ha indirizzi né numeri in rubrica: si aggiungono nella stanza Connettori.');
	const ms = (iso: string) => Date.parse(iso) || 0;
	const recente = (x: (typeof st.progetti)[number]) => Math.max(ms(x.fili[0]?.data ?? ''), ms(x.chat[0]?.data ?? ''));
	const progetti = scelti
		.filter(x => x.fili.length || x.chat.length)
		.sort((a, b) => b.nonLetti + b.chatDaRispondere - (a.nonLetti + a.chatDaRispondere) || recente(b) - recente(a))
		.slice(0, 20)
		.map(x => ({
			nome: testo(x.name, 60),
			path: x.path,
			nonLetti: x.nonLetti,
			chatDaRispondere: x.chatDaRispondere,
			mail: x.fili.slice(0, 5).map(m => ({ da: mittenteSicuro(m.da), oggetto: oggettoSicuro(m.oggetto) || 'senza oggetto', at: ms(m.data), nonLetto: !!m.nonLetto })),
			mailTotali: x.fili.length,
			chat: x.chat.slice(0, 5).map(ch => ({ contatto: contattoSicuro(ch.contatto, ch.gruppo), gruppo: !!ch.gruppo, at: ms(ch.data), mio: !!ch.mio, anteprima: ch.mio ? undefined : anteprimaSicura(ch.ultimo) || undefined })),
			chatTotali: x.chat.length,
		}));
	return {
		stanza: 'posta',
		ora: now,
		aggiornatoAt: Math.max(st.aggiornatoAt, st.whatsapp.aggiornatoAt),
		giorni: st.giorni,
		posta: { aggiornatoAt: st.aggiornatoAt, errore: st.errore ? testo(st.errore, 120) : undefined },
		whatsapp: { aggiornatoAt: st.whatsapp.aggiornatoAt, errore: st.whatsapp.errore ? testo(st.whatsapp.errore, 120) : undefined },
		conti: {
			nonLetti: somma(st.progetti.map(x => x.nonLetti)),
			chatDaRispondere: somma(st.progetti.map(x => x.chatDaRispondere)),
			mailDaAssegnare: st.daAssegnare.length,
			chatDaAssegnare: st.whatsapp.daAssegnare.length,
		},
		progetti,
	};
}

// ---------- clienti ----------

async function clienti(f: FontiStanze, d: Domanda, now: number, tempo: number) {
	if (!f.clienti) throw errore(503, 'La stanza Clienti non è disponibile.');
	const mese = meseDa(d.mese, now);
	const r = await conTempo(f.clienti(mese).catch(() => null), tempo);
	if (r === 'tempo') throw errore(503, 'Sto ancora leggendo le sessioni di Claude Code: riprova tra poco.');
	if (!r) throw errore(503, 'Le ore dei clienti non sono pronte.');
	const tariffa = (id: string) => r.config.find(k => k.id === id)?.tariffa;
	const elenco = [...r.clients].sort((a, b) => b.minutes - a.minutes);
	const conImporto = elenco.filter(c => c.amount !== undefined);
	return {
		stanza: 'clienti',
		ora: now,
		aggiornatoAt: now,
		mese: r.month,
		mesi: r.months.slice(0, 12),
		inCorso: r.month === chiaveMese(new Date(now)),
		arrotondamento: r.rounding,
		configurati: r.config.length,
		clienti: elenco.slice(0, 30).map(c => ({
			id: c.id,
			nome: testo(c.nome, 60),
			minuti: c.minutes,
			importo: c.amount !== undefined ? tondo(c.amount) : undefined,
			tariffa: tariffa(c.id),
			giorni: c.days.length,
			progetti: c.projects.slice(0, 4).map(x => ({ nome: testo(x.name, 60), path: x.path, minuti: x.minutes })),
		})),
		fuori: r.unassigned.slice(0, 6).map(u => ({ nome: testo(u.name, 60), path: u.path, minuti: u.minutes })),
		totale: { minuti: somma(r.clients.map(c => c.minutes)), importo: conImporto.length ? tondo(somma(conImporto.map(c => c.amount ?? 0))) : undefined },
	};
}

// ---------- notte ----------

function notte(f: FontiStanze, lavori: WorkItem[], now: number) {
	const n = f.notte?.();
	if (!n) throw errore(503, 'La coda della notte non è disponibile.');
	const r = n.report;
	return {
		stanza: 'notte',
		ora: now,
		aggiornatoAt: now,
		finestra: { da: n.from, a: n.to },
		insieme: n.parallel,
		inFila: n.queued,
		inCorso: n.running,
		corrente: n.ac,
		perche: testo(n.why, 200),
		fila: lavori
			.filter(w => w.status === 'stanotte' || (w.night && w.status === 'in corso'))
			.slice(0, 15)
			.map(w => ({ progetto: testo(w.project, 60), path: w.path, titolo: testo(w.title, 140), stato: w.status, chiave: w.key })),
		resoconto: r
			? {
					giorno: r.date,
					lavori: r.jobs.slice(0, 15).map(j => ({ progetto: testo(j.project, 60), compito: testo(j.task, 200), stato: j.status, riassunto: j.summary ? testo(j.summary, 300) : undefined })),
				}
			: null,
	};
}

// ---------- servizi (i crediti, per i widget) ----------

export const CONTI_FILE = path.join(os.homedir(), '.bottega', 'conti', 'giorni.json');
const SERVIZI = ['deepseek', 'elevenlabs', 'agnes'] as const;
const NOMI_SERVIZI: Record<string, string> = { deepseek: 'DeepSeek', elevenlabs: 'ElevenLabs', agnes: 'Agnes' };

/** Millisecondi da un numero o da una data ISO; undefined se non si legge. */
function msDa(v: unknown): number | undefined {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string' && v) {
		const t = Date.parse(v);
		return Number.isFinite(t) ? t : undefined;
	}
	return undefined;
}
const numero = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Il tono di un servizio: ok, attesa (in ambra) o male (in rosso). Uno sconosciuto vale attesa: meglio un'ambra di troppo. */
export function tonoServizio(v: unknown): 'ok' | 'attesa' | 'male' {
	const t = norma(String(v ?? ''));
	if (['ok', 'verde', 'bene'].includes(t)) return 'ok';
	if (['male', 'rosso', 'errore', 'finito', 'esaurito'].includes(t)) return 'male';
	return 'attesa';
}

function servizi(d: StanzeDeps, now: number) {
	let grezzo: string;
	try {
		grezzo = fs.readFileSync(d.contiFile ?? CONTI_FILE, 'utf8');
	} catch {
		throw errore(503, 'I conti dei servizi non sono ancora stati letti: li legge la Bottega sul Mac.');
	}
	let j: any;
	try {
		j = JSON.parse(grezzo);
	} catch {
		throw errore(503, 'Il file dei conti non si legge adesso: riprova tra poco.');
	}
	const sv = j && typeof j.servizi === 'object' && j.servizi ? j.servizi : {};
	const elenco = SERVIZI.filter(k => sv[k] && typeof sv[k] === 'object').map(k => {
		const x = sv[k];
		const base = { id: k, nome: testo(x.nome || NOMI_SERVIZI[k], 30), tono: tonoServizio(x.tono), frase: x.frase ? testo(x.frase, 120) : undefined };
		if (k === 'elevenlabs') {
			return { ...base, unita: x.unita ? testo(x.unita, 20) : 'caratteri', usati: numero(x.usatiMese), limite: numero(x.limiteMese), rinnovo: msDa(x.rinnovo) };
		}
		if (k === 'agnes') return { ...base, gratis: x.gratis !== false };
		return {
			...base,
			valuta: typeof x.valuta === 'string' ? x.valuta.slice(0, 3).toUpperCase() : 'USD',
			saldo: numero(x.saldo) !== undefined ? tondo(x.saldo) : undefined,
			mediaGiorno: numero(x.mediaGiorno) !== undefined ? tondo(x.mediaGiorno, 3) : undefined,
			giorniRimasti: numero(x.giorniRimasti) !== undefined ? Math.max(0, Math.floor(x.giorniRimasti)) : undefined,
			letto: msDa(x.letto),
		};
	});
	// la spesa degli ultimi 14 giorni, fino a oggi; un giorno senza riga e' null (non letto), non zero
	const g = j && typeof j.giorni === 'object' && j.giorni ? j.giorni : {};
	const oggi = new Date(now);
	const spesa = range(0, 14).map(i => {
		const d = new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate() - 13 + i);
		const k = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		const r = g[k] ?? {};
		const speso = (s: string) => (numero(r[s]?.speso) !== undefined ? tondo(r[s].speso, 3) : null);
		return { giorno: k, deepseek: speso('deepseek'), caratteri: numero(r.elevenlabs?.caratteri) ?? null };
	});
	const ds = elenco.find(x => x.id === 'deepseek') as { valuta?: string } | undefined;
	return {
		stanza: 'servizi',
		ora: now,
		aggiornatoAt: msDa(j?.aggiornato) ?? 0,
		servizi: elenco,
		spesa: { valuta: ds?.valuta ?? 'USD', giorni: spesa },
	};
}

// ---------- consigli (per i widget) ----------

export interface Consiglio {
	id: string;
	fonte: 'appstore' | 'vedetta' | 'lavori' | 'dafare' | 'home';
	/** Da dove viene, in due parole: «App Store», «Vedetta», «Lavori», «Cose da fare», «Apple Intelligence». */
	etichetta: string;
	/** La cosa da fare, in una frase. */
	titolo: string;
	perche?: string;
	cosa?: string;
	/** Euro al mese che vale (la stima del buco), se si sa. */
	valore?: number;
	/** Di chi parla: un'app o un progetto. */
	soggetto?: string;
	/** Dove porta un tocco nell'app: una stanza (9.6), oppure «lavori» o «stanze». */
	apri: string;
	/** Per «lavori»: la chiave della sessione. */
	chiave?: string;
}

async function consigli(f: FontiStanze, d: StanzeDeps, now: number, tempo: number) {
	const out: Consiglio[] = [];
	let aggiornatoAt = 0;

	// 1. il buco piu' grosso dell'App Store, con la stima al mese
	const st = f.appStore?.() as StatoStoreRicco | undefined;
	if (st?.aggiornatoAt) {
		aggiornatoAt = Math.max(aggiornatoAt, st.aggiornatoAt);
		const peso = { alta: 0, media: 1, bassa: 2 } as Record<string, number>;
		const buchi = [...st.buchi].sort((a, b) => (b.stima ?? 0) - (a.stima ?? 0) || (peso[a.gravita] ?? 3) - (peso[b.gravita] ?? 3));
		for (const b of buchi.slice(0, 1)) {
			out.push({
				id: `appstore:${b.id ?? `${b.chiave}:${norma(b.titolo).slice(0, 24)}`}`,
				fonte: 'appstore',
				etichetta: 'App Store',
				titolo: testo(b.titolo, 120),
				perche: b.perche ? testo(b.perche, 200) : undefined,
				cosa: testo(b.cosa, 200),
				valore: b.stima && b.stima >= 1 ? Math.round(b.stima) : undefined,
				soggetto: testo(b.app, 60),
				apri: 'appstore',
			});
		}
	}

	// 2. una regola rossa della Vedetta: prima quelle di tutti, poi i progetti
	const r = f.regole?.();
	if (r?.checkedAt) {
		aggiornatoAt = Math.max(aggiornatoAt, r.checkedAt);
		const rosse: { h: { id: string; frase: string; rimedio: string }; path?: string }[] = [
			...r.global.filter(h => h.livello === 'rosso').map(h => ({ h })),
			...Object.values(r.projects).flatMap(p => p.hits.filter(h => h.livello === 'rosso').map(h => ({ h, path: p.path }))),
		];
		for (const { h, path: p } of rosse.slice(0, 1)) {
			out.push({
				id: `vedetta:${p ?? 'tutti'}:${h.id}`,
				fonte: 'vedetta',
				etichetta: 'Vedetta',
				titolo: testo(h.frase, 120),
				cosa: testo(h.rimedio, 200),
				soggetto: p ? testo(f.progetto(p)?.name ?? baseNome(p), 60) : undefined,
				apri: 'vedetta',
			});
		}
	}

	// 3. un lavoro che ti aspetta
	const aspettano = (d.lavori?.() ?? []).filter(w => w.status === 'ti aspetta');
	for (const w of aspettano.slice(0, 2)) {
		out.push({
			id: `lavori:${w.key}`,
			fonte: 'lavori',
			etichetta: 'Lavori',
			titolo: `${testo(w.project, 60)} ti aspetta`,
			perche: w.title ? testo(w.title, 140) : undefined,
			cosa: 'Rispondi dalla scheda della sessione.',
			soggetto: testo(w.project, 60),
			apri: 'lavori',
			chiave: w.key,
		});
	}

	// 4. le cose da fare della Memoria: la prima dell'ultimo riassunto con una lista (al massimo 4 s: e' un widget)
	const m = f.memoria?.();
	if (m) {
		const rs = await conTempo(m.recent(undefined, { kinds: ['riassunto'], limit: 10 }).catch(() => null), Math.min(tempo, 4000));
		if (rs && rs !== 'tempo') {
			const visti = new Set<string>();
			let presi = 0;
			for (const x of [...rs].sort((a, b) => b.createdAt - a.createdAt)) {
				if (presi >= 1) break;
				if (!x.project || visti.has(x.project)) continue;
				visti.add(x.project);
				const todo = splitSummary(x.text).todo;
				if (!todo.length) continue;
				presi++;
				const chi = testo(x.project, 60);
				out.push({
					id: `dafare:${norma(x.project)}:${norma(todo[0]).slice(0, 24)}`,
					fonte: 'dafare',
					etichetta: 'Cose da fare',
					titolo: testo(todo[0], 120),
					perche: todo.length > 1 ? `Dall'ultimo riassunto di ${chi}, con altre ${todo.length - 1}.` : `Dall'ultimo riassunto di ${chi}.`,
					soggetto: chi,
					apri: 'dafare',
				});
			}
		}
	}

	// 5. i consigli della Home (Apple Intelligence sul Mac, o le regole)
	const casa = d.consigliHome ? d.consigliHome() : readBriefing().advice;
	if (casa?.items?.length) {
		aggiornatoAt = Math.max(aggiornatoAt, Number(casa.at) || 0);
		casa.items.slice(0, 3).forEach((it, i) => {
			const t = testo(it?.text, 160);
			if (t) out.push({ id: `home:${Number(casa.at) || 0}:${i}`, fonte: 'home', etichetta: casa.engine === 'apple' ? 'Apple Intelligence' : 'La Home', titolo: t, apri: 'stanze' });
		});
	}

	return {
		stanza: 'consigli',
		ora: now,
		aggiornatoAt,
		consigli: out.slice(0, 8),
		conti: {
			buchi: st?.aggiornatoAt ? st.buchi.length : null,
			stimaTotale: st?.aggiornatoAt ? Math.round(somma(st.buchi.map(b => (b.stima && b.stima >= 1 ? b.stima : 0)))) : null,
			rossi: r?.checkedAt ? r.counts.rosso : null,
			tiAspetta: aspettano.length,
		},
	};
}

// ---------- la rotta ----------

export class StanzePonte implements RotteStanze {
	constructor(private readonly deps: StanzeDeps) {}

	async leggi(q: URLSearchParams): Promise<unknown> {
		const nome = norma(q.get('nome') ?? '') as StanzaPonte;
		if (!STANZE_PONTE.includes(nome)) throw errore(400, `Stanza sconosciuta. Ci sono: ${STANZE_PONTE.join(', ')}.`);
		const f = this.deps.fonti();
		if (!f) throw errore(503, 'Le stanze non sono ancora pronte: la Bottega si sta avviando.');
		const now = this.deps.ora?.() ?? f.ora?.() ?? Date.now();
		const tempo = this.deps.tempoMs ?? 20_000;
		const progetto = (q.get('progetto') ?? '').trim().slice(0, 120) || undefined;
		const d: Domanda = { periodo: q.get('periodo'), progetto, mese: (q.get('mese') ?? '').trim().slice(0, 40) || undefined, app: (q.get('app') ?? '').trim().slice(0, 120) || undefined };
		switch (nome) {
			case 'appstore': return appStore(f, d, now);
			case 'cruscotto': return cruscotto(f, d, now, tempo);
			case 'vedetta': return vedetta(f, d, now);
			case 'dafare': return daFare(f, d, now, tempo);
			case 'posta': return posta(f, d, now);
			case 'clienti': return clienti(f, d, now, tempo);
			case 'notte': return notte(f, this.deps.lavori?.() ?? [], now);
			case 'servizi': return servizi(this.deps, now);
			case 'consigli': return consigli(f, this.deps, now, tempo);
		}
	}

	/** Quando e' partito l'ultimo lavoro per ogni buco: un doppio tocco non ne avvia due. */
	private readonly avviati = new Map<string, number>();

	/** POST /v1/stanza/azione (CONTRATTI 9.7). Il corpo e' gia' letto e limitato a 16 KB da ponte.ts. */
	async azione(corpo: unknown): Promise<unknown> {
		const c = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
		if (norma(String(c.stanza ?? '')) !== 'appstore') throw errore(400, 'Dall\'iPhone si agisce solo sulla stanza App Store.');
		const azione = String(c.azione ?? '') as (typeof AZIONI_APPSTORE)[number];
		if (!AZIONI_APPSTORE.includes(azione)) throw errore(400, `Azione sconosciuta. Ci sono: ${AZIONI_APPSTORE.join(', ')}.`);
		const a = this.deps.azioni;
		const f = this.deps.fonti();
		const st = f?.appStore?.() as StatoStoreRicco | undefined;
		if (!a || !f || !st?.aggiornatoAt) throw errore(503, 'La stanza App Store non è pronta sul Mac.');
		const now = this.deps.ora?.() ?? f.ora?.() ?? Date.now();
		const id = typeof c.id === 'string' ? c.id.slice(0, 200) : '';
		const buco = () => {
			const b = st.buchi.find(x => x.id === id);
			if (!b) throw errore(404, 'Questo punto non c\'è più: forse è già risolto o ignorato. Aggiorna la stanza.');
			return b;
		};
		switch (azione) {
			case 'verifica':
				if (st.aggiornando) return { ok: true, azione, messaggio: 'Sto già rileggendo AdMob e App Store Connect.' };
				a.verifica();
				return { ok: true, azione, messaggio: 'Rileggo AdMob e App Store Connect adesso: tra un minuto i numeri nuovi.' };
			case 'ignora': {
				const b = buco();
				a.ignora(id, pulisci(String(c.motivo ?? '').replace(/[\u0000-\u001f\u007f]/g, ' '), 300));
				return { ok: true, azione, id, messaggio: `Ignorato: «${testo(b.titolo, 80)}» non compare più finché non lo ripristini.` };
			}
			case 'ripristina': {
				if (!(st.ignorati ?? []).some(x => x.id === id)) throw errore(404, 'Non trovo questo punto tra gli ignorati.');
				a.ripristina(id);
				return { ok: true, azione, id, messaggio: 'Ripristinato: se c\'è ancora, torna tra le cose da sistemare.' };
			}
			case 'lavoro': {
				const b = buco();
				// il progetto viene dal buco, mai dall'iPhone, e deve essere uno di quelli che la Bottega conosce
				const p = b.projectPath ? f.progetto(b.projectPath) : undefined;
				if (!p || p.path !== b.projectPath) throw errore(409, 'Questa app non ha un progetto sul Mac: non so dove far lavorare Claude.');
				const ultimo = this.avviati.get(id);
				if (ultimo && now - ultimo < 2 * 60_000) throw errore(409, 'Ho appena avviato un lavoro per questo punto: guardalo nei Lavori.');
				const scritto = compitoPulito(c.compito);
				const compito = `${scritto || compitoBuco(b)} ${CODA_COMPITO}`;
				const j = a.lavoro(p.path, compito);
				if (!j) throw errore(503, 'I lavori della Bottega non sono pronti: riprova tra poco.');
				this.avviati.set(id, now);
				return {
					ok: true,
					azione,
					id,
					lavoro: j.id,
					stato: j.stato,
					progetto: p.name,
					messaggio: j.stato === 'in coda' ? `Lavoro in coda su ${p.name}: parte appena c'è posto.` : `Lavoro avviato su ${p.name}.`,
				};
			}
		}
	}
}
