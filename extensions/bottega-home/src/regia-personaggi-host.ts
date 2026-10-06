// Il ponte locale verso la mod melissa di Claude Code (docs/CONTRATTI.md, 9.11, «Sul Mac la regia sta in un posto solo»):
// un servizio HTTP su un socket Unix, ~/.bottega/regia.sock (600, solo l'utente del Mac), con una rotta sola:
//
//   POST /v1/regia {azione, sessione, ...}  -> JSON   (src/regia-personaggi.ts)
//
// Socket e non porta: la mod parla gia' cosi' con il Nucleo (isola.sock), non serve un gettone e funziona anche a
// Tailscale spento, quando il ponte verso l'iPhone e' chiuso. Bottega chiusa: niente socket, e la mod fa parlare solo
// Melissa.

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { RegiaPersonaggi } from './regia-personaggi';

/** Il socket della regia: lo stesso percorso che legge la mod. */
export function socketRegia(): string {
	return path.join(process.env.BOTTEGA_HOME || path.join(os.homedir(), '.bottega'), 'regia.sock');
}

/** Apre il servizio; `chiudi` lo spegne e toglie il socket. Un errore all'apertura si dice e basta: la Bottega va avanti. */
export function avviaRegiaPersonaggi(regia: RegiaPersonaggi, log: (riga: string) => void, sock = socketRegia()): { chiudi(): void } {
	const server = http.createServer((req, res) => {
		const json = (code: number, body: unknown) => {
			res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
			res.end(JSON.stringify(body));
		};
		if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/v1/regia') return json(404, { errore: 'Solo POST /v1/regia.' });
		let corpo = '';
		let troppo = false;
		req.setEncoding('utf8');
		req.on('data', (c: string) => {
			corpo += c;
			if (corpo.length > 64_000) {
				troppo = true;
				req.destroy();
			}
		});
		req.on('end', () => {
			if (troppo) return;
			let x: unknown;
			try {
				x = JSON.parse(corpo || '{}');
			} catch {
				return json(400, { errore: 'JSON non valido.' });
			}
			regia.gestisci(x).then(r => json(200, r), (e: any) => json(400, { errore: String(e?.message ?? e) }));
		});
	});
	try {
		fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
		// un socket rimasto da una Bottega chiusa male non e' di nessuno: si toglie
		fs.rmSync(sock, { force: true });
	} catch {
		// la cartella c'e' gia', o il file non c'era
	}
	server.on('error', (e: any) => log(`regia per la mod: il socket non si apre (${e?.code ?? e?.message ?? e})`));
	server.listen(sock, () => {
		try {
			fs.chmodSync(sock, 0o600);
		} catch {
			// resta quello del sistema: la cartella e' gia' 700
		}
		log(`regia per la mod: in ascolto su ${sock}`);
	});
	return {
		chiudi: () => {
			server.close();
			try {
				fs.rmSync(sock, { force: true });
			} catch {
				// gia' tolto
			}
		},
	};
}
