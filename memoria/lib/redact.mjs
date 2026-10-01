// Pulizia dei testi: via le chiavi prima che tocchino il disco o la rete, via le lineette lunghe
// da tutto cio' che un utente legge.

const RULES = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[chiave privata nascosta]'],
	[/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, '[chiave nascosta]'],
	[/\bwhsec_[A-Za-z0-9]{10,}/g, '[chiave nascosta]'],
	[/\bsk-[A-Za-z0-9_-]{16,}/g, '[chiave nascosta]'],
	[/\bre_[A-Za-z0-9_]{16,}/g, '[chiave nascosta]'],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[token nascosto]'],
	[/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[token nascosto]'],
	[/\bAKIA[0-9A-Z]{16}\b/g, '[chiave nascosta]'],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[token nascosto]'],
	[/\bAIza[0-9A-Za-z_-]{30,}/g, '[chiave nascosta]'],
	[/\bhf_[A-Za-z0-9]{20,}/g, '[token nascosto]'],
	[/\b(?:sbp|sbs)_[A-Za-z0-9]{20,}/g, '[token nascosto]'],
	[/\b((?:[a-z][a-z0-9+.-]*):\/\/[^:\s/@]+:)[^@\s]{3,}@/gi, '$1[nascosta]@'],
	[/\b([A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Z0-9_]*\s*[=:]\s*)["']?[^\s"']{6,}["']?/g, '$1[nascosto]'],
	[/((?:api[_-]?key|token|secret|password|passwd|parola d'ordine)["']?\s*[:=]\s*)["']?[^\s"',}]{6,}["']?/gi, '$1[nascosto]'],
];

export function redact(text) {
	if (!text) return '';
	let s = String(text);
	for (const [re, rep] of RULES) s = s.replace(re, rep);
	return s;
}

/** Niente lineette lunghe o medie nel testo che legge un utente. */
// Parole italiane che i modelli a volte scrivono con l'apostrofo al posto dell'accento ("e'", "gia'").
// Solo un elenco chiuso: una regola generica sulle vocali rovinerebbe codice e parole tra virgolette.
const ACCENTI = {
	e: 'è', gia: 'già', piu: 'più', puo: 'può', pero: 'però', cioe: 'cioè', cosi: 'così', perche: 'perché',
	poiche: 'poiché', finche: 'finché', benche: 'benché', affinche: 'affinché', nonche: 'nonché',
	sara: 'sarà', fara: 'farà', avra: 'avrà', potra: 'potrà', dovra: 'dovrà', verra: 'verrà', andra: 'andrà',
	citta: 'città', attivita: 'attività', funzionalita: 'funzionalità', possibilita: 'possibilità',
	qualita: 'qualità', novita: 'novità', priorita: 'priorità', modalita: 'modalità', quantita: 'quantità',
	realta: 'realtà', verita: 'verità', utilita: 'utilità', velocita: 'velocità', capacita: 'capacità',
	complessita: 'complessità', compatibilita: 'compatibilità', disponibilita: 'disponibilità',
	visibilita: 'visibilità', stabilita: 'stabilità', identita: 'identità', unita: 'unità', proprieta: 'proprietà',
	lunedi: 'lunedì', martedi: 'martedì', mercoledi: 'mercoledì', giovedi: 'giovedì', venerdi: 'venerdì',
};
const ACCENTI_RE = new RegExp(`(^|[^\\p{L}'])(${Object.keys(ACCENTI).join('|')})'(?=[\\s.,;:!?)\\]»"]|$)`, 'giu');

export function accenti(text) {
	if (!text) return '';
	return String(text)
		.replace(ACCENTI_RE, (_, pre, w) => {
			const low = w.toLowerCase();
			const acc = ACCENTI[low];
			return pre + (w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase() ? acc[0].toUpperCase() + acc.slice(1) : acc);
		})
		// "è" a inizio testo o di frase va maiuscola: il modello a volte scrive "e'" minuscolo anche li'.
		.replace(/(^|[.!?]\s+|\n\s*)è(?=\s)/g, '$1È');
}

export function undash(text) {
	if (!text) return '';
	return accenti(text)
		.replace(/\s*—\s*/g, ', ')
		.replace(/(\d)\s*–\s*(\d)/g, '$1-$2')
		.replace(/\s*–\s*/g, ', ')
		.replace(/,\s*,/g, ',');
}

export function clip(text, n) {
	const s = String(text ?? '').replace(/\s+/g, ' ').trim();
	return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Testo di una richiesta dell'utente cosi' come la vuole la memoria: senza promemoria di sistema,
 * senza i contenitori dei testi incollati, vuoto per notifiche e uscite di comandi locali.
 */
export function cleanPrompt(text) {
	let s = String(text ?? '');
	s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
	s = s.replace(/<\/?pasted_content[^>]*>/g, '');
	s = s.trim();
	if (!s) return '';
	if (s.startsWith('<command-name>')) {
		const name = /<command-name>([^<]*)<\/command-name>/.exec(s)?.[1]?.trim() || '';
		const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1]?.trim() || '';
		return args ? `${name} ${args}` : '';
	}
	if (/^<(local-command|task-notification|bash-|user-memory-input|tick)/.test(s)) return '';
	if (s.startsWith('[Request interrupted')) return '';
	if (s.startsWith('Caveat: The messages below were generated')) return '';
	return s;
}
