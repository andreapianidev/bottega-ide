/* I lettori delle fonti nuove della stanza App Store (docs/CONTRATTI.md, 13.1): abbonamenti e analisi della scheda
   dello Store. Solo funzioni pure, provate da test/appstore.cjs: ricevono il testo di un report e restituiscono numeri.

   - Abbonamenti: i report SUBSCRIPTION (fotografia del giorno: abbonati attivi, prove, ritardi di pagamento) e
     SUBSCRIPTION_EVENT (cosa e' successo quel giorno: prove iniziate, conversioni, disdette...) di App Store Connect,
     versione 1_4, un file per giorno.
   - Scheda dello Store: i report di analisi «App Store Discovery and Engagement Standard» (impressioni, visite) e
     «App Downloads Standard» (download per fonte). Un'istanza contiene gli eventi elaborati in un giorno, anche di
     giorni prima arrivati in ritardo: le istanze si sommano, non si sostituiscono. */

// ---------- abbonamenti ----------

/** Un'app in un giorno: abbonati che pagano, in prova, in ritardo di pagamento, in periodo di tolleranza, e ricavi
 *  mensili ricorrenti per valuta (abbonati a prezzo pieno x ricavo netto, riportato a un mese). */
export interface GiornoAbb {
	att: number;
	prv: number;
	rty: number;
	grz: number;
	mrr: Record<string, number>;
}
export type ReportAbb = Record<string, GiornoAbb>;

/** Un'app in un giorno: quanti eventi di ogni tipo (vedi EVENTI). */
export type EventiAbb = Record<string, Record<string, number>>;

/** Le categorie degli eventi di Apple che la stanza conta. */
export const EVENTI: Record<string, string> = {
	'Start Introductory Offer': 'prove',
	'Paid Subscription from Introductory Offer': 'conversioni',
	Subscribe: 'nuovi',
	Renew: 'rinnovi',
	'Renewal from Billing Retry': 'rinnovi',
	Cancel: 'disdette',
	Refund: 'rimborsi',
	'Billing Retry from Paid Subscription': 'ritardi',
	'Billing Retry from Introductory Offer': 'ritardi',
};

const PAGANTI = [
	'Active Standard Price Subscriptions',
	'Active Pay Up Front Introductory Offer Subscriptions',
	'Active Pay As You Go Introductory Offer Subscriptions',
	'Pay Up Front Promotional Offer Subscriptions',
	'Pay As You Go Promotional Offer Subscriptions',
	'Pay Up Front Offer Code Subscriptions',
	'Pay As You Go Offer Code Subscriptions',
	'Pay Up Front Win-back Offers',
	'Pay As You Go Win-back Offers',
];
const IN_PROVA = ['Active Free Trial Introductory Offer Subscriptions', 'Free Trial Promotional Offer Subscriptions', 'Free Trial Offer Code Subscriptions', 'Free Trial Win-back Offers'];

/** Quanti mesi dura un periodo di abbonamento («7 Days», «1 Month», «1 Year»). */
export function mesiDi(durata: string): number {
	const m = /(\d+)\s*(Day|Week|Month|Year)/i.exec(durata || '');
	if (!m) return 1;
	const n = Number(m[1]);
	const u = m[2].toLowerCase();
	return u === 'day' ? n / 30.44 : u === 'week' ? (n * 7) / 30.44 : u === 'month' ? n : n * 12;
}

function tabella(tsv: string): { h: string[]; righe: string[][] } {
	const r = tsv.split('\n').filter(x => x.trim());
	return { h: (r[0] ?? '').split('\t').map(x => x.trim()), righe: r.slice(1).map(x => x.split('\t')) };
}

export function leggiAbbonamenti(tsv: string): ReportAbb {
	const { h, righe } = tabella(tsv);
	const i = (n: string) => h.indexOf(n);
	const iApp = i('App Apple ID');
	const iDur = i('Standard Subscription Duration');
	const iRic = i('Developer Proceeds');
	const iVal = i('Proceeds Currency');
	const iStd = i('Active Standard Price Subscriptions');
	const out: ReportAbb = {};
	for (const c of righe) {
		const app = (c[iApp] ?? '').trim();
		if (!app) continue;
		const g = (out[app] ??= { att: 0, prv: 0, rty: 0, grz: 0, mrr: {} });
		const num = (n: string) => Number(c[i(n)]) || 0;
		g.att += PAGANTI.reduce((s, n) => s + num(n), 0);
		g.prv += IN_PROVA.reduce((s, n) => s + num(n), 0);
		g.rty += num('Billing Retry');
		g.grz += num('Grace Period');
		// la riga e' di un prezzo: chi la paga a prezzo pieno vale il suo ricavo netto, riportato a un mese
		const std = Number(c[iStd]) || 0;
		const ric = Number(c[iRic]) || 0;
		const val = (c[iVal] ?? '').trim();
		if (std && ric && val) g.mrr[val] = (g.mrr[val] ?? 0) + (std * ric) / mesiDi(c[iDur] ?? '');
	}
	return out;
}

export function leggiEventi(tsv: string): EventiAbb {
	const { h, righe } = tabella(tsv);
	const iApp = h.indexOf('App Apple ID');
	const iEv = h.indexOf('Event');
	const iQ = h.indexOf('Quantity');
	const out: EventiAbb = {};
	for (const c of righe) {
		const app = (c[iApp] ?? '').trim();
		const cat = EVENTI[(c[iEv] ?? '').trim()] ?? ((c[iEv] ?? '').startsWith('Reactivate') ? 'ritorni' : '');
		if (!app || !cat) continue;
		const e = (out[app] ??= {});
		e[cat] = (e[cat] ?? 0) + (Number(c[iQ]) || 1);
	}
	return out;
}

// ---------- scheda dello Store ----------

export interface Fonte {
	imp: number;
	vis: number;
	dl: number;
}

/** Un giorno della scheda: impressioni e visite (dispositivi unici), download nuovi e riscaricamenti, per fonte. */
export interface GiornoScheda extends Fonte {
	rdl: number;
	fonti: Record<string, Fonte>;
}
/** Un'istanza letta: data dell'evento -> numeri. */
export type IstanzaScheda = Record<string, GiornoScheda>;

const nuovoGiorno = (): GiornoScheda => ({ imp: 0, vis: 0, dl: 0, rdl: 0, fonti: {} });

/** Le fonti di Apple, con il nome che usa la stanza. */
export const FONTI: Record<string, string> = {
	'App Store search': 'ricerca',
	'App Store browse': 'navigazione',
	'Web referrer': 'web',
	'App referrer': 'altre app',
	'Institutional purchase': 'acquisti istituzionali',
	Unavailable: 'sconosciuta',
};
const fonte = (s: string) => FONTI[s] ?? (s ? s.toLowerCase() : 'sconosciuta');

/** «App Store Discovery and Engagement Standard»: impressioni e visite alla pagina (prodotto o foglio dello Store). */
export function leggiScoperta(csv: string, out: IstanzaScheda = {}): IstanzaScheda {
	const { h, righe } = tabella(csv);
	const iData = h.indexOf('Date');
	const iEv = h.indexOf('Event');
	const iPag = h.indexOf('Page Type');
	const iFonte = h.indexOf('Source Type');
	const iU = h.indexOf('Unique Counts');
	const iC = h.indexOf('Counts');
	for (const c of righe) {
		const d = (c[iData] ?? '').trim();
		const ev = (c[iEv] ?? '').trim();
		if (!d) continue;
		const n = Number(c[iU]) || Number(c[iC]) || 0;
		const g = (out[d] ??= nuovoGiorno());
		const f = (g.fonti[fonte((c[iFonte] ?? '').trim())] ??= { imp: 0, vis: 0, dl: 0 });
		if (ev === 'Impression') {
			g.imp += n;
			f.imp += n;
		} else if (ev === 'Page view' && /Product page|Store sheet/.test(c[iPag] ?? '')) {
			g.vis += n;
			f.vis += n;
		}
	}
	return out;
}

/** «App Downloads Standard»: download nuovi e riscaricamenti, per fonte. Aggiornamenti e ripristini no. */
export function leggiScaricamenti(csv: string, out: IstanzaScheda = {}): IstanzaScheda {
	const { h, righe } = tabella(csv);
	const iData = h.indexOf('Date');
	const iTipo = h.indexOf('Download Type');
	const iFonte = h.indexOf('Source Type');
	const iC = h.indexOf('Counts');
	for (const c of righe) {
		const d = (c[iData] ?? '').trim();
		const tipo = (c[iTipo] ?? '').trim();
		if (!d || (tipo !== 'First-time download' && tipo !== 'Redownload')) continue;
		const n = Number(c[iC]) || 0;
		const g = (out[d] ??= nuovoGiorno());
		if (tipo === 'Redownload') {
			g.rdl += n;
			continue;
		}
		g.dl += n;
		const f = (g.fonti[fonte((c[iFonte] ?? '').trim())] ??= { imp: 0, vis: 0, dl: 0 });
		f.dl += n;
	}
	return out;
}

/** Somma piu' istanze (gli eventi elaborati giorno per giorno) in un solo calendario. */
export function sommaIstanze(istanze: IstanzaScheda[]): IstanzaScheda {
	const out: IstanzaScheda = {};
	for (const ist of istanze) {
		for (const [d, g] of Object.entries(ist)) {
			const o = (out[d] ??= nuovoGiorno());
			o.imp += g.imp;
			o.vis += g.vis;
			o.dl += g.dl;
			o.rdl += g.rdl;
			for (const [k, f] of Object.entries(g.fonti)) {
				const of = (o.fonti[k] ??= { imp: 0, vis: 0, dl: 0 });
				of.imp += f.imp;
				of.vis += f.vis;
				of.dl += f.dl;
			}
		}
	}
	return out;
}

// ---------- versioni ----------

/** Confronto di versioni «2.10.1» > «2.9»: numero per numero. */
export function versioneMaggiore(a: string, b: string): boolean {
	const pa = a.split(/[.\s-]/).map(x => Number(x) || 0);
	const pb = b.split(/[.\s-]/).map(x => Number(x) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x > y;
	}
	return false;
}

/** Le uscite nel periodo: per ogni passo (giorno o mese) le versioni viste nei report di vendita; un'uscita e' la
 *  prima comparsa di una versione piu' alta di tutte quelle viste prima. Il primo passo e' la base, non un'uscita
 *  (un dispositivo vecchio che riscarica una versione vecchia non conta). */
export function uscite(passi: { quando: string; versioni: string[] }[]): { v: string; quando: string }[] {
	const out: { v: string; quando: string }[] = [];
	let massima: string | undefined;
	passi.forEach((p, i) => {
		const nuove = p.versioni.filter(v => v && (!massima || versioneMaggiore(v, massima))).sort((a, b) => (versioneMaggiore(a, b) ? 1 : -1));
		if (!nuove.length) return;
		const alta = nuove[nuove.length - 1];
		if (i > 0 && massima) out.push({ v: alta, quando: p.quando });
		massima = alta;
	});
	return out;
}
