import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { redact } from '../../../memoria/lib/redact.mjs';

/** Stesso spool degli hook, senza database o processi nel percorso dell'interfaccia. */
export function creaRegistroMemoria(root = path.join(process.env.BOTTEGA_HOME || path.join(os.homedir(), '.bottega'), 'memoria', 'spool')) {
 let queue = Promise.resolve();
 return (e: { source: 'terminale' | 'melissa' | 'personaggio' | 'mestiere'; sid: string; id: string; cwd?: string; at: number; text: string; who?: string; tipo?: string; cosa?: string; stato?: string; scadenza?: number }): Promise<void> => {
  const text = redact(e.text).slice(0, 8000);
  const file = path.join(root, new Date(e.at).toISOString().slice(0, 10) + '.jsonl');
  const line = JSON.stringify({ ...e, text, ev: 'external' }) + '\n';
  queue = queue.catch(() => {}).then(async () => {
   await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
   await fs.promises.appendFile(file, line, { mode: 0o600 });
  });
  return queue;
 };
}
