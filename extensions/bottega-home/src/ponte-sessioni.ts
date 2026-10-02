import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { WorkItem } from './jobs';
import { transcriptOf } from './mani';
import type { AiutiRotte, RigaParla, RotteSessioni } from './ponte';
import { Schermo } from './schermo';
import { Conto, contaToken, Domanda, domandaDi, Lettura, leggiCoda, nuovoConto, Passo, passoBreve, percorsoBreve, Registro, Token, totaleToken } from './sessione-lettura';

/* La scheda di una sessione per l'iPhone (docs/CONTRATTI.md, 9.5): tutte le sessioni Claude del Mac, anche quelle
   aperte in iTerm o altrove. Rotte sotto /v1/sessione, chiamate da src/ponte.ts dopo il gettone:

     GET  /v1/sessione?chiave=K               -> Scheda
     GET  /v1/sessione/eventi?chiave=K        -> text/event-stream, una riga "data: Scheda" a ogni cambio
     GET  /v1/sessione/modifiche?chiave=K     -> Modifiche   (git diff --numstat HEAD + i file nuovi)
     GET  /v1/sessione/diff?chiave=K&file=F   -> {file, diff, troncato}
     GET  /v1/sessione/terminale?chiave=K     -> text/event-stream di {righe, vivo}: solo lavori della Bottega
     POST /v1/sessione/rispondi {chiave, domanda, risposta: si|no|testo, testo?}  -> {ok}: solo lavori della Bottega
     POST /v1/sessione/segui {chiave}         -> {ok, seguita}: la Live Activity mostra il suo ultimo passo ('' smette)
     POST /v1/sessione/riassunto {chiave}     -> application/x-ndjson come /v1/parla: Melissa la racconta a voce

   Costi: niente gira se nessuno guarda. Mentre almeno un iPhone tiene aperta una scheda, un giro ogni 1,5 s guarda
   solo dimensione e data del jsonl e del registro; si rilegge la coda (256 KB) solo se sono cambiati. I token si
   contano una volta su tutto il file e poi solo sulla parte nuova. Il terminale si legge solo mentre qualcuno lo
   guarda, in memoria, mai su disco. git sempre con spawn (mai una shell), senza lucchetti, nella cartella di un
   progetto che la Bottega conosce, con l'uscita tagliata a 200 KB. Si scrive solo nei terminali dei lavori della
   Bottega, e solo la risposta alla domanda che e' davvero aperta adesso. */

export interface FonteTerminale {
	/** Comincia a leggere l'uscita grezza da adesso: ritorna come smettere, oppure il motivo per cui non si puo'. */
	ascolta(dati: (testo: string) => void, fine: () => void): (() => void) | string;
}

export interface SessioniDeps {
	/** Il lavoro in giro (snapshot.work): lavori della Bottega e sessioni aperte altrove. */
	lavori(): WorkItem[];
	/** Le cartelle dei progetti che la Bottega conosce: git gira solo dentro queste. */
	progetti(): string[];
	/** Scrive nel terminale di un lavoro della Bottega; `invio` aggiunge l'a capo. Falso se il terminale non c'e'. */
	scrivi?(jobId: string, dati: string, invio: boolean): boolean;
	terminale?(jobId: string): FonteTerminale | undefined;
	/** La sessione seguita o il suo ultimo passo sono cambiati: la Live Activity va aggiornata. */
	cambiato?(): void;
	log(riga: string): void;
	/** Solo per i test. */
	radice?: string;
	registro?: string;
	git?: string;
	ogniMs?: number;
	seguiOgniMs?: number;
	pausaEsc?: number;
}

export interface Scheda {
	chiave: string;
	origine: 'bottega' | 'altrove';
	stato: string;
	progetto: string;
	titolo: string;
	da: number;
	jobId?: string;
	/** Quando e' partita la sessione (ms). */
	iniziata?: number;
	/** Ultimo movimento nella trascrizione (ms). */
	ultimo?: number;
	richiesta?: string;
	risposta?: string;
	passi: Passo[];
	file: string[];
	token?: Token & { parziale?: boolean };
	domanda?: Domanda;
	/** Si puo' rispondere da qui: lavoro della Bottega con il terminale aperto. */
	scrivibile: boolean;
	terminale: boolean;
	modifiche: boolean;
	seguita: boolean;
	/** Uscita dalla lista mentre la si guardava. */
	finita?: boolean;
}

export interface FileCambiato {
	percorso: string;
	aggiunte: number;
	tolte: number;
	tipo: 'modificato' | 'nuovo' | 'tolto' | 'binario';
}

export interface Modifiche {
	cartella: string;
	ramo: string;
	file: FileCambiato[];
	/** Quanti file nuovi non tracciati ci sono in tutto (nella lista al massimo 40). */
	nonTracciati: number;
	troncato: boolean;
}

const RADICE = path.join(os.homedir(), '.claude', 'projects');
const REGISTRO = path.join(os.homedir(), '.claude', 'sessions');
const CODA = 256 * 1024;
const LIMITE_GIT = 200 * 1024;
const MAX_FLUSSI = 8;
const MAX_TERMINALI = 3;
const TOKEN_MAX = 64 << 20; // oltre, i token si contano sugli ultimi 64 MB

const errore = (status: number, msg: string) => Object.assign(new Error(msg), { status });

const dentro = (p: string, base: string) => p === base || p.startsWith(base.endsWith(path.sep) ? base : base + path.sep);

function vero(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

interface Memo {
	file: string;
	size: number;
	mtime: number;
	lettura: Lettura;
	conto: Conto;
	tokenParziale: boolean;
}

interface Flusso {
	res: http.ServerResponse;
	chiave: string;
	firma: string;
	ultima: string;
}

export class SessioniPonte implements RotteSessioni {
	private readonly memo = new Map<string, Memo>();
	private readonly trascrizioni = new Map<string, string>();
	private readonly visti = new Map<string, WorkItem>();
	private readonly flussi = new Set<Flusso>();
	private readonly terminali = new Set<() => void>();
	private giro?: NodeJS.Timeout;
	private ping?: NodeJS.Timeout;
	private inGiro = false;
	private seguita?: { chiave: string; progetto: string; passo: string; stato: string; persaDal?: number };
	private seguiTimer?: NodeJS.Timeout;

	constructor(private readonly d: SessioniDeps) {}

	// ---------- la scheda ----------

	private lavoro(chiave: string): { w: WorkItem; finita: boolean } | undefined {
		const w = this.d.lavori().find(x => x.key === chiave);
		if (w) {
			this.visti.set(chiave, w);
			if (this.visti.size > 60) this.visti.delete(this.visti.keys().next().value!);
			return { w, finita: false };
		}
		const v = this.visti.get(chiave);
		return v ? { w: v, finita: true } : undefined;
	}

	private fileDi(sessionId: string | undefined): string | undefined {
		if (!sessionId) return undefined;
		const noto = this.trascrizioni.get(sessionId);
		if (noto && fs.existsSync(noto)) return noto;
		const f = transcriptOf(sessionId, this.d.radice ?? RADICE);
		if (f) this.trascrizioni.set(sessionId, f);
		return f;
	}

	private async registro(pid: number | undefined): Promise<(Registro & { mtime: number }) | undefined> {
		if (!pid) return undefined;
		const f = path.join(this.d.registro ?? REGISTRO, `${pid}.json`);
		try {
			const [st, testo] = await Promise.all([fs.promises.stat(f), fs.promises.readFile(f, 'utf8')]);
			const r = JSON.parse(testo);
			return {
				status: typeof r.status === 'string' ? r.status : undefined,
				waitingFor: typeof r.waitingFor === 'string' ? r.waitingFor : undefined,
				startedAt: Number(r.startedAt) || undefined,
				cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
				mtime: st.mtimeMs,
			};
		} catch {
			return undefined;
		}
	}

	/** La coda della trascrizione e il conto dei token, riletti solo se il file e' cambiato. */
	private async leggi(file: string, cartella?: string): Promise<Memo | undefined> {
		let st: fs.Stats;
		try {
			st = await fs.promises.stat(file);
		} catch {
			return undefined;
		}
		const m = this.memo.get(file);
		if (m && m.size === st.size && m.mtime === st.mtimeMs) return m;
		const fh = await fs.promises.open(file, 'r');
		try {
			const start = Math.max(0, st.size - CODA);
			const buf = Buffer.alloc(st.size - start);
			await fh.read(buf, 0, buf.length, start);
			let testo = buf.toString('utf8');
			if (start > 0) testo = testo.slice(testo.indexOf('\n') + 1);
			const lettura = leggiCoda(testo, cartella);
			// i token: la prima volta tutto il file (al massimo gli ultimi 64 MB), poi solo il pezzo nuovo
			let conto = m?.conto && st.size >= m.conto.letto ? m.conto : nuovoConto();
			let parziale = m?.tokenParziale ?? false;
			if (conto.letto === 0 && st.size > TOKEN_MAX) {
				conto = nuovoConto();
				conto.letto = st.size - TOKEN_MAX;
				parziale = true;
			}
			const pezzo = 1 << 20;
			while (conto.letto < st.size) {
				const n = Math.min(pezzo, st.size - conto.letto);
				const b = Buffer.alloc(n);
				const { bytesRead } = await fh.read(b, 0, n, conto.letto);
				if (!bytesRead) break;
				contaToken(conto, b.subarray(0, bytesRead).toString('utf8'), bytesRead);
			}
			const nuovo: Memo = { file, size: st.size, mtime: st.mtimeMs, lettura, conto, tokenParziale: parziale };
			this.memo.set(file, nuovo);
			if (this.memo.size > 30) this.memo.delete(this.memo.keys().next().value!);
			return nuovo;
		} finally {
			await fh.close();
		}
	}

	/** La cartella dove guardare le modifiche: quella della sessione se sta dentro un progetto conosciuto
	 *  (per esempio un worktree), altrimenti quella del progetto; nessuna fuori dai progetti. */
	private cartella(w: WorkItem, reg?: Registro, l?: Lettura): string | undefined {
		const progetti = this.d.progetti().filter(Boolean).map(vero);
		for (const c of [reg?.cwd, l?.cwd, w.path]) {
			if (!c) continue;
			const v = vero(c);
			if (progetti.some(p => dentro(v, p)) && fs.existsSync(v)) return v;
		}
		return undefined;
	}

	async scheda(chiave: string): Promise<Scheda | undefined> {
		const t = this.lavoro(chiave);
		if (!t) return undefined;
		const { w, finita } = t;
		const reg = finita ? undefined : await this.registro(w.pid);
		const file = this.fileDi(w.sessionId);
		const progetto = this.d.progetti().filter(Boolean).map(vero).find(p => dentro(vero(w.path), p));
		const m = file ? await this.leggi(file, progetto ?? w.path) : undefined;
		const l = m?.lettura;
		const aspetta = w.status === 'ti aspetta' || reg?.status === 'waiting' || !!reg?.waitingFor;
		const domanda = l && !finita && aspetta ? domandaDi(l, reg, w.status === 'ti aspetta', w.sessionId ?? chiave) : undefined;
		const scrivibile = !!w.jobId && !finita && !!this.d.scrivi;
		const cartella = this.cartella(w, reg, l);
		const s: Scheda = {
			chiave,
			origine: w.source,
			stato: finita ? 'finita' : w.status,
			progetto: w.project,
			titolo: w.title,
			da: w.since,
			...(w.jobId ? { jobId: w.jobId } : {}),
			...(reg?.startedAt ? { iniziata: reg.startedAt } : {}),
			...(l?.ultimo ? { ultimo: l.ultimo } : {}),
			...(l?.richiesta ? { richiesta: clip(l.richiesta, 1500) } : {}),
			...(l?.risposta ? { risposta: clip(l.risposta, 3000) } : {}),
			passi: l?.passi ?? [],
			file: (l?.file ?? []).map(f => percorsoBreve(f, cartella ?? progetto)).slice(0, 20),
			...(m ? { token: { ...totaleToken(m.conto), ...(m.tokenParziale ? { parziale: true } : {}) } } : {}),
			...(domanda ? { domanda } : {}),
			scrivibile,
			terminale: !!w.jobId && !finita && !!this.d.terminale,
			modifiche: !!cartella,
			seguita: this.seguita?.chiave === chiave,
			...(finita ? { finita: true } : {}),
		};
		return s;
	}

	/** Quello che cambia la scheda, senza leggere niente: dimensione e data dei file, stato del lavoro. */
	private async firma(chiave: string): Promise<string> {
		const t = this.lavoro(chiave);
		if (!t) return 'via';
		const f = this.fileDi(t.w.sessionId);
		const st = f ? await fs.promises.stat(f).catch(() => undefined) : undefined;
		const reg = t.w.pid ? await fs.promises.stat(path.join(this.d.registro ?? REGISTRO, `${t.w.pid}.json`)).catch(() => undefined) : undefined;
		return [t.w.status, t.finita, t.w.jobId, st?.size, st?.mtimeMs, reg?.mtimeMs, this.seguita?.chiave === chiave].join('|');
	}

	// ---------- le rotte ----------

	async gestisci(req: http.IncomingMessage, res: http.ServerResponse, aiuti: AiutiRotte): Promise<void> {
		const u = new URL(req.url ?? '/', 'http://ponte');
		const via = u.pathname.replace(/\/+$/, '');
		const json = (code: number, body: unknown) => {
			res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
			res.end(JSON.stringify(body));
		};
		if (req.method === 'GET') {
			const chiave = u.searchParams.get('chiave') ?? '';
			if (!chiave) throw errore(400, 'Manca la sessione.');
			if (via === '/v1/sessione') {
				const s = await this.scheda(chiave);
				return s ? json(200, s) : json(404, { errore: 'Questa sessione non c\'e\' piu\'.' });
			}
			if (via === '/v1/sessione/eventi') return this.eventi(req, res, chiave);
			if (via === '/v1/sessione/modifiche') return json(200, await this.modifiche(chiave));
			if (via === '/v1/sessione/diff') return json(200, await this.diff(chiave, u.searchParams.get('file') ?? ''));
			if (via === '/v1/sessione/terminale') return this.terminale(req, res, chiave);
			return json(404, { errore: 'Non c\'e\' niente qui.' });
		}
		if (req.method !== 'POST') return json(404, { errore: 'Non c\'e\' niente qui.' });
		const corpo = (await aiuti.corpo()) ?? {};
		const chiave = typeof corpo.chiave === 'string' ? corpo.chiave : '';
		if (via === '/v1/sessione/rispondi') {
			await this.rispondi(chiave, corpo);
			return json(200, { ok: true });
		}
		if (via === '/v1/sessione/segui') {
			const seguita = this.segui(chiave);
			return json(200, { ok: true, seguita });
		}
		if (via === '/v1/sessione/riassunto') return this.riassunto(req, res, chiave, aiuti);
		return json(404, { errore: 'Non c\'e\' niente qui.' });
	}

	chiudi(): void {
		for (const f of this.flussi) f.res.end();
		this.flussi.clear();
		for (const stop of [...this.terminali]) stop();
		this.terminali.clear();
		this.aggiornaTimer();
	}

	/** Chiude anche il seguito (alla chiusura della Bottega). */
	dispose(): void {
		this.chiudi();
		clearInterval(this.seguiTimer);
		this.seguiTimer = undefined;
		this.seguita = undefined;
	}

	// ---------- in diretta ----------

	private async eventi(req: http.IncomingMessage, res: http.ServerResponse, chiave: string): Promise<void> {
		if (this.flussi.size >= MAX_FLUSSI) throw errore(429, 'Troppe schede aperte insieme: chiudine una.');
		const s = await this.scheda(chiave);
		if (!s) throw errore(404, 'Questa sessione non c\'e\' piu\'.');
		res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
		const ultima = JSON.stringify(s);
		res.write(`data: ${ultima}\n\n`);
		const f: Flusso = { res, chiave, firma: await this.firma(chiave), ultima };
		this.flussi.add(f);
		req.on('close', () => {
			this.flussi.delete(f);
			this.aggiornaTimer();
		});
		this.aggiornaTimer();
	}

	/** I timer vivono solo finche' c'e' qualcuno che guarda. */
	private aggiornaTimer(): void {
		if (this.flussi.size && !this.giro) this.giro = setInterval(() => void this.giroFlussi(), this.d.ogniMs ?? 1500);
		if (!this.flussi.size && this.giro) {
			clearInterval(this.giro);
			this.giro = undefined;
		}
		const aperti = this.flussi.size + this.terminali.size;
		if (aperti && !this.ping) {
			this.ping = setInterval(() => {
				for (const f of this.flussi) f.res.write(': ping\n\n');
			}, 25_000);
		}
		if (!aperti && this.ping) {
			clearInterval(this.ping);
			this.ping = undefined;
		}
	}

	private async giroFlussi(): Promise<void> {
		if (this.inGiro) return;
		this.inGiro = true;
		try {
			const perChiave = new Map<string, Flusso[]>();
			for (const f of this.flussi) perChiave.set(f.chiave, [...(perChiave.get(f.chiave) ?? []), f]);
			for (const [chiave, fl] of perChiave) {
				const firma = await this.firma(chiave);
				if (fl.every(f => f.firma === firma)) continue;
				const s = await this.scheda(chiave);
				if (!s) continue;
				const testo = JSON.stringify(s);
				for (const f of fl) {
					f.firma = firma;
					if (testo === f.ultima) continue;
					f.ultima = testo;
					f.res.write(`data: ${testo}\n\n`);
				}
			}
		} catch (e: any) {
			this.d.log(`sessioni: ${e?.message ?? e}`);
		} finally {
			this.inGiro = false;
		}
	}

	/** Dopo una scrittura nel terminale: il prossimo giro rilegge comunque. */
	private sveglia(chiave: string): void {
		for (const f of this.flussi) if (f.chiave === chiave) f.firma = '';
	}

	// ---------- la risposta alla domanda ----------

	private async rispondi(chiave: string, corpo: any): Promise<void> {
		const t = this.lavoro(chiave);
		if (!t || t.finita) throw errore(404, 'Questa sessione non c\'e\' piu\'.');
		if (!t.w.jobId) throw errore(403, 'Questa sessione e\' aperta in un\'altra app: rispondi dal Mac.');
		if (!this.d.scrivi) throw errore(503, 'Da qui non si puo\' scrivere.');
		const risposta = corpo.risposta;
		if (risposta !== 'si' && risposta !== 'no' && risposta !== 'testo') throw errore(400, 'Risposta sconosciuta: si, no o testo.');
		const testo = typeof corpo.testo === 'string' ? corpo.testo.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 2000) : '';
		if (risposta === 'testo' && !testo) throw errore(400, 'Manca il testo.');
		// la domanda si rilegge adesso (registro e trascrizione): un tocco su una scheda vecchia non approva quella dopo
		const s = await this.scheda(chiave);
		const dom = s?.domanda;
		if (!dom) throw errore(409, 'Non aspetta piu\' una risposta: guarda la scheda.');
		if (dom.id !== corpo.domanda) throw errore(409, 'La domanda e\' cambiata: guarda la scheda.');
		const id = t.w.jobId;
		const scrivi = (dati: string, invio: boolean) => {
			if (!this.d.scrivi!(id, dati, invio)) throw errore(404, 'Quel lavoro non ha piu\' un terminale aperto.');
		};
		const pausa = () => new Promise(r => setTimeout(r, this.d.pausaEsc ?? 350));
		if (dom.tipo === 'finestra') throw errore(409, 'Questa finestra di Claude Code si gestisce dal Mac.');
		if (dom.tipo === 'permesso') {
			// il prompt dei permessi di Claude Code: la prima opzione («Yes») e' gia' scelta, invio la conferma; Esc e' il no
			if (risposta === 'si') scrivi('', true);
			else if (risposta === 'no') scrivi('\x1b', false);
			else {
				// no, e il testo come istruzione nuova
				scrivi('\x1b', false);
				await pausa();
				scrivi(testo, true);
			}
		} else if (dom.tipo === 'scelta') {
			if (risposta !== 'testo') throw errore(400, 'A questa domanda si risponde con un testo.');
			// la domanda a scelte si chiude con Esc, poi la risposta arriva come messaggio
			scrivi('\x1b', false);
			await pausa();
			scrivi(testo, true);
		} else {
			scrivi(risposta === 'si' ? 'Sì' : risposta === 'no' ? 'No' : testo, true);
		}
		this.d.log(`sessioni: risposta dall'iPhone a ${t.w.project} (${dom.tipo}, ${risposta})`);
		this.sveglia(chiave);
	}

	// ---------- le modifiche ----------

	private async cartellaDi(chiave: string): Promise<string> {
		const t = this.lavoro(chiave);
		if (!t) throw errore(404, 'Questa sessione non c\'e\' piu\'.');
		const reg = t.finita ? undefined : await this.registro(t.w.pid);
		const file = this.fileDi(t.w.sessionId);
		const m = file ? this.memo.get(file) : undefined;
		const c = this.cartella(t.w, reg, m?.lettura);
		if (!c) throw errore(403, 'Questa sessione non lavora in un progetto che la Bottega conosce.');
		return c;
	}

	private git(args: string[], cwd: string, limite = LIMITE_GIT): Promise<{ out: string; troncato: boolean; codice: number | null }> {
		return eseguiGit(this.d.git ?? 'git', args, cwd, limite);
	}

	async modifiche(chiave: string): Promise<Modifiche> {
		const dir = await this.cartellaDi(chiave);
		const dentroRepo = await this.git(['rev-parse', '--is-inside-work-tree'], dir, 1024);
		if (dentroRepo.codice !== 0 || dentroRepo.out.trim() !== 'true') throw errore(409, 'Questo progetto non e\' un repository git.');
		const ramo = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], dir, 1024)).out.trim();
		const opzioni = ['--numstat', '--no-renames', '--relative', '--no-color', '--no-ext-diff', '--no-textconv'];
		let num = await this.git(['diff', 'HEAD', ...opzioni], dir);
		if (num.codice !== 0) num = await this.git(['diff', ...opzioni], dir); // repository senza commit
		const file: FileCambiato[] = [];
		for (const riga of num.out.split('\n')) {
			const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(riga);
			if (!m) continue;
			const binario = m[1] === '-';
			const aggiunte = binario ? 0 : +m[1];
			const tolte = binario ? 0 : +m[2];
			const esiste = fs.existsSync(path.join(dir, m[3]));
			file.push({ percorso: m[3], aggiunte, tolte, tipo: binario ? 'binario' : !esiste ? 'tolto' : 'modificato' });
			if (file.length >= 300) break;
		}
		const altri = await this.git(['ls-files', '--others', '--exclude-standard', '-z'], dir, 256 * 1024);
		const nuovi = altri.out.split('\0').filter(Boolean);
		for (const f of nuovi.slice(0, 40)) {
			const righe = await contaRighe(path.join(dir, f));
			file.push({ percorso: f, aggiunte: righe ?? 0, tolte: 0, tipo: righe === undefined ? 'binario' : 'nuovo' });
		}
		return {
			cartella: percorsoBreve(dir, undefined, os.homedir()),
			ramo: ramo === 'HEAD' ? 'testa staccata' : ramo,
			file,
			nonTracciati: nuovi.length,
			troncato: num.troncato || altri.troncato || nuovi.length > 40 || file.length - Math.min(40, nuovi.length) >= 300,
		};
	}

	async diff(chiave: string, file: string): Promise<{ file: string; diff: string; troncato: boolean; nuovo: boolean }> {
		const dir = await this.cartellaDi(chiave);
		if (!file || file.length > 1024 || file.includes('\0') || path.isAbsolute(file)) throw errore(400, 'File non valido.');
		const pieno = path.resolve(dir, file);
		if (!dentro(pieno, dir) || pieno === dir) throw errore(403, 'Quel file e\' fuori dal progetto.');
		if (fs.existsSync(pieno) && !dentro(vero(pieno), dir)) throw errore(403, 'Quel file e\' fuori dal progetto.');
		const rel = path.relative(dir, pieno);
		const opzioni = ['--no-color', '--no-ext-diff', '--no-textconv'];
		const tracciato = (await this.git(['ls-files', '--error-unmatch', '--', `:(literal)${rel}`], dir, 4096)).codice === 0;
		if (tracciato) {
			let r = await this.git(['diff', 'HEAD', ...opzioni, '--', `:(literal)${rel}`], dir);
			if (r.codice !== 0 && !r.out) r = await this.git(['diff', ...opzioni, '--', `:(literal)${rel}`], dir);
			return { file: rel, diff: r.out, troncato: r.troncato, nuovo: false };
		}
		// un file nuovo si mostra solo se git lo elencherebbe tra le modifiche: mai un file ignorato (.env e simili)
		const nuovo = (await this.git(['ls-files', '--others', '--exclude-standard', '-z', '--', `:(literal)${rel}`], dir, 4096)).out.split('\0').filter(Boolean);
		if (!nuovo.includes(rel) || !fs.statSync(pieno).isFile()) throw errore(404, 'Quel file non e\' tra le modifiche.');
		const r = await this.git(['diff', '--no-index', ...opzioni, '--', '/dev/null', rel], dir);
		return { file: rel, diff: r.out, troncato: r.troncato, nuovo: true };
	}

	// ---------- il terminale ----------

	private terminale(req: http.IncomingMessage, res: http.ServerResponse, chiave: string): void {
		const t = this.lavoro(chiave);
		if (!t || t.finita) throw errore(404, 'Questa sessione non c\'e\' piu\'.');
		if (!t.w.jobId) throw errore(403, 'Il terminale si vede solo per i lavori della Bottega.');
		if (this.terminali.size >= MAX_TERMINALI) throw errore(429, 'Troppi terminali aperti insieme: chiudine uno.');
		const fonte = this.d.terminale?.(t.w.jobId);
		if (!fonte) throw errore(404, 'Il terminale di questo lavoro non e\' piu\' aperto.');
		const schermo = new Schermo();
		let ultimo = '';
		let attesa: NodeJS.Timeout | undefined;
		let finito = false;
		const manda = (vivo: boolean) => {
			const righe = schermo.testo(150);
			const testo = JSON.stringify({ righe, vivo });
			if (testo === ultimo && vivo) return;
			ultimo = testo;
			if (!res.writableEnded) res.write(`data: ${testo}\n\n`);
		};
		const ascolto = fonte.ascolta(
			dati => {
				schermo.scrivi(dati);
				// al massimo quattro volte al secondo
				attesa ??= setTimeout(() => {
					attesa = undefined;
					manda(true);
				}, 250);
			},
			() => {
				finito = true;
				clearTimeout(attesa);
				manda(false);
				res.end();
			},
		);
		if (typeof ascolto === 'string') throw errore(409, ascolto);
		res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
		manda(true);
		const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
		const stop = () => {
			clearInterval(ping);
			clearTimeout(attesa);
			if (!finito) ascolto();
			finito = true;
			this.terminali.delete(stop);
			if (!res.writableEnded) res.end();
			this.aggiornaTimer();
		};
		this.terminali.add(stop);
		req.on('close', stop);
		this.d.log(`sessioni: l'iPhone guarda il terminale di ${t.w.project}`);
	}

	// ---------- segui sulla Live Activity ----------

	/** Sceglie la sessione da seguire ('' smette). Ritorna la chiave seguita adesso. */
	segui(chiave: string): string {
		if (!chiave) {
			if (this.seguita) {
				this.seguita = undefined;
				this.d.cambiato?.();
			}
			clearInterval(this.seguiTimer);
			this.seguiTimer = undefined;
			return '';
		}
		const t = this.lavoro(chiave);
		if (!t || t.finita) throw errore(404, 'Questa sessione non c\'e\' piu\'.');
		this.seguita = { chiave, progetto: t.w.project, passo: '', stato: t.w.status };
		this.seguiTimer ??= setInterval(() => void this.giroSegui(), this.d.seguiOgniMs ?? 5000);
		void this.giroSegui();
		for (const f of this.flussi) f.firma = '';
		return chiave;
	}

	/** Per la Live Activity (src/avvisi.ts): progetto, stato e l'ultimo passo, in forma breve. */
	seguito(): { chiave: string; progetto: string; passo: string; stato: string } | undefined {
		const s = this.seguita;
		return s ? { chiave: s.chiave, progetto: s.progetto, passo: s.passo, stato: s.stato } : undefined;
	}

	private async giroSegui(): Promise<void> {
		const s = this.seguita;
		if (!s) return;
		const w = this.d.lavori().find(x => x.key === s.chiave);
		if (!w) {
			// uscita dalla lista: dopo due minuti si smette di seguirla
			s.persaDal ??= Date.now();
			if (Date.now() - s.persaDal > 120_000) this.segui('');
			return;
		}
		s.persaDal = undefined;
		const f = this.fileDi(w.sessionId);
		const m = f ? await this.leggi(f, w.path).catch(() => undefined) : undefined;
		const reg = await this.registro(w.pid);
		let passo = '';
		if (reg?.waitingFor && /^approve /.test(reg.waitingFor)) passo = 'chiede un permesso';
		else if (w.status === 'ti aspetta') passo = 'aspetta te';
		else if (m?.lettura.ultimoStrumento) passo = passoBreve(m.lettura.ultimoStrumento.nome, m.lettura.ultimoStrumento.input, m.lettura.ultimoStrumento.inCorso);
		if (this.seguita !== s) return;
		if (passo !== s.passo || w.status !== s.stato || w.project !== s.progetto) {
			s.passo = passo;
			s.stato = w.status;
			s.progetto = w.project;
			this.d.cambiato?.();
		}
	}

	// ---------- riassumimelo ----------

	/** Melissa racconta la sessione a voce, in due frasi: lo stesso flusso di /v1/parla, con la scheda nella domanda
	 *  (cosi' parla proprio di questa sessione, anche se sullo stesso progetto ce n'e' piu' d'una). */
	private async riassunto(req: http.IncomingMessage, res: http.ServerResponse, chiave: string, aiuti: AiutiRotte): Promise<void> {
		const s = chiave ? await this.scheda(chiave) : undefined;
		if (!s) throw errore(404, 'Questa sessione non c\'e\' piu\'.');
		if (aiuti.occupata()) throw errore(409, 'Melissa sta gia\' rispondendo: riprova tra un attimo.');
		if (req.socket.destroyed) return;
		const testo = testoRiassunto(s);
		this.d.log(`sessioni: riassunto a voce di ${s.progetto} per l'iPhone`);
		res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
		res.socket?.setNoDelay(true);
		const riga = (o: unknown) => {
			if (!res.writableEnded) res.write(JSON.stringify(o) + '\n');
		};
		const ac = new AbortController();
		res.on('close', () => {
			if (!res.writableFinished) ac.abort();
		});
		try {
			const risposta = await aiuti.parla(testo, riga as (r: RigaParla) => void, ac.signal);
			riga({ tipo: 'fine', risposta });
		} catch (e: any) {
			riga({ tipo: 'errore', errore: e?.status ? e.message : 'Sul Mac qualcosa non e\' andato.' });
			this.d.log(`sessioni: riassunto: ${e?.message ?? e}`);
		}
		res.end();
	}
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const piatto = (s: string | undefined, n: number) => clip(String(s ?? '').replace(/\s+/g, ' ').trim(), n);

/** La domanda per Melissa: cosa chiedere e la scheda in frasi brevi. Resta sotto i 2000 caratteri. */
export function testoRiassunto(s: Scheda, ora = Date.now()): string {
	const min = Math.round((ora - (s.ultimo ?? s.da)) / 60_000);
	const quando = min < 2 ? 'adesso' : min < 60 ? `${min} minuti fa` : `${Math.round(min / 60)} ore fa`;
	const righe = [
		`Riassumimi a voce, in due frasi al massimo, la sessione di Claude Code su ${s.progetto}. Non usare strumenti: la scheda e' questa.`,
		`Stato: ${s.stato}, ultimo movimento ${quando}${s.origine === 'altrove' ? ', aperta fuori dalla Bottega' : ''}.`,
	];
	if (s.richiesta) righe.push(`Ultima richiesta di Andrea: «${piatto(s.richiesta, 300)}»`);
	if (s.passi.length) righe.push(`Ultimi passi: ${s.passi.slice(-6).map(p => p.testo).join('; ')}.`);
	if (s.risposta) righe.push(`Ultima risposta di Claude: «${piatto(s.risposta, 500)}»`);
	if (s.domanda) righe.push(`Adesso aspetta Andrea: ${piatto(s.domanda.testo, 200)}${s.domanda.comando ? ` (${piatto(s.domanda.comando, 120)})` : ''}.`);
	return clip(righe.join('\n'), 1900);
}

/** Le righe di un file nuovo (fino a 1 MB); undefined se e' binario o troppo grande. */
async function contaRighe(f: string): Promise<number | undefined> {
	try {
		const st = await fs.promises.lstat(f);
		if (!st.isFile() || st.size > 1 << 20) return undefined;
		const b = await fs.promises.readFile(f);
		if (b.subarray(0, 8000).includes(0)) return undefined;
		let n = 0;
		for (const c of b) if (c === 10) n++;
		return b.length && b[b.length - 1] !== 10 ? n + 1 : n;
	} catch {
		return undefined;
	}
}

/** git senza shell, senza lucchetti e senza programmi esterni; l'uscita si ferma a `limite` byte. */
export function eseguiGit(bin: string, args: string[], cwd: string, limite: number, timeout = 10_000): Promise<{ out: string; troncato: boolean; codice: number | null }> {
	return new Promise(resolve => {
		const tutti = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args];
		const p = spawn(bin, tutti, {
			cwd,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', LC_ALL: 'C' },
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		const parti: Buffer[] = [];
		let n = 0;
		let troncato = false;
		const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
		p.stdout.on('data', (c: Buffer) => {
			if (troncato) return;
			if (n + c.length > limite) {
				parti.push(c.subarray(0, limite - n));
				n = limite;
				troncato = true;
				p.kill('SIGKILL');
				return;
			}
			parti.push(c);
			n += c.length;
		});
		const fine = (codice: number | null) => {
			clearTimeout(timer);
			let out = Buffer.concat(parti).toString('utf8');
			if (troncato) out = out.slice(0, out.lastIndexOf('\n') + 1);
			resolve({ out, troncato, codice: troncato ? 0 : codice });
		};
		p.on('error', () => fine(-1));
		p.on('close', fine);
	});
}
