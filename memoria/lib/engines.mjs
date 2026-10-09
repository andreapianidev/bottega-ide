// I motori dei riassunti: DeepSeek e riserva Apple Intelligence sul Mac (Nucleo).
// Agnes ritirato il 9 ottobre 2026; dati e credenziali storici restano conservati.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BOTTEGA_HOME, HOME, log } from './paths.mjs';

// ---- Nucleo -----------------------------------------------------------------------------

export function nucleoPath() {
	const candidates = [process.env.BOTTEGA_NUCLEO, path.join(BOTTEGA_HOME, 'bin', 'nucleo'), path.join(HOME, '.bottega', 'bin', 'nucleo')];
	for (const c of candidates) {
		if (!c) continue;
		try {
			fs.accessSync(c, fs.constants.X_OK);
			return c;
		} catch {
			// non c'e' o non e' eseguibile
		}
	}
	return undefined;
}

const unavailable = new Set();

function nucleo(args, input, timeoutMs) {
	const bin = nucleoPath();
	if (!bin) return { code: -1, stdout: '' };
	const r = spawnSync(bin, ['--cli', ...args], { input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
	if (r.error) {
		log(`nucleo ${args[0]}: ${r.error.message}`);
		return { code: -1, stdout: '' };
	}
	return { code: r.status ?? -1, stdout: r.stdout || '' };
}

/** Testo generato da Apple Intelligence, oppure undefined se non c'e'. */
export function appleGenerate(instructions, text) {
	if (unavailable.has('generate')) return undefined;
	const r = nucleo(['generate', '--instructions', instructions], text, 120_000);
	if (r.code === 2) {
		unavailable.add('generate');
		return undefined;
	}
	if (r.code !== 0 || !r.stdout.trim()) {
		if (r.code !== -1) log(`apple generate: uscita ${r.code}`);
		if (r.code === -1) unavailable.add('generate');
		return undefined;
	}
	return r.stdout.trim();
}

/** Vettori di frase (NLEmbedding), uno per testo; undefined se il Nucleo non c'e'. */
export function embed(texts) {
	if (!texts.length || unavailable.has('embed')) return undefined;
	const input = texts.map(t => String(t).replace(/\s+/g, ' ').slice(0, 2000)).join('\n') + '\n';
	const r = nucleo(['embed'], input, 30_000);
	if (r.code !== 0) {
		if (r.code === 2 || r.code === -1) unavailable.add('embed');
		return undefined;
	}
	try {
		const d = JSON.parse(r.stdout);
		if (Array.isArray(d.vectors) && d.vectors.length === texts.length) return d.vectors;
	} catch {
		// uscita non valida
	}
	return undefined;
}

export function embedAvailable() {
	return !!nucleoPath() && !unavailable.has('embed');
}

// ---- DeepSeek ---------------------------------------------------------------------------

// deepseek-flash e' DeepSeek V4.1 Flash (GET /models, 3/10/2026, vedi cervelli.ts). Stessa chiave del
// cervello della Bottega: DEEPSEEK_API_KEY o ~/.secrets/deepseek-harness.env.
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_MODEL = 'deepseek-flash';
/** Provider/rete temporaneamente indisponibile: il lavoro resta nella coda durevole. */
export class RetryableGenerationError extends Error {}
const DEEPSEEK_PAUSE_MS = 60 * 60_000; // un 401/402 (chiave o credito) lo mette da parte per un'ora

export function deepseekKey() {
	if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
	try {
		const raw = fs.readFileSync(path.join(HOME, '.secrets', 'deepseek-harness.env'), 'utf8');
		const m = /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*["']?([^"'\s#]+)/m.exec(raw);
		return m?.[1];
	} catch {
		return undefined;
	}
}

/** Il motore scelto per i riassunti: 'deepseek' (predefinito) o 'apple'. Lo scrive `cli.mjs motore`. */
export function chosenEngine(store) {
	return store.meta('motore_riassunti') === 'apple' ? 'apple' : 'deepseek';
}

/** DeepSeek si puo' usare adesso: c'e' la chiave e non e' in pausa dopo un 401/402. */
export function deepseekUsable(store) {
	return !!deepseekKey() && Date.now() >= Number(store.meta('deepseek_blocked_until') || 0);
}

/** Una chiamata a DeepSeek Flash con poco ragionamento: legge meglio i dettagli tecnici. Ritorna il testo o lancia. */
export async function deepseekGenerate(store, instructions, text, { maxTokens = 3000 } = {}) {
	const key = deepseekKey();
	if (!key) throw new Error('chiave DeepSeek assente');
	let res;
	try {
		res = await fetch(DEEPSEEK_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
			body: JSON.stringify({
				model: DEEPSEEK_MODEL,
				reasoning_effort: 'low',
				temperature: 0.2,
				max_tokens: maxTokens,
				messages: [
					{ role: 'system', content: instructions },
					{ role: 'user', content: text },
				],
			}),
			signal: AbortSignal.timeout(120_000),
		});
	} catch (e) {
		throw new RetryableGenerationError(`DeepSeek non raggiungibile: ${e?.name === 'TimeoutError' ? 'tempo scaduto' : e?.message}`);
	}
	if (res.status === 401 || res.status === 402) {
		store.meta('deepseek_blocked_until', Date.now() + DEEPSEEK_PAUSE_MS);
		log(`deepseek ${res.status}: ${res.status === 402 ? 'credito finito' : 'chiave rifiutata'}, un'ora sulla riserva locale`);
		throw new RetryableGenerationError(`DeepSeek HTTP ${res.status}`);
	}
	if (!res.ok) {
		const body = (await res.text().catch(() => '')).slice(0, 200).replace(key, '[chiave]');
		const Failure = res.status === 408 || res.status === 429 || res.status >= 500 ? RetryableGenerationError : Error;
		throw new Failure(`DeepSeek HTTP ${res.status}: ${body}`);
	}
	let d;
	try { d = await res.json(); } catch { throw new RetryableGenerationError('DeepSeek: risposta non valida'); }
	const out = d?.choices?.[0]?.message?.content;
	if (!out || !String(out).trim()) throw new RetryableGenerationError('DeepSeek: risposta vuota');
	return String(out).trim();
}

// Compatibilita' di import per tool precedenti; le chiavi e i dati storici restano intatti.
export function agnesKey() { return undefined; }
export class RateLimited extends Error {}
export async function agnesGenerate() {
	throw new Error('Agnes e stato ritirato: usa DeepSeek o Apple Intelligence.');
}
