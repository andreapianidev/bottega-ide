// Pochi strumenti di sola lettura per ciascun personaggio (docs/CONTRATTI.md 9.11, «Strumenti dei personaggi»). Chi ha
// quali lo dice il campo `strumenti` del suo file; li esegue sempre la barra, anche quando li chiede la mod (azione
// `strumento` della regia). Solo lettura, mai scrittura, mai comandi; al piu' 1,5 s per lettura e testo breve: un ospite
// lento rovina la conversazione a voce.

import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import type { MestierePersonaggio } from './memoria-personaggi';
import { PERSONAGGI, esiste } from './personaggi';
import type { RulesState } from './tipi';

export const STRUMENTI_PERSONAGGI = ['vedetta_leggi', 'mestiere_leggi', 'bacheca_leggi'] as const;
export type StrumentoPersonaggio = (typeof STRUMENTI_PERSONAGGI)[number];

/** Al piu' tanto per una lettura, e tanti giri di strumenti per battuta. */
export const STRUMENTO_MS = 1500;
export const GIRI_STRUMENTI = 2;

type Spec = { type: 'function'; function: { name: string; description: string; parameters: any } };

const DESCRIZIONE_MESTIERE: Record<string, string> = {
	incidenti: 'gli incidenti di sicurezza della settimana (chiavi lette, segreti nel diff, push forzati, reset --hard, rm -rf), con quante volte',
	impegni: 'gli impegni che Andrea ha preso a voce: aperti, scaduti, fatti',
	forzature: 'le forzature di Claude e degli agenti (comandi distruttivi, test saltati, regole violate), con quante volte',
};

export interface FontiStrumenti {
	/** lo stato delle regole della Vedetta (src/regole.ts), se c'e' */
	regole(): RulesState | undefined;
	/** il mestiere di un personaggio dalla Memoria (cli personaggio) */
	mestiere(chi: string): Promise<MestierePersonaggio | undefined>;
	/** le sessioni e i lavori aperti adesso, in una riga */
	sessioni(): string;
	/** `cli.mjs orari --json`; senza, lo legge qui con la Memoria installata */
	orari?(): Promise<string>;
}

const casa = () => process.env.BOTTEGA_HOME || path.join(os.homedir(), '.bottega');

function orariVeri(): Promise<string> {
	const h = casa();
	return new Promise((ok, no) =>
		execFile(path.join(h, 'bin', 'node'), [path.join(h, 'memoria-app', 'cli.mjs'), 'orari', '--json'], { timeout: STRUMENTO_MS, maxBuffer: 1 << 20 }, (e, out) => (e ? no(e) : ok(String(out)))),
	);
}

/** "06/10 23:40" come lo direbbe a voce: "alle 23:40", "ieri alle 2:10". */
function quando(at: number, now = Date.now()): string {
	const d = new Date(at);
	const ora = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
	const giorni = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
	return giorni <= 0 ? `alle ${ora}` : giorni === 1 ? `ieri alle ${ora}` : `il ${d.getDate()}/${d.getMonth() + 1} alle ${ora}`;
}

export class StrumentiPersonaggi {
	constructor(private readonly f: FontiStrumenti) {}

	/** Gli strumenti di `chi`, nel formato Chat Completions; [] se non ne ha. */
	specs(chi: string): Spec[] {
		if (!esiste(chi)) return [];
		const p = PERSONAGGI[chi]!;
		return (p.strumenti ?? []).map(nome => {
			const description = nome === 'vedetta_leggi'
				? 'Legge i risultati della Vedetta della Bottega: le regole rosse e gialle dei progetti di Andrea (segreti, push, build, repository pubblici). Sola lettura.'
				: nome === 'mestiere_leggi'
					? `Legge la memoria del tuo mestiere nella Bottega: ${DESCRIZIONE_MESTIERE[p.mestiere ?? ''] ?? 'quello che hai visto'}. Sola lettura.`
					: 'Legge la bacheca della Bottega: le sessioni aperte adesso, da quanto Andrea lavora di fila, se ha lavorato di notte. Sola lettura.';
			return { type: 'function' as const, function: { name: nome, description, parameters: { type: 'object', properties: {} } } };
		});
	}

	/** Esegue uno strumento di `chi`, se e' suo: testo breve per il modello, mai un'eccezione, al piu' STRUMENTO_MS. */
	async esegui(chi: string, nome: string): Promise<string> {
		if (!esiste(chi) || !(PERSONAGGI[chi]!.strumenti ?? []).includes(nome as StrumentoPersonaggio)) return `Lo strumento ${nome} non e' tuo.`;
		let t: ReturnType<typeof setTimeout> | undefined;
		try {
			const r = await Promise.race([this.leggi(chi, nome as StrumentoPersonaggio), new Promise<string>(ok => (t = setTimeout(() => ok('La lettura non e\' arrivata in tempo: rispondi senza.'), STRUMENTO_MS)))]);
			return r.slice(0, 1500);
		} catch (e: any) {
			return `La lettura non e' riuscita (${e?.message ?? e}): rispondi senza.`;
		} finally {
			clearTimeout(t);
		}
	}

	private async leggi(chi: string, nome: StrumentoPersonaggio): Promise<string> {
		if (nome === 'vedetta_leggi') {
			const s = this.f.regole();
			if (!s?.checkedAt) return 'La Vedetta non ha ancora controllato i progetti.';
			const righe: string[] = [];
			for (const [percorso, r] of Object.entries(s.projects)) {
				for (const h of r.hits) if (h.livello === 'rosso') righe.push(`${path.basename(percorso)}: ${h.frase}`);
			}
			for (const h of s.global) if (h.livello === 'rosso') righe.push(`tutti i progetti: ${h.frase}`);
			return `Vedetta, controllata ${quando(s.checkedAt)}: ${s.counts.rosso} progetti in rosso, ${s.counts.giallo} in giallo, ${s.counts.verde} in verde.${righe.length ? ` Le regole rosse: ${righe.slice(0, 8).join('; ')}.` : ' Nessuna regola rossa.'}`;
		}
		if (nome === 'mestiere_leggi') {
			const m = await this.f.mestiere(chi);
			return m?.frase || 'Nella memoria del tuo mestiere non c\'e\' niente di recente.';
		}
		const sessioni = this.f.sessioni();
		let orari = '';
		try {
			const o = JSON.parse(await (this.f.orari ?? orariVeri)());
			const fila = o?.minutiDiFila > 0 ? `Andrea lavora di fila da ${o.minutiDiFila >= 90 ? `${Math.round(o.minutiDiFila / 6) / 10} ore` : `${o.minutiDiFila} minuti`} (dalle ${quando(o.inizioTratto).replace(/^alle /, '')})` : 'Andrea adesso non risulta al lavoro';
			const notti = Array.isArray(o?.notti) && o.notti.length ? ` Di notte, negli ultimi giorni: ${o.notti.map((n: any) => `${n.azioni} azioni, l'ultima ${quando(n.ultima)}`).join('; ')}.` : ' Niente lavoro di notte negli ultimi giorni.';
			orari = `${fila}.${notti}`;
		} catch {
			orari = 'Gli orari di lavoro non si leggono adesso.';
		}
		return `${orari} Aperte adesso: ${sessioni || 'nessuna sessione'}.`;
	}
}
