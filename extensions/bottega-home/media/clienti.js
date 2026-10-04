/* Bottega, i Clienti: le ore di ogni cliente nel mese, pronte da fatturare. I numeri li calcola
   l'estensione (src/clienti.ts) dalle sessioni di Claude Code; la forma di ClientReport e i messaggi
   clients.* sono in docs/CONTRATTI.md, sezione 4.2.

   Idea: un foglio ore per cliente. Il totale grande, l'importo se c'e' la tariffa, il mese in un
   piccolo calendario (una casella per giorno, piu' accesa quante piu' ore), i progetti con le loro
   ore. Sotto, le ore che non sono di nessuno, ciascuna con il modo di darle a un cliente.

   I nomi dei clienti vivono solo in ~/.bottega/clienti.json: questo file non ne contiene nessuno.
   Regole: niente librerie, niente attributi style (la CSP li blocca; element.style va bene), testo
   dei dati sempre sfuggito, aggiornamenti che non perdono fuoco, campi e scelte in corso. */
(function () {
	'use strict';

	const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
	const MESI_B = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
	const GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
	const INIZIALI = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];
	const PAROLE = ['nessuno', 'un', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci'];
	/** Soglie del calendario, in minuti al giorno: meno di un'ora, 2, 4, 6, di piu'. */
	const SOGLIE = [60, 120, 240, 360];

	// ---------- formati ----------

	const esc = s =>
		String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	const it = (n, d = 0) => Number(n || 0).toLocaleString('it-IT', { maximumFractionDigits: d, minimumFractionDigits: 0 });
	const parola = n => (n >= 0 && n < PAROLE.length ? PAROLE[n] : it(n));
	const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

	let euroFmt = null;
	function euro(n) {
		if (!euroFmt) {
			try {
				euroFmt = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
			} catch {
				euroFmt = { format: x => `${it(x, 2)} €` };
			}
		}
		return euroFmt.format(Number(n || 0));
	}

	/** "12 h 45 min", "45 min", "12 h", "0 min" */
	function hm(min) {
		const m = Math.round(min || 0);
		if (m < 1) return min > 0 ? 'meno di un minuto' : '0 min';
		if (m < 60) return `${m} min`;
		const h = Math.floor(m / 60);
		return m % 60 ? `${it(h)} h ${m % 60} min` : `${it(h)} h`;
	}

	const quarto = min => Math.round((min || 0) / 15) * 15;

	/** Per le frasi, con i quarti: "42 ore e un quarto", "un'ora e mezza", "tre quarti d'ora". */
	function oreFrase(min) {
		const m = Math.round(min || 0);
		const h = Math.floor(m / 60);
		const r = m % 60;
		const q = { 15: 'un quarto', 30: 'mezza', 45: 'tre quarti' };
		if (!h) {
			if (r === 0) return 'nessuna ora';
			if (r === 15) return "un quarto d'ora";
			if (r === 30) return "mezz'ora";
			if (r === 45) return "tre quarti d'ora";
			return r === 1 ? 'un minuto' : `${r} minuti`;
		}
		const hs = h === 1 ? "un'ora" : `${it(h)} ore`;
		if (!r) return hs;
		return q[r] ? `${hs} e ${q[r]}` : `${hs} e ${r} ${r === 1 ? 'minuto' : 'minuti'}`;
	}

	/** Accordo di "non assegnate" con la quantita' detta da oreFrase. */
	function nonAssegnate(min) {
		const m = Math.round(min || 0);
		const h = Math.floor(m / 60);
		const r = m % 60;
		if (h >= 2) return 'non assegnate';
		if (h === 1) return 'non assegnata';
		if (r === 30) return 'non assegnata';
		if (r === 15) return 'non assegnato';
		return 'non assegnati';
	}

	const meseNome = key => MESI[Number(String(key).slice(5, 7)) - 1] || '';
	const meseAnno = key => `${meseNome(key)} ${String(key).slice(0, 4)}`;
	const chiaveMese = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
	const chiaveGiorno = d => `${chiaveMese(d)}-${String(d.getDate()).padStart(2, '0')}`;

	/** "A settembre", "Ad agosto", "A settembre 2025" se non e' quest'anno. */
	function aMese(key) {
		const nome = meseNome(key);
		const anno = String(key).slice(0, 4);
		const a = /^a/.test(nome) ? 'Ad' : 'A';
		return `${a} ${nome}${anno !== String(new Date().getFullYear()) ? ' ' + anno : ''}`;
	}

	function livello(min) {
		if (!(min > 0)) return 0;
		let i = 0;
		while (i < SOGLIE.length && min >= SOGLIE[i]) i++;
		return i + 1;
	}

	// ---------- montaggio ----------

	function mount(root, host) {
		const post = m => host && host.post && host.post(m);
		const reduced = (host && host.reduced) || { matches: false };
		void reduced; // nessuna animazione qui: solo transizioni brevi, gia' spente dal CSS

		const ui = {
			month: '', // mese chiesto; vuoto = quello in corso
			editing: false,
			/** scelta in corso nelle tendine "Assegna a", per progetto */
			scelte: {},
			armed: '', // cliente da togliere alla seconda pressione
			waiting: false,
			saving: false,
			exporting: '',
		};
		/** @type {any} */ let report = null;
		/** @type {any[]} */ let draft = [];
		let home = '';
		let visible = false;
		let armT = 0;

		root.innerHTML = `
		<div class="cli" id="cli">
			<div class="cli-testa">
				<h1 class="sentence media cli-frase" id="cli-frase">Sto contando le ore dei clienti.</h1>
				<p class="invito">Ore osservate di Claude Code e Codex, senza duplicare il lavoro in parallelo. Cline e terminali non forniscono ancora durate utilizzabili qui.</p>
				<p class="invito cli-sottofrase" id="cli-sottofrase" hidden></p>
			</div>
			<div class="cli-comandi" id="cli-comandi">
				<div class="cli-mese" role="group" aria-label="Mese">
					<button type="button" class="ghost cli-freccia" data-c="prima" data-fk="c:prima" aria-label="Mese prima">‹</button>
					<label class="sr" for="cli-mese">Mese</label>
					<select id="cli-mese" class="cli-select" data-fk="c:mese"></select>
					<button type="button" class="ghost cli-freccia" data-c="dopo" data-fk="c:dopo" aria-label="Mese dopo">›</button>
				</div>
				<div class="cli-esporta" role="group" aria-label="Esporta il mese">
					<button type="button" class="act" data-c="esporta" data-f="csv" data-fk="c:csv">Esporta CSV</button>
					<button type="button" class="act" data-c="esporta" data-f="md" data-fk="c:md">Esporta Markdown</button>
				</div>
				<button type="button" class="ghost cli-modifica" id="cli-modifica" data-c="modifica" data-fk="c:modifica" aria-expanded="false" aria-controls="cli-editor">Modifica i clienti</button>
			</div>
			<p class="cli-esito" id="cli-esito" role="status" aria-live="polite"></p>

			<section class="pannello cli-editor" id="cli-editor" aria-labelledby="cli-editor-titolo" hidden>
				<h2 id="cli-editor-titolo">I tuoi clienti</h2>
				<p class="cli-privato">I nomi restano solo su questo Mac, nel file <code>~/.bottega/clienti.json</code>, mai nel repository.</p>
				<ol class="cli-ed-lista" id="cli-ed-lista"></ol>
				<button type="button" class="ghost cli-nuovo" data-c="nuovo" data-fk="c:nuovo">Aggiungi un cliente</button>
				<div class="cli-ed-piede">
					<button type="button" class="act main" data-c="salva" data-fk="c:salva">Salva</button>
					<button type="button" class="ghost" data-c="annulla" data-fk="c:annulla">Annulla</button>
					<p class="esito" id="cli-ed-esito" role="alert"></p>
				</div>
			</section>

			<div class="cli-corpo" id="cli-corpo">
				<div class="cli-sez-testa">
					<h2 class="cli-titolo" id="cli-lista-titolo">Clienti</h2>
					<div class="cli-scala" aria-hidden="true"><span>meno di un'ora</span><i class="cli-l1"></i><i class="cli-l2"></i><i class="cli-l3"></i><i class="cli-l4"></i><i class="cli-l5"></i><span>6 ore o più</span></div>
				</div>
				<p class="cli-vuoto" id="cli-vuoto" hidden></p>
				<ul class="cli-clienti" id="cli-clienti" aria-labelledby="cli-lista-titolo"></ul>

				<section class="cli-liberi" id="cli-liberi" aria-labelledby="cli-liberi-titolo" hidden>
					<h2 class="cli-titolo" id="cli-liberi-titolo">Ore di nessun cliente</h2>
					<p class="cli-nota" id="cli-liberi-nota"></p>
					<ul class="cli-liberi-lista" id="cli-liberi-lista"></ul>
				</section>

				<p class="cli-regola" id="cli-regola"></p>
			</div>
		</div>`;

		const $ = id => /** @type {any} */ (root.querySelector('#' + id));
		const cli = $('cli');
		const doc = root.ownerDocument;

		// ---------- piccoli attrezzi ----------

		const lastHTML = new WeakMap();

		function focusKey(scope) {
			const a = /** @type {any} */ (doc.activeElement);
			if (!a || !scope.contains(a)) return null;
			const k = a.closest ? a.closest('[data-fk]') : null;
			return k ? k.getAttribute('data-fk') : null;
		}

		function refocus(key, scope) {
			if (!key) return;
			const a = doc.activeElement;
			if (a && a !== doc.body && doc.contains(a)) return;
			for (const el of scope.querySelectorAll('[data-fk]')) {
				if (el.getAttribute('data-fk') === key) {
					el.focus({ preventScroll: true });
					return;
				}
			}
		}

		/** Riscrive un contenitore solo se l'HTML e' cambiato, e rimette il fuoco dov'era. */
		function put(el, html) {
			if (lastHTML.get(el) === html) return;
			const k = focusKey(el);
			el.innerHTML = html;
			lastHTML.set(el, html);
			refocus(k, el);
			larghezze(el);
		}

		function make(html) {
			const t = doc.createElement('template');
			t.innerHTML = html.trim();
			return /** @type {any} */ (t.content.firstElementChild);
		}

		/** Lista con chiavi: ricrea solo le voci cambiate, sposta le altre senza toccarle. */
		function sync(list, items, keyOf, htmlOf) {
			const k = focusKey(list);
			const old = new Map();
			for (const el of [...list.children]) old.set(el.getAttribute('data-key'), el);
			let prev = null;
			for (const item of items) {
				const key = String(keyOf(item));
				const html = htmlOf(item);
				let el = old.get(key);
				if (!el || lastHTML.get(el) !== html) {
					const n = make(html);
					n.setAttribute('data-key', key);
					lastHTML.set(n, html);
					if (el) el.replaceWith(n);
					el = n;
					larghezze(n);
				}
				old.delete(key);
				const want = prev ? prev.nextElementSibling : list.firstElementChild;
				if (want !== el) list.insertBefore(el, want);
				prev = el;
			}
			for (const el of old.values()) el.remove();
			refocus(k, list);
		}

		/** Le barre hanno la larghezza in data-w (0..1): la CSP non lascia scriverla nell'HTML. */
		function larghezze(scope) {
			for (const el of scope.querySelectorAll('[data-w]')) el.style.setProperty('--cli-w', String(Number(el.getAttribute('data-w')) || 0));
		}

		function esito(text) {
			const e = $('cli-esito');
			if (e.textContent !== text) e.textContent = text;
		}

		const corto = p => (home && p && p.startsWith(home) ? '~' + p.slice(home.length) : p || '');

		const projectName = path => {
			const p = report && (report.projects || []).find(x => x.path === path);
			return p ? p.name : String(path || '').split('/').filter(Boolean).pop() || path;
		};

		// ---------- frase e comandi ----------

		function frase(r) {
			const n = s => `<span class="n">${esc(s)}</span>`;
			const corrente = r.month === chiaveMese(new Date());
			const a = aMese(r.month) + (corrente ? ', finora,' : '');
			const attivi = r.clients.filter(c => c.minutes > 0);
			const tot = attivi.reduce((s, c) => s + c.minutes, 0);
			const liberi = quarto(r.unassigned.reduce((s, u) => s + u.minutes, 0));
			const piu = liberi ? `${n(oreFrase(liberi))} ${nonAssegnate(liberi)}` : '';
			if (!r.config.length) {
				if (!liberi) return `${a} non ci sono ore registrate.`;
				return `${a} hai lavorato ${n(oreFrase(liberi))}, ma non hai ancora clienti a cui darle.`;
			}
			if (!tot) {
				if (!liberi) return `${a} non ci sono ore registrate.`;
				return `${a} non hai lavorato per i tuoi clienti: ci sono ${piu}.`;
			}
			const k = attivi.length;
			return `${a} hai lavorato ${n(oreFrase(tot))} per ${n(k === 1 ? 'un' : parola(k))} ${k === 1 ? 'cliente' : 'clienti'}${piu ? `, più ${piu}` : ''}.`;
		}

		function renderTesta() {
			const r = report;
			if (!r) return;
			put($('cli-frase'), frase(r));
			const importi = r.clients.filter(c => typeof c.amount === 'number' && c.minutes > 0);
			const sotto = $('cli-sottofrase');
			if (importi.length) {
				const tot = importi.reduce((s, c) => s + c.amount, 0);
				const t = importi.length === r.clients.filter(c => c.minutes > 0).length ? `Da fatturare: ${euro(tot)}.` : `Da fatturare: ${euro(tot)} ai clienti con la tariffa.`;
				if (sotto.textContent !== t) sotto.textContent = t;
				sotto.hidden = false;
			} else sotto.hidden = true;

			// i mesi: quelli con ore, piu' quello mostrato
			const mesi = [...new Set([r.month, ...(r.months || [])])].sort().reverse();
			put($('cli-mese'), mesi.map(m => `<option value="${esc(m)}"${m === r.month ? ' selected' : ''}>${esc(cap(meseAnno(m)))}</option>`).join(''));
			$('cli-mese').value = r.month;
			const i = mesi.indexOf(r.month);
			root.querySelector('[data-c="prima"]').disabled = i < 0 || i >= mesi.length - 1;
			root.querySelector('[data-c="dopo"]').disabled = i <= 0;
			cli.classList.toggle('cli-attesa', ui.waiting);
			$('cli-corpo').setAttribute('aria-busy', ui.waiting ? 'true' : 'false');
			for (const b of root.querySelectorAll('[data-c="esporta"]')) b.disabled = !!ui.exporting;
		}

		// ---------- i clienti ----------

		function calendario(r, c) {
			const [y, m] = r.month.split('-').map(Number);
			const primo = new Date(y, m - 1, 1);
			const quanti = new Date(y, m, 0).getDate();
			const off = (primo.getDay() + 6) % 7;
			const per = new Map((c.days || []).map(d => [d.date, d.minutes]));
			const oggi = chiaveGiorno(new Date());
			let celle = INIZIALI.map(l => `<span class="cli-g-testa">${l}</span>`).join('');
			for (let i = 0; i < off; i++) celle += `<span class="cli-g cli-g-fuori"></span>`;
			for (let d = 1; d <= quanti; d++) {
				const k = `${r.month}-${String(d).padStart(2, '0')}`;
				const min = per.get(k) || 0;
				const t = `${d} ${MESI_B[m - 1]}: ${min ? hm(min) : 'niente'}`;
				celle += `<span class="cli-g cli-l${livello(min)}${k === oggi ? ' cli-oggi' : ''}" title="${esc(t)}"></span>`;
			}
			const giorni = (c.days || []).filter(d => d.minutes > 0);
			const sr = giorni.length
				? `Giorni lavorati: ${giorni
						.map(d => {
							const g = new Date(Number(d.date.slice(0, 4)), Number(d.date.slice(5, 7)) - 1, Number(d.date.slice(8, 10)));
							return `${GIORNI[g.getDay()]} ${g.getDate()}, ${hm(d.minutes)}`;
						})
						.join('; ')}.`
				: 'Nessun giorno lavorato.';
			return `<div class="cli-cal"><div class="cli-griglia" aria-hidden="true">${celle}</div><p class="sr">${esc(sr)}</p></div>`;
		}

		function clienteHTML(c) {
			const r = report;
			const cfg = (r.config || []).find(x => x.id === c.id);
			const giorni = (c.days || []).filter(d => d.minutes > 0).length;
			const sotto = [];
			if (cfg && typeof cfg.tariffa === 'number') sotto.push(`${euro(cfg.tariffa)} l'ora`);
			sotto.push(giorni === 1 ? 'un giorno lavorato' : `${it(giorni)} giorni lavorati`);
			if (c.raw && Math.round(c.raw) !== c.minutes) sotto.push(`${hm(c.raw)} prima di arrotondare`);
			const max = Math.max(1, ...(c.projects || []).map(p => p.minutes));
			const progetti = (c.projects || []).filter(p => p.minutes > 0);
			const fermi = cfg ? cfg.progetti.filter(p => !progetti.some(x => x.path === p)).length : 0;
			return `<li class="cli-cliente${c.minutes ? '' : ' cli-spento'}">
				<div class="cli-c-testa">
					<h3 class="cli-nome">${esc(c.nome)}</h3>
					<p class="cli-ore"><b>${esc(hm(c.minutes))}</b>${typeof c.amount === 'number' ? `<span class="cli-importo">${esc(euro(c.amount))}</span>` : ''}</p>
					<p class="cli-sotto">${esc(cap(sotto.join(', ')))}</p>
				</div>
				${calendario(r, c)}
				<div class="cli-c-progetti">
					${
						progetti.length
							? `<ul class="cli-progetti">${progetti
									.map(
										p =>
											`<li><span class="cli-p-nome" title="${esc(corto(p.path))}">${esc(p.name)}</span><span class="cli-barra" aria-hidden="true"><i data-w="${(p.minutes / max).toFixed(3)}"></i></span><span class="cli-p-ore">${esc(hm(p.minutes))}</span></li>`,
									)
									.join('')}</ul>`
							: `<p class="cli-nota">${cfg && cfg.progetti.length ? 'Nessuna ora questo mese.' : 'Nessun progetto scelto: aprilo in Modifica i clienti.'}</p>`
					}
					${fermi ? `<p class="cli-nota">${fermi === 1 ? 'Un altro progetto' : `Altri ${parola(fermi)} progetti`} senza ore questo mese.</p>` : ''}
				</div>
			</li>`;
		}

		function renderClienti() {
			const r = report;
			const vuoto = $('cli-vuoto');
			const list = [...r.clients].sort((a, b) => b.minutes - a.minutes || a.nome.localeCompare(b.nome, 'it'));
			if (!r.config.length) {
				vuoto.hidden = false;
				put(vuoto, `Non hai ancora clienti. Aggiungine uno e scegli i suoi progetti: le ore si contano da sole. <button type="button" class="link" data-c="modifica" data-fk="c:primo">Aggiungi un cliente</button>`);
			} else vuoto.hidden = true;
			sync($('cli-clienti'), list, c => c.id, clienteHTML);

			// le ore di nessuno
			const liberi = r.unassigned || [];
			const sez = $('cli-liberi');
			sez.hidden = !liberi.length;
			const nota = !r.config.length
				? 'Aggiungi un cliente per assegnargli questi progetti.'
				: ui.editing
					? 'Stai modificando i clienti: assegna i progetti lì.'
					: 'Scegli un cliente e premi Assegna: il progetto passa a lui da questo mese in poi, e anche nei mesi passati.';
			const n = $('cli-liberi-nota');
			if (n.textContent !== nota) n.textContent = nota;
			sync($('cli-liberi-lista'), liberi, u => u.path || '(fuori)', liberoHTML);

			const q = r.rounding || 15;
			const regola =
				q === 15
					? "Ogni giorno di ogni cliente è arrotondato al quarto d'ora più vicino; due sessioni insieme contano una volta."
					: `Ogni giorno di ogni cliente è arrotondato ai ${it(q)} minuti più vicini; due sessioni insieme contano una volta.`;
			const rg = $('cli-regola');
			if (rg.textContent !== regola) rg.textContent = regola;
		}

		function liberoHTML(u) {
			const r = report;
			const nome = `<span class="cli-l-nome"${u.path ? ` title="${esc(corto(u.path))}"` : ''}>${esc(u.name)}</span><span class="cli-l-ore">${esc(hm(u.minutes))}</span>`;
			if (!u.path) return `<li class="cli-libero">${nome}<span class="cli-nota cli-l-perche">Sessioni partite fuori da un progetto: non si possono assegnare.</span></li>`;
			if (!r.config.length || ui.editing) return `<li class="cli-libero">${nome}</li>`;
			const scelta = ui.scelte[u.path] || '';
			const id = 'cli-as-' + hash(u.path);
			return `<li class="cli-libero">${nome}
				<span class="cli-assegna">
					<label class="sr" for="${id}">Assegna ${esc(u.name)} a</label>
					<select id="${id}" class="cli-select" data-c-in="scelta" data-path="${esc(u.path)}" data-fk="c:sc:${esc(u.path)}">
						<option value="">Scegli un cliente</option>
						${r.config.map(c => `<option value="${esc(c.id)}"${c.id === scelta ? ' selected' : ''}>${esc(c.nome)}</option>`).join('')}
					</select>
					<button type="button" class="act" data-c="assegna" data-path="${esc(u.path)}" data-fk="c:as:${esc(u.path)}"${scelta ? '' : ' disabled'}>Assegna</button>
				</span>
			</li>`;
		}

		function hash(s) {
			let h = 0;
			for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
			return (h >>> 0).toString(36);
		}

		// ---------- l'editor ----------

		const copia = list => (list || []).map(c => ({ id: c.id, nome: c.nome, progetti: [...(c.progetti || [])], tariffa: c.tariffa, _t: typeof c.tariffa === 'number' ? String(c.tariffa).replace('.', ',') : '' }));

		function editorHTML() {
			if (!draft.length) return `<li class="cli-ed-vuoto">Nessun cliente. Aggiungine uno qui sotto.</li>`;
			const tutti = (report && report.projects) || [];
			return draft
				.map(c => {
					const id = esc(c.id);
					const h = hash(c.id);
					const di = p => draft.find(x => x !== c && x.progetti.includes(p));
					const liberi = tutti.filter(p => !c.progetti.includes(p.path) && !di(p.path));
					const altrui = tutti.filter(p => !c.progetti.includes(p.path) && di(p.path));
					const nomeC = c.nome.trim() || 'questo cliente';
					return `<li class="cli-ed" data-key="${id}">
						<div class="cli-ed-campi">
							<label class="cli-campo"><span>Nome</span><input type="text" data-c-in="nome" data-id="${id}" data-fk="c:n:${id}" value="${esc(c.nome)}" autocomplete="off" spellcheck="false"></label>
							<label class="cli-campo cli-campo-tariffa"><span>Tariffa in euro l'ora, facoltativa</span><input type="text" inputmode="decimal" data-c-in="tariffa" data-id="${id}" data-fk="c:t:${id}" value="${esc(c._t)}" placeholder="per esempio 40" autocomplete="off"></label>
						</div>
						<p class="cli-campo-titolo" id="cli-ed-p-${h}">Progetti</p>
						<ul class="cli-chips" aria-labelledby="cli-ed-p-${h}">${
							c.progetti.length
								? c.progetti
										.map(p => `<li><span title="${esc(corto(p))}">${esc(projectName(p))}</span><button type="button" data-c="togli-progetto" data-id="${id}" data-path="${esc(p)}" data-fk="c:tp:${id}:${esc(p)}" aria-label="Togli ${esc(projectName(p))} da ${esc(nomeC)}">×</button></li>`)
										.join('')
								: '<li class="cli-chips-vuoto">Ancora nessuno.</li>'
						}</ul>
						<div class="cli-ed-riga">
							<label class="sr" for="cli-ed-add-${h}">Aggiungi un progetto a ${esc(nomeC)}</label>
							<select id="cli-ed-add-${h}" class="cli-select" data-c-in="aggiungi" data-id="${id}" data-fk="c:add:${id}">
								<option value="">Aggiungi un progetto</option>
								${liberi.map(p => `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join('')}
								${altrui.length ? `<optgroup label="Già di un altro cliente, passa a questo">${altrui.map(p => `<option value="${esc(p.path)}">${esc(p.name)}, ora di ${esc(di(p.path).nome || 'un altro')}</option>`).join('')}</optgroup>` : ''}
							</select>
							<button type="button" class="link cli-togli" data-c="togli-cliente" data-id="${id}" data-fk="c:tc:${id}">${ui.armed === c.id ? 'Premi di nuovo per togliere' : 'Togli il cliente'}</button>
						</div>
					</li>`;
				})
				.join('');
		}

		/** Con list = false aggiorna solo la cornice: mentre Andrea scrive, un report che arriva non
		    deve riscrivere i campi (perderebbe il cursore). */
		function renderEditor(list = true) {
			const ed = $('cli-editor');
			ed.hidden = !ui.editing;
			const b = $('cli-modifica');
			b.setAttribute('aria-expanded', String(ui.editing));
			b.textContent = ui.editing ? 'Chiudi i clienti' : 'Modifica i clienti';
			if (ui.editing && list) put($('cli-ed-lista'), editorHTML());
		}

		function apriEditor() {
			draft = copia(report ? report.config : []);
			ui.editing = true;
			ui.armed = '';
			$('cli-ed-esito').textContent = '';
			if (!draft.length) nuovoCliente(false);
			render();
			renderEditor(true);
			const first = root.querySelector('#cli-ed-lista input');
			if (first) first.focus();
		}

		function chiudiEditor(focus) {
			ui.editing = false;
			ui.armed = '';
			draft = [];
			render();
			if (focus) $('cli-modifica').focus();
		}

		function nuovoCliente(rerender = true) {
			const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
			draft.push({ id, nome: '', progetti: [], tariffa: undefined, _t: '' });
			if (rerender) {
				renderEditor();
				const el = root.querySelector(`[data-fk="c:n:${id}"]`);
				if (el) el.focus();
			}
			return id;
		}

		/** Mette un progetto a un cliente, togliendolo agli altri: un progetto ha un cliente solo. */
		function dai(list, clientId, path) {
			for (const c of list) {
				if (c.id === clientId) {
					if (!c.progetti.includes(path)) c.progetti.push(path);
				} else c.progetti = c.progetti.filter(p => p !== path);
			}
		}

		function pulisci(list) {
			const errori = [];
			const out = list.map(c => {
				const nome = String(c.nome || '').trim();
				const t = String(c._t ?? '').trim();
				let tariffa;
				if (t) {
					const v = Number(t.replace(/\s/g, '').replace('€', '').replace(',', '.'));
					if (!Number.isFinite(v) || v < 0) errori.push(`La tariffa di ${nome || 'un cliente'} non è un numero.`);
					else if (v > 0) tariffa = Math.round(v * 100) / 100;
				}
				if (!nome) errori.push('Ogni cliente ha bisogno di un nome.');
				return { id: c.id, nome, progetti: [...c.progetti], ...(tariffa !== undefined ? { tariffa } : {}) };
			});
			return { out, errori: [...new Set(errori)] };
		}

		function salva() {
			const { out, errori } = pulisci(draft);
			const e = $('cli-ed-esito');
			if (errori.length) {
				e.textContent = errori.join(' ');
				e.classList.add('errore');
				return;
			}
			e.classList.remove('errore');
			post({ type: 'clients.save', clients: out });
			ui.saving = true;
			esito('Salvo i clienti…');
			chiudiEditor(true);
		}

		// ---------- tutto ----------

		function render() {
			if (!report) {
				renderEditor(false);
				return;
			}
			renderTesta();
			renderEditor(false);
			renderClienti();
		}

		function chiedi(month) {
			ui.waiting = true;
			if (month) ui.month = month;
			post(ui.month ? { type: 'clients.request', month: ui.month } : { type: 'clients.request' });
			if (report) renderTesta();
		}

		// ---------- eventi ----------

		root.addEventListener('click', e => {
			const b = /** @type {any} */ (e.target).closest && /** @type {any} */ (e.target).closest('[data-c]');
			if (!b || !root.contains(b) || b.disabled) return;
			const c = b.getAttribute('data-c');
			const mesi = report ? [...new Set([report.month, ...(report.months || [])])].sort().reverse() : [];
			const i = report ? mesi.indexOf(report.month) : -1;
			switch (c) {
				case 'prima':
					if (i >= 0 && i < mesi.length - 1) chiedi(mesi[i + 1]);
					return;
				case 'dopo':
					if (i > 0) chiedi(mesi[i - 1]);
					return;
				case 'esporta': {
					if (!report) return;
					const f = b.getAttribute('data-f') === 'md' ? 'md' : 'csv';
					ui.exporting = f;
					post({ type: 'clients.export', month: report.month, format: f });
					esito(`Preparo il file ${f === 'md' ? 'Markdown' : 'CSV'} di ${meseAnno(report.month)}…`);
					renderTesta();
					return;
				}
				case 'modifica':
					if (ui.editing) chiudiEditor(true);
					else apriEditor();
					return;
				case 'annulla':
					return chiudiEditor(true);
				case 'salva':
					return salva();
				case 'nuovo':
					ui.armed = '';
					return nuovoCliente();
				case 'togli-progetto': {
					const cl = draft.find(x => x.id === b.getAttribute('data-id'));
					if (!cl) return;
					const p = b.getAttribute('data-path');
					cl.progetti = cl.progetti.filter(x => x !== p);
					renderEditor();
					const add = root.querySelector(`[data-fk="c:add:${cssEsc(cl.id)}"]`);
					if (add && !root.contains(doc.activeElement)) add.focus();
					else if (add && doc.activeElement === doc.body) add.focus();
					return;
				}
				case 'togli-cliente': {
					const id = b.getAttribute('data-id');
					clearTimeout(armT);
					if (ui.armed !== id) {
						ui.armed = id;
						armT = setTimeout(() => {
							ui.armed = '';
							if (ui.editing) renderEditor();
						}, 4000);
						return renderEditor();
					}
					ui.armed = '';
					const k = draft.findIndex(x => x.id === id);
					const nome = k >= 0 ? draft[k].nome : '';
					if (k >= 0) draft.splice(k, 1);
					renderEditor();
					esito(nome ? `${nome} tolto. Premi Salva per confermare.` : 'Cliente tolto. Premi Salva per confermare.');
					const nuovo = root.querySelector('[data-c="nuovo"]');
					if (nuovo) nuovo.focus();
					return;
				}
				case 'assegna': {
					const path = b.getAttribute('data-path');
					const id = ui.scelte[path];
					if (!report || !id) return;
					const list = copia(report.config).map(x => ({ id: x.id, nome: x.nome, progetti: x.progetti, ...(typeof x.tariffa === 'number' ? { tariffa: x.tariffa } : {}) }));
					dai(list, id, path);
					post({ type: 'clients.save', clients: list });
					const cl = list.find(x => x.id === id);
					delete ui.scelte[path];
					ui.saving = true;
					esito(`${projectName(path)} ora è di ${cl ? cl.nome : 'quel cliente'}. Ricalcolo le ore…`);
					return;
				}
			}
		});

		const cssEsc = s => String(s).replace(/["\\]/g, '\\$&');

		root.addEventListener('input', e => {
			const t = /** @type {any} */ (e.target);
			const k = t && t.getAttribute && t.getAttribute('data-c-in');
			if (k !== 'nome' && k !== 'tariffa') return;
			const c = draft.find(x => x.id === t.getAttribute('data-id'));
			if (!c) return;
			if (k === 'nome') c.nome = t.value;
			else c._t = t.value;
			// la riga si riscrivera' con questi valori: va tenuta allineata senza toccare il campo
			const li = t.closest('.cli-ed');
			if (li && k === 'nome') {
				const nomeC = c.nome.trim() || 'questo cliente';
				for (const x of li.querySelectorAll('[data-c="togli-progetto"]')) x.setAttribute('aria-label', `Togli ${projectName(x.getAttribute('data-path'))} da ${nomeC}`);
				const lab = li.querySelector('.cli-ed-riga label');
				if (lab) lab.textContent = `Aggiungi un progetto a ${nomeC}`;
			}
			const ol = $('cli-ed-lista');
			lastHTML.delete(ol); // il prossimo renderEditor deve riscrivere: l'HTML salvato e' vecchio
		});

		root.addEventListener('change', e => {
			const t = /** @type {any} */ (e.target);
			if (!t || !t.getAttribute) return;
			if (t.id === 'cli-mese') return chiedi(t.value);
			const k = t.getAttribute('data-c-in');
			if (k === 'scelta') {
				const p = t.getAttribute('data-path');
				if (t.value) ui.scelte[p] = t.value;
				else delete ui.scelte[p];
				const btn = t.parentElement.querySelector('[data-c="assegna"]');
				if (btn) btn.disabled = !t.value;
				return;
			}
			if (k === 'aggiungi' && t.value) {
				dai(draft, t.getAttribute('data-id'), t.value);
				const nome = projectName(t.value);
				renderEditor();
				esito(`${nome} aggiunto. Premi Salva per confermare.`);
			}
		});

		root.addEventListener('keydown', e => {
			if (e.key === 'Escape' && ui.editing && $('cli-editor').contains(/** @type {any} */ (e.target))) {
				e.preventDefault();
				chiudiEditor(true);
			}
		});

		return {
			/** Lo snapshot serve solo per accorciare i percorsi con ~. */
			update(snapshot) {
				if (snapshot && snapshot.home) home = snapshot.home;
			},
			message(m) {
				if (!m) return;
				if (m.type === 'clients' && m.report) {
					report = m.report;
					ui.waiting = false;
					ui.month = report.month;
					if (ui.saving) {
						ui.saving = false;
						const e = $('cli-esito');
						if (/Salvo|Ricalcolo/.test(e.textContent)) esito('Clienti salvati.');
					}
					render();
				} else if (m.type === 'clients.exported') {
					ui.exporting = '';
					esito(m.path ? `Salvato in ${corto(m.path)}` : 'Esportazione annullata.');
					if (report) renderTesta();
				}
			},
			show() {
				visible = true;
				chiedi(ui.month || '');
				render();
			},
			hide() {
				visible = false;
			},
			pause() {},
			resume() {
				void visible;
			},
		};
	}

	/** @type {any} */ (window).BottegaClienti = { mount };
})();
