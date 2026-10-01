// Installazione degli hook in ~/.claude/settings.json e del server MCP a livello utente.
// Regole: backup prima di scrivere, mai toccare gli hook di altri, idempotente.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOME, BOTTEGA_HOME } from './paths.mjs';

export const EVENTS = [
	['SessionStart', 'session-start.mjs'],
	['UserPromptSubmit', 'user-prompt.mjs'],
	['PostToolUse', 'post-tool.mjs'],
	['Stop', 'stop.mjs'],
	['SessionEnd', 'session-end.mjs'],
];
const SCRIPTS = EVENTS.map(e => e[1]);
const OURS = new RegExp(`/hooks/(${SCRIPTS.map(s => s.replace('.', '\\.')).join('|')})(["']|\\s|$)`);
export const MCP_NAME = 'bottega-memoria';
export const DEFAULT_APP_DIR = path.join(HOME, '.bottega', 'memoria-app');

export function settingsPath() {
	return process.env.CLAUDE_SETTINGS || path.join(HOME, '.claude', 'settings.json');
}

/** Node stabile per hook e MCP: ~/.bottega/bin/node (collegamento che si aggiorna quando cambia
 *  la versione di Node), cosi' gli hook non si rompono se nvm toglie la versione di oggi. */
export function stableNode() {
	const link = path.join(BOTTEGA_HOME, 'bin', 'node');
	try {
		fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
		const cur = fs.existsSync(link) ? fs.realpathSync(link) : '';
		if (cur !== process.execPath) {
			try { fs.unlinkSync(link); } catch {}
			fs.symlinkSync(process.execPath, link);
		}
		return link;
	} catch {
		return process.execPath;
	}
}

const q = s => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;

function envPrefix() {
	// Solo se la Memoria vive fuori dal posto predefinito (prove, installazioni particolari).
	const def = path.join(HOME, '.bottega');
	return process.env.BOTTEGA_HOME && path.resolve(BOTTEGA_HOME) !== def ? `BOTTEGA_HOME=${q(BOTTEGA_HOME)} ` : '';
}

export function hookCommand(appDir, script) {
	return `${envPrefix()}${q(stableNode())} --no-warnings ${q(path.join(appDir, 'hooks', script))}`;
}

export const isOurs = cmd => typeof cmd === 'string' && OURS.test(cmd) && /memoria/i.test(cmd);

function readSettings(file) {
	if (!fs.existsSync(file)) return {};
	const raw = fs.readFileSync(file, 'utf8');
	if (!raw.trim()) return {};
	return JSON.parse(raw); // se non e' JSON valido ci si ferma: meglio non scrivere che rompere
}

function backup(file) {
	if (!fs.existsSync(file)) return undefined;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const dest = `${file}.bottega-memoria-${stamp}.bak`;
	fs.copyFileSync(file, dest);
	fs.chmodSync(dest, 0o600);
	return dest;
}

function writeAtomic(file, obj) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
	fs.renameSync(tmp, file);
}

/** Toglie le nostre voci, lasciando intatte quelle degli altri. */
function stripOurs(settings) {
	const hooks = settings.hooks;
	if (!hooks || typeof hooks !== 'object') return 0;
	let removed = 0;
	for (const ev of Object.keys(hooks)) {
		if (!Array.isArray(hooks[ev])) continue;
		const groups = [];
		for (const g of hooks[ev]) {
			if (!g || !Array.isArray(g.hooks)) {
				groups.push(g);
				continue;
			}
			const kept = g.hooks.filter(h => !isOurs(h?.command));
			removed += g.hooks.length - kept.length;
			if (kept.length) groups.push({ ...g, hooks: kept });
			else if (!g.hooks.length) groups.push(g); // gruppo vuoto non nostro: lo lasciamo com'era
		}
		if (groups.length) hooks[ev] = groups;
		else delete hooks[ev];
	}
	if (!Object.keys(hooks).length) delete settings.hooks;
	return removed;
}

export function planInstall(appDir) {
	const file = settingsPath();
	const settings = readSettings(file);
	const before = JSON.stringify(settings);
	stripOurs(settings);
	settings.hooks ??= {};
	for (const [ev, script] of EVENTS) {
		const entry = { type: 'command', command: hookCommand(appDir, script), timeout: ev === 'SessionStart' || ev === 'UserPromptSubmit' ? 5 : 3 };
		const group = ev === 'PostToolUse' ? { matcher: '*', hooks: [entry] } : { hooks: [entry] };
		settings.hooks[ev] = [...(settings.hooks[ev] || []), group];
	}
	return { file, settings, changed: JSON.stringify(settings) !== before };
}

export function install({ appDir = DEFAULT_APP_DIR, dryRun = false, mcp = true, force = false } = {}) {
	const missing = SCRIPTS.filter(s => !fs.existsSync(path.join(appDir, 'hooks', s)));
	if (missing.length && !force) {
		throw new Error(`in ${appDir}/hooks mancano ${missing.join(', ')}. Indica la cartella giusta con --app-dir (o usa --forza).`);
	}
	const { file, settings, changed } = planInstall(appDir);
	const report = { settings: file, appDir, changed, backup: undefined, hooks: EVENTS.map(e => e[0]), mcp: undefined };
	if (dryRun) {
		report.preview = settings.hooks;
	} else if (changed) {
		report.backup = backup(file);
		writeAtomic(file, settings);
	}
	if (mcp) report.mcp = registerMcp(appDir, dryRun);
	return report;
}

export function uninstall({ dryRun = false, mcp = true } = {}) {
	const file = settingsPath();
	const settings = readSettings(file);
	const removed = stripOurs(settings);
	const report = { settings: file, removed, backup: undefined, mcp: undefined };
	if (removed && !dryRun) {
		report.backup = backup(file);
		writeAtomic(file, settings);
	}
	if (mcp) report.mcp = dryRun ? 'da rimuovere (prova)' : removeMcp();
	return report;
}

export function hooksStatus() {
	try {
		const s = readSettings(settingsPath());
		const out = {};
		for (const [ev] of EVENTS) out[ev] = !!(s.hooks?.[ev] || []).some(g => (g?.hooks || []).some(h => isOurs(h?.command)));
		return out;
	} catch {
		return {};
	}
}

function claude(args) {
	const r = spawnSync('claude', args, { encoding: 'utf8', timeout: 30_000 });
	return { code: r.error ? -1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), error: r.error?.message };
}

export function mcpCommand(appDir) {
	return [stableNode(), '--no-warnings', path.join(appDir, 'mcp.mjs')];
}

function registerMcp(appDir, dryRun) {
	const want = mcpCommand(appDir);
	const args = ['mcp', 'add', '--scope', 'user'];
	if (envPrefix()) args.push('-e', `BOTTEGA_HOME=${BOTTEGA_HOME}`);
	args.push(MCP_NAME, '--', ...want);
	if (dryRun) return `claude ${args.join(' ')}`;
	const cur = mcpStatus();
	if (cur.registered && cur.command === want.join(' ')) return 'gia\' registrato';
	if (cur.registered) claude(['mcp', 'remove', '--scope', 'user', MCP_NAME]);
	const r = claude(args);
	if (r.code !== 0) return `non registrato: ${r.error || r.out.slice(0, 200)}`;
	return 'registrato';
}

function removeMcp() {
	if (!mcpStatus().registered) return 'non era registrato';
	const r = claude(['mcp', 'remove', '--scope', 'user', MCP_NAME]);
	return r.code === 0 ? 'rimosso' : `non rimosso: ${r.error || r.out.slice(0, 200)}`;
}

/** Legge ~/.claude.json senza lanciare claude: veloce, sola lettura. */
export function mcpStatus() {
	try {
		const d = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
		const s = d?.mcpServers?.[MCP_NAME];
		if (!s) return { registered: false };
		return { registered: true, command: [s.command, ...(s.args || [])].join(' ') };
	} catch {
		return { registered: false };
	}
}
