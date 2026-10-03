/* Melissa racconta cosa sta facendo mentre lavora (interruttore «racconta» della barra, CONTRATTI 6).

   Come la Melissa di Avo Agency AI (Core/Agent/AgentActivityNarration.swift): frasi vere e fisse, una per strumento,
   costruite con gli argomenti (il file, il progetto, la stanza). Mai il ragionamento nascosto del modello, mai comandi,
   chiavi o risultati grezzi, mai una chiamata a un cervello: partono subito e non costano niente. */

/** Dopo quanto uno strumento lento merita una frase in piu'. */
export const ATTESA_MS = 8000;

const corto = (s: unknown, n = 40): string => {
	const t = String(s ?? '').replace(/\s+/g, ' ').trim();
	return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};
const fileDi = (s: unknown) => corto(String(s ?? '').split('/').pop(), 40);

/** La frase per uno strumento che parte; undefined per gli strumenti che non vale la pena annunciare. */
export function fraseInizio(nome: string, a: Record<string, any> = {}): string | undefined {
	switch (nome) {
		case 'codice_leggi':
			return a.file ? `Leggo ${fileDi(a.file)}.` : 'Leggo il codice che hai davanti.';
		case 'guarda_schermo':
			return 'Guardo lo schermo.';
		case 'progetti_cerca':
			return a.testo ? `Cerco i progetti su «${corto(a.testo)}».` : 'Scorro i progetti.';
		case 'progetto_stato':
			return a.progetto ? `Guardo come sta ${corto(a.progetto)}: git, modifiche, build.` : 'Guardo lo stato del progetto.';
		case 'progetto_apri':
			return a.progetto ? `Apro ${corto(a.progetto)}.` : undefined;
		case 'file_apri':
			return a.percorso ? `Apro ${fileDi(a.percorso)}.` : undefined;
		case 'sessioni_attive':
			return 'Guardo le sessioni di Claude aperte.';
		case 'sessione_leggi':
			return a.progetto ? `Leggo cosa ha fatto Claude su ${corto(a.progetto)}.` : 'Leggo la sessione di Claude.';
		case 'lavori_elenco':
			return 'Scorro i lavori.';
		case 'lavoro_nuovo':
			return a.progetto ? `Avvio un lavoro di Claude su ${corto(a.progetto)}.` : 'Avvio un lavoro di Claude.';
		case 'lavoro_stanotte':
			return a.progetto ? `Metto in fila per stanotte un lavoro su ${corto(a.progetto)}.` : undefined;
		case 'memoria_cerca':
			return a.testo ? `Cerco nella memoria «${corto(a.testo)}».` : 'Cerco nella memoria.';
		case 'memoria_bacheca':
			return 'Guardo la bacheca delle sessioni.';
		case 'dove_risolto':
			return a.testo ? `Cerco dove hai già risolto «${corto(a.testo)}», nella memoria e nel codice.` : undefined;
		case 'regole_controlla':
			return a.progetto ? `Controllo le regole su ${corto(a.progetto)}.` : 'Controllo il semaforo delle regole.';
		case 'briefing':
			return 'Metto insieme il briefing.';
		case 'sistema_stato':
			return 'Guardo come sta il Mac.';
		case 'store_soldi':
			return 'Guardo App Store Connect e AdMob.';
		case 'app_guadagni':
			return a.app ? `Guardo i guadagni di ${corto(a.app)}.` : 'Guardo i guadagni delle app.';
		case 'stanza_leggi':
			return a.stanza ? `Leggo la stanza ${corto(a.stanza)}.` : 'Leggo la plancia.';
		case 'stanza_mostra':
		case 'plancia_mostra':
		case 'cruscotto_mostra':
			return 'Te lo metto sullo schermo.';
		case 'connettori_elenco':
			return 'Guardo quali connettori ci sono.';
		case 'connettore_leggi':
			return a.server ? `Interrogo ${corto(a.server, 24)}.` : 'Interrogo un connettore.';
		case 'connettore_chiedi':
			return 'Chiedo a Claude di passare dai connettori: ci mette un po\'.';
		case 'git_spingi':
			return a.progetto ? `Preparo il push di ${corto(a.progetto)}.` : undefined;
		default:
			// cervello_cambia, memoria_ricorda, lavoro_scrivi, lavoro_ferma, continua: si vede gia' dalla risposta
			return undefined;
	}
}

/** Uno strumento ci mette piu' di ATTESA_MS. */
export function fraseAttesa(nome: string): string {
	if (nome === 'connettore_chiedi' || nome === 'lavoro_nuovo') return 'Ci vuole ancora un po\', resto qui.';
	if (nome === 'codice_leggi' || nome === 'guarda_schermo') return 'Sto ancora leggendo.';
	return 'Ancora un attimo, sta rispondendo.';
}
