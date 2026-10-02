// @ts-check
/* Melissa dentro la Bottega: la vista laterale con la sua sfera. Prima la sfera galleggiava sullo
   schermo, sopra le altre app (e sopra la Melissa di Avo Agency AI); ora vive qui, nella barra
   laterale dell'IDE. Riceve lo stato dell'assistente ({type:'assistant', state}) e manda: converse,
   ask, open, voice.toggle. Contratto: docs/CONTRATTI.md, 4.8. */
(function () {
	const vscode = acquireVsCodeApi();
	const reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
	const root = /** @type {HTMLElement} */ (document.getElementById('sfera-vista'));
	root.innerHTML = `
		<button type="button" class="sfera-tasto" id="sfera-tasto" aria-pressed="false">
			<canvas id="sfera" aria-hidden="true"></canvas>
			<span class="sr" id="sfera-etichetta">Parla con Melissa</span>
		</button>
		<p class="sfera-stato" id="sfera-stato" aria-live="polite"></p>
		<p class="sfera-frase" id="sfera-frase"></p>
		<form class="sfera-chiedi" id="sfera-chiedi" autocomplete="off">
			<label class="sr" for="sfera-domanda">Scrivi a Melissa</label>
			<input id="sfera-domanda" type="text" placeholder="Scrivi a Melissa" spellcheck="false">
		</form>
		<p class="sfera-piede"><button type="button" class="sfera-link" id="sfera-apri">Apri la conversazione</button><button type="button" class="sfera-link" id="sfera-voce"></button></p>`;

	const orb = (() => {
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
		const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('sfera'));
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
			const css = canvas.clientWidth || 240;
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

		const running = () => !!ctx && !reduced.matches && document.visibilityState !== 'hidden';
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
				} else {
					this.sleep();
					snapTo();
					draw(); // un solo fotogramma fermo, con il colore giusto
				}
			},
			sleep() {
				if (handle) caf(handle);
				handle = 0;
			},
			redraw() {
				size = 0;
				if (!running()) draw();
			},
		};
	})();

	const WORD = { idle: 'Tocca la sfera per parlare', listening: 'Ti ascolto', thinking: 'Ci penso', speaking: 'Parlo', error: 'Qualcosa non va' };
	const el = id => /** @type {HTMLElement} */ (document.getElementById(id));

	function render(a) {
		const on = !!(a && a.enabled);
		const st = a ? (a.state === 'idle' && a.conversing ? 'listening' : a.state) : 'idle';
		orb.set(st, !on, a && a.level);
		const tasto = el('sfera-tasto');
		tasto.setAttribute('aria-pressed', String(!!(a && a.conversing)));
		tasto.classList.toggle('viva', !!(a && (a.conversing || a.state !== 'idle')));
		el('sfera-etichetta').textContent = a && a.conversing ? 'Chiudi la conversazione con Melissa' : 'Parla con Melissa';
		el('sfera-stato').textContent = !a ? '' : !on ? 'Melissa è spenta' : a.conversing && st === 'listening' ? 'In conversazione, ti ascolto' : WORD[st] || '';
		const log = (a && a.log) || [];
		el('sfera-frase').textContent = (a && a.partial) || (log.length ? log[log.length - 1].text : '');
		el('sfera-voce').textContent = on ? 'Spegni la voce' : 'Accendi la voce';
	}

	el('sfera-tasto').addEventListener('click', () => vscode.postMessage({ type: 'converse' }));
	el('sfera-apri').addEventListener('click', () => vscode.postMessage({ type: 'open' }));
	el('sfera-voce').addEventListener('click', () => vscode.postMessage({ type: 'voice.toggle' }));
	el('sfera-chiedi').addEventListener('submit', ev => {
		ev.preventDefault();
		const i = /** @type {HTMLInputElement} */ (el('sfera-domanda'));
		const text = i.value.trim();
		if (!text) return;
		vscode.postMessage({ type: 'ask', text });
		i.value = '';
	});
	window.addEventListener('message', ev => {
		const m = ev.data || {};
		if (m.type === 'assistant') render(m.state);
	});
	document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? orb.sleep() : orb.wake()));
	if (reduced.addEventListener) reduced.addEventListener('change', () => orb.wake());
	window.addEventListener('resize', () => orb.redraw());
	render(null);
	vscode.postMessage({ type: 'ready' });
})();
