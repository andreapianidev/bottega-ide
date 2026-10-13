// L'isola nella tacca segue anche Cline, Codex e i terminali integrati, sempre (Andrea, 6 ottobre 2026; docs/CONTRATTI.md,
// sezione 1, «L'isola segue anche Cline, Codex e i terminali»). Le sessioni di Claude Code l'isola le segue gia' con la
// mod melissa; queste altre fonti la Bottega le osserva nel registro delle attivita' (AgentActivity) e qui, a ogni cambio
// di stato, lo dice all'isola sul suo socket (`POST /stato`): al lavoro = `pensa` con il titolo, finito, in attesa o
// errore = `pronto` (si ritira da sola). Se l'isola non c'e' la si accende come fa la mod (LaunchServices, `--isola`).
// Mai mentre l'isola parla o ascolta: la voce e il microfono di Melissa vengono prima.
// Con l'avviso di fine acceso (avviso-fine.ts) la fine di una sessione che ha lavorato almeno 15 s non si scrive soltanto:
// Melissa la dice a voce (`POST /parla`, sessione `bottega-avvisi`), e l'isola la mette in fila dietro le altre voci.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AgentActivity } from './attivita-tipi';
import { AVVISO_ATTESA_MS, daAvvisare, NOMI_FONTI } from './avviso-fine';

export const FONTI_ISOLA = ['cline', 'codex', 'terminale'] as const;
const NOMI = NOMI_FONTI;
/** La sessione con cui la Bottega parla sull'isola: le sue battute stanno in fila come quelle di un terminale. */
export const SESSIONE_AVVISI = 'bottega-avvisi';

/** Cosa dire all'isola per un cambio di stato, o null se non c'e' niente da dire. */
export type StatoIsola = { stato: 'pensa' | 'pronto' | 'riposo'; testo: string };

export function statoPerIsola(a: AgentActivity, prima: AgentActivity['status'] | undefined): StatoIsola | null {
	if (prima === a.status) return null;
	const chi = NOMI[a.source] ?? a.source;
	const cosa = `${a.title}${a.project ? `, ${a.project}` : ''}`.slice(0, 140);
	if (a.status === 'in corso') return { stato: 'pensa', testo: `${chi}: ${cosa}` };
	// alla prima occhiata conta solo chi lavora: una sessione gia' finita da ore non si annuncia
	if (prima === undefined) return null;
	if (a.status === 'ti aspetta') return { stato: 'pronto', testo: `${chi} ti aspetta: ${cosa}` };
	if (a.status === 'finito') return { stato: 'pronto', testo: `${chi} ha finito: ${cosa}` };
	if (a.status === 'errore') return { stato: 'pronto', testo: `${chi}, errore: ${cosa}` };
	// sparita senza finire (un terminale chiuso a meta', un processo morto): l'isola si ritira
	return { stato: 'riposo', testo: '' };
}

export interface IsolaDeps {
	/** una richiesta all'isola; null se non risponde */
	manda(percorso: string, corpo?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
	/** accende l'isola, se si puo' */
	accendi(): Promise<void>;
	log?(riga: string): void;
	/** l'avviso di fine e' acceso (il campo `avviso` del file condiviso con la mod) */
	avvisoAcceso?(): boolean;
	/** Andrea parla con Melissa adesso, nella barra o nella mod: l'avviso aspetta */
	occupata?(): boolean;
	/** la frase dell'avviso per questa sessione */
	frase?(a: AgentActivity): Promise<string>;
	/** l'attesa tra due controlli (le prove la accorciano) */
	pausa?(ms: number): Promise<void>;
}

/** Da quanto deve lavorare una sessione prima che l'isola la annunci: un `ls` nel terminale non accende niente. */
export const ATTESA_ISOLA_MS: Record<string, number> = { terminale: 8000, cline: 3000, codex: 3000 };

export class IsolaAttivita {
	private prima = new Map<string, AgentActivity['status']>();
	/** le sessioni annunciate come al lavoro: solo di queste si dice la fine */
	private annunciate = new Set<string>();
	private inAttesa = new Map<string, ReturnType<typeof setTimeout>>();
	private ultime: readonly AgentActivity[] = [];
	private coda: Promise<void> = Promise.resolve();
	private ripresa?: ReturnType<typeof setTimeout>;
	/** quando ogni sessione e' passata a «in corso»: la durata del lavoro di cui si avvisa la fine */
	private inizio = new Map<string, number>();
	/** gli avvisi a voce, uno dopo l'altro e a parte: chi aspetta una chiacchierata non ferma l'isola scritta */
	private codaAvvisi: Promise<void> = Promise.resolve();
	private chiusa = false;
	/** l'isola esce dopo 15 minuti senza richieste: ogni 5 minuti si ricorda chi lavora ancora */
	private richiamo = setInterval(() => {
		const ancora = this.ultime.filter(x => this.annunciate.has(x.key) && x.status === 'in corso').sort((x, y) => y.updatedAt - x.updatedAt)[0];
		if (ancora) this.manda(statoPerIsola(ancora, undefined)!);
	}, 5 * 60_000);
	constructor(private readonly d: IsolaDeps = isolaVera(), private readonly attese = ATTESA_ISOLA_MS) {}

	/** Il registro delle attivita' e' cambiato: per le fonti dell'isola, i cambi di stato vanno all'isola. */
	aggiorna(activity: readonly AgentActivity[]): void {
		this.ultime = activity;
		for (const a of activity) {
			if (!(FONTI_ISOLA as readonly string[]).includes(a.source)) continue;
			const prima = this.prima.get(a.key);
			const s = statoPerIsola(a, prima);
			this.prima.set(a.key, a.status);
			if (!s) continue;
			if (a.status === 'in corso') this.inizio.set(a.key, Date.now());
			if (s.stato === 'pensa') {
				// si annuncia solo se lavora ancora dopo l'attesa della sua fonte
				clearTimeout(this.inAttesa.get(a.key));
				this.inAttesa.set(a.key, setTimeout(() => {
					this.inAttesa.delete(a.key);
					const ora = this.ultime.find(x => x.key === a.key);
					if (ora?.status !== 'in corso') return;
					this.annunciate.add(a.key);
					this.manda(statoPerIsola(ora, undefined)!);
				}, this.attese[a.source] ?? 3000));
				continue;
			}
			clearTimeout(this.inAttesa.get(a.key));
			this.inAttesa.delete(a.key);
			const iniziata = this.inizio.get(a.key);
			this.inizio.delete(a.key);
			if (!this.annunciate.delete(a.key)) continue;
			const durata = iniziata === undefined ? 0 : Date.now() - iniziata;
			if (this.d.avvisoAcceso?.() && daAvvisare(a, durata)) this.avvisa(a, s);
			else this.manda(s);
			// finito uno, se altri annunciati lavorano ancora l'isola torna su di loro dopo il «pronto»
			const ancora = this.ultime.filter(x => this.annunciate.has(x.key) && x.status === 'in corso').sort((x, y) => y.updatedAt - x.updatedAt)[0];
			clearTimeout(this.ripresa);
			if (ancora) this.ripresa = setTimeout(() => this.manda(statoPerIsola(ancora, undefined)!), 2500);
		}
	}

	private manda(s: StatoIsola): void {
		this.coda = this.coda.then(() => this.mostra(s)).catch(() => undefined);
	}

	private avvisa(a: AgentActivity, s: StatoIsola): void {
		this.codaAvvisi = this.codaAvvisi.then(() => this.diAvviso(a, s)).catch(() => undefined);
	}

	/**
	 * La fine detta a voce: la frase (il cervello ci mette qualche secondo), poi si aspetta che Andrea non stia parlando con
	 * Melissa e che il microfono dell'isola sia chiuso, fino a AVVISO_ATTESA_MS; oltre, o se l'isola non parla, resta lo
	 * stato scritto di sempre. La fila con le voci delle altre sessioni la tiene l'isola (CodaVoci, build 152).
	 */
	private async diAvviso(a: AgentActivity, s: StatoIsola): Promise<void> {
		const pausa = this.d.pausa ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
		const testo = (await this.d.frase?.(a).catch(() => '')) || s.testo;
		const libera = async () => {
			if (this.d.occupata?.()) return false;
			const p = await this.d.manda('/ping');
			return !p || p.ascolta !== true;
		};
		for (let t = 0; t < AVVISO_ATTESA_MS && !this.chiusa && !(await libera()); t += 2000) await pausa(2000);
		if (this.chiusa) return;
		if (!(await libera())) {
			this.d.log?.(`isola: avviso non detto, Melissa era occupata: ${testo}`);
			return this.mostra(s);
		}
		if (!(await this.d.manda('/ping'))) {
			await this.d.accendi();
			if (!(await this.d.manda('/ping'))) return;
		}
		const r = await this.d.manda('/parla', { sessione: SESSIONE_AVVISI, testo, final: true });
		if (!r) return this.mostra(s);
		this.d.log?.(`isola: avviso a voce${r.inCoda === true ? ', in fila dietro un\'altra voce' : ''}: ${testo}`);
	}

	private async mostra(s: StatoIsola): Promise<void> {
		let ping = await this.d.manda('/ping');
		if (!ping) {
			// solo per dire che qualcuno lavora vale la pena accenderla
			if (s.stato !== 'pensa') return;
			await this.d.accendi();
			ping = await this.d.manda('/ping');
			if (!ping) return;
		}
		if (ping.parla === true || ping.ascolta === true) return;
		await this.d.manda('/stato', s.stato === 'riposo' ? { stato: 'riposo' } : s);
		this.d.log?.(`isola: ${s.stato}, ${s.testo}`);
	}

	dispose(): void {
		this.chiusa = true;
		clearInterval(this.richiamo);
		clearTimeout(this.ripresa);
		for (const t of this.inAttesa.values()) clearTimeout(t);
		this.inAttesa.clear();
	}
}

/** L'isola vera: il socket ~/.bottega/nucleo/isola.sock e il Nucleo a cui punta ~/.bottega/bin/nucleo. */
export function isolaVera(casa = process.env.BOTTEGA_HOME || path.join(os.homedir(), '.bottega')): IsolaDeps {
	const sock = path.join(casa, 'nucleo', 'isola.sock');
	const manda = (percorso: string, corpo?: Record<string, unknown>) =>
		new Promise<Record<string, unknown> | null>(ok => {
			const testo = corpo ? JSON.stringify(corpo) : undefined;
			const req = http.request({ socketPath: sock, path: percorso, method: corpo ? 'POST' : 'GET', headers: testo ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(testo) } : {}, timeout: 1000 }, res => {
				let b = '';
				res.setEncoding('utf8');
				res.on('data', c => (b += c));
				res.on('end', () => {
					try {
						const j = JSON.parse(b || '{}');
						ok(res.statusCode && res.statusCode < 300 && j.ok !== false ? j : null);
					} catch {
						ok(null);
					}
				});
			});
			req.on('timeout', () => req.destroy());
			req.on('error', () => ok(null));
			if (testo) req.write(testo);
			req.end();
		});
	const accendi = async () => {
		let exe = '';
		try {
			exe = fs.realpathSync(path.join(casa, 'bin', 'nucleo'));
		} catch {
			return;
		}
		const app = exe.replace(/\/Contents\/MacOS\/[^/]+$/, '');
		if (!app.endsWith('.app')) return;
		await new Promise<void>(ok => execFile('/usr/bin/open', ['-n', '-g', '--stderr', path.join(casa, 'nucleo', 'isola.log'), '-a', app, '--args', '--isola'], () => ok()));
		for (let i = 0; i < 30; i++) {
			await new Promise(r => setTimeout(r, 150));
			if (await manda('/ping')) return;
		}
	};
	return { manda, accendi };
}
