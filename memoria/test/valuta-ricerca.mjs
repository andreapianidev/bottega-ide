#!/usr/bin/env node
// Misura «dove l'ho gia' risolto?» prima e dopo: parole sole, parole + embedding di frase (com'era),
// parole + embedding contestuale, parole + tutti e due, e i due embedding da soli.
//
//   node memoria/test/valuta-ricerca.mjs [--domande ~/.bottega/valutazione-ricerca.json] [--json]
//
// Le domande stanno FUORI dal repository (parlano dei progetti veri): {"domande":[{"q","attesi":[id]}]}.
// Legge il database vero in sola lettura, tranne i vettori contestuali mancanti, che scrive
// (tabella vettori_ctx). Il Nucleo si sceglie con BOTTEGA_NUCLEO.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, blobToVec, cosine } from '../lib/store.mjs';
import { embed } from '../lib/engines.mjs';
import { embedCtx, embedCtxPending } from '../lib/contestuale.mjs';
import { cercaNativa, chiudiFigli } from '../lib/ricerca-nativa.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const file = opt('--domande', path.join(os.homedir(), '.bottega', 'valutazione-ricerca.json'));
const domande = JSON.parse(fs.readFileSync(file, 'utf8')).domande;
const store = openStore();

// Vettori contestuali che mancano: a pezzi da 48.
let t0 = Date.now();
let scritti = 0;
for (;;) {
	const n = embedCtxPending(store, 48);
	scritti += n;
	if (!n) break;
}
const tCtxIndex = Date.now() - t0;

const frase = new Map(store.all('SELECT memoryId, vec FROM vectors').map(r => [Number(r.memoryId), blobToVec(r.vec)]));
const ctx = new Map(store.all('SELECT memoryId, vec FROM vettori_ctx').map(r => [Number(r.memoryId), blobToVec(r.vec)]));
const kinds = new Map(store.all('SELECT id, kind FROM memories').map(r => [Number(r.id), r.kind]));
const weight = { prompt: 0.7, riassunto: 1, decisione: 1, fatto: 0.95, nota: 1.05 };

/** Somiglianze riscalate sul gruppo: 0 la mediana, 1 la migliore (i due modelli hanno scale diverse). */
function rescale(sims) {
	const v = [...sims.values()].sort((a, b) => a - b);
	if (!v.length) return sims;
	const med = v[Math.floor(v.length / 2)];
	const max = v[v.length - 1];
	const out = new Map();
	for (const [k, s] of sims) out.set(k, max > med ? Math.max(0, (s - med) / (max - med)) : 0);
	return out;
}

function sims(qv, table) {
	const q = Float32Array.from(qv);
	const out = new Map();
	for (const [id, v] of table) out.set(id, cosine(q, v));
	return out;
}

function rank({ kw, semA, semB, wKw = 0, wA = 0, wB = 0 }) {
	const ids = new Set([...kw.keys(), ...(semA?.keys() ?? []), ...(semB?.keys() ?? [])]);
	const out = [];
	for (const id of ids) {
		const s = wKw * (kw.get(id) ?? 0) + wA * (semA?.get(id) ?? 0) + wB * (semB?.get(id) ?? 0);
		if (s > 0) out.push([id, s * (weight[kinds.get(id)] ?? 1)]);
	}
	return out.sort((a, b) => b[1] - a[1]).map(x => x[0]);
}

const varianti = {
	'parole': r => rank({ kw: r.kw, wKw: 1 }),
	'parole + frase (com\'era)': r => rank({ kw: r.kw, semA: r.fraseRaw, wKw: 0.55, wA: 0.45 }),
	'parole + frase riscalata': r => rank({ kw: r.kw, semA: r.frase, wKw: 0.55, wA: 0.45 }),
	'parole + contestuale': r => rank({ kw: r.kw, semB: r.ctx, wKw: 0.55, wB: 0.45 }),
	'parole + frase + contestuale': r => rank({ kw: r.kw, semA: r.frase, semB: r.ctx, wKw: 0.45, wA: 0.25, wB: 0.3 }),
	'solo frase': r => rank({ kw: new Map(), semA: r.frase, wKw: 0, wA: 1 }),
	'solo contestuale': r => rank({ kw: new Map(), semB: r.ctx, wKw: 0, wB: 1 }),
};

const righe = [];
const tempi = { frase: 0, ctx: 0 };
for (const d of domande) {
	const fts = store.ftsSearch(d.q, { limite: 60 });
	const maxS = Math.max(1e-9, ...fts.map(r => -r.rank));
	const kw = new Map(fts.map(r => [Number(r.id), -r.rank / maxS]));
	t0 = Date.now();
	const fv = embed([d.q])?.[0];
	tempi.frase += Date.now() - t0;
	t0 = Date.now();
	const cv = embedCtx([d.q])?.[0];
	tempi.ctx += Date.now() - t0;
	// com'era: coseno grezzo, i ricordi fuori dalle parole entrano solo sopra 0,55
	const fraseRaw = new Map();
	if (fv) for (const [id, s] of sims(fv, frase)) if (kw.has(id) || s >= 0.55) fraseRaw.set(id, Math.max(0, s));
	const r = { kw, fraseRaw, frase: fv ? rescale(sims(fv, frase)) : new Map(), ctx: cv ? rescale(sims(cv, ctx)) : new Map() };
	righe.push({ d, r });
}

const risultati = {};
for (const [nome, fn] of Object.entries(varianti)) {
	let s1 = 0, s5 = 0, mrr = 0;
	const dettaglio = [];
	for (const { d, r } of righe) {
		const order = fn(r);
		const pos = order.findIndex(id => d.attesi.includes(id));
		if (pos === 0) s1++;
		if (pos >= 0 && pos < 5) s5++;
		if (pos >= 0) mrr += 1 / (pos + 1);
		dettaglio.push(pos < 0 ? null : pos + 1);
	}
	const n = righe.length;
	risultati[nome] = { successo1: s1 / n, successo5: s5 / n, mrr: mrr / n, posizioni: dettaglio };
}

// La ricerca nativa vera (quella che entrerebbe in core.mjs), in tre configurazioni.
const nativa = {
	'nativa: RRF parole + contestuale': { espandi: false, riordina: false },
	'nativa: + espansione': { espandi: true, riordina: false },
	'nativa: + espansione + riordino': { espandi: true, riordina: true },
	'tetto: RRF + riordino migliori 8 s': { espandi: false, riordina: true, budgetMs: 8000 },
	'tetto: RRF + riordino punteggi 12 s': { espandi: false, riordina: true, budgetMs: 12000, forma: 'punteggi' },
};
const latenze = {};
for (const [nome, o] of Object.entries(nativa)) {
	let s1 = 0, s5 = 0, mrr = 0;
	const dettaglio = [];
	const ms = [];
	let riordinate = 0;
	// un giro a vuoto per scaldare i figli del Nucleo (come succede nel server MCP, che resta acceso)
	await cercaNativa(righe[0].d.q, { ...o, store, limite: 20 });
	for (const { d } of righe) {
		const m = {};
		const items = await cercaNativa(d.q, { ...o, store, limite: 20, misura: m });
		ms.push(m.tempi.totale);
		if (m.via === 'riordino') riordinate++;
		const pos = items.findIndex(it => d.attesi.includes(it.id));
		if (pos === 0) s1++;
		if (pos >= 0 && pos < 5) s5++;
		if (pos >= 0) mrr += 1 / (pos + 1);
		dettaglio.push(pos < 0 ? null : pos + 1);
	}
	const n = righe.length;
	ms.sort((a, b) => a - b);
	risultati[nome] = { successo1: s1 / n, successo5: s5 / n, mrr: mrr / n, posizioni: dettaglio };
	latenze[nome] = { mediana: ms[Math.floor(n / 2)], massimo: ms[n - 1], riordinate };
}
chiudiFigli();

const report = {
	latenze,
	domande: righe.length,
	ricordiConFrase: frase.size,
	ricordiContestuali: ctx.size,
	vettoriContestualiScrittiOra: scritti,
	msIndicizzazioneContestuale: tCtxIndex,
	msPerDomanda: { frase: Math.round(tempi.frase / righe.length), contestuale: Math.round(tempi.ctx / righe.length) },
	risultati,
};
if (args.includes('--json')) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log(`${report.domande} domande, ${frase.size} ricordi con vettore di frase, ${ctx.size} con vettore contestuale`);
	console.log(`tempo per domanda: frase ${report.msPerDomanda.frase} ms, contestuale ${report.msPerDomanda.contestuale} ms (processo del Nucleo compreso)`);
	for (const [nome, v] of Object.entries(risultati)) {
		const l = latenze[nome] ? `  (${l2(latenze[nome])})` : '';
		console.log(`${nome.padEnd(36)} @1 ${(v.successo1 * 100).toFixed(0).padStart(3)}%  @5 ${(v.successo5 * 100).toFixed(0).padStart(3)}%  MRR ${v.mrr.toFixed(2)}  ${v.posizioni.map(p => p ?? '-').join(' ')}${l}`);
	}
}

function l2(l) {
	return `mediana ${l.mediana} ms, massimo ${l.massimo} ms, riordinate ${l.riordinate}`;
}
