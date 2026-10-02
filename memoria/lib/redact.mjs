import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Pulizia dei testi: via le chiavi prima che tocchino il disco o la rete, via le lineette lunghe
// da tutto cio' che un utente legge.

// [schema, sostituzione, tipo, forte]. "forte": la forma basta a dire che e' una chiave; le ultime
// due regole guardano solo il nome di una variabile e da sole danno falsi allarmi nel codice.
const RULES = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[chiave privata nascosta]', 'chiave privata', true],
	[/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, '[chiave nascosta]', 'chiave Stripe', true],
	[/\bwhsec_[A-Za-z0-9]{10,}/g, '[chiave nascosta]', 'segreto di webhook Stripe', true],
	[/\bsk-[A-Za-z0-9_-]{16,}/g, '[chiave nascosta]', 'chiave sk- (OpenAI, Anthropic e simili)', true],
	[/\bre_[A-Za-z0-9_]{16,}/g, '[chiave nascosta]', 'chiave Resend', true],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[token nascosto]', 'token JWT', true],
	[/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[token nascosto]', 'token GitHub', true],
	[/\bAKIA[0-9A-Z]{16}\b/g, '[chiave nascosta]', 'chiave AWS', true],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[token nascosto]', 'token Slack', true],
	[/\bAIza[0-9A-Za-z_-]{30,}/g, '[chiave nascosta]', 'chiave Google', true],
	[/\bhf_[A-Za-z0-9]{20,}/g, '[token nascosto]', 'token Hugging Face', true],
	[/\b(?:sbp|sbs)_[A-Za-z0-9]{20,}/g, '[token nascosto]', 'chiave Supabase', true],
	[/\b((?:[a-z][a-z0-9+.-]*):\/\/[^:\s/@]+:)[^@\s]{3,}@/gi, '$1[nascosta]@', 'password dentro un indirizzo', true],
	[/\b([A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Z0-9_]*\s*[=:]\s*)["']?[^\s"']{6,}["']?/g, '$1[nascosto]', 'variabile segreta', false],
	[/((?:api[_-]?key|token|secret|password|passwd|parola d'ordine)["']?\s*[:=]\s*)["']?[^\s"',}]{6,}["']?/gi, '$1[nascosto]', 'campo segreto', false],
];

// Valori da nascondere sempre, anche se scritti in chat senza nome davanti: tutti i valori del vault
// locale (~/.secrets/*.env, se esiste) e le righe di ~/.bottega/memoria/nascondi.txt. Restano solo in
// memoria del processo: non vengono mai scritti da nessuna parte.
let SECRETS;
const SECRET_NAME = /(PASS|PWD|SECRET|TOKEN|KEY|PRIVATE|CREDENTIAL|AUTH|SIGNING|SALT|DSN|CONNECTION|DATABASE_URL)/i;
const NOT_SECRET_NAME = /(_ID|_URL|_USER|_USERNAME|_EMAIL|_HOST|_PORT|_NAME|_PATH|_MODEL|_REGION|_TEAM|_ISSUER|PUBLIC|PUBLISHABLE)$/i;
function localSecrets() {
	if (SECRETS) return SECRETS;
	const found = new Set();
	const add = v => {
		v = String(v || '').trim().replace(/^["']|["']$/g, '');
		if (v.length >= 8 && !/^(true|false|null|\d+)$/i.test(v)) found.add(v);
	};
	const home = os.homedir();
	try {
		const dir = path.join(home, '.secrets');
		for (const f of fs.readdirSync(dir)) {
			if (!f.endsWith('.env')) continue;
			for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
				// Solo i valori con un nome da segreto (password, chiavi, token): nomi utente, indirizzi,
				// email e identificativi del vault non sono segreti e nasconderli rovina i testi.
				const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line);
				if (m && !m[2].startsWith('#') && SECRET_NAME.test(m[1]) && !NOT_SECRET_NAME.test(m[1])) add(m[2]);
			}
		}
	} catch {
		// nessun vault su questo Mac
	}
	try {
		for (const line of fs.readFileSync(path.join(process.env.BOTTEGA_HOME || path.join(home, '.bottega'), 'memoria', 'nascondi.txt'), 'utf8').split('\n')) add(line);
	} catch {
		// nessun elenco locale
	}
	SECRETS = [...found].sort((a, b) => b.length - a.length);
	return SECRETS;
}

/**
 * Dove sono le chiavi in un testo, con gli stessi schemi di redact: tipo e posizione, mai il valore.
 * Una posizione gia' coperta da una regola precedente non conta due volte.
 */
export function findSecrets(text) {
	const out = [];
	if (!text) return out;
	const s = String(text);
	const taken = [];
	for (const [re, , tipo, forte] of RULES) {
		const r = new RegExp(re.source, re.flags);
		let m;
		while ((m = r.exec(s))) {
			const start = m.index;
			const end = start + m[0].length;
			if (!m[0].length) {
				r.lastIndex++;
				continue;
			}
			if (taken.some(([a, b]) => start < b && end > a)) continue;
			taken.push([start, end]);
			out.push({ rule: tipo, index: start, length: m[0].length, strong: forte });
		}
	}
	return out.sort((a, b) => a.index - b.index);
}

export function redact(text) {
	if (!text) return '';
	let s = String(text);
	for (const v of localSecrets()) if (s.includes(v)) s = s.split(v).join('[segreto nascosto]');
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
