/* «Continua da dove eri»: il prompt iniziale di un lavoro che riparte dall'ultimo riassunto della Memoria,
   dalla sua lista «da fare» e dalle decisioni recenti del progetto. Il prompt si mostra sempre ad Andrea, che
   lo puo' cambiare prima di avviare. Contratto: docs/CONTRATTI.md, 4.2 (continua.prepare). */

import type { MemoryItem } from './memoria';

export interface ContinuaSource {
	recent(project: string, opts: { kinds?: string[]; limit?: number }): Promise<MemoryItem[]>;
}

export interface Continuation {
	path: string;
	prompt: string;
	sources: string[];
}

const DAY = 86_400_000;

function when(ms: number, now: number): string {
	const d = Math.floor((now - ms) / DAY);
	if (now - ms < 3_600_000) return 'meno di un\'ora fa';
	if (d < 1) return `${Math.round((now - ms) / 3_600_000)} ore fa`;
	if (d === 1) return 'ieri';
	return `${d} giorni fa`;
}

/** Il riassunto della Memoria ha righe "File toccati: ..." e "Da fare: a; b": le separo dal racconto. */
export function splitSummary(text: string): { story: string; todo: string[]; files: string[] } {
	const lines = (text || '').split('\n');
	let todo: string[] = [];
	let files: string[] = [];
	const story: string[] = [];
	for (const l of lines) {
		const t = /^Da fare:\s*(.*)$/i.exec(l.trim());
		const f = /^File toccati:\s*(.*)$/i.exec(l.trim());
		if (t) todo = t[1].split(/;\s*/).map(s => s.trim()).filter(Boolean);
		else if (f) files = f[1].split(/,\s*/).map(s => s.trim()).filter(Boolean);
		else if (l.trim()) story.push(l.trim());
	}
	return { story: story.join(' '), todo, files };
}

export async function prepareContinuation(project: { name: string; path: string }, src: ContinuaSource, now = Date.now()): Promise<Continuation> {
	const [sums, decisions] = await Promise.all([
		src.recent(project.name, { kinds: ['riassunto'], limit: 2 }).catch(() => [] as MemoryItem[]),
		src.recent(project.name, { kinds: ['decisione', 'nota'], limit: 6 }).catch(() => [] as MemoryItem[]),
	]);
	const sources: string[] = [];
	const out: string[] = [`Riprendi il lavoro su ${project.name} da dove era rimasto.`];
	const last = sums[0];
	if (last) {
		const s = splitSummary(last.text);
		sources.push(`ultimo riassunto della memoria, ${when(last.createdAt, now)}`);
		out.push('', `L'ultima sessione (${when(last.createdAt, now)}): ${last.title}. ${s.story}`.trim());
		if (s.todo.length) {
			out.push('', 'Era rimasto da fare:', ...s.todo.map(t => `- ${t}`));
		}
		if (s.files.length) out.push('', `File toccati l'ultima volta: ${s.files.slice(0, 12).join(', ')}.`);
		const prev = sums[1];
		if (prev && !s.todo.length) {
			const p = splitSummary(prev.text);
			if (p.todo.length) {
				sources.push(`riassunto precedente, ${when(prev.createdAt, now)}`);
				out.push('', 'Dalla sessione prima ancora restava:', ...p.todo.map(t => `- ${t}`));
			}
		}
	}
	const dec = decisions.filter(d => d.text && (!last || d.createdAt >= last.createdAt - 30 * DAY)).slice(0, 5);
	if (dec.length) {
		sources.push(dec.length === 1 ? 'una decisione recente' : `${dec.length} decisioni e note recenti`);
		out.push('', 'Decisioni da rispettare:', ...dec.map(d => `- ${d.text.split('\n')[0].slice(0, 240)}`));
	}
	if (!last) {
		sources.push('la memoria non ha ancora un riassunto di questo progetto');
		out.push('', 'La memoria non ha un riassunto di questo progetto: prima di tutto guarda lo stato del repository e dimmi a che punto siamo.');
	}
	out.push(
		'',
		'Prima di cambiare qualcosa: leggi CLAUDE.md, guarda git status e git log -5 e controlla che il quadro sia ancora questo. Poi riparti dal primo punto rimasto da fare. Se non resta niente, proponimi tu il passo successivo.',
	);
	return { path: project.path, prompt: out.join('\n'), sources };
}
