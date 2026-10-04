# Passaggio di consegne, build 89

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
