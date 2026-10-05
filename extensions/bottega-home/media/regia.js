/* La Regia: lo stesso registro di Lavori, letto per progetto. Nessuna seconda fonte di stato. */
(function () {
	'use strict';
	const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	const rank = { 'ti aspetta': 0, errore: 1, 'in corso': 2, 'in coda': 3, stanotte: 4, sconosciuto: 5, finito: 6 };
	const active = new Set(['ti aspetta', 'errore', 'in corso', 'in coda', 'stanotte']);
	const sourceName = { claude: 'Claude Code', codex: 'Codex', cline: 'Cline', terminale: 'Terminale' };
	const keyOf = a => a.path ? `path:${a.path}` : `name:${a.project}`;
	const age = at => {
		if (!at) return '';
		const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
		if (minutes < 2) return 'adesso';
		if (minutes < 60) return `${minutes} min fa`;
		if (minutes < 1440) return `${Math.floor(minutes / 60)} h fa`;
		return `${Math.floor(minutes / 1440)} g fa`;
	};
	const plural = (n, singular, many) => `${n} ${n === 1 ? singular : many}`;

	function mount(root, host) {
		let snapshot = null;
		let visible = false;
		const saved = host.saved || {};
		let scope = saved.scope === 'tutte' ? 'tutte' : 'attive';
		let query = String(saved.query || '');
		const closed = new Set(Array.isArray(saved.closed) ? saved.closed : []);
		let lastList = '';
		let digest = null;
		const save = () => host.save({ scope, query, closed: [...closed] });
		root.innerHTML = `<div class="regia">
			<header class="regia-testa"><div><h1>Regia</h1><p id="regia-frase">Sto leggendo le sessioni.</p></div><div class="regia-testa-azioni"><button type="button" class="regia-metal" data-regia="metal">Apri cruscotto Metal</button><button type="button" class="regia-nuovo" data-regia="new">Nuovo lavoro</button></div></header>
			<section class="regia-sintesi" aria-label="Sintesi della Regia"><div class="regia-sintesi-titolo"><h2>Il punto della situazione</h2><button type="button" data-regia="refresh">Aggiorna sintesi</button></div><p id="regia-sintesi-testo">Preparo un riepilogo dai lavori osservati.</p><p id="regia-sintesi-fonte" class="regia-sintesi-fonte"></p><details id="regia-confronto" hidden><summary>Leggi anche l'altra versione</summary><p id="regia-altra"></p></details></section>
			<div class="regia-comandi"><div class="regia-scelta" role="group" aria-label="Quali sessioni mostrare"><button type="button" data-regia-scope="attive">Da seguire</button><button type="button" data-regia-scope="tutte">Tutte</button></div><label class="regia-cerca"><span class="sr">Cerca progetto o agente</span><input id="regia-cerca" type="search" placeholder="Cerca progetto o agente" autocomplete="off"></label></div>
			<p class="regia-nota">Claude Code, Codex, Cline e terminali. Le sessioni con stato non confermato restano nel registro, senza essere contate come attive.</p>
			<div id="regia-lista" class="regia-lista"></div>
		</div>`;
		const $ = id => root.querySelector(`#${id}`);
		$('regia-cerca').value = query;
		host.post({ type: 'regia.digest' });
		function renderDigest() {
			const activeNow = (snapshot?.activity || []).some(a => active.has(a.status)) || (snapshot?.work || []).some(w => w.status === 'in coda' || w.status === 'stanotte');
			if (snapshot && !activeNow) {
				$('regia-sintesi-testo').textContent = 'Nessun agente richiede attenzione adesso.';
				$('regia-sintesi-fonte').textContent = 'Dal registro aggiornato';
				$('regia-confronto').hidden = true;
				return;
			}
			if (!digest) return;
			$('regia-sintesi-testo').textContent = digest.text;
			$('regia-sintesi-fonte').textContent = `${digest.engine === 'apple' ? 'Apple Intelligence' : 'Agnes'} · aggiornato ${age(digest.at)}`;
			const alternate = digest.alternatives?.[0];
			$('regia-confronto').hidden = !alternate;
			$('regia-altra').textContent = alternate ? `${alternate.engine === 'apple' ? 'Apple Intelligence' : 'Agnes'}: ${alternate.text}` : '';
		}

		function entries() {
			if (!snapshot) return [];
			const known = new Map((snapshot.projects || []).map(p => [p.path, p]));
			const groups = new Map();
			const put = item => {
				const key = keyOf(item);
				if (!groups.has(key)) groups.set(key, { key, name: item.project || 'Senza progetto', path: item.path || '', rows: [] });
				groups.get(key).rows.push(item);
			};
			const latest = new Map();
			for (const a of snapshot.activity || []) {
				const old = latest.get(a.key);
				if (!old || a.updatedAt >= old.updatedAt) latest.set(a.key, a);
			}
			for (const a of latest.values()) {
				const p = a.path && known.get(a.path);
				put({ ...a, project: p?.name || a.project, path: a.path || p?.path || '' });
			}
			// La coda Claude appartiene a Lavori ma non al registro dei processi: la mostriamo senza duplicare le sessioni vive.
			for (const w of snapshot.work || []) {
				if (w.status !== 'in coda' && w.status !== 'stanotte') continue;
				put({ key: w.key, id: w.sessionId || '', source: 'claude', project: w.project, path: w.path,
					title: w.title, status: w.status, updatedAt: w.since, jobId: w.jobId });
			}
			const q = query.trim().toLocaleLowerCase('it');
			return [...groups.values()].map(g => {
				g.rows = g.rows.filter(a => (scope === 'tutte' || active.has(a.status)) && (!q || [g.name, a.title, a.summary, sourceName[a.source]].some(v => String(v || '').toLocaleLowerCase('it').includes(q))));
				g.rows.sort((a, b) => (rank[a.status] ?? 8) - (rank[b.status] ?? 8) || b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
				return g;
			}).filter(g => g.rows.length).sort((a, b) => (rank[a.rows[0].status] ?? 8) - (rank[b.rows[0].status] ?? 8) || b.rows[0].updatedAt - a.rows[0].updatedAt || a.name.localeCompare(b.name, 'it'));
		}

		function row(a) {
			const w = a.source === 'claude' && (snapshot.work || []).find(x => x.jobId && ((x.sessionId && x.sessionId === a.id) || `claude:${x.key}` === a.key));
			const jobId = a.jobId || w?.jobId;
			const step = Array.isArray(a.steps) ? a.steps.at(-1) : '';
			const detail = step || a.summary || '';
			const action = jobId && active.has(a.status)
				? `<button type="button" data-regia="focus" data-id="${esc(jobId)}">Apri lavoro</button>`
				: a.source === 'claude' && a.id && a.path
					? `<button type="button" data-regia="resume" data-path="${esc(a.path)}" data-id="${esc(a.id)}">Riprendi Claude</button>`
					: a.path ? `<button type="button" data-regia="open" data-path="${esc(a.path)}">Apri progetto</button>` : '';
			return `<li class="regia-agente stato-${esc(a.status.replace(/\s+/g, '-'))}" data-activity="${esc(a.key)}">
				<div class="regia-segno" aria-hidden="true"></div><div class="regia-agente-corpo"><div class="regia-agente-meta"><span class="regia-fonte">${esc(sourceName[a.source] || 'Agente')}</span><span class="regia-stato">${esc(a.status)}</span><time>${esc(age(a.updatedAt))}</time></div><p class="regia-compito">${esc(a.title || 'Sessione senza titolo')}</p>${detail ? `<p class="regia-passo">${esc(detail)}</p>` : ''}</div><div class="regia-azione">${action}</div>
			</li>`;
		}

		function render() {
			if (!snapshot || !visible) return;
			const all = snapshot.activity || [];
			const waiting = all.filter(a => a.status === 'ti aspetta').length;
			const running = all.filter(a => a.status === 'in corso').length;
			const errors = all.filter(a => a.status === 'errore').length;
			const queued = (snapshot.work || []).filter(w => w.status === 'in coda' || w.status === 'stanotte').length;
			$('regia-frase').textContent = [plural(waiting, 'ti aspetta', 'ti aspettano'), plural(running, 'al lavoro', 'al lavoro'), errors ? plural(errors, 'errore', 'errori') : '', queued ? plural(queued, 'in coda', 'in coda') : ''].filter(Boolean).join('  ·  ');
			renderDigest();
			for (const b of root.querySelectorAll('[data-regia-scope]')) b.setAttribute('aria-pressed', String(b.getAttribute('data-regia-scope') === scope));
			const groups = entries();
			const html = groups.length ? groups.map(g => {
				const wait = g.rows.filter(a => a.status === 'ti aspetta').length;
				const run = g.rows.filter(a => a.status === 'in corso').length;
				const isClosed = closed.has(g.key);
				return `<section class="regia-progetto" data-project="${esc(g.key)}"><div class="regia-progetto-testa"><button type="button" class="regia-espandi" data-regia="toggle" data-key="${esc(g.key)}" aria-expanded="${!isClosed}"><span class="regia-chevron" aria-hidden="true"></span><span class="regia-nome">${esc(g.name)}</span><span class="regia-conti">${wait ? `${esc(plural(wait, 'ti aspetta', 'ti aspettano'))}  ·  ` : ''}${run ? `${esc(plural(run, 'al lavoro', 'al lavoro'))}  ·  ` : ''}${esc(plural(g.rows.length, 'sessione', 'sessioni'))}</span></button>${g.path ? `<button type="button" class="regia-qui" data-regia="new" data-path="${esc(g.path)}">Nuovo lavoro</button>` : ''}</div><ul ${isClosed ? 'hidden' : ''}>${g.rows.map(row).join('')}</ul></section>`;
			}).join('') : `<div class="regia-vuoto"><p>${query ? 'Nessuna sessione corrisponde alla ricerca.' : scope === 'attive' ? 'Nessun agente richiede attenzione adesso.' : 'Nessuna sessione nel registro.'}</p><button type="button" data-regia="new">Prepara un lavoro</button></div>`;
			if (html !== lastList) {
				const focus = root.contains(document.activeElement) ? document.activeElement?.getAttribute('data-key') : null;
				$('regia-lista').innerHTML = html;
				lastList = html;
				if (focus) [...root.querySelectorAll('[data-key]')].find(el => el.getAttribute('data-key') === focus)?.focus();
			}
		}

		root.addEventListener('input', e => {
			if (e.target?.id !== 'regia-cerca') return;
			query = e.target.value;
			save();
			render();
		});
		root.addEventListener('click', e => {
			const scopeButton = e.target.closest('[data-regia-scope]');
			if (scopeButton) { scope = scopeButton.getAttribute('data-regia-scope'); save(); render(); return; }
			const b = e.target.closest('[data-regia]');
			if (!b) return;
			const action = b.getAttribute('data-regia');
			const path = b.getAttribute('data-path') || '';
			if (action === 'toggle') { const k = b.getAttribute('data-key'); closed.has(k) ? closed.delete(k) : closed.add(k); save(); render(); }
			if (action === 'new') host.compose(path);
			if (action === 'open') host.post({ type: 'open', path });
			if (action === 'resume') host.post({ type: 'claude', path, id: b.getAttribute('data-id') });
			if (action === 'focus') host.post({ type: 'job.focus', id: b.getAttribute('data-id') });
			if (action === 'metal') host.post({ type: 'regia.metal' });
			if (action === 'refresh') { $('regia-sintesi-testo').textContent = 'Aggiorno la sintesi…'; host.post({ type: 'regia.refresh' }); }
		});
		return { update(s) { snapshot = s; render(); }, setDigest(d) { digest = d; renderDigest(); }, show() { visible = true; host.post({ type: 'regia.digest' }); render(); renderDigest(); }, hide() { visible = false; }, pause() {}, resume() {} };
	}
	window.BottegaRegia = { mount };
})();
