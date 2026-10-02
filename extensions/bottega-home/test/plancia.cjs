#!/usr/bin/env node
// Banco di prova della plancia (media/plancia.js) in jsdom. NON spedito (vedi .vscodeignore).
// Finge acquireVsCodeApi (registra i postMessage) e le stanze esterne (Cruscotto, Vedetta, Clienti),
// poi manda snapshot finti: progetti inventati, nessun dato vero, nessun nome di cliente.
// Verifica: otto schede e tasti, briefing, consigli, cifre, progetti fermi, semaforo e filtro
// Regole, dialogo Continua, coda della notte, «Dove l'ho gia' risolto?», niente lineette lunghe,
// fuoco conservato tra due snapshot, snapshot vecchi senza i campi nuovi.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const JS = fs.readFileSync(path.join(__dirname, '..', 'media', 'plancia.js'), 'utf8');
const NOW = Date.now();
const H = 3_600_000;
const DAY = 24 * H;
const HOME = '/Users/prova';
const P = name => `${HOME}/prototipi/${name}`;

// ---------- dati finti ----------

function proj(name, git = {}) {
	return {
		name,
		path: P(name),
		kinds: ['web'],
		git: { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: 0, lastCommitSubject: 'Prima prova', lastCommitAt: NOW - DAY, ...git },
		live: [],
		sessions: [{ title: 'Sistema il menu', mtime: NOW - 2 * H, cwd: P(name), sessionId: `s-${name}` }],
		touchedAt: NOW - 3 * H,
		hasClaudeMd: true,
		build: null,
	};
}

const today = (() => {
	const d = new Date();
	const p = x => String(x).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

/** Snapshot di una estensione vecchia: solo i campi della sezione 3. */
function oldSnapshot(extra = {}) {
	return {
		scannedAt: NOW,
		home: HOME,
		projects: [proj('Faro', { ahead: 2 }), proj('Gabbiano'), proj('Vela', { changes: 3 }), proj('Scoglio')],
		live: [],
		elsewhere: [],
		jobs: [],
		system: null,
		assistant: { enabled: false, conversing: false, state: 'idle', log: [], brain: 'nessuno' },
		...extra,
	};
}

const LIVE = [
	{ pid: 501, cwd: P('Vela'), status: 'idle', statusSince: NOW - 20 * 60_000, title: 'Rivedi il layout', sessionId: 'sess-vela' },
	{ pid: 502, cwd: P('Gabbiano'), status: 'busy', statusSince: NOW - H, title: 'Aggiorna le dipendenze', sessionId: 'sess-j1' },
	{ pid: 503, cwd: HOME, status: 'shell', statusSince: NOW - 5 * 60_000, title: '', sessionId: 'sess-home' },
];

/** Progetti con le sessioni vive attaccate e un worktree su Faro. */
function projectsLive() {
	const ps = oldSnapshot().projects;
	ps.find(p => p.name === 'Vela').live = [LIVE[0]];
	ps.find(p => p.name === 'Gabbiano').live = [LIVE[1]];
	ps.find(p => p.name === 'Faro').worktrees = [{ path: P('Faro-idee'), branch: 'idee', changes: 2, ahead: 1, upstream: null }];
	return ps;
}

/** Snapshot completo, con tutti i campi della sezione 4 e la lista unica dei lavori. */
function snapshot(extra = {}) {
	return oldSnapshot({
		projects: projectsLive(),
		live: LIVE.map(l => ({ ...l })),
		work: [
			{ key: 'job:j3', source: 'bottega', status: 'ti aspetta', project: 'Faro', path: P('Faro'), title: 'Controlla gli avvisi', since: NOW - 600_000, jobId: 'j3' },
			{ key: 'pid:501', source: 'altrove', status: 'ti aspetta', project: 'Vela', path: P('Vela'), title: 'Rivedi il layout', since: NOW - 20 * 60_000, sessionId: 'sess-vela', pid: 501 },
			{ key: 'job:j1', source: 'bottega', status: 'in corso', project: 'Gabbiano', path: P('Gabbiano'), title: 'Aggiorna le dipendenze', since: NOW - H, jobId: 'j1', sessionId: 'sess-j1', pid: 502 },
			{ key: 'pid:503', source: 'altrove', status: 'nel terminale', project: 'prova', path: HOME, title: '', since: NOW - 5 * 60_000, sessionId: 'sess-home', pid: 503 },
			{ key: 'job:j2', source: 'bottega', status: 'stanotte', project: 'Vela', path: P('Vela'), title: 'Riscrivi i test del login', since: NOW - 2 * H, jobId: 'j2', night: true },
		],
		workCounts: { inCorso: 1, tiAspetta: 2, nelTerminale: 1, inCoda: 0, stanotte: 1, vive: 3 },
		jobs: [
			{ id: 'j1', project: 'Gabbiano', path: P('Gabbiano'), task: 'Aggiorna le dipendenze', status: 'in corso', createdAt: NOW - H, startedAt: NOW - H, sessionId: 'sess-j1', pid: 502 },
			{ id: 'j2', project: 'Vela', path: P('Vela'), task: 'Riscrivi i test del login', status: 'stanotte', night: true, createdAt: NOW - 2 * H },
			{ id: 'j3', project: 'Faro', path: P('Faro'), task: 'Controlla gli avvisi', status: 'ti aspetta', createdAt: NOW - 3 * H, startedAt: NOW - 3 * H, lastActivity: NOW - 600_000 },
		],
		rules: {
			projects: {
				[P('Faro')]: {
					path: P('Faro'),
					livello: 'rosso',
					checkedAt: NOW - 600_000,
					hits: [
						{ id: 'rilascio', livello: 'rosso', frase: 'La versione in revisione ha il rilascio a mano.', rimedio: 'Mettila in rilascio automatico.', azione: { act: 'rule.fix', label: 'Metti in automatico', args: { rule: 'rilascio' } } },
						{ id: 'push', livello: 'giallo', frase: 'Due commit non spinti.', rimedio: 'Spingili.', azione: { act: 'push', label: 'Spingi' }, dettagli: ['a1b2c3d Prima prova', 'd4e5f6a Seconda prova'] },
					],
				},
				[P('Vela')]: { path: P('Vela'), livello: 'giallo', checkedAt: NOW, hits: [{ id: 'build', livello: 'giallo', frase: 'Un commit non alza la build.', rimedio: 'Alza la build.' }] },
				[P('Gabbiano')]: { path: P('Gabbiano'), livello: 'verde', checkedAt: NOW, hits: [] },
			},
			global: [],
			appAds: null,
			counts: { rosso: 1, giallo: 2, verde: 1 },
			checkedAt: NOW - 600_000,
			running: false,
		},
		radar: { apps: [], totals: { yesterday: 12.3, last7: 80.1, daily: [1, 2, 3, 4, 5, 6, 7], currency: 'USD' }, ascAt: NOW - H, admobAt: NOW - 2 * H, refreshing: false },
		briefing: {
			date: today,
			at: NOW - 2 * H,
			text: 'Buongiorno. Ieri hai lavorato tre ore, Faro ha una regola rossa.',
			points: [
				{ kind: 'ore', text: 'Ieri tre ore, quasi tutte su Gabbiano.' },
				{ kind: 'regole', text: 'Faro ha il rilascio a mano.', act: { act: 'view', label: 'Apri la Vedetta', args: { view: 'vedetta' } } },
			],
			heard: false,
		},
		forgotten: [
			{ path: P('Scoglio'), name: 'Scoglio', idleDays: 23, reasons: ['due commit non spinti', 'modifiche fuori da un commit'] },
		],
		night: {
			from: '01:00', to: '06:00', parallel: 1, queued: 1, running: 0, ac: true,
			why: 'Stanotte parte un lavoro alle 01:00, il Mac è attaccato alla corrente.',
			report: { date: today, jobs: [{ id: 'n1', project: 'Gabbiano', task: 'Pulisci i log', status: 'finito', summary: 'Tolti i log inutili.' }] },
		},
		advice: {
			at: NOW - H,
			engine: 'apple',
			items: [
				{ text: 'Spingi i due commit di Faro prima di sera.', act: { act: 'push', label: 'Spingi adesso', args: { path: P('Faro') } } },
				{ text: 'Scoglio è fermo da tre settimane.' },
				{ text: 'Oggi hai già due ore: una pausa non guasta.' },
			],
		},
		...extra,
	});
}

const STATS = { computedAt: NOW, today: { date: today, you: 125, claude: 200, tok: 1000, sessions: 3 }, week: { start: today, now: { you: 600, claude: 900, tok: 5000 } } };

// ---------- avvio della plancia in jsdom ----------

const windows = [];

function boot({ rooms = true, saved = null } = {}) {
	const errors = [];
	const vc = new VirtualConsole();
	vc.on('jsdomError', e => {
		if (!/Not implemented/.test(String(e && e.message))) errors.push(e);
	});
	vc.on('error', (...a) => errors.push(a.join(' ')));
	const dom = new JSDOM('<!doctype html><html lang="it"><head></head><body class="vscode-dark"><main id="app" aria-live="polite"></main></body></html>', {
		runScripts: 'outside-only',
		pretendToBeVisual: true,
		virtualConsole: vc,
		url: 'https://plancia.prova/',
	});
	const w = dom.window;
	windows.push(w);
	w.addEventListener('error', e => errors.push(e.error || e.message));
	const posted = [];
	let st = saved;
	w.acquireVsCodeApi = () => ({
		postMessage: m => posted.push(JSON.parse(JSON.stringify(m))),
		getState: () => st,
		setState: s => (st = s),
	});
	const calls = [];
	const hosts = {};
	if (rooms) {
		for (const name of ['BottegaCruscotto', 'BottegaVedetta', 'BottegaClienti', 'BottegaConnettori']) {
			w[name] = {
				mount(root, host) {
					hosts[name] = host;
					root.innerHTML = `<p class="finta">${name}</p>`;
					calls.push([name, 'mount']);
					const rec = m => (...args) => calls.push([name, m, ...args]);
					return { update: rec('update'), message: rec('message'), show: rec('show'), hide: rec('hide'), pause: rec('pause'), resume: rec('resume'), render: rec('render'), setStats: rec('setStats') };
				},
			};
		}
	}
	w.eval(JS);
	const d = w.document;
	const send = data => w.dispatchEvent(new w.MessageEvent('message', { data }));
	const key = (k, target = d.body, extra = {}) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
	const click = el => {
		assert.ok(el, 'elemento da cliccare mancante');
		el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
	};
	const $ = s => d.querySelector(s);
	const $$ = s => [...d.querySelectorAll(s)];
	const last = type => [...posted].reverse().find(m => m.type === type);
	const byText = (sel, text) => $$(sel).find(el => el.textContent.trim() === text);
	return { w, d, posted, send, key, click, $, $$, last, byText, calls, hosts, errors, state: () => st };
}

// ---------- mini corridore ----------

let passed = 0;
const failed = [];
function test(name, fn) {
	try {
		fn();
		passed++;
		console.log(`  ok  ${name}`);
	} catch (e) {
		failed.push(name);
		console.log(`  NO  ${name}\n      ${String(e && e.stack ? e.stack : e).split('\n').slice(0, 9).join('\n      ')}`);
	}
}

/** Testo visibile e attributi: niente U+2014 e U+2013. */
function noDashes(d) {
	const bad = /[\u2013\u2014]/;
	assert.ok(!bad.test(d.body.textContent), 'lineetta nel testo: ' + (d.body.textContent.match(/.{0,30}[\u2013\u2014].{0,30}/) || [''])[0]);
	for (const el of d.body.querySelectorAll('*')) {
		for (const a of el.getAttributeNames()) {
			if (a === 'data-msg') continue;
			assert.ok(!bad.test(el.getAttribute(a) || ''), `lineetta nell'attributo ${a}`);
		}
	}
}

console.log('plancia.js in jsdom');

// ---------- schede ----------

test('stanze su una riga: quelle che non ci stanno vanno in «Altro», la stanza in cui sei resta sempre', () => {
	const t = boot();
	// jsdom non misura: una riga da 450 px, schede da 100, «Altro» da 80
	Object.defineProperty(t.w.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.id === 'altro' ? 80 : this.getAttribute('role') === 'tab' ? 100 : 0; } });
	Object.defineProperty(t.w.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.id === 'stanze' ? 450 : 0; } });
	t.click(t.$('#tab-plancia'));
	const fuori = () => t.$$('.tabs button.fuori').map(b => b.dataset.view);
	assert.deepStrictEqual(fuori(), ['melissa', 'cruscotto', 'vedetta', 'clienti', 'connettori'], 'tre schede nella riga, le altre in «Altro»');
	assert.strictEqual(t.$('#altro').hidden, false);
	assert.match(t.$('#altro').title, /Melissa, Cruscotto, Vedetta, Clienti, Connettori/);
	// apre il pannello e sceglie Connettori: entra nella riga al posto dell'ultima
	t.click(t.$('#altro'));
	assert.strictEqual(t.$('#altro').getAttribute('aria-expanded'), 'true');
	const voci = t.$$('#altro-menu button').map(b => b.dataset.view);
	assert.deepStrictEqual(voci, ['melissa', 'cruscotto', 'vedetta', 'clienti', 'connettori']);
	t.click(t.$('#altro-menu button[data-view="connettori"]'));
	assert.strictEqual(t.$('#tab-connettori').getAttribute('aria-selected'), 'true');
	assert.ok(!fuori().includes('connettori'), 'la stanza in cui sei e\' sempre nella riga');
	assert.ok(fuori().includes('memoria'), 'ha preso il posto dell\'ultima');
	assert.strictEqual(t.$('#altro-menu').hidden, true, 'scelta una stanza il pannello si chiude');
	// un segnale in una stanza nascosta compare anche su «Altro»
	t.send({ type: 'snapshot', snapshot: snapshot() }); // Faro e' rosso nel semaforo: la Vedetta ha la brace
	t.click(t.$('#tab-connettori'));
	assert.strictEqual(t.$('#segnale-vedetta').hidden, false);
	assert.strictEqual(t.$('#segnale-altro').hidden, false);
	assert.ok(t.$('#segnale-altro').classList.contains('st-rosso'));
	// finestra larga: tutte nella riga, «Altro» sparisce
	Object.defineProperty(t.w.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.id === 'stanze' ? 2000 : 0; } });
	t.click(t.$('#tab-plancia'));
	assert.deepStrictEqual(fuori(), []);
	assert.strictEqual(t.$('#altro').hidden, true);
	noDashes(t.d);
	assert.deepStrictEqual(t.errors, []);
});

test('otto schede, nell\'ordine, con i tasti da 1 a 8', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	const tabs = t.$$('[role="tab"]');
	assert.deepStrictEqual(
		tabs.map(x => x.querySelector('span:not(.segnale)').textContent),
		['Plancia', 'Lavori', 'Memoria', 'Melissa', 'Cruscotto', 'Vedetta', 'Clienti', 'Connettori'],
	);
	assert.match(tabs[5].getAttribute('title'), /tasto 6/);
	const ids = ['plancia', 'lavori', 'memoria', 'melissa', 'cruscotto', 'vedetta', 'clienti', 'connettori'];
	ids.forEach((id, i) => {
		t.key(String(i + 1));
		assert.strictEqual(t.$('#tab-' + id).getAttribute('aria-selected'), 'true', `tasto ${i + 1}`);
		assert.strictEqual(t.$('#vista-' + id).hidden, false);
		assert.strictEqual(t.d.activeElement, t.$('#tab-' + id));
	});
	t.key('9'); // non esiste: resta su Connettori
	assert.strictEqual(t.$('#tab-connettori').getAttribute('aria-selected'), 'true');
	// frecce nella barra delle stanze
	t.key('ArrowRight', t.$('#tab-connettori'));
	assert.strictEqual(t.$('#tab-plancia').getAttribute('aria-selected'), 'true');
	t.key('End', t.$('#tab-plancia'));
	assert.strictEqual(t.$('#tab-connettori').getAttribute('aria-selected'), 'true');
	assert.deepStrictEqual(t.errors, []);
});

test('stanze esterne: montate, snapshot e messaggi instradati, show/hide/pause/resume', () => {
	const t = boot();
	assert.ok(t.calls.some(c => c[0] === 'BottegaVedetta' && c[1] === 'mount'));
	assert.ok(t.calls.some(c => c[0] === 'BottegaClienti' && c[1] === 'mount'));
	assert.strictEqual(typeof t.hosts.BottegaVedetta.post, 'function');
	assert.strictEqual(typeof t.hosts.BottegaClienti.focusProject, 'function');
	const s = snapshot();
	t.send({ type: 'snapshot', snapshot: s });
	assert.ok(t.calls.some(c => c[0] === 'BottegaVedetta' && c[1] === 'update' && c[2].rules));
	assert.ok(t.calls.some(c => c[0] === 'BottegaClienti' && c[1] === 'update'));
	t.send({ type: 'clients', report: { month: '2026-10' } });
	t.send({ type: 'clients.exported', path: '/tmp/prova.csv' });
	const cm = t.calls.filter(c => c[0] === 'BottegaClienti' && c[1] === 'message').map(c => c[2].type);
	assert.deepStrictEqual(cm, ['clients', 'clients.exported']);
	// connettori e posta vanno alla stanza Connettori
	assert.ok(t.calls.some(c => c[0] === 'BottegaConnettori' && c[1] === 'mount'));
	t.send({ type: 'connettori', stato: { connettori: [] } });
	t.send({ type: 'posta', stato: { progetti: [] } });
	const km = t.calls.filter(c => c[0] === 'BottegaConnettori' && c[1] === 'message').map(c => c[2].type);
	assert.deepStrictEqual(km, ['connettori', 'posta']);
	t.send({ type: 'view', view: 'vedetta' });
	assert.strictEqual(t.$('#tab-vedetta').getAttribute('aria-selected'), 'true');
	assert.ok(t.calls.some(c => c[0] === 'BottegaVedetta' && c[1] === 'show'));
	t.send({ type: 'view', view: 'clienti' });
	assert.ok(t.calls.some(c => c[0] === 'BottegaVedetta' && c[1] === 'hide'));
	assert.ok(t.calls.some(c => c[0] === 'BottegaClienti' && c[1] === 'show'));
	Object.defineProperty(t.d, 'visibilityState', { value: 'hidden', configurable: true });
	t.d.dispatchEvent(new t.w.Event('visibilitychange'));
	assert.ok(t.calls.some(c => c[0] === 'BottegaClienti' && c[1] === 'pause'));
	Object.defineProperty(t.d, 'visibilityState', { value: 'visible', configurable: true });
	t.d.dispatchEvent(new t.w.Event('visibilitychange'));
	assert.ok(t.calls.some(c => c[0] === 'BottegaVedetta' && c[1] === 'resume'));
	// il messaggio stats arriva al cruscotto come prima
	t.send({ type: 'stats', stats: STATS });
	assert.ok(t.calls.some(c => c[0] === 'BottegaCruscotto' && c[1] === 'setStats' && c[2] === STATS));
	assert.deepStrictEqual(t.errors, []);
});

test('senza gli script delle stanze: una frase sobria, nessun errore', () => {
	const t = boot({ rooms: false });
	t.send({ type: 'snapshot', snapshot: snapshot() });
	t.key('6');
	assert.match(t.$('#vista-vedetta').textContent, /non è disponibile/);
	t.key('7');
	assert.match(t.$('#vista-clienti').textContent, /non è disponibile/);
	t.send({ type: 'clients', report: {} });
	t.send({ type: 'stats', stats: STATS });
	assert.deepStrictEqual(t.errors, []);
});

test('segnale sulla Vedetta solo con regole rosse, con testo per i lettori di schermo', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	const sv = t.$('#segnale-vedetta');
	assert.strictEqual(sv.hidden, false);
	assert.ok(sv.classList.contains('st-rosso'));
	assert.match(sv.querySelector('.sr').textContent, /una regola rossa/);
	const s = snapshot();
	s.rules.counts.rosso = 0;
	t.send({ type: 'snapshot', snapshot: s });
	assert.strictEqual(sv.hidden, true);
});

// ---------- Home ----------

test('briefing del mattino: testo, punti, azioni, Ascolta e Fatto', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	const b = t.$('#briefing');
	assert.strictEqual(b.hidden, false);
	assert.strictEqual(t.$('#briefing-titolo').textContent, 'Il briefing di oggi');
	assert.match(b.querySelector('.alba-testo').textContent, /Faro ha una regola rossa/);
	assert.strictEqual(b.querySelectorAll('.punto').length, 2);
	assert.deepStrictEqual(b.querySelectorAll('.punto-tipo')[1].textContent, 'Regole');
	t.click(t.byText('#briefing button', 'Apri la Vedetta'));
	assert.deepStrictEqual(t.posted.at(-1), { view: 'vedetta', type: 'view' });
	t.click(t.byText('#briefing button', 'Ascolta'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'briefing.listen' });
	t.click(t.byText('#briefing button', 'Fatto'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'briefing.dismiss' });
	// i consigli stanno accanto al briefing aperto
	assert.ok(t.$('#mattino').classList.contains('affiancati'));
});

test('briefing gia\' ascoltato: una riga richiudibile con «Rifallo»', () => {
	const t = boot();
	const s = snapshot();
	s.briefing.heard = true;
	t.send({ type: 'snapshot', snapshot: s });
	const b = t.$('#briefing');
	assert.ok(b.classList.contains('chiusa'));
	assert.strictEqual(t.$('#briefing-corpo').hidden, true);
	assert.ok(!t.byText('#briefing button', 'Fatto'));
	const toggle = t.$('[data-act="brief-toggle"]');
	assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
	t.click(toggle);
	assert.strictEqual(t.$('#briefing-corpo').hidden, false);
	assert.strictEqual(t.$('[data-act="brief-toggle"]').getAttribute('aria-expanded'), 'true');
	t.click(t.byText('#briefing button', 'Rifallo'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'briefing.make' });
	assert.ok(!t.$('#mattino').classList.contains('affiancati'));
});

test('briefing assente con estensione nuova: invito a prepararlo', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot({ briefing: null }) });
	t.click(t.byText('#briefing button', 'Preparalo adesso'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'briefing.make' });
});

test('consigli: frasi, origine dichiarata, età, azione e «Rifalli»', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	const c = t.$('#consigli');
	assert.strictEqual(c.querySelectorAll('.consigli-lista li').length, 3);
	assert.match(c.querySelector('.origine').textContent, /^Scelti da Apple Intelligence, sul Mac, 1 h fa/);
	assert.ok(!/nuvola|cloud/i.test(c.textContent));
	t.click(t.byText('#consigli button', 'Spingi adesso'));
	assert.deepStrictEqual(t.posted.at(-1), { path: P('Faro'), type: 'push' });
	t.click(t.byText('#consigli button', 'Rifalli'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'advice.refresh' });
	const s = snapshot();
	s.advice.engine = 'regole';
	t.send({ type: 'snapshot', snapshot: s });
	assert.match(c.querySelector('.origine').textContent, /^Dalle regole/);
});

test('quadro in cifre: chiede le ore, legge stats, soldi, regole, lavori, tutto cliccabile', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	assert.ok(t.last('stats.request'), 'la Home chiede le ore');
	const n = t.posted.filter(m => m.type === 'stats.request').length;
	t.send({ type: 'snapshot', snapshot: snapshot() });
	assert.strictEqual(t.posted.filter(m => m.type === 'stats.request').length, n, 'non le richiede a ogni snapshot');
	t.send({ type: 'stats', stats: STATS });
	const cells = t.$$('.quadro-cifre li');
	const txt = cells.map(c => [...c.querySelector('button').children].map(x => x.textContent.trim()).join(' '));
	assert.match(txt[0], /^Oggi 2 h 5 min questa settimana 10 h$/);
	assert.match(txt[1], /^Ieri 12,3.*7 giorni 80,1.*dato di 2 h fa$/);
	assert.match(txt[2], /^Regole 1 rossa, 2 gialle da sistemare subito$/);
	assert.ok(cells[2].classList.contains('rosso'));
	assert.match(txt[3], /^Lavori 1 in corso 2 ti aspettano, 1 nel terminale, 1 stanotte$/);
	t.click(cells[2].querySelector('button'));
	assert.strictEqual(t.$('#tab-vedetta').getAttribute('aria-selected'), 'true');
	assert.strictEqual(t.d.activeElement, t.$('#tab-vedetta'));
	t.key('1');
	t.click(t.$$('.quadro-cifre li')[3].querySelector('button'));
	assert.strictEqual(t.$('#tab-lavori').getAttribute('aria-selected'), 'true');
	t.key('1');
	t.click(t.$$('.quadro-cifre li')[0].querySelector('button'));
	assert.strictEqual(t.$('#tab-cruscotto').getAttribute('aria-selected'), 'true');
});

test('progetti fermi: nome, giorni, perché; clic apre il progetto; nascosti se vuoti', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	const f = t.$('#fermi');
	assert.strictEqual(f.hidden, false);
	const b = f.querySelector('.fermo');
	assert.match(b.textContent.replace(/\s+/g, ' '), /Scoglio fermo da 23 giorni due commit non spinti, modifiche fuori da un commit/);
	t.click(b);
	const row = t.$$('#righe .row').find(r => r.getAttribute('data-row') === P('Scoglio'));
	assert.strictEqual(row.querySelector('button').getAttribute('aria-expanded'), 'true');
	assert.strictEqual(row.querySelector('.detail').hidden, false);
	t.send({ type: 'snapshot', snapshot: snapshot({ forgotten: [] }) });
	assert.strictEqual(f.hidden, true);
});

test('semaforo accanto al segno, violazioni nel dettaglio, filtro Regole', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	const row = name => t.$$('#righe .row').find(r => r.getAttribute('data-row') === P(name));
	const faro = row('Faro');
	assert.ok(faro.querySelector('.mark'), 'il segno di prima resta');
	const sem = faro.querySelector('.semaforo.rosso');
	assert.ok(sem);
	assert.strictEqual(sem.getAttribute('aria-label'), 'Regole da sistemare: una rossa e una gialla');
	assert.ok(row('Vela').querySelector('.semaforo.giallo'));
	assert.ok(!row('Gabbiano').querySelector('.semaforo'), 'verde: niente semaforo');
	// dettaglio
	t.click(faro.querySelector('button[data-act="toggle"]'));
	const hits = row('Faro').querySelectorAll('.hit');
	assert.strictEqual(hits.length, 2);
	assert.ok(hits[0].classList.contains('l-rosso'));
	assert.match(hits[0].textContent, /rilascio a mano[\s\S]*rilascio automatico/);
	assert.strictEqual(hits[1].querySelectorAll('.hit-dettagli li').length, 2);
	t.click(t.byText('#righe button', 'Metti in automatico'));
	assert.deepStrictEqual(t.posted.at(-1), { path: P('Faro'), rule: 'rilascio', type: 'rule.fix' });
	// filtro
	const fb = t.$('[data-filter="regole"]');
	assert.match(fb.textContent, /Regole2/);
	t.click(fb);
	assert.deepStrictEqual(t.$$('#righe .row').map(r => r.getAttribute('data-row')), [P('Faro'), P('Vela')]);
	// rimbalzo dall'estensione: {type:'filter'}
	t.click(t.$('[data-filter="tutti"]'));
	t.key('2');
	t.send({ type: 'filter', filter: 'push' });
	assert.strictEqual(t.$('#tab-plancia').getAttribute('aria-selected'), 'true');
	assert.strictEqual(t.$('[data-filter="push"]').getAttribute('aria-pressed'), 'true');
	assert.deepStrictEqual(t.$$('#righe .row').map(r => r.getAttribute('data-row')), [P('Faro')]);
});

test('Continua da dove eri: richiesta, dialogo, modifica, Avvia con night, fuoco che torna', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	const row = () => t.$$('#righe .row').find(r => r.getAttribute('data-row') === P('Gabbiano'));
	t.click(row().querySelector('button[data-act="toggle"]'));
	const btn = row().querySelector('[data-act="continua"]');
	assert.strictEqual(btn.textContent, 'Continua da dove eri');
	btn.focus();
	t.click(btn);
	assert.deepStrictEqual(t.posted.at(-1), { type: 'continua.prepare', path: P('Gabbiano') });
	assert.strictEqual(row().querySelector('[data-act="continua"]').textContent, 'Preparo il prompt');
	t.send({ type: 'continua', path: P('Gabbiano'), prompt: 'Riprendi da qui: il menu va sistemato.', sources: ["dall'ultimo riassunto della memoria, 2 ore fa", 'da 3 commit'] });
	const velo = t.$('#continua-velo');
	assert.strictEqual(velo.hidden, false);
	assert.strictEqual(t.$('#continua').getAttribute('role'), 'dialog');
	assert.strictEqual(t.$('#continua').getAttribute('aria-modal'), 'true');
	assert.match(t.$('#continua-titolo').textContent, /Gabbiano/);
	assert.strictEqual(t.$('#continua-fonti').textContent, "Dall'ultimo riassunto della memoria, 2 ore fa; da 3 commit.");
	const ta = t.$('#continua-testo');
	assert.strictEqual(t.d.activeElement, ta);
	assert.strictEqual(ta.value, 'Riprendi da qui: il menu va sistemato.');
	ta.value = 'Riprendi da qui: il menu va sistemato, e anche il piè di pagina.';
	// Tab gira dentro il dialogo
	t.$('#continua-annulla').focus();
	t.key('Tab', t.$('#continua-annulla'));
	assert.strictEqual(t.d.activeElement, ta, 'Tab dall\'ultimo torna al primo');
	t.key('Tab', ta, { shiftKey: true });
	assert.strictEqual(t.d.activeElement, t.$('#continua-annulla'));
	// i tasti numerici non cambiano stanza mentre il dialogo e' aperto
	t.key('2', t.$('#continua-annulla'));
	assert.strictEqual(t.$('#tab-plancia').getAttribute('aria-selected'), 'true');
	t.$('#continua-notte').checked = true;
	t.click(t.$('#continua-avvia'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'job.new', path: P('Gabbiano'), task: 'Riprendi da qui: il menu va sistemato, e anche il piè di pagina.', night: true });
	assert.strictEqual(velo.hidden, true);
	assert.strictEqual(t.d.activeElement.getAttribute('data-fk'), `continua:${P('Gabbiano')}`);
	assert.strictEqual(row().querySelector('[data-act="continua"]').textContent, 'Continua da dove eri');
});

test('Continua chiesto da Melissa: apre la Plancia sul progetto e il dialogo; Esc chiude', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	t.key('3');
	t.send({ type: 'continua', path: P('Vela'), prompt: 'Continua i test.', sources: [] });
	assert.strictEqual(t.$('#tab-plancia').getAttribute('aria-selected'), 'true');
	const row = t.$$('#righe .row').find(r => r.getAttribute('data-row') === P('Vela'));
	assert.strictEqual(row.querySelector('.detail').hidden, false);
	assert.strictEqual(t.$('#continua-velo').hidden, false);
	assert.strictEqual(t.$('#continua-fonti').textContent, 'Prompt preparato dalla Bottega.');
	t.key('Escape', t.$('#continua-testo'));
	assert.strictEqual(t.$('#continua-velo').hidden, true);
	assert.strictEqual(t.d.activeElement.getAttribute('data-fk'), `continua:${P('Vela')}`);
	// senza notte nello snapshot la casella non si vede e Avvia non manda night
	const t2 = boot();
	t2.send({ type: 'snapshot', snapshot: oldSnapshot() });
	t2.send({ type: 'continua', path: P('Faro'), prompt: 'Vai.', sources: [] });
	assert.strictEqual(t2.$('#continua-notte').parentElement.hidden, true);
	t2.click(t2.$('#continua-avvia'));
	assert.deepStrictEqual(t2.posted.at(-1), { type: 'job.new', path: P('Faro'), task: 'Vai.' });
});

test('messaggio composer: Lavori con progetto, compito e casella notte gia\' scritti', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	t.send({ type: 'composer', path: P('Faro'), task: 'Alza la build e fai commit', night: true });
	assert.strictEqual(t.$('#tab-lavori').getAttribute('aria-selected'), 'true');
	assert.strictEqual(t.$('#scegli-progetto').value, 'Faro');
	assert.strictEqual(t.$('#composer-dove').textContent, '~/prototipi/Faro');
	assert.strictEqual(t.$('#compito').value, 'Alza la build e fai commit');
	assert.strictEqual(t.$('#composer-notte').checked, true);
	assert.strictEqual(t.$('#avvia').textContent, 'Metti in fila per stanotte');
	assert.strictEqual(t.d.activeElement, t.$('#compito'));
	t.$('#composer').dispatchEvent(new t.w.Event('submit', { cancelable: true }));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'job.new', path: P('Faro'), task: 'Alza la build e fai commit', night: true });
	// tolta la spunta, il lavoro parte di giorno
	t.$('#composer-notte').checked = false;
	t.$('#composer-notte').dispatchEvent(new t.w.Event('change', { bubbles: true }));
	assert.strictEqual(t.$('#avvia').textContent, 'Metti in coda', 'due lavori occupano gia\' i due posti');
	t.$('#compito').value = 'Un altro';
	t.$('#composer').dispatchEvent(new t.w.Event('submit', { cancelable: true }));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'job.new', path: P('Faro'), task: 'Un altro' });
});

test('Lavori: gruppo Stanotte, perché, finestra modificabile, promemoria, resoconto', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	t.key('2');
	const g = t.$('#g-stanotte');
	assert.strictEqual(g.hidden, false);
	assert.strictEqual(t.$('#frase-lavori').textContent, 'Faro e Vela ti aspettano. Un lavoro in corso, uno nel terminale. Uno aspetta la notte.');
	assert.match(t.$('#notte-riga').textContent, /il Mac è attaccato alla corrente/);
	assert.match(t.$('#notte-riga').textContent, /Dalle 01:00 alle 06:00, un lavoro alla volta\./);
	assert.strictEqual(g.querySelector('.promemoria').textContent, 'Di notte i lavori non fanno push e non pubblicano niente: lo trovi scritto nel loro prompt.');
	const job = t.$('#l-stanotte .lavoro');
	assert.ok(job.classList.contains('s-stanotte'));
	assert.match(job.textContent, /in fila per stanotte da 2 h/);
	t.click(t.byText('#l-stanotte button', 'Parti adesso'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'notte.now', id: 'j2' });
	t.click(t.byText('#l-stanotte button', 'Togli'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'job.remove', id: 'j2' });
	assert.match(t.$('#notte-resoconto').textContent, /Tolti i log inutili/);
	// la finestra
	assert.strictEqual(t.$('#notte-form').hidden, true);
	t.click(t.byText('#notte-riga button', 'Cambia'));
	assert.strictEqual(t.$('#notte-form').hidden, false);
	assert.strictEqual(t.d.activeElement, t.$('#notte-da'));
	assert.strictEqual(t.$('#notte-da').value, '01:00');
	t.$('#notte-da').value = '00:30';
	t.$('#notte-a').value = '05:45';
	t.$('#notte-insieme').value = '2';
	t.send({ type: 'snapshot', snapshot: snapshot() }); // non deve cancellare quello che si sta scrivendo
	assert.strictEqual(t.$('#notte-da').value, '00:30');
	t.$('#notte-form').dispatchEvent(new t.w.Event('submit', { cancelable: true }));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'notte.config', from: '00:30', to: '05:45', parallel: 2 });
	assert.strictEqual(t.$('#notte-form').hidden, true);
	// casella nel compositore, solo con un'estensione che sa della notte
	assert.strictEqual(t.$('#composer-notte-riga').hidden, false);
	const t2 = boot();
	t2.send({ type: 'snapshot', snapshot: oldSnapshot() });
	t2.key('2');
	assert.strictEqual(t2.$('#composer-notte-riga').hidden, true);
	assert.strictEqual(t2.$('#g-stanotte').hidden, true);
});

test('«Dove l\'ho già risolto?»: due blocchi, risposte vecchie scartate, evidenziazione sicura, file.open', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	t.key('3');
	t.click(t.$('[data-memmode="ricerca"]'));
	assert.strictEqual(t.$('#ric-cerca').hidden, false);
	assert.strictEqual(t.$('#mem-cerca').hidden, true);
	assert.strictEqual(t.d.activeElement, t.$('#cerca-risolto'));
	const search = q => {
		t.$('#cerca-risolto').value = q;
		t.$('#cerca-risolto').dispatchEvent(new t.w.Event('input', { bubbles: true }));
		t.$('#ric-cerca').dispatchEvent(new t.w.Event('submit', { cancelable: true }));
	};
	search('token');
	assert.deepStrictEqual(t.posted.at(-1), { type: 'ricerca', query: 'token' });
	search('refresh token');
	assert.deepStrictEqual(t.posted.at(-1), { type: 'ricerca', query: 'refresh token' });
	// arriva tardi la risposta alla prima: si scarta
	t.send({ type: 'ricerca', query: 'token', memoria: [{ id: 9, project: 'Vecchio', title: 'Da scartare', createdAt: NOW, score: 0.9 }], codice: [], ms: 10 });
	assert.match(t.$('#frase-memoria').textContent, /Sto cercando «refresh token»/);
	assert.ok(!t.$('#ric-risultati').textContent.includes('Da scartare'));
	t.send({
		type: 'ricerca',
		query: 'refresh token',
		ms: 340,
		memoria: [
			{ id: 1, kind: 'riassunto', project: 'Faro', projectPath: P('Faro'), sessionId: 'abcdef1234567890', title: 'Il refresh token scadeva', text: 'Il refresh token scadeva dopo un\'ora.', createdAt: NOW - DAY, score: 0.83 },
			{ id: 2, kind: 'fatto', project: 'Vela', projectPath: P('Vela'), sessionId: 's2', title: 'Accesso', text: 'Accesso con token', createdAt: NOW - 2 * DAY, score: 0.31 },
		],
		codice: [
			{ project: 'Faro', projectPath: P('Faro') + '/', file: 'src/auth.ts', line: 42, text: '  if (token && a < b) refresh(token); // <script>alert(1)</script> &amp;' },
		],
	});
	const box = t.$('#ric-risultati');
	assert.deepStrictEqual([...box.querySelectorAll('.ric-blocco h2')].map(h => h.textContent), ['Nei ricordi', 'Nel codice']);
	assert.match(t.$('#frase-memoria').textContent, /Due ricordi e una riga di codice per «refresh token»\./);
	assert.match(box.textContent, /molto vicino/);
	assert.match(box.textContent, /lontano/);
	assert.ok(!/0[.,]83|0[.,]31/.test(box.textContent), 'niente punteggi grezzi');
	assert.match(box.textContent, /sessione abcdef12/);
	assert.match(box.textContent, /Cercato in 340 ms\./);
	// sicurezza: nessun tag del testo diventa HTML, il testo resta letterale
	assert.strictEqual(box.querySelectorAll('script').length, 0);
	const code = box.querySelector('.ric-codice code');
	assert.ok(code.textContent.includes('<script>alert(1)</script> &amp;'));
	assert.deepStrictEqual([...code.querySelectorAll('mark')].map(m => m.textContent), ['token', 'refresh', 'token']);
	assert.ok(code.innerHTML.includes('a &lt; b'));
	// clic su una riga di codice: file.open con percorso intero e riga
	t.click(box.querySelector('.ric-codice'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'file.open', path: P('Faro') + '/src/auth.ts', line: 42 });
	t.click(t.byText('#ric-risultati button', 'Riprendi la sessione'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'claude', path: P('Faro'), id: 'abcdef1234567890' });
	// una parola come "amp" non rompe le entita'
	search('amp');
	t.send({ type: 'ricerca', query: 'amp', memoria: [], codice: [{ project: 'Faro', projectPath: P('Faro'), file: 'a.js', line: 1, text: 'x & y amp "z"' }], ms: 5 });
	const c2 = t.$('#ric-risultati .ric-codice code');
	assert.strictEqual(c2.textContent, 'x & y amp "z"');
	assert.deepStrictEqual([...c2.querySelectorAll('mark')].map(m => m.textContent), ['amp']);
	// errore
	search('niente');
	t.send({ type: 'ricerca', query: 'niente', memoria: [], codice: [], ms: 1, error: 'La memoria non risponde.' });
	assert.match(t.$('#frase-memoria').textContent, /non è riuscita/);
	assert.match(box.textContent, /La memoria non risponde\./);
	// tornando alla linea del tempo riparte la ricerca dei ricordi
	t.click(t.$('[data-memmode="ricordi"]'));
	assert.strictEqual(t.$('#mem-risultati').hidden, false);
	assert.strictEqual(t.$('#ric-risultati').hidden, true);
	assert.strictEqual(t.state().mem.mode, 'ricordi');
	assert.deepStrictEqual(t.errors, []);
});

test('memoria.cerca e ricerca.avvia (link bottega:// e Spotlight)', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	t.send({ type: 'view', view: 'memoria' });
	t.send({ type: 'memoria.cerca', query: 'notifiche push' });
	assert.strictEqual(t.$('#cerca-memoria').value, 'notifiche push');
	assert.deepStrictEqual(t.posted.at(-1), { type: 'memoria.search', query: 'notifiche push' });
	assert.strictEqual(t.$('#mem-cerca').hidden, false);
	t.send({ type: 'ricerca.avvia', query: 'certificato scaduto' });
	assert.strictEqual(t.$('#ric-cerca').hidden, false);
	assert.strictEqual(t.$('#cerca-risolto').value, 'certificato scaduto');
	assert.deepStrictEqual(t.posted.at(-1), { type: 'ricerca', query: 'certificato scaduto' });
	assert.match(t.$('#frase-memoria').textContent, /Sto cercando «certificato scaduto»/);
	// anche se la vista non e' ancora Memoria
	t.key('1');
	t.send({ type: 'memoria.cerca', query: 'login' });
	assert.strictEqual(t.$('#tab-memoria').getAttribute('aria-selected'), 'true');
	assert.strictEqual(t.$('#mem-risultati').hidden, false);
});

// ---------- la lista unica dei lavori ----------

/** I numeri come li dice ogni vista: frase della Plancia, scheda, cifra della Home, frase e gruppi di Lavori. */
function numbers(t) {
	t.key('1');
	const plancia = t.$('#frase').textContent;
	const badge = t.$('#segnale-lavori').hidden ? 0 : parseInt(t.$('#segnale-lavori').textContent, 10);
	const cifra = t.$('[data-fk="cifra:lavori"]');
	const lamps = t.$$('#lampade > li').length;
	t.key('2');
	const lavori = t.$('#frase-lavori').textContent;
	const groups = { aspetta: t.$$('#l-aspetta > li').length, corso: t.$$('#l-corso > li').length, terminale: t.$$('#l-terminale > li').length, stanotte: t.$$('#l-stanotte > li').length };
	t.key('1');
	return { plancia, badge, cifra: cifra ? [...cifra.children].map(c => c.textContent.trim()).join(' ') : '', lamps, lavori, groups };
}

test('Lavori mostra anche le sessioni vive aperte altrove, con le loro azioni', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	t.key('2');
	const vela = t.$('#l-aspetta li.altrove');
	assert.ok(vela, 'la sessione di Vela aperta nel terminale e\' un lavoro che ti aspetta');
	assert.match(vela.textContent, /Vela/);
	assert.match(vela.querySelector('.provenienza').textContent, /fuori dalla Bottega/);
	assert.match(vela.textContent, /Rivedi il layout/);
	const btn = label => [...t.$('#l-aspetta li.altrove').querySelectorAll('button')].find(b => b.textContent === label);
	t.click(btn('Apri il progetto'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'open', path: P('Vela') });
	t.click(btn('Riprendi in una scheda'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'claude', path: P('Vela'), id: 'sess-vela' });
	btn('Cosa sta facendo').focus();
	t.click(btn('Cosa sta facendo'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'bacheca.sessione', sessionId: 'sess-vela' });
	assert.match(t.$('#l-aspetta li.altrove .sessione-bacheca').textContent, /Chiedo alla memoria/);
	assert.strictEqual(btn('Cosa sta facendo').getAttribute('aria-expanded'), 'true');
	assert.strictEqual(t.d.activeElement.textContent, 'Cosa sta facendo', 'il fuoco resta sul pulsante');
	t.send({ type: 'bacheca.sessione', sessionId: 'sess-vela', items: [{ at: NOW - 60_000, project: 'Vela', kind: 'edit', summary: 'Modifica il foglio di stile', file: P('Vela') + '/src/stile.css' }] });
	const box = t.$('#l-aspetta li.altrove .sessione-bacheca');
	assert.match(box.textContent, /Modifica il foglio di stile/);
	assert.match(box.textContent, /stile\.css/);
	t.click(btn('Cosa sta facendo'));
	assert.ok(!t.$('#l-aspetta li.altrove .sessione-bacheca'), 'si richiude');
	// risposta vuota
	const home = () => t.$('#l-terminale li.altrove');
	t.click([...home().querySelectorAll('button')].find(b => b.textContent === 'Cosa sta facendo'));
	t.send({ type: 'bacheca.sessione', sessionId: 'sess-home', items: [] });
	assert.match(home().textContent, /La memoria non ha ancora visto niente di questa sessione\./);
	// quelli della Bottega hanno le azioni di sempre
	const faro = t.$$('#l-aspetta li').find(li => !li.classList.contains('altrove'));
	assert.deepStrictEqual([...faro.querySelectorAll('button')].map(b => b.textContent), ['Rispondi', 'Ferma']);
	t.click(faro.querySelector('button'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'job.focus', id: 'j3' });
	assert.deepStrictEqual(t.errors, []);
});

test('stessi numeri ovunque: frase, scheda, cifra, lampade, Lavori (da workCounts)', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	t.send({ type: 'stats', stats: STATS });
	const x = numbers(t);
	assert.match(x.plancia, /^Faro e Vela ti aspettano\. Un Claude al lavoro, uno nel terminale\./);
	assert.strictEqual(x.badge, 2);
	assert.strictEqual(x.cifra, 'Lavori 1 in corso 2 ti aspettano, 1 nel terminale, 1 stanotte');
	assert.strictEqual(x.lamps, 3, 'le lampade sono quante workCounts.vive');
	assert.strictEqual(x.lavori, 'Faro e Vela ti aspettano. Un lavoro in corso, uno nel terminale. Uno aspetta la notte.');
	assert.deepStrictEqual(x.groups, { aspetta: 2, corso: 1, terminale: 1, stanotte: 1 });
	// la lampada di Vela e' accesa come un lavoro che ti aspetta
	const lv = t.$$('#lampade .lamp').find(b => b.textContent.includes('Vela'));
	assert.ok(lv.classList.contains('aspetta'));
	assert.match(lv.textContent, /ti aspetta da 20 min/);
	// i numeri vengono da workCounts anche se la lista dicesse altro
	const s = snapshot();
	s.workCounts = { inCorso: 4, tiAspetta: 0, nelTerminale: 0, inCoda: 2, stanotte: 0, vive: 3 };
	t.send({ type: 'snapshot', snapshot: s });
	const y = numbers(t);
	assert.match(y.plancia, /^Quattro Claude al lavoro\./);
	assert.strictEqual(y.badge, 0);
	assert.strictEqual(y.cifra, 'Lavori 4 in corso 2 in coda');
	assert.match(y.lavori, /^Nessuno ti aspetta\. Quattro lavori in corso, due in coda\./);
});

test('estensione vecchia: la lista si ricava da jobs e live, con gli stessi numeri', () => {
	const t = boot();
	const s = snapshot();
	delete s.work;
	delete s.workCounts;
	t.send({ type: 'snapshot', snapshot: s });
	t.send({ type: 'stats', stats: STATS });
	const x = numbers(t);
	assert.strictEqual(x.badge, 2);
	assert.strictEqual(x.cifra, 'Lavori 1 in corso 2 ti aspettano, 1 nel terminale, 1 stanotte');
	assert.deepStrictEqual(x.groups, { aspetta: 2, corso: 1, terminale: 1, stanotte: 1 });
	assert.strictEqual(x.lamps, 3);
	assert.match(x.plancia, /ti aspettano\. Un Claude al lavoro, uno nel terminale\./);
	t.key('2');
	assert.ok(t.$('#l-aspetta li.altrove'), 'Vela, viva e inattiva, ti aspetta anche senza work');
	assert.ok(!t.$$('#l-corso li').some(li => li.classList.contains('altrove')), 'la sessione del lavoro j1 non si conta due volte');
});

test('worktree dentro il loro progetto: «+ ramo idee» nella riga, una riga nel dettaglio con Apri', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	const faro = () => t.$$('#righe .row').find(r => r.getAttribute('data-row') === P('Faro'));
	assert.strictEqual(faro().querySelector('.rami').textContent, '+ ramo idee');
	assert.ok(!t.$$('#righe .row').some(r => r.getAttribute('data-row') === P('Faro-idee')), 'il worktree non e\' una riga a se\'');
	t.click(faro().querySelector('button[data-act="toggle"]'));
	const li = faro().querySelector('.worktree li');
	assert.match([...li.children].map(c => c.textContent.trim()).join(' '), /idee ~\/prototipi\/Faro-idee 2 modifiche, 1 commit da spingere, senza remoto Apri/);
	t.click(li.querySelector('button'));
	assert.deepStrictEqual(t.posted.at(-1), { type: 'open', path: P('Faro-idee') });
});

// ---------- robustezza ----------

test('snapshot vecchio, senza i campi nuovi: la plancia di prima, senza errori', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: oldSnapshot() });
	assert.strictEqual(t.$('#briefing').hidden, true);
	assert.strictEqual(t.$('#consigli').hidden, true);
	assert.strictEqual(t.$('#fermi').hidden, true);
	assert.strictEqual(t.$('#quadro').hidden, true);
	assert.strictEqual(t.$('#segnale-vedetta').hidden, true);
	assert.ok(!t.$('[data-filter="regole"]'));
	assert.ok(!t.$('.semaforo'));
	assert.strictEqual(t.$$('#righe .row').length, 4);
	for (const k of ['2', '3', '4', '5', '6', '7', '1']) t.key(k);
	assert.deepStrictEqual(t.errors, []);
});

test('nessuna lineetta lunga o media nel DOM, in nessuna stanza', () => {
	const t = boot();
	const s = snapshot();
	s.briefing.heard = false;
	t.send({ type: 'snapshot', snapshot: s });
	t.send({ type: 'stats', stats: STATS });
	for (const k of ['1', '2', '3', '4', '5', '6', '7', '8']) {
		t.key(k);
		noDashes(t.d);
	}
	t.key('1');
	for (const b of t.$$('#righe button[data-act="toggle"]')) t.click(b);
	t.send({ type: 'continua', path: P('Faro'), prompt: 'x', sources: ['dalla memoria'] });
	noDashes(t.d);
});

test('il fuoco resta dov\'era tra due snapshot', () => {
	const t = boot();
	t.send({ type: 'snapshot', snapshot: snapshot() });
	// su una riga di progetto
	const faro = () => t.$$('#righe .row').find(r => r.getAttribute('data-row') === P('Faro')).querySelector('button');
	faro().focus();
	const s2 = snapshot();
	s2.projects[1].touchedAt = NOW - 60_000; // cambia un altro progetto
	s2.projects[0].git.ahead = 3; // e anche quello col fuoco
	s2.rules.counts.giallo = 5;
	t.send({ type: 'snapshot', snapshot: s2 });
	assert.strictEqual(t.d.activeElement.getAttribute('data-fk'), `row:${P('Faro')}`);
	assert.ok(t.d.contains(t.d.activeElement));
	// su un pulsante del briefing, mentre cambiano i consigli
	t.byText('#briefing button', 'Ascolta').focus();
	const s3 = snapshot();
	s3.advice.items.push({ text: 'Un consiglio nuovo.' });
	t.send({ type: 'snapshot', snapshot: s3 });
	assert.strictEqual(t.d.activeElement.getAttribute('data-fk'), 'briefing.listen');
	// su una cifra del quadro, mentre cambiano i numeri
	t.$('[data-fk="cifra:regole"]').focus();
	const s4 = snapshot();
	s4.rules.counts.rosso = 2;
	t.send({ type: 'snapshot', snapshot: s4 });
	assert.strictEqual(t.d.activeElement.getAttribute('data-fk'), 'cifra:regole');
	// nel compositore con un testo a meta'
	t.key('2', t.d.body);
	t.$('#compito').focus();
	t.$('#compito').value = 'testo a metà';
	t.send({ type: 'snapshot', snapshot: snapshot() });
	assert.strictEqual(t.d.activeElement, t.$('#compito'));
	assert.strictEqual(t.$('#compito').value, 'testo a metà');
});

console.log(`\n${passed} superati, ${failed.length} falliti`);
for (const w of windows) w.close(); // i timer della plancia (30 s) terrebbero vivo il processo
if (failed.length) console.log('Falliti: ' + failed.join('; '));
process.exit(failed.length ? 1 : 0);
