import * as fs from 'fs';
import * as path from 'path';

/* Il registro dell'iPhone (docs/CONTRATTI.md, 9.4): i token APNs che l'app manda con POST /v1/dispositivo.
   Un solo iPhone per ora: i campi si fondono. File ~/.bottega/iphone.json, permessi 600.

     token     notifiche (didRegisterForRemoteNotifications)
     avvio     push-to-start della Live Activity
     attivita  la Live Activity aperta adesso ('' quando finisce: si toglie)
     widget    WidgetPushHandler */

export type Ambiente = 'sviluppo' | 'produzione';
export type CampoToken = 'token' | 'avvio' | 'attivita' | 'widget';
export const CAMPI_TOKEN: CampoToken[] = ['token', 'avvio', 'attivita', 'widget'];

export interface Dispositivo {
	ambiente: Ambiente;
	token?: string;
	avvio?: string;
	attivita?: string;
	widget?: string;
	aggiornato: number;
}

export type DispositivoParziale = { ambiente: Ambiente } & Partial<Record<CampoToken, string>>;

/** Token APNs in esadecimale (quelli delle Live Activity sono piu' lunghi di quelli delle notifiche). */
export const TOKEN_HEX = /^[0-9a-f]{32,512}$/i;

const FILE = 'iphone.json';

export function leggiDispositivo(dir: string): Dispositivo | null {
	try {
		const d = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
		if (d?.ambiente !== 'sviluppo' && d?.ambiente !== 'produzione') return null;
		const out: Dispositivo = { ambiente: d.ambiente, aggiornato: Number(d.aggiornato) || 0 };
		for (const c of CAMPI_TOKEN) if (typeof d[c] === 'string' && TOKEN_HEX.test(d[c])) out[c] = d[c].toLowerCase();
		return out;
	} catch {
		return null;
	}
}

function scrivi(dir: string, d: Dispositivo): void {
	const file = path.join(dir, FILE);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n', { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, file);
}

/** Fonde i campi arrivati con quelli gia' noti: un campo vuoto ('') si toglie, uno assente resta com'era. */
export function fondiDispositivo(dir: string, p: DispositivoParziale, ora = Date.now()): Dispositivo {
	const prima = leggiDispositivo(dir);
	// cambiato ambiente (Debug, TestFlight, Store): i token di prima valgono sull'altro server, si buttano
	const base = prima && prima.ambiente === p.ambiente ? prima : {};
	const d: Dispositivo = { ...base, ambiente: p.ambiente, aggiornato: ora };
	for (const c of CAMPI_TOKEN) {
		const v = p[c];
		if (v === undefined) continue;
		if (v === '') delete d[c];
		else d[c] = v.toLowerCase();
	}
	scrivi(dir, d);
	return d;
}

/** Toglie un token che APNs dice morto, solo se e' ancora quello (nel frattempo l'iPhone puo' averne mandato uno nuovo). */
export function togliToken(dir: string, campo: CampoToken, token: string): boolean {
	const d = leggiDispositivo(dir);
	if (!d || d[campo] !== token.toLowerCase()) return false;
	delete d[campo];
	scrivi(dir, d);
	return true;
}
