#!/usr/bin/env node
// SessionEnd: la sessione e' finita, il processo staccato la riassume. Esce sempre con 0.
import { guard, readPayload, spool, spawnWorker } from '../lib/hook.mjs';

guard();
try {
	const p = await readPayload();
	spool({ ev: 'end', sid: p.session_id, cwd: p.cwd, tp: p.transcript_path, src: p.reason });
	if (p.session_id) spawnWorker(['--motivo', 'fine', '--sessione', String(p.session_id || '')]);
} catch {
	// mai bloccare Claude
}
process.exit(0);
