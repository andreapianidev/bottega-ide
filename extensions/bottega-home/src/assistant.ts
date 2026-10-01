import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LiveSession } from './claude';
import { Job } from './jobs';
import { SystemStats } from './nucleo';

// Melissa: il cervello della Bottega. Parla via Agnes AI (OpenAI-compatibile, in streaming),
// con ripiego su Apple Intelligence attraverso il Nucleo quando Agnes e' a terra.
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
}

export interface NucleoLike {
	readonly available: boolean;
	request<T = any>(cmd: string, args?: Record<string, any>, timeoutMs?: number): Promise<T>;
	fireAndForget(cmd: string, args?: Record<string, any>): void;
	on(event: string, handler: (...a: any[]) => void): any;
}

export interface AssistantDeps {
	nucleo: NucleoLike;
	actions: AssistantActions;
	liveSessions(): LiveSession[];
	jobs(): Job[];
	systemStats(): SystemStats | undefined;
	projectCount(): number;
	bacheca(project?: string): Promise<{ title: string; text: string; project: string }[]>;
	memoriaSearch(text: string, project?: string): Promise<{ title: string; text: string; project: string }[]>;
	memoriaRemember(text: string, project?: string): Promise<boolean>;
	secrets: vscode.SecretStorage;
	onState(state: AssistantState): void;
	/** Solo per i test: uno stream finto al posto di Agnes. */
	stream?: LlmStreamFn;
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
			const live = ctx.deps.liveSessions();
			if (!live.length) return 'Nessuna sessione di Claude viva adesso.';
			return live.map(s => `${s.title ?? s.name} in ${path.basename(s.cwd)}: ${s.status === 'busy' ? 'al lavoro' : s.status === 'idle' ? 'in attesa' : s.status}`).join('\n');
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
		spec: { type: 'function', function: { name: 'lavori_elenco', description: 'Elenco dei lavori con il loro stato.', parameters: obj({}) } },
		run(_a, ctx) {
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

	// stato del turno in corso (serve a barge-in e streaming TTS)
	private currentAbort?: AbortController;
	private speaking = false;
	private chunker = new ClauseChunker();
	private firstSpeakChunk = true;
	private turnText = '';
	private hotkeyDownAt = 0;
	private pushStarted = false;
	/** Vero solo tra la pressione del tasto (tieni premuto) e l'arrivo della sua frase: fuori da qui
	 *  e fuori dalla conversazione, una frase trascritta in ritardo non diventa mai una domanda. */
	private awaitingPushFinal = false;
	private pushFinalTimer?: NodeJS.Timeout;
	private readonly out = vscode.window.createOutputChannel('Melissa', { log: true });
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
		this.state.state = s;
		this.state.partial = partial;
		this.emit();
	}
	private pushLog(role: 'tu' | 'melissa' | 'azione', text: string): void {
		this.state.log.push({ role, text, at: Date.now() });
		if (this.state.log.length > 30) this.state.log = this.state.log.slice(-30);
		this.emit();
	}
	azione(text: string): void {
		this.pushLog('azione', text);
	}
	setPending(p: Pending): void {
		this.pending = p;
	}

	private model(): string {
		return vscode.workspace.getConfiguration('bottega').get('voice.model', 'eleven_v4_turbo');
	}

	// ----- avvio e cablaggio con il Nucleo -----

	wire(ctx: vscode.ExtensionContext): void {
		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 900);
		this.statusBar.command = 'bottega.voice.toggle';
		ctx.subscriptions.push(this.statusBar);
		this.paintStatus();

		const n = this.deps.nucleo;
		n.on('hotkey.down', () => this.onHotkeyDown());
		n.on('hotkey.up', () => this.onHotkeyUp());
		n.on('voice.partial', (m: any) => (this.state.state === 'listening') && this.setState('listening', m.text));
		n.on('voice.final', (m: any) => void this.onVoiceFinal(m.text, m.mode));
		n.on('voice.level', (m: any) => this.onLevel(m.level));
		n.on('voice.bargein', () => this.onBargein());
		n.on('orb.clicked', () => this.onHotkeyDown());
		this.emit();
	}

	private paintStatus(): void {
		if (!this.statusBar) return;
		if (this.state.enabled) {
			this.statusBar.text = this.state.conversing ? '$(mic) Melissa, in ascolto' : '$(mic) Melissa';
			this.statusBar.tooltip = 'Melissa e\' accesa. Tap di Opzione+Spazio per conversare, tieni premuto per parlare una volta. Clic per spegnerla.';
		} else {
			this.statusBar.text = '$(mic-off) Melissa';
			this.statusBar.tooltip = 'Melissa e\' spenta. Clic per accenderla.';
		}
		this.statusBar.show();
	}

	/** Comando bottega.voice.toggle: interruttore generale di Melissa. */
	async toggle(): Promise<void> {
		this.state.enabled = !this.state.enabled;
		await vscode.workspace.getConfiguration('bottega').update('voice.enabled', this.state.enabled, vscode.ConfigurationTarget.Global);
		if (!this.state.enabled) {
			this.stopConversation();
			this.deps.nucleo.fireAndForget('voice.stop');
			this.deps.nucleo.fireAndForget('orb.hide');
			this.setState('idle');
		}
		this.paintStatus();
		this.emit();
	}

	// ----- scorciatoia: tap = conversazione on/off, tieni premuto = parla una volta -----

	private onHotkeyDown(): void {
		if (!this.state.enabled) return;
		this.hotkeyDownAt = Date.now();
		if (this.state.conversing) return; // mic gia' aperto: decido al rilascio (tap = spegni)
		clearTimeout(this.orbHideTimer);
		this.pushStarted = true;
		this.awaitingPushFinal = true;
		clearTimeout(this.pushFinalTimer);
		this.deps.nucleo.fireAndForget('orb.show');
		this.deps.nucleo.fireAndForget('orb.state', { state: 'listening' });
		this.setState('listening');
		this.deps.nucleo.fireAndForget('voice.listen', { mode: 'push' });
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
			if (this.state.conversing) this.stopConversation();
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
		this.state.conversing = true;
		this.deps.nucleo.fireAndForget('orb.show');
		this.deps.nucleo.fireAndForget('orb.state', { state: 'listening' });
		this.deps.nucleo.fireAndForget('voice.converse.start', { model: this.model(), locale: 'it-IT' });
		this.setState('listening');
		this.paintStatus();
		this.armSilence();
	}

	private stopConversation(): void {
		if (!this.state.conversing) return;
		this.state.conversing = false;
		clearTimeout(this.silenceTimer);
		// Chiusa vuol dire chiusa: si ferma anche la risposta in corso e la sua voce.
		this.currentAbort?.abort();
		this.deps.nucleo.fireAndForget('voice.stopSpeaking');
		this.deps.nucleo.fireAndForget('voice.converse.stop');
		this.out.info('conversazione chiusa');
		this.deps.nucleo.fireAndForget('orb.state', { state: 'idle' });
		this.deps.nucleo.fireAndForget('orb.hide');
		this.setState('idle');
		this.paintStatus();
	}

	private armSilence(): void {
		clearTimeout(this.silenceTimer);
		this.silenceTimer = setTimeout(() => this.stopConversation(), SILENCE_MS);
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
		this.out.info(`frase (${mode ?? '?'}): "${text}"`);
		if (this.state.conversing) {
			this.armSilence();
			if (isEndWord(text)) {
				await this.sayFull('A dopo.', true);
				this.stopConversation();
				return;
			}
		}
		await this.turn(text, this.state.enabled && this.deps.nucleo.available);
	}

	/** Domanda scritta dalla plancia: stesso cervello, parlata solo se la voce e' accesa. */
	async ask(text: string): Promise<string> {
		return this.turn(text, this.state.enabled && this.deps.nucleo.available);
	}

	async turn(userText: string, speak: boolean): Promise<string> {
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
		this.deps.nucleo.fireAndForget('orb.state', { state: 'thinking' });
		if (speak) this.beginSpeech();

		try {
			const answer = await this.runAgent(userText, speak, ac.signal);
			this.state.brain = 'agnes';
			if (speak) this.finalizeSpeech(true);
			this.recordAnswer(answer);
			this.afterTurn(speak);
			return answer;
		} catch (e) {
			if (ac.signal.aborted) {
				// barge-in: chiudo senza "final" (la voce e' gia' stata fermata dal Nucleo)
				this.speaking = false;
				this.markInterrupted(this.turnText);
				return this.turnText;
			}
			// Agnes a terra: ripiego su Apple Intelligence, senza tool.
			const fb = await this.appleFallback(userText);
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
		if (this.pending && speak && !this.state.conversing) {
			// azione a rischio: resto in ascolto per il si/no
			this.setState('listening');
			this.deps.nucleo.fireAndForget('orb.state', { state: 'listening' });
			this.deps.nucleo.fireAndForget('voice.listen', { mode: 'utterance' });
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
		this.chunker = new ClauseChunker();
		this.firstSpeakChunk = true;
	}
	private feedSpeak(text: string): void {
		if (!this.speaking) return;
		for (const clause of this.chunker.push(text)) this.emitClause(clause);
	}
	private emitClause(clause: string): void {
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
		if (sendFinal) this.deps.nucleo.fireAndForget('voice.speak', { final: true });
		this.speaking = false;
		if (this.state.conversing) {
			this.setState('listening');
			this.deps.nucleo.fireAndForget('orb.state', { state: 'listening' });
		} else {
			this.setState('idle');
			this.deps.nucleo.fireAndForget('orb.state', { state: 'idle' });
			clearTimeout(this.orbHideTimer);
			this.orbHideTimer = setTimeout(() => this.deps.nucleo.fireAndForget('orb.hide'), 4000);
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

	async runAgent(userText: string, speak: boolean, signal: AbortSignal): Promise<string> {
		const messages: LlmMessage[] = [
			{ role: 'system', content: this.systemPrompt() },
			...this.history,
			{ role: 'user', content: userText },
		];
		this.history.push({ role: 'user', content: userText });
		this.trimHistory();

		const stream = this.deps.stream ?? ((m, t, cb, sig) => this.callAgnesStream(m, t, cb, sig));

		for (let step = 0; step < 8; step++) {
			if (signal.aborted) throw abortError();
			let content = '';
			const calls = new Map<number, { id: string; name: string; args: string }>();

			await stream(messages, this.specs, (d: LlmDelta) => {
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

			if (calls.size) {
				const toolCalls: LlmToolCall[] = [...calls.entries()]
					.sort((a, b) => a[0] - b[0])
					.map(([, c]) => ({ id: c.id || `call_${c.name}`, type: 'function', function: { name: c.name, arguments: c.args } }));
				messages.push({ role: 'assistant', content: content || '', tool_calls: toolCalls });
				for (const tc of toolCalls) {
					if (signal.aborted) throw abortError(); // tool non ancora partito: niente effetti
					const result = await this.runTool(tc, speak, signal);
					messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result });
				}
				continue;
			}
			return content.trim() || this.turnText.trim() || 'Non ho niente da dirti.';
		}
		return (this.turnText.trim() || 'Mi sono incartata tra i passaggi, ridimmi cosa ti serve.');
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
			? live.map(s => `${s.title ?? s.name} in ${path.basename(s.cwd)} (${s.status === 'busy' ? 'al lavoro' : s.status})`).join('; ')
			: 'nessuna';
		const jobLine = jobs.length ? jobs.map(j => `${j.project}: ${j.status}`).join('; ') : 'nessuno';
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
		const body = JSON.stringify({ model: AGNES_MODEL, messages, tools, tool_choice: 'auto', reasoning_effort: 'none', stream: true });
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
				throw new Error('Rete giu\' verso Agnes.');
			}
			if (res.status === 429) {
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

	private async appleFallback(userText: string): Promise<string | null> {
		if (!this.deps.nucleo.available) return null;
		try {
			const r = await this.deps.nucleo.request<{ text: string }>('ai.generate', {
				prompt: userText,
				instructions: MELISSA_CORE + '\n\nAgnes e\' a terra: rispondi col cervello di riserva sul dispositivo, senza strumenti, e dillo in mezza frase. Massimo tre frasi.',
				maxTokens: 300,
			}, 20_000);
			const text = (r?.text || '').trim();
			if (!text) return null;
			return 'Agnes e\' a terra, rispondo col cervello di riserva. ' + text;
		} catch {
			return null;
		}
	}
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
