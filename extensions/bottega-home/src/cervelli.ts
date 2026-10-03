/* I cervelli di Melissa: Agnes (predefinito, gratis), DeepSeek (a consumo, se ha credito), Apple Intelligence sul Mac
   (dal Nucleo, la riserva quando Agnes non risponde). Agnes e DeepSeek parlano l'API compatibile OpenAI con gli
   strumenti, in streaming: un solo client, con le differenze di ciascuno (url, chiave, modello, come si chiede
   l'impegno). La scelta e l'impegno si ricordano e si cambiano anche a voce.
   OpenRouter (Claude, Gemini, GPT a consumo) e' stato tolto il 3/10/2026: «Agnes e DeepSeek bastano e avanzano».
   Contratto: docs/CONTRATTI.md, sezione 6. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LlmDelta, LlmMessage, LlmStreamFn, ToolSpec } from './assistant';

export type Provider = 'agnes' | 'apple' | 'deepseek';
export type Effort = 'rapido' | 'normale' | 'profondo';

export interface BrainOption {
	provider: Provider;
	model: string;
	label: string;
	note: string;
	price?: { in: number; out: number };
	available: boolean;
	why?: string;
}

/** Un conto da mostrare nella barra: solo dati veri, con la loro fonte. */
export interface Account {
	id: 'agnes' | 'deepseek' | 'elevenlabs';
	label: string;
	text: string;
	tone: 'ok' | 'attesa' | 'male';
	/** vero quando il numero e' contato dalla Bottega e non letto dal servizio */
	local?: boolean;
}

export interface BrainState {
	current: { provider: Provider; model: string; label: string };
	effort: Effort;
	options: BrainOption[];
	accounts: Account[];
	checkedAt: number;
}

export interface Choice {
	provider: Provider;
	model: string;
	effort: Effort;
}

/** Dove si ricorda la scelta: il globalState dell'estensione (o un finto nei test). */
export interface Memento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void> | Promise<void> | void;
}

export interface CervelliOptions {
	memento: Memento;
	fetch?: typeof fetch;
	now?: () => number;
	secretsDir?: string;
	cacheFile?: string;
	appleAvailable?: () => boolean;
	/** Perche' Apple Intelligence non c'e', detto dal Nucleo. */
	appleReason?: () => string | undefined;
	usageFile?: string;
	log?: (s: string) => void;
}

/** Nel globalState si ricorda solo l'impegno: il cervello no (decisione di Andrea, 2 ottobre 2026: Agnes e' sempre il
 *  primario; un altro cervello vale per la conversazione in cui Andrea lo sceglie e poi si torna ad Agnes). */
const KEY = 'bottega.cervello.impegno';
const AGNES_DAY = 'bottega.agnes.oggi';
/** Una scelta manuale scade dopo 15 minuti senza domande. */
const TEMP_MS = 15 * 60_000;
const HOUR = 3_600_000;
const AGNES = { url: 'https://apihub.agnes-ai.com/v1/chat/completions', model: 'agnes-3.0-flash' };
/** DeepSeek (GET /models, 3/10/2026): deepseek-flash e' DeepSeek-V4.1-Flash, deepseek-v4-pro il modello grande; tutti e
 *  due con reasoning_effort. I nomi vecchi deepseek-chat e deepseek-reasoner portano a V4.1 Flash senza e con ragionamento:
 *  fino alla build 60 rapido e normale erano la stessa cosa e il Pro non si usava mai. */
const DEEPSEEK = { url: 'https://api.deepseek.com/chat/completions', fast: 'deepseek-flash', deep: 'deepseek-v4-pro' };
export const DEFAULT_CHOICE: Choice = { provider: 'agnes', model: AGNES.model, effort: 'normale' };

export class BrainError extends Error {
	constructor(readonly provider: Provider, readonly status: number, message: string) {
		super(message);
	}
}

/** Il corpo della richiesta per ogni provider, con l'impegno tradotto nel suo parametro. */
export function requestBody(c: Choice, messages: LlmMessage[], tools: ToolSpec[]): Record<string, unknown> {
	const body: Record<string, unknown> = { model: c.model, messages, stream: true };
	if (tools.length) {
		body.tools = tools;
		body.tool_choice = 'auto';
	}
	if (c.provider === 'agnes') body.reasoning_effort = c.effort === 'rapido' ? 'none' : c.effort === 'normale' ? 'low' : 'high';
	// DeepSeek: rapido V4.1 Flash senza ragionare, normale Flash con poco ragionamento, profondo V4 Pro a fondo
	if (c.provider === 'deepseek') {
		body.model = c.effort === 'profondo' ? DEEPSEEK.deep : DEEPSEEK.fast;
		body.reasoning_effort = c.effort === 'rapido' ? 'none' : c.effort === 'normale' ? 'low' : 'high';
	}
	return body;
}

/** Riconosce una richiesta a voce: «usa DeepSeek», «pensa piu' a fondo», «torna ad Agnes», «rispondi veloce». */
export function spokenChoice(text: string): { provider?: Provider; effort?: Effort } {
	const t = (text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
	const out: { provider?: Provider; effort?: Effort } = {};
	if (/\b(piu a fondo|ragiona bene|pensaci bene|profond|con calma)\b/.test(t)) out.effort = 'profondo';
	else if (/\b(veloce|rapid|in fretta|sbrigati)\b/.test(t)) out.effort = 'rapido';
	else if (/\b(normale|come prima)\b/.test(t)) out.effort = 'normale';
	if (/\bagnes\b/.test(t)) out.provider = 'agnes';
	else if (/\bapple\b|\bsul mac\b|\blocale\b/.test(t)) out.provider = 'apple';
	else if (/\bdeep ?seek\b/.test(t)) out.provider = 'deepseek';
	return out;
}

function readEnv(file: string): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
			const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
			if (m && !m[2].startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
		}
	} catch {
		// file assente
	}
	return out;
}

export class Cervelli {
	private readonly fetchFn: typeof fetch;
	private readonly now: () => number;
	private readonly secrets: string;
	private down = new Map<Provider, { until: number; why: string }>();
	private deepseekChecked = 0;
	private checkedAt = 0;
	/** Cervello scelto a mano per questa conversazione: solo in memoria, mai il nuovo predefinito. */
	private temp: { provider: Provider; model: string; until: number } | null = null;
	private agnesEvents: { at: number; status: number }[] = [];
	private balances: { at: number; deepseek?: number; deepseekOk?: boolean; elevenlabs?: number } | null = null;

	constructor(private readonly o: CervelliOptions) {
		this.fetchFn = o.fetch ?? fetch;
		this.now = o.now ?? Date.now;
		this.secrets = o.secretsDir ?? path.join(os.homedir(), '.secrets');
	}

	key(p: Provider): string | undefined {
		if (p === 'agnes') return process.env.AGNES_API_KEY || readEnv(path.join(this.secrets, 'agnes-ai.env')).AGNES_API_KEY;
		if (p === 'deepseek') return process.env.DEEPSEEK_API_KEY || readEnv(path.join(this.secrets, 'deepseek-harness.env')).DEEPSEEK_API_KEY;
		return undefined;
	}

	private effort(): Effort {
		const e = this.o.memento.get<Effort>(KEY);
		return e === 'rapido' || e === 'profondo' || e === 'normale' ? e : DEFAULT_CHOICE.effort;
	}

	/** Il cervello di adesso: Agnes, salvo una scelta manuale ancora valida per questa conversazione. */
	choice(): Choice {
		if (this.temp && this.temp.until > this.now()) return { provider: this.temp.provider, model: this.temp.model, effort: this.effort() };
		this.temp = null;
		return { ...DEFAULT_CHOICE, effort: this.effort() };
	}

	/** Scelta manuale: vale per questa conversazione (15 minuti senza domande al massimo), poi si torna ad Agnes. */
	async set(provider: Provider, model?: string): Promise<Choice> {
		if (provider === 'agnes') {
			this.temp = null;
			return this.choice();
		}
		const opts = await this.options();
		const opt = opts.find(o => o.provider === provider && (!model || o.model === model)) ?? opts.find(o => o.provider === provider);
		if (!opt) throw new Error(`Non conosco il cervello ${provider}.`);
		if (!opt.available) throw new Error(`${opt.label} adesso non è disponibile: ${opt.why ?? 'motivo sconosciuto'}.`);
		this.temp = { provider, model: opt.model, until: this.now() + TEMP_MS };
		return this.choice();
	}

	/** Una domanda con il cervello scelto a mano: la scelta dura altri 15 minuti. */
	touch(): void {
		if (this.temp) this.temp.until = this.now() + TEMP_MS;
	}

	/** Fine della conversazione: si torna ad Agnes. */
	endConversation(): void {
		this.temp = null;
	}

	async setEffort(effort: Effort): Promise<Choice> {
		await this.o.memento.update(KEY, effort);
		return this.choice();
	}

	/** Ogni richiesta ad Agnes dalla Bottega: stato HTTP (0 = rete giu'). Agnes non ha un endpoint di saldo:
	 *  la barra mostra se risponde, le richieste di oggi e i 429 recenti (limite di circa 20 al minuto). */
	noteAgnes(status: number): void {
		const now = this.now();
		this.agnesEvents = [...this.agnesEvents.filter(e => now - e.at < 15 * 60_000), { at: now, status }];
		const day = new Date(now).toISOString().slice(0, 10);
		const d = this.o.memento.get<{ day: string; n: number }>(AGNES_DAY);
		void this.o.memento.update(AGNES_DAY, { day, n: d?.day === day ? d.n + 1 : 1 });
	}

	/** Le richieste ad Agnes di oggi dalla Bottega (per il registro dei conti, src/conti.ts). */
	agnesOggi(): number {
		const d = this.o.memento.get<{ day: string; n: number }>(AGNES_DAY);
		return d?.day === new Date(this.now()).toISOString().slice(0, 10) ? d.n : 0;
	}

	private agnesAccount(): Account {
		const now = this.now();
		const day = new Date(now).toISOString().slice(0, 10);
		const d = this.o.memento.get<{ day: string; n: number }>(AGNES_DAY);
		const n = d?.day === day ? d.n : 0;
		const recent = this.agnesEvents.filter(e => now - e.at < 10 * 60_000);
		const limits = recent.filter(e => e.status === 429).length;
		const last = this.agnesEvents[this.agnesEvents.length - 1];
		const oggi = `${n === 1 ? 'una richiesta' : `${n} richieste`} oggi dalla Bottega`;
		if (last && (last.status === 0 || last.status >= 500) && now - last.at < 10 * 60_000) return { id: 'agnes', label: 'Agnes', text: `non risponde, ${oggi}`, tone: 'male', local: true };
		if (limits) return { id: 'agnes', label: 'Agnes', text: `al limite di circa 20 richieste al minuto (${limits === 1 ? 'un 429' : `${limits} 429`} negli ultimi 10 minuti), ${oggi}`, tone: 'attesa', local: true };
		return { id: 'agnes', label: 'Agnes', text: `gratis, nessun saldo da controllare; ${oggi}`, tone: 'ok', local: true };
	}

	/** Saldi veri dove il servizio li da': DeepSeek /user/balance; ElevenLabs solo il conteggio locale del Nucleo
	 *  (la chiave non puo' leggere l'account). Al massimo ogni 5 minuti. */
	private async otherBalances(): Promise<NonNullable<Cervelli['balances']>> {
		if (this.balances && this.now() - this.balances.at < 5 * 60_000) return this.balances;
		const b: NonNullable<Cervelli['balances']> = { at: this.now() };
		if (this.key('deepseek')) {
			try {
				const r = await this.fetchFn('https://api.deepseek.com/user/balance', { headers: { authorization: `Bearer ${this.key('deepseek')}` } });
				const j: any = r.ok ? await r.json() : null;
				const usd = j?.balance_infos?.find((x: any) => x.currency === 'USD') ?? j?.balance_infos?.[0];
				if (usd) b.deepseek = Number(usd.total_balance);
				if (j) {
					b.deepseekOk = !!j.is_available;
					if (!j.is_available) this.markDown('deepseek', 'senza credito');
				}
			} catch {
				// senza rete resta il dato di prima
				b.deepseek = this.balances?.deepseek;
			}
		}
		try {
			const u = JSON.parse(fs.readFileSync(this.o.usageFile ?? path.join(os.homedir(), '.bottega', 'nucleo', 'usage.json'), 'utf8'));
			const month = new Date(this.now()).toISOString().slice(0, 7);
			b.elevenlabs = Number(u?.elevenLabsCharsByMonth?.[month] ?? 0);
		} catch {
			// il Nucleo non ha ancora parlato
		}
		this.balances = b;
		return b;
	}

	/** I conti nella barra. Melissa pensa con Agnes, gratis (decisione di Andrea, 2 ottobre 2026): DeepSeek, a pagamento,
	 *  si vede solo mentre una conversazione lo sta usando; il suo credito sta sempre nel Cruscotto (src/conti.ts). */
	private async accounts(inUse: Provider): Promise<Account[]> {
		const out: Account[] = [this.agnesAccount()];
		const money = (n: number) => `${n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
		const b = await this.otherBalances();
		if (b.deepseek !== undefined && inUse === 'deepseek') out.push({ id: 'deepseek', label: 'DeepSeek', text: b.deepseekOk ? `restano ${money(b.deepseek)}` : `saldo ${money(b.deepseek)}: senza credito`, tone: b.deepseekOk ? 'ok' : 'male' });
		if (b.elevenlabs !== undefined) {
			const mese = new Date(this.now()).toLocaleDateString('it-IT', { month: 'long' });
			out.push({ id: 'elevenlabs', label: 'ElevenLabs', text: `${b.elevenlabs.toLocaleString('it-IT')} caratteri di voce a ${mese}, contati dalla Bottega`, tone: 'ok', local: true });
		}
		return out;
	}

	/** Un 401 o un 402 mette il cervello da parte per un'ora; si torna subito ad Agnes. */
	markDown(p: Provider, why: string): void {
		this.down.set(p, { until: this.now() + HOUR, why });
		if (this.temp?.provider === p) this.temp = null;
	}

	private isDown(p: Provider): string | undefined {
		const d = this.down.get(p);
		return d && d.until > this.now() ? d.why : undefined;
	}

	/** Tutte le opzioni, con disponibilita' e prezzi. Rete solo se la cache e' vecchia. */
	async options(): Promise<BrainOption[]> {
		const out: BrainOption[] = [];
		out.push({ provider: 'agnes', model: AGNES.model, label: 'Agnes 3.0 Flash', note: 'gratis', available: !!this.key('agnes') && !this.isDown('agnes'), why: !this.key('agnes') ? 'manca la chiave' : this.isDown('agnes') });
		out.push({ provider: 'apple', model: 'apple-on-device', label: 'Apple Intelligence', note: 'sul Mac', available: !!this.o.appleAvailable?.(), why: this.o.appleAvailable?.() ? undefined : (this.o.appleReason?.() ?? 'Apple Intelligence non risponde ancora dal Nucleo') });
		if (this.key('deepseek')) {
			await this.probeDeepseek();
			const why = this.isDown('deepseek');
			out.push({ provider: 'deepseek', model: DEEPSEEK.fast, label: 'DeepSeek V4.1 Flash', note: 'a consumo, a fondo V4 Pro', available: !why, ...(why ? { why } : {}) });
		}
		this.checkedAt = this.now();
		return out;
	}

	/** DeepSeek senza credito risponde 402 anche a una richiesta minima: si prova al massimo una volta all'ora. */
	private async probeDeepseek(): Promise<void> {
		if (this.now() - this.deepseekChecked < HOUR) return;
		this.deepseekChecked = this.now();
		try {
			const r = await this.fetchFn(DEEPSEEK.url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key('deepseek')}` },
				body: JSON.stringify({ model: DEEPSEEK.fast, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }),
			});
			if (r.status === 402) this.markDown('deepseek', 'senza credito');
			else if (r.status === 401) this.markDown('deepseek', 'chiave rifiutata');
		} catch {
			// senza rete non si decide niente
		}
	}

	async state(): Promise<BrainState> {
		const options = await this.options();
		let c = this.choice();
		let cur = options.find(o => o.provider === c.provider && o.model === c.model);
		if (!cur || !cur.available) {
			this.temp = null;
			c = this.choice();
			cur = options.find(o => o.provider === 'agnes');
		}
		return {
			current: { provider: c.provider, model: c.model, label: cur?.label ?? 'Agnes 3.0 Flash' },
			effort: c.effort,
			options,
			accounts: await this.accounts(c.provider),
			checkedAt: this.checkedAt,
		};
	}

	/** Lo stream per il cervello scelto (Apple escluso: passa dal Nucleo). Errori 401/402 mettono da parte il cervello. */
	streamFor(c: Choice = this.choice()): LlmStreamFn | undefined {
		if (c.provider === 'apple') return undefined;
		const url = c.provider === 'agnes' ? AGNES.url : DEEPSEEK.url;
		return async (messages, tools, onDelta, signal) => {
			const key = this.key(c.provider);
			if (!key) throw new BrainError(c.provider, 0, 'Manca la chiave.');
			const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
			const body = JSON.stringify(requestBody(c, messages, tools));
			let wait = 2000;
			for (let attempt = 0; attempt < 4; attempt++) {
				const res = await this.fetchFn(url, { method: 'POST', headers, body, signal }).catch(e => {
					if (c.provider === 'agnes' && e?.name !== 'AbortError') this.noteAgnes(0);
					throw e;
				});
				if (c.provider === 'agnes') this.noteAgnes(res.status);
				if (res.status === 429) {
					await new Promise(r => setTimeout(r, wait));
					wait = Math.min(wait * 2, 16_000);
					continue;
				}
				if (res.status === 402 || res.status === 401) {
					const why = res.status === 402 ? 'senza credito' : 'chiave rifiutata';
					this.markDown(c.provider, why);
					throw new BrainError(c.provider, res.status, why);
				}
				if (!res.ok || !res.body) throw new BrainError(c.provider, res.status, `risposta ${res.status}`);
				await readSse(res.body, onDelta);
				return;
			}
			throw new BrainError(c.provider, 429, 'troppe richieste');
		};
	}
}

/** Righe SSE compatibili OpenAI: testo e pezzi di chiamate agli strumenti. */
export async function readSse(body: ReadableStream<Uint8Array>, onDelta: (d: LlmDelta) => void): Promise<void> {
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
				for (const tc of delta.tool_calls) onDelta({ tool_call: { index: tc.index ?? 0, id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments } });
			}
		}
	}
}
