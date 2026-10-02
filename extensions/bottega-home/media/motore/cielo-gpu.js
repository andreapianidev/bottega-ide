// @ts-check
/* Bottega, il cielo dei progetti su WebGPU (sul Mac passa da Metal). Montato dal cruscotto
   (cruscotto.js) sopra la sua tela: disegna solo decorazione e luce, tutti i dati restano nell'SVG
   sopra (nomi, prese, tabella). L'estetica e' quella del cielo nativo dell'Osservatorio
   (nucleo/Sources/Motore/SkyShaders.metal): stelle con alone e punte di diffrazione che respirano,
   onde e scie delle sessioni vive, impulsi di luce lungo i legami, una ghiera che gira lentissima.

   window.BottegaCieloGPU.mount(canvas, opts) -> motore
     opts: { reduced: MediaQueryList | () => boolean, rilascio?: ms (GPU liberata a vista nascosta),
             onStato?(stato) ('spento' | 'avvio' | 'gpu'), onFail?(motivo) }
     motore: { stato, frames, costo, inCorsa, attiva(on), inVista(on), scena(s), accendi(i),
               ridisegna(), chiudi() }
   `mount` lancia subito se WebGPU qui non c'e' (manca motore/gpu.js, manca navigator.gpu): chi monta
   passa alla sua tela 2D. Se WebGPU cade dopo (nessun adattatore, shader rotto, dispositivo perso)
   chiama onFail(motivo) una volta e smette di disegnare. Richiede motore/gpu.js, caricato prima. */
(function () {
	'use strict';
	const W = /** @type {any} */ (typeof window !== 'undefined' ? window : globalThis);

	const oraAdesso = () => {
		const d = new Date();
		return d.getHours() + d.getMinutes() / 60;
	};
	const facile = k => 1 - Math.pow(1 - k, 3);

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
	d: vec4f,
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
	@location(4) px: vec2f,
	@location(5) @interpolate(flat) e: vec4f,
};

fn ruota(v: vec2f, a: f32) -> vec2f {
	let c = cos(a);
	let s = sin(a);
	return vec2f(v.x * c - v.y * s, v.x * s + v.y * c);
}

fn tipoE(t: f32, n: f32) -> bool { return abs(t - n) < 0.5; }

// respiro lento di una stella, sfasato per indice (lo stesso calcolo della tela 2D)
fn respiro(i: f32, tempo: f32) -> f32 {
	return 1.0 + 0.13 * sin(tempo * (0.38 + 0.22 * fract(i * 0.618)) + i * 2.399);
}

@vertex fn vs_luce(@builtin(vertex_index) vi: u32, i: VI) -> VS {
	var angoli = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
	let k = angoli[vi];
	let tempo = u.a.z;
	let riv = u.a.w;
	let acceso = u.c.x;
	let mosso = u.d.x;
	let giro = u.d.y;
	let tipo = i.a.w;
	var centro = i.a.xy;
	var lato = i.a.z;
	var col = i.col;
	var x = 0.0;
	var e = vec4f(0.0, 0.0, 0.0, 0.0);
	// il quadratino si allunga lungo asse di lungo volte (impulsi dei legami, tacche della ghiera)
	var asse = vec2f(1.0, 0.0);
	var lungo = 1.0;
	var p = vec2f(0.0, 0.0);
	if (tipoE(tipo, 0.0)) {
		// campo di fondo: scintilla, gira piano attorno al centro, si accende dal centro all'arrivo
		centro = u.b.xy + ruota(i.a.xy - u.b.xy, giro * 0.5);
		col.a *= (0.7 + 0.3 * sin(tempo * i.c.z + i.c.w)) * smoothstep(i.d.z, i.d.z + 0.5, riv);
	} else if (tipoE(tipo, 1.0) || tipoE(tipo, 5.0)) {
		let on = smoothstep(i.d.z, i.d.z + 0.7, riv);
		let r = mix(1.0, respiro(i.d.x, tempo), mosso);
		col.a *= on * r;
		lato *= mix(0.3, 1.0, on) * (1.0 + (r - 1.0) * 0.6);
		if (acceso >= 0.0) {
			if (abs(i.d.x - acceso) < 0.5) { lato *= 1.2; } else { col.a *= 0.32; }
		}
	} else if (tipoE(tipo, 2.0)) {
		// l'onda di una sessione viva: si allarga e si spegne ogni 2,8 secondi
		let f = fract(tempo / 2.8 + i.c.w);
		x = f;
		lato *= 0.85 + 0.6 * f;
		col.a *= (1.0 - f) * smoothstep(i.d.z, i.d.z + 0.7, riv);
		if (acceso >= 0.0 && abs(i.d.x - acceso) > 0.5) { col.a *= 0.32; }
	} else if (tipoE(tipo, 3.0)) {
		// impulso di luce lungo un legame, da una stella all'altra
		let f = fract(tempo * i.c.z + i.c.w);
		let d = i.c.xy - i.a.xy;
		asse = d / max(length(d), 0.001);
		lungo = 3.2;
		centro = mix(i.a.xy, i.c.xy, f);
		col.a *= sin(f * 3.14159265) * smoothstep(i.d.z, i.d.z + 0.8, riv);
		if (acceso >= 0.0) {
			if (abs(i.d.x - acceso) < 0.5 || abs(i.d.y - acceso) < 0.5) { col.a = min(1.0, col.a * 1.5); } else { col.a *= 0.15; }
		}
	} else if (tipoE(tipo, 6.0)) {
		// la scia di una sessione viva: un arco sulla sua orbita, alle sue spalle
		let s = i.c.xy - u.b.xy;
		let rs = max(length(s), 1.0);
		let L = clamp(i.c.z / rs, 0.2, 1.1);
		let th = atan2(s.x, -s.y) - L * 0.5;
		centro = u.b.xy + vec2f(sin(th), -cos(th)) * rs;
		lato = rs * L * 0.5 + 10.0;
		e = vec4f(s, L, rs);
		col.a *= smoothstep(i.d.z, i.d.z + 0.7, riv);
		if (acceso >= 0.0 && abs(i.d.x - acceso) > 0.5) { col.a *= 0.32; }
	} else if (tipoE(tipo, 7.0)) {
		// la ghiera: tacche fuori dal quadrante che girano lentissime (decorazione, nessun dato)
		let a = i.c.x + giro;
		let rad = vec2f(sin(a), -cos(a));
		centro = u.b.xy + rad * i.c.y;
		asse = rad;
		lungo = i.c.z;
		col.a *= smoothstep(i.d.z, i.d.z + 0.8, riv);
	}
	if (tipoE(tipo, 4.0)) {
		let A = i.a.xy;
		let B = i.c.xy;
		let dir = normalize(B - A);
		let nor = vec2f(-dir.y, dir.x);
		p = A + dir * ((k.x * 0.5 + 0.5) * length(B - A)) + nor * (k.y * lato);
		x = select(-1.0, fract(tempo / 4.0), u.c.z > 0.5);
	} else {
		let nor = vec2f(-asse.y, asse.x);
		p = centro + asse * (k.x * lato * lungo) + nor * (k.y * lato);
	}
	var o: VS;
	o.pos = vec4f(p.x / u.a.x * 2.0 - 1.0, 1.0 - p.y / u.a.y * 2.0, 0.0, 1.0);
	o.uv = k;
	o.col = col;
	o.tipo = tipo;
	o.x = x;
	o.px = p;
	o.e = e;
	return o;
}

@fragment fn fs_luce(v: VS) -> @location(0) vec4f {
	let r = length(v.uv);
	var a = 0.0;
	var rgb = v.col.rgb;
	if (tipoE(v.tipo, 0.0)) {
		a = exp(-r * r * 6.0);
	} else if (tipoE(v.tipo, 1.0)) {
		let nucleo = exp(-r * r * 34.0);
		let alone = exp(-r * r * 7.0) * 0.42 + exp(-r * 5.0) * 0.1;
		let raggi = (exp(-abs(v.uv.y) * 70.0) + exp(-abs(v.uv.x) * 70.0)) * pow(max(0.0, 1.0 - r), 2.5) * 0.5;
		a = nucleo + alone + raggi;
		rgb = mix(rgb, vec3f(1.0, 0.98, 0.93), clamp(nucleo * 1.3 + raggi * 0.4, 0.0, 1.0));
	} else if (tipoE(v.tipo, 2.0)) {
		let d = (r - 0.82) * 12.0;
		a = exp(-d * d);
	} else if (tipoE(v.tipo, 3.0)) {
		// testa luminosa davanti, coda che sfuma all'indietro lungo il legame
		let t = v.uv.x;
		let testa = exp(-(t - 0.55) * (t - 0.55) * 28.0);
		let coda = select(0.0, exp((t - 0.55) * 1.6) * 0.5, t < 0.55);
		a = (testa + coda) * exp(-v.uv.y * v.uv.y * 6.0);
		rgb = mix(rgb, vec3f(0.86, 1.0, 0.98), testa * 0.55);
	} else if (tipoE(v.tipo, 4.0)) {
		let lungoL = v.uv.x * 0.5 + 0.5;
		a = exp(-v.uv.y * v.uv.y * 9.0) * (0.25 + 0.75 * lungoL);
		if (v.x >= 0.0) {
			let s = lungoL - v.x;
			a += exp(-s * s * 400.0) * exp(-v.uv.y * v.uv.y * 4.0) * 0.9;
		}
	} else if (tipoE(v.tipo, 5.0)) {
		let d = (r - 0.32) * 16.0;
		a = exp(-d * d) * 0.9;
	} else if (tipoE(v.tipo, 6.0)) {
		// f: 0 sulla stella, 1 in fondo alla scia; la scia si allarga e ondeggia allontanandosi
		let q = v.px - u.b.xy;
		var dietro = atan2(v.e.x, -v.e.y) - atan2(q.x, -q.y);
		dietro -= 6.2831853 * floor(dietro / 6.2831853);
		let f = dietro / v.e.z;
		let largo = 1.1 + 1.8 * f;
		let fuori = length(q) - v.e.w;
		let onda = 0.72 + 0.28 * sin(f * 16.0 - u.a.z * 3.2);
		a = exp(-fuori * fuori / (largo * largo)) * exp(-f * 2.4) * smoothstep(0.0, 0.05, f) * (1.0 - smoothstep(0.8, 1.0, f)) * onda;
	} else {
		a = (1.0 - smoothstep(0.55, 1.0, abs(v.uv.x))) * exp(-v.uv.y * v.uv.y * 2.5);
	}
	let al = clamp(a * v.col.a, 0.0, 1.0);
	return vec4f(rgb * al, al);
}
`;

	/** Colori della luce (rgb lineari 0..1, la cupola resta notte anche nel tema chiaro). Gli stessi della tela 2D in cruscotto.js. */
	const LUCE = {
		campo: [0.91, 0.886, 0.816],
		stella: [0.96, 0.7, 0.34],
		calima: [0.91, 0.886, 0.816],
		sodio: [0.957, 0.671, 0.235],
		ciano: [0.39, 0.9, 0.86],
	};
	const FLOAT_ISTANZA = 16; // 4 vec4f per quadratino
	/** La ghiera fuori dal quadrante fa un giro ogni quarto d'ora (il campo di fondo a meta' velocita'). */
	const GIRO = (2 * Math.PI) / 900;
	/** Tacche della ghiera: una ogni 3,75 gradi, una lunga ogni otto. */
	const TACCHE = 96;
	/** Quanto e' lunga la scia di una sessione viva, in px lungo la sua orbita. */
	const SCIA_PX = 95;

	/**
	 * Il motore. Stati: 'spento' (GPU libera), 'avvio', 'gpu', 'rotto' (WebGPU caduto: onFail e' gia'
	 * stato chiamato, non si riprova in questo montaggio).
	 * @param {HTMLCanvasElement} canvas
	 * @param {any} G window.BottegaGPU
	 * @param {any} officina
	 * @param {{ reduced: () => boolean, onStato?: (stato: string) => void, onFail?: (motivo: string) => void, rilascio?: number }} opt
	 */
	function creaCielo(canvas, G, officina, opt) {
		const { modulo, USO, clock } = G;
		const rilascio = opt.rilascio ?? G.RILASCIO_MS;

		let stato = 'spento';
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
		const t0 = clock();
		let rivelaDa = -1e9;
		let migraDa = -1e9;
		let acceso = -1;
		let minuto = -1;
		let rilascioT = 0;
		// a, b, c, d (16 float) + 24 ore: 160 byte
		const U = new Float32Array(40);

		function cambia(s) {
			stato = s;
			try {
				if (opt.onStato) opt.onStato(s);
			} catch (e) {
				console.error('Bottega: cielo, stato', e);
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
			giro.ferma();
			const avevo = !!dev;
			dev = null;
			liberaRisorse();
			try {
				ctx && ctx.unconfigure && ctx.unconfigure();
			} catch {}
			if (avevo) officina.lascia();
		}

		/** Qualcosa e' andato storto: chi ha montato passa alla sua tela, qui non si riprova. */
		function ripiego(motivo) {
			if (stato === 'rotto') return;
			console.warn('Bottega: cielo senza WebGPU, ripiego:', motivo);
			spegni();
			stato = 'rotto';
			try {
				if (opt.onFail) opt.onFail(motivo);
			} catch (e) {
				console.error('Bottega: cielo, onFail', e);
			}
		}

		async function avvia() {
			if (stato === 'rotto' || stato === 'avvio' || dev) return;
			const g = ++gen;
			cambia('avvio');
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
				const mod = await modulo(d, WGSL, 'WGSL');
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
					officina.lascia();
					return;
				}
				const ubuf = d.createBuffer({ size: U.byteLength, usage: USO.UNIFORM | USO.COPY_DST });
				r = { format, pFondo, pCopia, pLuce, ubuf, ibuf: null, icap: 0, tex: null, texW: 0, texH: 0, bgFondo: null, bgCopia: null, bgLuce: null };
				r.bgFondo = d.createBindGroup({ layout: pFondo.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
				r.bgLuce = d.createBindGroup({ layout: pLuce.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
				dev = d;
				ctx = c;
				fondoSporco = true;
				istSporche = true;
				cambia('gpu');
				giro.chiedi();
			} catch (e) {
				if (preso && !dev) officina.lascia();
				if (g !== gen) return;
				ripiego(String((e && /** @type {any} */ (e).message) || e));
			}
		}
		officina.ascolta(motivo => ripiego(motivo));

		/* il giro dei fotogrammi: 30 al secondo mentre succede qualcosa, 20 a riposo, fermo a vista
		   nascosta o fuori schermo, un fotogramma solo con Riduci movimento */
		const giro = G.ciclo({
			pronto: () => !!dev && !!r && !!scena,
			mosso: () => !opt.reduced(),
			vivace: t => t - rivelaDa < 3500 || t - migraDa < 1000 || acceso >= 0,
			disegna,
			errore: e => ripiego(String((e && /** @type {any} */ (e).message) || e)),
		});
		const chiedi = () => giro.chiedi();

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
			const tot = s.campo.length + s.stelle.length + vive * 2 + parti.length + 1 + TACCHE;
			if (ist.length < tot * FLOAT_ISTANZA) ist = new Float32Array(Math.ceil(tot * 1.5) * FLOAT_ISTANZA);
			let o = 0;
			const metti = (x, y, lato, tipo, c, a, cx, cy, cz, cw, d0, d1, d2, d3) => {
				ist.set([x, y, lato, tipo, c[0], c[1], c[2], a, cx, cy, cz, cw, d0, d1, d2, d3], o);
				o += FLOAT_ISTANZA;
			};
			// all'arrivo dei dati anche il campo si accende dal centro verso il bordo
			for (const [x, y, rr, op, ph, w] of s.campo) metti(x, y, rr * 3.2, 0, LUCE.campo, Math.min(0.9, op * 2.2), 0, 0, w, ph, -1, -1, s.rivela ? 0.05 + (Math.hypot(x - s.c, y - s.c) / s.R) * 1.1 : -1, 0);
			// la ghiera
			for (let j = 0; j < TACCHE; j++) {
				const lunga = j % 8 === 0;
				metti(0, 0, 0.9, 7, LUCE.ciano, lunga ? 0.42 : 0.2, (j / TACCHE) * 2 * Math.PI, s.R + 35, lunga ? 3.6 / 0.9 : 2 / 0.9, 0, -1, -1, s.rivela ? 0.2 : -1, 0);
			}
			s.stelle.forEach((st, j) => {
				const [x, y] = pos[j];
				if (st.altrove) metti(x, y, st.size * 1.75, 5, LUCE.calima, 0.95, 0, 0, 0, 0, st.i, -1, st.ritardo, 0);
				else metti(x, y, st.size * 3.2, 1, LUCE.stella, 1, 0, 0, 0, 0, st.i, -1, st.ritardo, 0);
			});
			s.stelle.forEach((st, j) => {
				if (!st.vivo) return;
				const [x, y] = pos[j];
				metti(x, y, 0, 6, LUCE.sodio, 0.6, x, y, SCIA_PX, 0, st.i, -1, st.ritardo, 0);
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
			U[12] = mosso ? 1 : 0;
			U[13] = mosso ? ((t - t0) / 1000) * GIRO : 0;
			U[14] = 0;
			U[15] = 0;
			for (let i = 0; i < 24; i++) U[16 + i] = s.ore[i] || 0;
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
		}

		return {
			get stato() {
				return stato;
			},
			get frames() {
				return giro.frames;
			},
			get inCorsa() {
				return giro.inCorsa;
			},
			/** Costo medio di un fotogramma in ms, lato processore (preparazione e invio). */
			get costo() {
				return giro.costo;
			},
			/** Vista visibile (stanza aperta, finestra davanti) oppure no. */
			attiva(on) {
				if (stato === 'rotto') return;
				attivo = !!on;
				giro.attiva(attivo);
				clearTimeout(rilascioT);
				if (attivo) {
					if (!dev) avvia();
					return;
				}
				rilascioT = setTimeout(() => {
					if (attivo || !dev) return;
					spegni();
					cambia('spento');
				}, rilascio);
			},
			/** La carta e' sullo schermo o fuori, scorrendo la pagina. */
			inVista(on) {
				giro.inVista(on);
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

	W.BottegaCieloGPU = {
		/**
		 * @param {HTMLCanvasElement} canvas
		 * @param {{ reduced?: any, rilascio?: number, onStato?: (stato: string) => void, onFail?: (motivo: string) => void }} [opts]
		 */
		mount(canvas, opts = {}) {
			const G = W.BottegaGPU;
			if (!G) throw new Error('il motore condiviso (motore/gpu.js) non e\' caricato');
			const officina = G.officina();
			if (!officina.disponibile) throw new Error(officina.motivo || 'questa finestra non offre WebGPU');
			const red = opts.reduced;
			const reduced = typeof red === 'function' ? red : () => !!(red && red.matches);
			return creaCielo(canvas, G, officina, { reduced, rilascio: opts.rilascio, onStato: opts.onStato, onFail: opts.onFail });
		},
	};
})();
