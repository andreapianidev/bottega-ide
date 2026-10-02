/* «Dove l'ho gia' risolto?»: ricerca per significato nella Memoria (vettori del Nucleo, gia' nel database)
   piu' una ricerca testuale veloce nel codice di tutti i progetti (ripgrep se c'e', altrimenti git grep).
   Contratto: docs/CONTRATTI.md, 4.2 (ricerca). */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { MemoryItem } from './memoria';

export interface CodeHit {
	project: string;
	projectPath: string;
	file: string;
	line: number;
	text: string;
}

export interface SearchResult {
	query: string;
	memoria: MemoryItem[];
	codice: CodeHit[];
	ms: number;
	error?: string;
}

const MAX_HITS = 60;
const PER_PROJECT = 8;
const EXCLUDE = ['node_modules', 'vendor', 'build', 'dist', 'out', 'DerivedData', 'Pods', '.build', '.next', 'test-out', '*.min.js', '*.map', '*.lock', 'package-lock.json', '*.xcstrings', '*.pbxproj'];

let rgPath: string | null | undefined;
function findRg(): string | null {
	if (rgPath !== undefined) return rgPath;
	for (const p of ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', ...(process.env.PATH ?? '').split(':').map(d => path.join(d, 'rg'))]) {
		try {
			fs.accessSync(p, fs.constants.X_OK);
			return (rgPath = p);
		} catch {
			// avanti
		}
	}
	return (rgPath = null);
}

function run(cmd: string, args: string[], cwd?: string, timeout = 6000): Promise<string> {
	return new Promise(resolve => {
		execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => resolve(stdout || ''));
	});
}

/** Le parole che vale la pena cercare da sole: le piu' lunghe, senza articoli e preposizioni. */
const STOP = new Set(['come', 'dove', 'quando', 'perche', 'perché', 'della', 'delle', 'degli', 'dello', 'nella', 'nelle', 'sulla', 'sulle', 'con', 'per', 'che', 'una', 'uno', 'gli', 'the', 'and', 'with', 'from']);
export function keyWords(q: string): string[] {
	return [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(w => w.length >= 4 && !STOP.has(w)))].sort((a, b) => b.length - a.length);
}

function owner(file: string, projects: { name: string; path: string }[]): { name: string; path: string } | undefined {
	let best: { name: string; path: string } | undefined;
	for (const p of projects) if (file.startsWith(p.path + '/') && (!best || p.path.length > best.path.length)) best = p;
	return best;
}

async function rgSearch(rg: string, needle: string, projects: { name: string; path: string }[]): Promise<CodeHit[]> {
	const args = ['--json', '-i', '-F', '--max-count', '3', '--max-filesize', '1M', '--max-columns', '400', '--max-columns-preview'];
	for (const e of EXCLUDE) args.push('--glob', `!${e}`);
	args.push('--', needle, ...projects.map(p => p.path));
	const out = await run(rg, args);
	const hits: CodeHit[] = [];
	for (const line of out.split('\n')) {
		if (!line.startsWith('{"type":"match"')) continue;
		try {
			const d = JSON.parse(line).data;
			const file = d.path?.text as string;
			const p = file && owner(file, projects);
			if (!p) continue;
			hits.push({ project: p.name, projectPath: p.path, file: file.slice(p.path.length + 1), line: d.line_number, text: String(d.lines?.text ?? '').trim().slice(0, 300) });
		} catch {
			// riga troncata
		}
		if (hits.length >= MAX_HITS * 4) break;
	}
	return hits;
}

async function gitGrep(needle: string, projects: { name: string; path: string }[]): Promise<CodeHit[]> {
	const hits: CodeHit[] = [];
	for (const p of projects) {
		if (hits.length >= MAX_HITS) break;
		if (!fs.existsSync(path.join(p.path, '.git'))) continue;
		const out = await run('git', ['grep', '-n', '-i', '-F', '-I', '--max-count', '3', '-e', needle, '--', '.', ...EXCLUDE.map(e => `:!${e.includes('*') ? e : '**/' + e + '/**'}`)], p.path, 3000);
		for (const l of out.split('\n')) {
			const m = /^([^:]+):(\d+):(.*)$/.exec(l);
			if (m) hits.push({ project: p.name, projectPath: p.path, file: m[1], line: +m[2], text: m[3].trim().slice(0, 300) });
			if (hits.length >= MAX_HITS) break;
		}
	}
	return hits;
}

/** Cerca nel codice: prima la frase intera, poi (se trova poco) la parola piu' significativa. */
export async function searchCode(query: string, projects: { name: string; path: string }[]): Promise<CodeHit[]> {
	const q = query.trim();
	if (q.length < 3 || !projects.length) return [];
	const rg = findRg();
	const go = (needle: string) => (rg ? rgSearch(rg, needle, projects) : gitGrep(needle, projects));
	let hits = await go(q);
	const words = keyWords(q);
	if (hits.length < 5 && words.length && words[0] !== q.toLowerCase()) {
		const seen = new Set(hits.map(h => h.projectPath + h.file + h.line));
		for (const h of await go(words[0])) if (!seen.has(h.projectPath + h.file + h.line)) hits.push(h);
	}
	// prima i progetti con piu' risultati, poi per file
	const per = new Map<string, number>();
	for (const h of hits) per.set(h.projectPath, (per.get(h.projectPath) ?? 0) + 1);
	// al massimo 8 righe per progetto: un progetto con tanta documentazione non deve coprire tutti gli altri
	const shown = new Map<string, number>();
	hits = hits.filter(h => {
		const n = (shown.get(h.projectPath) ?? 0) + 1;
		shown.set(h.projectPath, n);
		return n <= PER_PROJECT;
	});
	hits = hits.sort((a, b) => (per.get(b.projectPath)! - per.get(a.projectPath)!) || a.projectPath.localeCompare(b.projectPath) || a.file.localeCompare(b.file) || a.line - b.line);
	return hits.slice(0, MAX_HITS);
}

export async function whereSolved(
	query: string,
	projects: { name: string; path: string }[],
	memoria: (q: string) => Promise<MemoryItem[]>,
): Promise<SearchResult> {
	const t0 = Date.now();
	const [mem, code] = await Promise.allSettled([memoria(query), searchCode(query, projects)]);
	const errors: string[] = [];
	if (mem.status === 'rejected') errors.push('la memoria non risponde');
	if (code.status === 'rejected') errors.push('la ricerca nel codice non è riuscita');
	return {
		query,
		memoria: mem.status === 'fulfilled' ? mem.value : [],
		codice: code.status === 'fulfilled' ? code.value : [],
		ms: Date.now() - t0,
		...(errors.length ? { error: errors.join(' e ') } : {}),
	};
}
