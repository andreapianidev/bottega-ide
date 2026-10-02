// @ts-check
/* La barra di Melissa: la vista nella barra laterale DESTRA (secondary side bar), sempre aperta, da cui
   Melissa tiene d'occhio tutte le sessioni Claude di Andrea. Contratto: docs/CONTRATTI.md,
   sezione 6; tipi AssistantState (sezione 3), WorkItem e WorkCounts (4.9).

   HTML minimo che il fornitore (src/barra.ts) deve servire. Niente altro: il modulo costruisce tutto
   dentro <main id="barra">, parte da solo e manda `ready`.

     <!doctype html>
     <html lang="it">
     <head>
     <meta charset="utf-8">
     <meta http-equiv="Content-Security-Policy"
           content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">
     <meta name="viewport" content="width=device-width, initial-scale=1">
     <link rel="stylesheet" href="${media}/barra.css">
     <title>Melissa</title>
     </head>
     <body><main id="barra"></main><script nonce="${nonce}" src="${media}/barra.js"></script></body>
     </html>

   Estensione -> barra
     {type:'stato', assistant?, brain?, work?, workCounts?, board?}
         Un campo assente vuol dire «invariato»: mentre Melissa parla basta mandare {type:'stato', assistant}
         piu' volte al secondo (il livello audio), senza ripetere lavori e bacheca.
     {type:'assistant', state}               come sopra, la forma della vista della sfera (4.8)
     {type:'bacheca.sessione', sessionId, items}  risposta a bacheca.sessione: le ultime tre ore
     {type:'visibile', visible}              facoltativo: la vista e' nascosta o di nuovo visibile
                                             (in aggiunta a document.visibilityState)
   Barra -> estensione
     ready, converse, ask {text}, voice.toggle, brain.set {provider, model}, effort.set {effort},
     job.focus {id}, job.write {id, text}, open {path}, claude {path, id}, bacheca.sessione {sessionId},
     home {view: 'plancia'}, comando {id: briefing | regole | lavori | cruscotto | continua | cerca}

   Aggiornare senza distruggere: ogni parte confronta la sua firma con quella di prima e tocca il DOM
   solo se e' cambiata. Le sessioni e le righe della conversazione sono nodi con una chiave che restano
   gli stessi da uno stato all'altro (fuoco, testo scritto, cassetti aperti restano dove sono); la sfera
   non riparte. A vista nascosta niente fotogrammi, niente orologio e niente DOM: lo stato si tiene da
   parte e si disegna quando la vista torna. */
(function () {
	const vscode = acquireVsCodeApi();
	const root = document.getElementById('barra');
	if (!root) return;
	const post = m => vscode.postMessage(m);
	const reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
	let hostHidden = false;
	const visible = () => !hostHidden && document.visibilityState !== 'hidden';

	// ---------- piccoli attrezzi ----------

	/** @param {string} tag @param {Record<string, any> | null} [props] @param {...any} kids */
	function h(tag, props, ...kids) {
		const el = document.createElement(tag);
		if (props)
			for (const k of Object.keys(props)) {
				const v = props[k];
				if (v == null || v === false) continue;
				if (k === 'class') el.className = v;
				else if (k === 'text') el.textContent = v;
				else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
				else el.setAttribute(k, v === true ? '' : String(v));
			}
		for (const c of kids) if (c != null && c !== false) el.append(c);
		return el;
	}
	const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
	const setText = (el, t) => {
		if (el.textContent !== t) el.textContent = t;
	};
	const setAttr = (el, k, v) => {
		if (v == null) {
			if (el.hasAttribute(k)) el.removeAttribute(k);
		} else if (el.getAttribute(k) !== String(v)) el.setAttribute(k, String(v));
	};
	const show = (el, on) => {
		if (el.hidden === on) el.hidden = !on;
	};
	const setClass = (el, c) => {
		if (el.className !== c) el.className = c;
	};

	function dur(ms) {
		const m = Math.floor(Math.max(0, ms) / 60_000);
		if (m < 1) return 'meno di un minuto';
		if (m < 60) return `${m} min`;
		const hr = Math.floor(m / 60);
		if (hr < 24) return m % 60 ? `${hr} h ${m % 60} min` : `${hr} h`;
		const d = Math.round(hr / 24);
		return d === 1 ? 'un giorno' : `${d} giorni`;
	}
	const clock = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
	const dollari = (n, fixed) =>
		`${n.toLocaleString('it-IT', { minimumFractionDigits: fixed || n % 1 ? 2 : 0, maximumFractionDigits: 2 })} $`;

	// ---------- lo scheletro: statico, senza dati ----------

	root.innerHTML = `
		<header class="testa">
			<div class="cervello">
				<button type="button" class="cervello-tasto" id="cervello" aria-haspopup="listbox" aria-expanded="false" aria-controls="cervelli">
					<span class="sr">Cervello di Melissa: </span><span class="cervello-nome" id="cervello-nome">Nessun cervello</span><span class="cervello-nota" id="cervello-nota"></span><span class="cervello-freccia" aria-hidden="true"></span>
				</button>
				<ul class="cervelli" id="cervelli" role="listbox" aria-label="Scegli il cervello di Melissa" tabindex="-1" hidden></ul>
			</div>
			<div class="testa-riga">
				<fieldset class="impegno" id="impegno">
					<legend class="sr">Impegno</legend>
					<label title="Risponde subito, pensa poco"><input type="radio" name="impegno" value="rapido"><span>rapido</span></label>
					<label title="L'equilibrio di sempre"><input type="radio" name="impegno" value="normale"><span>normale</span></label>
					<label title="Pensa a fondo, ci mette di più"><input type="radio" name="impegno" value="profondo"><span>profondo</span></label>
				</fieldset>
			</div>
			<details class="conti" id="conti" hidden>
				<summary><i class="conto-punto" id="conti-punto" aria-hidden="true"></i><span id="conti-riassunto"></span></summary>
				<ul class="conti-lista" id="conti-lista" aria-label="Conti dei servizi"></ul>
			</details>
			<div hidden>
			</div>
		</header>
		<section class="notte" id="notte" aria-label="Melissa">
			<button type="button" class="sfera-tasto" id="sfera-tasto" aria-pressed="false">
				<canvas id="sfera" aria-hidden="true"></canvas>
				<span class="sr" id="sfera-etichetta">Parla con Melissa</span>
			</button>
			<div class="notte-testo">
				<p class="stato" id="stato">Tocca la sfera per parlare</p>
				<p class="parziale" id="parziale"></p>
				<button type="button" class="voce" id="voce" hidden></button>
			</div>
		</section>
		<section class="dialogo" aria-labelledby="dialogo-titolo">
			<h2 class="sr" id="dialogo-titolo">Conversazione</h2>
			<ol class="registro" id="registro" role="log" aria-live="off" aria-label="Conversazione con Melissa" tabindex="0"></ol>
			<p class="vuoto" id="registro-vuoto">Silenzio, per ora. Tocca la sfera o scrivimi qui sotto.</p>
			<form class="chiedi" id="chiedi" autocomplete="off">
				<label class="sr" for="domanda">Scrivi a Melissa</label>
				<input id="domanda" type="text" placeholder="Scrivi a Melissa" spellcheck="false">
				<button type="submit" class="manda">Manda</button>
			</form>
		</section>
		<section class="sessioni" id="sessioni" aria-labelledby="sessioni-titolo" tabindex="-1">
			<div class="sessioni-testa">
				<h2 id="sessioni-titolo">Sessioni Claude</h2>
				<span class="sessioni-conto" id="sessioni-conto"></span>
			</div>
			<div class="aspettano" id="aspettano"></div>
			<div class="scorre" id="scorre">
				<p class="vuoto" id="sessioni-vuoto" hidden>Nessuna sessione aperta. Per una volta, il Mac respira.</p>
			</div>
		</section>
		<nav class="comandi" aria-label="Comandi rapidi">
			<button type="button" data-comando="briefing">Briefing</button>
			<button type="button" data-comando="regole">Regole</button>
			<button type="button" data-comando="lavori">Lavori</button>
			<button type="button" data-comando="cruscotto">Cruscotto</button>
			<button type="button" data-comando="continua">Continua</button>
			<button type="button" data-comando="cerca">Cerca</button>
			<button type="button" class="casa" id="casa">Apri la Home</button>
		</nav>
		<div class="sr" id="annuncio" role="status" aria-live="polite"></div>`;

	// ---------- la sfera: lo stesso disegno e gli stessi colori della pagina di Melissa (plancia.js) ----------
	// Copia allineata della sfera di plancia.js (stati, colori lineari, movimento) finché non arriva la sfera unica in WebGPU.

	// Punto di montaggio della sfera unica in WebGPU (media/motore/sfera-gpu.js, componente condiviso con la pagina di
	// Melissa e il cruscotto): window.BottegaSferaGPU.mount(canvas, {reduced, onFail}) -> {set(stato, spenta, livello),
	// wake(), sleep(), redraw()}. L'adattatore arriva dopo: se WebGPU manca, mount chiama onFail(motivo) e si passa al
	// Canvas 2D qui sotto, su un canvas nuovo (quello di WebGPU non accetta piu' un contesto 2D). Idem se mount lancia.
	const makeOrb2D = () => (() => {
		const LIN = {
			idle: [0.26, 0.74, 1.0],
			listening: [0.16, 0.86, 0.86],
			thinking: [0.6, 0.38, 0.98],
			speaking: [0.42, 0.88, 0.52],
			error: [0.905, 0.402, 0.045], // il sodio della palette, #f4ab3c, in lineare
		};
		const GREY = [0.16, 0.18, 0.24];
		const MOTO = {
			idle: { e: 0.32, v: 0.22 },
			listening: { e: 0.62, v: 0.45 },
			thinking: { e: 0.78, v: 1.05 },
			speaking: { e: 0.66, v: 0.7 },
			error: { e: 0.36, v: 0.14 },
		};
		const canvas = /** @type {HTMLCanvasElement} */ ($('sfera'));
		/** @type {CanvasRenderingContext2D | null} */ let ctx = null;
		try {
			ctx = canvas.getContext ? canvas.getContext('2d') : null;
		} catch {
			ctx = null;
		}
		const raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : f => setTimeout(() => f(performance.now()), 33);
		const caf = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : clearTimeout;

		let target = 'idle';
		let col = LIN.idle.slice();
		let e = MOTO.idle.e, v = MOTO.idle.v;
		let dim = 0, dimWant = 0, level = 0;
		let phase = Math.random() * 10;
		let handle = 0, last = 0, size = 0;

		const lerp = (a, b, t) => a + (b - a) * t;
		const srgb = c => {
			c = Math.min(1, Math.max(0, c));
			return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
		};
		const mixC = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
		const rgba = (c, a) => `rgba(${srgb(c[0])},${srgb(c[1])},${srgb(c[2])},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
		const scale = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

		function fit() {
			if (!ctx) return;
			const css = canvas.clientWidth || 104;
			const px = Math.round(css * Math.min(2, window.devicePixelRatio || 1));
			if (px !== size) {
				size = px;
				canvas.width = px;
				canvas.height = px;
			}
		}

		function draw() {
			if (!ctx) return;
			fit();
			const S = size, c = S / 2, R = S * 0.3;
			const C = mixC(col, GREY, dim * 0.7);
			const E = e * (1 - dim * 0.6);
			const speaking = target === 'speaking' && dim < 0.5;
			const voice = speaking ? 0.16 * Math.max(0, Math.sin(phase * 6.1)) * (0.6 + 0.4 * Math.sin(phase * 2.3)) : 0;
			const pulse = E + level * 0.5 + voice;

			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.globalCompositeOperation = 'source-over';
			ctx.clearRect(0, 0, S, S);

			// alone additivo
			ctx.globalCompositeOperation = 'lighter';
			let g = ctx.createRadialGradient(c, c, R * 0.7, c, c, S / 2);
			g.addColorStop(0, rgba(C, 0.3 + 0.25 * pulse));
			g.addColorStop(0.4, rgba(C, 0.08 + 0.06 * pulse));
			g.addColorStop(1, rgba(C, 0));
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, S, S);

			ctx.save();
			ctx.beginPath();
			ctx.arc(c, c, R, 0, Math.PI * 2);
			ctx.clip();

			// corpo: profondo al centro, quasi spento sul bordo
			ctx.globalCompositeOperation = 'source-over';
			g = ctx.createRadialGradient(c - R * 0.18, c - R * 0.22, 0, c, c, R);
			g.addColorStop(0, rgba(scale(C, 0.5), 1));
			g.addColorStop(1, rgba(scale(C, 0.06), 1));
			ctx.fillStyle = g;
			ctx.fillRect(c - R, c - R, R * 2, R * 2);

			// plasma: cinque correnti che girano piano e si sommano
			ctx.globalCompositeOperation = 'lighter';
			for (let i = 0; i < 5; i++) {
				const a = phase * (0.55 + i * 0.19) + i * 1.9;
				const rr = R * (0.3 + 0.14 * Math.sin(phase * 0.7 + i));
				const x = c + Math.cos(a) * rr;
				const y = c + Math.sin(a * 1.3 + i) * rr * 0.85;
				const br = R * (0.5 + 0.16 * Math.sin(phase * 1.1 + i * 2));
				const hue = i % 2 ? C : mixC(C, [1, 1, 1], 0.3);
				g = ctx.createRadialGradient(x, y, 0, x, y, br);
				g.addColorStop(0, rgba(hue, 0.1 + 0.42 * E));
				g.addColorStop(1, rgba(hue, 0));
				ctx.fillStyle = g;
				ctx.fillRect(c - R, c - R, R * 2, R * 2);
			}

			// nucleo caldo, quasi bianco
			const cx = c + Math.sin(phase * 0.9) * R * 0.05;
			const cy = c + Math.cos(phase * 0.7) * R * 0.05;
			const cr = R * (0.38 + 0.2 * pulse);
			g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
			g.addColorStop(0, `rgba(255,255,255,${(0.55 + 0.4 * (1 - dim)).toFixed(3)})`);
			g.addColorStop(0.35, rgba(mixC(C, [1, 1, 1], 0.55), 0.6));
			g.addColorStop(1, rgba(C, 0));
			ctx.fillStyle = g;
			ctx.fillRect(c - R, c - R, R * 2, R * 2);

			// bordo scuro, poi un filo di luce radente
			ctx.globalCompositeOperation = 'source-over';
			g = ctx.createRadialGradient(c, c, R * 0.6, c, c, R);
			g.addColorStop(0, 'rgba(3,6,16,0)');
			g.addColorStop(1, 'rgba(3,6,16,0.62)');
			ctx.fillStyle = g;
			ctx.fillRect(c - R, c - R, R * 2, R * 2);
			ctx.globalCompositeOperation = 'lighter';
			g = ctx.createRadialGradient(c, c, R * 0.88, c, c, R);
			g.addColorStop(0, rgba(C, 0));
			g.addColorStop(1, rgba(C, 0.3));
			ctx.fillStyle = g;
			ctx.fillRect(c - R, c - R, R * 2, R * 2);
			ctx.restore();
		}

		function step(dt) {
			const want = LIN[target] || LIN.idle;
			const m = MOTO[target] || MOTO.idle;
			const k = 1 - Math.exp(-dt * 4);
			col = mixC(col, want, k);
			e = lerp(e, m.e, k);
			v = lerp(v, m.v, k);
			dim = lerp(dim, dimWant, k);
			phase += dt * v * 2;
		}

		const running = () => !!ctx && !reduced.matches && visible();
		// Spenta (Nucleo assente o voce spenta) la sfera si ferma appena ha finito di sbiadire.
		const settled = () => dimWant === 1 && dim > 0.98;

		function frame(now) {
			handle = 0;
			if (!running()) return;
			const dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016;
			if (now - last >= 30) {
				// circa 30 fotogrammi al secondo: basta per un movimento lento, costa la meta'
				step(dt);
				draw();
				last = now;
			}
			if (settled()) return;
			handle = raf(frame);
		}

		function snapTo() {
			col = (LIN[target] || LIN.idle).slice();
			const m = MOTO[target] || MOTO.idle;
			e = m.e;
			v = m.v;
			dim = dimWant;
		}

		return {
			set(st, dimmed, lvl) {
				const changed = st !== target || (dimmed ? 1 : 0) !== dimWant;
				target = st;
				dimWant = dimmed ? 1 : 0;
				level = lvl || 0;
				if (changed) this.wake();
			},
			wake() {
				if (!ctx) return;
				if (running()) {
					if (!handle) {
						last = 0;
						handle = raf(frame);
					}
				} else if (visible()) {
					this.sleep();
					snapTo();
					draw(); // riduci movimento: un solo fotogramma fermo, con il colore giusto
				} else this.sleep();
			},
			sleep() {
				if (handle) caf(handle);
				handle = 0;
			},
			redraw() {
				size = 0;
				if (!running() && visible()) draw();
			},
		};
	})();

	let orbImpl = null;
	let orbLast = /** @type {any[] | null} */ (null);
	let orbAwake = false;
	const toCanvas2D = why => {
		if (why) console.warn('[barra] sfera WebGPU non disponibile, uso il Canvas 2D: ' + why);
		try {
			orbImpl && orbImpl.sleep && orbImpl.sleep();
		} catch {
			// il componente GPU e' gia' andato
		}
		const old = $('sfera');
		const fresh = /** @type {HTMLCanvasElement} */ (old.cloneNode(false));
		old.replaceWith(fresh);
		orbImpl = makeOrb2D();
		if (orbLast) orbImpl.set(orbLast[0], orbLast[1], orbLast[2]);
		if (orbAwake) orbImpl.wake();
	};
	const gpu = /** @type {any} */ (window).BottegaSferaGPU;
	if (gpu && typeof gpu.mount === 'function') {
		try {
			orbImpl = gpu.mount($('sfera'), { reduced, post: m => post(m), onFail: why => toCanvas2D(String(why || 'motivo sconosciuto')) });
		} catch (e) {
			orbImpl = null;
			console.warn('[barra] sfera WebGPU: mount ha lanciato, uso il Canvas 2D: ' + (e && e.message ? e.message : e));
		}
	}
	if (!orbImpl) orbImpl = makeOrb2D();
	/** La sfera, qualunque motore ci sia sotto: la barra chiama sempre questi quattro. */
	const orb = {
		set(st, dimmed, lvl) {
			orbLast = [st, dimmed, lvl];
			orbImpl.set(st, dimmed, lvl);
		},
		wake() {
			orbAwake = true;
			orbImpl.wake();
		},
		sleep() {
			orbAwake = false;
			orbImpl.sleep();
		},
		redraw() {
			orbImpl.redraw();
		},
	};

	// ---------- lo stato ----------

	/** @type {{assistant: any, brain: any, work: any[], counts: any, board: Record<string, any[]>}} */
	const S = { assistant: null, brain: null, work: [], counts: null, board: {} };
	const sig = { brain: '', log: '', work: '' };
	let dirty = { assistant: false, brain: false, work: false };

	// ---------- testata: il cervello e l'impegno ----------

	const cervello = $('cervello');
	const lista = /** @type {HTMLUListElement} */ ($('cervelli'));
	/** @type {any[]} */ let opzioni = [];
	let attiva = -1;

	function notaDi(o) {
		if (!o.available) return o.why || 'non disponibile';
		const p = o.price;
		if (p && (p.in || p.out)) return `${o.note}, ${dollari(p.in)} letti e ${dollari(p.out)} scritti al milione`;
		return o.note || '';
	}

	function renderBrain() {
		const b = S.brain;
		const s = JSON.stringify(b || null);
		if (s === sig.brain) return;
		sig.brain = s;
		const testa = /** @type {HTMLElement} */ (root.querySelector('.testa'));
		show(testa, !!b);
		if (!b) return;
		const cur = b.current || {};
		const curOpt = (b.options || []).find(o => o.provider === cur.provider && o.model === cur.model);
		setText($('cervello-nome'), cur.label || 'Nessun cervello');
		setText($('cervello-nota'), curOpt ? (curOpt.available ? curOpt.note || '' : curOpt.why || 'non disponibile') : '');
		root.querySelectorAll('#impegno input').forEach(i => {
			const r = /** @type {HTMLInputElement} */ (i);
			const on = r.value === b.effort;
			if (r.checked !== on) r.checked = on;
		});
		// i conti: solo dati veri (saldo dove il servizio lo da', altrimenti conteggi della Bottega, dichiarati)
		const conti = Array.isArray(b.accounts) ? b.accounts : [];
		show($('conti'), conti.length > 0);
		if (conti.length) {
			const peso = { male: 2, attesa: 1, ok: 0 };
			const mio = conti.find(a => a.id === cur.provider) || conti.find(a => a.id === 'agnes') || conti[0];
			const peggio = conti.reduce((x, a) => (peso[a.tone] > peso[x.tone] ? a : x), mio);
			const capo = peso[peggio.tone] > peso[mio.tone] ? peggio : mio;
			setText($('conti-riassunto'), `${capo.label}: ${capo.text}`);
			$('conti-punto').className = 'conto-punto t-' + capo.tone;
			const lista = $('conti-lista');
			const firma = JSON.stringify(conti);
			if (lista.getAttribute('data-firma') !== firma) {
				lista.replaceChildren(
					...conti.map(a => {
						const li = document.createElement('li');
						li.className = 'conto t-' + a.tone;
						const punto = document.createElement('i');
						punto.className = 'conto-punto t-' + a.tone;
						punto.setAttribute('aria-hidden', 'true');
						const nome = document.createElement('b');
						nome.textContent = a.label;
						const testo = document.createElement('span');
						testo.textContent = a.text;
						li.append(punto, nome, testo);
						return li;
					}),
				);
				lista.setAttribute('data-firma', firma);
			}
		}
		opzioni = b.options || [];
		const activeKey = attiva >= 0 && opzioni[attiva] ? opzioni[attiva].provider + '|' + opzioni[attiva].model : '';
		lista.replaceChildren(
			...opzioni.map((o, i) => {
				const sel = o.provider === cur.provider && o.model === cur.model;
				return h(
					'li',
					{ id: `cervello-${i}`, role: 'option', class: `opzione${o.available ? '' : ' spenta'}`, 'aria-selected': String(sel), 'aria-disabled': o.available ? null : 'true', 'data-i': i },
					h('span', { class: 'opzione-nome', text: o.label }),
					h('span', { class: 'opzione-nota', text: notaDi(o) }),
				);
			}),
		);
		if (!lista.hidden) {
			const k = opzioni.findIndex(o => o.provider + '|' + o.model === activeKey);
			muovi(k >= 0 ? k : Math.max(0, opzioni.findIndex(o => o.provider === cur.provider && o.model === cur.model)));
		}
	}

	function muovi(i) {
		if (!opzioni.length) return;
		attiva = Math.max(0, Math.min(opzioni.length - 1, i));
		lista.querySelectorAll('.opzione').forEach((li, j) => li.classList.toggle('attiva', j === attiva));
		lista.setAttribute('aria-activedescendant', `cervello-${attiva}`);
		const el = $(`cervello-${attiva}`);
		if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
	}
	function apri() {
		if (!opzioni.length) return;
		lista.hidden = false;
		cervello.setAttribute('aria-expanded', 'true');
		const cur = (S.brain && S.brain.current) || {};
		muovi(Math.max(0, opzioni.findIndex(o => o.provider === cur.provider && o.model === cur.model)));
		lista.focus();
	}
	function chiudi(rifocus) {
		if (lista.hidden) return;
		lista.hidden = true;
		cervello.setAttribute('aria-expanded', 'false');
		lista.removeAttribute('aria-activedescendant');
		attiva = -1;
		if (rifocus) cervello.focus();
	}
	function scegli(i) {
		const o = opzioni[i];
		if (!o || !o.available) return; // le spente si leggono, non si scelgono
		post({ type: 'brain.set', provider: o.provider, model: o.model });
		chiudi(true);
	}
	cervello.addEventListener('click', () => (lista.hidden ? apri() : chiudi(true)));
	cervello.addEventListener('keydown', ev => {
		if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
			ev.preventDefault();
			apri();
		}
	});
	lista.addEventListener('keydown', ev => {
		const k = ev.key;
		if (k === 'ArrowDown') muovi(attiva + 1);
		else if (k === 'ArrowUp') muovi(attiva - 1);
		else if (k === 'Home') muovi(0);
		else if (k === 'End') muovi(opzioni.length - 1);
		else if (k === 'Enter' || k === ' ') scegli(attiva);
		else if (k === 'Escape') chiudi(true);
		else if (k === 'Tab') return chiudi(false);
		else return;
		ev.preventDefault();
	});
	lista.addEventListener('click', ev => {
		const li = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (ev.target).closest('.opzione'));
		if (li) scegli(Number(li.dataset.i));
	});
	document.addEventListener('mousedown', ev => {
		const t = /** @type {Node} */ (ev.target);
		if (!lista.hidden && !lista.contains(t) && !cervello.contains(t)) chiudi(false);
	});
	$('impegno').addEventListener('change', ev => {
		const r = /** @type {HTMLInputElement} */ (ev.target);
		if (r.checked) post({ type: 'effort.set', effort: r.value });
	});

	// ---------- la sfera e la conversazione ----------

	const WORD = { idle: 'Tocca la sfera per parlare', listening: 'Ti ascolto', thinking: 'Ci penso', speaking: 'Parlo', error: 'Qualcosa non va' };
	const registro = $('registro');
	/** @type {Map<string, HTMLLIElement>} */ const righe = new Map();
	let primoRegistro = true;

	function renderAssistant() {
		const a = S.assistant;
		const on = !!(a && a.enabled);
		const st = a ? (a.state === 'idle' && a.conversing ? 'listening' : a.state) : 'idle';
		orb.set(st, !on, a && a.level);
		const tasto = $('sfera-tasto');
		setAttr(tasto, 'aria-pressed', String(!!(a && a.conversing)));
		$('notte').classList.toggle('viva', !!(on && a && (a.conversing || a.state !== 'idle')));
		setText($('sfera-etichetta'), a && a.conversing ? 'Chiudi la conversazione con Melissa' : 'Parla con Melissa');
		setText($('stato'), !a ? WORD.idle : !on ? 'Melissa è spenta' : a.conversing && st === 'listening' ? 'In conversazione, ti ascolto' : WORD[st] || '');
		setText($('parziale'), (a && a.partial) || '');
		const voce = $('voce');
		show(voce, !!a);
		setText(voce, on ? 'Spegni la voce' : 'Accendi la voce');
		renderLog((a && a.log) || []);
	}

	function renderLog(log) {
		const s = JSON.stringify(log);
		if (s === sig.log) return;
		sig.log = s;
		const inFondo = registro.scrollHeight - registro.scrollTop - registro.clientHeight < 24;
		const seen = new Map();
		const keys = log.map(r => {
			const base = `${r.at}|${r.role}`;
			const n = (seen.get(base) || 0) + 1;
			seen.set(base, n);
			return n > 1 ? `${base}#${n}` : base;
		});
		const want = new Set(keys);
		for (const [k, li] of righe)
			if (!want.has(k)) {
				li.remove();
				righe.delete(k);
			}
		keys.forEach((k, i) => {
			const r = log[i];
			let li = righe.get(k);
			if (!li) {
				li = rigaNuova(r);
				righe.set(k, li);
			}
			const testo = /** @type {HTMLElement} */ (li.querySelector('.testo'));
			setText(testo, String(r.text || ''));
			if (registro.children[i] !== li) registro.insertBefore(li, registro.children[i] || null);
		});
		show($('registro-vuoto'), !log.length);
		if (inFondo || primoRegistro) registro.scrollTop = registro.scrollHeight;
		primoRegistro = false;
	}

	function rigaNuova(r) {
		if (r.role === 'azione')
			return /** @type {HTMLLIElement} */ (
				h('li', { class: 'riga azione' }, h('span', { class: 'sr', text: 'Azione di Melissa: ' }), h('time', { datetime: new Date(r.at).toISOString(), text: clock(r.at) }), h('span', { class: 'testo' }))
			);
		const tu = r.role === 'tu';
		return /** @type {HTMLLIElement} */ (h('li', { class: `riga ${tu ? 'tu' : 'melissa'}` }, h('span', { class: 'sr', text: tu ? 'Tu: ' : 'Melissa: ' }), h('span', { class: 'testo' })));
	}

	$('sfera-tasto').addEventListener('click', () => post({ type: 'converse' }));
	// anche la frase accanto alla sfera («Tocca la sfera per parlare») e il riquadro intorno: Andrea tocca la scritta
	$('notte').addEventListener('click', ev => {
		const t = /** @type {HTMLElement} */ (ev.target);
		if (t.closest('button') || window.getSelection()?.toString()) return;
		post({ type: 'converse' });
	});
	$('voce').addEventListener('click', () => post({ type: 'voice.toggle' }));
	$('chiedi').addEventListener('submit', ev => {
		ev.preventDefault();
		const i = /** @type {HTMLInputElement} */ ($('domanda'));
		const text = i.value.trim();
		if (!text) return;
		post({ type: 'ask', text });
		i.value = '';
	});

	// ---------- le sessioni Claude ----------

	const GRUPPI = [
		{ status: 'ti aspetta', id: 'aspetta', one: 'Ti aspetta', many: 'Ti aspettano', count: 'tiAspetta', cls: 's-aspetta', tempo: 'aspetta da' },
		{ status: 'in corso', id: 'corso', one: 'In corso', many: 'In corso', count: 'inCorso', cls: 's-corso', tempo: 'da' },
		{ status: 'nel terminale', id: 'terminale', one: 'Nel terminale', many: 'Nel terminale', count: 'nelTerminale', cls: 's-terminale', tempo: 'da' },
		{ status: 'in coda', id: 'coda', one: 'In coda', many: 'In coda', count: 'inCoda', cls: 's-coda', tempo: 'in coda da', chiuso: true },
		{ status: 'stanotte', id: 'stanotte', one: 'Stanotte', many: 'Stanotte', count: 'stanotte', cls: 's-stanotte', tempo: 'in fila da', chiuso: true },
	];
	const memo = (() => {
		try {
			return vscode.getState() || {};
		} catch {
			return {};
		}
	})();
	/** gruppi chiusi a mano (in coda e stanotte partono chiusi) */
	const chiusi = new Set(Array.isArray(memo.chiusi) ? memo.chiusi : GRUPPI.filter(g => g.chiuso).map(g => g.id));
	const ricorda = () => {
		try {
			vscode.setState({ ...memo, chiusi: [...chiusi] });
		} catch {
			/* niente stato: pazienza */
		}
	};

	/** @type {Record<string, {sec: HTMLElement, ul: HTMLElement, conta: HTMLElement, nome: HTMLElement, tasto?: HTMLElement}>} */
	const gruppi = {};
	for (const g of GRUPPI) {
		const ul = h('ul', { class: 'lista', id: `lista-${g.id}` });
		const conta = h('span', { class: 'conta' });
		const nome = h('span', { class: 'gruppo-nome', text: g.many });
		let testa, tasto;
		if (g.id === 'aspetta') testa = h('h3', { class: 'gruppo-titolo' }, nome, conta);
		else {
			tasto = h('button', { type: 'button', class: 'gruppo-tasto', 'aria-expanded': String(!chiusi.has(g.id)), 'aria-controls': `lista-${g.id}` }, h('span', { class: 'freccia', 'aria-hidden': 'true' }), nome, conta);
			tasto.addEventListener('click', () => {
				if (chiusi.has(g.id)) chiusi.delete(g.id);
				else chiusi.add(g.id);
				ricorda();
				tasto.setAttribute('aria-expanded', String(!chiusi.has(g.id)));
				ul.hidden = chiusi.has(g.id);
			});
			testa = h('h3', { class: 'gruppo-titolo' }, tasto);
			ul.hidden = chiusi.has(g.id);
		}
		const sec = h('section', { class: `gruppo g-${g.id}`, 'aria-label': g.many, hidden: true }, testa, ul);
		(g.id === 'aspetta' ? $('aspettano') : $('scorre')).append(sec);
		gruppi[g.status] = { sec, ul, conta, nome, tasto };
	}
	const GRUPPO = Object.fromEntries(GRUPPI.map(g => [g.status, g]));

	/** @typedef {{el: HTMLLIElement, w: any, parti: Record<string, HTMLElement>, firma: string, bacheca: string}} Nodo */
	/** @type {Map<string, Nodo>} */ const nodi = new Map();
	/** cassetti «Scrivi al lavoro» aperti o chiusi a mano */
	const scriviAperti = new Set(), scriviChiusi = new Set();
	/** la bacheca intera (tre ore) chiesta per una sessione */
	/** @type {Map<string, any[]>} */ const bachecaIntera = new Map();
	const prima = new Map(); // chiave -> stato precedente, per gli annunci
	let primoLavoro = true;

	function nodoNuovo(w) {
		const k = w.key;
		const bottega = w.source === 'bottega';
		const parti = {
			dot: h('span', { class: 'dot', 'aria-hidden': 'true' }),
			progetto: h('b', { class: 'progetto' }),
			tempo: h('span', { class: 'tempo' }),
			notte: h('span', { class: 'di-notte', text: 'di notte', hidden: true }),
			titolo: h('p', { class: 'titolo' }),
			bacheca: h('ol', { class: 'bacheca', 'aria-label': 'Ultime voci della bacheca' }),
			tutto: h('button', { type: 'button', class: 'link tutto', hidden: true }),
			azioni: h('div', { class: 'azioni' }),
		};
		const it = () => (nodi.get(k) || { w }).w;
		if (bottega) {
			parti.mostra = h('button', { type: 'button', class: 'act', text: 'Mostra', onclick: () => it().jobId && post({ type: 'job.focus', id: it().jobId }) });
			const formId = `scrivi-${k.replace(/[^A-Za-z0-9_-]/g, '_')}`;
			parti.apriScrivi = h('button', { type: 'button', class: 'act', 'aria-expanded': 'false', 'aria-controls': formId, text: 'Scrivi al lavoro' });
			parti.campo = h('input', { type: 'text', class: 'campo', placeholder: 'Istruzioni per questo lavoro', spellcheck: 'false', 'aria-label': `Scrivi al lavoro su ${w.project}` });
			parti.esito = h('span', { class: 'esito' });
			parti.form = h('form', { class: 'scrivi', id: formId, autocomplete: 'off', hidden: true }, parti.campo, h('button', { type: 'submit', class: 'act', text: 'Manda' }), parti.esito);
			parti.apriScrivi.addEventListener('click', () => {
				const aperto = !parti.form.hidden;
				if (aperto) {
					scriviAperti.delete(k);
					scriviChiusi.add(k);
				} else {
					scriviChiusi.delete(k);
					scriviAperti.add(k);
				}
				aggiornaScrivi(nodi.get(k));
				if (!aperto) parti.campo.focus();
			});
			parti.form.addEventListener('submit', ev => {
				ev.preventDefault();
				const campo = /** @type {HTMLInputElement} */ (parti.campo);
				const text = campo.value.trim();
				const id = it().jobId;
				if (!text || !id) return;
				post({ type: 'job.write', id, text });
				campo.value = '';
				setText(parti.esito, 'Mandato.');
			});
			parti.campo.addEventListener('keydown', ev => {
				if (ev.key !== 'Escape') return;
				ev.preventDefault();
				scriviAperti.delete(k);
				scriviChiusi.add(k);
				parti.apriScrivi.focus();
				aggiornaScrivi(nodi.get(k));
			});
			parti.azioni.append(parti.mostra, parti.apriScrivi);
		} else {
			parti.riprendi = h('button', { type: 'button', class: 'act', text: 'Riprendi qui', onclick: () => it().sessionId && post({ type: 'claude', path: it().path, id: it().sessionId }) });
			parti.apri = h('button', { type: 'button', class: 'act', text: 'Apri il progetto', onclick: () => post({ type: 'open', path: it().path }) });
			parti.azioni.append(parti.riprendi, parti.apri);
		}
		parti.tutto.addEventListener('click', () => {
			const sid = it().sessionId;
			if (!sid) return;
			if (bachecaIntera.has(sid)) {
				bachecaIntera.delete(sid);
				const n = nodi.get(k);
				if (n) aggiornaBacheca(n);
			} else post({ type: 'bacheca.sessione', sessionId: sid });
		});
		const el = /** @type {HTMLLIElement} */ (
			h(
				'li',
				{ class: 'lavoro', 'data-key': k },
				h('div', { class: 'lavoro-testa' }, parti.dot, parti.progetto, parti.notte, parti.tempo),
				parti.titolo,
				parti.bacheca,
				parti.tutto,
				parti.azioni,
				parti.form || null,
			)
		);
		return { el, w, parti, firma: '', bacheca: '' };
	}

	function aggiornaScrivi(n) {
		if (!n || !n.parti.form) return;
		const { form, campo, apriScrivi } = n.parti;
		const k = n.w.key;
		const occupato = /** @type {HTMLInputElement} */ (campo).value !== '' || form.contains(document.activeElement);
		// chiuso a mano resta chiuso; altrimenti resta aperto chi ha del testo o il fuoco, e chi aspetta
		const aperto = scriviAperti.has(k) || (!scriviChiusi.has(k) && (occupato || n.w.status === 'ti aspetta'));
		show(form, aperto);
		setAttr(apriScrivi, 'aria-expanded', String(aperto));
	}

	function aggiornaBacheca(n) {
		const sid = n.w.sessionId;
		const intera = sid ? bachecaIntera.get(sid) : undefined;
		const voci = intera || (sid && S.board && S.board[sid]) || [];
		const s = JSON.stringify([!!intera, voci]);
		const { tutto } = n.parti;
		show(tutto, !!sid && (voci.length > 0 || !!intera));
		setText(tutto, intera ? 'Solo le ultime' : 'Le ultime tre ore');
		if (s === n.bacheca) return;
		n.bacheca = s;
		n.parti.bacheca.replaceChildren(
			...voci.map(v =>
				h(
					'li',
					{ class: `traccia k-${String(v.kind || 'nota').replace(/[^a-z]/g, '')}`, title: v.summary },
					h('time', { datetime: new Date(v.at).toISOString(), text: clock(v.at) }),
					h('span', { class: 'cosa', text: v.summary }),
				),
			),
		);
		show(n.parti.bacheca, voci.length > 0);
	}

	function tempoDi(w) {
		if (!w.since) return '';
		const g = GRUPPO[w.status];
		return `${g ? g.tempo : 'da'} ${dur(Date.now() - w.since)}`;
	}

	function aggiornaNodo(n, w) {
		n.w = w;
		const g = GRUPPO[w.status] || GRUPPI[1];
		const p = n.parti;
		setClass(n.el, `lavoro ${g.cls} ${w.source === 'bottega' ? 'da-bottega' : 'altrove'}`);
		const firma = JSON.stringify([w.status, w.project, w.path, w.title, w.jobId, w.sessionId, w.night]);
		if (firma !== n.firma) {
			n.firma = firma;
			setText(p.progetto, w.project || 'senza progetto');
			setAttr(p.progetto, 'title', w.path || null);
			setText(p.titolo, w.title || 'Sessione senza titolo');
			p.titolo.classList.toggle('muto', !w.title);
			show(p.notte, !!w.night && w.status !== 'stanotte');
			if (p.riprendi) show(p.riprendi, !!w.sessionId);
			if (p.mostra) show(p.mostra, !!w.jobId);
			if (p.campo) setAttr(p.campo, 'aria-label', `Scrivi al lavoro su ${w.project}`);
			const principale = w.status === 'ti aspetta' ? p.mostra || p.riprendi : null;
			for (const b of [p.mostra, p.riprendi]) if (b) b.classList.toggle('main', b === principale);
		}
		setText(p.tempo, tempoDi(w));
		aggiornaBacheca(n);
		aggiornaScrivi(n);
	}

	const annuncio = $('annuncio');
	function annuncia(testo) {
		annuncio.textContent = '';
		setTimeout(() => (annuncio.textContent = testo), 60);
	}

	function renderWork() {
		const work = S.work || [];
		const s = JSON.stringify([work, S.counts, S.board]);
		if (s === sig.work) return;
		sig.work = s;

		const attivo = /** @type {HTMLElement | null} */ (document.activeElement);
		const sel = attivo && 'selectionStart' in attivo ? [/** @type {HTMLInputElement} */ (attivo).selectionStart, /** @type {HTMLInputElement} */ (attivo).selectionEnd] : null;

		const per = {};
		for (const g of GRUPPI) per[g.status] = [];
		for (const w of work) (per[w.status] || per['in corso']).push(w);

		const vivi = new Set(work.map(w => w.key));
		let fuocoPerso = false;
		for (const [k, n] of nodi)
			if (!vivi.has(k)) {
				if (attivo && n.el.contains(attivo)) fuocoPerso = true;
				n.el.remove();
				nodi.delete(k);
				scriviAperti.delete(k);
				scriviChiusi.delete(k);
			}

		const nuoviInAttesa = [];
		for (const g of GRUPPI) {
			const { sec, ul, conta, nome } = gruppi[g.status];
			const items = per[g.status];
			items.forEach((w, i) => {
				let n = nodi.get(w.key);
				if (!n) {
					n = nodoNuovo(w);
					nodi.set(w.key, n);
				}
				aggiornaNodo(n, w);
				if (ul.children[i] !== n.el) ul.insertBefore(n.el, ul.children[i] || null);
				if (g.status === 'ti aspetta' && prima.get(w.key) !== 'ti aspetta' && !primoLavoro) nuoviInAttesa.push(w);
			});
			const c = S.counts && typeof S.counts[g.count] === 'number' ? S.counts[g.count] : items.length;
			setText(conta, String(c));
			setText(nome, c === 1 ? g.one : g.many);
			setAttr(sec, 'aria-label', c === 1 ? g.one : g.many);
			show(sec, items.length > 0);
		}
		prima.clear();
		for (const w of work) prima.set(w.key, w.status);

		const vive = S.counts && typeof S.counts.vive === 'number' ? S.counts.vive : work.filter(w => ['in corso', 'ti aspetta', 'nel terminale'].includes(w.status)).length;
		setText($('sessioni-conto'), vive ? `${vive} ${vive === 1 ? 'viva' : 'vive'}` : '');
		show($('sessioni-vuoto'), work.length === 0);
		$('sessioni').classList.toggle('con-attesa', per['ti aspetta'].length > 0);
		$('sessioni').classList.toggle('solo-attese', work.length > 0 && work.every(w => w.status === 'ti aspetta'));

		// un nodo spostato da un gruppo all'altro perde il fuoco: lo si rimette dov'era, cursore compreso
		if (attivo && attivo !== document.activeElement) {
			if (attivo.isConnected) {
				attivo.focus({ preventScroll: true });
				if (sel && /** @type {HTMLInputElement} */ (attivo).setSelectionRange) /** @type {HTMLInputElement} */ (attivo).setSelectionRange(sel[0], sel[1]);
			} else if (fuocoPerso) $('sessioni').focus({ preventScroll: true });
		}

		if (nuoviInAttesa.length === 1) annuncia(`${nuoviInAttesa[0].project} ti aspetta: ${nuoviInAttesa[0].title || 'sessione senza titolo'}`);
		else if (nuoviInAttesa.length > 1) annuncia(`${nuoviInAttesa.length} sessioni ti aspettano: ${nuoviInAttesa.map(w => w.project).join(', ')}`);
		primoLavoro = false;
	}

	// l'orologio: «da 12 min» si aggiorna ogni mezzo minuto, solo a vista visibile
	let orologio = 0;
	function batti() {
		for (const n of nodi.values()) setText(n.parti.tempo, tempoDi(n.w));
	}
	function avviaOrologio() {
		if (!orologio) orologio = window.setInterval(batti, 30_000);
	}
	function fermaOrologio() {
		if (orologio) window.clearInterval(orologio);
		orologio = 0;
	}

	// ---------- comandi rapidi ----------

	root.querySelector('.comandi')?.addEventListener('click', ev => {
		const b = /** @type {HTMLElement} */ (ev.target).closest('button');
		if (!b) return;
		if (b.id === 'casa') post({ type: 'home', view: 'plancia' });
		else if (b.dataset.comando) post({ type: 'comando', id: b.dataset.comando });
	});

	// ---------- messaggi e ciclo di vita ----------

	function disegna() {
		if (!visible()) return;
		if (dirty.brain) renderBrain();
		if (dirty.assistant) renderAssistant();
		if (dirty.work) renderWork();
		dirty = { assistant: false, brain: false, work: false };
	}

	window.addEventListener('message', ev => {
		const m = ev.data || {};
		if (m.type === 'stato') {
			if ('assistant' in m) {
				S.assistant = m.assistant || null;
				dirty.assistant = true;
			}
			if ('brain' in m) {
				S.brain = m.brain || null;
				dirty.brain = true;
			}
			if ('work' in m) {
				S.work = Array.isArray(m.work) ? m.work : [];
				dirty.work = true;
			}
			if ('workCounts' in m) {
				S.counts = m.workCounts || null;
				dirty.work = true;
			}
			if ('board' in m) {
				S.board = m.board || {};
				dirty.work = true;
			}
			disegna();
		} else if (m.type === 'assistant') {
			S.assistant = m.state || null;
			dirty.assistant = true;
			disegna();
		} else if (m.type === 'bacheca.sessione' && m.sessionId) {
			bachecaIntera.set(m.sessionId, Array.isArray(m.items) ? m.items : []);
			for (const n of nodi.values()) if (n.w.sessionId === m.sessionId) aggiornaBacheca(n);
		} else if (m.type === 'visibile') {
			hostHidden = m.visible === false;
			cambiaVisibilita();
		}
	});

	function cambiaVisibilita() {
		if (visible()) {
			document.body.classList.remove('ferma');
			disegna();
			batti();
			avviaOrologio();
			orb.wake();
		} else {
			document.body.classList.add('ferma');
			fermaOrologio();
			orb.sleep();
		}
	}
	document.addEventListener('visibilitychange', cambiaVisibilita);
	if (reduced.addEventListener) reduced.addEventListener('change', () => orb.wake());
	if (typeof ResizeObserver === 'function') new ResizeObserver(() => orb.redraw()).observe($('sfera-tasto'));
	else window.addEventListener('resize', () => orb.redraw());

	dirty.assistant = true;
	dirty.brain = true; // senza cervello la testata resta nascosta finche' non arriva lo stato
	cambiaVisibilita();
	post({ type: 'ready' });
})();
