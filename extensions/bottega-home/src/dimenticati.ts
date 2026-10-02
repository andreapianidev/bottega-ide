/* I progetti dimenticati: fermi da settimane ma con qualcosa lasciato a meta' (modifiche fuori da un commit,
   commit non spinti, lavori della Bottega fermati o rimasti ad aspettare). Contratto: docs/CONTRATTI.md, 4.1. */

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
	for (const p of projects) {
		if (p.live?.length) continue;
		const last = Math.max(p.git?.lastCommitAt ?? 0, p.sessions?.[0]?.mtime ?? 0);
		if (!last) continue;
		const idle = Math.floor((now - last) / DAY);
		if (idle < idleDays) continue;
		const reasons: string[] = [];
		const g = p.git;
		if (g?.changes) reasons.push(g.changes === 1 ? 'una modifica fuori da un commit' : `${g.changes} modifiche fuori da un commit`);
		if (g?.ahead) reasons.push(g.ahead === 1 ? 'un commit da spingere' : `${g.ahead} commit da spingere`);
		if (g && !g.upstream && g.lastCommitAt) reasons.push('nessun remoto: il lavoro esiste solo su questo Mac');
		const half = jobs.filter(j => j.path === p.path && (j.status === 'fermato' || j.status === 'ti aspetta'));
		if (half.length) reasons.push(half.length === 1 ? 'un lavoro lasciato a metà' : `${plural(half.length, 'un lavoro', 'lavori')} lasciati a metà`);
		if (reasons.length) out.push({ path: p.path, name: p.name, idleDays: idle, reasons });
	}
	// prima chi rischia di piu': niente remoto e modifiche, poi i piu' vecchi
	const weight = (f: Forgotten) => f.reasons.length * 1000 + f.idleDays;
	return out.sort((a, b) => weight(b) - weight(a));
}
