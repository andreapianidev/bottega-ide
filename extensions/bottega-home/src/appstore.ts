/* La stanza App Store: quanto rendono le app di Andrea (AdMob e vendite dello Store) per settimana, mese e anno, e
   dove intervenire. Contratto verso la plancia: docs/CONTRATTI.md, sezione 13.

   Fonti, tutte lette direttamente e gratis con le credenziali che il radar usa gia' (src/radar.ts):
   - Vendite di App Store Connect: report SALES/SUMMARY giornalieri (gli ultimi 62 giorni) e mensili (24 mesi), con
     ASC_VENDOR_NUMBER da ~/.secrets/appstoreconnect-api.env. Un report pubblicato non cambia piu': si scarica una
     volta e resta in ~/.bottega/appstore/vendite.json, con i ricavi nella valuta originale.
   - AdMob: cinque report (giorno per app, mese per app, formato per app, unita' pubblicitaria, paese) e gli elenchi di
     app e unita'. Si rileggono a ogni aggiornamento, perche' AdMob ritocca gli ultimi giorni.
   - Cambi: open.er-api.com (senza chiave, una volta al giorno), per portare in euro i ricavi in altre valute.
     Esce solo la richiesta dei cambi, nessun dato di Andrea.
   - I repository: i progetti collegati alle app (bundle id e applicationId) si leggono sul disco per capire come
     sono integrati AdMob, il consenso, ATT, SKAdNetwork e gli acquisti in-app.
   Dalle tre cose insieme escono i «buchi»: regole scritte qui sotto (trovaBuchi), ognuna con il perche', cosa fare
   e, quando si puo' stimare in modo onesto, quanto vale in euro al mese. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import type { Project } from './scan';
import { projectBundleIds, readEnvFile, type Radar } from './radar';

// ---------- forma dello stato (contratto, 13.2) ----------

export type Periodo = 'settimana' | 'mese' | 'anno';

export interface Serie {
	/** Euro da AdMob. */
	admob: number[];
	/** Euro dallo Store (ricavi netti dopo la quota di Apple). */
	store: number[];
	/** Download nuovi (non gli aggiornamenti, non i riscaricamenti). */
	dl: number[];
}

export interface FormatoApp {
	formato: string;
	richieste: number;
	abbinate: number;
	impressioni: number;
	clic: number;
	euro: number;
}

export interface UnitaApp {
	id: string;
	nome: string;
	formato: string;
	richieste: number;
	impressioni: number;
	euro: number;
}

export interface RepoEsito {
	path: string;
	letteAt: number;
	file: number;
	sdk: boolean;
	formati: string[];
	ump: boolean;
	att: boolean;
	attRichiesta: boolean;
	skan: number;
	/** File con l'ID di prova di Google fuori da un ramo DEBUG (i test e i framework non contano). */
	idProva: string[];
	/** ID di unita' trovati nel codice, con la piattaforma del file (Swift e plist iOS, Kotlin e XML Android). */
	unita: { id: string; piattaforma: 'ios' | 'android' }[];
	storekit: boolean;
	revenuecat: boolean;
}

export interface AppRiga {
	chiave: string;
	nome: string;
	piattaforma: 'ios' | 'android';
	ascId?: string;
	bundleId?: string;
	admobId?: string;
	/** APPROVED, ACTION_REQUIRED, IN_REVIEW... solo se l'app e' su AdMob. */
	approvazione?: string;
	/** L'app di AdMob e' collegata alla sua scheda dello Store. */
	collegata?: boolean;
	projectPath?: string;
	projectName?: string;
	giorni: Serie;
	mesi: Serie;
	/** Ultimi 30 giorni. */
	formati: FormatoApp[];
	unita: UnitaApp[];
	acquisti: { nuovi: number; rinnovi: number; altri: number; euro: number };
	repo?: RepoEsito;
}

export type Gravita = 'alta' | 'media' | 'bassa';

export interface Buco {
	id: string;
	chiave: string;
	app: string;
	gravita: Gravita;
	titolo: string;
	perche: string;
	cosa: string;
	/** Euro al mese, se si puo' stimare. */
	stima?: number;
	stimaNota?: string;
	projectPath?: string;
	/** Il compito gia' scritto per un lavoro Claude sul progetto. */
	compito?: string;
}

export interface AppStoreStato {
	aggiornatoAt: number;
	aggiornando: boolean;
	fase?: string;
	errori: { store?: string; admob?: string; cambi?: string; repo?: string };
	valuta: 'EUR';
	/** Le date (YYYY-MM-DD) delle serie giornaliere, dalla piu' vecchia a ieri. */
	giorni: string[];
	/** I mesi (YYYY-MM) delle serie mensili, dal piu' vecchio a quello in corso. */
	mesi: string[];
	/** L'ultimo giorno con il report dello Store: dopo, i numeri dello Store mancano (Apple pubblica verso le 14). */
	storeFinoA?: string;
	/** Mesi per cui Apple non da' piu' il report delle vendite (410): lo Store li' non ha numeri, non zero. */
	storeSenzaDati: string[];
	totale: { giorni: Serie; mesi: Serie };
	app: AppRiga[];
	paesi: { codice: string; euro: number; impressioni: number }[];
	buchi: Buco[];
	/** Valute dei ricavi senza cambio: quei ricavi non sono nei totali. */
	senzaCambio: string[];
	publisher?: string;
}

// ---------- costanti ----------

const GIORNI = 62;
const MESI = 24;
const MIN_GAP = 45 * 60_000;
const REPO_TTL = 6 * 3_600_000;
const CAMBI_TTL = 24 * 3_600_000;
const TIMEOUT = 30_000;
const PARALLEL = 4;
const SCHEMA = 1;

const DL = new Set(['1', '1F', '1T', 'F1', '1E', '1EP', '1EU']);
const RIDL = new Set(['3', '3F', 'F3']);
const IAP = new Set(['IA1', 'IA9', 'IAY', 'IAC', 'FI1']);

// ---------- date ----------

const pad = (n: number) => String(n).padStart(2, '0');
export const dkey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const mkey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/** Gli ultimi n giorni fino a ieri, dal piu' vecchio. */
export function ultimiGiorni(now: number, n = GIORNI): string[] {
	const t = new Date(now);
	const out: string[] = [];
	for (let k = n; k >= 1; k--) out.push(dkey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - k)));
	return out;
}

/** Gli ultimi n mesi fino a quello in corso, dal piu' vecchio. */
export function ultimiMesi(now: number, n = MESI): string[] {
	const t = new Date(now);
	const out: string[] = [];
	for (let k = n - 1; k >= 0; k--) out.push(mkey(new Date(t.getFullYear(), t.getMonth() - k, 1)));
	return out;
}

// ---------- report di vendita ----------

/** Una app in un report: download, riscaricamenti, acquisti, abbonamenti e ricavi per valuta. */
export interface RigaVendite {
	dl: number;
	rdl: number;
	iap: number;
	sn: number;
	sr: number;
	pr: Record<string, number>;
}

/** Un report letto: chiave Apple ID (o "sku:<sku>" se l'acquisto non si riesce a collegare alla sua app). */
export type Report = Record<string, RigaVendite>;

/** Lo stato di un report in cache: letto, vuoto (Apple dice che non ci sono vendite) o perso (troppo vecchio). */
type Voce = Report | 'vuoto' | 'perso';

const nuovaRiga = (): RigaVendite => ({ dl: 0, rdl: 0, iap: 0, sn: 0, sr: 0, pr: {} });

/** Legge il TSV di un report SALES/SUMMARY. `sku` collega gli SKU delle app agli Apple ID e si arricchisce. */
export function leggiReport(tsv: string, sku: Record<string, string>, nomi: Record<string, string> = {}): Report {
	const righe = tsv.split('\n').filter(Boolean);
	if (!righe.length) return {};
	const h = righe[0].split('\t');
	const col = (n: string) => h.indexOf(n);
	const iSku = col('SKU');
	const iTitolo = col('Title');
	const iTipo = col('Product Type Identifier');
	const iUnita = col('Units');
	const iRicavo = col('Developer Proceeds');
	const iValuta = col('Currency of Proceeds');
	const iApple = col('Apple Identifier');
	const iPadre = col('Parent Identifier');
	const iAbb = col('Subscription');
	const celle = righe.slice(1).map(r => r.split('\t'));
	// prima le app, per sapere a chi appartengono gli acquisti in-app (Parent Identifier e' lo SKU della app)
	for (const c of celle) {
		const tipo = (c[iTipo] ?? '').trim();
		if (IAP.has(tipo)) continue;
		const s = (c[iSku] ?? '').trim();
		const a = (c[iApple] ?? '').trim();
		if (s && a) sku[s] = a;
		if (a && iTitolo >= 0 && c[iTitolo] && !nomi[a]) nomi[a] = c[iTitolo].trim();
	}
	const out: Report = {};
	for (const c of celle) {
		const tipo = (c[iTipo] ?? '').trim();
		const unita = Number(c[iUnita]) || 0;
		let chiave = (c[iApple] ?? '').trim();
		if (IAP.has(tipo)) {
			const padre = (c[iPadre] ?? '').trim();
			chiave = (padre && sku[padre]) || (padre ? 'sku:' + padre : chiave);
		}
		if (!chiave) continue;
		const r = (out[chiave] ??= nuovaRiga());
		if (DL.has(tipo)) r.dl += unita;
		else if (RIDL.has(tipo)) r.rdl += unita;
		else if (IAP.has(tipo)) {
			const abb = (c[iAbb] ?? '').trim();
			if (abb === 'New') r.sn += unita;
			else if (abb === 'Renewal') r.sr += unita;
			else r.iap += unita;
		}
		const ricavo = Number(c[iRicavo]) || 0;
		const valuta = (c[iValuta] ?? '').trim();
		if (ricavo && valuta) r.pr[valuta] = (r.pr[valuta] ?? 0) + unita * ricavo;
	}
	return out;
}

// ---------- i repository ----------

const SALTA = new Set(['node_modules', 'Pods', 'build', 'DerivedData', '.git', '.build', 'vendor', 'Carthage', '.gradle', 'dist', 'out', '.claude', '.next', '.swiftpm', 'xcuserdata', 'test-out']);
const ESTENSIONI = new Set(['.swift', '.m', '.mm', '.h', '.plist', '.pbxproj', '.xcconfig', '.resolved', '.kt', '.java', '.xml', '.gradle', '.kts', '.properties']);
const NOMI = new Set(['Podfile', 'Package.swift', 'Package.resolved']);
const MAX_FILE = 5000;
const MAX_BYTE = 1_500_000;
const ID_PROVA = 'ca-app-pub-3940256099942544';

const FORMATI_CODICE: [string, RegExp][] = [
	['banner', /\bGADBannerView\b|\bBannerView\s*\(|AnchoredAdaptiveBanner|\bAdSizeBanner\b|\bAdView\s*\(|\bBannerAdView\b|\bGADAdSize/],
	['interstitial', /\bGADInterstitialAd\b|(?<!Rewarded)\bInterstitialAd\s*\.\s*load\b|(?<!Rewarded)\bInterstitialAd\.load/],
	['rewarded', /\bGADRewardedAd\b|(?<!Interstitial)\bRewardedAd\s*\.\s*load\b/],
	['rewarded_interstitial', /RewardedInterstitialAd/],
	['app_open', /\bGADAppOpenAd\b|\bAppOpenAd\s*\.\s*load\b/],
	['native', /\bGADNativeAd\b|\bNativeAdView\b|\bGADAdLoader\b|\bforNativeAd\b/],
];

/** Legge un progetto e dice come sono messi AdMob, consenso, ATT, SKAdNetwork e acquisti in-app. */
export async function leggiRepo(dir: string, now = Date.now()): Promise<RepoEsito> {
	const out: RepoEsito = { path: dir, letteAt: now, file: 0, sdk: false, formati: [], ump: false, att: false, attRichiesta: false, skan: 0, idProva: [], unita: [], storekit: false, revenuecat: false };
	const formati = new Set<string>();
	const unita = new Map<string, 'ios' | 'android'>();
	const file: string[] = [];
	const coda = [dir];
	while (coda.length && file.length < MAX_FILE) {
		const d = coda.shift()!;
		let voci: fs.Dirent[];
		try {
			voci = await fs.promises.readdir(d, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const v of voci) {
			if (v.name.startsWith('.') && v.name !== '.xcconfig') {
				if (v.isDirectory()) continue;
			}
			const p = path.join(d, v.name);
			if (v.isDirectory()) {
				if (!SALTA.has(v.name) && !v.name.endsWith('.xcassets') && !v.name.endsWith('.lproj')) coda.push(p);
			} else if (v.isFile() && (ESTENSIONI.has(path.extname(v.name)) || NOMI.has(v.name))) file.push(p);
		}
	}
	out.file = file.length;
	let i = 0;
	await Promise.all(
		Array.from({ length: 8 }, async () => {
			while (i < file.length) {
				const f = file[i++];
				let testo: string;
				try {
					const st = await fs.promises.stat(f);
					if (st.size > MAX_BYTE) continue;
					testo = await fs.promises.readFile(f, 'utf8');
				} catch {
					continue;
				}
				const ext = path.extname(f);
				const nome = path.basename(f);
				if (/GoogleMobileAds|Google-Mobile-Ads-SDK|swift-package-manager-google-mobile-ads|play-services-ads|com\.google\.android\.gms\.ads/.test(testo)) out.sdk = true;
				if (ext === '.swift' || ext === '.m' || ext === '.mm' || ext === '.kt' || ext === '.java') {
					for (const [nomeF, re] of FORMATI_CODICE) if (re.test(testo)) formati.add(nomeF);
					if (/requestTrackingAuthorization/.test(testo)) out.attRichiesta = true;
					// non basta import StoreKit: lo usa anche la richiesta di recensione
					if (/\bProduct\.products\b|\bSKProductsRequest\b|\bBillingClient\b|\bSubscriptionStoreView\b|\bStoreView\b|\bTransaction\.currentEntitlements\b/.test(testo)) out.storekit = true;
					if (/import RevenueCat|Purchases\.configure|com\.revenuecat/.test(testo)) out.revenuecat = true;
				}
				if (/UserMessagingPlatform|\bConsentInformation\b|UMPConsentInformation|user-messaging-platform/.test(testo)) out.ump = true;
				if (/NSUserTrackingUsageDescription/.test(testo)) out.att = true;
				if (ext === '.plist' || ext === '.pbxproj') {
					const n = (testo.match(/[a-z0-9]+\.skadnetwork/gi) ?? []).length;
					if (n > out.skan) out.skan = n;
				}
				const rel = path.relative(dir, f);
				// l'ID di prova dietro #if DEBUG (o BuildConfig.DEBUG) e' giusto; nei test e nei framework non conta
				if (testo.includes(ID_PROVA) && !/\bDEBUG\b/.test(testo) && !/(^|\/)\w*Tests?\/|\.framework\/|Package\.resolved$|\.pbxproj$/.test(rel)) out.idProva.push(rel);
				const piatt = ext === '.kt' || ext === '.java' || ext === '.xml' || ext === '.gradle' || ext === '.kts' || ext === '.properties' ? 'android' : 'ios';
				for (const m of testo.matchAll(/ca-app-pub-(\d{16})\/(\d{10})/g)) {
					// segnaposto dei documenti e degli esempi: tutte cifre uguali o la scala 0123456789
					if (m[0].startsWith(ID_PROVA) || /^(\d)\1+$/.test(m[1]) || m[1].startsWith('0123456789') || /^(\d)\1+$/.test(m[2])) continue;
					if (!unita.has(m[0])) unita.set(m[0], piatt);
				}
			}
		}),
	);
	out.formati = [...formati].sort();
	out.unita = [...unita].map(([id, piattaforma]) => ({ id, piattaforma })).sort((a, b) => a.id.localeCompare(b.id));
	out.idProva = [...new Set(out.idProva)].sort().slice(0, 8);
	return out;
}

/** L'applicationId di un progetto Android (app/build.gradle o build.gradle, anche .kts). */
const gradleCache = new Map<string, { mtime: number; id: string | null }>();
export function androidAppId(dir: string): string | null {
	for (const f of ['app/build.gradle.kts', 'app/build.gradle', 'build.gradle.kts', 'build.gradle', 'androidApp/build.gradle.kts', 'composeApp/build.gradle.kts']) {
		const p = path.join(dir, f);
		let mtime: number;
		try {
			mtime = fs.statSync(p).mtimeMs;
		} catch {
			continue;
		}
		const hit = gradleCache.get(p);
		if (hit && hit.mtime === mtime) {
			if (hit.id) return hit.id;
			continue;
		}
		let id: string | null = null;
		try {
			const m = /applicationId\s*=?\s*["']([\w.]+)["']/.exec(fs.readFileSync(p, 'utf8'));
			id = m ? m[1] : null;
		} catch {
			// illeggibile
		}
		gradleCache.set(p, { mtime, id });
		if (id) return id;
	}
	return null;
}

// ---------- AdMob ----------

export interface RigaAdmob {
	dim: Record<string, string>;
	euro: number;
	richieste: number;
	abbinate: number;
	impressioni: number;
	clic: number;
}

/** Le righe di un networkReport:generate (un array di header, row e footer). */
export function leggiAdmob(rep: any): RigaAdmob[] {
	const parti = Array.isArray(rep) ? rep : [rep];
	const out: RigaAdmob[] = [];
	const num = (v: any) => (v ? Number(v.microsValue ?? NaN) / 1e6 || Number(v.integerValue ?? 0) || Number(v.doubleValue ?? 0) || 0 : 0);
	for (const p of parti) {
		const r = p?.row;
		if (!r) continue;
		const dim: Record<string, string> = {};
		for (const [k, v] of Object.entries<any>(r.dimensionValues ?? {})) dim[k] = String(v?.value ?? '');
		const m = r.metricValues ?? {};
		out.push({
			dim,
			euro: num(m.ESTIMATED_EARNINGS),
			richieste: num(m.AD_REQUESTS),
			abbinate: num(m.MATCHED_REQUESTS),
			impressioni: num(m.IMPRESSIONS),
			clic: num(m.CLICKS),
		});
	}
	return out;
}

export interface AppAdmob {
	appId: string;
	piattaforma: string;
	nome: string;
	store?: string;
	approvazione?: string;
}

export interface UnitaAdmob {
	id: string;
	appId: string;
	nome: string;
	formato: string;
}

export interface DatiAdmob {
	publisher: string;
	app: AppAdmob[];
	unita: UnitaAdmob[];
	giorni: RigaAdmob[];
	mesi: RigaAdmob[];
	formati: RigaAdmob[];
	perUnita: RigaAdmob[];
	paesi: RigaAdmob[];
}

// ---------- costruzione dello stato ----------

export interface Ingressi {
	now: number;
	giorni: string[];
	mesi: string[];
	venditeGiorni: Record<string, Voce | undefined>;
	venditeMesi: Record<string, Voce | undefined>;
	/** Quante unita' di una valuta fanno un euro. */
	cambi: Record<string, number>;
	asc: { id: string; name: string; bundleId: string }[];
	nomiVendite: Record<string, string>;
	admob: DatiAdmob | null;
	/** Chiave dell'app -> progetto. */
	collegamenti: Record<string, { path: string; name: string }>;
	repo: Record<string, RepoEsito>;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const somma = (a: number[], da = 0, a2 = a.length) => a.slice(Math.max(0, da), a2).reduce((s, x) => s + x, 0);
const vuota = (n: number): Serie => ({ admob: new Array(n).fill(0), store: new Array(n).fill(0), dl: new Array(n).fill(0) });

/** Una riga di vendite in euro; le valute senza cambio finiscono in `senza`. */
function euro(r: RigaVendite, cambi: Record<string, number>, senza: Set<string>): number {
	let e = 0;
	for (const [v, x] of Object.entries(r.pr)) {
		if (v === 'EUR') e += x;
		else if (cambi[v] > 0) e += x / cambi[v];
		else if (x) senza.add(v);
	}
	return e;
}

const FORMATO_ADMOB: Record<string, string> = {
	BANNER: 'banner',
	INTERSTITIAL: 'interstitial',
	REWARDED: 'rewarded',
	REWARDED_INTERSTITIAL: 'rewarded_interstitial',
	APP_OPEN: 'app_open',
	NATIVE: 'native',
};

export function costruisci(x: Ingressi): Omit<AppStoreStato, 'aggiornatoAt' | 'aggiornando' | 'errori'> {
	const nG = x.giorni.length;
	const nM = x.mesi.length;
	const senza = new Set<string>();
	const app = new Map<string, AppRiga>();
	const ascById = new Map(x.asc.map(a => [a.id, a]));
	const prendi = (chiave: string, base: Partial<AppRiga>): AppRiga => {
		let a = app.get(chiave);
		if (!a) {
			a = { chiave, nome: '', piattaforma: 'ios', giorni: vuota(nG), mesi: vuota(nM), formati: [], unita: [], acquisti: { nuovi: 0, rinnovi: 0, altri: 0, euro: 0 }, ...base };
			app.set(chiave, a);
		}
		return a;
	};
	const appIos = (appleId: string) => {
		const asc = ascById.get(appleId);
		const a = prendi('ios:' + appleId, { ascId: appleId });
		if (asc) {
			a.nome = asc.name;
			a.bundleId = asc.bundleId;
		} else if (!a.nome) a.nome = x.nomiVendite[appleId] || `App ${appleId}`;
		return a;
	};

	// --- Store, giorno per giorno ---
	const giornoIdx = new Map(x.giorni.map((d, i) => [d, i]));
	let storeFinoA: string | undefined;
	const ultimi30 = new Set(x.giorni.slice(-30));
	for (const [d, i] of giornoIdx) {
		const v = x.venditeGiorni[d];
		if (!v) continue;
		storeFinoA = d;
		if (typeof v === 'string') continue;
		for (const [k, r] of Object.entries(v)) {
			if (k.startsWith('sku:')) continue;
			const a = appIos(k);
			a.giorni.dl[i] += r.dl;
			const e = euro(r, x.cambi, senza);
			a.giorni.store[i] += e;
			if (ultimi30.has(d)) {
				a.acquisti.nuovi += r.sn;
				a.acquisti.rinnovi += r.sr;
				a.acquisti.altri += r.iap;
				a.acquisti.euro += e;
			}
		}
	}
	// --- Store, mese per mese: il report mensile se c'e', altrimenti la somma dei giorni ---
	for (let i = 0; i < nM; i++) {
		const m = x.mesi[i];
		const v = x.venditeMesi[m];
		if (v && typeof v !== 'string') {
			for (const [k, r] of Object.entries(v)) {
				if (k.startsWith('sku:')) continue;
				const a = appIos(k);
				a.mesi.dl[i] += r.dl;
				a.mesi.store[i] += euro(r, x.cambi, senza);
			}
			continue;
		}
		for (const [d, gi] of giornoIdx) {
			if (!d.startsWith(m)) continue;
			for (const a of app.values()) {
				a.mesi.dl[i] += a.giorni.dl[gi];
				a.mesi.store[i] += a.giorni.store[gi];
			}
		}
	}

	// --- AdMob ---
	const ad = x.admob;
	const chiaveAdmob = new Map<string, string>();
	if (ad) {
		for (const a of ad.app) {
			let chiave: string;
			if (a.store && a.piattaforma === 'IOS') {
				chiave = 'ios:' + a.store;
				const riga = appIos(a.store);
				if (!ascById.has(a.store)) riga.nome = a.nome || riga.nome;
			} else if (a.store && a.piattaforma === 'ANDROID') {
				chiave = 'android:' + a.store;
				prendi(chiave, { nome: a.nome, piattaforma: 'android' });
			} else {
				chiave = 'admob:' + a.appId;
				prendi(chiave, { nome: a.nome || a.appId, piattaforma: a.piattaforma === 'ANDROID' ? 'android' : 'ios' });
			}
			const riga = app.get(chiave)!;
			riga.admobId = a.appId;
			riga.approvazione = a.approvazione;
			riga.collegata = !!a.store;
			chiaveAdmob.set(a.appId, chiave);
		}
		const riga = (appId: string) => {
			const k = chiaveAdmob.get(appId);
			return k ? app.get(k) : undefined;
		};
		const idxG = new Map(x.giorni.map((d, i) => [d.replace(/-/g, ''), i]));
		for (const r of ad.giorni) {
			const a = riga(r.dim.APP);
			const i = idxG.get(r.dim.DATE);
			if (a && i !== undefined) a.giorni.admob[i] += r.euro;
		}
		const idxM = new Map(x.mesi.map((m, i) => [m.replace('-', ''), i]));
		for (const r of ad.mesi) {
			const a = riga(r.dim.APP);
			const i = idxM.get(r.dim.MONTH);
			if (a && i !== undefined) a.mesi.admob[i] += r.euro;
		}
		for (const r of ad.formati) {
			const a = riga(r.dim.APP);
			if (!a) continue;
			a.formati.push({ formato: r.dim.FORMAT, richieste: r.richieste, abbinate: r.abbinate, impressioni: r.impressioni, clic: r.clic, euro: r2(r.euro) });
		}
		const perUnita = new Map(ad.perUnita.map(r => [r.dim.AD_UNIT, r]));
		for (const u of ad.unita) {
			const a = riga(u.appId);
			if (!a) continue;
			const r = perUnita.get(u.id);
			a.unita.push({ id: u.id, nome: u.nome, formato: FORMATO_ADMOB[u.formato] ?? u.formato.toLowerCase(), richieste: r?.richieste ?? 0, impressioni: r?.impressioni ?? 0, euro: r2(r?.euro ?? 0) });
		}
	}

	// --- progetti e repository ---
	for (const a of app.values()) {
		const p = x.collegamenti[a.chiave];
		if (p) {
			a.projectPath = p.path;
			a.projectName = p.name;
			if (x.repo[p.path]) a.repo = x.repo[p.path];
		}
		a.formati.sort((p1, p2) => p2.euro - p1.euro || p2.richieste - p1.richieste);
		a.unita.sort((u1, u2) => u2.richieste - u1.richieste);
		a.acquisti.euro = r2(a.acquisti.euro);
		for (const s of [a.giorni, a.mesi]) {
			s.admob = s.admob.map(r2);
			s.store = s.store.map(r2);
		}
	}

	// --- totali, su tutte le app ---
	const totale = { giorni: vuota(nG), mesi: vuota(nM) };
	for (const a of app.values()) {
		for (const k of ['giorni', 'mesi'] as const) {
			for (const s of ['admob', 'store', 'dl'] as const) a[k][s].forEach((v, i) => (totale[k][s][i] += v));
		}
	}
	for (const k of ['giorni', 'mesi'] as const) {
		totale[k].admob = totale[k].admob.map(r2);
		totale[k].store = totale[k].store.map(r2);
	}

	// si mostrano le app che in un anno hanno reso, venduto, scaricato o chiesto annunci
	const mostrate = [...app.values()].filter(a => {
		const anno = a.mesi.admob.slice(-12);
		return somma(anno) > 0 || somma(a.mesi.store.slice(-12)) !== 0 || somma(a.mesi.dl.slice(-12)) >= 10 || a.formati.some(f => f.richieste > 0);
	});
	const ult30 = (a: AppRiga) => somma(a.giorni.admob, nG - 30) + somma(a.giorni.store, nG - 30);
	mostrate.sort((p1, p2) => ult30(p2) - ult30(p1) || somma(p2.mesi.dl) - somma(p1.mesi.dl) || p1.nome.localeCompare(p2.nome));

	const paesi = (ad?.paesi ?? [])
		.map(r => ({ codice: r.dim.COUNTRY, euro: r2(r.euro), impressioni: r.impressioni }))
		.filter(p => p.codice && p.euro > 0)
		.sort((p1, p2) => p2.euro - p1.euro)
		.slice(0, 12);

	return {
		valuta: 'EUR',
		giorni: x.giorni,
		mesi: x.mesi,
		storeFinoA,
		totale,
		app: mostrate,
		paesi,
		storeSenzaDati: x.mesi.filter(m => x.venditeMesi[m] === 'perso'),
		buchi: trovaBuchi(mostrate, ad?.publisher),
		senzaCambio: [...senza].sort(),
		publisher: ad?.publisher,
	};
}

// ---------- i buchi ----------

const FORMATO_NOME: Record<string, string> = {
	banner: 'banner',
	interstitial: 'interstitial',
	rewarded: 'con premio',
	rewarded_interstitial: 'interstitial con premio',
	app_open: "all'apertura",
	native: 'nativo',
};
export const nomeFormato = (f: string) => FORMATO_NOME[f] ?? f;

/** Sotto questa quota di annunci mostrati su quelli caricati si butta via inventario. L'apertura ha una quota
 *  naturalmente piu' bassa (si carica a ogni ritorno in primo piano), quindi una soglia sua. */
const SOGLIA_MOSTRATI: Record<string, number> = { app_open: 0.2, interstitial: 0.35, rewarded: 0.35, rewarded_interstitial: 0.35, banner: 0.5, native: 0.4 };

const euroTesto = (n: number) => `${n.toLocaleString('it-IT', { maximumFractionDigits: n < 10 ? 2 : 0 })} €`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** RPM (euro ogni mille impressioni) del portafoglio per formato, negli ultimi 30 giorni. */
function rpmPortafoglio(apps: AppRiga[]): Record<string, number> {
	const acc: Record<string, { e: number; i: number }> = {};
	for (const a of apps) for (const f of a.formati) {
		const s = (acc[f.formato] ??= { e: 0, i: 0 });
		s.e += f.euro;
		s.i += f.impressioni;
	}
	const out: Record<string, number> = {};
	for (const [k, s] of Object.entries(acc)) if (s.i >= 500) out[k] = (s.e / s.i) * 1000;
	return out;
}

export function trovaBuchi(apps: AppRiga[], publisher?: string): Buco[] {
	const out: Buco[] = [];
	/** Unita' AdMob di tutte le app, per capire di chi e' un ID trovato nel codice. */
	const diChi = new Map<string, AppRiga>();
	for (const a of apps) for (const u of a.unita) diChi.set(u.id, a);
	const rpm = rpmPortafoglio(apps);
	const n = apps[0]?.giorni.dl.length ?? 0;
	const pub = publisher ? publisher.replace(/^accounts\//, '').replace(/^pub-/, '') : '';
	// euro AdMob per download, mediana delle app che hanno entrambi: serve a stimare un'app senza annunci
	const perDl = apps
		.map(a => ({ e: somma(a.giorni.admob, n - 30), d: somma(a.giorni.dl, n - 30) }))
		.filter(v => v.e > 0 && v.d >= 30)
		.map(v => v.e / v.d)
		.sort((p, q) => p - q);
	const mediana = perDl.length >= 3 ? perDl[Math.floor(perDl.length / 2)] : 0;

	for (const a of apps) {
		const dl30 = somma(a.giorni.dl, n - 30);
		const dlPrima = somma(a.giorni.dl, n - 60, n - 30);
		const ad30 = somma(a.giorni.admob, n - 30);
		const ad7 = somma(a.giorni.admob, n - 7);
		const adPrima7 = somma(a.giorni.admob, n - 14, n - 7);
		const st30 = somma(a.giorni.store, n - 30);
		const richieste = a.formati.reduce((s, f) => s + f.richieste, 0);
		const r = a.repo;
		const base = { chiave: a.chiave, app: a.nome, projectPath: a.projectPath };
		const dove = a.projectName ? ` nel progetto ${a.projectName}` : '';
		const add = (b: Omit<Buco, 'chiave' | 'app' | 'projectPath'>) => out.push({ ...base, ...b });

		// 1. AdMob limita l'app
		if (a.admobId && a.approvazione && a.approvazione !== 'APPROVED' && (richieste > 0 || dl30 > 0)) {
			add({
				id: `${a.chiave}:approvazione`,
				gravita: 'alta',
				titolo: 'AdMob non ha approvato l\'app',
				perche: `Su AdMob l'app è in stato «${a.approvazione === 'ACTION_REQUIRED' ? 'richiede un intervento' : a.approvazione.toLowerCase().replace(/_/g, ' ')}»: finché non è approvata gli annunci sono limitati o fermi.`,
				cosa: 'Apri l\'app nella console di AdMob, guarda cosa chiede (di solito collegarla allo Store o app-ads.txt) e sistemalo.',
			});
		}
		// 2. Non collegata allo Store
		if (a.admobId && a.collegata === false && richieste > 0) {
			add({
				id: `${a.chiave}:scollegata`,
				gravita: 'media',
				titolo: 'L\'app di AdMob non è collegata allo Store',
				perche: 'Un\'app non collegata alla sua scheda riceve meno annunci, e la Bottega non può unire i suoi guadagni ai download.',
				cosa: 'In AdMob: App, Impostazioni app, «Aggiungi store dell\'app», e scegli la scheda giusta.',
			});
		}
		// 3. Download senza guadagni
		if (dl30 >= 30 && ad30 === 0 && st30 <= 0 && richieste === 0) {
			const stima = mediana ? dl30 * mediana : undefined;
			const sdk = r?.sdk;
			add({
				id: `${a.chiave}:ferma`,
				gravita: 'alta',
				titolo: sdk ? 'AdMob è nel codice ma non chiede annunci' : 'Scaricata ma non guadagna',
				perche: sdk
					? `${dl30} download negli ultimi 30 giorni, AdMob è integrato${dove} ma nessuna richiesta di annunci è arrivata: l'app pubblicata forse non ha gli annunci accesi o usa un ID di app sbagliato.`
					: `${dl30} download negli ultimi 30 giorni e nessun euro, né da AdMob né dallo Store.`,
				cosa: sdk
					? 'Controlla che GADApplicationIdentifier e gli ID delle unità siano quelli di questa app su AdMob e che la versione pubblicata li usi.'
					: 'Aggiungi AdMob (banner adattivo, un interstitial ogni qualche azione, app open al ritorno) con il consenso UMP e ATT.',
				stima,
				stimaNota: stima ? 'download del mese per la resa mediana per download delle tue altre app' : undefined,
				compito: sdk
					? `L'app ${a.nome} ha ${dl30} download in 30 giorni ma AdMob non riceve nessuna richiesta di annunci. Trova perché: controlla GADApplicationIdentifier, gli ID delle unità e che il codice degli annunci giri nella build Release. Usa la skill ios-admob-integration.`
					: `L'app ${a.nome} ha ${dl30} download in 30 giorni e non guadagna niente. Integra AdMob con la skill ios-admob-integration: banner adattivo, interstitial con frequenza misurata, app open al ritorno in primo piano, consenso UMP e ATT, SKAdNetworkItems. Crea prima le unità nell'account AdMob giusto.`,
			});
		}
		// 4 e 5. Riempimento e annunci mostrati, formato per formato
		for (const f of a.formati) {
			const fill = f.richieste ? f.abbinate / f.richieste : 1;
			const mostrati = f.abbinate ? f.impressioni / f.abbinate : 1;
			const rpmF = f.impressioni >= 200 ? (f.euro / f.impressioni) * 1000 : (rpm[f.formato] ?? 0);
			if (f.richieste >= 500 && fill < 0.6) {
				const stima = (f.richieste * 0.9 - f.abbinate) * Math.min(0.6, Math.max(0.25, mostrati)) * (rpm[f.formato] ?? rpmF) / 1000;
				add({
					id: `${a.chiave}:fill:${f.formato}`,
					gravita: fill < 0.2 ? 'alta' : 'media',
					titolo: `Annunci ${nomeFormato(f.formato)}: solo il ${pct(fill)} delle richieste trova un annuncio`,
					perche: `${f.richieste.toLocaleString('it-IT')} richieste in 30 giorni, ${f.abbinate.toLocaleString('it-IT')} con un annuncio. Sotto il 60% c'è un problema: unità nuova o sbagliata, floor troppo alto, app non approvata o niente consenso in Europa.`,
					cosa: fill < 0.2 ? 'Controlla che l\'ID dell\'unità nel codice sia giusto e di questa app, e che non abbia un floor di eCPM.' : 'Togli il floor dall\'unità o aggiungi una fonte di mediazione; controlla il consenso UMP.',
					stima: stima > 0.5 ? stima : undefined,
					stimaNota: 'se trovasse un annuncio il 90% delle volte, alla resa media del formato',
					compito: `Nell'app ${a.nome} le richieste di annunci ${nomeFormato(f.formato)} trovano un annuncio solo il ${pct(fill)} delle volte (30 giorni, ${f.richieste} richieste). Controlla l'ID dell'unità usato nel codice per quel formato, che non sia un ID di prova o di un'altra app, e il flusso del consenso UMP prima del caricamento. Usa la skill ios-admob-integration.`,
				});
			}
			const soglia = SOGLIA_MOSTRATI[f.formato] ?? 0.35;
			const premio = f.formato === 'rewarded' || f.formato === 'rewarded_interstitial';
			if (premio && f.abbinate >= 500 && mostrati < 0.15) {
				// un annuncio con premio lo sceglie l'utente: non si stima in euro, si dice che l'offerta non attira
				add({
					id: `${a.chiave}:mostrati:${f.formato}`,
					gravita: 'bassa',
					titolo: `Annunci ${nomeFormato(f.formato)}: guardati solo il ${pct(mostrati)} di quelli caricati`,
					perche: `${f.abbinate.toLocaleString('it-IT')} caricati in 30 giorni, ${f.impressioni.toLocaleString('it-IT')} guardati. O l'offerta si vede poco o non vale la pena, o l'annuncio si carica dove l'utente non arriva mai.`,
					cosa: 'Carica l\'annuncio con premio solo nella schermata che lo offre, e rendi il premio chiaro e utile (una funzione Pro per un giorno, per esempio).',
				});
			} else if (!premio && f.abbinate >= 500 && mostrati < soglia) {
				const stima = (f.abbinate * (soglia - mostrati) * rpmF) / 1000;
				add({
					id: `${a.chiave}:mostrati:${f.formato}`,
					gravita: mostrati < soglia / 2 ? 'alta' : 'media',
					titolo: `Annunci ${nomeFormato(f.formato)} caricati e non mostrati: ${pct(mostrati)}`,
					perche: `${f.abbinate.toLocaleString('it-IT')} annunci caricati in 30 giorni, ${f.impressioni.toLocaleString('it-IT')} mostrati. Un annuncio caricato e mai mostrato non rende e abbassa la resa delle richieste future.`,
					cosa:
						f.formato === 'app_open'
							? 'Carica l\'annuncio di apertura una volta sola e mostralo al ritorno in primo piano (dopo almeno 30 secondi fuori), scartandolo dopo 4 ore; non ricaricarlo a ogni scena.'
							: 'Carica l\'annuncio solo poco prima del punto in cui lo mostri davvero, e mostralo in quel punto.',
					stima: stima > 0.5 ? stima : undefined,
					stimaNota: `se ne mostrasse almeno il ${pct(soglia)}, alla resa attuale del formato`,
					compito: `Nell'app ${a.nome} gli annunci ${nomeFormato(f.formato)} vengono caricati ${f.abbinate} volte in 30 giorni ma mostrati solo ${f.impressioni} (${pct(mostrati)}). Trova dove vengono caricati e sistema il ciclo: caricare solo quando si mostrerà, riusare quello già caricato, scadenza dopo 4 ore per l'app open. Usa la skill ios-admob-integration.`,
				});
			}
		}
		// 6. Solo banner
		const formatiVivi = new Set(a.formati.filter(f => f.impressioni > 0).map(f => f.formato));
		const impBanner = a.formati.find(f => f.formato === 'banner')?.impressioni ?? 0;
		if (formatiVivi.size && [...formatiVivi].every(f => f === 'banner' || f === 'native') && impBanner >= 3000 && !(r?.formati ?? []).some(f => ['interstitial', 'rewarded', 'app_open', 'rewarded_interstitial'].includes(f))) {
			const stima = rpm.interstitial ? (impBanner * 0.08 * rpm.interstitial) / 1000 : undefined;
			add({
				id: `${a.chiave}:formati`,
				gravita: 'media',
				titolo: 'Solo banner: manca un formato a schermo intero',
				perche: `${impBanner.toLocaleString('it-IT')} banner mostrati in 30 giorni e nessun interstitial, annuncio con premio o di apertura. Sono i formati che rendono di più.`,
				cosa: 'Aggiungi un app open al ritorno in primo piano, o un interstitial nei punti di pausa naturali (non più di uno ogni due minuti).',
				stima,
				stimaNota: stima ? 'stima larga: un interstitial ogni 12 banner, alla resa media dei tuoi interstitial' : undefined,
				compito: `L'app ${a.nome} mostra solo banner. Aggiungi un formato a schermo intero (app open al ritorno in primo piano o interstitial nei punti di pausa, con frequenza misurata) con la skill ios-admob-integration, creando l'unità nell'account AdMob.`,
			});
		}
		// 7-10. Il codice
		if (r?.sdk) {
			if (!r.ump) {
				add({
					id: `${a.chiave}:ump`,
					gravita: 'alta',
					titolo: 'Manca il consenso Google (UMP)',
					perche: `AdMob è nel codice${dove} ma non trovo User Messaging Platform: in Europa senza consenso arrivano solo annunci limitati, e Google può sospendere le richieste.`,
					cosa: 'Aggiungi UMP: chiedi il consenso all\'avvio e carica gli annunci solo quando canRequestAds è vero.',
					compito: `Nel progetto dell'app ${a.nome} AdMob è integrato ma manca il consenso Google UMP. Aggiungi UserMessagingPlatform con la skill ios-admob-integration: richiesta all'avvio, annunci solo con canRequestAds, pulsante per rivedere le scelte nelle impostazioni.`,
				});
			}
			if (!r.att && a.piattaforma === 'ios') {
				add({
					id: `${a.chiave}:att`,
					gravita: 'media',
					titolo: 'Manca la richiesta di tracciamento (ATT)',
					perche: `Non trovo NSUserTrackingUsageDescription${dove}: senza ATT gli annunci su iOS rendono meno, perché nessun utente può dare il permesso.`,
					cosa: 'Aggiungi la descrizione nel Info.plist e chiedi il permesso dopo il consenso UMP.',
					compito: `Nell'app ${a.nome} manca ATT. Aggiungi NSUserTrackingUsageDescription e la richiesta requestTrackingAuthorization dopo il consenso UMP, con la skill ios-admob-integration.`,
				});
			} else if (r.att && !r.attRichiesta && a.piattaforma === 'ios') {
				add({
					id: `${a.chiave}:att-richiesta`,
					gravita: 'media',
					titolo: 'ATT dichiarato ma mai chiesto',
					perche: `C'è NSUserTrackingUsageDescription${dove} ma non trovo requestTrackingAuthorization: il permesso non viene mai chiesto.`,
					cosa: 'Chiedi il permesso di tracciamento dopo il consenso UMP, prima di caricare il primo annuncio.',
				});
			}
			if (r.skan < 10 && a.piattaforma === 'ios') {
				add({
					id: `${a.chiave}:skan`,
					gravita: 'bassa',
					titolo: `Pochi SKAdNetworkItems: ${r.skan}`,
					perche: 'Gli inserzionisti che pagano di più misurano con SKAdNetwork: senza i loro identificativi nel Info.plist l\'annuncio vale meno.',
					cosa: 'Copia nel Info.plist l\'elenco completo degli identificativi SKAdNetwork pubblicato da Google.',
				});
			}
			if (r.idProva.length) {
				add({
					id: `${a.chiave}:prova`,
					gravita: 'media',
					titolo: 'ID di prova di AdMob nel codice',
					perche: `L'ID di prova di Google è in ${r.idProva.slice(0, 3).join(', ')}${r.idProva.length > 3 ? ' e altri' : ''}: se finisce nella build pubblicata, quegli annunci non pagano.`,
					cosa: 'Controlla che gli ID di prova stiano solo dietro #if DEBUG e che Release usi le unità vere.',
				});
			}
			// solo gli ID della piattaforma dell'app: un repository con iOS e Android ha anche quelli dell'altra
			const mie = r.unita.filter(u => u.piattaforma === a.piattaforma).map(u => u.id);
			const estranee = pub ? mie.filter(u => !u.includes(pub)) : [];
			const mancanti = pub && a.admobId ? mie.filter(u => { const altra = diChi.get(u); return altra && altra !== a && altra.piattaforma === a.piattaforma; }) : [];
			if (estranee.length) {
				add({
					id: `${a.chiave}:estranee`,
					gravita: 'alta',
					titolo: 'ID di unità di un altro account AdMob',
					perche: `Nel codice ci sono ${estranee.length === 1 ? 'un ID' : estranee.length + ' ID'} di unità che non sono del tuo account (${estranee[0]}): quei guadagni vanno altrove o non arrivano.`,
					cosa: 'Sostituiscili con unità create nel tuo account AdMob per questa app.',
				});
			}
			if (mancanti.length) {
				add({
					id: `${a.chiave}:altra-app`,
					gravita: 'media',
					titolo: 'ID di unità di un\'altra app',
					perche: `Nel codice c'è ${mancanti[0]}, che su AdMob è un'unità di «${diChi.get(mancanti[0])!.nome}»: i guadagni finiscono sotto l'app sbagliata e le statistiche si confondono.`,
					cosa: 'Crea le unità per questa app e usa quelle.',
				});
			}
		}
		// 11. Unita' create e mai chiamate
		if (richieste > 0) {
			const ferme = a.unita.filter(u => u.richieste === 0);
			if (ferme.length) {
				add({
					id: `${a.chiave}:ferme`,
					gravita: 'bassa',
					titolo: ferme.length === 1 ? `Un'unità mai chiamata: ${ferme[0].nome}` : `${ferme.length} unità mai chiamate`,
					perche: `Su AdMob ${ferme.map(u => `«${u.nome}» (${nomeFormato(u.formato)})`).slice(0, 3).join(', ')} non ha ricevuto richieste in 30 giorni: o il codice non la usa più, o il punto in cui dovrebbe comparire non si raggiunge.`,
					cosa: 'Se il formato serve, controlla che il codice usi quell\'ID; se non serve, ignorala.',
				});
			}
		}
		// 12. Calo dei guadagni
		if (adPrima7 >= 5 && ad7 < adPrima7 * 0.65) {
			add({
				id: `${a.chiave}:calo`,
				gravita: 'media',
				titolo: `AdMob in calo: ${pct(1 - ad7 / adPrima7)} in meno in una settimana`,
				perche: `Ultimi 7 giorni ${euroTesto(ad7)}, i 7 prima ${euroTesto(adPrima7)}.`,
				cosa: 'Guarda se è uscita una versione nuova in questi giorni, se sono calati i download o se un formato ha smesso di rendere.',
				stima: (adPrima7 - ad7) * (30 / 7),
				stimaNota: 'la differenza della settimana, portata a un mese',
			});
		}
		// 13. Calo dei download
		if (dlPrima >= 60 && dl30 < dlPrima * 0.7) {
			add({
				id: `${a.chiave}:download`,
				gravita: 'media',
				titolo: `Download in calo: ${pct(1 - dl30 / dlPrima)} in meno`,
				perche: `${dl30} download negli ultimi 30 giorni, ${dlPrima} nei 30 prima.`,
				cosa: 'Controlla posizione nelle ricerche, recensioni recenti e se una versione ha cambiato titolo o parole chiave.',
			});
		}
		// 14. Acquisti in-app che non vendono
		if ((r?.storekit || r?.revenuecat) && dl30 >= 100 && a.acquisti.euro <= 0 && a.acquisti.nuovi + a.acquisti.altri === 0) {
			add({
				id: `${a.chiave}:paywall`,
				gravita: 'bassa',
				titolo: 'Acquisti in-app che non vendono',
				perche: `Il codice${dove} ha gli acquisti in-app ma in 30 giorni, con ${dl30} download, non è entrato niente.`,
				cosa: 'Guarda quando compare il paywall, il prezzo e se la prova gratuita è chiara.',
			});
		}
	}
	const peso: Record<Gravita, number> = { alta: 0, media: 1, bassa: 2 };
	out.sort((p, q) => peso[p.gravita] - peso[q.gravita] || (q.stima ?? 0) - (p.stima ?? 0) || p.app.localeCompare(q.app));
	for (const b of out) if (b.stima !== undefined) b.stima = r2(b.stima);
	return out;
}

// ---------- il motore ----------

export interface AppStoreOpzioni {
	radar: () => Radar | undefined;
	projects: () => Project[];
	log?: (s: string) => void;
	dir?: string;
	now?: () => number;
	fetch?: typeof fetch;
	ascEnvFile?: string;
}

interface Cache {
	schema: number;
	giorni: Record<string, Voce>;
	mesi: Record<string, Voce>;
	sku: Record<string, string>;
	nomi: Record<string, string>;
	cambi?: { at: number; rates: Record<string, number> };
	repo: Record<string, RepoEsito>;
}

export class AppStore {
	private readonly dir: string;
	private readonly file: string;
	private readonly now: () => number;
	private readonly fetch: typeof fetch;
	private readonly ascEnvFile: string;
	private cache: Cache;
	private stato: AppStoreStato;
	private running: Promise<void> | undefined;
	private provatoAt = 0;
	private listeners: ((s: AppStoreStato) => void)[] = [];

	constructor(private readonly o: AppStoreOpzioni) {
		this.dir = o.dir ?? path.join(os.homedir(), '.bottega', 'appstore');
		this.file = path.join(this.dir, 'vendite.json');
		this.now = o.now ?? Date.now;
		this.fetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
		this.ascEnvFile = o.ascEnvFile ?? path.join(os.homedir(), '.secrets', 'appstoreconnect-api.env');
		this.cache = this.carica();
		this.stato = this.caricaStato();
	}

	state(): AppStoreStato {
		return { ...this.stato, aggiornando: !!this.running };
	}

	onChange(cb: (s: AppStoreStato) => void): void {
		this.listeners.push(cb);
	}

	private emit() {
		const s = this.state();
		for (const cb of this.listeners) {
			try {
				cb(s);
			} catch (e) {
				this.log('appstore: ' + (e as Error).message);
			}
		}
	}

	private log(s: string) {
		this.o.log?.(s);
	}

	private carica(): Cache {
		try {
			const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			if (raw?.schema === SCHEMA) return { repo: {}, ...raw };
		} catch {
			// prima volta
		}
		return { schema: SCHEMA, giorni: {}, mesi: {}, sku: {}, nomi: {}, repo: {} };
	}

	private caricaStato(): AppStoreStato {
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(this.dir, 'stato.json'), 'utf8'));
			if (raw?.schema === SCHEMA && raw.stato) return { ...raw.stato, aggiornando: false };
		} catch {
			// prima volta
		}
		return { aggiornatoAt: 0, aggiornando: false, errori: {}, valuta: 'EUR', giorni: [], mesi: [], storeSenzaDati: [], totale: { giorni: vuota(0), mesi: vuota(0) }, app: [], paesi: [], buchi: [], senzaCambio: [] };
	}

	private scrivi(file: string, dati: unknown) {
		try {
			fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			fs.chmodSync(this.dir, 0o700);
			const tmp = file + '.tmp';
			fs.writeFileSync(tmp, JSON.stringify(dati), { mode: 0o600 });
			fs.renameSync(tmp, file);
		} catch (e) {
			this.log('appstore: non riesco a salvare: ' + (e as Error).message);
		}
	}

	/** Una lettura alla volta; tra due letture almeno 45 minuti, salvo force. */
	refresh(opts: { force?: boolean } = {}): Promise<void> {
		if (this.running) return this.running;
		if (!opts.force && this.now() - this.provatoAt < MIN_GAP && this.stato.aggiornatoAt) return Promise.resolve();
		this.provatoAt = this.now();
		this.running = this.run(!!opts.force)
			.catch(e => this.log('appstore: ' + (e as Error).message))
			.finally(() => {
				this.running = undefined;
				this.stato.fase = undefined;
				this.emit();
			});
		this.emit();
		return this.running;
	}

	private fase(f: string) {
		this.stato.fase = f;
		this.emit();
	}

	private async run(force: boolean) {
		const radar = this.o.radar();
		if (!radar) throw new Error('il radar non è pronto');
		const now = this.now();
		const giorni = ultimiGiorni(now);
		const mesi = ultimiMesi(now);
		const errori: AppStoreStato['errori'] = {};

		this.fase('Leggo le app su App Store Connect');
		let asc: Ingressi['asc'] = [];
		try {
			asc = await this.appAsc(radar);
		} catch (e) {
			errori.store = msg(e, 'App Store Connect');
		}

		const [vendite, admob, cambi] = await Promise.allSettled([
			errori.store ? Promise.reject(new Error(errori.store)) : this.vendite(radar, giorni, mesi),
			this.admob(radar, giorni, mesi),
			this.cambi(),
		]);
		if (vendite.status === 'rejected') errori.store = msg(vendite.reason, 'App Store Connect');
		if (cambi.status === 'rejected') errori.cambi = msg(cambi.reason, 'Il servizio dei cambi');
		let datiAdmob: DatiAdmob | null = null;
		if (admob.status === 'fulfilled') datiAdmob = admob.value;
		else errori.admob = msg(admob.reason, 'AdMob');

		// collegamenti app -> progetto
		const progetti = this.o.projects();
		const collegamenti: Ingressi['collegamenti'] = {};
		const perBundle = new Map<string, Project>();
		const perPacchetto = new Map<string, Project>();
		for (const p of progetti) {
			for (const id of projectBundleIds(p)) if (!perBundle.has(id)) perBundle.set(id, p);
			if (p.kinds.includes('android')) {
				const id = androidAppId(p.path);
				if (id && !perPacchetto.has(id)) perPacchetto.set(id, p);
			}
		}
		for (const a of asc) {
			const p = perBundle.get(a.bundleId);
			if (p) collegamenti['ios:' + a.id] = { path: p.path, name: p.name };
		}
		for (const a of datiAdmob?.app ?? []) {
			if (a.piattaforma === 'ANDROID' && a.store) {
				const p = perPacchetto.get(a.store);
				if (p) collegamenti['android:' + a.store] = { path: p.path, name: p.name };
			}
		}

		// i repository delle app collegate
		this.fase('Leggo il codice delle app');
		const daLeggere = [...new Set(Object.values(collegamenti).map(c => c.path))].filter(p => force || !this.cache.repo[p] || now - this.cache.repo[p].letteAt > REPO_TTL);
		try {
			for (const p of daLeggere) this.cache.repo[p] = await leggiRepo(p, now);
		} catch (e) {
			errori.repo = (e as Error).message;
		}

		const base = costruisci({
			now,
			giorni,
			mesi,
			venditeGiorni: this.cache.giorni,
			venditeMesi: this.cache.mesi,
			cambi: this.cache.cambi?.rates ?? {},
			asc,
			nomiVendite: this.cache.nomi,
			admob: datiAdmob,
			collegamenti,
			repo: this.cache.repo,
		});
		// senza AdMob si tengono i numeri AdMob dell'ultima lettura buona, invece di mostrare zeri
		if (!datiAdmob && this.stato.giorni.length) {
			const vecchio = new Map(this.stato.app.map(a => [a.chiave, a]));
			for (const a of base.app) {
				const v = vecchio.get(a.chiave);
				if (!v) continue;
				a.giorni.admob = riallinea(this.stato.giorni, v.giorni.admob, giorni);
				a.mesi.admob = riallinea(this.stato.mesi, v.mesi.admob, mesi);
				a.formati = v.formati;
				a.unita = v.unita;
				a.approvazione = v.approvazione;
				a.collegata = v.collegata;
				a.admobId = v.admobId;
			}
			base.totale.giorni.admob = riallinea(this.stato.giorni, this.stato.totale.giorni.admob, giorni);
			base.totale.mesi.admob = riallinea(this.stato.mesi, this.stato.totale.mesi.admob, mesi);
			base.paesi = this.stato.paesi;
			base.buchi = trovaBuchi(base.app, this.stato.publisher);
		}
		this.stato = { ...base, aggiornatoAt: now, aggiornando: false, errori };
		this.scrivi(this.file, this.cache);
		this.scrivi(path.join(this.dir, 'stato.json'), { schema: SCHEMA, stato: this.stato });
	}

	// --- App Store Connect ---

	private async appAsc(radar: Radar): Promise<Ingressi['asc']> {
		const out: Ingressi['asc'] = [];
		let next: string | undefined = '/apps?limit=200&fields[apps]=name,bundleId,sku';
		for (let page = 0; next && page < 5; page++) {
			const j = await radar.asc('GET', next);
			for (const a of j?.data ?? []) {
				const id = String(a.id);
				out.push({ id, name: String(a.attributes?.name ?? ''), bundleId: String(a.attributes?.bundleId ?? '') });
				if (a.attributes?.sku) this.cache.sku[String(a.attributes.sku)] = id;
			}
			next = j?.links?.next;
		}
		return out;
	}

	private async report(radar: Radar, vendor: string, frequenza: 'DAILY' | 'MONTHLY', data: string): Promise<Voce | undefined> {
		const versione = frequenza === 'DAILY' ? '1_1' : '1_0';
		const url =
			'https://api.appstoreconnect.apple.com/v1/salesReports?filter[reportType]=SALES&filter[reportSubType]=SUMMARY' +
			`&filter[frequency]=${frequenza}&filter[reportDate]=${data}&filter[vendorNumber]=${encodeURIComponent(vendor)}&filter[version]=${versione}`;
		const res = await this.fetch(url, { headers: { Authorization: `Bearer ${radar.ascJwt()}` }, signal: AbortSignal.timeout(TIMEOUT) });
		if (res.ok) {
			const buf = Buffer.from(await res.arrayBuffer());
			let testo: string;
			try {
				testo = zlib.gunzipSync(buf).toString('utf8');
			} catch {
				testo = buf.toString('utf8');
			}
			return leggiReport(testo, this.cache.sku, this.cache.nomi);
		}
		let detail = '';
		try {
			const j: any = await res.json();
			detail = String(j?.errors?.[0]?.detail ?? '');
		} catch {
			// corpo non JSON
		}
		if (res.status === 410) return 'perso';
		// 404: «no sales» e' definitivo; tutto il resto (report non ancora pronto) si riprova alla prossima lettura
		if (res.status === 404) return /no sales/i.test(detail) ? 'vuoto' : undefined;
		if (res.status === 401 || res.status === 403) throw new Error('App Store Connect non dà accesso ai report di vendita con questa chiave (serve il ruolo Finance o Sales).');
		if (res.status === 429) throw new Error('App Store Connect chiede di rallentare (429): riprovo più tardi.');
		throw new Error(`App Store Connect ha risposto ${res.status} ai report di vendita${detail ? ': ' + detail.slice(0, 120) : ''}.`);
	}

	private async vendite(radar: Radar, giorni: string[], mesi: string[]) {
		const vendor = readEnvFile(this.ascEnvFile).ASC_VENDOR_NUMBER;
		if (!vendor) throw new Error('Manca ASC_VENDOR_NUMBER in ~/.secrets/appstoreconnect-api.env: serve per i report di vendita.');
		const meseCorrente = mesi[mesi.length - 1];
		const lavori: { tipo: 'g' | 'm'; data: string }[] = [];
		for (const d of giorni) if (!this.cache.giorni[d]) lavori.push({ tipo: 'g', data: d });
		for (const m of mesi) if (m !== meseCorrente && !this.cache.mesi[m]) lavori.push({ tipo: 'm', data: m });
		const recenti = new Set([...giorni.slice(-4), ...mesi.slice(-3)]);
		let fatti = 0;
		let errore: unknown;
		let i = 0;
		await Promise.all(
			Array.from({ length: Math.min(PARALLEL, lavori.length) }, async () => {
				while (i < lavori.length && !errore) {
					const l = lavori[i++];
					try {
						const v = await this.report(radar, vendor, l.tipo === 'g' ? 'DAILY' : 'MONTHLY', l.data);
						// Apple dice «no sales» anche per un report non ancora pubblicato: un vuoto recente non si tiene
						if (v && !(v === 'vuoto' && recenti.has(l.data))) (l.tipo === 'g' ? this.cache.giorni : this.cache.mesi)[l.data] = v;
					} catch (e) {
						errore = e;
					}
					fatti++;
					if (lavori.length > 8 && fatti % 6 === 0) this.fase(`Scarico le vendite dello Store: ${fatti} report su ${lavori.length}`);
				}
			}),
		);
		// i giorni usciti dalla finestra non servono piu'
		const tieni = new Set(giorni);
		for (const d of Object.keys(this.cache.giorni)) if (!tieni.has(d)) delete this.cache.giorni[d];
		if (errore) throw errore;
	}

	// --- AdMob ---

	private async admob(radar: Radar, giorni: string[], mesi: string[]): Promise<DatiAdmob> {
		const acc = await radar.admob('GET', '/accounts');
		const publisher = String(acc?.account?.[0]?.name ?? '');
		if (!publisher) throw new Error('AdMob: nessun account collegato a queste credenziali.');
		const elenco = async (risorsa: 'apps' | 'adUnits') => {
			const out: any[] = [];
			let token = '';
			for (let page = 0; page < 10; page++) {
				const j = await radar.admob('GET', `/${publisher}/${risorsa}?pageSize=500${token ? '&pageToken=' + encodeURIComponent(token) : ''}`);
				out.push(...(j?.[risorsa] ?? []));
				token = j?.nextPageToken || '';
				if (!token) break;
			}
			return out;
		};
		const giorno = (d: string) => {
			const [y, m, g] = d.split('-').map(Number);
			return { year: y, month: m, day: g };
		};
		const ieri = giorno(giorni[giorni.length - 1]);
		const da30 = giorno(giorni[giorni.length - 30]);
		const [y0, m0] = mesi[0].split('-').map(Number);
		const report = async (dim: string[], metriche: string[], inizio: { year: number; month: number; day: number }, fine = ieri) =>
			leggiAdmob(await radar.admob('POST', `/${publisher}/networkReport:generate`, { reportSpec: { dateRange: { startDate: inizio, endDate: fine }, dimensions: dim, metrics: metriche } }));
		const tutte = ['ESTIMATED_EARNINGS', 'AD_REQUESTS', 'MATCHED_REQUESTS', 'IMPRESSIONS', 'CLICKS'];
		this.fase('Leggo AdMob');
		const [app, unita, perGiorno, perMese, formati, perUnita, paesi] = await Promise.all([
			elenco('apps'),
			elenco('adUnits'),
			report(['DATE', 'APP'], ['ESTIMATED_EARNINGS', 'IMPRESSIONS'], giorno(giorni[0])),
			// il mese in corso arriva fino a oggi: AdMob lo da' gia' parziale
			report(['MONTH', 'APP'], ['ESTIMATED_EARNINGS'], { year: y0, month: m0, day: 1 }),
			report(['APP', 'FORMAT'], tutte, da30),
			report(['AD_UNIT'], tutte, da30),
			report(['COUNTRY'], ['ESTIMATED_EARNINGS', 'IMPRESSIONS'], da30),
		]);
		return {
			publisher,
			app: app.map(a => ({
				appId: String(a.appId),
				piattaforma: String(a.platform ?? ''),
				nome: String(a.linkedAppInfo?.displayName || a.manualAppInfo?.displayName || a.appId),
				store: a.linkedAppInfo?.appStoreId ? String(a.linkedAppInfo.appStoreId) : undefined,
				approvazione: a.appApprovalState ? String(a.appApprovalState) : undefined,
			})),
			unita: unita.map(u => ({ id: String(u.adUnitId), appId: String(u.appId), nome: String(u.displayName ?? ''), formato: String(u.adFormat ?? '') })),
			giorni: perGiorno,
			mesi: perMese,
			formati,
			perUnita,
			paesi,
		};
	}

	// --- cambi ---

	private async cambi(): Promise<void> {
		const c = this.cache.cambi;
		if (c && this.now() - c.at < CAMBI_TTL) return;
		const res = await this.fetch('https://open.er-api.com/v6/latest/EUR', { signal: AbortSignal.timeout(TIMEOUT) });
		const j: any = await res.json().catch(() => null);
		if (!res.ok || j?.result !== 'success' || !j?.rates) {
			if (c) return; // si tengono gli ultimi cambi buoni
			throw new Error(`risposta ${res.status}`);
		}
		this.cache.cambi = { at: this.now(), rates: j.rates };
	}
}

/** Una serie salvata su un asse di date vecchio, spostata sul nuovo (gli assi scorrono di un giorno al giorno). */
function riallinea(vecchieDate: string[], valori: number[], nuoveDate: string[]): number[] {
	const m = new Map(vecchieDate.map((d, i) => [d, valori[i] ?? 0]));
	return nuoveDate.map(d => m.get(d) ?? 0);
}

function msg(e: unknown, chi: string): string {
	const m = e instanceof Error ? e.message : String(e);
	if (/abort|timeout/i.test(m)) return `${chi} non risponde (tempo scaduto).`;
	if (/^(App Store|AdMob|Manca|Il permesso|Il servizio)/.test(m)) return m;
	return `${chi}: ${m.slice(0, 160)}`;
}
