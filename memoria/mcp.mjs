#!/usr/bin/env node
// Server MCP della Memoria (stdio, JSON-RPC 2.0, una riga per messaggio).
// Strumenti: memoria_cerca, memoria_ricorda, memoria_recenti, memoria_sessione, memoria_bacheca.
process.removeAllListeners('warning');

import readline from 'node:readline';

const PROTOCOL = '2025-06-18';
const core = await import('./lib/core.mjs');
const { openStore } = await import('./lib/store.mjs');
const { clip } = await import('./lib/redact.mjs');

const TOOLS = [
	{
		name: 'memoria_cerca',
		description:
			"Cerca nella memoria delle sessioni Claude Code, Codex, Cline e attività integrate passate: riassunti, decisioni, fatti, note e richieste. Usalo prima di rifare un lavoro, quando l'utente cita qualcosa fatto in passato o quando ti serve sapere perche' una scelta e' stata presa.",
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Cosa cercare, in parole semplici.' },
				progetto: { type: 'string', description: 'Nome del progetto (cartella) per restringere la ricerca. Facoltativo.' },
				limite: { type: 'integer', description: 'Numero massimo di risultati (predefinito 8).', minimum: 1, maximum: 30 },
			},
			required: ['query'],
		},
	},
	{
		name: 'memoria_ricorda',
		description: 'Salva una nota da ricordare nelle sessioni future: una decisione, una convenzione, un problema noto. Le note entrano nel contesto di inizio sessione del progetto.',
		inputSchema: {
			type: 'object',
			properties: {
				testo: { type: 'string', description: 'La nota, in una o due frasi.' },
				progetto: { type: 'string', description: 'Progetto a cui legarla. Se manca, quello della cartella di lavoro.' },
			},
			required: ['testo'],
		},
	},
	{
		name: 'memoria_recenti',
		description: 'Le memorie piu\' recenti (riassunti di sessione, decisioni, fatti, note), per un progetto o per tutti.',
		inputSchema: {
			type: 'object',
			properties: {
				progetto: { type: 'string', description: 'Nome del progetto. Facoltativo.' },
				limite: { type: 'integer', description: 'Quante voci (predefinito 10).', minimum: 1, maximum: 50 },
			},
		},
	},
	{
		name: 'memoria_sessione',
		description: 'Dettaglio di una sessione passata: riassunto, decisioni, fatti e le ultime richieste e azioni registrate. Per Claude accetta anche i primi 8 caratteri dell\'id; per le altre fonti usa l\'id completo con prefisso.',
		inputSchema: {
			type: 'object',
			properties: { sessionId: { type: 'string', description: 'Id della sessione (o il suo inizio).' } },
			required: ['sessionId'],
		},
	},
	{
		name: 'memoria_bacheca',
		description:
			"Cosa stanno facendo adesso le sessioni e funzioni integrate sul Mac: richieste, file modificati, comandi lanciati, per progetto. Usalo quando l'utente chiede cosa fanno le altre sessioni o prima di toccare file che un'altra sessione potrebbe avere in mano.",
		inputSchema: {
			type: 'object',
			properties: {
				progetto: { type: 'string', description: 'Nome del progetto. Se manca, tutti.' },
				minuti: { type: 'integer', description: 'Finestra di tempo in minuti (predefinita 30).', minimum: 1, maximum: 1440 },
			},
		},
	},
];

const fmt = ts => new Date(ts).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const sessionLabel = id => /^(?:codex|cline|terminale|melissa):/.test(id) ? id : id.slice(0, 8);
const itemText = m =>
	`#${m.id} [${m.kind}] ${m.project}, ${fmt(m.createdAt)}${m.sessionId ? `, sessione ${sessionLabel(m.sessionId)}` : ''}${m.score !== undefined ? `, punteggio ${m.score}` : ''}\n${m.text.startsWith(m.title.replace(/\u2026$/, '')) ? '' : m.title + '\n'}${m.text}`;

function call(name, a = {}) {
	const store = openStore();
	switch (name) {
		case 'memoria_cerca': {
			core.ingest(store);
			const q = String(a.query || '').trim();
			if (!q) throw new Error('query vuota');
			const r = core.search(q, { progetto: a.progetto, limite: a.limite || 8, store });
			return r.length ? r.map(itemText).join('\n\n---\n\n') : `Niente in memoria per "${q}"${a.progetto ? ` nel progetto ${a.progetto}` : ''}.`;
		}
		case 'memoria_ricorda': {
			const m = core.remember(a.testo, { progetto: a.progetto, cwd: process.cwd(), store });
			return `Ricordato (#${m.id}, progetto ${m.project}): ${m.text}`;
		}
		case 'memoria_recenti': {
			core.ingest(store);
			const r = store.recent({ progetto: a.progetto, limite: a.limite || 10 });
			return r.length ? r.map(itemText).join('\n\n---\n\n') : 'Nessuna memoria ancora.';
		}
		case 'memoria_sessione': {
			core.ingest(store);
			const d = core.sessionDetail(String(a.sessionId || ''), store);
			if (!d) return 'Sessione non trovata in memoria.';
			const s = d.session;
			const head = [
				`Sessione ${s.id}`,
				`Progetto: ${s.project || 'home'}${s.cwd ? `, cartella ${s.cwd}` : ''}`,
				s.title ? `Titolo: ${s.title}` : '',
				`Periodo: ${s.startedAt ? fmt(s.startedAt) : '?'} - ${s.lastActivity ? fmt(s.lastActivity) : '?'}`,
				typeof s.prompts === 'number' ? `Richieste: ${s.prompts}, strumenti: ${s.tools}${s.engine ? `, riassunta con ${s.engine}` : ''}` : '',
			].filter(Boolean);
			const mem = d.memories.filter(m => m.kind !== 'prompt').map(m => `[${m.kind}] ${m.text}`);
			const obs = d.observations.map(o => `${fmt(o.at)} ${o.kind === 'prompt' ? `richiesta: ${clip(o.input, 200)}` : `${o.tool} ${clip((o.files || '').split('\n')[0] || o.input, 140)}`}`);
			return [head.join('\n'), mem.length ? `\nMemorie:\n${mem.join('\n')}` : '', obs.length ? `\nUltime attivita':\n${obs.join('\n')}` : ''].join('\n');
		}
		case 'memoria_bacheca': {
			const items = core.board({ progetto: a.progetto, minuti: a.minuti || 30 });
			if (!items.length) return `Nessuna attivita' di altre sessioni negli ultimi ${a.minuti || 30} minuti${a.progetto ? ` su ${a.progetto}` : ''}.`;
			const per = new Map();
			for (const e of items) {
				const k = `${e.project} | ${e.sessionId}`;
				per.set(k, [...(per.get(k) || []), e]);
			}
			const me = process.env.CLAUDE_SESSION_ID;
			return [...per]
				.map(([k, es]) => {
					const [project, sid] = k.split(' | ');
					return `${project}, sessione ${sessionLabel(sid)}${sid === me ? ' (questa)' : ''}:\n${es
						.slice(-12)
						.map(e => `  ${new Date(e.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} ${e.summary}`)
						.join('\n')}`;
				})
				.join('\n\n');
		}
		default:
			throw Object.assign(new Error(`strumento sconosciuto: ${name}`), { code: -32602 });
	}
}

function send(msg) {
	process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
	const { id, method, params } = msg;
	const isRequest = id !== undefined && id !== null;
	try {
		let result;
		switch (method) {
			case 'initialize':
				result = {
					protocolVersion: PROTOCOL,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'bottega-memoria', title: 'Memoria della Bottega', version: '1.0.0' },
					instructions:
						"Memoria persistente di Claude Code, Codex, Cline, Melissa e terminali integrati di questo Mac. Usa memoria_cerca prima di rifare un lavoro gia' fatto, memoria_ricorda per le decisioni da tenere, memoria_bacheca per sapere cosa fanno le altre sessioni aperte adesso.",
				};
				break;
			case 'ping':
				result = {};
				break;
			case 'tools/list':
				result = { tools: TOOLS };
				break;
			case 'tools/call': {
				const { syncSources } = await import('./lib/fonti.mjs');
				syncSources();
				const name = params?.name;
				if (!TOOLS.some(t => t.name === name)) throw Object.assign(new Error(`strumento sconosciuto: ${name}`), { code: -32602 });
				try {
					result = { content: [{ type: 'text', text: call(name, params?.arguments || {}) }] };
				} catch (e) {
					result = { content: [{ type: 'text', text: `Errore della memoria: ${e?.message || e}` }], isError: true };
				}
				break;
			}
			case 'resources/list':
				result = { resources: [] };
				break;
			case 'prompts/list':
				result = { prompts: [] };
				break;
			default:
				if (method?.startsWith('notifications/')) return; // initialized, cancelled: niente da rispondere
				if (isRequest) throw Object.assign(new Error(`metodo non supportato: ${method}`), { code: -32601 });
				return;
		}
		if (isRequest) send({ jsonrpc: '2.0', id, result });
	} catch (e) {
		if (isRequest) send({ jsonrpc: '2.0', id, error: { code: e?.code || -32603, message: String(e?.message || e) } });
	}
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
	if (!line.trim()) return;
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON non valido' } });
		return;
	}
	if (Array.isArray(msg)) msg.forEach(m => handle(m));
	else handle(msg);
});
rl.on('close', () => process.exit(0));
