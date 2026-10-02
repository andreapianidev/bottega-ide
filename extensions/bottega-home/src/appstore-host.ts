/* La stanza App Store dentro l'estensione (docs/CONTRATTI.md, 13): crea il motore (src/appstore.ts), lo ricontrolla
   da solo ogni bottega.appstore.controlloOre ore, manda gli allarmi come notifiche del Mac, risponde ai messaggi della
   plancia e da' a Melissa lo strumento app_guadagni. extension.ts la registra e le passa i messaggi: un solo aggancio.
   Gli allarmi arrivano anche all'iPhone, attraverso gli avvisi (src/avvisi.ts, istantanea.negozio). */

import * as vscode from 'vscode';
import type { Assistant, ToolSpec } from './assistant';
import { type Allarme, AppStore } from './appstore';
import type { Nucleo } from './nucleo';
import type { Radar } from './radar';
import type { Project } from './scan';

export interface AppStoreHost {
	radar(): Radar | undefined;
	projects(): Project[];
	send(msg: unknown): void;
	nucleo(): Nucleo | undefined;
	showHome(view?: string): void;
	log(s: string): void;
}

const ore = () => {
	const v = Number(vscode.workspace.getConfiguration('bottega').get('appstore.controlloOre', 3));
	return Number.isFinite(v) && v > 0 ? Math.min(24, v) : 0;
};

let motore: AppStore | undefined;

export function registerAppStore(ctx: vscode.ExtensionContext, h: AppStoreHost): AppStore {
	const m = new AppStore({ radar: h.radar, projects: h.projects, log: h.log, controlloOre: ore });
	motore = m;
	m.onChange(s => h.send({ type: 'appstore', state: s }));
	// un allarme e' una notifica del Mac; con Andrea lontano arriva anche all'iPhone (avvisi.ts)
	m.onAllarmi((nuovi: Allarme[]) => {
		for (const a of nuovi.slice(0, 3)) {
			h.nucleo()?.fireAndForget('notify', { id: `bottega:appstore:${a.id}`, title: a.app, body: a.testo, actions: [{ id: 'apri', title: 'Apri App Store' }], sound: false });
		}
	});
	const n = h.nucleo();
	n?.on('notify.clicked', (x: any) => {
		if (String(x?.id ?? '').startsWith('bottega:appstore:') && x.action !== 'dismiss') h.showHome('appstore');
	});
	// il controllo da solo: un giro ogni 15 minuti guarda se sono passate le ore scelte dall'ultima lettura
	const giro = () => {
		const o = ore();
		if (!o) return;
		if (Date.now() - m.state().aggiornatoAt >= o * 3_600_000) void m.refresh();
	};
	const t1 = setTimeout(giro, 2 * 60_000);
	const t2 = setInterval(giro, 15 * 60_000);
	ctx.subscriptions.push({ dispose: () => (clearTimeout(t1), clearInterval(t2)) });
	return m;
}

/** I messaggi della plancia per la stanza (13.4). Vero se il messaggio era suo. */
export function handleAppStore(msg: { type: string; [k: string]: any }, h: Pick<AppStoreHost, 'send'>): boolean {
	const m = motore;
	if (!m || !msg.type.startsWith('appstore.')) return false;
	switch (msg.type) {
		case 'appstore.request':
			// lo stato salvato subito; il motore rilegge da solo se sono passati 45 minuti
			h.send({ type: 'appstore', state: m.state() });
			void m.refresh();
			return true;
		case 'appstore.refresh':
			void m.refresh({ force: true });
			return true;
		case 'appstore.ignora':
			if (typeof msg.id === 'string') m.ignora(msg.id, typeof msg.motivo === 'string' ? msg.motivo : '');
			return true;
		case 'appstore.ripristina':
			if (typeof msg.id === 'string') m.ripristina(msg.id);
			return true;
	}
	return false;
}

/** Gli allarmi recenti per gli avvisi dell'iPhone. */
export const allarmiAppStore = (): Allarme[] | null => motore?.allarmiRecenti() ?? null;

/** Il briefing del mattino (src/briefing.ts, Facts.appstore). */
export const briefingAppStore = () => motore?.briefing() ?? null;

export interface StrumentoAppStore {
	spec: ToolSpec;
	risky?: boolean;
	run(args: any, ctx: Assistant): Promise<string> | string;
}

export const STRUMENTI_APPSTORE: Record<string, StrumentoAppStore> = {
	app_guadagni: {
		spec: {
			type: 'function',
			function: {
				name: 'app_guadagni',
				description:
					'Quanto hanno reso le app di Andrea (AdMob e vendite dello Store, download, abbonati) ieri, nella settimana, nel mese o nell\'anno, tutte insieme o una sola, e cosa c\'e\' da sistemare per guadagnare di piu\' (i buchi della stanza App Store). Usalo per «quanto hanno reso le app», «come va Talky», «cosa sistemo per primo».',
				parameters: {
					type: 'object',
					properties: {
						periodo: { type: 'string', enum: ['ieri', 'settimana', 'mese', 'anno'], description: 'di default la settimana' },
						app: { type: 'string', description: 'nome di una sola app o del suo progetto, per esempio Talky' },
						mostra: { type: 'boolean', description: 'true per aprire anche la stanza App Store nella Bottega' },
					},
					required: [],
					additionalProperties: false,
				},
			},
		},
		run: a => {
			const m = motore;
			if (!m) return 'La stanza App Store non è pronta.';
			const periodo = ['ieri', 'settimana', 'mese', 'anno'].includes(a?.periodo) ? a.periodo : 'settimana';
			// dati vecchi di oltre tre ore: si risponde con quelli e intanto si rilegge
			const vecchi = Date.now() - m.state().aggiornatoAt > 3 * 3_600_000;
			if (vecchi) void m.refresh();
			if (a?.mostra) vscode.commands.executeCommand('bottega.openAppStore').then(undefined, () => undefined);
			return m.riassunto(periodo, typeof a?.app === 'string' && a.app.trim() ? a.app : undefined) + (vecchi ? '\nSto rileggendo i numeri adesso.' : '');
		},
	},
};
