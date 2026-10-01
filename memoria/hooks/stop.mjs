#!/usr/bin/env node
// Stop (fine di un turno): segna il momento e lascia al processo staccato la decisione se
// riassumere. Esce sempre con 0.
import { guard, readPayload, spool, spawnWorker } from '../lib/hook.mjs';

guard();
try {
	const p = await readPayload();
	spool({ ev: 'stop', sid: p.session_id, cwd: p.cwd, tp: p.transcript_path });
	if (p.session_id) spawnWorker(['--motivo', 'stop', '--sessione', String(p.session_id || '')]);
} catch {
	// mai bloccare Claude
}
process.exit(0);
