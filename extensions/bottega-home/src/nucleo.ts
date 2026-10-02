import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// Cliente del Nucleo nativo (Swift): una riga JSON per messaggio su stdin/stdout.
// Tutto degrada con grazia se il Nucleo non c'e': le funzioni che lo usano mostrano
// un messaggio chiaro in italiano invece di piantare la Bottega.

export interface Capabilities {
	foundationModels: boolean;
	/** Perche' Apple Intelligence non si puo' usare (spenta, modello in preparazione...), se non si puo'. */
	foundationModelsReason?: string;
	speechLocaleInstalled: boolean;
	speechLocale?: string;
	embedding: boolean;
	metal?: string;
	memoryGB?: number;
	cores?: number;
}

export interface SystemStats {
	load: number[];
	memoryPressure: string;
	memoryUsedGB: number;
	memoryTotalGB: number;
	thermal: string;
	cores: number;
}

interface Pending {
	resolve: (v: any) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

const HOME = os.homedir();

/** Il percorso dell'eseguibile del Nucleo, risolto nell'ordine del contratto. */
export function resolveNucleoPath(extensionPath: string): string | undefined {
	const configured = vscode.workspace.getConfiguration('bottega').get<string>('nucleoPath');
	const candidates = [
		configured,
		path.join(extensionPath, 'nucleo', 'Bottega Nucleo.app', 'Contents', 'MacOS', 'BottegaNucleo'),
		path.join(HOME, 'prototipi', 'Bottega', 'nucleo', 'build', 'Bottega Nucleo.app', 'Contents', 'MacOS', 'BottegaNucleo'),
	];
	for (const c of candidates) {
		if (c && fs.existsSync(c)) return c;
	}
	return undefined;
}

export class Nucleo extends EventEmitter {
	private proc?: ChildProcess;
	private buffer = '';
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private backoff = 500;
	private restartTimer?: NodeJS.Timeout;
	private statsTimer?: NodeJS.Timeout;
	/** Ogni quanto si chiedono le statistiche di sistema: spesso con la plancia davanti o con lavori in corso, di rado se no. */
	private statsEvery = 10_000;
	private stopped = false;
	private execPath?: string;
	private _available = false;
	private _capabilities?: Capabilities;
	private _lastStats?: SystemStats;
	private capsTimer?: NodeJS.Timeout;

	constructor(private readonly extensionPath: string) {
		super();
		this.setMaxListeners(50);
	}

	get available(): boolean {
		return this._available;
	}

	get capabilities(): Capabilities | undefined {
		return this._capabilities;
	}

	get lastStats(): SystemStats | undefined {
		return this._lastStats;
	}

	/** Avvia il Nucleo. Se l'eseguibile non c'e', resta spento senza rilanciare in loop. */
	start(): void {
		this.stopped = false;
		this.execPath = resolveNucleoPath(this.extensionPath);
		if (!this.execPath) {
			this._available = false;
			this.emit('unavailable', 'Il Nucleo nativo non e\' installato: la voce e le funzioni native sono spente.');
			return;
		}
		this.spawnProc();
	}

	private spawnProc(): void {
		if (this.stopped || !this.execPath) return;
		let proc: ChildProcess;
		try {
			proc = spawn(this.execPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (e: any) {
			this.scheduleRestart();
			return;
		}
		this.proc = proc;
		proc.stdout?.setEncoding('utf8');
		proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
		proc.stderr?.setEncoding('utf8');
		proc.stderr?.on('data', (chunk: string) => this.emit('stderr', chunk));
		proc.on('error', () => {
			/* gestito da 'exit' */
		});
		proc.on('exit', () => this.onExit());

		// Appena vivo: capabilities, scorciatoia globale, giro periodico delle statistiche.
		this.onReady();
	}

	private async onReady(): Promise<void> {
		this._available = true;
		this.backoff = 500;
		this.emit('available');
		// All'avvio della Bottega il Mac e' carico e il Nucleo puo' rispondere tardi: una risposta persa lasciava
		// Apple Intelligence «non attiva» fino al riavvio. Si riprova, e ogni 10 minuti si ricontrolla (il modello
		// puo' finire di scaricarsi, o Andrea accenderla nelle Impostazioni).
		await this.readCapabilities();
		clearInterval(this.capsTimer);
		this.capsTimer = setInterval(() => void this.readCapabilities(1), 10 * 60_000);
		const hotkey = vscode.workspace.getConfiguration('bottega').get<string>('voice.hotkey', 'option+space');
		const { key, modifiers } = parseHotkey(hotkey);
		this.request('hotkey.register', { key, modifiers }, 5000).catch(() => undefined);
		this.startStatsLoop();
	}

	private startStatsLoop(): void {
		clearInterval(this.statsTimer);
		const tick = async () => {
			try {
				const stats = await this.request<SystemStats>('system.stats', {}, 5000);
				this._lastStats = stats;
				this.emit('system.stats', stats);
			} catch {
				// un giro mancato non e' un problema
			}
		};
		void tick();
		this.statsTimer = setInterval(tick, this.statsEvery);
	}

	/** Cambia il ritmo delle statistiche di sistema; se il Nucleo e' gia' vivo riparte subito con quello nuovo. */
	setStatsInterval(ms: number): void {
		if (ms === this.statsEvery) return;
		this.statsEvery = ms;
		if (this.statsTimer) this.startStatsLoop();
	}

	private onStdout(chunk: string): void {
		this.buffer += chunk;
		let nl: number;
		while ((nl = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (!line) continue;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				continue; // riga non JSON (log sporco finito su stdout)
			}
			this.dispatch(msg);
		}
	}

	private dispatch(msg: any): void {
		if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
			const p = this.pending.get(msg.id)!;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.ok === false) p.reject(new Error(msg.error || 'Errore dal Nucleo'));
			else p.resolve(msg);
			return;
		}
		if (typeof msg.event === 'string') {
			if (msg.event === 'system.pressure' && (msg.memoryPressure || msg.thermal) && this._lastStats) {
				this._lastStats = { ...this._lastStats, memoryPressure: msg.memoryPressure ?? this._lastStats.memoryPressure, thermal: msg.thermal ?? this._lastStats.thermal };
			}
			this.emit(msg.event, msg);
			this.emit('event', msg);
			return;
		}
		if (msg.log) this.emit('log', msg.log);
	}

	private async readCapabilities(attempts = 4): Promise<void> {
		for (let i = 0; i < attempts && this._available; i++) {
			try {
				const caps = await this.request<Capabilities>('capabilities', {}, 15_000);
				this._capabilities = caps;
				this.emit('capabilities', caps);
				return;
			} catch {
				// senza capabilities si procede lo stesso; si riprova tra poco
				await new Promise(r => setTimeout(r, 3000));
			}
		}
	}

	private onExit(): void {
		this.proc = undefined;
		this._available = false;
		clearInterval(this.capsTimer);
		// Ogni richiesta in sospeso muore con il processo.
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error('Il Nucleo si e\' chiuso prima di rispondere.'));
		}
		this.pending.clear();
		clearInterval(this.statsTimer);
		this.emit('down');
		this.scheduleRestart();
	}

	private scheduleRestart(): void {
		if (this.stopped) return;
		clearTimeout(this.restartTimer);
		const wait = this.backoff;
		this.backoff = Math.min(this.backoff * 2, 30_000);
		this.restartTimer = setTimeout(() => this.spawnProc(), wait);
	}

	/** Richiesta con id e timeout. Se il Nucleo non c'e', rifiuta con un messaggio chiaro. */
	request<T = any>(cmd: string, args: Record<string, any> = {}, timeoutMs = 15_000): Promise<T> {
		if (!this.proc || !this.proc.stdin?.writable) {
			return Promise.reject(new Error('Il Nucleo nativo non e\' disponibile adesso.'));
		}
		const id = this.nextId++;
		const line = JSON.stringify({ id, cmd, ...args }) + '\n';
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Il Nucleo non ha risposto a "${cmd}" in tempo.`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.proc!.stdin!.write(line);
			} catch (e: any) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(new Error('Non riesco a scrivere al Nucleo.'));
			}
		});
	}

	/** Comando a cui non interessa la risposta: se il Nucleo manca, si ignora in silenzio. */
	fireAndForget(cmd: string, args: Record<string, any> = {}): void {
		this.request(cmd, args, 8000).catch(() => undefined);
	}

	dispose(): void {
		this.stopped = true;
		clearTimeout(this.restartTimer);
		clearInterval(this.statsTimer);
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error('Bottega in chiusura.'));
		}
		this.pending.clear();
		try {
			this.proc?.kill();
		} catch {
			// gia' morto
		}
		this.proc = undefined;
		this._available = false;
	}
}

/** "option+space" -> { key: "space", modifiers: ["option"] } per hotkey.register. */
export function parseHotkey(hotkey: string): { key: string; modifiers: string[] } {
	const parts = hotkey.toLowerCase().split('+').map(s => s.trim()).filter(Boolean);
	const mods = new Set(['option', 'alt', 'cmd', 'command', 'ctrl', 'control', 'shift']);
	const modifiers: string[] = [];
	let key = 'space';
	for (const p of parts) {
		if (mods.has(p)) {
			modifiers.push(p === 'alt' ? 'option' : p === 'command' ? 'cmd' : p === 'control' ? 'ctrl' : p);
		} else {
			key = p;
		}
	}
	return { key, modifiers: modifiers.length ? modifiers : ['option'] };
}
