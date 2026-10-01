// @ts-check
(function () {
	const vscode = acquireVsCodeApi();
	const app = /** @type {HTMLElement} */ (document.getElementById('app'));
	const saved = vscode.getState() || {};
	const state = {
		snapshot: null,
		filter: saved.filter || 'tutti',
		query: saved.query || '',
		open: new Set(saved.open || []),
	};

	const persist = () => vscode.setState({ filter: state.filter, query: state.query, open: [...state.open] });

	const esc = s =>
		String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

	const NUM = ['nessun', 'un', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci'];
	const word = n => (n < NUM.length ? NUM[n] : String(n));
	const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

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

	const home = p => (state.snapshot && p.startsWith(state.snapshot.home) ? '~' + p.slice(state.snapshot.home.length) : p);
	const STATUS = { busy: 'al lavoro', idle: 'in attesa', shell: 'nel terminale' };
	const KIND = { apple: 'Apple', web: 'Web', android: 'Android', python: 'Python', swiftpm: 'Swift package', docs: 'Documenti', altro: 'Altro' };

	const day = 86_400_000;
	const FILTERS = [
		['tutti', 'Tutti', () => true],
		['claude', 'Claude oggi', p => p.live.length > 0 || (p.sessions[0] && Date.now() - p.sessions[0].mtime < day)],
		['push', 'Da spingere', p => p.git && (p.git.ahead > 0 || !p.git.upstream)],
		['dirty', 'Con modifiche', p => p.git && p.git.changes > 0],
		['apple', 'Apple', p => p.kinds.includes('apple') || p.kinds.includes('swiftpm')],
		['web', 'Web', p => p.kinds.includes('web')],
		['android', 'Android', p => p.kinds.includes('android')],
		['nogit', 'Senza git', p => !p.git],
	];

	function sentence(s) {
		const busy = s.live.filter(l => l.status === 'busy').length;
		const waiting = s.live.length - busy;
		const toPush = s.projects.filter(p => p.git && p.git.ahead > 0).length;
		const dirty = s.projects.filter(p => p.git && p.git.changes > 0).length;
		const n = x => `<span class="n">${word(x)}</span>`;
		let a = busy === 0 ? 'Nessun Claude al lavoro' : `${cap(n(busy))} Claude al lavoro`;
		if (waiting) a += `, ${n(waiting)} in attesa`;
		a += '.';
		const b = toPush === 0 ? ' Tutto spinto.' : toPush === 1 ? ` ${cap(n(1))} progetto aspetta un push.` : ` ${cap(n(toPush))} progetti aspettano un push.`;
		const c = dirty ? (dirty === 1 ? ` ${cap(n(1))} ha modifiche fuori da un commit.` : ` ${cap(n(dirty))} hanno modifiche fuori da un commit.`) : '';
		return a + b + c;
	}

	function projectOf(s, l) {
		return s.projects.find(p => p.live.some(x => x.pid === l.pid));
	}

	function lamps(s) {
		if (!s.live.length) return `<p class="quiet">Nessuna sessione Claude Code aperta in questo momento.</p>`;
		return `<ul class="lamps">${s.live
			.map(l => {
				const p = projectOf(s, l);
				const where = p ? p.name : l.cwd === s.home ? 'home' : l.cwd.split('/').pop();
				return `<li><button class="lamp ${l.status === 'busy' ? 'busy' : ''}" data-act="${p ? 'focus' : 'claude-here'}" data-path="${esc(p ? p.path : l.cwd)}"
					title="${esc(l.cwd)}, PID ${l.pid}">
					<i class="dot" aria-hidden="true"></i><b>${esc(where)}</b>
					<span>${esc(STATUS[l.status] || l.status)} da ${esc(ago(l.statusSince).replace(' fa', ''))}${l.title ? ', ' + esc(l.title) : ''}</span>
				</button></li>`;
			})
			.join('')}</ul>`;
	}

	function mark(p) {
		if (p.live.length) return ['live', 'Claude sta lavorando qui'];
		if (!p.git) return ['none', 'Non e’ un repository git'];
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
		const actions = [
			`<button class="act main" data-act="claude" data-path="${pa}">Nuova sessione Claude</button>`,
			`<button class="act" data-act="open" data-path="${pa}">Apri in una nuova finestra</button>`,
			`<button class="act" data-act="here" data-path="${pa}">Apri qui</button>`,
			p.xcodeProject ? `<button class="act" data-act="xcode" data-path="${pa}">Apri in Xcode</button>` : '',
			`<button class="act" data-act="finder" data-path="${pa}">Mostra nel Finder</button>`,
			p.git && p.git.ahead > 0 && p.git.upstream ? `<button class="act" data-act="push" data-path="${pa}">Spingi ${p.git.ahead} commit</button>` : '',
		].join('');
		const hist = p.sessions.length
			? `<ol>${p.sessions
					.slice(0, 6)
					.map(
						s => `<li><span class="t" title="${esc(s.title)}">${esc(s.title)}</span><span class="w">${esc(ago(s.mtime))}</span>
						<button class="link" data-act="resume" data-path="${esc(s.cwd)}" data-id="${esc(s.sessionId)}">Riprendi</button></li>`,
					)
					.join('')}</ol>`
			: `<p class="w">Nessuna sessione Claude negli ultimi 45 giorni.</p>`;
		return `<div class="detail" ${state.open.has(p.path) ? '' : 'hidden'}>
			<div><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl><div class="actions">${actions}</div></div>
			<div class="history"><h3>Sessioni Claude</h3>${hist}</div>
		</div>`;
	}

	function row(p) {
		const [cls, label] = mark(p);
		const last = p.sessions[0];
		const what = p.live[0]?.title || last?.title || p.git?.lastCommitSubject || '';
		const isOpen = state.open.has(p.path);
		return `<li class="row" data-row="${esc(p.path)}">
			<button data-act="toggle" data-path="${esc(p.path)}" aria-expanded="${isOpen}">
				<i class="mark ${cls}" role="img" aria-label="${esc(label)}" title="${esc(label)}"></i>
				<span class="name">${esc(p.name)}</span>
				<span class="what">${esc(what)}</span>
				<span class="git">${gitCell(p)}</span>
				<span class="build">${buildCell(p)}</span>
				<span class="when">${esc(ago(p.touchedAt))}</span>
			</button>
			${detail(p)}
		</li>`;
	}

	function elsewhere(s) {
		if (!s.elsewhere.length) return '';
		return `<section class="elsewhere history">
			<h2>Sessioni fuori dai progetti</h2>
			<p>Partite dalla home o da cartelle che la Bottega non conosce. Riprenderle le riapre nella stessa cartella.</p>
			<ol>${s.elsewhere
				.slice(0, 12)
				.map(
					x => `<li><span class="t"><span title="${esc(x.title)}">${esc(x.title)}</span><span class="cwd">${esc(home(x.cwd))}</span></span>
					<span class="w">${esc(ago(x.mtime))}</span>
					<button class="link" data-act="resume" data-path="${esc(x.cwd)}" data-id="${esc(x.sessionId)}">Riprendi</button></li>`,
				)
				.join('')}</ol>
		</section>`;
	}

	function render() {
		const s = state.snapshot;
		if (!s) {
			app.innerHTML = `<p class="empty">Sto leggendo i progetti e le sessioni Claude.</p>`;
			return;
		}
		const active = FILTERS.find(f => f[0] === state.filter) || FILTERS[0];
		const q = state.query.trim().toLowerCase();
		const shown = s.projects.filter(active[2]).filter(p => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
		const hadFocus = document.activeElement && document.activeElement.classList.contains('search');
		app.innerHTML = `
			<header class="head">
				<p class="brand">Bottega</p>
				<div class="stamp"><span>${s.scannedAt ? 'letto ' + esc(ago(s.scannedAt)) : 'lettura in corso'}</span>
				<button class="ghost" data-act="refresh">Aggiorna</button></div>
			</header>
			<h1 class="sentence">${sentence(s)}</h1>
			${lamps(s)}
			<div class="bar">
				<input class="search" type="search" placeholder="Cerca un progetto" value="${esc(state.query)}" aria-label="Cerca un progetto">
				<div class="filters" role="group" aria-label="Filtra i progetti">
					${FILTERS.map(([id, label, fn]) => {
						const n = s.projects.filter(fn).length;
						if (!n && id !== 'tutti' && id !== state.filter) return '';
						return `<button data-filter="${id}" aria-pressed="${id === state.filter}">${label}<small>${n}</small></button>`;
					}).join('')}
				</div>
			</div>
			${
				shown.length
					? `<ul class="rows">${shown.map(row).join('')}</ul>`
					: `<p class="empty">Nessun progetto corrisponde. Cambia filtro o svuota la ricerca.</p>`
			}
			${elsewhere(s)}`;
		if (hadFocus) {
			const input = /** @type {HTMLInputElement} */ (app.querySelector('.search'));
			input.focus();
			input.setSelectionRange(input.value.length, input.value.length);
		}
	}

	app.addEventListener('click', e => {
		const t = /** @type {HTMLElement} */ (e.target);
		const f = t.closest('[data-filter]');
		if (f) {
			state.filter = f.getAttribute('data-filter') || 'tutti';
			persist();
			return render();
		}
		const b = t.closest('[data-act]');
		if (!b) return;
		const act = b.getAttribute('data-act');
		const p = b.getAttribute('data-path') || '';
		if (act === 'toggle') {
			state.open.has(p) ? state.open.delete(p) : state.open.add(p);
			persist();
			const li = b.closest('.row');
			const d = li && li.querySelector('.detail');
			if (d) d.toggleAttribute('hidden', !state.open.has(p));
			b.setAttribute('aria-expanded', String(state.open.has(p)));
			return;
		}
		if (act === 'focus') return focusRow(p);
		if (act === 'resume') return vscode.postMessage({ type: 'claude', path: p, id: b.getAttribute('data-id') });
		if (act === 'claude-here') return vscode.postMessage({ type: 'claude', path: p });
		vscode.postMessage({ type: act, path: p });
	});

	app.addEventListener('input', e => {
		const t = /** @type {HTMLInputElement} */ (e.target);
		if (!t.classList.contains('search')) return;
		state.query = t.value;
		persist();
		render();
	});

	document.addEventListener('keydown', e => {
		const inField = /** @type {HTMLElement} */ (e.target).tagName === 'INPUT';
		if (e.key === '/' && !inField) {
			e.preventDefault();
			/** @type {HTMLInputElement} */ (app.querySelector('.search'))?.focus();
		}
		if (e.key === 'Escape' && inField && state.query) {
			state.query = '';
			persist();
			render();
		}
	});

	function focusRow(p) {
		if (!state.snapshot) return;
		state.filter = 'tutti';
		state.query = '';
		state.open.add(p);
		persist();
		render();
		const li = [...app.querySelectorAll('.row')].find(x => x.getAttribute('data-row') === p);
		if (li) {
			li.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
			/** @type {HTMLElement} */ (li.querySelector('button')).focus({ preventScroll: true });
		}
	}

	window.addEventListener('message', ev => {
		const m = ev.data;
		if (m.type === 'snapshot') {
			state.snapshot = m.snapshot;
			render();
		} else if (m.type === 'focus') {
			focusRow(m.path);
		}
	});

	// I tempi relativi invecchiano anche senza nuovi dati.
	setInterval(() => {
		if (!document.activeElement || !document.activeElement.classList.contains('search')) render();
	}, 60_000);

	render();
	vscode.postMessage({ type: 'ready' });
})();
