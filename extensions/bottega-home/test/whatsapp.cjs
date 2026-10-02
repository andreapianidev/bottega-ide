#!/usr/bin/env node
// Banco di prova delle chat WhatsApp per progetto. NON spedito (vedi .vscodeignore).
// Dati tutti inventati (+34 600 000 0xx, esempio.it): il repository e' pubblico. Il server WhatsApp e' finto e
// risponde come quelli veri: una riga JSON per chat, JID "@lid" senza numero, numero trovato con search_contacts.

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const esbuild = require('esbuild');

const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'test-out', 'whatsapp');
esbuild.buildSync({
	entryPoints: ['whatsapp', 'posta', 'delega', 'connettori', 'connettori-mappa', 'mcp'].map(n => path.join(SRC, n + '.ts')),
	outdir: OUT,
	format: 'cjs',
	platform: 'node',
	bundle: false,
	target: 'node20',
	logLevel: 'silent',
});
const W = require(path.join(OUT, 'whatsapp.js'));
const P = require(path.join(OUT, 'posta.js'));
const M = require(path.join(OUT, 'mcp.js'));

let passed = 0, failed = 0;
const fails = [];
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log('  ok  ' + name);
	} catch (e) {
		failed++;
		fails.push(name);
		console.log('FAIL  ' + name + '\n      ' + String((e && e.stack) || e).split('\n').slice(0, 5).join('\n      '));
	}
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-whatsapp-'));
const mode = f => fs.statSync(f).mode & 0o777;

const NOW = Date.parse('2026-10-02T12:00:00Z');
const ore = h => new Date(NOW - h * 3600e3).toISOString();
const LUNGO = 'parola '.repeat(60);

// Le chat di un server finto, come le restituisce list_chats (una riga JSON per chat)
const CHAT_BUSINESS = [
	{ jid: 'status@broadcast', name: '0', last_message_time: ore(1), last_message: null, last_sender: null, last_is_from_me: null },
	{ jid: '111111111111111@lid', name: 'Bar Esempio', last_message_time: ore(2), last_message: LUNGO, last_sender: '111111111111111', last_is_from_me: 0 },
	{ jid: '34600000002@s.whatsapp.net', name: 'Ufficio Beta', last_message_time: ore(3), last_message: 'Grazie', last_sender: '34600000002', last_is_from_me: 1 },
	{ jid: '120363000000000001@g.us', name: 'Cantiere Alfa', last_message_time: ore(5), last_message: 'Foto', last_sender: '34600000009', last_is_from_me: 0 },
	{ jid: '222222222222222@lid', name: 'Senza Numero', last_message_time: ore(6), last_message: 'ciao', last_sender: '2', last_is_from_me: 0 },
	{ jid: '13135550000@bot', name: 'Assistente', last_message_time: ore(7), last_message: 'x', last_sender: null, last_is_from_me: 0 },
	{ jid: '34600000003@s.whatsapp.net', name: 'Vecchio', last_message_time: ore(24 * 30), last_message: 'vecchio', last_sender: '1', last_is_from_me: 0 },
];
const CHAT_PERSONALE = [
	{ jid: '333333333333333@lid', name: 'Mamma', last_message_time: ore(1), last_message: 'privato', last_sender: '3', last_is_from_me: 0 },
	{ jid: '34600000004@s.whatsapp.net', name: 'Cliente Gamma', last_message_time: ore(2), last_message: 'Il sito?', last_sender: '34600000004', last_is_from_me: 0 },
	{ jid: '120363000000000002@g.us', name: 'Calcetto', last_message_time: ore(3), last_message: 'stasera', last_sender: '9', last_is_from_me: 0 },
	{ jid: '120363000000000003@g.us', name: 'Gruppo Gamma', last_message_time: ore(4), last_message: 'ok', last_sender: '9', last_is_from_me: 1 },
];
const CONTATTI = [
	{ phone_number: '34600000001', name: 'Bar Esempio', jid: '111111111111111@lid' },
	{ phone_number: '34600000099', name: 'Altro', jid: '999999999999999@lid' },
	{ phone_number: '34600000005', name: 'Mamma', jid: '333333333333333@lid' },
];

/** Un lettore finto con la stessa forma dei risultati di tools/call. */
function lettore(chats, chiamate) {
	return {
		async chiama(nome, args) {
			chiamate.push([nome, args]);
			const righe = l => ({ content: l.map(x => ({ type: 'text', text: JSON.stringify(x) })) });
			if (nome === 'list_chats') return righe(chats.slice(args.page * args.limit, (args.page + 1) * args.limit));
			if (nome === 'search_contacts') return righe(CONTATTI.filter(c => c.jid.includes(args.query) || c.phone_number.includes(args.query)));
			throw new Error('strumento inatteso ' + nome);
		},
	};
}

(async () => {
	console.log('whatsapp');

	await test('righe JSON, tipi di JID, link per aprire la chat', () => {
		assert.deepStrictEqual(W.righeJson('{"a":1}\n{"a":2}\nriga di log'), [{ a: 1 }, { a: 2 }]);
		assert.deepStrictEqual(W.righeJson('[{"a":1}]'), [{ a: 1 }]);
		assert.deepStrictEqual(W.righeJson(''), []);
		assert.strictEqual(W.tipoJid('34600000002@s.whatsapp.net'), 'persona');
		assert.strictEqual(W.tipoJid('111111111111111@lid'), 'lid');
		assert.strictEqual(W.tipoJid('120363000000000001@g.us'), 'gruppo');
		assert.strictEqual(W.tipoJid('status@broadcast'), 'altro');
		assert.strictEqual(W.tipoJid('13135550000@bot'), 'altro');
		assert.strictEqual(W.fonteDi('whatsapp-business'), 'business');
		assert.strictEqual(W.fonteDi('whatsapp-personal'), 'personale');
		assert.strictEqual(W.linkWhatsapp({ telefono: '+34600000001', gruppo: false }), 'whatsapp://send?phone=34600000001');
		assert.strictEqual(W.linkWhatsapp({ telefono: '', gruppo: false }), undefined);
		assert.strictEqual(W.linkWhatsapp({ telefono: '+34600000001', gruppo: true }), undefined);
		assert.strictEqual(W.linkWhatsapp({ telefono: '+34 600; rm -rf', gruppo: false }), undefined);
	});

	await test('lettura: solo gli ultimi giorni, numero dei "@lid" da search_contacts, anteprima a 120, niente stato e bot', async () => {
		const chiamate = [];
		const chat = await W.leggiChat(lettore(CHAT_BUSINESS, chiamate), 'whatsapp-business', NOW - 7 * 864e5);
		assert.deepStrictEqual(chat.map(c => c.contatto), ['Bar Esempio', 'Ufficio Beta', 'Cantiere Alfa', 'Senza Numero']);
		const bar = chat[0];
		assert.deepStrictEqual(
			{ ...bar, ultimo: bar.ultimo.length },
			{ id: 'wa:business:111111111111111@lid', fonte: 'business', server: 'whatsapp-business', jid: '111111111111111@lid', gruppo: false, contatto: 'Bar Esempio', telefono: '+34600000001', ultimo: 120, data: ore(2), mio: false },
		);
		assert.strictEqual(chat[1].telefono, '+34600000002');
		assert.strictEqual(chat[1].mio, true);
		assert.strictEqual(chat[2].gruppo, true);
		assert.strictEqual(chat[2].telefono, '');
		assert.strictEqual(chat[3].telefono, '', 'un "@lid" senza contatto resta senza numero');
		// solo strumenti di lettura, list_chats senza corpo dei messaggi oltre all'ultimo
		assert.ok(chiamate.every(([n]) => n === 'list_chats' || n === 'search_contacts'));
		assert.deepStrictEqual(chiamate[0], ['list_chats', { limit: 100, page: 0, include_last_message: true, sort_by: 'last_active' }]);
		assert.deepStrictEqual(chiamate.filter(([n]) => n === 'search_contacts').map(([, a]) => a.query), ['111111111111111', '222222222222222']);
	});

	const RUB = {
		'/p/alfa': { indirizzi: [], domini: [], telefoni: ['+34600000001'], gruppi: ['120363000000000001@g.us'] },
		'/p/gamma': { indirizzi: ['g@esempio.it'], domini: [], telefoni: ['+34600000004'] },
	};

	await test('privacy: le chat personali fuori rubrica non entrano, i gruppi solo se in rubrica', async () => {
		const pers = await W.leggiChat(lettore(CHAT_PERSONALE, []), 'whatsapp-personal', NOW - 7 * 864e5);
		const ammesse = pers.filter(c => W.ammessa(c, RUB, false)).map(c => c.contatto);
		assert.deepStrictEqual(ammesse, ['Cliente Gamma'], 'Mamma e i gruppi personali restano fuori');
		assert.deepStrictEqual(pers.filter(c => W.ammessa(c, RUB, true)).map(c => c.contatto), ['Mamma', 'Cliente Gamma'], 'con l\'impostazione si vedono le persone, mai i gruppi');
		const biz = await W.leggiChat(lettore(CHAT_BUSINESS, []), 'whatsapp-business', NOW - 7 * 864e5);
		const a = W.assegnaChat([...biz, ...pers], RUB, false);
		assert.deepStrictEqual(Object.keys(a.perProgetto).sort(), ['/p/alfa', '/p/gamma']);
		assert.deepStrictEqual(a.perProgetto['/p/alfa'].map(c => c.contatto), ['Bar Esempio', 'Cantiere Alfa']);
		assert.deepStrictEqual(a.perProgetto['/p/gamma'].map(c => c.contatto), ['Cliente Gamma']);
		assert.deepStrictEqual(a.daAssegnare.map(c => c.contatto), ['Ufficio Beta'], 'business fuori rubrica si'+"'"+', senza numero no');
	});

	await test('motore: legge i due server, scrive solo le chat ammesse, file 600, un errore non cancella le chat di prima', async () => {
		const file = path.join(tmp, 'c', 'whatsapp.json');
		let rompi = false;
		const cambi = [];
		const deps = {
			file,
			server: () => ['whatsapp-business', 'whatsapp-personal'],
			apri: async (server, fn) => {
				if (rompi && server === 'whatsapp-business') throw new Error('non parte');
				return fn(lettore(server === 'whatsapp-business' ? CHAT_BUSINESS : CHAT_PERSONALE, []));
			},
			rubrica: () => RUB,
			giorni: () => 7,
			personaleDaAssegnare: () => false,
			onChange: () => cambi.push(1),
			log() {},
			ora: () => NOW,
		};
		const m = new W.MotoreWhatsapp(deps);
		await m.aggiorna();
		assert.strictEqual(m.aggiornando, false);
		assert.ok(cambi.length >= 2);
		assert.strictEqual(mode(file), 0o600);
		const disco = fs.readFileSync(file, 'utf8');
		assert.ok(!disco.includes('Mamma') && !disco.includes('privato') && !disco.includes('Calcetto'), 'la vita privata non finisce su disco');
		assert.ok(!disco.includes('vecchio'), 'solo gli ultimi giorni');
		assert.ok(!disco.includes(LUNGO.trim()), 'solo l\'anteprima breve');
		assert.deepStrictEqual(m.fonti.business.n, 4);
		assert.deepStrictEqual(m.fonti.personale.n, 1);
		rompi = true;
		await m.aggiorna();
		const m2 = new W.MotoreWhatsapp(deps);
		assert.match(m2.fonti.business.errore, /non parte/);
		assert.strictEqual(m2.chat.filter(c => c.fonte === 'business').length, 4, 'le chat di prima restano');
		const vuoto = new W.MotoreWhatsapp({ ...deps, file: path.join(tmp, 'c', 'altro.json'), server: () => [] });
		await vuoto.aggiorna();
		assert.strictEqual(vuoto.aggiornatoAt, 0, 'senza server non succede niente');
	});

	await test('un server MCP finto vero: tools/call con le stesse righe, e send_message rifiutato', async () => {
		const server = path.join(tmp, 'wa-finto.cjs');
		const registro = path.join(tmp, 'wa-finto.log');
		fs.writeFileSync(
			server,
			`const fs = require('fs');
const CHAT = ${JSON.stringify(CHAT_BUSINESS)};
const CONTATTI = ${JSON.stringify(CONTATTI)};
let buf = '';
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
const righe = l => ({ content: l.map(x => ({ type: 'text', text: JSON.stringify(x) })) });
process.stdin.on('data', c => {
	buf += c;
	let i;
	while ((i = buf.indexOf('\\n')) >= 0) {
		const m = JSON.parse(buf.slice(0, i));
		buf = buf.slice(i + 1);
		fs.appendFileSync(${JSON.stringify(registro)}, (m.params && m.params.name ? m.params.name : m.method) + '\\n');
		if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wa', version: '0' } } });
		else if (m.method === 'tools/call' && m.params.name === 'list_chats') out({ jsonrpc: '2.0', id: m.id, result: righe(CHAT.slice(m.params.arguments.page * 100, (m.params.arguments.page + 1) * 100)) });
		else if (m.method === 'tools/call' && m.params.name === 'search_contacts') out({ jsonrpc: '2.0', id: m.id, result: righe(CONTATTI.filter(c => c.jid.includes(m.params.arguments.query))) });
	}
});`,
		);
		const chat = await M.conServer('whatsapp-business', { command: process.execPath, args: [server], env: {} }, async c => {
			await assert.rejects(() => c.chiama('send_message', { recipient: '34600000001', message: 'x' }), /sola lettura/);
			return W.leggiChat(c, 'whatsapp-business', NOW - 7 * 864e5);
		});
		assert.deepStrictEqual(chat.map(c => c.telefono), ['+34600000001', '+34600000002', '', '']);
		const log = fs.readFileSync(registro, 'utf8');
		assert.ok(!/send/.test(log));
	});

	await test('nessuna lineetta lunga o media in whatsapp.ts', () => {
		assert.ok(!/[\u2013\u2014]/.test(fs.readFileSync(path.join(SRC, 'whatsapp.ts'), 'utf8')));
	});

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(`\n${passed} ok, ${failed} falliti${failed ? ': ' + fails.join('; ') : ''}`);
	process.exit(failed ? 1 : 0);
})();
