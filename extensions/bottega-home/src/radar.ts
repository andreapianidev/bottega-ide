/* Il radar: le app su App Store Connect (versione in lavorazione, stato, recensioni) e i soldi di
   AdMob (ieri e ultimi sette giorni), collegati ai progetti tramite PRODUCT_BUNDLE_IDENTIFIER.

   - App Store Connect: API REST con un JWT ES256 firmato da node:crypto (20 minuti di vita), chiave
     e identificativi da ~/.secrets/appstoreconnect-api.env. Una lettura costa una chiamata per
     l'elenco delle app (con le versioni incluse), una per la build di ogni versione in lavorazione
     e una per le recensioni di ogni app mostrata, al massimo quattro insieme.
   - AdMob: le credenziali del server MCP in ~/admob-mcp/secrets. Il token di accesso si rinfresca
     in memoria: token.json di admob-mcp non si riscrive mai.
   - Tutto finisce in ~/.bottega/radar/stato.json (cartella 700, file 600): senza rete si mostra
     l'ultimo dato con la sua eta' (ascAt, admobAt). Tra due letture passano almeno 45 minuti.
   - I siti su Vercel (src/vercel.ts) viaggiano con il radar: stessa cartella, stessa spinta (refresh), ognuno con
     la sua cadenza, e arrivano alla plancia in RadarState.vercel.
   I bundle id sono identificatori tecnici: servono a collegare, il nome mostrato viene da ASC.
   Contratto verso la plancia: docs/CONTRATTI.md, sezione 4.1. */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Project } from './scan';
import { Vercel } from './vercel';

import type { RadarApp, RadarState } from './tipi';

export type { RadarApp, RadarState };

export interface RadarOptions {
	dir?: string;
	log?: (s: string) => void;
	fetch?: typeof fetch;
	now?: () => number;
	ascEnvFile?: string;
	admobDir?: string;
	/** Il lettore dei siti su Vercel. Di default ce n'e' uno vero, salvo con dir o fetch finti (le prove). */
	vercel?: Vercel | false;
}

type Money = NonNullable<RadarApp['money']>;

const ASC = 'https://api.appstoreconnect.apple.com/v1';
const ADMOB = 'https://admob.googleapis.com/v1';
const MIN_GAP = 45 * 60_000;
const TIMEOUT = 20_000;
const PARALLEL = 4;
const REVIEWS_MAX_APPS = 40;
const SCHEMA = 1;

/** Stati in cui una versione si puo' ancora mettere in rilascio automatico: la regola "rilascio"
 *  scatta qui se releaseType non e' AFTER_APPROVAL. Le rifiutate tornano in revisione. */
export const STATI_RILASCIO = new Set([
	'PREPARE_FOR_SUBMISSION',
	'READY_FOR_REVIEW',
	'WAITING_FOR_REVIEW',
	'IN_REVIEW',
	'WAITING_FOR_EXPORT_COMPLIANCE',
	'REJECTED',
	'METADATA_REJECTED',
	'DEVELOPER_REJECTED',
	'INVALID_BINARY',
]);

/** Versioni chiuse: pubblicate, sostituite o tolte. Tutto il resto e' "in lavorazione". */
const CHIUSE = new Set(['READY_FOR_SALE', 'REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE', 'DEVELOPER_REMOVED_FROM_SALE', 'PREORDER_READY_FOR_SALE', 'NOT_APPLICABLE']);

const ETICHETTE: Record<string, [string, 'ok' | 'attesa' | 'male']> = {
	PREPARE_FOR_SUBMISSION: ['in preparazione', 'attesa'],
	READY_FOR_REVIEW: ['pronta per la revisione', 'attesa'],
	WAITING_FOR_REVIEW: ['in attesa di revisione', 'attesa'],
	IN_REVIEW: ['in revisione', 'attesa'],
	WAITING_FOR_EXPORT_COMPLIANCE: ["in attesa della conformità all'esportazione", 'attesa'],
	PENDING_DEVELOPER_RELEASE: ['approvata, in attesa di rilascio', 'attesa'],
	PENDING_APPLE_RELEASE: ['approvata, la rilascia Apple', 'attesa'],
	PROCESSING_FOR_APP_STORE: ['in elaborazione per lo Store', 'attesa'],
	PENDING_CONTRACT: ['in attesa del contratto', 'male'],
	ACCEPTED: ['approvata', 'ok'],
	READY_FOR_SALE: ['pubblicata', 'ok'],
	PREORDER_READY_FOR_SALE: ['in preordine', 'ok'],
	REPLACED_WITH_NEW_VERSION: ['sostituita', 'ok'],
	REJECTED: ['rifiutata', 'male'],
	METADATA_REJECTED: ['metadati rifiutati', 'male'],
	DEVELOPER_REJECTED: ['ritirata dalla revisione', 'attesa'],
	INVALID_BINARY: ['binario non valido', 'male'],
	REMOVED_FROM_SALE: ['tolta dalla vendita', 'male'],
	DEVELOPER_REMOVED_FROM_SALE: ['tolta dalla vendita', 'male'],
};

/** appVersionState (il campo nuovo) riportato agli stati di appStoreState. */
const DA_VERSION_STATE: Record<string, string> = {
	READY_FOR_DISTRIBUTION: 'READY_FOR_SALE',
	PROCESSING_FOR_DISTRIBUTION: 'PROCESSING_FOR_APP_STORE',
};

export function stateLabel(state: string): { label: string; tone: 'ok' | 'attesa' | 'male' } {
	const e = ETICHETTE[state];
	return e ? { label: e[0], tone: e[1] } : { label: state.toLowerCase().replace(/_/g, ' '), tone: 'attesa' };
}

// ---------- utilita' ----------

/** Legge un file KEY=valore (con o senza export e virgolette); espande ~ e $HOME. */
export function readEnvFile(file: string): Record<string, string> {
	const out: Record<string, string> = {};
	let text = '';
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return out;
	}
	for (const raw of text.split('\n')) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
		if (!m) continue;
		let v = m[2].trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
		else v = v.replace(/\s+#.*$/, '');
		v = v.replace(/^~(?=\/)/, os.homedir()).replace(/\$\{?HOME\}?/g, os.homedir());
		out[m[1]] = v;
	}
	return out;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** JWT ES256 per App Store Connect, firmato con node:crypto. */
export function ascToken(keyId: string, issuerId: string, privateKeyPem: string, nowMs: number): string {
	const iat = Math.floor(nowMs / 1000);
	const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
	const payload = b64url(JSON.stringify({ iss: issuerId, iat, exp: iat + 20 * 60, aud: 'appstoreconnect-v1' }));
	const data = `${header}.${payload}`;
	const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' });
	return `${data}.${b64url(sig)}`;
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (i < items.length) {
				const k = i++;
				out[k] = await fn(items[k]);
			}
		}),
	);
	return out;
}

class HttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function ymd(d: Date) {
	return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}
function ymdKey(d: Date) {
	return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** I bundle id di un progetto Xcode (tutti i bersagli), senza quelli con variabili $(...). */
const bundleCache = new Map<string, { mtime: number; ids: string[] }>();
export function projectBundleIds(p: Pick<Project, 'xcodeProject'>): string[] {
	if (!p.xcodeProject) return [];
	const projs = p.xcodeProject.endsWith('.xcworkspace')
		? (() => {
				try {
					return fs.readdirSync(path.dirname(p.xcodeProject!)).filter(e => e.endsWith('.xcodeproj')).map(e => path.join(path.dirname(p.xcodeProject!), e));
				} catch {
					return [];
				}
			})()
		: [p.xcodeProject];
	const ids = new Set<string>();
	for (const proj of projs) {
		const f = path.join(proj, 'project.pbxproj');
		let mtime = 0;
		try {
			mtime = fs.statSync(f).mtimeMs;
		} catch {
			continue;
		}
		let hit = bundleCache.get(f);
		if (!hit || hit.mtime !== mtime) {
			const found: string[] = [];
			try {
				const pbx = fs.readFileSync(f, 'utf8');
				for (const m of pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)) {
					const v = m[1].trim().replace(/^"|"$/g, '');
					if (v && !v.includes('$')) found.push(v);
				}
			} catch {
				// pbxproj illeggibile
			}
			hit = { mtime, ids: [...new Set(found)] };
			bundleCache.set(f, hit);
		}
		hit.ids.forEach(id => ids.add(id));
	}
	// il piu' corto prima: di solito e' l'app, gli altri sono estensioni, widget e test
	return [...ids].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

// ---------- il radar ----------

interface CacheFile {
	schema: number;
	state: Omit<RadarState, 'refreshing'>;
	money: Record<string, Money>; // chiave: Apple ID
	triedAt: number;
}

interface AscVersion {
	id: string;
	platform?: string;
	string: string;
	state: string;
	releaseType?: string;
	at: number;
}

export class Radar {
	private readonly dir: string;
	private readonly file: string;
	private readonly fetch: typeof fetch;
	private readonly now: () => number;
	private readonly ascEnvFile: string;
	private readonly admobDir: string;
	private cache: CacheFile;
	private running: Promise<RadarState> | undefined;
	private listeners: ((s: RadarState) => void)[] = [];
	private jwt: { token: string; exp: number } | undefined;
	private google: { token: string; exp: number } | undefined;
	private publisher: string | undefined;
	readonly vercel: Vercel | null;

	constructor(private readonly opts: RadarOptions = {}) {
		this.dir = opts.dir ?? path.join(os.homedir(), '.bottega', 'radar');
		this.file = path.join(this.dir, 'stato.json');
		this.fetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
		this.now = opts.now ?? Date.now;
		this.ascEnvFile = opts.ascEnvFile ?? path.join(os.homedir(), '.secrets', 'appstoreconnect-api.env');
		this.admobDir = opts.admobDir ?? path.join(os.homedir(), 'admob-mcp');
		this.cache = this.load();
		this.vercel = opts.vercel === false ? null : (opts.vercel ?? (opts.dir || opts.fetch ? null : new Vercel({ dir: this.dir, log: opts.log })));
		this.vercel?.onChange(() => this.emit());
	}

	state(): RadarState {
		const s: RadarState = { ...this.cache.state, refreshing: !!this.running };
		if (this.vercel) s.vercel = this.vercel.state();
		return s;
	}

	onChange(cb: (s: RadarState) => void): void {
		this.listeners.push(cb);
	}

	private emit() {
		const s = this.state();
		for (const cb of this.listeners) {
			try {
				cb(s);
			} catch (e) {
				this.log('radar: ' + (e as Error).message);
			}
		}
	}

	private log(s: string) {
		this.opts.log?.(s);
	}

	private load(): CacheFile {
		try {
			const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			if (raw?.schema === SCHEMA && raw.state) return raw;
		} catch {
			// prima volta, o file rovinato
		}
		return { schema: SCHEMA, state: { apps: [], totals: null, ascAt: 0, admobAt: 0 }, money: {}, triedAt: 0 };
	}

	private save() {
		try {
			fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			fs.chmodSync(this.dir, 0o700);
			const tmp = this.file + '.tmp';
			fs.writeFileSync(tmp, JSON.stringify(this.cache), { mode: 0o600 });
			fs.renameSync(tmp, this.file);
			fs.chmodSync(this.file, 0o600);
		} catch (e) {
			this.log('radar: non riesco a salvare lo stato: ' + (e as Error).message);
		}
	}

	/** Una lettura alla volta; tra due letture almeno 45 minuti, salvo force. */
	refresh(projects: Project[], opts: { force?: boolean } = {}): Promise<RadarState> {
		// Vercel ha la sua cadenza (bottega.vercel.ogniMinuti) e si limita da solo
		if (this.vercel) void this.vercel.refresh(projects, opts);
		if (this.running) return this.running;
		if (!opts.force && this.now() - this.cache.triedAt < MIN_GAP) return Promise.resolve(this.state());
		this.running = this.run(projects)
			.finally(() => {
				this.running = undefined;
				this.emit();
			})
			.then(() => this.state());
		this.emit();
		return this.running;
	}

	private async run(projects: Project[]): Promise<RadarState> {
		this.cache.triedAt = this.now();
		const [asc, admob] = await Promise.allSettled([this.readAsc(projects), this.readAdmob()]);
		const st = this.cache.state;
		if (admob.status === 'fulfilled') {
			this.cache.money = admob.value.perApp;
			st.totals = admob.value.totals;
			st.admobAt = this.now();
			delete st.admobError;
		} else {
			st.admobError = this.message(admob.reason, 'AdMob');
			this.log('radar: ' + st.admobError);
		}
		if (asc.status === 'fulfilled') {
			st.apps = asc.value;
			st.ascAt = this.now();
			delete st.ascError;
		} else {
			st.ascError = this.message(asc.reason, 'App Store Connect');
			this.log('radar: ' + st.ascError);
			// i collegamenti ai progetti si rifanno anche senza rete
			const links = this.links(projects, st.apps.map(a => a.bundleId));
			for (const a of st.apps) a.projectPath = links.get(a.bundleId);
		}
		for (const a of st.apps) {
			const m = this.cache.money[a.ascId];
			if (m) a.money = m;
			else delete a.money;
		}
		this.save();
		return this.state();
	}

	private message(e: unknown, who: string): string {
		if (e instanceof HttpError || (e instanceof Error && /^(Mancano|Manca|Il permesso|AdMob|App Store)/.test(e.message))) return e.message;
		const m = e instanceof Error ? e.message : String(e);
		if (/abort|timeout/i.test(m)) return `${who} non risponde (tempo scaduto).`;
		return `${who} non risponde: ${m.slice(0, 120)}`;
	}

	// ---------- App Store Connect ----------

	private ascJwt(): string {
		const now = this.now();
		if (this.jwt && this.jwt.exp - now > 60_000) return this.jwt.token;
		const env = readEnvFile(this.ascEnvFile);
		const keyId = env.ASC_KEY_ID;
		const issuer = env.ASC_ISSUER_ID;
		const keyPath = env.ASC_PRIVATE_KEY_PATH;
		if (!keyId || !issuer || !keyPath) throw new Error(`Mancano le credenziali di App Store Connect in ${this.ascEnvFile.replace(os.homedir(), '~')}.`);
		let pem: string;
		try {
			pem = fs.readFileSync(keyPath, 'utf8');
		} catch {
			throw new Error('Manca il file della chiave di App Store Connect indicato in ASC_PRIVATE_KEY_PATH.');
		}
		const token = ascToken(keyId, issuer, pem, now);
		this.jwt = { token, exp: now + 15 * 60_000 };
		return token;
	}

	private async asc(method: string, pathAndQuery: string, body?: unknown): Promise<any> {
		const url = pathAndQuery.startsWith('http') ? pathAndQuery : ASC + pathAndQuery;
		const res = await this.fetch(url, {
			method,
			headers: { Authorization: `Bearer ${this.ascJwt()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(TIMEOUT),
		});
		if (!res.ok) {
			let detail = '';
			try {
				const j: any = await res.json();
				detail = String(j?.errors?.[0]?.detail || j?.errors?.[0]?.title || '').slice(0, 160);
			} catch {
				// corpo non JSON
			}
			if (res.status === 401) throw new HttpError(401, 'App Store Connect ha rifiutato la chiave (401): controlla ASC_KEY_ID e ASC_ISSUER_ID.');
			if (res.status === 403) throw new HttpError(403, 'La chiave di App Store Connect non ha i permessi per questa operazione (403).');
			if (res.status === 429) throw new HttpError(429, 'App Store Connect chiede di rallentare (429): riprovo alla prossima lettura.');
			throw new HttpError(res.status, `App Store Connect ha risposto ${res.status}${detail ? ': ' + detail : ''}.`);
		}
		return res.status === 204 ? null : res.json();
	}

	private async listAscApps(): Promise<{ id: string; name: string; bundleId: string; versions: AscVersion[] }[]> {
		const out: { id: string; name: string; bundleId: string; versions: AscVersion[] }[] = [];
		let next: string | undefined =
			'/apps?limit=200&fields[apps]=name,bundleId,appStoreVersions&include=appStoreVersions&limit[appStoreVersions]=50' +
			'&fields[appStoreVersions]=platform,versionString,appStoreState,appVersionState,releaseType,createdDate';
		for (let page = 0; next && page < 5; page++) {
			const j = await this.asc('GET', next);
			const versions = new Map<string, AscVersion>();
			for (const inc of j?.included ?? []) {
				if (inc.type !== 'appStoreVersions') continue;
				versions.set(inc.id, parseVersion(inc));
			}
			for (const a of j?.data ?? []) {
				const vs = (a.relationships?.appStoreVersions?.data ?? []).map((r: any) => versions.get(r.id)).filter(Boolean) as AscVersion[];
				out.push({ id: String(a.id), name: String(a.attributes?.name ?? ''), bundleId: String(a.attributes?.bundleId ?? ''), versions: vs });
			}
			next = j?.links?.next;
		}
		return out;
	}

	/** Progetto per ogni bundle id: il primo progetto (gia' in ordine di recenza) che lo dichiara. */
	private links(projects: Project[], appBundleIds: string[]): Map<string, string> {
		const wanted = new Set(appBundleIds);
		const out = new Map<string, string>();
		for (const p of projects) {
			for (const id of projectBundleIds(p)) {
				if (wanted.has(id) && !out.has(id)) out.set(id, p.path);
			}
		}
		return out;
	}

	private async readAsc(projects: Project[]): Promise<RadarApp[]> {
		const all = await this.listAscApps();
		const links = this.links(projects, all.map(a => a.bundleId));
		// Una sola app per progetto: se piu' app corrispondono, vince il bundle id piu' corto.
		const byProject = new Map<string, string>();
		for (const a of [...all].sort((x, y) => x.bundleId.length - y.bundleId.length)) {
			const p = links.get(a.bundleId);
			if (p && !byProject.has(p)) byProject.set(p, a.id);
		}
		const apps: { app: RadarApp; current?: AscVersion }[] = [];
		for (const a of all) {
			const vs = [...a.versions].sort((x, y) => y.at - x.at);
			const ios = vs.filter(v => !v.platform || v.platform === 'IOS');
			const pick = ios.length ? ios : vs;
			const working = pick.find(v => !CHIUSE.has(v.state));
			const live = pick.find(v => v.state === 'READY_FOR_SALE');
			const current = working ?? pick[0];
			const projectPath = links.get(a.bundleId);
			const linked = !!projectPath && byProject.get(projectPath) === a.id;
			// si mostrano le app collegate, quelle in lavorazione, quelle pubblicate e quelle che guadagnano
			if (!linked && !working && !live && !this.cache.money[a.id]) continue;
			const app: RadarApp = { ascId: a.id, bundleId: a.bundleId, name: a.name, reviews: [] };
			if (linked) app.projectPath = projectPath;
			if (current) {
				const { label, tone } = stateLabel(current.state);
				app.version = { string: current.string, state: current.state, label, tone, releaseType: current.releaseType, at: current.at || undefined };
			}
			if (live) app.live = live.string;
			apps.push({ app, current });
		}

		// build delle versioni in lavorazione, recensioni delle app mostrate: al massimo 4 chiamate insieme
		const tasks: (() => Promise<void>)[] = [];
		for (const { app, current } of apps) {
			if (current && !CHIUSE.has(current.state)) {
				tasks.push(async () => {
					try {
						const j = await this.asc('GET', `/appStoreVersions/${current.id}/build?fields[builds]=version`);
						const v = j?.data?.attributes?.version;
						if (v) app.version!.build = String(v);
					} catch (e) {
						if (!(e instanceof HttpError && e.status === 404)) throw e;
					}
				});
			}
		}
		const forReviews = [...apps]
			.sort((x, y) => Number(!!y.app.projectPath) - Number(!!x.app.projectPath) || Number(!!y.app.live) - Number(!!x.app.live))
			.slice(0, REVIEWS_MAX_APPS);
		for (const { app } of forReviews) {
			tasks.push(async () => {
				const j = await this.asc(
					'GET',
					`/apps/${app.ascId}/customerReviews?sort=-createdDate&limit=5&fields[customerReviews]=rating,title,body,createdDate,territory`,
				);
				app.reviews = (j?.data ?? []).map((r: any) => ({
					stars: Number(r.attributes?.rating) || 0,
					title: String(r.attributes?.title ?? ''),
					body: String(r.attributes?.body ?? '').slice(0, 600),
					territory: r.attributes?.territory || undefined,
					at: Date.parse(r.attributes?.createdDate) || 0,
				}));
			});
		}
		await pool(tasks, PARALLEL, t => t());
		return apps.map(x => x.app).sort((a, b) => Number(!!b.projectPath) - Number(!!a.projectPath) || a.name.localeCompare(b.name));
	}

	/** Mette in rilascio automatico la versione in lavorazione dell'app collegata al progetto.
	 *  Torna una frase da mostrare; lancia un errore (con un messaggio in italiano) se non riesce. */
	async setAutomaticRelease(projectPath: string): Promise<string> {
		const app = this.cache.state.apps.find(a => a.projectPath === projectPath);
		if (!app) throw new Error('Questo progetto non è collegato a nessuna app su App Store Connect.');
		const j = await this.asc(
			'GET',
			`/apps/${app.ascId}/appStoreVersions?limit=20&fields[appStoreVersions]=platform,versionString,appStoreState,appVersionState,releaseType,createdDate`,
		);
		const vs = ((j?.data ?? []) as any[]).map(parseVersion).sort((a, b) => b.at - a.at);
		const v = vs.find(x => STATI_RILASCIO.has(x.state));
		if (!v) throw new Error(`${app.name} non ha una versione in lavorazione da mettere in rilascio automatico.`);
		if (v.releaseType !== 'AFTER_APPROVAL') {
			const attributes: Record<string, unknown> = { releaseType: 'AFTER_APPROVAL' };
			if (v.releaseType === 'SCHEDULED') attributes.earliestReleaseDate = null;
			await this.asc('PATCH', `/appStoreVersions/${v.id}`, { data: { type: 'appStoreVersions', id: v.id, attributes } });
		}
		if (app.version && app.version.string === v.string) app.version.releaseType = 'AFTER_APPROVAL';
		this.save();
		this.emit();
		return v.releaseType === 'AFTER_APPROVAL'
			? `La versione ${v.string} di ${app.name} era già in rilascio automatico.`
			: `La versione ${v.string} di ${app.name} uscirà da sola appena approvata.`;
	}

	// ---------- AdMob ----------

	private async googleToken(): Promise<string> {
		const now = this.now();
		if (this.google && this.google.exp - now > 60_000) return this.google.token;
		const secrets = path.join(this.admobDir, 'secrets');
		let tok: any, cli: any;
		try {
			tok = JSON.parse(fs.readFileSync(path.join(secrets, 'token.json'), 'utf8'));
		} catch {
			throw new Error('AdMob non è collegato: manca token.json in ~/admob-mcp/secrets.');
		}
		if (tok?.access_token && tok.expiry_date && tok.expiry_date - now > 120_000) {
			this.google = { token: tok.access_token, exp: tok.expiry_date };
			return tok.access_token;
		}
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(secrets, 'client_secret.json'), 'utf8'));
			cli = raw.installed || raw.web;
		} catch {
			cli = undefined;
		}
		if (!cli?.client_id || !cli?.client_secret || !tok?.refresh_token) throw new Error('AdMob non è collegato: mancano le credenziali in ~/admob-mcp/secrets.');
		const res = await this.fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ client_id: cli.client_id, client_secret: cli.client_secret, refresh_token: tok.refresh_token, grant_type: 'refresh_token' }).toString(),
			signal: AbortSignal.timeout(TIMEOUT),
		});
		const j: any = await res.json().catch(() => ({}));
		if (!res.ok || !j.access_token) {
			if (j?.error === 'invalid_grant') throw new Error("Il permesso di AdMob è scaduto: rifai l'autorizzazione con ./setup.sh --reauth in ~/admob-mcp.");
			throw new Error(`AdMob: il rinnovo del permesso non è riuscito (${res.status}).`);
		}
		this.google = { token: j.access_token, exp: now + (Number(j.expires_in) || 3600) * 1000 };
		return j.access_token;
	}

	private async admob(method: string, p: string, body?: unknown): Promise<any> {
		const res = await this.fetch(ADMOB + p, {
			method,
			headers: { Authorization: `Bearer ${await this.googleToken()}`, 'Content-Type': 'application/json' },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(TIMEOUT),
		});
		if (!res.ok) {
			if (res.status === 401) {
				this.google = undefined;
				throw new HttpError(401, "AdMob ha rifiutato il permesso (401): rifai l'autorizzazione con ./setup.sh --reauth in ~/admob-mcp.");
			}
			throw new HttpError(res.status, `AdMob ha risposto ${res.status}.`);
		}
		return res.json();
	}

	private async readAdmob(): Promise<{ perApp: Record<string, Money>; totals: RadarState['totals'] }> {
		if (!this.publisher) {
			const acc = await this.admob('GET', '/accounts');
			const name = acc?.account?.[0]?.name;
			if (!name) throw new Error('AdMob: nessun account collegato a queste credenziali.');
			this.publisher = String(name);
		}
		// app AdMob -> Apple ID
		const toApple = new Map<string, string>();
		let pageToken = '';
		for (let page = 0; page < 5; page++) {
			const j = await this.admob('GET', `/${this.publisher}/apps?pageSize=500${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
			for (const a of j?.apps ?? []) {
				const store = a?.linkedAppInfo?.appStoreId;
				if (a?.appId && store && (a.platform === 'IOS' || /^\d+$/.test(store))) toApple.set(String(a.appId), String(store));
			}
			pageToken = j?.nextPageToken || '';
			if (!pageToken) break;
		}
		// i sette giorni fino a ieri, dal piu' vecchio
		const days: Date[] = [];
		const today = new Date(this.now());
		for (let k = 7; k >= 1; k--) days.push(new Date(today.getFullYear(), today.getMonth(), today.getDate() - k));
		const idx = new Map(days.map((d, i) => [ymdKey(d), i]));
		const rep = await this.admob('POST', `/${this.publisher}/networkReport:generate`, {
			reportSpec: {
				dateRange: { startDate: ymd(days[0]), endDate: ymd(days[6]) },
				dimensions: ['DATE', 'APP'],
				metrics: ['ESTIMATED_EARNINGS'],
			},
		});
		const parts = Array.isArray(rep) ? rep : [rep];
		let currency = 'USD';
		const total = new Array(7).fill(0);
		const per = new Map<string, number[]>();
		for (const item of parts) {
			const c = item?.header?.localizationSettings?.currencyCode;
			if (c) currency = String(c);
			const row = item?.row;
			if (!row) continue;
			const date = row.dimensionValues?.DATE?.value;
			const i = idx.get(String(date));
			if (i === undefined) continue;
			const mv = row.metricValues?.ESTIMATED_EARNINGS;
			const v = Number(mv?.microsValue ?? 0) / 1e6 || Number(mv?.doubleValue ?? 0) || 0;
			total[i] += v;
			const apple = toApple.get(String(row.dimensionValues?.APP?.value ?? ''));
			if (apple) {
				const arr = per.get(apple) ?? new Array(7).fill(0);
				arr[i] += v;
				per.set(apple, arr);
			}
		}
		const money = (d: number[]): Money => {
			const daily = d.map(round2);
			return { yesterday: daily[6], last7: round2(d.reduce((s, x) => s + x, 0)), daily, currency };
		};
		const perApp: Record<string, Money> = {};
		for (const [k, d] of per) perApp[k] = money(d);
		return { perApp, totals: money(total) };
	}
}

function parseVersion(v: any): AscVersion {
	const a = v?.attributes ?? {};
	const state = String(a.appStoreState || DA_VERSION_STATE[a.appVersionState] || a.appVersionState || 'NOT_APPLICABLE');
	return {
		id: String(v.id),
		platform: a.platform || undefined,
		string: String(a.versionString ?? ''),
		state,
		releaseType: a.releaseType || undefined,
		at: Date.parse(a.createdDate) || 0,
	};
}
