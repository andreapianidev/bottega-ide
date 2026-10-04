/* L'Osservatorio: la finestra nativa del Nucleo (SwiftUI + Metal) con il cielo dei progetti e i grafici 3D.
   L'estensione gli passa i numeri del cruscotto (Stats, contratto 3) piu' le categorie del lavoro, e
   glieli rimanda quando cambiano. Si apre dalla Bottega, dalla barra dei menu del Nucleo e dall'intent
   ApriOsservatorio (link bottega://.../osservatorio). Contratto: docs/CONTRATTI.md, sezione 7.7.

   Le categorie (correzione, funzione, rilascio, ricerca, manutenzione, documentazione) le decide Apple
   Intelligence sessione per sessione (memoria/lib/categorie.mjs); qui si pesano con i minuti di Claude di
   ciascuna sessione, presi dagli intervalli del cruscotto. Niente vscode: si prova da Node. */

export const CATEGORIE = ['correzione', 'funzione', 'rilascio', 'ricerca', 'manutenzione', 'documentazione'] as const;
export type Categoria = typeof CATEGORIE[number];
export type CategorieMinuti = Record<'7' | '30' | '90', Partial<Record<Categoria | 'altro', number>>>;

/** Minuti di ogni categoria negli ultimi 7, 30 e 90 giorni. `spans`: [inizio, fine, ...] in ms per sessione.
 *  Le sessioni senza categoria (non ancora riassunte o classificate) finiscono in `altro`. */
export function categorieMinuti(sessions: { sid: string; spans: number[] }[], cat: Record<string, string>, now = Date.now()): CategorieMinuti {
	const out: CategorieMinuti = { '7': {}, '30': {}, '90': {} };
	for (const days of [7, 30, 90] as const) {
		const from = now - days * 86_400_000;
		const bucket = out[String(days) as '7' | '30' | '90'];
		for (const s of sessions) {
			let ms = 0;
			for (let i = 0; i + 1 < s.spans.length; i += 2) {
				const a = Math.max(s.spans[i], from);
				const b = Math.min(s.spans[i + 1], now);
				if (b > a) ms += b - a;
			}
			if (ms <= 0) continue;
			const c = (CATEGORIE as readonly string[]).includes(cat[s.sid]) ? (cat[s.sid] as Categoria) : 'altro';
			bucket[c] = Math.round(((bucket[c] ?? 0) + ms / 60_000) * 10) / 10;
		}
	}
	return out;
}

/** "questa settimana 60% correzioni": la categoria che pesa di piu' negli ultimi 7 giorni, o null. */
export function fraseCategorie(c: CategorieMinuti | null | undefined): string | null {
	const w = c?.['7'];
	if (!w) return null;
	const known = Object.entries(w).filter(([k]) => k !== 'altro') as [Categoria, number][];
	const tot = known.reduce((s, [, m]) => s + m, 0);
	if (tot < 30) return null; // meno di mezz'ora classificata: non si dice niente
	known.sort((a, b) => b[1] - a[1]);
	const [top, m] = known[0];
	const pct = Math.round((m / tot) * 100);
	const plurale: Record<Categoria, string> = {
		correzione: 'correzioni', funzione: 'funzioni nuove', rilascio: 'rilasci', ricerca: 'ricerca',
		manutenzione: 'manutenzione', documentazione: 'documentazione',
	};
	return `Questa settimana ${pct}% ${plurale[top]}.`;
}

export interface OsservatorioNucleo {
	readonly available: boolean;
	request<T = any>(cmd: string, args?: Record<string, any>, timeoutMs?: number): Promise<T>;
	fireAndForget(cmd: string, args?: Record<string, any>): void;
	on(event: string, handler: (...a: any[]) => void): any;
}

/** Il ponte: apre la finestra, risponde a `osservatorio.ready`, rimanda i dati quando cambiano. */
export class Osservatorio {
	private open = false;
	private lastSig = '';
	constructor(
		private readonly nucleo: OsservatorioNucleo,
		private readonly data: () => Promise<Record<string, any> | null>,
		private readonly log: (s: string) => void = () => undefined,
	) {
		nucleo.on('osservatorio.ready', () => {
			this.open = true;
			void this.push(true);
		});
		nucleo.on('osservatorio.closed', () => (this.open = false));
	}

	async show(): Promise<void> {
		if (!this.nucleo.available) throw new Error('Il Nucleo non c\'e\': l\'Osservatorio e\' una finestra nativa.');
		const d = await this.data().catch(() => null);
		this.lastSig = d ? sig(d) : '';
		await this.nucleo.request('osservatorio.open', d ? { data: d } : {}, 15_000);
		this.open = true;
	}

	/** Dopo ogni calcolo del cruscotto e ogni frase nuova: manda solo se la finestra e' aperta e qualcosa e' cambiato. */
	async push(force = false): Promise<void> {
		if (!this.open || !this.nucleo.available) return;
		const d = await this.data().catch(e => {
			this.log(`osservatorio: ${e?.message ?? e}`);
			return null;
		});
		if (!d) return;
		const s = sig(d);
		if (!force && s === this.lastSig) return;
		this.lastSig = s;
		this.nucleo.fireAndForget('osservatorio.data', { data: d });
	}
}

function sig(d: Record<string, any>): string {
	const { computedAt, ms, files, ...rest } = d;
	return JSON.stringify(rest);
}

/** Il cielo comprende tutte le fonti osservate. Nessuna ora o consumo viene inventato. */
export function osservatorioConAttivita(stats: import('./stats').Stats, activity: readonly import('./attivita-tipi').AgentActivity[]) {
 const unique = [...new Map(activity.map(a => [a.key, a])).values()];
 const live = unique.filter(a => a.status === 'in corso' || a.status === 'ti aspetta').map(a => ({ project: a.project, path: a.path, title: a.title, status: a.status, source: a.source }));
 const periods = Object.fromEntries(Object.entries(stats.periods).map(([k, per]) => {
  const groups = new Map<string, typeof unique>();
  for (const a of unique) {
   if (a.updatedAt < stats.computedAt - Number(k) * 86400_000 && !['in corso', 'ti aspetta'].includes(a.status)) continue;
   const key = a.path || a.project;
   groups.set(key, [...(groups.get(key) || []), a]);
  }
  const projects = per.projects.map(p => {
   const rows = groups.get(p.path || p.name) || [];
   groups.delete(p.path || p.name);
   return { ...p, live: rows.filter(a => ['in corso', 'ti aspetta'].includes(a.status)).length };
  });
  for (const rows of groups.values()) projects.push({ name: rows[0].project, path: rows[0].path || null, you: 0, claude: 0, tok: [0,0,0,0], sessions: rows.length, last: Math.max(...rows.map(a => a.updatedAt)), hours: Array(24).fill(0), live: rows.filter(a => ['in corso', 'ti aspetta'].includes(a.status)).length, observedOnly: true } as any);
  return [k, { ...per, projects }];
 }));
 return { stats: { ...stats, periods }, live };
}
