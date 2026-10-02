// @ts-check
/* Bottega, il motore WebGPU condiviso delle webview. Sul Mac WebGPU passa da Metal: e' il modo di
   usare Metal dentro l'IDE. Lo usano il cielo del cruscotto (motore/cielo-gpu.js), la corrente del
   lavoro in parallelo (cruscotto.js) e la sfera di Melissa (motore/sfera-gpu.js).

   Cosa offre (window.BottegaGPU):
   - officina(): UN solo adattatore e UN solo dispositivo per webview, condiviso. Si apre col primo
     che lo chiede e si chiude quando l'ultimo lo lascia (a vista nascosta la GPU resta libera). Se
     l'adattatore manca o il dispositivo si perde, resta chiusa e dice perche' (`motivo`).
   - modulo(device, wgsl, nome): compila dentro uno scope di errori. Un errore di uno shader ferma
     solo chi lo compila, non tutti quelli che condividono il dispositivo.
   - ciclo({...}): il giro dei fotogrammi. 30 al secondo mentre succede qualcosa, 20 a riposo, 15 se
     un fotogramma costa troppo; fermo a vista nascosta, fuori schermo, a documento nascosto; con
     Riduci movimento un fotogramma solo. Misura il costo medio per fotogramma.
   - diagnosi(tipo, motore, motivo): il messaggio per l'estensione (`cielo.diag`, `sfera.diag`): quale
     motore disegna e perche'. Chi ha l'API di VS Code lo spedisce; qui non la si chiede, perche'
     acquireVsCodeApi() si puo' chiamare una volta sola per webview. */
(function () {
	'use strict';
	const W = /** @type {any} */ (typeof window !== 'undefined' ? window : globalThis);
	if (W.BottegaGPU) return;

	const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
	const G0 = /** @type {any} */ (globalThis);
	const USO = {
		UNIFORM: G0.GPUBufferUsage ? G0.GPUBufferUsage.UNIFORM : 0x40,
		COPY_DST: G0.GPUBufferUsage ? G0.GPUBufferUsage.COPY_DST : 0x08,
		VERTEX: G0.GPUBufferUsage ? G0.GPUBufferUsage.VERTEX : 0x20,
		STORAGE: G0.GPUBufferUsage ? G0.GPUBufferUsage.STORAGE : 0x80,
		RENDER: G0.GPUTextureUsage ? G0.GPUTextureUsage.RENDER_ATTACHMENT : 0x10,
		TEXTURE: G0.GPUTextureUsage ? G0.GPUTextureUsage.TEXTURE_BINDING : 0x04,
		TEX_COPY_DST: G0.GPUTextureUsage ? G0.GPUTextureUsage.COPY_DST : 0x02,
		STORAGE_TEX: G0.GPUTextureUsage ? G0.GPUTextureUsage.STORAGE_BINDING : 0x08,
	};
	/** Dopo quanto la GPU si libera a vista nascosta: tornarci subito non riaccende tutto. */
	const RILASCIO_MS = 15_000;
	/** Fotogrammi al secondo: 30 mentre succede qualcosa, 20 a riposo, 15 se un fotogramma costa troppo. */
	const FPS_VIVO = 30;
	const FPS_QUIETO = 20;
	const FPS_LENTO = 15;
	const COSTO_TROPPO_MS = 8;
	const fpsPer = (vivace, costo) => (costo > COSTO_TROPPO_MS ? FPS_LENTO : vivace ? FPS_VIVO : FPS_QUIETO);

	/**
	 * Compila un modulo WGSL dentro uno scope di errori. Senza scope un errore di compilazione arriva
	 * al dispositivo come `uncapturederror`, e l'officina, che il dispositivo lo condivide, spegne
	 * tutti: e' successo nella build 15, una parola riservata (`meta`) nello shader della corrente
	 * mandava all'SVG anche il cielo. Lo scope si apre e si chiude senza attese in mezzo, cosi' i due
	 * motori, che partono insieme, non si scambiano gli errori.
	 */
	async function modulo(d, code, nome) {
		const scope = typeof d.pushErrorScope === 'function' && typeof d.popErrorScope === 'function';
		if (scope) d.pushErrorScope('validation');
		const mod = d.createShaderModule({ code });
		const errore = scope ? d.popErrorScope() : null;
		if (mod.getCompilationInfo) {
			const info = await mod.getCompilationInfo();
			const err = (info.messages || []).find(m => m.type === 'error');
			if (err) throw new Error(`${nome}, riga ${err.lineNum}: ${err.message}`);
		}
		const e = errore ? await errore.catch(() => null) : null;
		if (e) throw new Error(`${nome}: ${String(e.message || e).split('\n')[0]}`);
		return mod;
	}

	/**
	 * L'officina: un solo dispositivo WebGPU (su Mac passa da Metal) per tutta la webview, condiviso dal
	 * cielo, dalla corrente del lavoro in parallelo e dalla sfera di Melissa. Si apre col primo che lo
	 * chiede e si chiude quando l'ultimo lo lascia: a vista nascosta la GPU resta libera. Se
	 * l'adattatore manca, o il dispositivo si perde, l'officina resta chiusa per questa webview e chi
	 * ascolta passa al suo ripiego (Canvas 2D, SVG).
	 */
	function creaOfficina() {
		const gpu = typeof navigator !== 'undefined' && /** @type {any} */ (navigator).gpu;
		/** @type {any} */ let dev = null;
		/** @type {Promise<any> | null} */ let attesa = null;
		let format = '';
		let utenti = 0;
		let rotta = gpu ? '' : 'questa finestra non offre WebGPU';
		/** @type {Set<(motivo: string) => void>} */ const ascoltatori = new Set();

		function rompi(motivo) {
			if (rotta) return;
			rotta = motivo;
			const d = dev;
			dev = null;
			attesa = null;
			utenti = 0;
			try {
				d && d.destroy();
			} catch {}
			for (const f of [...ascoltatori]) {
				try {
					f(motivo);
				} catch (e) {
					console.error('Bottega: cruscotto, officina', e);
				}
			}
		}

		async function apri() {
			const adapter = await gpu.requestAdapter({ powerPreference: 'low-power' });
			if (!adapter) throw new Error('nessun adattatore WebGPU');
			// i timestamp, se l'adattatore li ha: la sfera ci misura il proprio costo di GPU (costoGpu)
			const tempi = adapter.features && adapter.features.has && adapter.features.has('timestamp-query');
			const d = await adapter.requestDevice(tempi ? { requiredFeatures: ['timestamp-query'] } : undefined);
			d.lost.then(info => {
				if (dev === d) rompi(`dispositivo perso${info && info.message ? ': ' + info.message : ''}`);
			});
			if (d.addEventListener) d.addEventListener('uncapturederror', e => dev === d && rompi(String((e && e.error && e.error.message) || 'errore della GPU')));
			format = gpu.getPreferredCanvasFormat();
			dev = d;
			return d;
		}

		return {
			get disponibile() {
				return !rotta;
			},
			/** Perche' l'officina e' chiusa ('' se e' aperta o non ancora provata). */
			get motivo() {
				return rotta;
			},
			/** @returns {Promise<{ device: any, format: string }>} */
			async prendi() {
				if (rotta) throw new Error(rotta);
				utenti++;
				try {
					if (!dev) await (attesa = attesa || apri());
					if (rotta || !dev) throw new Error(rotta || 'WebGPU spento');
					return { device: dev, format };
				} catch (e) {
					utenti = Math.max(0, utenti - 1);
					attesa = null;
					if (!rotta) rotta = String((e && /** @type {any} */ (e).message) || e);
					throw e;
				}
			},
			lascia() {
				utenti = Math.max(0, utenti - 1);
				if (utenti || !dev) return;
				const d = dev;
				dev = null;
				attesa = null;
				try {
					d.destroy();
				} catch {}
			},
			/** @param {(motivo: string) => void} f */
			ascolta(f) {
				ascoltatori.add(f);
			},
		};
	}

	/** @type {ReturnType<typeof creaOfficina> | null} */ let unica = null;
	const documentoNascosto = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

	/**
	 * Il giro dei fotogrammi di un motore.
	 * @param {{ disegna: (t: number, mosso: boolean) => void, mosso: () => boolean, pronto: () => boolean,
	 *   errore: (e: any) => void, vivace?: (t: number) => boolean, continua?: () => boolean }} o
	 */
	function ciclo(o) {
		let raf = 0;
		let ultimo = 0;
		let attivo = false;
		let inVista = true;
		let costo = 0;
		let frames = 0;
		const puo = () => attivo && inVista && !documentoNascosto() && o.pronto();
		function chiedi() {
			if (raf || !puo()) return;
			raf = requestAnimationFrame(passo);
		}
		function ferma() {
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
		}
		function passo(ts) {
			raf = 0;
			if (!puo()) return;
			const mosso = o.mosso();
			const t = clock();
			if (mosso && ultimo && ts - ultimo < 1000 / fpsPer(o.vivace ? o.vivace(t) : false, costo) - 2) {
				raf = requestAnimationFrame(passo);
				return;
			}
			ultimo = ts;
			try {
				o.disegna(t, mosso);
			} catch (e) {
				return o.errore(e);
			}
			frames++;
			const ms = clock() - t;
			costo = costo ? costo * 0.9 + ms * 0.1 : ms;
			if (mosso && (!o.continua || o.continua())) raf = requestAnimationFrame(passo);
		}
		if (typeof document !== 'undefined')
			document.addEventListener('visibilitychange', () => {
				if (documentoNascosto()) ferma();
				else chiedi();
			});
		return {
			chiedi,
			ferma,
			/** Vista visibile (stanza aperta, finestra davanti) oppure no. */
			attiva(on) {
				attivo = !!on;
				if (attivo) chiedi();
				else ferma();
			},
			/** La tela e' sullo schermo o fuori, scorrendo la pagina. */
			inVista(on) {
				inVista = !!on;
				if (inVista) chiedi();
				else ferma();
			},
			get attivo() {
				return attivo;
			},
			get costo() {
				return costo;
			},
			get frames() {
				return frames;
			},
			get inCorsa() {
				return !!raf;
			},
		};
	}

	/** Il messaggio di diagnosi per l'estensione: quale motore disegna e perche'. */
	function diagnosi(tipo, motore, motivo) {
		const nav = /** @type {any} */ (typeof navigator !== 'undefined' ? navigator : {});
		return { type: tipo, motore, motivo: motivo || '', gpu: !!nav.gpu, isSecureContext: !!G0.isSecureContext, crossOriginIsolated: !!G0.crossOriginIsolated, userAgent: String(nav.userAgent || '') };
	}

	W.BottegaGPU = {
		officina: () => unica || (unica = creaOfficina()),
		modulo,
		ciclo,
		diagnosi,
		fpsPer,
		clock,
		USO,
		RILASCIO_MS,
	};
})();
