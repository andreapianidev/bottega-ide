/* Gli strumenti di Melissa sui connettori di Claude Code, sempre in sola lettura:

   - `connettori_elenco`: i connettori con stato e tipo (diretto e gratis, oppure via Claude e a pagamento) e, per i
     server locali diretti, i loro strumenti di sola lettura (cache in memoria di 5 minuti);
   - `connettore_leggi`: chiama direttamente uno strumento di sola lettura di un server locale stdio (mcp.ts): gratis,
     istantaneo, server chiuso a fine chiamata, risultato troncato;
   - `connettore_chiedi`: per i connettori di claude.ai (Gmail, Google Calendar, Vercel...) una delega a `claude -p`
     tramite la coda di delega.ts. Costa: chiede sempre conferma ad Andrea con la stima di tempo e costo, e la risposta
     arriva dopo, a voce, con `announce`;
   - il calendario del briefing: al piu' una delega al giorno, in background, che legge gli appuntamenti di oggi in
     ~/.bottega/connettori/calendario.json; briefing.ts ne fa la riga «Oggi hai: ...».

   Gli strumenti entrano nell'elenco di Melissa (TOOLS di assistant.ts) da extension.ts, che chiama anche
   `registraStrumentiConnettori` con la stanza Connettori. Niente contenuti nei log: solo nomi di server e strumenti.
   Contratto: docs/CONTRATTI.md, sezioni 5 e 6. */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Assistant, ToolSpec } from './assistant';
import { EventoCalendario, impostaFonteCalendario } from './briefing';
import { avvioServer, CLAUDE_JSON, Connettore, ConnettoriStato, soloLettura, utilizzabile } from './connettori';
import { STRUMENTI } from './connettori-mappa';
import { DIR_CONNETTORI, EsitoDelega, giornoLocale, RichiestaDelega, STIMA_BASE, StatoDeleghe } from './delega';
import { conServer, StrumentoMcp, testoRisultato } from './mcp';

/** Quello che serve della stanza Connettori (connettori-host.ts): la scoperta e la coda delle deleghe. */
export interface FonteConnettori {
	scoperta: { stato(): ConnettoriStato };
	coda: { accoda(r: RichiestaDelega): Promise<EsitoDelega>; stato(): StatoDeleghe };
}

export interface OpzioniStrumenti {
	/** ~/.claude.json, per i test. */
	claudeJson?: string;
	/** ~/.bottega/connettori, per i test. */
	dir?: string;
	log?: (s: string) => void;
	ora?: () => number;
}

/** La stessa forma di ToolDef in assistant.ts: extension.ts lo verifica con `satisfies`. */
export interface StrumentoMelissa {
	spec: ToolSpec;
	risky?: boolean;
	run(args: any, ctx: Assistant): Promise<string> | string;
}

export const MASSIMO_CARATTERI = 6000;
export const TIMEOUT_LETTURA = 60_000;
const CACHE_STRUMENTI_MS = 5 * 60_000;
/** Server con dati personali: solo se Andrea lo chiede in modo esplicito. */
export const SERVER_PERSONALI = ['whatsapp-personal', 'mail-mcp'];

const cfg = () => vscode.workspace.getConfiguration('bottega');

let fonte: FonteConnettori | undefined;
let opz: OpzioniStrumenti = {};
const cacheStrumenti = new Map<string, { at: number; strumenti: StrumentoMcp[] }>();

const ora = () => (opz.ora ? opz.ora() : Date.now());
const log = (s: string) => opz.log?.(s);
const dir = () => opz.dir ?? DIR_CONNETTORI;

/** L'aggancio in extension.ts: la stanza Connettori, restituita da registerConnettori. */
export function registraStrumentiConnettori<T extends FonteConnettori>(stanza: T, o: OpzioniStrumenti = {}): T {
	fonte = stanza;
	opz = { log: s => console.warn(s), ...o };
	cacheStrumenti.clear();
	calendarioTentato = '';
	impostaFonteCalendario(calendarioDiOggi);
	return stanza;
}

// ---------- pezzi puri ----------

/** Taglia un testo al massimo di caratteri, dicendo quanto era lungo. */
export function tronca(testo: string, max = MASSIMO_CARATTERI): string {
	if (testo.length <= max) return testo;
	return `${testo.slice(0, max)}\n(troncato: ${testo.length} caratteri in tutto. Se serve il resto, chiedi meno dati, per esempio con un limite o un periodo piu' corto.)`;
}

/** Toglie dai dati i campi vuoti e accorcia i testi lunghi: meno caratteri da leggere, stessi fatti. */
export function compatta(v: unknown, profondita = 0): unknown {
	if (v === null || v === undefined) return undefined;
	if (typeof v === 'string') return v.length > 500 ? v.slice(0, 500) + '...' : v;
	if (Array.isArray(v)) {
		const out = v.map(x => compatta(x, profondita + 1)).filter(x => x !== undefined);
		return out.length ? out : undefined;
	}
	if (typeof v === 'object') {
		if (profondita > 8) return '...';
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
			const c = compatta(x, profondita + 1);
			if (c !== undefined && !(typeof c === 'string' && !c.trim())) out[k] = c;
		}
		return Object.keys(out).length ? out : undefined;
	}
	return v;
}

/** Il nome breve: "mcp__admob__list_apps" diventa "list_apps". */
export function nomeBreve(strumento: string): string {
	const s = String(strumento ?? '').trim();
	return s.includes('__') ? s.slice(s.lastIndexOf('__') + 2) : s;
}

/** Prima frase della descrizione, al massimo 120 caratteri. */
export function descrizioneBreve(d?: string): string {
	const t = String(d ?? '').replace(/\s+/g, ' ').trim();
	const prima = (/^(.+?[.!?])(\s|$)/.exec(t)?.[1] ?? t).trim();
	return prima.length > 120 ? prima.slice(0, 117) + '...' : prima;
}

/** Gli argomenti di uno strumento, come "site*: string, days: number" (asterisco = obbligatorio). */
export function argomentiBrevi(schema: any): string {
	const props = schema && typeof schema === 'object' ? schema.properties ?? {} : {};
	const req = new Set<string>(Array.isArray(schema?.required) ? schema.required : []);
	const parti = Object.entries<any>(props)
		.slice(0, 10)
		.map(([k, p]) => {
			const tipo = Array.isArray(p?.enum) && p.enum.length <= 6 ? p.enum.join('|') : String(p?.type ?? 'valore');
			return `${k}${req.has(k) ? '*' : ''}: ${tipo}`;
		});
	return parti.join(', ');
}

/** Solo gli strumenti che la Bottega puo' chiamare (connettori.ts, soloLettura): con le annotazioni del server
 *  (readOnlyHint) e i permessi a mano per server (bottega.connettori.letturaPermessa). */
export function strumentiLeggibili(tools: StrumentoMcp[], server?: string): StrumentoMcp[] {
	return tools.filter(t => t && typeof t.name === 'string' && soloLettura(t.name, t.annotations, server));
}

const norma = (s: string) => String(s ?? '').toLowerCase().replace(/^claude\.ai\s+/, '').replace(/[^a-z0-9]+/g, '');

/** Trova i connettori nominati da Melissa: nome esatto, nome pulito, pezzo di nome, oppure una capacita'
 *  ("calendario" accende Google Calendar). */
export function trovaConnettori(connettori: Connettore[], nomi: string[]): Connettore[] {
	const out: Connettore[] = [];
	for (const n of nomi) {
		const k = norma(n);
		if (!k) continue;
		const c =
			connettori.find(x => norma(x.nome) === k || norma(x.pulito) === k) ??
			connettori.find(x => !!norma(x.pulito) && (norma(x.pulito).includes(k) || (k.length >= 4 && k.includes(norma(x.pulito))))) ??
			connettori.find(x => x.capacita.some(id => norma(id) === k));
		if (c && !out.includes(c)) out.push(c);
	}
	return out;
}

/** Gli strumenti di sola lettura noti per un connettore di claude.ai (nomi completi), dalla mappa piu' qualche
 *  aggiunta. Per i connettori che non conosciamo: nessuno, e la delega non parte. */
const STRUMENTI_IN_PIU: Record<string, string[]> = {
	gmail: ['get_message', 'list_drafts', 'get_draft'],
	'google calendar': ['list_calendars'],
	'google drive': ['read_file_content', 'get_file_permissions'],
	vercel: ['get_project', 'list_project_domains', 'get_runtime_errors', 'get_runtime_logs', 'list_domains', 'get_team', 'list_aliases'],
	stripe: ['list_available_accounts_or_orgs', 'search_stripe_documentation'],
	'hugging face': ['hub_repo_search', 'hub_repo_details', 'hf_whoami'],
};

export function strumentiNoti(c: Connettore): string[] {
	const brevi = new Set<string>();
	for (const perConn of Object.values(STRUMENTI)) for (const s of perConn[c.pulito] ?? []) brevi.add(s);
	for (const s of STRUMENTI_IN_PIU[c.pulito] ?? []) brevi.add(s);
	return [...brevi].filter(s => soloLettura(s)).map(s => c.prefisso + s);
}

const tipoDetto = (c: Connettore) => (c.diretto ? 'diretto, gratis' : 'via Claude, a pagamento');

// ---------- strumenti dei server diretti, con cache ----------

function serverDiretto(nome: string): Connettore | undefined {
	const cs = fonte?.scoperta.stato().connettori ?? [];
	const diretti = cs.filter(c => c.diretto && utilizzabile(c));
	return trovaConnettori(diretti, [nome])[0];
}

async function strumentiDi(c: Connettore): Promise<StrumentoMcp[]> {
	const hit = cacheStrumenti.get(c.nome);
	if (hit && ora() - hit.at < CACHE_STRUMENTI_MS) return hit.strumenti;
	const avvio = avvioServer(c.nome, opz.claudeJson ?? CLAUDE_JSON);
	if (!avvio) throw new Error('configurazione non trovata in ~/.claude.json');
	const tutti = await conServer(c.nome, avvio, s => s.strumenti(), 20_000);
	// in cache solo nome, descrizione e schema: mai comando o env
	const strumenti = tutti.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
	cacheStrumenti.set(c.nome, { at: ora(), strumenti });
	return strumenti;
}

// ---------- connettori_elenco ----------

async function elenco(a: { server?: string; cerca?: string }): Promise<string> {
	if (!fonte) return 'I connettori non sono pronti: la stanza Connettori non e\' partita.';
	const st = fonte.scoperta.stato();
	if (!st.connettori.length) return st.aggiornando ? 'Sto ancora leggendo i connettori di Claude Code, riprova tra poco.' : 'Non vedo connettori in Claude Code.';
	const cerca = String(a.cerca ?? '').trim().toLowerCase();

	if (a.server) {
		const c = trovaConnettori(st.connettori, [a.server])[0];
		if (!c) return `Non trovo il connettore "${a.server}". Ci sono: ${st.connettori.map(x => x.nome).join(', ')}.`;
		if (!c.diretto) {
			const noti = strumentiNoti(c).map(nomeBreve);
			return `${c.nome}: ${c.stato}, ${tipoDetto(c)}. Si usa con connettore_chiedi${noti.length ? `, che puo' leggere con ${noti.join(', ')}` : ', ma non so quali strumenti di sola lettura abbia'}.`;
		}
		if (!utilizzabile(c)) return `${c.nome}: ${c.stato}, non si puo' usare adesso.`;
		let tools: StrumentoMcp[];
		try {
			tools = await strumentiDi(c);
		} catch (e: any) {
			return `${c.nome} non risponde: ${e?.message ?? e}`;
		}
		const ro = strumentiLeggibili(tools, c.nome).filter(t => !cerca || `${t.name} ${t.description ?? ''}`.toLowerCase().includes(cerca));
		if (!ro.length) {
			return `${c.nome}: ${tools.length} strumenti, ma nessuno di sola lettura${cerca ? ` che parli di "${cerca}"` : ''} secondo le regole della Bottega: non posso leggerlo direttamente.`;
		}
		const righe = ro.map(t => `${t.name}(${argomentiBrevi(t.inputSchema)}): ${descrizioneBreve(t.description)}`);
		return tronca(`${c.nome}, diretto e gratis, ${ro.length} strumenti di sola lettura (con asterisco gli argomenti obbligatori). Chiamali con connettore_leggi:\n${righe.join('\n')}`);
	}

	const diretti = st.connettori.filter(c => c.diretto);
	const viaClaude = st.connettori.filter(c => !c.diretto);
	const righe: string[] = [];
	if (diretti.length) {
		righe.push('Diretti e gratis (connettore_leggi):');
		// pochi alla volta: ogni server e' un processo da avviare
		const pronti = diretti.filter(utilizzabile);
		const conti = new Map<string, string>();
		for (let i = 0; i < pronti.length; i += 3) {
			await Promise.all(
				pronti.slice(i, i + 3).map(async c => {
					try {
						const ro = strumentiLeggibili(await strumentiDi(c), c.nome).map(t => t.name);
						conti.set(c.nome, ro.length ? `${ro.length} di sola lettura: ${ro.slice(0, 20).join(', ')}${ro.length > 20 ? ` e altri ${ro.length - 20}` : ''}` : 'nessuno strumento di sola lettura');
					} catch (e: any) {
						conti.set(c.nome, `non risponde (${String(e?.message ?? e).slice(0, 80)})`);
					}
				}),
			);
		}
		for (const c of diretti) righe.push(`${c.nome} (${c.stato}${c.ambito === 'progetto' ? ', solo in alcuni progetti' : ''}): ${conti.get(c.nome) ?? 'non utilizzabile adesso'}`);
	}
	if (viaClaude.length) {
		righe.push('Via Claude, a pagamento, decine di secondi (connettore_chiedi, con conferma):');
		for (const c of viaClaude) righe.push(`${c.nome}: ${c.stato}`);
	}
	return tronca(righe.join('\n'));
}

// ---------- connettore_leggi ----------

function argomentiOggetto(v: unknown): Record<string, unknown> | string {
	if (v === undefined || v === null || v === '') return {};
	if (typeof v === 'string') {
		try {
			v = JSON.parse(v);
		} catch {
			return 'gli argomenti devono essere un oggetto JSON';
		}
	}
	if (typeof v !== 'object' || Array.isArray(v)) return 'gli argomenti devono essere un oggetto JSON';
	return v as Record<string, unknown>;
}

async function leggi(a: { server: string; strumento: string; argomenti?: unknown }, ctx?: Pick<Assistant, 'azione'>): Promise<string> {
	if (!fonte) return 'I connettori non sono pronti: la stanza Connettori non e\' partita.';
	const strumento = nomeBreve(a.strumento);
	// prima di tutto, e prima di avviare qualsiasi processo: fuori subito chi ha una parola che scrive o e' sensibile
	// (readOnlyHint supposto vero qui; il controllo vero, con le annotazioni del server, lo fa ClientMcp.chiama)
	if (!soloLettura(strumento, { readOnlyHint: true })) {
		return `Rifiutato: ${strumento} non e' di sola lettura. La Bottega non invia, non risponde, non crea e non cancella niente.`;
	}
	const c = serverDiretto(a.server);
	if (!c) {
		const st = fonte.scoperta.stato();
		const altro = trovaConnettori(st.connettori, [a.server])[0];
		if (altro && !altro.diretto) return `${altro.nome} non e' un server locale: si legge con connettore_chiedi, a pagamento e con conferma.`;
		const diretti = st.connettori.filter(x => x.diretto && utilizzabile(x)).map(x => x.nome);
		return `Non trovo un server locale "${a.server}" utilizzabile.${diretti.length ? ` Ci sono: ${diretti.join(', ')}.` : ''}`;
	}
	const args = argomentiOggetto(a.argomenti);
	if (typeof args === 'string') return `Argomenti non validi: ${args}.`;
	const avvio = avvioServer(c.nome, opz.claudeJson ?? CLAUDE_JSON);
	if (!avvio) return `Non trovo come avviare ${c.nome} in ~/.claude.json.`;

	const t0 = ora();
	let timer: NodeJS.Timeout | undefined;
	try {
		const r = await Promise.race([
			conServer(c.nome, avvio, async s => (await s.strumenti(), s.chiama(strumento, args)), TIMEOUT_LETTURA),
			new Promise<never>((_, ko) => {
				timer = setTimeout(() => ko(new Error(`nessuna risposta in ${TIMEOUT_LETTURA / 1000} secondi`)), TIMEOUT_LETTURA);
			}),
		]);
		const t = testoRisultato(r);
		// nei log solo server, strumento e durata: mai argomenti o contenuti
		log(`connettori: ${c.nome}.${strumento} in ${ora() - t0} ms`);
		ctx?.azione(`Ho letto da ${c.nome}`);
		if (t.errore) return `${c.nome} ha risposto con un errore: ${t.errore}`;
		if (t.json !== undefined) {
			const dati = compatta(t.json);
			const quanti = Array.isArray(t.json) ? ` (${t.json.length} elementi)` : '';
			return tronca(`Risultato di ${c.nome}.${strumento}${quanti}, riassumilo a voce:\n${dati === undefined ? 'vuoto' : JSON.stringify(dati)}`);
		}
		return tronca(t.testo.trim() ? `Risultato di ${c.nome}.${strumento}, riassumilo a voce:\n${t.testo.trim()}` : `${c.nome}.${strumento} non ha restituito niente.`);
	} catch (e: any) {
		log(`connettori: ${c.nome}.${strumento} non riuscito`);
		return `Non sono riuscita a leggere da ${c.nome}: ${String(e?.message ?? e).slice(0, 200)}`;
	} finally {
		clearTimeout(timer);
	}
}

// ---------- connettore_chiedi ----------

export const SCHEMA_RISPOSTA = '{"risposta": "testo in italiano, breve, da leggere a voce: al massimo cinque frasi, niente elenchi, niente markdown"}';

/** La risposta di una delega in testo da dire: il campo risposta, oppure il JSON accorciato. */
export function testoDelega(data: unknown): string {
	const r = data && typeof data === 'object' && !Array.isArray(data) ? (data as any).risposta : undefined;
	const t = typeof r === 'string' ? r : typeof data === 'string' ? data : JSON.stringify(compatta(data) ?? '');
	return tronca(t.replace(/\s*[\u2013\u2014]\s*/g, ', ').trim(), 1200);
}

function listaNomi(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(x => String(x ?? '').trim()).filter(Boolean);
	return String(v ?? '')
		.split(/[,;]|\se\s/)
		.map(x => x.trim())
		.filter(Boolean);
}

/** Dice la risposta quando Melissa e' libera (non mentre parla o pensa), al massimo dopo un minuto. */
async function annunciaQuandoLibera(ctx: Pick<Assistant, 'announce' | 'getState'>, testo: string): Promise<void> {
	for (let i = 0; i < 30; i++) {
		const s = ctx.getState().state;
		if (s === 'idle' || s === 'listening' || s === 'error') break;
		await new Promise(r => setTimeout(r, 2000));
	}
	await ctx.announce(testo);
}

function chiedi(a: { compito: string; connettori: unknown }, ctx: Assistant): string {
	if (!fonte) return 'I connettori non sono pronti: la stanza Connettori non e\' partita.';
	const f = fonte;
	const st = f.scoperta.stato();
	const nomi = listaNomi(a.connettori);
	if (!nomi.length) return 'Dimmi quale connettore usare (per esempio Gmail, Google Calendar, Vercel).';
	const trovati = trovaConnettori(st.connettori, nomi);
	if (!trovati.length) return `Non trovo i connettori ${nomi.join(', ')}. Ci sono: ${st.connettori.filter(c => !c.diretto).map(c => c.nome).join(', ') || 'nessuno via Claude'}.`;
	const diretti = trovati.filter(c => c.diretto);
	if (diretti.length === trovati.length) return `${diretti.map(c => c.nome).join(', ')} e' un server locale: usa connettore_leggi, gratis e subito.`;
	const viaClaude = trovati.filter(c => !c.diretto);
	const spenti = viaClaude.filter(c => c.stato !== 'connesso');
	if (spenti.length === viaClaude.length) return `${spenti.map(c => `${c.nome} e' ${c.stato}`).join(', ')}: va collegato in Claude Code prima.`;
	const pronti = viaClaude.filter(c => c.stato === 'connesso');
	const strumenti = pronti.flatMap(strumentiNoti);
	if (!strumenti.length) return `Non conosco strumenti di sola lettura per ${pronti.map(c => c.nome).join(', ')}: non posso chiederlo a Claude.`;

	const d = f.coda.stato();
	const stima = d.stime['chiedi'] ?? STIMA_BASE;
	if (d.spesaOggi + stima.usd > d.tetto) {
		return `Non posso: il tetto di spesa di oggi e' ${d.tetto.toFixed(2)} dollari e ne ho gia' spesi ${d.spesaOggi.toFixed(2)}. Dillo ad Andrea.`;
	}
	const chi = pronti.map(c => c.nome.replace(/^claude\.ai\s+/i, '')).join(' e ');
	const oggi = new Date(ora()).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
	const richiesta: RichiestaDelega = {
		capacita: 'chiedi',
		compito: `${String(a.compito).trim()}\n(Oggi e' ${oggi}. Leggi soltanto, poi rispondi in breve, come lo diresti a voce.)`,
		schema: SCHEMA_RISPOSTA,
		strumenti,
	};
	const costo = stima.usd.toFixed(2).replace('.', ',');
	ctx.setPending({
		describe: `chiedere a Claude di leggere da ${chi}`,
		run: () => {
			void f.coda.accoda(richiesta).then(
				e => annunciaQuandoLibera(ctx, e.ok ? `Da ${chi}: ${testoDelega(e.data)}` : `La lettura da ${chi} non e' riuscita: ${String(e.errore ?? 'errore').slice(0, 160)}`),
				() => undefined,
			);
		},
		done: `Ho chiesto a Claude di leggere da ${chi}: ci mette circa ${stima.secondi} secondi, te lo dico appena arriva.`,
		azione: `Ho chiesto a Claude di leggere da ${chi}`,
	});
	return (
		`AZIONE A PAGAMENTO: per leggere da ${chi} devo chiederlo a Claude, ci mette circa ${stima.secondi} secondi e costa circa ${costo} dollari ` +
		`(oggi spesi ${d.spesaOggi.toFixed(2).replace('.', ',')} su ${d.tetto.toFixed(2).replace('.', ',')}). ` +
		'Dillo ad Andrea con tempo e costo, chiedi "confermi?" e non fare altro.'
	);
}

// ---------- il calendario del briefing ----------

let calendarioTentato = '';

export const fileCalendario = () => path.join(dir(), 'calendario.json');

/** Gli eventi di oggi dal file della delega, oppure null se il file non e' di oggi o non e' riuscito. */
export function leggiCalendario(file: string, giorno: string): { stato: 'ok'; eventi: EventoCalendario[] } | { stato: 'tentato' | 'assente' } {
	let e: EsitoDelega;
	try {
		e = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return { stato: 'assente' };
	}
	if (!e || giornoLocale(Number(e.at) || 0) !== giorno) return { stato: 'assente' };
	const d: any = e.data;
	if (!e.ok || !d || !Array.isArray(d.eventi) || (d.giorno && d.giorno !== giorno)) return { stato: 'tentato' };
	const eventi = d.eventi
		.filter((x: any) => x && typeof x.titolo === 'string' && x.titolo.trim())
		.map((x: any) => ({ ora: String(x.ora ?? '').trim(), titolo: String(x.titolo).trim() }));
	return { stato: 'ok', eventi };
}

/** La fonte di briefing.ts: legge il file di oggi; se non c'e', avvia la delega in background (una al giorno). */
function calendarioDiOggi(now: number): EventoCalendario[] | null {
	const giorno = giornoLocale(now);
	const l = leggiCalendario(fileCalendario(), giorno);
	if (l.stato === 'ok') return l.eventi;
	if (l.stato === 'assente') avviaCalendario(now, giorno);
	return null;
}

function avviaCalendario(now: number, giorno: string): void {
	if (!fonte || calendarioTentato === giorno || new Date(now).getHours() < 5) return;
	if (!cfg().get<boolean>('briefing.calendario', true)) return;
	const cal = fonte.scoperta.stato().connettori.find(c => c.tipo === 'claude.ai' && c.pulito === 'google calendar' && c.stato === 'connesso');
	if (!cal) return;
	const strumenti = strumentiNoti(cal).filter(s => /list_events$/.test(s));
	if (!strumenti.length) return;
	calendarioTentato = giorno;
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Atlantic/Canary';
	void fonte.coda
		.accoda({
			capacita: 'calendario',
			compito: `Leggi con list_events gli appuntamenti di oggi, ${giorno}, nel calendario principale, da mezzanotte a mezzanotte, fuso ${tz}. Ordinali per ora.`,
			schema: `{"giorno": "${giorno}", "eventi": [{"ora": "HH:MM di inizio, oppure \\"tutto il giorno\\"", "titolo": "il titolo dell'evento, breve"}]}`,
			strumenti,
		})
		.then(
			e => log(`calendario: delega ${e.ok ? 'riuscita' : 'non riuscita'}`),
			() => log('calendario: delega non riuscita'),
		);
}

// ---------- le specifiche per Melissa ----------

function obj(properties: any, required: string[] = []): any {
	return { type: 'object', properties, required, additionalProperties: false };
}

export const STRUMENTI_CONNETTORI: Record<string, StrumentoMelissa> = {
	connettori_elenco: {
		spec: {
			type: 'function',
			function: {
				name: 'connettori_elenco',
				description:
					'I connettori di Claude Code di Andrea, con stato e tipo: diretti e gratis (server locali come admob, asc-mcp, google-play, searchconsole, keyword-suggest, mail-mcp, whatsapp) oppure via Claude e a pagamento (Gmail, Google Calendar, Google Drive, Vercel, Stripe, Hugging Face). ' +
					'Senza server: il quadro, con i nomi degli strumenti di sola lettura dei diretti. Con server: gli strumenti di sola lettura di quel server, con descrizione e argomenti (asterisco = obbligatorio); cerca filtra per parola. Chiamalo prima di connettore_leggi se non conosci nome e argomenti dello strumento.',
				parameters: obj({ server: { type: 'string', description: 'un connettore, per esempio admob o searchconsole' }, cerca: { type: 'string', description: 'parola per filtrare gli strumenti, per esempio review' } }),
			},
		},
		run: a => elenco(a),
	},
	connettore_leggi: {
		spec: {
			type: 'function',
			function: {
				name: 'connettore_leggi',
				description:
					'Legge dati da un server MCP locale di Claude Code chiamando un suo strumento di sola lettura: gratis e subito. Esempi: "quanto ha reso Talky ieri" su admob, "come va il traffico di andreapiani.com" su searchconsole (search_analytics), "stato di Woofmap su App Store" su asc-mcp, recensioni su google-play. ' +
					'Per i guadagni AdMob di ieri e della settimana e lo stato delle app c\'e\' gia\' store_soldi, piu\' rapido: usa questo quando serve altro. Solo strumenti di sola lettura (verbi come list, get, search, report, trend, oppure dichiarati di sola lettura dal server, oppure i report di admob, searchconsole e keyword-suggest): quelli che scrivono vengono rifiutati. ' +
					'whatsapp-personal e mail-mcp (chat e posta personali) SOLO se Andrea te lo chiede esplicitamente, mai di tua iniziativa. Se non sai nome e argomenti dello strumento, chiama prima connettori_elenco con il server. Il risultato e\' gia\' accorciato: riassumilo a voce in poche frasi.',
				parameters: obj(
					{
						server: { type: 'string', description: 'il nome del server, per esempio admob, searchconsole, asc-mcp' },
						strumento: { type: 'string', description: 'il nome breve dello strumento, per esempio list_apps' },
						argomenti: { type: 'object', description: 'gli argomenti dello strumento, come oggetto JSON' },
					},
					['server', 'strumento'],
				),
			},
		},
		run: (a, ctx) => leggi(a, ctx),
	},
	connettore_chiedi: {
		spec: {
			type: 'function',
			function: {
				name: 'connettore_chiedi',
				description:
					'Chiede a Claude Code di leggere da un connettore di claude.ai che la Bottega non puo\' interrogare da sola: Gmail, Google Calendar, Google Drive, Vercel, Stripe, Hugging Face. Solo lettura. ' +
					'Costa (decine di secondi e qualche decimo di dollaro, con un tetto giornaliero) e chiede SEMPRE conferma ad Andrea: lo strumento ti da\' tempo e costo da dirgli. La risposta arriva dopo, a voce. ' +
					'Usalo per "ho mail da Rossi su Gmail?", "cosa ho in agenda giovedi\'?", "l\'ultimo deploy su Vercel e\' andato?". Per i server locali usa connettore_leggi.',
				parameters: obj(
					{
						compito: { type: 'string', description: 'cosa leggere, in italiano chiaro e completo' },
						connettori: { type: 'array', items: { type: 'string' }, description: 'i connettori da usare, per esempio ["Gmail"]' },
					},
					['compito', 'connettori'],
				),
			},
		},
		risky: true,
		run: (a, ctx) => chiedi(a, ctx),
	},
};
