/* I siti su Vercel nella Vedetta: l'ultima pubblicazione di produzione di ogni progetto collegato (pronta, in
   costruzione, fallita, annullata), quando, il dominio, il commit, e se e' fallita quale resta online.

   - Nessuna chiave nuova: passa dalla CLI di Vercel gia' collegata da Andrea (`vercel api`, che firma da sola le
     richieste con il suo accesso). Il token non passa mai da qui: niente lettura di auth.json, niente --token.
   - Solo lettura, con un elenco chiuso (`comandoAmmesso`): whoami, ls, inspect, project ls e `api` in GET su
     /deployments, /projects e /user. Tutto il resto (deploy, rm, env, promote, rollback, alias...) viene rifiutato
     prima ancora di lanciare un processo.
   - Collegamento ai progetti: `.vercel/project.json` (projectId, orgId) nella cartella o in una sottocartella,
     `.vercel/repo.json` (monorepo); in mancanza il repository GitHub del remoto origin o il nome (cartella,
     vercel.json, package.json) uguale al nome del progetto su Vercel.
   - Costo: una chiamata per team (le ultime 100 pubblicazioni di produzione, fino a 3 pagine), poi solo per i
     progetti che non ci sono (una volta, finche' non ne esce una nuova) e per i dettagli delle pubblicazioni nuove
     (dominio, errore). Sempre con `nice`, con un tempo massimo, al massimo due processi insieme, al massimo ogni
     `bottega.vercel.ogniMinuti` minuti (default 30).
   - Cache in ~/.bottega/radar/vercel.json (cartella 700, file 600): senza rete si mostra l'ultimo dato con la sua
     eta'. Dentro ci sono solo stati, date, domini e messaggi di commit: le variabili d'ambiente che l'API manda
     insieme ai dettagli restano in memoria il tempo di leggerne il dominio.
   Contratto verso la plancia: docs/CONTRATTI.md, sezione 4.1 (RadarState.vercel). */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Project } from './scan';
import type { RuleHit, VercelSito, VercelState } from './tipi';

export type { VercelSito, VercelState };

/** Una regola del semaforo nata da Vercel: tipi.ts la conta tra le RuleHit quando `'vercel'` entra nell'id. */
export type VercelHit = Omit<RuleHit, 'id'> & { id: 'vercel' };

export type Esegui = (args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string; code: number; timedOut?: boolean }>;

export interface VercelOptions {
	dir?: string;
	log?: (s: string) => void;
	now?: () => number;
	/** Chi lancia la CLI (le prove ne passano uno finto). */
	esegui?: Esegui;
	/** Minuti tra due letture; default `bottega.vercel.ogniMinuti`, o 30. */
	ogniMinuti?: () => number;
}

const SCHEMA = 1;
const TIMEOUT = 30_000;
const PARALLEL = 2;
const MAX_PAGINE = 3;
const MAX_SINGOLI = 16;
const MAX_DETTAGLI = 16;
const MIN_FORZATA = 60_000;
const DEFAULT_MINUTI = 30;

// ---------- sola lettura: l'elenco chiuso ----------

const SOTTOCOMANDI = new Set(['whoami', 'ls', 'list', 'inspect', 'project', 'projects', 'api']);
/** Opzioni ammesse; true = vuole un valore. */
const OPZIONI: Record<string, boolean> = {
	'--format': true,
	'--json': false,
	'--limit': true,
	'--environment': true,
	'--scope': true,
	'--next': true,
	'-X': true,
	'--method': true,
	'--raw': false,
	'--non-interactive': false,
	'--no-color': false,
};
const ENDPOINT = /^\/v\d{1,2}\/(deployments|projects|user)(\/[A-Za-z0-9_.-]{1,80})?(\?[A-Za-z0-9_.=&%-]*)?$/;

/** Vero solo per i comandi di sola lettura dell'elenco chiuso. Ogni altra cosa si rifiuta. */
export function comandoAmmesso(args: string[]): boolean {
	if (!args.length || !SOTTOCOMANDI.has(args[0])) return false;
	const pos: string[] = [];
	let metodo: string | undefined;
	let i = 1;
	if (args[0] === 'project' || args[0] === 'projects') {
		if (args[1] !== 'ls' && args[1] !== 'list') return false;
		i = 2;
	}
	for (; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith('-')) {
			const [nome, uguale] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
			if (!(nome in OPZIONI)) return false;
			let valore = uguale;
			if (OPZIONI[nome] && valore === undefined) valore = args[++i];
			if (OPZIONI[nome] && (valore === undefined || valore.startsWith('-'))) return false;
			if (nome === '-X' || nome === '--method') metodo = String(valore).toUpperCase();
			if (nome === '--format' && valore !== 'json') return false;
			continue;
		}
		pos.push(a);
	}
	switch (args[0]) {
		case 'whoami':
		case 'project':
		case 'projects':
			return pos.length === 0 && !metodo;
		case 'ls':
		case 'list':
			return pos.length <= 1 && pos.every(p => /^[A-Za-z0-9._-]{1,100}$/.test(p)) && !metodo;
		case 'inspect':
			return pos.length === 1 && /^[A-Za-z0-9._:/-]{1,200}$/.test(pos[0]) && !metodo;
		case 'api':
			// il metodo va detto, e solo GET: senza, la CLI farebbe POST appena vede un corpo
			return pos.length === 1 && ENDPOINT.test(pos[0]) && metodo === 'GET';
	}
	return false;
}

// ---------- la CLI ----------

function trovaCli(): string | undefined {
	const dirs = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.npm-global', 'bin'), path.join(os.homedir(), '.bun', 'bin'), ...(process.env.PATH ?? '').split(':')];
	for (const d of dirs) {
		if (!d) continue;
		const f = path.join(d, 'vercel');
		try {
			fs.accessSync(f, fs.constants.X_OK);
			return f;
		} catch {
			// non qui
		}
	}
	return undefined;
}

class CliError extends Error {}

function eseguiVero(cwd: string): Esegui {
	return (args, timeoutMs) =>
		new Promise((resolve, reject) => {
			const cli = trovaCli();
			try {
				fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
			} catch {
				// se non si crea, execFile lo dira'
			}
			if (!cli) return reject(new CliError('La CLI di Vercel non è installata (npm i -g vercel, poi vercel login).'));
			// node deve stare nel PATH: lo script della CLI parte con #!/usr/bin/env node
			const env = {
				...process.env,
				PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}`,
				VERCEL_TELEMETRY_DISABLED: '1',
				NO_UPDATE_NOTIFIER: '1',
				FORCE_COLOR: '0',
			};
			execFile('/usr/bin/nice', ['-n', '10', cli, ...args], { cwd, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
				const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
				resolve({
					stdout: String(stdout ?? ''),
					stderr: String(stderr ?? ''),
					code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
					timedOut: !!e && (e.killed === true || e.signal === 'SIGTERM'),
				});
			});
		});
}

/** Le righe utili dell'errore della CLI, senza avvisi di node e senza nulla che somigli a una chiave. */
function pulisci(s: string): string {
	return s
		.split('\n')
		.map(l => l.trim())
		.filter(l => l && !/claude-code-hint|ExperimentalWarning|trace-warnings|^Vercel CLI \d/.test(l))
		.join(' ')
		.replace(/[A-Za-z0-9_-]{24,}/g, '[...]')
		.slice(0, 160);
}

export function messaggioErrore(out: { stdout: string; stderr: string; timedOut?: boolean }): string {
	if (out.timedOut) return 'Vercel non risponde (tempo scaduto).';
	const t = pulisci(out.stderr + '\n' + out.stdout);
	if (/not logged in|no existing credentials|vercel login|please log ?in|token is not valid|invalid token|expired/i.test(t))
		return 'La CLI di Vercel non è collegata: lancia vercel login nel Terminale.';
	if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed|network/i.test(t)) return 'Vercel non risponde: niente rete.';
	if (/\b429\b|rate.?limit|too many requests/i.test(t)) return 'Vercel chiede di rallentare (429): riprovo alla prossima lettura.';
	if (/\b403\b|forbidden|not authorized|no access/i.test(t)) return 'La CLI di Vercel non ha accesso a questo team (403).';
	if (/unknown command|not a valid command|did you mean/i.test(t)) return 'Questa CLI di Vercel non ha il comando api: aggiornala con npm i -g vercel.';
	return t ? `Vercel ha risposto con un errore: ${t.slice(0, 120)}` : 'Vercel ha risposto con un errore senza spiegazioni.';
}

// ---------- forma dei dati ----------

const ETICHETTE: Record<string, [string, VercelSito['tone']]> = {
	READY: ['pubblicata', 'ok'],
	ERROR: ['fallita', 'male'],
	BUILDING: ['in costruzione', 'attesa'],
	INITIALIZING: ['in costruzione', 'attesa'],
	QUEUED: ['in coda', 'attesa'],
	CANCELED: ['annullata', 'attesa'],
};

export function statoVercel(state: string): { label: string; tone: VercelSito['tone'] } {
	const e = ETICHETTE[state];
	return e ? { label: e[0], tone: e[1] } : { label: state.toLowerCase().replace(/_/g, ' '), tone: 'attesa' };
}

/** Una pubblicazione, con solo quello che serve (niente variabili d'ambiente, niente creator). */
export interface Pubblicazione {
	uid: string;
	projectId: string;
	name: string;
	state: string;
	at: number;
	readyAt?: number;
	host?: string;
	inspector?: string;
	commit?: { sha: string; message: string; ref?: string };
	repo?: string; // owner/nome su GitHub, minuscolo
}

const soloVercel = (u: unknown): string | undefined => (typeof u === 'string' && /^https:\/\/vercel\.com\/[A-Za-z0-9._~/%-]+$/.test(u) ? u : undefined);

/** Una voce di /v6/deployments. */
export function leggiPubblicazione(d: any): Pubblicazione | null {
	if (!d || typeof d !== 'object') return null;
	const uid = String(d.uid ?? d.id ?? '');
	const projectId = String(d.projectId ?? '');
	if (!uid || !projectId) return null;
	const m = d.meta ?? {};
	const sha = m.githubCommitSha || m.gitlabCommitSha || m.bitbucketCommitSha;
	const msg = m.githubCommitMessage || m.gitlabCommitMessage || m.bitbucketCommitMessage;
	const ref = m.githubCommitRef || m.gitlabCommitRef || m.bitbucketCommitRef;
	const org = m.githubOrg || m.githubCommitOrg;
	const rep = m.githubRepo || m.githubCommitRepo;
	const p: Pubblicazione = {
		uid,
		projectId,
		name: String(d.name ?? ''),
		state: String(d.readyState || d.state || 'QUEUED').toUpperCase(),
		at: Number(d.createdAt ?? d.created) || 0,
	};
	if (Number(d.ready)) p.readyAt = Number(d.ready);
	if (typeof d.url === 'string' && d.url) p.host = d.url.replace(/^https?:\/\//, '');
	const insp = soloVercel(d.inspectorUrl);
	if (insp) p.inspector = insp;
	if (sha) p.commit = { sha: String(sha), message: String(msg ?? '').split('\n')[0].slice(0, 160), ...(ref ? { ref: String(ref) } : {}) };
	if (org && rep) p.repo = `${org}/${rep}`.toLowerCase();
	return p;
}

/** Il dominio da mostrare tra gli alias: prima un dominio vero (il piu' corto), poi il piu' corto dei vercel.app. */
export function sceltaDominio(alias: unknown): string | undefined {
	const a = (Array.isArray(alias) ? alias : []).filter((x): x is string => typeof x === 'string' && /^[a-z0-9.-]+$/i.test(x));
	const corto = (l: string[]) => [...l].sort((x, y) => x.length - y.length || x.localeCompare(y))[0];
	return corto(a.filter(x => !x.endsWith('.vercel.app'))) ?? corto(a);
}

// ---------- collegamenti ai progetti ----------

export interface Collegamento {
	projectId: string;
	orgId: string; // '' = lo scope predefinito della CLI
	name?: string;
	path: string;
	via: VercelSito['via'];
}

interface Candidato {
	path: string;
	repo?: string;
	names: string[];
}

const GENERICI = new Set(['app', 'web', 'www', 'site', 'sito', 'website', 'frontend', 'backend', 'api', 'docs', 'server', 'client', 'test', 'demo']);

function leggiJson(f: string): any {
	try {
		return JSON.parse(fs.readFileSync(f, 'utf8'));
	} catch {
		return undefined;
	}
}

function dalleCartelle(dir: string): Omit<Collegamento, 'path'>[] {
	const out: Omit<Collegamento, 'path'>[] = [];
	const pj = leggiJson(path.join(dir, '.vercel', 'project.json'));
	if (pj?.projectId) out.push({ projectId: String(pj.projectId), orgId: String(pj.orgId ?? ''), name: pj.projectName ? String(pj.projectName) : undefined, via: 'project.json' });
	const rj = leggiJson(path.join(dir, '.vercel', 'repo.json'));
	for (const p of Array.isArray(rj?.projects) ? rj.projects : []) {
		if (p?.id) out.push({ projectId: String(p.id), orgId: String(p.orgId ?? rj.orgId ?? ''), name: p.name ? String(p.name) : undefined, via: 'repo.json' });
	}
	return out;
}

/** Il repository GitHub del remoto origin, letto da .git/config (niente processi). */
export function repoGithub(dir: string): string | undefined {
	let cfg = '';
	try {
		cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
	} catch {
		return undefined;
	}
	const sez = /\[remote "origin"\]([^[]*)/.exec(cfg)?.[1] ?? cfg;
	const url = /^\s*url\s*=\s*(\S+)/m.exec(sez)?.[1];
	const m = url && /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
	return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

/** I collegamenti espliciti (project.json, repo.json, anche in una sottocartella) e i candidati per repository e nome. */
export function collegamenti(projects: Pick<Project, 'path' | 'name'>[]): { espliciti: Collegamento[]; candidati: Candidato[] } {
	const espliciti: Collegamento[] = [];
	const visti = new Set<string>();
	const candidati: Candidato[] = [];
	for (const p of projects) {
		const trovati = dalleCartelle(p.path);
		let sub: fs.Dirent[] = [];
		try {
			sub = fs.readdirSync(p.path, { withFileTypes: true });
		} catch {
			// cartella sparita
		}
		for (const e of sub.slice(0, 200)) {
			if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
			trovati.push(...dalleCartelle(path.join(p.path, e.name)));
		}
		if (trovati.length) {
			for (const t of trovati) {
				if (visti.has(t.projectId)) continue;
				visti.add(t.projectId);
				espliciti.push({ ...t, path: p.path });
			}
			continue;
		}
		const names = new Set<string>();
		const add = (s: unknown) => {
			const n = typeof s === 'string' ? s.replace(/^@[^/]+\//, '').trim().toLowerCase() : '';
			if (n.length >= 3 && !GENERICI.has(n)) names.add(n);
		};
		add(path.basename(p.path));
		add(leggiJson(path.join(p.path, 'vercel.json'))?.name);
		add(leggiJson(path.join(p.path, 'package.json'))?.name);
		candidati.push({ path: p.path, repo: repoGithub(p.path), names: [...names] });
	}
	return { espliciti, candidati };
}

// ---------- la Vedetta: la regola ----------

const DATA = (ms: number) => new Date(ms).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });

/** Le pubblicazioni di produzione fallite di un progetto, come regole rosse del semaforo. */
export function vercelHits(projectPath: string, stato: VercelState | undefined): VercelHit[] {
	const out: VercelHit[] = [];
	for (const s of stato?.sites ?? []) {
		if (s.projectPath !== projectPath || s.state !== 'ERROR') continue;
		const dettagli: string[] = [];
		if (s.commit) dettagli.push(`${s.commit.sha.slice(0, 7)} ${s.commit.message}`.trim());
		if (s.error) dettagli.push(s.error);
		dettagli.push(s.url);
		out.push({
			id: 'vercel',
			livello: 'rosso',
			frase: `L'ultima pubblicazione di ${s.name} su Vercel è fallita (${DATA(s.at)}).`,
			rimedio: s.lastReady
				? `Online resta quella del ${DATA(s.lastReady.at)}. Guarda il registro su Vercel, correggi e ripubblica.`
				: 'Guarda il registro su Vercel, correggi e ripubblica.',
			dettagli,
		});
	}
	return out;
}

// ---------- il lettore ----------

interface Letto {
	at: number; // quando e' stato letto da solo
	p: Pubblicazione | null; // null: il progetto non ha pubblicazioni di produzione
}

interface CacheFile {
	schema: number;
	state: Omit<VercelState, 'refreshing'>;
	triedAt: number;
	/** progetti letti uno per uno perche' fuori dalle ultime pagine */
	letti: Record<string, Letto>;
	/** l'ultima pronta conosciuta di ogni progetto: quella che resta online se l'ultima fallisce */
	pronte: Record<string, Pubblicazione>;
	/** dettagli delle pubblicazioni gia' guardate: dominio e messaggio d'errore */
	dettagli: Record<string, { domain?: string; error?: string }>;
}

function minutiDaImpostazioni(): number {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const v = require('vscode').workspace.getConfiguration('bottega').get('vercel.ogniMinuti', DEFAULT_MINUTI);
		return Number(v) || DEFAULT_MINUTI;
	} catch {
		return DEFAULT_MINUTI; // fuori dall'IDE (le prove)
	}
}

async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<void>): Promise<void> {
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (i < items.length) await fn(items[i++]);
		}),
	);
}

/** Un percorso dell'API con la sua query, piu' il team quando il progetto sta in un team. */
function ep(p: string, q: Record<string, string | number>, orgId: string): string {
	const all: Record<string, string> = {};
	for (const [k, v] of Object.entries(q)) all[k] = String(v);
	if (orgId.startsWith('team_')) all.teamId = orgId;
	const qs = new URLSearchParams(all).toString();
	return qs ? `${p}?${qs}` : p;
}

export class Vercel {
	private readonly dir: string;
	private readonly file: string;
	private readonly now: () => number;
	private readonly esegui: Esegui;
	private readonly ogniMinuti: () => number;
	private cache: CacheFile;
	private running: Promise<VercelState> | undefined;
	private listeners: ((s: VercelState) => void)[] = [];

	constructor(private readonly opts: VercelOptions = {}) {
		this.dir = opts.dir ?? path.join(os.homedir(), '.bottega', 'radar');
		this.file = path.join(this.dir, 'vercel.json');
		this.now = opts.now ?? Date.now;
		this.esegui = opts.esegui ?? eseguiVero(this.dir);
		this.ogniMinuti = opts.ogniMinuti ?? minutiDaImpostazioni;
		this.cache = this.load();
	}

	state(): VercelState {
		return { ...this.cache.state, refreshing: !!this.running };
	}

	onChange(cb: (s: VercelState) => void): void {
		this.listeners.push(cb);
	}

	private emit() {
		const s = this.state();
		for (const cb of this.listeners) {
			try {
				cb(s);
			} catch (e) {
				this.log((e as Error).message);
			}
		}
	}

	private log(s: string) {
		this.opts.log?.('vercel: ' + s);
	}

	private load(): CacheFile {
		const raw = leggiJson(this.file);
		if (raw?.schema === SCHEMA && raw.state && Array.isArray(raw.state.sites)) {
			return { letti: {}, pronte: {}, dettagli: {}, triedAt: 0, ...raw };
		}
		return { schema: SCHEMA, state: { sites: [], at: 0 }, triedAt: 0, letti: {}, pronte: {}, dettagli: {} };
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
			this.log('non riesco a salvare lo stato: ' + (e as Error).message);
		}
	}

	/** Una lettura alla volta; tra due letture almeno `ogniMinuti` (forzata: almeno un minuto). */
	refresh(projects: Pick<Project, 'path' | 'name'>[], opts: { force?: boolean } = {}): Promise<VercelState> {
		if (this.running) return this.running;
		const gap = opts.force ? MIN_FORZATA : Math.max(10, Math.min(24 * 60, this.ogniMinuti())) * 60_000;
		if (this.now() - this.cache.triedAt < gap) return Promise.resolve(this.state());
		this.running = this.run(projects)
			.catch(e => {
				this.cache.state.error = e instanceof CliError ? e.message : `Vercel non risponde: ${pulisci(String((e as Error)?.message ?? e))}`;
				this.log(this.cache.state.error);
				this.save();
				return this.state();
			})
			.finally(() => {
				this.running = undefined;
				this.emit();
			})
			.then(() => this.state());
		this.emit();
		return this.running;
	}

	/** Chiama la CLI: solo comandi dell'elenco chiuso. */
	private async cli(args: string[]): Promise<any> {
		const full = [...args, '--non-interactive', '--no-color'];
		if (!comandoAmmesso(full)) throw new CliError(`Comando di Vercel rifiutato: solo lettura (${args[0] ?? ''}).`);
		const out = await this.esegui(full, TIMEOUT);
		if (out.code !== 0 || out.timedOut) throw new CliError(messaggioErrore(out));
		try {
			return JSON.parse(out.stdout);
		} catch {
			throw new CliError('Vercel ha risposto in un formato inatteso.');
		}
	}

	private api(endpoint: string): Promise<any> {
		return this.cli(['api', endpoint, '-X', 'GET', '--raw']);
	}

	private async run(projects: Pick<Project, 'path' | 'name'>[]): Promise<VercelState> {
		this.cache.triedAt = this.now();
		const { espliciti, candidati } = collegamenti(projects);
		const c = this.cache;

		// 1. le ultime pubblicazioni di produzione, team per team
		const orgs = new Map<string, Set<string>>();
		for (const l of espliciti) {
			if (!orgs.has(l.orgId)) orgs.set(l.orgId, new Set());
			orgs.get(l.orgId)!.add(l.projectId);
		}
		if (!orgs.size) orgs.set('', new Set());
		const ultime = new Map<string, Pubblicazione>(); // projectId -> la piu' recente
		const tutte: Pubblicazione[] = [];
		const orgDi = new Map<string, string>(); // projectId -> team in cui e' stato visto
		const finoA = new Map<string, number>(); // org -> la piu' vecchia vista (0: viste tutte)
		for (const [org, wanted] of orgs) {
			let until = '';
			let oldest = 0;
			for (let page = 0; page < MAX_PAGINE; page++) {
				const j = await this.api(ep('/v6/deployments', { target: 'production', limit: 100, ...(until ? { until } : {}) }, org));
				const list = (Array.isArray(j?.deployments) ? j.deployments : []).map(leggiPubblicazione).filter(Boolean) as Pubblicazione[];
				list.sort((a, b) => b.at - a.at);
				for (const p of list) {
					tutte.push(p);
					if (!orgDi.has(p.projectId)) orgDi.set(p.projectId, org);
					if (!ultime.has(p.projectId)) ultime.set(p.projectId, p);
					if (p.state === 'READY' && (!c.pronte[p.projectId] || c.pronte[p.projectId].at < p.at)) c.pronte[p.projectId] = p;
				}
				if (list.length) oldest = list[list.length - 1].at;
				const next = j?.pagination?.next;
				if (!next || !list.length) {
					oldest = 0;
					break;
				}
				until = String(next);
				// basta pagine quando ogni progetto voluto e' qui, o e' stato letto da solo dopo la piu' vecchia vista
				if ([...wanted].every(id => ultime.has(id) || (c.letti[id]?.at ?? -1) >= oldest)) break;
			}
			finoA.set(org, oldest);
		}

		// 2. chi non ha project.json: repository GitHub, poi nome
		const links = [...espliciti];
		const presi = new Set(links.map(l => l.projectId));
		const perRepo = new Map<string, Pubblicazione>();
		const perNome = new Map<string, Pubblicazione>();
		for (const p of tutte) {
			if (p.repo && !perRepo.has(p.repo)) perRepo.set(p.repo, p);
			const n = p.name.toLowerCase();
			if (n && !perNome.has(n)) perNome.set(n, p);
		}
		for (const k of candidati) {
			const r = k.repo ? perRepo.get(k.repo) : undefined;
			if (r && !presi.has(r.projectId)) {
				presi.add(r.projectId);
				links.push({ projectId: r.projectId, orgId: orgDi.get(r.projectId) ?? '', name: r.name, path: k.path, via: 'github' });
				continue;
			}
			for (const n of k.names) {
				const p = perNome.get(n);
				if (p && !presi.has(p.projectId)) {
					presi.add(p.projectId);
					links.push({ projectId: p.projectId, orgId: orgDi.get(p.projectId) ?? '', name: p.name, path: k.path, via: 'nome' });
					break;
				}
			}
		}

		// 3. i progetti fuori dalle pagine: uno per uno, e solo se la lettura vecchia potrebbe aver perso qualcosa
		const singoli = links.filter(l => {
			if (ultime.has(l.projectId)) return false;
			const old = c.letti[l.projectId];
			return !old || old.at < (finoA.get(l.orgId) ?? 0);
		});
		await pool(singoli.slice(0, MAX_SINGOLI), PARALLEL, async l => {
			try {
				const j = await this.api(ep('/v6/deployments', { projectId: l.projectId, target: 'production', limit: 5 }, l.orgId));
				const list = ((Array.isArray(j?.deployments) ? j.deployments : []).map(leggiPubblicazione).filter(Boolean) as Pubblicazione[]).sort((a, b) => b.at - a.at);
				c.letti[l.projectId] = { at: this.now(), p: list[0] ?? null };
				const pronta = list.find(p => p.state === 'READY');
				if (pronta && (!c.pronte[l.projectId] || c.pronte[l.projectId].at < pronta.at)) c.pronte[l.projectId] = pronta;
			} catch (e) {
				// progetto tolto da Vercel (la cartella .vercel e' rimasta): si ricorda, si riprova fra qualche giorno
				if (/\b404\b|not found/i.test((e as Error).message)) c.letti[l.projectId] = { at: this.now(), p: null };
				this.log(`${l.name ?? l.projectId}: ${(e as Error).message}`);
			}
		});
		for (const [id, p] of ultime) c.letti[id] = { at: this.now(), p };

		// 4. dettagli delle pubblicazioni nuove: il dominio dall'ultima pronta, l'errore dalla fallita
		const serve = new Map<string, string>(); // uid -> orgId
		for (const l of links) {
			const p = c.letti[l.projectId]?.p;
			if (!p) continue;
			if (p.state === 'ERROR' && !c.dettagli[p.uid]) serve.set(p.uid, l.orgId);
			const pronta = p.state === 'READY' ? p : c.pronte[l.projectId];
			if (pronta && !c.dettagli[pronta.uid]) serve.set(pronta.uid, l.orgId);
		}
		await pool([...serve].slice(0, MAX_DETTAGLI), PARALLEL, async ([uid, org]) => {
			try {
				const j = await this.api(ep(`/v13/deployments/${encodeURIComponent(uid)}`, {}, org));
				const det: { domain?: string; error?: string } = {};
				const dom = sceltaDominio(j?.alias);
				if (dom) det.domain = dom;
				const err = j?.errorMessage || j?.errorCode;
				if (err) det.error = pulisci(String(err)).slice(0, 200);
				c.dettagli[uid] = det;
			} catch (e) {
				this.log(`dettagli: ${(e as Error).message}`);
			}
		});

		// 5. i siti
		const sites: VercelSito[] = [];
		for (const l of links) {
			const p = c.letti[l.projectId]?.p;
			if (!p) continue;
			const pronta = p.state === 'READY' ? p : c.pronte[l.projectId];
			const { label, tone } = statoVercel(p.state);
			const s: VercelSito = {
				projectId: l.projectId,
				name: p.name || l.name || l.projectId,
				projectPath: l.path,
				via: l.via,
				state: p.state,
				label,
				tone,
				at: p.at,
				url: p.inspector ?? pronta?.inspector ?? 'https://vercel.com/dashboard',
			};
			if (p.readyAt) s.readyAt = p.readyAt;
			// l'indirizzo della singola pubblicazione non e' il dominio del sito: meglio niente finche' non arriva l'alias
			const domain = pronta && c.dettagli[pronta.uid]?.domain;
			if (domain) s.domain = domain;
			if (p.commit) s.commit = p.commit;
			if (p.state === 'ERROR' && c.dettagli[p.uid]?.error) s.error = c.dettagli[p.uid].error;
			if (p.state !== 'READY' && pronta && pronta.at < p.at) s.lastReady = { at: pronta.at, url: pronta.inspector ?? s.url };
			sites.push(s);
		}
		const rank = { male: 0, attesa: 1, ok: 2 };
		sites.sort((a, b) => rank[a.tone] - rank[b.tone] || b.at - a.at);

		// la cache tiene solo cio' che serve ai siti di adesso
		const ids = new Set(links.map(l => l.projectId));
		const uids = new Set<string>();
		for (const id of Object.keys(c.letti)) if (!ids.has(id)) delete c.letti[id];
		for (const id of Object.keys(c.pronte)) if (!ids.has(id)) delete c.pronte[id];
		for (const id of ids) {
			const p = c.letti[id]?.p;
			if (p) uids.add(p.uid);
			if (c.pronte[id]) uids.add(c.pronte[id].uid);
		}
		for (const u of Object.keys(c.dettagli)) if (!uids.has(u)) delete c.dettagli[u];

		c.state = { sites, at: this.now() };
		this.save();
		return this.state();
	}
}
