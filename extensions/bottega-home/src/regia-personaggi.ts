// La regia dei personaggi per la mod melissa di Claude Code (docs/CONTRATTI.md, 9.11, «Sul Mac la regia sta in un posto
// solo»). La mod non decide piu' chi parla: lo chiede qui, con POST /v1/regia sul socket locale (src/regia-personaggi-host.ts),
// e riceve chi parla, con che voce e con che prompt. Le regole sono quelle della barra (src/personaggi.ts): sul Mac una
// copia sola, l'altra e' sull'iPhone, che deve funzionare a Mac spento.

import * as P from './personaggi';
import type { Occasione, Voluto } from './personaggi';

type Strumento = ReturnType<typeof P.strumentoPassaParola>;

/** Chi parla dopo, pronto per la mod: la voce, il prompt di sistema (la mod ci aggiunge ora, cartella, memoria e
 *  ricordi) e l'istruzione che chiude il messaggio dell'utente, dopo la chiacchierata. */
export interface OspiteRegia {
	chiave: string;
	nome: string;
	voce: string;
	sistema: string;
	istruzione: string;
	/** a chi puo' dare la parola con passa_parola; [] nessuno, e allora niente strumento */
	offerte: string[];
	strumento: Strumento | null;
	/** a chi il codice gli ha detto di darla: risponde anche se il modello non chiama lo strumento */
	deciso: string | null;
}

/** Lo stato di una sessione della mod: chi e' entrato e quando, per i turni e i freni. */
interface Sessione {
	dallUltimoOspite: number;
	ultimoOspite: string;
	recenti: string[];
	ospiteCronacaAt: number;
	umoreAt: number;
	usata: number;
}

export interface RegiaDeps {
	/** chi vuole sentire Andrea: chiVuole della barra (DeepSeek Flash, al piu' 2,5 s) */
	chiVuole(frase: string): Promise<Voluto | null>;
	/** una frase di Andrea nella chiacchierata della mod, per gli impegni di Krista (src/impegni.ts) */
	ascolta?(frase: string): void;
	caso?: () => number;
	ora?: () => number;
	log?: (riga: string) => void;
}

/** Una sessione ferma da sei ore si dimentica. */
const SESSIONE_MS = 6 * 3600_000;

/** Sa solo quello che gli si passa: lo dicono tutti i prompt dei personaggi. */
const SA_SOLO = "Sai solo quello che c'e' nella chiacchierata e nel contesto qui sotto: non inventare stati di progetti, lavori o sessioni.";

export class RegiaPersonaggi {
	private readonly sessioni = new Map<string, Sessione>();
	constructor(private readonly d: RegiaDeps) {}

	private adesso(): number {
		return this.d.ora?.() ?? Date.now();
	}

	private sessione(id: unknown): Sessione {
		const k = typeof id === 'string' && id ? id.slice(0, 120) : 'senza-sessione';
		const now = this.adesso();
		for (const [x, s] of this.sessioni) if (now - s.usata > SESSIONE_MS) this.sessioni.delete(x);
		let s = this.sessioni.get(k);
		if (!s) {
			// il contatore parte da 1: un ospite puo' entrare anche nella prima risposta (9.11)
			s = { dallUltimoOspite: 1, ultimoOspite: '', recenti: [], ospiteCronacaAt: 0, umoreAt: 0, usata: now };
			this.sessioni.set(k, s);
		}
		s.usata = now;
		return s;
	}

	private conVoce(): string[] {
		return P.ORDINE.filter(k => P.PERSONAGGI[k]?.voce);
	}

	private entra(s: Sessione, chi: string): void {
		s.dallUltimoOspite = 0;
		s.ultimoOspite = chi;
		s.recenti = [...s.recenti.filter(k => k !== chi), chi];
	}

	/** Una richiesta della mod: `azione` dice quale. Un'azione sconosciuta e' un errore (400 dal servizio). */
	async gestisci(x: any): Promise<Record<string, unknown>> {
		const s = this.sessione(x?.sessione);
		switch (x?.azione) {
			case 'frase': return this.frase(s, x);
			case 'chivuole': return this.chiVuole(s, x);
			case 'parola': return this.parola(s, x);
			case 'chiusa': return this.chiusa(x);
			case 'cronaca': return this.cronaca(s, x);
			default: throw new Error(`azione sconosciuta: ${String(x?.azione)}`);
		}
	}

	/**
	 * Andrea ha detto `frase` nella chiacchierata della mod, con `chi` al telefono. Il nome esatto dopo "passami" passa
	 * subito (`passa`); altrimenti, con Melissa, l'eventuale invito a tirare dentro un personaggio, deciso o facoltativo,
	 * con lo strumento per dare la parola. Niente modello: risponde subito.
	 */
	private frase(s: Sessione, x: any): Record<string, unknown> {
		const frase = String(x?.frase ?? '');
		const chi = P.esiste(x?.chi) ? x.chi : 'melissa';
		this.d.ascolta?.(frase);
		const passa = P.chiChiede(frase);
		if (passa && passa !== chi && (passa === 'melissa' || this.conVoce().includes(passa))) return { passa };
		if (chi !== 'melissa') return { passa: null, invito: '', offerte: [], strumento: null, deciso: null };
		// la prima frase di una conversazione: si riparte da 1, come nella barra all'apertura
		if (x?.prima === true) s.dallUltimoOspite = 1;
		const adatto = P.perArgomento(frase) ?? P.perSfogo(frase);
		const puo = s.dallUltimoOspite >= 1 && (s.dallUltimoOspite >= 2 || !adatto || adatto !== s.ultimoOspite);
		const scelto = puo ? P.ospiteDellaFrase(frase, s.ultimoOspite, this.d.caso?.()) : null;
		const vivo = s.dallUltimoOspite >= 2 || (!!adatto && scelto === adatto);
		// lo strumento sempre, come nella barra: chi riceve la parola risponde; l'invito solo quando c'e' un scelto
		const offerte = this.conVoce();
		const conScelto = !!scelto && offerte.includes(scelto);
		return {
			passa: null,
			invito: conScelto ? P.invito(scelto, vivo) : '',
			offerte,
			strumento: offerte.length ? P.strumentoPassaParola(offerte) : null,
			deciso: conScelto && vivo ? scelto : null,
		};
	}

	/**
	 * Chi vuole sentire Andrea, capito dal modello (9.11): passare la chiamata, il parere di uno, il giro a piu' voci.
	 * Con la regia di Melissa (`regia`, l'istruzione della sua battuta al posto della risposta) e i prompt di chi parla.
	 */
	private async chiVuole(s: Sessione, x: any): Promise<Record<string, unknown>> {
		const t0 = this.adesso();
		const chi = P.esiste(x?.chi) ? x.chi : 'melissa';
		const v = await this.d.chiVuole(String(x?.frase ?? ''));
		const riga = `${P.rigaChiVuole(v)} (${this.adesso() - t0} ms)`;
		this.d.log?.(`regia per la mod, chi vuole: ${riga}`);
		const conVoce = this.conVoce();
		const g = P.giroDiVoci(v, conVoce, chi);
		const passa = v?.passa && v.passa !== chi && (v.passa === 'melissa' || conVoce.includes(v.passa)) ? v.passa : null;
		const chiede = !g.voci.length && !passa && chi === 'melissa' ? (v?.chiede.find(k => conVoce.includes(k)) ?? null) : null;
		const regia = chi === 'melissa' && passa !== 'melissa' ? P.regia({ passa, chiede, voci: g.voci }) : '';
		const nuovo = passa && passa !== 'melissa' ? passa : null;
		const voci = g.voci.map((k, i) => {
			this.entra(s, k);
			const perche = k === nuovo ? 'Melissa ti ha appena passato la chiamata, e Andrea vuole sentire anche gli altri' : 'Andrea vuole sentire tutti, uno alla volta, e tocca a te';
			return this.pronto(k, `${P.PERSONAGGI[k]!.carattere} Sei in una chiacchierata a voce con Melissa, Andrea e gli altri di Mr. Robot. ${perche}. ${SA_SOLO} ${P.REGOLE}`, P.istruzioneGiro(k, i === 0));
		});
		const somme = g.chiude && voci.length
			? `Hanno detto la loro ${P.insieme(voci.map(o => o.nome))}. Tira le somme tu in una o due frasi, rivolta ad Andrea: cosa ne esce, senza ripetere le loro parole e senza fare domande agli altri. Solo le parole che diresti.`
			: '';
		return { riga, passa, chiede, regia, voci, chiude: g.chiude, somme, ospite: chiede ? this.ospite(s, chiede, { ultima: false }) : null };
	}

	/**
	 * Chi parla dopo la battuta di `da` ('melissa' o un personaggio): quello di passa_parola (`argomenti`, fra le
	 * `offerte`), oppure, senza la chiamata, il `deciso`; mai se il cervello non aveva lo strumento (`conStrumento`).
	 * Con `ospite` il prompt di chi risponde. `ultima`: chi risponde non passa la parola a nessuno (lo e' sempre dopo un
	 * personaggio). `cronaca`: nella cronaca il prompt dice cosa fa Claude, e `poi` e' a chi il primo ospite di
	 * un'attesa chiede dopo.
	 */
	private parola(s: Sessione, x: any): Record<string, unknown> {
		const da = P.esiste(x?.da) ? x.da : 'melissa';
		const cronaca = x?.cronaca === true;
		if (da === 'melissa' && !cronaca && x?.ultima !== true) s.dallUltimoOspite++;
		const offerte = (Array.isArray(x?.offerte) ? x.offerte : []).filter((k: unknown): k is string => P.esiste(k) && !!P.PERSONAGGI[k]?.voce);
		const deciso = P.esiste(x?.deciso) && offerte.includes(x.deciso) ? x.deciso : null;
		const daStrumento = x?.conStrumento === true ? P.passaParolaA(typeof x?.argomenti === 'string' ? x.argomenti : undefined, offerte) : null;
		const chi = x?.conStrumento === true ? (daStrumento ?? deciso) : null;
		if (chi) this.d.log?.(`regia per la mod: ${P.nomeDi(da)} da' la parola a ${chi}${daStrumento ? '' : ', invito deciso senza la chiamata'}`);
		if (!chi || chi === da) return { chi: null, ospite: null };
		const ultima = da !== 'melissa' || x?.ultima === true;
		const poi = P.esiste(x?.poi) && x.poi !== chi ? x.poi : null;
		return { chi, ospite: this.ospite(s, chi, { daChi: da !== 'melissa' ? da : null, ultima, cronaca, poi }) };
	}

	/** Melissa chiude dopo l'ospite `dopo`: senza domande e senza strumento, la parola torna ad Andrea. */
	private chiusa(x: any): Record<string, unknown> {
		const nome = P.nomeDi(P.esiste(x?.dopo) ? x.dopo : '');
		return {
			istruzione: `Hanno appena detto la loro. Chiudi tu in una o due frasi, rivolta ad Andrea, riprendendo il filo o rispondendo a modo tuo, senza fare domande a ${nome === 'Melissa' ? 'loro' : nome} ne' agli altri. Solo le parole che diresti.`,
		};
	}

	/**
	 * Nella cronaca (e nel riassunto di fine turno, `finale`): il fatto che chiama un ospite, con i freni (le prime due
	 * battute del turno, la pausa dall'ultimo ospite), l'invito per Melissa con il fatto e lo strumento. Le stesse
	 * funzioni della barra (occasione, frenoOspite).
	 */
	private cronaca(s: Sessione, x: any): Record<string, unknown> {
		const now = this.adesso();
		const conVoce = this.conVoce();
		const occ = P.occasione(String(x?.appunti ?? ''), {
			recenti: s.recenti,
			erroriDiFila: Number.isFinite(x?.erroriDiFila) ? x.erroriDiFila : undefined,
			fine: x?.finale === true ? 'Claude ha finito il turno' : undefined,
			silenzioMs: Number.isFinite(x?.silenzioMs) ? x.silenzioMs : 0,
			richiesta: typeof x?.richiesta === 'string' ? x.richiesta : '',
			dallUmoreMs: now - s.umoreAt,
		});
		const valido = occ && conVoce.includes(occ.chi) ? occ : null;
		const freno = !valido ? null : (Number(x?.battute) || 0) < 2 ? 'prime due battute' : P.frenoOspite(valido.tipo, now - s.ospiteCronacaAt);
		if (!valido) return { occasione: null, freno: null, riga: '', invito: '', offerte: [], strumento: null, deciso: null };
		if (freno) return { occasione: null, freno, riga: `ospite: niente, ${valido.tipo} fermato da ${freno}`, invito: '', offerte: [], strumento: null, deciso: null };
		s.ospiteCronacaAt = now;
		if (valido.tipo === 'umore') s.umoreAt = now;
		const poi = valido.tipo === 'attesa' ? this.poi(s, valido) : null;
		return {
			occasione: { ...valido, poi },
			freno: null,
			riga: `ospite: ${valido.chi} per ${valido.tipo} (${valido.fatto})`,
			invito: invitoCronaca(valido.chi, valido.fatto),
			offerte: [valido.chi],
			strumento: P.strumentoPassaParola([valido.chi]),
			deciso: valido.chi,
		};
	}

	/** In un'attesa il primo ospite chiede a un secondo: un altro con `attesa`, o se non c'e' un altro qualsiasi. */
	private poi(s: Sessione, o: { tipo: Occasione; chi: string }): string | null {
		const altri = this.conVoce().filter(k => k !== o.chi);
		return P.aTurno(altri.filter(k => P.PERSONAGGI[k]!.occasioni.includes('attesa')), s.recenti) ?? P.aTurno(altri, s.recenti);
	}

	/** Il prompt di chi risponde: nella chiacchierata come nel giro a tre della barra, nella cronaca col suo campo.
	 *  Nella chiacchierata nel 40% dei casi passa la parola a un altro con `chiacchiera` (deciso dal codice). */
	private ospite(s: Sessione, chi: string, o: { daChi?: string | null; ultima: boolean; cronaca?: boolean; poi?: string | null }): OspiteRegia {
		const p = P.PERSONAGGI[chi]!;
		this.entra(s, chi);
		const daChi = o.daChi ?? null;
		const passabili = P.daChiacchiera([chi, ...(daChi ? [daChi] : [])]).filter(k => P.PERSONAGGI[k]?.voce);
		const caso = this.d.caso ?? Math.random;
		const passa = o.ultima ? null
			: o.cronaca ? (o.poi && o.poi !== chi && o.poi !== daChi ? o.poi : null)
			: passabili.length && caso() < 0.4 ? passabili[Math.min(passabili.length - 1, Math.floor(caso() * passabili.length))]! : null;
		const passaggio = passa ? ` Poi chiedi a ${P.nomeDi(passa)} cosa ne pensa. ${P.chiamaCon(passa)}` : '';
		if (o.cronaca) {
			const chiede = daChi ? `${P.nomeDi(daChi)} ti ha appena chiesto cosa ne pensi` : 'Melissa ti ha appena chiesto un parere';
			return this.pronto(
				chi,
				`${p.carattere} Andrea fa altro e Melissa gli racconta a voce cosa sta facendo Claude Code nel suo terminale; ${chiede}. Il tuo campo e' ${p.ruolo_cronaca}: parla solo di quello. Sai solo quello che trovi qui sotto: non inventare file, risultati o errori. ${P.REGOLE}`,
				`Rispondi in una o due frasi brevi, a modo tuo, con qualcosa di utile: un dubbio, un rischio, un consiglio.${passaggio} Solo le parole che diresti.`,
				passa,
			);
		}
		const chiede = daChi ? `${P.nomeDi(daChi)} ti ha appena chiesto qualcosa` : `Melissa ti ha appena tirato in mezzo, e tocca a te per ${P.RUOLI[chi] ?? 'dire la tua'}`;
		const rispondi = daChi ? `Rispondi a ${P.nomeDi(daChi)}, davanti ad Andrea` : 'Rispondi alla domanda di Melissa, rivolto a lei (se dici un nome e\' Melissa), mentre Andrea ascolta,';
		return this.pronto(
			chi,
			`${p.carattere} Sei in una chiacchierata a voce con Melissa, Andrea e gli altri di Mr. Robot; Andrea lavora con Claude Code. ${chiede}. ${SA_SOLO} ${P.REGOLE}`,
			`${rispondi} in una o due frasi, a modo tuo e sul punto: qualcosa che gli serve davvero; puoi punzecchiare Melissa, ma da amici.${passaggio} Solo le parole che diresti.`,
			passa,
		);
	}

	private pronto(chi: string, sistema: string, istruzione: string, passa: string | null = null): OspiteRegia {
		const p = P.PERSONAGGI[chi]!;
		const offerte = passa ? [passa] : [];
		return { chiave: chi, nome: p.nome, voce: p.voce, sistema, istruzione, offerte, strumento: offerte.length ? P.strumentoPassaParola(offerte) : null, deciso: passa };
	}
}

/**
 * L'invito deciso della cronaca, con il fatto dentro, cosi' la domanda a `chi` parla di quello, e solo dal suo campo. A
 * chi ha `umore` (Krista) il lato umano anche di un fatto tecnico, mai dettagli che non puo' sapere. '' senza nessuno.
 */
export function invitoCronaca(chi: string | null, fatto: string): string {
	const p = chi && P.esiste(chi) ? P.PERSONAGGI[chi]! : undefined;
	if (!chi || !p) return '';
	const domanda = p.occasioni.includes('umore')
		? `una domanda rivolta a ${p.nome} dal suo campo (${p.ruolo_cronaca}): il lato umano di questo fatto, come ci sta lavorando Andrea, se conviene fermarsi, come decidere, mai dettagli di file, errori o comandi`
		: `una domanda rivolta a ${p.nome} proprio su questo, e solo dal suo campo (${p.ruolo_cronaca})`;
	return ` Adesso tira dentro ${p.nome} di Mr. Robot (${p.ruolo_cronaca}), per un fatto preciso: ${fatto}. Raccontalo tu in breve e chiudi con ${domanda}. ${P.chiamaCon(chi)}`;
}
