#!/usr/bin/env node
// Banco di prova della stanza App Store: il motore (src/appstore.ts) con report di vendita, AdMob e cambi finti,
// le regole dei buchi, la lettura di un repository inventato, e la stanza (media/appstore.js) in jsdom.
// Nessun dato vero: il repository e' pubblico. App, ID e numeri sono inventati.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'test-out', 'appstore');
esbuild.buildSync({
	entryPoints: [path.join(SRC, 'appstore.ts')],
	outdir: OUT,
	format: 'cjs',
	platform: 'node',
	bundle: true,
	external: ['vscode'],
	target: 'node20',
	logLevel: 'silent',
});
const A = require(path.join(OUT, 'appstore.js'));

let passed = 0, failed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log('  ok  ' + name);
	} catch (e) {
		failed++;
		console.log('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e));
	}
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-appstore-'));
const PUB = '1111222233334444';
const COLONNE = ['Provider', 'Provider Country', 'SKU', 'Developer', 'Title', 'Version', 'Product Type Identifier', 'Units', 'Developer Proceeds', 'Begin Date', 'End Date', 'Customer Currency', 'Country Code', 'Currency of Proceeds', 'Apple Identifier', 'Customer Price', 'Promo Code', 'Parent Identifier', 'Subscription', 'Period'];
function tsv(righe) {
	const r = o => COLONNE.map(c => o[c] ?? '').join('\t');
	return [COLONNE.join('\t'), ...righe.map(r)].join('\n') + '\n';
}
/** Un giorno di vendite: 10 download di Lanterna, un abbonamento nuovo a 2 USD, un rinnovo a 3 EUR. */
const giornoTipo = tsv([
	{ SKU: 'lanterna', Title: 'Lanterna', 'Product Type Identifier': '1F', Units: '10', 'Developer Proceeds': '0', 'Apple Identifier': '100' },
	{ SKU: 'lanterna', Title: 'Lanterna', 'Product Type Identifier': '7F', Units: '40', 'Developer Proceeds': '0', 'Apple Identifier': '100' },
	{ SKU: 'lanterna', Title: 'Lanterna', 'Product Type Identifier': '3F', Units: '2', 'Developer Proceeds': '0', 'Apple Identifier': '100' },
	{ SKU: 'lanterna.pro', Title: 'Pro', 'Product Type Identifier': 'IAY', Units: '1', 'Developer Proceeds': '2', 'Currency of Proceeds': 'USD', 'Apple Identifier': '900', 'Parent Identifier': 'lanterna', Subscription: 'New' },
	{ SKU: 'lanterna.pro', Title: 'Pro', 'Product Type Identifier': 'IAY', Units: '1', 'Developer Proceeds': '3', 'Currency of Proceeds': 'EUR', 'Apple Identifier': '900', 'Parent Identifier': 'lanterna', Subscription: 'Renewal' },
	{ SKU: 'bussola', Title: 'Bussola', 'Product Type Identifier': '1F', Units: '5', 'Developer Proceeds': '0', 'Apple Identifier': '200' },
]);

(async () => {
	console.log('stanza App Store');

	await test('leggiReport: download, abbonamenti al padre per SKU, ricavi per valuta, aggiornamenti esclusi', () => {
		const sku = {};
		const r = A.leggiReport(giornoTipo, sku);
		assert.deepStrictEqual(Object.keys(r).sort(), ['100', '200']);
		assert.strictEqual(r['100'].dl, 10);
		assert.strictEqual(r['100'].rdl, 2);
		assert.strictEqual(r['100'].sn, 1);
		assert.strictEqual(r['100'].sr, 1);
		assert.deepStrictEqual(r['100'].pr, { USD: 2, EUR: 3 });
		assert.strictEqual(sku.lanterna, '100');
		assert.strictEqual(r['200'].dl, 5);
	});

	await test('leggiReport: un acquisto senza app nota finisce sotto sku:, non sparisce', () => {
		const r = A.leggiReport(tsv([{ SKU: 'x.iap', 'Product Type Identifier': 'IA1', Units: '1', 'Developer Proceeds': '1', 'Currency of Proceeds': 'EUR', 'Apple Identifier': '901', 'Parent Identifier': 'ignota' }]), {});
		assert.ok(r['sku:ignota']);
		assert.strictEqual(r['sku:ignota'].iap, 1);
	});

	// --- costruisci e buchi ---
	const NOW = new Date(2026, 9, 3, 12).getTime();
	const giorni = A.ultimiGiorni(NOW);
	const mesi = A.ultimiMesi(NOW);
	const sku = {};
	const venditeGiorni = {};
	for (const d of giorni.slice(0, -1)) venditeGiorni[d] = A.leggiReport(giornoTipo, sku);
	const venditeMesi = { [mesi[0]]: 'perso', [mesi[mesi.length - 3]]: A.leggiReport(giornoTipo, sku) };
	const riga = (dim, o) => ({ dim, euro: 0, richieste: 0, abbinate: 0, impressioni: 0, clic: 0, ...o });
	const admob = {
		publisher: `accounts/pub-${PUB}`,
		app: [
			{ appId: `ca-app-pub-${PUB}~1`, piattaforma: 'IOS', nome: 'Lanterna', store: '100', approvazione: 'APPROVED' },
			{ appId: `ca-app-pub-${PUB}~2`, piattaforma: 'IOS', nome: 'Bussola', store: '200', approvazione: 'ACTION_REQUIRED' },
			{ appId: `ca-app-pub-${PUB}~3`, piattaforma: 'ANDROID', nome: 'Lanterna', store: 'com.esempio.lanterna', approvazione: 'APPROVED' },
		],
		unita: [
			{ id: `ca-app-pub-${PUB}/0000000011`, appId: `ca-app-pub-${PUB}~1`, nome: 'lanterna interstitial', formato: 'INTERSTITIAL' },
			{ id: `ca-app-pub-${PUB}/0000000012`, appId: `ca-app-pub-${PUB}~1`, nome: 'lanterna premio', formato: 'REWARDED' },
			{ id: `ca-app-pub-${PUB}/0000000013`, appId: `ca-app-pub-${PUB}~1`, nome: 'lanterna vecchia', formato: 'BANNER' },
			{ id: `ca-app-pub-${PUB}/0000000031`, appId: `ca-app-pub-${PUB}~3`, nome: 'lanterna android', formato: 'BANNER' },
		],
		giorni: giorni.map(d => riga({ DATE: d.replace(/-/g, ''), APP: `ca-app-pub-${PUB}~1` }, { euro: 1, impressioni: 100 })),
		mesi: mesi.map(m => riga({ MONTH: m.replace('-', ''), APP: `ca-app-pub-${PUB}~1` }, { euro: 30 })),
		formati: [
			riga({ APP: `ca-app-pub-${PUB}~1`, FORMAT: 'interstitial' }, { richieste: 4000, abbinate: 3900, impressioni: 200, euro: 2 }),
			riga({ APP: `ca-app-pub-${PUB}~1`, FORMAT: 'rewarded' }, { richieste: 2000, abbinate: 1900, impressioni: 20, euro: 0.4 }),
			riga({ APP: `ca-app-pub-${PUB}~2`, FORMAT: 'banner' }, { richieste: 5000, abbinate: 300, impressioni: 290, euro: 0.1 }),
		],
		perUnita: [riga({ AD_UNIT: `ca-app-pub-${PUB}/0000000011` }, { richieste: 4000 }), riga({ AD_UNIT: `ca-app-pub-${PUB}/0000000012` }, { richieste: 2000 })],
		paesi: [riga({ COUNTRY: 'US' }, { euro: 20, impressioni: 1000 }), riga({ COUNTRY: 'IT' }, { euro: 5, impressioni: 900 })],
	};
	const repoLanterna = {
		path: '/p/lanterna', letteAt: NOW, file: 10, sdk: true, formati: ['interstitial', 'rewarded'], ump: false, att: true, attRichiesta: true, skan: 3, idProva: [],
		unita: [
			{ id: `ca-app-pub-${PUB}/0000000011`, piattaforma: 'ios' },
			{ id: `ca-app-pub-${PUB}/0000000031`, piattaforma: 'android' }, // l'Android nello stesso repository: non e' un errore
			{ id: 'ca-app-pub-9999888877776666/1234512345', piattaforma: 'ios' },
		],
		storekit: true, revenuecat: false,
	};
	const ingressi = {
		now: NOW, giorni, mesi, venditeGiorni, venditeMesi, cambi: { USD: 2 }, asc: [{ id: '100', name: 'Lanterna', bundleId: 'com.esempio.lanterna' }],
		nomiVendite: { 200: 'Bussola' }, admob, collegamenti: { 'ios:100': { path: '/p/lanterna', name: 'lanterna' } }, repo: { '/p/lanterna': repoLanterna },
	};
	const s = A.costruisci(ingressi);
	const lanterna = s.app.find(a => a.chiave === 'ios:100');

	await test('costruisci: AdMob e Store sulla stessa app, in euro, con i cambi', () => {
		assert.ok(lanterna);
		assert.strictEqual(lanterna.projectName, 'lanterna');
		const i = giorni.length - 2;
		assert.strictEqual(lanterna.giorni.dl[i], 10);
		assert.strictEqual(lanterna.giorni.admob[i], 1);
		assert.strictEqual(lanterna.giorni.store[i], 4); // 2 USD a 2 per euro + 3 EUR
		assert.strictEqual(lanterna.acquisti.nuovi, 29, '30 giorni, ieri senza report');
	});

	await test('costruisci: l\'ultimo giorno senza report non e\' zero ma «Store fino a»', () => {
		assert.strictEqual(s.storeFinoA, giorni[giorni.length - 2]);
		assert.strictEqual(lanterna.giorni.store[giorni.length - 1], 0);
	});

	await test('costruisci: mesi dal report mensile, dai giorni quando manca, n/d quando Apple non lo da\' piu\'', () => {
		assert.strictEqual(lanterna.mesi.store[mesi.length - 3], 4);
		assert.strictEqual(lanterna.mesi.store[mesi.length - 1], 4, 'il mese in corso somma i giorni che ci sono (il primo)');
		assert.strictEqual(lanterna.mesi.store[mesi.length - 2], 4 * 30, 'settembre dai giorni: il report mensile manca');
		assert.deepStrictEqual(s.storeSenzaDati, [mesi[0]]);
		assert.strictEqual(lanterna.mesi.admob[0], 30);
	});

	await test('costruisci: paesi in ordine di euro e app Android a parte', () => {
		assert.deepStrictEqual(s.paesi.map(p => p.codice), ['US', 'IT']);
		assert.ok(s.app.some(a => a.chiave === 'android:com.esempio.lanterna') === false, 'l\'Android senza numeri non si mostra');
	});

	const buchi = s.buchi;
	const ids = buchi.map(b => b.id);
	await test('buchi: interstitial caricati e non mostrati, con stima e compito per Claude', () => {
		const b = buchi.find(x => x.id === 'ios:100:mostrati:interstitial');
		assert.ok(b, ids.join(', '));
		assert.strictEqual(b.gravita, 'alta');
		assert.ok(b.stima > 0);
		assert.ok(/ios-admob-integration/.test(b.compito));
		assert.strictEqual(b.projectPath, '/p/lanterna');
	});

	await test('buchi: gli annunci con premio non hanno stima in euro', () => {
		const b = buchi.find(x => x.id === 'ios:100:mostrati:rewarded');
		assert.ok(b);
		assert.strictEqual(b.gravita, 'bassa');
		assert.strictEqual(b.stima, undefined);
	});

	await test('buchi: riempimento basso, AdMob non approvata, consenso mancante, pochi SKAdNetwork', () => {
		assert.ok(ids.includes('ios:200:fill:banner'));
		assert.ok(ids.includes('ios:200:approvazione'));
		assert.ok(ids.includes('ios:100:ump'));
		assert.ok(ids.includes('ios:100:skan'));
	});

	await test('buchi: ID di un altro account sì, l\'Android dello stesso repository no', () => {
		const b = buchi.find(x => x.id === 'ios:100:estranee');
		assert.ok(b && /9999888877776666/.test(b.perche));
		assert.ok(!ids.includes('ios:100:altra-app'), 'un ID Android non e\' «di un\'altra app» per l\'app iOS');
	});

	await test('buchi: unita\' mai chiamata, e in cima le gravi', () => {
		assert.ok(ids.includes('ios:100:ferme'));
		const peso = { alta: 0, media: 1, bassa: 2 };
		for (let i = 1; i < buchi.length; i++) assert.ok(peso[buchi[i - 1].gravita] <= peso[buchi[i].gravita]);
	});

	await test('buchi: nessuna lineetta lunga o media nei testi', () => {
		for (const b of buchi) for (const k of ['titolo', 'perche', 'cosa', 'stimaNota', 'compito']) assert.ok(!/[\u2013\u2014]/.test(b[k] || ''), `${b.id}.${k}`);
	});

	await test('leggiRepo: formati, consenso, ATT, SKAdNetwork; ID di prova solo fuori da DEBUG; segnaposto ignorati', async () => {
		const dir = path.join(tmp, 'repo');
		fs.mkdirSync(path.join(dir, 'App'), { recursive: true });
		fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
		fs.mkdirSync(path.join(dir, 'AppTests'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'App', 'Annunci.swift'), [
			'import GoogleMobileAds', 'import UserMessagingPlatform',
			'#if DEBUG', 'let unita = "ca-app-pub-3940256099942544/4411468910"', '#else', `let unita = "ca-app-pub-${PUB}/0000000011"`, '#endif',
			'InterstitialAd.load(with: unita, request: Request())', 'AppOpenAd.load(with: unita, request: Request())',
			'// esempio: ca-app-pub-0123456789012345/0123456789 e ca-app-pub-0000000000000000/0000000001',
			'ATTrackingManager.requestTrackingAuthorization { _ in }',
		].join('\n'));
		fs.writeFileSync(path.join(dir, 'App', 'Config.swift'), 'let prova = "ca-app-pub-3940256099942544/1033173712"\n');
		fs.writeFileSync(path.join(dir, 'AppTests', 'ProvaTests.swift'), 'let x = "ca-app-pub-3940256099942544/1033173712"\n');
		fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'a.swift'), 'GADRewardedAd\n');
		fs.writeFileSync(path.join(dir, 'App', 'Info.plist'), '<key>NSUserTrackingUsageDescription</key><string>x</string><string>cstr6suwn9.skadnetwork</string><string>4fzdc2evr5.skadnetwork</string>');
		const r = await A.leggiRepo(dir, NOW);
		assert.strictEqual(r.sdk, true);
		assert.deepStrictEqual(r.formati, ['app_open', 'interstitial']);
		assert.strictEqual(r.ump, true);
		assert.strictEqual(r.att, true);
		assert.strictEqual(r.attRichiesta, true);
		assert.strictEqual(r.skan, 2);
		assert.deepStrictEqual(r.idProva, ['App/Config.swift']);
		assert.deepStrictEqual(r.unita, [{ id: `ca-app-pub-${PUB}/0000000011`, piattaforma: 'ios' }]);
		assert.strictEqual(r.storekit, false, 'import StoreKit da solo non vuol dire acquisti in-app');
	});

	// --- il motore con fetch e radar finti ---
	await test('AppStore.refresh: scarica i report una volta sola, non tiene un «no sales» recente, salva in 600', async () => {
		const dir = path.join(tmp, 'motore');
		const env = path.join(tmp, 'asc.env');
		fs.writeFileSync(env, 'ASC_VENDOR_NUMBER=12345\n');
		const chiamate = [];
		const fetchFinto = async url => {
			chiamate.push(String(url));
			if (String(url).includes('er-api')) return new Response(JSON.stringify({ result: 'success', rates: { USD: 2 } }), { status: 200 });
			const data = /reportDate\]=([\d-]+)/.exec(url)[1];
			const recente = data >= giorni[giorni.length - 1].slice(0, 7);
			if (data === giorni[giorni.length - 1] || (data.length === 7 && recente))
				return new Response(JSON.stringify({ errors: [{ status: '404', detail: 'There were no sales for the date specified.' }] }), { status: 404 });
			return new Response(zlib.gzipSync(giornoTipo), { status: 200 });
		};
		const radar = {
			ascJwt: () => 'jwt',
			asc: async () => ({ data: [{ id: '100', attributes: { name: 'Lanterna', bundleId: 'com.esempio.lanterna', sku: 'lanterna' } }] }),
			admob: async (metodo, p) => {
				if (p === '/accounts') return { account: [{ name: `accounts/pub-${PUB}` }] };
				if (p.includes('/apps')) return { apps: [{ appId: `ca-app-pub-${PUB}~1`, platform: 'IOS', linkedAppInfo: { appStoreId: '100', displayName: 'Lanterna' }, appApprovalState: 'APPROVED' }] };
				if (p.includes('/adUnits')) return { adUnits: [] };
				return [{ header: {} }];
			},
		};
		const as = new A.AppStore({ radar: () => radar, projects: () => [], dir, now: () => NOW, fetch: fetchFinto, ascEnvFile: env });
		await as.refresh({ force: true });
		const st = as.state();
		assert.deepStrictEqual(st.errori, {});
		assert.ok(st.app.find(a => a.chiave === 'ios:100'));
		const prime = chiamate.filter(u => u.includes('salesReports')).length;
		assert.ok(prime >= 62);
		const cache = JSON.parse(fs.readFileSync(path.join(dir, 'vendite.json'), 'utf8'));
		assert.strictEqual(cache.giorni[giorni[giorni.length - 1]], undefined, 'il vuoto di ieri si riprova');
		assert.strictEqual((fs.statSync(path.join(dir, 'vendite.json')).mode & 0o777).toString(8), '600');
		chiamate.length = 0;
		await as.refresh({ force: true });
		const seconde = chiamate.filter(u => u.includes('salesReports'));
		assert.ok(seconde.length <= 3, `alla seconda lettura solo i report mancanti, non ${seconde.length}`);
		assert.ok(!chiamate.some(u => u.includes('er-api')), 'i cambi si tengono un giorno');
	});

	// --- la stanza ---
	await test('stanza: monta, mostra frase, buchi e app; periodo e «Sistema con Claude» mandano i messaggi giusti', () => {
		const dom = new JSDOM('<!doctype html><html lang="it"><body class="vscode-dark"><main id="app"></main></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://plancia.invalid/' });
		const w = dom.window;
		w.eval(fs.readFileSync(path.join(__dirname, '..', 'media', 'appstore.js'), 'utf8'));
		const posts = [];
		const salvati = [];
		const root = w.document.getElementById('app');
		const stanza = w.BottegaAppStore.mount(root, { post: m => posts.push(JSON.parse(JSON.stringify(m))), saved: {}, save: o => salvati.push(JSON.parse(JSON.stringify(o))) });
		stanza.show();
		assert.deepStrictEqual(posts[0], { type: 'appstore.request' });
		stanza.message({ type: 'appstore', state: { ...s, aggiornatoAt: NOW, aggiornando: false, errori: {} } });
		const testo = root.textContent;
		assert.ok(/Negli ultimi 30 giorni le app hanno reso/.test(root.querySelector('#aps-frase').textContent));
		assert.ok(root.querySelectorAll('.aps-buco').length > 0);
		assert.ok(root.querySelector('#aps-app').textContent.includes('Lanterna'));
		assert.ok(root.querySelectorAll('#aps-guadagni path.aps-m-admob').length === 30);
		assert.ok(!/[\u2013\u2014]/.test(testo), 'niente lineette lunghe o medie');
		root.querySelector('[data-a="periodo"][data-v="anno"]').click();
		assert.strictEqual(salvati[salvati.length - 1].periodo, 'anno');
		assert.ok(root.querySelectorAll('#aps-guadagni path.aps-m-admob').length === 12);
		const claude = root.querySelector('[data-a="claude"]');
		assert.ok(claude, 'c\'e\' un pulsante per Claude');
		claude.focus();
		claude.click();
		const job = posts.find(m => m.type === 'job.prepare');
		assert.ok(job && job.path === '/p/lanterna' && job.task.length > 20);
		stanza.message({ type: 'appstore', state: { ...s, aggiornatoAt: NOW, aggiornando: true, fase: 'Leggo AdMob', errori: {} } });
		assert.strictEqual(w.document.activeElement.getAttribute('data-a'), 'claude', 'l\'aggiornamento non perde il fuoco');
		assert.ok(root.querySelector('#aps-timbro').textContent.includes('Leggo AdMob'));
		root.querySelector('[data-a="app"]').click();
		assert.ok(root.querySelector('.aps-dettaglio'), 'la riga si apre');
		assert.ok(root.querySelector('[data-a="aggiorna"]').disabled, 'mentre aggiorna il pulsante si spegne');
		stanza.message({ type: 'appstore', state: { ...s, aggiornatoAt: NOW, aggiornando: false, errori: {} } });
		root.querySelector('[data-a="aggiorna"]').click();
		assert.ok(posts.some(m => m.type === 'appstore.refresh'));
	});

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
