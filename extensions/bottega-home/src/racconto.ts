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

const righeDi = (r: string) => r.split('\n').filter(x => x.trim());
const primaFrase = (r: string, n = 140): string => {
	const t = r.replace(/\s+/g, ' ').trim();
	const m = /^(.+?[.!?])(\s|$)/.exec(t);
	return corto(m ? m[1].replace(/[.!?]$/, '') : t, n);
};
const nPlur = (n: number, uno: string, tanti: string) => (n === 1 ? uno : `${n} ${tanti}`);
const NOMI_STANZE: Record<string, string> = { appstore: 'La stanza App Store', cruscotto: 'Il cruscotto', vedetta: 'La vedetta', clienti: 'La stanza clienti', posta: 'La posta', whatsapp: 'WhatsApp', dafare: 'Le cose da fare', memoria: 'La memoria', connettori: 'I connettori', notte: 'La notte', siti: 'I siti' };

/** Il risultato dice che non e' andata: non trovato, errore, argomenti sbagliati. */
export function eFallito(r: string): boolean {
	return /^(Non |Nessun|Errore|Argomenti |Tool sconosciuto|Il tool \S+ ha dato errore|La memoria non ha trovato)/.test(r.trim());
}

/** Cosa ha trovato, con i dati veri del risultato; undefined quando non c'e' niente di utile da dire. */
export function fraseFine(nome: string, a: Record<string, any> = {}, risultato = ''): string | undefined {
	const r = String(risultato ?? '').trim();
	if (!r) return undefined;
	if (nome === 'codice_leggi') {
		if (/file di segreti/.test(r)) return 'È un file di segreti: non lo leggo.';
		if (/^Nessun file|^Non (vedo|trovo)/.test(r)) return primaFrase(r) + '.';
		const tot = /^File: .*?\((?:[^,]+), (\d+) righe\)/.exec(r);
		const parte = /qui le righe (\d+)-(\d+) di (\d+)/.exec(r);
		const sel = /Selezionato col mouse, righe (\d+)-(\d+)/.exec(r);
		let f = parte ? `Ho letto le righe ${parte[1]}-${parte[2]} di ${parte[3]}` : tot ? `Ho letto ${nPlur(Number(tot[1]), 'una riga', 'righe')}` : 'Ho letto il codice';
		if (sel) f += sel[1] === sel[2] ? `, la riga selezionata è la ${sel[1]}` : `, la parte selezionata è la ${sel[1]}-${sel[2]}`;
		return f + '.';
	}
	if (eFallito(r)) return primaFrase(r) + '.';
	switch (nome) {
		case 'progetti_cerca': {
			const n = righeDi(r).length;
			return n === 1 ? `Trovato: ${corto(r.split(' (')[0])}.` : `Trovati ${n} progetti.`;
		}
		case 'sessioni_attive':
		case 'lavori_elenco': {
			const l = righeDi(r);
			const aspettano = l.filter(x => /ti aspetta/.test(x)).length;
			return `${nPlur(l.length, nome === 'lavori_elenco' ? 'Un lavoro' : 'Una sessione aperta', nome === 'lavori_elenco' ? 'lavori' : 'sessioni aperte')}${aspettano ? `, ${aspettano === 1 ? 'una ti aspetta' : `${aspettano} ti aspettano`}` : ''}.`;
		}
		case 'memoria_cerca':
			return `La memoria ha ${nPlur(righeDi(r).filter(x => x.startsWith('[')).length || righeDi(r).length, 'un ricordo', 'ricordi')} su questo.`;
		case 'dove_risolto': {
			const n = righeDi(r).filter(x => !/^Nella memoria:|^Nel codice:/.test(x)).length;
			return `Trovato in ${nPlur(n, 'un punto', 'punti')}.`;
		}
		case 'stanza_leggi': {
			const chi = NOMI_STANZE[String(a.stanza ?? '').toLowerCase()] ?? 'La stanza';
			return `${chi} dice: ${primaFrase(r)}. Ora te lo spiego.`;
		}
		case 'app_guadagni':
		case 'store_soldi':
			return `I numeri dicono: ${primaFrase(r)}. Ora te lo spiego.`;
		case 'progetto_stato':
		case 'regole_controlla':
			return `${primaFrase(r, 100)}.`;
		case 'lavoro_nuovo':
			return /avviato/i.test(r) ? 'Il lavoro è partito.' : undefined;
		case 'guarda_schermo':
			return 'Ho letto lo schermo.';
		case 'connettore_leggi':
		case 'connettore_chiedi':
			return 'Il connettore ha risposto.';
		default:
			return undefined;
	}
}

/** Uno strumento ci mette piu' di ATTESA_MS. */
export function fraseAttesa(nome: string): string {
	if (nome === 'connettore_chiedi' || nome === 'lavoro_nuovo') return 'Ci vuole ancora un po\', resto qui.';
	if (nome === 'codice_leggi' || nome === 'guarda_schermo') return 'Sto ancora leggendo.';
	return 'Ancora un attimo, sta rispondendo.';
}
