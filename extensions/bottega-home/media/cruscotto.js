/* Bottega, il cruscotto: la quinta stanza della plancia. Ore di lavoro, token e progetti letti dai
   registri di Claude Code (src/stats.ts li riassume, docs/CONTRATTI.md sezione 3 ne descrive la forma).

   Idea: un osservatorio. Il pezzo forte e' la carta del cielo: ogni progetto e' una stella su un
   orologio di 24 ore (come l'ascensione retta, che si misura in ore), grande quanto le ore che ci
   hai passato, vicina al centro se ci hai lavorato da poco, con la scia delle ore in cui ci lavori
   e le linee verso i progetti lavorati insieme. Attorno, strumenti sobri e precisi: la curva di
   luce delle ore, i token, la settimana ora per ora, il registro.

   Regole: niente librerie, SVG scritto a mano, nessun attributo style nell'HTML (la CSP lo blocca;
   le posizioni dinamiche passano da element.style, che e' permesso). Testo dei dati sempre
   sfuggito o messo con textContent. Ogni grafico ha la sua tabella e si usa da tastiera. */
(function () {
	'use strict';

	const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
	const MESI_B = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
	const GIORNI = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
	const GIORNI_B = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];
	const PAROLE = ['nessuna', 'una', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci'];
	const DAY = 86_400_000;

	const PERIODI = [
		['7', '7 giorni'],
		['30', '30 giorni'],
		['90', '90 giorni'],
	];
	const GRUPPI = [
		['giorno', 'Per giorno'],
		['settimana', 'Per settimana'],
		['mese', 'Per mese'],
	];
	/** Raggruppamenti che hanno senso per ogni periodo. */
	const GRUPPI_OK = { '7': ['giorno'], '30': ['giorno', 'settimana'], '90': ['giorno', 'settimana', 'mese'] };

	/** I quattro tipi di token, nell'ordine della pila (dal basso). Colori validati (dataviz). */
	const TIPI = [
		['cr', 'Letti dalla cache', 2],
		['in', 'Input', 0],
		['cw', 'Scritti in cache', 3],
		['out', 'Output', 1],
	];

	// ---------- formati ----------

	const esc = s =>
		String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	const it = (n, d = 0) => Number(n || 0).toLocaleString('it-IT', { maximumFractionDigits: d, minimumFractionDigits: 0 });
	const parola = n => (n >= 0 && n < PAROLE.length ? PAROLE[n] : it(n));

	/** "5 h 20 min", "45 min", "meno di un minuto", "135 h" */
	function hm(min) {
		const m = Math.round(min || 0);
		if (m < 1) return min > 0 ? 'meno di un minuto' : '0 min';
		if (m < 60) return `${m} min`;
		const h = Math.floor(m / 60);
		if (h >= 100) return `${it(h)} h`;
		return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
	}

	/** Per le frasi: "22 ore e 45 minuti", "un'ora", "45 minuti". */
	function oreParole(min) {
		const m = Math.round(min || 0);
		if (m < 1) return 'meno di un minuto';
		const h = Math.floor(m / 60);
		const r = m % 60;
		const hs = h === 0 ? '' : h === 1 ? "un'ora" : `${it(h)} ore`;
		const ms = r === 0 ? '' : r === 1 ? 'un minuto' : `${r} minuti`;
		return hs && ms ? `${hs} e ${ms}` : hs || ms;
	}

	/** Token, corto: "850", "12 mila", "340 mln", "1,4 mld". */
	function tk(n) {
		n = n || 0;
		if (n >= 1e9) return `${it(n / 1e9, n >= 1e10 ? 0 : 1)} mld`;
		if (n >= 1e6) return `${it(n / 1e6, n >= 1e7 ? 0 : 1)} mln`;
		if (n >= 1e4) return `${it(n / 1e3)} mila`;
		return it(n);
	}

	/** Token, nelle frasi: "1,4 miliardi", "340 milioni". */
	function tkParole(n) {
		n = n || 0;
		if (n >= 1e9) return `${it(n / 1e9, 1)} ${n >= 2e9 ? 'miliardi' : 'miliardo'}`;
		if (n >= 1e6) return `${it(n / 1e6, n >= 1e7 ? 0 : 1)} ${n >= 2e6 ? 'milioni' : 'milione'}`;
		if (n >= 1e3) return `${it(n / 1e3)} mila`;
		return it(n);
	}

	const usd = n => `${it(n, n < 10 ? 2 : 0)} $`;
	const pct = (a, b) => (b ? (a / b) * 100 : 0);
	const pctTxt = x => (x > 0 && x < 0.1 ? 'meno dello 0,1%' : `${it(x, x < 10 ? 1 : 0)}%`);
	const sum4 = t => (t ? t[0] + t[1] + t[2] + t[3] : 0);

	function parseDay(k) {
		const [y, m, d] = k.split('-').map(Number);
		return new Date(y, m - 1, d);
	}
	const giornoB = k => {
		const d = parseDay(k);
		return `${d.getDate()} ${MESI_B[d.getMonth()]}`;
	};
	const giornoL = k => {
		const d = parseDay(k);
		return `${GIORNI[(d.getDay() + 6) % 7]} ${d.getDate()} ${MESI[d.getMonth()]}`;
	};
	const giornoM = k => {
		const d = parseDay(k);
		return `${d.getDate()} ${MESI[d.getMonth()]}`;
	};
	const ora = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
	const meseL = key => MESI[Number(key.slice(5, 7)) - 1];
	/** Giorno locale YYYY-MM-DD di un istante. */
	const localKey = ms => {
		const d = new Date(ms);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	};

	function fa(ms, now) {
		const m = Math.max(0, (now - ms) / 60_000);
		if (m < 2) return 'adesso';
		if (m < 60) return `${Math.round(m)} min fa`;
		const h = m / 60;
		if (h < 24) return `${Math.round(h)} h fa`;
		const d = Math.round(h / 24);
		return d === 1 ? 'ieri' : `${d} giorni fa`;
	}

	/** Passo "rotondo" per un asse: 1, 2, 2,5, 5 per potenze di dieci. */
	function passo(max, n) {
		if (!(max > 0)) return 1;
		const raw = max / n;
		const p = Math.pow(10, Math.floor(Math.log10(raw)));
		const f = raw / p;
		return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
	}

	/** Barra verticale con l'estremo dei dati arrotondato (4 px) e la base quadrata. */
	function colonna(x, y, w, h, round) {
		if (h <= 0 || w <= 0) return '';
		const r = round ? Math.min(4, w / 2, h) : 0;
		const b = y + h;
		if (!r) return `M${x},${b}V${y}H${x + w}V${b}Z`;
		return `M${x},${b}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${b}Z`;
	}

	/** Generatore deterministico per il campo di stelle di sfondo (sempre lo stesso cielo). */
	function semi(seed) {
		return () => {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	// ---------- montaggio ----------

	function mount(root, host) {
		const saved = host.saved || {};
		const ui = {
			period: ['7', '30', '90'].includes(saved.period) ? saved.period : '30',
			group: saved.group || 'giorno',
			sort: saved.sort === 'token' ? 'token' : 'ore',
			all: !!saved.all,
			tables: saved.tables || {},
		};
		const reduced = host.reduced || { matches: false };
		const save = () => host.save && host.save({ period: ui.period, group: ui.group, sort: ui.sort, all: ui.all, tables: ui.tables });

		/** @type {any} */ let stats = null;
		let error = '';
		let visible = false;
		let revealed = false;
		let waitTimer = 0;
		let lastKey = '';

		root.innerHTML = `
		<div class="crus" id="crus">
			<p class="empty" id="crus-attesa">Sto leggendo le sessioni di Claude Code. La prima volta ci vuole qualche secondo, poi si rilegge solo quello che è cambiato.</p>
			<div class="crus-errore" id="crus-errore" hidden><p id="crus-errore-testo"></p><button type="button" class="act" data-c="riprova" data-fk="c:riprova">Riprova</button></div>
			<div id="crus-corpo" hidden>
				<div class="crus-testa">
					<h1 class="sentence media" id="crus-frase"></h1>
					<p class="crus-timbro"><span id="crus-letto"></span><button type="button" class="ghost" data-c="aggiorna" data-fk="c:aggiorna">Aggiorna</button></p>
				</div>
				<div class="crus-filtri" id="crus-filtri"></div>
				<dl class="cifre" id="crus-cifre"></dl>

				<section class="crus-cielo" aria-labelledby="carta-titolo">
					<figure class="carta" id="carta">
						<h2 id="carta-titolo">Il cielo dei progetti</h2>
						<div class="carta-svg" id="carta-svg" aria-hidden="true"></div>
						<figcaption id="carta-legenda" class="carta-legenda"></figcaption>
						<div class="tabella-blocco" id="carta-tabella"></div>
					</figure>
					<div class="classifica">
						<div class="sez-testa"><h2 id="classifica-titolo">Progetti</h2><div class="interruttori" role="group" aria-label="Ordina i progetti" id="crus-ordina"></div></div>
						<p class="nota" id="classifica-nota"></p>
						<ol class="righe-classifica" id="classifica" aria-labelledby="classifica-titolo"></ol>
						<div id="classifica-piede"></div>
					</div>
				</section>

				<section class="crus-sez" aria-labelledby="curva-titolo">
					<div class="sez-testa"><h2 id="curva-titolo">Ore di lavoro</h2><ul class="legenda" id="curva-legenda"></ul></div>
					<p class="nota" id="curva-nota"></p>
					<div class="grafico" id="curva" tabindex="0" role="group" aria-roledescription="grafico" data-fk="c:curva"></div>
					<div class="tabella-blocco" id="curva-tabella"></div>
				</section>

				<section class="crus-due" aria-labelledby="token-titolo">
					<div class="crus-sez">
						<div class="sez-testa"><h2 id="token-titolo">Token</h2><ul class="legenda" id="token-legenda"></ul></div>
						<p class="nota" id="token-nota"></p>
						<div class="grafico" id="token" tabindex="0" role="group" aria-roledescription="grafico" data-fk="c:token"></div>
						<div class="tabella-blocco" id="token-tabella"></div>
					</div>
					<aside class="crus-lato" aria-label="Composizione, modelli e valore">
						<h3>Di che cosa sono fatti</h3>
						<div id="spettro"></div>
						<h3>Per modello</h3>
						<div id="modelli"></div>
						<div id="valore"></div>
					</aside>
				</section>

				<section class="crus-due" aria-labelledby="calore-titolo">
					<div class="crus-sez">
						<div class="sez-testa"><h2 id="calore-titolo">La settimana, ora per ora</h2><div class="scala" id="calore-scala"></div></div>
						<p class="nota" id="calore-nota"></p>
						<div class="grafico calore" id="calore" tabindex="0" role="group" aria-roledescription="mappa di calore" data-fk="c:calore"></div>
						<div class="tabella-blocco" id="calore-tabella"></div>
					</div>
					<aside class="crus-lato registro-lato" aria-labelledby="registro-titolo">
						<h3 id="adesso-titolo">Adesso</h3>
						<ul class="adesso" id="adesso" aria-labelledby="adesso-titolo"></ul>
						<h3 id="registro-titolo">Registro</h3>
						<dl class="primati" id="primati"></dl>
					</aside>
				</section>

				<p class="come-conto" id="come-conto"></p>
			</div>
			<div class="crus-tip" id="crus-tip" hidden></div>
			<p class="sr" id="crus-voce" aria-live="polite"></p>
		</div>`;

		const $ = id => /** @type {any} */ (root.querySelector('#' + id));
		const crus = $('crus');
		const tip = $('crus-tip');

		// ---------- piccoli attrezzi ----------

		const lastHTML = new WeakMap();
		function put(el, html) {
			if (lastHTML.get(el) === html) return;
			const a = /** @type {any} */ (el.ownerDocument.activeElement);
			const k = a && el.contains(a) && a.closest('[data-fk]') ? a.closest('[data-fk]').getAttribute('data-fk') : null;
			el.innerHTML = html;
			lastHTML.set(el, html);
			if (k) {
				for (const back of el.querySelectorAll('[data-fk]')) {
					if (back.getAttribute('data-fk') === k) {
						back.focus({ preventScroll: true });
						break;
					}
				}
			}
		}

		function say(text) {
			const v = $('crus-voce');
			v.textContent = '';
			setTimeout(() => (v.textContent = text), 20);
		}

		const width = el => {
			const w = el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 0;
			return w > 40 ? w : 860;
		};

		/** Tooltip: valori in evidenza, nome dopo. Tutto con textContent. */
		function showTip(anchorEl, x, y, title, rows) {
			tip.textContent = '';
			const t = document.createElement('p');
			t.className = 'tip-titolo';
			t.textContent = title;
			tip.appendChild(t);
			for (const r of rows) {
				const p = document.createElement('p');
				p.className = 'tip-riga';
				if (r.key) {
					const k = document.createElement('i');
					k.className = 'chiave ' + r.key;
					k.setAttribute('aria-hidden', 'true');
					p.appendChild(k);
				}
				const b = document.createElement('b');
				b.textContent = r.value;
				p.appendChild(b);
				if (r.label) {
					const s = document.createElement('span');
					s.textContent = r.label;
					p.appendChild(s);
				}
				tip.appendChild(p);
			}
			tip.hidden = false;
			const box = crus.getBoundingClientRect();
			const a = anchorEl.getBoundingClientRect();
			const tw = tip.offsetWidth || 220;
			const th = tip.offsetHeight || 80;
			let left = a.left - box.left + x + 14;
			if (left + tw > box.width - 4) left = a.left - box.left + x - tw - 14;
			let top = a.top - box.top + y - th / 2;
			top = Math.max(4, top);
			tip.style.left = Math.max(4, left) + 'px';
			tip.style.top = top + 'px';
		}
		const hideTip = () => (tip.hidden = true);

		function tabella(id, label, heads, rows) {
			const open = !!ui.tables[id];
			const btn = `<button type="button" class="link mostra-tabella" data-c="tabella" data-id="${id}" data-fk="c:tab:${id}" aria-expanded="${open}">${open ? 'Nascondi i numeri' : 'Mostra i numeri'}</button>`;
			if (!open) return btn;
			return (
				btn +
				`<div class="tabella-scorre"><table><caption class="sr">${esc(label)}</caption><thead><tr>${heads.map((h, i) => `<th scope="col"${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
					.map(r => `<tr>${r.map((c, i) => (i ? `<td class="num">${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`)).join('')}</tr>`)
					.join('')}</tbody></table></div>`
			);
		}

		const P = () => (stats ? stats.periods[ui.period] : null);
		const now = () => (stats ? stats.computedAt : Date.now());

		/** Il periodo precedente ha dati? Se i registri partono dopo, il confronto non dice niente. */
		function prevOk(p) {
			if (!stats || !stats.firstEvent) return false;
			const prevStart = parseDay(p.from).getTime() - p.days * DAY;
			return stats.firstEvent <= prevStart + DAY;
		}

		function delta(cur, prev, ok, fmt) {
			if (!ok) return { txt: 'nessun dato prima', cls: 'muto', sr: '' };
			const d = cur - prev;
			if (Math.abs(d) < (fmt === 'min' ? 1 : 1e-9) || (prev && Math.abs(d) / prev < 0.005)) return { txt: 'come prima', cls: 'pari', sr: '' };
			const v = fmt === 'min' ? hm(Math.abs(d)) : fmt === 'tok' ? tk(Math.abs(d)) : fmt === 'usd' ? usd(Math.abs(d)) : it(Math.abs(d));
			return { txt: `${d > 0 ? '▲' : '▼'} ${v}`, cls: d > 0 ? 'su' : 'giu', sr: d > 0 ? 'in più' : 'in meno' };
		}

		// ---------- intestazione ----------

		function frase() {
			const w = stats.week;
			const n = s => `<span class="n">${s}</span>`;
			let out;
			if (w.now.you < 1) {
				out = `Questa settimana non hai ancora lavorato con Claude.`;
				if (w.prevFull.you >= 1) out += ` La scorsa: ${n(oreParole(w.prevFull.you))}.`;
				return out;
			}
			out = `Questa settimana hai lavorato ${n(oreParole(w.now.you))}`;
			const d = w.now.you - w.prevSoFar.you;
			if (w.prevSoFar.you < 1 && w.prevFull.you < 1) out += '.';
			else if (Math.abs(d) < 30) out += ', come la scorsa a questo punto.';
			else out += `, ${n(oreParole(Math.abs(d)))} ${d > 0 ? 'più' : 'meno'} della scorsa a questo punto.`;
			const today = stats.today.you;
			const vive = stats.live.length;
			if (today >= 1) {
				out += ` Oggi sei a ${n(oreParole(today))}`;
				out += vive ? `, con ${n(parola(vive))} ${vive === 1 ? 'sessione aperta' : 'sessioni aperte'} adesso.` : '.';
			} else if (vive) out += ` Adesso ${vive === 1 ? `c'è ${n('una')} sessione aperta` : `ci sono ${n(parola(vive))} sessioni aperte`}.`;
			return out;
		}

		function renderTesta() {
			put($('crus-frase'), frase());
			$('crus-letto').textContent = `Aggiornato alle ${ora(stats.computedAt)}`;
			$('crus-letto').title = `Calcolo in ${it(stats.ms / 1000, 2)} s: ${stats.files.read} file letti (${it(stats.files.mb, 1)} MB), ${stats.files.cached} dalla cache`;
			const okG = GRUPPI_OK[ui.period];
			put(
				$('crus-filtri'),
				`<div class="interruttori" role="group" aria-label="Periodo">${PERIODI.map(
					([id, l]) => `<button type="button" data-c="periodo" data-id="${id}" data-fk="c:p:${id}" aria-pressed="${ui.period === id}">${l}</button>`,
				).join('')}</div>
				<div class="interruttori" role="group" aria-label="Raggruppa le ore e i token">${GRUPPI.map(([id, l]) => {
					const on = okG.includes(id);
					return `<button type="button" data-c="gruppo" data-id="${id}" data-fk="c:g:${id}" aria-pressed="${ui.group === id}"${on ? '' : ' disabled title="Serve un periodo più lungo"'}>${l}</button>`;
				}).join('')}</div>`,
			);
			const p = P();
			const ok = prevOk(p);
			const prima = `rispetto ai ${p.days} giorni prima`;
			const cifra = (label, value, d, extra, title) =>
				`<div class="cifra"><dt>${label}</dt><dd><b${title ? ` title="${esc(title)}"` : ''}>${value}</b>${
					d ? `<span class="delta ${d.cls}" title="${esc(prima)}">${esc(d.txt)}${d.sr ? `<span class="sr"> ${d.sr} ${esc(prima)}</span>` : ''}</span>` : ''
				}${extra ? `<small>${extra}</small>` : ''}</dd></div>`;
			const tot = sum4(p.tok);
			put(
				$('crus-cifre'),
				[
					cifra('Ore tue', hm(p.you), delta(p.you, p.prev.you, ok, 'min'), `${parola(p.activeDays)} ${p.activeDays === 1 ? 'giorno attivo' : 'giorni attivi'} su ${p.days}`),
					cifra('Ore di Claude', hm(p.claude), delta(p.claude, p.prev.claude, ok, 'min'), p.you >= 1 ? `${it(p.claude / p.you, 1)} sessioni attive in media mentre lavori` : ''),
					cifra('Sessioni', it(p.sessions), delta(p.sessions, p.prev.sessions, ok, 'n'), p.sessions ? `in media ${hm(p.avgSession)} l'una` : ''),
					cifra('Token', tk(tot), delta(tot, sum4(p.prev.tok), ok, 'tok'), `${it(p.prompts)} messaggi scritti da te`),
					cifra('Valore a listino', usd(p.cost), delta(p.cost, p.prev.cost, ok, 'usd'), 'stima, non quello che paghi', stats.prices.note),
				].join(''),
			);
		}

		// ---------- la carta del cielo ----------

		/** Ora tipica (media circolare) e ampiezza (scarto circolare) dalle 24 ore. */
		function oraTipica(hours) {
			let x = 0, y = 0, w = 0;
			for (let h = 0; h < 24; h++) {
				const a = ((h + 0.5) / 24) * 2 * Math.PI;
				x += hours[h] * Math.cos(a);
				y += hours[h] * Math.sin(a);
				w += hours[h];
			}
			if (!w) return { h: 12, spread: 0, ok: false };
			let a = Math.atan2(y, x);
			if (a < 0) a += 2 * Math.PI;
			const R = Math.min(1, Math.hypot(x, y) / w);
			const sd = R > 0 ? Math.sqrt(-2 * Math.log(R)) : Math.PI;
			return { h: (a / (2 * Math.PI)) * 24, spread: Math.min(8, (sd / (2 * Math.PI)) * 24), ok: true };
		}

		const oraTxt = h => {
			const hh = Math.floor(h) % 24;
			const mm = Math.round((h - Math.floor(h)) * 60 / 15) * 15;
			return mm === 60 ? `${(hh + 1) % 24}:00` : `${hh}:${String(mm).padStart(2, '0')}`;
		};

		let stelle = []; // stelle disegnate, per evidenziarle dalla classifica

		function renderCarta() {
			const p = P();
			const box = $('carta-svg');
			const S = Math.round(Math.min(width(box), 640));
			const c = S / 2;
			const R = c - 40;
			const R0 = R * 0.1;
			const days = p.days;
			const t = now();
			const rad = ageDays => R0 + (R - R0) * (Math.log(1 + Math.max(0, Math.min(days, ageDays))) / Math.log(1 + days));
			const pos = (h, r) => {
				const a = ((h - 12) / 24) * 2 * Math.PI;
				return [c + r * Math.sin(a), c - r * Math.cos(a)];
			};

			const rows = p.projects.filter(x => x.you >= 1).slice(0, 48);
			const maxYou = Math.max(1, ...rows.map(x => x.you));
			stelle = rows.map((x, i) => {
				const o = oraTipica(x.hours);
				const r = rad((t - x.last) / DAY);
				const [sx, sy] = pos(o.h, r);
				return { i, row: x, o, r, x: sx, y: sy, size: 2.6 + 10 * Math.sqrt(x.you / maxYou) };
			});
			const byName = new Map(stelle.map(s => [s.row.name, s]));

			let svg = `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg">
				<defs>
					<radialGradient id="crus-bagliore"><stop offset="0" stop-color="#fff6de" stop-opacity="0.95"/><stop offset="0.35" stop-color="#f6dfae" stop-opacity="0.45"/><stop offset="1" stop-color="#f4ab3c" stop-opacity="0"/></radialGradient>
					<radialGradient id="crus-cupola" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#1d2846"/><stop offset="0.7" stop-color="#141c33"/><stop offset="1" stop-color="#0f1628"/></radialGradient>
				</defs>
				<circle cx="${c}" cy="${c}" r="${R + 8}" fill="url(#crus-cupola)"/>`;
			// campo di stelle: decorazione fissa, minuscola e fioca, mai confondibile con i dati
			const rnd = semi(1990);
			let campo = '';
			for (let i = 0; i < 140; i++) {
				const a = rnd() * 2 * Math.PI;
				const rr = Math.sqrt(rnd()) * (R + 6);
				campo += `<circle cx="${(c + rr * Math.cos(a)).toFixed(1)}" cy="${(c + rr * Math.sin(a)).toFixed(1)}" r="${(0.35 + rnd() * 0.55).toFixed(2)}" opacity="${(0.12 + rnd() * 0.3).toFixed(2)}"/>`;
			}
			svg += `<g class="campo">${campo}</g>`;
			// anelli del tempo: al centro adesso, fuori l'inizio del periodo
			const anelli = [1, 7, 30, 90].filter(d => d <= days);
			svg += `<g class="anelli">${anelli
				.map(d => {
					const r = rad(d);
					return `<circle cx="${c}" cy="${c}" r="${r.toFixed(1)}"/><text x="${c + 4}" y="${(c - r - 3).toFixed(1)}">${d === 1 ? 'ieri' : `${d} giorni fa`}</text>`;
				})
				.join('')}</g>`;
			// quadrante delle 24 ore
			let quad = `<circle cx="${c}" cy="${c}" r="${R + 8}" class="bordo"/>`;
			for (let h = 0; h < 24; h++) {
				const [x1, y1] = pos(h, R + 8);
				const [x2, y2] = pos(h, R + (h % 6 ? 12 : 16));
				quad += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
				if (h % 3 === 0) {
					const [lx, ly] = pos(h, R + 27);
					quad += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" class="${h % 6 ? '' : 'forte'}">${h}</text>`;
				}
			}
			svg += `<g class="quadrante">${quad}</g>`;
			svg += `<text class="centro" x="${c}" y="${c + 4}">adesso</text>`;
			// costellazioni: progetti lavorati in parallelo
			let linee = '';
			for (const e of p.edges) {
				const a = byName.get(e.a), b = byName.get(e.b);
				if (!a || !b) continue;
				linee += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" pathLength="1" class="${e.minutes >= 60 ? 'forte' : ''}"/>`;
			}
			svg += `<g class="costellazione">${linee}</g>`;
			// scie: le ore in cui ci lavori, come in una lunga posa
			let scie = '';
			for (const s of stelle) {
				if (s.row.you < 30 || s.o.spread < 0.4 || !s.o.ok) continue;
				const h0 = s.o.h - s.o.spread, h1 = s.o.h + s.o.spread;
				const [ax, ay] = pos(h0, s.r);
				const [bx, by] = pos(h1, s.r);
				const large = h1 - h0 > 12 ? 1 : 0;
				scie += `<path d="M${ax.toFixed(1)},${ay.toFixed(1)}A${s.r.toFixed(1)},${s.r.toFixed(1)} 0 ${large} 1 ${bx.toFixed(1)},${by.toFixed(1)}" stroke-width="${Math.max(1.5, Math.min(4, s.size * 0.45)).toFixed(1)}" data-i="${s.i}"/>`;
			}
			svg += `<g class="scie">${scie}</g>`;
			// stelle
			let st = '';
			for (const s of stelle) {
				const live = s.row.live > 0;
				st += `<g class="stella${live ? ' vivo' : ''}" data-i="${s.i}">
					<circle class="alone" cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${(s.size * 2.6).toFixed(1)}" fill="url(#crus-bagliore)"/>
					${live ? `<circle class="anello" cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${(s.size + 6).toFixed(1)}"/>` : ''}
					<circle class="nucleo" cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${(s.size * 0.55).toFixed(1)}"/>
					<circle class="presa" cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${Math.max(12, s.size + 6).toFixed(1)}" data-i="${s.i}"/>
				</g>`;
			}
			svg += `<g class="stelle">${st}</g>`;
			// nomi: solo le stelle piu' grandi e quelle vive, senza sovrapposizioni
			const boxes = [];
			let nomi = '';
			const daNominare = stelle.filter((s, i) => i < 9 || s.row.live > 0);
			for (const s of daNominare) {
				const name = s.row.name.length > 22 ? s.row.name.slice(0, 21) + '…' : s.row.name;
				const w = name.length * 6.4 + 4;
				const right = s.x >= c;
				const x = right ? s.x + s.size * 0.8 + 6 : s.x - s.size * 0.8 - 6;
				const y = s.y + 4;
				const bx = right ? x : x - w;
				const bb = [bx, y - 11, bx + w, y + 3];
				if (bb[0] < 2 || bb[2] > S - 2) continue;
				if (boxes.some(o => !(bb[2] < o[0] || bb[0] > o[2] || bb[3] < o[1] || bb[1] > o[3]))) continue;
				boxes.push(bb);
				nomi += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${right ? 'start' : 'end'}" data-i="${s.i}">${esc(name)}</text>`;
			}
			svg += `<g class="nomi">${nomi}</g></svg>`;
			put(box, svg);

			if (revealed === false && visible && !reduced.matches && stelle.length) {
				revealed = true;
				crus.classList.add('rivela');
				box.querySelectorAll('.stella').forEach((g, i) => (/** @type {any} */ (g).style.animationDelay = `${Math.min(1100, 120 + i * 40)}ms`));
				setTimeout(() => crus.classList.remove('rivela'), 2200);
			}

			put(
				$('carta-legenda'),
				`<p>Ogni stella è un progetto, grande quanto le ore che ci hai lavorato negli ultimi ${days} giorni. Il giro è l'orologio delle 24 ore, con mezzogiorno in alto: la stella sta all'ora in cui lavori di solito a quel progetto, la scia copre le ore in cui ci lavori. Più è vicina al centro, più di recente ci hai lavorato. Le linee uniscono i progetti che hai portato avanti negli stessi momenti; l'anello acceso segna una sessione aperta adesso.</p>`,
			);
			put(
				$('carta-tabella'),
				tabella(
					'carta',
					'Progetti nel cielo',
					['Progetto', 'Ore tue', 'Ore di Claude', 'Ora tipica', 'Ultima volta', 'Token'],
					stelle.map(s => [s.row.name, hm(s.row.you), hm(s.row.claude), s.o.ok ? `verso le ${oraTxt(s.o.h)}` : 'n/d', fa(s.row.last, t), tk(sum4(s.row.tok))]),
				),
			);
		}

		function accendi(i, on) {
			const svg = $('carta-svg');
			svg.querySelectorAll('.acceso').forEach(el => el.classList.remove('acceso'));
			svg.classList.toggle('cerca', !!on);
			if (!on) return;
			svg.querySelectorAll(`[data-i="${i}"]`).forEach(el => {
				const g = el.closest('.stella') || el;
				g.classList.add('acceso');
			});
		}

		function tipStella(s, anchor, x, y) {
			const r = s.row;
			const rows = [
				{ key: 'k-tu', value: hm(r.you), label: 'tue' },
				{ key: 'k-claude', value: hm(r.claude), label: 'di Claude' },
				{ value: tk(sum4(r.tok)), label: 'token' },
			];
			if (s.o.ok) rows.push({ value: `verso le ${oraTxt(s.o.h)}`, label: 'di solito' });
			rows.push({ value: fa(r.last, now()), label: 'ultima volta' });
			if (r.live) rows.push({ value: r.live === 1 ? 'una sessione aperta' : `${parola(r.live)} sessioni aperte`, label: '' });
			showTip(anchor, x, y, r.name, rows);
		}

		// ---------- classifica ----------

		function renderClassifica() {
			const p = P();
			const ok = prevOk(p);
			put(
				$('crus-ordina'),
				[
					['ore', 'Per ore'],
					['token', 'Per token'],
				]
					.map(([id, l]) => `<button type="button" data-c="ordina" data-id="${id}" data-fk="c:o:${id}" aria-pressed="${ui.sort === id}">${l}</button>`)
					.join(''),
			);
			const rows = p.projects.slice().sort((a, b) => (ui.sort === 'token' ? sum4(b.tok) - sum4(a.tok) : b.you - a.you));
			const val = r => (ui.sort === 'token' ? sum4(r.tok) : r.you);
			const max = Math.max(1, ...rows.map(val));
			const shown = ui.all ? rows : rows.slice(0, 10);
			const idx = new Map(stelle.map(s => [s.row.name, s.i]));
			$('classifica-nota').textContent = rows.length
				? `${it(rows.length)} ${rows.length === 1 ? 'progetto' : 'progetti'} negli ultimi ${p.days} giorni. Tocca un progetto per aprirlo nella plancia.`
				: `Nessun progetto con sessioni Claude negli ultimi ${p.days} giorni.`;
			put(
				$('classifica'),
				shown
					.map((r, n) => {
						const pr = ui.sort === 'token' ? r.prev.tok : r.prev.you;
						const d = !ok ? null : pr === 0 && val(r) > 0 ? { txt: 'nuovo', cls: 'nuovo', sr: 'non c\'era nel periodo prima' } : delta(val(r), pr, true, ui.sort === 'token' ? 'tok' : 'min');
						const w = Math.max(0.5, (val(r) / max) * 100);
						const i = idx.has(r.name) ? idx.get(r.name) : '';
						const second = ui.sort === 'token' ? `${hm(r.you)} tue, ${hm(r.claude)} di Claude` : `${hm(r.claude)} di Claude, ${tk(sum4(r.tok))} token`;
						const tag = r.path ? 'button' : 'div';
						const attrs = r.path
							? `type="button" data-c="progetto" data-path="${esc(r.path)}" title="Apri ${esc(r.name)} nella plancia"`
							: `tabindex="0" title="Sessioni partite dalla home o da cartelle che non sono un progetto"`;
						return `<li><${tag} class="riga-progetto${r.live ? ' vivo' : ''}" ${attrs} data-i="${i}" data-fk="c:r:${esc(r.name)}">
							<span class="pos">${n + 1}</span>
							<span class="chi"><b>${esc(r.name)}</b><small>${esc(second)}</small></span>
							<span class="misura" aria-hidden="true"><i class="${ui.sort === 'token' ? 'b-claude' : 'b-tu'}" data-w="${w.toFixed(1)}"></i></span>
							<span class="valore">${ui.sort === 'token' ? tk(val(r)) : hm(val(r))}</span>
							<span class="delta ${d ? d.cls : 'muto'}">${d ? esc(d.txt) : ''}${d && d.sr ? `<span class="sr"> ${esc(d.sr)}</span>` : ''}</span>
						</${tag}></li>`;
					})
					.join(''),
			);
			// larghezze delle barre: via CSSOM, la CSP non permette style nell'HTML
			$('classifica').querySelectorAll('[data-w]').forEach(el => (el.style.width = el.getAttribute('data-w') + '%'));
			put(
				$('classifica-piede'),
				rows.length > 10
					? `<button type="button" class="link" data-c="tutti" data-fk="c:tutti" aria-expanded="${ui.all}">${ui.all ? 'Mostra i primi dieci' : `Mostra tutti i ${it(rows.length)} progetti`}</button>`
					: '',
			);
		}

		// ---------- intervalli di tempo per i grafici ----------

		function bins() {
			const p = P();
			const g = GRUPPI_OK[ui.period].includes(ui.group) ? ui.group : 'giorno';
			const today = stats.today.date;
			if (g === 'giorno') {
				return {
					g,
					list: stats.days.slice(-p.days).map(d => ({
						...d,
						label: giornoB(d.date),
						long: giornoL(d.date) + (d.date === today ? ', in corso' : ''),
						wd: (parseDay(d.date).getDay() + 6) % 7,
					})),
				};
			}
			const src = g === 'settimana' ? stats.weeks : stats.months;
			return {
				g,
				list: src
					.filter(b => b.end >= p.from)
					.map(b => ({
						...b,
						label: g === 'settimana' ? giornoB(b.start) : meseL(b.key),
						long:
							g === 'settimana'
								? `settimana dal ${giornoM(b.start)} al ${giornoM(b.end)}${b.end === today ? ', in corso' : ''}`
								: `${meseL(b.key)}${b.end === today ? ', in corso' : ''}${b.start.slice(8) !== '01' ? `, dal ${giornoM(b.start)}` : ''}`,
					})),
			};
		}

		/** Etichette dell'asse x: abbastanza distanziate, l'ultima sempre presente. */
		function xLabels(list, slot) {
			const k = Math.max(1, Math.ceil(64 / slot));
			return list.map((b, i) => (list.length - 1 - i) % k === 0);
		}

		// ---------- curva di luce: ore ----------

		let curva = null;

		function renderCurva() {
			const { g, list } = bins();
			const el = $('curva');
			const W = width(el);
			const H = 250, L = 46, Rm = 14, T = 14, B = 28;
			const pw = W - L - Rm, ph = H - T - B;
			const n = list.length;
			const slot = pw / Math.max(1, n);
			const maxM = Math.max(60, ...list.map(b => b.claude));
			const stepH = Math.max(0.5, passo(maxM / 60, 4));
			const top = Math.ceil(maxM / 60 / stepH) * stepH * 60;
			const y = m => T + ph - (m / top) * ph;
			let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
			for (let v = 0; v <= top + 1e-6; v += stepH * 60) {
				svg += `<line class="${v ? 'griglia' : 'base'}" x1="${L}" x2="${W - Rm}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="asse-y" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}">${it(v / 60, 1)} h</text>`;
			}
			const show = xLabels(list, slot);
			list.forEach((b, i) => {
				if (show[i]) svg += `<text class="asse-x" x="${(L + slot * (i + 0.5)).toFixed(1)}" y="${H - 8}">${esc(b.label)}</text>`;
			});
			const cx = i => L + slot * (i + 0.5);
			if (g === 'giorno') {
				const pts = list.map((b, i) => [cx(i), y(b.you)]);
				const cpts = list.map((b, i) => [cx(i), y(b.claude)]);
				const line = ps => ps.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join('');
				if (n > 1) {
					svg += `<path class="area-tu" d="${line(pts)}L${pts[n - 1][0].toFixed(1)},${y(0)}L${pts[0][0].toFixed(1)},${y(0)}Z"/>`;
					svg += `<path class="linea-claude" d="${line(cpts)}"/><path class="linea-tu" d="${line(pts)}"/>`;
				}
				const last = n - 1;
				svg += `<circle class="punto-claude" cx="${cpts[last][0].toFixed(1)}" cy="${cpts[last][1].toFixed(1)}" r="4"/><circle class="punto-tu" cx="${pts[last][0].toFixed(1)}" cy="${pts[last][1].toFixed(1)}" r="4"/>`;
				svg += `<g class="mirino" hidden><line x1="0" x2="0" y1="${T}" y2="${T + ph}"/><circle class="punto-claude" r="4"/><circle class="punto-tu" r="4"/></g>`;
			} else {
				const pair = Math.min(44, slot * 0.78);
				const bw = (pair - 2) / 2;
				list.forEach((b, i) => {
					const x0 = cx(i) - pair / 2;
					svg += `<path class="col-tu" d="${colonna(x0, y(b.you), bw, y(0) - y(b.you), true)}"/>`;
					svg += `<path class="col-claude" d="${colonna(x0 + bw + 2, y(b.claude), bw, y(0) - y(b.claude), true)}"/>`;
				});
				svg += `<rect class="evidenza" hidden y="${T}" height="${ph}" rx="4"/>`;
			}
			svg += '</svg>';
			put(el, svg);
			curva = { el, list, L, slot, T, ph, y, g, idx: curva && curva.list.length === n ? curva.idx : -1 };

			const p = P();
			put(
				$('curva-legenda'),
				`<li><i class="chiave k-tu" aria-hidden="true"></i>Tu, le sessioni insieme contano una volta</li><li><i class="chiave k-claude" aria-hidden="true"></i>Claude, somma delle sessioni</li>`,
			);
			const best = list.reduce((a, b) => (b.you > (a ? a.you : -1) ? b : a), null);
			const unit = g === 'giorno' ? 'il giorno più pieno' : g === 'settimana' ? 'la settimana più piena' : 'il mese più pieno';
			const nota = best && best.you >= 1 ? `Negli ultimi ${p.days} giorni ${unit} è ${g === 'giorno' ? giornoL(best.date) : best.long.replace(', in corso', '')}, con ${hm(best.you)} tue e ${hm(best.claude)} di Claude.` : `Nessuna ora di lavoro negli ultimi ${p.days} giorni.`;
			$('curva-nota').textContent = nota;
			el.setAttribute('aria-label', `Ore di lavoro ${g === 'giorno' ? 'per giorno' : g === 'settimana' ? 'per settimana' : 'per mese'}. ${nota} Usa le frecce per leggere i valori.`);
			put(
				$('curva-tabella'),
				tabella('curva', 'Ore di lavoro', [g === 'giorno' ? 'Giorno' : g === 'settimana' ? 'Settimana' : 'Mese', 'Tu', 'Claude', 'Sessioni', 'Messaggi tuoi'], list.slice().reverse().map(b => [b.long, hm(b.you), hm(b.claude), it(b.sessions), it(b.prompts)])),
			);
		}

		function curvaAt(i, fromKey) {
			const c = curva;
			if (!c || !c.list.length) return;
			i = Math.max(0, Math.min(c.list.length - 1, i));
			c.idx = i;
			const b = c.list[i];
			const x = c.L + c.slot * (i + 0.5);
			const svg = c.el.querySelector('svg');
			if (c.g === 'giorno') {
				const m = svg.querySelector('.mirino');
				m.removeAttribute('hidden');
				const ln = m.querySelector('line');
				ln.setAttribute('x1', x.toFixed(1));
				ln.setAttribute('x2', x.toFixed(1));
				const [pc, pt] = m.querySelectorAll('circle');
				pc.setAttribute('cx', x.toFixed(1));
				pc.setAttribute('cy', c.y(b.claude).toFixed(1));
				pt.setAttribute('cx', x.toFixed(1));
				pt.setAttribute('cy', c.y(b.you).toFixed(1));
			} else {
				const r = svg.querySelector('.evidenza');
				r.removeAttribute('hidden');
				r.setAttribute('x', (x - c.slot / 2 + 1).toFixed(1));
				r.setAttribute('width', Math.max(2, c.slot - 2).toFixed(1));
			}
			const rows = [
				{ key: 'k-tu', value: hm(b.you), label: 'tu' },
				{ key: 'k-claude', value: hm(b.claude), label: 'Claude' },
				{ value: it(b.sessions), label: b.sessions === 1 ? 'sessione' : 'sessioni' },
			];
			showTip(c.el, x, c.y(Math.max(b.you, b.claude)), b.long, rows);
			if (fromKey) say(`${b.long}: tu ${hm(b.you)}, Claude ${hm(b.claude)}, ${it(b.sessions)} sessioni.`);
		}

		function curvaOff() {
			if (!curva) return;
			const svg = curva.el.querySelector('svg');
			if (svg) {
				const m = svg.querySelector('.mirino');
				if (m) m.setAttribute('hidden', '');
				const r = svg.querySelector('.evidenza');
				if (r) r.setAttribute('hidden', '');
			}
			hideTip();
		}

		// ---------- token ----------

		let token = null;

		function renderToken() {
			const { g, list } = bins();
			const el = $('token');
			const W = width(el);
			const H = 230, L = 58, Rm = 14, T = 14, B = 28;
			const pw = W - L - Rm, ph = H - T - B;
			const n = list.length;
			const slot = pw / Math.max(1, n);
			const max = Math.max(1, ...list.map(b => sum4(b.tok)));
			const step = passo(max, 4);
			const top = Math.ceil(max / step) * step;
			const y = v => T + ph - (v / top) * ph;
			let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
			for (let v = 0; v <= top + step / 1e6; v += step) {
				svg += `<line class="${v ? 'griglia' : 'base'}" x1="${L}" x2="${W - Rm}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="asse-y" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}">${tk(v)}</text>`;
			}
			const show = xLabels(list, slot);
			const bw = Math.max(1, Math.min(24, slot - 2));
			list.forEach((b, i) => {
				const x = L + slot * (i + 0.5);
				if (show[i]) svg += `<text class="asse-x" x="${x.toFixed(1)}" y="${H - 8}">${esc(b.label)}</text>`;
				let acc = 0;
				const segs = TIPI.map(([id, , k]) => [id, b.tok[k]]).filter(s => s[1] > 0);
				segs.forEach(([id, v], si) => {
					const y1 = y(acc + v);
					const y0 = y(acc);
					acc += v;
					const isTop = si === segs.length - 1;
					// spazio di 2 px tra i pezzi della pila, solo se il pezzo lo regge
					const h = y0 - y1 - (si > 0 && y0 - y1 > 3 ? 2 : 0);
					svg += `<path class="t-${id}" d="${colonna(x - bw / 2, y1, bw, h, isTop)}"/>`;
				});
			});
			svg += `<rect class="evidenza" hidden y="${T}" height="${ph}" rx="4"/></svg>`;
			put(el, svg);
			token = { el, list, L, slot, y, idx: -1 };

			put($('token-legenda'), TIPI.map(([id, l]) => `<li><i class="chiave q t-${id}" aria-hidden="true"></i>${l}</li>`).join(''));
			const p = P();
			const tot = sum4(p.tok);
			const nota = tot
				? `Negli ultimi ${p.days} giorni ${tkParole(tot)} di token, ${pctTxt(pct(p.tok[2], tot))} riletti dalla cache. Quelli scritti da Claude, l'output, sono ${tkParole(p.tok[1])}.`
				: `Nessun token negli ultimi ${p.days} giorni.`;
			$('token-nota').textContent = nota;
			el.setAttribute('aria-label', `Token ${g === 'giorno' ? 'per giorno' : g === 'settimana' ? 'per settimana' : 'per mese'}, divisi per tipo. ${nota} Usa le frecce per leggere i valori.`);
			put(
				$('token-tabella'),
				tabella(
					'token',
					'Token',
					[g === 'giorno' ? 'Giorno' : g === 'settimana' ? 'Settimana' : 'Mese', 'Letti dalla cache', 'Input', 'Scritti in cache', 'Output', 'Totale', 'Valore a listino'],
					list.slice().reverse().map(b => [b.long, it(b.tok[2]), it(b.tok[0]), it(b.tok[3]), it(b.tok[1]), it(sum4(b.tok)), usd(b.cost)]),
				),
			);
		}

		function tokenAt(i, fromKey) {
			const c = token;
			if (!c || !c.list.length) return;
			i = Math.max(0, Math.min(c.list.length - 1, i));
			c.idx = i;
			const b = c.list[i];
			const x = c.L + c.slot * (i + 0.5);
			const r = c.el.querySelector('.evidenza');
			r.removeAttribute('hidden');
			r.setAttribute('x', (x - c.slot / 2 + 1).toFixed(1));
			r.setAttribute('width', Math.max(2, c.slot - 2).toFixed(1));
			const rows = TIPI.slice()
				.reverse()
				.map(([id, l, k]) => ({ key: 'q t-' + id, value: tk(b.tok[k]), label: l.toLowerCase() }));
			rows.push({ value: usd(b.cost), label: 'valore a listino' });
			showTip(c.el, x, c.y(sum4(b.tok)), `${b.long}: ${tk(sum4(b.tok))}`, rows);
			if (fromKey) say(`${b.long}: ${tk(sum4(b.tok))} token, di cui ${tk(b.tok[1])} di output.`);
		}

		function tokenOff() {
			if (token) {
				const r = token.el.querySelector('.evidenza');
				if (r) r.setAttribute('hidden', '');
			}
			hideTip();
		}

		// ---------- composizione, modelli, valore ----------

		function renderLato() {
			const p = P();
			const tot = sum4(p.tok);
			let spettro = '<div class="spettro" aria-hidden="true">';
			for (const [id, , k] of TIPI) {
				const v = p.tok[k];
				if (v > 0) spettro += `<i class="t-${id}" data-w="${Math.max(0.6, pct(v, tot)).toFixed(2)}"></i>`;
			}
			spettro += '</div><dl class="spettro-voci">';
			for (const [id, l, k] of TIPI.slice().reverse()) {
				spettro += `<div><dt><i class="chiave q t-${id}" aria-hidden="true"></i>${l}</dt><dd><b>${tk(p.tok[k])}</b><span>${pctTxt(pct(p.tok[k], tot))}</span></dd></div>`;
			}
			spettro += '</dl>';
			put($('spettro'), spettro);
			$('spettro').querySelectorAll('[data-w]').forEach(el => (el.style.flexGrow = el.getAttribute('data-w')));

			const ms = p.models;
			const max = Math.max(1, ...ms.map(m => sum4(m.tok)));
			put(
				$('modelli'),
				ms.length
					? `<ul class="modelli">${ms
							.map(
								m => `<li><span class="nome">${esc(m.name)}</span><span class="misura" aria-hidden="true"><i class="b-claude" data-w="${Math.max(0.5, (sum4(m.tok) / max) * 100).toFixed(1)}"></i></span><span class="valore">${tk(sum4(m.tok))}</span><span class="soldi">${m.cost === null ? 'n/d' : usd(m.cost)}</span></li>`,
							)
							.join('')}</ul>`
					: '<p class="nota">Nessun modello nel periodo.</p>',
			);
			$('modelli').querySelectorAll('[data-w]').forEach(el => (el.style.width = el.getAttribute('data-w') + '%'));
			put(
				$('valore'),
				`<p class="valore-stima"><span>Valore a listino nel periodo</span><b>${usd(p.cost)}</b></p><p class="nota">${esc(stats.prices.note)}${
					stats.unpricedTokens ? ` ${tk(stats.unpricedTokens)} token di modelli senza prezzo noto non sono contati.` : ''
				}</p>`,
			);
		}

		// ---------- la settimana, ora per ora ----------

		let calore = null;

		function renderCalore() {
			const p = P();
			const el = $('calore');
			const W = width(el);
			const Lw = 40, Tt = 20;
			const cell = Math.max(12, Math.min(30, Math.floor((W - Lw) / 24)));
			const gap = 2;
			const Wt = Lw + cell * 24;
			const Ht = Tt + cell * 7;
			const max = Math.max(1, ...p.heat.flat());
			const q = v => (v <= 0.5 ? 0 : Math.max(1, Math.ceil((v / max) * 5)));
			let svg = `<svg width="${Wt}" height="${Ht}" viewBox="0 0 ${Wt} ${Ht}" xmlns="http://www.w3.org/2000/svg">`;
			for (let h = 0; h < 24; h += 3) svg += `<text class="asse-x" x="${(Lw + cell * h + cell / 2).toFixed(1)}" y="12">${h}</text>`;
			for (let d = 0; d < 7; d++) {
				svg += `<text class="asse-y" x="${Lw - 8}" y="${(Tt + cell * d + cell / 2 + 4).toFixed(1)}">${GIORNI_B[d]}</text>`;
				for (let h = 0; h < 24; h++) {
					svg += `<rect class="h${q(p.heat[d][h])}" x="${Lw + cell * h}" y="${Tt + cell * d}" width="${cell - gap}" height="${cell - gap}" rx="3" data-d="${d}" data-h="${h}"/>`;
				}
			}
			svg += `<rect class="cursore" hidden width="${cell}" height="${cell}" rx="4"/></svg>`;
			put(el, svg);
			calore = { el, p, Lw, Tt, cell, at: calore ? calore.at : [0, 9] };

			put($('calore-scala'), `<span>meno</span>${[0, 1, 2, 3, 4, 5].map(i => `<i class="h${i}" aria-hidden="true"></i>`).join('')}<span>più</span>`);
			// giorno e ora piu' pieni
			const byDay = p.heat.map(r => r.reduce((a, b) => a + b, 0));
			const byHour = Array.from({ length: 24 }, (_, h) => p.heat.reduce((a, r) => a + r[h], 0));
			const dMax = byDay.indexOf(Math.max(...byDay));
			const hMax = byHour.indexOf(Math.max(...byHour));
			const tot = byDay.reduce((a, b) => a + b, 0);
			const notte = byHour.slice(0, 7).reduce((a, b) => a + b, 0) + byHour[23];
			const nota = tot
				? `Il giorno più pieno è il ${GIORNI[dMax]}, l'ora più piena quella dalle ${hMax} alle ${hMax + 1}. Tra le 23 e le 7 hai lavorato ${hm(notte)}, il ${pctTxt(pct(notte, tot))} del totale. La casella più piena vale ${hm(max)}.`
				: `Nessuna ora di lavoro negli ultimi ${p.days} giorni.`;
			$('calore-nota').textContent = nota;
			el.setAttribute('aria-label', `Minuti di lavoro per giorno della settimana e ora, ultimi ${p.days} giorni. ${nota} Usa le frecce per leggere le caselle.`);
			put(
				$('calore-tabella'),
				tabella(
					'calore',
					'La settimana ora per ora, minuti di lavoro',
					['Ora', ...GIORNI_B],
					Array.from({ length: 24 }, (_, h) => [`dalle ${h} alle ${h + 1}`, ...p.heat.map(r => (r[h] >= 0.5 ? hm(r[h]) : '0 min'))]),
				),
			);
		}

		function caloreAt(d, h, fromKey) {
			const c = calore;
			if (!c) return;
			d = (d + 7) % 7;
			h = (h + 24) % 24;
			c.at = [d, h];
			const cur = c.el.querySelector('.cursore');
			cur.removeAttribute('hidden');
			cur.setAttribute('x', String(c.Lw + c.cell * h - 1));
			cur.setAttribute('y', String(c.Tt + c.cell * d - 1));
			const v = c.p.heat[d][h];
			const title = `${GIORNI[d]}, dalle ${h} alle ${h + 1}`;
			showTip(c.el, c.Lw + c.cell * (h + 1), c.Tt + c.cell * (d + 0.5), title, [{ key: 'q h5', value: hm(v), label: `in ${c.p.days} giorni` }]);
			if (fromKey) say(`${title}: ${hm(v)}.`);
		}

		function caloreOff() {
			if (calore) {
				const cur = calore.el.querySelector('.cursore');
				if (cur) cur.setAttribute('hidden', '');
			}
			hideTip();
		}

		// ---------- adesso e registro ----------

		function renderRegistro() {
			const t = now();
			const STATO = { busy: 'al lavoro', idle: 'in attesa', shell: 'nel terminale' };
			put(
				$('adesso'),
				stats.live.length
					? stats.live
							.map(
								l => `<li class="${l.status === 'busy' ? 'busy' : ''}"><i class="dot" aria-hidden="true"></i><span><b>${esc(l.project)}</b> ${esc(STATO[l.status] || l.status)} da ${esc(fa(l.since, t).replace(' fa', '').replace('adesso', 'poco'))}${
									l.title ? `<small>${esc(l.title)}</small>` : ''
								}<small>Oggi ${hm(l.today)} di lavoro, ${tk(l.tokToday)} token</small></span></li>`,
							)
							.join('')
					: '<li class="nota">Nessuna sessione Claude aperta in questo momento.</li>',
			);
			const r = stats.records;
			const p = P();
			const voci = [];
			voci.push([
				'Giorni di fila',
				stats.streak.current
					? `${it(stats.streak.current)}, con almeno ${stats.streakMinutes} minuti di lavoro al giorno.${stats.streak.best > stats.streak.current ? ` Il record è ${it(stats.streak.best)}, fino al ${giornoM(stats.streak.bestEnd)}.` : ' È anche il record.'}`
					: `Nessuno adesso. Il record è ${it(stats.streak.best)}${stats.streak.bestEnd ? `, fino al ${giornoM(stats.streak.bestEnd)}` : ''}.`,
			]);
			if (r.busiestDay) voci.push(['Il giorno più pieno', `${giornoL(r.busiestDay.date)}, ${hm(r.busiestDay.you)}.`]);
			if (r.longestStint) voci.push(['La tirata più lunga', `${hm(r.longestStint.minutes)} senza pause oltre ${stats.gapMinutes} minuti, ${giornoM(localKey(r.longestStint.start))} dalle ${ora(r.longestStint.start)}.`]);
			if (r.tokenDay && r.tokenDay.tok) voci.push(['Il giorno con più token', `${giornoL(r.tokenDay.date)}, ${tk(r.tokenDay.tok)}.`]);
			if (p.peak.n > 1) voci.push(['Più sessioni insieme', `${it(p.peak.n)} negli ultimi ${p.days} giorni, ${giornoL(localKey(p.peak.at))} alle ${ora(p.peak.at)}.`]);
			if (stats.firstEvent) voci.push(['I dati partono dal', `${giornoM(localKey(stats.firstEvent))}: prima non ci sono registri di Claude Code.`]);
			put($('primati'), voci.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join(''));

			put(
				$('come-conto'),
				`<b>Come conto.</b> Ogni sessione di Claude Code scrive nel suo registro l'ora di ogni messaggio. Due messaggi a meno di ${stats.gapMinutes} minuti l'uno dall'altro valgono come tempo di lavoro, una pausa più lunga interrompe il conto. Le tue ore sono quelle in cui almeno una sessione era attiva: due sessioni insieme contano una volta sola. Le ore di Claude sommano le sessioni, quindi crescono quando ne fai girare più d'una. Una sessione appartiene al progetto della cartella in cui è partita, oppure, se è partita dalla home, a quello in cui ha toccato più file. Fuso orario ${esc(stats.tz || 'del Mac')}.`,
			);
		}

		// ---------- tutto ----------

		function render(force) {
			if (!visible && !force) return;
			$('crus-attesa').hidden = !!stats || !!error;
			$('crus-errore').hidden = !error || !!stats;
			$('crus-errore-testo').textContent = error;
			$('crus-corpo').hidden = !stats;
			if (!stats) return;
			const key = [stats.computedAt, JSON.stringify(ui), width($('crus-corpo'))].join('|');
			if (key === lastKey && !force) return;
			lastKey = key;
			if (!GRUPPI_OK[ui.period].includes(ui.group)) ui.group = 'giorno';
			renderTesta();
			renderCarta();
			renderClassifica();
			renderCurva();
			renderToken();
			renderLato();
			renderCalore();
			renderRegistro();
		}

		function request() {
			host.post({ type: 'stats.request', period: Number(ui.period) });
			clearTimeout(waitTimer);
			waitTimer = setTimeout(() => crus.classList.add('in-attesa'), 300);
		}

		// ---------- eventi ----------

		crus.addEventListener('click', e => {
			const t = /** @type {any} */ (e.target);
			const b = t.closest('[data-c]');
			if (!b || b.disabled) return;
			const id = b.getAttribute('data-id');
			switch (b.getAttribute('data-c')) {
				case 'periodo':
					ui.period = id;
					if (!GRUPPI_OK[id].includes(ui.group)) ui.group = 'giorno';
					save();
					render(true);
					say(`Ultimi ${id} giorni.`);
					return;
				case 'gruppo':
					ui.group = id;
					save();
					return render(true);
				case 'ordina':
					ui.sort = id;
					save();
					return render(true);
				case 'tutti':
					ui.all = !ui.all;
					save();
					return render(true);
				case 'tabella':
					ui.tables[id] = !ui.tables[id];
					save();
					return render(true);
				case 'progetto':
					if (host.focusProject) host.focusProject(b.getAttribute('data-path'));
					return;
				case 'aggiorna':
				case 'riprova':
					return request();
			}
		});

		// carta: puntatore sulle stelle
		const carta = $('carta-svg');
		carta.addEventListener('pointermove', e => {
			const t = /** @type {any} */ (e.target);
			const i = t && t.getAttribute ? t.getAttribute('data-i') : null;
			if (i === null || i === '' || !stelle[+i]) {
				accendi(-1, false);
				return hideTip();
			}
			const s = stelle[+i];
			accendi(+i, true);
			tipStella(s, carta.querySelector('svg'), s.x, s.y);
		});
		carta.addEventListener('pointerleave', () => {
			accendi(-1, false);
			hideTip();
		});
		carta.addEventListener('click', e => {
			const t = /** @type {any} */ (e.target);
			const i = t && t.getAttribute ? t.getAttribute('data-i') : null;
			const s = i !== null && i !== '' ? stelle[+i] : null;
			if (s && s.row.path && host.focusProject) host.focusProject(s.row.path);
		});

		// classifica: passarci sopra o arrivarci col tab accende la stella
		const cl = $('classifica');
		const lightRow = row => {
			const i = row ? row.getAttribute('data-i') : '';
			if (i === null || i === '' || !stelle[+i]) {
				accendi(-1, false);
				return hideTip();
			}
			const s = stelle[+i];
			accendi(+i, true);
			tipStella(s, carta.querySelector('svg'), s.x, s.y);
		};
		cl.addEventListener('pointerover', e => lightRow(/** @type {any} */ (e.target).closest('.riga-progetto')));
		cl.addEventListener('pointerleave', () => lightRow(null));
		cl.addEventListener('focusin', e => lightRow(/** @type {any} */ (e.target).closest('.riga-progetto')));
		cl.addEventListener('focusout', () => lightRow(null));

		// grafici a colonne o curve: il puntatore trova la x, le frecce scorrono
		function bindSeries(id, getState, at, off) {
			const el = $(id);
			el.addEventListener('pointermove', e => {
				const c = getState();
				if (!c || !c.list.length) return;
				const r = el.getBoundingClientRect();
				const x = e.clientX - r.left;
				if (x < c.L - 4) return off();
				at(Math.floor((x - c.L) / c.slot), false);
			});
			el.addEventListener('pointerleave', off);
			el.addEventListener('blur', off);
			el.addEventListener('focus', () => {
				const c = getState();
				if (c && c.list.length) at(c.idx >= 0 ? c.idx : c.list.length - 1, true);
			});
			el.addEventListener('keydown', e => {
				const c = getState();
				if (!c || !c.list.length) return;
				const cur = c.idx >= 0 ? c.idx : c.list.length - 1;
				const k = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: c.list.length - 1 }[e.key];
				if (k === undefined) return;
				e.preventDefault();
				at(k, true);
			});
		}
		bindSeries('curva', () => curva, curvaAt, curvaOff);
		bindSeries('token', () => token, tokenAt, tokenOff);

		const cal = $('calore');
		cal.addEventListener('pointermove', e => {
			const t = /** @type {any} */ (e.target);
			if (!t || !t.getAttribute || t.getAttribute('data-d') === null) return caloreOff();
			caloreAt(+t.getAttribute('data-d'), +t.getAttribute('data-h'), false);
		});
		cal.addEventListener('pointerleave', caloreOff);
		cal.addEventListener('blur', caloreOff);
		cal.addEventListener('focus', () => calore && caloreAt(calore.at[0], calore.at[1], true));
		cal.addEventListener('keydown', e => {
			if (!calore) return;
			const [d, h] = calore.at;
			const mv = { ArrowLeft: [d, h - 1], ArrowRight: [d, h + 1], ArrowUp: [d - 1, h], ArrowDown: [d + 1, h], Home: [d, 0], End: [d, 23] }[e.key];
			if (!mv) return;
			e.preventDefault();
			caloreAt(mv[0], mv[1], true);
		});

		let resizeT = 0;
		window.addEventListener('resize', () => {
			if (!visible) return;
			clearTimeout(resizeT);
			resizeT = setTimeout(() => render(false), 140);
		});
		if (reduced.addEventListener) reduced.addEventListener('change', () => crus.classList.remove('rivela'));

		return {
			/** Dati nuovi dall'estensione (null con un errore). */
			setStats(s, err) {
				clearTimeout(waitTimer);
				crus.classList.remove('in-attesa');
				if (s) {
					stats = s;
					error = '';
				} else error = err || 'Non riesco a leggere le sessioni di Claude Code.';
				lastKey = '';
				render(false);
			},
			render() {
				render(false);
			},
			show() {
				visible = true;
				crus.classList.remove('fermo');
				render(false);
				request();
			},
			hide() {
				visible = false;
				crus.classList.add('fermo');
				hideTip();
			},
			pause() {
				crus.classList.add('fermo');
			},
			resume() {
				if (visible) crus.classList.remove('fermo');
			},
		};
	}

	/** @type {any} */ (window).BottegaCruscotto = { mount };
})();
