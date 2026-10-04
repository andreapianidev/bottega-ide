import { importCodex } from './codex.mjs';
import { importCline } from './cline.mjs';
// Un solo punto d'ingresso per CLI, MCP e letture delle funzioni integrate.
export function syncSources() {
 return { codex: importCodex(), cline: importCline() };
}
