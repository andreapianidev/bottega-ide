import type { AgentActivity } from './attivita-tipi';
import type { WorkItem } from './jobs';
import { summarizeObservedActivity } from './stats';

/** Gli stessi dati del quadro Lavori del Mac, aggregati prima del limite di 40 righe del ponte. */
export function quadroLavori(work: readonly WorkItem[], activity: readonly AgentActivity[], now = Date.now()) {
	const active = new Map<string, { nome: string; path: string; conteggio: number }>();
	for (const w of work) {
		if (w.status !== 'ti aspetta' && w.status !== 'in corso') continue;
		const key = String(w.path || w.project || '');
		if (!key) continue;
		const entry = active.get(key) || { nome: String(w.project || key.split('/').pop()), path: key, conteggio: 0 };
		entry.conteggio++;
		active.set(key, entry);
	}
	const sorted = [...active.values()]
		.sort((a, b) => b.conteggio - a.conteggio || a.nome.localeCompare(b.nome, 'it'))
		.slice(0, 5);
	const names = new Map<string, number>();
	for (const p of sorted) names.set(p.nome, (names.get(p.nome) || 0) + 1);
	const used = new Map<string, number>();
	const progetti = sorted.map(p => {
		const parent = p.path.split('/').filter(Boolean).at(-2) || 'altrove';
		const base = names.get(p.nome)! > 1 ? `${p.nome} · ${parent}` : p.nome;
		const n = (used.get(base) || 0) + 1;
		used.set(base, n);
		return { nome: n > 1 ? `${base} ${n}` : base, conteggio: p.conteggio };
	});
	const giorni = summarizeObservedActivity(activity, now).days.slice(-7).map(d => ({
		data: d.date,
		conteggio: d.claude + d.cline + d.codex + d.terminale,
	}));
	return { progetti, giorni };
}
