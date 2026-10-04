# Passaggio di consegne, build 101

## Informazioni macOS, build 101

- La schermata segnalata da Andrea mostrava 1.140.0 perche' il formatter nativo leggeva
  soltanto i metadati upstream di VS Code. Il pacchetto installato era davvero Bottega
  0.1.1 build 99: `bottegaVersion`, `bottegaBuild` e `CFBundleVersion` lo confermano.
- Patch riproducibile in `scripts/patch-source.py`: i pannelli Informazioni nativo e del
  banco, incluso «Copia», espongono versione e build di Bottega dal product.json del
  pacchetto. I dettagli upstream restano nella sezione «Base VS Code». La versione
  interna di VS Code resta invariata per la compatibilita' delle estensioni.
- `scripts/package.sh` allinea anche `CFBundleShortVersionString`: il Finder smette
  di mostrare 1.140.0 come versione di Bottega.
- Test del formatter nativo per build 99/101/102, copia e metadati assenti superati;
  compilazione completa VS Code riuscita, controllo del ciclo installer superato.
- Mac 101 preparato senza riavvio. Non confondere il pacchetto pronto con la copia
  in esecuzione: `/Applications` resta 99 fino all'installazione autorizzata.
  iPhone e Watch fisici restano alla 100; il Watch richiede ancora sblocco per la prova.

## Ripresa del 4 ottobre 2026, build 100

- Ricostruiti i commit 95–98 e il lavoro locale della 99. All'inizio di questa sessione
  `/Applications/Bottega.app` era gia' alla 99, ma Osservatorio Metal, controllo SAN TLS
  e incremento build erano ancora modifiche non committate. Il codice e' conservato e verificato.
- Watch: corretti reinvio su attivazione/installazione/cambio orologio, retry dopo errore,
  precedenza della cancellazione e refresh manuale a contenuti invariati. Un dato piu' vecchio
  dello stesso Mac non sostituisce quello recente. Il pulsante mostra quando l'iPhone non e'
  raggiungibile. Le complicazioni smettono di presentare conteggi correnti dopo 20 minuti;
  la rettangolare espone l'ora dell'ultimo dato.
- iPhone e Apple Watch fisici: Release 100 firmata e installazione confermata da devicectl.
  iPhone avviato, schermata reale con ponte Tailscale collegato e 208 attivita' ricevute.
  Avvio Watch respinto da watchOS per dispositivo bloccato: richiesta all'utente di sbloccarlo.
  Non dichiarare ancora verificati ricezione sul polso, aggiornamento in background o quadrante.
- Verifiche: suite npm completa e typecheck; test lifecycle widget, processi installer e build;
  StatoNativo (mezzanotte/cache/compatibilita'); 162 layout Osservatorio con picking e collisioni;
  build Watch simulatore e Release iOS/watchOS firmate. XCTest registra 54 test offline senza errori,
  inclusi 5 OrologioTests. Xcode resta nel completamento del report con `invalidDigitCount`
  per l'SDK 27.1: il log XCTest e' passato, l'export xcresult non e' disponibile.
  I test di integrazione AssistenteTelefono richiedono abbinamento reale e sono esclusi dalla
  suite offline finale; il primo tentativo sul simulatore privo di abbinamento non e' superato.
- Renderer Metal Release 100: shader precompilati, benchmark GPU completato con 40 progetti
  e 1.800 stelle a 1440×900, 1920×1230 e 3840×2160 (30 frame, circa 1,75–1,97 ms medi sotto carico).
  I numeri nel contratto precedente sono misure della 99 in condizioni diverse.
- Mac: pacchetto 100 firmato in `dist/Bottega.app`; copia in esecuzione ancora 99.
  Prima di riavviare rispettare la richiesta di Andrea riportata sotto. Il file dei widget
  risulta aggiornato ogni minuto; la correttezza delle classificazioni delle singole sessioni
  non si deduce dalla sola freschezza del file.

## Installazione del 4 ottobre 2026, build 94

- La build 94 corregge la data del KPI AdMob quando il report è vecchio e rende leggibili le
  etichette delle ore nella Plancia stretta. Plancia 31/31, barra 7/7 e APNs 18/18 verificati
  dall'audit indipendente; il pacchetto Mac è stato firmato prima dell'installazione.
- iPhone Release 94 firmata, installata e avviata. Mac e Nucleo 94 firmati installati in
  `/Applications/Bottega.app` con un solo riavvio, dopo autorizzazione esplicita di Andrea.
  I bundle installati dell'estensione e della Plancia hanno lo stesso SHA256 dei sorgenti
  compilati. Ponte HTTPS Tailscale autenticato con certificato verificato: HTTP 200 dopo il
  riavvio, 194 attività (Claude 130, Codex 57, Cline 4, terminali 3), iPhone collegato.
- Restano aperte la verifica fisica della Live Activity sul blocco schermo (issue #1), l'ascolto
  completo di un Racconta nell'interfaccia Mac e un parlato al microfono oltre due minuti. Il
  test Xcode sul telefono era stato annullato prima dell'esecuzione perché risultava bloccato;
  non conta come test superato sulla 94. Le quattro prove fisiche della build 90 usavano lo stesso
  percorso voce iOS; i test Widget 8/8 sono passati su simulatore con i nuovi campi.

## Aggiornamento del 4 ottobre 2026, build 93

- iPhone: Release 93 firmata, installata e avviata sul dispositivo fisico; `devicectl` conferma la
  build 93. Il ponte Mac ancora alla 91 ha una connessione HTTPS Tailscale stabilita dopo l'avvio.
  La prova Xcode di integrazione sul dispositivo non è partita perché il telefono era bloccato al
  controllo iniziale. I test Widget 8/8 su simulatore e la compilazione Release 93 sono superati.
- Mac: pacchetto 93 firmato e verificato in `dist/Bottega.app`, con Nucleo 93 e bundle estensione
  identico a quello compilato. La copia in `/Applications` e il processo in esecuzione sono ancora
  alla 91. Il pacchetto è stato preparato con `scripts/package.sh --stage-only`; non è stata chiusa
  l'app. Il Nucleo 93 del pacchetto, avviato separatamente via protocollo CLI, ha riprodotto in 9,2 s
  tre frasi con tre eventi `voice.spoken` nell'ordine esatto. Andrea ha chiesto espressamente di essere
  consultato prima del riavvio.
- Voce Mac: corretto il timer di inattività che poteva fermare una risposta dopo 60 secondi di
  generazione o riproduzione. Nel Nucleo, il commit finale della trascrizione non viene più perso
  durante la chiusura del microfono; il limite push passa da 120 a 600 secondi; start/stop, vecchi
  timer e callback tardivi non devono più aprire un doppio microfono o interrompere la voce.
  Test mirato 36/36, suite completa estensione, typecheck, build Nucleo e firma del pacchetto passati.
  Resta da ascoltare un racconto lungo dall'interfaccia Mac e provare fisicamente una richiesta >2 min.
- iPhone Lavori: la scheda Codex/Cline/Terminale segue gli aggiornamenti SSE mentre è aperta e
  mostra ultimi passi ed evidenza redatti. Home, widget, Live Activity e Consigli ricevono le quattro
  fonti; test Widget 8/8, APNs 18/18, Consigli 22/22 e barra Terminale 7/7 passati. La schermata
  di blocco della Live Activity non è stata osservata fisicamente: issue #1 resta aperta.
- Il dettaglio profondo (trascrizioni, diff, azioni remote) è disponibile per Claude Code; Codex e
  Cline forniscono estratti recenti e i terminali sono osservati solo tramite shell integration.
  Non dichiarare che Melissa vede indistintamente tutto il Mac o ogni sessione storica.
- Una chiave Cline è comparsa in un output di tool in un turno precedente. Il diff e il repository
  non contengono chiavi; per una dichiarazione di produzione ruotare le chiavi DeepSeek/OpenRouter
  di Cline e aggiornare eventuali copie usate da Melissa, senza pubblicarle nei log.

## Aggiornamento del 4 ottobre 2026

- La prova CLI con il Nucleo installato ha individuato un ulteriore difetto della build 90: tre frasi
  complete inviate senza separatore venivano fuse in due segmenti. Con lo spazio finale per frase il
  Nucleo ha emesso tre eventi `voice.spoken` distinti, con testo identico alle tre frasi, tre marker
  audio e nessun avviso, in 11,4 secondi. La build 91 include questa correzione nell'estensione.

- iPhone: release 91 firmata, installata e avviata sul dispositivo fisico; `devicectl` conferma la build 91.
- Prove reali su iPhone con lo stesso codice applicativo della build 91: quattro test di integrazione
  superati sulla build 90 con il Mac acceso, inclusi attività Codex,
  voce Agnes e DeepSeek diretta, racconto della stanza e autonomia quando il Mac diventa irraggiungibile.
  I dieci test automatici del WebSocket ElevenLabs sono superati sul simulatore.
- Mac e Nucleo: build 91 firmata installata in `/Applications/Bottega.app`, app riaperta e Nucleo 91
  in esecuzione. Il controllo HTTPS autenticato dopo il riavvio restituisce 200 con 184 attività delle
  quattro fonti. Il bundle dell'estensione installato ha lo stesso SHA256 di quello testato. Il
  controllo iniziale senza gettone nella build 90 aveva restituito 429: era il limite ai tentativi
  non autenticati, non un guasto del ponte.
- «Racconta» chiude esplicitamente la sessione ElevenLabs
  dopo l'ultima frase, conserva «ferma» finché l'audio suona e non apre il microfono di conferma prima
  della fine della voce. Il prompt percorre il codice rilevante invece di fermarsi al riepilogo. Il
  registro conserva le ultime 30 righe fra i riavvii; i log indicano quanti segmenti e byte PCM
  sono arrivati senza scrivere il testo o le chiavi. La prova Python sul WebSocket reale ha ricevuto
  audio per tre frasi, tre marker di turno e il marker finale. La prova completa dall'IDE all'altoparlante
  della build 91 resta una verifica di ascolto fisico, non eseguita dall'audit da codice.
- Cruscotto: token Codex e Cline, durata dei turni Codex e costo riportato da Cline compaiono per fonte
  e periodo, con N/D quando il dato manca. Le cifre principali Claude restano separate.
- Home, Lavori e barra Terminale: azione per avviare una nuova sessione Claude Code, Codex, Cline o
  Terminale nella stessa finestra dell'IDE, senza inviare automaticamente un compito. Test estensione
  completi sulla build 91, typecheck e sette test della barra Terminale superati.
- Issue GitHub #1 resta aperta: il difetto Live Activity sul blocco schermo era documentato fino alla
  build 74; le modifiche 76–78 non hanno una verifica fisica registrata. L'audit del codice attuale non
  trova un difetto certo, quindi non dichiariamo risolta la schermata di blocco.

## Verifiche fisiche ancora aperte dopo la build 91

- Un racconto lungo dall'interfaccia Mac con ascolto reale fino all'ultima frase, confrontando i nuovi
  conteggi nel registro Melissa e in `~/.bottega/nucleo.log` se si interrompe.
- Una richiesta continua al microfono Mac oltre due minuti e la Live Activity sulla schermata di blocco
  dell'iPhone. La prima ha test automatici di rotazione, la seconda richiede osservazione fisica.
- La cronologia Mac persa prima della build 90 non si può ricostruire dal nuovo archivio; i turni nuovi
  vengono persistiti e sincronizzati con l'iPhone.

## Stato precedente: build 89

4 ottobre 2026. Bottega 0.1.0 build 89 installata sull'iPhone di prova. L'installazione Mac è l'ultimo passo di questa consegna.

## Fatto

- Home, Lavori, barra di Melissa, barra di stato e menu del Mac usano il registro osservato di Claude Code, Cline, Codex e terminali integrati. Lo stesso registro arriva all'iPhone e ai suoi conteggi. Le sessioni concluse restano consultabili; quelle senza prova di attività corrente mostrano uno stato non confermato.
- Il Cruscotto mostra conteggi per fonte e un grafico giornaliero delle attività aggiornate. Ore, token e costi restano metriche di Claude Code, perché le altre fonti non forniscono misure comparabili.
- Melissa su iPhone usa direttamente DeepSeek o Agnes e la voce ElevenLabs. Le stanze e Lavori hanno «Racconta con Melissa» con testo e audio in streaming. La cronologia del Mac rimane visibile anche durante una caduta del ponte; il testo della risposta in corso arriva tramite eventi.
- Il ponte recupera i vecchi abbinamenti con HTTPS sull'IP Tailscale e verifica l'impronta del certificato. I nuovi QR portano già l'impronta. Non ripiega su HTTP verso l'IP, bloccato da iOS.
- Sul Mac il timer della conversazione segue le trascrizioni parziali. Apple Speech ruota la richiesta ogni 45 secondi e conserva il testo tra finestre, con invio dopo 1,8 secondi di pausa.
- La barra Terminale resta sopra il pannello, con menu al passaggio del puntatore e accesso alle sessioni. La voce ElevenLabs su iPhone aspetta la fine globale del racconto e rinnova il limite di inattività mentre arrivano frammenti audio.
- Se il Mac non risponde, Lavori e la testata dell'iPhone mostrano l'ultimo registro salvato con ora esplicita. Melissa e Siri possono usarlo come dato storico; una nuova associazione o lo scollegamento cancellano il registro del Mac precedente.

## Verificato

- Suite dell'estensione, typecheck e build superati; test del Cruscotto, del ponte e del parlato lungo superati.
- Build iOS firmata compilata, installata e avviata su iPhone. Schermo reale: collegamento al Mac verde, cronologia visibile e attività delle quattro fonti presenti.
- App macOS e Nucleo installati con build 87; ponte HTTP/HTTPS attivo e connessione HTTPS dell'iPhone stabilita. Home Mac mostra Cline, Codex, terminale e conteggi coerenti.
- Barra Terminale build 88: compilazione VS Code, typecheck e 6 test superati. Voce iOS: 10 test Swift offline e prova reale ElevenLabs superati; il racconto lungo ha prodotto 23,6 secondi di PCM, incluso audio dopo la richiesta di chiusura.
- Build iOS 89 firmata compilata, installata e avviata sull'iPhone fisico. Versione 89 confermata via `devicectl`. Le modifiche offline sono state verificate in compilazione, senza automazione dell'interfaccia.

## Verifiche ancora utili

- Pronunciare sul Mac una richiesta continua di oltre due minuti e controllare che venga trascritta e riceva risposta. Il caso su tre finestre è coperto da test automatico, ma manca una prova con microfono reale dopo l'installazione.
- Toccare «Racconta con Melissa» in Lavori su iPhone e ascoltare il racconto completo. La prova reale ElevenLabs copre la sintesi ma non il pulsante né l'altoparlante dell'iPhone; il percorso diretto DeepSeek, Agnes e una Stanza era stato provato su dispositivo nella build 86.
- Verificare la cronologia parziale mentre Melissa parla sul Mac e la lettura del registro salvato con il Mac irraggiungibile. Le due strade sono compilate e coperte dai test del ponte, ma non provate a mano nella build 89.
- [Issue #1](https://github.com/andreapianidev/bottega-ide/issues/1), Live Activity nera sulla schermata di blocco, resta aperta: questo intervento non ne ha verificato la soluzione.
