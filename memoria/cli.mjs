#!/usr/bin/env node
// Memoria della Bottega, riga di comando. `node cli.mjs aiuto` per l'elenco dei comandi.
process.removeAllListeners('warning');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const pos = [];
const BOOL = new Set(['json', 'prova', 'dry-run', 'no-mcp', 'forza', 'solo-agnes']);
for (let i = 1; i < argv.length; i++) {
	const a = argv[i];
	if (a.startsWith('--')) {
		const [k, v] = a.slice(2).split('=');
		if (v !== undefined) flags[k] = v;
		else if (BOOL.has(k)) flags[k] = true;
		else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
		else flags[k] = true;
	} else pos.push(a);
}
const json = !!flags.json;
const progetto = flags.progetto || flags.project;
const num = (v, d) => (v === undefined || v === true ? d : Number(v) || d);

const HELP = `Memoria della Bottega

  ingest                              porta nel database quello che hanno scritto gli hook
  search <testo> [--progetto P] [--limite N] [--json]
  recent [--progetto P] [--limite N] [--tipo riassunto,fatto,...] [--json]
  remember <testo> [--progetto P]     aggiunge una nota
  summarize <sessionId> [--json]      riassume subito una sessione
  backfill [--giorni N] [--max N] [--prova]
                                      riassume le sessioni passate gia' su disco
  context <cartella> [--json]         il contesto che riceve una sessione aperta li'
  bacheca [--progetto P] [--minuti N] [--json]
                                      cosa stanno facendo adesso le sessioni Claude
  sessione <id> [--json]              dettaglio di una sessione
  classifica [--tutte] [--limite N] [--json]
                                      categoria delle sessioni riassunte (Apple Intelligence, in fondo)
  categorie [--giorni N] [--json]     sessione -> categoria
  install [--app-dir D] [--no-mcp] [--prova]
  uninstall [--no-mcp] [--prova]
  status [--json]`;

function print(obj, text) {
	if (json) process.stdout.write(JSON.stringify(obj, null, 0) + '\n');
	else process.stdout.write((typeof text === 'function' ? text(obj) : text ?? JSON.stringify(obj, null, 2)) + '\n');
}

const fmtDate = ts => new Date(ts).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const listText = items =>
	items.length
		? items
				.map(m => `[${m.kind}] ${m.project} ${fmtDate(m.createdAt)}${m.score !== undefined ? `  (${m.score})` : ''}\n  ${m.text.startsWith(m.title.replace(/\u2026$/, '')) ? '' : m.title + '\n  '}${m.text.replace(/\n/g, '\n  ')}`)
				.join('\n\n')
		: 'Niente in memoria.';

async function main() {
	switch (cmd) {
		case 'worker': {
			const { runWorker } = await import('./lib/core.mjs');
			await runWorker({ motivo: flags.motivo, sessione: flags.sessione || undefined });
			return;
		}
		case 'ingest': {
			const { ingest } = await import('./lib/core.mjs');
			const r = ingest();
			return print(r, `Righe assorbite: ${r.lines}, sessioni: ${r.sessions}`);
		}
		case 'search':
		case 'cerca': {
			const { search, ingest } = await import('./lib/core.mjs');
			ingest();
			const q = pos.join(' ').trim();
			if (!q) throw new Error('scrivi cosa cercare');
			return print(search(q, { progetto, limite: num(flags.limite, 10) }), listText);
		}
		case 'recent':
		case 'recenti': {
			const { openStore } = await import('./lib/store.mjs');
			const { ingest } = await import('./lib/core.mjs');
			ingest();
			const kinds = typeof flags.tipo === 'string' ? flags.tipo.split(',') : undefined;
			return print(openStore().recent({ progetto, limite: num(flags.limite, 10), ...(kinds ? { kinds } : {}) }), listText);
		}
		case 'remember':
		case 'ricorda': {
			const { remember } = await import('./lib/core.mjs');
			const m = remember(pos.join(' '), { progetto, cwd: process.cwd() });
			return print(m, `Ricordato per ${m.project}: ${m.text}`);
		}
		case 'summarize':
		case 'riassumi': {
			const { summarizeSession, ingest } = await import('./lib/core.mjs');
			if (!pos[0]) throw new Error('indica la sessione');
			ingest();
			const r = await summarizeSession(pos[0], { soloAgnes: !!flags['solo-agnes'] });
			return print(r, r.skipped ? `Saltata: ${r.skipped}` : `Riassunta con ${r.engine}: ${r.title} (${r.project}, ${r.memories} memorie)`);
		}
		case 'backfill': {
			const { backfill } = await import('./lib/core.mjs');
			const r = await backfill({
				giorni: num(flags.giorni, 30),
				max: num(flags.max, 50),
				dryRun: !!(flags.prova || flags['dry-run']),
				onProgress: p => {
					if (json) return;
					if (p.wait) console.error('Aspetto che finisca un altro riassunto...');
					else if (p.error) console.error(`${p.sessionId ? p.sessionId.slice(0, 8) + ': ' : ''}${p.error}`);
					else console.error(`${p.sessionId.slice(0, 8)}: ${p.skipped ? `saltata (${p.skipped})` : `${p.engine}, ${p.project}: ${p.title}`}`);
				},
			});
			return print(r, `Sessioni candidate: ${r.candidates}, gia' riassunte: ${r.alreadyDone}, fatte ora: ${r.done}`);
		}
		case 'context':
		case 'contesto': {
			const { writeContext } = await import('./lib/core.mjs');
			const { projectOf, HOME_PROJECT } = await import('./lib/paths.mjs');
			const { activeLine } = await import('./lib/bacheca.mjs');
			const project = projectOf(pos[0] || process.cwd()) || HOME_PROJECT;
			const text = [writeContext(project), activeLine({ project })].filter(Boolean).join('\n\n');
			return print({ project: project.name, projectPath: project.path, key: project.key, text }, text || 'Nessun contesto per questa cartella.');
		}
		case 'bacheca': {
			const { board } = await import('./lib/core.mjs');
			const items = board({ progetto, minuti: num(flags.minuti, 60) });
			return print(items, () =>
				items.length ? items.map(e => `${fmtDate(e.at)} ${e.project} ${String(e.sessionId).slice(0, 8)} ${e.summary}`).join('\n') : 'Nessuna attivita\' recente.',
			);
		}
		case 'sessione':
		case 'session': {
			const { sessionDetail, ingest } = await import('./lib/core.mjs');
			ingest();
			const d = sessionDetail(pos[0] || '');
			if (!d) throw new Error('sessione non trovata');
			return print(d);
		}
		case 'install': {
			const { install, DEFAULT_APP_DIR } = await import('./lib/install.mjs');
			const { resolve } = await import('node:path');
			const r = install({
				appDir: resolve(flags['app-dir'] || DEFAULT_APP_DIR),
				dryRun: !!(flags.prova || flags['dry-run']),
				mcp: !flags['no-mcp'],
				force: !!flags.forza,
			});
			return print(r);
		}
		case 'uninstall': {
			const { uninstall } = await import('./lib/install.mjs');
			return print(uninstall({ dryRun: !!(flags.prova || flags['dry-run']), mcp: !flags['no-mcp'] }));
		}
		case 'status':
		case 'stato': {
			return print(await status());
		}
		case undefined:
		case 'aiuto':
		case 'help':
		case '--help':
			process.stdout.write(HELP + '\n');
			return;
		default: {
			const { NATIVO_COMANDI, nativoComando } = await import('./lib/nativo-cli.mjs');
			if (NATIVO_COMANDI.includes(cmd)) {
				process.exitCode = nativoComando(cmd, argv.slice(1), print) ?? 0;
				return;
			}
			throw new Error(`comando sconosciuto: ${cmd}\n\n${HELP}`);
		}
	}
}

async function status() {
	const fs = await import('node:fs');
	const P = await import('./lib/paths.mjs');
	const { openStore } = await import('./lib/store.mjs');
	const { nucleoPath, agnesKey } = await import('./lib/engines.mjs');
	const { hooksStatus, mcpStatus, settingsPath } = await import('./lib/install.mjs');
	const s = openStore();
	const kinds = Object.fromEntries(s.all('SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind').map(r => [r.kind, Number(r.n)]));
	let spoolPending = 0;
	try {
		for (const f of fs.readdirSync(P.SPOOL_DIR)) {
			const size = fs.statSync(`${P.SPOOL_DIR}/${f}`).size;
			const off = Number(s.get('SELECT offset FROM spool_offsets WHERE file = ?', f)?.offset || 0);
			spoolPending += Math.max(0, size - off);
		}
	} catch {
		// spool non ancora creato
	}
	let worker = false;
	try {
		const d = JSON.parse(fs.readFileSync(P.LOCK_PATH, 'utf8'));
		process.kill(d.pid, 0);
		worker = true;
	} catch {
		// nessun lavoro in corso
	}
	const num = sql => Number(s.get(sql)?.n || 0);
	return {
		home: P.MEM_DIR,
		db: P.DB_PATH,
		dbBytes: fs.existsSync(P.DB_PATH) ? fs.statSync(P.DB_PATH).size : 0,
		sessions: num('SELECT COUNT(*) AS n FROM sessions'),
		summarized: num("SELECT COUNT(*) AS n FROM sessions WHERE summarizedAt IS NOT NULL AND engine != 'vuota'"),
		observations: num('SELECT COUNT(*) AS n FROM observations'),
		memories: kinds,
		vectors: num('SELECT COUNT(*) AS n FROM vectors'),
		queue: num('SELECT COUNT(*) AS n FROM queue'),
		spoolPendingBytes: spoolPending,
		lastIngest: Number(s.meta('last_ingest') || 0) || null,
		worker,
		engines: { apple: !!nucleoPath(), nucleo: nucleoPath() || null, agnes: !!agnesKey() },
		hooks: hooksStatus(),
		settings: settingsPath(),
		mcp: mcpStatus(),
		contexts: (() => {
			try {
				return fs.readdirSync(P.CONTEXT_DIR).filter(f => f.endsWith('.md')).length;
			} catch {
				return 0;
			}
		})(),
	};
}

main().then(
	() => process.exit(0),
	e => {
		if (cmd === 'worker') {
			// il processo staccato non ha un terminale: si annota e basta
			import('./lib/paths.mjs').then(P => P.log(`worker: ${e?.stack || e}`)).finally(() => process.exit(0));
			return;
		}
		if (json) process.stdout.write(JSON.stringify({ error: String(e?.message || e) }) + '\n');
		else process.stderr.write(`Memoria: ${e?.message || e}\n`);
		process.exit(1);
	},
);
