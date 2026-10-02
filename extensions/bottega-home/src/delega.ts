/* Le deleghe a Claude Code senza finestra, per i connettori di claude.ai (Gmail, Google Calendar, Vercel...):
   le loro credenziali le tiene Claude, quindi l'unico modo di usarli e' chiedere a `claude -p`.

   Costano: con haiku da 20 a 70 secondi e da 0,14 a 0,46 dollari l'una (misurato il 2 ottobre 2026; il grosso e'
   il contesto con gli strumenti di tutti i connettori dell'utente), quindi:
   - una alla volta, in coda, con `nice`, timeout 180 secondi, mai sul filo del processo delle estensioni;
   - solo strumenti di sola lettura (soloLettura), passati con --allowedTools, piu' --permission-mode dontAsk
     (tutto il resto e' negato senza chiedere) e --tools "" (niente Bash, Edit, Read...);
   - un tetto di spesa giornaliero (bottega.connettori.tettoGiornalieroUsd): si somma total_cost_usd per giorno
     in ~/.bottega/connettori/spesa.json, e la delega che lo sforerebbe non parte. Anche --max-budget-usd;
   - il prompt chiede SOLO JSON, con lo schema scritto dentro; il prompt passa da stdin, non dagli argomenti.
   Il risultato si salva in ~/.bottega/connettori/<capacita>.json con data e costo (file 600).
   Contratto: docs/CONTRATTI.md, sezione 5. */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathEsteso, soloLettura, trovaClaude } from './connettori';

export const DIR_CONNETTORI = path.join(os.homedir(), '.bottega', 'connettori');
export const TIMEOUT_DELEGA = 180_000;
/** Stima di partenza, prima di avere uno storico: la piu' cara delle due misure fatte a mano con haiku. */
export const STIMA_BASE = { secondi: 60, usd: 0.45 };
/** Una sola delega non spende mai piu' di cosi' (--max-budget-usd), anche con il tetto giornaliero alto. */
export const MASSIMO_PER_DELEGA = 0.8;

export interface RichiestaDelega {
	/** Dove salvare il risultato: ~/.bottega/connettori/<capacita>.json */
	capacita: string;
	/** Cosa fare, in italiano semplice. */
	compito: string;
	/** Lo schema del JSON atteso, scritto per il modello. */
	schema: string;
	/** Nomi completi degli strumenti (mcp__claude_ai_Gmail__search_threads). Quelli che scrivono vengono scartati. */
	strumenti: string[];
}

export interface EsitoDelega {
	capacita: string;
	at: number;
	ok: boolean;
	costo: number;
	durataMs: number;
	turni?: number;
	errore?: string;
	data?: unknown;
}

export interface StatoDeleghe {
	inCorso: string | null;
	coda: string[];
	spesaOggi: number;
	tetto: number;
	modello: string;
	stime: Record<string, { secondi: number; usd: number }>;
}

// ---------- pezzi puri ----------

export function strumentiConsentiti(strumenti: string[]): string[] {
	return [...new Set(strumenti.filter(s => /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(s) && soloLettura(s)))];
}

export function promptDelega(r: RichiestaDelega, strumenti: string[]): string {
	return [
		'Sei un lettore di dati per la Bottega, un programma che mostra queste informazioni in una sua schermata.',
		`Puoi usare SOLO questi strumenti, e solo per leggere: ${strumenti.join(', ')}.`,
		'Non inviare, non rispondere, non inoltrare, non creare bozze, non modificare e non cancellare niente.',
		'',
		`Compito: ${r.compito}`,
		'',
		'Rispondi SOLO con JSON valido: niente testo prima o dopo, niente blocchi di codice, niente commenti.',
		'Lo schema e\':',
		r.schema,
		'Se non trovi niente, rispondi con il valore vuoto dello schema ([] per un elenco).',
	].join('\n');
}

export function argomentiDelega(o: { modello: string; strumenti: string[]; budgetUsd: number }): string[] {
	return [
		'-p',
		'--output-format', 'json',
		'--model', o.modello || 'haiku',
		'--permission-mode', 'dontAsk',
		'--no-session-persistence',
		'--max-budget-usd', Math.max(0.01, o.budgetUsd).toFixed(2),
		'--tools', '',
		'--allowedTools', o.strumenti.join(','),
	];
}

/** Il JSON dentro una risposta: tollera blocchi ```json e testo intorno. */
export function estraiJson(testo: string): unknown {
	const t = String(testo ?? '').trim();
	const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
	const body = fence ? fence[1].trim() : t;
	try {
		return JSON.parse(body);
	} catch {
		// cerca il primo [ o { e l'ultimo ] o }
	}
	const a = body.search(/[[{]/);
	if (a < 0) throw new Error('la risposta non contiene JSON');
	const close = body[a] === '[' ? ']' : '}';
	const b = body.lastIndexOf(close);
	if (b <= a) throw new Error('JSON incompleto nella risposta');
	return JSON.parse(body.slice(a, b + 1));
}

/** L'uscita di `claude -p --output-format json`: { result, is_error, total_cost_usd, num_turns, ... }. */
export function leggiUscita(stdout: string): { ok: boolean; data?: unknown; costo: number; turni?: number; errore?: string } {
	const lines = String(stdout ?? '').trim().split('\n').filter(Boolean);
	let o: any;
	for (let i = lines.length - 1; i >= 0 && !o; i--) {
		try {
			const x = JSON.parse(lines[i]);
			if (x && typeof x === 'object' && ('result' in x || 'is_error' in x)) o = x;
		} catch {
			// riga non JSON
		}
	}
	if (!o) {
		try {
			o = JSON.parse(String(stdout));
		} catch {
			return { ok: false, costo: 0, errore: 'Claude Code non ha risposto in JSON' };
		}
	}
	const costo = Number(o.total_cost_usd) || 0;
	const turni = Number.isFinite(Number(o.num_turns)) ? Number(o.num_turns) : undefined;
	if (o.is_error || (o.subtype && o.subtype !== 'success')) {
		const why = typeof o.result === 'string' && o.result ? o.result : String(o.subtype ?? 'errore');
		return { ok: false, costo, turni, errore: why.slice(0, 300) };
	}
	try {
		return { ok: true, costo, turni, data: estraiJson(String(o.result ?? '')) };
	} catch (e: any) {
		return { ok: false, costo, turni, errore: `risposta senza JSON valido (${e?.message ?? e})` };
	}
}

export const giornoLocale = (t = Date.now()) => {
	const d = new Date(t);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- spesa ----------

interface Spesa {
	giorni: Record<string, number>;
	storico: { at: number; capacita: string; costo: number; durataMs: number; ok: boolean }[];
}

export function scriviPrivato(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = file + '.tmp';
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** Stima di durata e costo per una capacita': media delle ultime cinque deleghe riuscite, o la stima di partenza. */
export function stima(storico: Spesa['storico'], capacita: string): { secondi: number; usd: number } {
	const ultime = storico.filter(s => s.capacita === capacita && s.ok).slice(-5);
	if (!ultime.length) return { ...STIMA_BASE };
	const secondi = Math.round(ultime.reduce((a, s) => a + s.durataMs, 0) / ultime.length / 1000);
	const usd = Math.round((ultime.reduce((a, s) => a + s.costo, 0) / ultime.length) * 1000) / 1000;
	return { secondi, usd };
}

// ---------- la coda ----------

export interface CodaOpts {
	dir?: string;
	claudeCommand: () => string;
	modello: () => string;
	tetto: () => number;
	onChange: () => void;
	log: (s: string) => void;
	/** Per i test: sostituisce il lancio di claude. */
	esegui?: (args: string[], stdin: string, timeoutMs: number) => Promise<{ stdout: string; code: number | null }>;
	ora?: () => number;
}

interface Voce {
	r: RichiestaDelega;
	ok: (e: EsitoDelega) => void;
}

export class CodaDeleghe {
	private coda: Voce[] = [];
	private inCorso: string | null = null;
	private readonly dir: string;

	constructor(private readonly o: CodaOpts) {
		this.dir = o.dir ?? DIR_CONNETTORI;
	}

	private ora(): number {
		return this.o.ora ? this.o.ora() : Date.now();
	}

	private get fileSpesa(): string {
		return path.join(this.dir, 'spesa.json');
	}

	leggiSpesa(): Spesa {
		try {
			const d = JSON.parse(fs.readFileSync(this.fileSpesa, 'utf8'));
			return { giorni: d?.giorni && typeof d.giorni === 'object' ? d.giorni : {}, storico: Array.isArray(d?.storico) ? d.storico : [] };
		} catch {
			return { giorni: {}, storico: [] };
		}
	}

	spesaOggi(): number {
		return Math.round((Number(this.leggiSpesa().giorni[giornoLocale(this.ora())]) || 0) * 10000) / 10000;
	}

	stato(): StatoDeleghe {
		const s = this.leggiSpesa();
		const caps = new Set(['posta', ...s.storico.map(x => x.capacita)]);
		const stime: StatoDeleghe['stime'] = {};
		for (const c of caps) stime[c] = stima(s.storico, c);
		return {
			inCorso: this.inCorso,
			coda: this.coda.map(v => v.r.capacita),
			spesaOggi: Math.round((Number(s.giorni[giornoLocale(this.ora())]) || 0) * 10000) / 10000,
			tetto: this.o.tetto(),
			modello: this.o.modello() || 'haiku',
			stime,
		};
	}

	/** Mette in coda una delega. Non rifiuta mai con un'eccezione: l'esito dice ok o errore. */
	accoda(r: RichiestaDelega): Promise<EsitoDelega> {
		return new Promise(ok => {
			this.coda.push({ r, ok });
			this.o.onChange();
			void this.avanti();
		});
	}

	private async avanti(): Promise<void> {
		if (this.inCorso || !this.coda.length) return;
		const v = this.coda.shift()!;
		this.inCorso = v.r.capacita;
		this.o.onChange();
		let e: EsitoDelega;
		try {
			e = await this.esegui(v.r);
		} catch (err: any) {
			e = { capacita: v.r.capacita, at: this.ora(), ok: false, costo: 0, durataMs: 0, errore: String(err?.message ?? err) };
		}
		this.inCorso = null;
		v.ok(e);
		this.o.onChange();
		void this.avanti();
	}

	private async esegui(r: RichiestaDelega): Promise<EsitoDelega> {
		const t0 = this.ora();
		const fail = (errore: string): EsitoDelega => ({ capacita: r.capacita, at: t0, ok: false, costo: 0, durataMs: 0, errore });
		const strumenti = strumentiConsentiti(r.strumenti);
		if (!strumenti.length) return fail('nessuno strumento di sola lettura da usare');
		const tetto = Math.max(0, Number(this.o.tetto()) || 0);
		const speso = this.spesaOggi();
		const st = stima(this.leggiSpesa().storico, r.capacita);
		if (speso + st.usd > tetto) {
			return fail(`tetto di spesa di oggi raggiunto: ${speso.toFixed(2)} $ su ${tetto.toFixed(2)} $`);
		}
		const args = argomentiDelega({ modello: this.o.modello(), strumenti, budgetUsd: Math.min(tetto - speso, MASSIMO_PER_DELEGA) });
		const prompt = promptDelega(r, strumenti);
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const run = this.o.esegui ?? ((a, s, t) => this.lancia(a, s, t));
		const { stdout, code } = await run(args, prompt, TIMEOUT_DELEGA);
		const u = leggiUscita(stdout);
		const durataMs = this.ora() - t0;
		const esito: EsitoDelega = {
			capacita: r.capacita,
			at: this.ora(),
			ok: u.ok,
			costo: u.costo,
			durataMs,
			...(u.turni !== undefined ? { turni: u.turni } : {}),
			...(u.ok ? { data: u.data } : { errore: u.errore ?? `claude e' uscito con ${code}` }),
		};
		this.registra(esito);
		try {
			scriviPrivato(path.join(this.dir, `${r.capacita.replace(/[^a-z0-9-]/gi, '')}.json`), esito);
		} catch (err) {
			this.o.log(`delega: non salvo il risultato (${err})`);
		}
		return esito;
	}

	private registra(e: EsitoDelega): void {
		const s = this.leggiSpesa();
		const g = giornoLocale(e.at);
		s.giorni[g] = Math.round(((Number(s.giorni[g]) || 0) + e.costo) * 10000) / 10000;
		// si tengono gli ultimi 60 giorni e le ultime 40 deleghe
		const limite = giornoLocale(e.at - 60 * 24 * 3_600_000);
		for (const k of Object.keys(s.giorni)) if (k < limite) delete s.giorni[k];
		s.storico = [...s.storico, { at: e.at, capacita: e.capacita, costo: e.costo, durataMs: e.durataMs, ok: e.ok }].slice(-40);
		try {
			scriviPrivato(this.fileSpesa, s);
		} catch (err) {
			this.o.log(`delega: non salvo la spesa (${err})`);
		}
	}

	private lancia(args: string[], stdin: string, timeoutMs: number): Promise<{ stdout: string; code: number | null }> {
		return new Promise(resolve => {
			const claude = trovaClaude(this.o.claudeCommand());
			const p = spawn('nice', ['-n', '10', claude, ...args], {
				cwd: this.dir,
				env: { ...process.env, PATH: pathEsteso(), BOTTEGA_DELEGA: '1' },
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			let out = '';
			let err = '';
			let fatto = false;
			const fine = (code: number | null, extra?: string) => {
				if (fatto) return;
				fatto = true;
				clearTimeout(t);
				if (!out.trim() && (extra || err)) {
					out = JSON.stringify({ is_error: true, result: extra || err.split('\n')[0] || 'errore', total_cost_usd: 0 });
				}
				resolve({ stdout: out, code });
			};
			const t = setTimeout(() => {
				p.kill('SIGTERM');
				setTimeout(() => p.kill('SIGKILL'), 3000).unref();
				fine(null, `nessuna risposta in ${Math.round(timeoutMs / 1000)} secondi`);
			}, timeoutMs);
			p.stdout.on('data', c => (out += c));
			p.stderr.on('data', c => (err += c));
			p.on('error', e => fine(null, `claude non parte: ${e.message}`));
			p.on('close', code => fine(code));
			p.stdin.end(stdin);
		});
	}
}
