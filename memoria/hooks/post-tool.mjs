#!/usr/bin/env node
// PostToolUse: una riga nello spool, una voce in bacheca, e un avviso se un'altra sessione ha appena
// modificato lo stesso file. Esce sempre con 0.
import { guard, readPayload, spool, compactTool, emit } from '../lib/hook.mjs';
import { boardProject, appendBoard, writeSessionInfo, conflictNote, rel } from '../lib/bacheca.mjs';
import { expand } from '../lib/paths.mjs';
import { clip } from '../lib/redact.mjs';

guard();
try {
	const p = await readPayload();
	const sid = p.session_id;
	const tool = String(p.tool_name || '');
	const c = compactTool(tool, p.tool_input || {}, p.tool_response);
	spool({ ev: 'tool', sid, cwd: p.cwd, tp: p.transcript_path, tool, files: c.files, input: c.input, result: c.result });

	const kind =
		tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit' ? 'edit'
		: tool === 'Write' ? 'write'
		: tool === 'Read' ? 'read'
		: tool === 'Bash' ? 'bash'
		: tool === 'Task' || tool === 'Agent' ? 'agent'
		: tool === 'WebFetch' || tool === 'WebSearch' ? 'web'
		: tool.startsWith('mcp__') ? 'mcp'
		: '';
	if (sid && kind) {
		const hints = [...c.files];
		const cmd = kind === 'bash' ? String(p.tool_input?.command || '') : '';
		if (cmd) {
			const m = /(?:^|[\s'"=])((?:~|\/Users\/)[^\s'";|&)]*)/.exec(cmd);
			if (m) hints.push(expand(m[1]));
		}
		const project = boardProject({ sid, cwd: p.cwd, files: hints });
		if (project) {
			const file = c.files[0];
			const r = rel(file, project.path);
			const summary =
				kind === 'edit' ? `ha modificato ${r}`
				: kind === 'write' ? `ha scritto ${r}`
				: kind === 'read' ? `ha letto ${r}`
				: kind === 'bash' ? `ha lanciato ${clip(c.input.split(' | ').pop(), 120)}`
				: kind === 'agent' ? `ha avviato un agente: ${clip(p.tool_input?.description || c.input, 100)}`
				: kind === 'web' ? `ha consultato ${clip(c.input, 120)}`
				: `ha usato ${tool.replace(/^mcp__/, '')}`;
			let note = '';
			if (kind === 'edit' || kind === 'write') note = conflictNote({ project, sid, file });
			appendBoard(project, {
				sessionId: sid,
				kind,
				summary: clip(summary, 160),
				...(file ? { file, rel: r } : {}),
				...(kind === 'bash' ? { cmd: clip(c.input.split(' | ').pop(), 120) } : {}),
			});
			if (project.how !== 'sessione') writeSessionInfo(sid, { key: project.key, name: project.name, path: project.path });
			if (note) emit('PostToolUse', note);
		}
	}
} catch {
	// mai bloccare Claude
}
process.exit(0);
