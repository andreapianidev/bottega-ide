// @ts-check
/* Bottega, la sfera di Melissa su WebGPU (sul Mac passa da Metal). E' la sfera del Nucleo
   (nucleo/Sources/Orb/OrbShaders.metal + OrbRenderer.swift) portata in WGSL: un sole di plasma in
   raymarching con il nucleo volumetrico, la pelle granulosa, l'iridescenza sul bordo, la corona e i
   raggi, l'onda d'urto a ogni attacco della voce. Per una webview e' piu' leggera della nativa:
   niente particelle e niente bloom (l'alone e la corona li fa gia' lo shader), meno passi di marcia,
   la tela al massimo di 480 px. Il volume di rumore (Perlin e Worley, 96^3) lo calcola la GPU una
   volta sola, con uno shader di calcolo: in JS ci vorrebbe un secondo.

   window.BottegaSferaGPU.mount(canvas, opts) -> sfera
     opts: { reduced: MediaQueryList | () => boolean, zoom?: numero (1 la sfera col suo alone, 0,6 la
             sfera che riempie la tela), post?(msg) per la diagnosi all'estensione, onFail?(motivo) }
     sfera: { set(stato, spenta, livello), wake(), sleep(), redraw(), smonta(),
              motore ('webgpu'), stato ('spento' | 'avvio' | 'gpu' | 'rotto'), costo (ms), frames }
     stato: 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'; spenta: boolean (Nucleo assente
     o voce spenta: la sfera sbiadisce verso il grigio e poi si ferma); livello: 0..1 (la voce).
   `mount` lancia subito se WebGPU qui non c'e' (manca motore/gpu.js o navigator.gpu): la vista usa
   la sua sfera Canvas 2D. Se WebGPU cade dopo (nessun adattatore, shader rotto, dispositivo perso)
   chiama onFail(motivo) una volta: la vista sostituisce la tela (che ha gia' un contesto webgpu) e
   passa al Canvas 2D. Il motivo va sempre in console e, con opts.post, all'estensione come
   `{type: 'sfera.diag', motore, motivo, gpu, isSecureContext, crossOriginIsolated, userAgent}`.
   `set` non sveglia la sfera: e' la vista che decide con wake/sleep. Gira solo sveglia, sulla
   pagina, con il documento visibile; con Riduci movimento disegna un fotogramma per cambio.
   A sfera addormentata da 15 secondi la GPU si libera. Richiede motore/gpu.js, caricato prima. */
(function () {
	'use strict';
	const W = /** @type {any} */ (typeof window !== 'undefined' ? window : globalThis);

	const STATI = { idle: 0, listening: 1, thinking: 2, speaking: 3, error: 4 };
	/** Lato del volume di rumore, come nel Nucleo. */
	const DIM = 96;
	/** La tela al massimo di 480 px: oltre, il costo cresce e la sfera non migliora. */
	const MAX_PX = 480;

	/* Il volume di rumore, sulla GPU: r e a fbm di value noise (frequenze 6, 12, 24, 48), g e b Worley
	   a 8 e 16 celle. Stesse funzioni di OrbRenderer.makeRichNoise, stesso hash. */
	const WGSL_RUMORE = /* wgsl */ `
@group(0) @binding(0) var uscita: texture_storage_3d<rgba16float, write>;

fn hashF(x: i32, y: i32, z: i32, seme: i32) -> f32 {
	var n = u32(x) * 374761393u + u32(y) * 668265263u + u32(z) * 1274126177u + u32(seme) * 2246822519u;
	n = (n ^ (n >> 13u)) * 1274126177u;
	n = n ^ (n >> 16u);
	return f32(n & 0xFFFFFFu) / 16777215.0;
}

fn liscia(t: f32) -> f32 { return t * t * (3.0 - 2.0 * t); }

fn valore(f: vec3f, freq: i32, seme: i32) -> f32 {
	let q = f * f32(freq);
	let i = vec3i(floor(q));
	let t = q - floor(q);
	let s = vec3f(liscia(t.x), liscia(t.y), liscia(t.z));
	var c: array<f32, 8>;
	for (var k = 0; k < 8; k++) {
		let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
		let w = (i + o) % vec3i(freq);
		c[k] = hashF(w.x, w.y, w.z, seme);
	}
	let x00 = mix(c[0], c[1], s.x);
	let x10 = mix(c[2], c[3], s.x);
	let x01 = mix(c[4], c[5], s.x);
	let x11 = mix(c[6], c[7], s.x);
	return mix(mix(x00, x10, s.y), mix(x01, x11, s.y), s.z);
}

fn vfbm(f: vec3f, seme: i32) -> f32 {
	var v = 0.0;
	var a = 0.5;
	var freq = 6;
	for (var k = 0; k < 4; k++) {
		v += a * valore(f, freq, seme + k * 101);
		a *= 0.5;
		freq *= 2;
	}
	return v / 0.9375;
}

fn worley(f: vec3f, celle: i32, seme: i32) -> f32 {
	let q = f * f32(celle);
	let i = vec3i(floor(q));
	var f1 = 8.0;
	for (var dz = -1; dz <= 1; dz++) {
		for (var dy = -1; dy <= 1; dy++) {
			for (var dx = -1; dx <= 1; dx++) {
				let c = i + vec3i(dx, dy, dz);
				let w = ((c % vec3i(celle)) + vec3i(celle)) % vec3i(celle);
				let p = vec3f(c) + vec3f(hashF(w.x, w.y, w.z, seme), hashF(w.x, w.y, w.z, seme + 1), hashF(w.x, w.y, w.z, seme + 2));
				let d = p - q;
				f1 = min(f1, dot(d, d));
			}
		}
	}
	return sqrt(f1);
}

@compute @workgroup_size(4, 4, 4) fn cs_rumore(@builtin(global_invocation_id) id: vec3u) {
	if (id.x >= ${DIM}u || id.y >= ${DIM}u || id.z >= ${DIM}u) { return; }
	let f = (vec3f(id) + 0.5) / ${DIM}.0;
	textureStore(uscita, id, vec4f(vfbm(f, 1), 1.0 - min(worley(f, 8, 17), 1.0), 1.0 - min(worley(f, 16, 53), 1.0), vfbm(f, 91)));
}
`;

	/* La sfera: orb_fragment del Nucleo. Uniform come OrbUniforms, piu' p6.x = spenta (0..1). */
	const WGSL = /* wgsl */ `
struct U {
	p0: vec4f,
	p1: vec4f,
	p2: vec4f,
	p3: vec4f,
	p4: vec4f,
	p5: vec4f,
	spettro: array<vec4f, 4>,
	p6: vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var rumore: texture_3d<f32>;
@group(0) @binding(2) var campione: sampler;

const BANDE: i32 = 16;
const INV: f32 = 1.0 / 64.0;
const PI: f32 = 3.14159265;
const PASSI_FUORI: i32 = 56;
const PASSI_DENTRO: i32 = 20;

fn tex(x: vec3f) -> vec4f { return textureSampleLevel(rumore, campione, x * INV, 0.0); }
fn vn(x: vec3f) -> f32 { return tex(x).r; }

fn fbm3(p0: vec3f) -> f32 {
	var p = p0;
	var v = 0.0;
	var a = 0.5;
	for (var i = 0; i < 4; i++) {
		v += a * vn(p);
		p *= 2.02;
		a *= 0.5;
	}
	return v;
}

fn hash21(p0: vec2f) -> f32 {
	var p = fract(p0 * vec2f(127.31, 311.7));
	p += dot(p, p + 34.12);
	return fract(p.x * p.y);
}

fn rotY(p: vec3f, a: f32) -> vec3f {
	let s = sin(a);
	let c = cos(a);
	return vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

struct Spinta {
	tempo: f32,
	baseR: f32,
	amp: f32,
	vortice: f32,
	bassi: f32,
	medi: f32,
	verso: f32,
	rivela: f32,
};

fn spostamento(dir: vec3f, d: Spinta) -> f32 {
	let sp = rotY(dir, d.tempo * d.vortice);
	let q = sp * 2.0 + d.verso * d.tempo * 0.18;
	let ordito = fbm3(q * 0.7 + d.tempo * 0.10);
	let n = fbm3(q + ordito);
	var h = (n - 0.5) * 2.0 * d.amp;
	let theta = acos(clamp(dir.y, -1.0, 1.0));
	let phi = atan2(dir.z, dir.x);
	let onda = d.verso * d.tempo * 1.6;
	h += d.bassi * 0.11 * sin(3.0 * phi + onda) * sin(2.0 * theta);
	h += d.medi * 0.06 * sin(6.0 * phi - onda * 1.3 + n * 4.0) * sin(4.0 * theta);
	return h * d.rivela;
}

fn mappa(pos: vec3f, d: Spinta) -> f32 {
	let dir = normalize(pos + vec3f(1e-5));
	return length(pos) - (d.baseR + spostamento(dir, d));
}

fn normale(pos: vec3f, d: Spinta) -> vec3f {
	let e = 0.012;
	let k = vec2f(1.0, -1.0);
	return normalize(k.xyy * mappa(pos + k.xyy * e, d) + k.yyx * mappa(pos + k.yyx * e, d) + k.yxy * mappa(pos + k.yxy * e, d) + k.xxx * mappa(pos + k.xxx * e, d));
}

fn banda(i: i32) -> f32 {
	let v = u.spettro[i >> 2u];
	return v[i & 3];
}

// la tavolozza di Melissa; l'errore e' il sodio della Bottega
fn tavolozza(s: i32) -> vec3f {
	let acqua = vec3f(0.26, 0.74, 1.0);
	let verdeacqua = vec3f(0.16, 0.86, 0.86);
	let viola = vec3f(0.6, 0.38, 0.98);
	let verde = vec3f(0.42, 0.88, 0.52);
	let sodio = vec3f(0.905, 0.402, 0.045);
	if (s == 1) { return mix(acqua, verdeacqua, 0.6); }
	if (s == 2) { return mix(acqua, viola, 0.55); }
	if (s == 3) { return mix(verde, acqua, 0.3); }
	if (s == 4) { return sodio; }
	return acqua;
}

fn ruotaTinta(c: vec3f, a: f32) -> vec3f {
	let k = vec3f(0.57735027);
	let ca = cos(a);
	let sa = sin(a);
	return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}

fn alone(pr: f32, R: f32, guadagno: f32, forte: f32) -> f32 {
	return (exp(-max(pr - R, 0.0) * 7.0) * 0.55 + exp(-max(pr - R, 0.0) * 2.6) * 0.28) * guadagno * (0.65 + 0.6 * forte);
}

fn densita(pos: vec3f, tempo: f32, verso: f32) -> f32 {
	var q = rotY(pos, tempo * 0.10 * verso);
	q.y -= tempo * 0.12 * verso;
	let w = vec3f(tex(q + 11.5).a, tex(q + 47.2).a, tex(q + 83.1).a) - 0.5;
	let qq = q + w * 1.6;
	let d = fbm3(qq * 1.7 + tempo * 0.15 * verso);
	let g = tex(qq * 2.3).g;
	return clamp(d * 0.75 + g * 0.35, 0.0, 1.5);
}

fn emissione(x0: f32, base: vec3f) -> vec3f {
	let x = clamp(x0, 0.0, 1.0);
	let fredda = base * 0.5;
	let calda = mix(base, vec3f(1.0), 0.85);
	let c = mix(fredda, base, smoothstep(0.0, 0.5, x));
	return mix(c, calda, smoothstep(0.5, 1.0, x));
}

fn ricciolo(p: vec3f) -> vec3f {
	let e = 2.0;
	let oX = vec3f(0.0, 31.1, 0.0);
	let oY = vec3f(17.3, 0.0, 11.7);
	let oZ = vec3f(5.2, 23.9, 41.3);
	let x0 = tex(p + oX).a;
	let y0 = tex(p + oY).a;
	let z0 = tex(p + oZ).a;
	let pzy = tex(p + vec3f(0.0, e, 0.0) + oZ).a;
	let pyz = tex(p + vec3f(0.0, 0.0, e) + oY).a;
	let pxz = tex(p + vec3f(0.0, 0.0, e) + oX).a;
	let pzx = tex(p + vec3f(e, 0.0, 0.0) + oZ).a;
	let pyx = tex(p + vec3f(e, 0.0, 0.0) + oY).a;
	let pxy = tex(p + vec3f(0.0, e, 0.0) + oX).a;
	return vec3f((pzy - z0) - (pyz - y0), (pxz - x0) - (pzx - z0), (pyx - y0) - (pxy - x0)) / e;
}

fn rilievo(p: vec3f, freq: f32) -> vec3f {
	let e = 0.06;
	let dx = vn((p + vec3f(e, 0.0, 0.0)) * freq) - vn((p - vec3f(e, 0.0, 0.0)) * freq);
	let dy = vn((p + vec3f(0.0, e, 0.0)) * freq) - vn((p - vec3f(0.0, e, 0.0)) * freq);
	let dz = vn((p + vec3f(0.0, 0.0, e)) * freq) - vn((p - vec3f(0.0, 0.0, e)) * freq);
	return vec3f(dx, dy, dz) / (2.0 * e);
}

fn aSrgb(c: f32) -> f32 {
	let x = clamp(c, 0.0, 1.0);
	return select(1.055 * pow(x, 1.0 / 2.4) - 0.055, 12.92 * x, x <= 0.0031308);
}

struct VF { @builtin(position) pos: vec4f };

@vertex fn vs_pieno(@builtin(vertex_index) i: u32) -> VF {
	var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
	var o: VF;
	o.pos = vec4f(p[i], 0.0, 1.0);
	return o;
}

@fragment fn fs_sfera(v: VF) -> @location(0) vec4f {
	let res = max(u.p0.xy, vec2f(1.0));
	let uv = vec2f(v.pos.x / res.x, 1.0 - v.pos.y / res.y);
	let tempo = u.p0.z;
	let st = i32(u.p1.x + 0.5);
	let prima = i32(u.p1.y + 0.5);
	let smix = clamp(u.p1.z, 0.0, 1.0);
	let forte = clamp(u.p1.w, 0.0, 1.5);
	let attacco = clamp(u.p2.x, 0.0, 1.0);
	let impulso = u.p2.z;
	let rivela = clamp(u.p2.w, 0.0, 1.0);
	let spenta = clamp(u.p6.x, 0.0, 1.0);

	let sole = normalize(u.p3.xyz);
	let tepore = clamp(u.p3.w, 0.0, 1.0);
	let luceChiave = mix(vec3f(0.80, 0.86, 1.00), vec3f(1.00, 0.74, 0.46), tepore);
	let ambiente = u.p4.xyz;
	let notte = clamp(u.p4.w, 0.0, 1.0);

	var p = uv * 2.0 - 1.0;
	p.x *= res.x / res.y;
	let zoom = select(1.0, u.p5.x, u.p5.x > 0.0);
	p *= zoom;

	// la sfera vaga piano (di piu' quando e' calma)
	let vaga = select(0.014, 0.030, st == 0);
	let deriva = vec2f(fbm3(vec3f(tempo * 0.06, 3.0, 0.0)) - 0.5, fbm3(vec3f(0.0, tempo * 0.06, 7.0)) - 0.5);
	p -= deriva * vaga;
	let pr = length(p);

	var bassi = 0.0;
	var medi = 0.0;
	var acuti = 0.0;
	for (var i = 0; i < 4; i++) { bassi += banda(i); }
	for (var i = 4; i < 10; i++) { medi += banda(i); }
	for (var i = 10; i < BANDE; i++) { acuti += banda(i); }
	bassi /= 4.0;
	medi /= 6.0;
	acuti /= 6.0;

	// un battito sotto la soglia: e' sempre viva
	let cuore = pow(0.5 + 0.5 * sin(tempo * 6.3), 6.0) * 0.6 + pow(0.5 + 0.5 * sin(tempo * 6.3 - 0.7), 6.0) * 0.3;
	let respiro = 0.5 + 0.5 * sin(select(tempo * 1.1, u.p5.z, u.p5.w > 0.5));
	var d: Spinta;
	d.tempo = tempo;
	d.bassi = bassi;
	d.medi = medi;
	d.baseR = 0.46;
	d.amp = 0.05;
	d.vortice = 0.10;
	d.verso = 1.0;
	d.rivela = rivela;
	var nucleo = 1.0;
	var guadagno = 1.0;
	var flusso = 0.0;

	if (st == 0) {
		d.baseR += 0.018 * respiro;
		d.amp = 0.075 + 0.018 * respiro;
		d.vortice = 0.16;
		flusso = 0.50 + 0.14 * respiro;
		guadagno = 1.02 + 0.10 * respiro;
		nucleo = 1.09;
	} else if (st == 1) {
		d.baseR += 0.020 + 0.050 * forte;
		d.amp = 0.050 + 0.050 * forte + 0.04 * bassi;
		d.vortice = 0.16;
		d.verso = -1.0;
		flusso = 0.45 + 0.55 * forte;
		guadagno = 0.90 + 0.50 * forte;
		nucleo = 1.00 + 0.30 * forte;
	} else if (st == 2) {
		d.baseR += 0.015 * sin(tempo * 2.0);
		d.amp = 0.070;
		d.vortice = 1.10;
	} else if (st == 4) {
		let tremito = 0.5 + 0.5 * sin(tempo * 9.0 + 2.0 * sin(tempo * 3.1));
		d.baseR += -0.012 + 0.008 * respiro;
		d.amp = 0.055;
		d.vortice = 0.06;
		flusso = 0.30;
		guadagno = 0.80 + 0.22 * tremito;
		nucleo = 0.95;
	} else {
		let scoppio = pow(forte, 0.6);
		d.baseR += 0.030 + 0.100 * scoppio + 0.020 * sin(tempo * 7.0) * scoppio;
		d.amp = 0.060 + 0.050 * scoppio + 0.04 * medi;
		d.vortice = 0.50;
		flusso = 0.40 + 0.60 * scoppio;
		guadagno = 1.10 + 0.80 * scoppio;
		nucleo = 1.10 + 0.50 * scoppio;
	}

	d.baseR += cuore * 0.012 + impulso * 0.05;
	guadagno += cuore * 0.08 + attacco * 0.45;
	flusso += attacco * 0.5;

	var base = mix(tavolozza(prima), tavolozza(st), smix);
	let tinta = 0.42 * sin(tempo * 0.060) + 0.18 * sin(tempo * 0.017 + 2.1);
	var quanto = 0.55;
	if (st == 0) { quanto = 1.0; } else if (st == 2) { quanto = 0.85; } else if (st == 4) { quanto = 0.12; }
	base = ruotaTinta(base, tinta * quanto);
	if (st == 1 || st == 3) {
		let energia = clamp(forte * 0.70 + medi * 0.55 + bassi * 0.35, 0.0, 1.0);
		let luma = dot(base, vec3f(0.2126, 0.7152, 0.0722));
		base = max(mix(vec3f(luma), base, 1.0 + 0.45 * energia), vec3f(0.0));
		base = ruotaTinta(base, (energia - 0.30) * 0.55 * select(-1.0, 1.0, st == 3));
	}
	// spenta: il colore va verso il grigio della notte, la luce cala
	base = mix(base, vec3f(0.16, 0.18, 0.24), spenta * 0.7);
	guadagno *= 1.0 - 0.6 * spenta;
	nucleo *= 1.0 - 0.6 * spenta;

	let ro = vec3f(p, 2.5);
	let rd = vec3f(0.0, 0.0, -1.0);
	let R = d.baseR;
	let maxR = R + 0.24;
	let pxMondo = 2.0 * zoom / res.y;

	var col = vec3f(0.0);
	var alfa = 0.0;

	if (pr < maxR) {
		let zIn = sqrt(max(0.0, maxR * maxR - pr * pr));
		var t = 2.5 - zIn;
		var preso = false;
		var minimo = 1e9;
		var pos = ro + rd * t;
		for (var i = 0; i < PASSI_FUORI; i++) {
			pos = ro + rd * t;
			let dist = mappa(pos, d);
			minimo = min(minimo, dist);
			if (dist < 0.0012) { preso = true; break; }
			t += dist * 0.8;
			if (pos.z < -maxR) { break; }
		}

		if (preso) {
			var N = normale(pos, d);
			let campo = ricciolo(pos * 5.5 + vec3f(0.0, tempo * 0.10, 0.0));
			let fp = pos + campo * 0.12;
			var b = rilievo(fp, 9.0) + rilievo(fp, 22.0) * 0.5;
			b -= N * dot(b, N);
			N = normalize(N - b * (0.11 * rivela));

			let V = vec3f(0.0, 0.0, 1.0);
			let L = sole;
			let diff = clamp(dot(N, L), 0.0, 1.0);
			let fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
			let H = normalize(L + V);
			let ndh = clamp(dot(N, H), 0.0, 1.0);
			let spec = pow(ndh, 64.0) + 0.20 * pow(ndh, 12.0);

			let dir = normalize(pos);
			let rip = 0.5 + 0.5 * sin(pr * 15.0 - d.verso * tempo * 5.0);
			let ang = atan2(dir.y, dir.x);
			let bi = i32((ang / (2.0 * PI) + 0.5) * f32(BANDE)) & (BANDE - 1);
			let eq = banda(bi);
			let centrale = smoothstep(R, 0.0, pr);

			let profondo = base * 0.22;
			var corpo = mix(profondo, base, diff * 0.85 + 0.15);
			corpo *= mix(vec3f(1.0), luceChiave, 0.45);
			corpo += base * mix(ambiente, base, 0.5) * (N.y * 0.5 + 0.5) * 0.10;
			corpo += base * rip * flusso * 0.22;
			corpo += base * centrale * nucleo * 0.22;
			corpo += luceChiave * spec * (0.45 + 0.25 * nucleo);

			// il nucleo di plasma: una marcia dentro la sfera, con la convezione di un sole
			var rdr = refract(rd, N, 0.86);
			if (dot(rdr, rdr) < 1e-4) { rdr = rd; }
			let passo = (2.0 * R) / f32(PASSI_DENTRO);
			let scarto = hash21(uv * res + tempo * 60.0);
			var vp = pos + rdr * (0.02 + scarto * passo);
			var plasma = vec3f(0.0);
			var trasp = 1.0;
			for (var j = 0; j < PASSI_DENTRO; j++) {
				vp += rdr * passo;
				if (mappa(vp, d) > 0.015) { break; }
				let rr = length(vp);
				let cuoreV = smoothstep(R, 0.0, rr);
				var dens = densita(vp, tempo, d.verso);
				dens = pow(dens, 1.3) * (0.30 + 1.30 * cuoreV);
				let temp = clamp(dens * (0.55 + 0.9 * cuoreV) + 0.15 * cuore, 0.0, 1.0);
				plasma += emissione(temp, base) * dens * trasp * passo * 6.0;
				trasp *= exp(-dens * passo * 5.5);
				if (trasp < 0.02) { break; }
			}
			corpo += plasma * (0.6 + 0.5 * nucleo);

			// iridescenza sottile sul bordo
			let film = 2.4 + 1.7 * vn(fp * 5.0 + tempo * 0.08);
			let irid = 0.5 + 0.5 * cos(6.2831853 * (fres * film + tempo * 0.05 + vec3f(0.0, 0.33, 0.66)));
			let bordo = mix(base, vec3f(1.0), 0.55);
			corpo += bordo * fres * (1.0 + guadagno) * (0.85 + 0.6 * eq + 0.35 * acuti);
			corpo += irid * fres * (0.30 + 0.18 * rivela);

			let pelle = fbm3(fp * 9.0 + tempo * 0.05);
			corpo *= 0.92 + 0.16 * pelle * rivela;
			let granulo = mix(tex(fp * 3.0).g, tex(fp * 7.0 + vec3f(0.0, tempo * 0.04, 0.0)).g, 0.4);
			corpo *= mix(1.0, 0.82 + 0.40 * granulo, rivela);
			corpo += base * smoothstep(0.6, 0.95, granulo) * 0.12 * (0.6 + nucleo) * rivela;
			let fil = fbm3(dir * 6.0 + vec3f(0.0, tempo * 0.30, 0.0));
			let prom = smoothstep(0.62, 0.92, fil) * pow(fres, 1.5);
			corpo += emissione(0.85, base) * prom * (0.5 + 1.6 * attacco + 0.8 * forte) * rivela;
			let scint = fbm3(pos * 26.0 - tempo * 0.6);
			let tw = 0.5 + 0.5 * sin(tempo * 3.0 + scint * 28.0);
			let lampo = smoothstep(0.74, 0.9, scint) * (0.35 + 0.65 * fres) * (0.30 + 0.70 * tw * tw);
			corpo += luceChiave * lampo * (0.6 + 0.5 * guadagno) * rivela;
			let avvolge = clamp((dot(N, L) + 0.35) / 1.35, 0.0, 1.0);
			let retro = pow(clamp(dot(V, -L), 0.0, 1.0), 2.0);
			corpo += base * (retro + 0.45 * avvolge) * (1.0 - centrale) * (0.18 + 0.12 * tepore);

			// bordo che scurisce e cromosfera
			let ndv = clamp(dot(N, V), 0.0, 1.0);
			corpo *= mix(0.72, 1.0, pow(ndv, 0.55));
			let cromo = smoothstep(0.16, 0.0, ndv) * smoothstep(0.0, 0.05, ndv);
			corpo += emissione(0.92, base) * cromo * (1.1 + 0.6 * guadagno);

			col = corpo;
			alfa = 1.0;
		} else {
			let cop = 1.0 - smoothstep(0.0, 1.6 * pxMondo, minimo);
			if (cop > 0.0) {
				col = mix(base, vec3f(1.0), 0.55) * (0.9 + guadagno);
				alfa = cop;
			}
		}
	}

	// alone morbido
	let h = alone(pr, R, guadagno * (1.0 - 0.25 * notte), forte);
	col += base * h;
	alfa = max(alfa, h);

	// corona e raggi lunghi, accesi per angolo dalla banda della voce
	let cang = atan2(p.y, p.x);
	let fuori = max(pr - R, 0.0);
	let cbi = i32((cang / (2.0 * PI) + 0.5) * f32(BANDE)) & (BANDE - 1);
	let ceq = banda(cbi);
	let cn1 = fbm3(vec3f(cang * 2.5, pr * 3.0, tempo * 0.25));
	let cn2 = fbm3(vec3f(cang * 5.0, pr * 1.5, -tempo * 0.17));
	let s1 = pow(0.5 + 0.5 * sin(cang * 18.0 + tempo * 0.80 + cn1 * 6.2831853), 3.0);
	let s2 = pow(0.5 + 0.5 * sin(cang * 41.0 - tempo * 0.55 + cn2 * 6.2831853), 5.0);
	let corona = (s1 + 0.6 * s2) * exp(-fuori * 4.0) * (0.05 + 0.10 * forte + 0.18 * attacco) * (1.0 - 0.6 * spenta);
	col += emissione(0.7, base) * corona;
	alfa = max(alfa, corona * 0.6);
	let rN = pow(0.5 + 0.5 * sin(cang * 9.0 + cn1 * 4.0 + tempo * 0.22), 6.0);
	let raggi = rN * exp(-fuori * 1.05) * (0.020 + 0.075 * ceq + 0.26 * attacco + 0.10 * forte) * smoothstep(0.0, 0.05, fuori);
	col += emissione(0.80, base) * raggi * rivela;
	alfa = max(alfa, raggi * 0.5);

	// l'onda d'urto a ogni attacco della voce
	if (attacco > 0.01) {
		let eta = 1.0 - attacco;
		let rad = R + eta * 0.95;
		let largo = 0.020 + 0.055 * eta;
		let anello = exp(-pow((pr - rad) / largo, 2.0));
		let svan = attacco * attacco;
		col += emissione(0.95, base) * anello * svan * 0.85;
		alfa = max(alfa, anello * svan * 0.5);
	}

	// tutto a zero prima del bordo della tela: l'alone non mostra mai un quadrato
	let margine = 1.0 - smoothstep(0.80, 0.99, max(abs(uv.x * 2.0 - 1.0), abs(uv.y * 2.0 - 1.0)));
	col *= margine;
	alfa *= margine;

	// Reinhard esteso che conserva la luminanza. La tela e' a 8 bit, senza il margine EDR del Nucleo:
	// un'esposizione un po' piu' bassa tiene i colori pieni invece di sbiancarli, poi si codifica sRGB
	col *= 0.62;
	let Lc = max(dot(col, vec3f(0.2126, 0.7152, 0.0722)), 1e-4);
	let Lw = 2.6;
	let Lt = Lc * (1.0 + Lc / (Lw * Lw)) / (1.0 + Lc);
	col *= Lt / Lc;
	col += (hash21(uv * res + tempo) - 0.5) * (1.0 / 255.0);
	let a = clamp(alfa, 0.0, 1.0);
	let s = vec3f(aSrgb(col.r), aSrgb(col.g), aSrgb(col.b));
	return vec4f(s * a, a);
}
`;

	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {any} G window.BottegaGPU
	 * @param {any} officina
	 * @param {{ reduced: () => boolean, zoom: number, post: ((m: any) => void) | null, onFail?: (motivo: string) => void }} opt
	 */
	function creaSfera(canvas, G, officina, opt) {
		const { modulo, USO, clock } = G;
		let stato = 'spento';
		let gen = 0;
		/** @type {any} */ let dev = null;
		/** @type {any} */ let ctx = null;
		/** @type {any} */ let r = null;
		let sveglia = false;
		let rilascioT = 0;
		let diagInviata = false;
		// lo stato dell'assistente, come lo dice la vista
		let bersaglio = 0;
		let spentaVuole = 0;
		let livello = 0;
		// la dinamica di OrbRenderer.encodeFrame: molle, impulso, attacchi, dissolvenza di 0,35 s
		const t0 = clock();
		let tPrima = 0;
		let statoOra = 0;
		let statoPrima = 0;
		let cambioDa = -1e9;
		let fortePos = 0, forteVel = 0;
		let impPos = 0, impVel = 0;
		let attacco = 0;
		let livelloPrima = 0;
		let rivela = 0;
		let spenta = 0;
		const spettro = new Float32Array(16);
		// p0..p5 (24) + spettro (16) + p6 (4): 176 byte
		const U = new Float32Array(44);
		const luce = (() => {
			const l = Math.hypot(0.45, 0.65, 0.85);
			return [0.45 / l, 0.65 / l, 0.85 / l];
		})();

		function diag(motore, motivo) {
			if (diagInviata || !opt.post) return;
			diagInviata = true;
			try {
				opt.post(G.diagnosi('sfera.diag', motore, motivo));
			} catch {}
		}

		function cambia(s) {
			stato = s;
		}

		function libera() {
			if (!r) return;
			for (const b of [r.ubuf, r.vol]) {
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
			libera();
			try {
				ctx && ctx.unconfigure && ctx.unconfigure();
			} catch {}
			if (avevo) officina.lascia();
		}

		function rompi(motivo) {
			if (stato === 'rotto') return;
			console.warn('Bottega: sfera senza WebGPU, ripiego sul Canvas 2D:', motivo);
			spegni();
			stato = 'rotto';
			diagInviata = false;
			diag('canvas', motivo);
			try {
				if (opt.onFail) opt.onFail(motivo);
			} catch (e) {
				console.error('Bottega: sfera, onFail', e);
			}
		}
		officina.ascolta(motivo => rompi(motivo));

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
				const [modR, mod] = await Promise.all([modulo(d, WGSL_RUMORE, 'WGSL del rumore della sfera'), modulo(d, WGSL, 'WGSL della sfera')]);
				const [pRumore, pSfera] = await Promise.all([
					d.createComputePipelineAsync({ layout: 'auto', compute: { module: modR, entryPoint: 'cs_rumore' } }),
					d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: mod, entryPoint: 'vs_pieno' }, fragment: { module: mod, entryPoint: 'fs_sfera', targets: [{ format }] }, primitive: { topology: 'triangle-list' } }),
				]);
				if (g !== gen) {
					officina.lascia();
					return;
				}
				// il volume di rumore, una volta: 96^3 su gruppi di 4^3
				const vol = d.createTexture({ size: [DIM, DIM, DIM], dimension: '3d', format: 'rgba16float', usage: USO.STORAGE_TEX | USO.TEXTURE });
				const enc = d.createCommandEncoder();
				const cp = enc.beginComputePass();
				cp.setPipeline(pRumore);
				cp.setBindGroup(0, d.createBindGroup({ layout: pRumore.getBindGroupLayout(0), entries: [{ binding: 0, resource: vol.createView() }] }));
				cp.dispatchWorkgroups(DIM / 4, DIM / 4, DIM / 4);
				cp.end();
				d.queue.submit([enc.finish()]);
				const ubuf = d.createBuffer({ size: U.byteLength, usage: USO.UNIFORM | USO.COPY_DST });
				const samp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
				const bg = d.createBindGroup({
					layout: pSfera.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: { buffer: ubuf } },
						{ binding: 1, resource: vol.createView() },
						{ binding: 2, resource: samp },
					],
				});
				const c = canvas.getContext('webgpu');
				if (!c) throw new Error('la tela non da un contesto webgpu');
				c.configure({ device: d, format, alphaMode: 'premultiplied' });
				r = { pSfera, ubuf, vol, bg };
				dev = d;
				ctx = c;
				rivela = opt.reduced() ? 1 : 0;
				cambia('gpu');
				diag('webgpu', '');
				giro.chiedi();
			} catch (e) {
				if (preso && !dev) officina.lascia();
				if (g !== gen) return;
				rompi(String((e && /** @type {any} */ (e).message) || e));
			}
		}

		/** Un passo della dinamica; fermi (Riduci movimento) tutto va subito allo stato finale. */
		function avanza(t, mosso) {
			const ora = t / 1000;
			let dt = tPrima ? (t - tPrima) / 1000 : 1 / 30;
			tPrima = t;
			dt = Math.min(Math.max(dt, 1 / 240), 0.05);
			if (bersaglio !== statoOra) {
				statoPrima = statoOra;
				statoOra = bersaglio;
				cambioDa = ora;
				impVel += 7;
			}
			if (!mosso) {
				cambioDa = -1e9;
				fortePos = livello;
				forteVel = 0;
				impPos = impVel = 0;
				attacco = 0;
				rivela = 1;
				spenta = spentaVuole;
				for (let i = 0; i < 16; i++) spettro[i] = livello * (1 - i / 20);
				return;
			}
			const sale = Math.max(0, livello - livelloPrima);
			livelloPrima += (livello - livelloPrima) * 0.5;
			forteVel += (130 * (livello - fortePos) - 17 * forteVel) * dt;
			fortePos = Math.max(0, fortePos + forteVel * dt);
			impVel += (95 * (0 - impPos) - 8 * impVel) * dt;
			impPos += impVel * dt;
			attacco = Math.max(attacco * (1 - Math.min(1, dt * 7)), Math.min(1, sale * 2.5));
			rivela = Math.min(1, rivela + dt * 1.25);
			spenta += (spentaVuole - spenta) * (1 - Math.exp(-dt * 4));
			// niente analisi dello spettro nella webview: bande sintetiche dal livello della voce
			const tt = (t - t0) / 1000;
			for (let i = 0; i < 16; i++) {
				const v = Math.min(1, livello * (1 - i / 20) * (0.75 + 0.25 * Math.sin(tt * 5 + i * 1.7)));
				spettro[i] += (v - spettro[i]) * (v > spettro[i] ? 0.55 : 0.22);
			}
		}

		function disegna(t, mosso) {
			const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
			const cssW = canvas.clientWidth || 240;
			const px = Math.max(16, Math.min(MAX_PX, Math.round(cssW * dpr)));
			if (canvas.width !== px || canvas.height !== px) {
				canvas.width = px;
				canvas.height = px;
			}
			avanza(t, mosso);
			const ora = t / 1000;
			const tSec = mosso ? (t - t0) / 1000 : 12;
			const mix = mosso ? Math.min(1, Math.max(0, (ora - cambioDa) / 0.35)) : 1;
			const rs = rivela * rivela * (3 - 2 * rivela);
			U.set([px, px, tSec, livello], 0);
			U.set([statoOra, statoPrima, mix, Math.min(fortePos, 1.5)], 4);
			U.set([attacco, 0, impPos, rs], 8);
			U.set([luce[0], luce[1], luce[2], 0.35], 12);
			U.set([0.1, 0.16, 0.26, 0.5], 16);
			U.set([opt.zoom, 0, tSec * 1.1, 1], 20);
			U.set(spettro, 24);
			U.set([spenta, 0, 0, 0], 40);
			dev.queue.writeBuffer(r.ubuf, 0, U.buffer, 0, U.byteLength);
			const enc = dev.createCommandEncoder();
			const p = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
			p.setPipeline(r.pSfera);
			p.setBindGroup(0, r.bg);
			p.draw(3);
			p.end();
			dev.queue.submit([enc.finish()]);
		}

		const giro = G.ciclo({
			pronto: () => !!dev && !!r,
			mosso: () => !opt.reduced(),
			// 30 fotogrammi mentre parla, ascolta, pensa o cambia stato; 20 a riposo
			vivace: t => bersaglio !== 0 || t / 1000 - cambioDa < 1 || Math.abs(spenta - spentaVuole) > 0.02,
			// spenta, si ferma appena ha finito di sbiadire
			continua: () => !(spentaVuole === 1 && spenta > 0.98),
			disegna,
			errore: e => rompi(String((e && /** @type {any} */ (e).message) || e)),
		});

		/** @type {IntersectionObserver | null} */ let osserva = null;
		if (typeof IntersectionObserver === 'function') {
			try {
				osserva = new IntersectionObserver(es => giro.inVista(es.some(e => e.isIntersecting)));
				osserva.observe(canvas);
			} catch {}
		}

		return {
			get motore() {
				return 'webgpu';
			},
			get stato() {
				return stato;
			},
			get costo() {
				return giro.costo;
			},
			get frames() {
				return giro.frames;
			},
			get inCorsa() {
				return giro.inCorsa;
			},
			/** Stato dell'assistente. Non sveglia la sfera: se e' sveglia, il cambio si vede subito. */
			set(st, spentaOra, liv) {
				const b = STATI[/** @type {keyof typeof STATI} */ (st)] ?? 0;
				const s = spentaOra ? 1 : 0;
				const cambiato = b !== bersaglio || s !== spentaVuole;
				bersaglio = b;
				spentaVuole = s;
				livello = Math.max(0, Math.min(1, Number(liv) || 0));
				if (cambiato || bersaglio === 3 || bersaglio === 1) giro.chiedi();
			},
			wake() {
				if (stato === 'rotto') return;
				sveglia = true;
				clearTimeout(rilascioT);
				giro.attiva(true);
				if (!dev) avvia();
			},
			sleep() {
				sveglia = false;
				giro.attiva(false);
				clearTimeout(rilascioT);
				rilascioT = setTimeout(() => {
					if (sveglia || !dev) return;
					spegni();
					cambia('spento');
				}, G.RILASCIO_MS);
			},
			/** Misura cambiata o un fotogramma da rifare. */
			redraw() {
				giro.chiedi();
			},
			smonta() {
				sveglia = false;
				clearTimeout(rilascioT);
				spegni();
				if (osserva) osserva.disconnect();
			},
		};
	}

	W.BottegaSferaGPU = {
		/**
		 * @param {HTMLCanvasElement} canvas
		 * @param {{ reduced?: any, zoom?: number, post?: (m: any) => void, onFail?: (motivo: string) => void }} [opts]
		 */
		mount(canvas, opts = {}) {
			const G = W.BottegaGPU;
			const post = typeof opts.post === 'function' ? opts.post : null;
			const manca = motivo => {
				console.warn('Bottega: sfera senza WebGPU, resta il Canvas 2D:', motivo);
				if (post && G) {
					try {
						post(G.diagnosi('sfera.diag', 'canvas', motivo));
					} catch {}
				}
				throw new Error(motivo);
			};
			if (!G) return manca("il motore condiviso (motore/gpu.js) non e' caricato");
			const officina = G.officina();
			if (!officina.disponibile) return manca(officina.motivo || 'questa finestra non offre WebGPU');
			const red = opts.reduced;
			const reduced = typeof red === 'function' ? red : () => !!(red && red.matches);
			return creaSfera(canvas, G, officina, { reduced, zoom: Number(opts.zoom) > 0 ? Number(opts.zoom) : 1, post, onFail: opts.onFail });
		},
	};
})();
