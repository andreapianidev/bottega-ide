/* Inventario Vercel: stessi dati del ponte iPhone. Nessuna credenziale nella webview. */
(function () {
	'use strict';
	const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	const safe = u => { try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password ? esc(x.href) : ''; } catch { return ''; } };
	function mount(root, host) {
		let snapshot, query = '', filter = 'tutti', html = '';
		root.innerHTML = `<div class="vrc"><h1 class="sentence media">I tuoi progetti su Vercel.</h1>
			<p class="invito">Dalla cartella al repository, fino all’ultima pubblicazione di produzione.</p>
			<div class="vrc-tools"><label>Cerca un progetto <input id="vrc-search" type="search" placeholder="Nome, repository o dominio"></label>
			<label>Mostra <select id="vrc-filter"><option value="tutti">Tutti i progetti</option><option value="male">Pubblicazioni fallite</option><option value="cloud">Senza cartella locale</option></select></label>
			<button class="act" id="vrc-refresh">Aggiorna Vercel</button></div>
			<p id="vrc-status" role="status" aria-live="polite"></p><ul id="vrc-list" class="vrc-list"></ul></div>`;
		const $ = id => root.querySelector('#' + id);
		function render() {
			const v = snapshot?.radar?.vercel;
			const catalog = v?.catalog ?? (v?.sites ?? []).map(s => ({ ...s, id: s.projectId, localPaths: s.projectPath ? [s.projectPath] : [] }));
			const at = v?.catalogAt || v?.at;
			$('vrc-refresh').disabled = !!v?.refreshing;
			$('vrc-status').textContent = [v?.refreshing ? 'Aggiornamento in corso.' : at ? `Letto il ${new Date(at).toLocaleString('it-IT')}.` : 'Inventario non ancora letto. Premi Aggiorna Vercel.',
				v?.catalogError || v?.error || '', v?.catalogPartial ? 'Inventario parziale: alcuni progetti o team potrebbero mancare.' : ''].filter(Boolean).join(' ');
			const list = catalog.filter(p => (filter === 'tutti' || filter === 'male' && p.tone === 'male' || filter === 'cloud' && !p.localPaths.length) &&
				[p.name, p.repo, p.domain].join(' ').toLowerCase().includes(query.toLowerCase()));
			const next = list.map(p => `<li class="vrc-project"><div class="vrc-heading"><h2>${esc(p.name)}</h2><span class="vrc-state ${['ok','male','attesa'].includes(p.tone) ? p.tone : 'attesa'}">${esc(p.label)}</span></div>
				${p.domain ? `<p><a href="${safe('https://' + p.domain)}">${esc(p.domain)}</a></p>` : ''}
				<dl><dt>GitHub</dt><dd>${p.repo ? `<a href="https://github.com/${esc(p.repo)}">${esc(p.repo)}</a>` : 'Repository non collegato'}</dd>
				<dt>Sul Mac</dt><dd>${p.localPaths.length ? p.localPaths.map(x => `<button class="link" data-path="${esc(x)}">${esc(x.replace(snapshot?.home || '\u0000', '~'))}</button>`).join('<br>') : 'Cartella non rilevata'}</dd>
				<dt>Produzione</dt><dd>${esc(p.productionBranch || p.commit?.ref || 'Ramo non disponibile')}${p.framework ? ' · ' + esc(p.framework) : ''}</dd></dl>
				${p.commit ? `<p class="vrc-commit">${esc(p.commit.sha.slice(0,7))} ${esc(p.commit.message)}</p>` : ''}
				<p class="vrc-footer">${p.at ? esc(new Date(p.at).toLocaleString('it-IT')) : 'Nessuna pubblicazione di produzione'} <a href="${safe(p.url)}">Apri su Vercel</a></p></li>`).join('') || '<li class="empty">Nessun progetto per questa ricerca.</li>';
			if (next !== html) { $('vrc-list').innerHTML = next; html = next; }
		}
		$('vrc-search').addEventListener('input', e => { query = e.target.value; render(); });
		$('vrc-filter').addEventListener('change', e => { filter = e.target.value; render(); });
		$('vrc-refresh').addEventListener('click', () => { host.post({ type: 'vercel.refresh' }); });
		root.addEventListener('click', e => { const b = e.target.closest('[data-path]'); if (b) host.post({ type: 'open', path: b.dataset.path }); });
		return { update(s) { snapshot = s; render(); }, show() { render(); if (!snapshot?.radar?.vercel?.catalogAt) host.post({ type: 'vercel.refresh' }); }, hide() {}, pause() {}, resume() {} };
	}
	window.BottegaVercel = { mount };
})();
