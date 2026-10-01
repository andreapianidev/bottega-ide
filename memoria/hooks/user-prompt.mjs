#!/usr/bin/env node
// UserPromptSubmit: registra la richiesta (senza chiavi) e, se altre sessioni stanno lavorando sullo
// stesso progetto, passa a Claude un riassunto di cosa hanno fatto. Esce sempre con 0.
import { guard, readPayload, spool, emit } from '../lib/hook.mjs';
import { boardProject, appendBoard, writeSessionInfo, readSessionInfo, digest } from '../lib/bacheca.mjs';
import { redact, clip, cleanPrompt } from '../lib/redact.mjs';

guard();
try {
	const p = await readPayload();
	const sid = p.session_id;
	const prompt = redact(String(p.prompt || ''));
	spool({ ev: 'prompt', sid, cwd: p.cwd, tp: p.transcript_path, prompt: prompt.slice(0, 2500) });
	const plain = cleanPrompt(prompt);
	if (sid && plain) {
		const project = boardProject({ sid, cwd: p.cwd, prompt: plain });
		if (project) {
			const note = digest({ project, sid, prompt: plain });
			appendBoard(project, { sessionId: sid, kind: 'prompt', summary: clip(`ha chiesto: ${plain}`, 160), text: clip(plain, 200) });
			const info = readSessionInfo(sid);
			writeSessionInfo(sid, { key: project.key, name: project.name, path: project.path, title: info?.title || clip(plain, 70) });
			emit('UserPromptSubmit', note);
		}
	}
} catch {
	// mai bloccare Claude
}
process.exit(0);
