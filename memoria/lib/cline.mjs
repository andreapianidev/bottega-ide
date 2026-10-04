import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store.mjs';
import { saveExternal } from './esterne.mjs';

const stamp = v => typeof v === 'number' ? v : Date.parse(v);
const dirs = p => { try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory() && /^[\w-]{5,100}$/.test(d.name)).map(d => d.name); } catch { return []; } };
function read(file, max = 8 * 1024 * 1024) {
 try { if (fs.statSync(file).size > max) return undefined; return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}
export function clineRoots(home = os.homedir()) {
 const base = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : process.platform === 'win32' ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming') : path.join(home, '.config');
 return ['Bottega', 'Code', 'Code - Insiders', 'VSCodium'].map(app => path.join(base, app, 'User', 'globalStorage', 'saoudrizwan.claude-dev'));
}
function userText(text) {
 return text.replace(/<environment_details>[\s\S]*?<\/environment_details>/g, '').replace(/<\/?(?:task|user_message)>/g, '').trim();
}
export function importCline({ store, dataDir = process.env.CLINE_DATA_DIR || path.join(os.homedir(), '.cline', 'data'), legacyRoots = process.env.CLINE_DATA_DIR ? [] : clineRoots(), now = Date.now() } = {}) {
 const own = !store; store ??= new Store();
 let imported = 0, skipped = 0;
 try {
  store.db.exec('CREATE TABLE IF NOT EXISTS cline_files (file TEXT PRIMARY KEY, signature TEXT)');
  const candidates = [];
  for (const sid of dirs(path.join(dataDir, 'sessions'))) {
   const dir = path.join(dataDir, 'sessions', sid);
   candidates.push({ sid, file: path.join(dir, `${sid}.messages.json`), meta: path.join(dir, `${sid}.json`), sdk: true });
  }
  for (const root of new Set([dataDir, ...legacyRoots])) {
   const history = read(path.join(root, 'tasks', 'taskHistory.json')) || read(path.join(root, 'taskHistory.json')) || [];
   const rows = Array.isArray(history) ? history : history.taskHistory || [];
   for (const sid of dirs(path.join(root, 'tasks'))) candidates.push({ sid, file: path.join(root, 'tasks', sid, 'ui_messages.json'), row: rows.find(r => String(r.id) === sid) || {}, sdk: false });
  }
  for (const c of candidates) { try { c.stat = fs.statSync(c.file); } catch {} }
  for (const c of candidates.filter(c => c.stat?.isFile() && c.stat.mtimeMs >= now - 45 * 86400_000).sort((a,b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 100)) {
   const signature = `${c.stat.ino}:${c.stat.mtimeMs}:${c.stat.size}`;
   if (store.get('SELECT signature FROM cline_files WHERE file = ?', c.file)?.signature === signature) continue;
   const raw = read(c.file), meta = c.sdk ? read(c.meta) : c.row;
   const messages = c.sdk ? raw?.version === 1 && raw.messages : raw;
   if (!Array.isArray(messages) || !meta || (c.sdk && meta.session_id !== c.sid)) { skipped++; continue; }
   const cwd = meta.workspace_root || meta.cwdOnTaskInitialization || meta.cwd;
   store.tx(() => {
    const save = (m, i, j, text, who) => {
     const at = stamp(m.ts ?? m.timestamp ?? meta.started_at ?? meta.ts);
     if (!Number.isFinite(at) || at > now + 60_000 || typeof text !== 'string') return;
     imported += saveExternal(store, { source: 'cline', sid: c.sid, id: `${m.id || m.ts || i}:${j}`, cwd, at, text: who === 'Richiesta' ? userText(text) : text, who });
    };
    messages.forEach((m, i) => {
     if (m.partial) return;
     if (c.sdk) {
      if (!['user', 'assistant'].includes(m.role)) return;
      const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      if (!Array.isArray(content)) return;
      content.forEach((b, j) => {
       if (b.type === 'text') save(m, i, j, b.text, m.role === 'user' ? 'Richiesta' : 'Risposta');
       if (m.role === 'assistant' && b.type === 'tool_use' && b.name === 'attempt_completion') save(m, i, j, b.input?.result, 'Esito');
      });
     } else if (m.type === 'say' && ['text', 'user_feedback', 'completion_result'].includes(m.say)) {
      save(m, i, 0, m.text, m.say === 'user_feedback' || i === 0 ? 'Richiesta' : 'Risposta');
     } else if (m.type === 'ask' && m.ask === 'followup') save(m, i, 0, m.text, 'Domanda');
    });
    store.run('INSERT INTO cline_files VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET signature=excluded.signature', c.file, signature);
   });
  }
  store.meta('last_cline_import', now);
  return { imported, skipped };
 } finally { if (own) store.close(); }
}
