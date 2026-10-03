#!/usr/bin/env node
// Banco di prova della barra di Melissa (media/barra.js) in jsdom, con uno stato finto: testata del
// cervello (opzioni spente con il motivo, prezzi, credito, impegno), sfera e stato in parole,
// conversazione (azioni come eventi), sessioni raggruppate con la bacheca, i messaggi mandati da
// ogni controllo, il fuoco e il testo che restano tra due stati, nessun DOM toccato da uno stato
// uguale, annunci solo quando un lavoro comincia ad aspettare, niente lavoro a vista nascosta,
// riduci movimento, niente lineette lunghe.
// Nessun dato vero: il repository e' pubblico. Progetti, sessioni e percorsi sono inventati.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const MEDIA = path.join(__dirname, '..', 'media');
const JS = fs.readFileSync(path.join(MEDIA, 'barra.js'), 'utf8');
const CSS = fs.readFileSync(path.join(MEDIA, 'barra.css'), 'utf8');

let passed = 0, failed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log('  ok  ' + name);
	} catch (e) {
		failed++;
		console.log('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n      ') : e));
	}
}
const pausa = ms => new Promise(r => setTimeout(r, ms));

// ---------- stato finto ----------

const ORA = Date.now();
const MIN = 60_000;

function brain(over = {}) {
	return {
		current: { provider: 'agnes', model: 'agnes-3.0-flash', label: 'Agnes 3.0 Flash' },
		effort: 'normale',
		options: [
			{ provider: 'agnes', model: 'agnes-3.0-flash', label: 'Agnes 3.0 Flash', note: 'gratis', available: true },
			{ provider: 'apple', model: 'foundation', label: 'Apple sul Mac', note: 'sul Mac', available: true },
			{ provider: 'deepseek', model: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', note: 'a consumo, a fondo V4 Pro', available: false, why: 'senza credito (402)' },
		],
		accounts: [
			{ id: 'agnes', label: 'Agnes', text: 'gratis, nessun saldo da controllare; 12 richieste oggi dalla Bottega', tone: 'ok', local: true },
			{ id: 'deepseek', label: 'DeepSeek', text: 'saldo -0,01 $: senza credito', tone: 'male' },
			{ id: 'elevenlabs', label: 'ElevenLabs', text: '801 caratteri di voce a ottobre, contati dalla Bottega', tone: 'ok', local: true },
		],
		checkedAt: ORA,
		...over,
	};
}

function assistant(over = {}) {
	return {
		enabled: true,
		conversing: false,
		state: 'idle',
		brain: 'agnes',
		log: [
			{ role: 'tu', text: 'Come va il faro?', at: ORA - 5 * MIN },
			{ role: 'melissa', text: 'Il faro regge. Tu un po\' meno.', at: ORA - 5 * MIN + 2000 },
			{ role: 'azione', text: 'Ho avviato un lavoro su faro-di-prova', at: ORA - 4 * MIN },
		],
		...over,
	};
}

function work() {
	return [
		{ key: 'job:j1', source: 'bottega', status: 'ti aspetta', project: 'faro-di-prova', path: '/prova/faro-di-prova', title: 'Ripara la mappa lenta', since: ORA - 12 * MIN, jobId: 'j1', sessionId: 's1' },
		{ key: 'sess:s2', source: 'altrove', status: 'in corso', project: 'orto-digitale', path: '/prova/orto-digitale', title: 'Pulisci i test', since: ORA - 40 * MIN, sessionId: 's2', pid: 11 },
		{ key: 'job:j3', source: 'bottega', status: 'in corso', project: 'quaderno', path: '/prova/quaderno', title: 'Scrivi le note', since: ORA - 3 * MIN, jobId: 'j3', sessionId: 's3', night: true },
		{ key: 'sess:s4', source: 'altrove', status: 'nel terminale', project: 'telaio', path: '/prova/telaio', title: '', since: ORA - 90 * MIN, sessionId: 's4' },
		{ key: 'job:j5', source: 'bottega', status: 'in coda', project: 'bussola', path: '/prova/bussola', title: 'Aggiorna la bussola', since: ORA - 2 * MIN, jobId: 'j5' },
		{ key: 'job:j6', source: 'bottega', status: 'stanotte', project: 'lanterna', path: '/prova/lanterna', title: 'Rifai le icone', since: ORA - 60 * MIN, jobId: 'j6', night: true },
	];
}
const counts = w => {
	const c = { inCorso: 0, tiAspetta: 0, nelTerminale: 0, inCoda: 0, stanotte: 0, vive: 0 };
	for (const x of w) {
		if (x.status === 'in corso') c.inCorso++;
		else if (x.status === 'ti aspetta') c.tiAspetta++;
		else if (x.status === 'nel terminale') c.nelTerminale++;
		else if (x.status === 'in coda') c.inCoda++;
		else if (x.status === 'stanotte') c.stanotte++;
		if (['in corso', 'ti aspetta', 'nel terminale'].includes(x.status)) c.vive++;
	}
	return c;
};
const board = () => ({
	s1: [
		{ at: ORA - 11 * MIN, kind: 'edit', summary: 'ha modificato src/mappa.ts', file: 'src/mappa.ts' },
		{ at: ORA - 10 * MIN, kind: 'bash', summary: 'ha lanciato npm test' },
	],
	s2: [{ at: ORA - 2 * MIN, kind: 'write', summary: 'ha scritto test/orto.cjs', file: 'test/orto.cjs' }],
});
const stato = (over = {}) => ({ type: 'stato', assistant: assistant(), brain: brain(), work: work(), workCounts: counts(work()), board: board(), ...over });

// ---------- una barra in jsdom ----------

function fakeCtx(rec) {
	const grad = { addColorStop() {} };
	return new Proxy(
		{},
		{
			get(_, k) {
				if (k === 'createRadialGradient') return () => grad;
				return (...a) => {
					rec.push(k);
					return undefined;
				};
			},
			set() {
				return true;
			},
		},
	);
}

function mount({ reduced = false, tema = 'vscode-dark', gpu = null } = {}) {
	const errors = [];
	const vc = new VirtualConsole();
	vc.on('jsdomError', e => {
		if (!/Not implemented/.test(String(e && e.message))) errors.push(e);
	});
	vc.on('error', (...a) => errors.push(a.join(' ')));
	const warns = [];
	vc.on('warn', (...a) => warns.push(a.join(' ')));
	const dom = new JSDOM(`<!doctype html><html lang="it"><head></head><body class="${tema}"><main id="barra"></main></body></html>`, {
		runScripts: 'outside-only',
		pretendToBeVisual: true,
		virtualConsole: vc,
		url: 'https://barra.prova/',
	});
	const w = dom.window;
	w.addEventListener('error', e => errors.push(e.error || e.message));
	const posted = [];
	let saved;
	w.acquireVsCodeApi = () => ({ postMessage: m => posted.push(JSON.parse(JSON.stringify(m))), getState: () => saved, setState: s => (saved = s) });
	// la sfera: un contesto 2D finto e fotogrammi contati, mai eseguiti da soli
	const draws = [];
	w.HTMLCanvasElement.prototype.getContext = function () {
		return fakeCtx(draws);
	};
	const frames = { asked: 0, cancelled: 0, pending: new Map(), next: 1 };
	w.requestAnimationFrame = cb => {
		frames.asked++;
		const id = frames.next++;
		frames.pending.set(id, cb);
		return id;
	};
	w.cancelAnimationFrame = id => {
		if (frames.pending.delete(id)) frames.cancelled++;
	};
	const runFrames = (n = 1, t0 = 1000) => {
		for (let i = 0; i < n; i++) {
			const all = [...frames.pending.entries()];
			frames.pending.clear();
			for (const [, cb] of all) cb(t0 + i * 40);
		}
	};
	// orologi contati
	const timers = new Set();
	const si = w.setInterval.bind(w), ci = w.clearInterval.bind(w);
	w.setInterval = (f, ms) => {
		const id = si(f, ms);
		timers.add(id);
		return id;
	};
	w.clearInterval = id => {
		timers.delete(id);
		ci(id);
	};
	w.matchMedia = q => ({ matches: reduced && /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
	let vis = 'visible';
	Object.defineProperty(w.document, 'visibilityState', { configurable: true, get: () => vis });
	if (gpu) w.BottegaSferaGPU = gpu;
	w.eval(JS);
	const d = w.document;
	const send = data => w.dispatchEvent(new w.MessageEvent('message', { data: JSON.parse(JSON.stringify(data)) }));
	const click = el => {
		assert.ok(el, 'elemento da cliccare mancante');
		el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
	};
	const key = (el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
	const type = (input, text) => {
		input.focus();
		input.value = text;
		input.dispatchEvent(new w.Event('input', { bubbles: true }));
	};
	const submit = form => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
	const $ = s => d.querySelector(s);
	const $$ = s => [...d.querySelectorAll(s)];
	const last = t => [...posted].reverse().find(m => m.type === t);
	const item = k => d.querySelector(`.lavoro[data-key="${k}"]`);
	const byText = (root, sel, text) => [...root.querySelectorAll(sel)].find(el => el.textContent.trim() === text);
	const setVisible = on => {
		vis = on ? 'visible' : 'hidden';
		d.dispatchEvent(new w.Event('visibilitychange'));
	};
	return { w, d, posted, send, click, key, type, submit, $, $$, last, item, byText, errors, warns, frames, runFrames, draws, timers, setVisible, state: () => saved };
}

const LINEETTE = /[\u2013\u2014]/;
function lineette(d) {
	const out = [];
	const walk = d.createTreeWalker(d.body, 4 /* SHOW_TEXT */);
	while (walk.nextNode()) if (LINEETTE.test(walk.currentNode.nodeValue)) out.push(walk.currentNode.nodeValue);
	for (const el of d.body.querySelectorAll('*')) for (const a of el.attributes) if (LINEETTE.test(a.value)) out.push(`${el.tagName}[${a.name}]=${a.value}`);
	return out;
}

(async () => {
	console.log('barra di Melissa');

	await test('parte da sola: scheletro, ready, testata nascosta finche\' non c\'e\' un cervello', () => {
		const b = mount();
		assert.ok(b.$('#barra .notte'));
		assert.ok(b.$('#sfera-tasto canvas'));
		assert.ok(b.$('#registro'));
		assert.ok(b.$('#chiedi input'));
		assert.ok(b.$('#sessioni'));
		assert.ok(b.$('nav.comandi'));
		assert.deepStrictEqual(b.posted[0], { type: 'ready' });
		assert.strictEqual(b.$('.testa').hidden, true);
		assert.strictEqual(b.$$('[style]').length, 0, 'nessun attributo style');
		assert.deepStrictEqual(b.errors, []);
	});

	await test('testata: cervello, nota, opzioni spente con il motivo, conti, impegno', () => {
		const b = mount();
		b.send(stato());
		assert.strictEqual(b.$('.testa').hidden, false);
		assert.strictEqual(b.$('#cervello-nome').textContent, 'Agnes 3.0 Flash');
		assert.strictEqual(b.$('#cervello-nota').textContent, 'gratis');
		const opts = b.$$('#cervelli [role=option]');
		assert.strictEqual(opts.length, 3);
		const ds = opts[2];
		assert.strictEqual(ds.getAttribute('aria-disabled'), 'true');
		assert.ok(ds.classList.contains('spenta'));
		assert.match(ds.textContent, /DeepSeek/);
		assert.match(ds.textContent, /senza credito \(402\)/);
		assert.strictEqual(opts[0].getAttribute('aria-selected'), 'true');
		assert.match(opts[1].textContent, /sul Mac/);
		assert.ok(!/openrouter|claude|gemini|gpt/i.test(b.$('#cervelli').textContent), 'niente piu\' OpenRouter');
		// i conti: riassunto del cervello in uso (o del conto peggiore), elenco completo a richiesta
		assert.strictEqual(b.$('#conti').hidden, false);
		assert.strictEqual(b.$('#conti-riassunto').textContent, 'DeepSeek: saldo -0,01 $: senza credito');
		assert.deepStrictEqual([...b.$$('#conti-lista li')].map(li => li.textContent), ['Agnesgratis, nessun saldo da controllare; 12 richieste oggi dalla Bottega', 'DeepSeeksaldo -0,01 $: senza credito', 'ElevenLabs801 caratteri di voce a ottobre, contati dalla Bottega']);
		assert.strictEqual(b.$('#impegno input[value=normale]').checked, true);
		assert.strictEqual(b.$('#impegno input[value=rapido]').checked, false);
	});

	await test('cervello: clic e tastiera mandano brain.set, le opzioni spente no', () => {
		const b = mount();
		b.send(stato());
		const tasto = b.$('#cervello');
		b.click(tasto);
		assert.strictEqual(tasto.getAttribute('aria-expanded'), 'true');
		assert.strictEqual(b.$('#cervelli').hidden, false);
		assert.strictEqual(b.d.activeElement, b.$('#cervelli'));
		// clic su DeepSeek: niente
		b.click(b.$$('#cervelli [role=option]')[2]);
		assert.strictEqual(b.last('brain.set'), undefined);
		assert.strictEqual(b.$('#cervelli').hidden, false, 'resta aperto sulla spenta');
		// tastiera: giu' fino a DeepSeek (spento), Invio non fa nulla; su di uno e Invio sceglie Apple
		const lb = b.$('#cervelli');
		b.key(lb, 'ArrowDown');
		b.key(lb, 'ArrowDown');
		assert.strictEqual(lb.getAttribute('aria-activedescendant'), 'cervello-2');
		b.key(lb, 'Enter');
		assert.strictEqual(b.last('brain.set'), undefined);
		b.key(lb, 'ArrowUp');
		b.key(lb, 'Enter');
		assert.deepStrictEqual(b.last('brain.set'), { type: 'brain.set', provider: 'apple', model: 'foundation' });
		assert.strictEqual(b.$('#cervelli').hidden, true);
		assert.strictEqual(b.d.activeElement, tasto, 'il fuoco torna al tasto');
		// clic su un'opzione disponibile
		b.click(tasto);
		b.click(b.$$('#cervelli [role=option]')[0]);
		assert.deepStrictEqual(b.last('brain.set'), { type: 'brain.set', provider: 'agnes', model: 'agnes-3.0-flash' });
		// Esc chiude senza scegliere
		const prima = b.posted.length;
		b.key(tasto, 'ArrowDown');
		assert.strictEqual(b.$('#cervelli').hidden, false);
		b.key(lb, 'Escape');
		assert.strictEqual(b.$('#cervelli').hidden, true);
		assert.strictEqual(b.posted.length, prima);
	});

	await test('impegno: cambiare posizione manda effort.set', () => {
		const b = mount();
		b.send(stato());
		const r = b.$('#impegno input[value=profondo]');
		r.checked = true;
		r.dispatchEvent(new b.w.Event('change', { bubbles: true }));
		assert.deepStrictEqual(b.last('effort.set'), { type: 'effort.set', effort: 'profondo' });
		b.send({ type: 'stato', brain: brain({ effort: 'rapido' }) });
		assert.strictEqual(b.$('#impegno input[value=rapido]').checked, true);
	});

	await test('sfera: stato in parole, frase parziale, clic manda converse, voce', () => {
		const b = mount();
		b.send(stato());
		assert.strictEqual(b.$('#stato').textContent, 'Tocca la sfera per parlare');
		b.send({ type: 'stato', assistant: assistant({ state: 'listening', partial: 'dimmi del fa' }) });
		assert.strictEqual(b.$('#stato').textContent, 'Ti ascolto');
		assert.strictEqual(b.$('#parziale').textContent, 'dimmi del fa');
		b.send({ type: 'stato', assistant: assistant({ state: 'thinking' }) });
		assert.strictEqual(b.$('#stato').textContent, 'Ci penso');
		assert.strictEqual(b.$('#parziale').textContent, '');
		b.send({ type: 'stato', assistant: assistant({ state: 'speaking', level: 0.4, conversing: true }) });
		assert.strictEqual(b.$('#stato').textContent, 'Parlo');
		assert.strictEqual(b.$('#sfera-tasto').getAttribute('aria-pressed'), 'true');
		assert.strictEqual(b.$('#sfera-etichetta').textContent, 'Chiudi la conversazione con Melissa');
		b.send({ type: 'stato', assistant: assistant({ state: 'error' }) });
		assert.strictEqual(b.$('#stato').textContent, 'Qualcosa non va');
		b.send({ type: 'stato', assistant: assistant({ enabled: false }) });
		assert.strictEqual(b.$('#stato').textContent, 'Melissa è spenta');
		assert.strictEqual(b.$('#voce').textContent, 'Accendi la voce');
		b.click(b.$('#voce'));
		assert.deepStrictEqual(b.last('voice.toggle'), { type: 'voice.toggle' });
		b.click(b.$('#sfera-tasto'));
		assert.deepStrictEqual(b.last('converse'), { type: 'converse' });
		// anche la forma della vista della sfera
		b.send({ type: 'assistant', state: assistant({ state: 'thinking' }) });
		assert.strictEqual(b.$('#stato').textContent, 'Ci penso');
	});

	await test('conversazione: ruoli, azioni come eventi, ask, campo vuoto non parte', () => {
		const b = mount();
		b.send(stato());
		const righe = b.$$('#registro > li');
		assert.strictEqual(righe.length, 3);
		assert.ok(righe[0].classList.contains('tu'));
		assert.ok(righe[1].classList.contains('melissa'));
		assert.ok(righe[2].classList.contains('azione'));
		assert.ok(righe[2].querySelector('time'), 'l\'azione ha la sua ora');
		assert.match(righe[2].textContent, /Azione di Melissa: .*Ho avviato un lavoro su faro-di-prova/);
		assert.strictEqual(b.$('#registro-vuoto').hidden, true);
		assert.strictEqual(b.$('#registro').getAttribute('aria-live'), 'off', 'la conversazione non si annuncia da sola');
		const i = b.$('#domanda');
		b.type(i, '   ');
		b.submit(b.$('#chiedi'));
		assert.strictEqual(b.last('ask'), undefined);
		b.type(i, 'Accendi le lampade');
		b.submit(b.$('#chiedi'));
		assert.deepStrictEqual(b.last('ask'), { type: 'ask', text: 'Accendi le lampade' });
		assert.strictEqual(i.value, '');
		// una riga nuova si aggiunge, le altre restano gli stessi nodi
		const log = assistant().log.concat({ role: 'melissa', text: 'Fatto.', at: ORA });
		b.send({ type: 'stato', assistant: assistant({ log }) });
		const dopo = b.$$('#registro > li');
		assert.strictEqual(dopo.length, 4);
		assert.strictEqual(dopo[0], righe[0]);
		assert.strictEqual(dopo[2], righe[2]);
		// registro vuoto
		b.send({ type: 'stato', assistant: assistant({ log: [] }) });
		assert.strictEqual(b.$('#registro-vuoto').hidden, false);
	});

	await test('sessioni: gruppi in ordine, chi aspetta in cima, conteggi, bacheca', () => {
		const b = mount();
		b.send(stato());
		assert.ok(b.$('#aspettano').contains(b.item('job:j1')), 'chi aspetta sta nel blocco in cima');
		assert.ok(!b.$('#scorre').contains(b.item('job:j1')));
		const ordine = b.$$('#sessioni .gruppo:not([hidden])').map(s => s.getAttribute('aria-label'));
		assert.deepStrictEqual(ordine, ['Ti aspetta', 'In corso', 'Nel terminale', 'In coda', 'Stanotte']);
		assert.strictEqual(b.$('.g-corso .conta').textContent, '2');
		assert.strictEqual(b.$('#sessioni-conto').textContent, '4 vive');
		const j1 = b.item('job:j1');
		assert.strictEqual(j1.querySelector('.progetto').textContent, 'faro-di-prova');
		assert.strictEqual(j1.querySelector('.titolo').textContent, 'Ripara la mappa lenta');
		assert.strictEqual(j1.querySelector('.tempo').textContent, 'aspetta da 12 min');
		const voci = [...j1.querySelectorAll('.bacheca li')].map(li => li.querySelector('.cosa').textContent);
		assert.deepStrictEqual(voci, ['ha modificato src/mappa.ts', 'ha lanciato npm test']);
		assert.strictEqual(b.item('sess:s4').querySelector('.titolo').textContent, 'Sessione senza titolo');
		assert.strictEqual(b.item('sess:s4').querySelector('.bacheca').hidden, true);
		assert.strictEqual(b.item('job:j3').querySelector('.di-notte').hidden, false);
		assert.strictEqual(b.item('job:j6').querySelector('.di-notte').hidden, true, 'stanotte lo dice gia\' il gruppo');
		// in coda e stanotte partono chiusi, si aprono e il ricordo resta
		const coda = b.$('.g-coda .gruppo-tasto');
		assert.strictEqual(coda.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(b.$('#lista-coda').hidden, true);
		b.click(coda);
		assert.strictEqual(coda.getAttribute('aria-expanded'), 'true');
		assert.strictEqual(b.$('#lista-coda').hidden, false);
		assert.deepStrictEqual(JSON.parse(JSON.stringify(b.state().chiusi)), ['stanotte']);
		// nessuna sessione
		b.send({ type: 'stato', work: [], workCounts: counts([]), board: {} });
		assert.strictEqual(b.$('#sessioni-vuoto').hidden, false);
		assert.strictEqual(b.$$('#sessioni .lavoro').length, 0);
	});

	await test('sessioni: azioni giuste per i lavori della Bottega e per quelli aperti altrove', () => {
		const b = mount();
		b.send(stato());
		const j1 = b.item('job:j1');
		assert.ok(b.byText(j1, 'button', 'Mostra'));
		assert.ok(!b.byText(j1, 'button', 'Riprendi qui'), 'un lavoro della Bottega non si riprende altrove');
		b.click(b.byText(j1, 'button', 'Mostra'));
		assert.deepStrictEqual(b.last('job.focus'), { type: 'job.focus', id: 'j1' });
		assert.ok(b.byText(j1, 'button', 'Mostra').classList.contains('main'), 'chi aspetta ha il tasto acceso');
		// chi aspetta ha il campo gia' aperto
		const form = j1.querySelector('form.scrivi');
		assert.strictEqual(form.hidden, false);
		const campo = form.querySelector('input');
		b.type(campo, 'Usa la seconda strada');
		b.submit(form);
		assert.deepStrictEqual(b.last('job.write'), { type: 'job.write', id: 'j1', text: 'Usa la seconda strada' });
		assert.strictEqual(campo.value, '');
		assert.strictEqual(form.querySelector('.esito').textContent, 'Mandato.');
		// un lavoro in corso: il campo si apre con «Scrivi al lavoro»
		const j3 = b.item('job:j3');
		const apri = b.byText(j3, 'button', 'Scrivi al lavoro');
		assert.strictEqual(apri.getAttribute('aria-expanded'), 'false');
		b.click(apri);
		assert.strictEqual(apri.getAttribute('aria-expanded'), 'true');
		assert.strictEqual(b.d.activeElement, j3.querySelector('form.scrivi input'));
		b.type(j3.querySelector('form.scrivi input'), 'Fermati dopo i test');
		b.submit(j3.querySelector('form.scrivi'));
		assert.deepStrictEqual(b.last('job.write'), { type: 'job.write', id: 'j3', text: 'Fermati dopo i test' });
		// Esc chiude il cassetto e torna al tasto
		b.key(j3.querySelector('form.scrivi input'), 'Escape');
		assert.strictEqual(j3.querySelector('form.scrivi').hidden, true);
		assert.strictEqual(b.d.activeElement, apri);
		// chiuso a mano resta chiuso anche con del testo dentro, e anche se poi il lavoro aspetta
		b.click(apri);
		b.type(j3.querySelector('form.scrivi input'), 'bozza');
		apri.focus();
		b.click(apri);
		assert.strictEqual(j3.querySelector('form.scrivi').hidden, true);
		const w2 = work().map(x => (x.key === 'job:j3' ? { ...x, status: 'ti aspetta' } : x));
		b.send({ type: 'stato', work: w2, workCounts: counts(w2) });
		assert.strictEqual(j3.querySelector('form.scrivi').hidden, true);
		assert.strictEqual(j3.querySelector('form.scrivi input').value, 'bozza', 'la bozza resta');
		// aperti altrove: sola lettura, Riprendi qui e Apri il progetto
		const s2 = b.item('sess:s2');
		assert.ok(!b.byText(s2, 'button', 'Mostra'));
		assert.ok(!s2.querySelector('form'));
		b.click(b.byText(s2, 'button', 'Riprendi qui'));
		assert.deepStrictEqual(b.last('claude'), { type: 'claude', path: '/prova/orto-digitale', id: 's2' });
		b.click(b.byText(s2, 'button', 'Apri il progetto'));
		assert.deepStrictEqual(b.last('open'), { type: 'open', path: '/prova/orto-digitale' });
	});

	await test('bacheca: le ultime tre ore si chiedono e si mostrano', () => {
		const b = mount();
		b.send(stato());
		const j1 = b.item('job:j1');
		const tutto = b.byText(j1, 'button', 'Le ultime tre ore');
		b.click(tutto);
		assert.deepStrictEqual(b.last('bacheca.sessione'), { type: 'bacheca.sessione', sessionId: 's1' });
		const items = [0, 1, 2, 3, 4, 5].map(i => ({ at: ORA - (100 - i) * MIN, kind: 'read', summary: `ha letto file-${i}.ts` }));
		b.send({ type: 'bacheca.sessione', sessionId: 's1', items });
		assert.strictEqual(j1.querySelectorAll('.bacheca li').length, 6);
		assert.strictEqual(tutto.textContent, 'Solo le ultime');
		b.click(tutto);
		assert.strictEqual(j1.querySelectorAll('.bacheca li').length, 2);
	});

	await test('comandi rapidi e Home', () => {
		const b = mount();
		b.send(stato());
		for (const id of ['briefing', 'regole', 'lavori', 'cruscotto', 'continua', 'cerca']) {
			b.click(b.$(`.comandi [data-comando="${id}"]`));
			assert.deepStrictEqual(b.last('comando'), { type: 'comando', id });
		}
		b.click(b.byText(b.d, '.comandi button', 'Apri la Home'));
		assert.deepStrictEqual(b.last('home'), { type: 'home', view: 'plancia' });
	});

	await test('fuoco e testo restano tra due stati, anche se il lavoro cambia gruppo', () => {
		const b = mount();
		b.send(stato());
		const j3 = b.item('job:j3');
		b.click(b.byText(j3, 'button', 'Scrivi al lavoro'));
		const campo = j3.querySelector('form.scrivi input');
		b.type(campo, 'mezza fra');
		campo.setSelectionRange(4, 4);
		// il livello audio, piu' volte
		for (let i = 0; i < 5; i++) b.send({ type: 'stato', assistant: assistant({ state: 'speaking', level: i / 5 }) });
		assert.strictEqual(b.d.activeElement, campo);
		assert.strictEqual(campo.value, 'mezza fra');
		// lo stesso lavoro passa da «in corso» a «ti aspetta»: si sposta nel blocco fisso, il fuoco no
		const w2 = work().map(x => (x.key === 'job:j3' ? { ...x, status: 'ti aspetta' } : x));
		b.send({ type: 'stato', work: w2, workCounts: counts(w2) });
		assert.strictEqual(b.item('job:j3'), j3, 'stesso nodo');
		assert.ok(b.$('#aspettano').contains(j3));
		assert.strictEqual(b.d.activeElement, campo, 'il fuoco resta nel campo');
		assert.strictEqual(campo.value, 'mezza fra');
		assert.strictEqual(campo.selectionStart, 4);
		// anche il campo di Melissa
		const domanda = b.$('#domanda');
		b.type(domanda, 'quasi pronta');
		b.send(stato({ assistant: assistant({ state: 'thinking' }) }));
		assert.strictEqual(b.d.activeElement, domanda);
		assert.strictEqual(domanda.value, 'quasi pronta');
		assert.deepStrictEqual(b.errors, []);
	});

	await test('uno stato uguale non tocca il DOM; il livello audio tocca solo la sfera', async () => {
		const b = mount();
		b.send(stato());
		const muta = [];
		const mo = new b.w.MutationObserver(r => muta.push(...r));
		mo.observe(b.d.body, { subtree: true, childList: true, attributes: true, characterData: true });
		b.send(stato());
		await pausa(0);
		assert.strictEqual(muta.length, 0, 'stato identico: nessuna modifica');
		b.send(stato({ assistant: assistant({ level: 0.7 }) }));
		await pausa(0);
		assert.strictEqual(muta.length, 0, 'solo il livello: il DOM resta, cambia il disegno');
		mo.disconnect();
	});

	await test('la sfera non riparte: un fotogramma alla volta, stessi nodi, a ogni livello', () => {
		const b = mount();
		const canvas = b.$('#sfera');
		b.send(stato({ assistant: assistant({ state: 'speaking' }) }));
		const chiesti = b.frames.asked;
		assert.ok(chiesti >= 1, 'la sfera gira a vista visibile');
		for (let i = 0; i < 20; i++) b.send({ type: 'stato', assistant: assistant({ state: 'speaking', level: (i % 5) / 5 }) });
		assert.strictEqual(b.frames.asked, chiesti, 'il livello non chiede fotogrammi nuovi');
		assert.strictEqual(b.frames.pending.size, 1, 'un solo ciclo vivo');
		b.runFrames(3);
		assert.ok(b.draws.includes('clearRect'), 'ha disegnato');
		assert.strictEqual(b.frames.pending.size, 1);
		assert.strictEqual(b.$('#sfera'), canvas);
	});

	await test('vista nascosta: niente fotogrammi, niente orologio, niente DOM; al ritorno si recupera', () => {
		const b = mount();
		b.send(stato());
		assert.strictEqual(b.timers.size, 1, 'l\'orologio dei «da 12 min» gira');
		b.setVisible(false);
		assert.strictEqual(b.frames.pending.size, 0, 'nessun fotogramma in attesa');
		assert.strictEqual(b.timers.size, 0, 'orologio fermo');
		assert.ok(b.d.body.classList.contains('ferma'));
		const chiesti = b.frames.asked, disegni = b.draws.length;
		const w2 = work().concat({ key: 'sess:s9', source: 'altrove', status: 'in corso', project: 'cometa', path: '/prova/cometa', title: 'Nuova', since: ORA, sessionId: 's9' });
		for (let i = 0; i < 10; i++) b.send(stato({ assistant: assistant({ state: 'speaking', level: i / 10 }), work: w2, workCounts: counts(w2) }));
		assert.strictEqual(b.frames.asked, chiesti, 'nessun fotogramma chiesto');
		assert.strictEqual(b.draws.length, disegni, 'nessun disegno');
		assert.strictEqual(b.item('sess:s9'), null, 'il DOM aspetta la vista');
		assert.strictEqual(b.$('#stato').textContent, 'Tocca la sfera per parlare');
		b.setVisible(true);
		assert.ok(b.item('sess:s9'), 'tornata visibile, disegna lo stato tenuto da parte');
		assert.strictEqual(b.$('#stato').textContent, 'Parlo');
		assert.strictEqual(b.frames.pending.size, 1);
		assert.strictEqual(b.timers.size, 1);
		// anche il segnale dell'estensione
		b.send({ type: 'visibile', visible: false });
		assert.strictEqual(b.frames.pending.size, 0);
		assert.strictEqual(b.timers.size, 0);
		b.send({ type: 'visibile', visible: true });
		assert.strictEqual(b.frames.pending.size, 1);
	});

	await test('riduci movimento: la sfera resta ferma, un solo fotogramma col colore giusto', () => {
		const b = mount({ reduced: true });
		b.send(stato({ assistant: assistant({ state: 'thinking' }) }));
		assert.strictEqual(b.frames.asked, 0, 'nessuna animazione');
		assert.ok(b.draws.includes('clearRect'), 'ma un disegno fermo c\'e\'');
		assert.match(CSS, /prefers-reduced-motion: reduce/);
	});

	await test('annunci: solo quando un lavoro comincia ad aspettare', async () => {
		const b = mount();
		b.send(stato());
		await pausa(100);
		assert.strictEqual(b.$('#annuncio').textContent, '', 'al primo stato non si annuncia nulla');
		b.send(stato({ assistant: assistant({ state: 'speaking' }) }));
		await pausa(100);
		assert.strictEqual(b.$('#annuncio').textContent, '');
		const w2 = work().map(x => (x.key === 'sess:s2' ? { ...x, status: 'ti aspetta' } : x));
		b.send({ type: 'stato', work: w2, workCounts: counts(w2) });
		await pausa(100);
		assert.strictEqual(b.$('#annuncio').textContent, 'orto-digitale ti aspetta: Pulisci i test');
		assert.strictEqual(b.$('#annuncio').getAttribute('role'), 'status');
	});

	await test('a 280 px e nel tema chiaro: niente da rompere nel CSS', () => {
		const b = mount({ tema: 'vscode-light' });
		b.send(stato());
		assert.match(CSS, /body\.vscode-light\s*\{/);
		// la notte di Melissa non ha override nel tema chiaro
		const chiaro = CSS.slice(CSS.indexOf('body.vscode-light {'), CSS.indexOf('}', CSS.indexOf('body.vscode-light {')));
		assert.ok(!/--notte/.test(chiaro), 'la notte resta notte');
		assert.match(CSS, /\.notte \{[^}]*var\(--notte\)/);
		assert.ok(!/min-width:\s*(2[89]\d|[3-9]\d\d)px/.test(CSS), 'nessuna larghezza minima oltre la barra');
		assert.match(CSS, /\.aspettano \{[^}]*flex: 0 0 auto/, 'chi aspetta non si restringe');
		assert.match(CSS, /\.cervello \{[^}]*z-index: 3/, 'l\'elenco dei cervelli sta sopra i selettori dell\'impegno');
		// una sola parte che scorre: le sessioni intere, non chi aspetta e le altre ciascuno per conto suo
		assert.match(CSS, /\.sessioni \{[^}]*overflow-y: auto/, 'le sessioni scorrono insieme');
		for (const sel of ['aspettano', 'scorre']) assert.ok(!new RegExp(`\\.${sel} \\{[^}]*overflow-y`).test(CSS), `.${sel} non ha uno scorrimento suo`);
		assert.match(CSS, /\.sessioni-testa \{[^}]*position: sticky/, 'il titolo resta in vista')
		assert.deepStrictEqual(b.errors, []);
	});

	await test('niente lineette lunghe U+2014 e U+2013, ne\' nel DOM ne\' nei sorgenti; niente style=', () => {
		const b = mount();
		b.send(stato());
		b.click(b.$('#cervello'));
		b.send(stato({ assistant: assistant({ state: 'speaking', partial: 'quasi' }) }));
		assert.deepStrictEqual(lineette(b.d), []);
		assert.ok(!LINEETTE.test(JS), 'barra.js');
		assert.ok(!LINEETTE.test(CSS), 'barra.css');
		assert.ok(!/style=/.test(JS), 'nessuno style= nelle stringhe HTML');
		assert.strictEqual(b.$$('[style]').length, 0);
	});

		await test('sfera WebGPU: si monta il componente unico; se WebGPU manca (onFail, dopo) si passa al Canvas 2D su un canvas nuovo, con il motivo nel log', () => {
		const calls = [];
		let fail;
		const gpu = {
			mount(canvas, opts) {
				fail = opts.onFail;
				calls.push(['mount', canvas.id]);
				return { set: (...a) => calls.push(['set', ...a]), wake: () => calls.push(['wake']), sleep: () => calls.push(['sleep']), redraw: () => calls.push(['redraw']) };
			},
		};
		const b = mount({ gpu });
		b.send({ type: 'stato', assistant: { enabled: true, conversing: false, state: 'speaking', level: 0.5, log: [], brain: 'agnes' } });
		assert.deepStrictEqual(calls[0], ['mount', 'sfera']);
		assert.ok(calls.some(c => c[0] === 'set' && c[1] === 'speaking'), 'lo stato arriva al componente GPU');
		const prima = b.$('#sfera');
		const disegniPrima = b.draws.length;
		fail('nessun adattatore WebGPU');
		const dopo = b.$('#sfera');
		assert.notStrictEqual(dopo, prima, 'canvas nuovo: quello di WebGPU non accetta un contesto 2D');
		assert.ok(calls.some(c => c[0] === 'sleep'), 'il componente GPU si ferma');
		assert.ok(b.warns.some(w => w.includes('nessun adattatore WebGPU')), 'motivo nel log');
		b.runFrames(3);
		assert.ok(b.draws.length > disegniPrima, 'disegna in 2D con lo stato di prima');
		const lanciante = mount({ gpu: { mount() { throw new Error('rotto'); } } });
		lanciante.send({ type: 'stato', assistant: { enabled: true, conversing: false, state: 'idle', log: [], brain: 'agnes' } });
		assert.ok(lanciante.warns.some(w => w.includes('rotto')));
		assert.deepStrictEqual(lanciante.errors, []);
	});

console.log(`\n${passed} ok, ${failed} falliti`);
	process.exit(failed ? 1 : 0);
})();
