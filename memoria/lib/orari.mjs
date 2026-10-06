// Gli orari di lavoro di Andrea per Krista (docs/CONTRATTI.md 9.11, strumento bacheca_leggi): da quando lavora di fila
// (una pausa di 90 minuti spezza il tratto) e le notti recenti (azioni fra le 23 e le 6, ora locale). Dalle osservazioni
// della Memoria, che vengono da tutte le sessioni: sola lettura.

/** Una pausa piu' lunga di questa chiude un tratto di lavoro. */
export const PAUSA_MS = 90 * 60_000;

export function orariDiLavoro(store, now = Date.now()) {
	const righe = store.all('SELECT at FROM observations WHERE at >= ? AND at <= ? ORDER BY at ASC', now - 4 * 86_400_000, now + 60_000).map(r => Number(r.at));
	if (!righe.length) return { ultima: 0, inizioTratto: 0, minutiDiFila: 0, notti: [] };
	const ultima = righe[righe.length - 1];
	let inizio = ultima;
	for (let i = righe.length - 2; i >= 0; i--) {
		if (inizio - righe[i] > PAUSA_MS) break;
		inizio = righe[i];
	}
	// le notti: dalle 23 alle 6, raggruppate col giorno in cui la notte comincia
	const notti = new Map();
	for (const at of righe) {
		const d = new Date(at);
		const h = d.getHours();
		if (h < 23 && h >= 6) continue;
		const inizioNotte = new Date(d);
		if (h < 6) inizioNotte.setDate(inizioNotte.getDate() - 1);
		const chiave = `${inizioNotte.getFullYear()}-${String(inizioNotte.getMonth() + 1).padStart(2, '0')}-${String(inizioNotte.getDate()).padStart(2, '0')}`;
		const n = notti.get(chiave) ?? { notte: chiave, azioni: 0, ultima: 0 };
		n.azioni++;
		n.ultima = Math.max(n.ultima, at);
		notti.set(chiave, n);
	}
	const lavora = now - ultima <= PAUSA_MS;
	return {
		ultima,
		inizioTratto: lavora ? inizio : 0,
		minutiDiFila: lavora ? Math.round((ultima - inizio) / 60_000) : 0,
		notti: [...notti.values()].sort((a, b) => b.ultima - a.ultima).slice(0, 3),
	};
}
