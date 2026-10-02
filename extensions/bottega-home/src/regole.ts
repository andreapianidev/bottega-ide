/* Il semaforo delle regole di Andrea, progetto per progetto (docs/CONTRATTI.md, sezione 4.1).

   rosso: segreti nei commit non spinti, repository pubblico non scelto, versione su App Store Connect
          non in rilascio automatico, app-ads.txt diverso sui tre siti (globale).
   giallo: build non salita nello stesso commit del codice, commit non spinti, niente remoto o upstream.

   Prestazioni: tre progetti alla volta, ogni comando con il suo tempo massimo. Per progetto un giro
   costa due comandi git leggeri (rev-parse, remoti); le regole che leggono la storia (build, segreti)
   si rifanno solo se cambiano la HEAD o l'upstream. La build legge solo i nomi dei file degli ultimi
   N commit, poi chiede a git (-G, sui soli file di versione) quali di quelli alzano la build: nessuna
   patch intera passa di qui. La visibilita' su GitHub si chiede al massimo una volta al giorno per
   repository, app-ads.txt al massimo ogni 6 ore. Tutto in ~/.bottega/regole-cache.json. */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { findSecrets } from '../../../memoria/lib/redact.mjs';
import type { Project } from './scan';
import type { Livello, ProjectRules, RadarState, RuleHit, RulesState } from './tipi';
import { STATI_RILASCIO } from './radar';

export type { Livello, ProjectRules, RuleHit, RulesState };

export type RunFn = (
	cmd: string,
	args: string[],
	cwd: string,
	opts?: { timeout?: number; maxBuffer?: number },
) => Promise<{ code: number; stdout: string; truncated?: boolean }>;

export interface RulesOptions {
	cacheFile?: string;
	configFile?: string;
	log?: (s: string) => void;
	radar?: () => RadarState | undefined;
	run?: RunFn;
	fetch?: typeof fetch;
	now?: () => number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GH_TTL = DAY;
const GH_ERR_TTL = HOUR;
const ADS_TTL = 6 * HOUR;
const ADS_ERR_TTL = HOUR / 2;
const GIT_TTL = DAY; // la finestra dei 60 giorni scorre anche senza commit nuovi
const PARALLEL = 3;
const SCHEMA = 1;
export const APP_ADS_HOSTS = ['www.andreapiani.com', 'privacypolicyhub.vercel.app', 'walkie-talky.vercel.app'];
const SEMPRE_PUBBLICI = ['andreapianidev/bottega-ide'];

const CODICE = new Set(
	'swift m h kt java ts tsx js mjs cjs py metal xib storyboard xcstrings strings plist gradle kts css html'.split(' '),
);
const VERSIONE_RE = 'CURRENT_PROJECT_VERSION|versionCode|"build"[[:space:]]*:';
/** Dove vive il numero di build: Xcode (anche XcodeGen, project.yml), Gradle, bottega.json. */
const VERSIONE_FILES = [
	':(glob)**/*.pbxproj',
	':(glob)**/*.xcconfig',
	':(glob)**/project.yml',
	':(glob)**/project.yaml',
	':(glob)**/build.gradle',
	':(glob)**/build.gradle.kts',
	':(glob)**/*.properties',
	':(glob)**/bottega.json',
];
/** Uscite compilate e dipendenze: non sono codice scritto, non chiedono una build. */
const GENERATI_RE = /(^|\/)(out|dist|build|test-out|node_modules|Pods|DerivedData|\.build)\//;
/** File in cui le regole "deboli" di redact (nomi di variabili) contano anche senza virgolette. */
const CONFIG_RE = /(^|\/)\.env[^/]*$|\.(json|ya?ml|plist|properties|xcconfig|toml|ini|cfg|conf|txt)$/i;
const LOCK_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Podfile\.lock|Package\.resolved|Cargo\.lock|poetry\.lock)$/;

const GH_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'];

/** execFile con tempo massimo e limite di uscita: mai un'eccezione, solo un codice. */
export const defaultRun: RunFn = (cmd, args, cwd, opts = {}) =>
	new Promise(resolve => {
		const bin = cmd === 'gh' ? GH_CANDIDATES.find(p => fs.existsSync(p)) ?? 'gh' : cmd;
		execFile(
			bin,
			args,
			{
				cwd,
				timeout: opts.timeout ?? 15_000,
				maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', LC_ALL: 'C' },
			},
			(err, stdout) => {
				const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
				const truncated = e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
				resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout ?? ''), truncated });
			},
		);
	});

interface GitCache {
	key: string;
	at: number;
	build: RuleHit | null;
	segreti: RuleHit | null;
}

interface CacheFile {
	schema: number;
	state: Omit<RulesState, 'running'>;
	git: Record<string, GitCache>;
	gh: Record<string, { private: boolean | null; own?: boolean; at: number }>;
}

interface Config {
	pubbliciPerScelta: string[];
	commitDaControllare: number;
	appAdsHosts: string[];
}

/** owner/nome da un indirizzo di GitHub (https o ssh); undefined per gli altri. */
export function githubRepo(url: string): string | undefined {
	const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
	return m ? `${m[1]}/${m[2]}` : undefined;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export class RulesEngine {
	private readonly cacheFile: string;
	private readonly configFile: string;
	private readonly run: RunFn;
	private readonly fetch: typeof fetch;
	private readonly now: () => number;
	private cache: CacheFile;
	private running: Promise<RulesState> | undefined;
	private listeners: ((s: RulesState) => void)[] = [];
	/** Misure dell'ultimo controllo, per il banco di prova e i resoconti. */
	lastTiming = { ms: 0, projects: 0, recomputed: 0, commands: 0 };

	constructor(private readonly opts: RulesOptions = {}) {
		this.cacheFile = opts.cacheFile ?? path.join(os.homedir(), '.bottega', 'regole-cache.json');
		this.configFile = opts.configFile ?? path.join(os.homedir(), '.bottega', 'regole.json');
		const run = opts.run ?? defaultRun;
		this.run = (cmd, args, cwd, o) => {
			this.lastTiming.commands++;
			return run(cmd, args, cwd, o);
		};
		this.fetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
		this.now = opts.now ?? Date.now;
		this.cache = this.load();
	}

	state(): RulesState {
		return { ...this.cache.state, running: !!this.running };
	}

	onChange(cb: (s: RulesState) => void): void {
		this.listeners.push(cb);
	}

	private emit() {
		const s = this.state();
		for (const cb of this.listeners) {
			try {
				cb(s);
			} catch (e) {
				this.opts.log?.('regole: ' + (e as Error).message);
			}
		}
	}

	private load(): CacheFile {
		try {
			const raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
			if (raw?.schema === SCHEMA && raw.state && raw.git && raw.gh) return raw;
		} catch {
			// prima volta, o cache rovinata
		}
		return {
			schema: SCHEMA,
			state: { projects: {}, global: [], appAds: null, counts: { rosso: 0, giallo: 0, verde: 0 }, checkedAt: 0 },
			git: {},
			gh: {},
		};
	}

	private save() {
		try {
			fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
			const tmp = this.cacheFile + '.tmp';
			fs.writeFileSync(tmp, JSON.stringify(this.cache), { mode: 0o600 });
			fs.renameSync(tmp, this.cacheFile);
		} catch (e) {
			this.opts.log?.('regole: non riesco a salvare la cache: ' + (e as Error).message);
		}
	}

	private config(): Config {
		let raw: any = {};
		try {
			raw = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
		} catch {
			// file facoltativo
		}
		const list = Array.isArray(raw?.pubbliciPerScelta) ? raw.pubbliciPerScelta.map((s: unknown) => String(s).toLowerCase()) : [];
		const n = Number(raw?.commitDaControllare);
		return {
			pubbliciPerScelta: [...new Set([...SEMPRE_PUBBLICI, ...list])],
			commitDaControllare: Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 200) : 10,
			appAdsHosts: Array.isArray(raw?.appAdsHosts) && raw.appAdsHosts.length ? raw.appAdsHosts.map(String) : APP_ADS_HOSTS,
		};
	}

	/** Un controllo alla volta: chi chiede mentre si controlla riceve lo stesso risultato. */
	check(projects: Project[], opts: { force?: boolean } = {}): Promise<RulesState> {
		if (this.running) return this.running;
		this.running = this.doCheck(projects, !!opts.force)
			.finally(() => {
				this.running = undefined;
				this.emit();
			})
			.then(() => this.state());
		this.emit();
		return this.running;
	}

	private async doCheck(projects: Project[], force: boolean): Promise<RulesState> {
		const t0 = performance.now();
		this.lastTiming = { ms: 0, projects: 0, recomputed: 0, commands: 0 };
		const cfg = this.config();
		const radar = this.opts.radar?.();
		const repos = projects.filter(p => p.git);
		const results = await pool(repos, PARALLEL, p => this.checkProject(p, cfg, radar, force));
		const st = this.cache.state;
		st.projects = {};
		for (const r of results) if (r) st.projects[r.path] = r;
		// via dalla cache i progetti che non ci sono piu'
		for (const k of Object.keys(this.cache.git)) if (!st.projects[k]) delete this.cache.git[k];

		st.appAds = await this.checkAppAds(cfg, force);
		st.global = appAdsHits(st.appAds);
		const counts = { rosso: 0, giallo: 0, verde: 0 };
		for (const p of Object.values(st.projects)) counts[p.livello]++;
		for (const h of st.global) counts[h.livello]++;
		st.counts = counts;
		st.checkedAt = this.now();
		this.save();
		this.lastTiming.ms = Math.round(performance.now() - t0);
		this.lastTiming.projects = repos.length;
		return this.state();
	}

	private async checkProject(p: Project, cfg: Config, radar: RadarState | undefined, force: boolean): Promise<ProjectRules | undefined> {
		const g = p.git!;
		const upstream = g.upstream;
		const [rev, remotes] = await Promise.all([
			this.run('git', ['rev-parse', 'HEAD', ...(upstream ? ['@{u}'] : [])], p.path, { timeout: 5000 }),
			this.run('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], p.path, { timeout: 5000 }),
		]);
		const [head = '', up = ''] = rev.stdout.trim().split('\n');
		const urls = remotes.stdout
			.split('\n')
			.map(l => /^remote\.(.+)\.url\s+(.+)$/.exec(l.trim()))
			.filter(Boolean) as RegExpExecArray[];
		const origin = urls.find(m => m[1] === 'origin')?.[2] ?? urls[0]?.[2];

		const eligible = this.buildEligible(p);
		const key = [head, up, g.ahead, cfg.commitDaControllare, eligible ? 1 : 0].join('|');
		let cached = this.cache.git[p.path];
		if (force || !cached || cached.key !== key || this.now() - cached.at > GIT_TTL) {
			this.lastTiming.recomputed++;
			cached = {
				key,
				at: this.now(),
				build: head && eligible ? await this.buildHit(p, cfg.commitDaControllare) : null,
				segreti: head && up && g.ahead > 0 ? await this.secretsHit(p) : null,
			};
			this.cache.git[p.path] = cached;
		}

		const hits: RuleHit[] = [];
		if (cached.segreti) hits.push(cached.segreti);
		const repo = origin ? githubRepo(origin) : undefined;
		if (repo) {
			const gh = await this.github(repo, p.path, force);
			// un clone di un progetto altrui (nessun permesso di scrittura) non e' una scelta di Andrea
			if (gh.private === false && gh.own && !cfg.pubbliciPerScelta.includes(repo.toLowerCase())) {
				hits.push({
					id: 'pubblico',
					livello: 'rosso',
					frase: `Il repository ${repo} su GitHub è pubblico.`,
					rimedio: 'Rendilo privato su GitHub, oppure aggiungilo a pubbliciPerScelta in ~/.bottega/regole.json se è una scelta.',
				});
			}
		}
		const rel = releaseHit(p.path, radar);
		if (rel) hits.push(rel);
		if (cached.build) hits.push(cached.build);
		if (g.ahead > 0 && g.upstream) {
			hits.push({
				id: 'push',
				livello: 'giallo',
				frase: `${g.ahead} ${plural(g.ahead, 'commit non spinto', 'commit non spinti')} su ${g.branch}.`,
				rimedio: cached.segreti
					? 'Prima togli la chiave dai commit, poi spingi.'
					: 'Spingili: finché restano qui esistono in una sola copia.',
				...(cached.segreti ? {} : { azione: { act: 'push', label: 'Spingi', args: { path: p.path } } }),
			});
		}
		if (!urls.length) {
			hits.push({
				id: 'remoto',
				livello: 'giallo',
				frase: 'Il repository non ha un remoto.',
				rimedio: 'Collegalo a un repository privato su GitHub: adesso il lavoro esiste solo su questo Mac.',
			});
		} else if (!g.upstream && g.branch !== '(detached)') {
			hits.push({
				id: 'remoto',
				livello: 'giallo',
				frase: `Il ramo ${g.branch} non ha un upstream.`,
				rimedio: `Spingilo con git push -u origin ${g.branch}, così i commit hanno una seconda copia.`,
			});
		}
		const livello: Livello = hits.some(h => h.livello === 'rosso') ? 'rosso' : hits.length ? 'giallo' : 'verde';
		return { path: p.path, livello, hits, checkedAt: this.now() };
	}

	private buildEligible(p: Project): boolean {
		if (p.build?.source === 'xcode' || p.build?.source === 'android') return true;
		try {
			const j = JSON.parse(fs.readFileSync(path.join(p.path, 'bottega.json'), 'utf8'));
			return !!j && typeof j === 'object' && 'build' in j;
		} catch {
			return false;
		}
	}

	/** Commit degli ultimi N (60 giorni, niente merge) che toccano il codice senza alzare la build. */
	private async buildHit(p: Project, n: number): Promise<RuleHit | null> {
		const names = await this.run(
			'git',
			['-c', 'core.quotepath=off', 'log', `-n${n}`, '--since=60.days', '--no-merges', '--format=%x1e%H%x1f%s', '--name-only', '--no-renames'],
			p.path,
			{ maxBuffer: 2 * 1024 * 1024 },
		);
		if (names.code !== 0 && !names.truncated) return null;
		const commits: { sha: string; subject: string; code: boolean }[] = [];
		for (const block of names.stdout.split('\x1e')) {
			if (!block.trim()) continue;
			const [first, ...files] = block.split('\n');
			const [sha, subject = ''] = first.split('\x1f');
			if (!/^[0-9a-f]{40}$/.test(sha)) continue;
			const code = files.some(f => !GENERATI_RE.test(f) && CODICE.has(path.extname(f.trim()).slice(1).toLowerCase()));
			commits.push({ sha, subject, code });
		}
		const suspects = commits.filter(c => c.code);
		if (!suspects.length) return null;
		const bumped = await this.run(
			'git',
			['log', '--no-walk=unsorted', '--format=%H', '-G', VERSIONE_RE, ...suspects.map(c => c.sha), '--', ...VERSIONE_FILES],
			p.path,
			{ maxBuffer: 256 * 1024 },
		);
		if (bumped.code !== 0) return null;
		const ok = new Set(bumped.stdout.split('\n').map(s => s.trim()).filter(Boolean));
		const bad = suspects.filter(c => !ok.has(c.sha));
		if (!bad.length) return null;
		const script = ['scripts/bump-build.sh', 'scripts/bump_build.sh', 'scripts/bump-build', 'bump-build.sh'].find(s =>
			fs.existsSync(path.join(p.path, s)),
		);
		const shas = bad.map(c => c.sha.slice(0, 7));
		return {
			id: 'build',
			livello: 'giallo',
			frase: `${bad.length} ${plural(bad.length, 'commit', 'commit')} su ${commits.length} ${plural(bad.length, 'tocca', 'toccano')} il codice senza alzare la build.`,
			rimedio: `Alza la build nel prossimo commit${script ? ` con ${script}` : ''}, insieme alla modifica.`,
			azione: {
				act: 'job.prepare',
				label: 'Fai alzare la build',
				args: {
					path: p.path,
					task:
						`Negli ultimi commit il numero di build non è salito insieme al codice (${shas.join(', ')}). ` +
						'Non riscrivere i commit già fatti. Alza adesso il numero di build ' +
						(script ? `con ${script} (non a mano nel file di progetto)` : '(CURRENT_PROJECT_VERSION su Xcode, versionCode su Android)') +
						', controlla che tutti i bersagli dell\'app abbiano lo stesso numero, compila e fai un commit con la build alzata. ' +
						'Da qui in avanti la build sale nello stesso commit di ogni modifica.',
				},
			},
			dettagli: bad.map(c => `${c.sha.slice(0, 7)} ${c.subject}`.trim()),
		};
	}

	/** Chiavi nelle righe aggiunte dai commit non spinti. Mai il valore: solo file e tipo. */
	private async secretsHit(p: Project): Promise<RuleHit | null> {
		const diff = await this.run(
			'git',
			['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--unified=0', '--no-renames', '@{u}..HEAD'],
			p.path,
			{ maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
		);
		if (diff.code !== 0 && !diff.truncated) return null;
		const added = new Map<string, string[]>();
		let file = '';
		for (const line of diff.stdout.split('\n')) {
			if (line.startsWith('+++ ')) {
				file = line.startsWith('+++ b/') ? line.slice(6) : '';
				continue;
			}
			if (!file || !line.startsWith('+')) continue;
			let a = added.get(file);
			if (!a) added.set(file, (a = []));
			a.push(line.slice(1));
		}
		const found: string[] = [];
		const kinds = new Set<string>();
		for (const [f, lines] of added) {
			if (LOCK_RE.test(f)) continue;
			const text = lines.join('\n');
			for (const h of findSecrets(text)) {
				if (!h.strong && !weakCounts(f, text.slice(h.index, h.index + h.length))) continue;
				const d = `${f}: ${h.rule}`;
				if (!found.includes(d)) found.push(d);
				kinds.add(h.rule);
			}
		}
		if (!found.length) return null;
		const files = [...new Set(found.map(d => d.slice(0, d.lastIndexOf(': '))))];
		const n = found.length;
		const dettagli = found.slice(0, 10);
		if (diff.truncated) dettagli.push('(differenza troppo grande: controllata solo in parte)');
		return {
			id: 'segreti',
			livello: 'rosso',
			frase: `Nei commit non spinti ${plural(n, "c'è una chiave", `ci sono ${n} chiavi`)} (${[...kinds].join(', ')}).`,
			rimedio: 'Toglila dai commit prima di spingere, mettila in ~/.secrets/ e, se era vera, cambiala.',
			azione: {
				act: 'job.prepare',
				label: 'Fai togliere la chiave',
				args: {
					path: p.path,
					task:
						`Nei commit non ancora spinti ci sono chiavi in chiaro (${files.slice(0, 6).join(', ')}). Non spingere. ` +
						'Togli le chiavi dai soli commit non spinti (riscrivendoli in locale), leggile dalla configurazione o dalle variabili ' +
						"d'ambiente, salva i valori in ~/.secrets/ secondo le regole del vault, e dimmi quali chiavi erano vere e vanno cambiate. " +
						'Non scrivere mai il valore delle chiavi nel resoconto.',
				},
			},
			dettagli,
		};
	}

	/** private: true privato, false pubblico, null non si sa (gh assente, nessun accesso, rete).
	 *  own: Andrea ci puo' scrivere (permessi push), cioe' e' un suo repository e non un clone altrui. */
	private async github(repo: string, cwd: string, force: boolean): Promise<{ private: boolean | null; own: boolean }> {
		const k = repo.toLowerCase();
		const c = this.cache.gh[k];
		const ttl = c && c.private === null ? GH_ERR_TTL : GH_TTL;
		if (c && !force && this.now() - c.at < ttl) return { private: c.private, own: c.own !== false };
		const r = await this.run('gh', ['api', `repos/${repo}`, '--jq', '"\\(.private) \\(.permissions.push // false)"'], cwd, {
			timeout: 10_000,
			maxBuffer: 64 * 1024,
		});
		const [priv, push] = r.stdout.trim().split(/\s+/);
		const v = r.code === 0 && (priv === 'true' || priv === 'false') ? priv === 'true' : null;
		const own = push !== 'false';
		this.cache.gh[k] = { private: v, own, at: this.now() };
		return { private: v, own };
	}

	private async checkAppAds(cfg: Config, force: boolean): Promise<RulesState['appAds']> {
		const prev = this.cache.state.appAds;
		const sameHosts = prev && prev.hosts.map(h => h.host).join(',') === cfg.appAdsHosts.join(',');
		const allFailed = prev ? prev.hosts.every(h => !h.md5) : false;
		if (prev && sameHosts && !force && this.now() - prev.checkedAt < (allFailed ? ADS_ERR_TTL : ADS_TTL)) return prev;
		const hosts = await Promise.all(
			cfg.appAdsHosts.map(async host => {
				try {
					const res = await this.fetch(`https://${host}/app-ads.txt`, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
					if (!res.ok) return { host, md5: null, error: `risponde ${res.status}` };
					const buf = Buffer.from(await res.arrayBuffer());
					return { host, md5: crypto.createHash('md5').update(buf).digest('hex') };
				} catch (e) {
					const m = (e as Error)?.message || String(e);
					return { host, md5: null, error: /abort|timeout/i.test(m) ? 'tempo scaduto' : 'non raggiungibile' };
				}
			}),
		);
		const md5s = hosts.map(h => h.md5);
		const identical = md5s.every(m => m && m === md5s[0]);
		return { checkedAt: this.now(), identical, hosts };
	}
}

/** Le regole deboli (solo il nome della variabile) valgono nei file di configurazione, e nel codice
 *  solo con un valore letterale tra virgolette che non sia un segnaposto. */
function weakCounts(file: string, match: string): boolean {
	const m = /[:=]\s*(["']?)([^\s"',}]*)/.exec(match);
	const quoted = !!m?.[1];
	const value = m?.[2] ?? '';
	if (/^(x{3,}|\*{3,}|<|your|changeme|placeholder|example|esempio|dummy|todo|null|undefined|none|false|true)/i.test(value)) return false;
	if (CONFIG_RE.test(file)) return !/^\$|^\{\{|process\.env/.test(value);
	return quoted;
}

function appAdsHits(a: RulesState['appAds']): RuleHit[] {
	if (!a || a.identical) return [];
	const ok = a.hosts.filter(h => h.md5);
	if (!ok.length) return []; // nessuno risponde: e' la rete, non il file
	const down = a.hosts.filter(h => !h.md5);
	return [
		{
			id: 'app-ads',
			livello: 'rosso',
			frase: down.length
				? `app-ads.txt non risponde su ${down.map(h => h.host).join(', ')}.`
				: `app-ads.txt non è identico sui ${a.hosts.length} siti.`,
			rimedio: `Copia la fonte di ${a.hosts[0].host} sugli altri siti e ripubblicali: devono essere identici byte per byte.`,
			dettagli: a.hosts.map(h => `${h.host}: ${h.md5 ? h.md5.slice(0, 8) : h.error ?? 'errore'}`),
		},
	];
}

function releaseHit(projectPath: string, radar: RadarState | undefined): RuleHit | null {
	const app = radar?.apps.find(a => a.projectPath === projectPath && a.version && STATI_RILASCIO.has(a.version.state));
	if (!app || !app.version || app.version.releaseType === 'AFTER_APPROVAL') return null;
	const how =
		app.version.releaseType === 'MANUAL'
			? 'con il rilascio manuale'
			: app.version.releaseType === 'SCHEDULED'
				? 'con il rilascio programmato'
				: 'senza rilascio automatico';
	return {
		id: 'rilascio',
		livello: 'rosso',
		frase: `La versione ${app.version.string} di ${app.name} è ${app.version.label} ${how}.`,
		rimedio: 'Mettila in rilascio automatico: uscirà da sola appena approvata.',
		azione: { act: 'rule.fix', label: 'Metti in rilascio automatico', args: { path: projectPath, rule: 'rilascio' } },
	};
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
