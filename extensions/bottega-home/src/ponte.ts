import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { CAMPI_TOKEN, DispositivoParziale, TOKEN_HEX } from './dispositivo';

/* Il ponte verso l'iPhone (docs/CONTRATTI.md, sezione 9). Un server HTTP che ascolta SOLO sull'indirizzo
   Tailscale del Mac: dal Wi-Fi di casa o da internet non si vede, dall'iPhone nella stessa rete Tailscale si'.
   Ogni richiesta porta il gettone (Authorization: Bearer), generato una volta e tenuto in ~/.bottega/ponte.json.
   Il traffico e' gia' cifrato da WireGuard dentro Tailscale: niente TLS sopra.

     GET  /v1/stato               -> Stato (Melissa, lavori, conti)
     GET  /v1/eventi              -> text/event-stream, una riga "data: Stato" a ogni cambio
     POST /v1/chiedi {testo}      -> {risposta, stato}      stesso cervello e stessa conversazione del Mac
     POST /v1/parla {testo}       -> application/x-ndjson   la domanda a voce: frasi e audio mentre Melissa risponde
     POST /v1/voce {testo}        -> audio/wav              la voce di Melissa, sintetizzata sul Mac
     POST /v1/lavoro {id, testo}  -> {ok}                   scrive in un lavoro della Bottega
     POST /v1/dispositivo {...}   -> {ok}                   i token APNs dell'iPhone (9.4): notifiche, Live Activity, widget */

export interface PonteMelissa {
	stato: string;
	cervello: string;
	parziale?: string;
	registro: { chi: 'tu' | 'melissa' | 'azione'; testo: string; alle: number }[];
}

export interface PonteLavoro {
	chiave: string;
	origine: 'bottega' | 'altrove';
	stato: string;
	progetto: string;
	titolo: string;
	da: number;
	jobId?: string;
}

export interface PonteStato {
	versione: string;
	mac: string;
	ora: number;
	melissa: PonteMelissa;
	lavori: PonteLavoro[];
	conti: { inCorso: number; tiAspetta: number; inCoda: number; vive: number };
}

export interface PonteDeps {
	/** Cartella dei dati della Bottega (~/.bottega): li' sta il gettone. */
	dir: string;
	versione: string;
	stato(): Omit<PonteStato, 'versione' | 'mac' | 'ora'>;
	/** Vero mentre Melissa sta gia' rispondendo a qualcuno. */
	occupata(): boolean;
	chiedi(testo: string): Promise<string>;
	/** Il numero della conferma che Melissa aspetta adesso (per le notifiche CONFERMA), se ce n'e' una. */
	confermaAttuale?(): number | undefined;
	/** Domanda a voce: `emetti` riceve le righe ({tipo: voce|frase|audio}) mentre Melissa risponde; `segnale`
	 *  scatta se l'iPhone chiude (interruzione). Ritorna la risposta intera. */
	parla(testo: string, emetti: (riga: RigaParla) => void, segnale: AbortSignal): Promise<string>;
	voce(testo: string): Promise<Buffer>;
	scriviLavoro(id: string, testo: string): boolean;
	/** I token APNs dell'iPhone: si fondono con quelli gia' noti ('' toglie un campo). */
	registraDispositivo(d: DispositivoParziale): void;
	log(riga: string): void;
	/** Solo per i test: dove ascoltare al posto dell'indirizzo Tailscale. */
	indirizzo?: () => Promise<Rete | null>;
	porta?: number;
}

export type RigaParla =
	| { tipo: 'voce'; ok: boolean }
	| { tipo: 'frase'; testo: string }
	| { tipo: 'audio'; pcm: string }
	| { tipo: 'voce-persa'; errore: string };

export interface Rete {
	ip: string;
	nome: string;
}

export interface PonteInfo {
	attivo: boolean;
	ip?: string;
	nome?: string;
	porta: number;
	errore?: string;
	collegamento?: string;
}

const PORTA = 7790;
const MAX_CORPO = 16 * 1024;
const MAX_TESTO = 2000;
const TAILSCALE = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

/** L'indirizzo Tailscale di questo Mac e il suo nome MagicDNS, o null se Tailscale non c'e' o e' spento. */
export function tailscaleSelf(): Promise<Rete | null> {
	const bin = TAILSCALE.find(p => fs.existsSync(p));
	if (!bin) return Promise.resolve(null);
	return new Promise(resolve => {
		execFile(bin, ['status', '--json'], { timeout: 5000, maxBuffer: 4 << 20 }, (err, out) => {
			if (err) return resolve(null);
			try {
				const d = JSON.parse(out);
				if (d.BackendState !== 'Running') return resolve(null);
				const ip = (d.Self?.TailscaleIPs ?? []).find((a: string) => /^100\./.test(a));
				const nome = String(d.Self?.DNSName ?? '').replace(/\.$/, '');
				resolve(ip ? { ip, nome: nome || ip } : null);
			} catch {
				resolve(null);
			}
		});
	});
}

/** Un indirizzo della rete Tailscale (CGNAT 100.64.0.0/10 o l'IPv6 fd7a:115c:a1e0::/48). */
export function inTailnet(addr: string | undefined): boolean {
	if (!addr) return false;
	const a = addr.replace(/^::ffff:/, '');
	const m = /^100\.(\d+)\./.exec(a);
	if (m) return +m[1] >= 64 && +m[1] <= 127;
	if (a === '127.0.0.1' || a === '::1') return true; // i test, e una richiesta dal Mac stesso
	return /^fd7a:115c:a1e0:/i.test(a);
}

export function leggiGettone(dir: string): string {
	const file = path.join(dir, 'ponte.json');
	try {
		const d = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (typeof d.token === 'string' && d.token.length >= 32) return d.token;
	} catch {
		// non c'e' ancora
	}
	const token = crypto.randomBytes(32).toString('base64url');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ token, creato: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
	fs.chmodSync(file, 0o600);
	return token;
}

function uguali(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class Ponte {
	private server?: http.Server;
	private rete: Rete | null = null;
	private errore?: string;
	private timer?: NodeJS.Timeout;
	private readonly token: string;
	private readonly porta: number;
	private readonly flussi = new Set<http.ServerResponse>();
	private pingTimer?: NodeJS.Timeout;
	private notifyTimer?: NodeJS.Timeout;
	/** Gettoni sbagliati per indirizzo: dopo 20 in dieci minuti quell'indirizzo resta fuori dieci minuti. */
	private readonly sbagli = new Map<string, number[]>();
	private fermato = false;
	/** Un riallineamento alla volta: due insieme aprirebbero due server, e uno resterebbe orfano. */
	private allineando?: Promise<void>;

	constructor(private readonly deps: PonteDeps) {
		this.token = leggiGettone(deps.dir);
		this.porta = deps.porta ?? PORTA;
	}

	/** Si accende sull'indirizzo Tailscale e ricontrolla ogni minuto: se Tailscale si spegne o cambia indirizzo, si riallinea. */
	async start(): Promise<void> {
		this.fermato = false;
		await this.allinea();
		if (!this.fermato && !this.timer) this.timer = setInterval(() => void this.allinea(), 60_000);
	}

	stop(): void {
		this.fermato = true;
		clearInterval(this.timer);
		this.timer = undefined;
		this.chiudi();
	}

	info(): PonteInfo {
		const attivo = !!this.server && !!this.rete;
		const out: PonteInfo = { attivo, porta: this.porta, ip: this.rete?.ip, nome: this.rete?.nome, errore: this.errore };
		if (this.rete) {
			const q = new URLSearchParams({ host: this.rete.nome, ip: this.rete.ip, porta: String(this.porta), token: this.token });
			out.collegamento = `bottega://collega?${q.toString()}`;
		}
		return out;
	}

	/** Qualcosa e' cambiato (Melissa, i lavori): chi segue gli eventi lo sa, al massimo tre volte al secondo. */
	notify(): void {
		if (!this.flussi.size || this.notifyTimer) return;
		this.notifyTimer = setTimeout(() => {
			this.notifyTimer = undefined;
			const riga = `data: ${JSON.stringify(this.stato())}\n\n`;
			for (const r of this.flussi) r.write(riga);
		}, 330);
	}

	private stato(): PonteStato {
		return { versione: this.deps.versione, mac: os.hostname().replace(/\.local$/, ''), ora: Date.now(), ...this.deps.stato() };
	}

	private allinea(): Promise<void> {
		this.allineando ??= this.riallinea().finally(() => (this.allineando = undefined));
		return this.allineando;
	}

	private async riallinea(): Promise<void> {
		const rete = await (this.deps.indirizzo ?? tailscaleSelf)();
		if (this.fermato) return;
		if (!rete) {
			if (this.server) this.deps.log('ponte: Tailscale non risponde, il ponte verso l\'iPhone si spegne');
			this.errore = 'Tailscale e\' spento o non installato su questo Mac.';
			this.rete = null;
			this.chiudi();
			return;
		}
		if (this.server && this.rete?.ip === rete.ip) {
			this.rete = rete;
			return;
		}
		this.chiudi();
		this.rete = rete;
		await this.apri(rete.ip);
	}

	private apri(ip: string): Promise<void> {
		return new Promise(resolve => {
			const server = http.createServer((req, res) => void this.gestisci(req, res));
			server.on('error', (e: any) => {
				this.errore = e?.code === 'EADDRINUSE' ? `La porta ${this.porta} e' gia' occupata.` : String(e?.message ?? e);
				this.deps.log(`ponte: ${this.errore}`);
				if (this.server === server) this.chiudi();
				else server.close();
				resolve();
			});
			server.listen(this.porta, ip, () => {
				if (this.fermato) {
					// spento mentre si apriva: non resta un server acceso che nessuno chiude
					server.close();
					return resolve();
				}
				this.server = server;
				this.errore = undefined;
				this.deps.log(`ponte: in ascolto su ${ip}:${this.porta} (${this.rete?.nome})`);
				this.pingTimer = setInterval(() => {
					for (const r of this.flussi) r.write(': ping\n\n');
				}, 25_000);
				resolve();
			});
		});
	}

	private chiudi(): void {
		clearInterval(this.pingTimer);
		this.pingTimer = undefined;
		for (const r of this.flussi) r.end();
		this.flussi.clear();
		this.server?.close();
		this.server?.closeAllConnections?.();
		this.server = undefined;
	}

	private escluso(addr: string): boolean {
		const now = Date.now();
		const list = (this.sbagli.get(addr) ?? []).filter(t => now - t < 600_000);
		this.sbagli.set(addr, list);
		return list.length >= 20;
	}

	private async gestisci(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const addr = req.socket.remoteAddress ?? '';
		const json = (code: number, body: unknown) => {
			res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
			res.end(JSON.stringify(body));
		};
		if (!inTailnet(addr)) return json(403, { errore: 'Solo dalla rete Tailscale.' });
		const auth = String(req.headers.authorization ?? '');
		const dato = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
		// il gettone giusto passa sempre: dopo un nuovo QR i widget col gettone vecchio non chiudono fuori l'iPhone
		if (!dato || !uguali(dato, this.token)) {
			if (this.escluso(addr)) return json(429, { errore: 'Troppi tentativi sbagliati: riprova tra dieci minuti.' });
			this.sbagli.get(addr)!.push(Date.now());
			this.deps.log(`ponte: gettone sbagliato da ${addr}`);
			return json(401, { errore: 'Gettone non valido: ricollega l\'iPhone dalla Bottega.' });
		}
		const url = (req.url ?? '/').split('?')[0];
		try {
			if (req.method === 'GET' && url === '/v1/stato') return json(200, this.stato());
			if (req.method === 'GET' && url === '/v1/eventi') return this.eventi(req, res);
			if (req.method !== 'POST') return json(404, { errore: 'Non c\'e\' niente qui.' });
			const corpo = (await leggiCorpo(req)) ?? {};
			if (typeof corpo !== 'object') return json(400, { errore: 'JSON non valido.' });
			const testo = typeof corpo.testo === 'string' ? corpo.testo.trim().slice(0, MAX_TESTO) : '';
			if (url === '/v1/chiedi') {
				if (!testo) return json(400, { errore: 'Manca il testo.' });
				if (this.deps.occupata()) return json(409, { errore: 'Melissa sta gia\' rispondendo: riprova tra un attimo.' });
				// un si' o un no da una notifica CONFERMA vale solo per la domanda di quella notifica
				if (typeof corpo.conferma === 'number' && this.deps.confermaAttuale?.() !== corpo.conferma) {
					return json(409, { errore: 'La domanda e\' cambiata o e\' gia\' chiusa: guarda Melissa nell\'app.' });
				}
				this.deps.log(`ponte: domanda dall'iPhone (${testo.length} caratteri)`);
				const risposta = await this.deps.chiedi(testo);
				return json(200, { risposta, stato: this.stato() });
			}
			if (url === '/v1/parla') {
				if (!testo) return json(400, { errore: 'Manca il testo.' });
				if (this.deps.occupata()) return json(409, { errore: 'Melissa sta gia\' rispondendo: riprova tra un attimo.' });
				// l'iPhone ha chiuso mentre arrivava la domanda: niente turno fantasma
				if (req.socket.destroyed) return;
				this.deps.log(`ponte: domanda a voce dall'iPhone (${testo.length} caratteri)`);
				res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
				res.socket?.setNoDelay(true);
				const riga = (o: unknown) => {
					if (!res.writableEnded) res.write(JSON.stringify(o) + '\n');
				};
				const ac = new AbortController();
				res.on('close', () => {
					if (!res.writableFinished) ac.abort();
				});
				try {
					const risposta = await this.deps.parla(testo, riga, ac.signal);
					riga({ tipo: 'fine', risposta, stato: this.stato() });
				} catch (e: any) {
					riga({ tipo: 'errore', errore: e?.status ? e.message : 'Sul Mac qualcosa non e\' andato.' });
					this.deps.log(`ponte: /v1/parla: ${e?.message ?? e}`);
				}
				return void res.end();
			}
			if (url === '/v1/voce') {
				if (!testo) return json(400, { errore: 'Manca il testo.' });
				const wav = await this.deps.voce(testo);
				res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'no-store' });
				return void res.end(wav);
			}
			if (url === '/v1/lavoro') {
				const id = typeof corpo.id === 'string' ? corpo.id : '';
				if (!id || !testo) return json(400, { errore: 'Servono il lavoro e il testo.' });
				return this.deps.scriviLavoro(id, testo)
					? json(200, { ok: true })
					: json(404, { errore: 'Quel lavoro non ha piu\' un terminale aperto.' });
			}
			if (url === '/v1/dispositivo') {
				if (corpo.ambiente !== 'sviluppo' && corpo.ambiente !== 'produzione') return json(400, { errore: 'Ambiente sconosciuto: sviluppo o produzione.' });
				const d: DispositivoParziale = { ambiente: corpo.ambiente };
				for (const c of CAMPI_TOKEN) {
					const v = corpo[c];
					if (v === undefined || v === null) continue;
					if (typeof v !== 'string' || (v !== '' && !TOKEN_HEX.test(v))) return json(400, { errore: `Il campo ${c} non e' un token valido.` });
					d[c] = v;
				}
				this.deps.registraDispositivo(d);
				this.deps.log(`ponte: iPhone registrato (${d.ambiente}: ${CAMPI_TOKEN.filter(c => d[c] !== undefined).map(c => (d[c] ? c : `${c} tolto`)).join(', ') || 'nessun token'})`);
				return json(200, { ok: true });
			}
			return json(404, { errore: 'Non c\'e\' niente qui.' });
		} catch (e: any) {
			this.deps.log(`ponte: ${url}: ${e?.message ?? e}`);
			if (!res.headersSent) json(e?.status ?? 500, { errore: e?.status ? e.message : 'Sul Mac qualcosa non e\' andato.' });
			else res.end();
		}
	}

	private eventi(req: http.IncomingMessage, res: http.ServerResponse): void {
		res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
		res.write(`data: ${JSON.stringify(this.stato())}\n\n`);
		this.flussi.add(res);
		req.on('close', () => this.flussi.delete(res));
	}
}

function leggiCorpo(req: http.IncomingMessage): Promise<any> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const parts: Buffer[] = [];
		const troppo = () => Object.assign(new Error('Richiesta troppo grande.'), { status: 413 });
		if (Number(req.headers['content-length'] ?? 0) > MAX_CORPO) {
			req.resume(); // si scarta senza tenerlo, cosi' la risposta 413 arriva
			return reject(troppo());
		}
		req.on('data', (c: Buffer) => {
			size += c.length;
			if (size <= MAX_CORPO) parts.push(c);
		});
		req.on('end', () => {
			if (size > MAX_CORPO) return reject(troppo());
			try {
				resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {});
			} catch {
				reject(Object.assign(new Error('JSON non valido.'), { status: 400 }));
			}
		});
		req.on('error', reject);
	});
}
