import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LiveSession, PastSession } from './claude';

export type Kind = 'apple' | 'web' | 'android' | 'python' | 'swiftpm' | 'docs' | 'altro';

export interface Project {
	name: string;
	path: string;
	root: string;
	kinds: Kind[];
	git?: {
		branch: string;
		ahead: number;
		behind: number;
		upstream: boolean;
		changes: number;
		lastCommitAt: number;
		lastCommitSubject: string;
	};
	build?: { marketing?: string; number?: string; source: string };
	hasClaudeMd: boolean;
	xcodeProject?: string;
	sessions: PastSession[];
	live: LiveSession[];
	/** Ultimo momento in cui qualcuno (commit, file, Claude) ha toccato il progetto. */
	touchedAt: number;
	/** Worktree git di questo repository che stanno sotto le radici: non sono progetti a se', stanno qui. */
	worktrees?: { path: string; branch: string; changes: number; ahead: number; upstream: boolean }[];
}

export function expand(p: string): string {
	return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function run(cwd: string, args: string[]): Promise<string> {
	return new Promise(resolve => {
		execFile('git', args, { cwd, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
	});
}

async function gitInfo(dir: string): Promise<Project['git']> {
	const status = await run(dir, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
	if (!status) {
		return undefined;
	}
	let branch = '?';
	let ahead = 0;
	let behind = 0;
	let upstream = false;
	let changes = 0;
	for (const line of status.split('\n')) {
		if (line.startsWith('# branch.head ')) {
			branch = line.slice(14);
		} else if (line.startsWith('# branch.upstream ')) {
			upstream = true;
		} else if (line.startsWith('# branch.ab ')) {
			const m = /\+(\d+) -(\d+)/.exec(line);
			if (m) {
				ahead = +m[1];
				behind = +m[2];
			}
		} else if (line && !line.startsWith('#')) {
			changes++;
		}
	}
	const log = (await run(dir, ['log', '-1', '--format=%ct%x09%s'])).trim();
	const [ct, ...subj] = log.split('\t');
	return { branch, ahead, behind, upstream, changes, lastCommitAt: (+ct || 0) * 1000, lastCommitSubject: subj.join('\t') };
}

function list(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

function detect(dir: string): { kinds: Kind[]; xcodeProject?: string } {
	const top = list(dir);
	const kinds = new Set<Kind>();
	let xcodeProject: string | undefined;
	const look = (entries: string[], base: string) => {
		for (const e of entries) {
			if (e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace')) {
				kinds.add('apple');
				if (!xcodeProject || e.endsWith('.xcworkspace')) {
					xcodeProject = path.join(base, e);
				}
			}
			if (e === 'Package.swift') kinds.add('swiftpm');
			if (e === 'package.json' || e === 'next.config.js' || e === 'next.config.ts' || e === 'vite.config.ts' || e === 'index.html') kinds.add('web');
			if (e === 'build.gradle' || e === 'build.gradle.kts' || e === 'settings.gradle.kts') kinds.add('android');
			if (e === 'pyproject.toml' || e === 'requirements.txt') kinds.add('python');
		}
	};
	look(top, dir);
	// Molti progetti Xcode stanno un livello sotto (Fontanelle/Fontanelle.xcodeproj e simili).
	if (!kinds.size) {
		for (const e of top) {
			if (e.startsWith('.') || e === 'node_modules') continue;
			const sub = path.join(dir, e);
			try {
				if (fs.statSync(sub).isDirectory()) look(list(sub), sub);
			} catch {
				// collegamento rotto
			}
		}
	}
	if (!kinds.size && top.some(e => e.endsWith('.md'))) kinds.add('docs');
	if (!kinds.size) kinds.add('altro');
	return { kinds: [...kinds], xcodeProject };
}

function readBuild(dir: string, xcodeProject?: string): Project['build'] {
	if (xcodeProject) {
		const proj = xcodeProject.endsWith('.xcworkspace')
			? list(path.dirname(xcodeProject)).filter(e => e.endsWith('.xcodeproj')).map(e => path.join(path.dirname(xcodeProject), e))[0]
			: xcodeProject;
		if (proj) {
			try {
				const pbx = fs.readFileSync(path.join(proj, 'project.pbxproj'), 'utf8');
				const number = /CURRENT_PROJECT_VERSION = ([^;]+);/.exec(pbx)?.[1]?.replace(/"/g, '');
				const marketing = /MARKETING_VERSION = ([^;]+);/.exec(pbx)?.[1]?.replace(/"/g, '');
				if (number || marketing) return { number, marketing, source: 'xcode' };
			} catch {
				// progetto senza pbxproj leggibile
			}
		}
	}
	for (const g of ['app/build.gradle.kts', 'app/build.gradle']) {
		try {
			const s = fs.readFileSync(path.join(dir, g), 'utf8');
			const number = /versionCode\s*=?\s*(\d+)/.exec(s)?.[1];
			const marketing = /versionName\s*=?\s*"([^"]+)"/.exec(s)?.[1];
			if (number || marketing) return { number, marketing, source: 'android' };
		} catch {
			// non e' un progetto Android
		}
	}
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
		if (pkg.version) return { marketing: pkg.version, source: 'npm' };
	} catch {
		// nessun package.json
	}
	return undefined;
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

const norm = (p: string) => p.toLowerCase().replace(/\/+$/, '');

/** Chiave di confronto di una cartella di progetto: minuscole, con la barra finale. */
export const projectKey = (p: string) => norm(p) + '/';

/** Se `dir` e' un worktree git (.git e' un FILE "gitdir: <repo>/.git/worktrees/<nome>"), il repository principale.
 *  Stessa regola di memoria/lib/paths.mjs. */
export function worktreeMain(dir: string): string | undefined {
	try {
		const g = path.join(dir, '.git');
		if (!fs.statSync(g).isFile()) return undefined;
		return /^gitdir:\s*(.+?)\/\.git\/worktrees\/[^/\n]+\s*$/m.exec(fs.readFileSync(g, 'utf8'))?.[1];
	} catch {
		return undefined;
	}
}

/** Worktree conosciuti: chiave del worktree -> chiave del repository principale. Li riempie scanProjects. */
const aliases = new Map<string, string>();

/** Chiave di un percorso con i worktree ricondotti al progetto principale: una sessione che lavora in
 *  Bottega-idee e' una sessione di Bottega, per la plancia, il cruscotto e la memoria. */
export function canonKey(p: string): string {
	const k = projectKey(p);
	for (const [a, m] of aliases) if (k.startsWith(a)) return m + k.slice(a.length);
	return k;
}

/** A quale progetto appartiene una sessione: quello della cartella di partenza, altrimenti quello
 *  in cui ha toccato piu' cartelle e file (almeno due). La usano la plancia e il cruscotto, cosi'
 *  una sessione finisce nello stesso progetto in tutte e due. `keys` sono chiavi di `projectKey`. */
export function sessionOwner(keys: string[], cwd: string, touched: Iterable<string>): string | undefined {
	const start = keys.find(k => canonKey(cwd).startsWith(k));
	if (start) return start;
	const hits = new Map<string, number>();
	for (const t of touched) {
		const k = keys.find(k => canonKey(t).startsWith(k));
		if (k) hits.set(k, (hits.get(k) ?? 0) + 1);
	}
	const best = [...hits].sort((a, b) => b[1] - a[1])[0];
	return best && best[1] >= 2 ? best[0] : undefined;
}

export async function scanProjects(roots: string[], ignore: string[], past: PastSession[], live: LiveSession[]): Promise<Project[]> {
	const ignoreRe = ignore.map(s => new RegExp(s, 'i'));
	const seen = new Set<string>();
	const candidates: { name: string; path: string; root: string }[] = [];
	const worktrees: { path: string; main: string }[] = [];
	for (const r of roots.map(expand)) {
		for (const name of list(r)) {
			if (ignoreRe.some(re => re.test(name))) continue;
			const p = path.join(r, name);
			try {
				if (!fs.statSync(p).isDirectory()) continue;
			} catch {
				continue;
			}
			const key = norm(fs.realpathSync(p));
			if (seen.has(key)) continue;
			seen.add(key);
			const main = worktreeMain(p);
			if (main && norm(main) !== norm(p)) {
				worktrees.push({ path: p, main });
				continue;
			}
			candidates.push({ name, path: p, root: r });
		}
	}

	// Un worktree il cui repository principale e' tra i progetti diventa un ramo di quel progetto;
	// gli altri (principale fuori dalle radici) restano progetti come prima.
	aliases.clear();
	const byKey = new Map(candidates.map(c => [projectKey(c.path), c]));
	for (const w of worktrees) {
		const main = byKey.get(projectKey(w.main)) ?? candidates.find(c => projectKey(fs.realpathSync(c.path)) === projectKey(w.main));
		if (main) aliases.set(projectKey(w.path), projectKey(main.path));
		else candidates.push({ name: path.basename(w.path), path: w.path, root: path.dirname(w.path) });
	}

	// Ogni sessione va a un solo progetto: quello della cartella di partenza, altrimenti
	// quello in cui ha toccato piu' cartelle e file.
	const keys = candidates.map(c => projectKey(c.path));
	const owner = new Map<string, string>();
	for (const s of past) {
		const k = sessionOwner(keys, s.cwd, s.touched);
		if (k) owner.set(s.sessionId, k);
	}

	const projects = await pool(candidates, 6, async c => {
		const { kinds, xcodeProject } = detect(c.path);
		const git = await gitInfo(c.path);
		const key = norm(c.path) + '/';
		const sessions = past.filter(s => owner.get(s.sessionId) === key);
		const liveHere = live.filter(s => canonKey(s.cwd).startsWith(key) || owner.get(s.sessionId) === key);
		let mtime = 0;
		try {
			mtime = fs.statSync(c.path).mtimeMs;
		} catch {
			// cartella sparita tra listing e stat
		}
		const project: Project = {
			...c,
			kinds,
			git,
			build: readBuild(c.path, xcodeProject),
			hasClaudeMd: fs.existsSync(path.join(c.path, 'CLAUDE.md')),
			xcodeProject,
			sessions,
			live: liveHere,
			touchedAt: Math.max(git?.lastCommitAt ?? 0, sessions[0]?.mtime ?? 0, mtime),
		};
		const mine = worktrees.filter(w => aliases.get(projectKey(w.path)) === key);
		if (mine.length) {
			project.worktrees = await Promise.all(
				mine.map(async w => {
					const g = await gitInfo(w.path);
					return { path: w.path, branch: g?.branch ?? path.basename(w.path), changes: g?.changes ?? 0, ahead: g?.ahead ?? 0, upstream: !!g?.upstream };
				}),
			);
		}
		return project;
	});
	return projects.sort((a, b) => b.touchedAt - a.touchedAt);
}
