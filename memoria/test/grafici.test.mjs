// I numeri della stanza Memoria (lib/grafici.mjs) su un database di prova.
// Mai il database vero: BOTTEGA_HOME punta a una cartella temporanea prima di importare lo store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-grafici-'));
process.env.BOTTEGA_HOME = path.join(TMP, 'home');
const { Store } = await import('../lib/store.mjs');
const { grafici } = await import('../lib/grafici.mjs');

const ORA = new Date(2026, 9, 3, 10, 0, 0).getTime(); // 3 ottobre 2026, 10:00 ora del Mac
const GIORNO = 86_400_000;

test('scritti e letti per giorno, progetti, totali', () => {
	const store = new Store(path.join(TMP, 'm.db'));
	const ricordo = (kind, project, at) =>
		store.db.prepare('INSERT INTO memories (kind, project, text, createdAt) VALUES (?, ?, ?, ?)').run(kind, project, 'x', at);
	ricordo('fatto', 'Faro', ORA - 1000);
	ricordo('nota', 'Faro', ORA - 2000);
	ricordo('decisione', 'Vela', ORA - 3000);
	ricordo('riassunto', 'Faro', ORA - GIORNO);
	ricordo('immagine', '', ORA - GIORNO);
	ricordo('prompt', 'Faro', ORA - 500);
	ricordo('fatto', 'Vecchio', ORA - 60 * GIORNO); // fuori dal periodo
	const sessione = (id, at, riassunta) =>
		store.db.prepare('INSERT INTO sessions (id, startedAt, summarizedAt) VALUES (?, ?, ?)').run(id, at, riassunta ? at : null);
	sessione('s1', ORA - 1000, true);
	sessione('s2', ORA - GIORNO, false);
	const osserva = (tool, at) => store.db.prepare("INSERT INTO observations (sessionId, at, kind, tool) VALUES ('s1', ?, 'tool', ?)").run(at, tool);
	osserva('mcp__bottega-memoria__memoria_cerca', ORA - 100);
	osserva('mcp__bottega-memoria__memoria_cerca', ORA - 200);
	osserva('mcp__bottega-memoria__memoria_bacheca', ORA - 300);
	osserva('Bash', ORA - 400);
	store.db.prepare("INSERT INTO queue (sessionId, reason, at) VALUES ('s2', 'prova', ?)").run(ORA);

	const g = grafici({ giorni: 7, ora: ORA, store });
	assert.equal(g.giorni, 7);
	assert.equal(g.scritti.length, 7);
	assert.equal(g.scritti.at(-1).giorno, '2026-10-03');
	assert.deepEqual(g.scritti.at(-1), { giorno: '2026-10-03', fatti: 2, decisioni: 1, riassunti: 0, schermate: 0, richieste: 1 }, 'le note vanno con i fatti');
	assert.deepEqual(g.scritti.at(-2), { giorno: '2026-10-02', fatti: 0, decisioni: 0, riassunti: 1, schermate: 1, richieste: 0 });
	assert.deepEqual(g.letti.at(-1), { giorno: '2026-10-03', avvio: 1, ricerche: 3, strumenti: { cerca: 2, bacheca: 1 } }, 'solo gli strumenti della memoria');
	assert.equal(g.letti.at(-2).avvio, 1);
	assert.deepEqual(g.progetti[0], { progetto: 'Faro', ricordi: 4 });
	assert.ok(g.progetti.some(p => p.progetto === 'Fuori dai progetti'), 'senza progetto ha un nome');
	assert.ok(!g.progetti.some(p => p.progetto === 'Vecchio'), 'fuori dal periodo');
	assert.equal(g.totali.ricordi, 7);
	assert.equal(g.totali.sessioni, 2);
	assert.equal(g.totali.riassunte, 1);
	assert.equal(g.totali.coda, 1);
	assert.equal(g.totali.lettiSettimana, 2 + 3);
	assert.equal(g.totali.ultimo, ORA - 500);
	assert.equal(grafici({ giorni: 400, ora: ORA, store }).giorni, 90, 'al massimo 90 giorni');
	fs.rmSync(TMP, { recursive: true, force: true });
});
