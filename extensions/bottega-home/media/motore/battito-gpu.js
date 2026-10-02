// @ts-check
/* Bottega, il battito della memoria in WebGPU (sul Mac passa da Metal). Una griglia di 7 giorni per 24 ore:
   ogni cella e' quante cose la memoria ha imparato in quell'ora della settimana. Una sola scala, l'ambra della
   lampada della Bottega: piu' piena dove nascono piu' ricordi, con un bagliore che sfuma sulle celle vicine.

   Si muove poco e con senso: entrando le celle si accendono una dopo l'altra, una luce lenta scorre sulle ore
   come la lampada sul banco, la cella di adesso batte, quella sotto il mouse si accende. Il giro dei fotogrammi e'
   quello del motore condiviso (motore/gpu.js): fermo a stanza nascosta o fuori schermo, un fotogramma solo con
   Riduci movimento. Le etichette (giorni, ore) e il suggerimento restano HTML, nitidi; qui solo le celle.

   window.BottegaBattito.monta(canvas, { margine: {sx, su}, onFail }) ->
     { dati(ore: number[7][24], adesso: {giorno, ora}), colori({cella, piena, fondo}), sopra(indice|-1),
       attiva(on), inVista(on), distruggi() }
   Senza WebGPU chiama onFail(motivo) e chi ha montato disegna la sua griglia ferma. */
(function () {
	'use strict';
	const W = /** @type {any} */ (typeof window !== 'undefined' ? window : globalThis);
	if (W.BottegaBattito) return;

	const WGSL = /* wgsl */ `
struct U {
	// x, y: tela in pixel; z: tempo (s); w: entrata (s dal primo dato)
	t0: vec4f,
	// x, y: margine sinistro e alto in pixel; z: cella sotto il mouse (-1 nessuna); w: cella di adesso
	t1: vec4f,
	// colori: cella vuota, cella piena, fondo (rgb in luce lineare, a = movimento 0..1)
	vuota: vec4f,
	piena: vec4f,
	fondo: vec4f,
	// 168 valori 0..1, quattro per vec4
	v: array<vec4f, 42>,
};
@group(0) @binding(0) var<uniform> u: U;

struct FS { @builtin(position) p: vec4f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> FS {
	let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
	var o: FS;
	o.p = vec4f(xy, 0.0, 1.0);
	return o;
}

fn val(i: i32) -> f32 {
	if (i < 0 || i > 167) { return 0.0; }
	let q = u.v[i / 4];
	let k = i % 4;
	if (k == 0) { return q.x; }
	if (k == 1) { return q.y; }
	if (k == 2) { return q.z; }
	return q.w;
}

fn rett(p: vec2f, mezzo: vec2f, r: f32) -> f32 {
	let q = abs(p) - mezzo + vec2f(r);
	return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment fn fs(i: FS) -> @location(0) vec4f {
	let res = u.t0.xy;
	let t = u.t0.z;
	let entrata = u.t0.w;
	let moto = u.fondo.a;
	let g0 = u.t1.xy;
	let area = res - g0;
	let cw = area.x / 24.0;
	let ch = area.y / 7.0;
	let p = i.p.xy - g0;
	if (p.x < -cw || p.y < -ch) { return vec4f(0.0); }
	let col = i32(floor(p.x / cw));
	let row = i32(floor(p.y / ch));
	var luce = vec3f(0.0);
	var alfa = 0.0;

	// il bagliore delle celle vicine (due per lato): le ore piene illuminano il banco intorno
	for (var dy = -2; dy <= 2; dy++) {
		for (var dx = -2; dx <= 2; dx++) {
			let c = col + dx;
			let r = row + dy;
			if (c < 0 || c > 23 || r < 0 || r > 6) { continue; }
			let v = val(r * 24 + c);
			if (v <= 0.0) { continue; }
			let centro = vec2f((f32(c) + 0.5) * cw, (f32(r) + 0.5) * ch);
			let d = length((p - centro) / vec2f(cw, ch));
			let g = v * v * exp(-d * d * 1.6) * 0.22;
			luce += u.piena.rgb * g;
			alfa += g;
		}
	}

	if (col >= 0 && col < 24 && row >= 0 && row < 7) {
		let idx = row * 24 + col;
		let v = val(idx);
		let centro = vec2f((f32(col) + 0.5) * cw, (f32(row) + 0.5) * ch);
		// entrata: le celle si accendono una dopo l'altra, in diagonale
		let ritardo = (f32(col) + f32(row) * 2.0) * 0.028;
		let e = clamp((entrata - ritardo) / 0.45, 0.0, 1.0);
		let es = e * e * (3.0 - 2.0 * e);
		let mezzo = vec2f(cw, ch) * 0.5 - vec2f(1.5) - vec2f(1.0 - es) * min(cw, ch) * 0.2;
		let d = rett(p - centro, mezzo, min(4.0, min(cw, ch) * 0.25));
		let dentro = 1.0 - smoothstep(-0.6, 0.6, d);
		// la luce che scorre sulle ore, lenta: un giro ogni 9 secondi
		let fase = fract(t / 9.0) * 1.4 - 0.2;
		let x = (f32(col) + 0.5) / 24.0;
		let q = (x - fase) * 7.0;
		let onda = exp(-q * q) * moto;
		let liv = sqrt(v);
		var c = mix(u.vuota.rgb, u.piena.rgb, liv) * (1.0 + onda * (0.25 + 0.45 * liv));
		var a = mix(0.55, 1.0, liv) * es;
		// la cella sotto il mouse
		if (f32(idx) == u.t1.z) {
			c = mix(c, vec3f(1.0), 0.18);
			let bordo = 1.0 - smoothstep(0.0, 1.2, abs(d + 0.6));
			c = mix(c, u.piena.rgb * 1.3, bordo);
		}
		luce = mix(luce, c, dentro * a);
		alfa = max(alfa, dentro * a);
		// adesso: un battito, due colpi ravvicinati ogni 1,2 secondi, e un anello che si allarga
		if (f32(idx) == u.t1.w) {
			let b = fract(t / 1.2);
			let k1 = b / 0.07;
			let k2 = (b - 0.2) / 0.06;
			let colpo = (exp(-k1 * k1) + 0.6 * exp(-k2 * k2)) * moto;
			let anello = abs(d - b * min(cw, ch) * 0.5);
			let ring = (1.0 - smoothstep(0.0, 1.4, anello)) * (1.0 - b) * moto;
			let base = 1.0 - smoothstep(0.0, 1.0, abs(d + 0.5));
			luce += u.piena.rgb * (ring * 0.9 + colpo * 0.35 * dentro + base * 0.8);
			alfa = max(alfa, max(ring, base) * 0.9);
		}
	}
	// premoltiplicato: il bagliore puo' superare la copertura e schiarisce il fondo, come una luce
	return vec4f(luce, clamp(alfa, 0.0, 1.0));
}
`;

	/** sRGB 0..1 -> luce lineare. */
	const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
	function rgb(hex) {
		const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
		if (!m) return [0.5, 0.5, 0.5];
		const n = parseInt(m[1], 16);
		return [lin(((n >> 16) & 255) / 255), lin(((n >> 8) & 255) / 255), lin((n & 255) / 255)];
	}

	function monta(canvas, opt = {}) {
		const G = W.BottegaGPU;
		const margine = opt.margine || { sx: 34, su: 20 };
		const U = new Float32Array(4 * 5 + 168);
		let valori = new Float32Array(168);
		let adesso = -1;
		let sopraI = -1;
		let colori = { vuota: rgb('#1d2740'), piena: rgb('#f4ab3c'), fondo: rgb('#121a2e') };
		let nato = 0;
		let dev = null;
		let ctx = null;
		let pipe = null;
		let buf = null;
		let bg = null;
		let rotto = false;
		let preso = false;
		const fermo = () => !!(W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches);

		function fallisci(motivo) {
			if (rotto) return;
			rotto = true;
			distruggi();
			try {
				opt.onFail && opt.onFail(motivo);
			} catch (e) {
				console.error('Bottega: battito, onFail', e);
			}
		}
		if (!G) {
			setTimeout(() => fallisci('motore WebGPU non caricato'), 0);
			return { dati() {}, colori() {}, sopra() {}, attiva() {}, inVista() {}, distruggi() {} };
		}
		const officina = G.officina();
		const giro = G.ciclo({
			pronto: () => !!dev,
			// si muove sempre un poco (la luce, il battito); con Riduci movimento un fotogramma e basta
			mosso: () => !fermo(),
			vivace: t => t - nato < 2500,
			disegna,
			errore: e => fallisci(String((e && e.message) || e)),
		});

		async function avvia() {
			try {
				const r = await officina.prendi();
				preso = true;
				if (rotto) return officina.lascia();
				const c = canvas.getContext('webgpu');
				if (!c) throw new Error('la tela non da un contesto webgpu');
				c.configure({ device: r.device, format: r.format, alphaMode: 'premultiplied' });
				const mod = await G.modulo(r.device, WGSL, 'battito');
				pipe = await r.device.createRenderPipelineAsync({
					layout: 'auto',
					vertex: { module: mod, entryPoint: 'vs' },
					fragment: {
						module: mod,
						entryPoint: 'fs',
						targets: [{ format: r.format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }],
					},
					primitive: { topology: 'triangle-list' },
				});
				buf = r.device.createBuffer({ size: U.byteLength, usage: G.USO.UNIFORM | G.USO.COPY_DST });
				bg = r.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
				dev = r.device;
				ctx = c;
				giro.chiedi();
			} catch (e) {
				if (preso && !dev) officina.lascia();
				preso = false;
				fallisci(String((e && /** @type {any} */ (e).message) || e));
			}
		}
		officina.ascolta(motivo => fallisci(motivo));

		function disegna(t) {
			if (!dev || !ctx) return;
			const dpr = W.devicePixelRatio || 1;
			const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
			const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
			if (canvas.width !== w || canvas.height !== h) {
				canvas.width = w;
				canvas.height = h;
			}
			const moto = fermo() ? 0 : 1;
			U.set([w, h, t / 1000, moto ? (t - nato) / 1000 : 99], 0);
			U.set([margine.sx * dpr, margine.su * dpr, sopraI, adesso], 4);
			U.set([...colori.vuota, 1], 8);
			U.set([...colori.piena, 1], 12);
			U.set([...colori.fondo, moto], 16);
			U.set(valori, 20);
			dev.queue.writeBuffer(buf, 0, U);
			const enc = dev.createCommandEncoder();
			const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store' }] });
			pass.setPipeline(pipe);
			pass.setBindGroup(0, bg);
			pass.draw(3);
			pass.end();
			dev.queue.submit([enc.finish()]);
		}

		function distruggi() {
			giro.ferma();
			try {
				ctx && ctx.unconfigure && ctx.unconfigure();
			} catch {}
			try {
				buf && buf.destroy();
			} catch {}
			if (dev && preso) officina.lascia();
			dev = null;
			ctx = null;
			buf = null;
			preso = false;
		}

		const api = {
			/** @param {number[][]} ore 7 x 24 @param {{giorno: number, ora: number} | null} qui */
			dati(ore, qui) {
				const max = Math.max(1, ...ore.flat());
				const nuovi = new Float32Array(168);
				ore.forEach((riga, d) => riga.forEach((v, o) => (nuovi[d * 24 + o] = v / max)));
				const primo = !nato;
				valori = nuovi;
				adesso = qui ? qui.giorno * 24 + qui.ora : -1;
				if (primo) nato = G.clock();
				giro.chiedi();
			},
			colori(c) {
				colori = { vuota: rgb(c.vuota), piena: rgb(c.piena), fondo: rgb(c.fondo) };
				giro.chiedi();
			},
			sopra(i) {
				if (i === sopraI) return;
				sopraI = i;
				giro.chiedi();
			},
			/** Entrando di nuovo nella stanza le celle si riaccendono da capo. */
			attiva(on) {
				if (on && !dev && !rotto) void avvia();
				if (on) nato = G.clock();
				giro.attiva(on);
			},
			inVista(on) {
				giro.inVista(on);
			},
			distruggi,
		};
		return api;
	}

	W.BottegaBattito = { monta };
})();
