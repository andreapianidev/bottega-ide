/* Terminali integrati osservati con la shell integration di VS Code. Solo eventi ricevuti dopo
   l'attivazione possono provare che un comando sia in corso e permettere la lettura dell'output. */

import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentActivity } from './attivita-tipi';

const MAX_TERMINALS = 30;
const MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_PENDING = 512;
const MAX_CLOSED_MS = 10 * 60_000;
const OUTPUT_DEBOUNCE_MS = 250;

export interface TerminalActivityDetail {
	activity: AgentActivity;
	/** Solo il testo catturato dopo onDidStartTerminalShellExecution, gia' redatto. */
	output: string;
	captured: boolean;
	truncated: boolean;
}

export interface TerminalActivityMonitor {
	activities(): AgentActivity[];
	detail(key: string): TerminalActivityDetail | undefined;
	dispose(): void;
}

interface Entry {
	terminal: vscode.Terminal;
	key: string;
	startedAt: number;
	updatedAt: number;
	closedAt?: number;
	project: string;
	cwd?: string;
	title: string;
	status: AgentActivity['status'];
	evidence: string;
	steps: string[];
	output: string;
	pending: string;
	lineOverflow: boolean;
	privateBlock: boolean;
	captured: boolean;
	truncated: boolean;
	execution?: vscode.TerminalShellExecution;
	iterator?: AsyncIterator<string>;
	generation: number;
}

const sensitive = /\b(?:api[ _-]?key|secret|token|password|passwd|credenzial[ei]|chiave|bearer|authorization|private[ _-]?key)\b|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16})\b|[A-Za-z0-9+/_-]{32,}|\.env\b/i;

/** Aggressive by design: a line containing a likely credential is omitted rather than partially masked. */
export function redactTerminalLine(line: string): string {
	const clean = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trimEnd();
	if (sensitive.test(clean) || /\bexport\s+\w+\s*=/.test(clean) || /:\/\/[^\s/@]+:[^\s/@]+@/.test(clean)) return '[riga riservata omessa]';
	return clean.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]');
}

function safeCommand(raw: string | undefined): string {
	if (!raw?.trim()) return 'Comando nel terminale';
	const line = raw.replace(/\s+/g, ' ').trim();
	if (sensitive.test(line) || /\bexport\s+\w+\s*=/.test(line) || /:\/\/[^\s/@]+:[^\s/@]+@/.test(line)) return 'Comando riservato';
	const clean = line.replace(/https?:\/\/[^\s?#]+\?[^\s]+/gi, '[indirizzo con parametri]').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]');
	return clean.length > 140 ? clean.slice(0, 139) + '…' : clean;
}

function cwdOf(t: vscode.Terminal, execution?: vscode.TerminalShellExecution): string | undefined {
	const uri = execution?.cwd ?? t.shellIntegration?.cwd;
	if (uri?.scheme === 'file' && uri.fsPath) return uri.fsPath;
	const raw = (t.creationOptions as vscode.TerminalOptions).cwd;
	if (typeof raw === 'string' && path.isAbsolute(raw)) return raw;
	if (raw && typeof raw !== 'string' && raw.scheme === 'file' && raw.fsPath) return raw.fsPath;
	return undefined;
}

function toActivity(e: Entry): AgentActivity {
	return {
		key: e.key, source: 'terminale', id: e.key.slice('terminale:'.length),
		project: e.project, ...(e.cwd ? { path: e.cwd } : {}), title: e.title,
		status: e.status, updatedAt: e.updatedAt, startedAt: e.startedAt,
		...(e.steps.length ? { steps: [...e.steps] } : {}), evidence: e.evidence,
	};
}

/** Attiva il monitor per i terminali della finestra. `onChange` e' aggregato a 250 ms. */
export function registerTerminalActivity(ctx: vscode.ExtensionContext, onChange?: () => void): TerminalActivityMonitor {
	const entries = new Map<vscode.Terminal, Entry>();
	let sequence = 0;
	let disposed = false;
	let changeTimer: ReturnType<typeof setTimeout> | undefined;
	const listeners: vscode.Disposable[] = [];
	const changed = () => {
		if (!onChange || disposed || changeTimer) return;
		changeTimer = setTimeout(() => {
			changeTimer = undefined;
			if (!disposed) onChange();
		}, OUTPUT_DEBOUNCE_MS);
	};
	const stopReading = (e: Entry) => {
		e.generation++;
		const it = e.iterator;
		e.iterator = undefined;
		if (it?.return) void Promise.resolve(it.return()).catch(() => {});
	};
	const trim = () => {
		const now = Date.now();
		for (const [t, e] of entries) if (e.closedAt && now - e.closedAt > MAX_CLOSED_MS) entries.delete(t);
		while (entries.size > MAX_TERMINALS) {
			const oldest = [...entries.values()].sort((a, b) => (a.closedAt ? 0 : 1) - (b.closedAt ? 0 : 1) || a.updatedAt - b.updatedAt)[0];
			if (!oldest) break;
			stopReading(oldest);
			entries.delete(oldest.terminal);
		}
	};
	const add = (t: vscode.Terminal): Entry => {
		const previous = entries.get(t);
		if (previous) return previous;
		const now = Date.now();
		const cwd = cwdOf(t);
		const entry: Entry = {
			terminal: t, key: `terminale:${++sequence}`, startedAt: now, updatedAt: now,
			project: cwd ? path.basename(cwd) : 'Cartella sconosciuta', cwd,
			title: safeCommand(t.name), status: 'sconosciuto',
			evidence: 'Terminale aperto; nessun comando osservato dalla shell integration',
			steps: [], output: '', pending: '', lineOverflow: false, privateBlock: false,
			captured: false, truncated: false, generation: 0,
		};
		entries.set(t, entry);
		trim();
		changed();
		return entry;
	};
	const appendLine = (e: Entry) => {
		let line: string;
		if (e.lineOverflow) line = '[riga lunga omessa]';
		else if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(e.pending)) {
			e.privateBlock = true;
			line = '[blocco privato omesso]';
		} else if (e.privateBlock) {
			line = '';
			if (/-----END [^-]*PRIVATE KEY-----/.test(e.pending)) e.privateBlock = false;
		} else line = redactTerminalLine(e.pending);
		e.pending = '';
		e.lineOverflow = false;
		if (line) {
			const next = e.output + line + '\n';
			const bytes = Buffer.from(next, 'utf8');
			if (bytes.length > MAX_OUTPUT_BYTES - MAX_PENDING) e.truncated = true;
			e.output = bytes.subarray(Math.max(0, bytes.length - (MAX_OUTPUT_BYTES - MAX_PENDING))).toString('utf8');
		}
	};
	const appendChunk = (e: Entry, chunk: string) => {
		const parts = chunk.split(/\r\n|\r|\n/);
		for (let i = 0; i < parts.length; i++) {
			if (!e.lineOverflow) {
				e.pending += parts[i];
				if (Buffer.byteLength(e.pending, 'utf8') > MAX_PENDING) {
					e.pending = '';
					e.lineOverflow = true;
				}
			}
			if (i < parts.length - 1) appendLine(e);
		}
		e.updatedAt = Date.now();
		changed();
	};

	for (const t of vscode.window.terminals) add(t);
	listeners.push(vscode.window.onDidOpenTerminal(t => add(t)));
	listeners.push(vscode.window.onDidCloseTerminal(t => {
		const e = entries.get(t);
		if (!e) return;
		stopReading(e);
		if (e.pending || e.lineOverflow) appendLine(e);
		e.execution = undefined;
		e.closedAt = e.updatedAt = Date.now();
		if (e.status === 'in corso') e.status = 'sconosciuto';
		e.evidence = 'Terminale chiuso; ultimo stato osservato dalla shell integration';
		trim();
		changed();
	}));
	listeners.push(vscode.window.onDidStartTerminalShellExecution(ev => {
		const e = add(ev.terminal);
		stopReading(e);
		e.execution = ev.execution;
		e.closedAt = undefined;
		e.cwd = cwdOf(ev.terminal, ev.execution) ?? e.cwd;
		e.project = e.cwd ? path.basename(e.cwd) : 'Cartella sconosciuta';
		e.title = safeCommand(ev.execution.commandLine?.value);
		e.status = 'in corso';
		e.evidence = 'VS Code: avvio del comando rilevato dalla shell integration';
		e.updatedAt = Date.now();
		e.output = '';
		e.pending = '';
		e.lineOverflow = e.privateBlock = e.truncated = false;
		e.captured = true;
		e.steps = ['Comando avviato'];
		const generation = e.generation;
		// read() deve essere chiamato durante l'evento di avvio: in seguito l'output gia' scritto e' perso.
		try {
			e.iterator = ev.execution.read()[Symbol.asyncIterator]();
			const iterator = e.iterator;
			void (async () => {
				try {
					for (;;) {
						const next = await iterator.next();
						if (next.done || disposed || e.generation !== generation) break;
						appendChunk(e, String(next.value));
					}
				} catch { /* chiusura del terminale o stream interrotto */ }
			})();
		} catch {
			e.captured = false;
		}
		changed();
	}));
	listeners.push(vscode.window.onDidEndTerminalShellExecution(ev => {
		const e = entries.get(ev.terminal);
		if (!e || e.execution !== ev.execution) return;
		if (e.pending || e.lineOverflow) appendLine(e);
		e.execution = undefined;
		e.status = ev.exitCode === 0 ? 'finito' : typeof ev.exitCode === 'number' ? 'errore' : 'sconosciuto';
		e.evidence = typeof ev.exitCode === 'number'
			? `VS Code: comando terminato con codice ${ev.exitCode}`
			: 'VS Code: comando terminato senza codice di uscita';
		e.updatedAt = Date.now();
		e.steps.push(e.status === 'finito' ? 'Comando completato' : e.status === 'errore' ? 'Comando fallito' : 'Comando terminato');
		changed();
	}));

	const monitor: TerminalActivityMonitor = {
		activities() {
			trim();
			return [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(toActivity);
		},
		detail(key) {
			trim();
			const e = [...entries.values()].find(x => x.key === key);
			return e ? { activity: toActivity(e), output: e.output, captured: e.captured, truncated: e.truncated } : undefined;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (changeTimer) clearTimeout(changeTimer);
			for (const d of listeners) d.dispose();
			for (const e of entries.values()) stopReading(e);
			entries.clear();
		},
	};
	ctx.subscriptions.push(monitor);
	return monitor;
}
