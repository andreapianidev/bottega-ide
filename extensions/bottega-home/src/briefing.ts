/* Il briefing del mattino e i consigli della Home.

   Tutti e due nascono dagli stessi fatti, raccolti qui senza inventare niente: ore e progetti di ieri (cruscotto),
   lavori che aspettano, novita' dallo Store, soldi di ieri, regole violate, progetti dimenticati, la notte.
   - Il briefing si fa una volta al giorno: Melissa lo scrive con la sua voce (Agnes, ripiego Apple Intelligence,
     ripiego frasi fisse) e lo dice in una trentina di secondi. Mai insistente: una volta, poi resta una card.
   - I consigli li scrive Apple Intelligence sul Mac (ai.generate del Nucleo), da 3 a 5 frasi; senza Apple
     Intelligence restano consigli fissi ricavati dalle regole.
   Contratto: docs/CONTRATTI.md, 4.1 (Briefing) e 4.7 (Advice). */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Forgotten } from './dimenticati';
import type { Job } from './jobs';
import type { NightState } from './notte';
import type { RadarState, RulesState, RuleAction } from './tipi';
import type { Stats } from './stats';

export interface BriefingPoint {
	kind: 'ore' | 'lavori' | 'store' | 'soldi' | 'regole' | 'dimenticati' | 'notte';
	text: string;
	act?: RuleAction;
}

export interface Briefing {
	date: string;
	at: number;
	text: string;
	points: BriefingPoint[];
	heard: boolean;
}

export interface Advice {
	at: number;
	engine: 'apple' | 'regole';
	items: { text: string; act?: RuleAction }[];
}

export interface Facts {
	stats?: Stats | null;
	jobs: Job[];
	radar?: RadarState | null;
	rules?: RulesState | null;
	forgotten: Forgotten[];
	night?: NightState | null;
	projects: { name: string; path: string }[];
	/** Stati delle versioni e recensioni gia' raccontati nel briefing precedente. */
	seen?: BriefingMemory;
	now?: number;
}

export interface BriefingMemory {
	at: number;
	states: Record<string, string>; // ascId -> stato:versione
}

export const BRIEFING_FILE = path.join(os.homedir(), '.bottega', 'briefing.json');

const pad = (n: number) => String(n).padStart(2, '0');
export const today = (t = Date.now()) => {
	const d = new Date(t);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** "3 ore e un quarto", "40 minuti", "un'ora e mezza": come si dice a voce. */
export function spokenMinutes(min: number): string {
	const q = Math.round(min / 15) * 15;
	if (q < 60) return q <= 0 ? 'pochi minuti' : `${q} minuti`;
	const h = Math.floor(q / 60);
	const r = q % 60;
	const hs = h === 1 ? 'un\'ora' : `${h} ore`;
	return r === 0 ? hs : r === 15 ? `${hs} e un quarto` : r === 30 ? `${hs} e mezza` : `${hs} e tre quarti`;
}

const money = (n: number, cur = 'USD') => {
	const sym = cur === 'EUR' ? 'euro' : cur === 'USD' ? 'dollari' : cur;
	return `${n.toLocaleString('it-IT', { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: 2 })} ${sym}`;
};

/** Minuscola iniziale per una frase che finisce dentro un'altra (ma non per un nome come "App Store"). */
const lower = (t: string) => (/^[A-ZÈÀ][a-zàèéìòù]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);

const listIt = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`);

/** I punti del briefing, in ordine di importanza. Solo fatti: ogni frase viene da un dato. */
export function briefingPoints(f: Facts): BriefingPoint[] {
	const now = f.now ?? Date.now();
	const pts: BriefingPoint[] = [];

	// regole rosse prima di tutto
	const red: { name: string; path: string; frase: string; act?: RuleAction }[] = [];
	for (const pr of Object.values(f.rules?.projects ?? {})) {
		for (const h of pr.hits) if (h.livello === 'rosso') red.push({ name: f.projects.find(p => p.path === pr.path)?.name ?? path.basename(pr.path), path: pr.path, frase: h.frase, act: h.azione });
	}
	for (const g of f.rules?.global ?? []) if (g.livello === 'rosso') red.push({ name: '', path: '', frase: g.frase, act: g.azione });
	const yellow = f.rules?.counts?.giallo ?? 0;
	if (red.length) {
		const first = red[0];
		pts.push({
			kind: 'regole',
			text: `${red.length === 1 ? 'Una regola rossa' : `${red.length} regole rosse`}: ${first.name ? first.name + ', ' : ''}${lower(first.frase).replace(/\.$/, '')}.${yellow ? ` Poi ${yellow === 1 ? 'un progetto in giallo' : `${yellow} progetti in giallo`}.` : ''}`,
			act: first.act ?? { act: 'view', label: 'Apri la Vedetta', args: { view: 'vedetta' } },
		});
	} else if (yellow) {
		pts.push({ kind: 'regole', text: `Nessuna regola rossa, ${yellow === 1 ? 'un progetto in giallo' : `${yellow} progetti in giallo`}.`, act: { act: 'view', label: 'Apri la Vedetta', args: { view: 'vedetta' } } });
	}

	// lavori
	const waiting = f.jobs.filter(j => j.status === 'ti aspetta');
	const night = f.jobs.filter(j => j.status === 'stanotte');
	if (waiting.length) {
		const names = [...new Set(waiting.map(j => j.project))];
		pts.push({ kind: 'lavori', text: `${waiting.length === 1 ? 'Un lavoro ti aspetta' : `${waiting.length} lavori ti aspettano`}: ${listIt(names)}.`, act: { act: 'view', label: 'Apri i lavori', args: { view: 'lavori' } } });
	}

	// la notte
	const rep = f.night?.report;
	if (rep && rep.jobs.length && now - new Date(rep.date + 'T12:00:00').getTime() < 2 * 86_400_000) {
		const done = rep.jobs.filter(j => j.status === 'finito').length;
		const stuck = rep.jobs.filter(j => j.status === 'ti aspetta').length;
		const bits = rep.jobs.map(j => `${j.project}${j.summary ? `: ${j.summary.split(/(?<=\.)\s/)[0]}` : ''}`);
		pts.push({
			kind: 'notte',
			text: `Stanotte ${rep.jobs.length === 1 ? 'ha lavorato un lavoro' : `hanno lavorato ${rep.jobs.length} lavori`}${done ? `, ${done === 1 ? 'uno finito' : `${done} finiti`}` : ''}${stuck ? `, ${stuck === 1 ? 'uno si è fermato e ti aspetta' : `${stuck} si sono fermati e ti aspettano`}` : ''}. ${bits.slice(0, 2).join('. ')}.`.replace(/\.\./g, '.'),
			act: { act: 'view', label: 'Apri i lavori', args: { view: 'lavori' } },
		});
	} else if (night.length) {
		pts.push({ kind: 'notte', text: `${night.length === 1 ? 'Un lavoro è in fila' : `${night.length} lavori sono in fila`} per stanotte.` });
	}

	// ore di ieri
	const st = f.stats;
	if (st) {
		const yKey = today(now - 86_400_000);
		const yRow = st.days.find(d => d.date === yKey);
		if (yRow && yRow.you >= 5) {
			const p7 = st.periods['7'];
			const idx = p7.days - 2; // ieri, nel vettore daily che parte dal piu' vecchio
			const top = p7.projects
				.filter(p => p.path && (p.daily[idx] ?? 0) >= 10)
				.sort((a, b) => (b.daily[idx] ?? 0) - (a.daily[idx] ?? 0))
				.slice(0, 3)
				.map(p => `${p.name} ${spokenMinutes(p.daily[idx])}`);
			pts.push({ kind: 'ore', text: `Ieri hai lavorato ${spokenMinutes(yRow.you)}${top.length ? `: ${listIt(top)}` : ''}.`, act: { act: 'view', label: 'Apri il cruscotto', args: { view: 'cruscotto' } } });
		} else {
			pts.push({ kind: 'ore', text: 'Ieri niente lavoro con Claude, o quasi.' });
		}
	}

	// Store: cose nuove rispetto al briefing precedente
	const seen = f.seen?.states ?? {};
	const since = f.seen?.at ?? now - 86_400_000;
	const news: string[] = [];
	let reviews = 0;
	let low = 0;
	for (const a of f.radar?.apps ?? []) {
		const v = a.version;
		if (v) {
			const key = `${v.state}:${v.string}`;
			if (seen[a.ascId] !== key && (v.tone === 'male' || v.state === 'READY_FOR_SALE' || v.state === 'PENDING_DEVELOPER_RELEASE' || v.state === 'IN_REVIEW')) {
				news.push(`${a.name} ${v.string} è ${v.label}`);
			}
		}
		for (const r of a.reviews) {
			if (r.at > since) {
				reviews++;
				if (r.stars <= 2) low++;
			}
		}
	}
	if (news.length || reviews) {
		const t = [news.slice(0, 3).join(', ')];
		if (reviews) t.push(`${reviews === 1 ? 'una recensione nuova' : `${reviews} recensioni nuove`}${low ? `, ${low === 1 ? 'una' : low} con due stelle o meno` : ''}`);
		pts.push({ kind: 'store', text: `Dallo Store: ${t.filter(Boolean).join('; ')}.`, act: { act: 'view', label: 'Apri la Vedetta', args: { view: 'vedetta' } } });
	}

	// soldi
	const tot = f.radar?.totals;
	if (tot && f.radar?.admobAt && now - f.radar.admobAt < 36 * 3_600_000) {
		pts.push({ kind: 'soldi', text: `AdMob ieri ha reso ${money(tot.yesterday, tot.currency)}, ${money(tot.last7, tot.currency)} negli ultimi sette giorni.` });
	}

	// dimenticati
	if (f.forgotten.length) {
		const fg = f.forgotten[0];
		pts.push({
			kind: 'dimenticati',
			text: `${fg.name} è fermo da ${fg.idleDays} giorni con ${fg.reasons[0]}${f.forgotten.length > 1 ? `, e non è l'unico: ${f.forgotten.length - 1 === 1 ? 'ce n\'è un altro' : `ce ne sono altri ${f.forgotten.length - 1}`}` : ''}.`,
			act: { act: 'focus', label: `Apri ${fg.name}`, args: { path: fg.path } },
		});
	}
	return pts;
}

/** Il testo di ripiego, se nessun modello risponde: i punti uno dopo l'altro. */
export function plainBriefing(points: BriefingPoint[]): string {
	if (!points.length) return 'Buongiorno. Niente da segnalare: regole a posto, nessun lavoro che ti aspetta.';
	return 'Buongiorno. ' + points.map(p => p.text).join(' ');
}

export const BRIEFING_INSTRUCTIONS =
	'Scrivi il briefing del mattino per Andrea, da dire a voce in circa trenta secondi (al massimo 90 parole). ' +
	'Usa solo i fatti elencati, nell\'ordine in cui sono, senza aggiungere numeri o nomi che non ci sono. Tono: il tuo, ' +
	'diretto e asciutto, una battuta al massimo. Niente elenchi, niente markdown, niente emoji: frasi che scorrono. ' +
	'Se non c\'e\' niente di importante dillo in una frase.';

export function factsForModel(points: BriefingPoint[]): string {
	return points.length ? points.map((p, i) => `${i + 1}. ${p.text}`).join('\n') : 'Nessun fatto rilevante: tutto in ordine.';
}

// ---------- consigli ----------

export const ADVICE_INSTRUCTIONS =
	'Sei il consigliere di bottega di uno sviluppatore indipendente che lavora con Claude Code su molti progetti. ' +
	'Dai da 3 a 5 consigli pratici per oggi, basati SOLO sui fatti elencati. Uno per riga, ognuno al massimo 22 parole, ' +
	'in italiano, con un verbo all\'imperativo all\'inizio. Se un consiglio riguarda un progetto, scrivi il suo nome ' +
	'esatto. Niente numerazione, niente trattini, niente markdown, niente premesse.';

export function adviceFacts(f: Facts, points: BriefingPoint[]): string {
	const lines = points.map(p => p.text);
	const st = f.stats;
	if (st) {
		lines.push(`Questa settimana finora: ${spokenMinutes(st.week.now.you)} di lavoro, la settimana scorsa allo stesso punto ${spokenMinutes(st.week.prevSoFar.you)}.`);
		lines.push(`Serie di giorni con almeno mezz'ora di lavoro: ${st.streak.current}.`);
		const top = st.periods['7'].projects.filter(p => p.path).slice(0, 4).map(p => `${p.name} ${spokenMinutes(p.you)}`);
		if (top.length) lines.push(`Progetti della settimana: ${top.join(', ')}.`);
	}
	for (const pr of Object.values(f.rules?.projects ?? {})) {
		for (const h of pr.hits) {
			if (h.livello !== 'giallo') continue;
			const name = f.projects.find(p => p.path === pr.path)?.name;
			if (name) lines.push(`${name}: ${h.frase}`);
		}
		if (lines.length > 30) break;
	}
	const queued = f.jobs.filter(j => j.status === 'in coda').length;
	if (queued) lines.push(`${queued} lavori in coda.`);
	return lines.slice(0, 32).join('\n');
}

/** Le righe che il modello scrive diventano consigli; quelle che citano un progetto hanno il pulsante per aprirlo. */
export function parseAdvice(text: string, projects: { name: string; path: string }[]): Advice['items'] {
	const items: Advice['items'] = [];
	for (let line of (text || '').split('\n')) {
		line = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/[—–]/g, ',').replace(/\*\*/g, '').trim();
		if (line.length < 8) continue;
		const hit = projects
			.filter(p => p.name.length >= 3 && new RegExp(`\\b${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(line))
			.sort((a, b) => b.name.length - a.name.length)[0];
		items.push({ text: line, ...(hit ? { act: { act: 'focus', label: `Apri ${hit.name}`, args: { path: hit.path } } } : {}) });
		if (items.length === 5) break;
	}
	return items;
}

/** Consigli fissi dalle regole, quando Apple Intelligence non c'e'. */
export function ruleAdvice(f: Facts, points: BriefingPoint[]): Advice['items'] {
	const items: Advice['items'] = [];
	for (const p of points) {
		if (p.kind === 'regole' && p.act) items.push({ text: 'Sistema prima le regole: ' + p.text.charAt(0).toLowerCase() + p.text.slice(1), act: p.act });
		if (p.kind === 'lavori') items.push({ text: 'Rispondi ai lavori che ti aspettano prima di aprirne di nuovi.', act: p.act });
		if (p.kind === 'dimenticati' && p.act) items.push({ text: p.text, act: p.act });
	}
	const push = Object.values(f.rules?.projects ?? {}).filter(r => r.hits.some(h => h.id === 'push')).length;
	if (push) items.push({ text: `Spingi i commit rimasti: ${push === 1 ? 'un progetto aspetta' : `${push} progetti aspettano`} un push.`, act: { act: 'filter', label: 'Mostrali', args: { filter: 'push' } } });
	if (!items.length) items.push({ text: 'Tutto in ordine: è un buon giorno per chiudere qualcosa rimasto a metà.' });
	return items.slice(0, 5);
}

// ---------- memoria su disco ----------

export function readBriefing(file = BRIEFING_FILE): { briefing: Briefing | null; memory?: BriefingMemory; advice?: Advice | null } {
	try {
		const d = JSON.parse(fs.readFileSync(file, 'utf8'));
		return { briefing: d.briefing ?? null, memory: d.memory, advice: d.advice ?? null };
	} catch {
		return { briefing: null };
	}
}

export function writeBriefing(data: { briefing: Briefing | null; memory?: BriefingMemory; advice?: Advice | null }, file = BRIEFING_FILE): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const tmp = file + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch {
		// disco pieno o permessi: il briefing resta in memoria
	}
}

export function storeMemory(radar: RadarState | null | undefined, now = Date.now()): BriefingMemory {
	const states: Record<string, string> = {};
	for (const a of radar?.apps ?? []) if (a.version) states[a.ascId] = `${a.version.state}:${a.version.string}`;
	return { at: now, states };
}
