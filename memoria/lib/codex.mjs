// Importazione locale incrementale: solo richieste e risposte finali, mai ragionamenti,
// strumenti o immagini. Sono note della conversazione, non fatti dedotti da un modello.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from './store.mjs';
import { projectOf, HOME_PROJECT } from './paths.mjs';
import { redact, cleanPrompt, clip } from './redact.mjs';

const DAY = 86_400_000;
const CHUNK = 256 * 1024;
const MAX_LINE = 256 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT = new RegExp(`^rollout-.*-(${UUID})\\.jsonl$`, 'i');

function userText(text) {
	text = cleanPrompt(text);
	// Contesto iniettato dal client, non parole dell'utente.
	if (/^(?:# AGENTS\.md|<)/.test(text)) return '';
	const marker = '## My request:';
	if (text.includes(marker)) text = text.slice(text.indexOf(marker) + marker.length).trim();
	return text;
}

export function importCodex({ store, root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'), now = Date.now(), budget = 32 * 1024 * 1024 } = {}) {
	const own = !store;
	store ??= new Store();
	try {
		store.db.exec(`CREATE TABLE IF NOT EXISTS codex_offsets (file TEXT PRIMARY KEY, identity TEXT, offset INTEGER, state TEXT);
		CREATE TABLE IF NOT EXISTS codex_imports (event TEXT PRIMARY KEY, memoryId INTEGER);`);
		const candidates = [];
		for (let day = 0; day <= 8; day++) {
			const d = new Date(now - day * DAY);
			const dir = path.join(root, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
			let names;
			try { names = fs.readdirSync(dir); } catch { continue; }
			for (const name of names) {
				if (!ROLLOUT.test(name)) continue;
				const file = path.join(dir, name);
				try {
					const stat = fs.statSync(file);
					if (stat.isFile() && stat.mtimeMs >= now - 7 * DAY) candidates.push({ file, stat });
				} catch { /* rotation */ }
			}
		}
		let imported = 0;
		let bytes = 0;
		let pending = false;
		for (const { file, stat } of candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 100)) {
			if (bytes >= budget) { pending = true; break; }
			let fd;
			try { fd = fs.openSync(file, 'r'); } catch { continue; }
			try {
				store.tx(() => {
					const old = store.get('SELECT * FROM codex_offsets WHERE file = ?', file);
					const identity = `${stat.dev}:${stat.ino}`;
					const resume = old?.identity === identity && old.offset <= stat.size;
					let offset = resume ? old.offset : 0;
					const state = resume ? JSON.parse(old.state) : { id: ROLLOUT.exec(path.basename(file))[1] };
					let fragment = Buffer.alloc(0);
					let skipping = !!state.skipping;
					let committed = offset;
					const consume = line => {
						let r;
						try { r = JSON.parse(line); } catch { return; }
						const p = r?.payload;
						if (!p || typeof p !== 'object') return;
						if (r.type === 'session_meta' || r.type === 'turn_context') {
							if (typeof p.cwd === 'string' && path.isAbsolute(p.cwd)) state.cwd = p.cwd;
							if (p.source?.subagent || p.parent_thread_id) state.subagent = true;
							return;
						}
						if (state.subagent) return;
						let text, who;
						if (r.type === 'response_item' && p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
							text = p.content.filter(c => c.type === 'input_text' && typeof c.text === 'string').map(c => c.text).join('\n');
							who = 'Richiesta';
						} else if (r.type === 'event_msg' && p.type === 'task_complete') {
							text = p.last_agent_message;
							who = 'Risposta';
						}
						if (typeof text !== 'string') return;
						text = redact(who === 'Richiesta' ? userText(text) : text).trim();
						const at = Date.parse(r.timestamp);
						if (!text || !Number.isFinite(at) || at > now + 60_000) return;
						const event = createHash('sha256').update(`${state.id}\n${who}\n${at}\n${text}`).digest('hex');
						if (store.get('SELECT 1 FROM codex_imports WHERE event = ?', event)) return;
						const project = projectOf(state.cwd) || HOME_PROJECT;
						const memoryId = store.addMemory({ kind: 'nota', origin: 'codex', sessionId: `codex:${state.id}`, project: project.name, projectPath: project.path, projectKey: project.key,
							title: `Codex · ${who}: ${clip(text, 100)}`, text: text.length > 8000 ? text.slice(0, 7999) + '…' : text, createdAt: at });
						store.run('INSERT INTO codex_imports(event, memoryId) VALUES (?, ?)', event, memoryId);
						imported++;
					};
					while (offset < stat.size && bytes < budget) {
						const buf = Buffer.alloc(Math.min(CHUNK, stat.size - offset, budget - bytes));
						const count = fs.readSync(fd, buf, 0, buf.length, offset);
						if (!count) break;
						bytes += count;
						let start = 0;
						for (let i = 0; i < count; i++) {
							if (buf[i] !== 10) continue;
							if (!skipping && fragment.length + i - start <= MAX_LINE) consume(Buffer.concat([fragment, buf.subarray(start, i)]).toString('utf8'));
							fragment = Buffer.alloc(0);
							skipping = false;
							committed = offset + i + 1;
							start = i + 1;
						}
						if (!skipping) {
							fragment = Buffer.concat([fragment, buf.subarray(start, count)]);
							if (fragment.length > MAX_LINE) { fragment = Buffer.alloc(0); skipping = true; }
						}
						offset += count;
						if (skipping) committed = offset;
					}
					state.skipping = skipping;
					pending ||= committed < stat.size;
					store.run('INSERT INTO codex_offsets VALUES (?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET identity=excluded.identity, offset=excluded.offset, state=excluded.state', file, identity, committed, JSON.stringify(state));
				});
			} finally { fs.closeSync(fd); }
		}
		store.meta('last_codex_import', now);
		return { imported, bytes, pending };
	} finally { if (own) store.close(); }
}
