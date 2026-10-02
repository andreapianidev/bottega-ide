/* I progetti dimenticati: fermi da settimane ma con qualcosa lasciato a meta' (modifiche fuori da un commit,
   commit non spinti, lavori della Bottega fermati o rimasti ad aspettare). Contratto: docs/CONTRATTI.md, 4.1. */

import * as path from 'path';
import type { Job } from './jobs';
import type { Project } from './scan';

export interface Forgotten {
	path: string;
	name: string;
	idleDays: number;
	reasons: string[];
}

export const IDLE_DAYS = 14;
const DAY = 86_400_000;

const plural = (n: number, one: string, many: string) => (n === 1 ? `${one}` : `${n} ${many}`);

export function findForgotten(projects: Project[], jobs: Job[], now = Date.now(), idleDays = IDLE_DAYS): Forgotten[] {
	const out: Forgotten[] = [];
	const ago = (t: number) => Math.floor((now - t) / DAY);
	for (const p of projects) {
		if (p.live?.length) continue;
		const last = Math.max(p.git?.lastCommitAt ?? 0, p.sessions?.[0]?.mtime ?? 0);
		if (!last) continue;
		const reasons: string[] = [];
		let idle = ago(last);
		// il progetto: solo se e' fermo da settimane
		if (idle >= idleDays) {
			const g = p.git;
			if (g?.changes) reasons.push(g.changes === 1 ? 'una modifica fuori da un commit' : `${g.changes} modifiche fuori da un commit`);
			if (g?.ahead) reasons.push(g.ahead === 1 ? 'un commit da spingere' : `${g.ahead} commit da spingere`);
			if (g && !g.upstream && g.lastCommitAt) reasons.push('nessun remoto: il lavoro esiste solo su questo Mac');
			const half = jobs.filter(j => j.path === p.path && (j.status === 'fermato' || j.status === 'ti aspetta'));
			if (half.length) reasons.push(half.length === 1 ? 'un lavoro lasciato a metà' : `${plural(half.length, 'un lavoro', 'lavori')} lasciati a metà`);
		}
		// Le copie di lavoro (worktree) stanno dentro il progetto, ma il loro lavoro a meta' non deve sparire:
		// ognuna conta con la sua data, anche se il progetto principale e' vivo.
		let wIdleMax = 0;
		for (const w of p.worktrees ?? []) {
			const wIdle = ago(w.lastCommitAt || last);
			if (wIdle < idleDays) continue;
			const bits: string[] = [];
			if (w.changes) bits.push(w.changes === 1 ? 'una modifica fuori da un commit' : `${w.changes} modifiche fuori da un commit`);
			if (w.ahead) bits.push(w.ahead === 1 ? 'un commit da spingere' : `${w.ahead} commit da spingere`);
			if (!bits.length) continue;
			reasons.push(`copia ${path.basename(w.path)} (ramo ${w.branch}), ferma da ${wIdle} giorni: ${bits.join(', ')}`);
			wIdleMax = Math.max(wIdleMax, wIdle);
		}
		if (!reasons.length) continue;
		if (idle < idleDays) idle = wIdleMax;
		out.push({ path: p.path, name: p.name, idleDays: idle, reasons });
	}
	// prima chi rischia di piu': niente remoto e modifiche, poi i piu' vecchi
	const weight = (f: Forgotten) => f.reasons.length * 1000 + f.idleDays;
	return out.sort((a, b) => weight(b) - weight(a));
}
