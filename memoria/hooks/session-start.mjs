#!/usr/bin/env node
// SessionStart: inietta il contesto gia' pronto del progetto (contesto/<chiave>.md) e chi sta
// lavorando adesso sullo stesso progetto. Poi avvia in background il riordino. Esce sempre con 0.
import fs from 'node:fs';
import path from 'node:path';
import { guard, readPayload, spool, emit, spawnWorker } from '../lib/hook.mjs';
import { CONTEXT_DIR, projectOf, HOME_PROJECT } from '../lib/paths.mjs';
import { activeLine, writeSessionInfo } from '../lib/bacheca.mjs';

guard();
try {
	const p = await readPayload();
	const sid = p.session_id;
	spool({ ev: 'start', sid, cwd: p.cwd, tp: p.transcript_path, src: p.source });
	const project = projectOf(p.cwd) || HOME_PROJECT;
	if (sid && project.key !== 'home') writeSessionInfo(sid, { key: project.key, name: project.name, path: project.path });
	let ctx = '';
	try {
		ctx = fs.readFileSync(path.join(CONTEXT_DIR, `${project.key}.md`), 'utf8').trim();
	} catch {
		// nessun contesto per questo progetto
	}
	const live = activeLine({ project, sid });
	emit('SessionStart', [ctx, live].filter(Boolean).join('\n\n'));
	spawnWorker(['--motivo', 'avvio']);
} catch {
	// mai bloccare Claude
}
process.exit(0);
