#!/usr/bin/env node
// Banco di prova del ponte verso l'iPhone (src/ponte.ts): gettone, rete Tailscale, domanda, voce, eventi,
// limiti. Ascolta su 127.0.0.1 con una porta a caso al posto dell'indirizzo Tailscale; niente Melissa vera.

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const assert = require('assert');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'test-out', 'ponte');
esbuild.buildSync({ entryPoints: ['ponte.ts', 'ponte-tls.ts', 'dispositivo.ts', 'cervelli.ts'].map(f => path.join(SRC, f)), outdir: OUT, format: 'cjs', platform: 'node', bundle: false, target: 'node20', logLevel: 'silent' });
const { Ponte, inTailnet, leggiGettone, rotteCervelli, sceltaDi, leggiSceltaCervello, nomeCervello, direttiInCasa, vicinoDi } = require(path.join(OUT, 'ponte.js'));
const { Cervelli } = require(path.join(OUT, 'cervelli.js'));
const { fondiDispositivo, leggiDispositivo } = require(path.join(OUT, 'dispositivo.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-ponte-'));
let passed = 0;
const ok = name => (passed++, console.log('  ok  ' + name));

function call(port, method, url, { token, body, raw } = {}) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
		const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) } }, res => {
			const parts = [];
			res.on('data', c => parts.push(c));
			res.on('end', () => {
				const buf = Buffer.concat(parts);
				resolve({ status: res.statusCode, type: res.headers['content-type'], body: raw ? buf : buf.length ? JSON.parse(buf.toString()) : null });
			});
		});
		req.on('error', reject);
		if (data) req.write(data);
		req.end();
	});
}

(async () => {
	// la rete
	assert.ok(inTailnet('100.101.102.103'));
	assert.ok(inTailnet('::ffff:100.64.0.9'));
	assert.ok(!inTailnet('100.63.255.1'), 'fuori dal blocco CGNAT');
	assert.ok(!inTailnet('192.168.1.20'));
	assert.ok(inTailnet('fd7a:115c:a1e0::1234'));
	ok('solo indirizzi Tailscale');

	// il gettone: creato una volta, privato, stabile
	const t1 = leggiGettone(dir);
	const t2 = leggiGettone(dir);
	assert.strictEqual(t1, t2);
	assert.ok(t1.length >= 40);
	assert.strictEqual(fs.statSync(path.join(dir, 'ponte.json')).mode & 0o777, 0o600);
	ok('gettone stabile in un file 600');

	let busy = false;
	let interrotte = 0;
	let confermaAperta;
	const asked = [];
	const written = [];
	let cavo = false;
	const port = 20000 + Math.floor(Math.random() * 20000);
	// i Cervelli veri, con rete finta e chiavi finte: DeepSeek ha credito, Apple Intelligence no
	const secrets = path.join(dir, 'secrets');
	fs.mkdirSync(secrets);
	fs.writeFileSync(path.join(secrets, 'agnes-ai.env'), 'AGNES_API_KEY=chiave-finta-agnes\n');
	fs.writeFileSync(path.join(secrets, 'deepseek-harness.env'), 'DEEPSEEK_API_KEY=chiave-finta-ds\n');
	for (const k of ['AGNES_API_KEY', 'DEEPSEEK_API_KEY']) delete process.env[k];
	const mem = new Map();
	const reteFinta = async url => (url.includes('user/balance') ? { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [] }) } : { ok: true, status: 200, body: null });
	const cv = new Cervelli({ memento: { get: k => mem.get(k), update: (k, v) => void mem.set(k, v) }, fetch: reteFinta, secretsDir: secrets, usageFile: path.join(dir, 'nessuno.json'), appleAvailable: () => false, appleReason: () => 'il Nucleo non è acceso' });
	const ponte = new Ponte({
		dir,
		versione: '9.9.9',
		porta: port,
		indirizzo: async () => ({ ip: '127.0.0.1', nome: 'mac-di-prova.tailnet.ts.net', diretti: ['100.70.0.9'] }),
		cavo: () => cavo,
		cervelli: rotteCervelli(() => cv),
		stato: () => ({ melissa: { stato: busy ? 'thinking' : 'idle', cervello: 'agnes', scelta: sceltaDi(cv), registro: asked.map(t => ({ chi: 'tu', testo: t, alle: 1 })) }, lavori: [], conti: { inCorso: 0, tiAspetta: 1, inCoda: 0, vive: 1 } }),
		occupata: () => busy,
		chiedi: async t => (asked.push(t), `Risposta a: ${t}`),
		confermaAttuale: () => confermaAperta,
		parla: async (t, emetti, segnale) => {
			emetti({ tipo: 'voce', ok: true });
			emetti({ tipo: 'frase', testo: 'Prima frase.' });
			emetti({ tipo: 'audio', pcm: Buffer.from('pcm1').toString('base64') });
			if (t === 'lunga') {
				await new Promise(r => segnale.addEventListener('abort', r, { once: true }));
				interrotte++;
				return '';
			}
			emetti({ tipo: 'frase', testo: 'Seconda.' });
			emetti({ tipo: 'audio', pcm: Buffer.from('pcm2').toString('base64') });
			return 'Prima frase. Seconda.';
		},
		voce: async t => Buffer.from('RIFF' + t),
		scriviLavoro: (id, t) => (id === 'j1' ? (written.push(t), true) : false),
		registraDispositivo: d => fondiDispositivo(dir, d),
		log: () => undefined,
	});
	await ponte.start();
	const info = ponte.info();
	assert.ok(info.attivo);
	assert.ok(info.collegamento.startsWith('bottega://collega?'));
	const q = new URL(info.collegamento).searchParams;
	assert.strictEqual(q.get('token'), t1);
	assert.strictEqual(q.get('host'), 'mac-di-prova.tailnet.ts.net');
	assert.strictEqual(q.get('porta'), String(port));
	ok('collegamento con host, porta e gettone');

	assert.strictEqual((await call(port, 'GET', '/v1/stato')).status, 401);
	assert.strictEqual((await call(port, 'GET', '/v1/stato', { token: t1 + 'x' })).status, 401);
	ok('senza gettone giusto: 401');

	const s = await call(port, 'GET', '/v1/stato', { token: t1 });
	assert.strictEqual(s.status, 200);
	assert.strictEqual(s.body.versione, '9.9.9');
	assert.strictEqual(s.body.conti.tiAspetta, 1);
	ok('stato');

	const a = await call(port, 'POST', '/v1/chiedi', { token: t1, body: { testo: '  che lavori ho?  ' } });
	assert.strictEqual(a.status, 200);
	assert.strictEqual(a.body.risposta, 'Risposta a: che lavori ho?');
	assert.strictEqual(a.body.stato.melissa.registro.length, 1);
	assert.strictEqual((await call(port, 'POST', '/v1/chiedi', { token: t1, body: { testo: '' } })).status, 400);
	busy = true;
	assert.strictEqual((await call(port, 'POST', '/v1/chiedi', { token: t1, body: { testo: 'ancora' } })).status, 409);
	busy = false;
	ok('domanda, testo vuoto, Melissa occupata');

	// il si' da una notifica CONFERMA vale solo per la sua domanda
	confermaAperta = 7;
	assert.strictEqual((await call(port, 'POST', '/v1/chiedi', { token: t1, body: { testo: 'sì', conferma: 6 } })).status, 409, 'notifica vecchia');
	assert.ok(!asked.includes('sì'));
	confermaAperta = undefined;
	assert.strictEqual((await call(port, 'POST', '/v1/chiedi', { token: t1, body: { testo: 'sì', conferma: 7 } })).status, 409, 'domanda gia\' chiusa');
	confermaAperta = 7;
	assert.strictEqual((await call(port, 'POST', '/v1/chiedi', { token: t1, body: { testo: 'sì', conferma: 7 } })).status, 200);
	assert.strictEqual(asked.at(-1), 'sì');
	assert.strictEqual((await call(port, 'POST', '/v1/chiedi', { token: t1, body: 'null' })).status, 400, 'corpo null');
	ok('conferma: il si\' vale solo per la domanda della sua notifica');

	const p = await call(port, 'POST', '/v1/parla', { token: t1, body: { testo: 'come va?' }, raw: true });
	assert.strictEqual(p.status, 200);
	assert.strictEqual(p.type, 'application/x-ndjson; charset=utf-8');
	const righeParla = p.body.toString().trim().split('\n').map(l => JSON.parse(l));
	assert.deepStrictEqual(righeParla.map(r => r.tipo), ['voce', 'frase', 'audio', 'frase', 'audio', 'fine']);
	assert.strictEqual(Buffer.from(righeParla[4].pcm, 'base64').toString(), 'pcm2');
	assert.strictEqual(righeParla[5].risposta, 'Prima frase. Seconda.');
	assert.ok(righeParla[5].stato.versione);
	busy = true;
	assert.strictEqual((await call(port, 'POST', '/v1/parla', { token: t1, body: { testo: 'x' } })).status, 409);
	busy = false;
	ok('domanda a voce: frasi e audio in ordine, poi la fine con lo stato');

	// l'iPhone chiude a meta' risposta: il ponte lo dice a Melissa
	await new Promise((resolve, reject) => {
		const data = Buffer.from(JSON.stringify({ testo: 'lunga' }));
		const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/parla', headers: { authorization: `Bearer ${t1}`, 'content-type': 'application/json', 'content-length': data.length } }, res => {
			res.once('data', () => req.destroy());
		});
		req.on('error', () => undefined);
		req.on('close', resolve);
		req.end(data);
	});
	for (let i = 0; i < 50 && !interrotte; i++) await new Promise(r => setTimeout(r, 10));
	assert.strictEqual(interrotte, 1);
	ok('interruzione dall\'iPhone');

	const v = await call(port, 'POST', '/v1/voce', { token: t1, body: { testo: 'ciao' }, raw: true });
	assert.strictEqual(v.status, 200);
	assert.strictEqual(v.type, 'audio/wav');
	assert.strictEqual(v.body.toString(), 'RIFFciao');
	ok('voce in WAV');

	assert.strictEqual((await call(port, 'POST', '/v1/lavoro', { token: t1, body: { id: 'j1', testo: 'vai avanti' } })).status, 200);
	assert.strictEqual((await call(port, 'POST', '/v1/lavoro', { token: t1, body: { id: 'nessuno', testo: 'x' } })).status, 404);
	assert.deepStrictEqual(written, ['vai avanti']);
	ok('scrive in un lavoro');

	assert.strictEqual((await call(port, 'POST', '/v1/chiedi', { token: t1, body: '{rotto' })).status, 400);
	assert.strictEqual((await call(port, 'POST', '/v1/chiedi', { token: t1, body: { testo: 'x'.repeat(20000) } })).status, 413);
	ok('JSON rotto e corpo troppo grande');

	// eventi: il primo stato subito, poi uno a ogni notify
	const righe = [];
	await new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, path: '/v1/eventi', headers: { authorization: `Bearer ${t1}` } }, res => {
			assert.strictEqual(res.headers['content-type'], 'text/event-stream; charset=utf-8');
			res.on('data', c => {
				for (const l of c.toString().split('\n')) if (l.startsWith('data: ')) righe.push(JSON.parse(l.slice(6)));
				if (righe.length === 1) ponte.notify();
				if (righe.length === 2) (req.destroy(), resolve());
			});
		});
		req.on('error', e => (righe.length >= 2 ? resolve() : reject(e)));
		req.end();
	});
	assert.strictEqual(righe[0].versione, '9.9.9');
	ok('eventi in diretta');

	// i token APNs dell'iPhone (9.4)
	const tokA = 'ab'.repeat(32);
	const tokB = 'cd'.repeat(80);
	let r = await call(port, 'POST', '/v1/dispositivo', { token: t1, body: { ambiente: 'sviluppo', token: tokA.toUpperCase(), avvio: tokB } });
	assert.deepStrictEqual([r.status, r.body], [200, { ok: true }]);
	r = await call(port, 'POST', '/v1/dispositivo', { token: t1, body: { ambiente: 'sviluppo', attivita: tokB, widget: tokA } });
	assert.strictEqual(r.status, 200);
	let dsp = leggiDispositivo(dir);
	assert.deepStrictEqual([dsp.ambiente, dsp.token, dsp.avvio, dsp.attivita, dsp.widget], ['sviluppo', tokA, tokB, tokB, tokA], 'i campi si fondono');
	assert.strictEqual(fs.statSync(path.join(dir, 'iphone.json')).mode & 0o777, 0o600);
	assert.strictEqual((await call(port, 'POST', '/v1/dispositivo', { token: t1, body: { ambiente: 'sviluppo', attivita: '' } })).status, 200);
	assert.strictEqual(leggiDispositivo(dir).attivita, undefined, "attivita '' la toglie");
	assert.strictEqual(leggiDispositivo(dir).token, tokA);
	r = await call(port, 'POST', '/v1/dispositivo', { token: t1, body: { ambiente: 'staging', token: tokA } });
	assert.strictEqual(r.status, 400);
	assert.ok(r.body.errore);
	assert.strictEqual((await call(port, 'POST', '/v1/dispositivo', { token: t1, body: { ambiente: 'produzione', token: 'non-esadecimale' } })).status, 400);
	assert.strictEqual((await call(port, 'POST', '/v1/dispositivo', { token: t1, body: { ambiente: 'produzione', widget: 42 } })).status, 400);
	assert.strictEqual((await call(port, 'POST', '/v1/dispositivo', { body: { ambiente: 'sviluppo', token: tokA } })).status, 401);
	assert.strictEqual(leggiDispositivo(dir).ambiente, 'sviluppo', 'le richieste rifiutate non toccano il registro');
	ok('dispositivo: token esadecimali, campi fusi, attivita vuota tolta, errori');

	// il cervello di Melissa (9.8): letto e cambiato con gli stessi metodi della barra
	assert.deepStrictEqual(s.body.melissa.scelta, { provider: 'agnes', nome: 'Agnes', impegno: 'normale', predefinito: 'agnes', perOra: false });
	let cb = await call(port, 'GET', '/v1/cervelli', { token: t1 });
	assert.strictEqual(cb.status, 200);
	assert.deepStrictEqual(cb.body.opzioni.map(o => [o.provider, o.nome, o.nota, o.disponibile]), [['agnes', 'Agnes', 'gratis', true], ['apple', 'Apple Intelligence', 'gratis, sul Mac', false], ['deepseek', 'DeepSeek', 'a consumo, a fondo V4 Pro', true]]);
	assert.strictEqual(cb.body.opzioni[1].perche, 'il Nucleo non è acceso');
	cb = await call(port, 'POST', '/v1/cervello', { token: t1, body: { provider: 'deepseek', impegno: 'profondo' } });
	assert.strictEqual(cb.status, 200);
	assert.deepStrictEqual([cb.body.provider, cb.body.nome, cb.body.impegno, cb.body.perOra, cb.body.predefinito], ['deepseek', 'DeepSeek V4 Pro', 'profondo', true, 'agnes']);
	assert.strictEqual(cv.choice().provider, 'deepseek', 'la barra del Mac vede lo stesso cervello');
	assert.strictEqual((await call(port, 'GET', '/v1/stato', { token: t1 })).body.melissa.scelta.nome, 'DeepSeek V4 Pro');
	cb = await call(port, 'POST', '/v1/cervello', { token: t1, body: { provider: 'deepseek', impegno: 'normale', sempre: true } });
	assert.deepStrictEqual([cb.body.nome, cb.body.perOra, cb.body.predefinito], ['DeepSeek', false, 'deepseek']);
	assert.strictEqual(mem.get('bottega.cervello.predefinito'), 'deepseek', 'sempre: si ricorda');
	cv.endConversation();
	assert.strictEqual(cv.choice().provider, 'deepseek');
	cb = await call(port, 'POST', '/v1/cervello', { token: t1, body: { provider: 'apple' } });
	assert.strictEqual(cb.status, 409);
	assert.ok(/non è disponibile: il Nucleo non è acceso/.test(cb.body.errore), cb.body.errore);
	for (const corpo of [{ provider: 'claude' }, { impegno: 'massimo' }, {}, { provider: 'agnes', sempre: 'si' }, [1]]) {
		const r = await call(port, 'POST', '/v1/cervello', { token: t1, body: corpo });
		assert.strictEqual(r.status, 400, JSON.stringify(corpo));
		assert.ok(r.body.errore);
	}
	assert.strictEqual((await call(port, 'GET', '/v1/cervello', { token: t1 })).status, 405);
	assert.strictEqual((await call(port, 'POST', '/v1/cervelli', { token: t1, body: {} })).status, 405);
	assert.strictEqual((await call(port, 'POST', '/v1/cervello', { body: { provider: 'agnes' } })).status, 401);
	cb = await call(port, 'POST', '/v1/cervello', { token: t1, body: { provider: 'agnes', sempre: true } });
	assert.deepStrictEqual([cb.body.provider, cb.body.predefinito, cb.body.perOra], ['agnes', 'agnes', false]);
	assert.strictEqual(nomeCervello('deepseek', 'rapido'), 'DeepSeek');
	assert.strictEqual(typeof leggiSceltaCervello(null), 'string');
	assert.ok(![JSON.stringify(cb.body)].some(t => /[—–]/.test(t)));
	ok('cervello: GET /v1/cervelli, POST /v1/cervello con elenco chiuso, sempre, 409 se non disponibile');

	// un cambio arriva agli eventi
	const ev = [];
	await new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, path: '/v1/eventi', headers: { authorization: `Bearer ${t1}` } }, res => {
			res.on('data', c => {
				for (const l of c.toString().split('\n')) if (l.startsWith('data: ')) ev.push(JSON.parse(l.slice(6)));
				if (ev.length === 1) void call(port, 'POST', '/v1/cervello', { token: t1, body: { impegno: 'rapido' } });
				if (ev.length === 2) (req.destroy(), resolve());
			});
		});
		req.on('error', e => (ev.length >= 2 ? resolve() : reject(e)));
		req.end();
	});
	assert.deepStrictEqual([ev[0].melissa.scelta.impegno, ev[1].melissa.scelta.impegno], ['normale', 'rapido']);
	ok('il cambio di cervello arriva agli eventi');

	// vicino (9.9): dalle richieste in locale l'iPhone non si conosce ancora, quindi basta un iPhone in casa
	assert.strictEqual((await call(port, 'GET', '/v1/stato', { token: t1 })).body.vicino, 'casa');
	cavo = true;
	assert.strictEqual((await call(port, 'GET', '/v1/stato', { token: t1 })).body.vicino, 'usb');
	cavo = false;
	ok('vicino nello stato: casa da Tailscale, usb col cavo');

	// https (9.1): le stesse rotte sulla porta accanto, col certificato del Mac; l'impronta e' quella dello stato
	{
		const https = require('https');
		const st = (await call(port, 'GET', '/v1/stato', { token: t1 })).body;
		assert.strictEqual(st.https.porta, port + 1);
		assert.match(st.https.impronta, /^[0-9a-f]{64}$/);
		const sicura = token => new Promise((resolve, reject) => {
			const req = https.request({ host: '127.0.0.1', port: port + 1, path: '/v1/stato', method: 'GET', rejectUnauthorized: false, headers: token ? { authorization: `Bearer ${token}` } : {} }, res => {
				const cert = res.socket.getPeerCertificate();
				let d = '';
				res.on('data', c => (d += c));
				res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null, impronta: cert.fingerprint256.replace(/:/g, '').toLowerCase(), san: cert.subjectaltname }));
			});
			req.on('error', reject);
			req.end();
		});
		const r = await sicura(t1);
		assert.strictEqual(r.status, 200);
		assert.strictEqual(r.body.versione, '9.9.9');
		assert.strictEqual(r.impronta, st.https.impronta, 'l\'impronta dello stato e\' quella del certificato servito');
		assert.ok(r.san.includes('DNS:mac-di-prova.tailnet.ts.net') && r.san.includes('IP Address:127.0.0.1'));
		assert.strictEqual((await sicura()).status, 401, 'anche in https serve il gettone');
		const k = path.join(dir, 'ponte-tls', 'chiave.pem');
		assert.strictEqual(fs.statSync(k).mode & 0o777, 0o600);
		// riacceso: stesso certificato, stessa impronta (l'iPhone non deve reimpararla)
		const { certificatoPonte } = require(path.join(OUT, 'ponte-tls.js'));
		assert.strictEqual(certificatoPonte(dir, 'mac-di-prova.tailnet.ts.net', '127.0.0.1').impronta, st.https.impronta);
		assert.notStrictEqual(certificatoPonte(dir, 'altro-nome.tailnet.ts.net', '127.0.0.1').impronta, st.https.impronta, 'nome cambiato: certificato nuovo');
		// una chiave che il TLS non carica (build 71: quella di openssl -newkey in Electron) si rifa'
		assert.match(fs.readFileSync(k, 'utf8'), /^-----BEGIN PRIVATE KEY-----/, 'PKCS#8, fatta da Node');
		fs.writeFileSync(k, '-----BEGIN PRIVATE KEY-----\nnonvale\n-----END PRIVATE KEY-----\n');
		const rifatto = certificatoPonte(dir, 'altro-nome.tailnet.ts.net', '127.0.0.1');
		assert.ok(rifatto.key.toString().includes('BEGIN PRIVATE KEY') && !rifatto.key.toString().includes('nonvale'), 'chiave illeggibile: rifatta');
	}
	ok('https sulla porta accanto: stesse rotte, gettone, impronta nello stato, certificato riusato');

	const statoTs = {
		Peer: {
			a: { OS: 'iOS', Online: true, CurAddr: '192.168.0.106:41641', TailscaleIPs: ['100.124.213.1', 'fd7a:115c:a1e0::1'] },
			b: { OS: 'iOS', Online: true, CurAddr: '', Relay: 'mad', TailscaleIPs: ['100.90.0.2'] },
			c: { OS: 'iOS', Online: true, CurAddr: '85.48.1.2:41641', TailscaleIPs: ['100.90.0.3'] },
			d: { OS: 'macOS', Online: true, CurAddr: '192.168.0.20:41641', TailscaleIPs: ['100.90.0.4'] },
			e: { OS: 'iOS', Online: false, CurAddr: '10.0.0.5:41641', TailscaleIPs: ['100.90.0.5'] },
			f: { OS: 'iOS', Online: true, CurAddr: '172.20.1.1:41641', TailscaleIPs: ['100.90.0.6'] },
		},
	};
	assert.deepStrictEqual(direttiInCasa(statoTs), ['100.124.213.1', 'fd7a:115c:a1e0::1', '100.90.0.6']);
	assert.deepStrictEqual(direttiInCasa({}), []);
	ok('in casa solo gli iPhone in linea raggiunti diretti su un indirizzo privato');
	assert.strictEqual(vicinoDi(true, [], undefined), 'usb');
	assert.strictEqual(vicinoDi(true, ['100.1.1.1'], '100.1.1.1'), 'usb');
	assert.strictEqual(vicinoDi(false, ['100.1.1.1'], '100.1.1.1'), 'casa');
	assert.strictEqual(vicinoDi(false, ['100.1.1.1'], '100.2.2.2'), 'lontano');
	assert.strictEqual(vicinoDi(false, ['100.1.1.1'], undefined), 'casa');
	assert.strictEqual(vicinoDi(false, undefined, '100.1.1.1'), 'lontano');
	ok('vicinoDi: il cavo vince, poi la casa dell\'iPhone che ha parlato');

	// troppi gettoni sbagliati: fuori
	for (let i = 0; i < 20; i++) await call(port, 'GET', '/v1/stato', { token: 'sbagliato' });
	assert.strictEqual((await call(port, 'GET', '/v1/stato', { token: 'sbagliato' })).status, 429);
	assert.strictEqual((await call(port, 'GET', '/v1/stato', { token: t1 })).status, 200, 'il gettone giusto passa anche da un indirizzo bloccato');
	ok('dopo 20 gettoni sbagliati quell\'indirizzo resta fuori, ma il gettone giusto passa');

	ponte.stop();
	assert.ok(!ponte.info().attivo);
	ok('si spegne');
	fs.rmSync(dir, { recursive: true, force: true });
	console.log(`ponte: ${passed} prove passate`);
})().catch(e => {
	console.error(e);
	process.exit(1);
});
