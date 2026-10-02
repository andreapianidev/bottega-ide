// La ricerca per significato della Memoria, versione nativa (Apple Intelligence + Neural Engine sul Mac):
//   1. espansione della domanda: FoundationModels guidato (`nucleo --cli expand`): sinonimi, sigle, it/en, max 6;
//   2. bm25 (FTS5) sulla domanda e, a parte, sui termini espansi;
//   3. embedding contestuale (NLContextualEmbedding) della domanda contro riassunti, fatti e decisioni;
//   4. fusione delle classifiche con Reciprocal Rank Fusion (k = 60);
//   5. riordino dei primi 20 con FoundationModels guidato (`nucleo --cli rerank`, punteggio 0-3), entro 1,5 s,
//      altrimenti resta l'ordine della fusione.
// Il modello del Mac sta in un processo figlio lungo (NucleoFiglio), caldo tra una ricerca e l'altra:
// l'avvio a freddo di FoundationModels non si paga a ogni domanda.
// Misurata da memoria/test/valuta-ricerca.mjs sulle stesse domande della ricerca di prima.
import { spawn } from 'node:child_process';
import { openStore, blobToVec } from './store.mjs';
import { nucleoPath } from './engines.mjs';
import { embedCtx } from './contestuale.mjs';

export const RRF_K = 60;
const KIND_WEIGHT = { prompt: 0.7, riassunto: 1, decisione: 1, fatto: 0.95, nota: 1.05 };

/** Fusione di classifiche (liste di id, la migliore prima): somma di 1/(k + posizione). */
export function rrf(lists, k = RRF_K) {
	const score = new Map();
	for (const list of lists) {
		list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
	}
	return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id, s]) => ({ id, s }));
}

/** Un figlio `nucleo --cli <cmd>` che risponde una riga per riga. Se muore o tace, si ripiega. */
export class NucleoFiglio {
	constructor(cmd, extra = []) {
		this.cmd = cmd;
		this.extra = extra;
		this.proc = undefined;
		this.buf = '';
		this.waiting = [];
		this.dead = false;
	}
	start() {
		if (this.proc || this.dead) return !!this.proc;
		const bin = nucleoPath();
		if (!bin) return (this.dead = true), false;
		const p = spawn(bin, ['--cli', this.cmd, ...this.extra], { stdio: ['pipe', 'pipe', 'ignore'] });
		p.stdout.setEncoding('utf8');
		p.stdout.on('data', chunk => {
			this.buf += chunk;
			let i;
			while ((i = this.buf.indexOf('\n')) >= 0) {
				const line = this.buf.slice(0, i);
				this.buf = this.buf.slice(i + 1);
				const w = this.waiting.shift();
				if (!w) continue;
				clearTimeout(w.t);
				try {
					w.res(JSON.parse(line));
				} catch {
					w.res(undefined);
				}
			}
		});
		const down = code => {
			if (code === 2 || code === 64) this.dead = true; // Apple Intelligence assente o Nucleo vecchio
			this.proc = undefined;
			for (const w of this.waiting.splice(0)) (clearTimeout(w.t), w.res(undefined));
		};
		p.on('exit', down);
		p.on('error', () => down(64));
		p.stdin.on('error', () => undefined);
		this.proc = p;
		return true;
	}
	/** Una richiesta, una riga di risposta; undefined dopo `timeoutMs` (e il figlio si ricrea alla prossima). */
	ask(obj, timeoutMs) {
		if (!this.start()) return Promise.resolve(undefined);
		return new Promise(res => {
			const w = { res, t: setTimeout(() => {
				const k = this.waiting.indexOf(w);
				if (k >= 0) this.waiting.splice(k, 1);
				// risposta in ritardo: le righe successive sarebbero sfasate, meglio ricominciare
				try { this.proc?.kill(); } catch { /* gia' morto */ }
				res(undefined);
			}, timeoutMs) };
			this.waiting.push(w);
			this.proc.stdin.write((typeof obj === 'string' ? obj.replace(/\s+/g, ' ') : JSON.stringify(obj)) + '\n');
		});
	}
	close() {
		try { this.proc?.kill(); } catch { /* gia' morto */ }
		this.proc = undefined;
	}
}

let figli;
function nucleoFigli() {
	figli ??= { expand: new NucleoFiglio('expand'), rerank: new NucleoFiglio('rerank'), embed: new NucleoFiglio('embed-ctx', ['--righe']) };
	return figli;
}
export function chiudiFigli() {
	if (!figli) return;
	figli.expand.close();
	figli.rerank.close();
	figli.embed.close();
	figli = undefined;
}

let ctxCache;
function ctxVectors(store) {
	const n = Number(store.get('SELECT COUNT(*) AS n FROM vettori_ctx')?.n ?? 0);
	if (!ctxCache || ctxCache.n !== n) {
		const rows = store.all(`SELECT v.memoryId, v.vec, m.projectKey, m.project FROM vettori_ctx v JOIN memories m ON m.id = v.memoryId WHERE m.kind != 'prompt'`);
		ctxCache = { n, rows: rows.map(r => ({ id: Number(r.memoryId), vec: blobToVec(r.vec), key: r.projectKey, project: r.project })) };
	}
	return ctxCache.rows;
}

function dot(a, b) {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s; // vettori gia' normalizzati dal Nucleo (vDSP): coseno = prodotto scalare
}

/**
 * opts: { progetto, limite = 10, store, espandi = true, riordina = true, budgetMs = 1500, misura }
 * Torna gli item come search() di core.mjs, con `score` e `via` (cosa li ha trovati).
 */
export async function cercaNativa(query, opts = {}) {
	const { progetto, limite = 10, store = openStore(), espandi = true, riordina = true, budgetMs = 1500, misura } = opts;
	const t0 = Date.now();
	const tempi = {};
	const lists = [];

	const kwOrig = store.ftsSearch(query, { progetto, limite: 60 }).map(r => Number(r.id));
	lists.push(kwOrig);

	let termini = [];
	if (espandi) {
		const t = Date.now();
		const r = await nucleoFigli().expand.ask({ q: query }, 1200);
		tempi.espansione = Date.now() - t;
		termini = Array.isArray(r?.termini) ? r.termini.map(String).filter(Boolean).slice(0, 6) : [];
		if (termini.length) {
			const seen = new Set();
			const kwExp = [];
			for (const term of termini) {
				for (const row of store.ftsSearch(term, { progetto, limite: 20 })) {
					const id = Number(row.id);
					if (!seen.has(id)) (seen.add(id), kwExp.push(id));
				}
			}
			lists.push(kwExp.slice(0, 60));
		}
	}

	{
		const t = Date.now();
		const r = await nucleoFigli().embed.ask(query, 3000);
		const qv = Array.isArray(r?.vector) ? r.vector : embedCtx([query])?.[0];
		tempi.vettore = Date.now() - t;
		if (qv) {
			const q = Float32Array.from(qv);
			const filt = progetto ? String(progetto).toLowerCase() : null;
			const sims = [];
			for (const r of ctxVectors(store)) {
				if (filt && String(r.project).toLowerCase() !== filt && r.key !== filt) continue;
				sims.push([r.id, dot(q, r.vec)]);
			}
			sims.sort((a, b) => b[1] - a[1]);
			lists.push(sims.slice(0, 60).map(x => x[0]));
		}
	}

	let fused = rrf(lists);
	const rows = new Map();
	const row = id => {
		if (!rows.has(id)) rows.set(id, store.get('SELECT * FROM memories WHERE id = ?', id));
		return rows.get(id);
	};
	fused = fused.map(f => ({ ...f, s: f.s * (KIND_WEIGHT[row(f.id)?.kind] ?? 1) })).sort((a, b) => b.s - a.s);

	let via = 'rrf';
	if (riordina && fused.length > 1) {
		const top = fused.slice(0, 20);
		const left = Math.max(300, budgetMs - (Date.now() - t0));
		const t = Date.now();
		const r = await nucleoFigli().rerank.ask({
			q: query,
			candidates: top.map(f => {
				const m = row(f.id);
				return { id: String(f.id), text: `${m?.title ?? ''}. ${m?.text ?? ''}`.replace(/\s+/g, ' ').slice(0, 300) };
			}),
			timeoutMs: left,
		}, left + 300);
		tempi.riordino = Date.now() - t;
		if (r?.completo && r.punteggi) {
			via = 'riordino';
			const pos = new Map(top.map((f, i) => [f.id, i]));
			const scored = top.map(f => ({ ...f, p: Number(r.punteggi[String(f.id)] ?? -1) }));
			// prima il punteggio del modello, a parita' l'ordine della fusione
			scored.sort((a, b) => b.p - a.p || pos.get(a.id) - pos.get(b.id));
			fused = [...scored, ...fused.slice(20)];
		}
	}
	tempi.totale = Date.now() - t0;
	if (misura) Object.assign(misura, { tempi, termini, via });

	return fused.slice(0, Math.max(1, Math.min(50, limite))).map(f => {
		const m = row(f.id);
		return {
			id: Number(m.id), kind: m.kind, project: m.project ?? 'home', projectPath: m.projectPath ?? '',
			sessionId: m.sessionId ?? '', title: m.title ?? '', text: m.text ?? '', createdAt: Number(m.createdAt),
			score: Math.round(f.s * 1000) / 1000, via,
		};
	});
}
