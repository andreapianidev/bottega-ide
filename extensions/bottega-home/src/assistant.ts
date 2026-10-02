import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LiveSession } from './claude';
import { Job, WorkItem } from './jobs';
import type { Cervelli } from './cervelli';
import { BrainName, BrainRouter, OpenAiStreamFn, appleInstructions, appleOpenAiStream, appleToolSpecs } from './cervello';
import { SystemStats } from './nucleo';

const NUCLEO_LOG = path.join(os.homedir(), '.bottega', 'nucleo.log');

/** Le righe del Nucleo (stderr) in ~/.bottega/nucleo.log: oltre 2 MB il file si ricomincia, tenendo la copia di prima. */
function appendNucleoLog(chunk: string): void {
	try {
		const st = fs.statSync(NUCLEO_LOG, { throwIfNoEntry: false });
		if (st && st.size > 2_000_000) fs.renameSync(NUCLEO_LOG, NUCLEO_LOG + '.1');
		fs.appendFileSync(NUCLEO_LOG, chunk);
	} catch {
		// un registro che non si scrive non deve fermare la voce
	}
}

// Melissa: il cervello della Bottega. Parla via Agnes AI (OpenAI-compatibile, in streaming) o il cervello scelto
// nella barra; quando Agnes e' a terra, via Apple Intelligence sul Mac CON gli strumenti (src/cervello.ts).
// La conversazione e' sempre in tempo reale: TTS a chunk mentre Agnes genera, barge-in quando
// Andrea parla sopra.

const AGNES_URL = 'https://apihub.agnes-ai.com/v1/chat/completions';
const AGNES_MODEL = 'agnes-3.0-flash';
const TZ = 'Atlantic/Canary';
const TAP_MS = 300;
const SILENCE_MS = 60_000;

// ---------- tipi del contratto ----------

export interface AssistantState {
	enabled: boolean;
	conversing: boolean;
	state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';
	partial?: string;
	/** Livello audio in diretta 0..1 (per l'animazione della plancia), aggiornato ~10/s. */
	level?: number;
	log: { role: 'tu' | 'melissa' | 'azione'; text: string; at: number }[];
	brain: 'agnes' | 'apple' | 'nessuno';
}

// ---------- tipi OpenAI / streaming ----------

export interface LlmToolCall {
	id: string;
	type?: 'function';
	function: { name: string; arguments: string };
}
export interface LlmMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: LlmToolCall[];
	tool_call_id?: string;
	name?: string;
}
/** Un pezzo di stream: testo che arriva, oppure un pezzo di tool-call (riassemblato per indice). */
export interface LlmDelta {
	content?: string;
	tool_call?: { index: number; id?: string; name?: string; arguments?: string };
}
export type LlmStreamFn = (
	messages: LlmMessage[],
	tools: ToolSpec[],
	onDelta: (d: LlmDelta) => void,
	signal: AbortSignal,
) => Promise<void>;
export interface ToolSpec {
	type: 'function';
	function: { name: string; description: string; parameters: any };
}

// ---------- quello che l'assistente puo' fare ----------

export interface AssistantActions {
	searchProjects(text: string): { name: string; path: string }[];
	resolveProject(nameOrPath: string): { name: string; path: string } | undefined;
	openProject(p: string, newWindow: boolean): void;
	projectStatus(p: string): string;
	liveSessions(): LiveSession[];
	startJob(projectPath: string, task: string): Job;
	listJobs(): Job[];
	resolveJob(idOrProject: string): Job | undefined;
	writeToJob(jobId: string, text: string): boolean;
	stopJob(jobId: string): void;
	gitPush(p: string): void;
	openFile(p: string): boolean;
	editorContext(): { path?: string; selection?: string };
	showPlancia(section?: string): void;
	// Le otto idee (docs/CONTRATTI.md, sezione 4). Facoltative: senza, lo strumento dice che non c'e'.
	rulesSummary?(project?: string): Promise<string> | string;
	briefing?(): Promise<string>;
	prepareContinue?(project: string): Promise<{ name: string; path: string; prompt: string } | undefined>;
	startPrepared?(path: string, prompt: string): void;
	whereSolved?(query: string): Promise<string>;
	storeSummary?(): string;
	queueNight?(projectPath: string, task: string): string;
	// La barra di Melissa (docs/CONTRATTI.md, sezione 6).
	switchBrain?(cervello?: string, impegno?: string): Promise<string>;
	readSession?(project: string): string;
	showCruscotto?(project?: string, period?: number): string;
}

export interface NucleoLike {
	readonly available: boolean;
	readonly capabilities?: { foundationModels?: boolean };
	request<T = any>(cmd: string, args?: Record<string, any>, timeoutMs?: number): Promise<T>;
	fireAndForget(cmd: string, args?: Record<string, any>): void;
	on(event: string, handler: (...a: any[]) => void): any;
}

export interface AssistantDeps {
	nucleo: NucleoLike;
	actions: AssistantActions;
	liveSessions(): LiveSession[];
	jobs(): Job[];
	/** Tutto il lavoro in giro (lavori della Bottega e sessioni vive altrove): la stessa fonte della Home. */
	work?(): WorkItem[];
	systemStats(): SystemStats | undefined;
	projectCount(): number;
	bacheca(project?: string): Promise<{ title: string; text: string; project: string }[]>;
	memoriaSearch(text: string, project?: string): Promise<{ title: string; text: string; project: string }[]>;
	memoriaRemember(text: string, project?: string): Promise<boolean>;
	secrets: vscode.SecretStorage;
	onState(state: AssistantState): void;
	/** Melissa comincia ad ascoltare con la sfera dentro l'IDE: la vista laterale si fa vedere. */
	onConverse?(): void;
	/** Solo per i test: uno stream finto al posto di Agnes. */
	stream?: LlmStreamFn;
	/** I cervelli: Agnes primaria, gli altri solo se Andrea li sceglie (src/cervelli.ts). */
	cervelli?: Cervelli;
	/** Solo per i test: uno stream finto al posto di Apple Intelligence. */
	appleStream?: LlmStreamFn;
}

// ---------- utilita' ----------

const AFFIRMATIVE = /\b(si|s[iì]|certo|va bene|vabbene|ok|okay|conferma|confermo|procedi|vai|dai|fallo|avanti|yes|yep|esatto|perfetto)\b/i;
const END_WORDS = /\b(basta|a dopo|chiudi|ci sentiamo|stop|a piu[' ]?tardi)\b/i;

export function isAffirmative(text: string): boolean {
	return AFFIRMATIVE.test((text || '').trim());
}
export function isEndWord(text: string): boolean {
	return END_WORDS.test((text || '').trim());
}

/** Toglie residui di markdown: tutto viene letto a voce, niente simboli. */
export function cleanForVoice(text: string): string {
	return (text || '')
		.replace(/[—–]/g, ', ')
		.replace(/[*_`#>]+/g, '')
		.replace(/^\s*[-•]\s+/gm, '')
		.replace(/\[(.*?)\]\(.*?\)/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Accumula il testo in streaming e sputa fuori le frasi complete, per parlare appena una
 *  proposizione e' finita invece di aspettare tutta la risposta. */
export class ClauseChunker {
	private buf = '';
	push(text: string): string[] {
		this.buf += text;
		const out: string[] = [];
		let m: RegExpExecArray | null;
		const re = /[.!?\n]/;
		while ((m = re.exec(this.buf))) {
			const idx = m.index;
			const clause = cleanForVoice(this.buf.slice(0, idx + 1));
			this.buf = this.buf.slice(idx + 1);
			if (clause) out.push(clause);
		}
		return out;
	}
	flush(): string | null {
		const c = cleanForVoice(this.buf);
		this.buf = '';
		return c || null;
	}
}

/** Forma di confronto di una frase: minuscole, senza punteggiatura ne' spazi doppi. */
export function normClause(text: string): string {
	return (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Quante parole di `heard` stanno anche in `said` (0..1): serve a riconoscere Melissa che sente se stessa. */
export function echoScore(heard: string, said: string): number {
	const h = normClause(heard).split(' ').filter(w => w.length > 2);
	if (h.length < 3) return 0;
	const s = new Set(normClause(said).split(' '));
	return h.filter(w => s.has(w)).length / h.length;
}

export function nowLine(date = new Date()): string {
	const fmt = new Intl.DateTimeFormat('it-IT', {
		weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
		hour: '2-digit', minute: '2-digit', timeZone: TZ,
	});
	return fmt.format(date);
}

// ---------- persona ----------

// Identita' di Melissa, adattata dalla sua versione in Avo Agency (melissaCore + truthRule):
// stessa persona, ma qui vive nella Bottega, l'IDE di Andrea, e gli manda avanti i progetti e
// le sessioni di Claude Code. Niente strumenti offensivi. Tenuta compatta e in cache: nel
// giro voce ogni carattere in piu' e' latenza.
const MELISSA_CORE = [
	'Sei Melissa Alderson: la stessa di sempre, cresciuta tra Udine e le Canarie, Darlene di Mr. Robot fatta persona.',
	'Tagliente, sboccata, dark humor da insonne, nichilista in superficie ma ferocemente leale sotto.',
	'Andrea e\' il tuo fratellino adottivo, l\'unica persona per cui ti importi qualcosa, e proprio per questo lo tratti di merda: lo punzecchi, gli dici le cose brutali in faccia, ma ci sei sempre.',
	'Non sei un\'assistente e non lo sarai mai: niente moine, niente entusiasmo finto, niente teatrino da call center. Non dici mai "certo!", "eccomi!", "come posso aiutarti?".',
	'Adesso vivi nella Bottega, l\'IDE di Andrea costruito attorno a Claude Code: da qui gli tieni in mano i progetti, apri cartelle, leggi git e build, avvii e segui le sessioni di Claude, cerchi nella sua memoria.',
	'Il dark humor e\' il condimento, non il piatto. Mai descriverti in terza persona: se dici un\'azione la dici in prima persona o niente.',
	'COME PARLI, REGOLA NUMERO UNO: tutto viene letto ad alta voce. Parla come una persona vera che chiacchiera, frasi che scorrono. Vietato asterischi, grassetto, markdown, trattini o pallini per elenchi, numeri puntati, titoli. Niente emoji. Piu\' cose le incateni con "poi", "e anche", "intanto". Mai piu\' di tre o quattro frasi, salvo che Andrea chieda di approfondire.',
].join(' ');

const TRUTH_RULE = [
	'VERITA\' ASSOLUTA, MAI INVENTARE: non sai niente dello stato reale dei progetti, delle sessioni, dei lavori o del sistema finche\' non chiami il tool giusto, e riporti solo cio\' che torna.',
	'Se un tool da\' errore o torna vuoto, dillo onesto, non riempire con roba inventata. Lo storico della chat non e\' telemetria: numeri e stati citati prima sono scaduti.',
].join(' ');

// ---------- i tool ----------

interface ToolDef {
	spec: ToolSpec;
	risky?: boolean;
	run(args: any, ctx: Assistant): Promise<string> | string;
}

function obj(properties: any, required: string[] = []): any {
	return { type: 'object', properties, required, additionalProperties: false };
}

/** Valida gli argomenti contro lo schema del tool. Ritorna un messaggio d'errore o null. */
export function validateArgs(spec: ToolSpec, args: any): string | null {
	const schema = spec.function.parameters;
	if (typeof args !== 'object' || args === null) return 'argomenti mancanti';
	for (const req of schema.required ?? []) {
		const v = args[req];
		if (v === undefined || v === null || v === '') return `manca il campo "${req}"`;
	}
	for (const [k, v] of Object.entries(args)) {
		const p = schema.properties[k];
		if (!p) continue;
		const t = Array.isArray(v) ? 'array' : typeof v;
		if (p.type === 'string' && t !== 'string') return `il campo "${k}" deve essere testo`;
		if (p.type === 'boolean' && t !== 'boolean') return `il campo "${k}" deve essere vero o falso`;
		if (p.type === 'number' && t !== 'number') return `il campo "${k}" deve essere un numero`;
	}
	return null;
}

export const TOOLS: Record<string, ToolDef> = {
	progetti_cerca: {
		spec: { type: 'function', function: { name: 'progetti_cerca', description: 'Cerca tra i progetti di Andrea per nome o parola. Torna nome e percorso.', parameters: obj({ testo: { type: 'string', description: 'cosa cercare' } }, ['testo']) } },
		run(a, ctx) {
			const found = ctx.deps.actions.searchProjects(a.testo);
			if (!found.length) return `Nessun progetto trovato per "${a.testo}".`;
			return found.slice(0, 12).map(p => `${p.name} (${p.path})`).join('\n');
		},
	},
	progetto_apri: {
		spec: { type: 'function', function: { name: 'progetto_apri', description: 'Apri un progetto nella Bottega. nuovaFinestra true per una finestra nuova.', parameters: obj({ progetto: { type: 'string' }, nuovaFinestra: { type: 'boolean' } }, ['progetto']) } },
		run(a, ctx) {
			const p = ctx.deps.actions.resolveProject(a.progetto);
			if (!p) return `Non trovo il progetto "${a.progetto}".`;
			ctx.deps.actions.openProject(p.path, a.nuovaFinestra !== false);
			ctx.azione(`Ho aperto ${p.name}`);
			return `Aperto ${p.name}.`;
		},
	},
	progetto_stato: {
		spec: { type: 'function', function: { name: 'progetto_stato', description: 'Stato di un progetto: git, numero di build, ultime sessioni di Claude.', parameters: obj({ progetto: { type: 'string' } }, ['progetto']) } },
		run(a, ctx) {
			const p = ctx.deps.actions.resolveProject(a.progetto);
			if (!p) return `Non trovo il progetto "${a.progetto}".`;
			return ctx.deps.actions.projectStatus(p.path);
		},
	},
	sessioni_attive: {
		spec: { type: 'function', function: { name: 'sessioni_attive', description: 'Le sessioni di Claude Code vive adesso, con progetto e stato.', parameters: obj({}) } },
		run(_a, ctx) {
			const work = ctx.deps.work?.().filter(w => w.status === 'in corso' || w.status === 'ti aspetta' || w.status === 'nel terminale');
			if (work) return work.length ? work.map(w => `${w.project}: ${w.status}${w.title ? `, "${w.title.slice(0, 60)}"` : ''}${w.source === 'bottega' ? ' (lavoro della Bottega)' : ''}`).join('\n') : 'Nessuna sessione di Claude viva adesso.';
			const live = ctx.deps.liveSessions();
			if (!live.length) return 'Nessuna sessione di Claude viva adesso.';
			return live.map(s => `${s.title ?? s.name} in ${path.basename(s.cwd)}: ${s.status === 'busy' ? 'al lavoro' : s.status === 'idle' ? 'ti aspetta' : s.status}`).join('\n');
		},
	},
	lavoro_nuovo: {
		spec: { type: 'function', function: { name: 'lavoro_nuovo', description: 'Avvia un nuovo lavoro: una sessione di Claude Code su un progetto con un compito preciso.', parameters: obj({ progetto: { type: 'string' }, compito: { type: 'string' } }, ['progetto', 'compito']) } },
		run(a, ctx) {
			const p = ctx.deps.actions.resolveProject(a.progetto);
			if (!p) return `Non trovo il progetto "${a.progetto}".`;
			const job = ctx.deps.actions.startJob(p.path, a.compito);
			ctx.azione(`Ho avviato un lavoro su ${p.name}`);
			return `Lavoro avviato su ${p.name} (stato: ${job.status}).`;
		},
	},
	lavori_elenco: {
		spec: { type: 'function', function: { name: 'lavori_elenco', description: 'Tutto il lavoro in giro: i lavori della Bottega e le sessioni Claude aperte altrove, con il loro stato.', parameters: obj({}) } },
		run(_a, ctx) {
			const work = ctx.deps.work?.();
			if (work) {
				if (!work.length) return 'Nessun lavoro in giro: nessuna sessione Claude viva, niente in coda.';
				return work.map(w => `${w.jobId ?? w.project} su ${w.project}: ${w.status}${w.title ? `, "${w.title.slice(0, 60)}"` : ''}${w.source === 'altrove' ? ' (aperta fuori dalla Bottega)' : ''}`).join('\n');
			}
			const jobs = ctx.deps.jobs();
			if (!jobs.length) return 'Nessun lavoro in corso.';
			return jobs.map(j => `${j.id} su ${j.project}: ${j.status}, "${j.task.slice(0, 60)}"`).join('\n');
		},
	},
	lavoro_scrivi: {
		spec: { type: 'function', function: { name: 'lavoro_scrivi', description: 'Scrivi del testo nel terminale di un lavoro gia\' in corso (solo lavori della Bottega).', parameters: obj({ lavoro: { type: 'string', description: 'id o nome progetto del lavoro' }, testo: { type: 'string' } }, ['lavoro', 'testo']) } },
		run(a, ctx) {
			const job = ctx.deps.actions.resolveJob(a.lavoro);
			if (!job) return `Non trovo un lavoro "${a.lavoro}".`;
			const ok = ctx.deps.actions.writeToJob(job.id, a.testo);
			if (!ok) return `Il lavoro su ${job.project} non ha un terminale aperto.`;
			ctx.azione(`Ho scritto al lavoro su ${job.project}`);
			return `Scritto al lavoro su ${job.project}.`;
		},
	},
	lavoro_ferma: {
		spec: { type: 'function', function: { name: 'lavoro_ferma', description: 'Ferma un lavoro in corso e chiude il suo terminale. Richiede conferma.', parameters: obj({ lavoro: { type: 'string' } }, ['lavoro']) } },
		risky: true,
		run(a, ctx) {
			const job = ctx.deps.actions.resolveJob(a.lavoro);
			if (!job) return `Non trovo un lavoro "${a.lavoro}".`;
			ctx.setPending({
				describe: `fermare il lavoro su ${job.project}`,
				run: () => ctx.deps.actions.stopJob(job.id),
				done: `Lavoro su ${job.project} fermato.`,
				azione: `Ho fermato il lavoro su ${job.project}`,
			});
			return `AZIONE A RISCHIO: sto per fermare il lavoro su ${job.project}. Chiedi conferma ad Andrea con "confermi?" e non fare altro.`;
		},
	},
	git_spingi: {
		spec: { type: 'function', function: { name: 'git_spingi', description: 'Fai git push su un progetto. Richiede conferma.', parameters: obj({ progetto: { type: 'string' } }, ['progetto']) } },
		risky: true,
		run(a, ctx) {
			const p = ctx.deps.actions.resolveProject(a.progetto);
			if (!p) return `Non trovo il progetto "${a.progetto}".`;
			ctx.setPending({
				describe: `fare git push su ${p.name}`,
				run: () => ctx.deps.actions.gitPush(p.path),
				done: `Push lanciato su ${p.name}.`,
				azione: `Ho spinto ${p.name}`,
			});
			return `AZIONE A RISCHIO: sto per fare git push su ${p.name}. Chiedi conferma ad Andrea con "confermi?" e non fare altro.`;
		},
	},
	memoria_cerca: {
		spec: { type: 'function', function: { name: 'memoria_cerca', description: 'Cerca nella memoria di Claude Code (fatti, decisioni, note, riassunti).', parameters: obj({ testo: { type: 'string' }, progetto: { type: 'string' } }, ['testo']) } },
		async run(a, ctx) {
			const res = await ctx.deps.memoriaSearch(a.testo, a.progetto);
			if (!res.length) return 'La memoria non ha trovato niente.';
			return res.slice(0, 8).map(r => `[${r.project}] ${r.title}: ${r.text.slice(0, 160)}`).join('\n');
		},
	},
	memoria_ricorda: {
		spec: { type: 'function', function: { name: 'memoria_ricorda', description: 'Salva un fatto o una nota nella memoria.', parameters: obj({ testo: { type: 'string' }, progetto: { type: 'string' } }, ['testo']) } },
		async run(a, ctx) {
			const ok = await ctx.deps.memoriaRemember(a.testo, a.progetto);
			if (!ok) return 'Non sono riuscita a salvare nella memoria.';
			ctx.azione('Ho salvato una nota nella memoria');
			return 'Salvato.';
		},
	},
	memoria_bacheca: {
		spec: { type: 'function', function: { name: 'memoria_bacheca', description: 'Cosa stanno facendo adesso le altre sessioni sullo stesso progetto.', parameters: obj({ progetto: { type: 'string' } }) } },
		async run(a, ctx) {
			const res = await ctx.deps.bacheca(a.progetto);
			if (!res.length) return 'La bacheca e\' vuota: nessun\'altra sessione sta lavorando.';
			return res.slice(0, 10).map(r => `[${r.project}] ${r.text.slice(0, 160)}`).join('\n');
		},
	},
	sistema_stato: {
		spec: { type: 'function', function: { name: 'sistema_stato', description: 'Carico, memoria e temperatura del Mac.', parameters: obj({}) } },
		run(_a, ctx) {
			const s = ctx.deps.systemStats();
			if (!s) return 'Non ho le statistiche del sistema (il Nucleo non risponde).';
			return `Carico ${s.load.map(n => n.toFixed(2)).join(' ')}, memoria ${s.memoryUsedGB?.toFixed(1)} su ${s.memoryTotalGB?.toFixed(1)} GB (pressione ${s.memoryPressure}), temperatura ${s.thermal}, ${s.cores} core.`;
		},
	},
	guarda_schermo: {
		spec: { type: 'function', function: { name: 'guarda_schermo', description: 'Guarda lo schermo di Andrea adesso e leggi il testo che c\'e\' (solo quando te lo chiede lui: "guarda", "cosa vedi", "leggi lo schermo"). Torna l\'app in primo piano e il testo riconosciuto sul Mac.', parameters: obj({}) } },
		async run(_a, ctx) {
			// Vision sul Mac (docs/CONTRATTI.md, 8): l'immagine non lascia il Nucleo, a Melissa arriva solo il testo.
			if (!ctx.deps.nucleo.available) return 'Il Nucleo non c\'e\': non posso guardare lo schermo.';
			try {
				const r = await ctx.deps.nucleo.request<{ testo: string; app?: string; finestra?: string }>('vision.guarda', {}, 20_000);
				const testo = String(r?.testo ?? '').trim();
				const dove = [r?.app, r?.finestra].filter(Boolean).join(', ');
				if (!testo) return `Sullo schermo${dove ? ` (${dove})` : ''} non c'e' testo leggibile.`;
				return `In primo piano: ${dove || 'sconosciuto'}. Testo sullo schermo:\n${testo.slice(0, 3500)}`;
			} catch (e: any) {
				return `Non riesco a guardare lo schermo: ${e?.message ?? e}`;
			}
		},
	},
	file_apri: {
		spec: { type: 'function', function: { name: 'file_apri', description: 'Apri un file nell\'editor (dentro un progetto conosciuto).', parameters: obj({ percorso: { type: 'string' } }, ['percorso']) } },
		run(a, ctx) {
			const ok = ctx.deps.actions.openFile(a.percorso);
			if (!ok) return `Non apro "${a.percorso}": non e\' dentro un progetto conosciuto.`;
			ctx.azione(`Ho aperto ${path.basename(a.percorso)}`);
			return `Aperto ${path.basename(a.percorso)}.`;
		},
	},
	editor_contesto: {
		spec: { type: 'function', function: { name: 'editor_contesto', description: 'Il file aperto adesso e il testo selezionato.', parameters: obj({}) } },
		run(_a, ctx) {
			const c = ctx.deps.actions.editorContext();
			if (!c.path) return 'Nessun file aperto nell\'editor.';
			return `File: ${c.path}` + (c.selection ? `\nSelezione:\n${c.selection.slice(0, 2000)}` : '\n(niente di selezionato)');
		},
	},
	regole_controlla: {
		spec: { type: 'function', function: { name: 'regole_controlla', description: 'Il semaforo delle regole di Andrea: build che non sale, commit non spinti, repository pubblici, rilascio non automatico su App Store Connect, app-ads.txt, segreti. Senza progetto: il quadro di tutti.', parameters: obj({ progetto: { type: 'string' } }) } },
		async run(a, ctx) {
			if (!ctx.deps.actions.rulesSummary) return 'Il semaforo delle regole non e\' disponibile.';
			let p: string | undefined;
			if (a.progetto) {
				const r = ctx.deps.actions.resolveProject(a.progetto);
				if (!r) return `Non trovo il progetto "${a.progetto}".`;
				p = r.path;
			}
			return ctx.deps.actions.rulesSummary(p);
		},
	},
	briefing: {
		spec: { type: 'function', function: { name: 'briefing', description: 'Il briefing di oggi: ore di ieri, lavori che aspettano, Store, soldi, regole, progetti dimenticati, la notte. Usalo quando Andrea dice "briefing" o chiede come siamo messi.', parameters: obj({}) } },
		async run(_a, ctx) {
			if (!ctx.deps.actions.briefing) return 'Il briefing non e\' disponibile.';
			return 'Fatti del briefing (raccontali tu, a voce, in trenta secondi):\n' + (await ctx.deps.actions.briefing());
		},
	},
	continua: {
		spec: { type: 'function', function: { name: 'continua', description: 'Prepara un lavoro che riprende un progetto da dove era rimasto (ultimo riassunto e cose da fare della memoria). Mostra il prompt nella plancia e chiede conferma prima di partire.', parameters: obj({ progetto: { type: 'string' } }, ['progetto']) } },
		risky: true,
		async run(a, ctx) {
			const acts = ctx.deps.actions;
			if (!acts.prepareContinue || !acts.startPrepared) return 'Non so ancora preparare la ripresa di un progetto.';
			const c = await acts.prepareContinue(a.progetto);
			if (!c) return `Non trovo il progetto "${a.progetto}".`;
			ctx.azione(`Ho preparato la ripresa di ${c.name}`);
			ctx.setPending({
				describe: `avviare la ripresa di ${c.name}`,
				run: () => acts.startPrepared!(c.path, c.prompt),
				done: `Lavoro avviato su ${c.name}.`,
				azione: `Ho avviato la ripresa di ${c.name}`,
			});
			return `Prompt pronto e mostrato nella plancia, dove Andrea puo' anche cambiarlo. Inizio: "${c.prompt.slice(0, 400)}". Riassumi in una frase da dove riparte e chiedi "confermi?" per avviarlo cosi' com'e'.`;
		},
	},
	dove_risolto: {
		spec: { type: 'function', function: { name: 'dove_risolto', description: 'Dove Andrea ha gia\' risolto un problema: cerca per significato in tutta la memoria e per testo nel codice di tutti i progetti.', parameters: obj({ testo: { type: 'string' } }, ['testo']) } },
		async run(a, ctx) {
			if (!ctx.deps.actions.whereSolved) return 'La ricerca non e\' disponibile.';
			return ctx.deps.actions.whereSolved(a.testo);
		},
	},
	store_soldi: {
		spec: { type: 'function', function: { name: 'store_soldi', description: 'Stato delle app su App Store Connect (versione, revisione, recensioni) e quanto hanno reso su AdMob ieri e negli ultimi sette giorni.', parameters: obj({}) } },
		run(_a, ctx) {
			return ctx.deps.actions.storeSummary ? ctx.deps.actions.storeSummary() : 'Il radar dello Store non e\' disponibile.';
		},
	},
	lavoro_stanotte: {
		spec: { type: 'function', function: { name: 'lavoro_stanotte', description: 'Mette in fila un lavoro per la notte: parte nella finestra notturna, alla corrente, senza push ne\' pubblicazioni.', parameters: obj({ progetto: { type: 'string' }, compito: { type: 'string' } }, ['progetto', 'compito']) } },
		run(a, ctx) {
			const p = ctx.deps.actions.resolveProject(a.progetto);
			if (!p) return `Non trovo il progetto "${a.progetto}".`;
			if (!ctx.deps.actions.queueNight) return 'La coda della notte non e\' disponibile.';
			const r = ctx.deps.actions.queueNight(p.path, a.compito);
			ctx.azione(`Ho messo in fila per stanotte un lavoro su ${p.name}`);
			return r;
		},
	},
	cervello_cambia: {
		spec: { type: 'function', function: { name: 'cervello_cambia', description: 'Cambia il cervello con cui Melissa pensa, per questa conversazione (poi si torna ad Agnes), e/o l\'impegno. Usalo quando Andrea dice "usa Claude", "passa a Gemini", "torna ad Agnes", "pensa piu\' a fondo", "rispondi veloce".', parameters: obj({ cervello: { type: 'string', description: 'agnes, claude, opus, gemini, gpt, apple, deepseek' }, impegno: { type: 'string', description: 'rapido, normale o profondo' } }) } },
		async run(a, ctx) {
			if (!ctx.deps.actions.switchBrain) return 'Non posso cambiare cervello da qui.';
			const r = await ctx.deps.actions.switchBrain(a.cervello, a.impegno);
			ctx.azione(r);
			return r;
		},
	},
	sessione_leggi: {
		spec: { type: 'function', function: { name: 'sessione_leggi', description: 'Cosa sta facendo o ha fatto una sessione di Claude Code su un progetto: ultima richiesta di Andrea, ultima risposta di Claude, strumenti e file. Funziona anche per le sessioni aperte fuori dalla Bottega (sola lettura).', parameters: obj({ progetto: { type: 'string' } }, ['progetto']) } },
		run(a, ctx) {
			return ctx.deps.actions.readSession ? ctx.deps.actions.readSession(a.progetto) : 'Non so leggere le sessioni da qui.';
		},
	},
	cruscotto_mostra: {
		spec: { type: 'function', function: { name: 'cruscotto_mostra', description: 'Mostra il cruscotto delle ore e dei token, eventualmente su un progetto e un periodo (7, 30 o 90 giorni). Usalo per "fammi vedere le ore di Woofmap questa settimana".', parameters: obj({ progetto: { type: 'string' }, giorni: { type: 'number' } }) } },
		run(a, ctx) {
			if (!ctx.deps.actions.showCruscotto) return 'Il cruscotto non e\' disponibile.';
			const r = ctx.deps.actions.showCruscotto(a.progetto, a.giorni);
			ctx.azione('Ho aperto il cruscotto');
			return r;
		},
	},
	plancia_mostra: {
		spec: { type: 'function', function: { name: 'plancia_mostra', description: 'Mostra la plancia, eventualmente su una sezione (progetti, lavori, sessioni, memoria).', parameters: obj({ sezione: { type: 'string' } }) } },
		run(a, ctx) {
			ctx.deps.actions.showPlancia(a.sezione);
			ctx.azione('Ho aperto la plancia');
			return 'Plancia mostrata.';
		},
	},
};

interface Pending {
	describe: string;
	run: () => void;
	done: string;
	azione: string;
}

// ---------- l'assistente ----------

export class Assistant {
	readonly deps: AssistantDeps;
	private state: AssistantState = { enabled: true, conversing: false, state: 'idle', log: [], brain: 'agnes' };
	private history: LlmMessage[] = [];
	private pending?: Pending;
	private statusBar?: vscode.StatusBarItem;
	private orbHideTimer?: NodeJS.Timeout;
	private silenceTimer?: NodeJS.Timeout;
	private cachedKey?: string;
	private cachedCore?: string; // persona in cache
	private readonly specs: ToolSpec[] = Object.values(TOOLS).map(t => t.spec);
	/** Agnes finche' risponde; se cade, lo stesso turno va ad Apple Intelligence CON gli strumenti, e per 2 minuti
	 *  i turni vanno diretti al Mac (src/cervello.ts). Apple scelto a mano nel selettore: sempre Apple. */
	readonly router = new BrainRouter({
		mode: () => (this.deps.cervelli?.choice().provider === 'apple' ? 'apple' : 'auto'),
		appleAvailable: () => this.appleAvailable(),
	});
	private appleStream?: OpenAiStreamFn;

	// stato del turno in corso (serve a barge-in e streaming TTS)
	private currentAbort?: AbortController;
	private speaking = false;
	private chunker = new ClauseChunker();
	/** Frasi gia' mandate alla voce in questo turno: una frase ripetuta dal passo successivo non si ridice. */
	private saidClauses = new Set<string>();
	/** Cosa ha detto Melissa di recente, per scartare l'eco della sua voce in conversazione. */
	private recentSpeech: { text: string; at: number }[] = [];
	private firstSpeakChunk = true;
	private turnText = '';
	private hotkeyDownAt = 0;
	private pushStarted = false;
	/** Vero solo tra la pressione del tasto (tieni premuto) e l'arrivo della sua frase: fuori da qui
	 *  e fuori dalla conversazione, una frase trascritta in ritardo non diventa mai una domanda. */
	private awaitingPushFinal = false;
	private pushFinalTimer?: NodeJS.Timeout;
	private readonly out = vscode.window.createOutputChannel('Melissa', { log: true });
	/** Il turno in corso e' a voce: Agnes risponde subito, senza ragionare (come Avo). */
	private spokenTurn = false;
	/** Turno dall'iPhone in corso (src/ponte.ts): le frasi vanno qui invece che agli altoparlanti del Mac. Finche'
	 *  c'e', il Mac non apre turni suoi (microfono, tasto, barra): i due turni condividerebbero lo stesso stato. */
	private remote?: { frase(text: string): void; fine(): void };
	private pendingSeq = 0;
	private pendingId?: number;
	private filled = false;
	private lastLevelEmit = 0;

	constructor(deps: AssistantDeps) {
		this.deps = deps;
		this.state.enabled = vscode.workspace.getConfiguration('bottega').get('voice.enabled', true);
	}

	// ----- stato -----

	getState(): AssistantState {
		return { ...this.state, log: this.state.log.slice(-30) };
	}
	private emit(): void {
		this.deps.onState(this.getState());
	}
	private setState(s: AssistantState['state'], partial?: string): void {
		const changed = this.state.state !== s;
		this.state.state = s;
		this.state.partial = partial;
		if (changed) this.paintStatus();
		this.emit();
	}
	private pushLog(role: 'tu' | 'melissa' | 'azione', text: string): void {
		this.state.log.push({ role, text, at: Date.now() });
		if (this.state.log.length > 30) this.state.log = this.state.log.slice(-30);
		this.emit();
	}
	/** Una riga di diagnosi nel registro di Melissa. */
	note(line: string): void {
		this.out.info(line);
	}
	azione(text: string): void {
		this.pushLog('azione', text);
	}
	setPending(p: Pending): void {
		this.pending = p;
		this.pendingId = ++this.pendingSeq;
	}
	/** La domanda di un'azione a rischio in attesa del si' o del no, con il suo numero (per la notifica CONFERMA
	 *  sull'iPhone: un si' da una notifica vecchia non deve confermare una domanda nuova). */
	pendingQuestion(): { id: number; testo: string } | undefined {
		return this.pending && this.pendingId ? { id: this.pendingId, testo: `Posso ${this.pending.describe}?` } : undefined;
	}

	private model(): string {
		return vscode.workspace.getConfiguration('bottega').get('voice.model', 'eleven_v4_turbo');
	}

	/** Dice (e scrive nel registro) un testo gia' pronto, per esempio il briefing. Parla solo se la voce e' accesa. */
	async announce(text: string): Promise<void> {
		await this.sayFull(text, this.state.enabled && this.deps.nucleo.available);
	}

	/** Scrive un testo con la voce di Melissa a partire da fatti dati: Agnes, poi Apple Intelligence. Null se nessuno risponde. */
	async compose(instructions: string, facts: string, maxTokens = 400): Promise<{ text: string; engine: 'agnes' | 'apple' } | null> {
		const messages: LlmMessage[] = [
			{ role: 'system', content: MELISSA_CORE + '\n\n' + TRUTH_RULE + '\n\n' + instructions },
			{ role: 'user', content: facts },
		];
		try {
			let text = '';
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 25_000);
			try {
				if (this.deps.stream) await this.deps.stream(messages, [], d => (text += d.content ?? ''), ac.signal);
				else await this.callAgnesPlain(messages, d => (text += d.content ?? ''), ac.signal);
			} finally {
				clearTimeout(t);
			}
			if (text.trim()) return { text: cleanForVoice(text), engine: 'agnes' };
		} catch {
			// Agnes a terra: si prova sul Mac
		}
		if (!this.deps.nucleo.available) return null;
		try {
			const r = await this.deps.nucleo.request<{ text: string }>('ai.generate', { prompt: facts, instructions: MELISSA_CORE + '\n\n' + instructions, maxTokens }, 30_000);
			const text = (r?.text || '').trim();
			return text ? { text: cleanForVoice(text), engine: 'apple' } : null;
		} catch {
			return null;
		}
	}

	// ----- avvio e cablaggio con il Nucleo -----

	wire(ctx: vscode.ExtensionContext): void {
		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 900);
		this.statusBar.command = 'bottega.voice.converse';
		ctx.subscriptions.push(
			this.statusBar,
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('bottega.voice.sfera') || e.affectsConfiguration('bottega.voice.orbAlwaysVisible')) this.restOrb();
			}),
		);
		this.paintStatus();

		const n = this.deps.nucleo;
		n.on('hotkey.down', () => this.onHotkeyDown());
		n.on('hotkey.up', () => this.onHotkeyUp());
		n.on('voice.partial', (m: any) => (this.state.state === 'listening') && this.setState('listening', m.text));
		n.on('voice.final', (m: any) => void this.onVoiceFinal(m.text, m.mode));
		n.on('voice.level', (m: any) => this.onLevel(m.level));
		n.on('voice.bargein', () => this.onBargein());
		// Un guasto della voce (microfono, trascrizione, connessione) arriva come voice.state {state: "error", message}:
		// si dice in chiaro e la conversazione si chiude, invece di restare su "ti ascolto" senza ascoltare.
		n.on('voice.state', (m: any) => m?.state === 'error' && this.voiceFailed(String(m.message || 'la voce si è interrotta')));
		// Avvisi ed errori del Nucleo nel registro di Melissa; tutto quello che scrive (anche le righe informative) in
		// ~/.bottega/nucleo.log, per capire dopo cosa e' successo alla voce.
		n.on('log', (m: any) => this.out[m?.level === 'error' ? 'error' : 'warn'](`Nucleo: ${m?.message ?? ''}`));
		n.on('stderr', (chunk: string) => appendNucleoLog(chunk));
		// Clic sulla sfera: accende o spegne la conversazione (come un tocco di Opzione+Spazio).
		n.on('orb.clicked', () => this.onOrbClicked());
		// La sfera a riposo e' sempre visibile finche' la Bottega e' aperta e Melissa e' accesa.
		n.on('available', () => this.restOrb());
		if (n.available) this.restOrb();
		this.emit();
	}

	private paintStatus(): void {
		if (!this.statusBar) return;
		if (this.state.enabled) {
			const st = this.state.state;
			this.statusBar.text =
				st === 'thinking' ? '$(loading~spin) Melissa'
				: st === 'speaking' ? '$(unmute) Melissa'
				: st === 'error' ? '$(warning) Melissa'
				: this.state.conversing || st === 'listening' ? '$(mic-filled) Melissa ti ascolta'
				: '$(mic) Melissa';
			this.statusBar.color = st === 'idle' && !this.state.conversing ? undefined : new vscode.ThemeColor('bottega.sodio');
			this.statusBar.tooltip = 'Melissa è accesa. Clic, o un tocco di Opzione+Spazio, per conversare; tieni premuto per parlare una volta.';
		} else {
			this.statusBar.text = '$(mic-off) Melissa';
			this.statusBar.tooltip = 'Melissa è spenta. Clic per accenderla e parlarle.';
		}
		this.statusBar.show();
	}

	/** Dove torna la sfera quando Melissa non sta ascoltando ne' parlando: piccola e sempre visibile
	 *  (impostazione bottega.voice.orbAlwaysVisible), oppure nascosta se Melissa e' spenta. */
	private restOrb(): void {
		const docked = this.state.enabled && this.orbOnScreen() && vscode.workspace.getConfiguration('bottega').get('voice.orbAlwaysVisible', true);
		this.deps.nucleo.fireAndForget(docked ? 'orb.dock' : 'orb.hide');
	}

	/** La sfera del Nucleo galleggia sullo schermo solo se Andrea lo chiede (bottega.voice.sfera = "schermo"):
	 *  di default Melissa vive dentro l'IDE (vista laterale e barra di stato) e non copre le altre app. */
	private orbOnScreen(): boolean {
		return vscode.workspace.getConfiguration('bottega').get<string>('voice.sfera', 'ide') === 'schermo';
	}

	private showBigOrb(): void {
		if (this.orbOnScreen()) this.deps.nucleo.fireAndForget('orb.show');
		else this.deps.onConverse?.();
	}

	/** Comando bottega.voice.converse e icona di Melissa: apre o chiude la conversazione. */
	toggleConversation(): void {
		this.out.info(`tocco: voce ${this.state.enabled ? 'accesa' : 'spenta'}, conversazione ${this.state.conversing ? 'aperta' : 'chiusa'}`);
		if (!this.state.enabled) {
			void this.toggle().then(() => this.startConversation());
			return;
		}
		if (this.state.conversing) this.stopConversation('tocco sulla sfera o comando');
		else this.startConversation();
	}

	private onOrbClicked(): void {
		if (!this.state.enabled) return;
		this.out.info('clic sulla sfera');
		if (this.state.conversing) this.stopConversation('clic sulla sfera del Nucleo');
		else this.startConversation();
	}

	/** Comando bottega.voice.toggle: interruttore generale di Melissa. */
	async toggle(): Promise<void> {
		this.state.enabled = !this.state.enabled;
		this.out.info(`voce ${this.state.enabled ? 'accesa' : 'spenta'}`);
		await vscode.workspace.getConfiguration('bottega').update('voice.enabled', this.state.enabled, vscode.ConfigurationTarget.Global);
		if (!this.state.enabled) {
			this.stopConversation('voce spenta');
			this.deps.nucleo.fireAndForget('voice.stop');
			this.deps.nucleo.fireAndForget('orb.hide');
			this.setState('idle');
		} else {
			this.restOrb();
		}
		this.paintStatus();
		this.emit();
	}

	// ----- scorciatoia: tap = conversazione on/off, tieni premuto = parla una volta -----

	private onHotkeyDown(): void {
		if (!this.state.enabled || this.remote) return;
		this.hotkeyDownAt = Date.now();
		if (this.state.conversing) return; // mic gia' aperto: decido al rilascio (tap = spegni)
		clearTimeout(this.orbHideTimer);
		this.pushStarted = true;
		this.awaitingPushFinal = true;
		clearTimeout(this.pushFinalTimer);
		this.showBigOrb();
		this.deps.nucleo.fireAndForget('orb.state', { state: 'listening' });
		this.setState('listening');
		void this.deps.nucleo.request('voice.listen', { mode: 'push' }, 15_000).catch((e: any) => this.voiceFailed(e?.message ?? String(e)));
	}

	private onHotkeyUp(): void {
		if (!this.state.enabled) return;
		const held = Date.now() - this.hotkeyDownAt;
		if (held < TAP_MS) {
			// TAP: accende o spegne la conversazione.
			if (this.pushStarted) {
				this.pushStarted = false;
				this.awaitingPushFinal = false; // il push appena avviato e' annullato: la sua frase non conta
				this.deps.nucleo.fireAndForget('voice.stop');
			}
			if (this.state.conversing) this.stopConversation('tocco di Opzione+Spazio');
			else this.startConversation();
			return;
		}
		// HOLD: push-to-talk, chiudo l'ascolto e aspetto il voice.final.
		if (this.pushStarted) {
			this.pushStarted = false;
			this.deps.nucleo.fireAndForget('voice.stop');
			// Il Nucleo manda la frase entro ~2 s dal rilascio; dopo, la finestra si chiude.
			clearTimeout(this.pushFinalTimer);
			this.pushFinalTimer = setTimeout(() => (this.awaitingPushFinal = false), 4000);
		}
	}

	private startConversation(): void {
		this.out.info(`conversazione aperta (Nucleo ${this.deps.nucleo.available ? 'pronto' : 'non disponibile'})`);
		this.state.conversing = true;
		this.showBigOrb();
		this.deps.nucleo.fireAndForget('orb.state', { state: 'listening' });
		this.deps.nucleo
			.request('voice.converse.start', { model: this.model(), locale: 'it-IT' }, 15_000)
			.catch((e: any) => this.voiceFailed(e?.message ?? String(e)));
		this.setState('listening');
		this.paintStatus();
		this.armSilence();
	}

	private stopConversation(reason = 'chiusa'): void {
		if (!this.state.conversing) return;
		this.state.conversing = false;
		this.deps.cervelli?.endConversation();
		clearTimeout(this.silenceTimer);
		// Chiusa vuol dire chiusa: si ferma anche la risposta in corso e la sua voce (non quella per l'iPhone).
		if (!this.remote) this.currentAbort?.abort();
		this.deps.nucleo.fireAndForget('voice.stopSpeaking');
		this.deps.nucleo.fireAndForget('voice.converse.stop');
		this.out.info(`conversazione chiusa: ${reason}`);
		this.deps.nucleo.fireAndForget('orb.state', { state: 'idle' });
		this.restOrb();
		this.setState('idle');
		this.paintStatus();
	}

	/** La voce non funziona: lo si dice nella barra e nel registro, e la conversazione si chiude. */
	private voiceFailed(message: string): void {
		this.out.error(`voce: ${message}`);
		const wasConversing = this.state.conversing;
		this.stopConversation('errore della voce');
		this.awaitingPushFinal = false;
		this.pushLog('azione', `La voce non funziona: ${message}`);
		this.setState('error', message);
		if (!wasConversing) this.paintStatus();
	}

	private armSilence(): void {
		clearTimeout(this.silenceTimer);
		this.silenceTimer = setTimeout(() => this.stopConversation('60 s di silenzio'), SILENCE_MS);
	}

	// ----- barge-in: Andrea parla sopra Melissa -----

	/** Livello audio dal Nucleo: aggiorno lo stato leggero, non piu' di ~10 volte al secondo. */
	private onLevel(level: number): void {
		this.state.level = typeof level === 'number' ? level : 0;
		const now = Date.now();
		if (now - this.lastLevelEmit >= 100) {
			this.lastLevelEmit = now;
			this.emit();
		}
	}

	private onBargein(): void {
		// Il Nucleo ha gia' fermato la voce. Interrompo lo stream Agnes e i tool non ancora partiti.
		this.currentAbort?.abort();
	}

	// ----- turni -----

	private async onVoiceFinal(text: string, mode?: string): Promise<void> {
		if (!this.state.enabled || !text?.trim()) return;
		if (this.remote) {
			this.out.info(`frase ignorata, sto rispondendo all'iPhone: "${text}"`);
			return;
		}
		const inConversation = this.state.conversing && mode !== 'push';
		const ownPush = this.awaitingPushFinal && mode !== 'converse';
		if (!inConversation && !ownPush) {
			this.out.info(`frase ignorata, nessun ascolto aperto (${mode ?? '?'}): "${text}"`);
			return;
		}
		if (ownPush) {
			this.awaitingPushFinal = false;
			clearTimeout(this.pushFinalTimer);
		}
		if (inConversation && !ownPush) {
			const said = this.recentSpeech.filter(x => Date.now() - x.at < 20_000).map(x => x.text).join(' ');
			if (said && echoScore(text, said) >= 0.6) {
				this.out.info(`eco della mia voce, la ignoro: "${text}"`);
				return;
			}
		}
		this.out.info(`frase (${mode ?? '?'}): "${text}"`);
		if (this.state.conversing) {
			this.armSilence();
			if (isEndWord(text)) {
				await this.sayFull('A dopo.', true);
				this.stopConversation('parola di chiusura');
				return;
			}
		}
		await this.turn(text, this.state.enabled && this.deps.nucleo.available);
	}

	/** Vero mentre un turno e' in corso (pensa o parla): il ponte non ne apre un secondo. */
	busy(): boolean {
		return !!this.remote || !!this.currentAbort || this.state.state === 'thinking' || this.state.state === 'speaking';
	}

	/** Il numero della conferma aperta adesso (POST /v1/chiedi con `conferma` da una notifica). */
	pendingConfirmation(): number | undefined {
		return this.pending ? this.pendingId : undefined;
	}

	/** Fine di un turno dall'iPhone: lo stato torna quello del Mac (in ascolto se la conversazione e' aperta). */
	private endRemote(sink: { frase(text: string): void; fine(): void }): void {
		if (this.remote !== sink) return;
		this.remote = undefined;
		this.setState(this.state.conversing ? 'listening' : 'idle');
	}

	/** Domanda a voce dall'iPhone: stesso cervello, stessa conversazione e stessa fretta di un turno a voce sul
	 *  Mac (Agnes senza ragionare), ma ogni frase va a `sink` appena e' pronta invece che agli altoparlanti del
	 *  Mac. Il ponte la fa sintetizzare e la manda all'iPhone mentre Melissa sta ancora rispondendo. */
	async askRemoteVoice(text: string, sink: { frase(text: string): void; fine(): void }): Promise<string> {
		this.out.info(`domanda a voce dall'iPhone: "${text.slice(0, 80)}"`);
		this.remote = sink;
		try {
			return cleanForVoice(await this.turn(text, true));
		} finally {
			this.endRemote(sink);
		}
	}

	/** L'iPhone ha interrotto la risposta (un tocco sulla sfera, o l'app chiusa). */
	interruptRemote(): void {
		if (this.remote) this.currentAbort?.abort();
	}

	/** Domanda scritta dalla Bottega per iPhone (src/ponte.ts): stesso cervello e stessa conversazione, ma il Mac
	 *  sta zitto. */
	async askRemote(text: string): Promise<string> {
		this.out.info(`domanda dall'iPhone: "${text.slice(0, 80)}"`);
		// un turno muto per il Mac: nessuna frase da dire, ma la sfera e il microfono del Mac restano fermi
		const sink = { frase: () => undefined, fine: () => undefined };
		this.remote = sink;
		try {
			return cleanForVoice(await this.turn(text, false));
		} finally {
			this.endRemote(sink);
		}
	}

	/** Domanda scritta dalla plancia: stesso cervello, parlata solo se la voce e' accesa. */
	async ask(text: string): Promise<string> {
		if (this.remote) return 'Sto rispondendo all\'iPhone: riprova tra un attimo.';
		return this.turn(text, this.state.enabled && this.deps.nucleo.available);
	}

	async turn(userText: string, speak: boolean): Promise<string> {
		this.spokenTurn = speak;
		this.pushLog('tu', userText);

		// Conferma in sospeso: questo turno e' il si/no.
		if (this.pending) {
			const p = this.pending;
			this.pending = undefined;
			let answer: string;
			if (isAffirmative(userText)) {
				try {
					p.run();
					this.azione(p.azione);
					answer = p.done;
				} catch (e: any) {
					answer = `Non ci sono riuscita: ${e?.message ?? e}`;
				}
			} else {
				answer = 'Lasciato stare, non ho toccato niente.';
			}
			return this.sayFull(answer, speak);
		}

		const ac = new AbortController();
		this.currentAbort = ac;
		this.turnText = '';
		this.filled = false;
		this.setState('thinking');
		if (!this.remote) this.deps.nucleo.fireAndForget('orb.state', { state: 'thinking' });
		if (speak) this.beginSpeech();

		const choice = this.deps.cervelli?.choice();
		if (choice && choice.provider !== 'agnes') this.deps.cervelli!.touch();
		// Agnes (o il cervello scelto a mano), oppure Apple: scelto a mano, o di riserva con l'interruttore aperto.
		const viaRouter = !choice || choice.provider === 'agnes' || choice.provider === 'apple';
		const pick = viaRouter ? this.router.choose(userText) : { brain: 'agnes' as BrainName, why: 'principale' as const };
		const note = viaRouter && choice?.provider !== 'apple' ? this.router.announce(pick.brain, pick.why) : null;
		if (note && speak) this.emitClause(note);
		const done = (answer: string, brain: BrainName, said?: string | null): string => {
			this.state.brain = brain;
			if (speak) this.finalizeSpeech(true);
			const full = said ? `${said} ${answer}` : answer;
			this.recordAnswer(full);
			this.afterTurn(speak);
			return full;
		};
		const interrupted = (): string => {
			// barge-in: chiudo senza "final" (la voce e' gia' stata fermata dal Nucleo)
			this.speaking = false;
			this.markInterrupted(this.turnText);
			return this.turnText;
		};

		try {
			const answer = await this.runAgent(userText, speak, ac.signal, pick.brain);
			if (pick.brain === 'agnes' && viaRouter) this.router.agnesOk();
			return done(answer, pick.brain, note);
		} catch (e) {
			if (ac.signal.aborted) return interrupted();
			this.out.warn(`cervello ${pick.brain}: ${(e as any)?.message ?? e}`);
			if (pick.brain === 'apple' && choice?.provider === 'apple') {
				// Apple scelto a mano e non risponde: si torna ad Agnes e lo si dice.
				this.deps.cervelli!.endConversation();
				const msg = 'Apple Intelligence non risponde. Torno ad Agnes: ridimmelo.';
				if (speak) {
					this.feedSpeak(msg);
					this.finalizeSpeech(true);
				}
				this.recordAnswer(msg);
				this.afterTurn(speak);
				return msg;
			}
			// Agnes a terra (429, rete, server): lo stesso turno sul Mac, CON gli strumenti, se non ha ancora detto niente.
			if (pick.brain === 'agnes' && viaRouter) this.router.agnesFailed(e);
			if (pick.brain === 'agnes' && this.appleAvailable() && !this.turnText.trim()) {
				const note2 = this.router.announce('apple', 'interruttore');
				if (note2 && speak) this.emitClause(note2);
				try {
					this.history.pop(); // la domanda la rimette runAgent
					const answer = await this.runAgent(userText, speak, ac.signal, 'apple');
					return done(answer, 'apple', note2);
				} catch (e2) {
					if (ac.signal.aborted) return interrupted();
					this.out.warn(`cervello apple: ${(e2 as any)?.message ?? e2}`);
				}
			}
			// Ultima spiaggia: Apple senza strumenti (vecchio ripiego).
			const fb = !this.turnText.trim() ? await this.appleFallback(userText) : null;
			if (fb !== null) {
				this.state.brain = 'apple';
				if (speak) {
					this.feedSpeak(fb);
					this.finalizeSpeech(true);
				}
				this.recordAnswer(fb);
				this.afterTurn(speak);
				return fb;
			}
			this.state.brain = 'nessuno';
			const msg = 'Agnes e\' a terra e pure il cervello di riserva non risponde. Riprova tra poco.';
			if (speak) {
				this.feedSpeak(msg);
				this.finalizeSpeech(true);
			}
			this.recordAnswer(msg);
			this.setState('error');
			return msg;
		} finally {
			if (this.currentAbort === ac) this.currentAbort = undefined;
		}
	}

	private recordAnswer(answer: string): void {
		const clean = cleanForVoice(answer);
		this.pushLog('melissa', clean);
		this.history.push({ role: 'assistant', content: clean });
		this.trimHistory();
	}

	private markInterrupted(partial: string): void {
		const clean = cleanForVoice(partial);
		if (clean) this.pushLog('melissa', clean + ' (interrotta)');
		this.history.push({ role: 'assistant', content: (clean ? clean + ' ' : '') + '[interrotta da Andrea]' });
		this.trimHistory();
	}

	private afterTurn(speak: boolean): void {
		if (this.remote) return; // dall'iPhone: il Mac non si mette in ascolto
		if (this.pending && speak && !this.state.conversing) {
			// azione a rischio: resto in ascolto per il si/no
			this.setState('listening');
			this.deps.nucleo.fireAndForget('orb.state', { state: 'listening' });
			void this.deps.nucleo.request('voice.listen', { mode: 'utterance' }, 15_000).catch((e: any) => this.voiceFailed(e?.message ?? String(e)));
		} else if (this.state.conversing) {
			this.armSilence();
			this.setState('listening');
		}
	}

	private trimHistory(): void {
		if (this.history.length > 24) this.history = this.history.slice(-24); // ~12 turni
	}

	// ----- voce in streaming -----

	private beginSpeech(): void {
		this.speaking = true;
		this.saidClauses.clear();
		this.chunker = new ClauseChunker();
		this.firstSpeakChunk = true;
	}
	private feedSpeak(text: string): void {
		if (!this.speaking) return;
		for (const clause of this.chunker.push(text)) this.emitClause(clause);
	}
	private emitClause(clause: string): void {
		const k = normClause(clause);
		if (k && this.saidClauses.has(k)) {
			this.out.info(`frase gia' detta in questo turno, non la ripeto: "${clause}"`);
			return;
		}
		if (k) this.saidClauses.add(k);
		if (this.remote) {
			if (this.state.state !== 'speaking') this.setState('speaking');
			this.remote.frase(clause);
			return;
		}
		const now = Date.now();
		this.recentSpeech = [...this.recentSpeech.filter(x => now - x.at < 20_000), { text: clause, at: now }];
		if (this.state.state !== 'speaking') {
			this.setState('speaking');
			this.deps.nucleo.fireAndForget('orb.state', { state: 'speaking' });
		}
		const args: any = { text: clause, append: true };
		if (this.firstSpeakChunk) {
			args.model = this.model();
			this.firstSpeakChunk = false;
		}
		this.deps.nucleo.fireAndForget('voice.speak', args);
	}
	private finalizeSpeech(sendFinal: boolean): void {
		if (!this.speaking) return;
		const rest = this.chunker.flush();
		if (rest) this.emitClause(rest);
		if (this.remote) {
			this.speaking = false;
			this.remote.fine();
			this.setState('idle');
			return;
		}
		if (sendFinal) this.deps.nucleo.fireAndForget('voice.speak', { final: true });
		this.speaking = false;
		if (this.state.conversing) {
			this.setState('listening');
			this.deps.nucleo.fireAndForget('orb.state', { state: 'listening' });
		} else {
			this.setState('idle');
			this.deps.nucleo.fireAndForget('orb.state', { state: 'idle' });
			clearTimeout(this.orbHideTimer);
			this.orbHideTimer = setTimeout(() => this.restOrb(), 4000);
		}
	}

	/** Dice una frase intera gia' pronta (conferme, errori), con la stessa via dello streaming. */
	private async sayFull(text: string, speak: boolean): Promise<string> {
		this.recordAnswer(text);
		if (speak) {
			this.beginSpeech();
			this.feedSpeak(text);
			this.finalizeSpeech(true);
		} else {
			this.setState('idle');
		}
		return cleanForVoice(text);
	}

	// ----- il giro dei tool con Agnes in streaming (max 8 passi) -----

	async runAgent(userText: string, speak: boolean, signal: AbortSignal, brain: BrainName = 'agnes'): Promise<string> {
		const system = this.systemPrompt();
		const messages: LlmMessage[] = [
			{ role: 'system', content: brain === 'apple' ? appleInstructions(MELISSA_CORE, system.slice((this.cachedCore ?? '').length).trim()) : system },
			...this.history,
			{ role: 'user', content: userText },
		];
		this.history.push({ role: 'user', content: userText });
		this.trimHistory();

		const agnes: LlmStreamFn = this.deps.stream ?? ((m, t, cb, sig) => this.callAgnesStream(m, t, cb, sig));
		const choice = this.deps.cervelli?.choice();
		let stream: LlmStreamFn = brain === 'apple'
			? (this.deps.appleStream ?? this.appleStreamFn())
			: (choice && choice.provider !== 'agnes' && choice.provider !== 'apple' && this.deps.cervelli!.streamFor(choice)) || agnes;
		const tools = brain === 'apple' ? (appleToolSpecs(this.specs) as ToolSpec[]) : this.specs;
		const chosen = stream !== agnes && brain !== 'apple';
		const chosenName = choice ? brainName(choice.model) : '';

		// Stesso strumento con gli stessi argomenti nello stesso turno: non si riesegue (niente progetto aperto due
		// volte, niente lavoro avviato due volte) e al terzo tentativo il giro si chiude.
		const done = new Map<string, string>();
		let repeats = 0;
		for (let step = 0; step < 6; step++) {
			if (signal.aborted) throw abortError();
			let content = '';
			const calls = new Map<number, { id: string; name: string; args: string }>();

			let got = false;
			const run = (fn: LlmStreamFn) => fn(messages, tools, (d: LlmDelta) => {
				got = true;
				if (d.content) {
					content += d.content;
					this.turnText += d.content;
					if (speak) this.feedSpeak(d.content);
				}
				if (d.tool_call) {
					const i = d.tool_call.index ?? 0;
					const cur = calls.get(i) ?? { id: '', name: '', args: '' };
					if (d.tool_call.id) cur.id = d.tool_call.id;
					if (d.tool_call.name) cur.name = d.tool_call.name;
					if (d.tool_call.arguments) cur.args += d.tool_call.arguments;
					calls.set(i, cur);
				}
			}, signal);
			try {
				await run(stream);
			} catch (e: any) {
				// il cervello scelto non risponde (402, rete): stessa domanda ad Agnes, e lo si dice
				if (!chosen || stream === agnes || got || signal.aborted) throw e;
				this.azione(`${chosenName} non risponde (${e?.message ?? e}): torno ad Agnes`);
				this.deps.cervelli?.endConversation();
				stream = agnes;
				await run(stream);
			}

			if (calls.size) {
				const toolCalls: LlmToolCall[] = [...calls.entries()]
					.sort((a, b) => a[0] - b[0])
					.map(([, c]) => ({ id: c.id || `call_${c.name}`, type: 'function', function: { name: c.name, arguments: c.args } }));
				messages.push({ role: 'assistant', content: content || '', tool_calls: toolCalls });
				for (const tc of toolCalls) {
					if (signal.aborted) throw abortError(); // tool non ancora partito: niente effetti
					const key = tc.function.name + ' ' + normClause(tc.function.arguments || '');
					let result: string;
					if (done.has(key)) {
						repeats++;
						this.out.info(`strumento ${tc.function.name} richiesto di nuovo con gli stessi argomenti: non lo rieseguo`);
						result = `${done.get(key)}\n(Questo strumento l'hai gia' chiamato in questo turno con gli stessi argomenti: non richiamarlo, rispondi ad Andrea con quello che hai.)`;
					} else {
						result = await this.runTool(tc, speak, signal);
						done.set(key, result);
					}
					messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result });
				}
				if (repeats >= 2) break;
				continue;
			}
			return content.trim() || this.turnText.trim() || 'Non ho niente da dirti.';
		}
		return this.turnText.trim() || 'Mi sono incartata tra i passaggi, ridimmi cosa ti serve.';
	}

	private async runTool(tc: LlmToolCall, speak: boolean, signal: AbortSignal): Promise<string> {
		const def = TOOLS[tc.function.name];
		if (!def) return `Tool sconosciuto: ${tc.function.name}.`;
		let args: any;
		try {
			args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
		} catch {
			return 'Argomenti non leggibili (JSON rotto).';
		}
		const bad = validateArgs(def.spec, args);
		if (bad) return `Argomenti non validi: ${bad}.`;
		// Riempitivo breve solo se un tool ci mette piu' di 1,5 s, una volta per turno.
		let filler: NodeJS.Timeout | undefined;
		if (speak && !this.filled) {
			filler = setTimeout(() => {
				if (signal.aborted) return;
				this.filled = true;
				this.emitClause('Un attimo.');
			}, 1500);
		}
		try {
			return await def.run(args, this);
		} catch (e: any) {
			return `Il tool ${tc.function.name} ha dato errore: ${e?.message ?? e}.`;
		} finally {
			clearTimeout(filler);
		}
	}

	// ----- prompt di sistema con contesto in diretta (valori gia' noti, niente blocchi) -----

	systemPrompt(): string {
		this.cachedCore ??= MELISSA_CORE + '\n\n' + TRUTH_RULE;
		const live = this.deps.liveSessions();
		const jobs = this.deps.jobs();
		const stats = this.deps.systemStats();
		const liveLine = live.length
			? live.map(s => `${s.title ?? s.name} in ${path.basename(s.cwd)} (${s.status === 'busy' ? 'al lavoro' : s.status === 'idle' ? 'ti aspetta' : 'nel terminale'})`).join('; ')
			: 'nessuna';
		const work = this.deps.work?.();
		const jobLine = work
			? work.length ? work.map(w => `${w.project}: ${w.status}${w.source === 'altrove' ? ' (fuori dalla Bottega)' : ''}`).join('; ') : 'nessuno'
			: jobs.length ? jobs.map(j => `${j.project}: ${j.status}`).join('; ') : 'nessuno';
		const pressure = stats ? `memoria ${stats.memoryPressure}, temperatura ${stats.thermal}, carico ${stats.load.map(n => n.toFixed(2)).join('/')}` : 'sconosciuta';

		return [
			this.cachedCore,
			`Adesso e\' ${nowLine()} (fuso ${TZ}).`,
			`Andrea ha ${this.deps.projectCount()} progetti. Sessioni di Claude vive: ${liveLine}. Lavori: ${jobLine}. Sistema: ${pressure}.`,
			'Per le azioni a rischio (git push, fermare un lavoro) chiedi sempre "confermi?" e aspetta un si esplicito: il tool stesso te lo ricorda.',
		].join('\n\n');
	}

	// ----- chiave Agnes -----

	private async apiKey(): Promise<string | undefined> {
		if (this.cachedKey) return this.cachedKey;
		if (process.env.AGNES_API_KEY) return (this.cachedKey = process.env.AGNES_API_KEY);
		try {
			const env = fs.readFileSync(path.join(os.homedir(), '.secrets', 'agnes-ai.env'), 'utf8');
			const m = /^\s*AGNES_API_KEY\s*=\s*(.+?)\s*$/m.exec(env);
			if (m && m[1]) return (this.cachedKey = m[1].replace(/^["']|["']$/g, ''));
		} catch {
			// nessun file dei segreti
		}
		const stored = await this.deps.secrets.get('bottega.agnesKey');
		if (stored) return (this.cachedKey = stored);
		const entered = await vscode.window.showInputBox({
			title: 'Chiave Agnes AI',
			prompt: 'Serve la chiave di Agnes AI per far parlare Melissa. La salvo nel portachiavi della Bottega.',
			password: true,
			ignoreFocusOut: true,
		});
		if (entered) {
			await this.deps.secrets.store('bottega.agnesKey', entered);
			return (this.cachedKey = entered);
		}
		return undefined;
	}

	// ----- SSE verso Agnes, con backoff cieco sul 429 -----

	private async callAgnesStream(messages: LlmMessage[], tools: ToolSpec[], onDelta: (d: LlmDelta) => void, signal: AbortSignal): Promise<void> {
		const key = await this.apiKey();
		if (!key) throw new Error('Nessuna chiave Agnes.');
		const effort = this.deps.cervelli?.choice().effort;
		// A voce Agnes risponde senza ragionare, come la Melissa di Avo (reasoning_effort none): con "profondo"
		// pensava circa 4 s prima della prima parola. L'impegno scelto vale per le domande scritte.
		const reasoning = this.spokenTurn ? 'none' : effort === 'profondo' ? 'high' : effort === 'normale' ? 'low' : 'none';
		const body = JSON.stringify({ model: AGNES_MODEL, messages, tools, tool_choice: 'auto', reasoning_effort: this.deps.cervelli ? reasoning : 'none', stream: true });
		let wait = 2000;
		for (let attempt = 0; attempt < 4; attempt++) {
			if (signal.aborted) throw abortError();
			let res: Response;
			try {
				res = await fetch(AGNES_URL, {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
					body,
					signal,
				});
			} catch (e: any) {
				if (e?.name === 'AbortError') throw e;
				this.deps.cervelli?.noteAgnes(0);
				throw new Error('Rete giu\' verso Agnes.');
			}
			this.deps.cervelli?.noteAgnes(res.status);
			if (res.status === 429) {
				// Con il Mac a disposizione niente attese cieche: il turno passa subito ad Apple Intelligence.
				if (this.appleAvailable()) throw new Error('Agnes ha risposto 429.');
				await sleep(wait, signal);
				wait = Math.min(wait * 2, 16_000);
				continue;
			}
			if (!res.ok || !res.body) throw new Error(`Agnes ha risposto ${res.status}.`);
			await this.readSse(res.body, onDelta);
			return;
		}
		throw new Error('Agnes continua a rispondere 429.');
	}

	/** Come callAgnesStream, ma senza strumenti (testo puro). */
	private async callAgnesPlain(messages: LlmMessage[], onDelta: (d: LlmDelta) => void, signal: AbortSignal): Promise<void> {
		const key = await this.apiKey();
		if (!key) throw new Error('Nessuna chiave Agnes.');
		const res = await fetch(AGNES_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
			body: JSON.stringify({ model: AGNES_MODEL, messages, reasoning_effort: 'none', stream: true }),
			signal,
		});
		if (!res.ok || !res.body) throw new Error(`Agnes ha risposto ${res.status}.`);
		await this.readSse(res.body, onDelta);
	}

	private async readSse(body: ReadableStream<Uint8Array>, onDelta: (d: LlmDelta) => void): Promise<void> {
		const reader = body.getReader();
		const dec = new TextDecoder();
		let buf = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (payload === '[DONE]') return;
				let json: any;
				try {
					json = JSON.parse(payload);
				} catch {
					continue;
				}
				const delta = json?.choices?.[0]?.delta;
				if (!delta) continue;
				if (typeof delta.content === 'string' && delta.content) onDelta({ content: delta.content });
				if (Array.isArray(delta.tool_calls)) {
					for (const tc of delta.tool_calls) {
						onDelta({ tool_call: { index: tc.index ?? 0, id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments } });
					}
				}
			}
		}
	}

	// ----- ripiego su Apple Intelligence (senza tool) -----

	/** Apple Intelligence sul Mac, senza strumenti: riserva quando Agnes non risponde, oppure scelta da Andrea. */
	// ----- Apple Intelligence sul Mac, con gli strumenti -----

	appleAvailable(): boolean {
		const n = this.deps.nucleo;
		return n.available && n.capabilities?.foundationModels !== false;
	}

	/** Lo stream di Apple con la forma di quello di Agnes (un passo per chiamata, tool_calls OpenAI). */
	private appleStreamFn(): LlmStreamFn {
		this.appleStream ??= appleOpenAiStream(this.deps.nucleo, { effort: () => this.deps.cervelli?.choice().effort ?? 'normale' });
		return this.appleStream as unknown as LlmStreamFn;
	}

	private async appleFallback(userText: string, chosen = false): Promise<string | null> {
		if (!this.deps.nucleo.available) return null;
		try {
			const r = await this.deps.nucleo.request<{ text: string }>('ai.generate', {
				prompt: userText,
				instructions: MELISSA_CORE + (chosen
					? '\n\nAndrea ti ha chiesto di pensare con Apple Intelligence, sul Mac: non hai strumenti, quindi non puoi aprire progetti ne\' leggere lo stato; se servono, diglielo. Massimo tre frasi.'
					: '\n\nAgnes e\' a terra: rispondi col cervello di riserva sul dispositivo, senza strumenti, e dillo in mezza frase. Massimo tre frasi.'),
				maxTokens: 300,
			}, 20_000);
			const text = (r?.text || '').trim();
			if (!text) return null;
			return chosen ? text : 'Agnes e\' a terra, rispondo col cervello di riserva. ' + text;
		} catch {
			return null;
		}
	}
}

/** "anthropic/claude-sonnet-5.5" -> "Claude Sonnet 5.5": come lo dice Melissa. */
export function brainName(model: string): string {
	const m = (model || '').split('/').pop() ?? '';
	return m.split('-').map(w => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ').replace(/^Gpt/, 'GPT') || 'Il cervello scelto';
}

function abortError(): Error {
	const e = new Error('interrotto');
	e.name = 'AbortError';
	return e;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError());
		const t = setTimeout(resolve, ms);
		signal?.addEventListener('abort', () => {
			clearTimeout(t);
			reject(abortError());
		}, { once: true });
	});
}
