/* I due cervelli di Melissa: Agnes (in rete, il principale) e Apple Intelligence sul Mac (gratis, privato,
   senza rete), questo ora CON gli strumenti: il Nucleo trasforma le ToolSpec in Tool di FoundationModels e,
   quando il modello ne chiama uno, lo chiede a noi con l'evento `tool.call`; noi lo eseguiamo con lo stesso
   `runTool` di Melissa (stesse conferme per le azioni a rischio) e rispondiamo con `tool.result`.
   Contratto: docs/CONTRATTI.md, sezione 7.1.

   Chi decide (BrainRouter):
   - `agnes` / `apple`: forzati dall'impostazione bottega.melissa.cervello;
   - `auto` (scelta di Andrea, 2 ottobre 2026): Agnes sempre, finche' risponde. Apple Intelligence entra solo
     come riserva quando Agnes non risponde (429, rete, 5xx): subito, con gli strumenti, e per 2 minuti i turni
     vanno diretti al Mac (interruttore), niente piu' attese cieche. Senza Apple Intelligence, Agnes comunque.
   Melissa dice quale cervello usa solo quando cambia. Niente vscode qui dentro: si prova da Node. */

export type BrainName = 'agnes' | 'apple';
export type BrainMode = 'auto' | 'agnes' | 'apple';

export interface ToolSpecLike {
	type: 'function';
	function: { name: string; description: string; parameters: any };
}

export interface NucleoBridge {
	readonly available: boolean;
	request<T = any>(cmd: string, args?: Record<string, any>, timeoutMs?: number): Promise<T>;
	fireAndForget(cmd: string, args?: Record<string, any>): void;
	on(event: string, handler: (...a: any[]) => void): any;
	off?(event: string, handler: (...a: any[]) => void): any;
	removeListener?(event: string, handler: (...a: any[]) => void): any;
}

/** Gli strumenti che Apple riceve, in ordine di importanza (il Nucleo toglie dalla coda se il contesto non basta). */
export const APPLE_TOOLS = [
	'progetti_cerca', 'progetto_stato', 'lavori_elenco', 'sessioni_attive', 'progetto_apri',
	'lavoro_nuovo', 'memoria_cerca', 'stanza_leggi', 'regole_controlla', 'briefing', 'stanza_mostra', 'plancia_mostra',
	'sistema_stato', 'git_spingi', 'lavoro_ferma', 'memoria_ricorda', 'guarda_schermo',
];

export function appleToolSpecs(all: ToolSpecLike[]): ToolSpecLike[] {
	const byName = new Map(all.map(t => [t.function.name, t]));
	return APPLE_TOOLS.map(n => byName.get(n)).filter((t): t is ToolSpecLike => !!t);
}

/** Errori di Agnes che aprono l'interruttore: quota, rete, server. Non il barge-in. */
export function isAgnesOutage(e: any): boolean {
	const m = String(e?.message ?? e ?? '');
	if (/abort/i.test(m) || e?.name === 'AbortError') return false;
	return /429|quota|rate|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|rete|5\d\d|Nessuna chiave/i.test(m);
}

export class BrainRouter {
	private openUntil = 0;
	private last: BrainName | null = null;
	constructor(private readonly opts: { mode: () => BrainMode; appleAvailable: () => boolean; now?: () => number; breakerMs?: number }) {}

	private now(): number {
		return this.opts.now ? this.opts.now() : Date.now();
	}

	/** Agnes ha appena fallito: per un po' si va diretti sul Mac. */
	agnesFailed(e?: any): void {
		if (e === undefined || isAgnesOutage(e)) this.openUntil = this.now() + (this.opts.breakerMs ?? 120_000);
	}
	agnesOk(): void {
		this.openUntil = 0;
	}
	get breakerOpen(): boolean {
		return this.now() < this.openUntil;
	}

	choose(text: string): { brain: BrainName; why: 'forzato' | 'interruttore' | 'principale' | 'senza-apple' } {
		const mode = this.opts.mode();
		const apple = this.opts.appleAvailable();
		if (mode === 'agnes') return { brain: 'agnes', why: 'forzato' };
		if (mode === 'apple') return apple ? { brain: 'apple', why: 'forzato' } : { brain: 'agnes', why: 'senza-apple' };
		if (!apple) return { brain: 'agnes', why: 'senza-apple' };
		if (this.breakerOpen) return { brain: 'apple', why: 'interruttore' };
		void text; // le domande brevi non contano piu': Agnes finche' risponde (scelta di Andrea)
		return { brain: 'agnes', why: 'principale' };
	}

	/** La mezza frase da dire quando il cervello cambia davvero, altrimenti null. */
	announce(brain: BrainName, why: string): string | null {
		const prev = this.last;
		this.last = brain;
		if (prev === null || prev === brain) return null;
		return brain === 'apple'
			? (why === 'forzato' ? 'Ti rispondo col cervello del Mac.' : 'Agnes non risponde, ti rispondo dal Mac.')
			: 'Agnes e\' tornata.';
	}
}

// ---------- il turno con Apple Intelligence e gli strumenti ----------

export interface AppleTurn {
	instructions: string;
	prompt: string;
	history: { role: 'user' | 'assistant'; content: string }[];
	tools: ToolSpecLike[];
	/** Esegue uno strumento di Melissa: torna il testo da dare al modello. */
	exec(name: string, argsJson: string): Promise<string>;
	onDelta?(text: string): void;
	signal?: AbortSignal;
	maxTokens?: number;
	timeoutMs?: number;
}

export interface AppleResult {
	text: string;
	toolCalls: { name: string; args: any }[];
	ms: number;
	dropped?: string[];
}

let seq = 0;

export async function runAppleTurn(nucleo: NucleoBridge, t: AppleTurn): Promise<AppleResult> {
	if (!nucleo.available) throw new Error('Il Nucleo non c\'e\': niente cervello del Mac.');
	const req = `m${Date.now().toString(36)}${(++seq).toString(36)}`;
	const off = (ev: string, h: (...a: any[]) => void) => (nucleo.off ?? nucleo.removeListener)?.call(nucleo, ev, h);

	const onDelta = (m: any) => {
		if (m?.req === req && typeof m.text === 'string' && m.text) t.onDelta?.(m.text);
	};
	const onTool = async (m: any) => {
		if (m?.req !== req) return;
		let result: string;
		try {
			result = t.signal?.aborted ? 'Turno interrotto.' : await t.exec(String(m.name), JSON.stringify(m.args ?? {}));
		} catch (e: any) {
			result = `Lo strumento ${m.name} ha dato errore: ${e?.message ?? e}.`;
		}
		nucleo.fireAndForget('tool.result', { call: m.call, result });
	};
	const onAbort = () => nucleo.fireAndForget('ai.cancel', { req });

	nucleo.on('ai.delta', onDelta);
	nucleo.on('tool.call', onTool);
	t.signal?.addEventListener('abort', onAbort, { once: true });
	try {
		const r = await nucleo.request<AppleResult>('ai.agent', {
			req,
			instructions: t.instructions,
			prompt: t.prompt,
			history: t.history.slice(-6),
			tools: t.tools,
			maxTokens: t.maxTokens ?? 350,
		}, t.timeoutMs ?? 90_000);
		if (t.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
		return { text: String(r?.text ?? '').trim(), toolCalls: r?.toolCalls ?? [], ms: Number(r?.ms ?? 0), dropped: r?.dropped };
	} finally {
		off('ai.delta', onDelta);
		off('tool.call', onTool);
		t.signal?.removeEventListener('abort', onAbort);
	}
}

/** Istruzioni per il modello piccolo: la persona di Melissa compressa, le regole che contano, e niente
 *  markdown (la risposta si dice a voce). Il contesto del Mac e' di circa 4000 token. */
export function appleInstructions(core: string, live: string): string {
	const short = core.length > 900 ? core.slice(0, 900).replace(/\s+\S*$/, '') + '.' : core;
	return [
		short,
		'Sei il cervello di riserva sul Mac di Andrea. Rispondi in italiano, al massimo tre frasi brevi, senza elenchi ne\' markdown: la risposta viene detta a voce.',
		'Non inventare mai lo stato di progetti, lavori o sessioni: chiama lo strumento giusto e riporta solo quello che torna.',
		'Per push e per fermare un lavoro lo strumento chiede conferma: riferisci la domanda e aspetta il si.',
		live,
	].join('\n');
}

// ---------- Apple come provider OpenAI (selettore dei cervelli) ----------
//
// Stessa forma di Agnes e DeepSeek: messaggi e strumenti OpenAI dentro, testo in streaming e
// tool_calls fuori, un passo per chiamata. Dietro c'e' UNA sessione FoundationModels per turno: quando il
// modello chiama uno strumento, il passo finisce con la tool_call (il Nucleo resta in attesa); al passo dopo
// il messaggio `tool` con lo stesso tool_call_id diventa `tool.result` e la stessa sessione riprende.

export interface OpenAiDelta {
	content?: string;
	tool_call?: { index: number; id?: string; name?: string; arguments?: string };
}
export type OpenAiStreamFn = (messages: any[], tools: ToolSpecLike[], onDelta: (d: OpenAiDelta) => void, signal: AbortSignal) => Promise<void>;
export type Effort = 'rapido' | 'normale' | 'profondo';

type Ev = { k: 'delta'; text: string } | { k: 'tool'; call: string; name: string; args: any } | { k: 'end' } | { k: 'error'; e: any };

class AppleRun {
	readonly queue: Ev[] = [];
	private wake?: () => void;
	readonly waitingCalls = new Set<string>();
	constructor(readonly req: string) {}
	push(e: Ev): void {
		this.queue.push(e);
		this.wake?.();
	}
	next(): Promise<Ev> {
		const e = this.queue.shift();
		if (e) return Promise.resolve(e);
		return new Promise(res => (this.wake = () => ((this.wake = undefined), res(this.queue.shift()!))));
	}
}

export function appleOpenAiStream(nucleo: NucleoBridge, opts: { effort?: () => Effort; timeoutMs?: number } = {}): OpenAiStreamFn {
	let run: AppleRun | undefined;
	nucleo.on('ai.delta', (m: any) => run && m?.req === run.req && m.text && run.push({ k: 'delta', text: String(m.text) }));
	nucleo.on('tool.call', (m: any) => {
		if (!run || m?.req !== run.req) return;
		run.waitingCalls.add(String(m.call));
		run.push({ k: 'tool', call: String(m.id ?? m.call), name: String(m.name), args: m.args ?? {} });
	});

	return async (messages, tools, onDelta, signal) => {
		const trailingTools: any[] = [];
		for (let i = messages.length - 1; i >= 0 && messages[i].role === 'tool'; i--) trailingTools.unshift(messages[i]);
		const resumes = !!run && trailingTools.length > 0 && trailingTools.every(t => run!.waitingCalls.has(String(t.tool_call_id)));

		if (resumes) {
			for (const t of trailingTools) {
				run!.waitingCalls.delete(String(t.tool_call_id));
				nucleo.fireAndForget('tool.result', { call: t.tool_call_id, result: String(t.content ?? '') });
			}
		} else {
			if (run) nucleo.fireAndForget('ai.cancel', { req: run.req });
			const r = new AppleRun(`m${Date.now().toString(36)}${(++seq).toString(36)}`);
			run = r;
			nucleo.request('ai.agent', { req: r.req, messages, tools, effort: opts.effort?.() ?? 'normale' }, opts.timeoutMs ?? 120_000)
				.then(() => r.push({ k: 'end' }), e => r.push({ k: 'error', e }));
		}

		const cur = run!;
		const onAbort = () => {
			nucleo.fireAndForget('ai.cancel', { req: cur.req });
			cur.push({ k: 'error', e: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
		};
		signal.addEventListener('abort', onAbort, { once: true });
		try {
			for (;;) {
				const e = await cur.next();
				if (e.k === 'delta') onDelta({ content: e.text });
				else if (e.k === 'tool') {
					// le chiamate gia' arrivate insieme escono nello stesso passo
					let index = 0;
					onDelta({ tool_call: { index: index++, id: e.call, name: e.name, arguments: JSON.stringify(e.args) } });
					while (cur.queue[0]?.k === 'tool') {
						const t = cur.queue.shift() as Extract<Ev, { k: 'tool' }>;
						onDelta({ tool_call: { index: index++, id: t.call, name: t.name, arguments: JSON.stringify(t.args) } });
					}
					return; // la sessione resta viva: il prossimo passo porta il risultato
				} else if (e.k === 'end') {
					if (run === cur) run = undefined;
					return;
				} else {
					if (run === cur) run = undefined;
					throw e.e;
				}
			}
		} finally {
			signal.removeEventListener('abort', onAbort);
		}
	};
}
