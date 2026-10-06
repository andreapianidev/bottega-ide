#!/usr/bin/env node
// Banco di prova degli avvisi verso l'iPhone (src/avvisi.ts, src/apns.ts, src/dispositivo.ts): quando partono
// notifiche, Live Activity e widget, con un orologio finto e un invio finto. Il client APNs parla con un server
// HTTP/2 locale e firma con una chiave generata qui: nessuna rete vera, mai la chiave vera.

const path = require('path');
const fs = require('fs');
const os = require('os');
const http2 = require('http2');
const crypto = require('crypto');
const assert = require('assert');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'test-out', 'avvisi');
esbuild.buildSync({
	entryPoints: ['avvisi.ts', 'apns.ts', 'dispositivo.ts'].map(f => path.join(SRC, f)),
	outdir: OUT, format: 'cjs', platform: 'node', bundle: false, target: 'node20', logLevel: 'silent',
});
const { Avvisi, pulisci } = require(path.join(OUT, 'avvisi.js'));
const { Apns, firmaJwt, leggiConfig, leggiEnv, espandi, tokenMorto } = require(path.join(OUT, 'apns.js'));
const { fondiDispositivo, leggiDispositivo, togliToken } = require(path.join(OUT, 'dispositivo.js'));

let passed = 0;
const ok = name => (passed++, console.log('  ok  ' + name));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-avvisi-'));
const MIN = 60_000;
const hex = n => crypto.randomBytes(n).toString('hex');
const lineette = /[\u2013\u2014]/;

function lavoro(key, status, extra = {}) {
	return { key, source: key.startsWith('job:') ? 'bottega' : 'altrove', status, project: 'Bottega', path: '/p/bottega', title: 'Sistema la plancia', since: 1000, ...(key.startsWith('job:') ? { jobId: key.slice(4) } : {}), ...extra };
}
function conti(lavori) {
	const c = { inCorso: 0, tiAspetta: 0, vive: 0 };
	for (const w of lavori) {
		if (w.status === 'in corso') c.inCorso++;
		if (w.status === 'ti aspetta') c.tiAspetta++;
		if (['in corso', 'ti aspetta', 'nel terminale'].includes(w.status)) c.vive++;
	}
	return c;
}

/** Un banco: orologio, istantanea, invii registrati, registro vero su disco in una cartella di prova. */
function banco(opz = {}) {
	const b = {
		ora: 1_000_000,
		lavori: [],
		conferma: undefined,
		regole: null,
		segui: undefined,
		modo: 'lontano',
		inattivo: 5 * MIN,
		letture: 0,
		inviati: [],
		risposta: () => ({ ok: true, status: 200 }),
		dir: fs.mkdtempSync(path.join(dir, 'b-')),
	};
	b.av = new Avvisi({
		istantanea: () => ({ lavori: b.lavori, attivita: b.attivita, conti: conti(b.lavori), conferma: b.conferma, regole: b.regole, ...(b.negozio !== undefined ? { negozio: b.negozio } : {}), ...(b.segui ? { segui: b.segui } : {}) }),
		invio: { manda: async p => (b.inviati.push(p), b.risposta(p)) },
		dispositivo: () => leggiDispositivo(b.dir),
		togliToken: (campo, token) => togliToken(b.dir, campo, token),
		modo: () => b.modo,
		inattivoMs: async () => (b.letture++, b.inattivo),
		mac: 'mac-di-prova',
		ora: () => b.ora,
		...opz,
	});
	b.giro = async (avanti = 0) => {
		b.ora += avanti;
		await b.av.aggiorna();
	};
	b.presi = tipo => {
		const out = b.inviati.filter(p => p.tipo === tipo);
		b.inviati = b.inviati.filter(p => p.tipo !== tipo);
		return out;
	};
	return b;
}

(async () => {
	// ---------- il registro ----------
	const rd = path.join(dir, 'reg');
	const t1 = hex(32);
	fondiDispositivo(rd, { ambiente: 'sviluppo', token: t1.toUpperCase() });
	fondiDispositivo(rd, { ambiente: 'sviluppo', avvio: hex(80), widget: hex(40) });
	let d = leggiDispositivo(rd);
	assert.strictEqual(d.token, t1, 'i campi si fondono, in minuscolo');
	assert.ok(d.avvio && d.widget);
	assert.strictEqual(fs.statSync(path.join(rd, 'iphone.json')).mode & 0o777, 0o600);
	fondiDispositivo(rd, { ambiente: 'sviluppo', attivita: hex(80) });
	assert.ok(leggiDispositivo(rd).attivita);
	fondiDispositivo(rd, { ambiente: 'sviluppo', attivita: '' });
	assert.strictEqual(leggiDispositivo(rd).attivita, undefined, "attivita '' la toglie");
	assert.ok(!togliToken(rd, 'token', hex(32)), 'un token diverso non si tocca');
	assert.ok(togliToken(rd, 'token', t1));
	assert.strictEqual(leggiDispositivo(rd).token, undefined);
	ok('registro: si fonde, file 600, attivita vuota e token morto tolti');

	// ---------- JWT e configurazione ----------
	const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const jwt = firmaJwt(privateKey, 'KEYID12345', 'TEAMID1234', 1_700_000_000);
	const [h, c, s] = jwt.split('.');
	assert.deepStrictEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEYID12345' });
	assert.deepStrictEqual(JSON.parse(Buffer.from(c, 'base64url')), { iss: 'TEAMID1234', iat: 1_700_000_000 });
	assert.strictEqual(Buffer.from(s, 'base64url').length, 64, 'firma r||s di 64 byte');
	assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
	ok('JWT ES256 valido');

	assert.deepStrictEqual(leggiEnv('# commento\nexport A=1\nB="due due"\nC=tre # nota\n'), { A: '1', B: 'due due', C: 'tre' });
	assert.strictEqual(espandi('$HOME/.secrets/k.p8', '/Users/x'), '/Users/x/.secrets/k.p8');
	assert.strictEqual(espandi('~/k.p8', '/Users/x'), '/Users/x/k.p8');
	assert.strictEqual(espandi('${HOME}/k.p8', '/Users/x'), '/Users/x/k.p8');
	const envFile = path.join(dir, 'prova.env');
	fs.writeFileSync(envFile, 'APNS_KEY_PATH=$HOME/chiave.p8\nAPNS_KEY_ID=DAFILE\nAPNS_TEAM_ID=TEAM\n');
	const cfg = leggiConfig({ APNS_KEY_ID: 'DAENV' }, envFile);
	assert.strictEqual(cfg.keyPath, path.join(os.homedir(), 'chiave.p8'));
	assert.strictEqual(cfg.keyId, 'DAENV', "l'ambiente vince sul file");
	assert.strictEqual(leggiConfig({}, path.join(dir, 'non-esiste.env')), null);
	ok('configurazione: $HOME e ~ espansi, variabili d\'ambiente prima del file');

	// ---------- il client contro un server HTTP/2 locale ----------
	const keyFile = path.join(dir, 'prova.p8');
	fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
	const richieste = [];
	const server = http2.createServer();
	let sessioni = 0;
	server.on('session', () => sessioni++);
	server.on('stream', (stream, headers) => {
		const parti = [];
		stream.on('data', p => parti.push(p));
		stream.on('end', () => {
			richieste.push({ headers, corpo: JSON.parse(Buffer.concat(parti).toString()) });
			const morto = headers[':path'].endsWith('/morto');
			stream.respond({ ':status': morto ? 400 : 200, ...(morto ? { 'content-type': 'application/json' } : { 'apns-id': 'x' }) });
			stream.end(morto ? JSON.stringify({ reason: 'BadDeviceToken' }) : undefined);
		});
	});
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	const porta = server.address().port;
	let oraApns = 2_000_000_000_000;
	const righeLog = [];
	const apns = new Apns({
		config: () => ({ keyPath: keyFile, keyId: 'KEYID12345', teamId: 'TEAMID1234' }),
		ora: () => oraApns,
		origine: () => `http://127.0.0.1:${porta}`,
		log: l => righeLog.push(l),
	});
	const tok = hex(32);
	let e = await apns.manda({ tipo: 'liveactivity', token: tok, ambiente: 'sviluppo', priorita: 5, scadenza: 123, payload: { aps: { event: 'update' } } });
	assert.deepStrictEqual(e, { ok: true, status: 200 });
	const r0 = richieste[0];
	assert.strictEqual(r0.headers[':path'], `/3/device/${tok}`);
	assert.strictEqual(r0.headers['apns-topic'], 'com.andreapiani.bottega.ios.push-type.liveactivity');
	assert.strictEqual(r0.headers['apns-push-type'], 'liveactivity');
	assert.strictEqual(r0.headers['apns-priority'], '5');
	assert.strictEqual(r0.headers['apns-expiration'], '123');
	assert.deepStrictEqual(r0.corpo, { aps: { event: 'update' } });
	const bearer = r0.headers.authorization.replace(/^bearer /, '');
	const [bh, bc, bs] = bearer.split('.');
	assert.ok(crypto.verify('sha256', Buffer.from(`${bh}.${bc}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(bs, 'base64url')));
	assert.strictEqual(JSON.parse(Buffer.from(bc, 'base64url')).iat, Math.floor(oraApns / 1000));
	e = await apns.manda({ tipo: 'alert', token: 'morto', ambiente: 'sviluppo', priorita: 10, payload: { aps: {} } });
	assert.deepStrictEqual(e, { ok: false, status: 400, reason: 'BadDeviceToken' });
	assert.ok(tokenMorto(e) && tokenMorto({ ok: false, status: 410 }) && tokenMorto({ ok: false, status: 400, reason: 'Unregistered' }));
	assert.ok(!tokenMorto({ ok: false, status: 403, reason: 'InvalidProviderToken' }));
	assert.strictEqual(richieste[1].headers['apns-topic'], 'com.andreapiani.bottega.ios');
	assert.strictEqual(richieste[1].headers['apns-expiration'], '0', 'senza scadenza: un tentativo solo');
	assert.strictEqual(richieste[1].headers.authorization, r0.headers.authorization, 'stesso JWT entro 50 minuti');
	oraApns += 51 * MIN;
	await apns.manda({ tipo: 'widgets', token: tok, ambiente: 'produzione', priorita: 5, payload: { aps: { 'content-changed': true } } });
	assert.notStrictEqual(richieste[2].headers.authorization, r0.headers.authorization, 'JWT rifatto dopo 50 minuti');
	assert.strictEqual(richieste[2].headers['apns-topic'], 'com.andreapiani.bottega.ios.push-type.widgets');
	assert.ok(!righeLog.join('\n').includes(bs) && !righeLog.join('\n').includes('PRIVATE KEY'), 'mai il JWT o la chiave nel registro');
	assert.strictEqual(sessioni, 1, 'una sola connessione HTTP/2 per host, riusata');
	apns.chiudi();
	server.close();
	const senzaChiave = new Apns({ config: () => null });
	e = await senzaChiave.manda({ tipo: 'alert', token: tok, ambiente: 'sviluppo', priorita: 10, payload: {} });
	assert.strictEqual(e.ok, false);
	assert.strictEqual(e.status, 0);
	ok('client APNs: header, topic, una sessione, JWT riusato e rifatto, errori di Apple');

	// ---------- ATTESA ----------
	{
		const b = banco();
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', token: hex(32) });
		b.lavori = [lavoro('job:j1', 'ti aspetta'), lavoro('sess:s1', 'in corso')];
		await b.giro();
		assert.strictEqual(b.presi('alert').length, 0, 'quello che c\'e\' all\'avvio non suona');
		await b.giro(61_000);
		assert.strictEqual(b.presi('alert').length, 0);

		b.lavori = [lavoro('job:j1', 'ti aspetta'), lavoro('sess:s1', 'ti aspetta', { title: 'Rifai i test \u2014 subito', project: 'Woofmap' })];
		await b.giro(1000);
		let a = b.presi('alert');
		assert.strictEqual(a.length, 1);
		assert.strictEqual(a[0].priorita, 10);
		assert.deepStrictEqual(a[0].payload, {
			aps: { alert: { title: 'Woofmap', body: 'Ti aspetta: Rifai i test, subito' }, sound: 'default', category: 'ATTESA', 'thread-id': 'Woofmap', 'interruption-level': 'time-sensitive' },
			chiave: 'sess:s1',
		});
		await b.giro(1000);
		assert.strictEqual(b.presi('alert').length, 0, 'una volta per passaggio');

		// torna al lavoro e aspetta di nuovo dopo un minuto: niente, sono passati meno di 10 minuti
		b.lavori = [lavoro('job:j1', 'ti aspetta'), lavoro('sess:s1', 'in corso')];
		await b.giro(30_000);
		b.lavori = [lavoro('job:j1', 'ti aspetta'), lavoro('sess:s1', 'ti aspetta')];
		await b.giro(30_000);
		assert.strictEqual(b.presi('alert').length, 0, 'non piu\' di una ogni 10 minuti');
		await b.giro(9 * MIN);
		a = b.presi('alert');
		assert.strictEqual(a.length, 1, 'dopo 10 minuti, se aspetta ancora, arriva');
		assert.strictEqual(a[0].payload.chiave, 'sess:s1');

		// un lavoro della Bottega: c'e' il jobId per «Rispondi»
		b.lavori = [lavoro('job:j2', 'in corso')];
		await b.giro(1000);
		b.lavori = [lavoro('job:j2', 'ti aspetta')];
		await b.giro(1000);
		a = b.presi('alert');
		assert.strictEqual(a[0].payload.jobId, 'j2');
		assert.strictEqual(a[0].payload.chiave, 'job:j2');
		ok('ATTESA: una volta per passaggio, non piu\' di una ogni 10 minuti, jobId per rispondere');
	}

	// ---------- lontano dal Mac ----------
	{
		const b = banco();
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', token: hex(32) });
		b.lavori = [lavoro('job:j1', 'in corso'), lavoro('sess:s1', 'in corso')];
		await b.giro();
		await b.giro(61_000);
		b.inattivo = 10_000; // Andrea e' al Mac
		b.lavori = [lavoro('sess:s1', 'ti aspetta')]; // j1 ha finito, s1 aspetta
		await b.giro(1000);
		assert.strictEqual(b.presi('alert').length, 0, 'al Mac non arriva niente');
		assert.ok(b.letture >= 1);
		b.inattivo = 3 * MIN; // si alza
		await b.giro(1000);
		assert.strictEqual(b.presi('alert').length, 0, 'quello che ha visto al Mac non arriva quando si alza: niente raffica');
		b.lavori = [lavoro('sess:s1', 'ti aspetta'), lavoro('sess:s3', 'ti aspetta')]; // s3 aspetta mentre e' via
		await b.giro(1000);
		const a = b.presi('alert');
		assert.deepStrictEqual(a.map(p => p.payload.chiave), ['sess:s3'], 'arriva solo chi comincia ad aspettare quando e\' via');

		b.modo = 'mai';
		b.lavori = [lavoro('sess:s1', 'in corso'), lavoro('sess:s2', 'ti aspetta')];
		await b.giro(11 * MIN);
		assert.strictEqual(b.presi('alert').length, 0, 'con «mai» niente notifiche');
		b.modo = 'sempre';
		b.inattivo = 0;
		const prima = b.letture;
		await b.giro(1000);
		assert.strictEqual(b.presi('alert').length, 1, 'con «sempre» anche al Mac');
		assert.strictEqual(b.letture, prima, 'con «sempre» non serve leggere l\'inattivita\'');
		ok('lontano dal Mac: al Mac niente, poi solo chi comincia ad aspettare quando e\' via; «mai» e «sempre»');
	}

	// ---------- iPhone attaccato al Mac col cavo (9.9) ----------
	{
		let cavo = true;
		const b = banco({ cavo: () => cavo });
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', token: hex(32) });
		b.lavori = [lavoro('sess:s1', 'in corso')];
		await b.giro();
		await b.giro(61_000);
		b.lavori = [lavoro('sess:s1', 'ti aspetta')]; // Andrea e' lontano dalla tastiera, ma l'iPhone e' sulla scrivania
		await b.giro(1000);
		assert.strictEqual(b.presi('alert').length, 0, 'col cavo niente notifiche anche lontano dalla tastiera');
		cavo = false;
		b.lavori = [lavoro('sess:s1', 'ti aspetta'), lavoro('sess:s2', 'ti aspetta')];
		await b.giro(1000);
		assert.deepStrictEqual(b.presi('alert').map(p => p.payload.chiave), ['sess:s2'], 'staccato: arriva chi comincia ad aspettare dopo');
		ok('col cavo l\'iPhone e\' al Mac: niente notifiche, e staccandolo niente raffica');
	}

	// ---------- FINITO, CONFERMA, REGOLA ----------
	{
		const b = banco();
		fondiDispositivo(b.dir, { ambiente: 'produzione', token: hex(32) });
		b.lavori = [lavoro('job:j1', 'in corso', { title: 'Aggiorna il README', project: 'Peak' }), lavoro('sess:s9', 'in corso'), lavoro('job:j3', 'in coda')];
		b.regole = [{ path: '/p/a', progetto: 'Alfa', livello: 'verde' }, { path: '/p/b', progetto: 'Beta', livello: 'rosso', frase: 'Gia\' rosso.' }];
		await b.giro();
		await b.giro(61_000);
		assert.strictEqual(b.presi('alert').length, 0);

		b.lavori = [];
		await b.giro(1000);
		let a = b.presi('alert');
		assert.strictEqual(a.length, 1, 'solo il lavoro della Bottega in corso; la sessione altrove e quello in coda no');
		assert.deepStrictEqual(a[0].payload, { aps: { alert: { title: 'Peak', body: 'Ha finito: Aggiorna il README' }, category: 'FINITO', 'thread-id': 'Peak' } });
		assert.strictEqual(a[0].ambiente, 'produzione');

		b.conferma = { id: 1, testo: 'Posso fare git push su Bottega?' };
		await b.giro(1000);
		a = b.presi('alert');
		assert.deepStrictEqual(a[0].payload, { aps: { alert: { title: 'Melissa', body: 'Posso fare git push su Bottega?' }, sound: 'default', category: 'CONFERMA', 'interruption-level': 'time-sensitive' }, conferma: 1 });
		assert.ok(a[0].scadenza > b.ora / 1000);
		await b.giro(1000);
		assert.strictEqual(b.presi('alert').length, 0, 'la stessa domanda una volta sola');
		b.conferma = undefined;
		await b.giro(1000);
		b.conferma = { id: 2, testo: 'Posso fermare il lavoro su Peak?' };
		await b.giro(1000);
		assert.strictEqual(b.presi('alert').length, 1, 'una domanda nuova si');

		b.regole = [{ path: '/p/a', progetto: 'Alfa', livello: 'rosso', frase: '3 commit non spinti su main.' }, { path: '/p/b', progetto: 'Beta', livello: 'rosso', frase: 'Gia\' rosso.' }];
		await b.giro(1000);
		a = b.presi('alert');
		assert.deepStrictEqual(a.map(p => p.payload), [{ aps: { alert: { title: 'Alfa', body: '3 commit non spinti su main.' }, category: 'REGOLA' } }]);
		await b.giro(1000);
		assert.strictEqual(b.presi('alert').length, 0, 'resta rosso: niente di nuovo');
		ok('FINITO, CONFERMA e REGOLA');
	}

	// ---------- Live Activity ----------
	{
		const b = banco();
		const avvio = hex(80);
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', avvio });
		b.lavori = [];
		await b.giro();
		assert.strictEqual(b.presi('liveactivity').length, 0, 'niente sessioni, niente attivita\'');

		b.inattivo = 0; // vale anche con Andrea al Mac
		b.lavori = [lavoro('sess:s1', 'in corso', { project: 'Uno', since: 3000 }), lavoro('sess:s2', 'ti aspetta', { project: 'Due' }), lavoro('sess:s3', 'in corso', { since: 2000 }), lavoro('sess:s4', 'in corso'), lavoro('sess:s5', 'nel terminale')];
		await b.giro(1000);
		let la = b.presi('liveactivity');
		assert.strictEqual(la.length, 1);
		assert.strictEqual(la[0].token, avvio);
		assert.strictEqual(la[0].priorita, 10);
		const aps = la[0].payload.aps;
		assert.strictEqual(aps.event, 'start');
		assert.strictEqual(aps.timestamp, Math.floor(b.ora / 1000));
		assert.strictEqual(aps['attributes-type'], 'BottegaAttivita');
		assert.deepStrictEqual(aps.attributes, { mac: 'mac-di-prova' });
		assert.deepStrictEqual(aps.alert, { title: 'Bottega', body: '3 sessioni al lavoro' });
		const cs = aps['content-state'];
		assert.deepStrictEqual({ ...cs, aggiornato: 0 }, { inCorso: 3, tiAspetta: 1, vive: 5, righe: [{ progetto: 'Uno', stato: 'in corso', da: 3000 }, { progetto: 'Bottega', stato: 'in corso', da: 2000 }, { progetto: 'Due', stato: 'ti aspetta', da: 1000 }], aggiornato: 0 }, 'righe in ordine di tempo, dalla piu\' recente, non per stato');
		assert.strictEqual(cs.aggiornato, b.ora);
		await b.giro(30_000);
		assert.strictEqual(b.presi('liveactivity').length, 0, 'gia\' avviata: non riparte');

		// l'app registra il token dell'attivita'
		const att = hex(80);
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', attivita: att });
		b.lavori = b.lavori.slice(1); // s1 se ne va
		await b.giro(1000);
		la = b.presi('liveactivity');
		assert.strictEqual(la.length, 1);
		assert.strictEqual(la[0].token, att);
		assert.strictEqual(la[0].payload.aps.event, 'update');
		assert.strictEqual(la[0].priorita, 5, 'tiAspetta uguale: priorita\' 5');
		assert.strictEqual(la[0].payload.aps['stale-date'], Math.floor((b.ora + 15 * MIN) / 1000));
		b.lavori = [lavoro('sess:s7', 'ti aspetta'), ...b.lavori];
		await b.giro(5000);
		assert.strictEqual(b.presi('liveactivity').length, 0, 'al massimo ogni 15 secondi');
		await b.giro(10_000);
		la = b.presi('liveactivity');
		assert.strictEqual(la.length, 1, 'passati i 15 secondi parte il cambio rimasto');
		assert.strictEqual(la[0].priorita, 10, 'tiAspetta cambia: priorita\' 10');
		await b.giro(20_000);
		assert.strictEqual(b.presi('liveactivity').length, 0, 'senza cambi niente');

		// nessuna sessione: aggiornamento, poi la fine dopo 2 minuti
		b.lavori = [lavoro('sess:s5', 'nel terminale')];
		await b.giro(1000);
		la = b.presi('liveactivity');
		assert.strictEqual(la[0].payload.aps.event, 'update');
		await b.giro(MIN);
		assert.strictEqual(b.presi('liveactivity').length, 0);
		await b.giro(MIN);
		la = b.presi('liveactivity');
		assert.strictEqual(la.length, 1);
		assert.strictEqual(la[0].payload.aps.event, 'end');
		assert.strictEqual(la[0].payload.aps['dismissal-date'], Math.floor((b.ora + 5 * MIN) / 1000));
		assert.strictEqual(la[0].payload.aps['content-state'].inCorso, 0);
		assert.strictEqual(leggiDispositivo(b.dir).attivita, undefined, 'finita: il token dell\'attivita\' si toglie');
		await b.giro(MIN);
		assert.strictEqual(b.presi('liveactivity').length, 0);

		// il lavoro riparte: una nuova attivita'
		b.lavori = [lavoro('sess:s6', 'in corso')];
		await b.giro(1000);
		la = b.presi('liveactivity');
		assert.strictEqual(la[0].payload.aps.event, 'start');
		assert.strictEqual(la[0].payload.aps.alert.body, '1 sessione al lavoro');
		ok('Live Activity: avvio, aggiornamenti ogni 15 s al massimo, fine dopo 2 minuti, nuovo avvio');
	}

	// ---------- Live Activity: il token di un'attivita' che non c'e' piu' ----------
	{
		// app reinstallata: iOS ha chiuso l'attivita', il Mac ha ancora il suo token (ereditato dal file) e lo
		// aggiornava per sempre. Quando l'app lo toglie si riparte subito con il token di avvio.
		const b = banco();
		const avvio = hex(80), vecchio = hex(80);
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', avvio, attivita: vecchio });
		b.inattivo = 0;
		b.lavori = [lavoro('sess:s1', 'in corso')];
		await b.giro(1000);
		let la = b.presi('liveactivity');
		assert.strictEqual(la[0].token, vecchio, 'prima aggiorna quella che crede viva');
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', attivita: '' });
		await b.giro(1000);
		la = b.presi('liveactivity');
		assert.strictEqual(la.length, 1, 'tolto dall\'app: riparte');
		assert.strictEqual(la[0].payload.aps.event, 'start');
		assert.strictEqual(la[0].token, avvio);

		// partita da qui e chiusa a mano da Andrea: non riparte finche' il lavoro continua
		const nuovo = hex(80);
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', attivita: nuovo });
		await b.giro(20_000);
		assert.ok(!b.presi('liveactivity').some(p => p.payload.aps.event === 'start'), 'col token nuovo aggiorna, non riparte');
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', attivita: '' });
		await b.giro(3 * MIN);
		assert.strictEqual(b.presi('liveactivity').length, 0, 'chiusa a mano: non riparte');

		// spente e riaccese dalle impostazioni dell'app: il token di avvio va e torna, e si riparte subito
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', avvio: '' });
		await b.giro(1000);
		assert.strictEqual(b.presi('liveactivity').length, 0, 'spente: niente');
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', avvio });
		await b.giro(1000);
		la = b.presi('liveactivity');
		assert.strictEqual(la.length, 1, 'riaccese col lavoro in corso: riparte');
		assert.strictEqual(la[0].payload.aps.event, 'start');
		assert.strictEqual(la[0].token, avvio);

		// spente e riaccese in meno di un secondo, senza un giro in mezzo (build 74): il ponte lo dice subito
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', attivita: hex(80) });
		await b.giro(20_000);
		b.presi('liveactivity');
		b.av.avvioTolto();
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', avvio: '', attivita: '' });
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', avvio });
		await b.giro(1000);
		la = b.presi('liveactivity');
		assert.strictEqual(la.length, 1, 'riaccese di corsa: riparte lo stesso');
		assert.strictEqual(la[0].payload.aps.event, 'start');
		ok('Live Activity: il token tolto dall\'app fa ripartire un\'attivita\' ereditata, non una chiusa a mano; riaccese dall\'app ripartono, anche di corsa');
	}
	{
		// oltre le 8 ore iOS l'ha chiusa e APNs risponde 200 lo stesso: il token si toglie e si riparte
		const b = banco();
		const avvio = hex(80), att = hex(80);
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', avvio, attivita: att });
		b.inattivo = 0;
		b.lavori = [lavoro('sess:s1', 'in corso')];
		await b.giro(1000);
		assert.strictEqual(b.presi('liveactivity')[0].token, att);
		await b.giro(8 * 60 * MIN);
		assert.strictEqual(leggiDispositivo(b.dir).attivita, undefined, 'dopo 8 ore il token si toglie');
		await b.giro(1000);
		const la = b.presi('liveactivity');
		assert.strictEqual(la.length, 1);
		assert.strictEqual(la[0].payload.aps.event, 'start', 'e ne parte una nuova');
		assert.strictEqual(la[0].token, avvio);
		ok('Live Activity: oltre le 8 ore il token si toglie e ne parte una nuova');
	}
	{
		// «segui questo lavoro»: la sessione seguita tiene viva l'attivita' anche quando aspetta
		const b = banco();
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', avvio: hex(80) });
		b.lavori = [lavoro('sess:s1', 'ti aspetta', { project: 'Uno' })];
		b.segui = { progetto: 'Uno', passo: 'chiede un permesso per Bash e altro testo lungo che non deve passare intero dai server di Apple', stato: 'ti aspetta' };
		await b.giro(1000);
		let la = b.presi('liveactivity');
		assert.strictEqual(la.length, 1, 'seguita e in attesa: l\'attivita\' parte');
		assert.strictEqual(la[0].payload.aps.alert.body, 'Segui Uno');
		const seg = la[0].payload.aps['content-state'].segui;
		assert.strictEqual(seg.progetto, 'Uno');
		assert.ok(seg.passo.length <= 60, 'passo corto: ' + seg.passo);
		assert.ok(JSON.stringify(la[0].payload).length < 4096, 'sotto i 4 KB di APNs');
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', attivita: hex(80) });
		await b.giro(3 * MIN);
		assert.ok(!b.presi('liveactivity').some(p => p.payload.aps.event === 'end'), 'seguita: non finisce');
		b.segui = undefined;
		await b.giro(1000);
		await b.giro(2 * MIN);
		assert.ok(b.presi('liveactivity').some(p => p.payload.aps.event === 'end'), 'non piu\' seguita e nessuno al lavoro: finisce');
		ok('Live Activity: una sessione seguita la tiene viva, passo corto, sotto i 4 KB');
	}

	// Registro multi-fonte: stessi dati del Mac, senza trasformare osservazioni in lavori azionabili.
	{
		const b = banco();
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', avvio: hex(80), widget: hex(40), token: hex(32) });
		b.attivita = [];
		await b.giro();
		const a = (source, status, updatedAt = 1000) => ({ key: source + ':1', id: '1', source,
			project: 'Progetto comune', title: 'Attivita di prova', status, updatedAt, evidence: 'test' });
		b.attivita = [a('claude', 'in corso'), a('cline', 'ti aspetta', 3000), a('codex', 'in corso', 2000),
			a('terminale', 'in corso'), a('codex', 'finito', 1000)];
		await b.giro(MIN);
		const push = b.presi('liveactivity')[0];
		const cs = push.payload.aps['content-state'];
		assert.strictEqual(cs.inCorso, 3);
		assert.strictEqual(cs.tiAspetta, 1);
		assert.strictEqual(cs.vive, 4, 'storico e duplicati non gonfiano le vive');
		assert.deepStrictEqual(cs.righe.map(r => r.fonte), ['Cline', 'Codex', 'Claude Code']);
		assert.strictEqual(b.presi('alert').length, 0, 'le osservate non generano notifiche con risposte a job inesistenti');
		assert.strictEqual(b.presi('widgets').length, 1);
		assert.ok(Buffer.byteLength(JSON.stringify(push.payload)) < 4096);
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', attivita: hex(80) });
		b.attivita = [a('terminale', 'in corso', 4000)];
		await b.giro(5 * MIN);
		const solo = b.presi('liveactivity')[0].payload.aps['content-state'];
		assert.strictEqual(solo.inCorso, 1);
		assert.strictEqual(solo.righe[0].fonte, 'Terminale');
		b.presi('widgets');
		b.attivita[0].project = 'Nuovo progetto';
		await b.giro(5 * MIN);
		assert.strictEqual(b.presi('widgets').length, 1, 'stessi contatori, progetto diverso: aggiorna widget');
		b.attivita[0].title = 'Nuovo compito';
		await b.giro(1000);
		assert.strictEqual(b.presi('widgets').length, 0, 'il cambio testo rispetta il limite');
		await b.giro(5 * MIN);
		assert.strictEqual(b.presi('widgets').length, 1, 'cambio testo differito, non perso');
		b.presi('liveactivity');
		b.lavori = [lavoro('sess:vecchia', 'in corso')];
		b.attivita = [];
		await b.giro(15_000);
		assert.strictEqual(b.presi('liveactivity')[0].payload.aps['content-state'].inCorso, 0, 'registro vuoto autorevole');
		await b.giro(2 * MIN);
		assert.strictEqual(b.presi('liveactivity')[0].payload.aps.event, 'end');
		ok('Live Activity e widget: quattro fonti, deduplica, aggiornamento contenuti e fine multi-fonte');
	}
	for (const source of ['cline', 'codex', 'terminale']) {
		const b = banco();
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', avvio: hex(80) });
		b.attivita = [{ key: source + ':solo', id: 'solo', source, project: 'Prova', title: 'Prova', status: 'in corso', updatedAt: 1000, evidence: 'test' }];
		await b.giro();
		assert.strictEqual(b.presi('liveactivity')[0].payload.aps.event, 'start', source + ' avvia da solo la Live Activity');
	}
	ok('Live Activity avviata anche senza alcun lavoro Claude');

	// ---------- widget ----------
	{
		const b = banco();
		const w = hex(40);
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', widget: w });
		b.lavori = [lavoro('sess:s1', 'in corso')];
		await b.giro();
		assert.strictEqual(b.presi('widgets').length, 0, 'all\'avvio niente');
		b.lavori = [lavoro('sess:s1', 'in corso'), lavoro('sess:s2', 'in corso')];
		await b.giro(61_000);
		let wg = b.presi('widgets');
		assert.strictEqual(wg.length, 1);
		assert.deepStrictEqual(wg[0].payload, { aps: { 'content-changed': true } });
		assert.strictEqual(wg[0].priorita, 5);
		b.lavori = [lavoro('sess:s1', 'in corso')];
		await b.giro(MIN);
		assert.strictEqual(b.presi('widgets').length, 0, 'al massimo uno ogni 5 minuti');
		b.lavori = [lavoro('sess:s1', 'ti aspetta')];
		await b.giro(MIN);
		assert.strictEqual(b.presi('widgets').length, 1, 'salvo tiAspetta che sale');
		b.lavori = [lavoro('sess:s1', 'in corso')];
		await b.giro(MIN);
		assert.strictEqual(b.presi('widgets').length, 0, 'tiAspetta che scende aspetta i 5 minuti');
		await b.giro(4 * MIN);
		assert.strictEqual(b.presi('widgets').length, 1, 'passati 5 minuti il cambio arriva');
		await b.giro(10 * MIN);
		assert.strictEqual(b.presi('widgets').length, 0, 'senza cambi niente');
		ok('widget: uno ogni 5 minuti, subito se tiAspetta sale');
	}
	{
		// un rosso in piu' nel semaforo o un allarme nuovo del negozio svegliano i widget (guadagni, consigli, semaforo)
		const b = banco();
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', widget: hex(40) });
		b.regole = [{ path: '/p/uno', progetto: 'Uno', livello: 'verde' }];
		b.negozio = [];
		await b.giro();
		await b.giro(61_000);
		assert.strictEqual(b.presi('widgets').length, 0, 'niente cambiato, niente push');
		b.regole = [{ path: '/p/uno', progetto: 'Uno', livello: 'rosso', frase: 'Chiave nei commit.' }];
		await b.giro(MIN);
		assert.strictEqual(b.presi('widgets').length, 1, 'un rosso in piu\'');
		b.negozio = [{ id: 'a:2026-10-03', app: 'Prova', testo: 'AdMob di ieri al 30% della media' }];
		await b.giro(MIN);
		assert.strictEqual(b.presi('widgets').length, 0, 'sempre al massimo uno ogni 5 minuti');
		await b.giro(5 * MIN);
		assert.strictEqual(b.presi('widgets').length, 1, 'l\'allarme nuovo arriva dopo i 5 minuti');
		b.regole = null;
		b.negozio = null;
		await b.giro(10 * MIN);
		assert.strictEqual(b.presi('widgets').length, 0, 'semaforo e negozio non letti: resta tutto com\'era');
		ok('widget: anche un rosso nuovo nel semaforo o un allarme del negozio, con lo stesso limite');
	}

	// ---------- token morto ----------
	{
		const b = banco();
		const t = hex(32);
		const w = hex(40);
		fondiDispositivo(b.dir, { ambiente: 'sviluppo', token: t, widget: w });
		b.lavori = [lavoro('sess:s1', 'in corso'), lavoro('sess:s2', 'in corso')];
		await b.giro();
		await b.giro(61_000);
		b.risposta = p => (p.tipo === 'alert' ? { ok: false, status: 410, reason: 'Unregistered' } : { ok: false, status: 400, reason: 'BadDeviceToken' });
		b.lavori = [lavoro('sess:s1', 'ti aspetta'), lavoro('sess:s2', 'ti aspetta')];
		await b.giro(1000);
		assert.strictEqual(b.presi('alert').length, 1, 'dopo un token morto non si insiste');
		assert.strictEqual(b.presi('widgets').length, 1);
		const d2 = leggiDispositivo(b.dir);
		assert.strictEqual(d2.token, undefined);
		assert.strictEqual(d2.widget, undefined);
		b.risposta = () => ({ ok: true, status: 200 });
		b.lavori = [lavoro('sess:s3', 'ti aspetta')];
		await b.giro(11 * MIN);
		assert.strictEqual(b.inviati.length, 0, 'senza token non parte niente');
		ok('token morto tolto dal registro');
	}

	// ---------- testi ----------
	assert.strictEqual(pulisci('Prima \u2013 dopo \u2014 fine'), 'Prima, dopo, fine');
	assert.strictEqual(pulisci('usa `git push`  ora'), 'usa git push ora');
	assert.strictEqual(pulisci('x'.repeat(100), 10).length, 10);
	assert.ok(!lineette.test(pulisci('a \u2014 b')));
	ok('testi: niente lineette, niente apici del codice, corti');

	fs.rmSync(dir, { recursive: true, force: true });
	console.log(`avvisi: ${passed} prove passate`);
})().catch(e => {
	console.error(e);
	process.exit(1);
});
