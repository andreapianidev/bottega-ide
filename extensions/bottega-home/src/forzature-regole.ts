// Le regole violate come forzature, per chi ha il mestiere `forzature` (Darlene; docs/CONTRATTI.md 9.11). Quando la
// Vedetta (src/regole.ts) trova una regola rossa in un progetto, una voce nello spool della Memoria: una al giorno per
// progetto e regola (l'id porta la data), e una volta sola per processo, perche' onChange scatta spesso.

import * as crypto from 'crypto';
import { isoGiorno } from './impegni';
import type { RegistraMemoria } from './memoria-personaggi';
import { chiDelMestiere } from './personaggi';
import type { RulesState } from './tipi';

const scritte = new Set<string>();

export function forzatureDalleRegole(s: RulesState, registra: RegistraMemoria | undefined, now = Date.now()): number {
	const chi = chiDelMestiere('forzature');
	if (!chi || !registra || s.running || !s.checkedAt) return 0;
	const giorno = isoGiorno(now);
	let n = 0;
	for (const [percorso, r] of Object.entries(s.projects)) {
		for (const h of r.hits) {
			if (h.livello !== 'rosso') continue;
			const id = `regola-${crypto.createHash('sha1').update(percorso).digest('hex').slice(0, 10)}-${h.id}-${giorno}`;
			if (scritte.has(id)) continue;
			scritte.add(id);
			void registra({ source: 'mestiere', sid: chi, id, cwd: percorso, at: now, text: `una regola violata: ${h.frase}`, tipo: 'forzatura', cosa: `regola-${h.id}` }).catch(() => undefined);
			n++;
		}
	}
	return n;
}
