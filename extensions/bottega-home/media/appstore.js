/* Bottega, la stanza App Store: quanto rendono le app (AdMob e Store) per settimana, mese e anno, app per app,
   abbonamenti, scheda dello Store, e dove intervenire. I dati li prepara l'estensione (src/appstore.ts); i messaggi
   appstore.* e la forma dello stato sono in docs/CONTRATTI.md, sezione 13.

   Due serie con il loro colore fisso, sempre nello stesso ordine: AdMob (ambra della lampada) e Store (la luce
   fredda della notte). Coppia verificata con il validatore della palette sui due fondi, scuro e chiaro. Le altre
   misure (download, abbonati, impressioni) sono una serie sola: colore neutro e il titolo che le nomina.
   Ogni grafico ha la legenda (quando ha due serie) e il suggerimento al passaggio del mouse; le tabelle sono la sua
   versione a righe. I testi stanno sempre nell'inchiostro del testo, mai nel colore della serie.
   Regole: niente librerie, niente attributi style (la CSP li blocca; element.style va bene), testo dei dati sempre
   sfuggito, aggiornamenti che rimettono il fuoco dov'era (data-fk), niente finestre di dialogo del browser. */
(function () {
	'use strict';

	const MESI_B = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
	const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
	const GIORNI_B = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
	const GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
	const PERIODI = [
		['settimana', 'Settimana', 7],
		['mese', 'Mese', 30],
		['anno', 'Anno', 12],
	];
	const GRAVITA = { alta: 'subito', media: 'da sistemare', bassa: 'quando puoi' };
	const FORMATO = { banner: 'banner', interstitial: 'interstitial', rewarded: 'con premio', rewarded_interstitial: 'interstitial con premio', app_open: "all'apertura", native: 'nativo' };
	const EVENTI = [
		['prove', 'prove iniziate'],
		['conversioni', 'prove diventate a pagamento'],
		['nuovi', 'abbonamenti nuovi'],
		['rinnovi', 'rinnovi'],
		['disdette', 'rinnovi spenti'],
		['rimborsi', 'rimborsi'],
		['ritorni', 'tornati'],
	];

	const esc = s =>
		String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	const it = (n, d = 0) => Number(n || 0).toLocaleString('it-IT', { maximumFractionDigits: d, minimumFractionDigits: d });
	const somma = a => a.reduce((s, x) => s + (x || 0), 0);
	const pct = n => `${Math.round(n * 100)}%`;
	const pctFine = n => `${(n * 100).toLocaleString('it-IT', { maximumFractionDigits: n < 0.1 ? 1 : 0 })}%`;
	const fmtEuro = new Map();
	function euro(n, dec) {
		const v = Number(n || 0);
		const d = dec ?? (Math.abs(v) < 100 ? 2 : 0);
		let f = fmtEuro.get(d);
		if (!f) {
			try {
				f = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: d, maximumFractionDigits: d });
			} catch {
				f = { format: x => `${it(x, d)} €` };
			}
			fmtEuro.set(d, f);
		}
		return f.format(v);
	}
	let paesi;
	function paese(c) {
		try {
			paesi = paesi || new Intl.DisplayNames(['it'], { type: 'region' });
			return paesi.of(c) || c;
		} catch {
			return c;
		}
	}
	const giorno = d => new Date(d + 'T12:00:00');
	const giornoCorto = d => {
		const x = giorno(d);
		return `${GIORNI_B[x.getDay()]} ${x.getDate()}`;
	};
	const giornoLungo = d => {
		const x = giorno(d);
		return `${GIORNI[x.getDay()]} ${x.getDate()} ${MESI[x.getMonth()]}`;
	};
	const giornoBreve = d => {
		const x = giorno(d);
		return `${x.getDate()} ${MESI_B[x.getMonth()]}`;
	};
	const meseCorto = m => MESI_B[Number(m.slice(5, 7)) - 1];
	const meseLungo = m => `${MESI[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

	function fa(t) {
		if (!t) return 'mai';
		const m = Math.max(0, (Date.now() - t) / 60_000);
		if (m < 2) return 'adesso';
		if (m < 60) return `${Math.round(m)} min fa`;
		const h = m / 60;
		if (h < 24) return `${Math.round(h)} h fa`;
		const d = Math.round(h / 24);
		return d === 1 ? 'ieri' : `${d} giorni fa`;
	}
	/** «oggi alle 00:31», «ieri alle 22:10», «2 ott alle 9:05» */
	function allOra(t) {
		const d = new Date(t);
		const oggi = new Date();
		const ora = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
		if (d.toDateString() === oggi.toDateString()) return `oggi alle ${ora}`;
		const ieri = new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate() - 1);
		if (d.toDateString() === ieri.toDateString()) return `ieri alle ${ora}`;
		return `${d.getDate()} ${MESI_B[d.getMonth()]} alle ${ora}`;
	}
	const giorniDa = t => Math.max(0, Math.round((Date.now() - t) / 86_400_000));

	/** «+12% su prima», «come prima», «prima: n/d»: la variazione, a parole e senza colori. */
	function delta(ora, prima, disp = true) {
		if (!disp) return '<span class="delta muto">prima: n/d</span>';
		if (!prima && !ora) return '<span class="delta muto">come prima</span>';
		if (!prima) return '<span class="delta nuovo">prima: zero</span>';
		const v = (ora - prima) / Math.abs(prima);
		if (Math.abs(v) < 0.02) return '<span class="delta">come prima</span>';
		return `<span class="delta">${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}% su prima</span>`;
	}

	/** Barra con l'estremita' dei dati arrotondata (4px) e la base dritta sulla linea di fondo. */
	function barra(x, y, w, h, r) {
		if (h <= 0) return '';
		const rr = Math.min(r, w / 2, h);
		return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
	}

	/** Un passo "tondo" per l'asse: 1, 2, 5 per potenze di dieci. */
	function passo(max, righe = 3) {
		const grezzo = max / righe;
		const p = Math.pow(10, Math.floor(Math.log10(grezzo || 1)));
		for (const k of [1, 2, 5, 10]) if (k * p >= grezzo) return k * p;
		return 10 * p;
	}

	function mount(root, host) {
		const post = m => host && host.post && host.post(m);
		const saved = (host && host.saved) || {};
		const ui = {
			periodo: PERIODI.some(p => p[0] === saved.periodo) ? saved.periodo : 'mese',
			aperte: new Set(Array.isArray(saved.aperte) ? saved.aperte : []),
			filtro: saved.filtro === 'subito' || saved.filtro === 'stima' ? saved.filtro : 'tutti',
			/** L'app scelta per i grafici ('' = tutte). */
			app: typeof saved.app === 'string' ? saved.app : '',
			tutti: false,
			/** Il buco per cui si sta scrivendo il motivo di «Ignora». */
			ignorando: '',
			motivo: '',
		};
		/** @type {any} */ let st = null;
		let visible = false;
		let chiesto = 0;
		const doc = root.ownerDocument;

		const save = () => host && host.save && host.save({ periodo: ui.periodo, aperte: [...ui.aperte].slice(-20), filtro: ui.filtro, app: ui.app });

		root.innerHTML = `
		<div class="aps" id="aps">
			<div class="aps-testa">
				<h1 class="sentence media aps-frase" id="aps-frase">Sto leggendo AdMob e App Store Connect.</h1>
				<p class="invito aps-sotto" id="aps-sotto"></p>
			</div>
			<p class="aps-timbro" id="aps-timbro"></p>
			<ul class="aps-allarmi" id="aps-allarmi" aria-label="Allarmi" hidden></ul>
			<div class="aps-filtri">
				<div class="interruttori" role="group" aria-label="Periodo" id="aps-periodi"></div>
				<label class="aps-scelta"><span>App</span><select id="aps-app-scelta" data-fk="app-scelta"></select></label>
			</div>
			<dl class="cifre aps-cifre" id="aps-cifre"></dl>
			<section class="aps-sez" aria-labelledby="aps-g-titolo">
				<div class="sez-testa aps-sez-testa">
					<h2 id="aps-g-titolo">Guadagni</h2>
					<ul class="aps-legenda" aria-label="Legenda">
						<li><i class="aps-q aps-q-admob" aria-hidden="true"></i>AdMob</li>
						<li><i class="aps-q aps-q-store" aria-hidden="true"></i>Store</li>
						<li class="aps-leg-versione" id="aps-leg-versione" hidden><i class="aps-tacca-leg" aria-hidden="true"></i>versione uscita</li>
					</ul>
				</div>
				<div class="aps-grafico" id="aps-guadagni"></div>
			</section>
			<section class="aps-sez" aria-labelledby="aps-d-titolo">
				<div class="sez-testa aps-sez-testa"><h2 id="aps-d-titolo">Download</h2></div>
				<div class="aps-grafico aps-grafico-basso" id="aps-download"></div>
			</section>
			<section class="aps-sez" aria-labelledby="aps-b-titolo">
				<div class="sez-testa aps-sez-testa">
					<h2 id="aps-b-titolo">Dove intervenire</h2>
					<div class="interruttori" role="group" aria-label="Quali mostrare" id="aps-filtro"></div>
				</div>
				<p class="aps-nota" id="aps-b-nota"></p>
				<ol class="aps-buchi" id="aps-buchi"></ol>
				<p class="aps-altri" id="aps-altri"></p>
				<div id="aps-chiusi"></div>
			</section>
			<section class="aps-sez" aria-labelledby="aps-ab-titolo" id="aps-ab-sez" hidden>
				<div class="sez-testa aps-sez-testa"><h2 id="aps-ab-titolo">Abbonamenti</h2></div>
				<p class="aps-nota" id="aps-ab-nota"></p>
				<dl class="cifre aps-cifre" id="aps-ab-cifre"></dl>
				<div class="aps-grafico aps-grafico-basso" id="aps-ab-grafico"></div>
				<ul class="aps-eventi" id="aps-ab-eventi"></ul>
				<div class="aps-tabella aps-tab-piccola" role="table" aria-label="Abbonamenti per app" id="aps-ab-app"></div>
			</section>
			<section class="aps-sez" aria-labelledby="aps-s-titolo" id="aps-s-sez" hidden>
				<div class="sez-testa aps-sez-testa"><h2 id="aps-s-titolo">La scheda dello Store</h2></div>
				<p class="aps-nota" id="aps-s-nota"></p>
				<dl class="cifre aps-cifre" id="aps-s-cifre"></dl>
				<h3 class="aps-h3">Da dove arrivano i download</h3>
				<ol class="aps-paesi aps-fonti" id="aps-s-fonti"></ol>
				<div class="aps-tabella aps-tab-piccola" role="table" aria-label="La scheda per app" id="aps-s-app"></div>
			</section>
			<section class="aps-sez" aria-labelledby="aps-a-titolo">
				<div class="sez-testa aps-sez-testa"><h2 id="aps-a-titolo">App per app</h2></div>
				<div class="aps-tabella" role="table" aria-labelledby="aps-a-titolo" id="aps-app"></div>
			</section>
			<section class="aps-sez" aria-labelledby="aps-p-titolo">
				<div class="sez-testa aps-sez-testa"><h2 id="aps-p-titolo">Dove rende AdMob</h2></div>
				<p class="aps-nota">Ultimi 30 giorni, tutti i paesi delle tue app insieme.</p>
				<ol class="aps-paesi" id="aps-paesi"></ol>
			</section>
			<p class="aps-nota aps-come" id="aps-come"></p>
			<div class="aps-tip" id="aps-tip" role="status" aria-live="polite" hidden></div>
		</div>`;
		const $ = id => root.querySelector('#' + id);

		const pronto = () => st && st.giorni && st.giorni.length;
		/** L'app scelta per grafici e cifre, o null (tutte). */
		const scelta = () => (ui.app && st && st.app ? st.app.find(a => a.chiave === ui.app) || null : null);
		const serie = () => scelta() || st.totale;

		// ---------- il periodo ----------

		/** Le serie del periodo scelto: valori, etichette, e lo stesso tratto subito prima per il confronto. */
		function finestra(s) {
			if (ui.periodo === 'anno') {
				const n = st.mesi.length;
				const da = Math.max(0, n - 12);
				const etich = st.mesi.slice(da);
				const persi = new Set(st.storeSenzaDati || []);
				return {
					tipo: 'mesi',
					date: etich,
					admob: s.mesi.admob.slice(da),
					store: s.mesi.store.slice(da),
					dl: s.mesi.dl.slice(da),
					admobPrima: s.mesi.admob.slice(Math.max(0, da - 12), da),
					storePrima: s.mesi.store.slice(Math.max(0, da - 12), da),
					dlPrima: s.mesi.dl.slice(Math.max(0, da - 12), da),
					storeManca: etich.map(m => persi.has(m)),
					primaStoreDisp: !st.mesi.slice(Math.max(0, da - 12), da).some(m => persi.has(m)),
				};
			}
			const k = ui.periodo === 'settimana' ? 7 : 30;
			const n = st.giorni.length;
			const etich = st.giorni.slice(n - k);
			const fino = st.storeFinoA || '';
			return {
				tipo: 'giorni',
				date: etich,
				admob: s.giorni.admob.slice(n - k),
				store: s.giorni.store.slice(n - k),
				dl: s.giorni.dl.slice(n - k),
				admobPrima: s.giorni.admob.slice(n - 2 * k, n - k),
				storePrima: s.giorni.store.slice(n - 2 * k, n - k),
				dlPrima: s.giorni.dl.slice(n - 2 * k, n - k),
				storeManca: etich.map(d => !fino || d > fino),
				primaStoreDisp: true,
			};
		}

		/** Le uscite di versione dentro la finestra, per l'app scelta. */
		function versioniIn(w) {
			const a = scelta();
			if (!a) return new Map();
			const l = w.tipo === 'mesi' ? a.versioniMesi || [] : a.versioni || [];
			const out = new Map();
			for (const v of l) {
				const i = w.date.indexOf(v.quando);
				if (i >= 0) out.set(i, (out.get(i) ? out.get(i) + ', ' : '') + v.v);
			}
			return out;
		}

		const etichettaPeriodo = () => (ui.periodo === 'settimana' ? 'Negli ultimi 7 giorni' : ui.periodo === 'mese' ? 'Negli ultimi 30 giorni' : 'Negli ultimi 12 mesi');
		const kGiorni = () => (ui.periodo === 'settimana' ? 7 : 30);

		// ---------- testa ----------

		function renderTesta() {
			const frase = $('aps-frase');
			const sotto = $('aps-sotto');
			if (!pronto()) {
				frase.textContent = st && st.aggiornando ? 'Sto leggendo AdMob e App Store Connect.' : 'Non ho ancora letto i numeri delle app.';
				sotto.textContent =
					st && st.aggiornando ? 'La prima volta scarico un anno di vendite, gli abbonamenti e le schede dello Store: ci vuole un minuto o due.' : 'Premi «Aggiorna» per leggerli.';
				return;
			}
			const a0 = scelta();
			const w = finestra(serie());
			const a = somma(w.admob);
			const s = somma(w.store.filter((_, i) => !w.storeManca[i]));
			const tot = a + s;
			const prima = somma(w.admobPrima) + somma(w.storePrima);
			let var_ = '';
			if (prima > 0 && w.primaStoreDisp) {
				const v = (tot - prima) / prima;
				var_ = Math.abs(v) < 0.03 ? ' Come nel periodo prima.' : ` Il ${Math.round(Math.abs(v) * 100)}% ${v > 0 ? 'in più' : 'in meno'} del periodo prima.`;
			}
			frase.innerHTML = `${etichettaPeriodo()} ${a0 ? esc(a0.nome) + ' ha' : 'le app hanno'} reso <span class="n">${esc(euro(tot, 0))}</span>, ${esc(euro(a, 0))} da AdMob e ${esc(euro(s, 0))} dallo Store.${esc(var_)}`;
			const buchi = (st.buchi || []).filter(b => !a0 || b.chiave === a0.chiave);
			const subito = buchi.filter(b => b.gravita === 'alta');
			const conStima = buchi.filter(b => b.stima);
			const valore = somma(conStima.map(b => b.stima));
			if (!buchi.length) sotto.textContent = 'Non vedo buchi: annunci, consenso e codice sono in ordine.';
			else {
				const primo = conStima.slice().sort((x, y) => y.stima - x.stima)[0];
				sotto.textContent =
					`${subito.length ? `${subito.length === 1 ? 'Una cosa da sistemare' : `${subito.length} cose da sistemare`} subito` : 'Niente di urgente'}` +
					`${buchi.length > subito.length ? `, ${buchi.length - subito.length} quando puoi` : ''}.` +
					(valore >= 1 ? ` Quelle che si possono stimare valgono circa ${euro(valore, 0)} al mese; la più grossa è su ${primo.app} (${euro(primo.stima, 0)}).` : '');
			}
		}

		function renderTimbro() {
			const el = $('aps-timbro');
			const parti = [];
			if (st && st.aggiornatoAt) parti.push(`<span>Aggiornati ${esc(allOra(st.aggiornatoAt))} (${esc(fa(st.aggiornatoAt))})</span>`);
			if (st && st.storeFinoA) parti.push(`<span>Store fino a ${esc(giornoLungo(st.storeFinoA))}</span>`);
			if (st) parti.push(`<span>${st.controlloOre ? `Ricontrollo da solo ogni ${st.controlloOre === 1 ? 'ora' : `${it(st.controlloOre)} ore`}` : 'Rileggo solo quando apri la stanza'}</span>`);
			if (st && st.aggiornando) parti.push(`<span class="aps-fase">${esc(st.fase || 'Aggiorno')}…</span>`);
			parti.push(`<button type="button" class="ghost" data-a="aggiorna" data-fk="aggiorna" ${st && st.aggiornando ? 'disabled' : ''}>Aggiorna</button>`);
			const err = st && st.errori ? Object.entries(st.errori).filter(([, v]) => v) : [];
			for (const [, v] of err) parti.push(`<span class="aps-errore">${esc(v)}</span>`);
			el.setAttribute('aria-busy', st && st.aggiornando ? 'true' : 'false');
			el.innerHTML = parti.join('');
		}

		function renderAllarmi() {
			const el = $('aps-allarmi');
			const l = (st && st.allarmi) || [];
			el.hidden = !l.length;
			el.innerHTML = l
				.map(a => `<li><span class="aps-segno aps-segno-alta" aria-hidden="true"></span><span><b>${esc(a.app)}</b> ${esc(a.testo)} <small>${esc(fa(a.at))}</small></span></li>`)
				.join('');
		}

		function renderFiltri() {
			$('aps-periodi').innerHTML = PERIODI.map(
				([id, l]) => `<button type="button" data-a="periodo" data-v="${id}" data-fk="p:${id}" aria-pressed="${ui.periodo === id}">${l}</button>`,
			).join('');
			const sel = $('aps-app-scelta');
			const app = (st && st.app) || [];
			if (ui.app && !app.some(a => a.chiave === ui.app)) ui.app = '';
			sel.innerHTML = `<option value="">Tutte le app</option>${app.map(a => `<option value="${esc(a.chiave)}"${a.chiave === ui.app ? ' selected' : ''}>${esc(a.nome)}</option>`).join('')}`;
			sel.value = ui.app;
		}

		function renderCifre() {
			const el = $('aps-cifre');
			if (!pronto()) {
				el.innerHTML = '';
				return;
			}
			const w = finestra(serie());
			const a = somma(w.admob);
			const s = somma(w.store.filter((_, i) => !w.storeManca[i]));
			const d = somma(w.dl);
			const notaStore = w.storeManca.some(Boolean)
				? ui.periodo === 'anno'
					? 'senza i mesi che Apple non dà più'
					: `fino a ${esc(giornoLungo(st.storeFinoA || w.date[0]))}`
				: 'ricavi netti, dopo la quota di Apple';
			el.innerHTML =
				cifra('Totale', esc(euro(a + s, 0)), delta(a + s, somma(w.admobPrima) + somma(w.storePrima), w.primaStoreDisp)) +
				cifra('AdMob', esc(euro(a, 0)), delta(a, somma(w.admobPrima)), 'stima di AdMob') +
				cifra('Store', esc(euro(s, 0)), delta(s, somma(w.storePrima), w.primaStoreDisp), notaStore) +
				cifra('Download', esc(it(d)), delta(d, somma(w.dlPrima), w.primaStoreDisp), 'nuovi, senza aggiornamenti');
		}
		const cifra = (dt, valore, dlt, nota) => `<div class="cifra"><dt>${dt}</dt><dd><b class="lettura">${valore}</b>${dlt}${nota ? `<small>${nota}</small>` : ''}</dd></div>`;

		// ---------- grafici ----------

		const W = 720;

		/** Un grafico a barre: una o due serie impilate, l'asse, le etichette, le tacche delle versioni, le zone di
		 *  passaggio del mouse. `fmt` scrive i valori dell'asse. */
		function barre({ id, date, tipo, serieA, serieB, manca, H, fmt, versioni, etichetta }) {
			const top = 14;
			const base = H - 24;
			const sx = 48;
			const n = date.length;
			const valori = date.map((_, i) => (serieA[i] || 0) + (serieB && !(manca && manca[i]) ? serieB[i] || 0 : 0));
			const max = Math.max(1, ...valori);
			const p = passo(max, H > 150 ? 3 : 2);
			const tetto = Math.ceil(max / p) * p;
			const y = v => base - (v / tetto) * (base - top);
			const larg = (W - sx) / n;
			const bw = Math.max(3, Math.min(34, larg * 0.62));
			let svg = '';
			for (let v = 0; v <= tetto + 1e-9; v += p) {
				svg += `<line class="aps-griglia${v === 0 ? ' aps-base' : ''}" x1="${sx}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
				svg += `<text class="aps-asse" x="${sx - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v, p))}</text>`;
			}
			const ogni = n > 14 ? 5 : 1;
			for (let i = 0; i < n; i++) {
				const cx = sx + i * larg + larg / 2;
				if (versioni && versioni.has(i)) {
					svg += `<line class="aps-tacca" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${top - 6}" y2="${base}"/>`;
					svg += `<text class="aps-asse aps-tacca-testo" x="${cx.toFixed(1)}" y="${top - 8}" text-anchor="middle">${esc(versioni.get(i).split(',')[0])}</text>`;
				}
				const x = sx + i * larg + (larg - bw) / 2;
				const ha = ((serieA[i] || 0) / tetto) * (base - top);
				const hs = serieB && !(manca && manca[i]) ? ((serieB[i] || 0) / tetto) * (base - top) : 0;
				const gap = ha > 0 && hs > 0 ? 2 : 0;
				const clA = serieB ? 'aps-m-admob' : 'aps-m-una';
				if (hs > 0) {
					svg += `<path class="${clA}" d="${barra(x, base - ha, bw, ha, 0)}"/>`;
					svg += `<path class="aps-m-store" d="${barra(x, base - ha - gap - hs, bw, hs, 4)}"/>`;
				} else svg += `<path class="${clA}" d="${barra(x, base - ha, bw, ha, 4)}"/>`;
				if (manca && manca[i] && tipo === 'mesi' && serieB) svg += `<text class="aps-asse aps-nd" x="${cx.toFixed(1)}" y="${(base - ha - 6).toFixed(1)}" text-anchor="middle">n/d</text>`;
				if (i % ogni === (n - 1) % ogni) {
					const l = tipo === 'mesi' ? meseCorto(date[i]) : n > 7 ? String(giorno(date[i]).getDate()) : giornoCorto(date[i]);
					svg += `<text class="aps-asse" x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`;
				}
				svg += `<rect class="aps-hit" data-i="${i}" data-g="${id}" x="${(sx + i * larg).toFixed(1)}" y="${top}" width="${larg.toFixed(1)}" height="${base - top}"/>`;
			}
			return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(etichetta)}">${svg}</svg>`;
		}

		function renderGrafici() {
			const g = $('aps-guadagni');
			const d = $('aps-download');
			if (!pronto()) {
				g.innerHTML = d.innerHTML = '';
				return;
			}
			const a = scelta();
			const w = finestra(serie());
			const versioni = versioniIn(w);
			$('aps-leg-versione').hidden = !versioni.size;
			const chi = a ? a.nome : 'tutte le app';
			g.innerHTML = barre({
				id: 'guadagni', date: w.date, tipo: w.tipo, serieA: w.admob, serieB: w.store, manca: w.storeManca, H: 200, versioni,
				fmt: (v, p) => `${it(v, p < 1 ? 1 : 0)} €`, etichetta: `Guadagni di ${chi} ${etichettaPeriodo().toLowerCase()}, AdMob e Store, in euro`,
			});
			d.innerHTML = barre({
				id: 'download', date: w.date, tipo: w.tipo, serieA: w.dl.map((x, i) => (w.storeManca[i] ? 0 : x)), H: 124, versioni,
				fmt: v => it(v), etichetta: `Download di ${chi} ${etichettaPeriodo().toLowerCase()}`,
			});
		}

		/** Il suggerimento sopra la barra: data, valori, la versione uscita quel giorno. */
		function tip(target) {
			const el = $('aps-tip');
			if (!target || !st) {
				el.hidden = true;
				return;
			}
			const i = Number(target.getAttribute('data-i'));
			const g = target.getAttribute('data-g');
			let righe = '';
			let quando = '';
			if (g === 'abbonati') {
				const w = finestraAbb();
				if (!w) return;
				quando = giornoLungo(w.date[i]);
				righe = `<span>${esc(it(w.attivi[i]))} abbonati che pagano</span><span>${esc(it(w.prove[i]))} in prova</span>`;
			} else {
				const w = finestra(serie());
				const d = w.date[i];
				quando = w.tipo === 'mesi' ? meseLungo(d) : giornoLungo(d);
				const manca = w.storeManca[i];
				const testoStore = manca ? (w.tipo === 'mesi' ? 'Apple non dà più questo mese' : 'non ancora pubblicato da Apple') : euro(w.store[i]);
				righe =
					g === 'download'
						? `<span>${manca ? 'Download: non ancora pubblicati' : `${esc(it(w.dl[i]))} download`}</span>`
						: `<span><i class="aps-q aps-q-admob" aria-hidden="true"></i>AdMob ${esc(euro(w.admob[i]))}</span><span><i class="aps-q aps-q-store" aria-hidden="true"></i>Store ${esc(testoStore)}</span>${manca ? '' : `<span>Totale ${esc(euro(w.admob[i] + w.store[i]))}</span>`}`;
				const v = versioniIn(w).get(i);
				if (v) righe += `<span>Uscita la versione ${esc(v)}</span>`;
			}
			el.innerHTML = `<b>${esc(quando)}</b>${righe}`;
			el.hidden = false;
			const box = root.querySelector('.aps').getBoundingClientRect();
			const r = target.getBoundingClientRect();
			const tw = el.offsetWidth;
			let left = r.left - box.left + r.width / 2 - tw / 2;
			left = Math.max(0, Math.min(box.width - tw, left));
			el.style.left = `${left}px`;
			el.style.top = `${r.top - box.top - el.offsetHeight - 6}px`;
		}

		// ---------- i buchi ----------

		function filtrati() {
			const a0 = scelta();
			const b = ((st && st.buchi) || []).filter(x => !a0 || x.chiave === a0.chiave);
			if (ui.filtro === 'subito') return b.filter(x => x.gravita === 'alta');
			if (ui.filtro === 'stima') return b.filter(x => x.stima).sort((x, y) => y.stima - x.stima);
			return b;
		}

		function renderFiltroBuchi() {
			const a0 = scelta();
			const b = ((st && st.buchi) || []).filter(x => !a0 || x.chiave === a0.chiave);
			const voci = [
				['tutti', `Tutti ${b.length}`],
				['subito', `Subito ${b.filter(x => x.gravita === 'alta').length}`],
				['stima', `Con una stima ${b.filter(x => x.stima).length}`],
			];
			$('aps-filtro').innerHTML = voci
				.map(([id, l]) => `<button type="button" data-a="filtro" data-v="${id}" data-fk="f:${id}" aria-pressed="${ui.filtro === id}">${esc(l)}</button>`)
				.join('');
		}

		/** Prima e dopo l'ultima versione, a parole. */
		function testoVerifica(b) {
			const v = b.verifica;
			if (!v) return '';
			const q = x => pct(x);
			const quando = giornoBreve(v.giorno);
			if (v.esito === 'risolto') return `Dalla ${v.versione} (${quando}): ${q(v.dopo)}, prima ${q(v.prima)}. Sembra risolto: la media dei 30 giorni lo confermerà.`;
			if (v.esito === 'meglio') return `Dalla ${v.versione} (${quando}): dal ${q(v.prima)} al ${q(v.dopo)}. Meglio, ma ancora sotto il ${q(b.soglia)}.`;
			if (v.esito === 'uguale') return `Dalla ${v.versione}, uscita ${v.giorniDopo} giorni fa, non è cambiato niente: ${q(v.dopo)}, prima ${q(v.prima)}.`;
			return `La ${v.versione} è uscita da ${v.giorniDopo} ${v.giorniDopo === 1 ? 'giorno' : 'giorni'}: finora ${q(v.dopo)}, prima ${q(v.prima)}.`;
		}

		function voceBuco(b, i) {
			const azioni = [];
			if (b.compito && b.projectPath) azioni.push(`<button type="button" class="act piccolo main" data-a="claude" data-i="${i}" data-fk="c:${esc(b.id)}">Sistema con Claude</button>`);
			if (b.projectPath) azioni.push(`<button type="button" class="act piccolo" data-a="apri" data-path="${esc(b.projectPath)}" data-fk="o:${esc(b.id)}">Apri il progetto</button>`);
			azioni.push(`<button type="button" class="act piccolo" data-a="ignora" data-v="${esc(b.id)}" data-fk="ig:${esc(b.id)}" aria-expanded="${ui.ignorando === b.id}">Ignora</button>`);
			const da = b.daQuando ? giorniDa(b.daQuando) : null;
			const verifica = testoVerifica(b);
			const modulo =
				ui.ignorando === b.id
					? `<form class="aps-ignora" data-ignora="${esc(b.id)}">
						<label for="aps-motivo">Perché lo lasci così</label>
						<input type="text" id="aps-motivo" data-fk="motivo" maxlength="300" placeholder="Per esempio: gli annunci con premio li offro solo a chi li vuole" value="${esc(ui.motivo)}">
						<span class="aps-azioni"><button type="submit" class="act piccolo main" data-fk="ig-ok">Ignora</button><button type="button" class="act piccolo" data-a="ignora-annulla" data-fk="ig-no">Annulla</button></span>
					</form>`
					: '';
			return `<li class="aps-buco aps-g-${b.gravita}">
				<span class="aps-segno" aria-hidden="true"></span>
				<div class="aps-buco-corpo">
					<p class="aps-buco-testa"><span class="aps-gravita">${GRAVITA[b.gravita]}</span><span class="aps-buco-app">${esc(b.app)}</span>${da !== null ? `<span>${da === 0 ? 'visto oggi' : da === 1 ? 'da ieri' : `da ${da} giorni`}</span>` : ''}</p>
					<h3>${esc(b.titolo)}</h3>
					<p>${esc(b.perche)}</p>
					${verifica ? `<p class="aps-verifica aps-v-${b.verifica.esito}">${esc(verifica)}</p>` : ''}
					<p class="aps-cosa"><b>Cosa fare.</b> ${esc(b.cosa)}</p>
					<p class="aps-azioni">${azioni.join('')}</p>
					${modulo}
				</div>
				<p class="aps-stima">${b.stima ? `<b>≈ ${esc(euro(b.stima, b.stima < 10 ? 2 : 0))}</b><small>al mese</small><small class="aps-stima-nota">${esc(b.stimaNota || '')}</small>` : '<small>senza stima</small>'}</p>
			</li>`;
		}

		function renderBuchi() {
			renderFiltroBuchi();
			const tutti = filtrati();
			const nota = $('aps-b-nota');
			const lista = $('aps-buchi');
			const altri = $('aps-altri');
			if (!pronto()) {
				nota.textContent = '';
				lista.innerHTML = altri.innerHTML = $('aps-chiusi').innerHTML = '';
				return;
			}
			nota.textContent = tutti.length
				? 'Dai numeri di AdMob, dello Store, degli abbonamenti e della scheda degli ultimi 30 giorni, e dal codice dei progetti collegati. Le stime sono ordini di grandezza, non promesse.'
				: ui.filtro === 'tutti'
					? 'Niente da sistemare.'
					: 'Nessuno in questo gruppo.';
			const quanti = ui.tutti ? tutti.length : Math.min(tutti.length, 10);
			const idx = new Map((st.buchi || []).map((b, i) => [b, i]));
			lista.innerHTML = tutti.slice(0, quanti).map(b => voceBuco(b, idx.get(b))).join('');
			altri.innerHTML =
				tutti.length > 10
					? `<button type="button" class="ghost" data-a="tutti" data-fk="tutti">${ui.tutti ? 'Mostra i primi dieci' : `Mostra tutti e ${tutti.length}`}</button>`
					: '';
			renderChiusi();
		}

		/** Risolti di recente e ignorati, chiusi in fondo. */
		function renderChiusi() {
			const a0 = scelta();
			const risolti = ((st && st.risolti) || []).filter(b => !a0 || b.chiave === a0.chiave);
			const ignorati = ((st && st.ignorati) || []).filter(b => !a0 || b.chiave === a0.chiave);
			const prima = b => (b.prima !== undefined && b.dopo !== undefined ? `, dal ${pct(b.prima)} al ${pct(b.dopo)}` : '');
			let html = '';
			if (risolti.length)
				html += `<details class="aps-chiusi"><summary>Risolti negli ultimi 60 giorni: ${risolti.length}</summary><ul>${risolti
					.map(b => `<li><b>${esc(b.app)}</b> ${esc(b.titolo)}<small>risolto ${esc(giornoBreveTs(b.quando))}, dopo ${giorniTra(b.daQuando, b.quando)}${esc(prima(b))}</small></li>`)
					.join('')}</ul></details>`;
			if (ignorati.length)
				html += `<details class="aps-chiusi"><summary>Ignorati: ${ignorati.length}</summary><ul>${ignorati
					.map(
						b =>
							`<li><b>${esc(b.app)}</b> ${esc(b.titolo)}<small>${b.motivo ? `«${esc(b.motivo)}», ` : ''}ignorato ${esc(giornoBreveTs(b.quando))}</small><button type="button" class="act piccolo" data-a="ripristina" data-v="${esc(b.id)}" data-fk="rp:${esc(b.id)}">Ripristina</button></li>`,
					)
					.join('')}</ul></details>`;
			$('aps-chiusi').innerHTML = html;
		}
		const giornoBreveTs = t => {
			const d = new Date(t);
			return `il ${d.getDate()} ${MESI_B[d.getMonth()]}`;
		};
		const giorniTra = (a, b) => {
			const g = Math.max(0, Math.round((b - a) / 86_400_000));
			return g === 0 ? 'meno di un giorno' : g === 1 ? 'un giorno' : `${g} giorni`;
		};

		// ---------- abbonamenti ----------

		/** Gli abbonamenti nella finestra (settimana o mese; l'anno usa i 60 giorni che ci sono), fino all'ultimo
		 *  giorno con il report. */
		function finestraAbb() {
			const ab = (scelta() || st.totale).abbonamenti;
			if (!ab || !st.abbFinoA) return null;
			const fine = st.giorni.indexOf(st.abbFinoA);
			if (fine < 0) return null;
			const k = ui.periodo === 'anno' ? fine + 1 : kGiorni();
			const da = Math.max(0, fine + 1 - k);
			const sl = a => a.slice(da, fine + 1);
			const prima = a => a.slice(Math.max(0, da - k), da);
			return {
				ab, fine, da, k: fine + 1 - da,
				date: st.giorni.slice(da, fine + 1),
				attivi: sl(ab.attivi), prove: sl(ab.prove),
				ev: c => somma(sl(ab.eventi[c] || [])),
				evPrima: c => somma(prima(ab.eventi[c] || [])),
				haPrima: da - k >= 0,
			};
		}

		function renderAbbonamenti() {
			const sez = $('aps-ab-sez');
			const w = pronto() ? finestraAbb() : null;
			sez.hidden = !w || Math.max(0, ...w.ab.attivi, ...w.ab.prove) === 0;
			if (sez.hidden) return;
			const ab = w.ab;
			const f = w.fine;
			const confronto = Math.max(0, f - w.k);
			$('aps-ab-nota').textContent = `Dai report degli abbonamenti di Apple, fino a ${giornoLungo(st.abbFinoA)}.${ui.periodo === 'anno' ? ' Per l\'anno ci sono gli ultimi due mesi: Apple li tiene per giorno.' : ''}`;
			$('aps-ab-cifre').innerHTML =
				cifra('Abbonati che pagano', esc(it(ab.attivi[f])), delta(ab.attivi[f], ab.attivi[confronto], f - w.k >= 0), 'quel giorno') +
				cifra('In prova gratuita', esc(it(ab.prove[f])), '', '') +
				cifra('Ricavi ricorrenti', esc(euro(ab.mrr[f], 0)), delta(ab.mrr[f], ab.mrr[confronto], f - w.k >= 0), 'al mese, netti, a prezzo pieno') +
				cifra('In ritardo di pagamento', esc(it(ab.ritardo[f])), '', ab.grazia[f] ? `${it(ab.grazia[f])} in periodo di tolleranza` : 'nessuno in tolleranza');
			$('aps-ab-grafico').innerHTML = barre({
				id: 'abbonati', date: w.date, tipo: 'giorni', serieA: w.attivi, H: 120, fmt: v => it(v), etichetta: 'Abbonati che pagano, giorno per giorno',
			});
			$('aps-ab-eventi').innerHTML = EVENTI.filter(([c]) => w.ev(c) || w.evPrima(c))
				.map(([c, l]) => `<li><b>${esc(it(w.ev(c)))}</b> ${esc(l)}${w.haPrima ? ` <span class="delta">prima ${esc(it(w.evPrima(c)))}</span>` : ''}</li>`)
				.join('');
			const app = (st.app || []).filter(a => a.abbonamenti && Math.max(0, ...a.abbonamenti.attivi, ...a.abbonamenti.prove) > 0);
			$('aps-ab-app').innerHTML =
				scelta() || app.length < 2
					? ''
					: `<div class="aps-riga aps-intesta aps-riga-4" role="row"><span role="columnheader">App</span><span role="columnheader">Pagano</span><span role="columnheader">In prova</span><span role="columnheader">Al mese</span></div>` +
						app
							.sort((x, y) => y.abbonamenti.mrr[f] - x.abbonamenti.mrr[f])
							.map(
								a =>
									`<div class="aps-riga aps-riga-4" role="row"><span role="cell" class="aps-nome"><b>${esc(a.nome)}</b></span><span role="cell" class="aps-num">${esc(it(a.abbonamenti.attivi[f]))}</span><span role="cell" class="aps-num">${esc(it(a.abbonamenti.prove[f]))}</span><span role="cell" class="aps-num">${esc(euro(a.abbonamenti.mrr[f], 0))}</span></div>`,
							)
							.join('');
		}

		// ---------- la scheda dello Store ----------

		/** La scheda nella finestra che finisce all'ultimo giorno con dati (Apple li elabora con qualche giorno di
		 *  ritardo), e lo stesso tratto prima. */
		function finestraScheda(sc) {
			if (!sc || !st.schedaFinoA) return null;
			const fine = st.giorni.indexOf(st.schedaFinoA);
			if (fine < 0) return null;
			const k = ui.periodo === 'anno' ? 30 : kGiorni();
			const da = Math.max(0, fine + 1 - k);
			const tratto = (a, x, y) => somma(a.slice(x, y));
			return {
				imp: tratto(sc.imp, da, fine + 1), vis: tratto(sc.vis, da, fine + 1), dl: tratto(sc.dl, da, fine + 1),
				impP: tratto(sc.imp, Math.max(0, da - k), da), visP: tratto(sc.vis, Math.max(0, da - k), da), dlP: tratto(sc.dl, Math.max(0, da - k), da),
				haPrima: sc.imp.slice(Math.max(0, da - k), da).some(Boolean), k: fine + 1 - da,
			};
		}

		function renderScheda() {
			const sez = $('aps-s-sez');
			const a0 = scelta();
			const sc = pronto() ? (a0 || st.totale).scheda : null;
			const w = finestraScheda(sc);
			sez.hidden = !w || !w.imp;
			if (sez.hidden) return;
			$('aps-s-nota').textContent = `Dai report di analisi di App Store Connect, fino a ${giornoLungo(st.schedaFinoA)}: Apple li prepara con due o tre giorni di ritardo. ${ui.periodo === 'anno' ? 'Per l\'anno: gli ultimi 30 giorni. ' : ''}Impressioni e visite contano i dispositivi, non le volte.`;
			const conv = w.imp ? w.dl / w.imp : 0;
			const convP = w.impP ? w.dlP / w.impP : 0;
			$('aps-s-cifre').innerHTML =
				cifra('Impressioni', esc(it(w.imp)), delta(w.imp, w.impP, w.haPrima), 'nelle ricerche e nelle pagine dello Store') +
				cifra('Visite alla pagina', esc(it(w.vis)), delta(w.vis, w.visP, w.haPrima), '') +
				cifra('Download nuovi', esc(it(w.dl)), delta(w.dl, w.dlP, w.haPrima), w.vis ? `${pct(w.dl / w.vis)} di chi apre la pagina` : '') +
				cifra('Conversione', esc(pctFine(conv)), w.haPrima && convP ? `<span class="delta">prima ${esc(pctFine(convP))}</span>` : '', 'download sulle impressioni');
			const fonti = Object.entries(sc.fonti || {}).filter(([, f]) => f.dl || f.imp).sort((x, y) => y[1].dl - x[1].dl);
			const max = Math.max(1, ...fonti.map(([, f]) => f.dl));
			$('aps-s-fonti').innerHTML = fonti
				.map(
					([k, f]) =>
						`<li><span class="aps-paese">${esc(k.charAt(0).toUpperCase() + k.slice(1))}</span><span class="aps-misura aps-misura-una" aria-hidden="true"><i data-w="${((f.dl / max) * 100).toFixed(1)}"></i></span><span class="aps-num">${esc(it(f.dl))} download</span><span class="aps-num muto">${f.imp ? `${esc(it(f.imp))} impressioni` : ''}</span></li>`,
				)
				.join('');
			for (const i of $('aps-s-fonti').querySelectorAll('i[data-w]')) /** @type {HTMLElement} */ (i).style.width = i.getAttribute('data-w') + '%';
			const app = a0 ? [] : (st.app || []).map(a => ({ a, w: finestraScheda(a.scheda) })).filter(x => x.w && x.w.imp);
			$('aps-s-app').innerHTML = app.length < 2
				? ''
				: `<div class="aps-riga aps-intesta aps-riga-5" role="row"><span role="columnheader">App</span><span role="columnheader">Impressioni</span><span role="columnheader">Visite</span><span role="columnheader">Download</span><span role="columnheader">Conversione</span></div>` +
					app
						.sort((x, y) => y.w.imp - x.w.imp)
						.map(
							({ a, w: x }) =>
								`<div class="aps-riga aps-riga-5" role="row"><span role="cell" class="aps-nome"><b>${esc(a.nome)}</b></span><span role="cell" class="aps-num">${esc(it(x.imp))}</span><span role="cell" class="aps-num">${esc(it(x.vis))}</span><span role="cell" class="aps-num">${esc(it(x.dl))}</span><span role="cell" class="aps-num">${esc(pctFine(x.imp ? x.dl / x.imp : 0))}</span></div>`,
						)
						.join('');
		}

		// ---------- le app ----------

		function scintilla(valori) {
			const n = valori.length;
			if (!n) return '';
			const max = Math.max(...valori, 0.01);
			const pts = valori.map((v, i) => `${((i / Math.max(1, n - 1)) * 80).toFixed(1)},${(18 - (v / max) * 16).toFixed(1)}`).join(' ');
			return `<svg class="aps-scintilla" viewBox="0 0 80 20" aria-hidden="true"><polyline points="${pts}"/></svg>`;
		}

		function dettaglio(a) {
			const righe = (a.formati || []).filter(f => f.richieste || f.impressioni);
			const formati = righe.length
				? `<table class="aps-formati"><caption>Annunci per formato, ultimi 30 giorni</caption><thead><tr><th scope="col">Formato</th><th scope="col">Richieste</th><th scope="col">Trovano un annuncio</th><th scope="col">Mostrati</th><th scope="col">Impressioni</th><th scope="col">Ogni mille</th><th scope="col">Euro</th></tr></thead><tbody>${righe
						.map(
							f =>
								`<tr><th scope="row">${esc(FORMATO[f.formato] || f.formato)}</th><td>${it(f.richieste)}</td><td>${f.richieste ? pct(f.abbinate / f.richieste) : 'n/d'}</td><td>${f.abbinate ? pct(f.impressioni / f.abbinate) : 'n/d'}</td><td>${it(f.impressioni)}</td><td>${f.impressioni ? esc(euro((f.euro / f.impressioni) * 1000)) : 'n/d'}</td><td>${esc(euro(f.euro))}</td></tr>`,
						)
						.join('')}</tbody></table>`
				: `<p class="aps-nota">${a.admobId ? 'Nessuna richiesta di annunci negli ultimi 30 giorni.' : 'Questa app non è su AdMob.'}</p>`;
			const r = a.repo;
			const sino = (v, l) => `<li class="${v ? 'si' : 'no'}"><span aria-hidden="true">${v ? '●' : '○'}</span>${esc(l)}: ${v ? 'sì' : 'no'}</li>`;
			const codice = r
				? `<ul class="aps-codice" aria-label="Il codice di ${esc(a.projectName || '')}">${sino(r.sdk, 'AdMob nel codice')}${r.sdk ? sino(r.ump, 'consenso UMP') : ''}${a.piattaforma === 'ios' ? sino(r.att, 'ATT') : ''}${a.piattaforma === 'ios' && r.sdk ? `<li class="${r.skan >= 10 ? 'si' : 'no'}"><span aria-hidden="true">${r.skan >= 10 ? '●' : '○'}</span>SKAdNetwork: ${r.skan}</li>` : ''}${sino(r.storekit || r.revenuecat, 'acquisti in-app')}${r.formati.length ? `<li class="si"><span aria-hidden="true">●</span>formati nel codice: ${esc(r.formati.map(f => FORMATO[f] || f).join(', '))}</li>` : ''}</ul>`
				: `<p class="aps-nota">${a.projectPath ? 'Il codice non è ancora stato letto.' : 'Nessun progetto sul Mac collegato a questa app.'}</p>`;
			const acq = a.acquisti || {};
			const acquisti =
				acq.nuovi || acq.rinnovi || acq.altri || acq.euro
					? `<p class="aps-nota">Negli ultimi 30 giorni: ${[acq.nuovi ? `${it(acq.nuovi)} abbonamenti nuovi` : '', acq.rinnovi ? `${it(acq.rinnovi)} rinnovi` : '', acq.altri ? `${it(acq.altri)} altri acquisti` : '']
							.filter(Boolean)
							.join(', ') || 'nessun acquisto'}, ${esc(euro(acq.euro))} netti dallo Store.</p>`
					: '';
			const vers = (a.versioni || []).slice(-4).reverse();
			const versioni = vers.length ? `<p class="aps-nota">Versioni uscite negli ultimi due mesi: ${esc(vers.map(v => `${v.v} il ${giornoBreve(v.quando)}`).join(', '))}.</p>` : '';
			const suoi = (st.buchi || []).filter(b => b.chiave === a.chiave);
			return `<div class="aps-dettaglio">
				${formati}
				${acquisti}
				${versioni}
				${codice}
				${suoi.length ? `<p class="aps-nota">${suoi.length === 1 ? 'Una cosa da sistemare' : `${suoi.length} cose da sistemare`}: ${esc(suoi.map(b => b.titolo.toLowerCase()).join('; '))}.</p>` : ''}
				<p class="aps-azioni"><button type="button" class="act piccolo" data-a="nel-grafico" data-v="${esc(a.chiave)}" data-fk="g:${esc(a.chiave)}">Mostra nei grafici</button>${a.projectPath ? `<button type="button" class="act piccolo" data-a="apri" data-path="${esc(a.projectPath)}" data-fk="oa:${esc(a.chiave)}">Apri ${esc(a.projectName || 'il progetto')}</button>` : ''}</p>
			</div>`;
		}

		function renderApp() {
			const el = $('aps-app');
			if (!st || !st.app || !st.app.length) {
				el.innerHTML = '';
				return;
			}
			const testa = `<div class="aps-riga aps-intesta" role="row"><span role="columnheader">App</span><span role="columnheader">Download</span><span role="columnheader">AdMob</span><span role="columnheader">Store</span><span role="columnheader">Totale</span><span role="columnheader">Andamento</span></div>`;
			const righe = st.app.map(a => {
				const w = finestra(a);
				const ad = somma(w.admob);
				const so = somma(w.store.filter((_, i) => !w.storeManca[i]));
				const d = somma(w.dl);
				const aperta = ui.aperte.has(a.chiave);
				const vals = w.date.map((_, i) => w.admob[i] + (w.storeManca[i] ? 0 : w.store[i]));
				const nBuchi = (st.buchi || []).filter(b => b.chiave === a.chiave && b.gravita === 'alta').length;
				return `<div class="aps-voce${aperta ? ' aperta' : ''}" role="rowgroup">
					<button type="button" class="aps-riga" role="row" data-a="app" data-v="${esc(a.chiave)}" data-fk="a:${esc(a.chiave)}" aria-expanded="${aperta}">
						<span role="cell" class="aps-nome"><b>${esc(a.nome)}</b><small>${esc(a.piattaforma === 'android' ? 'Android' : 'iOS')}${a.projectName ? ` · ${esc(a.projectName)}` : ''}${nBuchi ? ` · <span class="aps-allarme">${nBuchi === 1 ? 'una cosa subito' : `${nBuchi} cose subito`}</span>` : ''}</small></span>
						<span role="cell" class="aps-num">${d ? esc(it(d)) : '<span class="muto">0</span>'}</span>
						<span role="cell" class="aps-num">${esc(euro(ad))}</span>
						<span role="cell" class="aps-num">${esc(euro(so))}</span>
						<span role="cell" class="aps-num aps-tot">${esc(euro(ad + so))}</span>
						<span role="cell" class="aps-and">${scintilla(vals)}</span>
					</button>
					${aperta ? dettaglio(a) : ''}
				</div>`;
			});
			el.innerHTML = testa + righe.join('');
		}

		function renderPaesi() {
			const el = $('aps-paesi');
			const p = (st && st.paesi) || [];
			const max = Math.max(0.01, ...p.map(x => x.euro));
			el.innerHTML = p
				.map(
					x =>
						`<li><span class="aps-paese">${esc(paese(x.codice))}</span><span class="aps-misura" aria-hidden="true"><i data-w="${((x.euro / max) * 100).toFixed(1)}"></i></span><span class="aps-num">${esc(euro(x.euro))}</span><span class="aps-num muto">${x.impressioni ? `${esc(euro((x.euro / x.impressioni) * 1000))} ogni mille` : ''}</span></li>`,
				)
				.join('');
			// le larghezze passano da element.style: l'attributo style la CSP non lo vuole
			for (const i of el.querySelectorAll('i[data-w]')) /** @type {HTMLElement} */ (i).style.width = i.getAttribute('data-w') + '%';
		}

		function renderCome() {
			const parti = [
				'AdMob è la stima di AdMob, in euro. Lo Store sono i ricavi netti dei report di vendita di Apple (dopo la sua quota), portati in euro con i cambi del giorno.',
				'Apple pubblica le vendite di ieri verso le 14: fino ad allora l\'ultimo giorno dello Store manca, non è zero. Le versioni uscite si ricavano dai report di vendita, il giorno in cui compaiono.',
				'I buchi sono regole scritte nel codice della Bottega, non un modello: ognuno dice con quali numeri è nato.',
			];
			if (st && st.storeSenzaDati && st.storeSenzaDati.length)
				parti.push(`Per ${st.storeSenzaDati.length === 1 ? 'un mese' : `${st.storeSenzaDati.length} mesi`} (da ${meseLungo(st.storeSenzaDati[0])}) Apple non dà più il report: lì lo Store è segnato n/d.`);
			if (st && st.senzaCambio && st.senzaCambio.length) parti.push(`Senza cambio, e quindi fuori dai totali: ${st.senzaCambio.join(', ')}.`);
			$('aps-come').textContent = parti.join(' ');
		}

		// ---------- tutto ----------

		function render() {
			if (!visible) return;
			const fk = doc.activeElement && root.contains(doc.activeElement) ? doc.activeElement.getAttribute('data-fk') : null;
			const cursore = fk === 'motivo' ? /** @type {HTMLInputElement} */ (doc.activeElement).selectionStart : null;
			renderTesta();
			renderTimbro();
			renderAllarmi();
			renderFiltri();
			renderCifre();
			renderGrafici();
			renderBuchi();
			renderAbbonamenti();
			renderScheda();
			renderApp();
			renderPaesi();
			renderCome();
			if (fk) {
				const t = [...root.querySelectorAll('[data-fk]')].find(x => x.getAttribute('data-fk') === fk);
				if (t) {
					/** @type {HTMLElement} */ (t).focus();
					if (cursore !== null && t.setSelectionRange) t.setSelectionRange(cursore, cursore);
				}
			}
		}

		root.addEventListener('click', e => {
			const t = /** @type {HTMLElement} */ (e.target).closest('[data-a]');
			if (!t || !root.contains(t)) return;
			const a = t.getAttribute('data-a');
			const v = t.getAttribute('data-v');
			switch (a) {
				case 'aggiorna':
					post({ type: 'appstore.refresh' });
					if (st) st.aggiornando = true;
					return render();
				case 'periodo':
					ui.periodo = v || 'mese';
					save();
					return render();
				case 'filtro':
					ui.filtro = v || 'tutti';
					ui.tutti = false;
					save();
					return render();
				case 'tutti':
					ui.tutti = !ui.tutti;
					return renderBuchi();
				case 'app':
					if (!v) return;
					if (ui.aperte.has(v)) ui.aperte.delete(v);
					else ui.aperte.add(v);
					save();
					return renderApp();
				case 'nel-grafico':
					ui.app = v || '';
					save();
					render();
					if (root.scrollIntoView) $('aps-app-scelta').focus();
					return;
				case 'apri': {
					const p = t.getAttribute('data-path');
					if (p) post({ type: 'open', path: p });
					return;
				}
				case 'claude': {
					const b = st && st.buchi && st.buchi[Number(t.getAttribute('data-i'))];
					if (b && b.projectPath && b.compito) post({ type: 'job.prepare', path: b.projectPath, task: b.compito });
					return;
				}
				case 'ignora':
					ui.ignorando = ui.ignorando === v ? '' : v || '';
					ui.motivo = '';
					renderBuchi();
					if (ui.ignorando) /** @type {HTMLElement} */ ($('aps-motivo')).focus();
					return;
				case 'ignora-annulla': {
					const id = ui.ignorando;
					ui.ignorando = '';
					renderBuchi();
					const b = [...root.querySelectorAll('[data-fk]')].find(x => x.getAttribute('data-fk') === 'ig:' + id);
					if (b) /** @type {HTMLElement} */ (b).focus();
					return;
				}
				case 'ripristina':
					if (v) post({ type: 'appstore.ripristina', id: v });
					return;
			}
		});
		root.addEventListener('submit', e => {
			const f = /** @type {HTMLElement} */ (e.target).closest('form[data-ignora]');
			if (!f) return;
			e.preventDefault();
			const id = f.getAttribute('data-ignora');
			const motivo = /** @type {HTMLInputElement} */ ($('aps-motivo')).value.trim();
			post({ type: 'appstore.ignora', id, motivo });
			// subito fuori dall'elenco: lo stato nuovo arriva tra un attimo e lo conferma
			if (st && st.buchi) {
				const b = st.buchi.find(x => x.id === id);
				st.buchi = st.buchi.filter(x => x.id !== id);
				if (b) st.ignorati = [{ ...b, motivo, quando: Date.now(), daQuando: b.daQuando || Date.now() }, ...(st.ignorati || [])];
			}
			ui.ignorando = '';
			ui.motivo = '';
			render();
			$('aps-b-titolo').setAttribute('tabindex', '-1');
			/** @type {HTMLElement} */ ($('aps-b-titolo')).focus();
		});
		root.addEventListener('input', e => {
			const t = /** @type {HTMLInputElement} */ (e.target);
			if (t.id === 'aps-motivo') ui.motivo = t.value;
		});
		root.addEventListener('change', e => {
			const t = /** @type {HTMLSelectElement} */ (e.target);
			if (t.id !== 'aps-app-scelta') return;
			ui.app = t.value;
			save();
			render();
		});
		root.addEventListener('pointerover', e => {
			const t = /** @type {Element} */ (e.target);
			if (t.classList && t.classList.contains('aps-hit')) tip(t);
		});
		root.addEventListener('pointerout', e => {
			const t = /** @type {Element} */ (e.target);
			if (t.classList && t.classList.contains('aps-hit')) tip(null);
		});

		function chiedi() {
			// all'apertura chiede lo stato; il motore decide da solo se rileggere (al massimo ogni 45 minuti)
			if (Date.now() - chiesto < 10_000) return;
			chiesto = Date.now();
			post({ type: 'appstore.request' });
		}

		return {
			show() {
				visible = true;
				chiedi();
				render();
			},
			hide() {
				visible = false;
				tip(null);
			},
			pause() {},
			resume() {
				if (visible) chiedi();
			},
			render,
			message(m) {
				if (m && m.type === 'appstore' && m.state) {
					st = m.state;
					render();
				}
			},
		};
	}

	/** @type {any} */ (window).BottegaAppStore = { mount };
})();
