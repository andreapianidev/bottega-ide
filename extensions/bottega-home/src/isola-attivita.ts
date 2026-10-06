// L'isola nella tacca segue anche Cline, Codex e i terminali integrati, sempre (Andrea, 6 ottobre 2026; docs/CONTRATTI.md,
// sezione 1, «L'isola segue anche Cline, Codex e i terminali»). Le sessioni di Claude Code l'isola le segue gia' con la
// mod melissa; queste altre fonti la Bottega le osserva nel registro delle attivita' (AgentActivity) e qui, a ogni cambio
// di stato, lo dice all'isola sul suo socket (`POST /stato`): al lavoro = `pensa` con il titolo, finito, in attesa o
// errore = `pronto` (si ritira da sola). Se l'isola non c'e' la si accende come fa la mod (LaunchServices, `--isola`).
// Mai mentre l'isola parla o ascolta: la voce e il microfono di Melissa vengono prima.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AgentActivity } from './attivita-tipi';

export const FONTI_ISOLA = ['cline', 'codex', 'terminale'] as const;
const NOMI: Record<string, string> = { cline: 'Cline', codex: 'Codex', terminale: 'Il terminale' };

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
			if (!this.annunciate.delete(a.key)) continue;
			this.manda(s);
			// finito uno, se altri annunciati lavorano ancora l'isola torna su di loro dopo il «pronto»
			const ancora = this.ultime.filter(x => this.annunciate.has(x.key) && x.status === 'in corso').sort((x, y) => y.updatedAt - x.updatedAt)[0];
			clearTimeout(this.ripresa);
			if (ancora) this.ripresa = setTimeout(() => this.manda(statoPerIsola(ancora, undefined)!), 2500);
		}
	}

	private manda(s: StatoIsola): void {
		this.coda = this.coda.then(() => this.mostra(s)).catch(() => undefined);
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
