// Comandi della Memoria per la parte nativa (Apple Intelligence sul Mac), chiamati da cli.mjs:
//   classifica [--tutte] [--limite N] [--json]   categoria delle sessioni riassunte (in fondo, bassa priorita')
//   categorie [--giorni N] --json                mappa sessione -> categoria
//   contestuale [--limite N] [--json]            vettori contestuali mancanti
import { classifica, classificaTutte, mappa } from './categorie.mjs';
import { embedCtxPending, hasCtx } from './contestuale.mjs';

export const NATIVO_COMANDI = ['classifica', 'categorie', 'contestuale'];

export function nativoComando(cmd, args, print) {
	const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
	switch (cmd) {
		case 'classifica': {
			const r = args.includes('--tutte') ? classificaTutte() : classifica({ limite: Number(opt('--limite', 8)) || 8 });
			const text = r.code === 2
				? 'Apple Intelligence non e\' disponibile: nessuna sessione classificata.'
				: `Classificate ${r.fatte} sessioni, ne restano ${r.restano}.`;
			print(r, text);
			return r.code === 2 ? 2 : 0;
		}
		case 'categorie': {
			const g = opt('--giorni');
			const m = mappa({ giorni: g ? Number(g) : undefined });
			print(m, Object.entries(m).map(([s, c]) => `${s} ${c}`).join('\n') || 'Nessuna sessione classificata.');
			return 0;
		}
		case 'contestuale': {
			const limite = Number(opt('--limite', 256)) || 256;
			let n = 0;
			for (let k; (k = embedCtxPending(undefined, 48)) && n < limite; ) n += k;
			print({ scritti: n, presenti: hasCtx() }, `Vettori contestuali scritti: ${n}.`);
			return 0;
		}
	}
	return undefined;
}
