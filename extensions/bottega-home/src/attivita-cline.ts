/* Lettura sola delle attivita' Cline. Le sessioni SDK 4.x vivono in ~/.cline/data/sessions;
 * i task precedenti in ~/.cline/data/tasks o nel globalStorage dell'editor. Nessun file viene modificato.
 * Fonti: cline/cline sdk/packages/core/docs/messages-contract-v1.md e .clinerules/storage.md. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentActivity } from './attivita-tipi';

type Status = AgentActivity['status'];
type Json = Record<string, unknown>;
export interface ClineReadOptions {
	dataDir?: string;
	legacyRoots?: string[];
	maxAgeDays?: number;
	limit?: number;
	now?: number;
}

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 500;
const DEFAULT_DAYS = 45;

function object(value: unknown): Json | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function text(value: unknown, limit = 140): string | undefined {
	const s = string(value)?.replace(/\s+/g, ' ');
	return s ? s.slice(0, limit) : undefined;
}

function timestamp(value: unknown): number | undefined {
	const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function json(file: string): Promise<unknown | undefined> {
	try {
		const stat = await fs.promises.stat(file);
		if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return undefined;
		return JSON.parse(await fs.promises.readFile(file, 'utf8'));
	} catch {
		// Cline puo' sostituire il file fra stat e read; il giro seguente lo riprende.
		return undefined;
	}
}

async function dirs(root: string): Promise<string[]> {
	try {
		return (await fs.promises.readdir(root, { withFileTypes: true }))
			.filter(e => e.isDirectory() && !e.name.startsWith('.'))
			.map(e => e.name);
	} catch { return []; }
}

function activityStatus(raw: unknown, pid: unknown): Status {
	const s = string(raw)?.toLowerCase();
	if (s === 'failed' || s === 'error') return 'errore';
	if (s === 'completed' || s === 'complete' || s === 'finished' || s === 'cancelled' || s === 'canceled') return 'finito';
	if (s === 'waiting' || s === 'awaiting_input' || s === 'waiting_for_input' || s === 'paused') return 'ti aspetta';
	if (s === 'running' || s === 'active' || s === 'in_progress') {
		if (typeof pid !== 'number' || pid <= 0) return 'sconosciuto';
		try { process.kill(pid, 0); return 'in corso'; }
		catch (e: any) { return e?.code === 'EPERM' ? 'in corso' : 'sconosciuto'; }
	}
	return 'sconosciuto';
}

function project(cwd: unknown): { project: string; path?: string } {
	const p = string(cwd);
	if (!p || !path.isAbsolute(p)) return { project: 'Progetto non rilevato' };
	return { project: path.basename(p) || p, path: p };
}

function sdkSteps(messages: unknown): { summary?: string; steps: string[] } {
	if (!Array.isArray(messages)) return { steps: [] };
	const steps: string[] = [];
	let summary: string | undefined;
	for (const item of messages.slice(-80)) {
		const m = object(item);
		if (!m || !Array.isArray(m.content)) continue;
		for (const part of m.content) {
			const b = object(part);
			if (!b) continue;
			if (m.role === 'assistant' && b.type === 'tool_use') {
				const name = text(b.name, 60);
				if (name) steps.push(`Strumento: ${name}`);
			} else if (m.role === 'assistant' && b.type === 'text') {
				const line = text(b.text, 220);
				if (line) { summary = line; steps.push(line); }
			}
		}
	}
	return { summary, steps: steps.slice(-5) };
}

async function sdkActivities(dataDir: string, cutoff: number, limit: number): Promise<AgentActivity[]> {
	const root = path.join(dataDir, 'sessions');
	const names = (await dirs(root)).filter(n => /^[a-zA-Z0-9_-]{5,100}$/.test(n));
	const ranked: { name: string; mtime: number }[] = [];
	for (const name of names) {
		try {
			const dir = path.join(root, name);
			const st = await fs.promises.stat(path.join(dir, `${name}.json`));
			if (!st.isFile()) continue;
			const messagesMtime = await fs.promises.stat(path.join(dir, `${name}.messages.json`)).then(s => s.mtimeMs, () => 0);
			const mtime = Math.max(st.mtimeMs, messagesMtime);
			if (mtime >= cutoff) ranked.push({ name, mtime });
		} catch { /* file mancante */ }
	}
	ranked.sort((a, b) => b.mtime - a.mtime);
	const out: AgentActivity[] = [];
	for (const { name, mtime } of ranked.slice(0, limit)) {
		const dir = path.join(root, name);
		const metaFile = path.join(dir, `${name}.json`);
		const d = object(await json(metaFile));
		if (!d || string(d.session_id) !== name) continue;
		const messagesFile = path.join(dir, `${name}.messages.json`);
		const transcript = object(await json(messagesFile));
		const detail = transcript?.version === 1 ? sdkSteps(transcript.messages) : { steps: [] as string[], summary: undefined };
		const updatedAt = timestamp(d.updated_at) ?? timestamp(transcript?.updated_at) ?? timestamp(d.ended_at) ?? mtime;
		if (updatedAt < cutoff) continue;
		const cwd = d.workspace_root ?? d.cwd;
		out.push({
			key: `cline:${name}`, source: 'cline', id: name, ...project(cwd),
			title: text(d.prompt, 120) ?? 'Sessione Cline',
			status: activityStatus(d.status, d.pid),
			updatedAt,
			...(timestamp(d.started_at) ? { startedAt: timestamp(d.started_at) } : {}),
			...(detail.summary ? { summary: detail.summary } : {}),
			...(detail.steps.length ? { steps: detail.steps } : {}),
			evidence: `Cline SDK: ${metaFile}${transcript ? `; ${messagesFile}` : ''}`,
		});
	}
	return out;
}

function legacySteps(value: unknown): { summary?: string; steps: string[]; status: Status } {
	if (!Array.isArray(value)) return { steps: [], status: 'sconosciuto' };
	const steps: string[] = [];
	let summary: string | undefined;
	let status: Status = 'sconosciuto';
	for (const entry of value.slice(-80)) {
		const m = object(entry);
		if (!m) continue;
		if (m.type === 'say' && m.say === 'completion_result') {
			status = 'finito';
			const line = text(m.text, 220);
			if (line) { summary = line; steps.push(line); }
		} else if (m.type === 'ask' && m.ask === 'api_req_failed') {
			status = 'errore';
			steps.push('Richiesta al modello fallita');
		} else if (m.type === 'ask' && typeof m.ask === 'string') {
			// Un ask salvato non prova che un task storico aspetti ancora oggi.
			status = 'sconosciuto';
			steps.push(`Richiesta: ${text(m.ask, 60)}`);
		} else if (m.type === 'say' && m.say === 'text') {
			const line = text(m.text, 160);
			if (line) { summary = line; steps.push(line); }
		} else if (m.type === 'say' && m.say === 'command') {
			steps.push('Comando nel terminale');
		}
	}
	return { summary, steps: steps.slice(-5), status };
}

async function legacyActivities(root: string, cutoff: number, limit: number): Promise<AgentActivity[]> {
	const historyFile = path.join(root, 'tasks', 'taskHistory.json');
	const history = await json(historyFile);
	const rows = Array.isArray(history) ? history : Array.isArray(object(history)?.taskHistory) ? object(history)!.taskHistory as unknown[] : [];
	const ranked = rows.map(object).filter((r): r is Json => !!r && !!string(r.id))
		.filter(r => (timestamp(r.ts) ?? 0) >= cutoff)
		.sort((a, b) => (timestamp(b.ts) ?? 0) - (timestamp(a.ts) ?? 0)).slice(0, limit);
	const out: AgentActivity[] = [];
	for (const r of ranked) {
		const id = string(r.id)!;
		if (!/^[a-zA-Z0-9_-]{5,100}$/.test(id)) continue;
		const uiFile = path.join(root, 'tasks', id, 'ui_messages.json');
		const detail = legacySteps(await json(uiFile));
		const cwd = r.cwdOnTaskInitialization ?? r.cwd;
		out.push({
			key: `cline:${id}`, source: 'cline', id, ...project(cwd),
			title: text(r.task, 120) ?? 'Task Cline',
			status: detail.status,
			updatedAt: timestamp(r.ts)!,
			...(detail.summary ? { summary: detail.summary } : {}),
			...(detail.steps.length ? { steps: detail.steps } : {}),
			evidence: `Cline legacy: ${historyFile}${await fs.promises.access(uiFile).then(() => true, () => false) ? `; ${uiFile}` : ''}`,
		});
	}
	return out;
}

function defaultLegacyRoots(): string[] {
	const home = os.homedir();
	if (process.platform === 'darwin') return ['Bottega', 'Code', 'Code - Insiders', 'VSCodium'].map(app => path.join(home, 'Library', 'Application Support', app, 'User', 'globalStorage', 'saoudrizwan.claude-dev'));
	if (process.platform === 'win32') return ['Code', 'Code - Insiders', 'VSCodium'].map(app => path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), app, 'User', 'globalStorage', 'saoudrizwan.claude-dev'));
	return ['Code', 'Code - Insiders', 'VSCodium'].map(app => path.join(home, '.config', app, 'User', 'globalStorage', 'saoudrizwan.claude-dev'));
}

/** Stato osservato nei file di Cline. Gli stati storici senza segnale esplicito restano `sconosciuto`. */
export async function readClineActivities(options: ClineReadOptions = {}): Promise<AgentActivity[]> {
	const now = options.now ?? Date.now();
	const days = Math.max(1, Math.min(options.maxAgeDays ?? DEFAULT_DAYS, 3650));
	const limit = Math.max(1, Math.min(options.limit ?? MAX_ENTRIES, MAX_ENTRIES));
	const cutoff = now - days * 86_400_000;
	const dataDir = options.dataDir ?? process.env.CLINE_DATA_DIR?.trim() ?? path.join(os.homedir(), '.cline', 'data');
	const roots = [...new Set([dataDir, ...(options.legacyRoots ?? defaultLegacyRoots())])];
	const groups = await Promise.all([sdkActivities(dataDir, cutoff, limit), ...roots.map(root => legacyActivities(root, cutoff, limit))]);
	const byKey = new Map<string, AgentActivity>();
	for (const item of groups.flat()) {
		const prior = byKey.get(item.key);
		const sdk = item.evidence.startsWith('Cline SDK');
		const priorSdk = prior?.evidence.startsWith('Cline SDK');
		if (!prior || (sdk && !priorSdk) || (sdk === priorSdk && item.updatedAt > prior.updatedAt)) byKey.set(item.key, item);
	}
	return [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
