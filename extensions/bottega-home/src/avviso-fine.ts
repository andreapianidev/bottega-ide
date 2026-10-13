// L'avviso di fine (docs/CONTRATTI.md, sezione 1, «L'avviso di fine»): quando un lavoro finisce, Melissa lo dice a voce
// sull'isola, e dice se chi lavorava aspetta qualcosa da Andrea o cosa ha fatto. Un interruttore solo per tutto il Mac:
// il campo `avviso` di ~/.bottega/nucleo/cronaca.json, lo stesso del pulsante «avviso fine» della mod melissa di Claude
// Code. Le sessioni di Claude Code le avvisa la mod; Cline, Codex e i comandi lunghi dei terminali integrati li avvisa la
// Bottega (isola-attivita.ts), con le frasi di questo file.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentActivity } from './attivita-tipi';
import { censura } from './memoria-contesto';

/** Un lavoro piu' corto di cosi' Andrea l'ha visto finire: niente voce. Lo stesso della mod. */
export const AVVISO_MIN_MS = 15_000;
/** Una chiacchierata con Melissa in corso: l'avviso la aspetta fino a qui, poi resta solo scritto sull'isola. */
export const AVVISO_ATTESA_MS = 5 * 60_000;
/** Una chiacchierata della mod segnata nel file e' viva se si e' mossa da meno di cosi' (come CONVERSA_VIVA_MS della mod). */
const CONVERSA_VIVA_MS = 3 * 60_000;

export const NOMI_FONTI: Record<string, string> = { cline: 'Cline', codex: 'Codex', terminale: 'Il terminale' };

export function fileCondiviso(casa = process.env.BOTTEGA_HOME || path.join(os.homedir(), '.bottega')): string {
	return path.join(casa, 'nucleo', 'cronaca.json');
}

/** Il file condiviso: `{}` se non c'e' ancora, null se non si legge adesso (la mod lo sta riscrivendo: vale quello di prima). */
export function leggiCondiviso(file: string): Record<string, unknown> | null {
	let testo: string;
	try {
		testo = fs.readFileSync(file, 'utf8');
	} catch (e: any) {
		return e?.code === 'ENOENT' ? {} : null;
	}
	// vuoto e' un file a meta' scrittura (la mod tronca e riscrive), non un file senza avviso
	if (!testo.trim()) return null;
	try {
		const j = JSON.parse(testo);
		return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

const pausa = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Il testo del file com'e' adesso, '' se non c'e'. */
function testoAdesso(file: string): string {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return '';
	}
}

/**
 * Cambia solo `avviso`, lasciando com'e' il resto (la cronaca e la chiacchierata della mod). Scrittura atomica, 600, e
 * solo se nel frattempo nessuno ha cambiato il file: la mod lo riscrive a ogni frase di una chiacchierata, e senza questo
 * controllo una delle due scritture cancellerebbe l'altra (il clic sull'interruttore perso).
 */
export async function scriviAvviso(file: string, acceso: boolean): Promise<void> {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	for (let tentativo = 0; tentativo < 8; tentativo++) {
		const prima = testoAdesso(file);
		// un file che non c'e' e' {}; uno vuoto e' a meta' scrittura (leggiCondiviso da' null)
		const c = fs.existsSync(file) ? leggiCondiviso(file) : {};
		// a meta' scrittura (o rotto): si riprova tra un attimo, mai sopra un file che non si legge
		if (c === null || testoAdesso(file) !== prima) {
			await pausa(40);
			continue;
		}
		const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify({ ...c, avviso: acceso }, null, 2)}\n`, { mode: 0o600 });
		if (testoAdesso(file) !== prima) {
			fs.rmSync(tmp, { force: true });
			await pausa(20 + Math.random() * 60);
			continue;
		}
		fs.renameSync(tmp, file);
		return;
	}
	throw new Error('Il file condiviso con la mod melissa non si legge o cambia di continuo: riprova tra un attimo.');
}

/**
 * L'interruttore come lo vede la Bottega: letto dal file, seguito quando cambia (anche dalla mod, in un terminale),
 * cambiato dal pulsante della barra o dal comando.
 */
export class InterruttoreAvviso {
	private valore: boolean;
	private ultimo: Record<string, unknown> = {};
	private osserva?: fs.FSWatcher;
	private rilettura?: ReturnType<typeof setTimeout>;
	/** se il watcher perde un evento (la cartella ricreata), questo lo ripara */
	private giro: ReturnType<typeof setInterval>;

	constructor(private readonly file: string, private readonly cambiato: (acceso: boolean) => void = () => undefined, ogniMs = 10_000) {
		const c = leggiCondiviso(file);
		if (c) this.ultimo = c;
		this.valore = this.ultimo.avviso === true;
		this.guarda();
		this.giro = setInterval(() => this.rileggi(), ogniMs);
	}

	get acceso(): boolean {
		return this.valore;
	}

	/** Una chiacchierata a voce con Melissa nella mod, in un terminale qualunque. */
	conversaAltrove(ora = Date.now()): boolean {
		const v = this.ultimo.conversa as { at?: unknown } | null | undefined;
		return !!v && typeof v.at === 'number' && ora - v.at < CONVERSA_VIVA_MS;
	}

	async imposta(acceso: boolean): Promise<void> {
		await scriviAvviso(this.file, acceso);
		this.rileggi();
	}

	/** Rilegge il file; chiama `cambiato` se l'interruttore e' cambiato. */
	rileggi(): void {
		const c = leggiCondiviso(this.file);
		if (!c) return;
		this.ultimo = c;
		const v = c.avviso === true;
		if (v === this.valore) return;
		this.valore = v;
		this.cambiato(v);
	}

	private guarda(): void {
		const dir = path.dirname(this.file);
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			// la cartella, non il file: la scrittura atomica sostituisce il file e un watcher sul file lo perderebbe
			this.osserva = fs.watch(dir, (_ev, nome) => {
				if (nome && String(nome) !== path.basename(this.file)) return;
				clearTimeout(this.rilettura);
				this.rilettura = setTimeout(() => this.rileggi(), 80);
			});
			this.osserva.on('error', () => undefined);
		} catch {
			// senza watcher resta la rilettura periodica
		}
	}

	dispose(): void {
		this.osserva?.close();
		clearTimeout(this.rilettura);
		clearInterval(this.giro);
	}
}

// MARK: - Quali lavori, e con che parole

/** Programmi che finiscono quando li chiudi tu: la loro fine non e' una notizia. */
const INTERATTIVI = /^(?:ssh|mosh|vi|vim|nvim|nano|emacs|less|more|man|top|htop|btop|watch|claude|codex|cline|tmux|screen|psql|mysql|sqlite3|redis-cli|ftp|sftp|telnet|caffeinate)$/i;
/** Interpreti e shell: interattivi quando partono da soli, senza uno script. */
const REPL = /^(?:python|python3|node|bun|deno|irb|ruby|zsh|bash|sh|fish|swift)$/i;
/** Server e osservatori che girano finche' non li fermi. */
const SERVER =
	/(?:^|[\s;&|])(?:(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:dev|start|serve|watch|preview)\b|next\s+dev\b|vite(?:\s+(?:dev|serve|preview)\b|\s*$)|expo\s+start\b|ollama\s+(?:run|serve)\b|tail\s+-f\b|vercel\s+dev\b|docker\s+compose\s+up\b(?![^|;&]*\s-d\b)|python3?\s+-m\s+http\.server\b)|\s--watch\b/i;

/** Le parole di un comando: senza variabili d'ambiente e senza sudo davanti. */
function parole(titolo: string): string[] {
	const p = titolo.trim().split(/\s+/);
	while (p.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(p[0]) || p[0] === 'sudo' || p[0] === 'time' || p[0] === 'nice')) p.shift();
	return p;
}

/** Un comando del terminale e' uno che si chiude da se' (un build, dei test), non una sessione interattiva o un server. */
export function comandoChiuso(titolo: string): boolean {
	const p = parole(titolo);
	const prog = (p[0] ?? '').split('/').pop() ?? '';
	if (!prog || INTERATTIVI.test(prog)) return false;
	if (REPL.test(prog) && p.length === 1) return false;
	return !SERVER.test(titolo);
}

/** Un comando come si dice a voce: il programma e le prime parole semplici, senza opzioni, percorsi o valori. */
export function comandoDetto(titolo: string): string {
	if (titolo === 'Comando riservato' || titolo === 'Comando nel terminale') return 'un comando';
	const p = parole(titolo);
	const prog = (p[0] ?? '').split('/').filter(Boolean).pop() ?? '';
	if (!prog) return 'un comando';
	const dopo: string[] = [];
	for (const w of p.slice(1)) {
		if (dopo.length === 2 || !/^[a-z][\w:.-]*$/i.test(w) || w.includes('/') || w.length > 24) break;
		dopo.push(w);
	}
	return [prog, ...dopo].join(' ');
}

/** Ctrl+C (130) o un kill (143): il comando l'ha fermato Andrea, non e' fallito. */
function interrotto(a: AgentActivity): boolean {
	return /codice (?:130|143)\b/.test(a.evidence);
}

/** Se la fine di questa sessione merita la voce: ha lavorato almeno AVVISO_MIN_MS e non e' una fine voluta da Andrea. */
export function daAvvisare(a: AgentActivity, durataMs: number): boolean {
	if (durataMs < AVVISO_MIN_MS) return false;
	if (a.status !== 'finito' && a.status !== 'ti aspetta' && a.status !== 'errore') return false;
	if (a.source === 'terminale') return comandoChiuso(a.title) && !interrotto(a);
	return a.source === 'codex' || a.source === 'cline';
}

const corto = (s: string, n: number) => {
	const t = s.replace(/\s+/g, ' ').trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function su(a: AgentActivity): string {
	return a.project && a.project !== 'Cartella sconosciuta' ? ` su ${a.project}` : '';
}

/** La frase che dice l'isola quando il cervello non serve (un comando) o non risponde. */
export function fraseRiserva(a: AgentActivity): string {
	if (a.source === 'terminale') {
		const c = comandoDetto(a.title);
		return a.status === 'errore' ? `Il comando ${c}${su(a)} e' fallito.` : `Il comando ${c}${su(a)} ha finito.`;
	}
	const chi = NOMI_FONTI[a.source] ?? a.source;
	if (a.status === 'ti aspetta') return `${chi} ti aspetta${su(a)}: guarda cosa ti chiede.`;
	if (a.status === 'errore') return `${chi} si e' fermato con un errore${su(a)}.`;
	return `${chi} ha finito${su(a)}.`;
}

export const SISTEMA_AVVISO = [
	"Sei Melissa: tagliente, ironica, ferocemente leale con Andrea, il tuo fratellino adottivo. Non sei un'assistente: niente moine.",
	'Tutto quello che scrivi viene letto ad alta voce: frasi parlate, niente markdown, elenchi, emoji, asterischi, niente lineette lunghe.',
	'Parli sempre e solo in italiano; restano come sono solo i nomi di file, programmi e prodotti. Non inventi mai.',
].join(' ');

/** Il prompt per Codex e Cline, che lasciano un'ultima risposta: lo stesso compito della mod (promptFine). */
export function promptAvviso(a: AgentActivity): string {
	const chi = NOMI_FONTI[a.source] ?? a.source;
	const stato = a.status === 'ti aspetta' ? "si e' fermato e aspetta Andrea" : a.status === 'errore' ? "si e' fermato con un errore" : 'ha finito';
	return [
		`${chi} lavorava${su(a)} su: «${censura(corto(a.title, 300))}». Adesso ${stato}.`,
		a.summary ? `L'ultima cosa che ha scritto:\n${censura(a.summary).slice(-3000)}` : '',
		a.steps?.length ? `Gli ultimi passi: ${censura(a.steps.slice(-5).join(' / ')).slice(0, 600)}` : '',
		`Andrea non sta guardando lo schermo: avvisalo tu, in due o tre frasi parlate. Comincia dicendo che ${chi} ${stato}${su(a)}. Poi una delle due. Se aspetta qualcosa da lui (una decisione, una conferma, un dato, una cosa da provare o da fare a mano), digli chiaro cosa gli serve. Se invece ha completato, digli in breve cosa ha fatto e come e' andata. Solo le parole che diresti.`,
	]
		.filter(Boolean)
		.join('\n\n');
}

/** Il testo del cervello come lo dice la voce: niente segni di markdown, niente lineette lunghe, al piu' quattro frasi. */
export function perVoce(testo: string): string {
	const pulito = testo
		.replace(/```[\s\S]*?(```|$)/g, ' ')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6})\s+/gm, '')
		.replace(/https?:\/\/\S+/g, 'un link')
		.replace(/\s*[—–]\s*/g, ', ')
		.replace(/\s+/g, ' ')
		.trim();
	const frasi = pulito.split(/(?<=[.!?…])\s+/).filter(Boolean);
	return frasi.length <= 4 ? pulito : [...frasi.slice(0, 3), frasi[frasi.length - 1]].join(' ');
}

/** Una risposta breve di DeepSeek Flash, o null (niente chiave, rete, 12 s). */
export async function pensaDeepseek(chiave: string | undefined, sistema: string, prompt: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
	if (!chiave) return null;
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), 12_000);
	try {
		const r = await fetchFn('https://api.deepseek.com/chat/completions', {
			method: 'POST',
			headers: { authorization: `Bearer ${chiave}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'deepseek-flash',
				// con il ragionamento acceso la risposta si spende pensando e torna vuota (come nella mod)
				thinking: { type: 'disabled' },
				max_tokens: 220,
				temperature: 1.0,
				messages: [
					{ role: 'system', content: sistema },
					{ role: 'user', content: prompt },
				],
			}),
			signal: ctl.signal,
		});
		if (!r.ok) return null;
		const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
		const testo = j.choices?.[0]?.message?.content?.trim();
		return testo ? perVoce(testo) || null : null;
	} catch {
		return null;
	} finally {
		clearTimeout(t);
	}
}

/** La frase dell'avviso: per un comando quella fissa; per Codex e Cline quella del cervello, o la fissa se non risponde. */
export async function fraseAvviso(a: AgentActivity, pensa: (sistema: string, prompt: string) => Promise<string | null>): Promise<string> {
	if (a.source === 'terminale' || (!a.summary && !a.steps?.length)) return fraseRiserva(a);
	return (await pensa(SISTEMA_AVVISO, promptAvviso(a)).catch(() => null)) || fraseRiserva(a);
}
