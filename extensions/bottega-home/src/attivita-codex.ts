/* Sessioni Codex osservate dai rollout locali. La lettura e' limitata a testa e coda dei JSONL:
   le righe con output degli strumenti possono contenere dati privati, e non servono alla Home. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentActivity } from './attivita-tipi';

const DEFAULT_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 256 * 1024;
// Un turno lungo puo' produrre megabyte di tool output dopo task_started. La coda corta basta
// quasi sempre; allarghiamo la lettura solo per le trascrizioni appena modificate ma senza stato.
const STATUS_TAIL_BYTES = [1024 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024];
const MAX_LINE = 128 * 1024;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 100;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT = new RegExp(`^rollout-.*-(${UUID})\\.jsonl$`, 'i');

type RecordLike = Record<string, any>;

function isRecord(value: unknown): value is RecordLike {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value: unknown, limit: number): string | undefined {
	if (typeof value !== 'string') return undefined;
	const line = value.split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith('<') && !s.startsWith('```'));
	if (!line) return undefined;
	// If a prompt/reply discusses credentials, suppress it entirely. A partial regex replacement could
	// expose an unfamiliar key format, so we deliberately lose some detail in these cases.
	if (/\b(?:api[ _-]?key|secret|token|password|passwd|credenzial[ei]|chiave|bearer|authorization|private[ _-]?key)\b|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16})\b|\.env\b/i.test(line)) return undefined;
	const clean = line.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
	return clean.length > limit ? clean.slice(0, limit - 1).trimEnd() + '…' : clean;
}

function messageText(payload: RecordLike): string | undefined {
	if (payload.type !== 'message' || !Array.isArray(payload.content)) return undefined;
	const part = payload.content.find((p: unknown) => isRecord(p) && (p.type === 'input_text' || p.type === 'output_text') && typeof p.text === 'string');
	return isRecord(part) ? part.text : undefined;
}

function stepOf(item: RecordLike): string | undefined {
	switch (item.type) {
		case 'CommandExecution': {
			const command = typeof item.command === 'string' ? item.command.trim().split(/\s+/)[0] : '';
			const safeCommand = /^(?:npm|pnpm|yarn|bun|git|swift|xcodebuild|pytest|python3?|node|rg|cargo|go|make|cmake|tsc|npx)$/i.test(command) ? command : '';
			return `Ha eseguito ${safeCommand || 'un comando'}`;
		}
		case 'FileChange': return 'Ha modificato file';
		case 'WebSearch': return 'Ha cercato sul web';
		case 'McpToolCall': return 'Ha usato uno strumento collegato';
		case 'SubAgentActivity': return 'Ha coordinato un agente';
		case 'Extension': return "Ha usato un'estensione";
		default: return undefined;
	}
}

function addStep(steps: string[], step: string): void {
	if (steps[steps.length - 1] !== step) steps.push(step);
	if (steps.length > 8) steps.shift();
}

/** Parser puro: tollera righe incomplete e varianti della trascrizione senza interpretare gli output. */
export function parseCodexRollout(head: string, tail: string, file: string, mtime: number, now = Date.now()): AgentActivity | undefined {
	const match = ROLLOUT.exec(path.basename(file));
	if (!match) return undefined;
	let id = match[1];
	let cwd: string | undefined;
	let parentId: string | undefined;
	let startedAt: number | undefined;
	let lastEventAt = 0;
	let prompt: string | undefined;
	let reply: string | undefined;
	let statusEvent: 'start' | 'complete' | 'abort' | undefined;
	const steps: string[] = [];

	const consume = (line: string, metaOnly: boolean): void => {
		if (!line.startsWith('{') || line.length > MAX_LINE) return;
		let row: RecordLike;
		try { row = JSON.parse(line); } catch { return; }
		if (!isRecord(row) || !isRecord(row.payload)) return;
		const p = row.payload;
		if (row.type === 'session_meta') {
			if (typeof p.id === 'string' && new RegExp(`^${UUID}$`, 'i').test(p.id) && !cwd) id = p.id;
			if (typeof p.cwd === 'string' && path.isAbsolute(p.cwd)) cwd = p.cwd;
			if (typeof p.parent_thread_id === 'string') parentId = p.parent_thread_id;
			const t = Date.parse(p.timestamp ?? row.timestamp ?? '');
			if (Number.isFinite(t) && t > 0 && !startedAt) startedAt = t;
		}
		if (metaOnly) return;
		const t = Date.parse(row.timestamp ?? '');
		if (Number.isFinite(t) && t > lastEventAt && t <= now + 60_000) lastEventAt = t;
		if (row.type === 'turn_context' && typeof p.cwd === 'string' && path.isAbsolute(p.cwd)) cwd = p.cwd;
		if (row.type === 'event_msg') {
			if (p.type === 'task_started') statusEvent = 'start';
			if (p.type === 'task_complete') statusEvent = 'complete';
			if (p.type === 'turn_aborted') statusEvent = 'abort';
			if (p.type === 'item_completed' && isRecord(p.item)) {
				const step = stepOf(p.item);
				if (step) addStep(steps, step);
			}
		}
		if (row.type === 'response_item' && p.type === 'message') {
			if (p.role === 'user') prompt = safeText(messageText(p), 140) ?? prompt;
			if (p.role === 'assistant' && p.phase === 'final_answer') reply = safeText(messageText(p), 180) ?? reply;
		}
	};

	for (const line of head.split('\n')) consume(line, true);
	for (const line of tail.split('\n')) consume(line, false);
	const updatedAt = lastEventAt || mtime;
	const status: AgentActivity['status'] = statusEvent === 'complete' ? 'finito' :
		statusEvent === 'start' && !!lastEventAt && now - lastEventAt <= ACTIVE_MS && now >= lastEventAt - 60_000 ? 'in corso' : 'sconosciuto';
	const project = cwd ? path.basename(cwd) : 'Progetto sconosciuto';
	const title = prompt ?? (parentId ? 'Attività di un agente Codex' : 'Sessione Codex');
	return {
		key: `codex:${id}`, source: 'codex', id, project,
		...(cwd ? { path: cwd } : {}), title, status, updatedAt,
		...(startedAt ? { startedAt } : {}),
		...(reply ? { summary: reply } : {}),
		...(steps.length ? { steps } : {}),
		evidence: statusEvent === 'complete' ? 'Codex: fine del turno nella trascrizione locale' :
			status === 'in corso' ? 'Codex: turno avviato e trascrizione aggiornata di recente' :
			'Codex: trascrizione locale; stato attuale non verificato',
	};
}

function readSegment(fd: number, size: number, offset: number, length: number): string {
	const bytes = Math.min(length, size - offset);
	if (bytes <= 0) return '';
	const buffer = Buffer.alloc(bytes);
	const count = fs.readSync(fd, buffer, 0, bytes, offset);
	return buffer.subarray(0, count).toString('utf8');
}

function readRollout(file: string, mtime: number, now: number): AgentActivity | undefined {
	let fd: number;
	try { fd = fs.openSync(file, 'r'); } catch { return undefined; }
	try {
		const size = fs.fstatSync(fd).size;
		const head = readSegment(fd, size, 0, HEAD_BYTES);
		const parseTail = (length: number): AgentActivity | undefined => {
			const offset = Math.max(0, size - length);
			let tail = readSegment(fd, size, offset, length);
			if (offset) tail = tail.slice(tail.indexOf('\n') + 1);
			if (!tail.endsWith('\n')) tail = tail.slice(0, tail.lastIndexOf('\n') + 1);
			return parseCodexRollout(head, tail, file, mtime, now);
		};
		let activity = parseTail(TAIL_BYTES);
		if (activity?.status === 'sconosciuto' && now - mtime <= ACTIVE_MS) {
			for (const length of STATUS_TAIL_BYTES) {
				activity = parseTail(length);
				if (activity?.status !== 'sconosciuto' || length >= size) break;
			}
		}
		return activity;
	} catch {
		return undefined;
	} finally {
		fs.closeSync(fd);
	}
}

/** Ultime sessioni Codex, incluse quelle degli agenti delegati. Nessun processo o transcript e' modificato. */
export function readCodexActivities(root = DEFAULT_ROOT, now = Date.now()): AgentActivity[] {
	const candidates: { file: string; mtime: number }[] = [];
	for (let days = 0; days <= 8; days++) {
		const day = new Date(now - days * 24 * 60 * 60 * 1000);
		const dir = path.join(root, String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0'));
		let names: string[];
		try { names = fs.readdirSync(dir); } catch { continue; }
		for (const name of names) {
			if (!ROLLOUT.test(name)) continue;
			const file = path.join(dir, name);
			try {
				const stat = fs.statSync(file);
				if (stat.isFile() && stat.mtimeMs >= now - RECENT_MS && stat.mtimeMs <= now + 60_000) candidates.push({ file, mtime: stat.mtimeMs });
			} catch { /* file removed between list and stat */ }
		}
	}
	return candidates.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS)
		.map(c => readRollout(c.file, c.mtime, now)).filter((a): a is AgentActivity => !!a)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}
