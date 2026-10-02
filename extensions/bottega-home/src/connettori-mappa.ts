/* La mappa dei connettori: quale connettore di Claude Code accende quale capacita' della Bottega.

   Un connettore si riconosce dal nome "pulito" (minuscolo, senza "claude.ai " e senza "plugin:<nome>:"):
   "claude.ai Google Calendar" diventa "google calendar", "plugin:sales:gmail" diventa "gmail".
   Ogni voce e' una parola esatta o un'espressione regolare tra barre ("/^mail/").

   L'impostazione `bottega.connettori.mappa` aggiunge voci con la stessa forma: { "posta": ["mio-imap"] }.
   Contratto: docs/CONTRATTI.md, sezione 5. */

export interface Capacita {
	id: string;
	nome: string;
	/** Una frase su cosa accende nella Bottega. */
	cosa: string;
}

export const CAPACITA: Capacita[] = [
	{ id: 'posta', nome: 'Posta', cosa: 'i fili di posta di ogni progetto' },
	{ id: 'calendario', nome: 'Calendario', cosa: 'gli appuntamenti della giornata' },
	{ id: 'deploy', nome: 'Pubblicazioni', cosa: 'lo stato delle pubblicazioni dei siti' },
	{ id: 'store', nome: 'Store', cosa: 'le app su App Store e Google Play' },
	{ id: 'file', nome: 'File', cosa: 'i documenti condivisi' },
	{ id: 'pagamenti', nome: 'Pagamenti', cosa: 'incassi e abbonamenti' },
	{ id: 'pubblicita', nome: 'Pubblicità', cosa: 'i guadagni della pubblicità nelle app' },
	{ id: 'ricerca', nome: 'Motori di ricerca', cosa: 'il traffico dai motori di ricerca' },
];

export const MAPPA_BASE: Record<string, string[]> = {
	posta: ['gmail', 'mail-mcp', '/^(apple-)?mail$/', 'microsoft-365'],
	calendario: ['google calendar', 'calendly'],
	deploy: ['vercel', 'netlify'],
	store: ['asc-mcp', 'google-play', '/app-?store-?connect/'],
	file: ['google drive', 'egnyte'],
	pagamenti: ['stripe'],
	pubblicita: ['admob'],
	ricerca: ['searchconsole', '/search-?console/'],
};

/** Strumenti di sola lettura da usare, per capacita' e per connettore (nome pulito). Il resto non si usa. */
export const STRUMENTI: Record<string, Record<string, string[]>> = {
	posta: {
		gmail: ['search_threads', 'get_thread', 'list_labels'],
		'mail-mcp': ['search_messages', 'list_accounts', 'list_mailboxes'],
	},
	calendario: { 'google calendar': ['list_events', 'list_calendars', 'search_events', 'get_event'] },
	deploy: { vercel: ['list_deployments', 'list_projects', 'get_deployment', 'list_teams'] },
	file: { 'google drive': ['search_files', 'list_recent_files', 'get_file_metadata'] },
};
