// Parti comuni degli hook. Regole: uscita sempre 0, sotto i 150 ms, mai il database.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SPOOL_DIR, CLI_PATH, MEM_DIR, ensureDir, today, log, HOME } from './paths.mjs';
import { redact, clip } from './redact.mjs';

const started = Date.now();

/** Rete di sicurezza: qualunque errore, qualunque attesa, l'hook esce con 0. */
export function guard(budgetMs = 140) {
	const bail = () => process.exit(0);
	process.on('uncaughtException', e => {
		log(`hook: ${e?.stack || e}`);
		bail();
	});
	process.on('unhandledRejection', e => {
		log(`hook: ${e?.stack || e}`);
		bail();
	});
	setTimeout(bail, budgetMs).unref();
}

/** Legge il JSON su stdin senza mai restare appeso: se non arriva niente entro il tempo, va avanti. */
export function readPayload(waitMs = 80) {
	return new Promise(resolve => {
		let buf = '';
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			try {
				resolve(JSON.parse(buf || '{}'));
			} catch {
				resolve({});
			}
		};
		if (process.stdin.isTTY) return finish();
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', d => (buf += d));
		process.stdin.on('end', finish);
		process.stdin.on('error', finish);
		setTimeout(finish, waitMs).unref();
	});
}

export function elapsed() {
	return Date.now() - started;
}

/** Una riga nello spool del giorno. Righe sotto i 4 KB: l'append resta atomico tra processi. */
export function spool(entry) {
	if (!entry.sid) return; // payload vuoto o rotto: niente da ricordare
	ensureDir(SPOOL_DIR);
	let line = JSON.stringify({ v: 1, at: Date.now(), ...entry });
	if (Buffer.byteLength(line) > 3900) {
		for (const k of ['result', 'input', 'prompt']) {
			if (entry[k]) entry[k] = String(entry[k]).slice(0, 300);
		}
		line = JSON.stringify({ v: 1, at: Date.now(), ...entry }).slice(0, 3900);
		try {
			JSON.parse(line);
		} catch {
			line = JSON.stringify({ v: 1, at: Date.now(), ev: entry.ev, sid: entry.sid, cwd: entry.cwd, tp: entry.tp });
		}
	}
	fs.appendFileSync(path.join(SPOOL_DIR, `${today()}.jsonl`), line + '\n', { mode: 0o600 });
}

/** Avvia il lavoro pesante in un processo staccato: l'hook non lo aspetta. */
export function spawnWorker(args) {
	try {
		ensureDir(MEM_DIR);
		const child = spawn(process.execPath, ['--no-warnings', CLI_PATH, 'worker', ...args], {
			detached: true,
			stdio: 'ignore',
			cwd: HOME,
			env: process.env,
		});
		child.on('error', () => {});
		child.unref();
	} catch (e) {
		log(`spawnWorker: ${e?.message || e}`);
	}
}

export function emit(eventName, additionalContext) {
	if (!additionalContext) return;
	fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } }));
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function str(v) {
	if (v == null) return '';
	if (typeof v === 'string') return v;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

/** Riduce una chiamata di strumento a poche centinaia di caratteri, senza chiavi. */
export function compactTool(name, input = {}, response) {
	const files = [];
	for (const k of ['file_path', 'notebook_path']) {
		if (typeof input?.[k] === 'string') files.push(input[k]);
	}
	if (typeof input?.path === 'string' && input.path.startsWith('/')) files.push(input.path);
	let inp;
	if (FILE_TOOLS.has(name)) inp = files[0] || '';
	else if (name === 'Bash') inp = [input.description, input.command].filter(Boolean).join(' | ');
	else if (name === 'Grep' || name === 'Glob') inp = [input.pattern, input.path, input.glob].filter(Boolean).join(' ');
	else if (name === 'Task' || name === 'Agent') inp = [input.description, input.prompt].filter(Boolean).join(': ');
	else if (name === 'WebFetch') inp = input.url || '';
	else if (name === 'WebSearch') inp = input.query || '';
	else inp = str(input);
	let res = '';
	if (name !== 'Read' && response != null) {
		const r = typeof response === 'object' && response !== null ? response.stdout ?? response.content ?? response.result ?? response : response;
		res = str(r);
		if (typeof response === 'object' && response?.stderr) res += ' ' + str(response.stderr);
		if (typeof response === 'object' && response?.interrupted) res = '[interrotto] ' + res;
	}
	return { files, input: clip(redact(inp), 400), result: clip(redact(res), 400) };
}

export function tilde(p) {
	return p && p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p;
}
