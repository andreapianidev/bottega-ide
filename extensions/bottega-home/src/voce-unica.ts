// Una Melissa sola sul Mac (docs/CONTRATTI.md, 4.11, «Chi ha la voce»; Andrea, 15 ottobre 2026: «devono essere la
// stessa cosa»). Sul Mac ci sono tre Melissa che parlano e ascoltano: la barra della Bottega (questa), l'isola di
// Claude Code (il Nucleo in --isola) e Melissa di Avo Agency AI (sfera fluttuante e sfera in finestra). Una voce alla
// volta: chi apre il microfono o comincia a parlare per Andrea scrive ~/.bottega/voce/chi.json
//
//   {"chi": "bottega" | "avo" | "isola" | "", "pid": 123, "at": 1760000000.5, "personaggio": "melissa"}
//
// (`at` in secondi, scrittura atomica con file temporaneo e rename), chi smette e la teneva scrive `chi: ""`. Tutti
// guardano la cartella: se la voce la prende un altro, si tace e si molla il microfono. Chi prende la voce zittisce
// anche l'isola con POST /zitta senza sessione, che tace subito e svuota la sua fila.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface PresaVoce {
	chi: string;
	pid: number;
	at: number;
	personaggio?: string;
}

export const IO = 'bottega';

export function cartellaVoce(casa = process.env.BOTTEGA_HOME || path.join(os.homedir(), '.bottega')): string {
	return path.join(casa, 'voce');
}

export function leggiPresa(dir = cartellaVoce()): PresaVoce | undefined {
	try {
		const p = JSON.parse(fs.readFileSync(path.join(dir, 'chi.json'), 'utf8'));
		if (typeof p?.chi !== 'string' || typeof p?.pid !== 'number' || typeof p?.at !== 'number') return undefined;
		return p as PresaVoce;
	} catch {
		return undefined;
	}
}

export function scriviPresa(p: PresaVoce, dir = cartellaVoce()): void {
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tmp = path.join(dir, `.chi.${process.pid}.tmp`);
		fs.writeFileSync(tmp, JSON.stringify(p), { mode: 0o600 });
		fs.renameSync(tmp, path.join(dir, 'chi.json'));
	} catch {
		// senza file il patto non c'e', la voce funziona lo stesso
	}
}

/** La presa e' di un altro e piu' recente di tutto quello che abbiamo gia' visto o fatto. */
export function deveTacere(io: string, p: PresaVoce, giaVista: number): boolean {
	return p.chi !== '' && p.chi !== io && p.at > giaVista;
}

/** Si lascia solo la voce che e' nostra: mai cancellare la presa di un altro. */
export function daLasciare(io: string, pid: number, p: PresaVoce | undefined): boolean {
	return !!p && p.chi === io && p.pid === pid;
}

/** Il patto visto dalla barra: `prendi`, `lascia`, e `altri` chiamato quando un'altra Melissa prende la voce. */
export class VoceUnica {
	private giaVista = 0;
	private osserva?: fs.FSWatcher;
	private rilettura?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly altri: (p: PresaVoce) => void,
		private readonly zittisciIsola: () => void = () => undefined,
		private readonly dir = cartellaVoce(),
	) {
		try {
			fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			// la cartella, non il file: il rename sostituisce il file e un watcher sul file lo perderebbe
			this.osserva = fs.watch(this.dir, (_ev, nome) => {
				if (nome && String(nome) !== 'chi.json') return;
				clearTimeout(this.rilettura);
				this.rilettura = setTimeout(() => this.rileggi(), 50);
			});
			this.osserva.on('error', () => undefined);
		} catch {
			// senza watcher la barra non sente le altre, ma le altre sentono lei
		}
	}

	/** La barra apre il microfono o parla per Andrea: le altre Melissa tacciono. */
	prendi(personaggio?: string): void {
		const p: PresaVoce = { chi: IO, pid: process.pid, at: Date.now() / 1000, personaggio };
		this.giaVista = Math.max(this.giaVista, p.at);
		scriviPresa(p, this.dir);
		this.zittisciIsola();
	}

	/** La barra ha smesso: se la voce era sua torna libera. */
	lascia(): void {
		if (!daLasciare(IO, process.pid, leggiPresa(this.dir))) return;
		scriviPresa({ chi: '', pid: process.pid, at: Date.now() / 1000 }, this.dir);
	}

	rileggi(): void {
		const p = leggiPresa(this.dir);
		if (!p || !deveTacere(IO, p, this.giaVista)) return;
		this.giaVista = p.at;
		this.altri(p);
	}

	dispose(): void {
		this.osserva?.close();
		clearTimeout(this.rilettura);
	}
}
