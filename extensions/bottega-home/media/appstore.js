/* Bottega, la stanza App Store: quanto rendono le app (AdMob e Store) per settimana, mese e anno, app per app, e
   dove intervenire. I dati li prepara l'estensione (src/appstore.ts); i messaggi appstore.* e la forma dello stato
   sono in docs/CONTRATTI.md, sezione 13.

   Due serie con il loro colore fisso, sempre nello stesso ordine: AdMob (ambra della lampada) e Store (la luce
   fredda della notte). Coppia verificata con il validatore della palette sui due fondi, scuro e chiaro.
   Ogni grafico ha la legenda e il suggerimento al passaggio del mouse; la tabella delle app e' la sua versione a
   righe. I testi stanno sempre nell'inchiostro del testo, mai nel colore della serie.
   Regole: niente librerie, niente attributi style (la CSP li blocca; element.style va bene), testo dei dati sempre
   sfuggito, aggiornamenti che rimettono il fuoco dov'era (data-fk). */
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

	const esc = s =>
		String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	const it = (n, d = 0) => Number(n || 0).toLocaleString('it-IT', { maximumFractionDigits: d, minimumFractionDigits: d });
	const somma = a => a.reduce((s, x) => s + (x || 0), 0);
	const pct = n => `${Math.round(n * 100)}%`;
	let fmtEuro;
	function euro(n, dec) {
		const v = Number(n || 0);
		const d = dec ?? (Math.abs(v) < 100 ? 2 : 0);
		if (!fmtEuro || fmtEuro.d !== d) {
			try {
				fmtEuro = { d, f: new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: d, maximumFractionDigits: d }) };
			} catch {
				fmtEuro = { d, f: { format: x => `${it(x, d)} €` } };
			}
		}
		return fmtEuro.f.format(v);
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

	/** «+12%», «-30%», «n/d»: la variazione rispetto al periodo prima, a parole e senza colori. */
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
			tutti: false,
		};
		/** @type {any} */ let st = null;
		let visible = false;
		let chiesto = 0;
		const doc = root.ownerDocument;

		const save = () => host && host.save && host.save({ periodo: ui.periodo, aperte: [...ui.aperte].slice(-20), filtro: ui.filtro });

		root.innerHTML = `
		<div class="aps" id="aps">
			<div class="aps-testa">
				<h1 class="sentence media aps-frase" id="aps-frase">Sto leggendo AdMob e App Store Connect.</h1>
				<p class="invito aps-sotto" id="aps-sotto"></p>
			</div>
			<p class="aps-timbro" id="aps-timbro"></p>
			<div class="aps-filtri"><div class="interruttori" role="group" aria-label="Periodo" id="aps-periodi"></div></div>
			<dl class="cifre aps-cifre" id="aps-cifre"></dl>
			<section class="aps-sez" aria-labelledby="aps-g-titolo">
				<div class="sez-testa aps-sez-testa">
					<h2 id="aps-g-titolo">Guadagni</h2>
					<ul class="aps-legenda" aria-label="Legenda">
						<li><i class="aps-q aps-q-admob" aria-hidden="true"></i>AdMob</li>
						<li><i class="aps-q aps-q-store" aria-hidden="true"></i>Store</li>
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

		// ---------- il periodo ----------

		/** Le serie del periodo scelto: valori, etichette, e lo stesso tratto subito prima per il confronto. */
		function finestra(s) {
			const t = st.totale;
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
					t,
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
				t,
			};
		}

		const etichettaPeriodo = () => (ui.periodo === 'settimana' ? 'Negli ultimi 7 giorni' : ui.periodo === 'mese' ? 'Negli ultimi 30 giorni' : 'Negli ultimi 12 mesi');

		// ---------- testa ----------

		function renderTesta() {
			const frase = $('aps-frase');
			const sotto = $('aps-sotto');
			if (!st || !st.giorni || !st.giorni.length) {
				frase.textContent = st && st.aggiornando ? 'Sto leggendo AdMob e App Store Connect.' : 'Non ho ancora letto i numeri delle app.';
				sotto.textContent =
					st && st.aggiornando ? 'La prima volta scarico un anno di vendite dello Store: ci vuole mezzo minuto.' : 'Premi «Aggiorna» per leggerli.';
				return;
			}
			const w = finestra(st.totale);
			const a = somma(w.admob);
			const s = somma(w.store.filter((_, i) => !w.storeManca[i]));
			const tot = a + s;
			const prima = somma(w.admobPrima) + somma(w.storePrima);
			let var_ = '';
			if (prima > 0 && w.primaStoreDisp) {
				const v = (tot - prima) / prima;
				var_ = Math.abs(v) < 0.03 ? ' Come nel periodo prima.' : ` ${v > 0 ? 'Il' : 'Il'} ${Math.round(Math.abs(v) * 100)}% ${v > 0 ? 'in più' : 'in meno'} del periodo prima.`;
			}
			frase.innerHTML = `${etichettaPeriodo()} le app hanno reso <span class="n">${esc(euro(tot, 0))}</span>, ${esc(euro(a, 0))} da AdMob e ${esc(euro(s, 0))} dallo Store.${esc(var_)}`;
			const buchi = st.buchi || [];
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
			if (st && st.aggiornatoAt) parti.push(`<span>Dati di ${esc(fa(st.aggiornatoAt))}</span>`);
			if (st && st.storeFinoA) parti.push(`<span>Store fino a ${esc(giornoLungo(st.storeFinoA))}</span>`);
			if (st && st.aggiornando) parti.push(`<span class="aps-fase">${esc(st.fase || 'Aggiorno')}…</span>`);
			parti.push(`<button type="button" class="ghost" data-a="aggiorna" data-fk="aggiorna" ${st && st.aggiornando ? 'disabled' : ''}>Aggiorna</button>`);
			const err = st && st.errori ? Object.entries(st.errori).filter(([, v]) => v) : [];
			for (const [, v] of err) parti.push(`<span class="aps-errore">${esc(v)}</span>`);
			el.setAttribute('aria-busy', st && st.aggiornando ? 'true' : 'false');
			el.innerHTML = parti.join('');
		}

		function renderPeriodi() {
			$('aps-periodi').innerHTML = PERIODI.map(
				([id, l]) => `<button type="button" data-a="periodo" data-v="${id}" data-fk="p:${id}" aria-pressed="${ui.periodo === id}">${l}</button>`,
			).join('');
		}

		function renderCifre() {
			const el = $('aps-cifre');
			if (!st || !st.giorni || !st.giorni.length) {
				el.innerHTML = '';
				return;
			}
			const w = finestra(st.totale);
			const a = somma(w.admob);
			const s = somma(w.store.filter((_, i) => !w.storeManca[i]));
			const d = somma(w.dl);
			const cifra = (dt, valore, dlt, nota) => `<div class="cifra"><dt>${dt}</dt><dd><b class="lettura">${valore}</b>${dlt}${nota ? `<small>${nota}</small>` : ''}</dd></div>`;
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

		// ---------- grafici ----------

		const W = 720;

		function renderGuadagni() {
			const el = $('aps-guadagni');
			if (!st || !st.giorni || !st.giorni.length) {
				el.innerHTML = '';
				return;
			}
			const w = finestra(st.totale);
			const H = 190;
			const top = 10;
			const base = H - 26;
			const sx = 44;
			const n = w.date.length;
			const valori = w.date.map((_, i) => w.admob[i] + (w.storeManca[i] ? 0 : w.store[i]));
			const max = Math.max(1, ...valori);
			const p = passo(max);
			const tetto = Math.ceil(max / p) * p;
			const y = v => base - (v / tetto) * (base - top);
			const larg = (W - sx) / n;
			const bw = Math.max(3, Math.min(34, larg * 0.62));
			let svg = '';
			for (let v = 0; v <= tetto + 1e-9; v += p) {
				svg += `<line class="aps-griglia${v === 0 ? ' aps-base' : ''}" x1="${sx}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
				svg += `<text class="aps-asse" x="${sx - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(it(v, p < 1 ? 1 : 0))} €</text>`;
			}
			const ogni = n > 14 ? 5 : 1;
			for (let i = 0; i < n; i++) {
				const x = sx + i * larg + (larg - bw) / 2;
				const ha = (w.admob[i] / tetto) * (base - top);
				const hs = w.storeManca[i] ? 0 : (w.store[i] / tetto) * (base - top);
				const gap = ha > 0 && hs > 0 ? 2 : 0;
				// AdMob in basso, Store sopra; la sola estremita' in cima e' arrotondata
				if (hs > 0) {
					svg += `<path class="aps-m-admob" d="${barra(x, base - ha, bw, ha, 0)}"/>`;
					svg += `<path class="aps-m-store" d="${barra(x, base - ha - gap - hs, bw, hs, 4)}"/>`;
				} else svg += `<path class="aps-m-admob" d="${barra(x, base - ha, bw, ha, 4)}"/>`;
				if (w.storeManca[i] && ui.periodo === 'anno') svg += `<text class="aps-asse aps-nd" x="${(x + bw / 2).toFixed(1)}" y="${(base - ha - 6).toFixed(1)}" text-anchor="middle">n/d</text>`;
				if (i % ogni === (n - 1) % ogni) {
					const l = w.tipo === 'mesi' ? meseCorto(w.date[i]) : n > 7 ? String(giorno(w.date[i]).getDate()) : giornoCorto(w.date[i]);
					svg += `<text class="aps-asse" x="${(sx + i * larg + larg / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(l)}</text>`;
				}
				svg += `<rect class="aps-hit" data-i="${i}" data-g="guadagni" x="${(sx + i * larg).toFixed(1)}" y="${top}" width="${larg.toFixed(1)}" height="${base - top}"/>`;
			}
			el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`Guadagni ${etichettaPeriodo().toLowerCase()}, AdMob e Store, in euro`)}">${svg}</svg>`;
		}

		function renderDownload() {
			const el = $('aps-download');
			if (!st || !st.giorni || !st.giorni.length) {
				el.innerHTML = '';
				return;
			}
			const w = finestra(st.totale);
			const H = 120;
			const top = 8;
			const base = H - 24;
			const sx = 44;
			const n = w.date.length;
			const max = Math.max(1, ...w.dl);
			const p = passo(max, 2);
			const tetto = Math.ceil(max / p) * p;
			const y = v => base - (v / tetto) * (base - top);
			const larg = (W - sx) / n;
			const bw = Math.max(3, Math.min(34, larg * 0.62));
			let svg = '';
			for (let v = 0; v <= tetto + 1e-9; v += p) {
				svg += `<line class="aps-griglia${v === 0 ? ' aps-base' : ''}" x1="${sx}" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
				svg += `<text class="aps-asse" x="${sx - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(it(v))}</text>`;
			}
			const ogni = n > 14 ? 5 : 1;
			for (let i = 0; i < n; i++) {
				const x = sx + i * larg + (larg - bw) / 2;
				const h = w.storeManca[i] ? 0 : (w.dl[i] / tetto) * (base - top);
				svg += `<path class="aps-m-dl" d="${barra(x, base - h, bw, h, 4)}"/>`;
				if (i % ogni === (n - 1) % ogni) {
					const l = w.tipo === 'mesi' ? meseCorto(w.date[i]) : n > 7 ? String(giorno(w.date[i]).getDate()) : giornoCorto(w.date[i]);
					svg += `<text class="aps-asse" x="${(sx + i * larg + larg / 2).toFixed(1)}" y="${H - 7}" text-anchor="middle">${esc(l)}</text>`;
				}
				svg += `<rect class="aps-hit" data-i="${i}" data-g="download" x="${(sx + i * larg).toFixed(1)}" y="${top}" width="${larg.toFixed(1)}" height="${base - top}"/>`;
			}
			el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`Download ${etichettaPeriodo().toLowerCase()}`)}">${svg}</svg>`;
		}

		/** Il suggerimento sopra la barra: data, AdMob, Store, totale (o i download). */
		function tip(target) {
			const el = $('aps-tip');
			if (!target || !st) {
				el.hidden = true;
				return;
			}
			const i = Number(target.getAttribute('data-i'));
			const w = finestra(st.totale);
			const d = w.date[i];
			const quando = w.tipo === 'mesi' ? meseLungo(d) : giornoLungo(d);
			const manca = w.storeManca[i];
			const testoStore = manca ? (w.tipo === 'mesi' ? 'Apple non dà più questo mese' : 'non ancora pubblicato da Apple') : euro(w.store[i]);
			el.innerHTML =
				target.getAttribute('data-g') === 'download'
					? `<b>${esc(quando)}</b><span>${manca ? 'Download: non ancora pubblicati' : `${esc(it(w.dl[i]))} download`}</span>`
					: `<b>${esc(quando)}</b><span><i class="aps-q aps-q-admob" aria-hidden="true"></i>AdMob ${esc(euro(w.admob[i]))}</span><span><i class="aps-q aps-q-store" aria-hidden="true"></i>Store ${esc(testoStore)}</span>${manca ? '' : `<span>Totale ${esc(euro(w.admob[i] + w.store[i]))}</span>`}`;
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
			const b = (st && st.buchi) || [];
			if (ui.filtro === 'subito') return b.filter(x => x.gravita === 'alta');
			if (ui.filtro === 'stima') return b.filter(x => x.stima).sort((x, y) => y.stima - x.stima);
			return b;
		}

		function renderFiltro() {
			const b = (st && st.buchi) || [];
			const voci = [
				['tutti', `Tutti ${b.length}`],
				['subito', `Subito ${b.filter(x => x.gravita === 'alta').length}`],
				['stima', `Con una stima ${b.filter(x => x.stima).length}`],
			];
			$('aps-filtro').innerHTML = voci
				.map(([id, l]) => `<button type="button" data-a="filtro" data-v="${id}" data-fk="f:${id}" aria-pressed="${ui.filtro === id}">${esc(l)}</button>`)
				.join('');
		}

		function voceBuco(b, i) {
			const azioni = [];
			if (b.compito && b.projectPath) azioni.push(`<button type="button" class="act piccolo main" data-a="claude" data-i="${i}" data-fk="c:${esc(b.id)}">Sistema con Claude</button>`);
			if (b.projectPath) azioni.push(`<button type="button" class="act piccolo" data-a="apri" data-path="${esc(b.projectPath)}" data-fk="o:${esc(b.id)}">Apri il progetto</button>`);
			return `<li class="aps-buco aps-g-${b.gravita}">
				<span class="aps-segno" aria-hidden="true"></span>
				<div class="aps-buco-corpo">
					<p class="aps-buco-testa"><span class="aps-gravita">${GRAVITA[b.gravita]}</span><span class="aps-buco-app">${esc(b.app)}</span></p>
					<h3>${esc(b.titolo)}</h3>
					<p>${esc(b.perche)}</p>
					<p class="aps-cosa"><b>Cosa fare.</b> ${esc(b.cosa)}</p>
					${azioni.length ? `<p class="aps-azioni">${azioni.join('')}</p>` : ''}
				</div>
				<p class="aps-stima">${b.stima ? `<b>≈ ${esc(euro(b.stima, b.stima < 10 ? 2 : 0))}</b><small>al mese</small><small class="aps-stima-nota">${esc(b.stimaNota || '')}</small>` : '<small>senza stima</small>'}</p>
			</li>`;
		}

		function renderBuchi() {
			renderFiltro();
			const tutti = filtrati();
			const nota = $('aps-b-nota');
			const lista = $('aps-buchi');
			const altri = $('aps-altri');
			if (!st || !st.giorni || !st.giorni.length) {
				nota.textContent = '';
				lista.innerHTML = '';
				altri.innerHTML = '';
				return;
			}
			nota.textContent = tutti.length
				? 'Dai numeri di AdMob e dello Store degli ultimi 30 giorni e dal codice dei progetti collegati. Le stime sono ordini di grandezza, non promesse.'
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
			const suoi = (st.buchi || []).filter(b => b.chiave === a.chiave);
			return `<div class="aps-dettaglio">
				${formati}
				${acquisti}
				${codice}
				${suoi.length ? `<p class="aps-nota">${suoi.length === 1 ? 'Una cosa da sistemare' : `${suoi.length} cose da sistemare`}: ${esc(suoi.map(b => b.titolo.toLowerCase()).join('; '))}.</p>` : ''}
				${a.projectPath ? `<p class="aps-azioni"><button type="button" class="act piccolo" data-a="apri" data-path="${esc(a.projectPath)}" data-fk="oa:${esc(a.chiave)}">Apri ${esc(a.projectName || 'il progetto')}</button></p>` : ''}
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
				'Apple pubblica le vendite di ieri verso le 14: fino ad allora l\'ultimo giorno dello Store manca, non è zero.',
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
			renderTesta();
			renderTimbro();
			renderPeriodi();
			renderCifre();
			renderGuadagni();
			renderDownload();
			renderBuchi();
			renderApp();
			renderPaesi();
			renderCome();
			if (fk) {
				const t = [...root.querySelectorAll('[data-fk]')].find(x => x.getAttribute('data-fk') === fk);
				if (t) /** @type {HTMLElement} */ (t).focus();
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
			}
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
