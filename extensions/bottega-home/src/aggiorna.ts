/* Gli aggiornamenti della Bottega. Contratto: docs/CONTRATTI.md, sezione 10.

   - VS Code sotto la Bottega si ricompila solo quando serve: quando l'ultima versione di Claude Code su Open VSX chiede
     un VS Code piu' nuovo di quello installato. Un controllo al giorno; se serve, una notifica con «Aggiorna» e «Dopo».
     «Aggiorna» lancia scripts/aggiorna-vscode.sh staccato dalla Bottega (alla fine la Bottega si chiude e si riapre),
     che scrive l'esito in ~/.bottega/aggiornamento.json: la Bottega lo legge e lo dice con un'altra notifica.
   - L'estensione Claude Code si aggiorna da sola: un controllo ogni ora su Open VSX e, se c'e' una versione nuova, la
     si installa sopra la vecchia. Quella vecchia resta in uso fino al prossimo riavvio delle estensioni, cosi' le
     sessioni aperte non cadono.

   Niente `vscode` qui dentro: chi lo usa passa le dipendenze, e i test girano in Node con una rete finta. */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

const OPENVSX_CLAUDE = 'https://open-vsx.org/api/anthropic/claude-code/darwin-arm64/latest';
const VSCODE_ULTIMA = 'https://api.github.com/repos/microsoft/vscode/releases/latest';
const ORA = 60 * 60 * 1000;
const GIORNO = 24 * ORA;
/** Dopo «Dopo» la stessa versione non si ripropone per tre giorni. */
const PAUSA_DOPO = 3 * GIORNO;

/** "1.140.0", "^1.94.0", ">=1.94.0", "1.94.x" -> [1, 140, 0]; null se non c'e' una versione. */
export function versione(s: string): number[] | null {
	const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(s || ''));
	return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

/** <0 se a e' piu' vecchia di b, 0 se uguali, >0 se piu' nuova. Una versione illeggibile vale come la piu' vecchia. */
export function confronta(a: string, b: string): number {
	const x = versione(a) || [0, 0, 0];
	const y = versione(b) || [0, 0, 0];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
}

export interface Verdetto {
	/** Va ricompilata: Claude Code chiede piu' di quello che c'e'. */
	serve: boolean;
	/** VS Code installato sotto la Bottega. */
	installato: string;
	/** Il minimo che chiede l'ultima versione di Claude Code ('' se Open VSX non lo dice). */
	minimo: string;
	/** L'ultima versione di Claude Code su Open VSX. */
	claude: string;
	/** La versione di VS Code a cui salire (l'ultima pubblicata, se basta); '' se non serve o non c'e'. */
	bersaglio: string;
}

async function leggi(fetchFn: Fetch, url: string): Promise<any> {
	const r = await fetchFn(url, { headers: { accept: 'application/json', 'user-agent': 'Bottega' } });
	if (!r.ok) throw new Error(`${new URL(url).host} ha risposto ${r.status}`);
	return r.json();
}

/** Serve ricompilare? Chiede a Open VSX l'ultima Claude Code e, solo se serve, a GitHub l'ultima VS Code. */
export async function controllaVSCode(installato: string, fetchFn: Fetch): Promise<Verdetto> {
	const j = await leggi(fetchFn, OPENVSX_CLAUDE);
	const claude = typeof j?.version === 'string' ? j.version : '';
	const v = versione(j?.engines?.vscode ?? '');
	const minimo = v ? v.join('.') : '';
	if (!minimo || confronta(installato, minimo) >= 0) return { serve: false, installato, minimo, claude, bersaglio: '' };
	const g = await leggi(fetchFn, VSCODE_ULTIMA);
	const tag = String(g?.tag_name ?? '');
	const bersaglio = /^\d+\.\d+\.\d+$/.test(tag) && confronta(tag, minimo) >= 0 ? tag : '';
	return { serve: true, installato, minimo, claude, bersaglio };
}

/** L'esito dello script, in ~/.bottega/aggiornamento.json. */
export interface Esito {
	stato: 'in corso' | 'fatto' | 'fallito';
	tag: string;
	build?: number;
	motivo?: string;
	push?: boolean;
	at: number;
	annunciato?: boolean;
}

export function leggiEsito(file: string): Esito | null {
	try {
		const e = JSON.parse(fs.readFileSync(file, 'utf8'));
		return e && typeof e.stato === 'string' && typeof e.tag === 'string' ? e : null;
	} catch {
		return null;
	}
}

/** La frase della notifica per un esito finito; null se non c'e' niente da dire. */
export function fraseEsito(e: Esito): { title: string; body: string } | null {
	if (e.stato === 'fatto')
		return {
			title: `Bottega su VS Code ${e.tag}`,
			body: `Aggiornata e installata${e.build ? `, build ${e.build}` : ''}.${e.push === false ? ' Il commit e\' fatto ma non spinto: va fatto il push.' : ''}`,
		};
	if (e.stato === 'fallito')
		return {
			title: `VS Code ${e.tag}: aggiornamento non riuscito`,
			body: `La Bottega resta com'era. ${e.motivo ? e.motivo : 'Il registro e\' in ~/.bottega/aggiornamento.log.'}`,
		};
	return null;
}

export interface Notifica {
	id: string;
	title: string;
	body: string;
	actions?: { id: string; title: string }[];
}

export interface AggiornaDeps {
	/** VS Code sotto la Bottega (vscode.version). */
	installato: string;
	/** La cartella dei sorgenti della Bottega (con bottega.json e scripts/), '' se non si trova. */
	sorgenti: string;
	fetchFn: Fetch;
	/** La versione di Claude Code installata, '' se manca. */
	claudeInstallato(): string;
	/** Installa quella versione di Claude Code sopra la vecchia. */
	installaClaude(versione: string): Promise<unknown>;
	notifica(n: Notifica): void;
	log(riga: string): void;
	/** Cosa ricordare fra un avvio e l'altro (globalState). */
	stato: { get<T>(k: string): T | undefined; update(k: string, v: unknown): unknown };
	/** File dell'esito e del registro (di solito in ~/.bottega). */
	fileEsito: string;
	fileLog: string;
	accesi(): { vscode: boolean; claude: boolean };
	now?(): number;
	/** Il clic sul corpo della notifica: una domanda nella Bottega prima di partire. */
	chiedi(tag: string): Promise<boolean>;
	/** Lancia lo script staccato dalla Bottega; nei test si sostituisce. */
	lancia?(script: string, tag: string, log: string): void;
}

export class Aggiornamenti {
	private timers: NodeJS.Timeout[] = [];
	private sorveglia?: NodeJS.Timeout;
	private ultimo?: Verdetto;
	private now: () => number;

	constructor(private readonly d: AggiornaDeps) {
		this.now = d.now ?? Date.now;
	}

	/** Avvio: prima l'esito di un aggiornamento appena finito, poi i controlli, lontano dai primi secondi della finestra. */
	start(): void {
		this.annunciaEsito();
		this.timers.push(setTimeout(() => void this.controllaClaude(), 90_000));
		this.timers.push(setInterval(() => void this.controllaClaude(), ORA));
		this.timers.push(setTimeout(() => void this.controllaVSCode(false), 120_000));
		this.timers.push(setInterval(() => void this.controllaVSCode(false), 6 * ORA));
	}

	dispose(): void {
		for (const t of this.timers) clearTimeout(t);
		this.timers = [];
		if (this.sorveglia) clearInterval(this.sorveglia);
	}

	/** Claude Code: se Open VSX ha una versione piu' nuova di quella installata, la installa. */
	async controllaClaude(): Promise<string> {
		if (!this.d.accesi().claude) return '';
		const ora = this.d.claudeInstallato();
		if (!ora) return '';
		try {
			const j = await leggi(this.d.fetchFn, OPENVSX_CLAUDE);
			const nuova = typeof j?.version === 'string' ? j.version : '';
			const motore = j?.engines?.vscode ?? '';
			if (!nuova || confronta(nuova, ora) <= 0) return '';
			// una versione che chiede un VS Code piu' nuovo non si installa: lo dice il controllo di VS Code
			if (motore && confronta(this.d.installato, motore) < 0) return '';
			this.d.log(`Claude Code ${ora} -> ${nuova}: la installo, parte al prossimo riavvio delle estensioni.`);
			await this.d.installaClaude(nuova);
			return nuova;
		} catch (e: any) {
			this.d.log(`Claude Code: controllo non riuscito, ${e?.message ?? e}`);
			return '';
		}
	}

	/** VS Code: un controllo al giorno (o subito, `forza`); se serve, la notifica con «Aggiorna». */
	async controllaVSCode(forza: boolean): Promise<Verdetto | null> {
		if (!forza && !this.d.accesi().vscode) return null;
		const fatto = this.d.stato.get<number>('aggiorna.controllo') ?? 0;
		if (!forza && this.now() - fatto < 20 * ORA) return this.ultimo ?? null;
		let v: Verdetto;
		try {
			v = await controllaVSCode(this.d.installato, this.d.fetchFn);
		} catch (e: any) {
			this.d.log(`VS Code: controllo non riuscito, ${e?.message ?? e}`);
			return null;
		}
		await this.d.stato.update('aggiorna.controllo', this.now());
		this.ultimo = v;
		this.d.log(`VS Code ${v.installato}; Claude Code ${v.claude || '?'} chiede ${v.minimo || '?'}: ${v.serve ? `va ricompilata (${v.bersaglio || 'nessuna versione pubblicata basta'})` : 'niente da fare'}.`);
		if (!v.serve || !v.bersaglio) return v;
		const rinviata = this.d.stato.get<{ tag: string; at: number }>('aggiorna.dopo');
		if (!forza && rinviata && rinviata.tag === v.bersaglio && this.now() - rinviata.at < PAUSA_DOPO) return v;
		if (this.inCorso()) return v;
		this.d.notifica({
			id: `aggiorna:${v.bersaglio}`,
			title: `Claude Code chiede VS Code ${v.minimo}`,
			body: `La Bottega e' su ${v.installato}: con «Aggiorna» la ricompilo su ${v.bersaglio} (da 30 a 60 minuti). Alla fine si chiude e si riapre da sola, salva i file.`,
			actions: [
				{ id: 'aggiorna', title: 'Aggiorna' },
				{ id: 'dopo', title: 'Dopo' },
			],
		});
		return v;
	}

	/** Il clic su una notifica `aggiorna:<tag>`: «Aggiorna» parte, «Dopo» rinvia, il corpo chiede prima (un clic per
	 *  sbaglio non deve far partire un'ora di compilazione). */
	async clic(id: string, azione: string | undefined): Promise<void> {
		const tag = id.startsWith('aggiorna:') ? id.slice('aggiorna:'.length) : '';
		if (!tag || azione === 'dismiss') return;
		if (azione === 'dopo') {
			await this.d.stato.update('aggiorna.dopo', { tag, at: this.now() });
			return;
		}
		if (azione === 'aggiorna' || (await this.d.chiedi(tag))) this.avvia(tag);
	}

	inCorso(): boolean {
		const e = leggiEsito(this.d.fileEsito);
		// un'esecuzione rimasta "in corso" da piu' di tre ore e' morta: non blocca piu'
		return !!e && e.stato === 'in corso' && this.now() - e.at < 3 * ORA;
	}

	/** Lancia scripts/aggiorna-vscode.sh staccato: sopravvive alla Bottega, che package.sh chiude e riapre. */
	avvia(tag: string): boolean {
		if (!/^\d+\.\d+\.\d+$/.test(tag)) return false;
		const script = this.d.sorgenti ? path.join(this.d.sorgenti, 'scripts', 'aggiorna-vscode.sh') : '';
		if (!script || !fs.existsSync(script)) {
			this.d.notifica({ id: `aggiorna-esito:${tag}`, title: 'Aggiornamento di VS Code', body: 'Non trovo i sorgenti della Bottega: imposta bottega.aggiornamenti.sorgenti.' });
			return false;
		}
		if (this.inCorso()) {
			this.d.notifica({ id: `aggiorna-esito:${tag}`, title: 'Aggiornamento di VS Code', body: "C'e' gia' un aggiornamento in corso." });
			return false;
		}
		this.d.log(`VS Code ${tag}: parte ${script}, registro in ${this.d.fileLog}.`);
		(this.d.lancia ?? lanciaStaccato)(script, tag, this.d.fileLog);
		this.d.notifica({ id: `aggiorna-esito:${tag}`, title: `Ricompilo la Bottega su VS Code ${tag}`, body: 'Ci vogliono da 30 a 60 minuti. Alla fine la Bottega si chiude e si riapre da sola.' });
		this.sorvegliaEsito();
		return true;
	}

	/** Un esito finito e non ancora detto: la notifica, una volta sola. Se e' in corso, lo si sorveglia. */
	annunciaEsito(): void {
		const e = leggiEsito(this.d.fileEsito);
		if (!e) return;
		if (e.stato === 'in corso') return this.sorvegliaEsito();
		if (e.annunciato) return;
		const f = fraseEsito(e);
		if (f) this.d.notifica({ id: `aggiorna-esito:${e.tag}`, ...f });
		try {
			fs.writeFileSync(this.d.fileEsito, JSON.stringify({ ...e, annunciato: true }, null, 2));
		} catch {}
	}

	/** Mentre lo script lavora: un'occhiata al file ogni 30 secondi, finche' non finisce. */
	private sorvegliaEsito(): void {
		if (this.sorveglia) return;
		this.sorveglia = setInterval(() => {
			const e = leggiEsito(this.d.fileEsito);
			if (e && e.stato === 'in corso') return;
			clearInterval(this.sorveglia);
			this.sorveglia = undefined;
			this.annunciaEsito();
		}, 30_000);
	}
}

/** Lo script parte in una sessione sua, con l'uscita nel registro: chiudere la Bottega non lo ferma. */
function lanciaStaccato(script: string, tag: string, log: string): void {
	const fd = fs.openSync(log, 'a');
	const p = spawn('/bin/zsh', [script, tag], { detached: true, stdio: ['ignore', fd, fd], cwd: path.dirname(path.dirname(script)) });
	p.unref();
	fs.closeSync(fd);
}

/** Dove sono i sorgenti: product.json (lo scrive scripts/package.sh), poi l'impostazione, poi ~/Prototipi/Bottega. */
export function trovaSorgenti(appRoot: string, impostazione: string, home: string): string {
	const prove: string[] = [];
	try {
		const p = JSON.parse(fs.readFileSync(path.join(appRoot, 'product.json'), 'utf8'));
		if (typeof p?.bottegaSorgenti === 'string') prove.push(p.bottegaSorgenti);
	} catch {}
	if (impostazione) prove.push(impostazione.replace(/^~(?=$|\/)/, home));
	prove.push(path.join(home, 'Prototipi', 'Bottega'));
	return prove.find(c => fs.existsSync(path.join(c, 'bottega.json')) && fs.existsSync(path.join(c, 'scripts', 'build.sh'))) ?? '';
}
