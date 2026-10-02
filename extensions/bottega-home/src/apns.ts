import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http2 from 'http2';
import * as os from 'os';
import * as path from 'path';
import type { Ambiente } from './dispositivo';

/* Il client APNs (docs/CONTRATTI.md, 9.4): il Mac parla direttamente con Apple in HTTP/2, senza server di terzi
   e senza dipendenze npm. Autenticazione a token: un JWT ES256 firmato con la chiave .p8 del team, rifatto ogni
   50 minuti. La chiave sta nel vault (~/.secrets/bottega.env), mai nel repository, e ne' lei ne' il JWT finiscono
   nei registri.

     sviluppo   -> api.sandbox.push.apple.com   (build Debug)
     produzione -> api.push.apple.com */

export type TipoPush = 'alert' | 'liveactivity' | 'widgets';

export interface Push {
	tipo: TipoPush;
	token: string;
	ambiente: Ambiente;
	payload: object;
	/** 10 subito, 5 quando conviene alla batteria. */
	priorita: 5 | 10;
	/** Secondi dal 1970 oltre i quali APNs non ci riprova piu'; assente = un tentativo solo. */
	scadenza?: number;
}

export interface Esito {
	ok: boolean;
	status: number;
	reason?: string;
}

/** Chi manda davvero: il client APNs, o nei test un finto che registra. */
export interface Invio {
	manda(p: Push): Promise<Esito>;
}

export interface ApnsConfig {
	keyPath: string;
	keyId: string;
	teamId: string;
}

export const BUNDLE = 'com.andreapiani.bottega.ios';
const TOPIC: Record<TipoPush, string> = {
	alert: BUNDLE,
	liveactivity: `${BUNDLE}.push-type.liveactivity`,
	widgets: `${BUNDLE}.push-type.widgets`,
};
const HOST: Record<Ambiente, string> = { sviluppo: 'api.sandbox.push.apple.com', produzione: 'api.push.apple.com' };
const JWT_VITA = 50 * 60_000;
const INATTIVA = 10 * 60_000;
const ATTESA_RISPOSTA = 15_000;

/** Un token morto per APNs: il chiamante lo toglie dal registro. */
export function tokenMorto(e: Esito): boolean {
	return e.status === 410 || e.reason === 'BadDeviceToken' || e.reason === 'Unregistered';
}

/** Righe KEY=value (con o senza `export`, virgolette e commenti). */
export function leggiEnv(testo: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const riga of testo.split('\n')) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(riga);
		if (!m) continue;
		let v = m[2];
		if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
		else v = v.replace(/\s+#.*$/, '');
		out[m[1]] = v;
	}
	return out;
}

/** `$HOME`, `${HOME}` e `~` all'inizio diventano la cartella di casa. */
export function espandi(p: string, home = os.homedir()): string {
	return p.replace(/^~(?=\/|$)/, home).replace(/\$\{HOME\}|\$HOME\b/g, home);
}

/** La configurazione da ~/.secrets/bottega.env; le variabili d'ambiente con lo stesso nome vincono. */
export function leggiConfig(env: NodeJS.ProcessEnv = process.env, file = path.join(os.homedir(), '.secrets', 'bottega.env')): ApnsConfig | null {
	let daFile: Record<string, string> = {};
	try {
		daFile = leggiEnv(fs.readFileSync(file, 'utf8'));
	} catch {
		// niente vault: restano le variabili d'ambiente
	}
	const v = (k: string) => (env[k] || daFile[k] || '').trim();
	const keyPath = v('APNS_KEY_PATH');
	const keyId = v('APNS_KEY_ID');
	const teamId = v('APNS_TEAM_ID');
	if (!keyPath || !keyId || !teamId) return null;
	return { keyPath: espandi(keyPath), keyId, teamId };
}

function b64url(b: Buffer | string): string {
	return Buffer.from(b).toString('base64url');
}

/** JWT del provider: header {alg: ES256, kid}, claims {iss: team, iat}, firma ES256 in formato r||s (IEEE P1363). */
export function firmaJwt(key: crypto.KeyObject, keyId: string, teamId: string, iat: number): string {
	const corpo = `${b64url(JSON.stringify({ alg: 'ES256', kid: keyId }))}.${b64url(JSON.stringify({ iss: teamId, iat }))}`;
	const firma = crypto.sign('sha256', Buffer.from(corpo), { key, dsaEncoding: 'ieee-p1363' });
	return `${corpo}.${b64url(firma)}`;
}

interface Sessione {
	s: http2.ClientHttp2Session;
	timer?: NodeJS.Timeout;
}

export interface ApnsOpzioni {
	config?: () => ApnsConfig | null;
	ora?: () => number;
	log?: (riga: string) => void;
	/** Solo per i test: dove collegarsi al posto di Apple. */
	origine?: (ambiente: Ambiente) => string;
	connetti?: (origine: string) => http2.ClientHttp2Session;
}

export class Apns implements Invio {
	private readonly sessioni = new Map<string, Sessione>();
	private jwt?: { valore: string; nato: number; keyId: string };
	private key?: { path: string; obj: crypto.KeyObject };
	private readonly ora: () => number;
	private readonly log: (riga: string) => void;

	constructor(private readonly o: ApnsOpzioni = {}) {
		this.ora = o.ora ?? Date.now;
		this.log = o.log ?? (() => undefined);
	}

	/** Vero se la chiave e' configurata (non dice se Apple la accetta). */
	pronto(): boolean {
		return !!(this.o.config ?? leggiConfig)();
	}

	async manda(p: Push): Promise<Esito> {
		let auth: string;
		try {
			auth = this.autorizzazione();
		} catch (e: any) {
			return { ok: false, status: 0, reason: e?.message ?? 'Chiave APNs non disponibile' };
		}
		const origine = this.o.origine?.(p.ambiente) ?? `https://${HOST[p.ambiente]}`;
		const prova = (a: string) =>
			this.richiesta(origine, a, p).catch(err => ({ ok: false, status: 0, reason: String(err?.code ?? err?.message ?? err) }) as Esito);
		let e = await prova(auth);
		if (e.status === 0) {
			// la connessione era vecchia o la rete e' cambiata: una sessione nuova, un tentativo ancora
			this.chiudiSessione(origine);
			e = await prova(auth);
		} else if (e.status === 403 && e.reason === 'ExpiredProviderToken') {
			this.jwt = undefined;
			try {
				e = await prova(this.autorizzazione());
			} catch {
				// resta l'esito di prima
			}
		}
		if (!e.ok) this.log(`apns: ${p.tipo} ${p.ambiente} -> ${e.status}${e.reason ? ' ' + e.reason : ''}`);
		return e;
	}

	chiudi(): void {
		for (const o of [...this.sessioni.keys()]) this.chiudiSessione(o);
	}

	private autorizzazione(): string {
		const cfg = (this.o.config ?? leggiConfig)();
		if (!cfg) throw new Error('APNS_KEY_PATH, APNS_KEY_ID o APNS_TEAM_ID mancano in ~/.secrets/bottega.env');
		const now = this.ora();
		if (this.jwt && this.jwt.keyId === cfg.keyId && now - this.jwt.nato < JWT_VITA) return `bearer ${this.jwt.valore}`;
		if (this.key?.path !== cfg.keyPath) {
			let pem: string;
			try {
				pem = fs.readFileSync(cfg.keyPath, 'utf8');
			} catch {
				throw new Error('Non trovo la chiave APNs indicata da APNS_KEY_PATH');
			}
			try {
				this.key = { path: cfg.keyPath, obj: crypto.createPrivateKey(pem) };
			} catch {
				throw new Error('La chiave APNs non si legge (serve il file .p8)');
			}
		}
		this.jwt = { valore: firmaJwt(this.key.obj, cfg.keyId, cfg.teamId, Math.floor(now / 1000)), nato: now, keyId: cfg.keyId };
		return `bearer ${this.jwt.valore}`;
	}

	private sessione(origine: string): http2.ClientHttp2Session {
		const c = this.sessioni.get(origine);
		if (c && !c.s.closed && !c.s.destroyed) return c.s;
		const s = (this.o.connetti ?? (o => http2.connect(o)))(origine);
		const via = () => {
			if (this.sessioni.get(origine)?.s === s) {
				clearTimeout(this.sessioni.get(origine)!.timer);
				this.sessioni.delete(origine);
			}
		};
		s.on('error', via);
		s.on('close', via);
		s.on('goaway', via);
		this.sessioni.set(origine, { s });
		return s;
	}

	private chiudiSessione(origine: string): void {
		const c = this.sessioni.get(origine);
		if (!c) return;
		clearTimeout(c.timer);
		this.sessioni.delete(origine);
		c.s.close();
	}

	/** Dopo dieci minuti senza invii la sessione si chiude: le notifiche sono rade. */
	private arma(origine: string): void {
		const c = this.sessioni.get(origine);
		if (!c) return;
		clearTimeout(c.timer);
		c.timer = setTimeout(() => this.chiudiSessione(origine), INATTIVA);
		c.timer.unref?.();
	}

	private richiesta(origine: string, auth: string, p: Push): Promise<Esito> {
		return new Promise((resolve, reject) => {
			const s = this.sessione(origine);
			const corpo = Buffer.from(JSON.stringify(p.payload));
			const headers: http2.OutgoingHttpHeaders = {
				':method': 'POST',
				':path': `/3/device/${p.token}`,
				authorization: auth,
				'apns-topic': TOPIC[p.tipo],
				'apns-push-type': p.tipo,
				'apns-priority': String(p.priorita),
				'content-type': 'application/json',
				'content-length': corpo.length,
			};
			if (p.scadenza !== undefined) headers['apns-expiration'] = String(Math.floor(p.scadenza));
			const req = s.request(headers);
			req.setTimeout(ATTESA_RISPOSTA, () => req.close(http2.constants.NGHTTP2_CANCEL));
			let status = 0;
			let fatto = false;
			const parti: Buffer[] = [];
			const fine = () => {
				if (fatto) return;
				fatto = true;
				if (!status) return reject(new Error('connessione chiusa senza risposta'));
				this.arma(origine);
				let reason: string | undefined;
				try {
					const t = Buffer.concat(parti).toString('utf8');
					if (t) reason = JSON.parse(t).reason;
				} catch {
					// corpo non JSON: resta lo stato
				}
				resolve({ ok: status === 200, status, ...(reason ? { reason } : {}) });
			};
			req.on('response', h => (status = Number(h[':status']) || 0));
			req.on('data', (c: Buffer) => parti.push(c));
			req.on('end', fine);
			req.on('close', fine);
			req.on('error', err => {
				if (fatto) return;
				fatto = true;
				reject(err);
			});
			req.end(corpo);
		});
	}
}
