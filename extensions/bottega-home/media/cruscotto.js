/* Bottega, il cruscotto: la quinta stanza della plancia. Ore di lavoro e progetti dai registri
   Claude Code; consumi Codex e Cline separati nella sezione attività (src/stats.ts).

   Idea: un osservatorio. Il pezzo forte e' la carta del cielo: ogni progetto e' una stella su un
   orologio di 24 ore (come l'ascensione retta, che si misura in ore), grande quanto le ore che ci
   hai passato, vicina al centro se ci hai lavorato da poco, con la scia delle ore in cui ci lavori
   e le linee verso i progetti lavorati insieme. Attorno, strumenti sobri e precisi: la curva di
   luce delle ore, i token, la settimana ora per ora, il registro.

   Regole: niente librerie, SVG scritto a mano, nessun attributo style nell'HTML (la CSP lo blocca;
   le posizioni dinamiche passano da element.style, che e' permesso). Testo dei dati sempre
   sfuggito o messo con textContent. Ogni grafico ha la sua tabella e si usa da tastiera.

   La sala di controllo (build 12): la notte dell'osservatorio diventa un banco strumenti. Due luci:
   l'ambra del sodio per le ore tue (i dati principali), il ciano per Claude e per la strumentazione
   (lancetta, reticoli, mirino). Il cielo ha tre motori, in ordine:
   - WebGPU (motore/cielo-gpu.js), che in Electron su Mac passa da Metal: nebulosa, corona delle ore,
     stelle con le punte di diffrazione che respirano, onde e scie delle sessioni vive, impulsi di
     luce lungo i legami, una ghiera che gira lentissima. Stesso dispositivo della sfera di Melissa
     (motore/gpu.js). Disegna solo decorazione e luce: i dati restano nell'SVG sopra.
   - Canvas 2D (creaCielo2d, qui sotto), quando WebGPU non parte: le stesse animazioni, disegnate
     dal processore con sprite fatti una volta.
   - SVG, sempre presente: dati, nomi, prese e tabella; da solo e' l'ultimo ripiego, fermo.
   L'indicatore in alto a destra dice quale motore disegna (WebGPU, Canvas, SVG), il suo titolo
   perche' e quanto costa un fotogramma; l'estensione riceve lo stesso motivo (cielo.diag).
   Animazioni con un perche': arrivo dei dati (un'onda parte dal centro e accende le stelle in
   sequenza, prima le recenti; cifre che contano, tracce che si disegnano), cambio di periodo (le
   stelle migrano), passaggio del mouse (mirino), sessione viva (onda e scia). Una volta per arrivo,
   mai a ogni aggiornamento periodico. Con "riduci movimento" un fotogramma solo, stessi contenuti.
   Stanza o documento nascosti, tela fuori schermo: nessun fotogramma; la GPU si libera dopo
   RILASCIO_MS.

   Il banco (sotto i token): sette blocchi (oggi sessione per sessione, adesso, lavoro in parallelo,
   la settimana ora per ora, chi sale e chi scende, quanto dura una sessione, registro) in due
   colonne che finiscono alla stessa altezza. Dopo ogni disegno si misurano i blocchi e `dividi`
   prova tutte le divisioni possibili (2^7) tenendo quella con lo scarto minore; sotto DUE_COLONNE
   px una colonna sola, nell'ordine di lettura. La corrente del lavoro in parallelo e' il secondo
   strumento su WebGPU: stesso dispositivo del cielo (l'officina di motore/gpu.js), stesse regole. */
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

	/** Ora del giorno adesso, in ore decimali (21,5 = 21:30), nel fuso del Mac. */
	function oraAdesso() {
		const d = new Date();
		return d.getHours() + d.getMinutes() / 60;
	}

	const facile = k => 1 - Math.pow(1 - k, 3);

	// ---------- luci e tempi del cielo ----------

	/* Il cielo su WebGPU vive in motore/cielo-gpu.js (stesso dispositivo della sfera di Melissa,
	   motore/gpu.js). Qui restano i valori che servono alla tela 2D di ripiego: devono restare uguali
	   a quelli di motore/cielo-gpu.js (il banco di prova li confronta). */

	/** Colori della luce (rgb lineari 0..1, la cupola resta notte anche nel tema chiaro). */
	const LUCE = {
		campo: [0.91, 0.886, 0.816],
		stella: [0.96, 0.7, 0.34],
		calima: [0.91, 0.886, 0.816],
		sodio: [0.957, 0.671, 0.235],
		ciano: [0.39, 0.9, 0.86],
	};
	/** La ghiera fuori dal quadrante fa un giro ogni quarto d'ora (il campo di fondo a meta' velocita'). */
	const GIRO = (2 * Math.PI) / 900;
	/** Tacche della ghiera: una ogni 3,75 gradi, una lunga ogni otto. */
	const TACCHE = 96;
	/** Quanto e' lunga la scia di una sessione viva, in px lungo la sua orbita. */
	const SCIA_PX = 95;
	/** Respiro di una stella (lo stesso calcolo dello shader). */
	const respiro = (i, tempo) => 1 + 0.13 * Math.sin(tempo * (0.38 + 0.22 * ((i * 0.618) % 1)) + i * 2.399);
	/** Fotogrammi al secondo: 30 mentre succede qualcosa, 20 a riposo, 15 se un fotogramma costa troppo. */
	const fpsPer = (vivace, costo) => (costo > 8 ? 15 : vivace ? 30 : 20);
	const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
	/** Dopo quanto la GPU della corrente si libera a stanza nascosta. */
	const RILASCIO_MS = 15_000;
	const G0 = /** @type {any} */ (globalThis);
	const USO = {
		UNIFORM: G0.GPUBufferUsage ? G0.GPUBufferUsage.UNIFORM : 0x40,
		COPY_DST: G0.GPUBufferUsage ? G0.GPUBufferUsage.COPY_DST : 0x08,
	};
	/** Quando motore/gpu.js manca: un'officina chiusa, la corrente resta in SVG. */
	const OFFICINA_CHIUSA = {
		disponibile: false,
		motivo: "il motore condiviso (motore/gpu.js) non e' caricato",
		async prendi() {
			throw new Error(this.motivo);
		},
		lascia() {},
		ascolta() {},
	};

	// ---------- il cielo su Canvas 2D, quando WebGPU non c'e' ----------

	/* Il ripiego animato: stesse luci e stessi movimenti del cielo WebGPU, disegnati dal processore.
	   - fondo: cupola, nebulosa (fbm su una griglia piccola, allargata), corona delle ore, l'ultima ora
	     alle spalle della lancetta. Cambia solo coi dati, con la misura o col minuto: sta in una tela
	     fuori schermo e a ogni fotogramma si copia;
	   - luce, sommata ('lighter'): ghiera che gira, campo che scintilla, impulsi lungo i legami, scie e
	     onde delle sessioni vive, stelle che respirano (sprite disegnati una volta), lancetta.
	   L'SVG sopra resta quello di sempre: nomi, prese, tabella. Stati: 'attesa' (decide WebGPU),
	   'canvas', 'svg' (nemmeno il contesto 2D: resta l'SVG fermo). */

	/** Un colore della luce (rgb 0..1) come stringa CSS. */
	const css = (c, a) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`;
	const liscio = (a, b, x) => {
		const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
		return t * t * (3 - 2 * t);
	};

	/** Lo stesso rumore dello shader, in JS: serve solo alla nebulosa, una volta per misura. */
	function fbm2(x, y) {
		const h = (a, b) => {
			let qx = (a * 123.34) % 1, qy = (b * 456.21) % 1;
			if (qx < 0) qx += 1;
			if (qy < 0) qy += 1;
			const d = qx * (qx + 45.32) + qy * (qy + 45.32);
			qx += d;
			qy += d;
			const v = (qx * qy) % 1;
			return v < 0 ? v + 1 : v;
		};
		const n = (px, py) => {
			const ix = Math.floor(px), iy = Math.floor(py);
			const fx = px - ix, fy = py - iy;
			const wx = fx * fx * (3 - 2 * fx), wy = fy * fy * (3 - 2 * fy);
			const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
			return (a + (b - a) * wx) * (1 - wy) + (c + (d - c) * wx) * wy;
		};
		let s = 0, amp = 0.5;
		for (let k = 0; k < 5; k++) {
			s += amp * n(x, y);
			x = x * 2.03 + 17.1;
			y = y * 2.03 + 9.2;
			amp *= 0.5;
		}
		return s;
	}

	/**
	 * @param {HTMLCanvasElement} canvas la tela delle luci, ridisegnata a ogni fotogramma
	 * @param {HTMLCanvasElement} telaFondo la tela del fondo, sotto: si ridisegna solo quando cambia
	 * @param {{ reduced: () => boolean, onStato: (stato: string, motivo: string) => void }} opt
	 */
	function creaCielo2d(canvas, telaFondo, opt) {
		let stato = 'attesa';
		/** @type {any} */ let ctx = null;
		/** @type {any} */ let scena = null;
		let attivo = false;
		let inVista = true;
		let raf = 0;
		let ultimo = 0;
		const t0 = clock();
		let rivelaDa = -1e9;
		let migraDa = -1e9;
		let acceso = -1;
		let minuto = -1;
		let frames = 0;
		let costo = 0;
		let fondoSporco = true;
		/** @type {any} */ let fondo = null; // il contesto della tela del fondo
		/** @type {any} */ let nebbia = null; // la nebulosa, per misura
		let nebbiaS = 0;
		/** @type {any} */ let sprite = null;

		function cambia(s, motivo) {
			stato = s;
			try {
				opt.onStato(s, motivo || '');
			} catch (e) {
				console.error('Bottega: cruscotto, stato della tela', e);
			}
		}

		function fuori(w, h) {
			const c = canvas.ownerDocument.createElement('canvas');
			c.width = w;
			c.height = h;
			const x = c.getContext('2d');
			if (!x) throw new Error('la tela fuori schermo non da un contesto 2D');
			return [c, x];
		}

		/** Gli sprite della luce, disegnati una volta: 64 px, si scalano col drawImage. */
		function creaSprite() {
			const N = 64, m = N / 2;
			const macchia = (col, stops) => {
				const [c, x] = fuori(N, N);
				const g = x.createRadialGradient(m, m, 0, m, m, m);
				for (const [o, a] of stops) g.addColorStop(o, css(col, a));
				x.fillStyle = g;
				x.fillRect(0, 0, N, N);
				return c;
			};
			// una gaussiana, come exp(-r^2 * 6) dello shader
			const gauss = [[0, 1], [0.2, 0.79], [0.4, 0.38], [0.6, 0.12], [0.8, 0.02], [1, 0]];
			const stella = (() => {
				const [c, x] = fuori(N, N);
				let g = x.createRadialGradient(m, m, 0, m, m, m);
				g.addColorStop(0, 'rgba(255, 250, 237, 1)');
				g.addColorStop(0.12, 'rgba(252, 226, 170, 0.95)');
				g.addColorStop(0.3, css(LUCE.stella, 0.38));
				g.addColorStop(0.6, css(LUCE.stella, 0.1));
				g.addColorStop(1, css(LUCE.stella, 0));
				x.fillStyle = g;
				x.fillRect(0, 0, N, N);
				// le punte di diffrazione
				for (const [w, h] of [[N, 1.4], [1.4, N]]) {
					g = w > h ? x.createLinearGradient(0, 0, N, 0) : x.createLinearGradient(0, 0, 0, N);
					g.addColorStop(0, 'rgba(255, 246, 222, 0)');
					g.addColorStop(0.5, 'rgba(255, 246, 222, 0.55)');
					g.addColorStop(1, 'rgba(255, 246, 222, 0)');
					x.fillStyle = g;
					x.fillRect(m - w / 2, m - h / 2, w, h);
				}
				return c;
			})();
			const altrove = (() => {
				const [c, x] = fuori(N, N);
				x.strokeStyle = css(LUCE.calima, 0.9);
				x.lineWidth = 3.2;
				x.beginPath();
				x.arc(m, m, m * 0.32, 0, 2 * Math.PI);
				x.stroke();
				return c;
			})();
			return { campo: macchia(LUCE.campo, gauss), scintilla: macchia([0.86, 1, 0.98], gauss), stella, altrove };
		}

		/** La nebulosa su una griglia di 112 px, una volta per misura (pochi ms). */
		function creaNebbia(s) {
			const N = 112;
			const [c, x] = fuori(N, N);
			const img = x.createImageData(N, N);
			const cup = s.R + 8;
			for (let j = 0; j < N; j++) {
				for (let i = 0; i < N; i++) {
					const dx = ((i + 0.5) / N) * s.S - s.c, dy = ((j + 0.5) / N) * s.S - s.c;
					const t = Math.min(1, Math.hypot(dx, dy) / cup);
					const qx = (dx / cup) * 2.4, qy = (dy / cup) * 2.4;
					const n1 = fbm2(qx + 3.1, qy + 1.7);
					const n2 = fbm2(qx * 1.6 + n1 * 1.4, qy * 1.6 + 5.2);
					const a = liscio(0.42, 0.92, n2) * (1 - 0.5 * t) * 0.7;
					const b = liscio(0.55, 0.95, n1) * 0.45;
					const o = (j * N + i) * 4;
					img.data[o] = (0.09 * a + 0.02 * b) * 255;
					img.data[o + 1] = (0.1 * a + 0.15 * b) * 255;
					img.data[o + 2] = (0.27 * a + 0.17 * b) * 255;
					img.data[o + 3] = 255;
				}
			}
			x.putImageData(img, 0, 0);
			return c;
		}

		/** Il fondo, sulla sua tela sotto le luci: cambia coi dati, con la misura e col minuto. */
		function disegnaFondo(s, W, dpr) {
			if (telaFondo.width !== W || telaFondo.height !== W) {
				telaFondo.width = W;
				telaFondo.height = W;
			}
			if (!nebbia || nebbiaS !== s.S) {
				nebbia = creaNebbia(s);
				nebbiaS = s.S;
			}
			const x = fondo;
			const { c, R } = s;
			const cup = R + 8;
			x.setTransform(1, 0, 0, 1, 0, 0);
			x.clearRect(0, 0, W, W);
			x.setTransform(dpr, 0, 0, dpr, 0, 0);
			x.save();
			x.beginPath();
			x.arc(c, c, cup, 0, 2 * Math.PI);
			x.clip();
			let g = x.createRadialGradient(c, c, 0, c, c, cup);
			g.addColorStop(0, '#1d2846');
			g.addColorStop(0.7, '#141c33');
			g.addColorStop(1, '#0f1628');
			x.fillStyle = g;
			x.fillRect(0, 0, s.S, s.S);
			x.globalCompositeOperation = 'lighter';
			x.imageSmoothingEnabled = true;
			x.drawImage(nebbia, 0, 0, s.S, s.S);
			// corona delle ore e ultima ora alle spalle della lancetta. Si disegnano come luce che si somma:
			// spicchi opachi del colore gia' moltiplicato per l'intensita' (sovrapposti di un soffio, cosi'
			// tra uno spicchio e l'altro non restano fili), poi una maschera radiale, poi 'lighter' sul fondo.
			const ang = h => ((h - 12) / 24) * 2 * Math.PI - Math.PI / 2;
			const strato = (spicchi, r0, r1, stops) => {
				const [cc, cx] = fuori(Math.round(s.S * dpr), Math.round(s.S * dpr));
				cx.setTransform(dpr, 0, 0, dpr, 0, 0);
				for (const [h0, h1, col] of spicchi) {
					cx.fillStyle = col;
					cx.beginPath();
					cx.moveTo(c, c);
					cx.arc(c, c, r1 + 2, ang(h0) - 0.004, ang(h1) + 0.004);
					cx.closePath();
					cx.fill();
				}
				cx.globalCompositeOperation = 'destination-in';
				const m = cx.createRadialGradient(c, c, r0, c, c, r1);
				for (const [o, a] of stops) m.addColorStop(o, `rgba(0, 0, 0, ${a})`);
				cx.fillStyle = m;
				cx.fillRect(0, 0, s.S, s.S);
				x.drawImage(cc, 0, 0, s.S, s.S);
			};
			const luce = (k, v) => `rgb(${Math.round(LUCE[k][0] * v * 255)}, ${Math.round(LUCE[k][1] * v * 255)}, ${Math.round(LUCE[k][2] * v * 255)})`;
			// quattro spicchi per ora, raccordati come nello shader (oraLiscia)
			const corona = [];
			for (let q = 0; q < 96; q++) {
				const h = q / 4 + 0.125;
				const i0 = Math.floor(h - 0.5 + 24) % 24, i1 = (i0 + 1) % 24;
				const f = liscio(0, 1, (h - 0.5 + 24) % 1);
				const v = (s.ore[i0] || 0) * (1 - f) + (s.ore[i1] || 0) * f;
				if (v >= 0.01) corona.push([q / 4, (q + 1) / 4, luce('sodio', 0.42 * v)]);
			}
			if (corona.length) strato(corona, R - 36, R + 7, [[0, 0], [34 / 43, 1], [37 / 43, 1], [1, 0]]);
			const h = oraAdesso();
			const ultima = [];
			for (let q = 0; q < 12; q++) ultima.push([h - (q + 1) / 12, h - q / 12, luce('ciano', 0.07 * (1 - liscio(0, 1, (q + 0.5) / 12)))]);
			strato(ultima, s.R0, cup, [[0, 0], [Math.max(0, (R * 0.6 - s.R0) / (cup - s.R0)), 1], [(R - s.R0) / (cup - s.R0), 1], [1, 0]]);
			x.globalAlpha = 1;
			x.globalCompositeOperation = 'source-over';
			g = x.createRadialGradient(c, c, cup * 0.78, c, c, cup);
			g.addColorStop(0, 'rgba(0, 0, 0, 0)');
			g.addColorStop(1, 'rgba(0, 0, 0, 0.28)');
			x.fillStyle = g;
			x.fillRect(0, 0, s.S, s.S);
			x.restore();
		}

		function chiedi() {
			if (raf || !ctx || stato !== 'canvas' || !attivo || !inVista || !scena) return;
			raf = requestAnimationFrame(passo);
		}

		function ferma() {
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
		}

		function passo(ts) {
			raf = 0;
			if (!ctx || stato !== 'canvas' || !attivo || !inVista || !scena) return;
			const mosso = !opt.reduced();
			const t = clock();
			const vivace = t - rivelaDa < 3500 || t - migraDa < 1000 || acceso >= 0;
			if (mosso && ultimo && ts - ultimo < 1000 / fpsPer(vivace, costo) - 2) {
				raf = requestAnimationFrame(passo);
				return;
			}
			ultimo = ts;
			try {
				disegna(t, mosso);
			} catch (e) {
				ferma();
				ctx = null;
				console.warn('Bottega: cruscotto, la tela 2D si ferma, resta l\'SVG:', e);
				return cambia('svg', String((e && /** @type {any} */ (e).message) || e));
			}
			const ms = clock() - t;
			costo = costo ? costo * 0.9 + ms * 0.1 : ms;
			if (mosso) raf = requestAnimationFrame(passo);
		}

		function disegna(t, mosso) {
			const s = scena;
			const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
			const W = Math.max(1, Math.round(s.S * dpr));
			if (canvas.width !== W || canvas.height !== W) {
				canvas.width = W;
				canvas.height = W;
				fondoSporco = true;
			}
			const m = Math.floor(oraAdesso() * 60);
			if (m !== minuto) {
				minuto = m;
				fondoSporco = true;
			}
			if (!sprite) sprite = creaSprite();
			if (fondoSporco) {
				disegnaFondo(s, W, dpr);
				fondoSporco = false;
			}
			const tempo = mosso ? (t - t0) / 1000 : 0;
			const riv = mosso ? (t - rivelaDa) / 1000 : 99;
			const giro = mosso ? tempo * GIRO : 0;
			const e = facile(mosso ? Math.min(1, (t - migraDa) / 900) : 1);
			const { c, R } = s;
			const on = rit => (rit < 0 ? 1 : liscio(rit, rit + 0.7, riv));
			const x = ctx;

			x.setTransform(1, 0, 0, 1, 0, 0);
			x.globalCompositeOperation = 'source-over';
			x.globalAlpha = 1;
			x.clearRect(0, 0, W, W);
			x.setTransform(dpr, 0, 0, dpr, 0, 0);
			x.globalCompositeOperation = 'lighter';

			// la ghiera, che gira lentissima
			x.lineCap = 'round';
			for (const lunga of [false, true]) {
				x.globalAlpha = (lunga ? 0.42 : 0.2) * (s.rivela ? liscio(0.2, 1, riv) : 1);
				x.strokeStyle = css(LUCE.ciano, 1);
				x.lineWidth = 1;
				x.beginPath();
				for (let j = lunga ? 0 : 1; j < TACCHE; j += lunga ? 8 : 1) {
					if (!lunga && j % 8 === 0) continue;
					const a = (j / TACCHE) * 2 * Math.PI + giro;
					const sn = Math.sin(a), cs = -Math.cos(a), l = lunga ? 3.6 : 2;
					x.moveTo(c + sn * (R + 35 - l), c + cs * (R + 35 - l));
					x.lineTo(c + sn * (R + 35 + l), c + cs * (R + 35 + l));
				}
				x.stroke();
			}

			// il campo: scintilla e gira a meta' velocita' della ghiera
			const ca = Math.cos(giro * 0.5), sa = Math.sin(giro * 0.5);
			for (const [px, py, rr, op, ph, w] of s.campo) {
				const dx = px - c, dy = py - c;
				const a = Math.min(0.9, op * 2.2) * (0.7 + 0.3 * Math.sin(tempo * w + ph)) * (s.rivela ? liscio(0.05 + (Math.hypot(dx, dy) / R) * 1.1, 0.55 + (Math.hypot(dx, dy) / R) * 1.1, riv) : 1);
				if (a < 0.01) continue;
				const l = rr * 3.2;
				x.globalAlpha = a;
				x.drawImage(sprite.campo, c + dx * ca - dy * sa - l, c + dx * sa + dy * ca - l, l * 2, l * 2);
			}

			const pos = s.stelle.map(st => (st.da ? [st.da[0] + (st.x - st.da[0]) * e, st.da[1] + (st.y - st.da[1]) * e] : [st.x, st.y]));
			const idx = new Map(s.stelle.map((st, j) => [st.i, j]));
			const spento = i => acceso >= 0 && i !== acceso;

			// impulsi di luce lungo i legami: testa chiara, coda che sfuma all'indietro
			const onL = on(s.ritardoLegami);
			x.lineWidth = 1.6;
			for (const l of s.legami) {
				const a0 = pos[idx.get(l.a)], b0 = pos[idx.get(l.b)];
				if (!a0 || !b0) continue;
				const n = Math.max(1, Math.min(4, Math.round(l.minuti / 40)));
				const forte = l.minuti >= 60;
				const vel = forte ? 0.16 : 0.11;
				const lit = acceso >= 0 ? (l.a === acceso || l.b === acceso ? 1.5 : 0.15) : 1;
				const dx = b0[0] - a0[0], dy = b0[1] - a0[1];
				const len = Math.hypot(dx, dy) || 1;
				for (let j = 0; j < n; j++) {
					const f = (((tempo * vel + j / n) % 1) + 1) % 1;
					const a = Math.min(1, (forte ? 0.95 : 0.7) * Math.sin(f * Math.PI) * onL * lit);
					if (a < 0.01) continue;
					const hx = a0[0] + dx * f, hy = a0[1] + dy * f;
					const coda = Math.min(len * f, 26);
					const g = x.createLinearGradient(hx - (dx / len) * coda, hy - (dy / len) * coda, hx, hy);
					g.addColorStop(0, css(LUCE.ciano, 0));
					g.addColorStop(1, css(LUCE.ciano, 0.55 * a));
					x.globalAlpha = 1;
					x.strokeStyle = g;
					x.beginPath();
					x.moveTo(hx - (dx / len) * coda, hy - (dy / len) * coda);
					x.lineTo(hx, hy);
					x.stroke();
					const q = forte ? 4.4 : 3.6;
					x.globalAlpha = a;
					x.drawImage(sprite.scintilla, hx - q, hy - q, q * 2, q * 2);
				}
			}

			// le scie delle sessioni vive: un arco sull'orbita, alle spalle della stella
			s.stelle.forEach((st, j) => {
				if (!st.vivo) return;
				const [px, py] = pos[j];
				const rs = Math.max(1, Math.hypot(px - c, py - c));
				const L = Math.max(0.2, Math.min(1.1, SCIA_PX / rs));
				const th = Math.atan2(py - c, px - c);
				const k = on(st.ritardo) * (spento(st.i) ? 0.32 : 1);
				const N = 14;
				for (let q = 0; q < N; q++) {
					const f = (q + 0.5) / N;
					const onda = 0.72 + 0.28 * Math.sin(f * 16 - tempo * 3.2);
					const a = 0.6 * k * Math.exp(-f * 2.4) * liscio(0, 0.05, f) * (1 - liscio(0.8, 1, f)) * onda;
					if (a < 0.01) continue;
					x.globalAlpha = a;
					x.strokeStyle = css(LUCE.sodio, 1);
					x.lineWidth = 1.6 + 2.6 * f;
					x.beginPath();
					x.arc(c, c, rs, th - (L * q) / N, th - (L * (q + 1)) / N, true);
					x.stroke();
				}
			});

			// le stelle: si accendono dal centro, respirano piano, sfasate
			s.stelle.forEach((st, j) => {
				const [px, py] = pos[j];
				const o = on(st.ritardo);
				if (o < 0.01) return;
				const r = mosso ? respiro(st.i, tempo) : 1;
				let a = (st.altrove ? 0.95 : 1) * o * r;
				let l = (st.altrove ? st.size * 1.75 : st.size * 3.2) * (0.3 + 0.7 * o) * (1 + (r - 1) * 0.6);
				if (acceso >= 0) {
					if (st.i === acceso) l *= 1.2;
					else a *= 0.32;
				}
				x.globalAlpha = Math.min(1, a);
				x.drawImage(st.altrove ? sprite.altrove : sprite.stella, px - l, py - l, l * 2, l * 2);
			});

			// l'onda delle sessioni vive: si allarga e si spegne ogni 2,8 secondi
			x.strokeStyle = css(LUCE.sodio, 1);
			x.lineWidth = 1.4;
			s.stelle.forEach((st, j) => {
				if (!st.vivo) return;
				const [px, py] = pos[j];
				const f = (((tempo / 2.8 + ((j * 0.37) % 1)) % 1) + 1) % 1;
				const a = 0.95 * (1 - f) * on(st.ritardo) * (spento(st.i) ? 0.32 : 1);
				if (a < 0.01) return;
				x.globalAlpha = a;
				x.beginPath();
				x.arc(px, py, (st.size + 6) * (0.85 + 0.6 * f), 0, 2 * Math.PI);
				x.stroke();
			});

			// la lancetta di adesso, con un lampo che la percorre se c'e' una sessione viva
			const h = oraAdesso();
			const an = ((h - 12) / 24) * 2 * Math.PI;
			const sn = Math.sin(an), cs = -Math.cos(an);
			x.globalAlpha = 0.5;
			x.strokeStyle = css(LUCE.ciano, 1);
			x.lineWidth = 1.2;
			x.beginPath();
			x.moveTo(c + sn * s.R0, c + cs * s.R0);
			x.lineTo(c + sn * (R + 8), c + cs * (R + 8));
			x.stroke();
			if (mosso && s.stelle.some(st => st.vivo)) {
				const f = (tempo / 4) % 1;
				const d = s.R0 + (R + 8 - s.R0) * f;
				x.globalAlpha = 0.8;
				x.drawImage(sprite.scintilla, c + sn * d - 3, c + cs * d - 3, 6, 6);
			}
			x.globalAlpha = 1;
			x.globalCompositeOperation = 'source-over';
			frames++;
		}

		return {
			get stato() {
				return stato;
			},
			get frames() {
				return frames;
			},
			get inCorsa() {
				return !!raf;
			},
			get costo() {
				return costo;
			},
			/** WebGPU non c'e': la tela prende il cielo. Senza contesto 2D resta l'SVG. */
			abilita() {
				if (stato !== 'attesa') return;
				try {
					ctx = canvas.getContext('2d');
					fondo = telaFondo.getContext('2d');
				} catch {
					ctx = null;
				}
				if (!ctx || !fondo) {
					ctx = null;
					return cambia('svg', 'la tela non da un contesto 2D');
				}
				cambia('canvas', '');
				chiedi();
			},
			attiva(on) {
				attivo = !!on;
				if (attivo) chiedi();
				else ferma();
			},
			inVista(on) {
				inVista = !!on;
				if (inVista) chiedi();
				else ferma();
			},
			scena(s) {
				scena = s;
				const t = clock();
				if (s.rivela) rivelaDa = t;
				if (s.migra) {
					migraDa = t;
					rivelaDa = t;
				}
				fondoSporco = true;
				chiedi();
			},
			accendi(i) {
				acceso = i;
				chiedi();
			},
			ridisegna() {
				chiedi();
			},
			chiudi() {
				ferma();
			},
		};
	}

	// ---------- la corrente del lavoro in parallelo, su WebGPU ----------

	/* Le ultime 168 ore come un canale di luce: lo spessore e' quante sessioni giravano insieme, la
	   luminosita' quanta parte dell'ora era coperta. Due passaggi:
	   - fiume: un triangolo che copre la tela; per ogni pixel legge le due ore vicine (uniform), le
	     raccorda e disegna la fascia con una corrente di rumore che scorre verso adesso;
	   - gocce: quadratini in istanza senza buffer (posizione e velocita' dal numero dell'istanza), che
	     viaggiano dentro la fascia; dove non c'erano sessioni spariscono.
	   Solo luce: assi, etichette, prese e numeri restano nell'SVG sopra, uguale col ripiego. */
	const WGSL_CORRENTE = /* wgsl */ `
struct U {
	a: vec4f,
	b: vec4f,
	c: vec4f,
	v: array<vec4f, 42>,
	o: array<vec4f, 42>,
};
@group(0) @binding(0) var<uniform> u: U;

fn hash(p: vec2f) -> f32 {
	var q = fract(p * vec2f(123.34, 456.21));
	q += dot(q, q + 45.32);
	return fract(q.x * q.y);
}

fn noise(p: vec2f) -> f32 {
	let i = floor(p);
	let f = fract(p);
	let w = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), w.x), mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), w.x), w.y);
}

fn fbm(p0: vec2f) -> f32 {
	var p = p0;
	var s = 0.0;
	var amp = 0.55;
	for (var k = 0; k < 3; k++) {
		s += amp * noise(p);
		p = p * 2.07 + vec2f(11.3, 4.7);
		amp *= 0.5;
	}
	return s;
}

fn val(i: i32) -> f32 {
	if (i < 0 || i > 167) { return 0.0; }
	let k = u32(i);
	let q = u.v[k / 4u];
	return q[k % 4u];
}

fn occ(i: i32) -> f32 {
	if (i < 0 || i > 167) { return 0.0; }
	let k = u32(i);
	let q = u.o[k / 4u];
	return q[k % 4u];
}

// x in px: (sessioni insieme, parte dell'ora coperta), raccordate tra un'ora e la successiva
fn campiona(x: f32) -> vec2f {
	let t = (x - u.b.z) / max(1.0, u.b.w - u.b.z) * u.c.x - 0.5;
	let i = i32(floor(t));
	let f = t - floor(t);
	let s = f * f * (3.0 - 2.0 * f);
	return vec2f(mix(val(i), val(i + 1), s), mix(occ(i), occ(i + 1), s));
}

// l'arrivo dei dati: la corrente entra da sinistra
fn rivela(x: f32) -> f32 {
	let k = clamp(u.c.z / 1.2, 0.0, 1.0);
	let fronte = u.b.z - 24.0 + (u.b.w - u.b.z + 48.0) * k;
	return 1.0 - smoothstep(fronte - 24.0, fronte, x);
}

struct VF { @builtin(position) pos: vec4f };

@vertex fn vs_pieno(@builtin(vertex_index) i: u32) -> VF {
	var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
	var o: VF;
	o.pos = vec4f(p[i], 0.0, 1.0);
	return o;
}

@fragment fn fs_fiume(v: VF) -> @location(0) vec4f {
	let p = v.pos.xy / u.a.w;
	let s = campiona(p.x);
	let fuori = step(p.x, u.b.z - 1.0) + step(u.b.w + 1.0, p.x);
	if (fuori > 0.5 || s.x < 0.01) { return vec4f(0.0); }
	let mezza = s.x * u.b.y;
	let d = abs(p.y - u.b.x);
	let dentro = 1.0 - smoothstep(mezza - 0.8, mezza + 0.8, d);
	let alone = exp(-max(0.0, d - mezza) / 6.0) * 0.28;
	let corrente = fbm(vec2f(p.x * 0.028 - u.a.z * 0.85, p.y * 0.1 + sin(p.x * 0.012) * 0.6));
	let cuore = exp(-(d * d) / max(1.0, mezza * mezza) * 1.8);
	let piena = 0.3 + 0.7 * s.y;
	let luce = (dentro * (0.2 + 0.55 * corrente + 0.4 * cuore) + alone) * piena * rivela(p.x);
	let bianca = clamp((s.x - 1.0) / 3.0, 0.0, 1.0) * cuore * 0.7;
	let col = mix(vec3f(0.39, 0.9, 0.86), vec3f(0.86, 1.0, 0.98), bianca);
	let a = clamp(luce, 0.0, 1.0);
	return vec4f(col * a, a);
}

struct VG {
	@builtin(position) pos: vec4f,
	@location(0) uv: vec2f,
	@location(1) a: f32,
};

@vertex fn vs_goccia(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VG {
	var angoli = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
	let k = angoli[vi];
	let f = f32(ii);
	let largo = max(1.0, u.b.w - u.b.z);
	let vel = 22.0 + 46.0 * hash(vec2f(f, 3.1));
	let x = u.b.z + fract(hash(vec2f(f, 1.7)) + u.a.z * vel / largo) * largo;
	let s = campiona(x);
	let corsia = clamp(hash(vec2f(f, 7.3)) * 2.0 - 1.0 + sin(u.a.z * 1.3 + f) * 0.08, -1.0, 1.0);
	let y = u.b.x + corsia * s.x * u.b.y * 0.86;
	let lato = 1.2 + 1.8 * hash(vec2f(f, 5.9));
	let p = vec2f(x, y) + k * lato * 2.2;
	var o: VG;
	o.pos = vec4f(p.x / u.a.x * 2.0 - 1.0, 1.0 - p.y / u.a.y * 2.0, 0.0, 1.0);
	o.uv = k;
	o.a = smoothstep(0.2, 0.9, s.x) * (0.35 + 0.65 * s.y) * rivela(x) * (0.55 + 0.45 * hash(vec2f(f, 8.8))) * u.c.y;
	return o;
}

@fragment fn fs_goccia(v: VG) -> @location(0) vec4f {
	let r = length(v.uv);
	let a = clamp(exp(-r * r * 5.0) * v.a, 0.0, 1.0);
	return vec4f(vec3f(0.8, 1.0, 0.97) * a, a);
}
`;
	const GOCCE = 240;
	const ORE7 = 168;

	/**
	 * Il motore WebGPU della corrente: stessa vita del cielo (stati 'spento', 'avvio', 'gpu', 'svg'),
	 * stesso dispositivo (l'officina). 20 fotogrammi al secondo al massimo, solo con la stanza
	 * visibile e la corrente sullo schermo; con "riduci movimento" un fotogramma fermo.
	 * @param {HTMLCanvasElement} canvas
	 * @param {any} officina window.BottegaGPU.officina(), oppure OFFICINA_CHIUSA
	 * @param {{ reduced: () => boolean, onStato: (stato: string, motivo: string) => void, rilascio?: number }} opt
	 */
	function creaCorrente(canvas, officina, opt) {
		const rilascio = opt.rilascio ?? RILASCIO_MS;
		let stato = officina.disponibile ? 'spento' : 'svg';
		let gen = 0;
		/** @type {any} */ let dev = null;
		/** @type {any} */ let ctx = null;
		/** @type {any} */ let r = null;
		/** @type {any} */ let scena = null;
		let attivo = false;
		let inVista = true;
		let raf = 0;
		let ultimo = 0;
		let rilascioT = 0;
		let rivelaDa = -1e9;
		const t0 = clock();
		// a, b, c (12 float) + 168 + 168: 1392 byte, multiplo di 16
		const U = new Float32Array(12 + ORE7 * 2);

		function cambia(s, motivo) {
			stato = s;
			try {
				opt.onStato(s, motivo || '');
			} catch (e) {
				console.error('Bottega: cruscotto, stato della corrente', e);
			}
		}

		function spegni() {
			gen++;
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
			const avevo = !!dev;
			dev = null;
			if (r && r.ubuf) {
				try {
					r.ubuf.destroy();
				} catch {}
			}
			r = null;
			try {
				ctx && ctx.unconfigure && ctx.unconfigure();
			} catch {}
			if (avevo) officina.lascia();
		}

		function ripiego(motivo) {
			if (stato === 'svg') return;
			console.warn('Bottega: corrente senza WebGPU, ripiego sull\'SVG:', motivo);
			spegni();
			cambia('svg', motivo);
		}
		officina.ascolta(motivo => ripiego(motivo));

		async function avvia() {
			if (stato === 'svg' || stato === 'avvio' || dev) return;
			const g = ++gen;
			cambia('avvio', '');
			let preso = false;
			try {
				const { device: d, format } = await officina.prendi();
				preso = true;
				if (g !== gen) {
					officina.lascia();
					return;
				}
				const c = canvas.getContext('webgpu');
				if (!c) throw new Error('la tela non da un contesto webgpu');
				c.configure({ device: d, format, alphaMode: 'premultiplied' });
				const mod = await opt.modulo(d, WGSL_CORRENTE, 'WGSL della corrente');
				const [pFiume, pGocce] = await Promise.all([
					d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: mod, entryPoint: 'vs_pieno' }, fragment: { module: mod, entryPoint: 'fs_fiume', targets: [{ format }] }, primitive: { topology: 'triangle-list' } }),
					d.createRenderPipelineAsync({
						layout: 'auto',
						vertex: { module: mod, entryPoint: 'vs_goccia' },
						fragment: {
							module: mod,
							entryPoint: 'fs_goccia',
							targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }],
						},
						primitive: { topology: 'triangle-strip' },
					}),
				]);
				if (g !== gen) {
					officina.lascia();
					return;
				}
				const ubuf = d.createBuffer({ size: U.byteLength, usage: USO.UNIFORM | USO.COPY_DST });
				r = {
					pFiume,
					pGocce,
					ubuf,
					bgFiume: d.createBindGroup({ layout: pFiume.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] }),
					bgGocce: d.createBindGroup({ layout: pGocce.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] }),
				};
				dev = d;
				ctx = c;
				cambia('gpu', '');
				chiedi();
			} catch (e) {
				if (preso && !dev) officina.lascia();
				if (g !== gen) return;
				ripiego(String((e && /** @type {any} */ (e).message) || e));
			}
		}

		const animato = () => !opt.reduced();

		function chiedi() {
			if (raf || !dev || !r || !attivo || !inVista || !scena) return;
			raf = requestAnimationFrame(passo);
		}

		function passo(ts) {
			raf = 0;
			if (!dev || !r || !attivo || !inVista || !scena) return;
			const mosso = animato();
			if (mosso && ultimo && ts - ultimo < 1000 / 20 - 2) {
				raf = requestAnimationFrame(passo);
				return;
			}
			ultimo = ts;
			try {
				disegna(mosso);
			} catch (e) {
				return ripiego(String((e && /** @type {any} */ (e).message) || e));
			}
			if (mosso) raf = requestAnimationFrame(passo);
		}

		function disegna(mosso) {
			const s = scena;
			const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
			const W = Math.max(1, Math.round(s.W * dpr));
			const H = Math.max(1, Math.round(s.H * dpr));
			if (canvas.width !== W || canvas.height !== H) {
				canvas.width = W;
				canvas.height = H;
			}
			const t = clock();
			U[0] = s.W;
			U[1] = s.H;
			U[2] = mosso ? (t - t0) / 1000 : 0;
			U[3] = dpr;
			U[4] = s.mid;
			U[5] = s.unit;
			U[6] = s.x0;
			U[7] = s.x1;
			U[8] = ORE7;
			U[9] = mosso ? 1 : 0.6; // gocce piene in movimento, piu' tenui da ferme
			U[10] = mosso ? (t - rivelaDa) / 1000 : 99;
			U[11] = 0;
			for (let i = 0; i < ORE7; i++) {
				U[12 + i] = s.avg[i] || 0;
				U[12 + ORE7 + i] = Math.min(1, (s.busy[i] || 0) / 60);
			}
			dev.queue.writeBuffer(r.ubuf, 0, U.buffer, 0, U.byteLength);
			const enc = dev.createCommandEncoder();
			const p = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
			p.setPipeline(r.pFiume);
			p.setBindGroup(0, r.bgFiume);
			p.draw(3);
			p.setPipeline(r.pGocce);
			p.setBindGroup(0, r.bgGocce);
			p.draw(4, GOCCE);
			p.end();
			dev.queue.submit([enc.finish()]);
		}

		return {
			get stato() {
				return stato;
			},
			attiva(on) {
				if (stato === 'svg') return;
				attivo = !!on;
				clearTimeout(rilascioT);
				if (attivo) {
					if (!dev) avvia();
					else chiedi();
					return;
				}
				if (raf) cancelAnimationFrame(raf);
				raf = 0;
				rilascioT = setTimeout(() => {
					if (attivo || !dev) return;
					spegni();
					cambia('spento', '');
				}, rilascio);
			},
			inVista(on) {
				inVista = !!on;
				if (inVista) chiedi();
				else if (raf) {
					cancelAnimationFrame(raf);
					raf = 0;
				}
			},
			/** Dati o misura nuovi; s.rivela fa entrare la corrente da sinistra. */
			scena(s) {
				const chiave = [s.W, s.H, s.mid, s.unit, s.x0, s.x1, s.avg.join(','), s.busy.join(',')].join('|');
				if (s.rivela) rivelaDa = clock();
				else if (scena && scena.chiave === chiave) return;
				scena = { ...s, chiave };
				chiedi();
			},
			ridisegna() {
				chiedi();
			},
			chiudi() {
				clearTimeout(rilascioT);
				spegni();
			},
		};
	}

	// ---------- il banco: due colonne che finiscono insieme ----------

	/** Sotto quanti px di guadagno una divisione nuova non vale lo spostamento dei blocchi. */
	const TENUTA = 40;

	/**
	 * Divide i blocchi del banco in due colonne con altezze il piu' possibile uguali. I blocchi sono
	 * pochi: si provano tutte le divisioni (2^n) e si tiene la migliore; dentro ogni colonna i blocchi
	 * restano nel loro ordine. A parita' (6 px a blocco) vince la colonna preferita, e la divisione di
	 * adesso resta se quella nuova guadagna meno di TENUTA px: niente blocchi che saltano per poco.
	 * @param {number[]} alti altezze in px
	 * @param {number} spazio px tra un blocco e il successivo nella stessa colonna
	 * @param {number[]} fissi colonna obbligata (0 o 1), oppure -1
	 * @param {number[]} preferite colonna preferita di ogni blocco
	 * @param {number[] | null} attuale la divisione di adesso
	 * @returns {{ colonne: number[], alte: number[], scarto: number }}
	 */
	function dividi(alti, spazio, fissi, preferite, attuale) {
		const n = alti.length;
		const misura = m => {
			const a = [0, 0];
			const k = [0, 0];
			for (let i = 0; i < n; i++) {
				a[m[i]] += alti[i];
				k[m[i]]++;
			}
			for (const c of [0, 1]) if (k[c] > 1) a[c] += spazio * (k[c] - 1);
			return a;
		};
		const costo = m => {
			const a = misura(m);
			let d = 0;
			for (let i = 0; i < n; i++) if (m[i] !== preferite[i]) d++;
			return Math.abs(a[0] - a[1]) + d * 6;
		};
		let best = null;
		let bc = Infinity;
		for (let mask = 0; mask < 1 << n; mask++) {
			const m = [];
			let ok = true;
			for (let i = 0; i < n && ok; i++) {
				const c = (mask >> i) & 1;
				if (fissi[i] >= 0 && fissi[i] !== c) ok = false;
				m.push(c);
			}
			if (!ok) continue;
			const c = costo(m);
			if (c < bc) {
				bc = c;
				best = m;
			}
		}
		if (!best) best = preferite.slice();
		const valida = !!attuale && attuale.length === n && attuale.every((c, i) => fissi[i] < 0 || fissi[i] === c);
		const scelta = valida && costo(/** @type {number[]} */ (attuale)) - bc <= TENUTA ? /** @type {number[]} */ (attuale).slice() : best;
		const a = misura(scelta);
		return { colonne: scelta, alte: a, scarto: Math.abs(a[0] - a[1]) };
	}

	/** I blocchi del banco nell'ordine di lettura (una colonna sola) e la colonna preferita. */
	const BLOCCHI = [
		['oggi', 0],
		['adesso', 1],
		['parallelo', 0],
		['calore', 1],
		['sale', 0],
		['durata', 1],
		['registro', 1],
	];
	/** px tra un blocco e il successivo in una colonna: lo stesso gap di .banco-col nel CSS. */
	const SPAZIO = 48;
	/** Sotto questa larghezza il banco va su una colonna sola (due colonne da meno di 388 px). */
	const DUE_COLONNE = 820;

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
		let paused = false;
		let waitTimer = 0;
		let lastKey = '';
		/** Animazioni in attesa del prossimo disegno visibile: una volta per arrivo di dati. */
		const anim = { rivela: false, conta: false, grafici: false, glitch: false, migra: false };
		let richiesto = false; // l'ultima richiesta l'ha fatta Andrea (Aggiorna, Riprova)
		/** Le cifre come le ha viste l'ultima volta, per periodo: si conta da li', si segnala cosa cambia. */
		/** @type {Record<string, Record<string, number>>} */ const viste = {};
		let mostrate = /** @type {Record<string, number> | null} */ (null);
		const mosso = () => !reduced.matches;

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
				<section class="crus-sez crus-attivita" id="crus-attivita" aria-labelledby="attivita-titolo" hidden>
					<div class="sez-testa"><h2 id="attivita-titolo">Attività osservate</h2><ul class="legenda" id="attivita-legenda"></ul></div>
					<p class="nota" id="attivita-nota"></p>
					<div class="attivita-fonti" id="attivita-fonti"></div>
					<div class="grafico attivita-grafico" id="attivita-grafico" tabindex="0" role="group" aria-roledescription="grafico" aria-label="Attività aggiornate per giorno, divise per fonte" data-fk="c:attivita"></div>
					<div class="tabella-blocco" id="attivita-tabella"></div>
				</section>

				<section class="crus-cielo" aria-labelledby="carta-titolo">
					<figure class="carta" id="carta">
						<div class="carta-testa" id="carta-testa"><h2 id="carta-titolo">Il cielo dei progetti</h2><p class="telemetria"><span id="carta-conto"></span><span class="motore" id="carta-motore"></span></p></div>
						<div class="carta-palco" id="carta-palco">
							<canvas class="carta-gpu" id="carta-gpu" aria-hidden="true"></canvas>
							<canvas class="carta-tela" id="carta-tela-fondo" aria-hidden="true"></canvas>
							<canvas class="carta-tela" id="carta-tela" aria-hidden="true"></canvas>
							<div class="carta-svg" id="carta-svg" aria-hidden="true"></div>
							<div class="scansione" aria-hidden="true"></div>
						</div>
						<p class="carta-piede"><button type="button" class="ghost" data-c="osservatorio" data-fk="c:osservatorio" title="Lo stesso cielo in una finestra del Mac, disegnato con Metal">Apri nell'Osservatorio</button></p>
						<figcaption id="carta-legenda" class="carta-legenda"></figcaption>
						<div class="tabella-blocco" id="carta-tabella"></div>
					</figure>
					<div class="classifica" id="classifica-col">
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

				<section class="crus-sez categorie" id="categorie-sez" aria-labelledby="categorie-titolo" hidden>
					<div class="sez-testa"><h2 id="categorie-titolo">Che lavoro è stato</h2></div>
					<p class="nota" id="categorie-frase"></p>
					<ol class="righe-categorie" id="categorie" aria-labelledby="categorie-titolo"></ol>
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

				<section class="crus-sez conti-sez" id="conti-sez" aria-labelledby="conti-titolo"></section>

				<div class="banco" id="banco">
					<div class="banco-col" id="banco-a">
						<section class="blocco" id="b-oggi" aria-labelledby="oggi-titolo">
							<div class="sez-testa"><h2 id="oggi-titolo">Oggi, sessione per sessione</h2><ul class="legenda" id="oggi-legenda"></ul></div>
							<p class="nota" id="oggi-nota"></p>
							<div class="grafico oggi" id="oggi" tabindex="0" role="group" aria-roledescription="linea del tempo" data-fk="c:oggi"></div>
							<div class="tabella-blocco" id="oggi-tabella"></div>
						</section>
						<section class="blocco" id="b-parallelo" aria-labelledby="parallelo-titolo">
							<div class="sez-testa"><h2 id="parallelo-titolo">Lavoro in parallelo</h2><ul class="legenda" id="parallelo-legenda"></ul></div>
							<p class="nota" id="parallelo-nota"></p>
							<figure class="corrente" id="corrente">
								<p class="telemetria"><span id="corrente-conto"></span><span class="motore" id="corrente-motore"></span></p>
								<div class="corrente-palco" id="corrente-palco">
									<canvas class="corrente-gpu" id="corrente-gpu" aria-hidden="true"></canvas>
									<div class="grafico corrente-svg" id="parallelo" tabindex="0" role="group" aria-roledescription="grafico" data-fk="c:parallelo"></div>
								</div>
							</figure>
							<div class="tabella-blocco" id="parallelo-tabella"></div>
						</section>
						<section class="blocco" id="b-sale" aria-labelledby="sale-titolo">
							<div class="sez-testa"><h2 id="sale-titolo">Chi sale e chi scende</h2><ul class="legenda" id="sale-legenda"></ul></div>
							<p class="nota" id="sale-nota"></p>
							<div id="sale"></div>
							<div class="tabella-blocco" id="sale-tabella"></div>
						</section>
					</div>
					<div class="banco-col" id="banco-b">
						<section class="blocco" id="b-adesso" aria-labelledby="adesso-titolo">
							<h2 id="adesso-titolo">Adesso</h2>
							<ul class="adesso" id="adesso" aria-labelledby="adesso-titolo"></ul>
						</section>
						<section class="blocco" id="b-calore" aria-labelledby="calore-titolo">
							<div class="sez-testa"><h2 id="calore-titolo">La settimana, ora per ora</h2><div class="scala" id="calore-scala"></div></div>
							<p class="nota" id="calore-nota"></p>
							<div class="grafico calore" id="calore" tabindex="0" role="group" aria-roledescription="mappa di calore" data-fk="c:calore"></div>
							<div class="tabella-blocco" id="calore-tabella"></div>
						</section>
						<section class="blocco" id="b-durata" aria-labelledby="durata-titolo">
							<div class="sez-testa"><h2 id="durata-titolo">Quanto dura una sessione</h2><ul class="legenda" id="durata-legenda"></ul></div>
							<p class="nota" id="durata-nota"></p>
							<div class="grafico" id="durata" tabindex="0" role="group" aria-roledescription="grafico" data-fk="c:durata"></div>
							<div class="tabella-blocco" id="durata-tabella"></div>
						</section>
						<section class="blocco" id="b-registro" aria-labelledby="registro-titolo">
							<h2 id="registro-titolo">Registro</h2>
							<dl class="primati" id="primati"></dl>
						</section>
					</div>
				</div>

				<p class="come-conto" id="come-conto"></p>
			</div>
			<div class="crus-tip" id="crus-tip" hidden></div>
			<p class="sr" id="crus-voce" aria-live="polite"></p>
		</div>`;

		const $ = id => /** @type {any} */ (root.querySelector('#' + id));
		const crus = $('crus');
		const tip = $('crus-tip');
		// crediti e consumi dei servizi: un file suo (media/conti.js, CONTRATTI 14), qui solo montato
		const BC = /** @type {any} */ (window).BottegaConti;
		const contiUI = BC ? BC.mount($('conti-sez'), { post: m => host.post(m), periodo: () => ui.period, claude: () => (stats ? P().cost : null) }) : null;

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

		/** Una classe che resta il tempo di un'animazione e poi se ne va (cosi' si puo' rifare). */
		/** @type {WeakMap<Element, Record<string, any>>} */ const timers = new WeakMap();
		function lampo(el, cls, ms) {
			if (!el) return;
			let m = timers.get(el);
			if (!m) timers.set(el, (m = {}));
			clearTimeout(m[cls]);
			el.classList.remove(cls);
			void el.getBoundingClientRect(); // riparte da capo
			el.classList.add(cls);
			m[cls] = setTimeout(() => el.classList.remove(cls), ms);
		}

		// ---------- letture che scorrono e si assestano ----------

		const FMT = { min: v => hm(v), n: v => it(Math.round(v)), tok: v => tk(v), usd: v => usd(v) };
		/** @type {Set<any>} */ const contatori = new Set();
		let rafC = 0;
		function conta(el, da, a, fmt, ms, ritardo) {
			el.textContent = FMT[fmt](da);
			contatori.add({ el, da, a, fmt, t0: performance.now() + ritardo, ms });
			if (!rafC) rafC = requestAnimationFrame(giraContatori);
		}
		function giraContatori() {
			rafC = 0;
			const t = performance.now();
			for (const c of contatori) {
				const k = Math.max(0, Math.min(1, (t - c.t0) / c.ms));
				c.el.textContent = FMT[c.fmt](k >= 1 ? c.a : c.da + (c.a - c.da) * facile(k));
				if (k >= 1) contatori.delete(c);
			}
			if (contatori.size) rafC = requestAnimationFrame(giraContatori);
		}
		/** Tutte le letture al valore finale, subito (stanza nascosta, riduci movimento). */
		function assesta() {
			for (const c of contatori) c.el.textContent = FMT[c.fmt](c.a);
			contatori.clear();
			if (rafC) cancelAnimationFrame(rafC);
			rafC = 0;
		}

		// ---------- il motore del cielo ----------

		const MOTORE = {
			gpu: ['WebGPU', 'Il cielo lo disegna la scheda grafica con WebGPU, che sul Mac passa da Metal. I dati sono gli stessi della versione in SVG.'],
			avvio: ['accendo WebGPU', 'Sto accendendo la scheda grafica; intanto il cielo è in SVG.'],
			spento: ['WebGPU', 'La scheda grafica è stata liberata mentre la stanza era nascosta; torna quando il cielo si vede.'],
			canvas: ['Canvas', 'Il cielo lo disegna il processore con Canvas 2D: stesse animazioni, luci più semplici. I dati sono gli stessi della versione in SVG.'],
			svg: ['SVG', 'Il cielo è disegnato in SVG, fermo, con gli stessi dati.'],
		};
		/* Il motore condiviso (motore/gpu.js): un solo dispositivo WebGPU per la webview, lo stesso della
		   sfera di Melissa. Senza quel file la corrente resta in SVG e il cielo passa alla tela 2D. */
		const GPU = /** @type {any} */ (window).BottegaGPU || null;
		const officina = GPU ? GPU.officina() : OFFICINA_CHIUSA;
		/* Il cielo ha tre motori, in ordine: WebGPU (motore/cielo-gpu.js), Canvas 2D (quando WebGPU non
		   parte), SVG fermo (quando manca anche il contesto 2D). L'SVG c'e' sempre sopra, con i dati. */
		let motivoGpu = '';
		/** Il motore che disegna adesso e perche' (per l'indicatore e per cielo.diag). */
		const motore = { stato: '', motivo: '' };
		/** @type {Set<string>} */ const diagInviati = new Set();
		/** Una riga all'estensione: quale motore disegna il cielo e perche'. Una per motore, per montaggio. */
		function diag(m, motivo) {
			if (diagInviati.has(m)) return;
			diagInviati.add(m);
			const nav = /** @type {any} */ (typeof navigator !== 'undefined' ? navigator : {});
			const g = /** @type {any} */ (globalThis);
			host.post({ type: 'cielo.diag', motore: m, motivo: motivo || '', gpu: !!nav.gpu, isSecureContext: !!g.isSecureContext, crossOriginIsolated: !!g.crossOriginIsolated, userAgent: String(nav.userAgent || '') });
		}
		const it1 = n => it(n, n < 10 ? 1 : 0);
		function titoloMotore() {
			const [, why] = MOTORE[motore.stato] || MOTORE.svg;
			let t = why;
			if (motore.stato === 'canvas' || motore.stato === 'svg') t += motivoGpu ? ` WebGPU non è partito: ${motivoGpu}.` : '';
			if (motore.stato === 'svg' && motore.motivo && motore.motivo !== motivoGpu) t += ` La tela 2D non è partita: ${motore.motivo}.`;
			const ms = motore.stato === 'gpu' ? cieloGpu.costo : motore.stato === 'canvas' ? cielo2d.costo : 0;
			if (ms > 0) t += ` Un fotogramma costa in media ${it1(ms)} ms.`;
			return t;
		}
		function mostraMotore(s, motivo) {
			motore.stato = s;
			motore.motivo = motivo || '';
			const carta = $('carta');
			carta.classList.toggle('gpu', s === 'gpu');
			carta.classList.toggle('tela', s === 'canvas');
			carta.setAttribute('data-motore', s);
			const m = $('carta-motore');
			m.textContent = (MOTORE[s] || MOTORE.svg)[0];
			m.title = titoloMotore();
			if (s === 'gpu') diag('webgpu', '');
			else if (s === 'canvas') diag('canvas', motivoGpu);
			else if (s === 'svg') diag('svg', [motivoGpu, motivo && motivo !== motivoGpu ? `tela 2D: ${motivo}` : ''].filter(Boolean).join('; '));
		}
		let gpuCaduto = false;
		const cielo2d = creaCielo2d(/** @type {any} */ ($('carta-tela')), /** @type {any} */ ($('carta-tela-fondo')), {
			reduced: () => !!reduced.matches,
			onStato(s, motivo) {
				if (gpuCaduto) mostraMotore(s, motivo);
			},
		});
		/** WebGPU non c'e' o e' caduto: la tela 2D prende il cielo (o resta l'SVG). */
		function passaAllaTela(motivo) {
			if (gpuCaduto) return;
			gpuCaduto = true;
			motivoGpu = motivo || officina.motivo || 'WebGPU spento';
			console.warn('Bottega: cruscotto, il cielo passa alla tela 2D:', motivoGpu);
			if (cielo2d.stato === 'attesa') cielo2d.abilita();
			else mostraMotore(cielo2d.stato === 'canvas' ? 'canvas' : 'svg', '');
		}
		/** Il motore WebGPU che non c'e': tiene le chiamate e non fa niente. */
		const SENZA = { stato: 'rotto', costo: 0, frames: 0, attiva() {}, inVista() {}, scena() {}, accendi() {}, ridisegna() {}, chiudi() {} };
		/** @type {any} */ let cieloGpu = SENZA;
		try {
			const CG = /** @type {any} */ (window).BottegaCieloGPU;
			if (!CG || !CG.mount) throw new Error("il cielo su WebGPU (motore/cielo-gpu.js) non e' caricato");
			cieloGpu = CG.mount($('carta-gpu'), {
				reduced,
				rilascio: host.rilascioGpu,
				onStato: s => !gpuCaduto && mostraMotore(s, ''),
				onFail: passaAllaTela,
			});
			mostraMotore(cieloGpu.stato, '');
		} catch (e) {
			cieloGpu = SENZA;
			passaAllaTela(String((e && /** @type {any} */ (e).message) || e));
		}
		$('carta-motore').addEventListener('pointerenter', () => ($('carta-motore').title = titoloMotore()));
		/** Le stesse chiamate ai due motori: chi non disegna le tiene da parte e basta. */
		const cielo = {
			attiva(on) {
				cieloGpu.attiva(on);
				cielo2d.attiva(on);
			},
			inVista(on) {
				cieloGpu.inVista(on);
				cielo2d.inVista(on);
			},
			scena(sc) {
				cieloGpu.scena(sc);
				cielo2d.scena(sc);
			},
			accendi(i) {
				cieloGpu.accendi(i);
				cielo2d.accendi(i);
			},
			ridisegna() {
				cieloGpu.ridisegna();
				cielo2d.ridisegna();
			},
		};
		const MOTORE_CORRENTE = {
			gpu: ['WebGPU', 'La corrente la disegna la scheda grafica con WebGPU, che sul Mac passa da Metal: le particelle scorrono dentro le ore con più sessioni. I numeri sono gli stessi della versione in SVG.'],
			avvio: ['accendo WebGPU', 'Sto accendendo la scheda grafica; intanto la corrente è in SVG.'],
			spento: ['SVG', 'La scheda grafica è stata liberata mentre la stanza era nascosta; torna quando la corrente si vede.'],
			svg: ['SVG', 'La corrente è disegnata in SVG, con gli stessi dati.'],
		};
		const statoCorrente = (s, motivo) => {
			const [txt, why] = MOTORE_CORRENTE[s] || MOTORE_CORRENTE.svg;
			const m = $('corrente-motore');
			m.textContent = txt;
			m.title = s === 'svg' && motivo ? `${why} WebGPU non è partito: ${motivo}.` : why;
			$('corrente').classList.toggle('gpu', s === 'gpu');
			$('corrente').setAttribute('data-motore', s);
		};
		const corrente = creaCorrente(/** @type {any} */ ($('corrente-gpu')), officina, {
			reduced: () => !!reduced.matches,
			rilascio: host.rilascioGpu,
			onStato: statoCorrente,
			modulo: GPU ? GPU.modulo : null,
		});
		statoCorrente(corrente.stato, officina.disponibile ? '' : officina.motivo || 'questa finestra non offre WebGPU');
		/** Documento nascosto (finestra coperta, altra scheda): niente fotogrammi, come in pausa. */
		const docNascosto = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
		const attivaCielo = () => {
			const on = visible && !paused && !docNascosto();
			cielo.attiva(on);
			corrente.attiva(on);
		};
		if (typeof document !== 'undefined') document.addEventListener('visibilitychange', attivaCielo);
		if (typeof IntersectionObserver === 'function') {
			try {
				new IntersectionObserver(es => cielo.inVista(es.some(e => e.isIntersecting)), { rootMargin: '80px' }).observe($('carta-palco'));
				new IntersectionObserver(es => corrente.inVista(es.some(e => e.isIntersecting)), { rootMargin: '80px' }).observe($('corrente-palco'));
			} catch {}
		}

		/** La tabella "Mostra i numeri"; `testo` sono le colonne di parole, allineate a sinistra. */
		function tabella(id, label, heads, rows, testo = []) {
			const open = !!ui.tables[id];
			const cls = i => (i && !testo.includes(i) ? ' class="num"' : '');
			const btn = `<button type="button" class="link mostra-tabella" data-c="tabella" data-id="${id}" data-fk="c:tab:${id}" aria-expanded="${open}">${open ? 'Nascondi i numeri' : 'Mostra i numeri'}</button>`;
			if (!open) return btn;
			return (
				btn +
				`<div class="tabella-scorre"><table><caption class="sr">${esc(label)}</caption><thead><tr>${heads.map((h, i) => `<th scope="col"${cls(i)}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
					.map(r => `<tr>${r.map((c, i) => (i ? `<td${cls(i)}>${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`)).join('')}</tr>`)
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
			const giorni = stats.days.slice(-p.days);
			const tot = sum4(p.tok);
			// [chiave, etichetta, valore, formato, delta, nota, titolo, traccia giornaliera, classe della traccia]
			const voci = [
				['tu', 'Ore tue', p.you, 'min', delta(p.you, p.prev.you, ok, 'min'), `${it(p.activeDays)} ${p.activeDays === 1 ? 'giorno attivo' : 'giorni attivi'} su ${p.days}`, '', giorni.map(d => d.you), 'sp-tu'],
				['claude', 'Ore di Claude', p.claude, 'min', delta(p.claude, p.prev.claude, ok, 'min'), p.you >= 1 ? `${it(p.claude / p.you, 1)} sessioni attive in media mentre lavori` : '', '', giorni.map(d => d.claude), 'sp-claude'],
				['sessioni', 'Sessioni', p.sessions, 'n', delta(p.sessions, p.prev.sessions, ok, 'n'), p.sessions ? `in media ${hm(p.avgSession)} l'una` : '', '', giorni.map(d => d.sessions), 'sp-n'],
				['token', 'Token', tot, 'tok', delta(tot, sum4(p.prev.tok), ok, 'tok'), `${it(p.prompts)} messaggi scritti da te`, '', giorni.map(d => sum4(d.tok)), 'sp-n'],
				['valore', 'Valore a listino', p.cost, 'usd', delta(p.cost, p.prev.cost, ok, 'usd'), 'stima, non quello che paghi', stats.prices.note, giorni.map(d => d.cost), 'sp-n'],
			];
			const cifra = ([k, label, v, fmt, d, extra, title, serie, cls]) => {
				const value = FMT[fmt](v);
				return `<div class="cifra" data-k="${k}"><dt>${label}</dt><dd><b class="lettura" aria-hidden="true" data-k="${k}"${title ? ` title="${esc(title)}"` : ''}>${value}</b><span class="sr">${value}</span>${
					d ? `<span class="delta ${d.cls}" title="${esc(prima)}">${esc(d.txt)}${d.sr ? `<span class="sr"> ${d.sr} ${esc(prima)}</span>` : ''}</span>` : ''
				}${tracciaMini(serie, cls)}${extra ? `<small>${extra}</small>` : ''}</dd></div>`;
			};
			put($('crus-cifre'), voci.map(cifra).join(''));

			// le letture: contano all'arrivo dei dati o al cambio di periodo, altrimenti segnalano solo cosa e' cambiato
			const valori = Object.fromEntries(voci.map(v => [v[0], v[2]]));
			const prec = viste[ui.period];
			if (anim.conta && mosso()) {
				const da = anim.migra && mostrate ? mostrate : null;
				let n = 0;
				for (const [k, , v, fmt] of voci) {
					const el = $('crus-cifre').querySelector(`.lettura[data-k="${k}"]`);
					if (el) conta(el, da ? da[k] || 0 : 0, v, fmt, 900, n++ * 70);
				}
				lampo($('crus-cifre'), 'traccia', 1600);
			} else if (prec && !anim.conta && mosso()) {
				for (const [k, , v] of voci) {
					if (Math.abs((prec[k] || 0) - v) > 1e-9) lampo($('crus-cifre').querySelector(`.cifra[data-k="${k}"]`), 'cambiata', 1800);
				}
			}
			viste[ui.period] = valori;
			mostrate = valori;
			if (anim.glitch && mosso()) lampo($('crus-frase'), 'glitch', 420);
		}

		/** Conteggi multi-fonte: un'attivita' appare nel giorno del suo ultimo aggiornamento. */
		function renderObservedActivity() {
			const section = $('crus-attivita');
			const observed = stats.observedActivity;
			section.hidden = !observed;
			if (!observed) return;
			const sources = [
				['claude', 'Claude Code'], ['cline', 'Cline'], ['codex', 'Codex'], ['terminale', 'Terminale integrato'],
			];
			const days = (observed.days || []).slice(-Number(ui.period));
			const bySource = Object.fromEntries(sources.map(([source]) => [source, days.reduce((n, d) => n + (Number(d[source]) || 0), 0)]));
			const latest = Object.fromEntries((observed.sources || []).map(s => [s.source, s]));
			put($('attivita-legenda'), sources.map(([source, name]) => `<li><i class="attivita-colore ${source}" aria-hidden="true"></i>${name}</li>`).join(''));
			$('attivita-nota').textContent = `Ultimo aggiornamento negli ultimi ${ui.period} giorni. Ogni attività conta una volta nel giorno in cui è stata vista l'ultima volta. Il registro delle attività copre fino a 7 giorni e 100 sessioni Codex, 45 giorni Cline e i soli terminali aperti; i consumi locali sotto possono coprire fino a 90 giorni. Le cifre principali e gli altri grafici riguardano Claude Code.`;
			const sourceMetrics = stats.sourceMetrics && stats.sourceMetrics[ui.period] || {};
			const claudePeriod = P();
			const metriche = source => {
				if (source === 'claude') return `<div class="attivita-metriche"><span>Token ${tk(sum4(claudePeriod.tok))}</span><span>Ore stimate ${hm(claudePeriod.claude)}</span><span>Valore API a listino ${usd(claudePeriod.cost)}</span><em>Registri Claude Code; ore inferite con pause di ${stats.gapMinutes} minuti. Il listino non è la spesa dell'abbonamento.</em></div>`;
				if (source === 'terminale') return '<div class="attivita-metriche"><span>Token N/D · Durata N/D · Costo N/D</span><em>Solo eventi della shell osservati mentre la Bottega è aperta; nessuno storico dei consumi.</em></div>';
				const m = sourceMetrics[source];
				const tokens = m && m.tokens != null ? tk(m.tokens) : 'N/D';
				const durata = source === 'codex' && m && m.durationMinutes != null ? hm(m.durationMinutes) : 'N/D';
				const costo = source === 'cline' && m && m.cost != null ? `${it(m.cost, m.cost > 0 && m.cost < 0.01 ? 4 : 2)} $` : 'N/D';
				const files = m ? `${it(m.records)} sessioni nel periodo, ${it(m.files)} file locali esaminati${m.skipped ? `, ${it(m.skipped)} omessi` : ''}` : 'Registri locali non disponibili';
				const origine = source === 'codex'
					? 'Rollout Codex: input e output; la durata è il tempo trascorso fra inizio e fine dei turni conclusi, include eventuali attese. Nessun costo affidabile.'
					: 'Messaggi Cline SDK con metriche: input, output e cache; somma dei costi riportati da Cline. La durata della sessione include le attese e non è contata.';
				return `<div class="attivita-metriche"><span>Token ${tokens}</span><span>${source === 'codex' ? 'Turni conclusi' : 'Durata'} ${durata}</span><span>${source === 'cline' ? 'Costo Cline' : 'Costo'} ${costo}</span><em>${origine} ${files}.</em></div>`;
			};
			put($('attivita-fonti'), sources.map(([source, name]) => {
				const s = latest[source] || {};
				const active = (s.inCorso || 0) + (s.tiAspetta || 0);
				const status = [active && `${it(active)} ${active === 1 ? 'aperta' : 'aperte'}`, s.errore && `${it(s.errore)} ${s.errore === 1 ? 'errore' : 'errori'}`].filter(Boolean).join(' · ');
				return `<div class="attivita-fonte ${source}"><span class="attivita-nome">${name}</span><strong>${it(bySource[source])}</strong><span class="attivita-periodo">aggiornate nel periodo</span><small>${status || `${it(s.total || 0)} nel registro`}</small>${metriche(source)}</div>`;
			}).join(''));
			const max = Math.max(1, ...days.map(d => sources.reduce((n, [source]) => n + (Number(d[source]) || 0), 0)));
			const width = 900, height = 140, top = 8, bottom = 25, plot = height - top - bottom;
			const step = width / Math.max(days.length, 1);
			const bars = days.map((d, i) => {
				let y = height - bottom;
				const pieces = sources.map(([source]) => {
					const n = Number(d[source]) || 0;
					const h = (n / max) * plot;
					y -= h;
					return h ? `<rect class="attivita-barra ${source}" x="${(i * step + 1).toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(1, step - 2).toFixed(2)}" height="${h.toFixed(2)}"/>` : '';
				}).join('');
				const label = days.length <= 7 || i % Math.ceil(days.length / 7) === 0 || i === days.length - 1;
				return `${pieces}${label ? `<text x="${((i + 0.5) * step).toFixed(2)}" y="${height - 5}" text-anchor="middle">${esc(giornoB(d.date))}</text>` : ''}`;
			}).join('');
			put($('attivita-grafico'), `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(`Attività aggiornate per giorno: ${sources.map(([source, name]) => `${name} ${bySource[source]}`).join(', ')}`)}"><line x1="0" y1="${height - bottom}" x2="${width}" y2="${height - bottom}"/>${bars}</svg>`);
			put($('attivita-tabella'), tabella('attivita', 'Attività aggiornate per giorno e per fonte', ['Giorno', ...sources.map(([, name]) => name)], days.map(d => [giornoL(d.date), ...sources.map(([source]) => it(d[source] || 0))])));
		}

		/** La traccia di un periodo, giorno per giorno: un oscilloscopio sotto la cifra. Decorativa
		    (i numeri giorno per giorno stanno nelle tabelle delle ore e dei token). */
		function tracciaMini(vals, cls) {
			const n = vals.length;
			if (n < 2) return '';
			const W = 88, H = 22;
			const max = Math.max(...vals);
			const pts = vals.map((v, i) => [1.5 + (i / (n - 1)) * (W - 5), H - 3 - (max > 0 ? v / max : 0) * (H - 7)]);
			const d = pts.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join('');
			const l = pts[n - 1];
			return `<span class="traccia-riga" aria-hidden="true"><svg class="traccia-mini ${cls}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path class="base-mini" d="M1.5,${H - 2.5}H${W - 2}"/><path class="linea-mini" pathLength="1" d="${d}"/><circle cx="${l[0].toFixed(1)}" cy="${l[1].toFixed(1)}" r="2"/></svg></span>`;
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
		/** Un comando vocale arrivato prima dei dati. */
		let attesaFocus = null;

		function renderCarta() {
			const p = P();
			const box = $('carta-svg');
			const palco = $('carta-palco');
			// la misura viene dalla testa della carta, che occupa tutta la larghezza: il palco ha la sua
			const S = Math.round(Math.min(width($('carta-testa')), 640));
			palco.style.width = S + 'px';
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
			const f1 = n => n.toFixed(1);

			const prima = anim.migra ? new Map(stelle.map(s => [s.row.name, [s.x / (s.S || S), s.y / (s.S || S)]])) : null;
			const rows = p.projects.filter(x => x.you >= 1).slice(0, 48);
			const maxYou = Math.max(1, ...rows.map(x => x.you));
			stelle = rows.map((x, i) => {
				const o = oraTipica(x.hours);
				const r = rad((t - x.last) / DAY);
				const [sx, sy] = pos(o.h, r);
				return { i, row: x, o, r, x: sx, y: sy, S, size: 2.6 + 10 * Math.sqrt(x.you / maxYou) };
			});
			const byName = new Map(stelle.map(s => [s.row.name, s]));
			// l'onda dell'arrivo parte dal centro e accende le stelle al suo passaggio: prima le recenti
			const ritardo = s => 0.1 + (s.r / R) * 1.2;

			// la corona: in quali ore del giorno lavori, da tutte le tue ore del periodo (la mappa di calore)
			const ore = Array.from({ length: 24 }, (_, h) => p.heat.reduce((a, r) => a + r[h], 0));
			const maxOra = Math.max(1, ...ore);
			const oreN = ore.map(v => v / maxOra);

			let svg = `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg">
				<defs>
					<radialGradient id="crus-bagliore"><stop offset="0" stop-color="#fff6de" stop-opacity="0.95"/><stop offset="0.35" stop-color="#f6dfae" stop-opacity="0.45"/><stop offset="1" stop-color="#f4ab3c" stop-opacity="0"/></radialGradient>
					<radialGradient id="crus-cupola" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#1d2846"/><stop offset="0.7" stop-color="#141c33"/><stop offset="1" stop-color="#0f1628"/></radialGradient>
					<radialGradient id="crus-corona" gradientUnits="userSpaceOnUse" cx="${c}" cy="${c}" r="${f1(R + 6)}"><stop offset="${((R - 36) / (R + 6)).toFixed(3)}" stop-color="#f4ab3c" stop-opacity="0"/><stop offset="${(R / (R + 6)).toFixed(3)}" stop-color="#f4ab3c" stop-opacity="0.85"/><stop offset="1" stop-color="#f4ab3c" stop-opacity="0.3"/></radialGradient>
				</defs>
				<circle class="cupola" cx="${c}" cy="${c}" r="${R + 8}" fill="url(#crus-cupola)"/>`;
			// campo di stelle: decorazione fissa, minuscola e fioca, mai confondibile con i dati.
			// Le stesse stelle, con lo stesso seme, le disegna anche la GPU (che le fa scintillare).
			const rnd = semi(1990);
			const campo = [];
			let campoSvg = '';
			for (let i = 0; i < 140; i++) {
				const a = rnd() * 2 * Math.PI;
				const rr = Math.sqrt(rnd()) * (R + 6);
				const x = c + rr * Math.cos(a), y = c + rr * Math.sin(a);
				const r = 0.35 + rnd() * 0.55, op = 0.12 + rnd() * 0.3;
				campo.push([x, y, r, op, rnd() * 6.28, 0.6 + rnd() * 1.4]);
				campoSvg += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${r.toFixed(2)}" opacity="${op.toFixed(2)}"/>`;
			}
			svg += `<g class="campo">${campoSvg}</g>`;
			// corona delle ore, a spicchi (la GPU la sfuma)
			let corona = '';
			for (let h = 0; h < 24; h++) {
				if (oreN[h] < 0.02) continue;
				const Ro = R + 6, Ri = R - 36;
				const [ax, ay] = pos(h, Ro), [bx, by] = pos(h + 1, Ro), [cx2, cy2] = pos(h + 1, Ri), [dx, dy] = pos(h, Ri);
				corona += `<path d="M${f1(ax)},${f1(ay)}A${f1(Ro)},${f1(Ro)} 0 0 1 ${f1(bx)},${f1(by)}L${f1(cx2)},${f1(cy2)}A${f1(Ri)},${f1(Ri)} 0 0 0 ${f1(dx)},${f1(dy)}Z" opacity="${(0.55 * oreN[h]).toFixed(3)}"/>`;
			}
			svg += `<g class="corona" fill="url(#crus-corona)">${corona}</g>`;
			// anelli del tempo: al centro adesso, fuori l'inizio del periodo
			const anelli = [1, 7, 30, 90].filter(d => d <= days);
			svg += `<g class="anelli">${anelli
				.map(d => {
					const r = rad(d);
					return `<circle cx="${c}" cy="${c}" r="${f1(r)}"/><text x="${c + 4}" y="${f1(c - r - 3)}">${d === 1 ? 'ieri' : `${d} giorni fa`}</text>`;
				})
				.join('')}</g>`;
			// reticolo del telescopio: due assi con una tacca su ogni anello, interrotti al centro
			let ret = '';
			for (const [ux, uy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
				ret += `<line x1="${f1(c + ux * R0 * 2.2)}" y1="${f1(c + uy * R0 * 2.2)}" x2="${f1(c + ux * R)}" y2="${f1(c + uy * R)}"/>`;
				for (const d of anelli) {
					const r = rad(d);
					ret += `<line class="tacca" x1="${f1(c + ux * r - uy * 3)}" y1="${f1(c + uy * r - ux * 3)}" x2="${f1(c + ux * r + uy * 3)}" y2="${f1(c + uy * r + ux * 3)}"/>`;
				}
			}
			svg += `<g class="reticolo">${ret}</g>`;
			// quadrante delle 24 ore
			let quad = `<circle cx="${c}" cy="${c}" r="${R + 8}" class="bordo"/>`;
			for (let h = 0; h < 24; h++) {
				const [x1, y1] = pos(h, R + 8);
				const [x2, y2] = pos(h, R + (h % 6 ? 12 : 16));
				quad += `<line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}"/>`;
				if (h % 3 === 0) {
					const [lx, ly] = pos(h, R + 27);
					quad += `<text x="${f1(lx)}" y="${f1(ly + 4)}" class="${h % 6 ? '' : 'forte'}">${h}</text>`;
				}
			}
			svg += `<g class="quadrante">${quad}</g>`;
			// la lancetta di adesso, con l'ultima ora alle spalle (la GPU la disegna con la sua luce)
			svg += `<g class="lancetta"><path class="lancetta-scia"/><line class="lancetta-asta"/></g>`;
			svg += `<text class="centro" x="${c}" y="${c + 4}">adesso</text>`;
			// costellazioni: progetti lavorati in parallelo
			let linee = '';
			const legami = [];
			for (const e of p.edges) {
				const a = byName.get(e.a), b = byName.get(e.b);
				if (!a || !b) continue;
				legami.push({ a: a.i, b: b.i, minuti: e.minutes });
				linee += `<line x1="${f1(a.x)}" y1="${f1(a.y)}" x2="${f1(b.x)}" y2="${f1(b.y)}" pathLength="1" class="${e.minutes >= 60 ? 'forte' : ''}"/>`;
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
				scie += `<path d="M${f1(ax)},${f1(ay)}A${f1(s.r)},${f1(s.r)} 0 ${large} 1 ${f1(bx)},${f1(by)}" stroke-width="${Math.max(1.5, Math.min(4, s.size * 0.45)).toFixed(1)}" data-i="${s.i}"/>`;
			}
			svg += `<g class="scie">${scie}</g>`;
			// stelle
			let st = '';
			for (const s of stelle) {
				const live = s.row.live > 0;
				// le sessioni fuori dai progetti non sono un progetto: stella vuota, senza alone
				st += `<g class="stella${live ? ' vivo' : ''}${s.row.path ? '' : ' altrove'}" data-i="${s.i}">
					<circle class="alone" cx="${f1(s.x)}" cy="${f1(s.y)}" r="${f1(s.size * 2.6)}" fill="url(#crus-bagliore)"/>
					${live ? `<circle class="anello" cx="${f1(s.x)}" cy="${f1(s.y)}" r="${f1(s.size + 6)}"/>` : ''}
					<circle class="nucleo" cx="${f1(s.x)}" cy="${f1(s.y)}" r="${f1(s.size * 0.55)}"/>
					<circle class="presa" cx="${f1(s.x)}" cy="${f1(s.y)}" r="${f1(Math.max(12, s.size + 6))}" data-i="${s.i}"/>
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
				nomi += `<text x="${f1(x)}" y="${f1(y)}" text-anchor="${right ? 'start' : 'end'}" data-i="${s.i}">${esc(name)}</text>`;
			}
			svg += `<g class="nomi">${nomi}</g>`;
			// il mirino: aggancia la stella sotto il puntatore
			svg += `<g class="mira" hidden><g class="mira-dentro"><path/></g></g></svg>`;
			put(box, svg);
			metteLancetta();

			const muovi = mosso() && visible;
			if (muovi && (anim.rivela || anim.migra) && stelle.length) {
				// accensione al passaggio della scansione; nella migrazione si accendono solo le nuove
				box.querySelectorAll('.stella').forEach(g => {
					const s = stelle[+(/** @type {any} */ (g).getAttribute('data-i'))];
					/** @type {any} */ (g).style.animationDelay = `${Math.round((anim.migra ? 300 : ritardo(s) * 1000))}ms`;
				});
				box.querySelectorAll('.nomi text').forEach(tx => {
					const s = stelle[+(/** @type {any} */ (tx).getAttribute('data-i'))];
					/** @type {any} */ (tx).style.animationDelay = `${Math.round((anim.migra ? 600 : ritardo(s) * 1000 + 250))}ms`;
				});
				if (anim.rivela) lampo(crus, 'rivela', 2800);
				else lampo(crus, 'ritraccia', 1800);
				if (anim.migra && prima) {
					// le stelle che c'erano scivolano dalla posizione di prima a quella nuova
					box.querySelectorAll('.stella, .nomi text').forEach(el => {
						const s = stelle[+(/** @type {any} */ (el).getAttribute('data-i'))];
						const da = s && prima.get(s.row.name);
						if (!da) return;
						const dx = da[0] * S - s.x, dy = da[1] * S - s.y;
						if (Math.abs(dx) + Math.abs(dy) < 0.5) return;
						const e = /** @type {any} */ (el);
						e.classList.add('vecchia');
						e.style.transform = `translate(${f1(dx)}px, ${f1(dy)}px)`;
					});
					void box.getBoundingClientRect();
					requestAnimationFrame(() =>
						box.querySelectorAll('.vecchia').forEach(el => {
							el.classList.add('migra');
							/** @type {any} */ (el).style.transform = '';
						}),
					);
				}
			}

			cielo.scena({
				S,
				c,
				R,
				R0,
				campo,
				ore: oreN,
				stelle: stelle.map(s => {
					const da = prima && prima.get(s.row.name);
					return {
						i: s.i,
						x: s.x,
						y: s.y,
						size: s.size,
						vivo: s.row.live > 0,
						altrove: !s.row.path,
						da: muovi && anim.migra && da ? [da[0] * S, da[1] * S] : null,
						ritardo: !muovi ? -1 : anim.rivela ? ritardo(s) : anim.migra ? (da ? -1 : 0.3) : -1,
					};
				}),
				legami,
				ritardoLegami: !muovi ? -1 : anim.rivela ? 1.4 : anim.migra ? 0.9 : -1,
				rivela: muovi && anim.rivela,
				migra: muovi && anim.migra,
			});

			const vive = stelle.filter(s => s.row.live > 0).length;
			$('carta-conto').textContent = `${it(stelle.length)} ${stelle.length === 1 ? 'stella' : 'stelle'}, ${it(legami.length)} ${legami.length === 1 ? 'legame' : 'legami'}${vive ? `, ${parola(vive)} ${vive === 1 ? 'viva' : 'vive'}` : ''}`;

			put(
				$('carta-legenda'),
				`<p>Ogni stella è un progetto, grande quanto le ore che ci hai lavorato negli ultimi ${days} giorni. Il giro è l'orologio delle 24 ore, con mezzogiorno in alto: la stella sta all'ora in cui lavori di solito a quel progetto, la scia copre le ore in cui ci lavori, e la luce ambra lungo il bordo dice in quali ore del giorno lavori di più. La lancetta azzurra segna l'ora di adesso. Più una stella è vicina al centro, più di recente ci hai lavorato. Le linee azzurre uniscono i progetti che hai portato avanti negli stessi momenti; l'anello acceso segna una sessione aperta adesso. La stella vuota raccoglie le sessioni partite fuori dai progetti.</p>`,
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

		/** La lancetta dell'SVG all'ora di adesso: si sposta di un quarto di grado al minuto. */
		function metteLancetta() {
			const svg = $('carta-svg').querySelector('svg');
			if (!svg || !stelle) return;
			const S = +svg.getAttribute('width');
			const c = S / 2, R = c - 40, R0 = R * 0.1;
			const h = oraAdesso();
			const pos = (hh, r) => {
				const a = ((hh - 12) / 24) * 2 * Math.PI;
				return [(c + r * Math.sin(a)).toFixed(1), (c - r * Math.cos(a)).toFixed(1)];
			};
			const [ax, ay] = pos(h, R0), [bx, by] = pos(h, R + 8);
			const asta = svg.querySelector('.lancetta-asta');
			if (asta) {
				asta.setAttribute('x1', ax);
				asta.setAttribute('y1', ay);
				asta.setAttribute('x2', bx);
				asta.setAttribute('y2', by);
			}
			const [sx, sy] = pos(h - 1, R), [ex, ey] = pos(h, R), [fx, fy] = pos(h, R * 0.6), [gx, gy] = pos(h - 1, R * 0.6);
			const scia = svg.querySelector('.lancetta-scia');
			if (scia) scia.setAttribute('d', `M${sx},${sy}A${R.toFixed(1)},${R.toFixed(1)} 0 0 1 ${ex},${ey}L${fx},${fy}A${(R * 0.6).toFixed(1)},${(R * 0.6).toFixed(1)} 0 0 0 ${gx},${gy}Z`);
		}

		function accendi(i, on) {
			const svg = $('carta-svg');
			svg.querySelectorAll('.acceso').forEach(el => el.classList.remove('acceso'));
			svg.classList.toggle('cerca', !!on);
			const mira = svg.querySelector('.mira');
			cielo.accendi(on ? i : -1);
			if (!on) {
				if (mira) mira.setAttribute('hidden', '');
				return;
			}
			svg.querySelectorAll(`[data-i="${i}"]`).forEach(el => {
				const g = el.closest('.stella') || el;
				g.classList.add('acceso');
			});
			const s = stelle[i];
			if (!mira || !s) return;
			// quattro angoli attorno alla stella, come il mirino di un cercatore
			const m = Math.max(9, s.size * 1.25 + 5);
			const l = Math.max(4, m * 0.45);
			const ang = (sx, sy) => `M${sx * m},${sy * (m - l)}V${sy * m}H${sx * (m - l)}`;
			mira.querySelector('path').setAttribute('d', ang(-1, -1) + ang(1, -1) + ang(1, 1) + ang(-1, 1));
			const nuova = mira.getAttribute('data-m') !== String(i);
			mira.setAttribute('transform', `translate(${s.x.toFixed(1)} ${s.y.toFixed(1)})`);
			mira.setAttribute('data-m', String(i));
			mira.removeAttribute('hidden');
			if (nuova && mosso()) lampo(mira, 'aggancia', 260);
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

		/** Quante righe della classifica si vedono: dieci, o quante ne servono per arrivare in fondo al cielo. */
		let righe = 10;

		/** Accanto al cielo la classifica si allunga fino alla sua altezza, invece di lasciare un vuoto. */
		function riempiClassifica() {
			if (ui.all) return;
			const carta = $('carta');
			const col = $('classifica-col');
			const riga = $('classifica').querySelector('li');
			const hc = carta.offsetHeight, hl = col.offsetHeight, hr = riga ? riga.offsetHeight : 0;
			if (!hc || !hl || !hr) return;
			const n = P().projects.length;
			// una colonna sola (finestra stretta): la classifica sta sotto il cielo, dieci righe bastano
			const vuole = Math.abs(carta.offsetTop - col.offsetTop) > 4 ? 10 : Math.max(10, Math.min(n, righe + Math.floor((hc - hl) / hr)));
			if (vuole === righe) return;
			righe = vuole;
			renderClassifica();
		}

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
			const shown = ui.all ? rows : rows.slice(0, righe);
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
				rows.length > righe
					? `<button type="button" class="link" data-c="tutti" data-fk="c:tutti" aria-expanded="${ui.all}">${ui.all ? `Mostra i primi ${parola(righe)}` : `Mostra tutti i ${it(rows.length)} progetti`}</button>`
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

		/** I grafici si disegnano da sinistra: linee tracciate, colonne che salgono, caselle che si
		    accendono ora per ora. Ritardi scaglionati, al massimo mezzo secondo in tutto. */
		function traccia(el) {
			if (!mosso() || !visible) return;
			const pile = el.querySelectorAll('.pila');
			pile.forEach((g, i) => (/** @type {any} */ (g).style.animationDelay = `${Math.round(Math.min(500, (i * 500) / Math.max(1, pile.length)))}ms`));
			el.querySelectorAll('rect[data-h]').forEach(r => (/** @type {any} */ (r).style.animationDelay = `${+(/** @type {any} */ (r).getAttribute('data-h')) * 22}ms`));
			lampo(el, 'traccia', 1400);
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
					svg += `<path class="linea-claude" pathLength="1" d="${line(cpts)}"/><path class="linea-tu" pathLength="1" d="${line(pts)}"/>`;
				}
				const last = n - 1;
				svg += `<circle class="punto-claude" cx="${cpts[last][0].toFixed(1)}" cy="${cpts[last][1].toFixed(1)}" r="4"/><circle class="punto-tu" cx="${pts[last][0].toFixed(1)}" cy="${pts[last][1].toFixed(1)}" r="4"/>`;
				svg += `<g class="mirino" hidden><line x1="0" x2="0" y1="${T}" y2="${T + ph}"/><circle class="punto-claude" r="4"/><circle class="punto-tu" r="4"/></g>`;
			} else {
				const pair = Math.min(44, slot * 0.78);
				const bw = (pair - 2) / 2;
				list.forEach((b, i) => {
					const x0 = cx(i) - pair / 2;
					svg += `<g class="pila"><path class="col-tu" d="${colonna(x0, y(b.you), bw, y(0) - y(b.you), true)}"/>`;
					svg += `<path class="col-claude" d="${colonna(x0 + bw + 2, y(b.claude), bw, y(0) - y(b.claude), true)}"/></g>`;
				});
				svg += `<rect class="evidenza" hidden y="${T}" height="${ph}" rx="4"/>`;
			}
			svg += '</svg>';
			put(el, svg);
			curva = { el, list, L, slot, T, ph, y, g, idx: curva && curva.list.length === n ? curva.idx : -1 };
			if (anim.grafici) traccia(el);

			const p = P();
			put(
				$('curva-legenda'),
				`<li><i class="chiave k-tu" aria-hidden="true"></i>Tu, le sessioni insieme contano una volta</li><li><i class="chiave k-claude" aria-hidden="true"></i>Claude, somma delle sessioni</li>`,
			);
			const best = list.reduce((a, b) => (b.you > (a ? a.you : -1) ? b : a), null);
			let quale = '';
			if (best && g === 'giorno') quale = `il giorno più pieno è ${giornoL(best.date)}`;
			else if (best && g === 'settimana') {
				const a = parseDay(best.start), z = parseDay(best.end);
				quale = `la settimana più piena è quella dal ${a.getDate()}${a.getMonth() === z.getMonth() ? '' : ' ' + MESI[a.getMonth()]} al ${giornoM(best.end)}`;
			} else if (best) quale = `il mese più pieno è ${meseL(best.key)}`;
			const nota = best && best.you >= 1 ? `Negli ultimi ${p.days} giorni ${quale}, con ${hm(best.you)} tue e ${hm(best.claude)} di Claude.` : `Nessuna ora di lavoro negli ultimi ${p.days} giorni.`;
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

		// ---------- che lavoro e' stato ----------

		/* Minuti delle sessioni per tipo di lavoro (stats.categorie, facoltativo: le categorie le decide
		   Apple Intelligence sessione per sessione, src/osservatorio.ts). Una sola serie, quindi un solo
		   colore e nessuna legenda: barre ordinate, ogni riga col suo valore. Senza il campo la sezione
		   non c'e'. */
		const CATEGORIE = {
			correzione: ['Correzioni', 'correzioni'],
			funzione: ['Funzioni nuove', 'funzioni nuove'],
			rilascio: ['Rilasci', 'rilasci'],
			ricerca: ['Ricerca', 'ricerca'],
			manutenzione: ['Manutenzione', 'manutenzione'],
			documentazione: ['Documentazione', 'documentazione'],
			altro: ['Non ancora classificate', 'sessioni non classificate'],
		};

		function renderCategorie() {
			const sez = $('categorie-sez');
			const tutte = stats && stats.categorie && typeof stats.categorie === 'object' ? stats.categorie : null;
			const per = tutte && tutte[ui.period] && typeof tutte[ui.period] === 'object' ? tutte[ui.period] : null;
			const righe = per
				? Object.entries(per)
						.map(([k, v]) => ({ k, nome: (CATEGORIE[k] || [k])[0], min: Number(v) || 0 }))
						.filter(r => r.min >= 1)
				: [];
			if (!righe.length) {
				sez.hidden = true;
				put($('categorie'), '');
				$('categorie-frase').textContent = '';
				return;
			}
			// le categorie vere per minuti, le non classificate sempre in fondo
			righe.sort((a, b) => Number(a.k === 'altro') - Number(b.k === 'altro') || b.min - a.min);
			const tot = righe.reduce((a, r) => a + r.min, 0);
			const max = Math.max(...righe.map(r => r.min));
			sez.hidden = false;
			// la frase: quella dell'estensione (dice la settimana), oppure la si fa qui per il periodo
			const f = stats.categorieFrase;
			let frase = typeof f === 'string' && ui.period === '7' ? f : f && typeof f === 'object' && typeof f[ui.period] === 'string' ? f[ui.period] : '';
			if (!frase) {
				const note = righe.filter(r => r.k !== 'altro');
				const totNote = note.reduce((a, r) => a + r.min, 0);
				if (note.length && totNote >= 30) {
					const k = note[0].k;
					frase = `${ui.period === '7' ? 'Questa settimana' : `Negli ultimi ${ui.period} giorni`} ${it(Math.round((note[0].min / totNote) * 100))}% ${(CATEGORIE[k] || [k, k])[1]}.`;
				}
			}
			$('categorie-frase').textContent = frase;
			put(
				$('categorie'),
				righe
					.map(
						r => `<li class="riga-categoria${r.k === 'altro' ? ' altro' : ''}">
							<span class="chi">${esc(r.nome)}</span>
							<span class="misura" aria-hidden="true"><i class="b-tu" data-w="${Math.max(0.5, (r.min / max) * 100).toFixed(1)}"></i></span>
							<span class="valore">${hm(r.min)}</span>
							<span class="quota">${pctTxt(pct(r.min, tot))}</span>
						</li>`,
					)
					.join(''),
			);
			$('categorie').querySelectorAll('[data-w]').forEach(el => (el.style.width = el.getAttribute('data-w') + '%'));
		}

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
				svg += '<g class="pila">';
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
				svg += '</g>';
			});
			svg += `<rect class="evidenza" hidden y="${T}" height="${ph}" rx="4"/></svg>`;
			put(el, svg);
			token = { el, list, L, slot, y, idx: -1 };
			if (anim.grafici) traccia(el);

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
			for (const [id, l, k] of TIPI) {
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
			// dove sei adesso nella settimana: un riquadro azzurro
			const oggi = new Date();
			const dA = (oggi.getDay() + 6) % 7, hA = oggi.getHours();
			svg += `<rect class="adesso-cella" x="${Lw + cell * hA - 1}" y="${Tt + cell * dA - 1}" width="${cell}" height="${cell}" rx="4"/>`;
			svg += `<rect class="cursore" hidden width="${cell}" height="${cell}" rx="4"/></svg>`;
			put(el, svg);
			calore = { el, p, Lw, Tt, cell, at: calore ? calore.at : [0, 9] };
			if (anim.grafici) traccia(el);

			put($('calore-scala'), `<span>meno</span>${[0, 1, 2, 3, 4, 5].map(i => `<i class="h${i}" aria-hidden="true"></i>`).join('')}<span>più</span><i class="adesso-chiave" aria-hidden="true"></i><span>adesso</span>`);
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

		// ---------- oggi, sessione per sessione ----------

		/** "9:05" da minuti dalla mezzanotte. */
		const hhmm = m => {
			const t = Math.round(m);
			return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
		};

		/** Minuti dalla mezzanotte del giorno dei dati a adesso: l'orologio vero, cosi' la linea cammina da sola. */
		function adessoMin() {
			const t0 = parseDay(stats.today.date).getTime();
			return Math.min(1440, Math.max((stats.computedAt - t0) / 60_000, Math.floor((Date.now() - t0) / 60_000)));
		}

		/** Unione di intervalli piatti [s, e, s, e, ...]. */
		function unisci(flat) {
			const pairs = [];
			for (let i = 0; i + 1 < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
			pairs.sort((a, b) => a[0] - b[0]);
			const out = [];
			for (const [a, b] of pairs) {
				const n = out.length;
				if (n && a <= out[n - 1]) out[n - 1] = Math.max(out[n - 1], b);
				else out.push(a, b);
			}
			return out;
		}

		/** Minuti in cui giravano almeno `k` sessioni insieme. */
		function minutiInsieme(liste, k) {
			const ev = [];
			for (const sp of liste) for (let i = 0; i + 1 < sp.length; i += 2) if (sp[i + 1] > sp[i]) ev.push([sp[i], 1], [sp[i + 1], -1]);
			ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
			let c = 0, last = 0, m = 0;
			for (const [t, d] of ev) {
				if (c >= k) m += t - last;
				c += d;
				last = t;
			}
			return m;
		}

		let oggi = null;
		const PASSO_OGGI = 12; // una riga di barre nella linea del tempo

		function renderOggi() {
			const el = $('oggi');
			const ss = stats.todaySessions || [];
			if (!ss.length) {
				put(el, '');
				oggi = null;
				put($('oggi-legenda'), '');
				$('oggi-nota').textContent = 'Oggi nessuna sessione di Claude Code, per ora. La linea del tempo si riempie da sola appena ne apri una.';
				el.setAttribute('aria-label', 'Oggi nessuna sessione.');
				put($('oggi-tabella'), '');
				return;
			}
			const adesso = adessoMin();
			const W = width(el);
			// le sessioni, con la fine vera; una sessione aperta arriva fino ad adesso (tratteggio)
			const sess = ss.map((s, i) => {
				const fine = s.spans[s.spans.length - 1];
				let lavoro = 0;
				for (let j = 0; j + 1 < s.spans.length; j += 2) lavoro += s.spans[j + 1] - s.spans[j];
				return { ...s, i, inizio: s.spans[0], fine, fino: s.live ? Math.max(fine, adesso) : fine, lavoro, riga: 0, corsia: /** @type {any} */ (null) };
			});
			// corsie: una per progetto, nell'ordine in cui sono partite; dentro, una riga per ogni sessione che si sovrappone
			const MAXC = 7;
			const corsie = [];
			const perChiave = new Map();
			for (const s of sess) {
				let k = s.path || 'altrove';
				if (!perChiave.has(k) && perChiave.size >= MAXC) k = 'altri';
				let c = perChiave.get(k);
				if (!c) {
					c = { nome: k === 'altri' ? 'Altri progetti' : s.project, righe: [], sess: [], y: 0, h: 0 };
					perChiave.set(k, c);
					corsie.push(c);
				}
				let r = c.righe.findIndex(fine => fine <= s.inizio);
				if (r < 0) {
					r = c.righe.length;
					c.righe.push(0);
				}
				c.righe[r] = s.fino + 0.5;
				s.riga = r;
				s.corsia = c;
				c.sess.push(s);
			}
			const primo = Math.min(...sess.map(s => s.inizio));
			const ultimo = Math.max(adesso, ...sess.map(s => s.fino));
			let a = Math.floor(primo / 60) * 60;
			const b = Math.min(1440, Math.max(a + 180, Math.ceil((ultimo + 1) / 60) * 60));
			if (b - a < 180) a = Math.max(0, b - 180);
			const Lw = Math.round(Math.min(150, Math.max(84, W * 0.22)));
			const x0 = Lw + 10, x1 = W - 10;
			const X = m => x0 + ((Math.max(a, Math.min(b, m)) - a) / (b - a)) * (x1 - x0);
			const f1 = v => v.toFixed(1);
			const T = 22;
			const yTu = T + 6;
			let y = yTu + 20;
			for (const c of corsie) {
				c.y = y;
				c.h = c.righe.length * PASSO_OGGI + 10;
				y += c.h;
			}
			const H = y + 4;
			const yDi = s => s.corsia.y + 5 + s.riga * PASSO_OGGI;
			const barra = (xa, xb, yy, cls, i) => {
				const w = Math.max(2, xb - xa);
				return `<rect class="${cls}"${i === '' ? '' : ` data-s="${i}"`} x="${f1(xa)}" y="${yy}" width="${f1(w)}" height="8" rx="${f1(Math.min(3, w / 2))}"/>`;
			};

			let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
			const pxOra = (x1 - x0) / ((b - a) / 60);
			const ogni = [1, 2, 3, 4, 6].find(k => k * pxOra >= 38) || 6;
			for (let m = a; m <= b; m += 60) {
				const x = f1(X(m));
				svg += `<line class="griglia" x1="${x}" x2="${x}" y1="${T - 4}" y2="${H - 2}"/>`;
				if ((m / 60) % ogni === 0) svg += `<text class="asse-x" x="${x}" y="${T - 9}">${m / 60}</text>`;
			}
			// tu: l'unione di tutte le sessioni, come le tue ore
			const tu = unisci(sess.flatMap(s => s.spans));
			svg += `<text class="corsia-nome tu" x="${Lw}" y="${yTu + 8}">Tu</text>`;
			for (let j = 0; j + 1 < tu.length; j += 2) svg += barra(X(tu[j]), X(tu[j + 1]), yTu, 'barra-tu', '');
			const car = Math.max(6, Math.floor(Lw / 6.6));
			for (const c of corsie) {
				svg += `<line class="divisore" x1="${x0 - 6}" x2="${x1}" y1="${c.y}" y2="${c.y}"/>`;
				const nome = c.nome.length > car ? c.nome.slice(0, car - 1) + '…' : c.nome;
				svg += `<text class="corsia-nome" x="${Lw}" y="${f1(c.y + c.h / 2 + 4)}">${esc(nome)}</text>`;
				for (const s of c.sess) {
					const yy = yDi(s);
					const mid = yy + 4;
					for (let j = 0; j + 1 < s.spans.length; j += 2) {
						if (j) svg += `<line class="pausa" data-s="${s.i}" x1="${f1(X(s.spans[j - 1]))}" x2="${f1(X(s.spans[j]))}" y1="${mid}" y2="${mid}"/>`;
						svg += barra(X(s.spans[j]), X(s.spans[j + 1]), yy, 'barra-s', s.i);
					}
					if (s.live && s.fino > s.fine) svg += `<line class="ancora" data-s="${s.i}" x1="${f1(X(s.fine))}" x2="${f1(X(s.fino))}" y1="${mid}" y2="${mid}"/>`;
					if (s.live) svg += `<circle class="vivo-punto" data-s="${s.i}" cx="${f1(X(s.fino))}" cy="${mid}" r="3"/>`;
				}
			}
			if (adesso >= a && adesso <= b) svg += `<line class="adesso-linea" x1="${f1(X(adesso))}" x2="${f1(X(adesso))}" y1="${T - 4}" y2="${H - 2}"/>`;
			// prese: tutta la sessione, piu' alte della barra, sopra a tutto
			for (const s of sess) svg += `<rect class="presa-s" data-s="${s.i}" x="${f1(X(s.inizio) - 3)}" y="${yDi(s) - 2}" width="${f1(Math.max(8, X(s.fino) - X(s.inizio) + 6))}" height="12"/>`;
			svg += '</svg>';
			put(el, svg);
			oggi = { el, sess, X, yDi, H, idx: oggi && oggi.sess.length === sess.length ? oggi.idx : -1 };
			if (oggi.idx >= 0 && el.contains(el.ownerDocument.activeElement)) oggiAt(oggi.idx, false);

			put(
				$('oggi-legenda'),
				`<li><i class="chiave q b-tu" aria-hidden="true"></i>Tu</li><li><i class="chiave q b-claude" aria-hidden="true"></i>Una sessione</li><li><i class="chiave tratteggio" aria-hidden="true"></i>Aperta, al lavoro</li><li><i class="chiave k-adesso" aria-hidden="true"></i>Adesso</li>`,
			);
			const n = sess.length;
			const nP = new Set(sess.map(s => s.path || 'altrove')).size;
			const lunga = sess.reduce((x, s) => (s.lavoro > x.lavoro ? s : x));
			const insieme = minutiInsieme(sess.map(s => s.spans), 2);
			let nota = `Oggi ${parola(n)} ${n === 1 ? 'sessione' : 'sessioni'} su ${nP === 1 ? 'un progetto' : `${parola(nP)} progetti`}, dalle ${hhmm(primo)}.`;
			if (insieme >= 1) nota += ` Per ${oreParole(insieme)} ne hai fatte girare almeno due insieme.`;
			else if (n > 1) nota += ' Mai due insieme.';
			if (lunga.lavoro >= 1 && n > 1) nota += ` La più lunga è ${lunga.title ? `«${lunga.title}»` : lunga.project}, con ${oreParole(lunga.lavoro)} di lavoro.`;
			$('oggi-nota').textContent = nota;
			el.setAttribute('aria-label', `Linea del tempo di oggi, una corsia per progetto. ${nota} Usa le frecce per passare da una sessione all'altra.`);
			put(
				$('oggi-tabella'),
				tabella(
					'oggi',
					'Le sessioni di oggi',
					['Sessione', 'Progetto', 'Dove', 'Dalle', 'Alle', 'Lavoro', 'Token'],
					sess.map(s => [s.title || 'senza titolo', s.project, s.where || 'nella sua cartella', hhmm(s.inizio), s.live ? 'aperta' : hhmm(s.fine), hm(s.lavoro), tk(s.tok)]),
					[1, 2],
				),
			);
		}

		function oggiAt(i, fromKey) {
			const c = oggi;
			if (!c || !c.sess.length) return;
			i = Math.max(0, Math.min(c.sess.length - 1, i));
			c.idx = i;
			const s = c.sess[i];
			const svg = c.el.querySelector('svg');
			if (!svg) return;
			svg.classList.add('cerca');
			svg.querySelectorAll('.acceso').forEach(e => e.classList.remove('acceso'));
			svg.querySelectorAll(`[data-s="${i}"]`).forEach(e => e.classList.add('acceso'));
			const quando = s.live ? `dalle ${hhmm(s.inizio)}, ancora aperta` : `dalle ${hhmm(s.inizio)} alle ${hhmm(s.fine)}`;
			showTip(c.el, c.X(s.fino), c.yDi(s) + 4, s.title || s.project, [
				{ value: s.where ? `${s.project}, ${s.where}` : s.project, label: '' },
				{ key: 'q b-claude', value: quando, label: '' },
				{ value: hm(s.lavoro), label: 'di lavoro' },
				{ value: tk(s.tok), label: 'token oggi' },
			]);
			if (fromKey) say(`${s.title || 'Sessione senza titolo'}, ${s.project}${s.where ? ', ' + s.where : ''}: ${quando}, ${hm(s.lavoro)} di lavoro.`);
		}

		function oggiOff() {
			if (oggi) {
				const svg = oggi.el.querySelector('svg');
				if (svg) {
					svg.classList.remove('cerca');
					svg.querySelectorAll('.acceso').forEach(e => e.classList.remove('acceso'));
				}
			}
			hideTip();
		}

		// ---------- adesso ----------

		function renderAdesso() {
			const t = now();
			const STATO = { busy: 'al lavoro', idle: 'ti aspetta', shell: 'nel terminale' };
			put(
				$('adesso'),
				stats.live.length
					? stats.live
							.map(l => {
								// il titolo davanti: tre sessioni sullo stesso progetto si distinguono da li', dalla copia di lavoro e dall'ora
								const titolo = l.title || l.project;
								const dove = [l.title ? l.project : '', l.where || ''].filter(Boolean).join(', ');
								const tip = `PID ${l.pid}${l.cwd ? `, cartella ${l.cwd}` : ''}`;
								const copia = /^copia /.test(l.where || '');
								return `<li class="${l.status === 'busy' ? 'busy' : ''}" title="${esc(tip)}"><i class="dot" aria-hidden="true"></i><span><b>${esc(titolo)}</b>${
									dove ? `<small class="dove${copia ? ' copia' : ''}">${esc(dove)}</small>` : ''
								}<small>${esc(STATO[l.status] || l.status)} da ${esc(fa(l.since, t).replace(' fa', '').replace('adesso', 'poco'))}${l.started ? `, aperta alle ${ora(l.started)}` : ''}</small><small>Oggi ${hm(l.today)} di lavoro, ${tk(l.tokToday)} token</small></span></li>`;
							})
							.join('')
					: '<li class="nota">Nessuna sessione Claude aperta in questo momento.</li>',
			);
		}

		// ---------- lavoro in parallelo: la corrente ----------

		let parallelo = null;

		function renderParallelo() {
			const c = stats.concurrency7;
			const el = $('parallelo');
			if (!c || !c.avg || c.avg.length !== ORE7) {
				put(el, '');
				parallelo = null;
				$('parallelo-nota').textContent = 'I numeri del lavoro in parallelo arrivano con il prossimo aggiornamento.';
				put($('parallelo-legenda'), '');
				put($('parallelo-tabella'), '');
				$('corrente-conto').textContent = '';
				return;
			}
			const W = width(el);
			const H = 176, x0 = 26, x1 = W - 46, T = 10, B = 26;
			const ph = H - T - B;
			const mid = T + ph / 2;
			const slot = (x1 - x0) / ORE7;
			const maxS = Math.max(2, Math.ceil(Math.max(...c.peak, ...c.avg)));
			const unit = (ph / 2 - 3) / maxS;
			const c0 = new Date(c.start);
			const oraDi = i => new Date(c0.getFullYear(), c0.getMonth(), c0.getDate(), c0.getHours() + i);
			const cx = i => x0 + slot * (i + 0.5);
			const f1 = v => v.toFixed(1);
			let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="crus-fiume" gradientUnits="userSpaceOnUse" x1="${x0}" x2="${f1(x1)}" y1="0" y2="0">${c.busy
				.map((m, i) => `<stop offset="${((i + 0.5) / ORE7).toFixed(4)}" stop-color="#63e6dc" stop-opacity="${(0.22 + 0.6 * Math.min(1, m / 60)).toFixed(2)}"/>`)
				.join('')}</linearGradient></defs>`;
			const step = maxS <= 5 ? 1 : 2;
			for (let k = step; k <= maxS; k += step) {
				for (const sg of [-1, 1]) svg += `<line class="griglia-n" x1="${x0}" x2="${f1(x1)}" y1="${f1(mid + sg * k * unit)}" y2="${f1(mid + sg * k * unit)}"/>`;
				svg += `<text class="asse-y" x="${x0 - 6}" y="${f1(mid - k * unit + 4)}">${k}</text>`;
			}
			svg += `<line class="mezzeria" x1="${x0}" x2="${f1(x1)}" y1="${f1(mid)}" y2="${f1(mid)}"/>`;
			// i giorni: un filo a mezzanotte, il nome al centro del giorno
			const etichetta = (da, a) => {
				if ((a - da) * slot < 34) return '';
				const d = oraDi(da);
				return `<text class="asse-x" x="${f1(x0 + (slot * (da + a)) / 2)}" y="${H - 8}">${GIORNI_B[(d.getDay() + 6) % 7]} ${d.getDate()}</text>`;
			};
			let da = 0;
			for (let i = 1; i < ORE7; i++) {
				if (oraDi(i).getHours() !== 0) continue;
				svg += `<line class="giorno" x1="${f1(x0 + slot * i)}" x2="${f1(x0 + slot * i)}" y1="${T}" y2="${T + ph}"/>`;
				svg += etichetta(da, i);
				da = i;
			}
			svg += etichetta(da, ORE7);
			// la fascia: spessa quante sessioni giravano insieme, piena quanto l'ora era coperta
			const sopra = c.avg.map((v, i) => `${f1(cx(i))},${f1(mid - v * unit)}`);
			const sotto = c.avg.map((v, i) => `${f1(cx(i))},${f1(mid + v * unit)}`).reverse();
			svg += `<path class="fascia" fill="url(#crus-fiume)" d="M${x0},${f1(mid)}L${sopra.join('L')}L${f1(x1)},${f1(mid)}L${sotto.join('L')}Z"/>`;
			// il massimo nello stesso istante: una linea a gradini sopra la fascia
			let mx = '';
			for (let i = 0; i < ORE7; i++) {
				const p = c.peak[i];
				if (p <= 0) continue;
				const yy = f1(mid - p * unit);
				mx += i && c.peak[i - 1] > 0 ? `V${yy}H${f1(x0 + slot * (i + 1))}` : `M${f1(x0 + slot * i)},${yy}H${f1(x0 + slot * (i + 1))}`;
			}
			if (mx) svg += `<path class="massimo" d="${mx}"/>`;
			svg += `<text class="adesso-t" x="${f1(x1 + 6)}" y="${f1(mid + 4)}">adesso</text>`;
			svg += `<g class="mirino" hidden><line x1="0" x2="0" y1="${T}" y2="${T + ph}"/></g></svg>`;
			put(el, svg);
			$('corrente-palco').style.height = H + 'px';

			const list = c.avg.map((v, i) => {
				const d = oraDi(i);
				const h = d.getHours();
				return { avg: v, peak: c.peak[i], busy: c.busy[i], long: `${giornoL(localKey(d.getTime()))}, dalle ${h} alle ${h + 1}`, quando: d.getTime() };
			});
			parallelo = { el, list, L: x0, slot, idx: parallelo ? parallelo.idx : -1, mid, unit, cx };
			if (anim.grafici) traccia($('corrente'));
			corrente.scena({ W, H, x0, x1, mid, unit, avg: c.avg, busy: c.busy, rivela: anim.grafici && mosso() && visible });

			// le cose da dire
			let tot = 0, sess = 0, ore = 0, ore2 = 0, pi = -1;
			for (let i = 0; i < ORE7; i++) {
				tot += c.busy[i];
				sess += c.avg[i] * c.busy[i];
				if (c.busy[i] > 0) ore++;
				if (c.peak[i] >= 2) ore2++;
				if (pi < 0 || c.peak[i] >= c.peak[pi]) pi = c.peak[i] > 0 ? i : pi;
			}
			const media = tot ? sess / tot : 0;
			let nota;
			if (tot < 1) nota = 'Negli ultimi 7 giorni nessuna sessione di Claude Code.';
			else {
				nota = media < 1.05 ? 'Nelle ore in cui lavori gira una sessione alla volta.' : `Nelle ore in cui lavori girano in media ${it(media, 1)} sessioni insieme.`;
				const p = list[pi];
				if (p && p.peak > 1) nota += ` Al massimo ne hai avute ${parola(p.peak)} insieme, ${giornoL(localKey(p.quando))} alle ${new Date(p.quando).getHours()}.`;
				nota += ore2 ? ` In ${it(ore2)} ${ore2 === 1 ? 'ora' : 'ore'} su ${it(ore)} ne giravano almeno due.` : ` In ${it(ore)} ${ore === 1 ? 'ora' : 'ore'} di lavoro mai due insieme.`;
			}
			$('parallelo-nota').textContent = nota;
			$('corrente-conto').textContent = tot ? `${it(ore)} ${ore === 1 ? 'ora' : 'ore'} con sessioni, ${it(ore2)} con almeno due` : '';
			el.setAttribute('aria-label', `Lavoro in parallelo negli ultimi 7 giorni, ora per ora. ${nota} Usa le frecce per leggere le ore.`);
			put(
				$('parallelo-legenda'),
				`<li><i class="chiave q k-fascia" aria-hidden="true"></i>Sessioni insieme, in media</li><li><i class="chiave tratteggio-notte" aria-hidden="true"></i>Al massimo</li>`,
			);
			put(
				$('parallelo-tabella'),
				tabella(
					'parallelo',
					'Lavoro in parallelo, ora per ora',
					['Ora', 'Insieme in media', 'Al massimo', 'Con almeno una sessione'],
					list
						.filter(x => x.busy > 0)
						.reverse()
						.map(x => [x.long, it(x.avg, 1), it(x.peak), hm(x.busy)]),
				),
			);
		}

		function paralleloAt(i, fromKey) {
			const c = parallelo;
			if (!c || !c.list.length) return;
			i = Math.max(0, Math.min(c.list.length - 1, i));
			c.idx = i;
			const b = c.list[i];
			const x = c.cx(i);
			const m = c.el.querySelector('.mirino');
			if (m) {
				m.removeAttribute('hidden');
				const ln = m.querySelector('line');
				ln.setAttribute('x1', x.toFixed(1));
				ln.setAttribute('x2', x.toFixed(1));
			}
			const rows = b.busy
				? [
						{ key: 'q k-fascia', value: it(b.avg, 1), label: b.avg === 1 ? 'sessione in media' : 'sessioni insieme in media' },
						{ key: 'tratteggio-notte', value: it(b.peak), label: 'al massimo nello stesso istante' },
						{ value: hm(b.busy), label: 'con almeno una sessione' },
					]
				: [{ value: 'nessuna sessione', label: '' }];
			showTip(c.el, x, c.mid - b.avg * c.unit, b.long, rows);
			if (fromKey) say(b.busy ? `${b.long}: ${it(b.avg, 1)} sessioni in media, al massimo ${it(b.peak)}.` : `${b.long}: nessuna sessione.`);
		}

		function paralleloOff() {
			if (parallelo) {
				const m = parallelo.el.querySelector('.mirino');
				if (m) m.setAttribute('hidden', '');
			}
			hideTip();
		}

		// ---------- chi sale e chi scende ----------

		let righeSale = 0;

		function renderSale() {
			const p = P();
			const n = p.days;
			const box = $('sale');
			if (!prevOk(p)) {
				righeSale = 0;
				put(box, '');
				put($('sale-legenda'), '');
				put($('sale-tabella'), '');
				$('sale-nota').textContent = `Per dire chi sale e chi scende servono dei registri anche nei ${n} giorni prima: per ora non ce ne sono.`;
				return;
			}
			const voce = r => ({ name: r.name, path: r.path, you: r.you, prev: r.prev.you, last: r.last });
			const conPath = p.projects.filter(r => r.path);
			const su = conPath
				.filter(r => r.you - r.prev.you >= 15)
				.map(voce)
				.sort((x, y) => y.you - y.prev - (x.you - x.prev))
				.slice(0, 5);
			const giu = conPath
				.filter(r => r.prev.you - r.you >= 15)
				.map(voce)
				.concat((p.stalled || []).map(x => ({ name: x.name, path: x.path, you: 0, prev: x.prev, last: x.last })))
				.sort((x, y) => y.prev - y.you - (x.prev - x.you))
				.slice(0, 5);
			righeSale = su.length + giu.length;
			const max = Math.max(60, ...su.concat(giu).map(r => Math.max(r.you, r.prev)));
			const q = v => ((100 * v) / max).toFixed(1);
			const t = now();
			const riga = (r, verso) => {
				const d = r.you - r.prev;
				const sotto = verso > 0 ? `${hm(r.prev)} prima, ${hm(r.you)} adesso` : `${r.you >= 1 ? hm(r.you) : 'nessuna ora'} adesso, ultima volta ${fa(r.last, t)}`;
				const sr = `${r.name}: ${hm(r.you)} negli ultimi ${n} giorni, ${hm(r.prev)} nei ${n} prima, ${hm(Math.abs(d))} ${d > 0 ? 'in più' : 'in meno'}. Apri nella plancia.`;
				return `<li><button type="button" class="riga-sale" data-c="progetto" data-path="${esc(r.path)}" data-fk="c:s:${esc(r.name)}" title="Apri ${esc(r.name)} nella plancia" aria-label="${esc(sr)}">
					<span class="chi"><b>${esc(r.name)}</b><small>${esc(sotto)}</small></span>
					<span class="pista" aria-hidden="true"><i class="tratto" data-a="${q(Math.min(r.you, r.prev))}" data-b="${q(Math.abs(d))}"></i><i class="prima" data-x="${q(r.prev)}"></i><i class="ora" data-x="${q(r.you)}"></i></span>
					<span class="delta" aria-hidden="true">${verso > 0 ? '▲' : '▼'} ${hm(Math.abs(d))}</span>
				</button></li>`;
			};
			let html = '';
			if (su.length) html += `<h3>Salgono</h3><ol class="righe-sale">${su.map(r => riga(r, 1)).join('')}</ol>`;
			if (giu.length) html += `<h3>Si stanno fermando</h3><ol class="righe-sale">${giu.map(r => riga(r, -1)).join('')}</ol>`;
			put(box, html);
			box.querySelectorAll('[data-x]').forEach(e => (e.style.left = e.getAttribute('data-x') + '%'));
			box.querySelectorAll('[data-a]').forEach(e => {
				e.style.left = e.getAttribute('data-a') + '%';
				e.style.width = e.getAttribute('data-b') + '%';
			});
			put($('sale-legenda'), righeSale ? `<li><i class="chiave pallino-vuoto" aria-hidden="true"></i>I ${n} giorni prima</li><li><i class="chiave pallino" aria-hidden="true"></i>Gli ultimi ${n}</li>` : '');
			let nota = '';
			if (su.length) nota += `Sale soprattutto ${su[0].name}, ${oreParole(su[0].you - su[0].prev)} in più dei ${n} giorni prima${su[1] ? `; poi ${su[1].name}` : ''}.`;
			if (giu.length) {
				const g = giu[0];
				nota += `${nota ? ' ' : ''}Si sta fermando ${g.name}: ${oreParole(g.prev)} nei ${n} giorni prima, ${g.you >= 1 ? oreParole(g.you) : 'nessuna ora'} in questi, l'ultima volta ${fa(g.last, t)}.`;
			}
			$('sale-nota').textContent = nota || `Nessun progetto si è mosso di più di un quarto d'ora rispetto ai ${n} giorni prima.`;
			put(
				$('sale-tabella'),
				righeSale
					? tabella(
							'sale',
							'Chi sale e chi scende',
							['Progetto', `Ultimi ${n} giorni`, `${n} giorni prima`, 'Differenza', 'Ultima volta'],
							su.concat(giu).map(r => [r.name, hm(r.you), hm(r.prev), `${r.you >= r.prev ? '▲' : '▼'} ${hm(Math.abs(r.you - r.prev))}`, fa(r.last, t)]),
						)
					: '',
			);
		}

		// ---------- quanto dura una sessione ----------

		const FASCE = ['meno di 5 minuti', 'da 5 a 15 minuti', 'da 15 a 30 minuti', 'da 30 a 60 minuti', 'da 1 a 2 ore', 'da 2 a 4 ore', 'oltre 4 ore'];
		const FASCE_B = ['< 5 min', '5-15 min', '15-30 min', '30-60 min', '1-2 h', '2-4 h', '> 4 h'];
		const FASCE_C = ['< 5', '5-15', '15-30', '30-60', '1-2 h', '2-4 h', '> 4 h'];
		let durata = null;

		function renderDurata() {
			const p = P();
			const l = p.lengths;
			const el = $('durata');
			if (!l || !l.n) {
				put(el, '');
				durata = null;
				put($('durata-legenda'), '');
				put($('durata-tabella'), '');
				$('durata-nota').textContent = l ? `Nessuna sessione di almeno un minuto negli ultimi ${p.days} giorni.` : 'Le durate delle sessioni arrivano con il prossimo aggiornamento.';
				return;
			}
			const W = width(el);
			const H = 190, Lm = 40, Rm = 10, T = 24, B = 28;
			const pw = W - Lm - Rm, ph = H - T - B;
			const k = l.bins.length;
			const slot = pw / k;
			const max = Math.max(1, ...l.bins);
			const step = Math.max(1, passo(max, 4));
			const top = Math.ceil(max / step) * step;
			const y = v => T + ph - (v / top) * ph;
			let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
			for (let v = 0; v <= top + 1e-6; v += step) {
				svg += `<line class="${v ? 'griglia' : 'base'}" x1="${Lm}" x2="${W - Rm}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="asse-y" x="${Lm - 8}" y="${(y(v) + 4).toFixed(1)}">${it(v)}</text>`;
			}
			const nomi = slot >= 64 ? FASCE_B : FASCE_C;
			const bw = Math.min(56, slot * 0.72);
			l.bins.forEach((v, i) => {
				const x = Lm + slot * (i + 0.5);
				svg += `<text class="asse-x" x="${x.toFixed(1)}" y="${H - 8}">${esc(nomi[i])}</text>`;
				svg += `<g class="pila"><path class="col-claude" d="${colonna(x - bw / 2, y(v), bw, y(0) - y(v), true)}"/></g>`;
			});
			// la mediana: dentro la sua fascia, in proporzione
			let j = l.edges.findIndex(e => l.median < e);
			if (j < 0) j = l.edges.length;
			const lo = j ? l.edges[j - 1] : 0;
			const hi = j < l.edges.length ? l.edges[j] : lo * 2;
			const xm = Lm + slot * (j + Math.max(0, Math.min(1, (l.median - lo) / (hi - lo))));
			const sx = xm > W - 140;
			svg += `<line class="mediana" x1="${xm.toFixed(1)}" x2="${xm.toFixed(1)}" y1="${T - 6}" y2="${y(0).toFixed(1)}"/>`;
			svg += `<text class="mediana-t" x="${(xm + (sx ? -6 : 6)).toFixed(1)}" y="${T - 10}" text-anchor="${sx ? 'end' : 'start'}">metà sotto ${esc(hm(l.median))}</text>`;
			svg += `<rect class="evidenza" hidden y="${T}" height="${ph}" rx="4"/></svg>`;
			put(el, svg);
			durata = { el, list: l.bins.map((v, i) => ({ v, nome: FASCE[i] })), L: Lm, slot, idx: -1, y, n: l.n };
			if (anim.grafici) traccia(el);
			put($('durata-legenda'), `<li><i class="chiave q b-claude" aria-hidden="true"></i>Sessioni</li><li><i class="chiave tratteggio-hud" aria-hidden="true"></i>Metà delle sessioni dura meno di così</li>`);
			const brevi = l.bins[0] + l.bins[1];
			const lunghe = l.bins[5] + l.bins[6];
			let nota =
				l.n === 1
					? `Negli ultimi ${p.days} giorni una sessione sola, con ${oreParole(l.median)} di lavoro.`
					: `Metà delle ${it(l.n)} sessioni degli ultimi ${p.days} giorni dura meno di ${oreParole(l.median)}.`;
			if (l.n > 1 && (lunghe || brevi)) {
				const parti = [];
				if (lunghe) parti.push(`${it(lunghe)} ${lunghe === 1 ? 'dura' : 'durano'} più di due ore`);
				if (brevi) parti.push(`${it(brevi)} ${lunghe ? '' : brevi === 1 ? 'dura ' : 'durano '}meno di un quarto d'ora`);
				nota += ` ${parti.join(' e ')}.`;
			}
			$('durata-nota').textContent = nota;
			el.setAttribute('aria-label', `Quanto dura una sessione, ultimi ${p.days} giorni, a fasce. ${nota} Usa le frecce per leggere le fasce.`);
			put(
				$('durata-tabella'),
				tabella('durata', 'Quanto dura una sessione', ['Durata', 'Sessioni', 'Quota'], l.bins.map((v, i) => [FASCE[i], it(v), pctTxt(pct(v, l.n))])),
			);
		}

		function durataAt(i, fromKey) {
			const c = durata;
			if (!c) return;
			i = Math.max(0, Math.min(c.list.length - 1, i));
			c.idx = i;
			const b = c.list[i];
			const x = c.L + c.slot * (i + 0.5);
			const r = c.el.querySelector('.evidenza');
			r.removeAttribute('hidden');
			r.setAttribute('x', (x - c.slot / 2 + 1).toFixed(1));
			r.setAttribute('width', Math.max(2, c.slot - 2).toFixed(1));
			showTip(c.el, x, c.y(b.v), b.nome, [
				{ key: 'q b-claude', value: it(b.v), label: b.v === 1 ? 'sessione' : 'sessioni' },
				{ value: pctTxt(pct(b.v, c.n)), label: 'del totale' },
			]);
			if (fromKey) say(`${b.nome}: ${it(b.v)} ${b.v === 1 ? 'sessione' : 'sessioni'}.`);
		}

		function durataOff() {
			if (durata) {
				const r = durata.el.querySelector('.evidenza');
				if (r) r.setAttribute('hidden', '');
			}
			hideTip();
		}

		// ---------- il banco: due colonne che finiscono insieme ----------

		/** @type {number[] | null} */ let banco = null;

		/** Una colonna o due, dalla larghezza vera del banco. Prima di disegnare: i grafici prendono la misura della colonna. */
		function impostaColonne() {
			const b = $('banco');
			const w = b.clientWidth || width($('crus-corpo'));
			b.classList.toggle('una', w < DUE_COLONNE);
		}

		/** Altezza stimata di un blocco, se il browser non la misura (stanza mai vista, banco di prova). */
		function stima(id) {
			const testa = 34, nota = 46, bottone = 30;
			const tab = ui.tables[id] ? 380 : 0;
			switch (id) {
				case 'oggi':
					return testa + nota + (oggi ? oggi.H : 0) + bottone + tab;
				case 'adesso':
					return testa + Math.max(1, stats.live.length) * 72;
				case 'parallelo':
					return testa + nota + 22 + 176 + bottone + tab;
				case 'calore':
					return testa + nota + (calore ? calore.Tt + calore.cell * 7 : 200) + bottone + tab;
				case 'sale':
					return testa + nota + (righeSale ? righeSale * 46 + 72 : 0) + bottone + tab;
				case 'durata':
					return testa + nota + 190 + bottone + tab;
				case 'registro':
					return testa + $('primati').children.length * 64;
			}
			return 0;
		}

		/** Mette i blocchi nelle due colonne in modo che finiscano alla stessa altezza (vedi dividi). Le
		    altezze sono quelle vere del browser; un blocco con la tabella aperta resta dov'e', cosi' non
		    scappa mentre Andrea legge i numeri. */
		function sistemaBanco() {
			const b = $('banco');
			const els = BLOCCHI.map(([id]) => $('b-' + id));
			let colonne;
			if (b.classList.contains('una')) {
				colonne = BLOCCHI.map(() => 0);
				banco = null;
				b.removeAttribute('data-scarto');
			} else {
				const misurate = els.map(e => e.offsetHeight || 0);
				const vere = misurate.every(h => h > 0);
				const alti = vere ? misurate : BLOCCHI.map(([id]) => stima(id));
				const fissi = BLOCCHI.map(([id], i) => (i === 0 ? 0 : banco && ui.tables[id] ? banco[i] : -1));
				const r = dividi(alti, SPAZIO, fissi, BLOCCHI.map(x => x[1]), banco);
				colonne = r.colonne;
				banco = colonne;
				b.setAttribute('data-scarto', String(Math.round(r.scarto)));
			}
			b.setAttribute('data-divisione', colonne.join(''));
			const cols = [$('banco-a'), $('banco-b')];
			const doc = root.ownerDocument;
			const att = doc.activeElement;
			let spostati = false;
			for (const c of [0, 1]) {
				const voglio = els.filter((_, i) => colonne[i] === c);
				const ho = [...cols[c].children];
				if (voglio.length === ho.length && voglio.every((e, i) => e === ho[i])) continue;
				for (const e of voglio) cols[c].appendChild(e);
				spostati = true;
			}
			if (spostati && att && root.contains(att) && doc.activeElement !== att) att.focus({ preventScroll: true });
		}

		// ---------- registro ----------

		function renderRegistro() {
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
			// le animazioni aspettano che la stanza si veda: disegnando di nascosto restano in attesa
			const tenute = visible ? null : { ...anim };
			if (tenute) for (const k of Object.keys(anim)) anim[/** @type {keyof typeof anim} */ (k)] = false;
			impostaColonne();
			renderTesta();
			renderObservedActivity();
			renderCarta();
			renderClassifica();
			renderCurva();
			renderCategorie();
			renderToken();
			renderLato();
			if (contiUI) contiUI.render();
			renderOggi();
			renderAdesso();
			renderParallelo();
			renderCalore();
			renderSale();
			renderDurata();
			renderRegistro();
			// a stanza nascosta il browser non misura: si sistema quando torna visibile (la misura cambia)
			if (visible || !banco) sistemaBanco();
			if (visible) riempiClassifica();
			Object.assign(anim, tenute || { rivela: false, conta: false, grafici: false, glitch: false, migra: false });
		}

		function request(daAndrea) {
			richiesto = !!daAndrea;
			host.post({ type: 'conti.request', aggiorna: !!daAndrea });
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
					if (ui.period === id) return;
					ui.period = id;
					if (!GRUPPI_OK[id].includes(ui.group)) ui.group = 'giorno';
					save();
					// cambio di periodo: le stelle migrano, le cifre scorrono dai valori di prima, i grafici si ridisegnano
					anim.migra = anim.conta = anim.grafici = true;
					render(true);
					say(`Ultimi ${id} giorni.`);
					return;
				case 'gruppo':
					if (ui.group !== id) anim.grafici = true;
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
				case 'osservatorio':
					host.post({ type: 'osservatorio.open' });
					return;
				case 'aggiorna':
				case 'riprova':
					return request(true);
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
		bindSeries('parallelo', () => parallelo, paralleloAt, paralleloOff);
		bindSeries('durata', () => durata, durataAt, durataOff);

		// oggi: il puntatore trova la sessione, le frecce passano dall'una all'altra in ordine di inizio
		const og = $('oggi');
		og.addEventListener('pointermove', e => {
			const t = /** @type {any} */ (e.target);
			const i = t && t.getAttribute ? t.getAttribute('data-s') : null;
			if (i === null || i === '') return oggiOff();
			oggiAt(+i, false);
		});
		og.addEventListener('pointerleave', oggiOff);
		og.addEventListener('blur', oggiOff);
		og.addEventListener('focus', () => oggi && oggi.sess.length && oggiAt(oggi.idx >= 0 ? oggi.idx : oggi.sess.length - 1, true));
		og.addEventListener('keydown', e => {
			if (!oggi || !oggi.sess.length) return;
			const cur = oggi.idx >= 0 ? oggi.idx : oggi.sess.length - 1;
			const k = { ArrowLeft: cur - 1, ArrowUp: cur - 1, ArrowRight: cur + 1, ArrowDown: cur + 1, Home: 0, End: oggi.sess.length - 1 }[e.key];
			if (k === undefined) return;
			e.preventDefault();
			oggiAt(k, true);
		});

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
		if (reduced.addEventListener)
			reduced.addEventListener('change', () => {
				crus.classList.remove('rivela', 'ritraccia');
				assesta();
				cielo.ridisegna();
				corrente.ridisegna();
			});

		// la lancetta segue l'ora, la linea di oggi il minuto; la casella di adesso nella settimana cambia allo scoccare dell'ora
		let orologio = 0;
		let oraVista = new Date().getHours();
		function batti() {
			if (!stats) return;
			metteLancetta();
			renderOggi();
			const h = new Date().getHours();
			if (h !== oraVista) {
				oraVista = h;
				renderCalore();
			}
		}
		const accendiOrologio = on => {
			clearInterval(orologio);
			orologio = on ? setInterval(batti, 60_000) : 0;
		};

		return {
			/** Dati nuovi dall'estensione (null con un errore). */
			setStats(s, err) {
				clearTimeout(waitTimer);
				crus.classList.remove('in-attesa');
				if (s) {
					// arrivo dei dati: la prima volta, o quando li ha chiesti Andrea. Gli aggiornamenti
					// periodici (ogni due minuti) non fanno ripartire niente: segnalano solo cosa e' cambiato.
					if (!stats || richiesto) anim.rivela = anim.conta = anim.grafici = anim.glitch = true;
					richiesto = false;
					stats = s;
					error = '';
				} else error = err || 'Non riesco a leggere le sessioni di Claude Code.';
				lastKey = '';
				render(false);
				if (attesaFocus && stats) {
					const f = attesaFocus;
					attesaFocus = null;
					this.focus(f);
				}
			},
			/** Crediti e consumi dei servizi (messaggio "conti"). */
			setConti(c) {
				if (contiUI) contiUI.set(c);
			},
			/** Dalla barra di Melissa o da un avviso di ricarica: la sezione dei servizi. */
			mostraConti() {
				if (contiUI) setTimeout(() => contiUI.mostra(), 50);
			},
			/** Comando vocale di Melissa («fammi vedere le ore di Woofmap questa settimana»): cambia periodo e
			 *  accende il progetto sul cielo e in classifica, mentre lei risponde. Senza dati, aspetta che arrivino. */
			focus(o) {
				if (!o) return;
				if (!stats) {
					attesaFocus = o;
					return;
				}
				const per = String(o.period || '');
				if (['7', '30', '90'].includes(per) && ui.period !== per) {
					ui.period = per;
					if (!GRUPPI_OK[per].includes(ui.group)) ui.group = 'giorno';
					save();
					anim.migra = anim.conta = anim.grafici = true;
					render(true);
					say(`Ultimi ${per} giorni.`);
				}
				if (!o.path) return;
				const i = stelle.findIndex(x => x && x.row && x.row.path === o.path);
				if (i < 0) {
					say('Questo progetto non ha ore nel periodo.');
					return;
				}
				const st = stelle[i];
				accendi(i, true);
				const svg = $('carta-svg').querySelector('svg');
				if (svg) tipStella(st, svg, st.x, st.y);
				const row = $('classifica').querySelector(`.riga-progetto[data-i="${i}"]`);
				if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center', behavior: reduced.matches ? 'auto' : 'smooth' });
				say(`${st.row.name} acceso sul cielo.`);
			},
			render() {
				render(false);
			},
			show() {
				visible = true;
				crus.classList.remove('fermo');
				attivaCielo();
				accendiOrologio(true);
				render(false);
				batti();
				request();
			},
			hide() {
				visible = false;
				crus.classList.add('fermo');
				hideTip();
				assesta();
				accendiOrologio(false);
				attivaCielo();
			},
			pause() {
				paused = true;
				crus.classList.add('fermo');
				assesta();
				attivaCielo();
			},
			resume() {
				paused = false;
				if (visible) crus.classList.remove('fermo');
				attivaCielo();
			},
		};
	}

	/** @type {any} */ (window).BottegaCruscotto = { mount, dividi };
})();
