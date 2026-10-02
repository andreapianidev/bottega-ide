// Comandi della Memoria per la parte nativa (Apple Intelligence sul Mac), chiamati da cli.mjs:
//   classifica [--tutte] [--limite N] [--json]   categoria delle sessioni riassunte (in fondo, bassa priorita')
//   categorie [--giorni N] --json                mappa sessione -> categoria
//   immagini [--limite N] [--giorni N] [--riprova] [--json]
//                                                schermate delle trascrizioni -> OCR del Nucleo -> ricordi
import { classifica, classificaTutte, mappa } from './categorie.mjs';

export const NATIVO_COMANDI = ['classifica', 'categorie', 'immagini'];

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
		case 'immagini': {
			return import('./immagini.mjs').then(async ({ giro }) => {
				const r = await giro({ limite: Math.max(0, Number(opt('--limite', 40)) || 0), giorni: Number(opt('--giorni', 90)) || 90, riprova: args.includes('--riprova') });
				const avviso = {
					'senza-ocr': 'Il Nucleo installato non sa ancora leggere le immagini (manca il comando ocr): nessuna letta.',
					assente: 'Il Nucleo non c\'e\': nessuna immagine letta.',
					occupato: 'Un altro giro sulle immagini e\' gia\' in corso.',
				}[r.nucleo];
				const riga = `Immagini lette ${r.lette}, ricordi nuovi ${r.nuove}, saltate ${r.saltate}, errori ${r.errori}, ne restano ${r.restano} (${(r.ms / 1000).toFixed(1)} s).`;
				print(r, avviso ? `${avviso}\n${riga}` : riga);
				return 0;
			});
		}
	}
	return undefined;
}
