# Passaggio di consegne, build 87

4 ottobre 2026. Bottega 0.1.0 build 87 installata su macOS e sull'iPhone di prova.

## Fatto

- Home, Lavori, barra di Melissa, barra di stato e menu del Mac usano il registro osservato di Claude Code, Cline, Codex e terminali integrati. Lo stesso registro arriva all'iPhone e ai suoi conteggi. Le sessioni concluse restano consultabili; quelle senza prova di attività corrente mostrano uno stato non confermato.
- Il Cruscotto mostra conteggi per fonte e un grafico giornaliero delle attività aggiornate. Ore, token e costi restano metriche di Claude Code, perché le altre fonti non forniscono misure comparabili.
- Melissa su iPhone usa direttamente DeepSeek o Agnes e la voce ElevenLabs. Le stanze e Lavori hanno «Racconta con Melissa» con testo e audio in streaming. La cronologia del Mac rimane visibile anche durante una caduta del ponte; il testo della risposta in corso arriva tramite eventi.
- Il ponte recupera i vecchi abbinamenti con HTTPS sull'IP Tailscale e verifica l'impronta del certificato. I nuovi QR portano già l'impronta. Non ripiega su HTTP verso l'IP, bloccato da iOS.
- Sul Mac il timer della conversazione segue le trascrizioni parziali. Apple Speech ruota la richiesta ogni 45 secondi e conserva il testo tra finestre, con invio dopo 1,8 secondi di pausa.

## Verificato

- Suite dell'estensione, typecheck e build superati; test del Cruscotto, del ponte e del parlato lungo superati.
- Build iOS firmata compilata, installata e avviata su iPhone. Schermo reale: collegamento al Mac verde, cronologia visibile e attività delle quattro fonti presenti.
- App macOS e Nucleo installati con build 87; ponte HTTP/HTTPS attivo e connessione HTTPS dell'iPhone stabilita. Home Mac mostra Cline, Codex, terminale e conteggi coerenti.

## Verifiche ancora utili

- Pronunciare sul Mac una richiesta continua di oltre due minuti e controllare che venga trascritta e riceva risposta. Il caso su tre finestre è coperto da test automatico, ma manca una prova con microfono reale dopo l'installazione.
- Toccare «Racconta con Melissa» in Lavori su iPhone e controllare il primo audio su rete reale. Il percorso vocale diretto era già stato provato su dispositivo per DeepSeek, Agnes e una Stanza; il nuovo pulsante Lavori è stato compilato e installato.
- [Issue #1](https://github.com/andreapianidev/bottega-ide/issues/1), Live Activity nera sulla schermata di blocco, resta aperta: questo intervento non ne ha verificato la soluzione.
