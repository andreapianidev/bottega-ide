/* Bottega, la Vedetta: una stanza della plancia che guarda tre cose, le regole di Andrea su ogni
   progetto, lo Store con i soldi delle app e i siti su Vercel. I dati arrivano nello snapshot (rules:
   RulesState, radar: RadarState, con i siti in radar.vercel), la forma e' in docs/CONTRATTI.md, sezione 4.1.

   Idea: una vedetta notturna sul crinale della Caldera. Ogni progetto e' una luce sul profilo dei
   monti: i rossi sono le luci d'ostacolo in cima alle torri (lampeggiano piano, sono sulle creste
   piu' alte), i gialli lampade al sodio con la loro pozza di luce, i verdi finestre quasi spente.
   Si capisce a colpo d'occhio se stanotte c'e' qualcosa che non va. Sotto, l'elenco preciso, che e'
   anche la versione accessibile del crinale.

   Regole: niente librerie, niente attributi style (la CSP li blocca; element.style va bene), testo
   dei dati sempre sfuggito o messo con textContent, aggiornamenti che riscrivono solo cio' che e'
   cambiato e rimettono il fuoco dov'era (data-fk). */
(function () {
	'use strict';

	const PAROLE = ['nessuno', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci'];
	const MESI_B = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
	const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
	const GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
	const GIORNI_B = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
	const DAY = 86_400_000;

	/** Come si chiama un livello, a parole (mai solo il colore). */
	const LIVELLO = { rosso: 'subito', giallo: 'da sistemare', verde: 'in regola' };
	const TONO = { ok: 'verde', attesa: 'giallo', male: 'rosso' };

	// ---------- formati ----------

	const esc = s =>
		String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	const it = (n, d = 0) => Number(n || 0).toLocaleString('it-IT', { maximumFractionDigits: d, minimumFractionDigits: 0 });
	const parola = n => (n >= 0 && n < PAROLE.length ? PAROLE[n] : it(n));
	const base = p => String(p || '').split('/').filter(Boolean).pop() || String(p || '');

	const fmtCache = new Map();
	function soldi(n, cur) {
		const c = cur || 'USD';
		let f = fmtCache.get(c);
		if (!f) {
			try {
				f = new Intl.NumberFormat('it-IT', { style: 'currency', currency: c, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 });
			} catch {
				f = { format: x => `${it(x, 2)} ${c}` };
			}
			fmtCache.set(c, f);
		}
		return f.format(Number(n || 0));
	}

	const ora = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
	const stessoGiorno = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

	/** "adesso", "12 min fa", "3 h fa", "ieri", "4 giorni fa" */
	function fa(ms, now) {
		const m = Math.max(0, (now - ms) / 60_000);
		if (m < 2) return 'adesso';
		if (m < 60) return `${Math.round(m)} min fa`;
		const h = m / 60;
		if (h < 24 && stessoGiorno(ms, now)) return `${Math.round(h)} h fa`;
		const d = Math.max(1, Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / DAY));
		return d === 1 ? 'ieri' : `${d} giorni fa`;
	}

	/** Per "ultimo dato ...": "delle 14:20", "di ieri", "di 3 giorni fa". */
	function di(ms, now) {
		// anche a cavallo della mezzanotte: un dato di poche ore fa si dice con l'ora, non «di 5 min fa»
		if (stessoGiorno(ms, now) || now - ms < 12 * 3_600_000) return `delle ${ora(ms)}`;
		return `di ${fa(ms, now)}`;
	}

	function giornoCorto(ms) {
		const d = new Date(ms);
		return `${GIORNI_B[d.getDay()]} ${d.getDate()} ${MESI_B[d.getMonth()]}`;
	}
	function giornoLungo(ms) {
		const d = new Date(ms);
		return `${GIORNI[d.getDay()]} ${d.getDate()} ${MESI[d.getMonth()]}`;
	}

	/** Generatore deterministico: lo stesso crinale a ogni aggiornamento. */
	function semi(seed) {
		return () => {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	/** Il segno di un livello: rombo per il rosso, cerchio pieno per il giallo, anello per il verde. */
	const segno = liv => `<i class="ved-segno ved-segno-${liv}" aria-hidden="true"></i>`;

	// ---------- montaggio ----------

	function mount(root, host) {
		const saved = (host && host.saved) || {};
		const reduced = (host && host.reduced) || { matches: false };
		const post = m => host && host.post && host.post(m);

		const ui = {
			/** dettagli aperti: commit di una regola, recensioni di un'app, elenco dei verdi */
			open: new Set(Array.isArray(saved.aperti) ? saved.aperti : []),
		};
		const save = () => host && host.save && host.save({ aperti: [...ui.open] });

		/** @type {any} */ let snap = null;
		let visible = false;
		let dirty = true;
		let askedRules = 0; // quando Andrea ha chiesto di ricontrollare (finche' non arriva running)
		let askedRadar = 0;
		let askedSiti = 0;
		/** azioni appena mandate: chiave -> istante, il pulsante resta in attesa per qualche secondo */
		const sent = new Map();

		root.innerHTML = `
		<div class="ved" id="ved">
			<section class="ved-regole" aria-labelledby="ved-frase">
				<div class="ved-testa">
					<h1 class="sentence media ved-frase" id="ved-frase">Sto guardando i progetti.</h1>
					<p class="ved-timbro" id="ved-timbro-regole"><span id="ved-controllo"></span><button type="button" class="ghost" data-v="ricontrolla" data-fk="v:ricontrolla">Ricontrolla</button></p>
				</div>
				<figure class="ved-crinale" id="ved-crinale">
					<div class="ved-crinale-svg" id="ved-crinale-svg" aria-hidden="true"></div>
					<figcaption class="ved-legenda" id="ved-legenda"></figcaption>
				</figure>
				<div class="ved-corpo">
					<div class="ved-progetti">
						<h2 class="ved-h2" id="ved-lista-titolo">Da sistemare</h2>
						<p class="ved-vuoto" id="ved-vuoto" hidden></p>
						<ol class="ved-lista" id="ved-lista" aria-labelledby="ved-lista-titolo"></ol>
						<div class="ved-verdi" id="ved-verdi"></div>
					</div>
					<aside class="ved-globali" aria-labelledby="ved-glob-titolo">
						<h2 class="ved-h2" id="ved-glob-titolo">Regole comuni</h2>
						<div id="ved-globali"></div>
					</aside>
				</div>
			</section>

			<section class="ved-store" aria-labelledby="ved-store-titolo">
				<div class="ved-sez-testa">
					<h2 class="ved-h2 ved-h2-grande" id="ved-store-titolo">Lo Store e i soldi</h2>
					<p class="ved-timbro" id="ved-timbro-radar"><span id="ved-letto"></span><button type="button" class="ghost" data-v="radar" data-fk="v:radar">Rileggi</button></p>
				</div>
				<div class="ved-errori" id="ved-errori"></div>
				<div class="ved-totali" id="ved-totali"></div>
				<ul class="ved-app" id="ved-app" aria-label="App sullo Store"></ul>
			</section>

			<section class="ved-siti" aria-labelledby="ved-siti-titolo">
				<div class="ved-sez-testa">
					<h2 class="ved-h2 ved-h2-grande" id="ved-siti-titolo">Siti</h2>
					<p class="ved-timbro" id="ved-timbro-siti"><span id="ved-siti-letto"></span><button type="button" class="ghost" data-v="siti" data-fk="v:siti">Rileggi</button></p>
				</div>
				<div class="ved-errori" id="ved-siti-errori"></div>
				<p class="ved-nota" id="ved-siti-vuoto" hidden></p>
				<ul class="ved-siti-lista" id="ved-siti" aria-label="Siti su Vercel"></ul>
			</section>
			<div class="ved-tip" id="ved-tip" hidden></div>
			<p class="sr" id="ved-voce" aria-live="polite"></p>
		</div>`;

		const $ = id => /** @type {any} */ (root.querySelector('#' + id));
		const ved = $('ved');
		const tip = $('ved-tip');
		const doc = root.ownerDocument;

		// ---------- piccoli attrezzi ----------

		const lastHTML = new WeakMap();

		function focusKey(scope) {
			const a = /** @type {any} */ (doc.activeElement);
			if (!a || !scope.contains(a)) return null;
			const k = a.closest ? a.closest('[data-fk]') : null;
			return k ? k.getAttribute('data-fk') : null;
		}

		function refocus(key, scope) {
			if (!key) return;
			const a = doc.activeElement;
			if (a && a !== doc.body && doc.contains(a)) return;
			for (const el of scope.querySelectorAll('[data-fk]')) {
				if (el.getAttribute('data-fk') === key) {
					el.focus({ preventScroll: true });
					return;
				}
			}
		}

		/** Riscrive un contenitore solo se l'HTML e' cambiato, e rimette il fuoco dov'era. */
		function put(el, html) {
			if (lastHTML.get(el) === html) return;
			const k = focusKey(el);
			el.innerHTML = html;
			lastHTML.set(el, html);
			refocus(k, el);
		}

		function make(html) {
			const t = doc.createElement('template');
			t.innerHTML = html.trim();
			return /** @type {any} */ (t.content.firstElementChild);
		}

		/** Lista con chiavi: ricrea solo le voci cambiate, sposta le altre senza toccarle. */
		function sync(list, items, keyOf, htmlOf) {
			const k = focusKey(list);
			const old = new Map();
			for (const el of [...list.children]) old.set(el.getAttribute('data-key'), el);
			let prev = null;
			for (const item of items) {
				const key = String(keyOf(item));
				const html = htmlOf(item);
				let el = old.get(key);
				if (!el || lastHTML.get(el) !== html) {
					const n = make(html);
					n.setAttribute('data-key', key);
					lastHTML.set(n, html);
					if (el) el.replaceWith(n);
					el = n;
				}
				old.delete(key);
				const want = prev ? prev.nextElementSibling : list.firstElementChild;
				if (want !== el) list.insertBefore(el, want);
				prev = el;
			}
			for (const el of old.values()) el.remove();
			refocus(k, list);
		}

		function say(text) {
			const v = $('ved-voce');
			v.textContent = '';
			setTimeout(() => (v.textContent = text), 30);
		}

		const now = () => Date.now();
		const projects = () => (snap && Array.isArray(snap.projects) ? snap.projects : []);
		const nameOf = path => {
			const p = projects().find(x => x.path === path);
			return p ? p.name : base(path);
		};
		const rules = () => (snap && snap.rules) || null;
		const radar = () => (snap && snap.radar) || null;

		/** I progetti con le loro regole, rossi prima, poi gialli, poi verdi; a pari livello per nome. */
		function ordered() {
			const r = rules();
			if (!r || !r.projects) return [];
			const rank = { rosso: 0, giallo: 1, verde: 2 };
			return Object.values(r.projects)
				.map(p => ({ ...p, name: nameOf(p.path), hits: Array.isArray(p.hits) ? p.hits : [] }))
				.sort((a, b) => rank[a.livello] - rank[b.livello] || b.hits.length - a.hits.length || a.name.localeCompare(b.name, 'it'));
		}

		function counts(list) {
			const r = rules();
			if (r && r.counts) return r.counts;
			const c = { rosso: 0, giallo: 0, verde: 0 };
			for (const p of list) c[p.livello]++;
			return c;
		}

		const appAdsRed = () => {
			const r = rules();
			if (!r) return false;
			if (r.appAds && r.appAds.identical === false) return true;
			return (r.global || []).some(h => h.id === 'app-ads' && h.livello === 'rosso');
		};

		// ---------- la frase ----------

		function frase(list) {
			const r = rules();
			const n = (s, cls) => `<span class="n${cls ? ' ' + cls : ''}">${s}</span>`;
			if (!r) return 'Le regole non sono ancora state controllate.';
			const c = counts(list);
			const tot = c.rosso + c.giallo + c.verde;
			const progetti = k => (k === 1 ? 'progetto' : 'progetti');
			let out = '';
			if (!tot) out = 'Non ci sono progetti da controllare.';
			else if (!c.rosso && !c.giallo) out = `Tutte le regole sono rispettate, in ${n(it(tot))} ${progetti(tot)}.`;
			else {
				if (c.rosso) {
					out = c.rosso === 1 ? `${cap(n('Un', 'ved-n-rosso'))} progetto va sistemato subito` : `${n(cap(parola(c.rosso)), 'ved-n-rosso')} progetti vanno sistemati subito`;
					if (c.giallo) out += c.giallo === 1 ? `, ${n('uno')} ha qualcosa da mettere a posto` : `, ${n(parola(c.giallo))} hanno qualcosa da mettere a posto`;
					out += '.';
				} else {
					out = c.giallo === 1 ? `Niente di urgente: ${n('un')} progetto ha qualcosa da mettere a posto.` : `Niente di urgente: ${n(parola(c.giallo))} progetti hanno qualcosa da mettere a posto.`;
				}
				if (c.verde) out += c.verde === 1 ? ` L'altro è in regola.` : ` Gli altri ${n(parola(c.verde))} sono in regola.`;
			}
			if (appAdsRed()) out += ` E app-ads.txt non è uguale sui tre siti.`;
			return out;
		}

		function cap(s) {
			// maiuscola alla prima lettera visibile, anche dentro un tag
			return s.replace(/^(<[^>]+>)?(\p{L})/u, (m, tag, ch) => (tag || '') + ch.toUpperCase());
		}

		function renderTimbroRegole() {
			const r = rules();
			const running = !!(r && r.running) || (askedRules && now() - askedRules < 10_000);
			if (r && r.running) askedRules = 0;
			const t = $('ved-timbro-regole');
			t.setAttribute('aria-busy', running ? 'true' : 'false');
			let txt;
			if (running) txt = 'Sto ricontrollando i progetti…';
			else if (r && r.checkedAt) txt = `Controllato ${fa(r.checkedAt, now())}`;
			else txt = 'Mai controllato';
			const s = $('ved-controllo');
			if (s.textContent !== txt) s.textContent = txt;
			if (r && r.checkedAt) s.title = `Ultimo controllo alle ${ora(r.checkedAt)}`;
			const b = t.querySelector('button');
			b.disabled = running;
		}

		// ---------- il crinale ----------

		let lights = [];
		let crinaleKey = '';

		function crinale(list) {
			const box = $('ved-crinale-svg');
			const W = Math.max(320, Math.round(box.clientWidth || (box.parentElement && box.parentElement.clientWidth) || 0) || 960);
			const H = 132;
			const key = W + '|' + list.map(p => p.path + ':' + p.livello).join(',');
			if (key === crinaleKey) return;
			crinaleKey = key;

			const rnd = semi(1729);
			// profilo della Caldera: una cresta alta a sinistra (il Roque), una piu' bassa a destra
			const ph = [rnd() * 6.28, rnd() * 6.28, rnd() * 6.28];
			const ridge = x => {
				const u = x / W;
				let y = 92;
				y -= 46 * Math.exp(-((u - 0.34) ** 2) / 0.028);
				y -= 24 * Math.exp(-((u - 0.78) ** 2) / 0.018);
				y += 5 * Math.sin(u * 23 + ph[0]) + 3 * Math.sin(u * 51 + ph[1]) + 1.6 * Math.sin(u * 117 + ph[2]);
				return Math.max(18, Math.min(112, y));
			};
			let d = `M0,${H}`;
			for (let x = 0; x <= W; x += 6) d += `L${x},${ridge(x).toFixed(1)}`;
			d += `L${W},${ridge(W).toFixed(1)}L${W},${H}Z`;

			// cielo: poche stelle fisse sopra la cresta
			let stelle = '';
			const rs = semi(42);
			for (let i = 0; i < Math.round(W / 14); i++) {
				const x = rs() * W;
				const y = rs() * (ridge(x) - 10);
				if (y < 4) continue;
				stelle += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.5 + rs() * 0.7).toFixed(2)}" opacity="${(0.25 + rs() * 0.45).toFixed(2)}"/>`;
			}

			// i posti: uno per progetto, sparsi lungo il crinale; i rossi sulle creste piu' alte
			const N = list.length;
			const rp = semi(7);
			const slots = [];
			for (let i = 0; i < N; i++) {
				const x = Math.max(10, Math.min(W - 10, (W * (i + 0.5)) / N + (rp() - 0.5) * (W / N) * 0.5));
				slots.push({ x, top: ridge(x), r: rp() });
			}
			const byHeight = [...slots].sort((a, b) => a.top - b.top);
			lights = [];
			let s = 0;
			for (const liv of ['rosso', 'giallo', 'verde']) {
				for (const p of list.filter(q => q.livello === liv)) {
					const slot = byHeight[s++];
					const y = liv === 'rosso' ? slot.top - 7 : liv === 'giallo' ? slot.top + 7 + slot.r * 10 : slot.top + 8 + slot.r * Math.max(4, H - slot.top - 16);
					lights.push({ path: p.path, name: p.name, livello: liv, hits: p.hits, x: slot.x, y: Math.min(H - 4, y), top: slot.top });
				}
			}

			const pozze = lights
				.filter(l => l.livello === 'giallo')
				.map(l => `<circle class="ved-pozza" cx="${l.x.toFixed(1)}" cy="${l.y.toFixed(1)}" r="16"/>`)
				.join('');
			const fari = lights
				.map((l, i) => {
					const pa = esc(l.path);
					if (l.livello === 'rosso')
						return `<g class="ved-luce ved-luce-rosso" data-path="${pa}" data-i="${i}"><line class="ved-torre" x1="${l.x.toFixed(1)}" y1="${(l.y + 3).toFixed(1)}" x2="${l.x.toFixed(1)}" y2="${(l.top + 1).toFixed(1)}"/><circle class="ved-alone-rosso" cx="${l.x.toFixed(1)}" cy="${l.y.toFixed(1)}" r="9"/><circle class="ved-faro" cx="${l.x.toFixed(1)}" cy="${l.y.toFixed(1)}" r="3.4"/></g>`;
					if (l.livello === 'giallo')
						return `<g class="ved-luce ved-luce-giallo" data-path="${pa}" data-i="${i}"><circle class="ved-lampada" cx="${l.x.toFixed(1)}" cy="${l.y.toFixed(1)}" r="2.8"/></g>`;
					return `<g class="ved-luce ved-luce-verde" data-path="${pa}" data-i="${i}"><circle class="ved-finestra" cx="${l.x.toFixed(1)}" cy="${l.y.toFixed(1)}" r="1.5"/></g>`;
				})
				.join('');

			box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMax meet" focusable="false">
				<defs><radialGradient id="ved-g-sodio"><stop offset="0" stop-color="#f4ab3c" stop-opacity="0.55"/><stop offset="1" stop-color="#f4ab3c" stop-opacity="0"/></radialGradient>
				<radialGradient id="ved-g-rosso"><stop offset="0" stop-color="#f2607a" stop-opacity="0.6"/><stop offset="1" stop-color="#f2607a" stop-opacity="0"/></radialGradient></defs>
				<g class="ved-cielo-stelle">${stelle}</g>
				<path class="ved-monte" d="${d}"/>
				<g class="ved-pozze">${pozze}</g>
				<g class="ved-luci">${fari}</g>
			</svg>`;
		}

		function legenda(list) {
			const c = counts(list);
			const voce = (liv, k) => `<li>${segno(liv)}<b>${it(k)}</b> ${LIVELLO[liv]}</li>`;
			put($('ved-legenda'), `<ul class="ved-chiavi">${voce('rosso', c.rosso)}${voce('giallo', c.giallo)}${voce('verde', c.verde)}</ul><p>Una luce per progetto. In cima alle creste le luci rosse, sui fianchi le lampade gialle, in basso le finestre di chi è in regola. Passa sopra una luce per sapere di chi è.</p>`);
		}

		/** Accende la luce di un progetto (passando sull'elenco) e abbassa le altre. */
		function accendi(path) {
			const box = $('ved-crinale-svg');
			box.classList.toggle('ved-cerca', !!path);
			for (const g of box.querySelectorAll('.ved-luce')) g.classList.toggle('ved-acceso', !!path && g.getAttribute('data-path') === path);
		}

		function nearest(e) {
			const box = $('ved-crinale-svg');
			const svg = box.querySelector('svg');
			if (!svg || !lights.length) return null;
			const r = svg.getBoundingClientRect();
			const vb = svg.viewBox && svg.viewBox.baseVal;
			if (!r.width || !vb) return null;
			const k = vb.width / r.width;
			const x = (e.clientX - r.left) * k;
			const y = (e.clientY - r.top) * k;
			let best = null;
			let bd = 18 * k + 6;
			for (const l of lights) {
				const dd = Math.hypot(l.x - x, l.y - y);
				if (dd < bd) {
					bd = dd;
					best = l;
				}
			}
			return best ? { l: best, px: best.x / k, py: best.y / k, r } : null;
		}

		function showTip(hit) {
			const { l, px, py, r } = hit;
			tip.textContent = '';
			const t = doc.createElement('p');
			t.className = 'ved-tip-nome';
			t.textContent = l.name;
			tip.appendChild(t);
			const s = doc.createElement('p');
			s.className = 'ved-tip-livello';
			s.textContent = l.livello === 'verde' ? 'In regola' : l.hits.length === 1 ? `${cap(LIVELLO[l.livello])}: ${l.hits[0].frase}` : `${cap(LIVELLO[l.livello])}: ${l.hits.length} regole`;
			tip.appendChild(s);
			tip.hidden = false;
			const box = ved.getBoundingClientRect();
			const tw = tip.offsetWidth || 220;
			let left = r.left - box.left + px + 14;
			if (left + tw > box.width - 4) left = r.left - box.left + px - tw - 14;
			tip.style.left = Math.max(4, left) + 'px';
			tip.style.top = Math.max(4, r.top - box.top + py - 18) + 'px';
		}
		const hideTip = () => (tip.hidden = true);

		// ---------- i progetti da sistemare ----------

		function hitKey(path, h, i) {
			return `${path}|${h.id}|${i}`;
		}

		function hitHTML(p, h, i) {
			const k = hitKey(p.path, h, i);
			const dk = 'd:' + k;
			const open = ui.open.has(dk);
			const det = Array.isArray(h.dettagli) ? h.dettagli : [];
			const pending = sent.has(k) && now() - sent.get(k) < 8000;
			let azione = '';
			if (h.azione && h.azione.act) {
				azione = `<button type="button" class="act${h.livello === 'rosso' ? ' main' : ''}" data-v="azione" data-path="${esc(p.path)}" data-hit="${i}" data-fk="v:az:${esc(k)}"${pending ? ' disabled aria-busy="true"' : ''}>${pending ? 'Chiesto…' : esc(h.azione.label || 'Rimedia')}</button>`;
			}
			const mostra = det.length
				? `<button type="button" class="link ved-mostra" data-v="dettagli" data-id="${esc(dk)}" data-fk="v:det:${esc(k)}" aria-expanded="${open}" aria-controls="ved-det-${esc(cssId(k))}">${open ? 'Nascondi' : det.length === 1 ? 'Mostra il dettaglio' : `Mostra i ${it(det.length)} dettagli`}</button>`
				: '';
			const lista = det.length ? `<ul class="ved-dettagli" id="ved-det-${esc(cssId(k))}"${open ? '' : ' hidden'}>${det.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
			return `<li class="ved-hit ved-hit-${h.livello}">
				<p class="ved-hit-frase">${segno(h.livello)}<span class="sr">${LIVELLO[h.livello]}: </span>${esc(h.frase)}</p>
				<p class="ved-hit-rimedio">${esc(h.rimedio)}</p>
				${azione || mostra ? `<div class="ved-hit-azioni">${azione}${mostra}</div>` : ''}
				${lista}
			</li>`;
		}

		function progettoHTML(p) {
			const pa = esc(p.path);
			const hits = [...p.hits].sort((a, b) => (a.livello === b.livello ? 0 : a.livello === 'rosso' ? -1 : 1));
			return `<li class="ved-prog ved-prog-${p.livello}" data-path="${pa}">
				<div class="ved-prog-testa">
					<p class="ved-prog-livello">${segno(p.livello)}${LIVELLO[p.livello]}</p>
					<h3 class="ved-prog-nome"><button type="button" class="ved-nome" data-v="progetto" data-path="${pa}" data-fk="v:p:${pa}" title="Mostra ${esc(p.name)} nella plancia">${esc(p.name)}</button></h3>
					${p.checkedAt ? `<span class="w">controllato ${esc(fa(p.checkedAt, now()))}</span>` : ''}
				</div>
				<ul class="ved-hits">${hits.map(h => hitHTML(p, h, p.hits.indexOf(h))).join('')}</ul>
			</li>`;
		}

		function cssId(s) {
			let h = 0;
			for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
			return (h >>> 0).toString(36);
		}

		function renderVerdi(verdi) {
			const box = $('ved-verdi');
			if (!verdi.length) return put(box, '');
			const open = ui.open.has('verdi');
			const n = verdi.length;
			const riga = `<p class="ved-conto">${segno('verde')}<span>${n === 1 ? `${esc(verdi[0].name)} è in regola` : `Altri ${it(n)} progetti in regola`}: numero di build, push, remoto, visibilità e segreti a posto.</span>${
				n > 1 ? ` <button type="button" class="link" data-v="dettagli" data-id="verdi" data-fk="v:verdi" aria-expanded="${open}" aria-controls="ved-verdi-nomi">${open ? 'Nascondi' : 'Quali sono'}</button>` : ''
			}</p>`;
			const nomi =
				n > 1
					? `<ul class="ved-verdi-nomi" id="ved-verdi-nomi"${open ? '' : ' hidden'}>${verdi
							.map(p => `<li><button type="button" class="link" data-v="progetto" data-path="${esc(p.path)}" data-fk="v:vp:${esc(p.path)}">${esc(p.name)}</button></li>`)
							.join('')}</ul>`
					: '';
			put(box, riga + nomi);
		}

		function renderGlobali() {
			const r = rules();
			const box = $('ved-globali');
			if (!r) return put(box, `<p class="ved-nota">Ancora nessun controllo.</p>`);
			const a = r.appAds;
			let html = `<p class="ved-nota">app-ads.txt deve essere identico, byte per byte, sui tre siti: AdMob lo legge dall'indirizzo di marketing di ogni app.</p>`;
			if (!a) html += `<p class="ved-nota">Non ancora letto.</p>`;
			else {
				// l'impronta della maggioranza: chi e' diverso va segnato
				const conta = new Map();
				for (const h of a.hosts) if (h.md5) conta.set(h.md5, (conta.get(h.md5) || 0) + 1);
				let maggioranza = null;
				let max = 0;
				for (const [k, v] of conta) if (v > max) (max = v), (maggioranza = k);
				const stato = a.identical
					? `<p class="ved-stato ved-stato-verde">${segno('verde')}Identico sui tre siti</p>`
					: `<p class="ved-stato ved-stato-rosso">${segno('rosso')}Non è identico: va sistemato subito</p>`;
				html += stato;
				html += `<table class="ved-host"><caption class="sr">Impronta di app-ads.txt su ogni sito</caption><thead><tr><th scope="col">Sito</th><th scope="col">Impronta</th></tr></thead><tbody>${a.hosts
					.map(h => {
						const diverso = !a.identical && (!h.md5 || (maggioranza && h.md5 !== maggioranza));
						const imp = h.md5 ? `<code title="${esc(h.md5)}">${esc(h.md5.slice(0, 8))}</code>` : '<span class="ved-nd">n/d</span>';
						const err = h.error ? `<span class="ved-host-errore">${esc(h.error)}</span>` : '';
						return `<tr${diverso ? ' class="ved-diverso"' : ''}><th scope="row">${diverso ? segno('rosso') + '<span class="sr">diverso: </span>' : ''}${esc(h.host)}</th><td>${imp}${err}</td></tr>`;
					})
					.join('')}</tbody></table>`;
				if (a.checkedAt) html += `<p class="w ved-glob-quando">Letto ${esc(fa(a.checkedAt, now()))}</p>`;
			}
			const altre = (r.global || []).filter(h => !(h.id === 'app-ads' && a));
			if (altre.length) html += `<ul class="ved-hits ved-hits-globali">${altre.map(h => hitHTML({ path: '' }, h, (r.global || []).indexOf(h))).join('')}</ul>`;
			put(box, html);
		}

		function renderRegole() {
			const list = ordered();
			put($('ved-frase'), frase(list));
			renderTimbroRegole();
			crinale(list);
			legenda(list);
			const da = list.filter(p => p.livello !== 'verde');
			const vuoto = $('ved-vuoto');
			const r = rules();
			if (!r) {
				vuoto.hidden = false;
				vuoto.textContent = 'Il primo controllo parte da solo. Puoi anche chiederlo adesso con Ricontrolla.';
			} else if (!da.length) {
				vuoto.hidden = false;
				vuoto.textContent = list.length ? 'Niente da sistemare. Ogni progetto rispetta le regole.' : 'Nessun progetto da controllare.';
			} else vuoto.hidden = true;
			sync($('ved-lista'), da, p => p.path, progettoHTML);
			renderVerdi(list.filter(p => p.livello === 'verde'));
			renderGlobali();
		}

		// ---------- lo Store e i soldi ----------

		/** Le date dei 7 giorni di una serie: l'ultimo e' ieri rispetto alla lettura di AdMob. */
		function giorniSerie(n, at) {
			const ieri = new Date(at || now());
			ieri.setHours(12, 0, 0, 0);
			const fine = ieri.getTime() - DAY;
			return Array.from({ length: n }, (_, i) => fine - (n - 1 - i) * DAY);
		}

		/** Sparkline a colonne: i giorni in grigio, ieri nell'accento. Con testo per i lettori di schermo. */
		function serie(daily, cur, at, size) {
			const v = (Array.isArray(daily) ? daily : []).map(x => Math.max(0, Number(x) || 0));
			if (!v.length) return '';
			const big = size === 'grande';
			const H = big ? 46 : 26;
			const bw = big ? 14 : 8;
			const gap = big ? 8 : 4;
			const W = v.length * bw + (v.length - 1) * gap;
			const max = Math.max(...v);
			const giorni = giorniSerie(v.length, at);
			const col = (x, h) => {
				const y = H - h;
				const r = Math.min(big ? 4 : 3, bw / 2, h);
				if (h <= 0) return '';
				return `M${x},${H}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${H}Z`;
			};
			const cols = v
				.map((x, i) => {
					const h = max > 0 ? Math.max(x > 0 ? 1.5 : 0, (x / max) * (H - 2)) : 0;
					const cx = i * (bw + gap);
					const last = i === v.length - 1;
					return `<g><title>${esc(giornoCorto(giorni[i]))}: ${esc(soldi(x, cur))}</title><rect class="ved-presa" x="${cx - gap / 2}" y="0" width="${bw + gap}" height="${H}"/><path class="${last ? 'ved-col-ieri' : 'ved-col'}" d="${col(cx, h)}"/></g>`;
				})
				.join('');
			const testo = `Ultimi ${parola(v.length)} giorni, dal più vecchio: ${v.map((x, i) => `${giornoLungo(giorni[i])} ${soldi(x, cur)}`).join('; ')}.`;
			return `<span class="ved-serie${big ? ' ved-serie-grande' : ''}"><svg viewBox="0 -1 ${W} ${H + 2}" width="${W}" height="${H + 2}" aria-hidden="true" focusable="false"><line class="ved-base" x1="0" x2="${W}" y1="${H + 0.5}" y2="${H + 0.5}"/>${cols}</svg><span class="sr">${esc(testo)}</span></span>`;
		}

		function stelle(n) {
			const k = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
			return `<span class="ved-stelle" role="img" aria-label="${k} ${k === 1 ? 'stella' : 'stelle'} su 5"><span class="ved-stelle-piene" aria-hidden="true">${'★'.repeat(k)}</span><span class="ved-stelle-vuote" aria-hidden="true">${'★'.repeat(5 - k)}</span></span>`;
		}

		function recensioneHTML(rv) {
			const quando = rv.at ? `<time class="w">${esc(fa(rv.at, now()))}</time>` : '';
			const dove = rv.territory ? `<span class="w">${esc(rv.territory)}</span>` : '';
			return `<li class="ved-rec"><p class="ved-rec-testa">${stelle(rv.stars)}${rv.title ? `<b>${esc(rv.title)}</b>` : ''}${dove}${quando}</p>${rv.body ? `<p class="ved-rec-corpo">${esc(rv.body)}</p>` : ''}</li>`;
		}

		function versioneHTML(a) {
			const v = a.version;
			if (!v) {
				return `<p class="ved-stato ved-stato-verde">${segno('verde')}${a.live ? `In vendita la ${esc(a.live)}` : 'Nessuna versione in preparazione'}</p>`;
			}
			const liv = TONO[v.tone] || 'giallo';
			const parti = [];
			if (v.string) parti.push(`versione ${esc(v.string)}${v.build ? `, build ${esc(v.build)}` : ''}`);
			if (a.live && a.live !== v.string) parti.push(`in vendita la ${esc(a.live)}`);
			if (v.releaseType) parti.push(v.releaseType === 'AFTER_APPROVAL' ? 'esce da sola' : 'uscita a mano');
			return `<p class="ved-stato ved-stato-${liv}">${segno(liv)}${esc(v.label || v.state || '')}</p>${parti.length ? `<p class="w ved-versione">${cap(parti.join(', '))}</p>` : ''}`;
		}

		function appHTML(a, cur, at) {
			const id = esc(a.ascId || a.bundleId);
			const prog = a.projectPath
				? `<button type="button" class="link ved-app-prog" data-v="progetto" data-path="${esc(a.projectPath)}" data-fk="v:ap:${id}" title="Mostra il progetto nella plancia">${esc(nameOf(a.projectPath))}</button>`
				: `<span class="w">nessun progetto collegato</span>`;
			const rv = Array.isArray(a.reviews) ? a.reviews : [];
			const rk = 'r:' + (a.ascId || a.bundleId);
			const open = ui.open.has(rk);
			let rec = `<p class="w">Nessuna recensione recente.</p>`;
			if (rv.length) {
				const altre = rv.slice(1);
				rec = `<ul class="ved-recs">${recensioneHTML(rv[0])}</ul>`;
				if (altre.length) {
					rec += `<ul class="ved-recs ved-recs-altre" id="ved-rec-${esc(cssId(rk))}"${open ? '' : ' hidden'}>${altre.map(recensioneHTML).join('')}</ul>`;
					rec += `<button type="button" class="link ved-mostra" data-v="dettagli" data-id="${esc(rk)}" data-fk="v:rec:${id}" aria-expanded="${open}" aria-controls="ved-rec-${esc(cssId(rk))}">${open ? 'Nascondi' : altre.length === 1 ? "Mostra l'altra recensione" : `Mostra le altre ${it(altre.length)}`}</button>`;
				}
			}
			const m = a.money;
			const soldiHTML = m
				? `<p class="ved-ieri"><b>${esc(soldi(m.yesterday, m.currency || cur))}</b> <span>ieri</span></p><p class="w">${esc(soldi(m.last7, m.currency || cur))} in 7 giorni</p>${serie(m.daily, m.currency || cur, at)}`
				: `<p class="w">Nessuna pubblicità collegata.</p>`;
			const tono = a.version ? TONO[a.version.tone] || 'giallo' : 'verde';
			return `<li class="ved-app-riga ved-app-${tono}">
				<div class="ved-app-chi"><h3 class="ved-app-nome">${esc(a.name)}</h3>${prog}</div>
				<div class="ved-app-versione">${versioneHTML(a)}</div>
				<div class="ved-app-recensioni">${rec}</div>
				<div class="ved-app-soldi">${soldiHTML}</div>
			</li>`;
		}

		function renderRadar() {
			const r = radar();
			const t = now();
			const refreshing = !!(r && r.refreshing) || (askedRadar && t - askedRadar < 10_000);
			if (r && r.refreshing) askedRadar = 0;
			const timbro = $('ved-timbro-radar');
			timbro.setAttribute('aria-busy', refreshing ? 'true' : 'false');
			timbro.querySelector('button').disabled = refreshing;

			let letto;
			if (refreshing) letto = 'Sto rileggendo App Store Connect e AdMob…';
			else if (!r || (!r.ascAt && !r.admobAt)) letto = 'Mai letto';
			else {
				const parti = [];
				if (r.ascAt) parti.push(r.ascError ? `App Store senza rete: ultimo dato ${di(r.ascAt, t)}` : `App Store letto ${fa(r.ascAt, t)}`);
				if (r.admobAt) parti.push(r.admobError ? `AdMob senza rete: ultimo dato ${di(r.admobAt, t)}` : `AdMob letto ${fa(r.admobAt, t)}`);
				letto = parti.join(', ');
			}
			const l = $('ved-letto');
			if (l.textContent !== letto) l.textContent = letto;

			const errori = [];
			if (r && r.ascError) errori.push(`<p>${segno('rosso')}<span><b>App Store Connect</b> non risponde: ${esc(r.ascError)}</span></p>`);
			if (r && r.admobError) errori.push(`<p>${segno('rosso')}<span><b>AdMob</b> non risponde: ${esc(r.admobError)}</span></p>`);
			put($('ved-errori'), errori.join(''));

			const tot = r && r.totals;
			const cur = (tot && tot.currency) || 'USD';
			if (tot) {
				put(
					$('ved-totali'),
					`<dl class="ved-cifre">
						<div class="ved-cifra"><dt>Ieri</dt><dd><b>${esc(soldi(tot.yesterday, cur))}</b></dd></div>
						<div class="ved-cifra"><dt>Ultimi 7 giorni</dt><dd><b>${esc(soldi(tot.last7, cur))}</b></dd></div>
						<div class="ved-cifra ved-cifra-serie"><dt>Giorno per giorno, ieri in evidenza</dt><dd>${serie(tot.daily, cur, r.admobAt, 'grande')}</dd></div>
					</dl>`,
				);
			} else put($('ved-totali'), r && r.admobAt === 0 && !r.admobError ? `<p class="ved-nota">I guadagni di AdMob non sono ancora stati letti.</p>` : '');

			const apps = r && Array.isArray(r.apps) ? r.apps : [];
			const rank = { male: 0, attesa: 1, ok: 2 };
			const list = [...apps].sort((a, b) => {
				const ta = a.version ? rank[a.version.tone] ?? 1 : 2;
				const tb = b.version ? rank[b.version.tone] ?? 1 : 2;
				return ta - tb || ((b.money && b.money.last7) || 0) - ((a.money && a.money.last7) || 0) || String(a.name).localeCompare(String(b.name), 'it');
			});
			const lista = $('ved-app');
			if (!list.length) {
				lista.hidden = true;
				if (!$('ved-app-vuoto')) lista.insertAdjacentHTML('afterend', `<p class="ved-nota" id="ved-app-vuoto">${r && r.ascAt ? 'Nessuna app su App Store Connect.' : 'App Store Connect non è ancora stato letto.'}</p>`);
			} else {
				lista.hidden = false;
				const v = $('ved-app-vuoto');
				if (v) v.remove();
			}
			sync(lista, list, a => a.ascId || a.bundleId, a => appHTML(a, cur, r.admobAt));
		}

		// ---------- i siti su Vercel ----------

		const vercel = () => {
			const r = radar();
			return r && r.vercel ? r.vercel : null;
		};
		/** Il semaforo di un sito: pronta verde, in costruzione o in coda ambra, fallita rossa. */
		const TONO_SITO = { ok: 'verde', attesa: 'giallo', male: 'rosso' };
		/** Solo indirizzi di vercel.com: il link apre il dettaglio della pubblicazione nel browser. */
		const linkVercel = u => (typeof u === 'string' && /^https:\/\/vercel\.com\//.test(u) ? u : 'https://vercel.com/dashboard');

		function sitoHTML(s) {
			const t = now();
			const liv = TONO_SITO[s.tone] || 'giallo';
			const href = esc(linkVercel(s.url));
			const quando = s.at ? `<time class="w" title="${esc(giornoLungo(s.at))}, alle ${esc(ora(s.at))}">${esc(fa(s.at, t))}</time>` : '';
			const prog =
				s.projectPath && nameOf(s.projectPath).toLowerCase() !== String(s.name).toLowerCase()
					? `<button type="button" class="link ved-app-prog" data-v="progetto" data-path="${esc(s.projectPath)}" data-fk="v:sp:${esc(s.projectId)}" title="Mostra il progetto nella plancia">${esc(nameOf(s.projectPath))}</button>`
					: '';
			const commit = s.commit && s.commit.message ? `<p class="w ved-sito-commit"><code>${esc(String(s.commit.sha || '').slice(0, 7))}</code> ${esc(s.commit.message)}</p>` : '';
			const errore = s.error ? `<p class="ved-sito-errore">${esc(s.error)}</p>` : '';
			const online = s.lastReady && s.lastReady.at ? `<p class="w">Online resta quella di ${esc(fa(s.lastReady.at, t))}.</p>` : '';
			return `<li class="ved-sito ved-sito-${liv}">
				<div class="ved-sito-chi">
					<h3 class="ved-sito-nome"><a href="${href}" target="_blank" rel="noopener noreferrer" data-fk="v:s:${esc(s.projectId)}" title="Apri il dettaglio della pubblicazione su vercel.com">${esc(s.name)}</a></h3>
					${prog}
				</div>
				<p class="ved-sito-dominio">${s.domain ? esc(s.domain) : '<span class="ved-nd">n/d</span>'}</p>
				<div class="ved-sito-stato">
					<p class="ved-stato ved-stato-${liv}">${segno(liv)}${esc(s.label || s.state || '')}${quando ? ' ' + quando : ''}</p>
					${errore}${online}${commit}
				</div>
			</li>`;
		}

		function renderSiti() {
			const v = vercel();
			const t = now();
			const refreshing = !!(v && v.refreshing) || (askedSiti && t - askedSiti < 10_000);
			if (v && v.refreshing) askedSiti = 0;
			const timbro = $('ved-timbro-siti');
			timbro.setAttribute('aria-busy', refreshing ? 'true' : 'false');
			timbro.querySelector('button').disabled = refreshing;
			let letto;
			if (refreshing) letto = 'Sto rileggendo Vercel…';
			else if (!v || !v.at) letto = 'Mai letto';
			else letto = v.error ? `Vercel senza rete: ultimo dato ${di(v.at, t)}` : `Vercel letto ${fa(v.at, t)}`;
			const l = $('ved-siti-letto');
			if (l.textContent !== letto) l.textContent = letto;
			put($('ved-siti-errori'), v && v.error ? `<p>${segno('rosso')}<span><b>Vercel</b>: ${esc(v.error)}</span></p>` : '');

			const sites = v && Array.isArray(v.sites) ? v.sites : [];
			const rank = { male: 0, attesa: 1, ok: 2 };
			const list = [...sites].sort((a, b) => (rank[a.tone] ?? 1) - (rank[b.tone] ?? 1) || (b.at || 0) - (a.at || 0));
			const vuoto = $('ved-siti-vuoto');
			if (!list.length) {
				vuoto.hidden = false;
				const txt = !v ? 'Vercel non viene letto in questa versione della Bottega.' : v.at ? 'Nessun progetto è collegato a un progetto su Vercel.' : 'Vercel non è ancora stato letto.';
				if (vuoto.textContent !== txt) vuoto.textContent = txt;
			} else vuoto.hidden = true;
			sync($('ved-siti'), list, s => s.projectId, sitoHTML);
		}

		function render() {
			if (!visible) {
				dirty = true;
				return;
			}
			dirty = false;
			renderRegole();
			renderRadar();
			renderSiti();
		}

		// ---------- eventi ----------

		root.addEventListener('click', e => {
			const b = /** @type {any} */ (e.target).closest && /** @type {any} */ (e.target).closest('[data-v]');
			if (!b || !root.contains(b) || b.disabled) return;
			const v = b.getAttribute('data-v');
			switch (v) {
				case 'ricontrolla':
					askedRules = now();
					post({ type: 'rules.refresh' });
					say('Ricontrollo le regole su tutti i progetti.');
					return renderTimbroRegole();
				case 'radar':
					askedRadar = now();
					post({ type: 'radar.refresh' });
					say('Rileggo App Store Connect e AdMob.');
					return renderRadar();
				case 'siti':
					// radar.refresh forzato rilegge anche Vercel (al massimo una volta al minuto)
					askedSiti = now();
					post({ type: 'radar.refresh' });
					say('Rileggo Vercel.');
					return renderSiti();
				case 'progetto': {
					const p = b.getAttribute('data-path');
					if (p && host && host.focusProject) host.focusProject(p);
					return;
				}
				case 'dettagli': {
					const id = b.getAttribute('data-id');
					if (ui.open.has(id)) ui.open.delete(id);
					else ui.open.add(id);
					save();
					return render();
				}
				case 'azione': {
					const path = b.getAttribute('data-path') || '';
					const i = Number(b.getAttribute('data-hit'));
					const r = rules();
					if (!r) return;
					const hits = path ? (r.projects[path] && r.projects[path].hits) || [] : r.global || [];
					const h = hits[i];
					if (!h || !h.azione) return;
					const msg = { type: h.azione.act, ...(path ? { path } : {}), ...(h.azione.args || {}) };
					post(msg);
					sent.set(hitKey(path, h, i), now());
					say(h.azione.act === 'rule.fix' ? 'La Bottega chiede conferma prima di cambiare.' : `Fatto: ${h.azione.label || 'chiesto'}.`);
					setTimeout(() => render(), 8100);
					return render();
				}
			}
		});

		// il crinale: passando sopra una luce si legge di chi e'; un clic porta al progetto
		const box = $('ved-crinale-svg');
		box.addEventListener('pointermove', e => {
			const h = nearest(e);
			if (!h) {
				accendi('');
				return hideTip();
			}
			accendi(h.l.path);
			showTip(h);
		});
		box.addEventListener('pointerleave', () => {
			accendi('');
			hideTip();
		});
		box.addEventListener('click', e => {
			const h = nearest(e);
			if (!h) return;
			const row = root.querySelector(`.ved-prog[data-key="${cssEsc(h.l.path)}"] .ved-nome`);
			if (row) {
				row.focus({ preventScroll: true });
				if (row.scrollIntoView) row.scrollIntoView({ block: 'center', behavior: reduced.matches ? 'auto' : 'smooth' });
			} else if (host && host.focusProject) host.focusProject(h.l.path);
		});
		box.classList.add('ved-cliccabile');

		const cssEsc = s => String(s).replace(/["\\]/g, '\\$&');

		// passando sull'elenco o arrivandoci col tab, si accende la luce del progetto
		const lista = $('ved-lista');
		const light = el => {
			const li = el && el.closest ? el.closest('.ved-prog') : null;
			accendi(li ? li.getAttribute('data-path') : '');
		};
		lista.addEventListener('pointerover', e => light(e.target));
		lista.addEventListener('pointerleave', () => accendi(''));
		lista.addEventListener('focusin', e => light(e.target));
		lista.addEventListener('focusout', () => accendi(''));

		let resizeT = 0;
		const onResize = () => {
			if (!visible) return;
			clearTimeout(resizeT);
			resizeT = setTimeout(() => crinale(ordered()), 160);
		};
		if (doc.defaultView) doc.defaultView.addEventListener('resize', onResize);

		const ferma = () => ved.classList.add('ved-fermo');
		const riparti = () => visible && ved.classList.remove('ved-fermo');
		ferma();

		return {
			/** Snapshot nuovo: progetti, regole, radar. Riscrive solo cio' che e' cambiato. */
			update(snapshot) {
				if (!snapshot) return;
				snap = snapshot;
				// la risposta a rules.refresh e radar.refresh e' uno snapshot: da qui decide lui (running, refreshing)
				askedRules = 0;
				askedRadar = 0;
				askedSiti = 0;
				render();
			},
			/** Messaggi diretti alla Vedetta: per ora nessuno oltre allo snapshot. */
			message(m) {
				if (m && m.type === 'snapshot' && m.snapshot) this.update(m.snapshot);
			},
			show() {
				visible = true;
				riparti();
				if (dirty || snap) render();
			},
			hide() {
				visible = false;
				ferma();
				hideTip();
			},
			pause() {
				ferma();
			},
			resume() {
				riparti();
			},
		};
	}

	/** @type {any} */ (window).BottegaVedetta = { mount };
})();
