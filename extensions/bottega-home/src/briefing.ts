/* Il briefing del mattino e i consigli della Home.

   Tutti e due nascono dagli stessi fatti, raccolti qui senza inventare niente: ore e progetti di ieri (cruscotto),
   lavori che aspettano, novita' dallo Store, soldi di ieri, regole violate, progetti dimenticati, la notte, e gli
   appuntamenti di oggi se Google Calendar e' collegato in Claude Code (strumenti-connettori.ts ne e' la fonte).
   - Il briefing si fa una volta al giorno: Melissa lo scrive con la sua voce (Agnes, ripiego Apple Intelligence,
     ripiego frasi fisse) e lo dice in una trentina di secondi. Mai insistente: una volta, poi resta una card.
   - I consigli li scrive Apple Intelligence sul Mac (ai.generate del Nucleo), da 3 a 5 frasi; senza Apple
     Intelligence restano consigli fissi ricavati dalle regole.
   Contratto: docs/CONTRATTI.md, 4.1 (Briefing) e 4.7 (Advice). */

import type { BriefingAppStore } from './appstore';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Forgotten } from './dimenticati';
import type { Job } from './jobs';
import type { NightState } from './notte';
import type { RadarState, RulesState, RuleAction } from './tipi';
import type { Stats } from './stats';

export interface BriefingPoint {
	kind: 'ore' | 'lavori' | 'store' | 'soldi' | 'regole' | 'dimenticati' | 'notte' | 'calendario';
	text: string;
	act?: RuleAction;
}

export interface Briefing {
	date: string;
	at: number;
	text: string;
	points: BriefingPoint[];
	heard: boolean;
}

export interface Advice {
	at: number;
	engine: 'apple' | 'regole';
	items: { text: string; act?: RuleAction }[];
}

export interface Facts {
	stats?: Stats | null;
	jobs: Job[];
	radar?: RadarState | null;
	rules?: RulesState | null;
	forgotten: Forgotten[];
	night?: NightState | null;
	projects: { name: string; path: string }[];
	/** Stati delle versioni e recensioni gia' raccontati nel briefing precedente. */
	seen?: BriefingMemory;
	now?: number;
	/** Gli appuntamenti di oggi; assente = si chiede alla fonte registrata, null = nessuna riga. */
	calendario?: EventoCalendario[] | null;
	/** I soldi delle app dalla stanza App Store (src/appstore.ts, briefing()); se c'e' prende il posto della riga di AdMob. */
	appstore?: BriefingAppStore | null;
}

export interface EventoCalendario {
	/** "10:00" oppure "tutto il giorno". */
	ora: string;
	titolo: string;
}

/** Chi sa gli appuntamenti di oggi (strumenti-connettori.ts): deve rispondere subito, senza aspettare la rete. */
export type FonteCalendario = (now: number) => EventoCalendario[] | null;
let fonteCalendario: FonteCalendario | undefined;
export function impostaFonteCalendario(f?: FonteCalendario): void {
	fonteCalendario = f;
}

/** La riga dei soldi: ieri AdMob e Store, la settimana contro quella prima, gli abbonati, i buchi nuovi, gli allarmi. */
export function fraseSoldi(a: BriefingAppStore): string {
	const e = (n: number) => money(n, 'EUR');
	const parti: string[] = [];
	const store = a.store ? (a.store.giorno === a.ieri ? `, Store ${e(a.store.euro)}` : `; lo Store dell'altro ieri ${e(a.store.euro)}`) : '';
	parti.push(`Ieri AdMob ha reso ${e(a.admobIeri)}${store}`);
	if (a.settimanaPrima > 0) {
		const v = (a.settimana - a.settimanaPrima) / a.settimanaPrima;
		parti.push(`in sette giorni ${e(a.settimana)}, ${Math.abs(v) < 0.05 ? 'come la settimana prima' : `${Math.round(Math.abs(v) * 100)}% ${v > 0 ? 'in più' : 'in meno'} della settimana prima`}`);
	} else parti.push(`in sette giorni ${e(a.settimana)}`);
	if (a.abbonati && a.abbonati.attivi !== a.abbonati.prima) {
		const d = a.abbonati.attivi - a.abbonati.prima;
		parti.push(`abbonati ${a.abbonati.attivi} (${d > 0 ? '+' : '−'}${Math.abs(d)} in una settimana)`);
	}
	let t = parti.join(', ') + '.';
	if (a.allarmi.length) t += ` Attenzione: ${a.allarmi[0]}`;
	if (a.buchiNuovi.length) {
		const b = a.buchiNuovi[0];
		t += ` ${a.buchiNuovi.length === 1 ? 'Una cosa nuova da sistemare' : `${a.buchiNuovi.length} cose nuove da sistemare`}: ${b.app}, ${b.titolo.charAt(0).toLowerCase()}${b.titolo.slice(1)}.`;
	}
	return t;
}

/** «Oggi hai: 10:00 chiamata con Rossi, 16:30 dentista.» Al massimo cinque, gli altri contati. */
export function fraseCalendario(eventi: EventoCalendario[]): string {
	const pulito = (t: string) => t.replace(/\s*[\u2013\u2014]\s*/g, ', ').replace(/\s+/g, ' ').replace(/[.;,\s]+$/, '').trim();
	const ok = eventi.filter(e => e && pulito(String(e.titolo ?? '')));
	if (!ok.length) return 'Oggi in agenda non hai niente.';
	const chiave = (o: string) => (/^\d{1,2}[:.]\d{2}$/.test(o) ? o.replace('.', ':').padStart(5, '0') : '');
	const ordinati = [...ok].sort((a, b) => chiave(a.ora).localeCompare(chiave(b.ora)));
	const voci = ordinati.slice(0, 5).map(e => {
		const o = String(e.ora ?? '').trim();
		const quando = chiave(o) ? chiave(o) : /tutto/i.test(o) ? 'tutto il giorno' : '';
		return `${quando ? quando + ' ' : ''}${pulito(String(e.titolo)).slice(0, 60)}`;
	});
	const altri = ordinati.length - voci.length;
	return `Oggi hai: ${voci.join(', ')}${altri ? `, e ${altri === 1 ? 'un altro' : `altri ${altri}`}` : ''}.`;
}

export interface BriefingMemory {
	at: number;
	states: Record<string, string>; // ascId -> stato:versione
}

export const BRIEFING_FILE = path.join(os.homedir(), '.bottega', 'briefing.json');

const pad = (n: number) => String(n).padStart(2, '0');
export const today = (t = Date.now()) => {
	const d = new Date(t);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** "3 ore e un quarto", "40 minuti", "un'ora e mezza": come si dice a voce. */
export function spokenMinutes(min: number): string {
	const q = Math.round(min / 15) * 15;
	if (q < 60) return q <= 0 ? 'pochi minuti' : `${q} minuti`;
	const h = Math.floor(q / 60);
	const r = q % 60;
	const hs = h === 1 ? 'un\'ora' : `${h} ore`;
	return r === 0 ? hs : r === 15 ? `${hs} e un quarto` : r === 30 ? `${hs} e mezza` : `${hs} e tre quarti`;
}

const money = (n: number, cur = 'USD') => {
	const sym = cur === 'EUR' ? 'euro' : cur === 'USD' ? 'dollari' : cur;
	return `${n.toLocaleString('it-IT', { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: 2 })} ${sym}`;
};

/** Minuscola iniziale per una frase che finisce dentro un'altra (ma non per un nome come "App Store"). */
const lower = (t: string) => (/^[A-ZÈÀ][a-zàèéìòù]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);

const listIt = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`);

/** I punti del briefing, in ordine di importanza. Solo fatti: ogni frase viene da un dato. */
export function briefingPoints(f: Facts): BriefingPoint[] {
	const now = f.now ?? Date.now();
	const pts: BriefingPoint[] = [];

	// regole rosse prima di tutto
	const red: { name: string; path: string; frase: string; act?: RuleAction }[] = [];
	for (const pr of Object.values(f.rules?.projects ?? {})) {
		for (const h of pr.hits) if (h.livello === 'rosso') red.push({ name: f.projects.find(p => p.path === pr.path)?.name ?? path.basename(pr.path), path: pr.path, frase: h.frase, act: h.azione });
	}
	for (const g of f.rules?.global ?? []) if (g.livello === 'rosso') red.push({ name: '', path: '', frase: g.frase, act: g.azione });
	const yellow = f.rules?.counts?.giallo ?? 0;
	if (red.length) {
		const first = red[0];
		pts.push({
			kind: 'regole',
			text: `${red.length === 1 ? 'Una regola rossa' : `${red.length} regole rosse`}: ${first.name ? first.name + ', ' : ''}${lower(first.frase).replace(/\.$/, '')}.${yellow ? ` Poi ${yellow === 1 ? 'un progetto in giallo' : `${yellow} progetti in giallo`}.` : ''}`,
			act: first.act ?? { act: 'view', label: 'Apri la Vedetta', args: { view: 'vedetta' } },
		});
	} else if (yellow) {
		pts.push({ kind: 'regole', text: `Nessuna regola rossa, ${yellow === 1 ? 'un progetto in giallo' : `${yellow} progetti in giallo`}.`, act: { act: 'view', label: 'Apri la Vedetta', args: { view: 'vedetta' } } });
	}

	// appuntamenti di oggi: se la fonte non li ha (delega in corso, fallita, tetto), niente riga
	let cal: EventoCalendario[] | null = null;
	if (f.calendario !== undefined) cal = f.calendario;
	else {
		try {
			cal = fonteCalendario ? fonteCalendario(now) : null;
		} catch {
			cal = null;
		}
	}
	if (cal) pts.push({ kind: 'calendario', text: fraseCalendario(cal) });

	// lavori
	const waiting = f.jobs.filter(j => j.status === 'ti aspetta');
	const night = f.jobs.filter(j => j.status === 'stanotte');
	if (waiting.length) {
		const names = [...new Set(waiting.map(j => j.project))];
		pts.push({ kind: 'lavori', text: `${waiting.length === 1 ? 'Un lavoro ti aspetta' : `${waiting.length} lavori ti aspettano`}: ${listIt(names)}.`, act: { act: 'view', label: 'Apri i lavori', args: { view: 'lavori' } } });
	}

	// la notte
	const rep = f.night?.report;
	if (rep && rep.jobs.length && now - new Date(rep.date + 'T12:00:00').getTime() < 2 * 86_400_000) {
		const done = rep.jobs.filter(j => j.status === 'finito').length;
		const stuck = rep.jobs.filter(j => j.status === 'ti aspetta').length;
		const bits = rep.jobs.map(j => `${j.project}${j.summary ? `: ${j.summary.split(/(?<=\.)\s/)[0]}` : ''}`);
		pts.push({
			kind: 'notte',
			text: `Stanotte ${rep.jobs.length === 1 ? 'ha lavorato un lavoro' : `hanno lavorato ${rep.jobs.length} lavori`}${done ? `, ${done === 1 ? 'uno finito' : `${done} finiti`}` : ''}${stuck ? `, ${stuck === 1 ? 'uno si è fermato e ti aspetta' : `${stuck} si sono fermati e ti aspettano`}` : ''}. ${bits.slice(0, 2).join('. ')}.`.replace(/\.\./g, '.'),
			act: { act: 'view', label: 'Apri i lavori', args: { view: 'lavori' } },
		});
	} else if (night.length) {
		pts.push({ kind: 'notte', text: `${night.length === 1 ? 'Un lavoro è in fila' : `${night.length} lavori sono in fila`} per stanotte.` });
	}

	// ore di ieri
	const st = f.stats;
	if (st) {
		const yKey = today(now - 86_400_000);
		const yRow = st.days.find(d => d.date === yKey);
		if (yRow && yRow.you >= 5) {
			const p7 = st.periods['7'];
			const idx = p7.days - 2; // ieri, nel vettore daily che parte dal piu' vecchio
			const top = p7.projects
				.filter(p => p.path && (p.daily[idx] ?? 0) >= 10)
				.sort((a, b) => (b.daily[idx] ?? 0) - (a.daily[idx] ?? 0))
				.slice(0, 3)
				.map(p => `${p.name} ${spokenMinutes(p.daily[idx])}`);
			pts.push({ kind: 'ore', text: `Ieri hai lavorato ${spokenMinutes(yRow.you)}${top.length ? `: ${listIt(top)}` : ''}.`, act: { act: 'view', label: 'Apri il cruscotto', args: { view: 'cruscotto' } } });
		} else {
			pts.push({ kind: 'ore', text: 'Ieri niente lavoro con Claude, o quasi.' });
		}
	}

	// Store: cose nuove rispetto al briefing precedente
	const seen = f.seen?.states ?? {};
	const since = f.seen?.at ?? now - 86_400_000;
	const news: string[] = [];
	let reviews = 0;
	let low = 0;
	for (const a of f.radar?.apps ?? []) {
		const v = a.version;
		if (v) {
			const key = `${v.state}:${v.string}`;
			// «pubblicata» e' una notizia solo se prima la versione era in un altro stato (al primo briefing nessuna
			// app gia' pubblicata da tempo diventa una novita'); rifiutate, in revisione e approvate si dicono sempre.
			const changed = seen[a.ascId] !== undefined && seen[a.ascId] !== key;
			const notable = v.tone === 'male' || v.state === 'IN_REVIEW' || v.state === 'PENDING_DEVELOPER_RELEASE' || (v.state === 'READY_FOR_SALE' && changed);
			if (seen[a.ascId] !== key && notable) {
				news.push(`${a.name} ${v.string} è ${v.label}`);
			}
		}
		for (const r of a.reviews) {
			if (r.at > since) {
				reviews++;
				if (r.stars <= 2) low++;
			}
		}
	}
	if (news.length || reviews) {
		const t = [news.slice(0, 3).join(', ')];
		if (reviews) t.push(`${reviews === 1 ? 'una recensione nuova' : `${reviews} recensioni nuove`}${low ? `, ${low === 1 ? 'una' : low} con due stelle o meno` : ''}`);
		pts.push({ kind: 'store', text: `Dallo Store: ${t.filter(Boolean).join('; ')}.`, act: { act: 'view', label: 'Apri la Vedetta', args: { view: 'vedetta' } } });
	}

	// soldi: la stanza App Store se ha dati freschi, altrimenti AdMob dal radar
	const as = f.appstore;
	const tot = f.radar?.totals;
	if (as) {
		pts.push({ kind: 'soldi', text: fraseSoldi(as), act: { act: 'view', label: 'Apri App Store', args: { view: 'appstore' } } });
	} else if (tot && f.radar?.admobAt && now - f.radar.admobAt < 36 * 3_600_000) {
		pts.push({ kind: 'soldi', text: `AdMob ieri ha reso ${money(tot.yesterday, tot.currency)}, ${money(tot.last7, tot.currency)} negli ultimi sette giorni.` });
	}

	// dimenticati
	if (f.forgotten.length) {
		const fg = f.forgotten[0];
		pts.push({
			kind: 'dimenticati',
			text: `${fg.reasons[0].startsWith('copia ') ? `In ${fg.name} c'è una ${fg.reasons[0]}` : `${fg.name} è fermo da ${fg.idleDays} giorni con ${fg.reasons[0]}`}${f.forgotten.length > 1 ? `, e non è l'unico: ${f.forgotten.length - 1 === 1 ? 'ce n\'è un altro' : `ce ne sono altri ${f.forgotten.length - 1}`}` : ''}.`,
			act: { act: 'focus', label: `Apri ${fg.name}`, args: { path: fg.path } },
		});
	}
	return pts;
}

/** Il testo di ripiego, se nessun modello risponde: i punti uno dopo l'altro. */
export function plainBriefing(points: BriefingPoint[]): string {
	if (!points.length) return 'Buongiorno. Niente da segnalare: regole a posto, nessun lavoro che ti aspetta.';
	return 'Buongiorno. ' + points.map(p => p.text).join(' ');
}

// Provato sui dati veri: quando Agnes riscriveva tutto il briefing cambiava i numeri (11 progetti in giallo
// diventavano dodici, 22,99 euro diventavano trenta). I fatti si dicono quindi sempre come escono dai dati;
// Melissa scrive solo l'apertura e la chiusura, senza numeri ne' fatti.
export const BRIEFING_INSTRUCTIONS =
	'Stai per dire ad Andrea il briefing del mattino; i fatti li leggo io, esatti. Tu scrivi SOLO due frasi brevi con ' +
	'la tua voce: la prima apre il briefing, la seconda lo chiude con una battuta o un incoraggiamento alla tua maniera. ' +
	'Al massimo 15 parole ciascuna. Niente numeri, niente nomi di progetti, niente fatti: solo tono. Scrivi la prima ' +
	'frase, una riga vuota, la seconda frase. Niente markdown, niente emoji.';

/** Le due frasi di Melissa intorno ai fatti; scartate se contengono cifre o sono troppo lunghe. */
export function briefingFrame(text: string): { intro: string; outro: string } | null {
	const clean = (x: string) => x.replace(/[—–]/g, ',').replace(/[*_#`]/g, '').trim();
	let parts = (text || '').split(/\n\s*\n|\n/).map(clean).filter(Boolean);
	// il testo pulito per la voce non ha piu' le righe: si separano le frasi dalla punteggiatura
	if (parts.length < 2) parts = (text || '').split(/(?<=[.!?…])\s+/).map(clean).filter(Boolean);
	if (parts.length < 2) return null;
	const [intro, outro] = [parts[0], parts[parts.length - 1]];
	const ok = (x: string) => x.length >= 3 && x.split(/\s+/).length <= 22 && !/\d/.test(x);
	return ok(intro) && ok(outro) ? { intro, outro } : null;
}

/** Il testo detto: apertura di Melissa (o «Buongiorno.»), i fatti esatti, chiusura di Melissa. */
export function briefingText(points: BriefingPoint[], frame: { intro: string; outro: string } | null): string {
	if (!frame) return plainBriefing(points);
	if (!points.length) return `${frame.intro} Niente da segnalare: regole a posto, nessun lavoro che ti aspetta. ${frame.outro}`;
	return `${frame.intro} ${points.map(p => p.text).join(' ')} ${frame.outro}`;
}

export function factsForModel(points: BriefingPoint[]): string {
	return points.length ? points.map((p, i) => `${i + 1}. ${p.text}`).join('\n') : 'Nessun fatto rilevante: tutto in ordine.';
}

// ---------- consigli ----------

// Apple Intelligence sul Mac sceglie e ordina, non riscrive: provato sui dati veri, quando riformulava sbagliava
// soggetti e stati (un'app in revisione diventava rifiutata). Il testo resta il rimedio esatto, dai dati.
export const ADVICE_INSTRUCTIONS =
	'Sei il consigliere di bottega di uno sviluppatore indipendente che lavora con Claude Code su molti progetti. ' +
	'Ricevi dei fatti numerati, ognuno con il suo rimedio. Scegli i 3, 4 o 5 piu\' importanti da fare oggi: prima ' +
	'cio\' che puo\' fare danni (chiavi, repository pubblici, app rifiutate), poi chi aspetta una risposta, poi il ' +
	'lavoro rimasto a meta\', poi il resto. Rispondi SOLO con i numeri scelti tra parentesi quadre, in ordine di ' +
	'importanza, separati da spazi, per esempio: [2] [5] [1]. Nient\'altro.';

export interface AdviceCandidate {
	n: number;
	fact: string;
	remedy: string;
	act?: RuleAction;
	project?: string;
	/** Di chi parla il consiglio: un progetto o un gruppo ("6 repository pubblici"). */
	subject: string;
}

/** I fatti su cui Apple Intelligence puo' dare consigli: ognuno con il suo rimedio e il pulsante che lo fa. */
const RULE_GROUP_REMEDY: Record<string, string> = {
	build: 'Fai salire il numero di build nel prossimo commit di ciascuno, insieme alla modifica.',
	push: 'Spingili: il lavoro non spinto esiste solo su questo Mac.',
	remoto: 'Collegali a un repository privato su GitHub.',
	pubblico: 'Rendili privati su GitHub, oppure segna in pubbliciPerScelta quelli pubblici per scelta.',
	rilascio: 'Mettili in rilascio automatico dalla Vedetta.',
	segreti: 'Togli le chiavi dai commit prima di spingere e mettile in ~/.secrets.',
};
const RULE_GROUP_SHORT: Record<string, string> = {
	build: 'build non salita',
	push: 'commit da spingere',
	remoto: 'repository senza remoto',
	pubblico: 'repository pubblici',
	rilascio: 'rilascio non automatico',
	segreti: 'chiavi nei commit',
};
const RULE_GROUP: Record<string, string> = {
	build: 'commit che toccano il codice senza alzare la build',
	push: 'commit non spinti',
	remoto: 'repository senza remoto',
	pubblico: 'repository pubblici su GitHub',
	rilascio: 'versioni non in rilascio automatico',
	segreti: 'chiavi nei commit non spinti',
};

export function adviceCandidates(f: Facts, points: BriefingPoint[]): AdviceCandidate[] {
	const out: AdviceCandidate[] = [];
	const add = (c: Omit<AdviceCandidate, 'n'>) => out.length < 24 && out.push({ n: out.length + 1, ...c });
	const nameOf = (p: string) => f.projects.find(x => x.path === p)?.name ?? path.basename(p);
	// Le violazioni uguali (stessa regola, stesso rimedio) diventano un solo fatto con l'elenco dei progetti:
	// cosi' il modello sceglie tra cose diverse invece di ripetere lo stesso consiglio cinque volte.
	for (const lv of ['rosso', 'giallo'] as const) {
		for (const g of f.rules?.global ?? []) if (g.livello === lv) add({ fact: `(${lv}) ${g.frase}`, remedy: g.rimedio, act: g.azione, subject: g.id === 'app-ads' ? 'app-ads.txt' : 'regola' });
		const groups = new Map<string, { hits: { name: string; path: string; frase: string; act?: RuleAction }[]; remedy: string }>();
		for (const pr of Object.values(f.rules?.projects ?? {})) {
			for (const h of pr.hits) {
				if (h.livello !== lv) continue;
				const g = groups.get(h.id) ?? { hits: [], remedy: h.rimedio };
				g.hits.push({ name: nameOf(pr.path), path: pr.path, frase: h.frase, act: h.azione });
				groups.set(h.id, g);
			}
		}
		for (const [id, g] of groups) {
			if (g.hits.length === 1) {
				const h = g.hits[0];
				add({ fact: `(${lv}) ${h.name}: ${h.frase}`, remedy: g.remedy, project: h.name, subject: h.name, act: h.act ?? { act: 'focus', label: `Apri ${h.name}`, args: { path: h.path } } });
			} else {
				const names = g.hits.map(h => h.name);
				add({
					fact: `(${lv}) ${RULE_GROUP[id] ?? 'regola violata'} in ${names.length} progetti: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ' e altri' : ''}.`,
					remedy: RULE_GROUP_REMEDY[id] ?? g.remedy,
					subject: `${names.length} progetti con ${RULE_GROUP_SHORT[id] ?? 'una regola violata'}`,
					act: { act: 'view', label: 'Apri la Vedetta', args: { view: 'vedetta' } },
				});
			}
		}
	}
	for (const p of points) {
		if (p.kind === 'lavori') add({ fact: p.text, remedy: 'Rispondi ai lavori che ti aspettano prima di aprirne di nuovi.', act: p.act, subject: 'Lavori' });
		if (p.kind === 'store' && /rifiutat/.test(p.text)) add({ fact: p.text, remedy: 'Leggi il motivo del rifiuto su App Store Connect e prepara la correzione.', act: p.act, subject: 'App rifiutate' });
	}
	for (const fg of f.forgotten.slice(0, 3)) {
		add({ fact: `${fg.name}: ${fg.reasons.join('; ')}`, remedy: 'Riprendilo con «Continua da dove eri», oppure chiudi il lavoro rimasto con un commit e un push.', project: fg.name, subject: fg.name, act: { act: 'focus', label: `Apri ${fg.name}`, args: { path: fg.path } } });
	}
	return out;
}

export function adviceFacts(cands: AdviceCandidate[]): string {
	return cands.map(c => `[${c.n}] Fatto: ${c.fact} Rimedio: ${c.remedy}`).join('\n');
}

/** Dalla risposta del modello prende solo i numeri dei fatti, in ordine, e mostra il rimedio di ciascuno. */
export function parseAdvice(text: string, cands: AdviceCandidate[]): Advice['items'] {
	const order: AdviceCandidate[] = [];
	for (const m of (text || '').matchAll(/\[(\d+)\]/g)) {
		const c = cands.find(x => x.n === Number(m[1]));
		if (c && !order.includes(c)) order.push(c);
		if (order.length === 5) break;
	}
	return order.map(adviceItem);
}

function adviceItem(c: AdviceCandidate): Advice['items'][number] {
	return { text: `${c.subject}: ${c.remedy.charAt(0).toLowerCase()}${c.remedy.slice(1)}`, ...(c.act ? { act: c.act } : {}) };
}

/** Consigli senza modello: i rimedi dei fatti piu' importanti, cosi' come sono. */
export function ruleAdvice(cands: AdviceCandidate[]): Advice['items'] {
	const items = cands.slice(0, 4).map(adviceItem);
	return items.length ? items : [{ text: 'Tutto in ordine: è un buon giorno per chiudere qualcosa rimasto a metà.' }];
}

// ---------- memoria su disco ----------

export function readBriefing(file = BRIEFING_FILE): { briefing: Briefing | null; memory?: BriefingMemory; advice?: Advice | null } {
	try {
		const d = JSON.parse(fs.readFileSync(file, 'utf8'));
		return { briefing: d.briefing ?? null, memory: d.memory, advice: d.advice ?? null };
	} catch {
		return { briefing: null };
	}
}

export function writeBriefing(data: { briefing: Briefing | null; memory?: BriefingMemory; advice?: Advice | null }, file = BRIEFING_FILE): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const tmp = file + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch {
		// disco pieno o permessi: il briefing resta in memoria
	}
}

export function storeMemory(radar: RadarState | null | undefined, now = Date.now()): BriefingMemory {
	const states: Record<string, string> = {};
	for (const a of radar?.apps ?? []) if (a.version) states[a.ascId] = `${a.version.state}:${a.version.string}`;
	return { at: now, states };
}
