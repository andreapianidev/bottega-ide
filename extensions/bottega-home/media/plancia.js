// @ts-check
/* Bottega, la plancia: sette stanze (Plancia, Lavori, Memoria, Melissa, Cruscotto, Vedetta, Clienti)
   in una sola webview. La Plancia e' la Home: briefing, consigli, cifre, progetti fermi, progetti.
   Cruscotto, Vedetta e Clienti vivono in file loro (caricati prima di questo), qui li si monta soltanto.
   Lo scheletro si costruisce una volta. Ogni aggiornamento tocca solo i pezzi cambiati, cosi'
   fuoco, scorrimento, dettagli aperti e testo che si sta scrivendo restano dove sono anche se
   l'istantanea arriva ogni pochi secondi. Contratto dei messaggi: docs/CONTRATTI.md, sezioni 3 e 4.
   Ogni campo della sezione 4 e' facoltativo: con un'estensione vecchia la plancia resta quella di prima. */
(function () {
	const vscode = acquireVsCodeApi();
	const app = /** @type {HTMLElement} */ (document.getElementById('app'));
	// Il pannello mette aria-live su tutto: con aggiornamenti ogni pochi secondi sarebbe rumore.
	// Gli annunci passano da una regione dedicata (#annuncio).
	app.removeAttribute('aria-live');

	const saved = vscode.getState() || {};
	const VIEWS = [
		['plancia', 'Plancia'],
		['lavori', 'Lavori'],
		['memoria', 'Memoria'],
		['melissa', 'Melissa'],
		['cruscotto', 'Cruscotto'],
		['vedetta', 'Vedetta'],
		['clienti', 'Clienti'],
	];
	const reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

	const state = {
		/** @type {any} */ snapshot: null,
		view: VIEWS.some(v => v[0] === saved.view) ? saved.view : 'plancia',
		filter: saved.filter || 'tutti',
		query: saved.query || '',
		open: new Set(saved.open || []),
		draft: {
			path: (saved.draft && saved.draft.path) || '',
			task: (saved.draft && saved.draft.task) || '',
			night: !!(saved.draft && saved.draft.night),
		},
		mem: {
			query: (saved.mem && saved.mem.query) || '',
			project: (saved.mem && saved.mem.project) || '',
			/** @type {{query: string, project: string} | null} */ sent: null,
			/** @type {any[] | null} */ results: null,
			/** @type {any[] | null} */ bacheca: null,
			waiting: false,
			open: new Set(),
			mode: saved.mem && saved.mem.mode === 'ricerca' ? 'ricerca' : 'ricordi',
		},
		/** «Dove l'ho gia' risolto?»: ricerca nei ricordi e nel codice. */
		ric: {
			query: (saved.ric && saved.ric.query) || '',
			/** @type {string | null} */ sent: null,
			/** @type {any} */ result: null,
			waiting: false,
		},
		ask: saved.ask || '',
		/** @type {any} */ crus: saved.crus || {},
		/** @type {any} */ vedetta: saved.vedetta || {},
		/** @type {any} */ clienti: saved.clienti || {},
		/** numeri del cruscotto per il quadro della Home (messaggio stats) */
		/** @type {any} */ stats: null,
		statsAskedAt: 0,
		briefOpen: false,
		/** progetto per cui si sta preparando «Continua da dove eri» */
		contWaiting: '',
		/** @type {{path: string, opener: string} | null} */ cont: null,
		notteEdit: false,
		/** «Cosa sta facendo» delle sessioni aperte altrove: sessionId -> {open, items|null} */
		/** @type {Map<string, {open: boolean, items: any[] | null}>} */ sess: new Map(),
		full: false,
		/** @type {any} */ assistant: null,
		/** @type {{text: string, at: number} | null} */ pendingAsk: null,
		/** @type {boolean | null} */ voiceOptimistic: null,
		armed: '',
		/** @type {Map<string, string>} */ jobStatus: new Map(),
		loud: false,
		/** @type {Record<string, number>} */ scroll: {},
	};

	const persist = () =>
		vscode.setState({
			view: state.view,
			filter: state.filter,
			query: state.query,
			open: [...state.open],
			draft: state.draft,
			mem: { query: state.mem.query, project: state.mem.project, mode: state.mem.mode },
			ric: { query: state.ric.query },
			ask: state.ask,
			crus: state.crus,
			vedetta: state.vedetta,
			clienti: state.clienti,
		});

	// ---------- piccoli attrezzi ----------

	const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));

	const esc = s =>
		String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

	const NUM = ['nessun', 'un', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci'];
	const word = n => (n < NUM.length ? NUM[n] : String(n));
	const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
	const num = n => Number(n || 0).toLocaleString('it-IT', { maximumFractionDigits: 1 });
	const day = 86_400_000;

	function ago(ms) {
		if (!ms) return '';
		const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
		if (s < 60) return 'adesso';
		const m = Math.round(s / 60);
		if (m < 60) return `${m} min fa`;
		const h = Math.round(m / 60);
		if (h < 24) return `${h} h fa`;
		const d = Math.round(h / 24);
		if (d === 1) return 'ieri';
		if (d < 60) return `${d} giorni fa`;
		return `${Math.round(d / 30)} mesi fa`;
	}

	const since = ms => {
		const a = ago(ms);
		return a === 'adesso' ? 'da poco' : a === 'ieri' ? 'da ieri' : 'da ' + a.replace(' fa', '');
	};

	/** Durata leggibile: "meno di un minuto", "12 min", "1 h 20 min", "3 giorni". */
	function dur(ms) {
		const m = Math.floor(Math.max(0, ms) / 60_000);
		if (m < 1) return 'meno di un minuto';
		if (m < 60) return `${m} min`;
		const h = Math.floor(m / 60);
		if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
		const d = Math.round(h / 24);
		return d === 1 ? 'un giorno' : `${d} giorni`;
	}

	const clock = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

	/** Minuti in "3 h 20 min", "45 min", "0 min". */
	function hm(min) {
		const m = Math.round(min || 0);
		if (m < 60) return `${m} min`;
		const h = Math.floor(m / 60);
		return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
	}

	function money(v, cur) {
		try {
			return Number(v || 0).toLocaleString('it-IT', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 2 });
		} catch {
			return `${num(v)} ${cur || ''}`.trim();
		}
	}

	/** YYYY-MM-DD nel fuso del Mac. */
	function dayKey(d = new Date()) {
		const p = x => String(x).padStart(2, '0');
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
	}

	/** "martedì 2 ottobre" da "2026-10-02". */
	function dateWords(key) {
		const [y, m, d] = String(key || '').split('-').map(Number);
		if (!y || !m || !d) return '';
		return new Date(y, m - 1, d).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
	}

	/** Parola femminile per i conteggi delle regole: "una rossa", "due gialle". */
	const FEM = ['nessuna', 'una', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci'];
	const fem = n => (n < FEM.length ? FEM[n] : String(n));

	/** Il messaggio di un'azione proposta da regole, briefing o consigli: {type: act, ...args}. */
	const actMsg = (a, extra) => JSON.stringify({ ...(extra || {}), ...(a.args || {}), type: a.act });
	const actBtn = (a, key, cls = 'act', extra) =>
		`<button type="button" class="${cls}" data-act="run" data-msg="${esc(actMsg(a, extra))}" data-fk="run:${esc(key)}">${esc(a.label || 'Fallo')}</button>`;

	const home = p => (state.snapshot && p && p.startsWith(state.snapshot.home) ? '~' + p.slice(state.snapshot.home.length) : p || '');

	function make(html) {
		const t = document.createElement('template');
		t.innerHTML = html.trim();
		return /** @type {HTMLElement} */ (t.content.firstElementChild);
	}

	/** Chiave stabile dell'elemento col fuoco, per ritrovarlo dopo un aggiornamento. */
	function focusKey() {
		const a = /** @type {HTMLElement | null} */ (document.activeElement);
		const k = a && a.closest ? a.closest('[data-fk]') : null;
		return k ? k.getAttribute('data-fk') : null;
	}

	function refocus(key, scope) {
		if (!key) return;
		const a = document.activeElement;
		if (a && a !== document.body && document.contains(a)) return;
		for (const el of scope.querySelectorAll('[data-fk]')) {
			if (el.getAttribute('data-fk') === key) {
				/** @type {HTMLElement} */ (el).focus({ preventScroll: true });
				return;
			}
		}
	}

	const lastHTML = new WeakMap();

	/** Riscrive un contenitore solo se l'HTML e' cambiato, e rimette il fuoco dov'era. */
	function setHTML(el, html) {
		if (lastHTML.get(el) === html) return;
		const k = el.contains(document.activeElement) ? focusKey() : null;
		el.innerHTML = html;
		lastHTML.set(el, html);
		refocus(k, el);
	}

	/** Lista con chiavi: ricrea solo le voci cambiate, sposta le altre senza toccarle. */
	function sync(list, items, keyOf, htmlOf) {
		const k = list.contains(document.activeElement) ? focusKey() : null;
		const old = new Map();
		for (const el of [...list.children]) old.set(el.getAttribute('data-key'), el);
		/** @type {Element | null} */ let prev = null;
		for (const it of items) {
			const key = String(keyOf(it));
			const html = htmlOf(it);
			let el = old.get(key);
			if (!el || lastHTML.get(el) !== html) {
				const n = make(html);
				n.setAttribute('data-key', key);
				lastHTML.set(n, html);
				if (el) el.replaceWith(n);
				el = n;
			}
			old.delete(key);
			const want = prev ? prev.nextElementSibling : list.firstElementChild;
			if (want !== el) list.insertBefore(el, want);
			prev = el;
		}
		for (const el of old.values()) el.remove();
		refocus(k, list);
	}

	function announce(text) {
		const a = $('annuncio');
		a.textContent = '';
		setTimeout(() => (a.textContent = text), 30);
	}

	const projects = () => (state.snapshot && state.snapshot.projects) || [];
	const jobs = () => (state.snapshot && state.snapshot.jobs) || [];
	const projectByPath = p => projects().find(x => x.path === p);
	const hasNucleo = () => {
		const s = state.snapshot;
		if (!s) return false;
		if (typeof s.nucleo === 'boolean') return s.nucleo;
		return !!s.system;
	};
	const assistant = () => state.assistant || (state.snapshot && state.snapshot.assistant) || null;
	/** Un campo della sezione 4 dello snapshot; undefined se l'estensione e' vecchia. */
	const snap = k => (state.snapshot ? state.snapshot[k] : undefined);
	const rulesOf = path => {
		const r = snap('rules');
		return (r && r.projects && r.projects[path]) || null;
	};
	/* ---------- il lavoro: una sola fonte per tutti i numeri ----------
	   Per Andrea ogni sessione Claude viva e' un lavoro, anche se e' aperta fuori dalla Bottega.
	   snapshot.work e snapshot.workCounts sono la verita'; con un'estensione vecchia la lista si
	   ricava qui da jobs e live con le stesse regole, e i numeri si contano sempre dalla lista. */

	const WORK_ORDER = ['ti aspetta', 'in corso', 'nel terminale', 'in coda', 'stanotte'];
	const LIVE_STATUS = { busy: 'in corso', idle: 'ti aspetta', shell: 'nel terminale' };
	/** @type {{snap: any, list: any[]}} */ let workMemo = { snap: null, list: [] };

	function workList() {
		const s = state.snapshot;
		if (!s) return [];
		if (Array.isArray(s.work)) return s.work;
		if (workMemo.snap === s) return workMemo.list;
		const js = Array.isArray(s.jobs) ? s.jobs : [];
		const list = js
			.filter(j => WORK_ORDER.includes(j.status))
			.map(j => ({
				key: 'job:' + j.id, source: 'bottega', status: j.status, project: j.project, path: j.path, title: j.task,
				since: j.status === 'ti aspetta' ? j.lastActivity || j.startedAt || j.createdAt : j.startedAt || j.createdAt,
				jobId: j.id, sessionId: j.sessionId, pid: j.pid, night: j.night,
			}));
		const mine = new Set(js.map(j => j.sessionId).filter(Boolean));
		for (const l of Array.isArray(s.live) ? s.live : []) {
			if (l.sessionId && mine.has(l.sessionId)) continue;
			const p = (s.projects || []).find(x => (x.live || []).some(y => y.pid === l.pid));
			list.push({
				key: 'pid:' + l.pid, source: 'altrove', status: LIVE_STATUS[l.status] || 'in corso',
				project: p ? p.name : String(l.cwd || '').split('/').pop() || 'home', path: p ? p.path : l.cwd,
				title: l.title || '', since: l.statusSince, sessionId: l.sessionId, pid: l.pid,
			});
		}
		list.sort((a, b) => WORK_ORDER.indexOf(a.status) - WORK_ORDER.indexOf(b.status) || (a.since || 0) - (b.since || 0));
		workMemo = { snap: s, list };
		return list;
	}

	function workCounts() {
		const wc = snap('workCounts');
		if (wc && typeof wc === 'object') return wc;
		const w = workList();
		const c = st => w.filter(x => x.status === st).length;
		const s = state.snapshot;
		return {
			inCorso: c('in corso'), tiAspetta: c('ti aspetta'), nelTerminale: c('nel terminale'), inCoda: c('in coda'), stanotte: c('stanotte'),
			vive: s && Array.isArray(s.live) ? s.live.length : 0,
		};
	}

	/** Il lavoro che corrisponde a una sessione viva (stesso pid o stessa sessione). */
	const workOfLive = l => workList().find(w => (w.pid && w.pid === l.pid) || (l.sessionId && w.sessionId === l.sessionId));

	/** 'rosso', 'giallo' o '' (verde o nessun controllo) */
	const ruleLevel = path => {
		const r = rulesOf(path);
		return r && (r.livello === 'rosso' || r.livello === 'giallo') ? r.livello : '';
	};

	// ---------- lo scheletro, costruito una volta ----------

	app.innerHTML = `
	<header class="top">
		<p class="brand">Bottega</p>
		<div class="tabs" role="tablist" aria-label="Stanze della Bottega">
			${VIEWS.map(
				([id, label], i) =>
					`<button type="button" role="tab" id="tab-${id}" data-view="${id}" aria-controls="vista-${id}" aria-selected="false" tabindex="-1" title="${label}, tasto ${i + 1}"><i class="lume" aria-hidden="true"></i><span>${label}</span><span class="segnale" id="segnale-${id}" hidden></span></button>`,
			).join('')}
		</div>
		<p class="sistema" id="sistema"></p>
	</header>

	<section class="vista" id="vista-plancia" role="tabpanel" aria-labelledby="tab-plancia" hidden>
		<p class="empty" id="plancia-attesa">Sto leggendo i progetti e le sessioni Claude.</p>
		<div id="plancia-corpo" hidden>
			<h1 class="sentence" id="frase"></h1>
			<ul class="lamps" id="lampade" aria-label="Sessioni Claude aperte adesso"></ul>
			<p class="quiet" id="lampade-vuote" hidden>Nessuna sessione Claude Code aperta in questo momento.</p>
			<div class="mattino" id="mattino">
				<section class="alba" id="briefing" aria-labelledby="briefing-titolo" hidden></section>
				<section class="consigli" id="consigli" aria-labelledby="consigli-titolo" hidden></section>
			</div>
			<section class="quadro" id="quadro" aria-labelledby="quadro-titolo" hidden>
				<h2 class="sr" id="quadro-titolo">Il quadro in cifre</h2>
				<ul class="quadro-cifre" id="quadro-cifre"></ul>
			</section>
			<section class="fermi" id="fermi" aria-labelledby="fermi-titolo" hidden>
				<h2 id="fermi-titolo">Fermi da un po'</h2>
				<p class="nota">Progetti che non tocchi da almeno due settimane, e perché valgono uno sguardo.</p>
				<ul class="fermi-lista" id="fermi-lista"></ul>
			</section>
			<div class="bar">
				<input class="search" id="cerca-progetti" type="search" placeholder="Cerca un progetto" aria-label="Cerca un progetto" autocomplete="off" spellcheck="false">
				<div class="filters" id="filtri" role="group" aria-label="Filtra i progetti"></div>
				<div class="stamp"><span id="letto"></span><button type="button" class="ghost" data-act="refresh" data-fk="refresh">Aggiorna</button></div>
			</div>
			<ul class="rows" id="righe"></ul>
			<p class="empty" id="righe-vuote" hidden>Nessun progetto corrisponde. Cambia filtro o svuota la ricerca.</p>
			<section class="elsewhere history" id="altrove" hidden></section>
		</div>
	</section>

	<section class="vista" id="vista-lavori" role="tabpanel" aria-labelledby="tab-lavori" hidden>
		<h1 class="sentence media" id="frase-lavori"></h1>
		<div class="lavori">
			<section class="gruppo aspettano" id="g-aspetta" aria-labelledby="g-aspetta-titolo" hidden>
				<h2 id="g-aspetta-titolo">Ti aspettano</h2>
				<ul class="lista-lavori" id="l-aspetta"></ul>
			</section>
			<form class="pannello composer" id="composer" aria-labelledby="composer-titolo" autocomplete="off">
				<h2 id="composer-titolo">Nuovo lavoro</h2>
				<label class="campo" for="scegli-progetto">Progetto</label>
				<div class="combo">
					<input id="scegli-progetto" type="text" role="combobox" aria-expanded="false" aria-controls="progetti-lista" aria-autocomplete="list" placeholder="Cerca tra i progetti" spellcheck="false">
					<ul class="opzioni" id="progetti-lista" role="listbox" aria-label="Progetti" hidden></ul>
				</div>
				<p class="dove" id="composer-dove"></p>
				<label class="campo" for="compito">Cosa deve fare Claude</label>
				<textarea id="compito" rows="5" placeholder="Per esempio: sistema il crash all'avvio su iOS 27 e fai salire la build"></textarea>
				<label class="spunta" id="composer-notte-riga" hidden><input type="checkbox" id="composer-notte" aria-describedby="composer-notte-nota"><span>Stanotte</span></label>
				<p class="spunta-nota" id="composer-notte-nota" hidden>Parte nella finestra della notte, senza push e senza pubblicare niente.</p>
				<div class="composer-piede">
					<button type="submit" class="act main" id="avvia">Avvia il lavoro</button>
					<span class="tasti"><kbd>⌘</kbd> <kbd>Invio</kbd></span>
				</div>
				<p class="esito" id="composer-esito" role="status"></p>
				<p class="limite" id="limite"></p>
			</form>
			<div class="resto">
				<p class="invito" id="lavori-vuoto" hidden>Ogni lavoro è una sessione Claude che lavora da sola su un progetto. Scegli il progetto, scrivi cosa deve fare e avvialo: quando ha bisogno di te lo trovi in cima, acceso.</p>
				<section class="gruppo" id="g-corso" aria-labelledby="g-corso-titolo" hidden><h2 id="g-corso-titolo">In corso</h2><ul class="lista-lavori" id="l-corso"></ul></section>
				<section class="gruppo" id="g-terminale" aria-labelledby="g-terminale-titolo" hidden><h2 id="g-terminale-titolo">Nel terminale</h2><ul class="lista-lavori" id="l-terminale"></ul></section>
				<section class="gruppo" id="g-coda" aria-labelledby="g-coda-titolo" hidden><h2 id="g-coda-titolo">In coda</h2><ul class="lista-lavori" id="l-coda"></ul></section>
				<section class="gruppo stanotte" id="g-stanotte" aria-labelledby="g-stanotte-titolo" hidden>
					<h2 id="g-stanotte-titolo">Stanotte</h2>
					<div class="notte-riga" id="notte-riga"></div>
					<form class="notte-form" id="notte-form" aria-label="Finestra della notte" autocomplete="off" hidden>
						<label class="campo" for="notte-da">Dalle</label>
						<input type="time" id="notte-da" step="900" required>
						<label class="campo" for="notte-a">alle</label>
						<input type="time" id="notte-a" step="900" required>
						<label class="campo" for="notte-insieme">Insieme</label>
						<select id="notte-insieme"><option value="1">un lavoro</option><option value="2">due lavori</option></select>
						<span class="notte-form-piede"><button type="submit" class="act main">Salva</button><button type="button" class="act" data-act="notte-edit" data-fk="notte-annulla">Annulla</button></span>
					</form>
					<p class="promemoria">Di notte i lavori non fanno push e non pubblicano niente: lo trovi scritto nel loro prompt.</p>
					<ul class="lista-lavori" id="l-stanotte"></ul>
					<p class="quiet notte-vuota" id="notte-vuota" hidden>Niente in fila per stanotte. Spunta «Stanotte» nel nuovo lavoro per metterne uno.</p>
					<div class="resoconto" id="notte-resoconto" hidden></div>
				</section>
				<section class="gruppo chiusi" id="g-finiti" aria-labelledby="g-finiti-titolo" hidden>
					<h2 id="g-finiti-titolo">Finiti</h2>
					<button type="button" class="ghost togli-tutti" data-act="jobs-clear" data-fk="jobs-clear">Togli i finiti</button>
					<ul class="lista-lavori" id="l-finiti"></ul>
				</section>
				<section class="gruppo chiusi" id="g-fermati" aria-labelledby="g-fermati-titolo" hidden><h2 id="g-fermati-titolo">Fermati</h2><ul class="lista-lavori" id="l-fermati"></ul></section>
			</div>
		</div>
	</section>

	<section class="vista" id="vista-memoria" role="tabpanel" aria-labelledby="tab-memoria" hidden>
		<h1 class="sentence media" id="frase-memoria"></h1>
		<div class="memoria">
			<div class="mem-main">
				<div class="modi" id="mem-modi" role="group" aria-label="Come cercare">
					<button type="button" data-memmode="ricordi" data-fk="memmode:ricordi" aria-pressed="true">Linea del tempo</button>
					<button type="button" data-memmode="ricerca" data-fk="memmode:ricerca" aria-pressed="false">Dove l'ho già risolto?</button>
				</div>
				<form class="mem-bar" id="mem-cerca" role="search" autocomplete="off">
					<input class="search" id="cerca-memoria" type="search" placeholder="Cerca nei ricordi, per esempio notifiche push" aria-label="Cerca nei ricordi" spellcheck="false">
					<select id="mem-progetto" aria-label="In quale progetto cercare"></select>
				</form>
				<div id="mem-risultati" class="mem-risultati"></div>
				<form class="mem-bar" id="ric-cerca" role="search" autocomplete="off" hidden>
					<input class="search" id="cerca-risolto" type="search" placeholder="Per esempio: refresh token scaduto" aria-label="Cerca nei ricordi e nel codice di tutti i progetti" spellcheck="false">
					<button type="submit" class="act main">Cerca</button>
				</form>
				<div id="ric-risultati" class="mem-risultati" hidden></div>
			</div>
			<aside class="mem-lato">
				<form class="pannello ricorda" id="ricorda" aria-labelledby="ricorda-titolo" autocomplete="off">
					<h2 id="ricorda-titolo">Ricorda una cosa</h2>
					<label class="sr" for="ricorda-testo">Cosa ricordare</label>
					<textarea id="ricorda-testo" rows="3" placeholder="Per esempio: su Peak la build sale con scripts/bump-build.sh"></textarea>
					<label class="campo" for="ricorda-progetto">Per il progetto</label>
					<select id="ricorda-progetto"></select>
					<div class="composer-piede"><button type="submit" class="act main">Ricorda</button></div>
					<p class="esito" id="ricorda-esito" role="status"></p>
				</form>
				<section class="bacheca" id="bacheca" aria-labelledby="bacheca-titolo" hidden>
					<h2 id="bacheca-titolo">Adesso nelle sessioni</h2>
					<p class="nota">Cosa stanno facendo le sessioni Claude aperte, progetto per progetto.</p>
					<div id="bacheca-lista"></div>
				</section>
			</aside>
		</div>
	</section>

	<section class="vista" id="vista-melissa" role="tabpanel" aria-labelledby="tab-melissa" hidden>
		<div class="melissa">
			<div class="notte" id="notte">
				<canvas id="sfera" aria-hidden="true"></canvas>
				<div class="notte-testo">
					<h1 class="stato-melissa" id="melissa-stato">Melissa</h1>
					<p class="conversa" id="conversa" hidden><i class="pallino" aria-hidden="true"></i>In conversazione <button type="button" class="chiudi-conversa" data-act="voice-end" data-fk="voice-end">Chiudi</button></p>
					<p class="parziale" id="parziale" aria-live="polite"></p>
					<p class="cervello" id="cervello"></p>
					<p class="senza-nucleo" id="senza-nucleo" hidden>La voce passa dal Nucleo, l'app nativa della Bottega che ascolta, parla e accende la sfera. Adesso non risulta avviato, quindi Melissa non sente e non parla. Puoi comunque scriverle qui accanto.</p>
				</div>
			</div>
			<div class="melissa-corpo">
				<div class="melissa-comandi">
					<button type="button" role="switch" class="interruttore" id="voce" aria-checked="false" data-fk="voce"><span class="binario" aria-hidden="true"><i></i></span><span>Ascolto a voce</span></button>
					<p class="suggerimento" id="suggerimento">Tocca <kbd>Opzione</kbd> e <kbd>Spazio</kbd> per parlare liberamente, tieni premuto per un solo comando. Funziona ovunque sul Mac.</p>
				</div>
				<ol class="registro" id="registro" aria-label="Conversazione con Melissa"></ol>
				<p class="invito" id="registro-vuoto" hidden>Ancora nessuna conversazione. Tieni premuto Opzione e Spazio e parla, oppure scrivile qui sotto.</p>
				<form class="chiedi" id="chiedi" autocomplete="off">
					<label class="sr" for="domanda">Scrivi a Melissa</label>
					<textarea id="domanda" rows="2" placeholder="Scrivi a Melissa, per esempio: quali progetti aspettano un push?"></textarea>
					<button type="submit" class="act main">Chiedi</button>
				</form>
			</div>
		</div>
	</section>

	<section class="vista" id="vista-cruscotto" role="tabpanel" aria-labelledby="tab-cruscotto" hidden></section>
	<section class="vista" id="vista-vedetta" role="tabpanel" aria-labelledby="tab-vedetta" hidden></section>
	<section class="vista" id="vista-clienti" role="tabpanel" aria-labelledby="tab-clienti" hidden></section>

	<div class="velo" id="continua-velo" hidden>
		<div class="dialogo" id="continua" role="dialog" aria-modal="true" aria-labelledby="continua-titolo" aria-describedby="continua-fonti">
			<h2 id="continua-titolo">Continua da dove eri</h2>
			<p class="fonti" id="continua-fonti"></p>
			<label class="campo" for="continua-testo">Cosa deve fare Claude</label>
			<textarea id="continua-testo" rows="10" spellcheck="false"></textarea>
			<label class="spunta"><input type="checkbox" id="continua-notte" aria-describedby="continua-notte-nota"><span>Stanotte</span></label>
			<p class="spunta-nota" id="continua-notte-nota">Parte nella finestra della notte, senza push e senza pubblicare niente.</p>
			<p class="esito" id="continua-esito" role="status"></p>
			<div class="composer-piede">
				<button type="button" class="act main" id="continua-avvia">Avvia</button>
				<button type="button" class="act" id="continua-annulla">Annulla</button>
				<span class="tasti"><kbd>Esc</kbd> chiude</span>
			</div>
		</div>
	</div>

	<p class="sr" id="annuncio" aria-live="polite"></p>`;

	$('cerca-progetti').value = state.query;
	$('compito').value = state.draft.task;
	$('composer-notte').checked = state.draft.night;
	$('cerca-memoria').value = state.mem.query;
	$('cerca-risolto').value = state.ric.query;
	$('domanda').value = state.ask;

	/* Le stanze esterne: stesso host per tutte. Se lo script manca (file non caricato o rotto) la
	   stanza dice una frase sobria, e la plancia va avanti. */
	const ROOMS = [
		['cruscotto', 'BottegaCruscotto', 'crus', 'Il cruscotto'],
		['vedetta', 'BottegaVedetta', 'vedetta', 'La Vedetta'],
		['clienti', 'BottegaClienti', 'clienti', 'La stanza dei clienti'],
	];
	/** @type {Record<string, any>} */ const rooms = {};
	for (const [id, global, key, name] of ROOMS) {
		const G = /** @type {any} */ (window)[global];
		const root = $('vista-' + id);
		try {
			rooms[id] = G && G.mount
				? G.mount(root, {
						post: m => vscode.postMessage(m),
						saved: state[key],
						save: o => {
							state[key] = o;
							persist();
						},
						reduced,
						focusProject: p => focusRow(p),
					})
				: null;
		} catch (err) {
			rooms[id] = null;
			console.error(`Bottega: ${id} non si monta`, err);
		}
		if (!rooms[id]) root.innerHTML = `<p class="empty">${name} non è disponibile in questa versione della Bottega.</p>`;
	}
	const crus = rooms.cruscotto;
	/** Chiama un metodo di una stanza esterna senza lasciare che un suo errore fermi la plancia. */
	function room(id, method, ...args) {
		const r = rooms[id];
		if (!r || typeof r[method] !== 'function') return;
		try {
			r[method](...args);
		} catch (err) {
			console.error(`Bottega: ${id}.${method}`, err);
		}
	}

	// ---------- testata: stanze e stato del Mac ----------

	function limitFor(s) {
		if (typeof s.jobLimit === 'number') return { n: s.jobLimit, why: s.jobLimitReason || '', tight: false };
		const sys = s.system;
		if (!sys) return { n: 2, why: 'senza il Nucleo non vedo la memoria del Mac, quindi vado piano', tight: false };
		const total = sys.memoryTotalGB || 16;
		const base = total >= 48 ? 5 : total >= 24 ? 4 : 3;
		if (sys.memoryPressure === 'critical') return { n: 1, why: 'la memoria è al limite', tight: true };
		if (sys.thermal === 'critical' || sys.thermal === 'serious') return { n: 1, why: 'il Mac scalda', tight: true };
		if (sys.memoryPressure === 'warning') return { n: Math.min(base, 2), why: 'la memoria è sotto pressione', tight: true };
		if (sys.thermal === 'fair') return { n: Math.max(2, base - 1), why: 'il Mac è tiepido', tight: false };
		return { n: base, why: `memoria tranquilla, ${num(sys.memoryUsedGB)} GB su ${num(total)} in uso`, tight: false };
	}

	function systemInfo(sys) {
		if (!sys) return { loud: false, text: 'Stato del Mac non disponibile senza il Nucleo' };
		const load = (sys.load && sys.load[0]) || 0;
		const cores = sys.cores || 8;
		const mem = `${num(sys.memoryUsedGB)} GB su ${num(sys.memoryTotalGB)}`;
		const warn = [];
		if (sys.memoryPressure === 'critical') warn.push(`memoria al limite, ${mem}`);
		else if (sys.memoryPressure === 'warning') warn.push(`memoria sotto pressione, ${mem}`);
		if (sys.thermal === 'critical') warn.push('il Mac è bollente');
		else if (sys.thermal === 'serious') warn.push('il Mac scalda');
		if (load > cores) warn.push(`carico ${num(load)} su ${cores} core`);
		if (warn.length) return { loud: true, text: cap(warn.join(', ')) };
		const temp = sys.thermal === 'fair' ? 'Mac tiepido' : 'Mac tranquillo';
		return { loud: false, text: `${temp}: carico ${num(load)}, memoria ${mem}` };
	}

	const VOICE_WORD = { listening: 'ascolta', thinking: 'pensa', speaking: 'parla', error: 'non riesce' };

	function renderHeader() {
		const s = state.snapshot;
		for (const [id] of VIEWS) {
			const on = id === state.view;
			const t = $('tab-' + id);
			t.setAttribute('aria-selected', String(on));
			t.tabIndex = on ? 0 : -1;
		}
		const waiting = workCounts().tiAspetta || 0;
		const sl = $('segnale-lavori');
		sl.hidden = !waiting;
		setHTML(sl, waiting ? `${waiting}<span class="sr"> ${waiting === 1 ? 'ti aspetta' : 'ti aspettano'}</span>` : '');

		const a = assistant();
		const sm = $('segnale-melissa');
		const st = a && a.state !== 'idle' && VOICE_WORD[a.state] ? a.state : a && a.conversing ? 'listening' : '';
		sm.hidden = !st;
		sm.className = 'segnale punto' + (st ? ' st-' + st : '');
		setHTML(sm, st ? `<span class="sr"> ${VOICE_WORD[st]}</span>` : '');

		// Vedetta: un puntino di brace finche' c'e' una regola rossa
		const rules = snap('rules');
		const red = (rules && rules.counts && rules.counts.rosso) || 0;
		const sv = $('segnale-vedetta');
		sv.hidden = !red;
		sv.className = 'segnale punto' + (red ? ' st-rosso' : '');
		setHTML(sv, red ? `<span class="sr"> ${red === 1 ? 'una regola rossa' : `${fem(red)} regole rosse`}</span>` : '');

		const info = systemInfo(s && s.system);
		const el = $('sistema');
		el.textContent = info.text;
		el.classList.toggle('forte', info.loud);
		if (s && s.system) el.title = `Carico ${(s.system.load || []).map(num).join(', ')} (1, 5, 15 min), ${s.system.cores} core, memoria ${s.system.memoryPressure}, temperatura ${s.system.thermal}`;
		if (info.loud && !state.loud) announce(info.text);
		state.loud = info.loud;
	}

	// ---------- Plancia ----------

	const STATUS = { busy: 'al lavoro', idle: 'ti aspetta', shell: 'nel terminale' };
	const KIND = { apple: 'Apple', web: 'Web', android: 'Android', python: 'Python', swiftpm: 'Swift package', docs: 'Documenti', altro: 'Altro' };

	const FILTERS = [
		['tutti', 'Tutti', () => true],
		['regole', 'Regole', p => !!ruleLevel(p.path)],
		['claude', 'Claude oggi', p => p.live.length > 0 || (p.sessions[0] && Date.now() - p.sessions[0].mtime < day)],
		['push', 'Da spingere', p => p.git && (p.git.ahead > 0 || !p.git.upstream)],
		['dirty', 'Con modifiche', p => p.git && p.git.changes > 0],
		['apple', 'Apple', p => p.kinds.includes('apple') || p.kinds.includes('swiftpm')],
		['web', 'Web', p => p.kinds.includes('web')],
		['android', 'Android', p => p.kinds.includes('android')],
		['nogit', 'Senza git', p => !p.git],
	];

	/** La maiuscola va sulla parola, prima di avvolgerla nello span. */
	const n = (x, first) => `<span class="n">${first ? cap(word(x)) : word(x)}</span>`;

	/** "Peak ti aspetta.", "Peak e Fontanelle ti aspettano.", "Tre lavori ti aspettano." */
	function waitingPhrase(list, count = list.length) {
		if (!count) return '';
		const names = [...new Set(list.map(j => j.project))];
		if (count === 1 && names.length === 1) return `${esc(names[0])} ti aspetta.`;
		if (count === 2 && names.length === 2) return `${esc(names[0])} e ${esc(names[1])} ti aspettano.`;
		return count === 1 ? `${n(1, true)} lavoro ti aspetta.` : `${n(count, true)} lavori ti aspettano.`;
	}

	function sentence(s) {
		const c = workCounts();
		const busy = c.inCorso || 0;
		const term = c.nelTerminale || 0;
		const toPush = s.projects.filter(p => p.git && p.git.ahead > 0).length;
		const noRemote = s.projects.filter(p => p.git && !p.git.upstream).length;
		const dirty = s.projects.filter(p => p.git && p.git.changes > 0).length;
		const w = waitingPhrase(workList().filter(x => x.status === 'ti aspetta'), c.tiAspetta || 0);
		let out = w ? w + ' ' : '';
		out += busy === 0 ? 'Nessun Claude al lavoro' : `${n(busy, true)} Claude al lavoro`;
		if (term) out += `, ${term === 1 ? '<span class="n">uno</span>' : n(term)} nel terminale`;
		out += '.';
		if (toPush) out += toPush === 1 ? ` ${n(1, true)} progetto aspetta un push.` : ` ${n(toPush, true)} progetti aspettano un push.`;
		if (noRemote) out += noRemote === 1 ? ` ${n(1, true)} progetto non ha un remoto.` : ` ${n(noRemote, true)} progetti non hanno un remoto.`;
		if (!toPush && !noRemote) out += ' Tutto spinto.';
		if (dirty) out += dirty === 1 ? ` ${n(1, true)} ha modifiche fuori da un commit.` : ` ${n(dirty, true)} hanno modifiche fuori da un commit.`;
		return out;
	}

	const projectOfLive = (s, l) => s.projects.find(p => p.live.some(x => x.pid === l.pid));

	function lampHTML(s, l) {
		const p = projectOfLive(s, l);
		const where = p ? p.name : l.cwd === s.home ? 'home' : l.cwd.split('/').pop();
		// lo stato della lampada e' quello del lavoro corrispondente: stessi conti di Lavori
		const wi = workOfLive(l);
		const st = wi ? wi.status : LIVE_STATUS[l.status] || 'in corso';
		const waits = st === 'ti aspetta';
		const cls = waits ? 'aspetta' : st === 'in corso' ? 'busy' : '';
		const verb = waits ? 'ti aspetta' : st === 'in corso' ? 'al lavoro' : st;
		const what = `${verb} ${since((wi && wi.since) || l.statusSince)}`;
		const act =
			waits && wi && wi.jobId
				? `data-act="job.focus" data-id="${esc(wi.jobId)}"`
				: `data-act="${p ? 'focus' : 'claude-here'}" data-path="${esc(p ? p.path : l.cwd)}"`;
		return `<li><button type="button" class="lamp ${cls}" ${act} data-fk="lamp:${l.pid}" title="${esc(l.cwd)}, PID ${l.pid}">
			<i class="dot" aria-hidden="true"></i><b>${esc(where)}</b>
			<span>${esc(what)}${l.title ? ', ' + esc(l.title) : ''}</span>
		</button></li>`;
	}

	function mark(p) {
		if (p.live.length) return ['live', 'Claude sta lavorando qui'];
		if (!p.git) return ['none', 'Non è un repository git'];
		if (p.git.ahead > 0 || !p.git.upstream) return ['push', 'Commit da spingere'];
		if (p.git.changes > 0) return ['dirty', 'Modifiche fuori da un commit'];
		return ['ok', 'Tutto in commit e spinto'];
	}

	function gitCell(p) {
		if (!p.git) return 'nessun git';
		const bits = [esc(p.git.branch)];
		if (!p.git.upstream) bits.push('<span class="warn">senza remoto</span>');
		if (p.git.ahead) bits.push(`<span class="warn">+${p.git.ahead}</span>`);
		if (p.git.behind) bits.push(`−${p.git.behind}`);
		if (p.git.changes) bits.push(`${p.git.changes} mod.`);
		return bits.join(' ');
	}

	function buildCell(p) {
		if (!p.build) return '';
		if (p.build.number) return `build ${esc(p.build.number)}`;
		return `v${esc(p.build.marketing)}`;
	}

	function detail(p) {
		const facts = [
			['Cartella', `<code>${esc(home(p.path))}</code>`],
			['Tipo', p.kinds.map(k => KIND[k] || k).join(', ')],
		];
		if (p.git) facts.push(['Ultimo commit', `${esc(p.git.lastCommitSubject || 'nessuno')} <span class="w">(${esc(ago(p.git.lastCommitAt))})</span>`]);
		if (p.build) facts.push(['Versione', [p.build.marketing, p.build.number && `build ${p.build.number}`].filter(Boolean).map(esc).join(', ')]);
		facts.push(['CLAUDE.md', p.hasClaudeMd ? 'presente' : 'manca']);
		const pa = esc(p.path);
		const btn = (act, label, main) =>
			`<button type="button" class="act${main ? ' main' : ''}" data-act="${act}" data-path="${pa}" data-fk="${act}:${pa}">${label}</button>`;
		const waitingCont = state.contWaiting === p.path;
		const actions = [
			btn('claude', 'Nuova sessione Claude', true),
			`<button type="button" class="act" data-act="continua" data-path="${pa}" data-fk="continua:${pa}"${waitingCont ? ' aria-busy="true"' : ''}>${waitingCont ? 'Preparo il prompt' : 'Continua da dove eri'}</button>`,
			btn('job-here', 'Affida un lavoro'),
			btn('open', 'Apri in una nuova finestra'),
			btn('here', 'Apri qui'),
			p.xcodeProject ? btn('xcode', 'Apri in Xcode') : '',
			btn('finder', 'Mostra nel Finder'),
			p.git && p.git.ahead > 0 && p.git.upstream ? btn('push', `Spingi ${p.git.ahead} commit`) : '',
		].join('');
		const hist = p.sessions.length
			? `<ol>${p.sessions
					.slice(0, 6)
					.map(
						s => `<li><span class="t" title="${esc(s.title)}">${esc(s.title)}</span><span class="w">${esc(ago(s.mtime))}</span>
						<button type="button" class="link" data-act="resume" data-path="${esc(s.cwd)}" data-id="${esc(s.sessionId)}" data-fk="resume:${esc(s.sessionId)}">Riprendi</button></li>`,
					)
					.join('')}</ol>`
			: `<p class="w">Nessuna sessione Claude negli ultimi 45 giorni.</p>`;
		return `<div class="detail" ${state.open.has(p.path) ? '' : 'hidden'}>
			${hitsHTML(p)}
			<div><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl><div class="actions">${actions}</div></div>
			<div class="history"><h3>Sessioni Claude</h3>${hist}</div>
			${worktreesHTML(p)}
		</div>`;
	}

	/** "una rossa e due gialle" dalle violazioni di un progetto. */
	function hitsWords(hits) {
		const r = hits.filter(h => h.livello === 'rosso').length;
		const g = hits.filter(h => h.livello === 'giallo').length;
		const parts = [];
		if (r) parts.push(`${fem(r)} ${r === 1 ? 'rossa' : 'rosse'}`);
		if (g) parts.push(`${fem(g)} ${g === 1 ? 'gialla' : 'gialle'}`);
		return parts.join(' e ');
	}

	/** Il semaforo accanto al nome: solo se c'e' qualcosa di rosso o di giallo. */
	function semaforo(p) {
		const lv = ruleLevel(p.path);
		if (!lv) return '';
		const r = /** @type {any} */ (rulesOf(p.path));
		const words = hitsWords(r.hits || []) || (lv === 'rosso' ? 'una rossa' : 'una gialla');
		const label = `Regole da sistemare: ${words}`;
		return `<i class="semaforo ${lv}" role="img" aria-label="${esc(label)}" title="${esc(label)}"></i>`;
	}

	/** Le violazioni nel dettaglio di un progetto, con frase, rimedio e azione. */
	function hitsHTML(p) {
		const r = rulesOf(p.path);
		const hits = (r && Array.isArray(r.hits) ? r.hits : []).filter(h => h.livello === 'rosso' || h.livello === 'giallo');
		if (!hits.length) return '';
		hits.sort((a, b) => (a.livello === b.livello ? 0 : a.livello === 'rosso' ? -1 : 1));
		return `<div class="regole-progetto">
			<h3>Regole da sistemare <span class="w">${esc(hitsWords(hits))}${r && r.checkedAt ? `, controllate ${esc(ago(r.checkedAt))}` : ''}</span></h3>
			<ul>${hits
				.map(
					(h, i) => `<li class="hit l-${h.livello}">
						<i class="semaforo ${h.livello}" role="img" aria-label="${h.livello === 'rosso' ? 'Rossa' : 'Gialla'}"></i>
						<div class="hit-corpo">
							<p class="hit-frase">${esc(h.frase)}</p>
							${h.rimedio ? `<p class="hit-rimedio">${esc(h.rimedio)}</p>` : ''}
							${Array.isArray(h.dettagli) && h.dettagli.length ? `<ul class="hit-dettagli">${h.dettagli.slice(0, 6).map(d => `<li>${esc(d)}</li>`).join('')}${h.dettagli.length > 6 ? `<li class="w">e altri ${h.dettagli.length - 6}</li>` : ''}</ul>` : ''}
						</div>
						${h.azione && h.azione.act ? actBtn(h.azione, `hit:${p.path}:${h.id || i}`, h.livello === 'rosso' ? 'act main' : 'act', { path: p.path }) : ''}
					</li>`,
				)
				.join('')}</ul>
		</div>`;
	}

	const worktrees = p => (Array.isArray(p.worktrees) ? p.worktrees.filter(w => w && w.path) : []);

	/** "+ ramo idee", "+ 2 rami": i worktree stanno dentro il loro progetto, non sono progetti a se'. */
	function ramiTag(p) {
		const wt = worktrees(p);
		if (!wt.length) return '';
		const label = wt.length === 1 ? `+ ramo ${wt[0].branch || 'senza nome'}` : `+ ${wt.length} rami`;
		const title = wt.map(w => `${w.branch || 'senza ramo'}: ${home(w.path)}`).join('\n');
		return `<span class="rami" title="${esc(title)}">${esc(label)}</span>`;
	}

	function worktreesHTML(p) {
		const wt = worktrees(p);
		if (!wt.length) return '';
		return `<div class="worktree">
			<h3>${wt.length === 1 ? 'Un altro ramo aperto' : `${cap(word(wt.length))} rami aperti`} <span class="w">worktree git</span></h3>
			<ul>${wt
				.map(w => {
					const bits = [];
					if (w.changes) bits.push(`${w.changes} ${w.changes === 1 ? 'modifica' : 'modifiche'}`);
					if (w.ahead) bits.push(`<span class="warn">${w.ahead} ${w.ahead === 1 ? 'commit' : 'commit'} da spingere</span>`);
					if (!w.upstream) bits.push('<span class="warn">senza remoto</span>');
					if (!bits.length) bits.push('tutto in commit e spinto');
					const pa = esc(w.path);
					return `<li><span class="wt-ramo">${esc(w.branch || 'senza ramo')}</span><code class="wt-dove">${esc(home(w.path))}</code><span class="wt-stato">${bits.join(', ')}</span>
						<button type="button" class="act piccolo" data-act="open" data-path="${pa}" data-fk="wt-open:${pa}">Apri</button></li>`;
				})
				.join('')}</ul>
		</div>`;
	}

	function rowHTML(p) {
		const [cls, label] = mark(p);
		const last = p.sessions[0];
		const what = (p.live[0] && p.live[0].title) || (last && last.title) || (p.git && p.git.lastCommitSubject) || '';
		const isOpen = state.open.has(p.path);
		return `<li class="row" data-row="${esc(p.path)}">
			<button type="button" data-act="toggle" data-path="${esc(p.path)}" data-fk="row:${esc(p.path)}" aria-expanded="${isOpen}">
				<i class="mark ${cls}" role="img" aria-label="${esc(label)}" title="${esc(label)}"></i>
				<span class="name"><span class="name-t">${esc(p.name)}</span>${semaforo(p)}${ramiTag(p)}</span>
				<span class="what">${esc(what)}</span>
				<span class="git">${gitCell(p)}</span>
				<span class="build">${buildCell(p)}</span>
				<span class="when">${esc(ago(p.touchedAt))}</span>
			</button>
			${detail(p)}
		</li>`;
	}

	function elsewhereHTML(s) {
		return `<h2>Sessioni fuori dai progetti</h2>
			<p>Partite dalla home o da cartelle che la Bottega non conosce. Riprenderle le riapre nella stessa cartella.</p>
			<ol>${s.elsewhere
				.slice(0, 12)
				.map(
					x => `<li><span class="t"><span title="${esc(x.title)}">${esc(x.title)}</span><span class="cwd">${esc(home(x.cwd))}</span></span>
					<span class="w">${esc(ago(x.mtime))}</span>
					<button type="button" class="link" data-act="resume" data-path="${esc(x.cwd)}" data-id="${esc(x.sessionId)}" data-fk="resume:${esc(x.sessionId)}">Riprendi</button></li>`,
				)
				.join('')}</ol>`;
	}

	// ---------- Home: briefing, consigli, cifre, progetti fermi ----------

	const POINT_KIND = { ore: 'Ore', lavori: 'Lavori', store: 'Store', soldi: 'Soldi', regole: 'Regole', dimenticati: 'Fermi', notte: 'Notte' };

	function briefTitle(b) {
		return !b.date || b.date === dayKey() ? 'Il briefing di oggi' : `Il briefing di ${dateWords(b.date)}`;
	}

	function briefPoints(b) {
		const pts = Array.isArray(b.points) ? b.points.filter(x => x && x.text) : [];
		if (!pts.length) return '';
		return `<ul class="punti">${pts
			.map(
				(x, i) => `<li class="punto">
					<span class="punto-tipo">${esc(POINT_KIND[x.kind] || 'Nota')}</span>
					<p>${esc(x.text)}</p>
					${x.act && x.act.act ? actBtn(x.act, `punto:${i}:${x.act.act}`, 'act piccolo') : ''}
				</li>`,
			)
			.join('')}</ul>`;
	}

	function renderBriefing() {
		const el = $('briefing');
		const s = state.snapshot;
		if (!s || !('briefing' in s)) {
			el.hidden = true;
			return;
		}
		const b = s.briefing;
		el.hidden = false;
		el.classList.toggle('chiusa', !b || !!b.heard);
		if (!b) {
			setHTML(
				el,
				`<h2 class="sr" id="briefing-titolo">Il briefing di oggi</h2>
				<p class="alba-riga-vuota">Il briefing di oggi non c'è ancora. <button type="button" class="link" data-act="briefing.make" data-fk="briefing.make">Preparalo adesso</button></p>`,
			);
			return;
		}
		const made = b.at ? `<span class="w">preparato alle ${esc(clock(b.at))}</span>` : '';
		if (b.heard) {
			const open = state.briefOpen;
			setHTML(
				el,
				`<div class="alba-riga">
					<button type="button" class="alba-apri" data-act="brief-toggle" data-fk="brief-toggle" aria-expanded="${open}" aria-controls="briefing-corpo">
						<i class="freccia" aria-hidden="true"></i><span id="briefing-titolo">${esc(briefTitle(b))}</span>
					</button>
					${made}
					<button type="button" class="link" data-act="briefing.make" data-fk="briefing.make">Rifallo</button>
				</div>
				<div class="alba-corpo" id="briefing-corpo" ${open ? '' : 'hidden'}>
					<p class="alba-testo">${esc(b.text)}</p>
					${briefPoints(b)}
					<div class="alba-piede"><button type="button" class="act" data-act="briefing.listen" data-fk="briefing.listen">Ascolta</button></div>
				</div>`,
			);
			return;
		}
		setHTML(
			el,
			`<div class="alba-testa"><h2 id="briefing-titolo">${esc(briefTitle(b))}</h2>${made}</div>
			<p class="alba-testo">${esc(b.text)}</p>
			${briefPoints(b)}
			<div class="alba-piede">
				<button type="button" class="act main" data-act="briefing.listen" data-fk="briefing.listen">Ascolta</button>
				<button type="button" class="act" data-act="briefing.dismiss" data-fk="briefing.dismiss">Fatto</button>
			</div>`,
		);
	}

	const ENGINE = { apple: 'da Apple Intelligence, sul Mac', regole: 'dalle regole' };

	function renderConsigli() {
		const el = $('consigli');
		const s = state.snapshot;
		if (!s || !('advice' in s)) {
			el.hidden = true;
			return;
		}
		const a = s.advice;
		const items = a && Array.isArray(a.items) ? a.items.filter(x => x && x.text).slice(0, 5) : [];
		el.hidden = false;
		const head = `<h2 id="consigli-titolo">Consigli</h2>`;
		if (!items.length) {
			setHTML(
				el,
				`${head}<p class="quiet">Ancora nessun consiglio. <button type="button" class="link" data-act="advice.refresh" data-fk="advice.refresh">Chiedili adesso</button></p>`,
			);
			return;
		}
		const origin = [ENGINE[a.engine] || ENGINE.regole, a.at ? ago(a.at) : ''].filter(Boolean).join(', ');
		setHTML(
			el,
			`${head}
			<ul class="consigli-lista">${items
				.map(
					(x, i) => `<li><p>${esc(x.text)}</p>${x.act && x.act.act ? actBtn(x.act, `consiglio:${i}:${x.act.act}`, 'link') : ''}</li>`,
				)
				.join('')}</ul>
			<p class="origine"><span>${esc(cap(origin))}</span><button type="button" class="link" data-act="advice.refresh" data-fk="advice.refresh">Rifalli</button></p>`,
		);
	}

	/** Il cruscotto sa le ore: se non le ho, le chiedo io (al massimo ogni due minuti). */
	function askStats() {
		const fresh = state.stats && Date.now() - (state.stats.computedAt || 0) < 15 * 60_000;
		if (fresh || Date.now() - state.statsAskedAt < 120_000) return;
		state.statsAskedAt = Date.now();
		vscode.postMessage({ type: 'stats.request' });
	}

	function cifra(key, view, label, big, small, tone) {
		return `<li class="cifra-h${tone ? ' ' + tone : ''}"><button type="button" data-view="${view}" data-fk="cifra:${key}">
			<span class="cifra-nome">${label}</span><b>${big}</b>${small ? `<small>${small}</small>` : ''}
		</button></li>`;
	}

	function renderQuadro() {
		const s = state.snapshot;
		const cells = [];
		const st = state.stats;
		if (st && st.today) {
			const today = st.today.date === dayKey() ? st.today.you : 0;
			const week = st.week && st.week.now ? st.week.now.you : null;
			cells.push(cifra('oggi', 'cruscotto', 'Oggi', esc(hm(today)), week != null ? `questa settimana ${esc(hm(week))}` : '', ''));
		}
		const radar = snap('radar');
		if (radar && radar.totals) {
			const t = radar.totals;
			const age = radar.admobAt ? `, dato di ${ago(radar.admobAt)}` : '';
			cells.push(cifra('soldi', 'vedetta', 'Ieri', esc(money(t.yesterday, t.currency)), `7 giorni ${esc(money(t.last7, t.currency))}${esc(age)}`, ''));
		}
		const rules = snap('rules');
		if (rules && rules.counts) {
			const r = rules.counts.rosso || 0, g = rules.counts.giallo || 0;
			let big, small, tone = '';
			if (r || g) {
				big = [r ? `${r} ${r === 1 ? 'rossa' : 'rosse'}` : '', g ? `${g} ${g === 1 ? 'gialla' : 'gialle'}` : ''].filter(Boolean).join(', ');
				small = r ? 'da sistemare subito' : 'da sistemare';
				tone = r ? 'rosso' : 'giallo';
			} else {
				big = rules.running && !rules.checkedAt ? 'controllo' : 'in regola';
				small = rules.checkedAt ? `controllate ${ago(rules.checkedAt)}` : '';
			}
			cells.push(cifra('regole', 'vedetta', 'Regole', esc(big), esc(small), tone));
		}
		// stessi numeri della frase, della scheda Lavori e della stanza: tutti da workCounts
		if (s && ('workCounts' in s || 'night' in s || workList().length)) {
			const c = workCounts();
			const run = c.inCorso || 0, wait = c.tiAspetta || 0;
			const small = [
				wait ? `${wait} ${wait === 1 ? 'ti aspetta' : 'ti aspettano'}` : '',
				c.nelTerminale ? `${c.nelTerminale} nel terminale` : '',
				c.inCoda ? `${c.inCoda} in coda` : '',
				c.stanotte ? `${c.stanotte} stanotte` : '',
			]
				.filter(Boolean)
				.join(', ');
			cells.push(cifra('lavori', 'lavori', 'Lavori', run ? `${run} in corso` : 'nessuno in corso', esc(small), wait ? 'giallo' : ''));
		}
		$('quadro').hidden = !cells.length;
		setHTML($('quadro-cifre'), cells.join(''));
	}

	function renderFermi() {
		const list = snap('forgotten');
		const ok = Array.isArray(list) && list.length > 0;
		$('fermi').hidden = !ok;
		if (!ok) return;
		const shown = list.slice(0, 8);
		sync(
			$('fermi-lista'),
			shown,
			f => f.path,
			f => `<li><button type="button" class="fermo" data-act="focus" data-path="${esc(f.path)}" data-fk="fermo:${esc(f.path)}">
				<span class="fermo-nome">${esc(f.name)}</span>
				<span class="fermo-giorni">fermo da ${esc(f.idleDays)} ${f.idleDays === 1 ? 'giorno' : 'giorni'}</span>
				<span class="fermo-perche">${esc((Array.isArray(f.reasons) ? f.reasons : []).join(', '))}</span>
			</button></li>`,
		);
	}

	function renderPlancia() {
		const s = state.snapshot;
		const ready = !!(s && s.scannedAt);
		$('plancia-attesa').hidden = ready;
		$('plancia-corpo').hidden = !ready;
		if (!ready) return;
		setHTML($('frase'), sentence(s));
		$('lampade-vuote').hidden = s.live.length > 0;
		$('lampade').hidden = !s.live.length;
		sync($('lampade'), s.live, l => l.pid, l => lampHTML(s, l));
		renderBriefing();
		renderConsigli();
		const b = s.briefing;
		$('mattino').classList.toggle('affiancati', !!(b && !b.heard) && !$('consigli').hidden);
		askStats();
		renderQuadro();
		renderFermi();
		$('letto').textContent = 'Letto ' + ago(s.scannedAt);
		setHTML(
			$('filtri'),
			FILTERS.map(([id, label, fn]) => {
				const c = s.projects.filter(fn).length;
				if (!c && id !== 'tutti' && id !== state.filter) return '';
				return `<button type="button" data-filter="${id}" data-fk="filter:${id}" aria-pressed="${id === state.filter}">${label}<small>${c}</small></button>`;
			}).join(''),
		);
		const active = FILTERS.find(f => f[0] === state.filter) || FILTERS[0];
		const q = state.query.trim().toLowerCase();
		const shown = s.projects.filter(active[2]).filter(p => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
		sync($('righe'), shown, p => p.path, rowHTML);
		$('righe-vuote').hidden = shown.length > 0;
		const alt = $('altrove');
		alt.hidden = !s.elsewhere.length;
		if (s.elsewhere.length) setHTML(alt, elsewhereHTML(s));
	}

	function focusRow(p) {
		if (!state.snapshot) return;
		if (state.view !== 'plancia') show('plancia');
		state.filter = 'tutti';
		state.query = '';
		$('cerca-progetti').value = '';
		state.open.add(p);
		persist();
		renderPlancia();
		const li = [...$('righe').children].find(x => x.getAttribute('data-row') === p);
		if (li) {
			if (li.scrollIntoView) li.scrollIntoView({ block: 'center', behavior: reduced.matches ? 'auto' : 'smooth' });
			/** @type {HTMLElement} */ (li.querySelector('button')).focus({ preventScroll: true });
		}
	}

	// ---------- Lavori ----------

	const GROUPS = [
		['ti aspetta', 'aspetta', 'Ti aspetta', 'Ti aspettano'],
		['in corso', 'corso', 'In corso', 'In corso'],
		['nel terminale', 'terminale', 'Nel terminale', 'Nel terminale'],
		['in coda', 'coda', 'In coda', 'In coda'],
		['stanotte', 'stanotte', 'Stanotte', 'Stanotte'],
		['finito', 'finiti', 'Finito', 'Finiti'],
		['fermato', 'fermati', 'Fermato', 'Fermati'],
	];

	function jobTime(j) {
		const now = Date.now();
		switch (j.status) {
			case 'in coda':
				return `in coda da ${dur(now - j.createdAt)}`;
			case 'stanotte':
				return `in fila per stanotte da ${dur(now - j.createdAt)}`;
			case 'in corso':
				return `al lavoro da ${dur(now - (j.startedAt || j.createdAt))}`;
			case 'ti aspetta':
				return `aspetta da ${dur(now - (j.lastActivity || j.startedAt || j.createdAt))}`;
			case 'finito':
				return j.endedAt ? `finito ${ago(j.endedAt)}${j.startedAt ? `, in ${dur(j.endedAt - j.startedAt)}` : ''}` : 'finito';
			default:
				return j.endedAt ? `fermato ${ago(j.endedAt)}` : 'fermato';
		}
	}

	function jobHTML(j) {
		const id = esc(j.id);
		const b = (act, label, main) => `<button type="button" class="act${main ? ' main' : ''}" data-act="${act}" data-id="${id}" data-fk="${act}:${id}">${label}</button>`;
		const stop = state.armed === j.id ? b('job.stop', 'Conferma: ferma') : b('job.stop', 'Ferma');
		const acts = {
			'in coda': [b('job.remove', 'Togli dalla coda')],
			stanotte: [b('notte.now', 'Parti adesso'), b('job.remove', 'Togli')],
			'in corso': [b('job.focus', 'Apri'), stop],
			'ti aspetta': [b('job.focus', 'Rispondi', true), stop],
			finito: [b('job.focus', 'Apri'), b('job.remove', 'Togli')],
			fermato: [b('job-again', 'Rilancia'), b('job.remove', 'Togli')],
		}[j.status] || [b('job.remove', 'Togli')];
		const g = GROUPS.find(x => x[0] === j.status);
		return `<li class="lavoro s-${g ? g[1] : 'fermati'}">
			<i class="dot" aria-hidden="true"></i>
			<div class="lavoro-corpo">
				<p class="lavoro-testa"><b class="nome" title="${esc(home(j.path))}">${esc(j.project)}</b><span class="tempo">${esc(jobTime(j))}</span>${j.night && j.status !== 'stanotte' ? '<span class="di-notte">di notte</span>' : ''}</p>
				<p class="compito" title="${esc(j.task)}">${esc(j.task)}</p>
			</div>
			<div class="lavoro-azioni">${acts.join('')}</div>
		</li>`;
	}

	/** La frase di Lavori: conta solo da workCounts, come la Plancia, la scheda e le cifre. */
	function lavoriSentence(c, waitingList, done) {
		const w = c.tiAspetta || 0, r = c.inCorso || 0, t = c.nelTerminale || 0, q = c.inCoda || 0, nt = c.stanotte || 0;
		if (!w && !r && !t && !q && !nt && !done) return 'Nessun lavoro in giro. Scegli un progetto e scrivi a Claude cosa deve fare.';
		let out = w ? waitingPhrase(waitingList, w) : r || t || q ? 'Nessuno ti aspetta.' : '';
		const parts = [];
		if (r) parts.push(`${n(r, true)} ${r === 1 ? 'lavoro' : 'lavori'} in corso`);
		if (t) parts.push(parts.length ? `${t === 1 ? '<span class="n">uno</span>' : n(t)} nel terminale` : `${n(t, true)} nel terminale`);
		if (q) parts.push(parts.length ? `${q === 1 ? '<span class="n">uno</span>' : n(q)} in coda` : `${n(q, true)} ${q === 1 ? 'lavoro' : 'lavori'} in coda`);
		if (parts.length) out += ' ' + parts.join(', ') + '.';
		if (!w && !r && !t && !q) out = done ? `Niente in corso. ${n(done, true)} ${done === 1 ? 'lavoro chiuso, lo trovi' : 'lavori chiusi, li trovi'} qui sotto.` : 'Niente in corso.';
		if (nt) out += nt === 1 ? ' <span class="n">Uno</span> aspetta la notte.' : ` ${n(nt, true)} aspettano la notte.`;
		return out.trim();
	}

	const WORK_TIME = { 'ti aspetta': 'aspetta da', 'in corso': 'al lavoro da', 'nel terminale': 'nel terminale da', 'in coda': 'in coda da', stanotte: 'in fila per stanotte da' };

	/** Un lavoro della lista unica. Quelli della Bottega hanno le azioni di sempre; quelli aperti
	    altrove si aprono, si riprendono in una scheda e si chiede alla memoria cosa stanno facendo. */
	function workHTML(w) {
		const job = w.source === 'bottega' && w.jobId ? jobs().find(j => j.id === w.jobId) : null;
		if (job) return jobHTML({ ...job, status: w.status });
		if (w.source === 'bottega' && w.jobId) {
			return jobHTML({ id: w.jobId, project: w.project, path: w.path, task: w.title || '', status: w.status, createdAt: w.since || Date.now(), startedAt: w.since, lastActivity: w.since, night: w.night });
		}
		const g = GROUPS.find(x => x[0] === w.status);
		const k = esc(w.key);
		const pa = esc(w.path || '');
		const sid = w.sessionId ? esc(w.sessionId) : '';
		const sess = w.sessionId ? state.sess.get(w.sessionId) : null;
		const open = !!(sess && sess.open);
		const acts = [
			`<button type="button" class="act${w.status === 'ti aspetta' && sid ? ' main' : ''}" data-act="${sid ? 'resume' : 'claude'}" data-path="${pa}"${sid ? ` data-id="${sid}"` : ''} data-fk="w-claude:${k}">${sid ? 'Riprendi in una scheda' : 'Nuova sessione qui'}</button>`,
			w.path ? `<button type="button" class="act" data-act="open" data-path="${pa}" data-fk="w-open:${k}">Apri il progetto</button>` : '',
			sid ? `<button type="button" class="act" data-act="sessione" data-id="${sid}" data-fk="w-sess:${k}" aria-expanded="${open}" aria-controls="sess-${cssId(w.sessionId)}">Cosa sta facendo</button>` : '',
		].join('');
		let inside = '';
		if (open) {
			const items = sess && sess.items;
			inside = `<div class="sessione-bacheca" id="sess-${cssId(w.sessionId)}" role="region" aria-label="Cosa sta facendo questa sessione">${
				items === null
					? '<p class="w">Chiedo alla memoria.</p>'
					: !items.length
						? '<p class="w">La memoria non ha ancora visto niente di questa sessione.</p>'
						: `<ol>${items
								.slice(0, 8)
								.map(e => `<li><span class="t">${esc(e.summary || '')}${e.file ? ` <code>${esc(String(e.file).split('/').pop())}</code>` : ''}</span><span class="w">${esc(ago(e.at))}</span></li>`)
								.join('')}</ol>`
			}</div>`;
		}
		return `<li class="lavoro altrove s-${g ? g[1] : 'corso'}">
			<i class="dot" aria-hidden="true"></i>
			<div class="lavoro-corpo">
				<p class="lavoro-testa"><b class="nome" title="${esc(home(w.path))}">${esc(w.project)}</b><span class="tempo">${esc(`${WORK_TIME[w.status] || 'da'} ${dur(Date.now() - (w.since || Date.now()))}`)}</span><span class="provenienza">aperta fuori dalla Bottega</span></p>
				${w.title ? `<p class="compito" title="${esc(w.title)}">${esc(w.title)}</p>` : ''}
				${inside}
			</div>
			<div class="lavoro-azioni">${acts}</div>
		</li>`;
	}

	const cssId = x => String(x || '').replace(/[^A-Za-z0-9_-]/g, '_');

	function renderLavori() {
		const s = state.snapshot;
		const all = jobs();
		const work = workList();
		const c = workCounts();
		/** @type {Record<string, any[]>} */
		const by = { 'ti aspetta': [], 'in corso': [], 'nel terminale': [], 'in coda': [], stanotte: [], finito: [], fermato: [] };
		// i lavori vivi dalla lista unica (gia' ordinata), i chiusi dai lavori della Bottega
		for (const w of work) (by[w.status] || by['in corso']).push(w);
		for (const j of all) if (j.status === 'finito' || j.status === 'fermato') by[j.status].push(j);
		by.finito.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
		by.fermato.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
		const done = by.finito.length + by.fermato.length;

		setHTML($('frase-lavori'), lavoriSentence(c, by['ti aspetta'], done));
		for (const [status, key, one, many] of GROUPS) {
			const closed = status === 'finito' || status === 'fermato';
			const list = closed ? by[status].slice(0, 12) : by[status];
			$('g-' + key).hidden = !list.length;
			$(`g-${key}-titolo`).textContent = list.length === 1 ? one : many;
			if (closed) sync($('l-' + key), list, j => j.id, jobHTML);
			else sync($('l-' + key), list, w => w.key, workHTML);
		}
		$('lavori-vuoto').hidden = work.length + done > 0;
		renderNotte(by.stanotte);

		const lim = limitFor(s || {});
		// il limite riguarda solo i lavori che la Bottega fa partire
		const busy = all.filter(j => j.status === 'in corso' || j.status === 'ti aspetta').length;
		const full = busy >= lim.n;
		const head = lim.n === 1 ? 'Un lavoro alla volta' : `Al massimo ${word(lim.n)} lavori insieme`;
		let limText = lim.why ? `${head}: ${lim.why}.` : `${head}.`;
		if (full) limText += ' Quelli nuovi aspettano in coda.';
		const limEl = $('limite');
		limEl.textContent = limText;
		limEl.classList.toggle('stretto', lim.tight || full);
		state.full = full;
		$('avvia').textContent = composerLabel(full);
		renderComposerWhere();
		const combo = $('scegli-progetto');
		const chosen = projectByPath(state.draft.path);
		if (chosen && document.activeElement !== combo && !combo.value) combo.value = chosen.name;
	}

	function renderComposerWhere() {
		const p = projectByPath(state.draft.path);
		$('composer-dove').textContent = p ? home(p.path) : '';
	}

	const PARALLEL = n => (Number(n) === 2 ? 'due lavori insieme' : 'un lavoro alla volta');

	/** La coda della notte: perche' parte o non parte, la finestra, i lavori in fila, l'ultima notte. */
	function renderNotte(list) {
		const s = state.snapshot;
		const night = s && s.night;
		const g = $('g-stanotte');
		g.hidden = !night && !list.length;
		$('composer-notte-riga').hidden = !night;
		$('composer-notte-nota').hidden = !night || !$('composer-notte').checked;
		if (g.hidden) return;
		$('notte-vuota').hidden = list.length > 0;
		if (!night) {
			setHTML($('notte-riga'), '');
			$('notte-resoconto').hidden = true;
			return;
		}
		const ac = night.ac === false ? '<p class="notte-batteria">Il Mac va a batteria: di notte i lavori partono solo con la corrente.</p>' : '';
		setHTML(
			$('notte-riga'),
			`${night.why ? `<p class="notte-perche">${esc(night.why)}</p>` : ''}${ac}
			<p class="notte-finestra">Dalle ${esc(night.from || '01:00')} alle ${esc(night.to || '06:00')}, ${PARALLEL(night.parallel)}.
			<button type="button" class="link" data-act="notte-edit" data-fk="notte-edit" aria-expanded="${state.notteEdit}" aria-controls="notte-form">Cambia</button></p>`,
		);
		const form = $('notte-form');
		form.hidden = !state.notteEdit;
		if (!form.contains(document.activeElement) && !state.notteEdit) {
			$('notte-da').value = night.from || '01:00';
			$('notte-a').value = night.to || '06:00';
			$('notte-insieme').value = String(Number(night.parallel) === 2 ? 2 : 1);
		}
		const rep = night.report;
		const box = $('notte-resoconto');
		const rj = rep && Array.isArray(rep.jobs) ? rep.jobs : [];
		box.hidden = !rj.length;
		if (rj.length) {
			const when = rep.date === dayKey(new Date(Date.now() - day)) || rep.date === dayKey() ? 'stanotte' : `la notte di ${dateWords(rep.date)}`;
			setHTML(
				box,
				`<h3>Com'è andata ${esc(when)}</h3>
				<ul>${rj
					.map(
						j => `<li class="resoconto-voce"><p class="lavoro-testa"><b class="nome">${esc(j.project)}</b><span class="tempo">${esc(j.status)}</span></p>
						<p class="compito">${esc(j.task)}</p>${j.summary ? `<p class="resoconto-sunto">${esc(j.summary)}</p>` : ''}</li>`,
					)
					.join('')}</ul>`,
			);
		}
	}

	function composerLabel(full) {
		if ($('composer-notte').checked && !$('composer-notte-riga').hidden) return 'Metti in fila per stanotte';
		return full ? 'Metti in coda' : 'Avvia il lavoro';
	}

	// combobox dei progetti
	/** @type {any[]} */ let comboItems = [];
	let comboIdx = -1;

	function comboOpen(open) {
		const combo = $('scegli-progetto');
		$('progetti-lista').hidden = !open;
		combo.setAttribute('aria-expanded', String(open));
		if (!open) {
			combo.removeAttribute('aria-activedescendant');
			comboIdx = -1;
		}
	}

	function comboFill() {
		const combo = $('scegli-progetto');
		const chosen = projectByPath(state.draft.path);
		const q = chosen && combo.value === chosen.name ? '' : combo.value.trim().toLowerCase();
		const all = projects();
		const hit = p => p.name.toLowerCase().includes(q) || home(p.path).toLowerCase().includes(q);
		const starts = all.filter(p => q && p.name.toLowerCase().startsWith(q));
		comboItems = (q ? [...starts, ...all.filter(p => hit(p) && !starts.includes(p))] : all).slice(0, 8);
		$('progetti-lista').innerHTML = comboItems.length
			? comboItems
					.map(
						(p, i) =>
							`<li role="option" id="opz-${i}" data-i="${i}" aria-selected="${p.path === state.draft.path}"><b>${esc(p.name)}</b><span>${esc(home(p.path))}</span></li>`,
					)
					.join('')
			: `<li class="nessuno" role="presentation">Nessun progetto con questo nome.</li>`;
		const sel = comboItems.findIndex(p => p.path === state.draft.path);
		comboActive(comboItems.length ? (sel >= 0 ? sel : 0) : -1);
	}

	function comboActive(i) {
		comboIdx = i;
		const combo = $('scegli-progetto');
		for (const li of $('progetti-lista').querySelectorAll('[role="option"]')) li.classList.toggle('attivo', li.getAttribute('data-i') === String(i));
		if (i < 0) return combo.removeAttribute('aria-activedescendant');
		combo.setAttribute('aria-activedescendant', 'opz-' + i);
		const el = $('opz-' + i);
		if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
	}

	function choose(p) {
		state.draft.path = p.path;
		$('scegli-progetto').value = p.name;
		persist();
		comboOpen(false);
		renderComposerWhere();
		say('composer-esito', '');
	}

	function say(id, text, bad) {
		const el = $(id);
		el.textContent = text;
		el.classList.toggle('errore', !!bad);
	}

	function startJob() {
		const p = projectByPath(state.draft.path);
		const task = $('compito').value.trim();
		if (!p) {
			say('composer-esito', 'Scegli prima il progetto.', true);
			$('scegli-progetto').focus();
			return;
		}
		if (!task) {
			say('composer-esito', 'Scrivi cosa deve fare Claude.', true);
			$('compito').focus();
			return;
		}
		const night = $('composer-notte').checked && !$('composer-notte-riga').hidden;
		/** @type {any} */ const msg = { type: 'job.new', path: p.path, task };
		if (night) msg.night = true;
		vscode.postMessage(msg);
		$('compito').value = '';
		state.draft.task = '';
		persist();
		say(
			'composer-esito',
			night ? `Lavoro su ${p.name} in fila per stanotte.` : state.full ? `Lavoro su ${p.name} messo in coda.` : `Lavoro su ${p.name} mandato a Claude.`,
		);
	}

	function noticeJobChanges(list) {
		const first = state.jobStatus.size === 0 && !state.snapshot;
		for (const j of list) {
			const before = state.jobStatus.get(j.id);
			if (!first && before && before !== j.status) {
				if (j.status === 'ti aspetta') announce(`${j.project} ti aspetta.`);
				else if (j.status === 'finito') announce(`Lavoro su ${j.project} finito.`);
			}
			state.jobStatus.set(j.id, j.status);
		}
	}

	// ---------- Memoria ----------

	const KIND_MEM = { riassunto: 'riassunto', fatto: 'fatto', decisione: 'decisione', nota: 'nota', prompt: 'richiesta' };
	let searchTimer = 0;

	function projectOptions(empty) {
		const names = [...new Set(projects().map(p => p.name))].sort((a, b) => a.localeCompare(b, 'it'));
		return `<option value="">${empty}</option>` + names.map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
	}

	function fillSelect(el, html, value) {
		if (lastHTML.get(el) !== html) {
			el.innerHTML = html;
			lastHTML.set(el, html);
		}
		el.value = value;
		if (el.value !== value) el.value = '';
	}

	function runSearch() {
		clearTimeout(searchTimer);
		const q = state.mem.query.trim();
		/** @type {any} */ const msg = { type: 'memoria.search', query: q };
		if (state.mem.project) msg.project = state.mem.project;
		state.mem.sent = { query: q, project: state.mem.project };
		state.mem.waiting = true;
		vscode.postMessage(msg);
		renderMemoria();
	}

	function dayLabel(ms) {
		const d = new Date(ms);
		const today = new Date();
		if (d.toDateString() === today.toDateString()) return 'Oggi';
		const y = new Date(today);
		y.setDate(y.getDate() - 1);
		if (d.toDateString() === y.toDateString()) return 'Ieri';
		/** @type {Intl.DateTimeFormatOptions} */ const o = { weekday: 'long', day: 'numeric', month: 'long' };
		if (d.getFullYear() !== today.getFullYear()) o.year = 'numeric';
		return cap(d.toLocaleDateString('it-IT', o));
	}

	/** Evidenzia le parole cercate in modo sicuro: si spezza il testo grezzo sulle parole, poi si
	    sfugge ogni pezzo. Cosi' una parola come "amp" non finisce mai dentro un'entita' HTML. */
	function highlight(text, q, min = 3) {
		const raw = String(text ?? '');
		const words = [...new Set((q || '').split(/\s+/).filter(w => w.length >= min))]
			.sort((a, b) => b.length - a.length)
			.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
		if (!words.length) return esc(raw);
		return raw
			.split(new RegExp(`(${words.join('|')})`, 'gi'))
			.map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)))
			.join('');
	}

	function memItemHTML(it, q) {
		const long = (it.text || '').length > 360;
		const open = state.mem.open.has(it.id);
		const kind = KIND_MEM[it.kind] ? it.kind : 'nota';
		const title = it.title && it.title !== it.text ? `<p class="titolo">${highlight(it.title, q)}</p>` : '';
		const more = long
			? `<button type="button" class="link" data-act="mem-more" data-id="${esc(it.id)}" data-fk="mem-more:${esc(it.id)}" aria-expanded="${open}">${open ? 'Riduci' : 'Leggi tutto'}</button>`
			: '';
		return `<li class="ricordo k-${kind}${long ? ' lungo' : ''}${open ? ' aperto' : ''}">
			<p class="quando"><time>${esc(clock(it.createdAt))}</time><span class="tipo">${KIND_MEM[kind]}</span></p>
			<div class="contenuto">${title}<p class="testo">${highlight(it.text || '', q)}</p>${more}</div>
		</li>`;
	}

	function timelineHTML(items, q) {
		const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
		/** @type {Map<string, Map<string, any[]>>} */ const days = new Map();
		for (const it of sorted) {
			const d = new Date(it.createdAt).toDateString();
			if (!days.has(d)) days.set(d, new Map());
			const per = /** @type {Map<string, any[]>} */ (days.get(d));
			const p = it.project || 'Fuori dai progetti';
			if (!per.has(p)) per.set(p, []);
			/** @type {any[]} */ (per.get(p)).push(it);
		}
		return [...days.values()]
			.map(per => {
				const first = [...per.values()][0][0];
				return `<section class="giorno"><h2>${esc(dayLabel(first.createdAt))}</h2>${[...per]
					.map(([p, list]) => `<h3 class="mem-progetto">${esc(p)}</h3><ol class="ricordi">${list.map(it => memItemHTML(it, q)).join('')}</ol>`)
					.join('')}</section>`;
			})
			.join('');
	}

	function bachecaHTML(list) {
		/** @type {Map<string, any[]>} */ const per = new Map();
		for (const e of [...list].sort((a, b) => b.at - a.at)) {
			const p = e.project || 'Fuori dai progetti';
			if (!per.has(p)) per.set(p, []);
			/** @type {any[]} */ (per.get(p)).push(e);
		}
		return [...per]
			.map(([p, es]) => {
				const sessions = new Set(es.map(e => e.sessionId).filter(Boolean)).size;
				return `<div class="bacheca-progetto"><h3>${esc(p)}${sessions > 1 ? `<span class="w"> ${sessions} sessioni</span>` : ''}</h3><ul>${es
					.slice(0, 4)
					.map(e => `<li><span class="t">${esc(e.summary || e.text || '')}</span><span class="w">${esc(ago(e.at))}</span></li>`)
					.join('')}</ul></div>`;
			})
			.join('');
	}

	// «Dove l'ho gia' risolto?»: ricordi e codice insieme

	function runRicerca() {
		const q = state.ric.query.trim();
		if (!q) {
			$('cerca-risolto').focus();
			return;
		}
		state.ric.sent = q;
		state.ric.waiting = true;
		vscode.postMessage({ type: 'ricerca', query: q });
		renderMemoria();
	}

	/** Il punteggio non si mostra: diventa una distanza a parole, relativa al migliore se la scala non e' 0..1. */
	function closeness(score, max) {
		const v = typeof score === 'number' ? (max > 1 ? score / max : score) : 0;
		if (v >= 0.75) return ['molto-vicino', 'molto vicino'];
		if (v >= 0.5) return ['vicino', 'vicino'];
		return ['lontano', 'lontano'];
	}

	const joinPath = (dir, file) => String(dir || '').replace(/\/+$/, '') + '/' + String(file || '').replace(/^\.?\/+/, '');

	function ricMemHTML(list, q) {
		if (!list.length) return `<p class="quiet">Nessun ricordo per «${esc(q)}».</p>`;
		const max = Math.max(...list.map(x => (typeof x.score === 'number' ? x.score : 0)));
		return `<ol class="ric-lista">${list
			.slice(0, 20)
			.map((it, i) => {
				const [cls, word] = closeness(it.score, max);
				const when = it.createdAt ? `${dayLabel(it.createdAt)}, ${clock(it.createdAt)}` : '';
				const sess = it.sessionId ? `sessione ${String(it.sessionId).slice(0, 8)}` : '';
				const resume =
					it.sessionId && it.projectPath
						? `<button type="button" class="link" data-act="resume" data-path="${esc(it.projectPath)}" data-id="${esc(it.sessionId)}" data-fk="ric-resume:${esc(it.sessionId)}:${i}">Riprendi la sessione</button>`
						: '';
				return `<li class="ric-voce">
					<p class="ric-testa"><b>${esc(it.project || 'Fuori dai progetti')}</b><span class="vicinanza v-${cls}"><i aria-hidden="true"></i>${word}</span></p>
					${it.title ? `<p class="titolo">${highlight(it.title, q)}</p>` : ''}
					${it.text && it.text !== it.title ? `<p class="ric-estratto">${highlight(it.text, q)}</p>` : ''}
					<p class="ric-piede"><span class="w">${esc([when, sess].filter(Boolean).join(', '))}</span>${resume}</p>
				</li>`;
			})
			.join('')}</ol>`;
	}

	function ricCodeHTML(list, q) {
		if (!list.length) return `<p class="quiet">Nessuna riga di codice per «${esc(q)}».</p>`;
		return `<ol class="ric-lista">${list
			.slice(0, 40)
			.map((h, i) => {
				const full = joinPath(h.projectPath, h.file);
				return `<li><button type="button" class="ric-codice" data-act="file-open" data-path="${esc(full)}" data-line="${esc(h.line)}" data-fk="code:${esc(full)}:${esc(h.line)}:${i}" title="Apri ${esc(h.file)} alla riga ${esc(h.line)}">
					<span class="ric-file"><b>${esc(h.project)}</b><span class="ric-percorso">${esc(h.file)}</span><span class="ric-riga">riga ${esc(h.line)}</span></span>
					<code>${highlight(String(h.text || '').trim(), q, 2)}</code>
				</button></li>`;
			})
			.join('')}</ol>`;
	}

	function renderRicerca() {
		const r = state.ric;
		const res = r.result;
		const box = $('ric-risultati');
		box.classList.toggle('in-attesa', r.waiting);
		const q = (res && res.query) || r.sent || '';
		let head;
		if (!r.sent) head = 'Dove l’ho già risolto? Cerca una parola nei ricordi e nel codice di tutti i progetti.';
		else if (r.waiting || !res) head = `Sto cercando «${esc(r.sent)}» nei ricordi e nel codice.`;
		else if (res.error) head = `La ricerca di «${esc(q)}» non è riuscita.`;
		else {
			const a = (res.memoria || []).length, b = (res.codice || []).length;
			if (!a && !b) head = `Niente per «${esc(q)}», né nei ricordi né nel codice.`;
			else {
				const mem = a === 0 ? 'Nessun ricordo' : a === 1 ? `${n(1, true)} ricordo` : `${n(a, true)} ricordi`;
				const code = b === 0 ? 'nessuna riga' : b === 1 ? '<span class="n">una</span> riga' : `${n(b)} righe`;
				head = `${mem} e ${code} di codice per «${esc(q)}».`;
			}
		}
		setHTML($('frase-memoria'), head);
		if (!res) {
			setHTML(
				box,
				r.sent
					? `<p class="invito">Guardo nei riassunti delle sessioni e nei file dei progetti. Il codice si apre con un clic, alla riga giusta.</p>`
					: `<p class="invito">Scrivi cosa stai cercando come lo diresti a voce: un errore, il nome di una funzione, un servizio. Trovi le sessioni in cui ne hai parlato e le righe di codice che lo contengono.</p>`,
			);
			return;
		}
		if (res.error) {
			setHTML(box, `<p class="invito">${esc(res.error)} Riprova tra poco, o cerca nella linea del tempo.</p>`);
			return;
		}
		const ms = typeof res.ms === 'number' ? `<p class="w ric-tempo">Cercato in ${res.ms < 1000 ? `${Math.round(res.ms)} ms` : `${num(res.ms / 1000)} s`}.</p>` : '';
		setHTML(
			box,
			`<div class="ric-colonne">
				<section class="ric-blocco" aria-labelledby="ric-mem-titolo"><h2 id="ric-mem-titolo">Nei ricordi</h2>${ricMemHTML(res.memoria || [], q)}</section>
				<section class="ric-blocco" aria-labelledby="ric-code-titolo"><h2 id="ric-code-titolo">Nel codice</h2>${ricCodeHTML(res.codice || [], q)}</section>
			</div>${ms}`,
		);
	}

	function renderMemoria() {
		const ricerca = state.mem.mode === 'ricerca';
		for (const b of $('mem-modi').querySelectorAll('[data-memmode]')) b.setAttribute('aria-pressed', String(b.getAttribute('data-memmode') === state.mem.mode));
		$('mem-cerca').hidden = ricerca;
		$('mem-risultati').hidden = ricerca;
		$('ric-cerca').hidden = !ricerca;
		$('ric-risultati').hidden = !ricerca;
		if (ricerca) {
			fillSelect($('ricorda-progetto'), projectOptions('Nessun progetto in particolare'), $('ricorda-progetto').value || state.mem.project);
			renderRicerca();
		} else renderTimeline();
		const b = state.mem.bacheca || (state.snapshot && state.snapshot.bacheca) || null;
		$('bacheca').hidden = !(b && b.length);
		if (b && b.length) setHTML($('bacheca-lista'), bachecaHTML(b));
	}

	function renderTimeline() {
		const m = state.mem;
		fillSelect($('mem-progetto'), projectOptions('Tutti i progetti'), m.project);
		const rp = $('ricorda-progetto');
		fillSelect(rp, projectOptions('Nessun progetto in particolare'), rp.value || m.project);

		const q = m.sent ? m.sent.query : '';
		const where = m.sent && m.sent.project ? ` in ${esc(m.sent.project)}` : '';
		let head;
		if (m.results === null) head = m.waiting ? 'Sto cercando nei ricordi.' : 'Cosa è successo, cosa si è deciso, cosa c’è da sapere.';
		else if (!m.results.length) head = q ? `Niente per «${esc(q)}»${where}.` : `Ancora nessun ricordo${where}.`;
		else {
			const c = m.results.length;
			head = q
				? `${n(c, true)} ${c === 1 ? 'ricordo' : 'ricordi'} per «${esc(q)}»${where}.`
				: `Gli ultimi ${c === 1 ? 'ricordo' : `${n(c)} ricordi`}${where}.`;
		}
		setHTML($('frase-memoria'), head);

		const box = $('mem-risultati');
		box.classList.toggle('in-attesa', m.waiting);
		if (m.results === null) {
			setHTML(
				box,
				`<p class="invito">La memoria si riempie da sola mentre lavori con Claude: riassunti delle sessioni, decisioni, fatti. Cerca una parola qui sopra, o scrivi accanto una cosa da ricordare.</p>`,
			);
		} else if (!m.results.length) {
			setHTML(
				box,
				q
					? `<p class="invito">Prova con parole diverse${m.sent && m.sent.project ? ', o cerca in tutti i progetti' : ''}. La ricerca guarda titoli e testi, non il codice.</p>`
					: `<p class="invito">I ricordi arrivano da soli alla fine di ogni sessione Claude. Intanto puoi scriverne uno qui accanto.</p>`,
			);
		} else {
			setHTML(box, timelineHTML(m.results, q));
		}
	}

	// ---------- Melissa ----------

	const VOICE_SENTENCE = {
		idle: 'Melissa aspetta che la chiami.',
		listening: 'Melissa ti ascolta.',
		thinking: 'Melissa ci pensa.',
		speaking: 'Melissa risponde.',
		error: 'Melissa non è riuscita a rispondere.',
	};
	const BRAIN = {
		agnes: 'Pensa con Agnes.',
		apple: 'Pensa con Apple Intelligence, qui sul Mac.',
		nessuno: 'Nessun cervello collegato: serve la chiave Agnes o Apple Intelligence attiva.',
	};
	const WHO = { tu: 'Tu', melissa: 'Melissa', azione: 'Fatto' };

	function renderMelissa() {
		const a = assistant();
		const nucleo = hasNucleo();
		const enabled = state.voiceOptimistic ?? !!(a && a.enabled);
		const st = (a && a.state) || 'idle';

		const sw = $('voce');
		sw.setAttribute('aria-checked', String(enabled && nucleo));
		sw.disabled = !nucleo;
		$('suggerimento').hidden = !nucleo;
		$('senza-nucleo').hidden = nucleo;

		let line;
		if (!state.snapshot) line = 'Melissa';
		else if (!nucleo) line = 'Melissa non sente: manca il Nucleo.';
		else if (!enabled) line = 'Voce spenta. Puoi scriverle.';
		else if (a && a.conversing && st === 'idle') line = 'Melissa ti ascolta.';
		else line = VOICE_SENTENCE[st] || VOICE_SENTENCE.idle;
		$('melissa-stato').textContent = line;
		const conversing = !!(a && a.conversing && nucleo);
		$('conversa').hidden = !conversing;
		$('notte').classList.toggle('in-conversazione', conversing);

		const partial = a && a.partial && st === 'listening' ? a.partial : '';
		$('parziale').textContent = partial ? `«${partial}»` : '';
		$('cervello').textContent = a ? BRAIN[a.brain] || '' : '';

		const log = (a && a.log) || [];
		const CUT = ' (interrotta)';
		const rows = log.map((e, i) => {
			const cut = e.role === 'melissa' && typeof e.text === 'string' && e.text.endsWith(CUT);
			return { ...e, text: cut ? e.text.slice(0, -CUT.length) : e.text, cut, key: `${e.at}:${e.role}:${i}` };
		});
		const p = state.pendingAsk;
		if (p && !log.some(e => e.role === 'tu' && e.text === p.text && e.at >= p.at - 5000)) rows.push({ role: 'tu', text: p.text, at: p.at, key: 'in-volo', pending: true });
		else state.pendingAsk = null;
		const reg = $('registro');
		const nearBottom = reg.scrollHeight - reg.scrollTop - reg.clientHeight < 60;
		const before = reg.children.length;
		sync(
			reg,
			rows,
			r => r.key,
			r =>
				`<li class="r-${esc(r.role)}${r.pending ? ' in-volo' : ''}${r.cut ? ' interrotta' : ''}"><span class="chi">${WHO[r.role] || esc(r.role)}</span><p>${esc(r.text)}${r.cut ? '<span class="taglio">interrotta</span>' : ''}</p><time class="w">${esc(clock(r.at))}</time></li>`,
		);
		reg.hidden = !rows.length;
		$('registro-vuoto').hidden = rows.length > 0;
		if (rows.length !== before && nearBottom) reg.scrollTop = reg.scrollHeight;

		// In conversazione il microfono resta aperto: tra un turno e l'altro la sfera ascolta.
		const orbState = conversing && st === 'idle' ? 'listening' : st;
		orb.set(orbState, !(nucleo && enabled), typeof (a && a.level) === 'number' ? a.level : 0);
	}

	// ---------- la sfera di Melissa ----------
	/* Eco della sfera Metal del Nucleo: plasma vivo, nucleo quasi bianco, bordo scuro, alone additivo.
	   I colori di stato sono in RGB lineare, come nello shader: si mescolano in lineare e si
	   convertono in sRGB solo per disegnare. Gira solo quando la stanza e' visibile. */

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

		const running = () => !!ctx && !reduced.matches && state.view === 'melissa' && document.visibilityState !== 'hidden';
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
					if (state.view === 'melissa') {
						snapTo();
						draw(); // un solo fotogramma fermo, con il colore giusto
					}
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

	// ---------- Continua da dove eri ----------
	/* Un dialogo modale fatto a mano (role=dialog, aria-modal): il fuoco entra nel testo, Tab gira
	   dentro, Esc chiude e il fuoco torna a chi l'ha aperto. Il testo si puo' cambiare prima di avviare. */

	function openContinua(m, opener) {
		const p = projectByPath(m.path);
		const name = (p && p.name) || String(m.path || '').split('/').pop() || 'progetto';
		state.cont = { path: m.path, opener: opener || '' };
		$('continua-titolo').textContent = `Continua ${name} da dove eri`;
		const src = Array.isArray(m.sources) ? m.sources.filter(Boolean) : [];
		$('continua-fonti').textContent = src.length ? cap(src.join('; ')) + '.' : 'Prompt preparato dalla Bottega.';
		const ta = $('continua-testo');
		ta.value = m.prompt || '';
		const nightOk = !!(state.snapshot && state.snapshot.night);
		$('continua-notte').checked = false;
		$('continua-notte').parentElement.hidden = !nightOk;
		$('continua-notte-nota').hidden = !nightOk;
		say('continua-esito', '');
		$('continua-velo').hidden = false;
		document.body.classList.add('con-dialogo');
		ta.focus();
		if (ta.setSelectionRange) ta.setSelectionRange(0, 0);
		ta.scrollTop = 0;
		announce(`Prompt pronto per ${name}. Puoi cambiarlo, poi Avvia.`);
	}

	function closeContinua() {
		if (!state.cont) return;
		const key = state.cont.opener;
		state.cont = null;
		$('continua-velo').hidden = true;
		document.body.classList.remove('con-dialogo');
		const back = key ? [...document.querySelectorAll('[data-fk]')].find(el => el.getAttribute('data-fk') === key) : null;
		if (back) /** @type {HTMLElement} */ (back).focus({ preventScroll: false });
	}

	function startContinua() {
		if (!state.cont) return;
		const task = $('continua-testo').value.trim();
		if (!task) {
			say('continua-esito', 'Il prompt è vuoto: scrivi cosa deve fare Claude.', true);
			$('continua-testo').focus();
			return;
		}
		const night = $('continua-notte').checked && !$('continua-notte').parentElement.hidden;
		/** @type {any} */ const msg = { type: 'job.new', path: state.cont.path, task };
		if (night) msg.night = true;
		vscode.postMessage(msg);
		const p = projectByPath(state.cont.path);
		const name = p ? p.name : 'il progetto';
		closeContinua();
		announce(night ? `Lavoro su ${name} in fila per stanotte.` : `Lavoro su ${name} mandato a Claude.`);
	}

	$('continua-avvia').addEventListener('click', startContinua);
	$('continua-annulla').addEventListener('click', closeContinua);
	$('continua-velo').addEventListener('keydown', e => {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			return closeContinua();
		}
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			return startContinua();
		}
		if (e.key !== 'Tab') return;
		const f = /** @type {HTMLElement[]} */ (
			[...$('continua').querySelectorAll('textarea, input, button')].filter(x => !x.disabled && !x.closest('[hidden]'))
		);
		if (!f.length) return;
		const i = f.indexOf(/** @type {HTMLElement} */ (document.activeElement));
		const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 || i < 0 ? 0 : i + 1;
		e.preventDefault();
		f[next].focus();
	});

	/** Il compositore dei Lavori gia' scritto (da una regola, da Melissa, da un link). */
	function openComposer(m) {
		show('lavori');
		const p = projectByPath(m.path);
		if (p) choose(p);
		else {
			state.draft.path = '';
			$('scegli-progetto').value = '';
			renderComposerWhere();
		}
		$('compito').value = m.task || '';
		state.draft.task = m.task || '';
		$('composer-notte').checked = !!m.night;
		state.draft.night = !!m.night;
		persist();
		renderLavori();
		say('composer-esito', p ? 'Controlla il compito e avvialo.' : 'Scegli il progetto, poi avvia.');
		(p ? $('compito') : $('scegli-progetto')).focus();
		announce(p ? `Nuovo lavoro su ${p.name} pronto da avviare.` : 'Nuovo lavoro pronto: scegli il progetto.');
	}

	// ---------- stanze ----------

	function renderView() {
		renderHeader();
		if (state.view === 'plancia') renderPlancia();
		else if (state.view === 'lavori') renderLavori();
		else if (state.view === 'memoria') renderMemoria();
		else if (state.view === 'melissa') renderMelissa();
		else if (state.view === 'cruscotto') room('cruscotto', 'render');
	}

	function show(view, focusTab) {
		if (!VIEWS.some(v => v[0] === view)) return;
		if (view !== state.view) state.scroll[state.view] = window.scrollY || 0;
		state.view = view;
		persist();
		for (const [id] of VIEWS) $('vista-' + id).hidden = id !== view;
		renderView();
		if (focusTab) $('tab-' + view).focus();
		if (window.scrollTo) window.scrollTo(0, state.scroll[view] || 0);
		if (view === 'melissa') orb.wake();
		else orb.sleep();
		for (const [id] of ROOMS) room(id, view === id ? 'show' : 'hide');
		if (view === 'memoria' && !state.mem.sent && state.mem.mode === 'ricordi') runSearch();
	}

	function render() {
		renderView();
	}

	// ---------- eventi ----------

	app.addEventListener('click', e => {
		const t = /** @type {HTMLElement} */ (e.target);
		// le stanze esterne gestiscono i loro clic da sole
		if (t.closest('#vista-cruscotto, #vista-vedetta, #vista-clienti')) return;
		const tab = t.closest('[data-view]');
		// una scheda si apre dov'e'; una cifra della Home porta il fuoco sulla scheda della stanza
		if (tab) return show(tab.getAttribute('data-view') || 'plancia', tab.getAttribute('role') !== 'tab');
		const mm = t.closest('[data-memmode]');
		if (mm) {
			state.mem.mode = mm.getAttribute('data-memmode') === 'ricerca' ? 'ricerca' : 'ricordi';
			persist();
			renderMemoria();
			if (state.mem.mode === 'ricordi' && !state.mem.sent) runSearch();
			$(state.mem.mode === 'ricerca' ? 'cerca-risolto' : 'cerca-memoria').focus();
			return;
		}
		const f = t.closest('[data-filter]');
		if (f) {
			state.filter = f.getAttribute('data-filter') || 'tutti';
			persist();
			return renderPlancia();
		}
		const opt = t.closest('#progetti-lista [data-i]');
		if (opt) {
			const p = comboItems[Number(opt.getAttribute('data-i'))];
			if (p) choose(p);
			$('compito').focus();
			return;
		}
		const b = /** @type {HTMLElement | null} */ (t.closest('[data-act]'));
		if (!b) return;
		const act = b.getAttribute('data-act') || '';
		const p = b.getAttribute('data-path') || '';
		const id = b.getAttribute('data-id') || '';
		switch (act) {
			case 'toggle': {
				state.open.has(p) ? state.open.delete(p) : state.open.add(p);
				persist();
				const li = b.closest('.row');
				const d = li && li.querySelector('.detail');
				if (d) d.toggleAttribute('hidden', !state.open.has(p));
				b.setAttribute('aria-expanded', String(state.open.has(p)));
				return;
			}
			case 'focus':
				return focusRow(p);
			case 'resume':
				return vscode.postMessage({ type: 'claude', path: p, id });
			case 'claude-here':
				return vscode.postMessage({ type: 'claude', path: p });
			case 'refresh':
				return vscode.postMessage({ type: 'refresh' });
			case 'job-here': {
				const proj = projectByPath(p);
				show('lavori');
				if (proj) choose(proj);
				$('compito').focus();
				return;
			}
			case 'job.focus':
			case 'job.remove':
				return vscode.postMessage({ type: act, id });
			case 'job.stop': {
				const j = jobs().find(x => x.id === id);
				if (state.armed !== id) {
					state.armed = id;
					renderLavori();
					announce(`Premi di nuovo per fermare il lavoro${j ? ' su ' + j.project : ''}.`);
					setTimeout(() => {
						if (state.armed === id) {
							state.armed = '';
							renderLavori();
						}
					}, 4000);
					return;
				}
				state.armed = '';
				vscode.postMessage({ type: 'job.stop', id });
				return renderLavori();
			}
			case 'job-again': {
				const j = jobs().find(x => x.id === id);
				if (j) vscode.postMessage({ type: 'job.new', path: j.path, task: j.task });
				return;
			}
			case 'voice-end':
				// chiude solo la conversazione: lo stato vero arriva col prossimo aggiornamento di Melissa
				vscode.postMessage({ type: 'voice.toggle' });
				$('conversa').hidden = true;
				$('voce').focus();
				return;
			case 'jobs-clear':
				for (const j of jobs().filter(x => x.status === 'finito')) vscode.postMessage({ type: 'job.remove', id: j.id });
				return;
			case 'run': {
				// azione proposta da regole, briefing o consigli: {type: act, ...args}, cosi' com'e'
				let msg = null;
				try {
					msg = JSON.parse(b.getAttribute('data-msg') || 'null');
				} catch {
					msg = null;
				}
				if (!msg || typeof msg.type !== 'string') return;
				if (msg.type === 'continua.prepare' && msg.path) {
					state.contWaiting = msg.path;
					if (state.view === 'plancia') renderPlancia();
				}
				return vscode.postMessage(msg);
			}
			case 'continua':
				state.contWaiting = p;
				vscode.postMessage({ type: 'continua.prepare', path: p });
				renderPlancia();
				// se la risposta non arriva, il pulsante non resta appeso
				setTimeout(() => {
					if (state.contWaiting !== p) return;
					state.contWaiting = '';
					renderPlancia();
					announce('Il prompt non è arrivato. Riprova tra poco.');
				}, 20_000);
				announce('Preparo il prompt per continuare.');
				return;
			case 'brief-toggle':
				state.briefOpen = !state.briefOpen;
				return renderBriefing();
			case 'briefing.listen':
				announce('Melissa legge il briefing.');
				return vscode.postMessage({ type: act });
			case 'briefing.make':
			case 'briefing.dismiss':
			case 'advice.refresh':
			case 'rules.refresh':
			case 'radar.refresh':
				return vscode.postMessage({ type: act });
			case 'notte.now':
				return vscode.postMessage({ type: 'notte.now', id });
			case 'sessione': {
				// «Cosa sta facendo»: chiede alla bacheca della memoria, risposta mostrata in linea
				const cur = state.sess.get(id);
				if (cur && cur.open) state.sess.set(id, { ...cur, open: false });
				else {
					state.sess.set(id, { open: true, items: null });
					vscode.postMessage({ type: 'bacheca.sessione', sessionId: id });
				}
				return renderLavori();
			}
			case 'notte-edit':
				state.notteEdit = !state.notteEdit;
				renderLavori();
				if (state.notteEdit) $('notte-da').focus();
				else $('notte-riga').querySelector('[data-act="notte-edit"]')?.focus();
				return;
			case 'file-open': {
				const line = Number(b.getAttribute('data-line')) || 1;
				return vscode.postMessage({ type: 'file.open', path: p, line });
			}
			case 'mem-more': {
				const key = isNaN(Number(id)) ? id : Number(id);
				state.mem.open.has(key) ? state.mem.open.delete(key) : state.mem.open.add(key);
				return renderMemoria();
			}
			default:
				if (['open', 'here', 'finder', 'xcode', 'push', 'claude'].includes(act)) vscode.postMessage({ type: act, path: p });
		}
	});

	// stanze: frecce, Home e Fine dentro la barra
	$('tab-plancia').parentElement.addEventListener('keydown', e => {
		const i = VIEWS.findIndex(v => v[0] === state.view);
		let k = -1;
		if (e.key === 'ArrowRight') k = (i + 1) % VIEWS.length;
		else if (e.key === 'ArrowLeft') k = (i - 1 + VIEWS.length) % VIEWS.length;
		else if (e.key === 'Home') k = 0;
		else if (e.key === 'End') k = VIEWS.length - 1;
		if (k < 0) return;
		e.preventDefault();
		show(VIEWS[k][0], true);
	});

	$('voce').addEventListener('click', () => {
		const sw = $('voce');
		if (sw.disabled) return;
		state.voiceOptimistic = sw.getAttribute('aria-checked') !== 'true';
		vscode.postMessage({ type: 'voice.toggle' });
		renderMelissa();
	});

	app.addEventListener('input', e => {
		const t = /** @type {HTMLInputElement} */ (e.target);
		switch (t.id) {
			case 'cerca-progetti':
				state.query = t.value;
				persist();
				return renderPlancia();
			case 'compito':
				state.draft.task = t.value;
				return persist();
			case 'domanda':
				state.ask = t.value;
				return persist();
			case 'scegli-progetto': {
				const chosen = projectByPath(state.draft.path);
				if (chosen && t.value !== chosen.name) {
					state.draft.path = '';
					renderComposerWhere();
				}
				comboFill();
				return comboOpen(true);
			}
			case 'cerca-memoria':
				state.mem.query = t.value;
				persist();
				clearTimeout(searchTimer);
				searchTimer = setTimeout(runSearch, 320);
				return;
			case 'cerca-risolto':
				state.ric.query = t.value;
				return persist();
		}
	});

	app.addEventListener('change', e => {
		const t = /** @type {HTMLSelectElement} */ (e.target);
		if (t.id === 'composer-notte') {
			state.draft.night = /** @type {any} */ (t).checked;
			persist();
			return renderLavori();
		}
		if (t.id === 'mem-progetto') {
			state.mem.project = t.value;
			persist();
			runSearch();
		}
	});

	const combo = $('scegli-progetto');
	combo.addEventListener('focus', () => {
		comboFill();
		comboOpen(true);
	});
	combo.addEventListener('blur', () =>
		setTimeout(() => {
			if (document.activeElement === combo) return;
			if (!state.draft.path) {
				const v = combo.value.trim().toLowerCase();
				const exact = projects().find(p => p.name.toLowerCase() === v);
				if (exact) choose(exact);
				else if (v && comboItems.length === 1) choose(comboItems[0]);
			}
			comboOpen(false);
		}, 120),
	);
	combo.addEventListener('keydown', e => {
		const open = combo.getAttribute('aria-expanded') === 'true';
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (!open) {
				comboFill();
				comboOpen(true);
				return;
			}
			if (!comboItems.length) return;
			const d = e.key === 'ArrowDown' ? 1 : -1;
			comboActive((comboIdx + d + comboItems.length) % comboItems.length);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (open && comboIdx >= 0 && comboItems[comboIdx]) {
				choose(comboItems[comboIdx]);
				$('compito').focus();
			}
		} else if (e.key === 'Escape') {
			if (open) {
				e.preventDefault();
				e.stopPropagation();
				comboOpen(false);
			}
		} else if (e.key === 'Tab' && open && comboIdx >= 0 && !state.draft.path && combo.value.trim()) {
			choose(comboItems[comboIdx]);
		}
	});
	$('progetti-lista').addEventListener('mousedown', e => e.preventDefault());

	$('composer').addEventListener('submit', e => {
		e.preventDefault();
		startJob();
	});
	$('compito').addEventListener('keydown', e => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			startJob();
		}
	});

	$('mem-cerca').addEventListener('submit', e => {
		e.preventDefault();
		runSearch();
	});

	$('ric-cerca').addEventListener('submit', e => {
		e.preventDefault();
		runRicerca();
	});

	$('notte-form').addEventListener('submit', e => {
		e.preventDefault();
		const from = $('notte-da').value, to = $('notte-a').value;
		if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) return;
		vscode.postMessage({ type: 'notte.config', from, to, parallel: Number($('notte-insieme').value) === 2 ? 2 : 1 });
		state.notteEdit = false;
		renderLavori();
		$('notte-riga').querySelector('[data-act="notte-edit"]')?.focus();
		announce(`Finestra della notte: dalle ${from} alle ${to}.`);
	});
	$('notte-form').addEventListener('keydown', e => {
		if (e.key !== 'Escape') return;
		e.preventDefault();
		state.notteEdit = false;
		renderLavori();
		$('notte-riga').querySelector('[data-act="notte-edit"]')?.focus();
	});

	$('ricorda').addEventListener('submit', e => {
		e.preventDefault();
		const ta = $('ricorda-testo');
		const text = ta.value.trim();
		if (!text) {
			say('ricorda-esito', 'Scrivi prima cosa ricordare.', true);
			ta.focus();
			return;
		}
		const project = $('ricorda-progetto').value;
		/** @type {any} */ const msg = { type: 'memoria.remember', text };
		if (project) msg.project = project;
		vscode.postMessage(msg);
		ta.value = '';
		say('ricorda-esito', project ? `Messo in memoria per ${project}.` : 'Messo in memoria.');
		// il ricordo nuovo compare nella linea del tempo appena la memoria l'ha scritto
		setTimeout(runSearch, 800);
	});

	function ask() {
		const ta = $('domanda');
		const text = ta.value.trim();
		if (!text) return ta.focus();
		vscode.postMessage({ type: 'assistant.ask', text });
		state.pendingAsk = { text, at: Date.now() };
		ta.value = '';
		state.ask = '';
		persist();
		renderMelissa();
		const reg = $('registro');
		reg.scrollTop = reg.scrollHeight;
	}
	$('chiedi').addEventListener('submit', e => {
		e.preventDefault();
		ask();
	});
	$('domanda').addEventListener('keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			ask();
		}
	});

	const SEARCH_OF = { plancia: 'cerca-progetti', lavori: 'scegli-progetto', memoria: 'cerca-memoria', melissa: 'domanda' };
	const searchOf = v => (v === 'memoria' && state.mem.mode === 'ricerca' ? 'cerca-risolto' : SEARCH_OF[v]);

	document.addEventListener('keydown', e => {
		const el = /** @type {HTMLElement} */ (e.target);
		const inField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
		if (e.metaKey || e.ctrlKey || e.altKey || state.cont) return;
		if (!inField && /^[1-9]$/.test(e.key) && Number(e.key) <= VIEWS.length) {
			e.preventDefault();
			return show(VIEWS[Number(e.key) - 1][0], true);
		}
		if (e.key === '/' && !inField) {
			const f = $(searchOf(state.view));
			if (!f) return;
			e.preventDefault();
			if (f) f.focus();
			return;
		}
		if (e.key === 'Escape' && el.id === 'cerca-progetti' && state.query) {
			state.query = '';
			el.value = '';
			persist();
			renderPlancia();
		}
	});

	document.addEventListener('visibilitychange', () => {
		const hidden = document.visibilityState === 'hidden';
		if (hidden) orb.sleep();
		else orb.wake();
		for (const [id] of ROOMS) room(id, hidden ? 'pause' : 'resume');
	});
	if (reduced.addEventListener) reduced.addEventListener('change', () => orb.wake());
	window.addEventListener('resize', () => {
		if (state.view === 'melissa') orb.redraw();
	});

	window.addEventListener('message', ev => {
		const m = ev.data || {};
		switch (m.type) {
			case 'snapshot':
				if (!m.snapshot) return;
				noticeJobChanges(m.snapshot.jobs || []);
				state.snapshot = m.snapshot;
				room('vedetta', 'update', m.snapshot);
				room('clienti', 'update', m.snapshot);
				if (m.snapshot.assistant) {
					state.assistant = m.snapshot.assistant;
					state.voiceOptimistic = null;
				}
				if (state.armed && !jobs().some(j => j.id === state.armed && (j.status === 'in corso' || j.status === 'ti aspetta'))) state.armed = '';
				return render();
			case 'focus':
				return focusRow(m.path);
			case 'view':
				if (m.view) show(m.view);
				return;
			case 'filter': {
				// un'azione di navigazione rimbalzata dall'estensione: Plancia con quel filtro
				const f = FILTERS.find(x => x[0] === m.filter);
				if (!f) return show('plancia');
				state.filter = f[0];
				state.query = '';
				$('cerca-progetti').value = '';
				persist();
				show('plancia');
				$('righe').scrollIntoView?.({ block: 'start', behavior: reduced.matches ? 'auto' : 'smooth' });
				announce(`Progetti filtrati: ${f[1]}.`);
				return;
			}
			case 'composer':
				return openComposer(m);
			case 'continua': {
				if (!m.path) return;
				const asked = state.contWaiting === m.path;
				state.contWaiting = '';
				if (state.cont) closeContinua();
				// chiesto da Melissa (o da un link) e non da un clic: si apre la Plancia su quel progetto
				if (!asked || state.view !== 'plancia') focusRow(m.path);
				else renderPlancia();
				// il fuoco, chiuso il dialogo, torna sul pulsante «Continua da dove eri» del progetto
				openContinua(m, `continua:${m.path}`);
				return;
			}
			case 'ricerca': {
				// solo la risposta all'ultima ricerca mandata: le vecchie si scartano
				if (typeof m.query !== 'string' || !state.ric.sent || m.query.trim() !== state.ric.sent) return;
				state.ric.result = {
					query: state.ric.sent,
					memoria: Array.isArray(m.memoria) ? m.memoria : [],
					codice: Array.isArray(m.codice) ? m.codice : [],
					ms: m.ms,
					error: m.error,
				};
				state.ric.waiting = false;
				if (state.view === 'memoria') renderMemoria();
				return;
			}
			case 'memoria.cerca': {
				// da un link bottega:// o da Spotlight: ricerca normale nei ricordi
				const q = typeof m.query === 'string' ? m.query : '';
				state.mem.mode = 'ricordi';
				state.mem.query = q;
				$('cerca-memoria').value = q;
				persist();
				if (state.view !== 'memoria') show('memoria');
				runSearch();
				return;
			}
			case 'ricerca.avvia': {
				// «Dove l'ho gia' risolto?» con quella domanda
				const q = typeof m.query === 'string' ? m.query.trim() : '';
				state.mem.mode = 'ricerca';
				state.ric.query = q;
				$('cerca-risolto').value = q;
				persist();
				if (state.view !== 'memoria') show('memoria');
				if (q) runRicerca();
				else {
					renderMemoria();
					$('cerca-risolto').focus();
				}
				return;
			}
			case 'bacheca.sessione': {
				if (!m.sessionId) return;
				const cur = state.sess.get(m.sessionId);
				state.sess.set(m.sessionId, { open: cur ? cur.open : true, items: Array.isArray(m.items) ? m.items : [] });
				if (state.view === 'lavori') renderLavori();
				return;
			}
			case 'clients':
			case 'clients.exported':
				return room('clienti', 'message', m);
			case 'memoria': {
				const sent = state.mem.sent;
				// una risposta arrivata dopo che la ricerca e' cambiata non deve coprire quella nuova
				if (sent && typeof m.query === 'string' && m.query.trim() !== sent.query) return;
				state.mem.results = Array.isArray(m.results) ? m.results : [];
				if (Array.isArray(m.bacheca)) state.mem.bacheca = m.bacheca;
				state.mem.waiting = false;
				if (state.view === 'memoria') renderMemoria();
				return;
			}
			case 'stats':
				// il cruscotto riceve tutto come prima; la Home tiene per se' oggi e settimana
				if (m.stats) state.stats = m.stats;
				room('cruscotto', 'setStats', m.stats || null, m.error);
				if (state.view === 'plancia' && state.snapshot && state.snapshot.scannedAt) renderQuadro();
				return;
			case 'assistant':
				state.assistant = m.state;
				state.voiceOptimistic = null;
				renderHeader();
				if (state.view === 'melissa') renderMelissa();
				return;
		}
	});

	// I tempi relativi invecchiano anche senza nuovi dati: si aggiorna solo cio' che e' cambiato.
	setInterval(() => {
		if (state.snapshot && document.visibilityState !== 'hidden') renderView();
	}, 30_000);

	vscode.postMessage({ type: 'ready' });
	show(state.view);
})();
