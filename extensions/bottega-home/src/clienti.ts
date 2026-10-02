/* Ore per cliente, pronte da fatturare.

   L'associazione progetto -> cliente sta in ~/.bottega/clienti.json, fuori dal repository: contiene nomi di
   clienti. Le ore vengono dal registro del cruscotto (StatsEngine.lastLedger): per ogni cliente si fa l'unione
   degli intervalli di tutti i suoi progetti (due sessioni insieme contano una volta), si spezza per giorno
   locale e ogni giorno si arrotonda al quarto d'ora piu' vicino. Il totale e' la somma dei giorni arrotondati.
   Contratto: docs/CONTRATTI.md, sezione 4.2. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dayKey, Ledger, mergeSpans, minutesIn } from './stats';

export interface Client {
	id: string;
	nome: string;
	progetti: string[];
	tariffa?: number;
}

export interface ClientsFile {
	version: 1;
	rounding: number;
	clients: Client[];
}

export interface ClientReport {
	month: string;
	months: string[];
	rounding: number;
	clients: {
		id: string;
		nome: string;
		minutes: number;
		raw: number;
		amount?: number;
		days: { date: string; minutes: number }[];
		projects: { path: string; name: string; minutes: number }[];
	}[];
	unassigned: { path: string | null; name: string; minutes: number }[];
	config: Client[];
	projects: { path: string; name: string }[];
}

export const CLIENTS_FILE = path.join(os.homedir(), '.bottega', 'clienti.json');

const norm = (p: string) => p.replace(/\/+$/, '');

export function readClients(file = CLIENTS_FILE): ClientsFile {
	try {
		const d = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (d && Array.isArray(d.clients)) {
			return { version: 1, rounding: Number(d.rounding) || 15, clients: cleanClients(d.clients) };
		}
	} catch {
		// file assente o rovinato: nessun cliente
	}
	return { version: 1, rounding: 15, clients: [] };
}

export function cleanClients(raw: any[]): Client[] {
	const seen = new Set<string>();
	const out: Client[] = [];
	for (const c of raw ?? []) {
		const nome = String(c?.nome ?? '').trim().slice(0, 120);
		if (!nome) continue;
		let id = String(c?.id ?? '').trim() || nome.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cliente';
		while (seen.has(id)) id += '-2';
		seen.add(id);
		const progetti = [...new Set((Array.isArray(c?.progetti) ? c.progetti : []).map((p: any) => norm(String(p))).filter(Boolean))] as string[];
		const t = Number(c?.tariffa);
		out.push({ id, nome, progetti, ...(Number.isFinite(t) && t > 0 ? { tariffa: Math.round(t * 100) / 100 } : {}) });
	}
	return out;
}

/** Scrive il file dei clienti (cartella 700, file 600). Un progetto appartiene a un solo cliente: l'ultimo vince. */
export function writeClients(clients: Client[], file = CLIENTS_FILE, rounding = 15): ClientsFile {
	const list = cleanClients(clients);
	const owner = new Map<string, string>();
	for (const c of list) for (const p of c.progetti) owner.set(p, c.id);
	for (const c of list) c.progetti = c.progetti.filter(p => owner.get(p) === c.id);
	const data: ClientsFile = { version: 1, rounding, clients: list };
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = file + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
	fs.renameSync(tmp, file);
	return data;
}

/** Mese locale "YYYY-MM" di un istante. */
export function monthKey(t: number): string {
	return dayKey(t).slice(0, 7);
}

function monthBounds(month: string): [number, number] {
	const [y, m] = month.split('-').map(Number);
	return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()];
}

/** Minuti per giorno locale di intervalli piatti, dentro [a, b). */
function perDay(spans: number[], a: number, b: number): Map<string, number> {
	const out = new Map<string, number>();
	for (let d = a; d < b; ) {
		const dt = new Date(d);
		const next = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1).getTime();
		const m = minutesIn(spans, d, Math.min(next, b));
		if (m > 0) out.set(dayKey(d), m);
		d = next;
	}
	return out;
}

/** Arrotonda al multiplo di `q` minuti piu' vicino (12 min e mezzo diventano 15, 7 diventano 0). */
export const roundTo = (m: number, q: number) => Math.round(m / q) * q;

export function buildReport(ledger: Ledger, cfg: ClientsFile, projects: { path: string; name: string }[], month?: string, now = Date.now()): ClientReport {
	const q = cfg.rounding || 15;
	const months = new Set<string>();
	for (const { spans } of ledger.values()) {
		for (let i = 0; i + 1 < spans.length; i += 2) {
			for (let t = spans[i]; ; ) {
				months.add(monthKey(t));
				const d = new Date(t);
				const next = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
				if (next >= spans[i + 1]) break;
				t = next;
			}
		}
	}
	const m = month && /^\d{4}-\d{2}$/.test(month) ? month : monthKey(now);
	months.add(monthKey(now));
	const [a, b] = monthBounds(m);
	const byPath = new Map<string, { name: string; spans: number[] }>();
	for (const [p, v] of ledger) if (p) byPath.set(norm(p), v);

	const assigned = new Set<string>();
	const clients: ClientReport['clients'] = cfg.clients.map(c => {
		const own = c.progetti.map(p => ({ path: p, rec: byPath.get(p) }));
		for (const o of own) assigned.add(o.path);
		const union = mergeSpans(own.flatMap(o => o.rec?.spans ?? []), 0);
		const days = [...perDay(union, a, b)].map(([date, raw]) => ({ date, raw, minutes: roundTo(raw, q) }));
		const minutes = days.reduce((s, d) => s + d.minutes, 0);
		const raw = days.reduce((s, d) => s + d.raw, 0);
		const projs = own
			.map(o => {
				const pd = perDay(o.rec?.spans ?? [], a, b);
				let mm = 0;
				for (const v of pd.values()) mm += roundTo(v, q);
				return { path: o.path, name: o.rec?.name ?? path.basename(o.path), minutes: mm };
			})
			.filter(p => p.minutes > 0)
			.sort((x, y) => y.minutes - x.minutes);
		return {
			id: c.id,
			nome: c.nome,
			minutes,
			raw: Math.round(raw * 10) / 10,
			...(c.tariffa ? { amount: Math.round((minutes / 60) * c.tariffa * 100) / 100 } : {}),
			days: days.filter(d => d.minutes > 0).map(d => ({ date: d.date, minutes: d.minutes })),
			projects: projs,
		};
	});

	const unassigned: ClientReport['unassigned'] = [];
	for (const [p, v] of ledger) {
		if (p && assigned.has(norm(p))) continue;
		let mm = 0;
		for (const x of perDay(v.spans, a, b).values()) mm += roundTo(x, q);
		if (mm > 0) unassigned.push({ path: p, name: v.name, minutes: mm });
	}
	unassigned.sort((x, y) => y.minutes - x.minutes);

	return {
		month: m,
		months: [...months].sort().reverse(),
		rounding: q,
		clients: clients.sort((x, y) => y.minutes - x.minutes),
		unassigned,
		config: cfg.clients,
		projects: projects.map(p => ({ path: norm(p.path), name: p.name })),
	};
}

// ---------- esportazione ----------

const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

export function monthName(month: string): string {
	const [y, m] = month.split('-').map(Number);
	return `${MESI[m - 1]} ${y}`;
}

/** "12 h 45 min", "45 min", "3 h". */
export function hm(minutes: number): string {
	const h = Math.floor(minutes / 60);
	const m = Math.round(minutes % 60);
	if (!h) return `${m} min`;
	return m ? `${h} h ${m} min` : `${h} h`;
}

const decimalHours = (minutes: number) => (minutes / 60).toFixed(2).replace('.', ',');
const euro = (n: number) => n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

function csvCell(s: string | number): string {
	const t = String(s);
	return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** CSV con il punto e virgola (Numbers ed Excel in italiano), una riga per cliente e giorno. */
export function toCsv(r: ClientReport): string {
	const rows: (string | number)[][] = [['cliente', 'data', 'minuti', 'ore', 'importo']];
	for (const c of r.clients) {
		const tariffa = c.amount !== undefined && c.minutes ? c.amount / (c.minutes / 60) : undefined;
		for (const d of c.days) {
			rows.push([c.nome, d.date, d.minutes, decimalHours(d.minutes), tariffa ? (Math.round((d.minutes / 60) * tariffa * 100) / 100).toFixed(2).replace('.', ',') : '']);
		}
		rows.push([c.nome, 'totale', c.minutes, decimalHours(c.minutes), c.amount !== undefined ? c.amount.toFixed(2).replace('.', ',') : '']);
	}
	return rows.map(r => r.map(csvCell).join(';')).join('\n') + '\n';
}

export function toMarkdown(r: ClientReport): string {
	const out: string[] = [];
	out.push(`# Ore per cliente, ${monthName(r.month)}`, '');
	out.push(`Ogni giorno di ogni cliente è arrotondato al quarto d'ora più vicino (${r.rounding} minuti). Le ore vengono dalle sessioni di Claude Code: due sessioni nello stesso momento contano una volta, una pausa di più di 15 minuti interrompe il conto.`, '');
	if (!r.clients.some(c => c.minutes)) out.push('Nessuna ora assegnata a un cliente in questo mese.', '');
	for (const c of r.clients) {
		if (!c.minutes) continue;
		out.push(`## ${c.nome}`, '');
		out.push(`Totale: **${hm(c.minutes)}** (${decimalHours(c.minutes)} ore)${c.amount !== undefined ? `, importo ${euro(c.amount)}` : ''}.`, '');
		if (c.projects.length > 1) {
			out.push('Progetti: ' + c.projects.map(p => `${p.name} ${hm(p.minutes)}`).join(', ') + '.', '');
		}
		out.push('| Giorno | Ore |', '|---|---|');
		for (const d of c.days) {
			const dt = new Date(d.date + 'T12:00:00');
			out.push(`| ${dt.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'long' })} | ${hm(d.minutes)} |`);
		}
		out.push('');
	}
	if (r.unassigned.length) {
		out.push('## Ore non assegnate', '');
		for (const u of r.unassigned) out.push(`- ${u.name}: ${hm(u.minutes)}`);
		out.push('');
	}
	return out.join('\n');
}
