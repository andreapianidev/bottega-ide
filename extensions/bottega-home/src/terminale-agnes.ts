/* Agnes nel terminale della Bottega: all'Invio, se la riga e' una frase in italiano e non un comando, il widget di
   zsh (extensions/bottega-home/shell/agnes.zsh) la manda qui su un socket locale e qui si chiede al cervello il
   comando. Qui dentro: le regole su cosa si esegue da solo e cosa chiede sempre (paletti, consentiti, tre modi), il
   prompt e la lettura della risposta, il socket (~/.bottega/terminale.sock, 600, una richiesta alla volta), i cervelli
   in fila (Agnes o DeepSeek, poi l'altro, poi Apple Intelligence) e la copia dei file di zsh in ~/.bottega/zsh.
   Niente vscode qui dentro: si prova da Node con test/terminale-agnes.cjs. Il collegamento a VS Code sta in
   src/terminale-host.ts. Contratto: docs/CONTRATTI.md, sezione 12. */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type { LlmMessage, LlmStreamFn } from './assistant';
import { NucleoBridge, runAppleTurn } from './cervello';
import { DEFAULT_CHOICE } from './cervelli';

export type Modo = 'proponi' | 'chiedi' | 'auto';
export type CervelloTerminale = 'agnes' | 'deepseek';
export type Pensatore = CervelloTerminale | 'apple';
export type Esegui = 'subito' | 'chiedi' | 'proponi';

export const NOMI: Record<Pensatore, string> = { agnes: 'Agnes', deepseek: 'DeepSeek', apple: 'Apple Intelligence' };
/** Fra due richieste ad Agnes almeno 3 secondi: ~20 al minuto condivise con tutte le app di Andrea. */
export const PAUSA_AGNES = 3000;

// ---------- la riga divisa in parti ----------

export interface Parte {
	/** Le parole, senza virgolette, senza redirezioni. */
	parole: string[];
	/** Dove scrive con > >> &> (e 2> 1>). */
	scrive: string[];
	/** Il separatore che la precede: '', '&&', '||', ';', '|', '&', '\n', '(' o ')'. */
	sep: string;
}

export interface Divisione {
	parti: Parte[];
	/** $( ), ` `, <( ), >( ): dentro c'e' un altro comando che qui non si legge. */
	sostituzione: boolean;
}

/** Divide un comando di shell in parti semplici (&&, ||, ;, |, &, a capo, parentesi), con le virgolette rispettate.
 *  Non e' un parser completo: serve a capire cosa fa ogni parte, e nel dubbio si chiede. */
export function dividi(cmd: string): Divisione {
	const parti: Parte[] = [];
	let sostituzione = false;
	let parole: string[] = [];
	let scrive: string[] = [];
	let w = '';
	let inParola = false;
	let sep = '';
	let redir: '' | 'scrive' | 'salta' = '';
	const chiudiParola = () => {
		if (!inParola) return;
		if (redir === 'scrive') scrive.push(w);
		else if (redir !== 'salta') parole.push(w);
		redir = '';
		w = '';
		inParola = false;
	};
	const chiudiParte = (nuovo: string) => {
		chiudiParola();
		if (parole.length || scrive.length) parti.push({ parole, scrive, sep });
		parole = [];
		scrive = [];
		sep = nuovo;
	};
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		const n = cmd[i + 1];
		if (c === '\\') {
			if (n === '\n') i++;
			else if (n !== undefined) {
				w += n;
				inParola = true;
				i++;
			}
			continue;
		}
		if (c === "'") {
			const j = cmd.indexOf("'", i + 1);
			w += cmd.slice(i + 1, j < 0 ? undefined : j);
			inParola = true;
			i = j < 0 ? cmd.length : j;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			let dentro = '';
			while (j < cmd.length && cmd[j] !== '"') {
				if (cmd[j] === '\\' && j + 1 < cmd.length) {
					dentro += cmd[j + 1];
					j += 2;
					continue;
				}
				if (cmd[j] === '`' || (cmd[j] === '$' && cmd[j + 1] === '(')) sostituzione = true;
				dentro += cmd[j];
				j++;
			}
			w += dentro;
			inParola = true;
			i = j;
			continue;
		}
		if (c === '`' || (c === '$' && n === '(') || ((c === '<' || c === '>') && n === '(')) {
			sostituzione = true;
			if (c === '$' || c === '`') {
				w += c;
				inParola = true;
				continue;
			}
		}
		if (c === ' ' || c === '\t') {
			chiudiParola();
			continue;
		}
		if (c === '\n' || c === ';') {
			chiudiParte(c);
			if (c === ';' && n === ';') i++;
			continue;
		}
		if (c === '&' && n === '&') {
			chiudiParte('&&');
			i++;
			continue;
		}
		if (c === '|' && n === '|') {
			chiudiParte('||');
			i++;
			continue;
		}
		if (c === '|') {
			chiudiParte('|');
			if (n === '&') i++;
			continue;
		}
		if (c === '&' && n === '>') {
			chiudiParola();
			i++;
			if (cmd[i + 1] === '>') i++;
			redir = 'scrive';
			continue;
		}
		if (c === '&') {
			chiudiParte('&');
			continue;
		}
		if (c === '>' || c === '<') {
			// 2> e 1>: il numero e' il descrittore, non una parola
			if (inParola && /^\d+$/.test(w)) {
				w = '';
				inParola = false;
			} else chiudiParola();
			if (c === '>') {
				if (n === '>' || n === '|') i++;
				if (cmd[i + 1] === '&') {
					i++;
					redir = 'salta'; // >&2: un descrittore
				} else redir = 'scrive';
			} else {
				if (n === '<') i++;
				if (cmd[i + 1] === '<') i++;
				redir = 'salta';
			}
			continue;
		}
		if (c === '(' || c === ')') {
			chiudiParte(c);
			continue;
		}
		w += c;
		inParola = true;
	}
	chiudiParte('');
	return { parti, sostituzione };
}

// ---------- cosa fa ogni parte ----------

const ASSEGNAZIONE = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Programmi che ne lanciano un altro: si guarda quello dopo. */
const INVOLUCRI = new Set(['noglob', 'command', 'builtin', 'nocorrect', 'exec', 'time', 'nohup', 'caffeinate', 'env', 'nice']);
const INTERPRETI = new Set(['sh', 'bash', 'zsh', 'fish', 'python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun', 'osascript']);
/** Programmi con un sottocomando: la forma e' programma piu' sottocomando (git status, npm test). */
const CON_SOTTOCOMANDO = new Set([
	'git', 'npm', 'pnpm', 'yarn', 'bun', 'bunx', 'npx', 'brew', 'docker', 'kubectl', 'cargo', 'go', 'swift', 'xcrun', 'gh',
	'vercel', 'eas', 'pod', 'pip', 'pip3', 'uv', 'make', 'flutter', 'dart', 'deno', 'supabase', 'firebase', 'fly', 'flyctl',
	'wrangler', 'gcloud', 'aws', 'terraform', 'tmux', 'launchctl', 'defaults', 'diskutil', 'mise', 'asdf', 'rustup',
	'poetry', 'composer', 'python', 'python3', 'node', 'ruby', 'perl', 'sh', 'bash', 'zsh', 'mas', 'tmutil', 'netlify',
	'heroku', 'twine', 'fastlane', 'xcodes', 'killall', 'pkill', 'open',
]);
/** Leggono soltanto: in modo auto si eseguono senza chiedere. */
const INNOCUI = new Set([
	'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'du', 'df', 'which', 'whereis', 'type', 'whence', 'where', 'whoami', 'id',
	'date', 'cal', 'echo', 'printf', 'file', 'stat', 'tree', 'uname', 'sw_vers', 'uptime', 'ps', 'printenv', 'hostname',
	'grep', 'egrep', 'fgrep', 'rg', 'ag', 'mdfind', 'mdls', 'less', 'more', 'sort', 'uniq', 'cut', 'tr', 'jq', 'basename',
	'dirname', 'realpath', 'readlink', 'md5', 'shasum', 'vm_stat', 'diff', 'cmp', 'column', 'nl', 'true', 'false', 'test',
	'history', 'dig', 'nslookup', 'host', 'man', 'cd', 'pushd', 'popd', 'top', 'lsof', 'pgrep', 'ping', 'find', 'fd',
]);
const SOTTO_INNOCUI: Record<string, Set<string>> = {
	git: new Set(['status', 'log', 'diff', 'show', 'blame', 'shortlog', 'describe', 'rev-parse', 'ls-files', 'ls-tree', 'grep', 'whatchanged', 'reflog']),
	npm: new Set(['ls', 'list', 'outdated', 'view', 'info', 'why', 'explain', 'config', 'root', 'prefix']),
	brew: new Set(['list', 'ls', 'info', 'search', 'outdated', 'deps', 'uses', 'config', '--prefix', 'doctor', 'leaves']),
	gh: new Set(['status']),
	docker: new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info']),
	kubectl: new Set(['get', 'describe', 'logs', 'version']),
	xcrun: new Set(['--show-sdk-path', '--find']),
	tmutil: new Set(['listbackups', 'latestbackup', 'destinationinfo']),
	diskutil: new Set(['list', 'info', 'apfs']),
};
const DEV_INNOCUI = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/** Il programma vero di una parte (dopo VAR=x, noglob, env, time...) e il resto. sudo resta come programma. */
export function programma(parole: string[]): { prog: string; resto: string[] } {
	let i = 0;
	for (;;) {
		while (i < parole.length && ASSEGNAZIONE.test(parole[i])) i++;
		if (i >= parole.length) return { prog: '', resto: [] };
		const p = path.basename(parole[i]);
		if (!INVOLUCRI.has(p)) break;
		i++;
		// le opzioni dell'involucro (nice -n 10, env -i)
		while (i < parole.length && parole[i].startsWith('-')) i += parole[i] === '-n' ? 2 : 1;
	}
	return { prog: parole[i], resto: parole.slice(i + 1) };
}

/** La forma di un comando per «consenti sempre»: programma piu' sottocomando (git status, npm run build, npx expo),
 *  oppure programma piu' le opzioni iniziali (ls, du -sh). undefined se non si sa dire. */
export function forma(parole: string[]): string | undefined {
	const { prog, resto } = programma(parole);
	if (!prog || prog === 'sudo') return undefined;
	const nome = path.basename(prog);
	if (CON_SOTTOCOMANDO.has(nome)) {
		let i = 0;
		if (nome === 'git') i = indiceGit(resto); // git -C cartella status
		else while (i < resto.length && resto[i].startsWith('-') && !/^--?(version|v|V)$/.test(resto[i])) i++;
		const sotto = resto[i];
		if (!sotto) return prog;
		if (['npm', 'pnpm', 'yarn', 'bun'].includes(nome) && ['run', 'run-script', 'exec', 'x', 'dlx'].includes(sotto) && resto[i + 1]) return `${prog} ${sotto} ${resto[i + 1]}`;
		return `${prog} ${sotto}`;
	}
	const opzioni: string[] = [];
	for (const r of resto) {
		if (!r.startsWith('-') || r === '-') break;
		opzioni.push(r);
	}
	return [prog, ...opzioni].join(' ');
}

/** Dove sta il sottocomando di git, dopo -C cartella e -c chiave=valore. */
const indiceGit = (resto: string[]) => {
	let i = 0;
	while (i < resto.length && resto[i].startsWith('-')) i += resto[i] === '-C' || resto[i] === '-c' ? 2 : 1;
	return i;
};

const flagsBrevi = (resto: string[]) => resto.filter(r => /^-[A-Za-z]+$/.test(r)).map(r => r.slice(1)).join('');
const haFlag = (resto: string[], lettera: string, lunghe: string[] = []) => flagsBrevi(resto).includes(lettera) || resto.some(r => lunghe.includes(r));
const argomenti = (resto: string[]) => resto.filter(r => !r.startsWith('-'));

interface Contesto {
	/** Dove si risolvono i percorsi: cambia con cd. */
	cartella: string;
	/** La cartella della richiesta: le scritture fuori da qui chiedono. */
	radice: string;
	home: string;
}

/** Dove scrive un programma (oltre alle redirezioni): i file e le cartelle di destinazione. */
function destinazioni(nome: string, resto: string[]): string[] {
	const args = argomenti(resto);
	switch (nome) {
		case 'cp':
		case 'mv':
		case 'ln':
		case 'rsync':
		case 'ditto':
		case 'install':
		case 'scp':
			return args.length >= 2 ? [args[args.length - 1]] : [];
		case 'touch':
		case 'mkdir':
		case 'rm':
		case 'rmdir':
		case 'tee':
		case 'truncate':
		case 'shred':
		case 'srm':
		case 'unlink':
			return args;
		case 'chmod':
		case 'chown':
		case 'chgrp':
			return args.slice(1);
		case 'sed':
			return resto.some(r => r === '-i' || r.startsWith('-i')) ? args.slice(1) : [];
		case 'unzip': {
			const d = resto.indexOf('-d');
			return d >= 0 && resto[d + 1] ? [resto[d + 1]] : [];
		}
		case 'tar': {
			const c = resto.indexOf('-C');
			return c >= 0 && resto[c + 1] ? [resto[c + 1]] : [];
		}
		default:
			return [];
	}
}

/** Le scritture fuori dalla cartella corrente o nella home: chiedono sempre (regola di Andrea). */
function scrittureFuori(bersagli: string[], c: Contesto): string[] {
	const out: string[] = [];
	for (const b of bersagli) {
		if (!b || DEV_INNOCUI.has(b)) continue;
		if (b.startsWith('/dev/')) {
			out.push(`scrive su un dispositivo (${b})`);
			continue;
		}
		const t = b.replace(/^~(?=\/|$)/, c.home).replace(/^\$\{?HOME\}?(?=\/|$)/, c.home);
		if (/[$`]/.test(t)) {
			out.push('scrive in un percorso che dipende da variabili');
			continue;
		}
		const p = path.resolve(c.cartella, t);
		const dentro = p === c.radice || p.startsWith(c.radice.endsWith('/') ? c.radice : c.radice + '/');
		if (!dentro) out.push(`scrive fuori dalla cartella corrente (${p})`);
		else if (c.radice === c.home) out.push('scrive direttamente nella home');
	}
	return out;
}

const PUBBLICA = 'pubblica: lo decidi tu';

/** I paletti di una parte: comandi pericolosi, pubblicazioni, push, sudo, scritture fuori. Nessun modo li scavalca. */
function paletti(parte: Parte, c: Contesto, prima?: Parte): string[] {
	const out: string[] = [];
	let { prog, resto } = programma(parte.parole);
	if (!prog) return scrittureFuori(parte.scrive, c);
	let nome = path.basename(prog);
	if (nome === 'sudo') {
		out.push('sudo: agisce da amministratore');
		let i = 0;
		while (i < resto.length && resto[i].startsWith('-')) i += ['-u', '-g', '-C', '-h', '-p'].includes(resto[i]) ? 2 : 1;
		const dentro = programma(resto.slice(i));
		prog = dentro.prog;
		resto = dentro.resto;
		nome = prog ? path.basename(prog) : '';
	}
	if (nome === 'xargs') {
		let i = 0;
		while (i < resto.length && resto[i].startsWith('-')) i += ['-I', '-n', '-P', '-L', '-J', '-s', '-E'].includes(resto[i]) ? 2 : 1;
		const dentro = programma(resto.slice(i));
		prog = dentro.prog;
		resto = dentro.resto;
		nome = prog ? path.basename(prog) : '';
	}
	if (['npx', 'bunx'].includes(nome) || (['pnpm', 'yarn'].includes(nome) && resto[0] === 'dlx')) {
		const r = nome === 'pnpm' || nome === 'yarn' ? resto.slice(1) : resto.filter((x, i) => !(i === 0 && x.startsWith('-')));
		const dentro = programma(r);
		prog = dentro.prog;
		resto = dentro.resto;
		nome = prog ? path.basename(prog) : '';
	}
	const sotto = argomenti(resto)[0] ?? '';
	const args = argomenti(resto);
	switch (nome) {
		case 'rm': {
			const r = haFlag(resto, 'r') || haFlag(resto, 'R', ['--recursive']);
			const f = haFlag(resto, 'f', ['--force']);
			out.push(r && f ? 'cancella file e cartelle senza chiedere' : r ? 'cancella cartelle intere' : f ? 'cancella file senza chiedere' : 'cancella file');
			break;
		}
		case 'shred':
		case 'srm':
		case 'truncate':
			out.push('distrugge il contenuto dei file');
			break;
		case 'git': {
			const gi = indiceGit(resto);
			const g = resto[gi] ?? '';
			const ga = resto.slice(gi + 1);
			if (g === 'push') {
				out.push(ga.some(a => /^(-f|--force|--force-with-lease.*|--mirror|--delete|-d)$/.test(a) || /^\+/.test(a) || /^:/.test(a)) ? 'git push che riscrive o cancella sul remoto: lo decidi tu' : 'git push: lo decidi tu');
			} else if (g === 'reset' && ga.includes('--hard')) out.push('butta le modifiche non salvate');
			else if (g === 'clean' && ga.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--force')) out.push('cancella i file non tracciati');
			else if ((g === 'checkout' && (ga.includes('--') || ga.includes('.'))) || (g === 'restore' && !ga.includes('--staged'))) out.push('butta le modifiche non salvate');
			else if (g === 'branch' && ga.some(a => /^-[a-zA-Z]*D/.test(a) || a === '--delete')) out.push('cancella un ramo');
			else if (g === 'stash' && ['drop', 'clear'].includes(ga[0])) out.push('cancella modifiche messe da parte');
			else if (g === 'filter-branch' || g === 'filter-repo') out.push('riscrive la storia');
			break;
		}
		case 'dd':
			out.push('scrive direttamente su dischi e file');
			break;
		case 'diskutil':
			if (/^(erase|reformat|partition|zero|random|secureErase|unmountDisk|apfs)/i.test(sotto) && sotto !== 'apfs') out.push('formatta o cancella un disco');
			if (sotto === 'apfs' && /delete|erase/i.test(args[1] ?? '')) out.push('formatta o cancella un disco');
			break;
		case 'chmod':
		case 'chown':
		case 'chgrp':
			if (haFlag(resto, 'R')) out.push('cambia i permessi di cartelle intere');
			break;
		case 'kill':
			if (resto.some(r => r === '-9' || r === '-KILL' || r === '-SIGKILL')) out.push('ferma processi senza farli chiudere');
			break;
		case 'killall':
		case 'pkill':
			out.push('ferma processi');
			break;
		case 'shutdown':
		case 'reboot':
		case 'halt':
			out.push('spegne o riavvia il Mac');
			break;
		case 'find':
			if (resto.includes('-delete')) out.push('cancella i file trovati');
			else if (resto.some(r => ['-exec', '-execdir', '-ok', '-okdir'].includes(r))) {
				const e = resto.findIndex(r => ['-exec', '-execdir', '-ok', '-okdir'].includes(r));
				if (['rm', 'shred', 'srm', 'mv', 'chmod', 'chown'].includes(path.basename(resto[e + 1] ?? ''))) out.push('cambia o cancella i file trovati');
			}
			break;
		case 'defaults':
			if (sotto === 'delete') out.push('cambia impostazioni di sistema');
			break;
		case 'tmutil':
			if (/^(delete|disable|removedestination)/.test(sotto)) out.push('cambia i backup di Time Machine');
			break;
		case 'csrutil':
		case 'nvram':
		case 'spctl':
			out.push('cambia impostazioni di sistema');
			break;
		case 'launchctl':
			if (/^(unload|bootout|remove|disable)$/.test(sotto)) out.push('cambia impostazioni di sistema');
			break;
		case 'mkfs':
		case 'newfs':
			out.push('formatta o cancella un disco');
			break;
		// pubblicazioni: le decide Andrea
		case 'vercel':
		case 'vc':
			if (!['ls', 'list', 'whoami', 'logs', 'inspect', 'login', 'link', 'pull', 'dev', 'build', 'env', 'help', 'project', 'domains', 'teams', 'switch'].includes(sotto) && !resto.some(r => /^(--version|-v|--help|-h)$/.test(r))) out.push(PUBBLICA);
			break;
		case 'npm':
		case 'yarn':
		case 'pnpm':
		case 'bun':
			if (['publish', 'unpublish', 'deprecate'].includes(sotto)) out.push(PUBBLICA);
			if (['install', 'i', 'add', 'uninstall', 'remove', 'rm', 'update', 'upgrade', 'link'].includes(sotto) && resto.some(r => r === '-g' || r === '--global')) out.push('installa programmi per tutto il Mac');
			break;
		case 'eas':
			if (['submit', 'update'].includes(sotto) || resto.includes('--auto-submit')) out.push(PUBBLICA);
			break;
		case 'xcrun':
			if (sotto === 'altool') out.push(PUBBLICA);
			break;
		case 'fastlane':
		case 'twine':
			out.push(PUBBLICA);
			break;
		case 'gh':
			if ((sotto === 'release' && ['create', 'upload', 'edit', 'delete'].includes(args[1])) || (sotto === 'pr' && args[1] === 'merge') || (sotto === 'repo' && ['create', 'delete', 'edit', 'rename', 'archive'].includes(args[1]))) out.push(PUBBLICA);
			break;
		case 'firebase':
		case 'netlify':
		case 'fly':
		case 'flyctl':
		case 'wrangler':
			if (['deploy', 'publish'].includes(sotto)) out.push(PUBBLICA);
			break;
		case 'cargo':
			if (sotto === 'publish') out.push(PUBBLICA);
			break;
		case 'pod':
			if (sotto === 'trunk' && args[1] === 'push') out.push(PUBBLICA);
			break;
		case 'docker':
			if (sotto === 'push') out.push(PUBBLICA);
			break;
		case 'supabase':
			if ((sotto === 'db' && args[1] === 'push') || (sotto === 'functions' && args[1] === 'deploy') || (sotto === 'secrets' && args[1] === 'set')) out.push(PUBBLICA);
			break;
		case 'gcloud':
			if (args.includes('deploy')) out.push(PUBBLICA);
			break;
		case 'heroku':
			out.push(PUBBLICA);
			break;
		case 'brew':
			if (['install', 'reinstall', 'uninstall', 'remove', 'rm', 'upgrade', 'tap', 'untap', 'cleanup', 'link', 'unlink'].includes(sotto)) out.push('installa o toglie programmi sul Mac');
			break;
		case 'mas':
		case 'gem':
			if (['install', 'uninstall', 'upgrade', 'update'].includes(sotto)) out.push('installa o toglie programmi sul Mac');
			break;
		case 'pip':
		case 'pip3':
			if (['install', 'uninstall'].includes(sotto)) out.push('installa o toglie pacchetti python');
			break;
	}
	// curl ... | sh: uno script scaricato eseguito al buio
	if (prima && parte.sep === '|' && INTERPRETI.has(nome) && args.length === 0) {
		const p = programma(prima.parole).prog;
		if (['curl', 'wget'].includes(path.basename(p ?? ''))) out.push('esegue uno script scaricato da internet');
	}
	out.push(...scrittureFuori([...parte.scrive, ...destinazioni(nome, resto)], c));
	return out;
}

/** Una parte che legge soltanto. */
function innocua(parte: Parte): boolean {
	if (parte.scrive.some(s => !DEV_INNOCUI.has(s))) return false;
	const { prog, resto } = programma(parte.parole);
	if (!prog) return false;
	const nome = path.basename(prog);
	const args = argomenti(resto);
	// --version, -v: solo un numero
	if (resto.length === 1 && /^(--version|-v|-V|version)$/.test(resto[0])) return true;
	if (nome === 'find') return !resto.some(r => /^-(delete|exec|execdir|ok|okdir|fprint.*|fls)$/.test(r));
	if (nome === 'top') return resto.includes('-l');
	if (INNOCUI.has(nome)) return true;
	const s = SOTTO_INNOCUI[nome];
	if (s) {
		const sotto = nome === 'git' ? resto[indiceGit(resto)] : args[0];
		if (sotto && s.has(sotto)) return true;
	}
	if (nome === 'git') {
		const gi = indiceGit(resto);
		const g = resto[gi];
		const ga = resto.slice(gi + 1);
		if (g === 'branch') return ga.every(a => ['-a', '-r', '-v', '-vv', '--list', '--show-current', '-l', '--all', '--remotes', '--merged', '--no-merged'].includes(a));
		if (g === 'remote') return ga.every(a => a === '-v' || a === 'show' || a === 'get-url' || !a.startsWith('-')) && !['add', 'remove', 'rm', 'rename', 'set-url', 'prune'].includes(ga[0]);
		if (g === 'stash') return ga[0] === 'list' || ga[0] === 'show';
		if (g === 'tag') return ga.length === 0 || ga.every(a => a === '-l' || a === '--list');
		if (g === 'config') return ga.some(a => ['--get', '--list', '-l', '--get-all'].includes(a));
	}
	if (nome === 'gh') return ['list', 'view', 'status', 'diff', 'checks'].includes(args[1] ?? '');
	if (nome === 'xcrun') return args[0] === 'simctl' && args[1] === 'list';
	if (nome === 'xcodebuild') return resto.every(r => ['-list', '-showsdks', '-version', '-showBuildSettings'].includes(r) || !r.startsWith('-')) && resto.some(r => ['-list', '-showsdks', '-version', '-showBuildSettings'].includes(r));
	return false;
}

export interface Analisi {
	parti: { forma?: string; innocua: boolean; paletti: string[] }[];
	sostituzione: boolean;
	/** Tutti i paletti, senza doppioni: diventano le righe d'avviso in ambra. */
	paletti: string[];
}

/** Analizza un comando parte per parte. `cd` cambia la cartella per le parti che seguono. */
export function analizza(comando: string, cartella: string, home: string): Analisi {
	const d = dividi(comando);
	const c: Contesto = { cartella: path.resolve(cartella), radice: path.resolve(cartella), home: path.resolve(home) };
	const parti: Analisi['parti'] = [];
	const tutti: string[] = [];
	d.parti.forEach((p, i) => {
		const pal = paletti(p, { ...c }, d.parti[i - 1]);
		parti.push({ forma: forma(p.parole), innocua: innocua(p), paletti: pal });
		for (const x of pal) if (!tutti.includes(x)) tutti.push(x);
		const { prog, resto } = programma(p.parole);
		if (prog === 'cd' || prog === 'pushd') {
			const dove = argomenti(resto)[0];
			if (!dove || dove === '~') c.cartella = c.home;
			else if (!/[$`]/.test(dove) && dove !== '-') c.cartella = path.resolve(c.cartella, dove.replace(/^~(?=\/)/, c.home));
		}
	});
	// sh -c "$(curl ...)": anche questo e' uno script scaricato
	if (d.sostituzione && /\b(curl|wget)\b/.test(comando) && /\b(sh|bash|zsh)\b/.test(comando) && !tutti.includes('esegue uno script scaricato da internet')) tutti.push('esegue uno script scaricato da internet');
	if (/:\s*\(\s*\)\s*\{/.test(comando)) tutti.push('blocca il Mac (fork bomb)');
	return { parti, sostituzione: d.sostituzione, paletti: tutti };
}

export interface Decisione {
	esegui: Esegui;
	avvisi: string[];
	/** Si puo' aggiungere ai consentiti: niente paletti, niente sostituzioni, ogni parte ha una forma. */
	consentibile: boolean;
	forme: string[];
}

/** Cosa fare del comando proposto. I paletti chiedono sempre (in `proponi` il comando va nel buffer con l'avviso);
 *  in `chiedi` va da solo solo cio' che e' consentito; in `auto` anche cio' che legge soltanto. Una catena va da sola
 *  solo se ogni parte lo fa. */
export function decidi(comando: string, o: { modo: Modo; consentiti: string[]; cartella: string; home: string }): Decisione {
	const a = analizza(comando, o.cartella, o.home);
	const forme = [...new Set(a.parti.map(p => p.forma).filter((f): f is string => !!f))];
	const consentibile = a.parti.length > 0 && !a.paletti.length && !a.sostituzione && a.parti.every(p => !!p.forma);
	const ok = new Set(o.consentiti);
	let esegui: Esegui;
	if (o.modo === 'proponi') esegui = 'proponi';
	else if (!consentibile) esegui = 'chiedi';
	else {
		const consentite = a.parti.filter(p => p.forma && ok.has(p.forma)).length;
		const tutte = a.parti.every(p => (p.forma && ok.has(p.forma)) || p.innocua);
		esegui = tutte && (o.modo === 'auto' || consentite > 0) ? 'subito' : 'chiedi';
	}
	return { esegui, avvisi: a.paletti, consentibile, forme };
}

// ---------- i consentiti ----------

export function leggiConsentiti(file: string): string[] {
	try {
		const j = JSON.parse(fs.readFileSync(file, 'utf8'));
		return Array.isArray(j?.forme) ? j.forme.filter((x: unknown) => typeof x === 'string' && x.trim()) : [];
	} catch {
		return [];
	}
}

export function scriviConsentiti(file: string, forme: string[]): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ forme: [...new Set(forme)].sort() }, null, 2) + '\n', { mode: 0o600 });
	fs.renameSync(tmp, file);
	fs.chmodSync(file, 0o600);
}

// ---------- il prompt e la risposta del cervello ----------

export interface ContestoRichiesta {
	sistema: string;
	zsh: string;
	cartella: string;
	git?: { ramo: string; stato: string };
	ultimo?: string;
	codice?: number;
}

export function promptSistema(tipo: 'comando' | 'perche'): string {
	const base = [
		'Sei l\'aiuto del terminale della Bottega, sul Mac di Andrea. Trasformi una richiesta in italiano in un comando di shell.',
		'Regole:',
		'- Il sistema e\' macOS con zsh: usa comandi BSD e di macOS, non GNU (per esempio sed -i \'\', stat -f, du -sh, find -size +100M, pbcopy, open, mdfind).',
		'- Niente sudo se non e\' indispensabile. Non cancellare, non pubblicare e non fare git push se la richiesta non lo chiede in modo esplicito.',
		'- "Qui" e "questa cartella" sono la cartella corrente: usa percorsi relativi.',
		'- Niente markdown, niente ```, niente $ davanti, niente spiegazioni dopo il comando.',
	];
	if (tipo === 'perche') {
		return [
			...base,
			'- L\'ultimo comando e\' andato storto. Rispondi con al massimo due righe che cominciano con "# " e dicono in italiano, brevi, perche\' e\' fallito; poi una riga con il comando che lo rimedia.',
			'- Se non c\'e\' niente da rimediare, solo le due righe con "# ".',
		].join('\n');
	}
	return [
		...base,
		'- Rispondi SOLO con il comando: una riga; se servono piu\' comandi uniscili con &&.',
		'- Se e\' una domanda su Andrea, il suo lavoro o i suoi dati (guadagni, vendite, download, app, ore, progetti, lavori e sessioni di Claude, posta, clienti, regole, cose da fare, siti), o comunque una domanda da fare a un\'assistente e non un comando sul Mac, rispondi esattamente MELISSA e nient\'altro.',
		'- Se la richiesta non si fa con un comando e non e\' una domanda, rispondi con una sola riga che comincia con "# " e dice perche\'.',
	].join('\n');
}

export function promptUtente(richiesta: string, c: ContestoRichiesta, tipo: 'comando' | 'perche'): string {
	const r = [`Sistema: ${c.sistema}, zsh ${c.zsh || 'sconosciuta'}.`, `Cartella corrente: ${c.cartella}`];
	if (c.git) {
		r.push(`Repository git, ramo ${c.git.ramo}.`);
		if (c.git.stato) r.push(`git status --short:\n${c.git.stato}`);
	}
	if (tipo === 'perche' || c.ultimo) {
		if (c.ultimo) r.push(`Ultimo comando: ${c.ultimo} (codice d'uscita ${c.codice ?? 'sconosciuto'})`);
	}
	r.push(tipo === 'perche' ? `Spiega perche' l'ultimo comando e' fallito e proponi il rimedio.${richiesta ? ` Nota di Andrea: ${richiesta}` : ''}` : `Richiesta: ${richiesta}`);
	return r.join('\n');
}

/** Dalla risposta del modello: le righe di spiegazione (# ...) e il comando. */
export function leggiProposta(testo: string): { comando: string; spiega: string[] } {
	let t = String(testo ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
	t = t.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '');
	const spiega: string[] = [];
	const righe: string[] = [];
	for (const r of t.split('\n')) {
		const x = r.trimEnd();
		if (/^\s*```/.test(x)) continue;
		if (/^\s*#(\s|$)/.test(x)) {
			const s = x.replace(/^\s*#\s?/, '').trim();
			if (s) spiega.push(s);
			continue;
		}
		if (!x.trim()) continue;
		righe.push(x.replace(/^\s*\$\s+/, ''));
	}
	let comando = righe.join('\n').trim();
	if (/^`[^`]+`$/.test(comando)) comando = comando.slice(1, -1);
	return { comando, spiega };
}

// ---------- il protocollo del socket ----------

/** Separatore delle righe dentro un valore (un comando su piu' righe): il widget lo usa al posto di \n. */
export const SEP_RIGHE = '\x1e';

export function leggiRichiesta(testo: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const r of testo.split('\n')) {
		if (!r) break;
		const i = r.indexOf(' ');
		const k = i < 0 ? r : r.slice(0, i);
		if (!/^[a-z]+$/.test(k)) continue;
		out[k] = (i < 0 ? '' : r.slice(i + 1)).split(SEP_RIGHE).join('\n');
	}
	return out;
}

export interface Risposta {
	esito: 'ok' | 'errore' | 'aspetta';
	esegui?: Esegui;
	consentibile?: boolean;
	avvisi?: string[];
	spiega?: string[];
	note?: string[];
	errore?: string;
	comando?: string;
	/** La risposta di Melissa a una domanda, riga per riga. */
	risposta?: string[];
}

const unaRiga = (s: string) => String(s).replace(/[\r\n]+/g, ' ').trim();

/** La risposta al widget: righe `chiave valore`, una riga vuota, poi il comando cosi' com'e'. */
export function codifica(r: Risposta): string {
	const righe = [`esito ${r.esito}`];
	if (r.esegui) righe.push(`esegui ${r.esegui}`);
	if (r.consentibile !== undefined) righe.push(`consentibile ${r.consentibile ? 'si' : 'no'}`);
	for (const n of r.note ?? []) righe.push(`nota ${unaRiga(n)}`);
	for (const s of r.spiega ?? []) righe.push(`spiega ${unaRiga(s)}`);
	for (const a of r.avvisi ?? []) righe.push(`avviso ${unaRiga(a)}`);
	for (const x of r.risposta ?? []) righe.push(`risposta ${unaRiga(x)}`);
	if (r.errore) righe.push(`errore ${unaRiga(r.errore)}`);
	return righe.join('\n') + '\n\n' + (r.comando ? r.comando + '\n' : '');
}

export function decodifica(testo: string): Risposta {
	const i = testo.indexOf('\n\n');
	const testa = i < 0 ? testo : testo.slice(0, i);
	const corpo = i < 0 ? '' : testo.slice(i + 2).replace(/\n$/, '');
	const r: Risposta = { esito: 'errore', avvisi: [], spiega: [], note: [] };
	for (const riga of testa.split('\n')) {
		const j = riga.indexOf(' ');
		const k = riga.slice(0, j);
		const v = riga.slice(j + 1);
		if (k === 'esito') r.esito = v as Risposta['esito'];
		else if (k === 'esegui') r.esegui = v as Esegui;
		else if (k === 'consentibile') r.consentibile = v === 'si';
		else if (k === 'nota') r.note!.push(v);
		else if (k === 'spiega') r.spiega!.push(v);
		else if (k === 'avviso') r.avvisi!.push(v);
		else if (k === 'risposta') (r.risposta ??= []).push(v);
		else if (k === 'errore') r.errore = v;
	}
	if (corpo) r.comando = corpo;
	return r;
}

// ---------- i cervelli ----------

/** Pensa con un cervello: torna il testo della risposta, o lancia un errore se non risponde. */
export type Pensa = (cervello: Pensatore, sistema: string, utente: string, signal: AbortSignal) => Promise<string>;

/** Il pensatore vero: Agnes e DeepSeek con gli stream di src/cervelli.ts (senza ragionamento, per rispondere subito),
 *  Apple Intelligence con `runAppleTurn` di src/cervello.ts, senza strumenti. */
export function pensatore(o: {
	cervelli: { streamFor(c: { provider: 'agnes' | 'deepseek'; model: string; effort: 'rapido' }): LlmStreamFn | undefined };
	nucleo: () => NucleoBridge | undefined;
	apple: () => boolean;
}): Pensa {
	return async (cervello, sistema, utente, signal) => {
		if (cervello === 'apple') {
			const n = o.nucleo();
			if (!n || !n.available || !o.apple()) throw new Error('Apple Intelligence non c\'e\'');
			const r = await runAppleTurn(n, { instructions: sistema, prompt: utente, history: [], tools: [], exec: async () => '', signal, maxTokens: 300, timeoutMs: 25_000 });
			return r.text;
		}
		const stream = o.cervelli.streamFor({ provider: 'deepseek', model: DEFAULT_CHOICE.model, effort: 'rapido' });
		if (!stream) throw new Error('cervello non disponibile');
		let testo = '';
		const messaggi: LlmMessage[] = [
			{ role: 'system', content: sistema },
			{ role: 'user', content: utente },
		];
		await stream(messaggi, [], d => void (d.content && (testo += d.content)), signal);
		return testo;
	};
}

// ---------- lo sportello: il socket ----------

export interface SportelloOpzioni {
	percorso: string;
	modo(): Modo;
	cervello(): CervelloTerminale;
	pensa: Pensa;
	consentiti: string;
	home: string;
	/** macOS e la versione, letti una volta. */
	sistema?: () => Promise<string>;
	/** Ramo e `git status --short` della cartella (finto nei test). */
	git?: (cartella: string) => Promise<{ ramo: string; stato: string } | undefined>;
	ora?: () => number;
	/** Una domanda che non e' un comando va a Melissa, con i suoi strumenti (stanze, App Store, cruscotto...): testo
	 *  della risposta. Senza, la domanda resta una spiegazione del cervello. */
	melissa?: (domanda: string) => Promise<string>;
	/** Tempo massimo per cervello, in millisecondi (Apple il doppio). */
	attesa?: number;
	log?: (s: string) => void;
}

export interface Sportello {
	readonly attivo: boolean;
	chiudi(): Promise<void>;
	/** Per i test e per l'host: risponde a una richiesta senza passare dal socket. */
	rispondi(campi: Record<string, string>): Promise<Risposta>;
}

const MAX_RICHIESTA = 16 * 1024;

export function gitDi(cartella: string): Promise<{ ramo: string; stato: string } | undefined> {
	const git = (args: string[]) =>
		new Promise<string | undefined>(ok => execFile('git', ['-C', cartella, ...args], { timeout: 1500, maxBuffer: 256 * 1024 }, (e, out) => ok(e ? undefined : String(out))));
	return git(['rev-parse', '--abbrev-ref', 'HEAD']).then(async ramo => {
		if (ramo === undefined) return undefined;
		const stato = (await git(['status', '--short'])) ?? '';
		const righe = stato.split('\n').filter(Boolean);
		return { ramo: ramo.trim(), stato: righe.slice(0, 15).join('\n') + (righe.length > 15 ? `\n(e altri ${righe.length - 15})` : '') };
	});
}

let sistemaLetto: Promise<string> | undefined;
export function sistemaMac(): Promise<string> {
	return (sistemaLetto ??= new Promise(ok =>
		execFile('/usr/bin/sw_vers', ['-productVersion'], { timeout: 2000 }, (e, out) => ok(e ? 'macOS' : `macOS ${String(out).trim()}`)),
	));
}

/** Apre il socket. Se un'altra finestra della Bottega ce l'ha gia' (risponde), si resta di riserva e si riprova ogni
 *  30 secondi: quando quella si chiude, il socket passa a questa. */
export function apriSportello(o: SportelloOpzioni): Sportello {
	const ora = o.ora ?? Date.now;
	const log = o.log ?? (() => undefined);
	let occupato = false;
	let ultimaAgnes = -Infinity;
	let server: net.Server | undefined;
	let mio: { ino: number } | undefined;
	let pronto = false;
	let chiuso = false;

	const chiediAMelissa = async (domanda: string): Promise<Risposta> => {
		const t0 = ora();
		try {
			const testo = String(await o.melissa!(domanda)).trim();
			log(`Melissa ha risposto in ${((ora() - t0) / 1000).toFixed(1)} s`);
			const righe = testo.split(/\n+/).map(x => x.trim()).filter(Boolean).slice(0, 30);
			return { esito: 'ok', note: ['risponde Melissa'], risposta: righe.length ? righe : ['Melissa non ha risposto niente.'] };
		} catch (e: any) {
			return { esito: 'errore', errore: `Melissa non risponde: ${String(e?.message ?? e).split('\n')[0].slice(0, 120)}` };
		}
	};

	const rispondi = async (c: Record<string, string>): Promise<Risposta> => {
		const azione = c.azione || 'proponi';
		const cartella = c.cartella && path.isAbsolute(c.cartella) ? c.cartella : o.home;
		if (azione === 'stato') return { esito: 'ok' };
		if (azione === 'consenti') {
			const comando = (c.comando ?? '').trim();
			const d = decidi(comando, { modo: 'chiedi', consentiti: [], cartella, home: o.home });
			if (!comando || !d.consentibile) return { esito: 'errore', errore: `questo comando non si puo' consentire${d.avvisi.length ? `: ${d.avvisi.join(', ')}` : ''}` };
			const prima = leggiConsentiti(o.consentiti);
			const nuove = d.forme.filter(f => !prima.includes(f));
			scriviConsentiti(o.consentiti, [...prima, ...d.forme]);
			log(`consentiti: ${nuove.join(', ') || 'gia\' tutti'}`);
			return { esito: 'ok', note: [nuove.length ? `da ora senza chiedere: ${nuove.join(', ')}` : `gia' consentito: ${d.forme.join(', ')}`] };
		}
		const tipo = c.tipo === 'perche' ? 'perche' : 'comando';
		const richiesta = (c.richiesta ?? '').trim().slice(0, 2000);
		if (tipo === 'comando' && !richiesta) return { esito: 'errore', errore: 'scrivi cosa vuoi fare' };
		if (tipo === 'perche' && !(c.ultimo ?? '').trim()) return { esito: 'errore', errore: 'non ho un ultimo comando da spiegare' };
		if (occupato) return { esito: 'aspetta', errore: 'aspetta un attimo, sto gia\' pensando' };
		const fila: Pensatore[] = ['deepseek', 'apple']; // anche le preferenze Agnes storiche migrano
		if (fila[0] === 'agnes' && ora() - ultimaAgnes < PAUSA_AGNES) return { esito: 'aspetta', errore: 'aspetta un attimo: Agnes accetta una richiesta ogni 3 secondi' };
		occupato = true;
		const t0 = ora();
		try {
			const [sistema, git] = await Promise.all([(o.sistema ?? sistemaMac)(), (o.git ?? gitDi)(cartella).catch(() => undefined)]);
			const codice = Number.parseInt(c.codice ?? '', 10);
			const ctx: ContestoRichiesta = { sistema, zsh: c.zsh ?? '', cartella, git, ultimo: tipo === 'perche' || c.ultimo ? (c.ultimo ?? '').slice(0, 500) : undefined, codice: Number.isFinite(codice) ? codice : undefined };
			if (tipo === 'comando') ctx.ultimo = undefined; // per una richiesta nuova l'ultimo comando non serve
			const sis = promptSistema(tipo);
			const ute = promptUtente(richiesta, ctx, tipo);
			const falliti: string[] = [];
			for (const cerv of fila) {
				if (cerv === 'agnes' && ora() - ultimaAgnes < PAUSA_AGNES) {
					falliti.push(`${NOMI.agnes} (appena usata)`);
					continue;
				}
				if (cerv === 'agnes') ultimaAgnes = ora();
				const ctrl = new AbortController();
				const timer = setTimeout(() => ctrl.abort(), (o.attesa ?? 12_000) * (cerv === 'apple' ? 2 : 1));
				let testo: string;
				try {
					testo = await o.pensa(cerv, sis, ute, ctrl.signal);
				} catch (e: any) {
					const perche = ctrl.signal.aborted ? 'troppo lento' : String(e?.message ?? e).split('\n')[0].slice(0, 80);
					falliti.push(`${NOMI[cerv]} (${perche})`);
					continue;
				} finally {
					clearTimeout(timer);
				}
				const p = leggiProposta(testo);
				// una domanda, non un comando: risponde Melissa con i suoi strumenti
				if (tipo === 'comando' && o.melissa && (/^\s*MELISSA\b/.test(testo.trim()) || (!p.comando && p.spiega.length))) {
					log(`domanda da ${cartella}: ${NOMI[cerv]} la passa a Melissa`);
					return await chiediAMelissa(richiesta);
				}
				if (!p.comando && !p.spiega.length) {
					falliti.push(`${NOMI[cerv]} (risposta vuota)`);
					continue;
				}
				const note = cerv !== fila[0] ? [`${NOMI[fila[0]]} non risponde, ha risposto ${NOMI[cerv]}.`] : [];
				log(`${tipo} da ${cartella}: ${NOMI[cerv]} in ${((ora() - t0) / 1000).toFixed(1)} s${falliti.length ? `, prima ${falliti.join(', ')}` : ''}`);
				if (!p.comando) return { esito: 'ok', note, spiega: p.spiega };
				const d = decidi(p.comando, { modo: o.modo(), consentiti: leggiConsentiti(o.consentiti), cartella, home: o.home });
				return { esito: 'ok', esegui: d.esegui, consentibile: d.consentibile, avvisi: d.avvisi, spiega: p.spiega, note, comando: p.comando };
			}
			log(`nessun cervello ha risposto: ${falliti.join(', ')}`);
			return { esito: 'errore', errore: `nessun cervello risponde: ${falliti.join(', ')}` };
		} finally {
			occupato = false;
		}
	};

	const servi = (sock: net.Socket) => {
		let buf = '';
		let fatto = false;
		sock.setEncoding('utf8');
		sock.setTimeout(90_000, () => sock.destroy());
		sock.on('error', () => undefined);
		const vai = () => {
			if (fatto) return;
			fatto = true;
			rispondi(leggiRichiesta(buf))
				.catch((e: any) => ({ esito: 'errore', errore: String(e?.message ?? e) }) as Risposta)
				.then(r => sock.end(codifica(r)));
		};
		sock.on('data', (d: string) => {
			buf += d;
			if (buf.length > MAX_RICHIESTA) return sock.destroy();
			if (buf.includes('\n\n')) vai();
		});
		sock.on('end', vai);
	};

	const vivo = (): Promise<boolean> =>
		new Promise(ok => {
			const s = net.connect(o.percorso);
			const t = setTimeout(() => (s.destroy(), ok(false)), 1000);
			s.on('connect', () => (clearTimeout(t), s.end(), ok(true)));
			s.on('error', () => (clearTimeout(t), ok(false)));
		});

	const prendi = async () => {
		if (chiuso || server) return;
		if (fs.existsSync(o.percorso)) {
			if (await vivo()) return; // un'altra finestra: si resta di riserva
			try {
				fs.unlinkSync(o.percorso);
			} catch {}
		}
		if (chiuso || server) return;
		fs.mkdirSync(path.dirname(o.percorso), { recursive: true, mode: 0o700 });
		const s = net.createServer(servi);
		server = s;
		s.on('error', (e: any) => {
			log(`socket non aperto: ${e?.message ?? e}`);
			if (server === s) server = undefined;
		});
		s.listen(o.percorso, () => {
			try {
				fs.chmodSync(o.percorso, 0o600);
				mio = { ino: fs.statSync(o.percorso).ino };
			} catch {}
			pronto = server === s;
			log(`socket pronto: ${o.percorso}`);
		});
	};
	void prendi();
	const giro = setInterval(() => {
		// un'altra finestra ha chiuso e tolto il socket, o qualcuno l'ha cancellato: lo si riprende
		if (server && !fs.existsSync(o.percorso)) {
			server.close();
			server = undefined;
			pronto = false;
		}
		void prendi();
	}, 30_000);
	giro.unref?.();

	return {
		get attivo() {
			return pronto && !!server && server.listening;
		},
		rispondi,
		chiudi: () =>
			new Promise<void>(ok => {
				chiuso = true;
				clearInterval(giro);
				const s = server;
				server = undefined;
				// si toglie il file solo se e' ancora il nostro (un'altra finestra puo' averlo ripreso)
				try {
					if (mio && fs.statSync(o.percorso).ino === mio.ino) fs.unlinkSync(o.percorso);
				} catch {}
				if (!s) return ok();
				s.close(() => ok());
			}),
	};
}

// ---------- i file di zsh ----------

/** I file di extensions/bottega-home/shell e il loro nome in ~/.bottega/zsh. */
export const FILE_ZSH: Record<string, string> = { zshenv: '.zshenv', zprofile: '.zprofile', zshrc: '.zshrc', zlogin: '.zlogin', 'agnes.zsh': 'agnes.zsh' };

/** Copia i file di zsh nella cartella della Bottega (700, file 600), solo quelli cambiati, e il nome del cervello
 *  (lo legge il widget per «Agnes pensa…»). Torna i file riscritti. */
export function installaZsh(sorgente: string, dest: string, cervello: CervelloTerminale): string[] {
	fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
	fs.chmodSync(dest, 0o700);
	const scritti: string[] = [];
	const scrivi = (nome: string, testo: string) => {
		const f = path.join(dest, nome);
		try {
			if (fs.readFileSync(f, 'utf8') === testo) return;
		} catch {}
		const tmp = `${f}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, testo, { mode: 0o600 });
		fs.renameSync(tmp, f);
		scritti.push(nome);
	};
	for (const [da, a] of Object.entries(FILE_ZSH)) scrivi(a, fs.readFileSync(path.join(sorgente, da), 'utf8'));
	scrivi('cervello', NOMI[cervello] + '\n');
	return scritti;
}

/** Il comando che il profilo «Bottega» di iTerm2 lancia per avere lo stesso zsh, o undefined se non si puo'
 *  (shell non zsh, percorso con spazi o caratteri strani). */
export function comandoIterm(zdotdir: string, shell: string | undefined): string | undefined {
	const sh = shell && /\/zsh$/.test(shell) ? shell : '/bin/zsh';
	if (shell && !/\/zsh$/.test(shell)) return undefined;
	if (!/^[A-Za-z0-9_./-]+$/.test(zdotdir) || !/^[A-Za-z0-9_./-]+$/.test(sh)) return undefined;
	return `/usr/bin/env ZDOTDIR=${zdotdir} ${sh} -l`;
}
