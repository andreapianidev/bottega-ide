/* Il cruscotto: ore di lavoro, token e progetti, ricavati dai registri di Claude Code
   (~/.claude/projects/<cartella>/<sessione>.jsonl, piu' <sessione>/subagents/*.jsonl).

   Regole (le stesse che il cruscotto scrive in chiaro ad Andrea):
   - Ogni riga user/assistant/system ha un "timestamp". Dentro una sessione, due eventi a meno di
     15 minuti l'uno dall'altro valgono come tempo di lavoro; una pausa piu' lunga spezza il conto.
     I sottoagenti appartengono alla sessione che li ha lanciati: i loro eventi riempiono i buchi.
   - Le ore di Andrea sono l'UNIONE degli intervalli di tutte le sessioni: due sessioni insieme
     contano una volta sola. Le ore di Claude sono la SOMMA per sessione: mostrano il parallelismo.
   - I token vengono da message.usage delle righe assistant. Claude Code scrive la stessa risposta
     in piu' righe (una per blocco) con lo stesso message.id e requestId: si conta una volta sola,
     tenendo per ogni campo il valore piu' alto (output_tokens cresce mentre la risposta si scrive).

   Prestazioni: ogni file si legge a pezzi da 1 MB, riga per riga, cedendo il passo all'host ogni
   ~12 ms. Il risultato per file (intervalli, token per ora e modello, file toccati) si salva in
   globalStorage con dimensione, mtime e byte gia' letti: al giro dopo si rilegge solo cio' che e'
   cambiato, e un file che e' solo cresciuto (una sessione viva) riprende da dove era arrivato.
   Contratto verso la plancia: docs/CONTRATTI.md, sezione 3 (messaggio "stats"). */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { performance } from 'perf_hooks';
import { sessionOwner, projectKey, canonKey } from './scan';
import type { AgentActivity } from './attivita-tipi';

export const GAP_MINUTES = 15;
const GAP = GAP_MINUTES * 60_000;
/** Un giorno conta per la serie se ha almeno mezz'ora di lavoro. */
export const STREAK_MINUTES = 30;
const SCHEMA = 3;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const DAYS_KEPT = 90;
const TOUCHED_MAX = 200;
const KEYS_TAIL = 64;
/** Fasce di durata delle sessioni (minuti di lavoro): meno di 5, 5-15, 15-30, 30-60, 1-2 h, 2-4 h, oltre. */
export const LENGTH_EDGES = [5, 15, 30, 60, 120, 240];
/** Sessioni di oggi mandate alla plancia: le piu' recenti. */
const TODAY_MAX = 40;
/** Progetti che si stanno fermando: almeno mezz'ora nel periodo prima, niente in questo. */
const STALLED_MIN = 30;

// ---------- prezzi ----------

/** Prezzi di listino API in dollari per milione di token: input, output, lettura dalla cache.
 *  Scrittura in cache: 1,25 volte l'input con durata 5 minuti, 2 volte con durata 1 ora.
 *  Fonte: listino Anthropic al 25/09/2026 (skill claude-api); controllati contro i conti
 *  "cost-state" che Claude Code stesso scrive nelle sessioni (vedi il banco di prova). */
const PRICES: { re: RegExp; name: string; p: [number, number, number] }[] = [
	{ re: /^claude-opus-5-5/, name: 'Opus 5.5', p: [4, 20, 0.2] },
	{ re: /^claude-opus-5($|\[|-20)/, name: 'Opus 5', p: [5, 25, 0.5] },
	{ re: /^claude-opus-4-8/, name: 'Opus 4.8', p: [5, 25, 0.5] },
	{ re: /^claude-opus-4-7/, name: 'Opus 4.7', p: [5, 25, 0.5] },
	{ re: /^claude-fable-5-1/, name: 'Fable 5.1', p: [10, 50, 0.25] },
	{ re: /^claude-fable-5($|\[|-20)/, name: 'Fable 5', p: [10, 50, 1] },
	{ re: /^claude-sonnet-5-5/, name: 'Sonnet 5.5', p: [2, 10, 0.2] },
	{ re: /^claude-sonnet-5($|\[|-20)/, name: 'Sonnet 5', p: [2, 10, 0.2] },
	{ re: /^claude-haiku-4-5/, name: 'Haiku 4.5', p: [1, 5, 0.1] },
];

export const PRICE_NOTE =
	'Stima a prezzi di listino API: token per il prezzo di ogni modello (input, output, lettura e scrittura in cache). Con un abbonamento non è quello che paghi.';

function priceOf(model: string) {
	return PRICES.find(x => x.re.test(model));
}

export function modelName(model: string): string {
	return priceOf(model)?.name ?? model.replace(/^claude-/, '');
}

/** Dollari per una quintupla [input, output, letti dalla cache, scritti 5 min, scritti 1 h]. */
export function costOf(model: string, v: ArrayLike<number>): number | null {
	const pr = priceOf(model);
	if (!pr) return null;
	const [i, o, r] = pr.p;
	return (v[0] * i + v[1] * o + v[2] * r + v[3] * i * 1.25 + v[4] * i * 2) / 1e6;
}

// ---------- tipi ----------

/** [input, output, letti dalla cache, scritti in cache] */
export type Tok = [number, number, number, number];

export interface StatsDay {
	date: string; // YYYY-MM-DD, ora locale
	you: number; // minuti, unione delle sessioni
	claude: number; // minuti, somma delle sessioni
	sessions: number;
	prompts: number; // messaggi scritti da Andrea
	tok: Tok;
	cost: number;
}

export interface StatsBin extends Omit<StatsDay, 'date'> {
	key: string; // 2026-W40 oppure 2026-09
	start: string;
	end: string;
	activeDays: number;
}

export interface StatsProject {
	name: string;
	path: string | null; // null: sessioni fuori dai progetti
	you: number;
	claude: number;
	tok: Tok;
	cost: number;
	sessions: number;
	prev: { you: number; claude: number; tok: number; cost: number };
	last: number; // ultimo evento, ms
	daily: number[]; // minuti tuoi per giorno del periodo, dal piu' vecchio
	hours: number[]; // 24 valori: minuti tuoi per ora del giorno nel periodo
	live: number; // sessioni aperte adesso
}

export interface StatsModel {
	id: string;
	name: string;
	tok: Tok;
	messages: number;
	cost: number | null;
}

export interface StatsTotals {
	you: number;
	claude: number;
	tok: Tok;
	cost: number;
	sessions: number;
	prompts: number;
	activeDays: number;
}

export interface StatsPeriod extends StatsTotals {
	days: number;
	from: string;
	avgSession: number; // minuti di Claude per sessione
	peak: { n: number; at: number }; // massimo di sessioni attive insieme
	prev: StatsTotals;
	projects: StatsProject[];
	edges: { a: string; b: string; minutes: number }[]; // progetti lavorati in parallelo
	models: StatsModel[];
	heat: number[][]; // [lunedi'..domenica][0..23] minuti tuoi
	/** Quanto dura una sessione: minuti di lavoro di ogni sessione dentro il periodo, a fasce. */
	lengths: StatsLengths;
	/** Progetti con almeno mezz'ora nel periodo prima e nessun minuto in questo (non sono in `projects`). */
	stalled: { name: string; path: string; prev: number; last: number }[];
}

export interface StatsLengths {
	edges: number[]; // LENGTH_EDGES: i limiti delle fasce in minuti
	bins: number[]; // edges.length + 1 conteggi: meno di 5, 5-15, ..., oltre l'ultimo
	median: number; // minuti
	n: number; // sessioni con almeno un minuto di lavoro nel periodo
}

/** Una sessione che ha lavorato oggi, per la linea del tempo della giornata. */
export interface StatsTodaySession {
	sid: string;
	project: string; // "Fuori dai progetti" se non e' di un progetto
	path: string | null;
	title: string;
	where: string; // vedi StatsLive.where
	spans: number[]; // [inizio, fine, ...] in minuti dalla mezzanotte locale, gia' fusi (regola dei 15 minuti)
	tok: number; // token di oggi
	live: boolean; // aperta adesso
}

/** Le ultime 168 ore (7 giorni), ora per ora, dalla piu' vecchia; l'ultima e' quella in corso. */
export interface StatsConcurrency {
	start: number; // ms, inizio della prima ora (ora locale)
	avg: number[]; // sessioni insieme in media mentre ne girava almeno una (minuti di sessione / minuti coperti)
	peak: number[]; // massimo di sessioni nello stesso istante
	busy: number[]; // minuti dell'ora con almeno una sessione (0..60)
}

export interface StatsLive {
	pid: number;
	sessionId: string;
	project: string;
	path: string | null;
	title: string;
	status: string;
	since: number;
	started: number;
	today: number; // minuti di lavoro oggi in questa sessione
	tokToday: number;
	cwd: string; // cartella in cui gira la sessione
	/** Dove gira, rispetto al progetto: '' nella sua cartella, "copia Bottega-idee, ramo idee" in un
	 *  worktree, "cartella sito" in una sottocartella, "dalla home" o "cartella X" fuori dai progetti. */
	where: string;
}

export interface Stats {
	version: 1;
	computedAt: number;
	ms: number;
	files: { total: number; read: number; cached: number; mb: number };
	gapMinutes: number;
	streakMinutes: number;
	tz: string;
	firstEvent: number;
	today: { date: string; you: number; claude: number; tok: number; sessions: number };
	week: {
		start: string;
		now: { you: number; claude: number; tok: number };
		prevSoFar: { you: number; claude: number; tok: number };
		prevFull: { you: number; claude: number; tok: number };
	};
	days: StatsDay[];
	weeks: StatsBin[];
	months: StatsBin[];
	periods: { '7': StatsPeriod; '30': StatsPeriod; '90': StatsPeriod };
	streak: { current: number; best: number; bestEnd: string | null };
	records: {
		busiestDay: { date: string; you: number } | null;
		longestStint: { start: number; minutes: number } | null;
		tokenDay: { date: string; tok: number } | null;
	};
	live: StatsLive[];
	prices: { note: string; perModel: Record<string, [number, number, number]> };
	unpricedTokens: number;
	todaySessions: StatsTodaySession[];
	concurrency7: StatsConcurrency;
	/** Registro multi-fonte: conteggi e date dell'ultimo aggiornamento, non durate o consumi. */
	observedActivity?: StatsObservedActivity;
	/** Consumi locali per fonte, separati dalle cifre Claude. */
	sourceMetrics?: StatsSourceMetrics;
	/** Tempo osservato degli agenti, unione tra fonti e sessioni parallele. */
	workTime: StatsWorkTime;
}

export interface StatsWorkTime {
	today: { date: string; minutes: number };
	days: { date: string; minutes: number }[];
	/** Ultimi sette giorni locali incluso oggi, e i sette immediatamente precedenti. */
	weekMinutes: number;
	previousWeekMinutes: number;
	/** Fonti con intervalli osservabili: Cline e terminali non forniscono durate affidabili. */
	sources: ('claude' | 'codex')[];
}

/** Nessuna somma delle sessioni parallele, nessuna estrapolazione fino all'orologio corrente. */
export function summarizeWorkTime(claude: number[], codex: number[], now = Date.now()): StatsWorkTime {
	const start = startOfDay(now);
	const union = mergeSpans([...claude, ...codex], 0);
	const days = Array.from({ length: DAYS_KEPT }, (_, i) => {
		const a = addDays(start, i + 1 - DAYS_KEPT);
		return { date: dayKey(a), minutes: r1(minutesIn(union, a, Math.min(now, addDays(a, 1)))) };
	});
	const sources: StatsWorkTime['sources'] = [];
	if (minutesIn(claude, addDays(start, 1 - DAYS_KEPT), now) > 0) sources.push('claude');
	if (minutesIn(codex, addDays(start, 1 - DAYS_KEPT), now) > 0) sources.push('codex');
	return { today: days[days.length - 1], days,
		weekMinutes: r1(minutesIn(union, addDays(start, -6), now)),
		previousWeekMinutes: r1(minutesIn(union, addDays(start, -13), addDays(start, -6))), sources };
}

export interface StatsSourceMetric {
	tokens: number | null;
	cost: number | null; // USD dichiarati dalla fonte, mai sommati al valore Claude a listino
	durationMinutes: number | null; // solo durata dei turni Codex conclusi, non ore di lavoro
	records: number;
	files: number;
	skipped: number;
}
export type StatsSourceMetrics = Record<'7' | '30' | '90', { codex: StatsSourceMetric; cline: StatsSourceMetric }>;

export type ActivitySource = AgentActivity['source'];
export interface StatsObservedActivity {
	sources: { source: ActivitySource; total: number; inCorso: number; tiAspetta: number;
		finito: number; errore: number; sconosciuto: number }[];
	/** Ultimi 90 giorni locali: ogni attivita' contribuisce solo nel giorno di updatedAt. */
	days: { date: string; claude: number; cline: number; codex: number; terminale: number }[];
}

/** Riassume il registro osservato senza inferire intervalli di lavoro da due timestamp isolati. */
export function summarizeObservedActivity(activity: readonly AgentActivity[], now = Date.now()): StatsObservedActivity {
	const sources: ActivitySource[] = ['claude', 'cline', 'codex', 'terminale'];
	const totals = new Map<ActivitySource, StatsObservedActivity['sources'][number]>(sources.map(source => [source, {
		source, total: 0, inCorso: 0, tiAspetta: 0, finito: 0, errore: 0, sconosciuto: 0,
	}]));
	const days = Array.from({ length: 90 }, (_, i) => {
		const date = new Date(now);
		date.setHours(12, 0, 0, 0);
		date.setDate(date.getDate() - (89 - i));
		return { date: dayKey(date.getTime()), claude: 0, cline: 0, codex: 0, terminale: 0 };
	});
	const byDate = new Map(days.map(day => [day.date, day]));
	const seen = new Set<string>();
	for (const item of activity) {
		const key = `${item.source}:${item.key}`;
		if (!sources.includes(item.source) || !item.key || seen.has(key)) continue;
		seen.add(key);
		const total = totals.get(item.source)!;
		total.total++;
		const field = ({ 'in corso': 'inCorso', 'ti aspetta': 'tiAspetta', finito: 'finito', errore: 'errore', sconosciuto: 'sconosciuto' } as const)[item.status] ?? 'sconosciuto';
		total[field]++;
		if (Number.isFinite(item.updatedAt) && item.updatedAt <= now) {
			const day = byDate.get(dayKey(item.updatedAt));
			if (day) day[item.source]++;
		}
	}
	return { sources: sources.map(source => totals.get(source)!), days };
}

type MetricSource = 'codex' | 'cline';
interface MetricDay { tokens: number; cost: number; minutes: number; files: Set<string> }
interface MetricScan { spans: number[]; days: Map<string, MetricDay>; files: number; skipped: number; hasTokens: boolean; hasCost: boolean; hasMinutes: boolean }
const metricScan = (): MetricScan => ({ spans: [], days: new Map(), files: 0, skipped: 0, hasTokens: false, hasCost: false, hasMinutes: false });
const nonnegative = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const metricTime = (value: unknown): number | null => {
	const t = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
	return Number.isFinite(t) && t > 0 ? t : null;
};
function addMetric(scan: MetricScan, sourceFile: string, timestamp: number, cutoff: number, now: number,
	tokens: number | null, cost: number | null, minutes: number | null): void {
	if (timestamp < cutoff || timestamp > now + 60_000) return;
	const key = dayKey(timestamp);
	let day = scan.days.get(key);
	if (!day) scan.days.set(key, (day = { tokens: 0, cost: 0, minutes: 0, files: new Set() }));
	day.files.add(sourceFile);
	if (tokens !== null) { day.tokens += tokens; scan.hasTokens = true; }
	if (cost !== null) { day.cost += cost; scan.hasCost = true; }
	if (minutes !== null) { day.minutes += minutes; scan.hasMinutes = true; }
}

/** Contatori di consumo e progressi nei turni dei rollout Codex. Ogni total_token_usage
 *  e' cumulativo nel file: si aggiunge solo la differenza positiva. I file invariati
 *  conservano gli intervalli in memoria, ma quelli cresciuti sono letti al giro successivo. */
interface CodexFileCache { size: number; mtime: number; cutoff: number; at: number; nextEvent: number; scan: MetricScan }
type CodexScanCache = Map<string, CodexFileCache>;

async function scanCodexMetrics(root: string, cutoff: number, now: number, cache: CodexScanCache = new Map()): Promise<MetricScan> {
	const scan = metricScan();
	const files: string[] = [];
	const days = Math.ceil((now - cutoff) / DAY) + 1;
	for (let i = 0; i <= days; i++) {
		const d = new Date(now - i * DAY);
		const dir = path.join(root, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
		let names: string[];
		try { names = await fs.promises.readdir(dir); } catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw err;
		}
		for (const name of names) if (/^rollout-.*\.jsonl$/.test(name)) files.push(path.join(dir, name));
	}
	const seen = new Set(files);
	for (const file of seen) {
		let st: fs.Stats;
		st = await fs.promises.stat(file);
		if (!st.isFile() || st.mtimeMs < cutoff) continue;
		const previous = cache.get(file);
		let part: MetricScan;
		if (previous && previous.size === st.size && previous.mtime === st.mtimeMs && previous.cutoff === cutoff && now >= previous.at && now < previous.nextEvent) {
			part = previous.scan;
		} else {
			part = metricScan();
			part.files = 1;
			let input = 0, output = 0, nextEvent = Infinity;
			let turnStart: number | null = null, lastProgress: number | null = null;
			// Un turno aperto vale solo fino all'ultimo progresso scritto. Le pause oltre
			// 15 minuti spezzano gli intervalli e un registro morto non cresce da solo.
			const progress = (at: number) => {
				if (turnStart === null || lastProgress === null || at < lastProgress) return;
				if (at - lastProgress <= GAP && at > lastProgress) part.spans.push(lastProgress, at);
				lastProgress = at;
			};
			try {
				const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
				for await (const line of lines) {
					if (!line.includes('"event_msg"') && !line.includes('"response_item"')) continue;
					let row: any;
					try { row = JSON.parse(line); } catch { continue; }
					if (!row.payload || typeof row.payload !== 'object') continue;
					const at = metricTime(row.timestamp);
					if (at === null) continue;
					if (at > now) { nextEvent = Math.min(nextEvent, at); continue; }
					const p = row.payload;
					if (row.type === 'response_item') {
						if (['reasoning', 'agent_message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'web_search_call'].includes(p.type) || (p.type === 'message' && p.role === 'assistant')) progress(at);
						continue;
					}
					if (row.type !== 'event_msg') continue;
					if (p.type === 'token_count' && p.info?.total_token_usage) {
						const u = p.info.total_token_usage;
						const i = nonnegative(u.input_tokens), o = nonnegative(u.output_tokens);
						if (i === null || o === null) continue;
						const delta = Math.max(0, i - input) + Math.max(0, o - output);
						input = Math.max(input, i); output = Math.max(output, o);
						if (delta > 0) { addMetric(part, file, at, cutoff, now, delta, null, null); progress(at); }
					} else if (p.type === 'task_started') {
						turnStart = at; lastProgress = at;
					} else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
						if (turnStart !== null) {
							const elapsed = (at - turnStart) / 60_000;
							if (elapsed > 0 && elapsed <= 24 * 60) addMetric(part, file, at, cutoff, now, null, null, elapsed);
							progress(at);
						}
						turnStart = null; lastProgress = null;
					} else if (p.type === 'agent_message' || p.type === 'agent_reasoning' || p.type === 'item_completed') progress(at);
				}
				part.spans = mergeSpans(part.spans, 0);
				cache.set(file, { size: st.size, mtime: st.mtimeMs, cutoff, at: now, nextEvent, scan: part });
			} catch (err) {
				// Un errore transitorio non deve pubblicare ore parziali con una data nuova.
				throw err;
			}
		}
		scan.files += part.files; scan.skipped += part.skipped;
		scan.hasTokens ||= part.hasTokens; scan.hasCost ||= part.hasCost; scan.hasMinutes ||= part.hasMinutes;
		scan.spans.push(...part.spans);
		for (const [key, d] of part.days) {
			let target = scan.days.get(key);
			if (!target) scan.days.set(key, target = { tokens: 0, cost: 0, minutes: 0, files: new Set() });
			target.tokens += d.tokens; target.cost += d.cost; target.minutes += d.minutes;
			for (const f of d.files) target.files.add(f);
		}
	}
	for (const file of cache.keys()) if (!seen.has(file)) cache.delete(file);
	return scan;
}

/** Metriche per messaggio dei soli registri Cline SDK 4.x. Il campo cost e' riportato da Cline. */
async function scanClineMetrics(root: string, cutoff: number, now: number): Promise<MetricScan> {
	const scan = metricScan();
	let names: string[];
	try { names = await fs.promises.readdir(root); } catch { return scan; }
	for (const name of names) {
		if (!/^[a-zA-Z0-9_-]{5,100}$/.test(name)) continue;
		const file = path.join(root, name, `${name}.messages.json`);
		let st: fs.Stats;
		try { st = await fs.promises.stat(file); } catch { continue; }
		if (!st.isFile() || st.mtimeMs < cutoff) continue;
		scan.files++;
		if (st.size > 16 * 1024 * 1024) { scan.skipped++; continue; }
		try {
			const transcript = JSON.parse(await fs.promises.readFile(file, 'utf8'));
			if (!Array.isArray(transcript?.messages)) { scan.skipped++; continue; }
			const seen = new Set<string>();
			for (const message of transcript.messages) {
				if (message?.role !== 'assistant' || !message.metrics || typeof message.metrics !== 'object') continue;
				const at = metricTime(message.ts);
				if (at === null) continue;
				const id = typeof message.id === 'string' ? message.id : '';
				if (id && seen.has(id)) continue;
				if (id) seen.add(id);
				const m = message.metrics;
				const i = nonnegative(m.inputTokens), o = nonnegative(m.outputTokens);
				const read = nonnegative(m.cacheReadTokens), write = nonnegative(m.cacheWriteTokens);
				const tokens = i === null || o === null ? null : i + o + (read ?? 0) + (write ?? 0);
				addMetric(scan, file, at, cutoff, now, tokens, nonnegative(m.cost), null);
			}
		} catch { scan.skipped++; }
	}
	return scan;
}

export async function collectSourceMetrics(codexRoot: string, clineRoot: string, now = Date.now()): Promise<StatsSourceMetrics> {
	const cutoff = addDays(startOfDay(now), -89);
	const [codex, cline] = await Promise.all([scanCodexMetrics(codexRoot, cutoff, now), scanClineMetrics(clineRoot, cutoff, now)]);
	return summarizeSourceMetrics(codex, cline, now);
}

function summarizeSourceMetrics(codex: MetricScan, cline: MetricScan, now: number): StatsSourceMetrics {
	const period = (source: MetricSource, days: number): StatsSourceMetric => {
		const scan = source === 'codex' ? codex : cline;
		const from = addDays(startOfDay(now), 1 - days);
		let tokens = 0, cost = 0, minutes = 0;
		const files = new Set<string>();
		for (const [key, d] of scan.days) {
			if (new Date(`${key}T12:00:00`).getTime() < from) continue;
			tokens += d.tokens; cost += d.cost; minutes += d.minutes;
			for (const file of d.files) files.add(file);
		}
		return {
			tokens: scan.hasTokens ? Math.round(tokens) : null,
			cost: scan.hasCost ? Math.round(cost * 10000) / 10000 : null,
			durationMinutes: scan.hasMinutes ? Math.round(minutes * 10) / 10 : null,
			records: files.size, files: scan.files, skipped: scan.skipped,
		};
	};
	return {
		'7': { codex: period('codex', 7), cline: period('cline', 7) },
		'30': { codex: period('codex', 30), cline: period('cline', 30) },
		'90': { codex: period('codex', 90), cline: period('cline', 90) },
	};
}

/** Il minimo che serve dei progetti e delle sessioni vive (sottoinsieme dello Snapshot). */
export interface StatsInput {
	projects: { name: string; path: string; sessions?: { sessionId: string }[]; live?: { pid: number }[]; worktrees?: { path: string; branch: string }[] }[];
	live: { pid: number; sessionId: string; cwd: string; status: string; statusSince: number; startedAt: number; title?: string; name?: string }[];
	now?: number;
}

/** Quello che resta di un file letto (in cache su disco). */
interface FileRec {
	size: number;
	mtime: number;
	off: number; // byte letti fino all'ultima riga completa
	head: string; // primi byte in base64: se cambiano, il file e' stato riscritto
	sid: string;
	cwd?: string;
	title?: string;
	touched: string[];
	spans: number[]; // [inizio, fine, inizio, fine, ...] ms, gia' fusi con la regola dei 15 minuti
	tok: Record<string, Record<string, number[]>>; // ora (ms/3600000) -> modello -> [in, out, cr, cw5, cw1, messaggi]
	prompts: Record<string, number>; // ora -> messaggi scritti da Andrea
	keys: [string, number, string, number[]][]; // ultime risposte viste: chiave, ora, modello, valori
}

interface CacheFile {
	schema: number;
	gap: number;
	files: Record<string, FileRec>;
}

// ---------- date locali ----------

const pad = (n: number) => String(n).padStart(2, '0');
export function dayKey(t: number): string {
	const d = new Date(t);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function startOfDay(t: number): number {
	const d = new Date(t);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function addDays(t: number, n: number): number {
	const d = new Date(t);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}
function nextHour(t: number): number {
	const d = new Date(t);
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
}
function parseDay(k: string): number {
	const [y, m, d] = k.split('-').map(Number);
	return new Date(y, m - 1, d).getTime();
}
/** 0 = lunedi' */
const weekday = (t: number) => (new Date(t).getDay() + 6) % 7;
function isoWeek(t: number): string {
	const d = new Date(t);
	const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	const wd = x.getUTCDay() || 7;
	x.setUTCDate(x.getUTCDate() + 4 - wd);
	const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
	const w = Math.ceil(((x.getTime() - y0.getTime()) / DAY + 1) / 7);
	return `${x.getUTCFullYear()}-W${pad(w)}`;
}
const mondayOf = (t: number) => addDays(startOfDay(t), -weekday(t));

/** Spezza [s, e) per ora locale: fn(giorno, ora, minuti). */
function walk(s: number, e: number, fn: (day: string, hour: number, min: number) => void) {
	let c = s;
	while (c < e) {
		const n = Math.min(e, nextHour(c));
		fn(dayKey(c), new Date(c).getHours(), (n - c) / 60_000);
		c = n;
	}
}

// ---------- intervalli ----------

/** Fonde coppie [s, e] (piatte) ordinandole; `gap` tiene insieme intervalli separati da meno di gap. */
export function mergeSpans(flat: number[], gap: number): number[] {
	const pairs: [number, number][] = [];
	for (let i = 0; i + 1 < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
	pairs.sort((a, b) => a[0] - b[0]);
	const out: number[] = [];
	for (const [s, e] of pairs) {
		const n = out.length;
		if (n && s <= out[n - 1] + gap) out[n - 1] = Math.max(out[n - 1], e);
		else out.push(s, e);
	}
	return out;
}

/** Minuti coperti da intervalli piatti dentro [a, b). */
export function minutesIn(flat: number[], a: number, b: number): number {
	let m = 0;
	for (let i = 0; i + 1 < flat.length; i += 2) {
		const s = Math.max(a, flat[i]);
		const e = Math.min(b, flat[i + 1]);
		if (e > s) m += e - s;
	}
	return m / 60_000;
}

function overlap(x: number[], y: number[], a: number, b: number): number {
	let i = 0, j = 0, m = 0;
	while (i + 1 < x.length && j + 1 < y.length) {
		const s = Math.max(x[i], y[j], a);
		const e = Math.min(x[i + 1], y[j + 1], b);
		if (e > s) m += e - s;
		if (x[i + 1] < y[j + 1]) i += 2;
		else j += 2;
	}
	return m / 60_000;
}

/** Dove gira una sessione rispetto al suo progetto (vedi StatsLive.where). `worktrees` sono quelli
 *  del progetto, come li porta lo snapshot della plancia. */
export function whereOf(projPath: string | null, worktrees: { path: string; branch: string }[] | undefined, cwd: string | undefined, home = os.homedir()): string {
	if (!cwd) return '';
	const k = projectKey(cwd);
	if (k === projectKey(home)) return 'dalla home';
	if (!projPath) return `cartella ${path.basename(cwd)}`;
	const pk = projectKey(projPath);
	if (k === pk) return '';
	const dentro = (base: string) => cwd.slice(base.replace(/\/+$/, '').length + 1).replace(/\/+$/, '');
	if (k.startsWith(pk)) return `cartella ${dentro(projPath)}`;
	for (const w of worktrees ?? []) {
		const wk = projectKey(w.path);
		if (!k.startsWith(wk)) continue;
		const name = path.basename(w.path);
		let out = `copia ${name}`;
		if (w.branch && w.branch !== '?' && w.branch !== name) out += `, ramo ${w.branch}`;
		if (k !== wk) out += `, cartella ${dentro(w.path)}`;
		return out;
	}
	// un worktree che lo snapshot non elenca: canonKey lo riconduce comunque al progetto
	return `${canonKey(cwd) !== k ? 'copia' : 'cartella'} ${path.basename(cwd)}`;
}

/** Le ultime 168 ore fino a quella in corso: quante sessioni insieme, ora per ora. `spans` sono gli
 *  intervalli (gia' fusi) di ogni sessione. */
export function concurrency(spans: number[][], now: number): StatsConcurrency {
	const d = new Date(now);
	const b: number[] = [];
	for (let i = 0; i <= 168; i++) b.push(new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() - 167 + i).getTime());
	const a = b[0], z = b[168];
	const sessMs = new Array(168).fill(0);
	const busyMs = new Array(168).fill(0);
	const peak = new Array(168).fill(0);
	const ev: [number, number][] = [];
	for (const sp of spans) {
		for (let i = 0; i + 1 < sp.length; i += 2) {
			const s = Math.max(a, sp[i]);
			const e = Math.min(z, sp[i + 1]);
			if (e > s) ev.push([s, 1], [e, -1]);
		}
	}
	// a parita' di istante chi finisce esce prima di chi entra: due sessioni in fila non sono insieme
	ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	const ora = (t: number) => {
		let lo = 0, hi = 167;
		while (lo < hi) {
			const m = (lo + hi + 1) >> 1;
			if (b[m] <= t) lo = m;
			else hi = m - 1;
		}
		return lo;
	};
	let c = 0, last = a;
	for (const [t, dl] of ev) {
		if (t > last && c > 0) {
			for (let k = ora(last), j = ora(t - 1); k <= j; k++) {
				const e = Math.min(t, b[k + 1]) - Math.max(last, b[k]);
				if (e <= 0) continue;
				sessMs[k] += c * e;
				busyMs[k] += e;
				if (c > peak[k]) peak[k] = c;
			}
		}
		c += dl;
		last = t;
	}
	return {
		start: a,
		avg: busyMs.map((m, k) => (m > 0 ? Math.round((sessMs[k] / m) * 10) / 10 : 0)),
		peak,
		busy: busyMs.map(m => Math.round(m / 60_000)),
	};
}

/** Fasce di durata e mediana da una lista di minuti. */
export function lengthsOf(mins: number[]): StatsLengths {
	const bins = new Array(LENGTH_EDGES.length + 1).fill(0);
	for (const m of mins) {
		const i = LENGTH_EDGES.findIndex(e => m < e);
		bins[i < 0 ? LENGTH_EDGES.length : i]++;
	}
	const s = mins.slice().sort((x, y) => x - y);
	const n = s.length;
	const median = !n ? 0 : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
	return { edges: LENGTH_EDGES.slice(), bins, median: Math.round(median * 10) / 10, n };
}

// ---------- lettura di un file ----------

class Yielder {
	private last = performance.now();
	busyMs = 0;
	async maybe() {
		const now = performance.now();
		if (now - this.last > 12) {
			this.busyMs += now - this.last;
			await new Promise(r => setImmediate(r));
			this.last = performance.now();
		}
	}
}

function isPrompt(d: any): boolean {
	if (d.isMeta || d.toolUseResult || d.isCompactSummary) return false;
	const c = d.message?.content;
	if (typeof c === 'string') return !!c.trim() && !c.startsWith('<');
	if (!Array.isArray(c)) return false;
	if (c.some((p: any) => p?.type === 'tool_result')) return false;
	const t = c.find((p: any) => p?.type === 'text')?.text;
	return typeof t === 'string' && !!t.trim() && !t.startsWith('<');
}

interface Ctx {
	rec: FileRec;
	times: number[];
	seen: Map<string, { h: number; m: string; v: number[] }>;
	touched: Set<string>;
}

function addTok(rec: FileRec, h: number, m: string, v: number[], msgs: number) {
	const hb = (rec.tok[h] ??= {});
	const a = (hb[m] ??= [0, 0, 0, 0, 0, 0]);
	for (let i = 0; i < 5; i++) a[i] += v[i];
	a[5] += msgs;
}

function touch(ctx: Ctx, p: unknown) {
	if (typeof p === 'string' && p.startsWith('/') && ctx.touched.size < TOUCHED_MAX && !ctx.touched.has(p)) {
		ctx.touched.add(p);
		ctx.rec.touched.push(p);
	}
}

function handleLine(ctx: Ctx, buf: Buffer) {
	if (buf.length < 40) return;
	const isTitle = buf.indexOf('"type":"ai-title"') >= 0 && buf.length < 4096;
	if (!isTitle && buf.indexOf('"timestamp":"') < 0) return;
	let d: any;
	try {
		d = JSON.parse(buf.toString('utf8'));
	} catch {
		return; // riga scritta a meta' o rovinata
	}
	const rec = ctx.rec;
	if (d.type === 'ai-title') {
		if (typeof d.aiTitle === 'string') rec.title = d.aiTitle;
		return;
	}
	if (d.type !== 'user' && d.type !== 'assistant' && d.type !== 'system') return;
	const t = Date.parse(d.timestamp);
	if (!Number.isFinite(t)) return;
	ctx.times.push(t);
	if (!rec.cwd && typeof d.cwd === 'string') {
		rec.cwd = d.cwd;
		touch(ctx, d.cwd);
	}
	const h = Math.floor(t / HOUR);
	if (d.type === 'user') {
		if (!d.isSidechain && isPrompt(d)) rec.prompts[h] = (rec.prompts[h] ?? 0) + 1;
		return;
	}
	if (d.type !== 'assistant') return;
	const msg = d.message;
	if (Array.isArray(msg?.content)) {
		for (const p of msg.content) {
			if (p?.type === 'tool_use' && p.input) {
				touch(ctx, p.input.file_path);
				touch(ctx, p.input.notebook_path);
			}
		}
	}
	const u = msg?.usage;
	const model = msg?.model;
	if (!u || typeof model !== 'string' || model === '<synthetic>') return;
	const cw = +u.cache_creation_input_tokens || 0;
	const cw1 = Math.min(cw, +u.cache_creation?.ephemeral_1h_input_tokens || 0);
	const v = [+u.input_tokens || 0, +u.output_tokens || 0, +u.cache_read_input_tokens || 0, cw - cw1, cw1];
	const key = `${msg.id}:${d.requestId}`;
	const old = ctx.seen.get(key);
	if (old) {
		const delta = v.map((x, i) => Math.max(0, x - old.v[i]));
		if (delta.some(x => x > 0)) {
			addTok(rec, old.h, old.m, delta, 0);
			old.v = old.v.map((x, i) => Math.max(x, v[i]));
		}
		ctx.seen.delete(key);
		ctx.seen.set(key, old);
	} else {
		addTok(rec, h, model, v, 1);
		ctx.seen.set(key, { h, m: model, v });
	}
}

async function readHead(file: string): Promise<string> {
	const fh = await fs.promises.open(file, 'r');
	try {
		const b = Buffer.alloc(48);
		const { bytesRead } = await fh.read(b, 0, 48, 0);
		return b.subarray(0, bytesRead).toString('base64');
	} finally {
		await fh.close();
	}
}

function emptyRec(sid: string): FileRec {
	return { size: 0, mtime: 0, off: 0, head: '', sid, touched: [], spans: [], tok: {}, prompts: {}, keys: [] };
}

/** Legge (o riprende) un file. Restituisce i byte letti. */
async function readFile(file: string, st: fs.Stats, sid: string, prev: FileRec | undefined, y: Yielder): Promise<{ rec: FileRec; bytes: number }> {
	const head = await readHead(file);
	const resume = !!prev && prev.head === head && st.size >= prev.off && prev.off > 0;
	const rec: FileRec = resume ? { ...prev!, touched: [...prev!.touched], tok: prev!.tok, prompts: prev!.prompts } : emptyRec(sid);
	rec.head = head;
	rec.sid = sid;
	const ctx: Ctx = {
		rec,
		times: [],
		seen: new Map(rec.keys.map(([k, h, m, v]) => [k, { h, m, v }])),
		touched: new Set(rec.touched),
	};
	const start = rec.off;
	const fh = await fs.promises.open(file, 'r');
	try {
		const CH = 1 << 20;
		const buf = Buffer.allocUnsafe(CH);
		let pos = rec.off;
		let carry: Buffer[] = [];
		while (pos < st.size) {
			const { bytesRead } = await fh.read(buf, 0, Math.min(CH, st.size - pos), pos);
			if (!bytesRead) break;
			let from = 0;
			for (;;) {
				const nl = buf.indexOf(10, from);
				if (nl < 0 || nl >= bytesRead) break;
				const piece = buf.subarray(from, nl);
				const line = carry.length ? Buffer.concat([...carry, piece]) : piece;
				carry = [];
				handleLine(ctx, line);
				rec.off = pos + nl + 1;
				from = nl + 1;
				await y.maybe();
			}
			if (from < bytesRead) carry.push(Buffer.from(buf.subarray(from, bytesRead)));
			pos += bytesRead;
		}
	} finally {
		await fh.close();
	}
	// L'ultima riga senza a capo resta da leggere: Claude Code la sta ancora scrivendo.
	if (ctx.times.length) {
		const flat = rec.spans.slice();
		for (const t of ctx.times) flat.push(t, t);
		rec.spans = mergeSpans(flat, GAP);
	}
	rec.keys = [...ctx.seen].slice(-KEYS_TAIL).map(([k, o]) => [k, o.h, o.m, o.v]);
	rec.size = st.size;
	rec.mtime = st.mtimeMs;
	return { rec, bytes: rec.off - start };
}

// ---------- elenco dei file ----------

interface Entry {
	file: string;
	sid: string;
}

async function listFiles(root: string): Promise<Entry[]> {
	const out: Entry[] = [];
	let dirs: fs.Dirent[] = [];
	try {
		dirs = await fs.promises.readdir(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const d of dirs) {
		if (!d.isDirectory()) continue;
		const dir = path.join(root, d.name);
		let ents: fs.Dirent[];
		try {
			ents = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of ents) {
			if (e.isFile() && e.name.endsWith('.jsonl')) {
				out.push({ file: path.join(dir, e.name), sid: e.name.slice(0, -6) });
			} else if (e.isDirectory()) {
				// <sessione>/subagents/*.jsonl; le altre cartelle (memory, ...) non hanno subagents
				const sub = path.join(dir, e.name, 'subagents');
				let subs: string[] = [];
				try {
					subs = await fs.promises.readdir(sub);
				} catch {
					continue;
				}
				for (const f of subs) if (f.endsWith('.jsonl')) out.push({ file: path.join(sub, f), sid: e.name });
			}
		}
	}
	return out;
}

// ---------- il motore ----------

interface DayAcc {
	you: number;
	claude: number;
	prompts: number;
	tok: number[];
	cost: number;
	sessions: Set<string>;
	hours: number[]; // minuti tuoi per ora
}
const newDay = (): DayAcc => ({ you: 0, claude: 0, prompts: 0, tok: [0, 0, 0, 0], cost: 0, sessions: new Set(), hours: new Array(24).fill(0) });

interface ProjAcc {
	key: string;
	name: string;
	path: string | null;
	spans: number[];
	days: Map<string, DayAcc>;
	last: number;
}

/** Intervalli di lavoro (gia' fusi, ms) di ogni progetto, chiave: path del progetto o null per le sessioni fuori.
 *  Lo usano le ore per cliente (src/clienti.ts), che fanno l'unione tra progetti dello stesso cliente. */
export type Ledger = Map<string | null, { name: string; spans: number[] }>;

export interface StatsEngineOptions {
	storageDir?: string;
	projectsDir?: string;
	codexSessionsDir?: string;
	clineSessionsDir?: string;
	log?: (s: string) => void;
}

export class StatsEngine {
	private cache: CacheFile | undefined;
	private dirty = false;
	private running: Promise<Stats> | undefined;
	private readonly root: string;
	private readonly cacheFile: string | undefined;
	private readonly codexRoot: string | undefined;
	private readonly clineRoot: string | undefined;
	private readonly codexScanCache: CodexScanCache = new Map();
	/** Tempi dell'ultimo calcolo, per il banco di prova. */
	lastTiming = { listMs: 0, readMs: 0, aggregateMs: 0, saveMs: 0, busyMs: 0 };
	/** Intervalli per progetto dell'ultimo calcolo. */
	lastLedger: Ledger = new Map();

	constructor(private readonly opts: StatsEngineOptions = {}) {
		this.root = opts.projectsDir ?? path.join(os.homedir(), '.claude', 'projects');
		this.cacheFile = opts.storageDir ? path.join(opts.storageDir, 'cruscotto-cache.json') : undefined;
		// Una root Claude finta nei test non deve leggere i registri personali del Mac.
		this.codexRoot = opts.codexSessionsDir ?? (opts.projectsDir ? undefined : path.join(os.homedir(), '.codex', 'sessions'));
		this.clineRoot = opts.clineSessionsDir ?? (opts.projectsDir ? undefined : path.join(os.homedir(), '.cline', 'data', 'sessions'));
	}

	/** Un calcolo alla volta: chi chiede mentre si calcola riceve lo stesso risultato. */
	compute(input: StatsInput): Promise<Stats> {
		if (this.running) return this.running;
		this.running = this.run(input).finally(() => (this.running = undefined));
		return this.running;
	}

	/** Intervalli di lavoro per sessione dell'ultimo calcolo (sessione principale e sottoagenti fusi):
	 *  servono a pesare le categorie del lavoro con i minuti veri (docs/CONTRATTI.md, 7.3). */
	sessionSpans(): { sid: string; spans: number[] }[] {
		const by = new Map<string, [number, number][]>();
		for (const f of Object.values(this.cache?.files ?? {})) {
			if (!f.sid || !f.spans.length) continue;
			const list = by.get(f.sid) ?? [];
			for (let i = 0; i + 1 < f.spans.length; i += 2) list.push([f.spans[i], f.spans[i + 1]]);
			by.set(f.sid, list);
		}
		return [...by].map(([sid, pairs]) => {
			pairs.sort((a, b) => a[0] - b[0]);
			const spans: number[] = [];
			for (const [a, b] of pairs) {
				if (spans.length && a <= spans[spans.length - 1]) spans[spans.length - 1] = Math.max(spans[spans.length - 1], b);
				else spans.push(a, b);
			}
			return { sid, spans };
		});
	}

	/** Firma per capire se vale la pena rimandare i dati alla plancia. */
	static signature(s: Stats): string {
		const { computedAt, ms, files, ...rest } = s;
		return JSON.stringify(rest);
	}

	private async load(): Promise<CacheFile> {
		if (this.cache) return this.cache;
		let c: CacheFile | undefined;
		if (this.cacheFile) {
			try {
				const raw = JSON.parse(await fs.promises.readFile(this.cacheFile, 'utf8'));
				if (raw?.schema === SCHEMA && raw?.gap === GAP && raw.files) c = raw;
			} catch {
				// prima volta, o cache rovinata: si rilegge tutto
			}
		}
		this.cache = c ?? { schema: SCHEMA, gap: GAP, files: {} };
		return this.cache;
	}

	private async save() {
		if (!this.cacheFile || !this.dirty || !this.cache) return;
		const tmp = this.cacheFile + '.tmp';
		await fs.promises.mkdir(path.dirname(this.cacheFile), { recursive: true });
		await fs.promises.writeFile(tmp, JSON.stringify(this.cache));
		await fs.promises.rename(tmp, this.cacheFile);
		this.dirty = false;
	}

	private async run(input: StatsInput): Promise<Stats> {
		const at = input.now ?? Date.now();
		const t0 = performance.now();
		const y = new Yielder();
		const cache = await this.load();
		const entries = await listFiles(this.root);
		const t1 = performance.now();
		const next: Record<string, FileRec> = {};
		let read = 0, cached = 0, bytes = 0;
		for (const e of entries) {
			let st: fs.Stats;
			try {
				st = await fs.promises.stat(e.file);
			} catch {
				continue;
			}
			const prev = cache.files[e.file];
			if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) {
				next[e.file] = prev;
				cached++;
				continue;
			}
			try {
				const r = await readFile(e.file, st, e.sid, prev, y);
				next[e.file] = r.rec;
				bytes += r.bytes;
				read++;
				this.dirty = true;
			} catch (err) {
				this.opts.log?.(`cruscotto: non riesco a leggere ${e.file}: ${err}`);
				if (prev) next[e.file] = prev;
			}
			await y.maybe();
		}
		if (Object.keys(cache.files).length !== Object.keys(next).length) this.dirty = true;
		cache.files = next;
		const t2 = performance.now();
		const ledger: Ledger = new Map();
		const stats = aggregate(next, input, at, ledger);
		if (this.codexRoot || this.clineRoot) {
			try {
				const cutoff = addDays(startOfDay(at), 1 - DAYS_KEPT);
				const [codex, cline] = await Promise.all([
					this.codexRoot ? scanCodexMetrics(this.codexRoot, cutoff, at, this.codexScanCache) : metricScan(),
					this.clineRoot ? scanClineMetrics(this.clineRoot, cutoff, at) : metricScan(),
				]);
				stats.sourceMetrics = summarizeSourceMetrics(codex, cline, at);
				stats.workTime = summarizeWorkTime([...ledger.values()].flatMap(p => p.spans), codex.spans, at);
			}
			catch (err) {
				this.opts.log?.(`cruscotto: metriche delle altre fonti non disponibili: ${err}`);
				throw err;
			}
		}
		this.lastLedger = ledger;
		const t3 = performance.now();
		try {
			await this.save();
		} catch (err) {
			this.opts.log?.(`cruscotto: non riesco a salvare la cache: ${err}`);
		}
		const t4 = performance.now();
		this.lastTiming = { listMs: t1 - t0, readMs: t2 - t1, aggregateMs: t3 - t2, saveMs: t4 - t3, busyMs: y.busyMs };
		stats.ms = Math.round(t4 - t0);
		stats.files = { total: entries.length, read, cached, mb: Math.round((bytes / 1048576) * 10) / 10 };
		return stats;
	}
}

// ---------- aggregazione ----------

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const tok4 = (v: number[]): Tok => [v[0], v[1], v[2], v[3]];
const tokSum = (t: number[]) => t[0] + t[1] + t[2] + t[3];

export function aggregate(files: Record<string, FileRec>, input: StatsInput, now: number, ledger?: Ledger): Stats {
	// 1. sessioni: file principale + sottoagenti
	interface Sess {
		sid: string;
		cwd?: string;
		title?: string;
		touched: string[];
		flat: number[];
		recs: FileRec[];
		project?: ProjAcc;
		spans: number[];
	}
	const sessions = new Map<string, Sess>();
	for (const [file, rec] of Object.entries(files)) {
		let s = sessions.get(rec.sid);
		if (!s) sessions.set(rec.sid, (s = { sid: rec.sid, touched: [], flat: [], recs: [], spans: [] }));
		const main = !file.includes(`${path.sep}subagents${path.sep}`);
		if (rec.cwd && (main || !s.cwd)) s.cwd = rec.cwd;
		if (main && rec.title) s.title = rec.title;
		s.touched.push(...rec.touched);
		s.flat.push(...rec.spans);
		s.recs.push(rec);
	}

	// 2. progetti: stessa attribuzione della plancia
	const projects = new Map<string, ProjAcc>();
	const keys: string[] = [];
	const known = new Map<string, string>(); // sessione -> chiave, dalla plancia
	for (const p of input.projects) {
		const k = projectKey(p.path);
		if (projects.has(k)) continue;
		keys.push(k);
		projects.set(k, { key: k, name: p.name, path: p.path, spans: [], days: new Map(), last: 0 });
		for (const s of p.sessions ?? []) known.set(s.sessionId, k);
	}
	const elsewhere: ProjAcc = { key: '', name: 'Fuori dai progetti', path: null, spans: [], days: new Map(), last: 0 };
	projects.set('', elsewhere);

	const days = new Map<string, DayAcc>();
	const dayOf = (m: Map<string, DayAcc>, k: string) => {
		let d = m.get(k);
		if (!d) m.set(k, (d = newDay()));
		return d;
	};
	const models = new Map<string, Map<string, { tok: number[]; msgs: number; cost: number }>>();
	let unpriced = 0;
	let firstEvent = Infinity;
	const allSessionSpans: number[][] = [];
	const sessTok = new Map<string, Map<number, number>>(); // sessione -> ora -> token (per le sessioni vive)

	for (const s of sessions.values()) {
		s.spans = mergeSpans(s.flat, GAP);
		const k = known.get(s.sid) ?? (s.cwd ? sessionOwner(keys, s.cwd, s.touched) : undefined);
		const proj = (k !== undefined && projects.get(k)) || elsewhere;
		s.project = proj;
		if (s.spans.length) {
			firstEvent = Math.min(firstEvent, s.spans[0]);
			proj.last = Math.max(proj.last, s.spans[s.spans.length - 1]);
			allSessionSpans.push(s.spans);
			proj.spans.push(...s.spans);
		}
		for (let i = 0; i + 1 < s.spans.length; i += 2) {
			walk(s.spans[i], s.spans[i + 1], (day, _h, min) => {
				const g = dayOf(days, day);
				g.claude += min;
				g.sessions.add(s.sid);
				const pd = dayOf(proj.days, day);
				pd.claude += min;
				pd.sessions.add(s.sid);
			});
		}
		const perHour = new Map<number, number>();
		for (const rec of s.recs) {
			for (const [h, n] of Object.entries(rec.prompts)) {
				const day = dayKey(+h * HOUR);
				const g = dayOf(days, day);
				g.prompts += n;
				g.sessions.add(s.sid);
				const pd = dayOf(proj.days, day);
				pd.prompts += n;
				pd.sessions.add(s.sid);
			}
			for (const [h, byModel] of Object.entries(rec.tok)) {
				const day = dayKey(+h * HOUR);
				const g = dayOf(days, day);
				const pd = dayOf(proj.days, day);
				for (const [model, v] of Object.entries(byModel)) {
					const c = costOf(model, v);
					const t = [v[0], v[1], v[2], v[3] + v[4]];
					for (let i = 0; i < 4; i++) {
						g.tok[i] += t[i];
						pd.tok[i] += t[i];
					}
					if (c === null) unpriced += tokSum(t);
					else {
						g.cost += c;
						pd.cost += c;
					}
					let mm = models.get(model);
					if (!mm) models.set(model, (mm = new Map()));
					const md = mm.get(day) ?? { tok: [0, 0, 0, 0], msgs: 0, cost: 0 };
					for (let i = 0; i < 4; i++) md.tok[i] += t[i];
					md.msgs += v[5];
					md.cost += c ?? 0;
					mm.set(day, md);
					perHour.set(+h, (perHour.get(+h) ?? 0) + tokSum(t));
				}
			}
		}
		sessTok.set(s.sid, perHour);
	}

	// 3. unioni: le tue ore (tutte le sessioni) e quelle per progetto
	const union = mergeSpans(allSessionSpans.flat(), 0);
	for (let i = 0; i + 1 < union.length; i += 2) {
		walk(union[i], union[i + 1], (day, h, min) => {
			const g = dayOf(days, day);
			g.you += min;
			g.hours[h] += min;
		});
	}
	for (const p of projects.values()) {
		p.spans = mergeSpans(p.spans, 0);
		if (ledger && p.spans.length) ledger.set(p.path, { name: p.name, spans: p.spans });
		for (let i = 0; i + 1 < p.spans.length; i += 2) {
			walk(p.spans[i], p.spans[i + 1], (day, h, min) => {
				const pd = dayOf(p.days, day);
				pd.you += min;
				pd.hours[h] += min;
			});
		}
	}

	// 4. finestre
	const today0 = startOfDay(now);
	const todayKey = dayKey(now);
	const keysBack = (n: number, offset = 0) => {
		const out: string[] = [];
		for (let i = n - 1 + offset; i >= offset; i--) out.push(dayKey(addDays(today0, -i)));
		return out;
	};
	const totals = (m: Map<string, DayAcc>, ks: string[]): StatsTotals & { sids: Set<string> } => {
		const t = { you: 0, claude: 0, tok: [0, 0, 0, 0] as Tok, cost: 0, sessions: 0, prompts: 0, activeDays: 0, sids: new Set<string>() };
		for (const k of ks) {
			const d = m.get(k);
			if (!d) continue;
			t.you += d.you;
			t.claude += d.claude;
			for (let i = 0; i < 4; i++) t.tok[i] += d.tok[i];
			t.cost += d.cost;
			t.prompts += d.prompts;
			if (d.you >= 1) t.activeDays++;
			for (const s of d.sessions) t.sids.add(s);
		}
		t.sessions = t.sids.size;
		return t;
	};
	const clean = (t: StatsTotals): StatsTotals => ({
		you: r1(t.you),
		claude: r1(t.claude),
		tok: t.tok,
		cost: r2(t.cost),
		sessions: t.sessions,
		prompts: t.prompts,
		activeDays: t.activeDays,
	});

	/** Progetto di una sessione viva: dal registro letto, altrimenti da come l'ha attribuita la plancia. */
	const liveProject = (l: StatsInput['live'][number]): ProjAcc => {
		const s = sessions.get(l.sessionId);
		if (s?.project) return s.project;
		const owner = input.projects.find(pr => pr.live?.some(x => x.pid === l.pid));
		return (owner && projects.get(projectKey(owner.path))) || elsewhere;
	};
	const liveCount = new Map<ProjAcc, number>();
	for (const l of input.live) {
		const p = liveProject(l);
		liveCount.set(p, (liveCount.get(p) ?? 0) + 1);
	}

	const period = (n: number): StatsPeriod => {
		const ks = keysBack(n);
		const prevKs = keysBack(n, n);
		const a = addDays(today0, -(n - 1));
		const cur = totals(days, ks);
		const prev = totals(days, prevKs);
		// massimo di sessioni insieme
		const ev: [number, number][] = [];
		for (const sp of allSessionSpans) {
			for (let i = 0; i + 1 < sp.length; i += 2) {
				const s = Math.max(a, sp[i]);
				const e = Math.min(now, sp[i + 1]);
				if (e > s) ev.push([s, 1], [e, -1]);
			}
		}
		ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
		let c = 0;
		const peak = { n: 0, at: 0 };
		for (const [t, d] of ev) {
			c += d;
			if (c > peak.n) {
				peak.n = c;
				peak.at = t;
			}
		}
		// progetti
		const rows: (StatsProject & { acc: ProjAcc })[] = [];
		const stalled: StatsPeriod['stalled'] = [];
		for (const p of projects.values()) {
			const t = totals(p.days, ks);
			const pv = totals(p.days, prevKs);
			if (t.you < 0.5 && tokSum(t.tok) === 0) {
				if (p.path && pv.you >= STALLED_MIN) stalled.push({ name: p.name, path: p.path, prev: r1(pv.you), last: p.last });
				continue;
			}
			const hours = new Array(24).fill(0);
			const daily: number[] = [];
			for (const k of ks) {
				const d = p.days.get(k);
				daily.push(r1(d?.you ?? 0));
				if (d) for (let h = 0; h < 24; h++) hours[h] += d.hours[h];
			}
			rows.push({
				acc: p,
				name: p.name,
				path: p.path,
				you: r1(t.you),
				claude: r1(t.claude),
				tok: t.tok,
				cost: r2(t.cost),
				sessions: t.sessions,
				prev: { you: r1(pv.you), claude: r1(pv.claude), tok: tokSum(pv.tok), cost: r2(pv.cost) },
				last: p.last,
				daily,
				hours: hours.map(r1),
				live: liveCount.get(p) ?? 0,
			});
		}
		rows.sort((x, y) => y.you - x.you || tokSum(y.tok) - tokSum(x.tok));
		// costellazioni: progetti con ore in comune
		const edges: StatsPeriod['edges'] = [];
		const top = rows.filter(r => r.path).slice(0, 24);
		for (let i = 0; i < top.length; i++) {
			for (let j = i + 1; j < top.length; j++) {
				const m = overlap(top[i].acc.spans, top[j].acc.spans, a, now);
				if (m >= 20) edges.push({ a: top[i].name, b: top[j].name, minutes: r1(m) });
			}
		}
		edges.sort((x, y) => y.minutes - x.minutes);
		stalled.sort((x, y) => y.prev - x.prev);
		// quanto dura una sessione: i suoi minuti di lavoro dentro il periodo
		const lens: number[] = [];
		for (const s of sessions.values()) {
			const m = minutesIn(s.spans, a, now + 1);
			if (m >= 1) lens.push(m);
		}
		// modelli
		const ms: StatsModel[] = [];
		for (const [id, mm] of models) {
			const t = [0, 0, 0, 0];
			let msgs = 0, cost = 0;
			for (const k of ks) {
				const d = mm.get(k);
				if (!d) continue;
				for (let i = 0; i < 4; i++) t[i] += d.tok[i];
				msgs += d.msgs;
				cost += d.cost;
			}
			if (!msgs && !tokSum(t)) continue;
			ms.push({ id, name: modelName(id), tok: tok4(t), messages: msgs, cost: priceOf(id) ? r2(cost) : null });
		}
		ms.sort((x, y) => tokSum(y.tok) - tokSum(x.tok));
		// la settimana ora per ora
		const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
		for (const k of ks) {
			const d = days.get(k);
			if (!d) continue;
			const wd = weekday(parseDay(k));
			for (let h = 0; h < 24; h++) heat[wd][h] += d.hours[h];
		}
		return {
			days: n,
			from: ks[0],
			...clean(cur),
			avgSession: cur.sessions ? r1(cur.claude / cur.sessions) : 0,
			peak,
			prev: clean(prev),
			projects: rows.map(({ acc, ...r }) => r),
			edges: edges.slice(0, 16),
			models: ms,
			heat: heat.map(row => row.map(r1)),
			lengths: lengthsOf(lens),
			stalled: stalled.slice(0, 8),
		};
	};

	// 5. giorni, settimane, mesi
	const dayRow = (k: string): StatsDay => {
		const d = days.get(k);
		return d
			? { date: k, you: r1(d.you), claude: r1(d.claude), sessions: d.sessions.size, prompts: d.prompts, tok: tok4(d.tok), cost: r2(d.cost) }
			: { date: k, you: 0, claude: 0, sessions: 0, prompts: 0, tok: [0, 0, 0, 0], cost: 0 };
	};
	const binOf = (key: string, ks: string[]): StatsBin => {
		const t = totals(days, ks);
		return { key, start: ks[0], end: ks[ks.length - 1], ...clean(t) };
	};
	const windowStart = addDays(today0, -(DAYS_KEPT - 1));
	const weeks: StatsBin[] = [];
	for (let m = mondayOf(windowStart); m <= today0; m = addDays(m, 7)) {
		const ks: string[] = [];
		for (let i = 0; i < 7; i++) {
			const d = addDays(m, i);
			if (d <= today0) ks.push(dayKey(d));
		}
		weeks.push(binOf(isoWeek(m), ks));
	}
	const months: StatsBin[] = [];
	{
		const w = new Date(windowStart);
		for (let m = new Date(w.getFullYear(), w.getMonth(), 1).getTime(); m <= today0; ) {
			const d = new Date(m);
			const nextM = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
			const ks: string[] = [];
			for (let x = m; x < nextM && x <= today0; x = addDays(x, 1)) ks.push(dayKey(x));
			months.push(binOf(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`, ks));
			m = nextM;
		}
	}

	// 6. serie, record, settimana in corso
	const allDays = [...days.keys()].sort();
	let best = 0, bestEnd: string | null = null, run = 0, prevDay = '';
	for (const k of allDays) {
		const ok = (days.get(k)?.you ?? 0) >= STREAK_MINUTES;
		if (!ok) {
			run = 0;
			prevDay = k;
			continue;
		}
		run = prevDay && dayKey(addDays(parseDay(prevDay), 1)) === k && run > 0 ? run + 1 : 1;
		prevDay = k;
		if (run > best) {
			best = run;
			bestEnd = k;
		}
	}
	let current = 0;
	{
		// oggi non ancora arrivato alla mezz'ora non spezza la serie
		let d = (days.get(todayKey)?.you ?? 0) >= STREAK_MINUTES ? today0 : addDays(today0, -1);
		while ((days.get(dayKey(d))?.you ?? 0) >= STREAK_MINUTES) {
			current++;
			d = addDays(d, -1);
		}
	}
	let busiest: Stats['records']['busiestDay'] = null;
	let tokenDay: Stats['records']['tokenDay'] = null;
	for (const [k, d] of days) {
		if (!busiest || d.you > busiest.you) busiest = { date: k, you: r1(d.you) };
		const t = tokSum(d.tok);
		if (!tokenDay || t > tokenDay.tok) tokenDay = { date: k, tok: t };
	}
	let stint: Stats['records']['longestStint'] = null;
	for (let i = 0; i + 1 < union.length; i += 2) {
		const m = (union[i + 1] - union[i]) / 60_000;
		if (!stint || m > stint.minutes) stint = { start: union[i], minutes: r1(m) };
	}

	const mon = mondayOf(now);
	const tokIn = (a: number, b: number) => {
		let t = 0;
		for (const s of sessions.values()) for (const [h, n] of sessTok.get(s.sid) ?? []) if (h * HOUR >= a && h * HOUR < b) t += n;
		return t;
	};
	const claudeIn = (a: number, b: number) => allSessionSpans.reduce((m, sp) => m + minutesIn(sp, a, b), 0);
	const slice = (a: number, b: number) => ({ you: r1(minutesIn(union, a, b)), claude: r1(claudeIn(a, b)), tok: tokIn(a, b) });

	// 7. sessioni vive
	const wtOf = new Map<string, { path: string; branch: string }[]>();
	for (const p of input.projects) if (p.worktrees?.length) wtOf.set(projectKey(p.path), p.worktrees);
	const whereFor = (p: ProjAcc, cwd: string | undefined) => whereOf(p.path, p.path ? wtOf.get(projectKey(p.path)) : undefined, cwd);
	const live: StatsLive[] = input.live.map(l => {
		const s = sessions.get(l.sessionId);
		const p = liveProject(l);
		let tokToday = 0;
		for (const [h, n] of sessTok.get(l.sessionId) ?? []) if (h * HOUR >= today0) tokToday += n;
		return {
			pid: l.pid,
			sessionId: l.sessionId,
			project: p.path ? p.name : l.cwd === os.homedir() ? 'home' : path.basename(l.cwd),
			path: p.path,
			title: s?.title ?? l.title ?? l.name ?? '',
			status: l.status,
			since: l.statusSince,
			started: s?.spans[0] ?? l.startedAt,
			today: r1(s ? minutesIn(s.spans, today0, now + 1) : 0),
			tokToday,
			cwd: l.cwd,
			where: whereFor(p, l.cwd),
		};
	});

	// 8. la giornata, sessione per sessione
	const liveIds = new Map(input.live.map(l => [l.sessionId, l]));
	let todaySessions: StatsTodaySession[] = [];
	for (const s of sessions.values()) {
		const sp: number[] = [];
		let m = 0;
		for (let i = 0; i + 1 < s.spans.length; i += 2) {
			if (s.spans[i + 1] < today0 || s.spans[i] > now) continue;
			const a = Math.max(today0, s.spans[i]);
			const e = Math.min(now, s.spans[i + 1]);
			sp.push(r1((a - today0) / 60_000), r1((e - today0) / 60_000));
			m += e - a;
		}
		const l = liveIds.get(s.sid);
		if (!sp.length || (m < 30_000 && !l)) continue;
		const p = s.project ?? elsewhere;
		let tok = 0;
		for (const [h, n] of sessTok.get(s.sid) ?? []) if (h * HOUR >= today0) tok += n;
		todaySessions.push({ sid: s.sid, project: p.name, path: p.path, title: s.title ?? l?.title ?? '', where: whereFor(p, s.cwd), spans: sp, tok, live: !!l });
	}
	todaySessions.sort((x, y) => x.spans[0] - y.spans[0]);
	todaySessions = todaySessions.slice(-TODAY_MAX);

	const todayRow = days.get(todayKey);
	const perModel: Record<string, [number, number, number]> = {};
	for (const id of models.keys()) {
		const pr = priceOf(id);
		if (pr) perModel[pr.name] = pr.p;
	}

	return {
		version: 1,
		computedAt: now,
		ms: 0,
		files: { total: 0, read: 0, cached: 0, mb: 0 },
		gapMinutes: GAP_MINUTES,
		streakMinutes: STREAK_MINUTES,
		tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
		firstEvent: Number.isFinite(firstEvent) ? firstEvent : 0,
		today: {
			date: todayKey,
			you: r1(todayRow?.you ?? 0),
			claude: r1(todayRow?.claude ?? 0),
			tok: todayRow ? tokSum(todayRow.tok) : 0,
			sessions: todayRow?.sessions.size ?? 0,
		},
		week: {
			start: dayKey(mon),
			now: slice(mon, now + 1),
			prevSoFar: slice(mon - 7 * DAY, now + 1 - 7 * DAY),
			prevFull: slice(addDays(mon, -7), mon),
		},
		days: keysBack(DAYS_KEPT).map(dayRow),
		weeks,
		months,
		periods: { '7': period(7), '30': period(30), '90': period(90) },
		streak: { current, best, bestEnd },
		records: { busiestDay: busiest, longestStint: stint, tokenDay },
		live,
		prices: { note: PRICE_NOTE, perModel },
		unpricedTokens: unpriced,
		todaySessions,
		concurrency7: concurrency(allSessionSpans, now),
		workTime: summarizeWorkTime(union, [], now),
	};
}
