/* Bottega, il cruscotto: la quinta stanza della plancia. Ore di lavoro, token e progetti letti dai
   registri di Claude Code (src/stats.ts li riassume, docs/CONTRATTI.md sezione 3 ne descrive la forma).

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
   (lancetta, reticoli, mirino). Il cielo ha due motori:
   - WebGPU, che in Electron su Mac passa da Metal: nebulosa, corona delle ore, stelle con le punte
     di diffrazione, scintille lungo i legami, l'anello che respira sulle sessioni vive. Disegna
     solo decorazione e luce: tutti i dati restano nell'SVG sopra (nomi, prese, tabella).
   - SVG, sempre presente: e' il ripiego (niente WebGPU, adattatore negato, dispositivo perso) e ha
     gli stessi contenuti, solo con luci piu' semplici.
   Animazioni con un perche': arrivo dei dati (scansione che accende le stelle, cifre che contano,
   tracce che si disegnano), cambio di periodo (le stelle migrano), passaggio del mouse (mirino),
   sessione viva (anello che respira). Una volta per arrivo, mai a ogni aggiornamento periodico.
   Con "riduci movimento" solo stati finali, stessi contenuti. Stanza nascosta: niente frame, e la
   GPU si libera dopo RILASCIO_MS. */
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

	// ---------- il cielo su WebGPU (Metal) ----------

	/* Un solo modulo WGSL, tre passaggi:
	   - fondo: cupola, nebulosa (fbm), corona delle ore lungo il bordo, l'ultima ora alle spalle della
	     lancetta. Cambia solo coi dati, con la misura o col minuto: si disegna in una texture e poi si
	     copia, cosi' il frame normale costa una copia e poche centinaia di quadratini;
	   - copia: la texture del fondo sulla tela;
	   - luce: quadratini in istanza, sommati (additivi): stelle di fondo che scintillano, stelle dei
	     progetti con alone e punte di diffrazione, anelli delle sessioni vive, scintille lungo i
	     legami, la lancetta di adesso.
	   Coordinate in px CSS della carta; la tela ha i px veri (dpr al massimo 2). */
	const WGSL = /* wgsl */ `
struct U {
	a: vec4f,
	b: vec4f,
	c: vec4f,
	hours: array<vec4f, 6>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var fondo: texture_2d<f32>;

fn wrap24(x: f32) -> f32 { return x - 24.0 * floor(x / 24.0); }

fn hash(p: vec2f) -> f32 {
	var q = fract(p * vec2f(123.34, 456.21));
	q += dot(q, q + 45.32);
	return fract(q.x * q.y);
}

fn noise(p: vec2f) -> f32 {
	let i = floor(p);
	let f = fract(p);
	let w = f * f * (3.0 - 2.0 * f);
	let a = hash(i);
	let b = hash(i + vec2f(1.0, 0.0));
	let c = hash(i + vec2f(0.0, 1.0));
	let d = hash(i + vec2f(1.0, 1.0));
	return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

fn fbm(p0: vec2f) -> f32 {
	var p = p0;
	var s = 0.0;
	var amp = 0.5;
	for (var k = 0; k < 5; k++) {
		s += amp * noise(p);
		p = p * 2.03 + vec2f(17.1, 9.2);
		amp *= 0.5;
	}
	return s;
}

fn ora(i: u32) -> f32 {
	let v = u.hours[i / 4u];
	return v[i % 4u];
}

fn oraLiscia(h: f32) -> f32 {
	let x = wrap24(h - 0.5);
	let i0 = u32(floor(x)) % 24u;
	let i1 = (i0 + 1u) % 24u;
	let f = x - floor(x);
	return mix(ora(i0), ora(i1), f * f * (3.0 - 2.0 * f));
}

struct VF { @builtin(position) pos: vec4f };

@vertex fn vs_pieno(@builtin(vertex_index) i: u32) -> VF {
	var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
	var o: VF;
	o.pos = vec4f(p[i], 0.0, 1.0);
	return o;
}

@fragment fn fs_fondo(v: VF) -> @location(0) vec4f {
	let p = v.pos.xy / u.b.w;
	let d = p - u.b.xy;
	let R = u.b.z;
	let r = length(d);
	let cupola = R + 8.0;
	let dentro = 1.0 - smoothstep(cupola - 1.0, cupola + 0.5, r);
	let t = clamp(r / cupola, 0.0, 1.0);
	var col = mix(vec3f(0.114, 0.157, 0.275), vec3f(0.078, 0.110, 0.200), smoothstep(0.0, 0.7, t));
	col = mix(col, vec3f(0.059, 0.086, 0.157), smoothstep(0.7, 1.0, t));
	let q = d / cupola * 2.4;
	let n1 = fbm(q + vec2f(3.1, 1.7));
	let n2 = fbm(q * 1.6 + vec2f(n1 * 1.4, 5.2));
	col += vec3f(0.09, 0.10, 0.27) * smoothstep(0.42, 0.92, n2) * (1.0 - 0.5 * t) * 0.7;
	col += vec3f(0.02, 0.15, 0.17) * smoothstep(0.55, 0.95, n1) * 0.45;
	let ang = atan2(d.x, -d.y);
	let h = wrap24(ang / 6.2831853 * 24.0 + 12.0);
	let fascia = smoothstep(R - 36.0, R - 2.0, r) * (1.0 - smoothstep(R + 1.0, R + 7.0, r));
	col += vec3f(0.957, 0.671, 0.235) * fascia * oraLiscia(h) * 0.42;
	let dietro = wrap24(u.c.y - h);
	let scia = (1.0 - smoothstep(0.0, 1.0, dietro)) * smoothstep(u.c.w, R * 0.6, r) * (1.0 - smoothstep(R, cupola, r));
	col += vec3f(0.39, 0.90, 0.86) * scia * 0.07;
	col *= 1.0 - 0.28 * smoothstep(0.78, 1.0, t);
	return vec4f(col * dentro, dentro);
}

@fragment fn fs_copia(v: VF) -> @location(0) vec4f {
	return textureLoad(fondo, vec2i(v.pos.xy), 0);
}

struct VI {
	@location(0) a: vec4f,
	@location(1) col: vec4f,
	@location(2) c: vec4f,
	@location(3) d: vec4f,
};

struct VS {
	@builtin(position) pos: vec4f,
	@location(0) uv: vec2f,
	@location(1) col: vec4f,
	@location(2) @interpolate(flat) tipo: f32,
	@location(3) @interpolate(flat) x: f32,
};

@vertex fn vs_luce(@builtin(vertex_index) vi: u32, i: VI) -> VS {
	var angoli = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
	let k = angoli[vi];
	let tempo = u.a.z;
	let riv = u.a.w;
	let acceso = u.c.x;
	let tipo = i.a.w;
	var centro = i.a.xy;
	var lato = i.a.z;
	var col = i.col;
	var x = 0.0;
	var p = vec2f(0.0, 0.0);
	if (tipo < 0.5) {
		col.a *= 0.7 + 0.3 * sin(tempo * i.c.z + i.c.w);
	} else if (tipo < 1.5 || tipo > 4.5) {
		let on = smoothstep(i.d.z, i.d.z + 0.7, riv);
		col.a *= on;
		lato *= mix(0.3, 1.0, on);
		if (acceso >= 0.0) {
			if (abs(i.d.x - acceso) < 0.5) { lato *= 1.2; } else { col.a *= 0.32; }
		}
	} else if (tipo < 2.5) {
		let f = fract(tempo / 2.8 + i.c.w);
		x = f;
		lato *= 0.85 + 0.4 * f;
		col.a *= (1.0 - f) * smoothstep(i.d.z, i.d.z + 0.7, riv);
		if (acceso >= 0.0 && abs(i.d.x - acceso) > 0.5) { col.a *= 0.32; }
	} else if (tipo < 3.5) {
		let f = fract(tempo * i.c.z + i.c.w);
		centro = mix(i.a.xy, i.c.xy, f);
		col.a *= sin(f * 3.14159265) * smoothstep(i.d.z, i.d.z + 0.8, riv);
		if (acceso >= 0.0) {
			if (abs(i.d.x - acceso) < 0.5 || abs(i.d.y - acceso) < 0.5) { col.a = min(1.0, col.a * 1.5); } else { col.a *= 0.15; }
		}
	}
	if (tipo > 3.5 && tipo < 4.5) {
		let A = i.a.xy;
		let B = i.c.xy;
		let dir = normalize(B - A);
		let nor = vec2f(-dir.y, dir.x);
		p = A + dir * ((k.x * 0.5 + 0.5) * length(B - A)) + nor * (k.y * lato);
		x = select(-1.0, fract(tempo / 4.0), u.c.z > 0.5);
	} else {
		p = centro + k * lato;
	}
	var o: VS;
	o.pos = vec4f(p.x / u.a.x * 2.0 - 1.0, 1.0 - p.y / u.a.y * 2.0, 0.0, 1.0);
	o.uv = k;
	o.col = col;
	o.tipo = tipo;
	o.x = x;
	return o;
}

@fragment fn fs_luce(v: VS) -> @location(0) vec4f {
	let r = length(v.uv);
	var a = 0.0;
	var rgb = v.col.rgb;
	if (v.tipo < 0.5) {
		a = exp(-r * r * 6.0);
	} else if (v.tipo < 1.5) {
		let nucleo = exp(-r * r * 34.0);
		let alone = exp(-r * r * 7.0) * 0.42 + exp(-r * 5.0) * 0.1;
		let raggi = (exp(-abs(v.uv.y) * 70.0) + exp(-abs(v.uv.x) * 70.0)) * pow(max(0.0, 1.0 - r), 2.5) * 0.5;
		a = nucleo + alone + raggi;
		rgb = mix(rgb, vec3f(1.0, 0.98, 0.93), clamp(nucleo * 1.3 + raggi * 0.4, 0.0, 1.0));
	} else if (v.tipo < 2.5) {
		let d = (r - 0.82) * 12.0;
		a = exp(-d * d);
	} else if (v.tipo < 3.5) {
		a = exp(-r * r * 9.0);
	} else if (v.tipo < 4.5) {
		let lungo = v.uv.x * 0.5 + 0.5;
		a = exp(-v.uv.y * v.uv.y * 9.0) * (0.25 + 0.75 * lungo);
		if (v.x >= 0.0) {
			let s = lungo - v.x;
			a += exp(-s * s * 400.0) * exp(-v.uv.y * v.uv.y * 4.0) * 0.9;
		}
	} else {
		let d = (r - 0.32) * 16.0;
		a = exp(-d * d) * 0.9;
	}
	let al = clamp(a * v.col.a, 0.0, 1.0);
	return vec4f(rgb * al, al);
}
`;

	/** Colori della luce (rgb lineari 0..1, la cupola resta notte anche nel tema chiaro). */
	const LUCE = {
		campo: [0.91, 0.886, 0.816],
		stella: [0.96, 0.7, 0.34],
		calima: [0.91, 0.886, 0.816],
		sodio: [0.957, 0.671, 0.235],
		ciano: [0.39, 0.9, 0.86],
	};
	/** Dopo quanto la GPU si libera a stanza nascosta: tornarci subito non riaccende tutto. */
	const RILASCIO_MS = 15_000;
	const FLOAT_ISTANZA = 16; // 4 vec4f per quadratino

	/**
	 * Il motore WebGPU del cielo. Restituisce sempre un oggetto: se WebGPU manca, lo stato e' 'svg'
	 * subito e tutti i metodi non fanno niente. Stati: 'spento' (GPU libera), 'avvio', 'gpu', 'svg'
	 * (ripiego definitivo per questo montaggio).
	 * @param {HTMLCanvasElement} canvas
	 * @param {{ reduced: () => boolean, onStato: (stato: string, motivo: string) => void, rilascio?: number }} opt
	 */
	function creaCielo(canvas, opt) {
		const gpu = typeof navigator !== 'undefined' && /** @type {any} */ (navigator).gpu;
		const G = /** @type {any} */ (globalThis);
		const USO = {
			UNIFORM: G.GPUBufferUsage ? G.GPUBufferUsage.UNIFORM : 0x40,
			COPY_DST: G.GPUBufferUsage ? G.GPUBufferUsage.COPY_DST : 0x08,
			VERTEX: G.GPUBufferUsage ? G.GPUBufferUsage.VERTEX : 0x20,
			RENDER: G.GPUTextureUsage ? G.GPUTextureUsage.RENDER_ATTACHMENT : 0x10,
			TEXTURE: G.GPUTextureUsage ? G.GPUTextureUsage.TEXTURE_BINDING : 0x04,
		};
		const rilascio = opt.rilascio ?? RILASCIO_MS;
		const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

		let stato = gpu ? 'spento' : 'svg';
		let gen = 0;
		/** @type {any} */ let dev = null;
		/** @type {any} */ let ctx = null;
		/** @type {any} */ let r = null; // risorse: pipeline, buffer, texture, gruppi
		/** @type {any} */ let scena = null;
		let ist = new Float32Array(0);
		let nIst = 0;
		let fondoSporco = true;
		let istSporche = true;
		let attivo = false;
		let inVista = true;
		let raf = 0;
		let ultimo = 0;
		const t0 = clock();
		let rivelaDa = -1e9;
		let migraDa = -1e9;
		let acceso = -1;
		let minuto = -1;
		let rilascioT = 0;
		let frames = 0;
		const U = new Float32Array(40);

		function cambia(s, motivo) {
			stato = s;
			try {
				opt.onStato(s, motivo || '');
			} catch (e) {
				console.error('Bottega: cruscotto, stato del cielo', e);
			}
		}

		function liberaRisorse() {
			if (!r) return;
			for (const b of [r.ubuf, r.ibuf, r.tex]) {
				try {
					b && b.destroy && b.destroy();
				} catch {}
			}
			r = null;
		}

		function spegni() {
			gen++;
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
			const d = dev;
			dev = null;
			liberaRisorse();
			try {
				ctx && ctx.unconfigure && ctx.unconfigure();
			} catch {}
			try {
				d && d.destroy();
			} catch {}
		}

		/** Qualcosa e' andato storto: si torna all'SVG e non si riprova in questo montaggio. */
		function ripiego(motivo) {
			if (stato === 'svg') return;
			console.warn('Bottega: cruscotto senza WebGPU, ripiego sull\'SVG:', motivo);
			spegni();
			cambia('svg', motivo);
		}

		async function avvia() {
			if (stato === 'svg' || stato === 'avvio' || dev) return;
			const g = ++gen;
			cambia('avvio', '');
			try {
				const adapter = await gpu.requestAdapter({ powerPreference: 'low-power' });
				if (g !== gen) return;
				if (!adapter) throw new Error('nessun adattatore WebGPU');
				const d = await adapter.requestDevice();
				if (g !== gen) {
					d.destroy();
					return;
				}
				const c = canvas.getContext('webgpu');
				if (!c) {
					d.destroy();
					throw new Error('la tela non da un contesto webgpu');
				}
				const format = gpu.getPreferredCanvasFormat();
				c.configure({ device: d, format, alphaMode: 'premultiplied' });
				const mod = d.createShaderModule({ code: WGSL });
				if (mod.getCompilationInfo) {
					const info = await mod.getCompilationInfo();
					const err = (info.messages || []).find(m => m.type === 'error');
					if (err) {
						d.destroy();
						throw new Error(`WGSL, riga ${err.lineNum}: ${err.message}`);
					}
				}
				const target = [{ format }];
				const additivo = [
					{
						format,
						blend: {
							color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
							alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
						},
					},
				];
				const [pFondo, pCopia, pLuce] = await Promise.all([
					d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: mod, entryPoint: 'vs_pieno' }, fragment: { module: mod, entryPoint: 'fs_fondo', targets: target }, primitive: { topology: 'triangle-list' } }),
					d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: mod, entryPoint: 'vs_pieno' }, fragment: { module: mod, entryPoint: 'fs_copia', targets: target }, primitive: { topology: 'triangle-list' } }),
					d.createRenderPipelineAsync({
						layout: 'auto',
						vertex: {
							module: mod,
							entryPoint: 'vs_luce',
							buffers: [
								{
									arrayStride: FLOAT_ISTANZA * 4,
									stepMode: 'instance',
									attributes: [0, 1, 2, 3].map(n => ({ shaderLocation: n, offset: n * 16, format: 'float32x4' })),
								},
							],
						},
						fragment: { module: mod, entryPoint: 'fs_luce', targets: additivo },
						primitive: { topology: 'triangle-strip' },
					}),
				]);
				if (g !== gen) {
					d.destroy();
					return;
				}
				const ubuf = d.createBuffer({ size: U.byteLength, usage: USO.UNIFORM | USO.COPY_DST });
				r = { format, pFondo, pCopia, pLuce, ubuf, ibuf: null, icap: 0, tex: null, texW: 0, texH: 0, bgFondo: null, bgCopia: null, bgLuce: null };
				r.bgFondo = d.createBindGroup({ layout: pFondo.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
				r.bgLuce = d.createBindGroup({ layout: pLuce.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
				dev = d;
				ctx = c;
				d.lost.then(info => {
					if (dev !== d) return; // spento da noi
					ripiego(`dispositivo perso${info && info.message ? ': ' + info.message : ''}`);
				});
				if (d.addEventListener) d.addEventListener('uncapturederror', e => ripiego(String((e && e.error && e.error.message) || 'errore della GPU')));
				fondoSporco = true;
				istSporche = true;
				cambia('gpu', '');
				chiedi();
			} catch (e) {
				if (g !== gen) return;
				ripiego(String((e && /** @type {any} */ (e).message) || e));
			}
		}

		function animato() {
			return !opt.reduced();
		}

		/** Chiede un frame se c'e' qualcosa da disegnare e qualcuno che guarda. */
		function chiedi() {
			if (raf || !dev || !r || !attivo || !inVista || !scena) return;
			raf = requestAnimationFrame(passo);
		}

		function passo(ts) {
			raf = 0;
			if (!dev || !r || !attivo || !inVista || !scena) return;
			const mosso = animato();
			const t = clock();
			// 30 fotogrammi al secondo mentre succede qualcosa, 20 a riposo
			const vivace = t - rivelaDa < 3500 || t - migraDa < 1000 || acceso >= 0;
			const fps = vivace ? 30 : 20;
			if (mosso && ultimo && ts - ultimo < 1000 / fps - 2) {
				raf = requestAnimationFrame(passo);
				return;
			}
			ultimo = ts;
			try {
				disegna(t, mosso);
			} catch (e) {
				return ripiego(String((e && /** @type {any} */ (e).message) || e));
			}
			if (mosso) raf = requestAnimationFrame(passo);
		}

		/** Prepara i quadratini in istanza; k e' l'avanzamento della migrazione (0..1). */
		function costruisci(k) {
			const s = scena;
			const e = facile(k);
			const pos = s.stelle.map(st => (st.da ? [st.da[0] + (st.x - st.da[0]) * e, st.da[1] + (st.y - st.da[1]) * e] : [st.x, st.y]));
			const parti = [];
			for (const l of s.legami) {
				const n = Math.max(1, Math.min(4, Math.round(l.minuti / 40)));
				for (let j = 0; j < n; j++) parti.push([l, j / n]);
			}
			const vive = s.stelle.filter(st => st.vivo).length;
			const tot = s.campo.length + s.stelle.length + vive + parti.length + 1;
			if (ist.length < tot * FLOAT_ISTANZA) ist = new Float32Array(Math.ceil(tot * 1.5) * FLOAT_ISTANZA);
			let o = 0;
			const metti = (x, y, lato, tipo, c, a, cx, cy, cz, cw, d0, d1, d2, d3) => {
				ist.set([x, y, lato, tipo, c[0], c[1], c[2], a, cx, cy, cz, cw, d0, d1, d2, d3], o);
				o += FLOAT_ISTANZA;
			};
			for (const [x, y, rr, op, ph, w] of s.campo) metti(x, y, rr * 3.2, 0, LUCE.campo, Math.min(0.9, op * 2.2), 0, 0, w, ph, -1, -1, -1, 0);
			s.stelle.forEach((st, j) => {
				const [x, y] = pos[j];
				if (st.altrove) metti(x, y, st.size * 1.75, 5, LUCE.calima, 0.95, 0, 0, 0, 0, st.i, -1, st.ritardo, 0);
				else metti(x, y, st.size * 3.2, 1, LUCE.stella, 1, 0, 0, 0, 0, st.i, -1, st.ritardo, 0);
			});
			s.stelle.forEach((st, j) => {
				if (!st.vivo) return;
				const [x, y] = pos[j];
				metti(x, y, (st.size + 6) / 0.82, 2, LUCE.sodio, 0.95, 0, 0, 0, (j * 0.37) % 1, st.i, -1, st.ritardo, 0);
			});
			const idx = new Map(s.stelle.map((st, j) => [st.i, j]));
			for (const [l, ph] of parti) {
				const a = pos[idx.get(l.a)];
				const b = pos[idx.get(l.b)];
				if (!a || !b) continue;
				const forte = l.minuti >= 60;
				metti(a[0], a[1], forte ? 3.8 : 3.2, 3, LUCE.ciano, forte ? 0.95 : 0.7, b[0], b[1], forte ? 0.16 : 0.11, ph, l.a, l.b, s.ritardoLegami, 0);
			}
			// la lancetta di adesso: dal bordo dell'anello interno al quadrante
			const h = oraAdesso();
			const ang = ((h - 12) / 24) * 2 * Math.PI;
			const ax = s.c + s.R0 * Math.sin(ang), ay = s.c - s.R0 * Math.cos(ang);
			const bx = s.c + (s.R + 8) * Math.sin(ang), by = s.c - (s.R + 8) * Math.cos(ang);
			metti(ax, ay, 3, 4, LUCE.ciano, 0.6, bx, by, 0, 0, -1, -1, -1, 0);
			nIst = o / FLOAT_ISTANZA;
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
			const h = oraAdesso();
			const m = Math.floor(h * 60);
			if (m !== minuto) {
				minuto = m;
				fondoSporco = true;
				istSporche = true;
			}
			const k = mosso ? Math.min(1, (t - migraDa) / 900) : 1;
			if (k < 1 || istSporche) {
				costruisci(k);
				istSporche = k < 1; // durante la migrazione si ricostruisce a ogni frame, poi una volta in piu'
				if (k >= 1) istSporche = false;
				const bytes = nIst * FLOAT_ISTANZA * 4;
				if (!r.ibuf || r.icap < bytes) {
					if (r.ibuf) r.ibuf.destroy();
					r.icap = Math.max(bytes, 32 * 1024);
					r.ibuf = dev.createBuffer({ size: r.icap, usage: USO.VERTEX | USO.COPY_DST });
				}
				if (bytes) dev.queue.writeBuffer(r.ibuf, 0, ist.buffer, 0, bytes);
			}
			if (!r.tex || r.texW !== W) {
				if (r.tex) r.tex.destroy();
				r.tex = dev.createTexture({ size: [W, W], format: r.format, usage: USO.RENDER | USO.TEXTURE });
				r.texW = W;
				r.bgCopia = dev.createBindGroup({ layout: r.pCopia.getBindGroupLayout(0), entries: [{ binding: 1, resource: r.tex.createView() }] });
				fondoSporco = true;
			}
			U[0] = s.S;
			U[1] = s.S;
			U[2] = mosso ? (t - t0) / 1000 : 0;
			U[3] = mosso ? (t - rivelaDa) / 1000 : 99;
			U[4] = s.c;
			U[5] = s.c;
			U[6] = s.R;
			U[7] = dpr;
			U[8] = acceso;
			U[9] = h;
			U[10] = mosso && s.stelle.some(st => st.vivo) ? 1 : 0;
			U[11] = s.R0;
			for (let i = 0; i < 24; i++) U[12 + i] = s.ore[i] || 0;
			dev.queue.writeBuffer(r.ubuf, 0, U.buffer, 0, U.byteLength);
			const enc = dev.createCommandEncoder();
			if (fondoSporco) {
				const p = enc.beginRenderPass({ colorAttachments: [{ view: r.tex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
				p.setPipeline(r.pFondo);
				p.setBindGroup(0, r.bgFondo);
				p.draw(3);
				p.end();
				fondoSporco = false;
			}
			const p = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
			p.setPipeline(r.pCopia);
			p.setBindGroup(0, r.bgCopia);
			p.draw(3);
			if (nIst) {
				p.setPipeline(r.pLuce);
				p.setBindGroup(0, r.bgLuce);
				p.setVertexBuffer(0, r.ibuf);
				p.draw(4, nIst);
			}
			p.end();
			dev.queue.submit([enc.finish()]);
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
			/** Stanza visibile (e finestra davanti) oppure no. */
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
			/** La carta e' sullo schermo o fuori, scorrendo la pagina. */
			inVista(on) {
				inVista = !!on;
				if (inVista) chiedi();
				else if (raf) {
					cancelAnimationFrame(raf);
					raf = 0;
				}
			},
			/** Dati nuovi o misura nuova. s.rivela e s.migra fanno partire l'orologio delle animazioni. */
			scena(s) {
				scena = s;
				const t = clock();
				if (s.rivela) rivelaDa = t;
				if (s.migra) {
					migraDa = t;
					rivelaDa = t;
				}
				fondoSporco = true;
				istSporche = true;
				chiedi();
			},
			accendi(i) {
				acceso = i;
				chiedi();
			},
			/** Riduci movimento cambiato, o qualcosa da ridisegnare una volta. */
			ridisegna() {
				istSporche = true;
				chiedi();
			},
			chiudi() {
				clearTimeout(rilascioT);
				spegni();
			},
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

				<section class="crus-cielo" aria-labelledby="carta-titolo">
					<figure class="carta" id="carta">
						<div class="carta-testa" id="carta-testa"><h2 id="carta-titolo">Il cielo dei progetti</h2><p class="telemetria"><span id="carta-conto"></span><span class="motore" id="carta-motore"></span></p></div>
						<div class="carta-palco" id="carta-palco">
							<canvas class="carta-gpu" id="carta-gpu" aria-hidden="true"></canvas>
							<div class="carta-svg" id="carta-svg" aria-hidden="true"></div>
							<div class="scansione" aria-hidden="true"></div>
						</div>
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
			gpu: ['WebGPU su Metal', 'Il cielo lo disegna la scheda grafica con WebGPU, che sul Mac passa da Metal. I dati sono gli stessi della versione in SVG.'],
			avvio: ['accendo WebGPU', 'Sto accendendo la scheda grafica; intanto il cielo è in SVG.'],
			spento: ['SVG', 'La scheda grafica è stata liberata mentre la stanza era nascosta; torna quando il cielo si vede.'],
			svg: ['SVG', 'Il cielo è disegnato in SVG, con gli stessi dati.'],
		};
		const cielo = creaCielo(/** @type {any} */ ($('carta-gpu')), {
			reduced: () => !!reduced.matches,
			rilascio: host.rilascioGpu,
			onStato(s, motivo) {
				$('carta').classList.toggle('gpu', s === 'gpu');
				const [txt, why] = MOTORE[s] || MOTORE.svg;
				const m = $('carta-motore');
				m.textContent = txt;
				m.title = s === 'svg' && motivo ? `${why} WebGPU non è partito: ${motivo}.` : why;
				$('carta').setAttribute('data-motore', s);
			},
		});
		{
			const [txt, why] = MOTORE[cielo.stato] || MOTORE.svg;
			$('carta-motore').textContent = txt;
			$('carta-motore').title = cielo.stato === 'svg' ? `${why} Questa finestra non offre WebGPU.` : why;
			$('carta').setAttribute('data-motore', cielo.stato);
		}
		const attivaCielo = () => cielo.attiva(visible && !paused);
		if (typeof IntersectionObserver === 'function') {
			try {
				new IntersectionObserver(es => cielo.inVista(es.some(e => e.isIntersecting)), { rootMargin: '80px' }).observe($('carta-palco'));
			} catch {}
		}

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
			// la scansione accende le stelle mentre passa: ritardo in base all'altezza
			const ritardo = s => 0.1 + (s.y / S) * 1.2;

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

		// ---------- adesso e registro ----------

		function renderRegistro() {
			const t = now();
			const STATO = { busy: 'al lavoro', idle: 'ti aspetta', shell: 'nel terminale' };
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
			// le animazioni aspettano che la stanza si veda: disegnando di nascosto restano in attesa
			const tenute = visible ? null : { ...anim };
			if (tenute) for (const k of Object.keys(anim)) anim[/** @type {keyof typeof anim} */ (k)] = false;
			renderTesta();
			renderCarta();
			renderClassifica();
			renderCurva();
			renderToken();
			renderLato();
			renderCalore();
			renderRegistro();
			Object.assign(anim, tenute || { rivela: false, conta: false, grafici: false, glitch: false, migra: false });
		}

		function request(daAndrea) {
			richiesto = !!daAndrea;
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
			});

		// la lancetta segue l'ora; la casella di adesso nella settimana cambia allo scoccare dell'ora
		let orologio = 0;
		let oraVista = new Date().getHours();
		function batti() {
			if (!stats) return;
			metteLancetta();
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

	/** @type {any} */ (window).BottegaCruscotto = { mount };
})();
