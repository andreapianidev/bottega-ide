/* Bottega, i Connettori: la posta di ogni progetto e i connettori di Claude Code che la accendono.
   I dati li prepara l'estensione (src/connettori-host.ts); i messaggi connettori.*, posta.* e rubrica.* e la forma
   degli stati sono in docs/CONTRATTI.md, sezione 5.

   Due schede: Posta (fili di posta e chat WhatsApp per progetto, da assegnare con le proposte imparate dalla posta,
   domini trovati nei file chiusi in fondo) e Connettori (cosa ha l'utente in Claude Code e quali capacita' della
   Bottega accende; i plugin non collegati raggruppati in fondo). La rubrica vive solo in ~/.bottega/rubrica.json:
   questo file non contiene nessun indirizzo.
   Regole: niente librerie, niente attributi style (la CSP li blocca), testo dei dati sempre sfuggito,
   aggiornamenti che non perdono il fuoco ne' il testo che si sta scrivendo. */
(function () {
	'use strict';

	const esc = s =>
		String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	const it = (n, d = 0) => Number(n || 0).toLocaleString('it-IT', { maximumFractionDigits: d, minimumFractionDigits: d });
	const dollari = n => `${it(n, 2)} $`;
	const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

	function fa(t) {
		if (!t) return 'mai';
		const s = Math.max(1, Math.round((Date.now() - t) / 1000));
		if (s < 60) return 'adesso';
		const m = Math.round(s / 60);
		if (m < 60) return `${m} min fa`;
		const h = Math.round(m / 60);
		if (h < 24) return `${h} h fa`;
		const d = Math.round(h / 24);
		return d === 1 ? 'ieri' : `${d} giorni fa`;
	}

	function quando(iso) {
		const t = Date.parse(iso || '');
		if (!Number.isFinite(t)) return '';
		const d = new Date(t);
		const oggi = new Date();
		if (d.toDateString() === oggi.toDateString()) return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
		return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
	}

	const STATO = { connesso: 'connesso', 'da autenticare': 'da autenticare', 'non configurato': 'non configurato', errore: 'non risponde', sconosciuto: 'non ancora controllato' };
	const TIPO = { 'claude.ai': 'claude.ai, via Claude', plugin: 'plugin, via Claude', locale: 'locale, diretto', remoto: 'remoto, via Claude' };

	function mount(root, host) {
		const post = m => host && host.post && host.post(m);
		const saved = (host && host.saved) || {};
		const ui = {
			scheda: saved.scheda === 'connettori' ? 'connettori' : 'posta',
			/** testo nei campi "aggiungi", per progetto */
			bozze: {},
			/** progetto scelto nelle tendine di "Da assegnare", per mittente */
			scelte: {},
			nuovo: { path: '', voce: '' },
		};
		/** @type {any} */ let con = null;
		/** @type {any} */ let posta = null;
		/** @type {{path: string, name: string}[]} */ let progetti = [];
		let visible = false;
		const doc = root.ownerDocument;
		const lastHTML = new WeakMap();

		root.innerHTML = `
		<div class="con" id="con">
			<div class="con-testa">
				<h1 class="sentence media con-frase" id="con-frase">Sto guardando i connettori di Claude Code.</h1>
				<p class="invito con-sotto" id="con-sotto"></p>
			</div>
			<div class="con-schede" role="group" aria-label="Sezioni dei connettori">
				<button type="button" class="ghost" data-k="scheda" data-v="posta" data-fk="k:posta" aria-pressed="true">Posta</button>
				<button type="button" class="ghost" data-k="scheda" data-v="connettori" data-fk="k:connettori" aria-pressed="false">Connettori</button>
			</div>
			<p class="con-esito" id="con-esito" role="status" aria-live="polite"></p>

			<section class="con-sez" id="con-posta" aria-labelledby="con-posta-titolo">
				<h2 class="sr" id="con-posta-titolo">Posta per progetto</h2>
				<div class="con-comandi" id="con-comandi"></div>
				<p class="con-fonti" id="con-fonti"></p>
				<div id="con-progetti-box">
					<h2 class="con-titolo" id="con-progetti-titolo">Per progetto</h2>
					<p class="con-vuoto" id="con-progetti-vuoto" hidden></p>
					<ul class="con-progetti" id="con-progetti" aria-labelledby="con-progetti-titolo"></ul>
					<form class="con-nuovo" id="con-nuovo" autocomplete="off">
						<label class="sr" for="con-nuovo-progetto">Progetto</label>
						<select id="con-nuovo-progetto" class="con-select" data-fk="k:nuovo-progetto"></select>
						<label class="sr" for="con-nuovo-voce">Indirizzo o dominio</label>
						<input id="con-nuovo-voce" class="con-campo" placeholder="anna@esempio.it o esempio.it" data-fk="k:nuovo-voce" spellcheck="false">
						<button type="submit" class="act" data-fk="k:nuovo-ok">Aggiungi alla rubrica</button>
					</form>
				</div>
				<section class="con-blocco" id="con-liberi-box" aria-labelledby="con-liberi-titolo" hidden>
					<h2 class="con-titolo" id="con-liberi-titolo">Da assegnare</h2>
					<p class="con-nota" id="con-liberi-nota"></p>
					<ul class="con-liberi" id="con-liberi"></ul>
					<h3 class="con-sottotitolo" id="con-liberi-wa-titolo" hidden>Chat WhatsApp</h3>
					<ul class="con-liberi" id="con-liberi-wa" aria-labelledby="con-liberi-wa-titolo"></ul>
				</section>
				<details class="con-altri" id="con-sugg-box" hidden>
					<summary id="con-sugg-titolo">Domini trovati nei file dei progetti</summary>
					<p class="con-nota">Da package.json, vercel.json, README e CLAUDE.md, solo quelli che stanno in un progetto solo. Sono indizi deboli: un clic e li aggiungo.</p>
					<ul class="con-sugg" id="con-sugg"></ul>
				</details>
				<p class="con-privato">La rubrica sta solo su questo Mac, in <code>~/.bottega/rubrica.json</code>, mai nel repository. La Bottega legge mittente, oggetto e data, e delle chat solo l'ultimo messaggio accorciato; non invia mai niente. Le chat personali compaiono solo per i numeri in rubrica.</p>
			</section>

			<section class="con-sez" id="con-elenco" aria-labelledby="con-elenco-titolo" hidden>
				<div class="con-comandi">
					<button type="button" class="act" data-k="elenco" data-fk="k:elenco">Aggiorna elenco</button>
					<span class="con-nota" id="con-elenco-nota"></span>
				</div>
				<h2 class="con-titolo" id="con-cap-titolo">Cosa si accende nella Bottega</h2>
				<ul class="con-cap" id="con-cap" aria-labelledby="con-cap-titolo"></ul>
				<h2 class="con-titolo" id="con-elenco-titolo">I tuoi connettori</h2>
				<ul class="con-lista" id="con-lista" aria-labelledby="con-elenco-titolo"></ul>
				<details class="con-altri" id="con-altri-box" hidden>
					<summary id="con-altri-titolo"></summary>
					<ul class="con-lista" id="con-altri"></ul>
				</details>
				<details class="con-altri" id="con-plugin-box" hidden>
					<summary id="con-plugin-titolo"></summary>
					<ul class="con-lista" id="con-plugin"></ul>
				</details>
				<p class="con-privato">Si aggiungono in Claude Code: i connettori di claude.ai dalle impostazioni di claude.ai, i server locali con <code>claude mcp add</code>. La Bottega non tiene nessuna chiave.</p>
			</section>
		</div>`;

		const $ = id => /** @type {any} */ (root.querySelector('#' + id));

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

		function put(el, html) {
			if (lastHTML.get(el) === html) return;
			const k = focusKey(el);
			el.innerHTML = html;
			lastHTML.set(el, html);
			refocus(k, el);
		}

		function esito(t) {
			const e = $('con-esito');
			if (e.textContent !== t) e.textContent = t;
		}

		const nomeDi = p => (progetti.find(x => x.path === p) || {}).name || String(p || '').split('/').filter(Boolean).pop() || p;

		// ---------- testa ----------

		function frase() {
			const n = s => `<span class="n">${esc(s)}</span>`;
			if (ui.scheda === 'connettori') {
				if (!con) return 'Sto guardando i connettori di Claude Code.';
				const accese = (con.capacita || []).filter(c => c.accesa);
				const usabili = (con.connettori || []).filter(c => c.stato === 'connesso').length;
				if (!usabili && !accese.length) return 'Claude Code non ha ancora connettori che la Bottega sa usare.';
				return `Hai ${n(it(usabili))} connettori collegati in Claude Code, e accendono ${n(it(accese.length))} capacità della Bottega.`;
			}
			if (!posta) return 'Sto guardando la posta dei progetti.';
			const nl = (posta.progetti || []).reduce((s, p) => s + (p.nonLetti || 0), 0);
			const conPosta = (posta.progetti || []).filter(p => p.fili.length).length;
			if (!posta.disponibili.locale && !posta.disponibili.gmail) return 'Per la posta serve un connettore di posta in Claude Code.';
			if (!posta.aggiornatoAt) return 'La posta non è ancora stata letta.';
			if (!(posta.progetti || []).length) return 'La rubrica è vuota: dimmi chi scrive per quale progetto.';
			if (!conPosta) return `Negli ultimi ${n(it(posta.giorni))} giorni nessun cliente ha scritto.`;
			return nl
				? `${n(it(nl))} ${nl === 1 ? 'filo non letto' : 'fili non letti'} in ${n(it(conPosta))} ${conPosta === 1 ? 'progetto' : 'progetti'}.`
				: `Hai letto tutto: ${n(it(conPosta))} ${conPosta === 1 ? 'progetto ha' : 'progetti hanno'} posta recente.`;
		}

		function renderTesta() {
			put($('con-frase'), frase());
			const sotto = $('con-sotto');
			let t = '';
			const d = (posta && posta.deleghe) || (con && con.deleghe);
			// Sempre visibile, anche a zero: il tetto si deve vedere prima di spendere, non dopo.
			if (d) t = `Deleghe a Claude oggi: ${dollari(d.spesaOggi || 0)} su un tetto giornaliero di ${dollari(d.tetto)}. Il server di posta del Mac non costa niente.`;
			if (sotto.textContent !== t) sotto.textContent = t;
			sotto.hidden = !t;
			for (const b of root.querySelectorAll('[data-k="scheda"]')) b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === ui.scheda));
			$('con-posta').hidden = ui.scheda !== 'posta';
			$('con-elenco').hidden = ui.scheda !== 'connettori';
		}

		// ---------- posta ----------

		function renderComandi() {
			const p = posta;
			if (!p) return put($('con-comandi'), '');
			const d = p.deleghe || { stime: {}, spesaOggi: 0, tetto: 1 };
			const st = (d.stime && d.stime.posta) || { secondi: 60, usd: 0.08 };
			const occupato = !!p.aggiornando;
			let h = '';
			if (p.disponibili.locale) {
				h += `<div class="con-cmd"><button type="button" class="act main" data-k="posta" data-fk="k:posta-locale"${occupato ? ' disabled' : ''}>${p.aggiornando === 'locale' ? 'Leggo la posta…' : 'Aggiorna posta'}</button>
					<span class="con-nota">da ${esc(p.disponibili.locale)}, sul Mac, gratis, pochi secondi</span></div>`;
			}
			if (p.disponibili.gmail) {
				const sfora = d.spesaOggi + st.usd > d.tetto;
				const testo = p.aggiornando === 'gmail' ? 'Claude cerca in Gmail…' : p.disponibili.locale ? 'Cerca anche in Gmail' : 'Aggiorna posta da Gmail';
				h += `<div class="con-cmd"><button type="button" class="act${p.disponibili.locale ? '' : ' main'}" data-k="gmail" data-fk="k:posta-gmail"${occupato || sfora ? ' disabled' : ''}>${testo}</button>
					<span class="con-nota">${sfora ? `tetto di oggi raggiunto (${dollari(d.spesaOggi)} su ${dollari(d.tetto)})` : `una delega a Claude Code, circa ${it(st.secondi)} secondi e ${dollari(st.usd)}`}</span></div>`;
			}
			const wa = p.whatsapp;
			if (wa && wa.disponibili && wa.disponibili.length) {
				h += `<div class="con-cmd"><button type="button" class="act" data-k="whatsapp" data-fk="k:whatsapp"${wa.aggiornando ? ' disabled' : ''}>${wa.aggiornando ? 'Leggo WhatsApp…' : 'Aggiorna WhatsApp'}</button>
					<span class="con-nota">da ${esc(wa.disponibili.join(' e '))}, sul Mac, gratis</span></div>`;
			}
			if (!h) h = '<p class="con-nota">Nessun connettore di posta. Aggiungi Gmail tra i connettori di claude.ai, oppure un server di posta locale in Claude Code, poi premi Aggiorna elenco nella scheda Connettori.</p>';
			put($('con-comandi'), h);
			const f = [];
			const loc = p.fonti && p.fonti.locale;
			const gm = p.fonti && p.fonti.gmail;
			if (loc) f.push(loc.errore ? `${loc.nome}: ${loc.errore}` : `${cap(loc.nome)} letta ${fa(loc.at)}, ${it(loc.n)} messaggi${loc.pieno ? ' (il massimo che legge in una volta: i messaggi potrebbero essere di più, prova con meno giorni)' : ''}`);
			if (gm) f.push(gm.errore ? `Gmail: ${gm.errore}` : `Gmail letta ${fa(gm.at)}, ${it(gm.n)} fili, ${dollari(gm.costo || 0)}`);
			const waf = (wa && wa.fonti) || {};
			for (const k of ['business', 'personale']) {
				const x = waf[k];
				if (x) f.push(x.errore ? `WhatsApp ${k}: ${x.errore}` : `WhatsApp ${k} letto ${fa(x.at)}, ${it(x.n)} chat`);
			}
			const ft = f.length ? f.join('. ') + `. Ultimi ${it(p.giorni)} giorni.` : '';
			if ($('con-fonti').textContent !== ft) $('con-fonti').textContent = ft;
		}

		function filoHtml(f) {
			const da = f.da || f.indirizzo || 'mittente sconosciuto';
			return `<li class="con-filo${f.nonLetto ? ' con-nonletto' : ''}">
				<span class="con-punto" aria-hidden="true"></span>
				<span class="con-filo-testo"><span class="con-oggetto">${esc(f.oggetto || '(senza oggetto)')}</span>
				<span class="con-da">${esc(da)}${f.anteprima ? `, ${esc(f.anteprima)}` : ''}</span></span>
				<span class="con-quando">${esc(quando(f.data))}${f.nonLetto ? '<span class="sr">, non letto</span>' : ''}</span>
				<button type="button" class="ghost con-apri" data-k="apri" data-id="${esc(f.id)}" data-fk="k:apri:${esc(f.id)}" aria-label="Apri ${esc(f.oggetto || 'il filo')} in ${f.fonte === 'gmail' ? 'Gmail' : 'Mail'}">${f.fonte === 'gmail' ? 'Gmail' : 'Mail'}</button>
			</li>`;
		}

		const FONTE_WA = { business: 'WhatsApp business', personale: 'WhatsApp personale' };

		function chatHtml(c) {
			const attesa = !c.mio || c.nonLetto;
			const apri = c.telefono && !c.gruppo
				? `<button type="button" class="ghost con-apri" data-k="wa-apri" data-id="${esc(c.id)}" data-fk="k:wa-apri:${esc(c.id)}" aria-label="Apri la chat con ${esc(c.contatto)} in WhatsApp">WhatsApp</button>`
				: '<span></span>';
			const ultimo = c.ultimo ? `, ${c.mio ? 'tu: ' : ''}${esc(c.ultimo)}` : '';
			return `<li class="con-filo con-chat${attesa ? ' con-attesa' : ''}">
				<span class="con-punto" aria-hidden="true"></span>
				<span class="con-filo-testo"><span class="con-oggetto">${esc(c.contatto || c.telefono || 'contatto')}${c.gruppo ? ' <span class="con-ind">gruppo</span>' : ''}</span>
				<span class="con-da">${esc(FONTE_WA[c.fonte] || 'WhatsApp')}${ultimo}</span></span>
				<span class="con-quando">${esc(quando(c.data))}${attesa ? '<span class="sr">, ha scritto per ultimo</span>' : ''}</span>
				${apri}
			</li>`;
		}

		function renderProgetti() {
			const list = (posta && posta.progetti) || [];
			const vuoto = $('con-progetti-vuoto');
			vuoto.hidden = !!list.length;
			if (!list.length) vuoto.textContent = 'Nessun progetto in rubrica. Aggiungine uno qui sotto, o conferma un suggerimento.';
			put(
				$('con-progetti'),
				list
					.map(p => {
						const voci = [...p.voce.indirizzi, ...p.voce.domini, ...(p.voce.telefoni || []), ...(p.voce.gruppi || [])];
						const chips = voci
							.map(v => `<li class="con-chip"><span>${esc(v)}</span><button type="button" class="con-togli" data-k="togli" data-path="${esc(p.path)}" data-v="${esc(v)}" data-fk="k:togli:${esc(p.path)}:${esc(v)}" aria-label="Togli ${esc(v)} da ${esc(p.name)}">×</button></li>`)
							.join('');
						const fili = p.fili.slice(0, 8).map(filoHtml).join('');
						const altri = p.fili.length > 8 ? `<p class="con-nota">e altri ${it(p.fili.length - 8)}</p>` : '';
						const chatL = p.chat || [];
						const chat = chatL.slice(0, 6).map(chatHtml).join('');
						const altreChat = chatL.length > 6 ? `<p class="con-nota">e altre ${it(chatL.length - 6)} chat</p>` : '';
						const conta = p.nonLetti ? `<span class="con-conta">${it(p.nonLetti)} da leggere</span>` : p.fili.length ? `<span class="con-conta con-letti">${it(p.fili.length)} letti</span>` : '';
						const contaChat = p.chatDaRispondere ? `<span class="con-conta">${it(p.chatDaRispondere)} ${p.chatDaRispondere === 1 ? 'chat ti ha' : 'chat ti hanno'} scritto</span>` : '';
						const vuoto = !fili && !chat ? `<p class="con-nota">Nessun filo negli ultimi ${it(posta.giorni)} giorni.</p>` : '';
						return `<li class="con-progetto">
							<div class="con-p-testa"><h3>${esc(p.name)}</h3><span class="con-conte">${conta}${contaChat}</span></div>
							<ul class="con-chips" aria-label="Rubrica di ${esc(p.name)}">${chips}</ul>
							${fili ? `<ul class="con-fili">${fili}</ul>${altri}` : ''}
							${chat ? `<ul class="con-fili con-chats" aria-label="Chat WhatsApp di ${esc(p.name)}">${chat}</ul>${altreChat}` : ''}
							${vuoto}
						</li>`;
					})
					.join(''),
			);
			// la tendina del nuovo progetto
			const sel = $('con-nuovo-progetto');
			const opts = `<option value="">Scegli un progetto</option>` + progetti.map(p => `<option value="${esc(p.path)}"${p.path === ui.nuovo.path ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
			put(sel, opts);
			sel.value = ui.nuovo.path;
		}

		function renderSuggerimenti() {
			const list = (posta && posta.suggerimenti) || [];
			$('con-sugg-box').hidden = !list.length;
			put(
				$('con-sugg'),
				list
					.slice(0, 12)
					.map(
						s => `<li><span class="con-s-nome">${esc(s.name)}</span><span class="con-s-domini">${s.domini
							.map(d => `<button type="button" class="act con-s-dom" data-k="aggiungi" data-path="${esc(s.path)}" data-v="${esc(d)}" data-fk="k:sugg:${esc(s.path)}:${esc(d)}" aria-label="Aggiungi ${esc(d)} a ${esc(s.name)}">${esc(d)}</button>`)
							.join('')}</span></li>`,
					)
					.join(''),
			);
		}

		/** Il progetto scelto per una riga di "Da assegnare": la scelta dell'utente, o la proposta se non ha scelto. */
		const sceltaDi = (chiave, proposta) => (Object.prototype.hasOwnProperty.call(ui.scelte, chiave) ? ui.scelte[chiave] : proposta ? proposta.path : '');

		function propostaHtml(chiave, pr, voce) {
			if (!pr) return '';
			return `<span class="con-proposta">Forse è di ${esc(pr.name)}: ${esc(pr.motivo)}.
				<button type="button" class="act con-s-dom" data-k="proponi" data-path="${esc(pr.path)}" data-v="${esc(voce)}" data-fk="k:proponi:${esc(chiave)}" aria-label="Aggiungi ${esc(voce)} a ${esc(pr.name)}">Assegna a ${esc(pr.name)}</button></span>`;
		}

		function renderLiberi() {
			const list = (posta && posta.daAssegnare) || [];
			const wa = (posta && posta.whatsapp && posta.whatsapp.daAssegnare) || [];
			const auto = (posta && posta.automatici) || 0;
			$('con-liberi-box').hidden = !list.length && !wa.length;
			const nota = `Mittenti e chat che non sono in rubrica. Scegli un progetto e aggiungi l'indirizzo, il dominio o il numero.${auto ? ` ${it(auto)} ${auto === 1 ? 'mittente automatico' : 'mittenti automatici'} (noreply, notifiche, newsletter) non ${auto === 1 ? 'è' : 'sono'} in elenco.` : ''}`;
			if ($('con-liberi-nota').textContent !== nota) $('con-liberi-nota').textContent = nota;
			const opts = sel => `<option value="">Progetto</option>` + progetti.map(p => `<option value="${esc(p.path)}"${p.path === sel ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
			const azioni = (chiave, nomeSr, scelto, pr, bottoni) => `<div class="con-l-azioni">
				<label class="sr" for="con-l-${esc(chiave)}">Progetto per ${esc(nomeSr)}</label>
				<select id="con-l-${esc(chiave)}" class="con-select" data-k-in="scelta" data-v="${esc(chiave)}" data-fk="k:scelta:${esc(chiave)}">${opts(scelto)}</select>
				${bottoni.map(b => `<button type="button" class="${b.cls}" data-k="assegna" data-v="${esc(b.voce)}" data-m="${esc(chiave)}" data-def="${esc(pr ? pr.path : '')}" data-fk="k:assegna:${esc(chiave)}:${esc(b.voce)}"${scelto ? '' : ' disabled'}>${esc(b.testo)}</button>`).join('')}
			</div>`;
			put(
				$('con-liberi'),
				list
					.map(m => {
						const pr = m.proposta;
						const scelto = sceltaDi(m.indirizzo, pr);
						const chi = m.nome ? `${esc(m.nome)} <span class="con-ind">${esc(m.indirizzo)}</span>` : `<span class="con-ind">${esc(m.indirizzo)}</span>`;
						const bottoni = [{ cls: 'act', voce: m.indirizzo, testo: "Aggiungi l'indirizzo" }];
						if (!m.generico) bottoni.push({ cls: 'ghost', voce: m.dominio, testo: `Tutto ${m.dominio}` });
						return `<li class="con-libero${pr ? ' con-proposto' : ''}">
							<div class="con-l-chi">${chi}<span class="con-nota">${it(m.n)} ${m.n === 1 ? 'filo' : 'fili'}${m.nonLetti ? `, ${it(m.nonLetti)} da leggere` : ''}, ultimo ${esc(quando(m.ultimo.data))}: ${esc(m.ultimo.oggetto || '(senza oggetto)')}</span>${propostaHtml(m.indirizzo, pr, pr && pr.voce)}</div>
							${azioni(m.indirizzo, m.indirizzo, scelto, pr, bottoni)}
						</li>`;
					})
					.join(''),
			);
			$('con-liberi-wa-titolo').hidden = !wa.length;
			put(
				$('con-liberi-wa'),
				wa
					.map(c => {
						const pr = c.proposta;
						const scelto = sceltaDi(c.id, pr);
						const voce = c.gruppo ? c.jid : c.telefono;
						const chi = `${esc(c.contatto || c.telefono)} <span class="con-ind">${esc(c.gruppo ? 'gruppo' : c.telefono)}</span>`;
						return `<li class="con-libero${pr ? ' con-proposto' : ''}">
							<div class="con-l-chi">${chi}<span class="con-nota">${esc(FONTE_WA[c.fonte] || 'WhatsApp')}, ${esc(quando(c.data))}${c.ultimo ? `: ${c.mio ? 'tu: ' : ''}${esc(c.ultimo)}` : ''}</span>${propostaHtml(c.id, pr, voce)}</div>
							${azioni(c.id, c.contatto || voce, scelto, pr, [{ cls: 'act', voce, testo: c.gruppo ? 'Aggiungi il gruppo' : 'Aggiungi il numero' }])}
						</li>`;
					})
					.join(''),
			);
		}

		// ---------- connettori ----------

		function connettoreHtml(c) {
			const caps = (c.capacita || []).map(id => ((con.capacita || []).find(x => x.id === id) || { nome: id }).nome).join(', ');
			return `<li class="con-c con-c-${esc(c.stato.replace(/\s+/g, '-'))}${c.avviso ? ' con-c-avviso' : ''}">
				<span class="con-c-luce" aria-hidden="true"></span>
				<span class="con-c-nome">${esc(c.nome)}</span>
				<span class="con-c-stato">${esc(STATO[c.stato] || c.stato)}</span>
				<span class="con-nota">${esc(TIPO[c.tipo] || c.tipo)}${c.ambito === 'progetto' ? `, solo in ${it((c.progetti || []).length)} ${(c.progetti || []).length === 1 ? 'progetto' : 'progetti'}` : ''}${caps ? `, accende ${esc(caps)}` : ''}${c.avviso ? `. ${esc(cap(c.avviso))}` : ''}</span>
			</li>`;
		}

		/** I plugin non collegati, uno per nome e stato: "gmail, non configurato, in 5 plugin (sales, design...)". */
		function pluginHtml(list) {
			const g = new Map();
			for (const c of list) {
				const k = `${c.pulito}|${c.stato}`;
				if (!g.has(k)) g.set(k, []);
				g.get(k).push(c);
			}
			return [...g.values()]
				.sort((a, b) => b.length - a.length || a[0].pulito.localeCompare(b[0].pulito))
				.map(l => {
					const plugin = l.map(c => (/^plugin:([^:]+):/.exec(c.nome) || [])[1]).filter(Boolean);
					return `<li class="con-c con-c-${esc(l[0].stato.replace(/\s+/g, '-'))}">
						<span class="con-c-luce" aria-hidden="true"></span>
						<span class="con-c-nome">${esc(l[0].pulito)}</span>
						<span class="con-c-stato">${esc(STATO[l[0].stato] || l[0].stato)}</span>
						<span class="con-nota">${l.length === 1 ? 'nel plugin' : `in ${it(l.length)} plugin:`} ${esc(plugin.join(', '))}</span>
					</li>`;
				})
				.join('');
		}

		function renderElenco() {
			if (!con) return;
			const nota = con.aggiornando ? 'Chiedo a Claude Code l\'elenco aggiornato, ci vuole qualche secondo.' : con.errore ? con.errore : `Elenco di Claude Code letto ${fa(con.aggiornatoAt)}.`;
			if ($('con-elenco-nota').textContent !== nota) $('con-elenco-nota').textContent = nota;
			const btn = root.querySelector('[data-k="elenco"]');
			btn.disabled = !!con.aggiornando;
			put(
				$('con-cap'),
				(con.capacita || [])
					.map(
						c => `<li class="con-k${c.accesa ? ' con-k-accesa' : ''}"><span class="con-k-nome">${esc(c.nome)}</span>
						<span class="con-k-stato">${c.accesa ? 'accesa' : 'spenta'}</span>
						<span class="con-nota">${c.accesa ? `${esc(c.cosa)}, da ${esc(c.fonti.join(', '))}` : esc(c.cosa)}</span></li>`,
					)
					.join(''),
			);
			// i plugin non collegati sono rumore (lo stesso gmail ripetuto in ogni plugin): raggruppati in fondo
			const plugin = (con.connettori || []).filter(c => c.tipo === 'plugin' && c.stato !== 'connesso');
			const tutti = (con.connettori || []).filter(c => !plugin.includes(c));
			$('con-plugin-box').hidden = !plugin.length;
			const tp = `Plugin di Claude Code non collegati: ${it(plugin.length)}`;
			if ($('con-plugin-titolo').textContent !== tp) $('con-plugin-titolo').textContent = tp;
			put($('con-plugin'), pluginHtml(plugin));
			const utili = tutti.filter(c => c.stato === 'connesso' || c.stato === 'errore' || (c.stato === 'sconosciuto' && c.ambito === 'utente') || (c.capacita.length && c.stato === 'da autenticare'));
			const altri = tutti.filter(c => !utili.includes(c));
			utili.sort((a, b) => b.capacita.length - a.capacita.length || a.nome.localeCompare(b.nome));
			put($('con-lista'), utili.map(connettoreHtml).join('') || '<li class="con-nota">Nessun connettore collegato.</li>');
			$('con-altri-box').hidden = !altri.length;
			const t = `Altri ${it(altri.length)}: da autenticare, non configurati o solo in alcuni progetti`;
			if ($('con-altri-titolo').textContent !== t) $('con-altri-titolo').textContent = t;
			put($('con-altri'), altri.map(connettoreHtml).join(''));
		}

		function render() {
			renderTesta();
			if (ui.scheda === 'posta') {
				renderComandi();
				renderProgetti();
				renderSuggerimenti();
				renderLiberi();
			} else renderElenco();
		}

		const salva = () => host && host.save && host.save({ scheda: ui.scheda });

		// ---------- eventi ----------

		root.addEventListener('click', e => {
			const b = /** @type {any} */ (e.target).closest('[data-k]');
			if (!b || b.disabled) return;
			const k = b.getAttribute('data-k');
			switch (k) {
				case 'scheda':
					ui.scheda = b.getAttribute('data-v') === 'connettori' ? 'connettori' : 'posta';
					salva();
					return render();
				case 'posta':
					esito('Leggo la posta sul Mac.');
					return post({ type: 'posta.refresh', fonte: 'locale' });
				case 'gmail':
					esito('Ho chiesto a Claude Code di cercare in Gmail. Ci vuole circa un minuto, intanto puoi fare altro.');
					return post({ type: 'posta.refresh', fonte: 'gmail' });
				case 'elenco':
					esito('Chiedo a Claude Code l\'elenco dei connettori.');
					return post({ type: 'connettori.refresh' });
				case 'apri':
					return post({ type: 'posta.apri', id: b.getAttribute('data-id') });
				case 'togli': {
					const p = b.getAttribute('data-path');
					const v = b.getAttribute('data-v');
					esito(`${v} tolto da ${nomeDi(p)}.`);
					return post({ type: 'rubrica.remove', path: p, voce: v });
				}
				case 'aggiungi': {
					const p = b.getAttribute('data-path');
					const v = b.getAttribute('data-v');
					esito(`${v} aggiunto a ${nomeDi(p)}.`);
					return post({ type: 'rubrica.add', path: p, voce: v });
				}
				case 'assegna': {
					const ind = b.getAttribute('data-m') || b.getAttribute('data-v');
					const p = Object.prototype.hasOwnProperty.call(ui.scelte, ind) ? ui.scelte[ind] : b.getAttribute('data-def');
					const v = b.getAttribute('data-v');
					if (!p) return;
					delete ui.scelte[ind];
					esito(`${v} ora è di ${nomeDi(p)}.`);
					return post({ type: 'rubrica.add', path: p, voce: v });
				}
				case 'proponi': {
					const p = b.getAttribute('data-path');
					const v = b.getAttribute('data-v');
					esito(`${v} ora è di ${nomeDi(p)}.`);
					return post({ type: 'rubrica.add', path: p, voce: v });
				}
				case 'whatsapp':
					esito('Leggo le chat WhatsApp sul Mac.');
					return post({ type: 'whatsapp.refresh' });
				case 'wa-apri':
					return post({ type: 'whatsapp.apri', id: b.getAttribute('data-id') });
			}
		});

		root.addEventListener('change', e => {
			const t = /** @type {any} */ (e.target);
			if (!t || !t.getAttribute) return;
			if (t.id === 'con-nuovo-progetto') {
				ui.nuovo.path = t.value;
				return;
			}
			if (t.getAttribute('data-k-in') === 'scelta') {
				const ind = t.getAttribute('data-v');
				// anche la scelta vuota si ricorda: vince sulla proposta
				ui.scelte[ind] = t.value;
				const li = t.closest('.con-libero');
				for (const x of li ? li.querySelectorAll('[data-k="assegna"]') : []) x.disabled = !t.value;
				lastHTML.delete($('con-liberi'));
				lastHTML.delete($('con-liberi-wa'));
			}
		});

		root.addEventListener('input', e => {
			const t = /** @type {any} */ (e.target);
			if (t && t.id === 'con-nuovo-voce') ui.nuovo.voce = t.value;
		});

		$('con-nuovo').addEventListener('submit', e => {
			e.preventDefault();
			const p = ui.nuovo.path || $('con-nuovo-progetto').value;
			const v = String($('con-nuovo-voce').value || '').trim();
			if (!p) {
				esito('Scegli prima il progetto.');
				return $('con-nuovo-progetto').focus();
			}
			if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && !/^@?([a-z0-9-]+\.)+[a-z]{2,}$/i.test(v)) {
				esito('Scrivi un indirizzo, per esempio anna@esempio.it, o un dominio, per esempio esempio.it.');
				return $('con-nuovo-voce').focus();
			}
			post({ type: 'rubrica.add', path: p, voce: v });
			esito(`${v} aggiunto a ${nomeDi(p)}.`);
			ui.nuovo.voce = '';
			$('con-nuovo-voce').value = '';
		});

		return {
			/** I progetti arrivano con lo stato della posta (tuttiProgetti); lo snapshot basta se qualcuno lo passa. */
			update(snapshot) {
				if (!snapshot || !Array.isArray(snapshot.projects) || (posta && posta.tuttiProgetti)) return;
				progetti = snapshot.projects.map(p => ({ path: p.path, name: p.name }));
			},
			message(m) {
				if (!m) return;
				if (m.type === 'connettori' && m.stato) {
					const prima = con && con.aggiornando;
					con = m.stato;
					if (prima && !con.aggiornando) esito(con.errore ? con.errore : 'Elenco dei connettori aggiornato.');
				} else if (m.type === 'posta' && m.stato) {
					const prima = posta && posta.aggiornando;
					const primaWa = posta && posta.whatsapp && posta.whatsapp.aggiornando;
					posta = m.stato;
					if (Array.isArray(posta.tuttiProgetti)) progetti = posta.tuttiProgetti;
					if (prima && !posta.aggiornando) esito(posta.errore ? posta.errore : 'Posta aggiornata.');
					const wa = posta.whatsapp;
					if (primaWa && wa && !wa.aggiornando) esito(wa.errore ? wa.errore : 'Chat WhatsApp aggiornate.');
				} else return;
				if (visible) render();
			},
			show() {
				visible = true;
				post({ type: 'connettori.request' });
				render();
			},
			hide() {
				visible = false;
			},
			pause() {},
			resume() {
				if (visible) render();
			},
		};
	}

	/** @type {any} */ (window).BottegaConnettori = { mount };
})();
