// @ts-check
/* Servizi: crediti e consumi, una sezione del Cruscotto (CONTRATTI 14).
   Montata da cruscotto.js dentro #conti-sez: window.BottegaConti.mount(el, host) -> { set(conti), render(), mostra() }.
   host: { post(msg), periodo() -> '7'|'30'|'90', claude() -> valore a listino di Claude Code nel periodo o null }.
   I dati sono ~/.bottega/conti/giorni.json, letti dall'estensione (src/conti.ts) e mandati col messaggio "conti".
   SVG scritto a mano come il resto del Cruscotto; ogni grafico ha la sua tabella. */
(function () {
	'use strict';

	const SPESE = [
		['deepseek', 'DeepSeek'],
		['openrouter', 'OpenRouter'],
		['deleghe', 'Claude, deleghe'],
	];
	const GIORNO = 86_400_000;

	const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
	const dollari = n => `${Number(n || 0).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
	const intero = n => Number(n || 0).toLocaleString('it-IT');
	const chiave = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	const giornoBreve = k => `${Number(k.slice(8, 10))}/${Number(k.slice(5, 7))}`;
	const giornoLungo = k => new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10))).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
	const speso = (g, id) => (id === 'deleghe' ? g.deleghe?.usd : g[id]?.speso) || 0;

	/** Un passo "tondo" per l'asse: 1, 2 o 5 per una potenza di dieci. */
	function passo(max, n) {
		const grezzo = max / n;
		const p = Math.pow(10, Math.floor(Math.log10(grezzo || 1)));
		for (const m of [1, 2, 5, 10]) if (grezzo <= m * p) return m * p;
		return 10 * p;
	}

	function mount(el, host) {
		/** @type {any} */ let conti = null;
		let aperta = false;

		el.innerHTML = `
			<div class="sez-testa"><h2 id="conti-titolo">Servizi: crediti e consumi</h2><button type="button" class="ghost" data-conti="aggiorna">Aggiorna i saldi</button></div>
			<p class="nota" id="conti-nota">Sto leggendo i saldi dei servizi.</p>
			<dl class="cifre conti-cifre" id="conti-cifre"></dl>
			<div class="sez-testa"><h3 id="conti-spesa-titolo">Spesa per giorno</h3><ul class="legenda" id="conti-legenda"></ul></div>
			<div class="grafico" id="conti-spesa" role="img"></div>
			<div class="sez-testa"><h3 id="conti-voce-titolo">Voce di Melissa, caratteri per giorno</h3></div>
			<div class="grafico" id="conti-voce" role="img"></div>
			<p class="nota" id="conti-piede"></p>
			<div class="tabella-blocco" id="conti-tabella"></div>`;
		const $ = id => /** @type {any} */ (el.querySelector('#' + id));

		el.addEventListener('click', e => {
			const b = /** @type {any} */ (e.target).closest('[data-conti]');
			if (!b) return;
			if (b.dataset.conti === 'aggiorna') {
				$('conti-nota').textContent = 'Rileggo i saldi.';
				host.post({ type: 'conti.request', aggiorna: true });
			} else if (b.dataset.conti === 'tabella') {
				aperta = !aperta;
				render();
			}
		});

		/** I giorni del periodo, dal piu' vecchio, anche quelli senza dati (barre vuote). */
		function giorni() {
			const n = Number(host.periodo()) || 30;
			const out = [];
			const oggi = new Date();
			for (let i = n - 1; i >= 0; i--) {
				const k = chiave(new Date(oggi.getFullYear(), oggi.getMonth(), oggi.getDate() - i));
				out.push({ k, g: (conti && conti.giorni && conti.giorni[k]) || {} });
			}
			return out;
		}

		function tessere() {
			const s = conti.servizi || {};
			const t = [];
			const tessera = (nome, valore, frase, tono) =>
				`<div class="cifra conti-${tono}"><dt>${esc(nome)}</dt><dd><b>${esc(valore)}</b><small>${esc(frase)}</small></dd></div>`;
			for (const id of ['deepseek', 'openrouter']) {
				const x = s[id];
				if (x) t.push(tessera(x.nome, dollari(x.saldo), x.frase.replace(/^restano [^,]+(, )?/, '') || (x.mediaGiorno === null ? 'il ritmo si vede dal secondo giorno' : ''), x.tono));
			}
			if (s.elevenlabs) {
				const v = s.elevenlabs;
				t.push(tessera(v.nome, v.limiteMese ? `${intero(Math.max(0, v.limiteMese - v.usatiMese))} rimasti` : `${intero(v.usatiMese)} caratteri`, v.frase, v.tono));
			}
			if (s.agnes) t.push(tessera('Agnes', 'gratis', s.agnes.frase.replace(/^gratis, /, ''), 'ok'));
			return t.join('');
		}

		function graficoSpesa(lista) {
			const box = $('conti-spesa');
			const W = Math.max(280, box.clientWidth || 640);
			const H = 200, L = 52, R = 10, T = 12, B = 26;
			const pw = W - L - R, ph = H - T - B;
			const slot = pw / lista.length;
			const tot = lista.map(({ g }) => SPESE.reduce((a, [id]) => a + speso(g, id), 0));
			const max = Math.max(0.01, ...tot);
			const st = passo(max, 4);
			const cima = Math.ceil(max / st) * st;
			const y = v => T + ph - (v / cima) * ph;
			let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`;
			for (let v = 0; v <= cima + st / 1e6; v += st) {
				svg += `<line class="${v ? 'griglia' : 'base'}" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="asse-y" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}">${esc(dollari(v))}</text>`;
			}
			const ogni = Math.ceil(lista.length / Math.max(1, Math.floor(pw / 46)));
			const bw = Math.max(1, Math.min(22, slot - 2));
			lista.forEach(({ k, g }, i) => {
				const x = L + slot * (i + 0.5);
				if (i % ogni === (lista.length - 1) % ogni) svg += `<text class="asse-x" x="${x.toFixed(1)}" y="${H - 8}">${esc(giornoBreve(k))}</text>`;
				let acc = 0;
				const righe = [];
				for (const [id, nome] of SPESE) {
					const v = speso(g, id);
					if (!v) continue;
					const y1 = y(acc + v), y0 = y(acc);
					acc += v;
					svg += `<rect class="cs-${id}" x="${(x - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, y0 - y1 - (acc > v && y0 - y1 > 3 ? 2 : 0)).toFixed(1)}" rx="2"/>`;
					righe.push(`${nome} ${dollari(v)}`);
				}
				const ric = ['deepseek', 'openrouter'].filter(id => g[id] && g[id].ricarica > 0);
				for (const id of ric) {
					// la ricarica: un segno sopra il giorno
					const yr = Math.min(y(acc) - 6, T + ph - 6);
					svg += `<path class="cs-ricarica" d="M${(x - 4).toFixed(1)} ${(yr - 6).toFixed(1)} h8 l-4 6 z"/>`;
					righe.push(`ricarica ${id === 'deepseek' ? 'DeepSeek' : 'OpenRouter'} ${dollari(g[id].ricarica)}`);
				}
				if (righe.length) svg += `<rect class="cs-sopra" x="${(x - slot / 2).toFixed(1)}" y="${T}" width="${slot.toFixed(1)}" height="${ph}"><title>${esc(`${giornoLungo(k)}: ${righe.join(', ')}`)}</title></rect>`;
			});
			svg += '</svg>';
			box.innerHTML = svg;
			const somma = tot.reduce((a, b) => a + b, 0);
			box.setAttribute('aria-label', `Spesa per giorno negli ultimi ${lista.length} giorni: ${dollari(somma)} in tutto.`);
			$('conti-legenda').innerHTML = SPESE.map(([id, nome]) => `<li><i class="chiave q cs-${id}" aria-hidden="true"></i>${esc(nome)}</li>`).join('') + '<li><i class="chiave cs-ricarica-k" aria-hidden="true"></i>ricarica</li>';
			return somma;
		}

		function graficoVoce(lista) {
			const box = $('conti-voce');
			const W = Math.max(280, box.clientWidth || 640);
			const H = 120, L = 52, R = 10, T = 10, B = 24;
			const pw = W - L - R, ph = H - T - B;
			const slot = pw / lista.length;
			const vals = lista.map(({ g }) => (g.elevenlabs && g.elevenlabs.caratteri) || 0);
			const max = Math.max(1, ...vals);
			const st = passo(max, 2);
			const cima = Math.ceil(max / st) * st;
			const y = v => T + ph - (v / cima) * ph;
			let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`;
			for (let v = 0; v <= cima + st / 1e6; v += st) svg += `<line class="${v ? 'griglia' : 'base'}" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="asse-y" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}">${esc(intero(v))}</text>`;
			const ogni = Math.ceil(lista.length / Math.max(1, Math.floor(pw / 46)));
			const bw = Math.max(1, Math.min(22, slot - 2));
			lista.forEach(({ k }, i) => {
				const x = L + slot * (i + 0.5);
				if (i % ogni === (lista.length - 1) % ogni) svg += `<text class="asse-x" x="${x.toFixed(1)}" y="${H - 6}">${esc(giornoBreve(k))}</text>`;
				if (vals[i]) svg += `<rect class="cs-voce" x="${(x - bw / 2).toFixed(1)}" y="${y(vals[i]).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, y(0) - y(vals[i])).toFixed(1)}" rx="2"><title>${esc(`${giornoLungo(k)}: ${intero(vals[i])} caratteri`)}</title></rect>`;
			});
			box.innerHTML = svg + '</svg>';
			const somma = vals.reduce((a, b) => a + b, 0);
			box.setAttribute('aria-label', `Caratteri di voce per giorno negli ultimi ${lista.length} giorni: ${intero(somma)} in tutto.`);
			return somma;
		}

		function render() {
			if (!conti) return;
			$('conti-cifre').innerHTML = tessere();
			const lista = giorni();
			const spesa = graficoSpesa(lista);
			const voce = graficoVoce(lista);
			const primo = Object.keys(conti.giorni || {}).sort()[0];
			const n = lista.length;
			const ric = lista.reduce((a, { g }) => a + ((g.deepseek && g.deepseek.ricarica) || 0) + ((g.openrouter && g.openrouter.ricarica) || 0), 0);
			let nota = `Negli ultimi ${n} giorni ${dollari(spesa)} di spesa vera${ric ? `, ${dollari(ric)} di ricariche` : ''} e ${intero(voce)} caratteri di voce.`;
			const claude = host.claude();
			if (claude) nota += ` Claude Code a listino vale ${dollari(claude)} nello stesso periodo: è l'abbonamento, non una spesa, e sta nei Token qui sopra.`;
			$('conti-nota').textContent = nota;
			const avvisi = Object.values(conti.servizi || {}).filter(x => x && x.tono !== 'ok').map(x => `${x.nome}: ${x.frase}`);
			$('conti-piede').textContent = [
				avvisi.length ? `Da guardare: ${avvisi.join('; ')}.` : '',
				primo ? `Lo storico parte dal ${giornoLungo(primo)}: prima la Bottega non teneva i conti. I saldi si leggono ogni 30 minuti con la Bottega aperta; se resta chiusa, la spesa di quei giorni va sul giorno dopo.` : '',
			].filter(Boolean).join(' ');
			const btn = `<button type="button" class="link mostra-tabella" data-conti="tabella" aria-expanded="${aperta}">${aperta ? 'Nascondi i numeri' : 'Mostra i numeri'}</button>`;
			if (!aperta) {
				$('conti-tabella').innerHTML = btn;
				return;
			}
			const teste = ['Giorno', 'DeepSeek', 'OpenRouter', 'Claude, deleghe', 'Ricariche', 'Caratteri di voce', 'Richieste ad Agnes'];
			const righe = lista
				.slice()
				.reverse()
				.filter(({ g }) => Object.keys(g).length)
				.map(({ k, g }) => [
					giornoLungo(k),
					dollari(speso(g, 'deepseek')),
					dollari(speso(g, 'openrouter')),
					dollari(speso(g, 'deleghe')),
					dollari(((g.deepseek && g.deepseek.ricarica) || 0) + ((g.openrouter && g.openrouter.ricarica) || 0)),
					intero(g.elevenlabs && g.elevenlabs.caratteri),
					intero(g.agnes && g.agnes.richieste),
				]);
			$('conti-tabella').innerHTML =
				btn +
				`<div class="tabella-scorre"><table><caption class="sr">Crediti e consumi per giorno</caption><thead><tr>${teste.map((h, i) => `<th scope="col"${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
					righe.length ? righe.map(r => `<tr>${r.map((c, i) => (i ? `<td class="num">${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`)).join('')}</tr>`).join('') : `<tr><td colspan="${teste.length}">Nessun giorno con dati nel periodo.</td></tr>`
				}</tbody></table></div>`;
		}

		return {
			set(c) {
				conti = c;
				if (!c) $('conti-nota').textContent = 'I conti non sono ancora stati letti: arrivano tra pochi secondi.';
				render();
			},
			render,
			mostra() {
				if (el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
			},
		};
	}

	/** @type {any} */ (window).BottegaConti = { mount, GIORNO };
})();
