/* Apple Intelligence nelle sezioni della Bottega: compiti brevi e guidati, fatti dal Nucleo sul Mac
   (docs/CONTRATTI.md, sezione 8). Qui la parte che non ha bisogno di vscode, provata da Node:
   - la coda di una trascrizione di Claude Code (ultima richiesta e ultimo messaggio di Claude) per la riga di stato;
   - le righe di stato delle sessioni vive, con una cache per sessione e un ritmo massimo;
   - i fatti del cruscotto e il riempimento dei segnaposto: le cifre escono dai dati, mai dal modello. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface NucleoCompiti {
	readonly available: boolean;
	readonly capabilities?: { foundationModels?: boolean };
	request<T = any>(cmd: string, args?: Record<string, any>, timeoutMs?: number): Promise<T>;
}

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

/** Il jsonl di una sessione: cerca `<sessionId>.jsonl` nelle cartelle dei progetti (una lettura di cartella). */
export function transcriptPath(sessionId: string, root = PROJECTS): string | undefined {
	let dirs: string[] = [];
	try {
		dirs = fs.readdirSync(root);
	} catch {
		return undefined;
	}
	for (const d of dirs) {
		const f = path.join(root, d, `${sessionId}.jsonl`);
		if (fs.existsSync(f)) return f;
	}
	return undefined;
}

/** Il testo di un messaggio: stringa, o i blocchi `text` (niente tool_use, tool_result, immagini). */
function textOf(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
}

/** I messaggi tra sessioni arrivano avvolti in tag: resta il contenuto. I promemoria di sistema si tolgono. */
export function pulisci(s: string): string {
	return s
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
		.replace(/<\/?[a-z][a-z0-9-]*(\s[^>]{0,400})?>/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Ultima richiesta testuale dell'utente e ultimo testo di Claude, dalla coda del file (al massimo 256 KB). */
export function codaTrascrizione(file: string, maxBytes = 256 * 1024): { richiesta?: string; ultimoMessaggio?: string; strumenti: string[] } {
	let buf: Buffer;
	try {
		const st = fs.statSync(file);
		const len = Math.min(st.size, maxBytes);
		const fd = fs.openSync(file, 'r');
		buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, st.size - len);
		fs.closeSync(fd);
	} catch {
		return { strumenti: [] };
	}
	const lines = buf.toString('utf8').split('\n');
	let richiesta: string | undefined;
	let ultimoMessaggio: string | undefined;
	const strumenti: string[] = [];
	for (let i = lines.length - 1; i >= 0 && (!richiesta || !ultimoMessaggio || strumenti.length < 4); i--) {
		let o: any;
		try {
			o = JSON.parse(lines[i]);
		} catch {
			continue; // la prima riga puo' essere a meta'
		}
		const content = o?.message?.content;
		if (o?.type === 'assistant') {
			if (!ultimoMessaggio) {
				const t = pulisci(textOf(content));
				if (t) ultimoMessaggio = t.slice(0, 1200);
			}
			if (Array.isArray(content) && strumenti.length < 4) {
				for (const b of content) if (b?.type === 'tool_use' && b.name) strumenti.push(String(b.name));
			}
		} else if (o?.type === 'user' && !richiesta && !o.isMeta) {
			const t = pulisci(textOf(content));
			if (t && !/^\[Request interrupted/.test(t)) richiesta = t.slice(0, 600);
		}
	}
	return { richiesta, ultimoMessaggio, strumenti };
}

// ---------- righe di stato ----------

export interface RigaStato { riga: string; fase?: string; at: number; firma: string }

/** Le righe di stato delle sessioni vive. Una richiesta al Nucleo alla volta, al massimo una riga ogni
 *  `ritmoMs` per sessione, e solo se la coda della trascrizione e' cambiata. */
export class RigheStato {
	private righe = new Map<string, RigaStato>();
	private occupato = false;
	constructor(
		private readonly nucleo: NucleoCompiti,
		private readonly opts: { ritmoMs?: number; transcript?: (sid: string) => string | undefined; now?: () => number } = {},
	) {}

	get(sessionId: string): RigaStato | undefined {
		return this.righe.get(sessionId);
	}

	all(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [k, v] of this.righe) out[k] = v.riga;
		return out;
	}

	private now(): number {
		return this.opts.now ? this.opts.now() : Date.now();
	}

	/** Aggiorna le sessioni date (le altre si dimenticano). Torna true se qualche riga e' cambiata. */
	async aggiorna(sessioni: { sessionId: string; progetto: string }[]): Promise<boolean> {
		const vive = new Set(sessioni.map(s => s.sessionId));
		for (const k of [...this.righe.keys()]) if (!vive.has(k)) this.righe.delete(k);
		if (this.occupato || !this.nucleo.available || this.nucleo.capabilities?.foundationModels === false) return false;
		this.occupato = true;
		let cambiate = false;
		try {
			for (const s of sessioni) {
				const prev = this.righe.get(s.sessionId);
				if (prev && this.now() - prev.at < (this.opts.ritmoMs ?? 120_000)) continue;
				const file = (this.opts.transcript ?? transcriptPath)(s.sessionId);
				if (!file) continue;
				const coda = codaTrascrizione(file);
				if (!coda.ultimoMessaggio && !coda.richiesta) continue;
				const firma = `${coda.richiesta ?? ''}|${coda.ultimoMessaggio ?? ''}`.slice(-600);
				if (prev && prev.firma === firma) {
					prev.at = this.now();
					continue;
				}
				try {
					const r = await this.nucleo.request<{ riga: string; fase?: string }>('ai.stato', { progetto: s.progetto, ...coda }, 15_000);
					if (r?.riga) {
						this.righe.set(s.sessionId, { riga: r.riga, fase: r.fase, at: this.now(), firma });
						cambiate = true;
					}
				} catch {
					// Apple Intelligence occupata o rifiuto: resta la riga di prima
				}
			}
		} finally {
			this.occupato = false;
		}
		return cambiate;
	}
}

// ---------- frasi con le cifre dai dati ----------

/** Riempie i segnaposto `{id}` con i valori dei fatti. Null se la frase ha cifre sue o segnaposto sconosciuti. */
export function riempi(frase: string, valori: Record<string, string>): string | null {
	const senzaSegnaposto = frase.replace(/\{[a-zA-Z0-9_]+\}/g, '');
	if (/\d/.test(senzaSegnaposto)) return null; // una cifra scritta dal modello: non si mostra
	let ok = true;
	const out = frase.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, id) => {
		if (!(id in valori)) ok = false;
		return valori[id] ?? '';
	});
	return ok ? out.replace(/\s+/g, ' ').trim() : null;
}

const ore = (min: number) => {
	const h = Math.floor(min / 60);
	const m = Math.round(min % 60);
	return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
};

/** I fatti del cruscotto (settimana) con i loro valori gia' scritti all'italiana. */
export function fattiCruscotto(stats: any): { fatti: { id: string; testo: string }[]; valori: Record<string, string> } {
	const fatti: { id: string; testo: string }[] = [];
	const valori: Record<string, string> = {};
	const add = (id: string, testo: string, valore: string) => {
		fatti.push({ id, testo });
		valori[id] = valore;
	};
	const w = stats?.week;
	if (w?.now) {
		add('ore', 'ore di lavoro di Andrea questa settimana', ore(w.now.you));
		if (w.prevSoFar?.you) {
			const d = Math.round(((w.now.you - w.prevSoFar.you) / w.prevSoFar.you) * 100);
			add('confronto', d >= 0 ? 'quanto di piu\' rispetto alla settimana scorsa allo stesso punto' : 'quanto di meno rispetto alla settimana scorsa allo stesso punto', `${Math.abs(d)}%`);
		}
	}
	const p7 = stats?.periods?.['7'];
	const top = (p7?.projects ?? []).filter((p: any) => p.path).sort((a: any, b: any) => b.you - a.you);
	if (top[0]) add('primo', 'il progetto piu\' lavorato della settimana', top[0].name);
	if (top[1]) add('secondo', 'il secondo progetto piu\' lavorato', top[1].name);
	if (p7?.peak?.n > 1) add('parallelo', 'il massimo di sessioni di Claude al lavoro insieme', String(p7.peak.n));
	if (stats?.streak?.current > 1) add('serie', 'giorni di fila con almeno mezz\'ora di lavoro', String(stats.streak.current));
	if (stats?.today) add('oggi', 'ore di lavoro di oggi', ore(stats.today.you));
	return { fatti, valori };
}
