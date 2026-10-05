import type { Snapshot } from './extension';

export interface RegiaDigest {
	at: number;
	text: string;
	engine: 'agnes' | 'apple';
	alternatives: { engine: 'agnes' | 'apple'; text: string }[];
}

export interface RegiaNucleo {
	readonly available: boolean;
	request<T>(cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<T>;
}

export const REGIA_INTERVAL = 8 * 60 * 60_000;

/** Solo stati e titoli osservati, senza percorsi, conversazioni o trascrizioni. */
export function regiaFacts(s: Snapshot): string {
	const rows = new Map(s.activity.map(a => [a.key, a]));
	const relevant = [...rows.values()].filter(a => ['ti aspetta', 'errore', 'in corso'].includes(a.status))
		.sort((a, b) => (a.status === 'ti aspetta' ? -1 : a.status === 'errore' ? 0 : 1) - (b.status === 'ti aspetta' ? -1 : b.status === 'errore' ? 0 : 1) || b.updatedAt - a.updatedAt);
	const queue = s.work.filter(w => w.status === 'in coda' || w.status === 'stanotte');
	return [
		`Stati osservati: ${relevant.filter(a => a.status === 'ti aspetta').length} in attesa, ${relevant.filter(a => a.status === 'errore').length} errori, ${relevant.filter(a => a.status === 'in corso').length} in corso, ${queue.length} in coda.`,
		...relevant.slice(0, 12).map(a => `${a.project || 'Senza progetto'} | ${a.source} | ${a.status} | ${a.title.slice(0, 100)}`),
		...queue.slice(0, 4).map(w => `${w.project || 'Senza progetto'} | Claude | ${w.status} | ${w.title.slice(0, 100)}`),
	].join('\n').slice(0, 2800);
}

const INSTRUCTIONS = 'Scrivi un riepilogo operativo della Regia in italiano, massimo 3 frasi e 75 parole. Parti da ciò che richiede una decisione di Andrea, poi ciò che lavora e ciò che è in coda. Usa solo i fatti forniti. Cita il progetto e il compito quando possibile. Non inventare azioni, scadenze, progressi, cause o numeri. Niente saluti, markdown o metafore.';

export function digestScore(text: string, facts: string): number {
	const body = text.trim();
	if (!body || body.length > 700) return -100;
	const numerals = body.match(/\d+/g) || [];
	if (numerals.some(n => !new RegExp(`(^|\\D)${n}(\\D|$)`).test(facts))) return -50;
	const lines = facts.split('\n').slice(1);
	const mentions = lines.filter(line => {
		const name = line.split(' | ')[0];
		return name.length > 2 && body.toLocaleLowerCase('it').includes(name.toLocaleLowerCase('it'));
	}).length;
	const words = body.split(/\s+/).length;
	return Math.min(mentions, 3) * 5 + (words >= 18 && words <= 75 ? 4 : 0) + (/[.!?]$/.test(body) ? 1 : 0) - Math.max(0, words - 75);
}

export async function makeRegiaDigest(
	s: Snapshot,
	compose: (instructions: string, facts: string, maxTokens: number) => Promise<{ text: string; engine: 'agnes' | 'apple' } | null>,
	nucleo: RegiaNucleo | undefined,
): Promise<RegiaDigest | null> {
	const facts = regiaFacts(s);
	if (!s.activity.length && !s.work.length) return null;
	const [primary, local] = await Promise.all([
		compose(INSTRUCTIONS, facts, 230).catch(() => null),
		nucleo?.available ? nucleo.request<{ text: string }>('ai.generate', { prompt: facts, instructions: INSTRUCTIONS, maxTokens: 230 }, 35_000).catch(() => null) : Promise.resolve(null),
	]);
	const candidates: { engine: 'agnes' | 'apple'; text: string }[] = [];
	if (primary?.text.trim()) candidates.push({ engine: primary.engine, text: primary.text.trim() });
	if (local?.text?.trim() && !candidates.some(c => c.engine === 'apple')) candidates.push({ engine: 'apple', text: local.text.trim() });
	if (!candidates.length) return null;
	candidates.sort((a, b) => digestScore(b.text, facts) - digestScore(a.text, facts) || (a.engine === 'agnes' ? -1 : 1));
	return { at: Date.now(), text: candidates[0].text, engine: candidates[0].engine, alternatives: candidates.slice(1) };
}

/** Stesse righe della Regia web e dei Lavori iOS, aggregate per il grafico Metal. */
export function regiaChart(s: Snapshot, digest?: RegiaDigest | null) {
	const groups = new Map<string, { name: string; waiting: number; errors: number; running: number; queued: number }>();
	const put = (name: string, status: string) => {
		const g = groups.get(name) || { name, waiting: 0, errors: 0, running: 0, queued: 0 };
		if (status === 'ti aspetta') g.waiting++;
		else if (status === 'errore') g.errors++;
		else if (status === 'in corso') g.running++;
		else if (status === 'in coda' || status === 'stanotte') g.queued++;
		groups.set(name, g);
	};
	for (const a of new Map(s.activity.map(a => [a.key, a])).values()) put(a.project || 'Senza progetto', a.status);
	for (const w of s.work) if (w.status === 'in coda' || w.status === 'stanotte') put(w.project || 'Senza progetto', w.status);
	const projects = [...groups.values()].filter(g => g.waiting + g.errors + g.running + g.queued > 0)
		.sort((a, b) => (b.waiting + b.errors) - (a.waiting + a.errors) || (b.running + b.queued) - (a.running + a.queued) || a.name.localeCompare(b.name, 'it')).slice(0, 14);
	return { projects, summary: projects.length ? digest?.text || '' : 'Nessun agente richiede attenzione adesso.',
		engine: projects.length ? digest?.engine || '' : '', updatedAt: digest?.at || 0 };
}
