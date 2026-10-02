/* Cosa si legge di una sessione Claude Code per la scheda dell'iPhone (docs/CONTRATTI.md, 9.5): dalla coda della
   trascrizione (~/.claude/projects/<cartella>/<sessione>.jsonl) l'ultima richiesta di Andrea, l'ultima risposta di
   Claude, i passi in chiaro («ha modificato ponte.ts», «sta lanciando npm test») e i file toccati; dal registro
   delle sessioni vive (~/.claude/sessions/<pid>.json) che cosa aspetta, se aspetta (`waitingFor`, scritto da
   Claude Code: «approve Bash: npm test», «input needed», «dialog open»). Funzioni pure, senza disco: le letture
   le fa src/ponte-sessioni.ts. Stesso modo di leggere di src/mani.ts, piu' dettagliato. */

import * as crypto from 'crypto';
import * as path from 'path';

export type TipoPasso = 'modifica' | 'comando' | 'lettura' | 'ricerca' | 'web' | 'agente' | 'altro';

export interface Passo {
	testo: string;
	tipo: TipoPasso;
	alle: number;
	/** Lo strumento e' partito e non ha ancora un risultato: «sta ...». */
	inCorso?: boolean;
}

export interface StrumentoAperto {
	id: string;
	nome: string;
	input: any;
}

export interface Lettura {
	richiesta?: string;
	risposta?: string;
	/** Dal piu' vecchio al piu' recente, gli ultimi 20. */
	passi: Passo[];
	/** Percorsi assoluti, dal piu' recente. */
	file: string[];
	ultimo: number;
	/** Gli strumenti chiamati e senza risultato, in ordine. */
	aperti: StrumentoAperto[];
	/** L'ultima parola e' un testo di Claude: ha finito il suo giro. */
	parlaClaude: boolean;
	/** uuid della riga dell'ultima risposta (per riconoscere la domanda). */
	rispostaId?: string;
	/** La cartella di lavoro della sessione, dalla trascrizione. */
	cwd?: string;
	/** L'ultimo strumento chiamato, per la riga della Live Activity (passoBreve). */
	ultimoStrumento?: { nome: string; input: any; inCorso: boolean };
}

export interface Registro {
	status?: string;
	waitingFor?: string;
	startedAt?: number;
	cwd?: string;
}

export interface Domanda {
	/** Cambia a ogni domanda nuova: la risposta dall'iPhone vale solo per quella. */
	id: string;
	/** permesso: Claude Code chiede di usare uno strumento (Si' = invio, No = Esc); scelta: AskUserQuestion;
	 *  domanda: Claude ha finito il giro e aspetta un messaggio; finestra: un'altra finestra di Claude Code. */
	tipo: 'permesso' | 'scelta' | 'domanda' | 'finestra';
	testo: string;
	strumento?: string;
	comando?: string;
	opzioni?: string[];
	/** Nel testo c'e' una domanda: hanno senso i pulsanti Si' e No. */
	chiede?: boolean;
}

const MAX_PASSI = 20;

const clip = (s: unknown, n: number): string => {
	const t = String(s ?? '').replace(/\s+/g, ' ').trim();
	return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Un percorso come lo legge Andrea: relativo alla cartella del progetto, oppure col ~. */
export function percorsoBreve(f: string, cartella?: string, home = process.env.HOME ?? ''): string {
	if (cartella && (f === cartella || f.startsWith(cartella + path.sep))) return path.relative(cartella, f) || path.basename(f);
	if (home && f.startsWith(home + path.sep)) return '~' + f.slice(home.length);
	return f;
}

const isPrompt = (c: any): string | undefined => {
	if (typeof c === 'string') return c.trim() && !c.startsWith('<') ? c : undefined;
	if (!Array.isArray(c) || c.some(p => p?.type === 'tool_result')) return undefined;
	const t = c.find((p: any) => p?.type === 'text')?.text;
	return typeof t === 'string' && t.trim() && !t.startsWith('<') ? t : undefined;
};

/** Un passo in chiaro da una chiamata di strumento. */
export function descriviPasso(nome: string, input: any, inCorso: boolean, cartella?: string): { testo: string; tipo: TipoPasso } {
	const i = input ?? {};
	const file = (f: unknown) => (typeof f === 'string' ? percorsoBreve(f, cartella) : 'un file');
	const v = (fatto: string, ora: string) => (inCorso ? ora : fatto);
	switch (nome) {
		case 'Edit':
		case 'MultiEdit':
			return { testo: `${v('ha modificato', 'sta modificando')} ${file(i.file_path)}`, tipo: 'modifica' };
		case 'Write':
			return { testo: `${v('ha scritto', 'sta scrivendo')} ${file(i.file_path)}`, tipo: 'modifica' };
		case 'NotebookEdit':
			return { testo: `${v('ha modificato', 'sta modificando')} ${file(i.notebook_path)}`, tipo: 'modifica' };
		case 'Read':
			return { testo: `${v('ha letto', 'sta leggendo')} ${file(i.file_path)}`, tipo: 'lettura' };
		case 'Bash': {
			const cosa = clip(i.description || i.command, 80);
			return { testo: `${v('ha lanciato', 'sta lanciando')} ${cosa || 'un comando'}`, tipo: 'comando' };
		}
		case 'Grep':
			return { testo: `${v('ha cercato', 'sta cercando')} «${clip(i.pattern, 50)}» nel codice`, tipo: 'ricerca' };
		case 'Glob':
			return { testo: `${v('ha cercato', 'sta cercando')} i file ${clip(i.pattern, 50)}`, tipo: 'ricerca' };
		case 'WebSearch':
			return { testo: `${v('ha cercato', 'sta cercando')} sul web «${clip(i.query, 60)}»`, tipo: 'web' };
		case 'WebFetch': {
			let host = '';
			try {
				host = new URL(String(i.url)).host;
			} catch {
				// indirizzo strano: resta generico
			}
			return { testo: `${v('ha aperto', 'sta aprendo')} ${host || 'una pagina web'}`, tipo: 'web' };
		}
		case 'Task':
		case 'Agent':
			return { testo: `${v('ha affidato', 'sta affidando')} a un agente: ${clip(i.description || i.prompt, 60)}`, tipo: 'agente' };
		case 'TodoWrite':
			return { testo: v('ha aggiornato la lista delle cose da fare', 'sta aggiornando la lista delle cose da fare'), tipo: 'altro' };
		case 'AskUserQuestion':
			return { testo: v('ti ha fatto una domanda', 'ti sta facendo una domanda'), tipo: 'altro' };
		case 'ExitPlanMode':
			return { testo: v('ha preparato un piano', 'ti propone un piano'), tipo: 'altro' };
	}
	const mcp = /^mcp__(.+?)__(.+)$/.exec(nome);
	if (mcp) return { testo: `${v('ha usato', 'sta usando')} ${mcp[2].replace(/_/g, ' ')} (${mcp[1].replace(/_/g, ' ')})`, tipo: 'altro' };
	return { testo: `${v('ha usato', 'sta usando')} ${nome}`, tipo: 'altro' };
}

/** Legge la coda di una trascrizione (righe jsonl). La prima riga puo' essere tagliata: si salta. */
export function leggiCoda(testo: string, cartella?: string): Lettura {
	const out: Lettura = { passi: [], file: [], ultimo: 0, aperti: [], parlaClaude: false };
	const aperti = new Map<string, StrumentoAperto & { passo: Passo }>();
	const file: string[] = [];
	for (const riga of testo.split('\n')) {
		if (!riga.startsWith('{')) continue;
		let d: any;
		try {
			d = JSON.parse(riga);
		} catch {
			continue;
		}
		if (d.type !== 'user' && d.type !== 'assistant') continue;
		if (d.isSidechain) continue; // i messaggi interni degli agenti non sono la sessione
		if (typeof d.cwd === 'string') out.cwd = d.cwd;
		const t = Date.parse(d.timestamp ?? '') || 0;
		if (t > out.ultimo) out.ultimo = t;
		const c = d.message?.content;
		if (d.type === 'user') {
			if (Array.isArray(c)) {
				for (const p of c) {
					if (p?.type !== 'tool_result') continue;
					const a = aperti.get(p.tool_use_id);
					if (a) {
						const fatto = descriviPasso(a.nome, a.input, false, cartella ?? out.cwd);
						a.passo.testo = fatto.testo;
						delete a.passo.inCorso;
						aperti.delete(p.tool_use_id);
					}
				}
			}
			const p = !d.isMeta && !d.isCompactSummary ? isPrompt(c) : undefined;
			if (p) {
				out.richiesta = p;
				out.parlaClaude = false;
			} else if (Array.isArray(c) && c.some((x: any) => x?.type === 'tool_result')) out.parlaClaude = false;
			continue;
		}
		if (!Array.isArray(c)) continue;
		for (const part of c) {
			if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
				out.risposta = part.text;
				out.rispostaId = d.uuid ?? d.message?.id;
				out.parlaClaude = true;
			}
			if (part?.type === 'tool_use' && part.name) {
				const des = descriviPasso(part.name, part.input, true, cartella ?? out.cwd);
				const passo: Passo = { ...des, alle: t, inCorso: true };
				out.passi.push(passo);
				aperti.set(part.id, { id: part.id, nome: part.name, input: part.input, passo });
				out.ultimoStrumento = { nome: part.name, input: part.input, inCorso: true };
				const f = part.input?.file_path ?? part.input?.notebook_path;
				if (typeof f === 'string') file.push(f);
				out.parlaClaude = false;
			}
		}
	}
	out.passi = out.passi.slice(-MAX_PASSI);
	out.file = [...new Set(file.reverse())].slice(0, 30);
	out.aperti = [...aperti.values()].map(({ id, nome, input }) => ({ id, nome, input }));
	if (out.ultimoStrumento) out.ultimoStrumento.inCorso = out.aperti.some(a => a.input === out.ultimoStrumento!.input);
	return out;
}

const corto = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

/** La domanda in primo piano, se la sessione aspetta Andrea. `aspetta`: lo stato della Bottega dice «ti aspetta». */
export function domandaDi(l: Lettura, reg: Registro | undefined, aspetta: boolean, sessione: string): Domanda | undefined {
	const wf = typeof reg?.waitingFor === 'string' ? reg.waitingFor.trim() : '';
	const domanda = l.aperti.find(a => a.nome === 'AskUserQuestion');
	if (domanda) {
		const q = Array.isArray(domanda.input?.questions) ? domanda.input.questions[0] : undefined;
		const opzioni = Array.isArray(q?.options) ? q.options.map((o: any) => clip(o?.label ?? o, 80)).filter(Boolean).slice(0, 8) : [];
		return { id: corto(`${sessione}:${domanda.id}`), tipo: 'scelta', testo: clip(q?.question ?? 'Claude ti chiede di scegliere.', 400), opzioni, chiede: true };
	}
	const m = /^approve (.+?)(?:: (.*))?$/s.exec(wf);
	if (m && m[1] !== 'plan' && !/^plan from/.test(m[1])) {
		// il permesso per uno strumento: il comando viene dal registro, la descrizione dalla trascrizione
		const strumento = m[1].trim();
		const comando = (m[2] ?? '').trim();
		const aperto = [...l.aperti].reverse().find(a => {
			const x = a.input?.command ?? a.input?.file_path ?? a.input?.url ?? '';
			return comando ? String(x).trim() === comando || comando.startsWith(String(x).trim().slice(0, 40)) : a.nome === strumento;
		});
		const descr = aperto?.input?.description ? clip(aperto.input.description, 160) : '';
		return {
			id: corto(`${sessione}:${aperto?.id ?? ''}:${wf}`),
			tipo: 'permesso',
			testo: descr || `Claude chiede il permesso di usare ${strumento}.`,
			strumento,
			...(comando ? { comando: comando.slice(0, 2000) } : {}),
			chiede: true,
		};
	}
	if (wf) {
		const cosa = /^approve plan/.test(wf) ? 'Claude ha preparato un piano e aspetta che tu lo approvi.' : `Claude Code ha una finestra aperta (${clip(wf, 80)}).`;
		return { id: corto(`${sessione}:${wf}`), tipo: 'finestra', testo: cosa };
	}
	// Claude Code piu' vecchi non scrivono waitingFor: uno strumento senza risultato, a sessione ferma, e' un permesso
	if (l.aperti.length && reg?.status && reg.status !== 'busy') {
		const a = l.aperti[l.aperti.length - 1];
		const comando = String(a.input?.command ?? a.input?.file_path ?? a.input?.url ?? '').trim();
		return {
			id: corto(`${sessione}:${a.id}`),
			tipo: 'permesso',
			testo: a.input?.description ? clip(a.input.description, 160) : `Claude chiede il permesso di usare ${a.nome}.`,
			strumento: a.nome,
			...(comando ? { comando: comando.slice(0, 2000) } : {}),
			chiede: true,
		};
	}
	if (aspetta && l.parlaClaude && l.risposta) {
		const testo = l.risposta.trim();
		return {
			id: corto(`${sessione}:${l.rispostaId ?? testo.slice(0, 200)}`),
			tipo: 'domanda',
			testo: testo.length > 900 ? '…' + testo.slice(-899) : testo,
			chiede: /\?\s*(\*\*)?\s*$/.test(testo) || /\?[^?]{0,200}$/.test(testo.slice(-300)),
		};
	}
	return undefined;
}

/** L'ultimo passo per la Live Activity: il testo passa dai server di Apple, quindi solo un verbo e il nome di un
 *  file o del programma lanciato, mai un comando intero, un percorso o un contenuto. */
export function passoBreve(nome: string, input: any, inCorso: boolean): string {
	const i = input ?? {};
	const base = (f: unknown) => (typeof f === 'string' ? clip(path.basename(f), 40) : 'un file');
	const v = (fatto: string, ora: string) => (inCorso ? ora : fatto);
	switch (nome) {
		case 'Edit':
		case 'MultiEdit':
		case 'Write':
		case 'NotebookEdit':
			return `${v('ha modificato', 'modifica')} ${base(i.file_path ?? i.notebook_path)}`;
		case 'Read':
			return `${v('ha letto', 'legge')} ${base(i.file_path)}`;
		case 'Bash': {
			// solo il nome del programma: niente argomenti, che possono contenere qualunque cosa
			const prog = String(i.command ?? '').trim().split(/\s+/).find(p => !/=/.test(p)) ?? '';
			const nomeProg = /^[\w.+-]{1,24}$/.test(path.basename(prog)) ? path.basename(prog) : '';
			return nomeProg ? `${v('ha lanciato', 'lancia')} ${nomeProg}` : v('ha lanciato un comando', 'lancia un comando');
		}
		case 'Grep':
		case 'Glob':
			return v('ha cercato nel codice', 'cerca nel codice');
		case 'WebSearch':
		case 'WebFetch':
			return v('ha cercato sul web', 'cerca sul web');
		case 'Task':
		case 'Agent':
			return v('ha lavorato con un agente', 'lavora con un agente');
		default:
			return v('ha usato uno strumento', 'usa uno strumento');
	}
}

export interface Conto {
	/** Byte gia' letti del file. */
	letto: number;
	/** Token per messaggio (lo stesso messaggio compare su piu' righe, una per blocco): si conta una volta. */
	messaggi: Map<string, { entrata: number; uscita: number }>;
	contesto: number;
	/** Pezzo di riga rimasto a meta' alla fine dell'ultimo blocco. */
	resto: string;
}

export interface Token {
	/** Token nuovi in entrata (senza la cache gia' letta), su tutta la sessione. */
	entrata: number;
	uscita: number;
	/** Quanto e' grande il contesto adesso (ultimo messaggio, cache compresa). */
	contesto: number;
}

export function nuovoConto(): Conto {
	return { letto: 0, messaggi: new Map(), contesto: 0, resto: '' };
}

/** Aggiunge al conto un pezzo nuovo del file (dalla posizione `conto.letto`). */
export function contaToken(conto: Conto, pezzo: string, byte: number): void {
	const testo = conto.resto + pezzo;
	const righe = testo.split('\n');
	conto.resto = righe.pop() ?? '';
	if (conto.resto.length > 4 << 20) conto.resto = ''; // riga enorme e senza fine: si lascia stare
	conto.letto += byte;
	for (const r of righe) {
		if (!r.includes('"usage"')) continue;
		let d: any;
		try {
			d = JSON.parse(r);
		} catch {
			continue;
		}
		const u = d?.message?.usage;
		if (d?.type !== 'assistant' || !u) continue;
		const id = String(d.message.id ?? d.uuid ?? conto.messaggi.size);
		const entrata = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
		conto.messaggi.set(id, { entrata, uscita: u.output_tokens || 0 });
		if (!d.isSidechain) conto.contesto = entrata + (u.cache_read_input_tokens || 0);
	}
}

export function totaleToken(conto: Conto): Token {
	let entrata = 0;
	let uscita = 0;
	for (const m of conto.messaggi.values()) {
		entrata += m.entrata;
		uscita += m.uscita;
	}
	return { entrata, uscita, contesto: conto.contesto };
}
