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
esbuild.buildSync({ entryPoints: [path.join(SRC, 'ponte.ts')], outdir: OUT, format: 'cjs', platform: 'node', bundle: false, target: 'node20', logLevel: 'silent' });
const { Ponte, inTailnet, leggiGettone } = require(path.join(OUT, 'ponte.js'));

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
	const asked = [];
	const written = [];
	const port = 20000 + Math.floor(Math.random() * 20000);
	const ponte = new Ponte({
		dir,
		versione: '9.9.9',
		porta: port,
		indirizzo: async () => ({ ip: '127.0.0.1', nome: 'mac-di-prova.tailnet.ts.net' }),
		stato: () => ({ melissa: { stato: busy ? 'thinking' : 'idle', cervello: 'agnes', registro: asked.map(t => ({ chi: 'tu', testo: t, alle: 1 })) }, lavori: [], conti: { inCorso: 0, tiAspetta: 1, inCoda: 0, vive: 1 } }),
		occupata: () => busy,
		chiedi: async t => (asked.push(t), `Risposta a: ${t}`),
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

	// troppi gettoni sbagliati: fuori
	for (let i = 0; i < 20; i++) await call(port, 'GET', '/v1/stato', { token: 'sbagliato' });
	assert.strictEqual((await call(port, 'GET', '/v1/stato', { token: t1 })).status, 429);
	ok('dopo 20 gettoni sbagliati l\'indirizzo resta fuori');

	ponte.stop();
	assert.ok(!ponte.info().attivo);
	ok('si spegne');
	fs.rmSync(dir, { recursive: true, force: true });
	console.log(`ponte: ${passed} prove passate`);
})().catch(e => {
	console.error(e);
	process.exit(1);
});
