// Una nota per evento originale, condivisa da Cline e dalle funzioni integrate.
import { createHash } from 'node:crypto';
import { projectOf, HOME_PROJECT } from './paths.mjs';
import { redact, clip } from './redact.mjs';
export function saveExternal(store, e) {
 const names = { cline: 'Cline', terminale: 'Terminale', melissa: 'Melissa' };
 if (!names[e.source] || typeof e.text !== 'string' || !Number.isFinite(e.at) || e.at <= 0 || e.at > Date.now() + 60_000) return 0;
 const text = redact(e.text).trim().slice(0, 8000);
 if (!text) return 0;
 store.db.exec('CREATE TABLE IF NOT EXISTS external_events (event TEXT PRIMARY KEY, memoryId INTEGER)');
 const event = createHash('sha256').update(`${e.source}:${e.sid}:${e.id}`).digest('hex');
 const old = store.get('SELECT memoryId FROM external_events WHERE event = ?', event);
 const project = projectOf(e.cwd) || HOME_PROJECT;
 const title = `${names[e.source]} · ${e.who || 'Attività'}: ${clip(text, 100)}`;
 if (old) {
  store.run('UPDATE memories SET title = ?, text = ? WHERE id = ? AND (title != ? OR text != ?)', title, text, old.memoryId, title, text);
  return 0;
 }
 const id = store.addMemory({ kind: 'nota', origin: e.source, sessionId: `${e.source}:${e.sid}`, project: project.name, projectPath: project.path, projectKey: project.key, title, text, createdAt: e.at });
 store.run('INSERT INTO external_events VALUES (?, ?)', event, id);
 return 1;
}
