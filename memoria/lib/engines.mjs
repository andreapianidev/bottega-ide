// I motori: Apple Intelligence sul Mac (Nucleo) prima, Agnes AI solo se Apple non c'e'.
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

// ---- Agnes ------------------------------------------------------------------------------

const AGNES_URL = 'https://apihub.agnes-ai.com/v1/chat/completions';
const AGNES_MODEL = 'agnes-3.0-flash';
const PER_MINUTE = 6; // il piano gratuito (~20 al minuto) e' condiviso con le altre app di Andrea
const MIN_GAP_MS = 10_000;

export function agnesKey() {
	if (process.env.AGNES_API_KEY) return process.env.AGNES_API_KEY.trim();
	try {
		const raw = fs.readFileSync(path.join(HOME, '.secrets', 'agnes-ai.env'), 'utf8');
		const m = /^\s*(?:export\s+)?AGNES_API_KEY\s*=\s*["']?([^"'\s#]+)/m.exec(raw);
		return m?.[1];
	} catch {
		return undefined;
	}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Prenota un posto nel limite di Agnes, condiviso tra tutti i processi della Memoria tramite il
 * database. Ritorna false se l'attesa supererebbe `maxWaitMs`.
 */
async function reserve(store, maxWaitMs) {
	const deadline = Date.now() + maxWaitMs;
	for (;;) {
		const now = Date.now();
		const wait = store.tx(() => {
			store.run('DELETE FROM agnes_calls WHERE at < ?', now - 60_000);
			const blocked = Number(store.meta('agnes_blocked_until') || 0);
			if (blocked > now) return blocked - now;
			const rows = store.all('SELECT at FROM agnes_calls ORDER BY at ASC');
			const last = rows.length ? Number(rows[rows.length - 1].at) : 0;
			if (rows.length >= PER_MINUTE) return Number(rows[0].at) + 60_000 - now + 50;
			if (now - last < MIN_GAP_MS) return MIN_GAP_MS - (now - last);
			store.run('INSERT INTO agnes_calls(at) VALUES (?)', now);
			return 0;
		});
		if (wait <= 0) return true;
		if (Date.now() + wait > deadline) return false;
		await sleep(wait);
	}
}

export class RateLimited extends Error {}

/** Una chiamata ad Agnes con reasoning_effort "none". Ritorna il testo, oppure lancia. */
export async function agnesGenerate(store, instructions, text, { maxTokens = 1100, maxWaitMs = 10 * 60_000 } = {}) {
	const key = agnesKey();
	if (!key) throw new Error('chiave Agnes assente');
	if (!(await reserve(store, maxWaitMs))) throw new RateLimited('limite Agnes: troppa attesa');
	let res;
	try {
		res = await fetch(AGNES_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
			body: JSON.stringify({
				model: AGNES_MODEL,
				reasoning_effort: 'none',
				temperature: 0.2,
				max_tokens: maxTokens,
				messages: [
					{ role: 'system', content: instructions },
					{ role: 'user', content: text },
				],
			}),
			signal: AbortSignal.timeout(90_000),
		});
	} catch (e) {
		throw new Error(`Agnes non raggiungibile: ${e?.name === 'TimeoutError' ? 'tempo scaduto' : e?.message}`);
	}
	if (res.status === 429) {
		// Nessun Retry-After: si aspetta alla cieca, sempre di piu' finche' non passa.
		const streak = Number(store.meta('agnes_429_streak') || 0) + 1;
		const backoff = Math.min(10 * 60_000, 30_000 * 2 ** (streak - 1));
		store.meta('agnes_429_streak', streak);
		store.meta('agnes_blocked_until', Date.now() + backoff);
		log(`agnes 429: pausa di ${Math.round(backoff / 1000)} s`);
		throw new RateLimited('Agnes: troppe richieste (429)');
	}
	if (!res.ok) {
		const body = (await res.text().catch(() => '')).slice(0, 200).replace(key, '[chiave]');
		throw new Error(`Agnes HTTP ${res.status}: ${body}`);
	}
	store.meta('agnes_429_streak', 0);
	const d = await res.json();
	const out = d?.choices?.[0]?.message?.content;
	if (!out || !String(out).trim()) throw new Error('Agnes: risposta vuota');
	return String(out).trim();
}
