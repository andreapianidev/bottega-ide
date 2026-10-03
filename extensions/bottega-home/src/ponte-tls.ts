/* Il certificato del ponte (docs/CONTRATTI.md, 9.1): solo perche' l'iPhone parli in https.
   La strada e' gia' cifrata da Tailscale. L'https serve a iOS: col nome MagicDNS in http passava prima dal relay
   privato di iCloud (502) e solo dopo dal tunnel, da 0,7 a 5,7 s in piu' a richiesta, e i widget scadevano (log del
   3 ottobre 2026). Il traffico cifrato il relay non lo tocca.
   Il certificato lo fa il Mac da se' (openssl), una volta, in ~/.bottega/ponte-tls/. Nessuna autorita' lo firma:
   l'iPhone lo riconosce dall'impronta SHA-256, che legge in /v1/stato. Se si perde se ne fa un altro e l'iPhone
   impara la nuova impronta da solo: non e' una chiave da custodire. */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

export interface CertificatoPonte {
	key: Buffer;
	cert: Buffer;
	/** SHA-256 del certificato (DER), esadecimale minuscolo senza due punti: quella che controlla l'iPhone. */
	impronta: string;
}

/** Validita' del certificato: sotto gli 825 giorni che iOS accetta. Si rifa' quando ne mancano meno di 30. */
const GIORNI = 800;
const RINNOVO_MS = 30 * 24 * 3600_000;
const OPENSSL = ['/usr/bin/openssl', '/opt/homebrew/bin/openssl', '/usr/local/bin/openssl'];

export function improntaDi(pem: string | Buffer): string {
	return new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
}

/** Il certificato per `nome` e `ip`: quello sul disco se vale ancora per loro, altrimenti uno nuovo. */
export function certificatoPonte(dir: string, nome: string, ip: string, ora = Date.now()): CertificatoPonte {
	const cartella = path.join(dir, 'ponte-tls');
	const fk = path.join(cartella, 'chiave.pem');
	const fc = path.join(cartella, 'certificato.pem');
	try {
		const key = fs.readFileSync(fk);
		const cert = fs.readFileSync(fc);
		const x = new crypto.X509Certificate(cert);
		const san = x.subjectAltName ?? '';
		const ancora = Date.parse(x.validTo) - ora > RINNOVO_MS;
		if (ancora && san.includes(`DNS:${nome}`) && (!ip || san.includes(`IP Address:${ip}`)) && x.checkPrivateKey(crypto.createPrivateKey(key))) {
			return { key, cert, impronta: improntaDi(cert) };
		}
	} catch {
		// manca o non si legge: se ne fa uno nuovo
	}
	fs.mkdirSync(cartella, { recursive: true, mode: 0o700 });
	const openssl = OPENSSL.find(p => fs.existsSync(p)) ?? 'openssl';
	const san = [`DNS:${nome}`, ...(ip ? [`IP:${ip}`] : [])].join(',');
	const tmpK = fk + '.nuova';
	const tmpC = fc + '.nuovo';
	// P-256 e SHA-256: quello che chiede App Transport Security; serverAuth e il nome nel SAN, come vuole iOS
	execFileSync(openssl, [
		'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-sha256',
		'-days', String(GIORNI), '-subj', '/CN=Bottega ponte', '-keyout', tmpK, '-out', tmpC,
		'-addext', `subjectAltName=${san}`, '-addext', 'extendedKeyUsage=serverAuth', '-addext', 'keyUsage=digitalSignature',
		'-addext', 'basicConstraints=critical,CA:FALSE',
	], { stdio: 'ignore', timeout: 15_000 });
	fs.chmodSync(tmpK, 0o600);
	fs.chmodSync(tmpC, 0o600);
	fs.renameSync(tmpK, fk);
	fs.renameSync(tmpC, fc);
	const key = fs.readFileSync(fk);
	const cert = fs.readFileSync(fc);
	return { key, cert, impronta: improntaDi(cert) };
}
