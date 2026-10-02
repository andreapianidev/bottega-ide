#!/usr/bin/env node
// Banco di prova della stanza App Store: il motore (src/appstore.ts), i lettori delle fonti (src/appstore-dati.ts), la
// memoria dei buchi (src/appstore-storia.ts) con report di vendita, abbonamenti, analisi, AdMob e cambi finti, la
// lettura di un repository inventato, e la stanza (media/appstore.js) in jsdom.
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
	entryPoints: ['appstore', 'appstore-dati', 'appstore-storia'].map(n => path.join(SRC, n + '.ts')),
	outdir: OUT,
	format: 'cjs',
	platform: 'node',
	bundle: true,
	external: ['vscode'],
	target: 'node20',
	logLevel: 'silent',
});
const A = require(path.join(OUT, 'appstore.js'));
const D = require(path.join(OUT, 'appstore-dati.js'));
const M = require(path.join(OUT, 'appstore-storia.js'));

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
function tsv(righe, colonne = COLONNE) {
	const r = o => colonne.map(c => o[c] ?? '').join('\t');
	return [colonne.join('\t'), ...righe.map(r)].join('\n') + '\n';
}
/** Un giorno di vendite: 10 download di Lanterna, un abbonamento nuovo a 2 USD, un rinnovo a 3 EUR. */
const giornoTipo = (ver = '1.0') =>
	tsv([
		{ SKU: 'lanterna', Title: 'Lanterna', Version: ver, 'Product Type Identifier': '1F', Units: '10', 'Developer Proceeds': '0', 'Apple Identifier': '100' },
		{ SKU: 'lanterna', Title: 'Lanterna', Version: ver, 'Product Type Identifier': '7F', Units: '40', 'Developer Proceeds': '0', 'Apple Identifier': '100' },
		{ SKU: 'lanterna', Title: 'Lanterna', Version: '0.9', 'Product Type Identifier': '3F', Units: '2', 'Developer Proceeds': '0', 'Apple Identifier': '100' },
		{ SKU: 'lanterna.pro', Title: 'Pro', 'Product Type Identifier': 'IAY', Units: '1', 'Developer Proceeds': '2', 'Currency of Proceeds': 'USD', 'Apple Identifier': '900', 'Parent Identifier': 'lanterna', Subscription: 'New' },
		{ SKU: 'lanterna.pro', Title: 'Pro', 'Product Type Identifier': 'IAY', Units: '1', 'Developer Proceeds': '3', 'Currency of Proceeds': 'EUR', 'Apple Identifier': '900', 'Parent Identifier': 'lanterna', Subscription: 'Renewal' },
		{ SKU: 'bussola', Title: 'Bussola', Version: '3.1', 'Product Type Identifier': '1F', Units: '5', 'Developer Proceeds': '0', 'Apple Identifier': '200' },
	]);
const COL_ABB = ['App Name', 'App Apple ID', 'Subscription Name', 'Standard Subscription Duration', 'Developer Proceeds', 'Proceeds Currency', 'Active Standard Price Subscriptions', 'Active Free Trial Introductory Offer Subscriptions', 'Billing Retry', 'Grace Period', 'Subscribers'];
const abbTipo = (attivi = 12) =>
	tsv(
		[
			{ 'App Name': 'Lanterna', 'App Apple ID': '100', 'Standard Subscription Duration': '1 Year', 'Developer Proceeds': '12', 'Proceeds Currency': 'EUR', 'Active Standard Price Subscriptions': String(attivi), 'Active Free Trial Introductory Offer Subscriptions': '3', 'Billing Retry': '1', 'Grace Period': '0' },
			{ 'App Name': 'Lanterna', 'App Apple ID': '100', 'Standard Subscription Duration': '1 Month', 'Developer Proceeds': '2', 'Proceeds Currency': 'USD', 'Active Standard Price Subscriptions': '4', 'Active Free Trial Introductory Offer Subscriptions': '0', 'Billing Retry': '0', 'Grace Period': '0' },
		],
		COL_ABB,
	);
const COL_EV = ['Event Date', 'Event', 'App Name', 'App Apple ID', 'Quantity'];
const eventiTipo = tsv(
	[
		{ Event: 'Start Introductory Offer', 'App Apple ID': '100', Quantity: '1' },
		{ Event: 'Cancel', 'App Apple ID': '100', Quantity: '2' },
		{ Event: 'Reactivate with Crossgrade', 'App Apple ID': '100', Quantity: '1' },
		{ Event: 'Qualcosa di nuovo', 'App Apple ID': '100', Quantity: '9' },
	],
	COL_EV,
);

(async () => {
	console.log('stanza App Store');

	// ---------- lettori ----------

	await test('leggiReport: download, abbonamenti al padre per SKU, ricavi per valuta, versioni dai download e aggiornamenti', () => {
		const sku = {};
		const r = A.leggiReport(giornoTipo(), sku);
		assert.deepStrictEqual(Object.keys(r).sort(), ['100', '200']);
		assert.strictEqual(r['100'].dl, 10);
		assert.strictEqual(r['100'].rdl, 2);
		assert.strictEqual(r['100'].sn, 1);
		assert.strictEqual(r['100'].sr, 1);
		assert.deepStrictEqual(r['100'].pr, { USD: 2, EUR: 3 });
		assert.deepStrictEqual(r['100'].v.sort(), ['0.9', '1.0']);
		assert.strictEqual(sku.lanterna, '100');
	});

	await test('leggiReport: un acquisto senza app nota finisce sotto sku:, non sparisce', () => {
		const r = A.leggiReport(tsv([{ SKU: 'x.iap', 'Product Type Identifier': 'IA1', Units: '1', 'Developer Proceeds': '1', 'Currency of Proceeds': 'EUR', 'Apple Identifier': '901', 'Parent Identifier': 'ignota' }]), {});
		assert.strictEqual(r['sku:ignota'].iap, 1);
	});

	await test('abbonamenti: paganti, prove, ritardi, ricavi ricorrenti riportati a un mese', () => {
		const r = D.leggiAbbonamenti(abbTipo());
		assert.strictEqual(r['100'].att, 16);
		assert.strictEqual(r['100'].prv, 3);
		assert.strictEqual(r['100'].rty, 1);
		assert.strictEqual(r['100'].mrr.EUR, 12); // 12 abbonati x 12 euro l'anno = 12 euro al mese
		assert.strictEqual(r['100'].mrr.USD, 8);
		assert.ok(Math.abs(D.mesiDi('7 Days') - 0.23) < 0.01);
	});

	await test('eventi: categorie della stanza, i «Reactivate» sono ritorni, gli eventi sconosciuti no', () => {
		const e = D.leggiEventi(eventiTipo);
		assert.deepStrictEqual(e['100'], { prove: 1, disdette: 2, ritorni: 1 });
	});

	await test('scheda: impressioni e visite uniche, download nuovi per fonte, istanze sommate', () => {
		const scoperta = tsv(
			[
				{ Date: '2026-09-30', Event: 'Impression', 'Page Type': 'No page', 'Source Type': 'App Store search', Counts: '30', 'Unique Counts': '20' },
				{ Date: '2026-09-30', Event: 'Page view', 'Page Type': 'Product page', 'Source Type': 'App Store search', Counts: '9', 'Unique Counts': '6' },
				{ Date: '2026-09-30', Event: 'Page view', 'Page Type': 'Developer page', 'Source Type': 'App Store browse', Counts: '5', 'Unique Counts': '5' },
				{ Date: '2026-09-30', Event: 'Tap', 'Page Type': 'No page', 'Source Type': 'App Store search', Counts: '4', 'Unique Counts': '4' },
			],
			['Date', 'App Name', 'App Apple Identifier', 'Event', 'Page Type', 'Source Type', 'Counts', 'Unique Counts'],
		);
		const scaricati = tsv(
			[
				{ Date: '2026-09-30', 'Download Type': 'First-time download', 'Source Type': 'App Store search', Counts: '3' },
				{ Date: '2026-09-30', 'Download Type': 'First-time download', 'Source Type': 'Web referrer', Counts: '1' },
				{ Date: '2026-09-30', 'Download Type': 'Redownload', 'Source Type': 'App Store search', Counts: '2' },
				{ Date: '2026-09-30', 'Download Type': 'Auto-update', 'Source Type': 'App Store search', Counts: '50' },
			],
			['Date', 'App Name', 'Download Type', 'Source Type', 'Counts'],
		);
		const g = D.leggiScaricamenti(scaricati, D.leggiScoperta(scoperta));
		const d = g['2026-09-30'];
		assert.deepStrictEqual([d.imp, d.vis, d.dl, d.rdl], [20, 6, 4, 2]);
		assert.deepStrictEqual(d.fonti.ricerca, { imp: 20, vis: 6, dl: 3 });
		assert.strictEqual(d.fonti.web.dl, 1);
		const s = D.sommaIstanze([g, D.leggiScoperta(scoperta)]);
		assert.strictEqual(s['2026-09-30'].imp, 40, 'due istanze con eventi dello stesso giorno si sommano');
	});

	await test('versioni: un\'uscita e\' una versione piu\' alta che compare, non una vecchia riscaricata', () => {
		assert.ok(D.versioneMaggiore('2.10', '2.9'));
		assert.ok(!D.versioneMaggiore('2.9', '2.10'));
		const u = D.uscite([
			{ quando: 'a', versioni: ['2.0', '1.9'] },
			{ quando: 'b', versioni: ['2.0'] },
			{ quando: 'c', versioni: ['2.1', '1.5'] },
			{ quando: 'd', versioni: ['1.8', '2.1'] },
		]);
		assert.deepStrictEqual(u, [{ v: '2.1', quando: 'c' }]);
	});

	// ---------- storia ----------

	await test('storia: un buco nuovo ha daQuando, si chiude solo se la sua fonte e\' stata letta, con la misura dopo', () => {
		const st = M.storiaVuota();
		const b = { id: 'ios:1:fill:banner', chiave: 'ios:1', app: 'Uno', titolo: 'Riempimento basso', fonte: 'admob', misura: 0.3 };
		let r = M.applicaStoria([{ ...b }], st, 1000, new Set(['admob']));
		assert.strictEqual(r.buchi[0].daQuando, 1000);
		r = M.applicaStoria([], st, 2000, new Set(['store']), { 'ios:1:fill:banner': 0.8 });
		assert.strictEqual(r.risolti.length, 0, 'AdMob non letto: il buco non si chiude');
		r = M.applicaStoria([], st, 3000, new Set(['admob']), { 'ios:1:fill:banner': 0.8 });
		assert.strictEqual(r.risolti.length, 1);
		assert.deepStrictEqual([r.risolti[0].prima, r.risolti[0].dopo, r.risolti[0].daQuando], [0.3, 0.8, 1000]);
		r = M.applicaStoria([{ ...b }], st, 4000, new Set(['admob']));
		assert.strictEqual(r.buchi[0].daQuando, 4000, 'un buco che torna riparte da adesso');
	});

	await test('storia: ignora con il motivo, resta fuori anche alle letture dopo; ripristina lo rimette', () => {
		const st = M.storiaVuota();
		const b = { id: 'ios:1:ump', chiave: 'ios:1', app: 'Uno', titolo: 'Manca UMP', fonte: 'codice' };
		M.applicaStoria([{ ...b }], st, 1, new Set(['codice']));
		assert.ok(M.ignora(st, 'ios:1:ump', '  lo faccio con la versione nuova  ', 2));
		let r = M.applicaStoria([{ ...b }], st, 3, new Set(['codice']));
		assert.strictEqual(r.buchi.length, 0);
		assert.strictEqual(r.ignorati[0].motivo, 'lo faccio con la versione nuova');
		assert.ok(M.ripristina(st, 'ios:1:ump'));
		r = M.applicaStoria([{ ...b }], st, 4, new Set(['codice']));
		assert.strictEqual(r.buchi.length, 1);
		assert.ok(!M.ignora(st, 'non-esiste', 'x', 5));
	});

	await test('storia: un allarme non si ripete per 7 giorni', () => {
		const st = M.storiaVuota();
		const a = [{ id: 'x', chiave: 'k', app: 'A', testo: 't' }];
		assert.strictEqual(M.allarmiNuovi(a, st, 0).length, 1);
		assert.strictEqual(M.allarmiNuovi(a, st, 6 * 86_400_000).length, 0);
		assert.strictEqual(M.allarmiNuovi(a, st, 8 * 86_400_000).length, 1);
	});

	// ---------- costruisci, buchi, verifica, allarmi ----------

	const NOW = new Date(2026, 9, 3, 12).getTime();
	const giorni = A.ultimiGiorni(NOW);
	const mesi = A.ultimiMesi(NOW);
	const n = giorni.length;
	const sku = {};
	const venditeGiorni = {};
	// la 1.1 di Lanterna esce 10 giorni fa
	giorni.slice(0, -1).forEach((d, i) => (venditeGiorni[d] = A.leggiReport(giornoTipo(i >= n - 10 ? '1.1' : '1.0'), sku)));
	const venditeMesi = { [mesi[0]]: 'perso', [mesi[mesi.length - 3]]: A.leggiReport(giornoTipo(), sku) };
	const abbGiorni = {};
	const eventiGiorni = {};
	giorni.slice(0, -2).forEach((d, i) => {
		abbGiorni[d] = D.leggiAbbonamenti(abbTipo(i < 30 ? 10 : 12));
		eventiGiorni[d] = D.leggiEventi(eventiTipo);
	});
	const riga = (dim, o) => ({ dim, euro: 0, richieste: 0, abbinate: 0, impressioni: 0, clic: 0, ...o });
	const perGiorno = (app, formato, f) => giorni.map((d, i) => riga({ DATE: d.replace(/-/g, ''), APP: app, FORMAT: formato }, f(i)));
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
		// 4 euro al giorno, ieri solo 0,5: un crollo
		giorni: giorni.map((d, i) => riga({ DATE: d.replace(/-/g, ''), APP: `ca-app-pub-${PUB}~1` }, { euro: i === n - 1 ? 0.5 : 4, impressioni: 100 })),
		mesi: mesi.map(m => riga({ MONTH: m.replace('-', ''), APP: `ca-app-pub-${PUB}~1` }, { euro: 30 })),
		formatiGiorni: [
			// interstitial: 130 caricati al giorno, mostrati 7 (5%); dopo la 1.1 ne mostra 13 (10%): meglio, non ancora risolto
			...perGiorno(`ca-app-pub-${PUB}~1`, 'interstitial', i => ({ richieste: 133, abbinate: 130, impressioni: i >= n - 9 ? 13 : 7, euro: 0.07 })),
			...perGiorno(`ca-app-pub-${PUB}~1`, 'rewarded', () => ({ richieste: 66, abbinate: 63, impressioni: 1, euro: 0.01 })),
			...perGiorno(`ca-app-pub-${PUB}~2`, 'banner', () => ({ richieste: 166, abbinate: 10, impressioni: 10, euro: 0.003 })),
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
	// la scheda: Lanterna converte il 5%, altre due app il 10% e il 12%, Bussola l'1%
	const scheda = {};
	const schedaApp = (id, imp, dl, vis) => {
		const ist = {};
		for (const d of giorni.slice(0, -3)) ist[d] = { imp, vis, dl, rdl: 0, fonti: { ricerca: { imp, vis, dl } } };
		scheda[id] = ist;
	};
	schedaApp('100', 100, 5, 20);
	schedaApp('200', 100, 1, 30);
	schedaApp('300', 100, 10, 20);
	schedaApp('400', 100, 12, 20);
	const ingressi = {
		now: NOW, giorni, mesi, venditeGiorni, venditeMesi, cambi: { USD: 2 }, asc: [{ id: '100', name: 'Lanterna', bundleId: 'com.esempio.lanterna' }],
		nomiVendite: { 200: 'Bussola' }, admob, collegamenti: { 'ios:100': { path: '/p/lanterna', name: 'lanterna' } }, repo: { '/p/lanterna': repoLanterna },
		abbGiorni, eventiGiorni, scheda, approvazioniPrima: { 'ios:200': 'APPROVED' },
	};
	const s = A.costruisci(ingressi);
	const lanterna = s.app.find(a => a.chiave === 'ios:100');

	await test('costruisci: AdMob e Store sulla stessa app, in euro, con i cambi', () => {
		assert.ok(lanterna);
		assert.strictEqual(lanterna.projectName, 'lanterna');
		const i = n - 2;
		assert.strictEqual(lanterna.giorni.dl[i], 10);
		assert.strictEqual(lanterna.giorni.admob[i], 4);
		assert.strictEqual(lanterna.giorni.store[i], 4); // 2 USD a 2 per euro + 3 EUR
		assert.strictEqual(lanterna.acquisti.nuovi, 29, '30 giorni, ieri senza report');
	});

	await test('costruisci: «Store fino a», mesi dal report mensile o dai giorni, n/d quando Apple non lo da\' piu\'', () => {
		assert.strictEqual(s.storeFinoA, giorni[n - 2]);
		assert.strictEqual(lanterna.mesi.store[mesi.length - 3], 4);
		assert.strictEqual(lanterna.mesi.store[mesi.length - 1], 4, 'il mese in corso somma i giorni che ci sono');
		assert.deepStrictEqual(s.storeSenzaDati, [mesi[0]]);
	});

	await test('costruisci: la 1.1 di Lanterna e\' un\'uscita, nel giorno giusto', () => {
		assert.deepStrictEqual(lanterna.versioni, [{ v: '1.1', quando: giorni[n - 10] }]);
	});

	await test('costruisci: formati dei 30 giorni dai dati giornalieri', () => {
		const f = lanterna.formati.find(x => x.formato === 'interstitial');
		assert.strictEqual(f.richieste, 133 * 30);
		assert.strictEqual(f.abbinate, 130 * 30);
	});

	await test('costruisci: abbonamenti giorno per giorno, ricavi ricorrenti in euro, eventi', () => {
		const ab = lanterna.abbonamenti;
		assert.strictEqual(s.abbFinoA, giorni[n - 3]);
		assert.strictEqual(ab.attivi[n - 3], 16);
		assert.strictEqual(ab.mrr[n - 3], 16); // 12 EUR + 8 USD a 2 per euro
		assert.strictEqual(ab.eventi.disdette[n - 3], 2);
		assert.strictEqual(s.totale.abbonamenti.attivi[n - 3], 16);
	});

	await test('costruisci: la scheda fino all\'ultimo giorno con dati e le fonti dei 30 giorni', () => {
		assert.strictEqual(s.schedaFinoA, giorni[n - 4]);
		assert.strictEqual(lanterna.scheda.imp[n - 4], 100);
		assert.strictEqual(lanterna.scheda.fonti.ricerca.dl, 150);
	});

	const buchi = s.buchi;
	const ids = buchi.map(b => b.id);
	await test('buchi: interstitial caricati e non mostrati, con stima, misura, soglia e compito per Claude', () => {
		const b = buchi.find(x => x.id === 'ios:100:mostrati:interstitial');
		assert.ok(b, ids.join(', '));
		assert.strictEqual(b.gravita, 'alta');
		assert.strictEqual(b.tipo, 'mostrati');
		assert.strictEqual(b.fonte, 'admob');
		assert.strictEqual(b.soglia, 0.35);
		assert.ok(b.stima > 0);
		assert.ok(/ios-admob-integration/.test(b.compito));
	});

	await test('verifica: dopo la 1.1 i mostrati salgono ma restano sotto la soglia: «meglio»', () => {
		const v = buchi.find(x => x.id === 'ios:100:mostrati:interstitial').verifica;
		assert.ok(v, 'c\'e\' la verifica');
		assert.strictEqual(v.versione, '1.1');
		assert.strictEqual(v.esito, 'meglio');
		assert.ok(v.dopo > v.prima);
	});

	await test('buchi: con premio senza stima; riempimento, approvazione, UMP, SKAdNetwork, ID estranei; niente falso «altra app»', () => {
		const b = buchi.find(x => x.id === 'ios:100:mostrati:rewarded');
		assert.strictEqual(b.gravita, 'bassa');
		assert.strictEqual(b.stima, undefined);
		for (const id of ['ios:200:fill:banner', 'ios:200:approvazione', 'ios:100:ump', 'ios:100:skan', 'ios:100:estranee', 'ios:100:ferme']) assert.ok(ids.includes(id), id);
		assert.ok(!ids.includes('ios:100:altra-app'));
	});

	await test('buchi nuovi: ritardi di pagamento senza tolleranza, scheda che converte poco, pagina che non convince', () => {
		assert.ok(ids.includes('ios:100:tolleranza'), ids.join(', '));
		const c = buchi.find(x => x.id === 'ios:200:conversione');
		assert.ok(c, 'Bussola converte meno della meta\' della mediana');
		assert.strictEqual(c.fonte, 'scheda');
		assert.ok(ids.includes('ios:200:pagina'));
		assert.ok(!ids.includes('ios:300:conversione'));
	});

	await test('buchi: in cima le gravi, e nessuna lineetta lunga o media nei testi', () => {
		const peso = { alta: 0, media: 1, bassa: 2 };
		for (let i = 1; i < buchi.length; i++) assert.ok(peso[buchi[i - 1].gravita] <= peso[buchi[i].gravita]);
		for (const b of buchi) for (const k of ['titolo', 'perche', 'cosa', 'stimaNota', 'compito']) assert.ok(!/[\u2013\u2014]/.test(b[k] || ''), `${b.id}.${k}`);
	});

	await test('allarmi: un\'app che AdMob non approva piu\' e il crollo di ieri; prima delle 8 niente crollo', () => {
		const a = s.allarmiTrovati.map(x => x.id);
		assert.ok(a.includes('ios:200:approvazione:ACTION_REQUIRED'), a.join(', '));
		assert.ok(a.includes(`ios:100:crollo:${giorni[n - 1]}`));
		const presto = A.costruisci({ ...ingressi, now: new Date(2026, 9, 3, 6).getTime() });
		assert.ok(!presto.allarmiTrovati.some(x => x.id.includes(':crollo:')));
	});

	await test('misure: la quota attuale anche dei formati che non sono buchi', () => {
		assert.ok(Math.abs(s.misure['ios:100:fill:interstitial'] - 130 / 133) < 1e-9);
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
		assert.deepStrictEqual([r.ump, r.att, r.attRichiesta, r.skan], [true, true, true, 2]);
		assert.deepStrictEqual(r.idProva, ['App/Config.swift']);
		assert.deepStrictEqual(r.unita, [{ id: `ca-app-pub-${PUB}/0000000011`, piattaforma: 'ios' }]);
		assert.strictEqual(r.storekit, false, 'import StoreKit da solo non vuol dire acquisti in-app');
	});

	// ---------- il motore con fetch e radar finti ----------

	const dirMotore = path.join(tmp, 'motore');
	const env = path.join(tmp, 'asc.env');
	fs.writeFileSync(env, 'ASC_VENDOR_NUMBER=12345\n');
	const chiamate = [];
	const fetchFinto = async url => {
		const u = String(url);
		chiamate.push(u);
		if (u.includes('er-api')) return new Response(JSON.stringify({ result: 'success', rates: { USD: 2 } }), { status: 200 });
		if (u.startsWith('https://segmenti.invalid/')) {
			const csv = u.endsWith('scoperta')
				? tsv([{ Date: giorni[n - 4], Event: 'Impression', 'Source Type': 'App Store search', 'Unique Counts': '50' }], ['Date', 'Event', 'Page Type', 'Source Type', 'Counts', 'Unique Counts'])
				: tsv([{ Date: giorni[n - 4], 'Download Type': 'First-time download', 'Source Type': 'App Store search', Counts: '4' }], ['Date', 'Download Type', 'Source Type', 'Counts']);
			return new Response(zlib.gzipSync(csv), { status: 200 });
		}
		const tipo = /reportType\]=(\w+)/.exec(u)[1];
		const data = /reportDate\]=([\d-]+)/.exec(u)[1];
		const recente = data >= giorni[n - 1].slice(0, 7);
		if (data === giorni[n - 1] || (data.length === 7 && recente))
			return new Response(JSON.stringify({ errors: [{ status: '404', detail: 'There were no sales for the date specified.' }] }), { status: 404 });
		if (tipo === 'SUBSCRIPTION') return new Response(zlib.gzipSync(abbTipo()), { status: 200 });
		if (tipo === 'SUBSCRIPTION_EVENT') return new Response(zlib.gzipSync(eventiTipo), { status: 200 });
		return new Response(zlib.gzipSync(giornoTipo()), { status: 200 });
	};
	const creati = [];
	const radar = {
		ascJwt: () => 'jwt',
		asc: async (metodo, p, corpo) => {
			chiamate.push(p);
			if (p.startsWith('/apps?')) return { data: [{ id: '100', attributes: { name: 'Lanterna', bundleId: 'com.esempio.lanterna', sku: 'lanterna' } }] };
			if (p.includes('/analyticsReportRequests?')) return { data: [] };
			if (p === '/analyticsReportRequests' && metodo === 'POST') {
				creati.push(corpo.data.relationships.app.data.id);
				return { data: { id: 'req1' } };
			}
			if (p.includes('/reports?filter[name]=')) return { data: [{ id: p.includes('Discovery') ? 'rs' : 'rd' }] };
			if (p.includes('/instances')) return { data: [{ id: p.includes('/rs/') ? 'is1' : 'id1', attributes: { processingDate: giorni[n - 3] } }] };
			if (p.includes('/segments')) return { data: [{ attributes: { url: `https://segmenti.invalid/${p.includes('is1') ? 'scoperta' : 'download'}` } }] };
			throw new Error('chiamata inattesa ' + p);
		},
		admob: async (metodo, p) => {
			if (p === '/accounts') return { account: [{ name: `accounts/pub-${PUB}` }] };
			if (p.includes('/apps')) return { apps: [{ appId: `ca-app-pub-${PUB}~1`, platform: 'IOS', linkedAppInfo: { appStoreId: '100', displayName: 'Lanterna' }, appApprovalState: 'APPROVED' }] };
			if (p.includes('/adUnits')) return { adUnits: [] };
			return [{ header: {} }];
		},
	};
	let ora = NOW;
	const motore = () => new A.AppStore({ radar: () => radar, projects: () => [], dir: dirMotore, now: () => ora, fetch: fetchFinto, ascEnvFile: env });
	const as = motore();

	await test('AppStore.refresh: vendite, abbonamenti e scheda; la richiesta di analisi si crea se manca; file in 600', async () => {
		await as.refresh({ force: true });
		const st = as.state();
		assert.deepStrictEqual(st.errori, {});
		assert.deepStrictEqual(creati.sort(), ['100', '200'], 'le app con download: Lanterna e Bussola');
		const l = st.app.find(a => a.chiave === 'ios:100');
		assert.ok(l && l.abbonamenti && l.scheda);
		assert.strictEqual(l.scheda.imp[n - 4], 50);
		const cache = JSON.parse(fs.readFileSync(path.join(dirMotore, 'vendite.json'), 'utf8'));
		assert.strictEqual(cache.giorni[giorni[n - 1]], undefined, 'il vuoto di ieri si riprova');
		for (const f of ['vendite.json', 'stato.json', 'storia.json']) assert.strictEqual((fs.statSync(path.join(dirMotore, f)).mode & 0o777).toString(8), '600', f);
	});

	await test('AppStore: dopo un riavvio non rilegge prima di 45 minuti; con force solo i report mancanti', async () => {
		chiamate.length = 0;
		ora = NOW + 10 * 60_000;
		const dopo = motore();
		assert.ok(dopo.state().aggiornatoAt, 'lo stato salvato c\'e\' subito');
		await dopo.refresh();
		assert.strictEqual(chiamate.length, 0, 'nessuna chiamata entro 45 minuti dall\'ultima lettura');
		await dopo.refresh({ force: true });
		const vendite = chiamate.filter(u => u.includes('salesReports'));
		assert.ok(vendite.length <= 6, `solo i report mancanti, non ${vendite.length}`);
		assert.ok(!chiamate.some(u => u.includes('er-api')), 'i cambi si tengono un giorno');
		assert.ok(!chiamate.some(u => u.includes('/instances')), 'le istanze di analisi si ricontrollano ogni 6 ore');
	});

	await test('AppStore: ignora e ripristina aggiornano subito lo stato e restano dopo un riavvio', async () => {
		const id = as.state().buchi[0]?.id;
		assert.ok(id, 'c\'e\' almeno un buco');
		let visti = 0;
		as.onChange(() => visti++);
		assert.ok(as.ignora(id, 'deciso così'));
		assert.ok(visti > 0);
		assert.ok(!as.state().buchi.some(b => b.id === id));
		assert.strictEqual(as.state().ignorati[0].motivo, 'deciso così');
		assert.ok(motore().state().ignorati.some(b => b.id === id), 'dopo un riavvio');
		assert.ok(as.ripristina(id));
		assert.ok(as.state().buchi.some(b => b.id === id));
	});

	await test('AppStore: riassunto per Melissa e briefing', () => {
		const r = as.riassunto('settimana');
		assert.ok(/Negli ultimi sette giorni le app hanno reso/.test(r), r);
		assert.ok(/Abbonati che pagano: 16/.test(r), r);
		assert.ok(/Non trovo/.test(as.riassunto('mese', 'inesistente')));
		assert.ok(/Lanterna ha reso/.test(as.riassunto('ieri', 'lanterna')));
		const b = as.briefing();
		assert.ok(b && b.ieri === giorni[n - 1] && typeof b.settimana === 'number');
		assert.ok(!/[\u2013\u2014]/.test(r));
	});

	// ---------- la stanza ----------

	function stanza(saved = {}) {
		const dom = new JSDOM('<!doctype html><html lang="it"><body class="vscode-dark"><main id="app"></main></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://plancia.invalid/' });
		const w = dom.window;
		w.eval(fs.readFileSync(path.join(__dirname, '..', 'media', 'appstore.js'), 'utf8'));
		const posts = [];
		const salvati = [];
		const root = w.document.getElementById('app');
		const r = w.BottegaAppStore.mount(root, { post: m => posts.push(JSON.parse(JSON.stringify(m))), saved, save: o => salvati.push(JSON.parse(JSON.stringify(o))) });
		return { w, root, r, posts, salvati, $: q => root.querySelector(q), $$: q => [...root.querySelectorAll(q)] };
	}
	const { misure: _m, allarmiTrovati, approvazioni: _a, ...base } = s;
	const stato = (o = {}) => ({ ...base, risolti: [], ignorati: [], allarmi: [], aggiornatoAt: NOW, aggiornando: false, errori: {}, controlloOre: 3, ...o });

	await test('stanza: monta, frase, buchi, app, ora precisa e ricontrollo; periodo e «Sistema con Claude»', () => {
		const t = stanza();
		t.r.show();
		assert.deepStrictEqual(t.posts[0], { type: 'appstore.request' });
		t.r.message({ type: 'appstore', state: stato() });
		assert.ok(/Negli ultimi 30 giorni le app hanno reso/.test(t.$('#aps-frase').textContent));
		assert.ok(/Aggiornati .* alle \d\d:\d\d/.test(t.$('#aps-timbro').textContent), t.$('#aps-timbro').textContent);
		assert.ok(/ogni 3 ore/.test(t.$('#aps-timbro').textContent));
		assert.strictEqual(t.$$('#aps-guadagni path.aps-m-admob').length, 30);
		assert.ok(!/[\u2013\u2014]/.test(t.root.textContent), 'niente lineette lunghe o medie');
		t.$('[data-a="periodo"][data-v="anno"]').click();
		assert.strictEqual(t.salvati[t.salvati.length - 1].periodo, 'anno');
		assert.strictEqual(t.$$('#aps-guadagni path.aps-m-admob').length, 12);
		const claude = t.$('[data-a="claude"]');
		claude.focus();
		claude.click();
		const job = t.posts.find(m => m.type === 'job.prepare');
		assert.ok(job && job.path === '/p/lanterna' && job.task.length > 20);
		t.r.message({ type: 'appstore', state: stato({ aggiornando: true, fase: 'Leggo AdMob' }) });
		assert.strictEqual(t.w.document.activeElement.getAttribute('data-a'), 'claude', 'l\'aggiornamento non perde il fuoco');
		assert.ok(t.$('[data-a="aggiorna"]').disabled);
	});

	await test('stanza: un\'app scelta mostra le sue serie e la tacca della versione uscita', () => {
		const t = stanza({ periodo: 'mese' });
		t.r.show();
		t.r.message({ type: 'appstore', state: stato() });
		assert.strictEqual(t.$$('.aps-tacca').length, 0, 'con tutte le app niente tacche');
		const sel = t.$('#aps-app-scelta');
		sel.value = 'ios:100';
		sel.dispatchEvent(new t.w.Event('change', { bubbles: true }));
		assert.strictEqual(t.salvati[t.salvati.length - 1].app, 'ios:100');
		assert.strictEqual(t.$$('#aps-guadagni .aps-tacca').length, 1);
		assert.ok(t.$('#aps-guadagni').textContent.includes('1.1'));
		assert.ok(/Lanterna ha reso/.test(t.$('#aps-frase').textContent));
		assert.strictEqual(t.$('#aps-leg-versione').hidden, false);
	});

	await test('stanza: «Ignora» chiede il motivo nella pagina e manda appstore.ignora; Ripristina; risolti in fondo', () => {
		const t = stanza();
		t.r.show();
		const risolto = { id: 'ios:9:ump', chiave: 'ios:9', app: 'Vecchia', titolo: 'Manca il consenso', quando: NOW - 86_400_000, daQuando: NOW - 5 * 86_400_000 };
		t.r.message({ type: 'appstore', state: stato({ risolti: [risolto] }) });
		const primo = t.$('.aps-buco [data-a="ignora"]');
		const id = primo.getAttribute('data-v');
		primo.click();
		const input = t.$('#aps-motivo');
		assert.ok(input, 'il campo del motivo');
		assert.strictEqual(t.w.document.activeElement, input);
		input.value = 'lo lascio così';
		input.dispatchEvent(new t.w.Event('input', { bubbles: true }));
		t.r.message({ type: 'appstore', state: stato({ risolti: [risolto] }) });
		assert.strictEqual(t.$('#aps-motivo').value, 'lo lascio così', 'un aggiornamento non cancella il motivo');
		t.$('form[data-ignora]').dispatchEvent(new t.w.Event('submit', { bubbles: true, cancelable: true }));
		assert.deepStrictEqual(t.posts.find(m => m.type === 'appstore.ignora'), { type: 'appstore.ignora', id, motivo: 'lo lascio così' });
		assert.ok(!t.$$('.aps-buco [data-a="ignora"]').some(b => b.getAttribute('data-v') === id), 'sparisce subito');
		assert.ok(t.$('#aps-chiusi').textContent.includes('Ignorati: 1'));
		assert.ok(t.$('#aps-chiusi').textContent.includes('Risolti negli ultimi 60 giorni: 1'));
		t.$('[data-a="ripristina"]').click();
		assert.deepStrictEqual(t.posts[t.posts.length - 1], { type: 'appstore.ripristina', id });
	});

	await test('stanza: verifica dopo la versione, abbonamenti, scheda, allarmi in cima', () => {
		const t = stanza();
		t.r.show();
		t.r.message({ type: 'appstore', state: stato({ allarmi: [{ id: 'x', chiave: 'ios:100', app: 'Lanterna', testo: 'AdMob ieri 0,5 €', at: NOW }] }) });
		assert.ok(/Dalla 1\.1 .*Meglio, ma ancora sotto il 35%/.test(t.$('#aps-buchi').textContent), t.$('#aps-buchi').textContent.slice(0, 400));
		assert.strictEqual(t.$('#aps-ab-sez').hidden, false);
		assert.ok(t.$('#aps-ab-cifre').textContent.includes('16'));
		assert.strictEqual(t.$('#aps-s-sez').hidden, false);
		assert.ok(t.$('#aps-s-fonti').textContent.includes('Ricerca'));
		assert.strictEqual(t.$('#aps-allarmi').hidden, false);
		assert.ok(t.$('#aps-allarmi').textContent.includes('Lanterna'));
		assert.ok(!/[\u2013\u2014]/.test(t.root.textContent));
	});

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
