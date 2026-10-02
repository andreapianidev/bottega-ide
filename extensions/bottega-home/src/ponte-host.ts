import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Apns } from './apns';
import type { Assistant } from './assistant';
import { Avvisi, inattivitaHID, ModoAvvisi, RegolaProgetto } from './avvisi';
import { Dispositivo, fondiDispositivo, leggiDispositivo, togliToken } from './dispositivo';
import type { WorkCounts, WorkItem } from './jobs';
import type { Nucleo } from './nucleo';
import * as crypto from 'crypto';
import { Ponte, PonteStato, RigaParla } from './ponte';

/* Il ponte dentro la Bottega: lo accende con Tailscale, gli passa Melissa e i lavori, e mostra il QR per
   collegare l'iPhone (comando "Collega l'iPhone"). Il protocollo e' in src/ponte.ts e in docs/CONTRATTI.md, 9.
   Qui vivono anche gli avvisi verso l'iPhone (9.4): notifiche, Live Activity e widget, via APNs (src/avvisi.ts). */

export interface PonteHostDeps {
	assistant(): Assistant | undefined;
	nucleo(): Nucleo | undefined;
	work(): WorkItem[];
	counts(): WorkCounts;
	writeJob(id: string, text: string): boolean;
	/** Il semaforo per progetto; null finche' non ha fatto il primo controllo. */
	regole?(): RegolaProgetto[] | null;
}

export function registerPonte(ctx: vscode.ExtensionContext, deps: PonteHostDeps): { notify(): void } {
	const out = vscode.window.createOutputChannel('Bottega per iPhone', { log: true });
	const dir = path.join(os.homedir(), '.bottega');
	const acceso = () => vscode.workspace.getConfiguration('bottega').get<boolean>('ponte.attivo', true);

	// gli avvisi: il registro dell'iPhone sta in memoria e su disco, gli invii passano da APNs
	let disp: Dispositivo | null = leggiDispositivo(dir);
	const apns = new Apns({ log: line => out.info(line) });
	const avvisi = new Avvisi({
		istantanea: () => {
			const c = deps.counts();
			return {
				lavori: deps.work(),
				conti: { inCorso: c.inCorso, tiAspetta: c.tiAspetta, vive: c.vive },
				conferma: deps.assistant()?.pendingQuestion(),
				regole: deps.regole?.() ?? null,
			};
		},
		invio: apns,
		dispositivo: () => disp,
		togliToken: (campo, token) => {
			if (togliToken(dir, campo, token)) disp = leggiDispositivo(dir);
		},
		modo: () => {
			const m = vscode.workspace.getConfiguration('bottega').get<string>('iphone.avvisi', 'lontano');
			return (m === 'sempre' || m === 'mai' ? m : 'lontano') as ModoAvvisi;
		},
		inattivoMs: inattivitaHID(),
		mac: os.hostname().replace(/\.local$/, ''),
		log: line => out.info(line),
	});
	let prossimo: NodeJS.Timeout | undefined;
	const avvisa = () => {
		if (prossimo || !acceso()) return;
		prossimo = setTimeout(() => {
			prossimo = undefined;
			void avvisi.aggiorna();
		}, 1000);
	};
	// i tempi della Live Activity (15 s, 2 minuti) e dei widget passano anche senza cambi
	const giri = setInterval(() => disp && avvisa(), 5000);

	let impegnata = false;
	const ponte = new Ponte({
		dir,
		versione: String(ctx.extension.packageJSON.version ?? ''),
		stato: () => stato(deps),
		// prenotata subito, prima di qualunque await: due domande dall'iPhone non passano insieme il controllo
		occupata: () => impegnata || (deps.assistant()?.busy() ?? true),
		confermaAttuale: () => deps.assistant()?.pendingConfirmation(),
		chiedi: async testo => {
			const a = deps.assistant();
			if (!a) throw Object.assign(new Error('Melissa non e\' ancora pronta.'), { status: 503 });
			impegnata = true;
			try {
				return await a.askRemote(testo);
			} finally {
				impegnata = false;
			}
		},
		parla: async (testo, emetti, segnale) => {
			impegnata = true;
			try {
				return await parla(deps, testo, emetti, segnale);
			} finally {
				impegnata = false;
			}
		},
		voce: async testo => {
			const n = deps.nucleo();
			if (!n?.available) throw Object.assign(new Error('Il Nucleo non e\' acceso: niente voce.'), { status: 503 });
			const r = await n.request<{ path: string }>('ponte.voce', { testo }, 45_000);
			try {
				return await fs.promises.readFile(r.path);
			} finally {
				fs.promises.unlink(r.path).catch(() => undefined);
			}
		},
		scriviLavoro: deps.writeJob,
		registraDispositivo: d => {
			disp = fondiDispositivo(dir, d);
			avvisa();
		},
		log: line => out.info(line),
	});

	if (acceso()) void ponte.start();
	avvisa(); // la linea di partenza: quello che c'e' gia' non suona
	ctx.subscriptions.push(
		out,
		{ dispose: () => ponte.stop() },
		{
			dispose: () => {
				clearInterval(giri);
				clearTimeout(prossimo);
				apns.chiudi();
			},
		},
		vscode.workspace.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration('bottega.ponte.attivo')) return;
			if (acceso()) {
				avvisi.riparti();
				void ponte.start();
			} else ponte.stop();
		}),
		vscode.commands.registerCommand('bottega.ponte.collega', () => mostraCollegamento(ponte, deps, acceso())),
	);
	return {
		notify: () => {
			ponte.notify();
			avvisa();
		},
	};
}

/** La domanda a voce dall'iPhone: Melissa risponde come a voce sul Mac e ogni frase, appena pronta, va al socket
 *  ElevenLabs del Nucleo (ponte.flusso.*); l'audio torna come eventi `ponte.audio` e scorre all'iPhone. */
async function parla(deps: PonteHostDeps, testo: string, emetti: (r: RigaParla) => void, segnale: AbortSignal): Promise<string> {
	const a = deps.assistant();
	if (!a) throw Object.assign(new Error('Melissa non e\' ancora pronta.'), { status: 503 });
	const n = deps.nucleo();
	const id = crypto.randomUUID();
	const voce = !!n?.available && (await n.request<{ ok: boolean }>('ponte.flusso.apri', { id }, 5000).then(r => !!r?.ok).catch(() => false));
	if (segnale.aborted) {
		// l'iPhone ha gia' chiuso mentre si apriva il socket: niente turno fantasma
		if (voce) n!.fireAndForget('ponte.flusso.ferma', { id });
		throw Object.assign(new Error('L\'iPhone ha chiuso la richiesta.'), { status: 499 });
	}
	emetti({ tipo: 'voce', ok: voce });

	let chiudiAudio!: () => void;
	const audioFinito = new Promise<void>(r => (chiudiAudio = r));
	const suAudio = (m: any) => m?.id === id && emetti({ tipo: 'audio', pcm: m.pcm });
	const suFine = (m: any) => m?.id === id && chiudiAudio();
	const suErrore = (m: any) => {
		if (m?.id !== id) return;
		emetti({ tipo: 'voce-persa', errore: String(m.errore ?? '') });
		chiudiAudio();
	};
	if (voce) {
		n!.on('ponte.audio', suAudio);
		n!.on('ponte.audio.fine', suFine);
		n!.on('ponte.audio.errore', suErrore);
	}
	// le frasi vanno al Nucleo una dopo l'altra, nell'ordine in cui Melissa le dice
	let coda: Promise<unknown> = Promise.resolve();
	let finito = false;
	const fine = () => {
		if (finito) return;
		finito = true;
		if (voce) coda = coda.then(() => n!.request('ponte.flusso.fine', { id }, 5000).catch(() => undefined));
		else chiudiAudio();
	};
	const interrompi = () => {
		a.interruptRemote();
		if (voce) n!.fireAndForget('ponte.flusso.ferma', { id });
		chiudiAudio();
	};
	segnale.addEventListener('abort', interrompi, { once: true });
	let attesa: NodeJS.Timeout | undefined;
	try {
		const risposta = await a.askRemoteVoice(testo, {
			frase: t => {
				emetti({ tipo: 'frase', testo: t });
				if (voce) coda = coda.then(() => n!.request('ponte.flusso.testo', { id, testo: t }, 5000).catch(() => undefined));
			},
			fine,
		});
		fine();
		await Promise.race([audioFinito, new Promise(r => (attesa = setTimeout(r, 30_000)))]);
		return risposta;
	} finally {
		clearTimeout(attesa);
		segnale.removeEventListener('abort', interrompi);
		if (voce) {
			n!.off('ponte.audio', suAudio);
			n!.off('ponte.audio.fine', suFine);
			n!.off('ponte.audio.errore', suErrore);
		}
	}
}

function stato(deps: PonteHostDeps): Omit<PonteStato, 'versione' | 'mac' | 'ora'> {
	const a = deps.assistant()?.getState();
	const c = deps.counts();
	return {
		melissa: {
			stato: a?.state ?? 'idle',
			cervello: a?.brain ?? 'nessuno',
			parziale: a?.partial,
			registro: (a?.log ?? []).slice(-30).map(l => ({ chi: l.role, testo: l.text, alle: l.at })),
		},
		lavori: deps.work().slice(0, 40).map(w => ({
			chiave: w.key,
			origine: w.source,
			stato: w.status,
			progetto: w.project,
			titolo: w.title,
			da: w.since,
			jobId: w.jobId,
		})),
		conti: { inCorso: c.inCorso, tiAspetta: c.tiAspetta, inCoda: c.inCoda, vive: c.vive },
	};
}

async function mostraCollegamento(ponte: import('./ponte').Ponte, deps: PonteHostDeps, acceso: boolean): Promise<void> {
	if (!acceso) {
		const s = await vscode.window.showWarningMessage('Il ponte verso l\'iPhone è spento.', 'Accendilo');
		if (s) await vscode.workspace.getConfiguration('bottega').update('ponte.attivo', true, vscode.ConfigurationTarget.Global);
		return;
	}
	await ponte.start();
	const info = ponte.info();
	if (!info.attivo || !info.collegamento) {
		void vscode.window.showWarningMessage(info.errore ?? 'Il ponte non è acceso: controlla che Tailscale sia attivo su questo Mac.');
		return;
	}
	let png = '';
	try {
		const n = deps.nucleo();
		if (n?.available) png = (await n.request<{ png: string }>('ponte.qr', { testo: info.collegamento }, 8000)).png;
	} catch {
		// senza Nucleo resta il collegamento da copiare
	}
	const panel = vscode.window.createWebviewPanel('bottega.ponte', 'Collega l\'iPhone', vscode.ViewColumn.Active, { enableScripts: true });
	panel.webview.html = pagina(panel.webview.cspSource, info.nome ?? info.ip ?? '', info.porta, png);
	panel.webview.onDidReceiveMessage(m => {
		if (m?.type === 'copia') void vscode.env.clipboard.writeText(info.collegamento!).then(() => vscode.window.showInformationMessage('Collegamento copiato. Contiene il gettone: incollalo solo sull\'iPhone.'));
	});
}

function esc(s: string): string {
	return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function pagina(csp: string, nome: string, porta: number, png: string): string {
	const nonce = Math.random().toString(36).slice(2);
	const qr = png
		? `<img class="qr" alt="QR per collegare l'iPhone" src="data:image/png;base64,${png}">`
		: '<p class="nota">Il Nucleo è spento, niente QR: copia il collegamento e aprilo sull\'iPhone.</p>';
	return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); display: grid; place-items: center; min-height: 92vh; margin: 0; }
main { max-width: 440px; text-align: center; padding: 24px; }
h1 { font-size: 1.5em; font-weight: 600; margin: 0 0 8px; }
p { line-height: 1.5; opacity: .85; }
.qr { width: 280px; height: 280px; image-rendering: pixelated; border-radius: 14px; background: #fff; padding: 10px; margin: 18px 0; }
.dove { font-family: var(--vscode-editor-font-family); font-size: .92em; opacity: .7; }
button { margin-top: 10px; font: inherit; padding: 6px 14px; border-radius: 8px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
.nota { font-size: .9em; opacity: .7; }
</style></head><body><main>
<h1>Collega l'iPhone</h1>
<p>Inquadra il codice con la fotocamera dell'iPhone: si apre la Bottega per iPhone già collegata a questo Mac.</p>
${qr}
<p class="dove">${esc(nome)}, porta ${porta}</p>
<button id="copia">Copia il collegamento</button>
<p class="nota">Funziona da ovunque, purché Tailscale sia acceso sull'iPhone e su questo Mac, e la Bottega sia aperta.
Il codice contiene il gettone del ponte: non mostrarlo ad altri.</p>
</main>
<script nonce="${nonce}">const vs = acquireVsCodeApi(); document.getElementById('copia').onclick = () => vs.postMessage({ type: 'copia' });</script>
</body></html>`;
}
