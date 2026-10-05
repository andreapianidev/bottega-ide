/* Inventario locale + GitHub + Vercel. Le associazioni sono dati locali, non operazioni git/deploy. */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Project } from './scan';
import type { Client } from './clienti';
import type { VercelState, VercelProject } from './tipi';
import { repoGithub } from './vercel';

export interface GithubRepo {
	repo: string;
	branch: string;
	pushedAt: number;
	private: boolean;
	archived: boolean;
}
export interface GithubState { repos: GithubRepo[]; at: number; error?: string; partial?: boolean; refreshing?: boolean }
export interface StackAsset {
	id: string;
	name: string;
	path?: string;
	repo?: string;
	github?: GithubRepo;
	git?: Project['git'];
	vercel: VercelProject[];
	clientId?: string;
	conflict?: boolean;
}
export interface StackState { assets: StackAsset[]; githubAt: number; githubError?: string; vercelAt: number; vercelError?: string; partial: boolean }

const validRepo = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(s);
export function cleanGithubRepo(r: any): GithubRepo | undefined {
	if (!validRepo(r?.full_name)) return undefined;
	return { repo: r.full_name.toLowerCase(), branch: String(r.default_branch ?? ''),
		pushedAt: Date.parse(r.pushed_at) || 0, private: r.private === true, archived: r.archived === true };
}

/** La CLI conserva l'autenticazione. Nessun token viene letto o copiato. */
export class GithubInventory {
	private value: GithubState = { repos: [], at: 0 };
	private tried = 0;
	private running?: Promise<GithubState>;
	constructor(private readonly file = path.join(os.homedir(), '.bottega', 'github-stack.json'),
		private readonly read: (page: number) => Promise<any[]> = page => new Promise((resolve, reject) => {
			execFile('gh', ['api', '--method', 'GET', `/user/repos?per_page=100&sort=pushed&page=${page}`],
				{ timeout: 20_000, maxBuffer: 12 << 20, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com', PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` } },
				(err, out) => {
					if (err) return reject(new Error('GitHub non disponibile: verifica la rete e gh auth status sul Mac.'));
					try { const d = JSON.parse(out); if (!Array.isArray(d)) throw new Error(); resolve(d); }
					catch { reject(new Error('GitHub ha risposto in un formato inatteso.')); }
				});
		}), private readonly now = Date.now) {
		try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d.version === 1 && Array.isArray(d.state?.repos)) this.value = d.state; } catch { /* prima lettura */ }
	}
	state(): GithubState { return { ...this.value, refreshing: !!this.running }; }
	refresh(force = false): Promise<GithubState> {
		if (this.running) return this.running;
		if (this.now() - this.tried < (force ? 60_000 : 15 * 60_000)) return Promise.resolve(this.state());
		this.tried = this.now();
		this.running = (async () => {
			try {
				const all = new Map<string, GithubRepo>();
				let partial = false;
				for (let page = 1; page <= 10; page++) {
					const rows = await this.read(page);
					for (const row of rows) { const r = cleanGithubRepo(row); if (r) all.set(r.repo, r); }
					if (rows.length < 100) break;
					if (page === 10) partial = true;
				}
				this.value = { repos: [...all.values()], at: this.now(), partial };
				fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
				fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 1, state: this.value }), { mode: 0o600 });
				fs.renameSync(this.file + '.tmp', this.file);
			} catch { this.value.error = 'GitHub non disponibile: verifica la rete e gh auth status sul Mac. Ultimo inventario conservato.'; }
		})().then(() => { this.running = undefined; return this.state(); });
		return this.running;
	}
}

export function buildStack(projects: Pick<Project, 'name' | 'path' | 'git'>[], clients: Client[], vercel?: VercelState, github?: GithubState): StackState {
	const repos = new Map((github?.repos ?? []).map(r => [r.repo, r]));
	const catalog = vercel?.catalog ?? [];
	const assets: StackAsset[] = projects.map(p => {
		const repo = repoGithub(p.path);
		return { id: p.path, name: p.name, path: p.path, repo, github: repo ? repos.get(repo) : undefined, git: p.git,
			vercel: catalog.filter(v => v.localPaths.includes(p.path) || (!v.localPaths.length && repo && v.repo === repo)) };
	});
	for (const v of catalog) {
		if (assets.some(a => a.vercel.some(s => s.id === v.id))) continue;
		assets.push({ id: `vercel:${v.id}`, name: v.name, repo: v.repo, github: v.repo ? repos.get(v.repo) : undefined, vercel: [v] });
	}
	for (const r of repos.values()) {
		if (!assets.some(a => a.repo === r.repo)) assets.push({ id: `github:${r.repo}`, name: r.repo, repo: r.repo, github: r, vercel: [] });
	}
	for (const a of assets) {
		const keys = new Set([a.id, ...(a.repo ? [`github:${a.repo}`] : []), ...a.vercel.map(v => `vercel:${v.id}`)]);
		const owners = clients.filter(c => c.progetti.some(p => keys.has(p)));
		if (owners.length === 1) a.clientId = owners[0].id;
		if (owners.length > 1) a.conflict = true;
	}
	return { assets, githubAt: github?.at ?? 0, githubError: github?.error, vercelAt: vercel?.catalogAt ?? 0,
		vercelError: vercel?.catalogError ?? vercel?.error, partial: !!(github?.partial || vercel?.catalogPartial) };
}
