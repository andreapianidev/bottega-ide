# Contratti tra i pezzi della Bottega

Questo file e' la fonte unica delle interfacce tra Nucleo (Swift), Memoria (Node), estensione
(TypeScript) e plancia (webview). Chi cambia un contratto aggiorna questo file nello stesso giro.

```
Bottega.app (VS Code 1.140, Electron)
  extensions/bottega-home  --stdio JSON-lines-->  Bottega Nucleo.app (Swift, nativo)
        |  postMessage                               voce, sfera Metal, scorciatoia globale,
        v                                            notifiche, barra dei menu, Apple Intelligence,
  plancia (webview)                                  embedding, stato del sistema
        |
  ~/.bottega/memoria  <-- hook di Claude Code (memoria/hooks), server MCP (memoria/mcp.mjs)
```

Regole comuni:
- Testi visibili in italiano, frasi normali, niente lineette lunghe (U+2014, U+2013), niente maiuscolo forzato.
- Solo Apple Silicon, macOS 27. Nessuna dipendenza di terze parti nel Nucleo (solo framework Apple)
  e nessuna dipendenza npm a runtime nella Memoria (solo `node:` built-in, Node 22).
- Le chiavi non entrano mai nel repository. La chiave Agnes si legge da `AGNES_API_KEY` nell'ambiente,
  altrimenti da `~/.secrets/agnes-ai.env`, altrimenti dal SecretStorage dell'estensione.
- Nessuno lancia la Bottega, simulatori o catture di schermo per «verificare»: compila, misura, e
  scrivi cosa deve guardare Andrea.

## 1. Nucleo (Swift) <-> estensione

Eseguibile: `Bottega Nucleo.app/Contents/MacOS/BottegaNucleo`, bundle id `com.andreapiani.bottega.nucleo`,
`LSUIElement = YES`. Dentro la Bottega sta in
`Bottega.app/Contents/Resources/app/extensions/bottega-home/nucleo/Bottega Nucleo.app`.
In sviluppo: `nucleo/build/Bottega Nucleo.app` (prodotto da `nucleo/build.sh`).

Permessi (2/10/2026): lanciato dall'estensione, il Nucleo ha Bottega.app come processo responsabile, e macOS legge da
li' la spiegazione dei permessi che usa: `NSMicrophoneUsageDescription` e `NSSpeechRecognitionUsageDescription` stanno
anche nell'Info.plist della Bottega (le mette `scripts/package.sh`), senza macOS chiude il Nucleo. Il rilancio con la
responsabilita' separata (`Autonomo.swift`, `BOTTEGA_NUCLEO_AUTONOMO`) non spostava il responsabile ed e' stato tolto.
Il registro dice dopo 3 s dall'apertura `segnale del microfono: N blocchi, M con suono` (M = 0 vuol dire silenzio da macOS).
Solo arm64, macOS 27+, solo framework Apple, firma ad hoc.

### Modalita' servizio (default, lanciato dall'estensione)

Una riga JSON per messaggio su stdin/stdout, UTF-8. Lo stderr e' log libero.

- Richiesta (estensione -> Nucleo): `{"id": 7, "cmd": "voice.speak", "text": "Ciao"}`
- Risposta: `{"id": 7, "ok": true, ...campi}` oppure `{"id": 7, "ok": false, "error": "messaggio in italiano"}`
- Evento (Nucleo -> estensione, senza id): `{"event": "voice.final", "text": "apri peak"}`
- L'`id` torna identico (numero o stringa). Le richieste sono servite in parallelo: le risposte possono
  arrivare in ordine diverso da quello di invio.
- All'avvio il Nucleo emette `{"event":"ready","version":"..."}`. Quando stdin si chiude (l'estensione
  e' morta) il Nucleo esce da solo; `{"cmd":"quit"}` lo chiude in modo pulito.

| cmd | argomenti | risposta | note |
|---|---|---|---|
| `ping` | | `version` | |
| `capabilities` | | `foundationModels: bool`, `speechLocaleInstalled: bool` (non c'e' piu' un modello vocale locale: vale true quando la chiave ElevenLabs c'e', cioe' quando la trascrizione e' usabile), `speechLocale`, `embedding: bool`, `metal: string`, `memoryGB`, `cores`; in piu': `version`, `foundationModelsReason?` (se non disponibile), `speechBackend` (`elevenlabs:scribe_v2_realtime`), `sttSecondsThisSession` (secondi di audio mandati alla trascrizione da quando il Nucleo e' partito), `embeddingDimension`, `ttsEngine` (`elevenlabs` o `apple`), `ttsModel`, `elevenLabsConfigured`, `elevenLabsVoice`, `elevenLabsCharsThisMonth`, `appleVoice`, `echoCancellation` (`hardware` o `software`, l'ultimo percorso usato in conversazione), `echoCancellationTested: bool`, `conversing: bool`, `hotkey` (etichetta o null) | |
| `voice.listen` | `mode`: `push` o `utterance`, `locale` | `backend` | trascrizione in tempo reale, con il riconoscimento vocale di Apple come Avo (vedi `voice.converse.start`; ElevenLabs con `BOTTEGA_STT=elevenlabs`). `utterance` finisce da sola alla prima frase che il server chiude (~0.8 s di silenzio), o dopo 8 s se nessuno parla; `push` resta aperto fino a `voice.stop` (massimo 120 s). Se Melissa sta parlando viene zittita: fuori dalla conversazione il microfono e' chiuso mentre lei parla. Se ElevenLabs non risponde: risposta di errore ed evento `voice.state {state:"error", message}` |
| `voice.stop` | | | chiude l'ascolto, chiude a mano la frase (commit) ed emette l'ultimo `voice.final` (~0.25 s dopo) |
| `voice.speak` | `text`, `voice?`, `append?: bool`, `final?: bool`, `model?` | `engine` | evento `voice.spoken {text, engine, chi}` quando un pezzo e' stato davvero ascoltato; `chi` e' il nome di chi l'ha detto (`Melissa`, oppure il `nome` del personaggio la cui `voce` in `~/.bottega/personaggi/*.json` e' quella del pezzo; la voce predefinita, quella di Apple e una voce sconosciuta sono `Melissa`). Senza `append` il testo e' una risposta intera. Con `append: true` l'estensione manda i pezzi man mano che l'LLM li scrive: ogni frase completa porta uno spazio finale, altrimenti il Nucleo salderebbe il punto alla parola seguente e cambierebbe i confini audio. La prima frase (o il primo inciso lungo) parte subito, poi una frase alla volta; `final: true` (anche con `text` vuoto) chiude il turno e invia `close_socket` a ElevenLabs, che consegna l'audio rimanente e `is_final`. Il Nucleo riapre poi una connessione calda. `model` sceglie il modello ElevenLabs (default `eleven_v4_turbo`). `voice`: `apple` forza la voce Apple, `com.apple...` sceglie una voce Apple precisa, qualsiasi altro valore e' un voice id ElevenLabs |
| `voice.scalda` | `voci: [{voce, testi}]` | `mancanti`, `inCoda` | prepara l'audio delle frasi brevi che si dicono mentre il modello pensa (riempitivi, 9.11). `voce` e' l'id ElevenLabs del personaggio, `""` per la voce di Melissa; un id non valido si salta. Risponde subito: le frasi che non sono gia' su disco si generano dopo, una alla volta, su un socket a parte, mai mentre la voce parla. Al massimo 300 testi per richiesta, ciascuno di 120 caratteri al massimo. Ogni testo si taglia nei pezzi in cui lo taglierebbe `voice.speak` (prima frase o primo inciso lungo, poi frasi intere), e la cache e' per pezzo: `mancanti` conta i pezzi non ancora pronti, `inCoda` quelli in coda. Cache in `~/.bottega/nucleo/voce-cache/` (cartella 700, file 600), un file `<sha256 della chiave>.pcm` (PCM 16 bit LE, mono, 24 kHz) per chiave `modello\|voce\|stability 0.5\|similarity 0.75\|testo pulito`, condivisa con la modalita' isola. Poi qualunque pezzo di `voice.speak` (o di `/parla`) con lo stesso testo, voce e modello parte dal disco, senza aspettare ElevenLabs e senza contare caratteri, purche' prima non ci sia altro audio ancora in arrivo; altrimenti va dal vivo. Il log lo dice (`voce: dalla cache «...»`) e per ogni turno scrive `voce: primo suono N ms dopo la richiesta`. Senza chiave ElevenLabs: errore |
| `voice.stopSpeaking` | | | interruzione (barge-in): silenzio subito, coda svuotata |
| `voice.converse.start` | `locale?` | `echoCancellation`, `backend` | modalita' conversazione: microfono sempre aperto, ogni frase che il server chiude (~0.8 s di silenzio) e' un turno dell'utente (`voice.final {text, mode:"converse"}`). Trascrizione (2/10/2026, `Voice/AppleSTT.swift`): come la Melissa di Avo Agency AI, SFSpeechRecognizer it-IT sul Mac,
i buffer del microfono passati cosi' come sono, risultati parziali, una richiesta nuova per ogni frase, frase chiusa
dopo 1,8 s senza parole nuove o quando il riconoscitore la da' per finita. Niente voice processing (VPIO affama il
riconoscitore). Come in Avo Agency AI, dalla frase chiusa alla fine della voce il microfono e' spento davvero (motore
audio fermo, niente pallino arancione di macOS) e si riapre 250 ms dopo che Melissa ha finito, oppure quando
l'estensione chiude un turno senza voce con `orb.state` `listening` (niente eco, niente interruzioni a voce; si
interrompe con un tocco). L'estensione resta su «parlo» finche' `voice.state` non lascia `speaking`. Permesso "Riconoscimento vocale" per Bottega Nucleo, chiesto
con lo stesso tempo massimo del microfono. ElevenLabs realtime resta con `BOTTEGA_STT=elevenlabs`. Con ElevenLabs:
si manda tutto l'audio, anche il silenzio: fino al 2/10/2026 passava solo quello sopra una soglia fissa (livello 0,08, circa -37 dBFS), e il microfono del MacBook Air senza voice processing restava sotto, quindi a ElevenLabs non arrivava niente. La conversazione si chiude dopo 60 s di silenzio, l'audio in piu' ha un tetto. Ogni apertura del microfono riaccende la trascrizione (`setMuted(false)` in `Listener.open`): la sessione tenuta calda 30 s dopo la chiusura poteva restare muta da una risposta interrotta (voce spenta mentre Melissa parlava), e la conversazione dopo restava in ascolto senza trascrivere niente (4/10/2026). Registro: `conversazione richiesta`, `trascrizione: primo audio inviato a ElevenLabs`, `prima trascrizione parziale ricevuta`, `conversazione chiusa dal Nucleo` con i secondi inviati; l'estensione scrive ogni tocco e il motivo di ogni chiusura. Se l'utente parla sopra Melissa, la voce si ferma ed esce `voice.bargein {text, trigger}` (`trigger`: `energy` con cancellazione dell'eco hardware, `speech` quando lo decide il testo parziale). Eco: prima la cancellazione hardware (voice processing), se fallisce il filtro software sul testo (parole in comune con quello che Melissa sta dicendo) |
| `voice.converse.stop` | | | chiude la conversazione (emette `voice.final` se c'era una frase a meta') |
| `wake.enable` | `phrase` (default `melissa`), `locale?` | | ascolto continuo tramite la trascrizione ElevenLabs, ma solo intorno alla voce (il silenzio non si manda); evento `wake.detected {phrase, text}`. Sospeso mentre Melissa parla e durante ascolto o conversazione. Costa audio trascritto ogni volta che qualcuno parla nella stanza: va acceso solo se serve |
| `wake.disable` | | | |
| `orb.show` | | | sfera grande (~165 pt) in un pannello flottante di vetro, in basso al centro, con la didascalia sotto; trascinabile, la posizione resta. Se era agganciata, la piccola sparisce e la grande cresce al suo posto (solo dissolvenza con Riduci movimento) |
| `orb.dock` | | `presentation` | sfera agganciata: piccola (~56 pt, pannello 72x72 pt), sempre a schermo finche' il Nucleo gira, su tutte le Scrivanie, non prende mai il fuoco, senza didascalia, trascinabile con una posizione sua (default in basso a destra sopra il Dock, margini 24 pt). Se la grande e' visibile si rimpicciolisce nella piccola. A riposo (`idle`) e' ferma: un solo fotogramma, 0 fps, il Nucleo da fermo resta a 0% di CPU. Mentre pensa (`thinking`) o in `error` si anima a 12 fps (~13 µs di CPU e ~0.7 ms di GPU per fotogramma, misurati fuori schermo); 30 fps se lo stato e' listening o speaking. Lo stato `error` la tinge d'ambra; gli altri stati cambiano solo il colore (per ingrandirla l'estensione manda `orb.show`) |
| `orb.hide` | | | sfera nascosta del tutto (solo quando Andrea spegne la voce); dopo 2 minuti nascosta libera anche la memoria grafica |
| `orb.state` | `state`: `idle`, `listening`, `thinking`, `speaking`, `error`; `caption?` | | la sfera usa anche il livello audio interno. La sfera segue da sola la voce (ascolto, pensiero dopo `voice.final`, parlato) e la didascalia mostra la trascrizione parziale o la frase detta; lo stato e la didascalia mandati qui valgono fino alla prossima transizione della voce |
| `hotkey.register` | `key` (es. `space`), `modifiers` (es. `["option"]`) | `label` | eventi `hotkey.down {key}`, `hotkey.up {key}`: tieni premuto per parlare. Default Option+Space. Cmd+Option+M e' rifiutata (e' di Melissa) |
| `hotkey.unregister` | | | |
| `notify` | `id`, `title`, `body`, `actions?: [{id, title}]`, `subtitle?`, `sound?` (default true) | | eventi `notify.clicked {id, action?}` (`action` assente = clic sulla notifica, `dismiss` = chiusa) |
| `menubar.update` | `busy`, `waiting`, `queued`, `title?`, `items?: [{id, title, status}]`, `visible?` | | icona nella barra dei menu (compare al primo update); `status` di un item: `busy`, `waiting`, `queued`, `done`, `error`; menu con una riga per item e "Apri la Bottega"; evento `menubar.clicked {item}` (`item` = id dell'item, oppure `open`). `visible: false` toglie l'icona |
| `ai.generate` | `prompt`, `instructions?`, `maxTokens?` | `text` | Apple Intelligence sul dispositivo (FoundationModels) |
| `ai.summarize` | `text`, `instructions?` | `text` | idem, con istruzioni di riassunto in italiano (richiesta, cosa e' stato fatto, decisioni, file, prossimi passi). Testi oltre la finestra di contesto: riassunto a pezzi da ~10.000 caratteri, poi fusione |
| `ai.embed` | `texts: [string]`, `language` (`it`) | `vectors: [[number]]`, `dimension` | NLEmbedding di frase, vettori normalizzati (norma 1, quindi coseno = prodotto scalare). Una riga per testo, testo vuoto = vettore di zeri. La dimensione la decide il sistema: su macOS 27.2 per l'italiano e' **640**, non 512: chi salva vettori legga `dimension` |
| `system.stats` | | `load: [1m,5m,15m]`, `memoryPressure: normal/warning/critical`, `memoryUsedGB`, `memoryTotalGB`, `thermal: nominal/fair/serious/critical`, `cores` | l'estensione la chiede ogni 10 s con la Home davanti o con lavori in corso o in coda, ogni 60 s altrimenti |
| `quit` | | | chiusura pulita |

Eventi aggiuntivi: `voice.state {state, conversing, mode?, wake?, message?}` (`state`: `idle`, `listening`, `processing`,
`speaking`, `error`; con `error` c'e' `message` in italiano e la sfera diventa ambra), `voice.partial {text, mode}`, `voice.final {text, mode}`, `voice.level {level 0..1, source: mic|tts}`
(al massimo 15 al secondo, niente eventi mentre resta silenzio), `voice.bargein {text, trigger}`,
`voice.engine {engine, reason}` (ElevenLabs e' caduto, si continua con la voce Apple), `orb.clicked {mode}` (`mode`: `docked` o `big`),
`system.pressure {memoryPressure, thermal}` quando cambia, `log {level, message}`, `ready {version}`.
L'estensione ascolta `voice.state` con `error`: scrive il messaggio nel registro di Melissa e nella barra, chiude la
conversazione e mette la sfera in errore. `voice.converse.start` e `voice.listen` si aspettano con una risposta (15 s):
un errore o un'attesa scaduta fanno lo stesso, la barra non resta mai su "ti ascolto" senza ascoltare. `log` va nel
registro di Melissa; tutto lo stderr del Nucleo in `~/.bottega/nucleo.log` (oltre 2 MB si ricomincia, la copia di prima
in `nucleo.log.1`). Il permesso del microfono si chiede con un tempo massimo di 20 s (il 2/10/2026 la richiesta restava
appesa senza finestra): scaduto o negato, si apre Impostazioni di Sistema sul Microfono e la richiesta fallisce con il
messaggio in italiano.

Voce in uscita: ElevenLabs se c'e' la chiave (`ELEVENLABS_API_KEY` nell'ambiente, altrimenti `~/.secrets/elevenlabs.env`,
con `ELEVENLABS_VOICE_ID` facoltativo, default Melissa `QITiGyM4owEZrBEf0QV8`), sempre in tempo reale sul socket
text-to-dialogue, modello `eleven_v4_turbo`, tenuto caldo mentre la voce e' in uso (conversazione, sfera visibile,
o una risposta negli ultimi 2 minuti). I caratteri mandati si contano in `~/.bottega/nucleo/usage.json` (la chiave
non ha il permesso di leggere il saldo): `elevenLabsCharsByMonth {"YYYY-MM": n}` e, dal 3/10/2026,
`elevenLabsCharsByDay {"YYYY-MM-DD": n}` (ora locale, gli ultimi 400 giorni) per la sezione 14. Senza chiave o a qualsiasi errore: AVSpeechSynthesizer, voce di sistema
`com.apple.voice.premium.it-IT.Emma` (gia' installata, niente download), i tag come `[laughs]` vengono tolti.

Voce in entrata: solo ElevenLabs, nessun modello locale e nessun download (decisione di Andrea).
`wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language_code=it&audio_format=pcm_16000&commit_strategy=vad&vad_silence_threshold_secs=0.8`,
audio PCM 16 kHz mono a pezzi da 100 ms, `partial_transcript` -> `voice.partial`, `committed_transcript` ->
`voice.final` (o un pezzo del `voice.final` in modalita' push). Misurato il 1/10/2026: frase chiusa dal VAD 0.75 s
dopo la fine del parlato, commit a mano 0.25 s. Il socket si apre all'ascolto (o alla pressione della scorciatoia)
e si chiude 30 s dopo l'ultimo ascolto: da fermo nessuna connessione aperta.

Permessi: il microfono lo chiede il Nucleo, ma macOS lo attribuisce al processo responsabile, cioe' a
Bottega.app che lo lancia: per questo anche Bottega.app deve avere `NSMicrophoneUsageDescription` (lo fa
`scripts/package.sh`). Il permesso di riconoscimento vocale non serve piu' (nessun riconoscitore Apple). Le notifiche
invece appartengono al Nucleo ("Bottega Nucleo" in Impostazioni di Sistema, Notifiche).

### Modalita' riga di comando (usata dagli hook della Memoria, fuori dall'IDE)

```
BottegaNucleo --cli summarize [--instructions "..."] < testo  -> riassunto su stdout (exit 2 se Apple Intelligence non c'e')
BottegaNucleo --cli generate --instructions "..." [--max-tokens N] < prompt
BottegaNucleo --cli embed [--language it] < una frase per riga -> JSON {"dimension":640,"vectors":[[...]]}
BottegaNucleo --cli stats                       -> JSON come system.stats
BottegaNucleo --cli power                       -> JSON come power.status
BottegaNucleo --cli stato [--file stato.json]   -> le frasi che direbbero «Briefing» e «Stato delle regole»
BottegaNucleo --cli spotlight-find <testo>      -> gli elementi della Bottega nell'indice di Spotlight (diagnosi)
BottegaNucleo --cli capabilities                -> JSON come capabilities
BottegaNucleo --cli tts --out f.wav [--engine elevenlabs|apple] [--via ws|rest] [--model m] < testo
                                                -> scrive un WAV 24 kHz senza suonarlo (prova della voce)
BottegaNucleo --cli stt-file f.wav [--commit manual|vad]
                                                -> manda un WAV alla trascrizione ElevenLabs in tempo reale e
                                                   stampa eventi e tempi (prova della trascrizione, niente microfono)
```

Exit: 0 ok, 1 errore (messaggio su stderr), 2 Apple Intelligence non disponibile, 64 uso sbagliato.
Nessuna interfaccia: niente Dock, niente barra dei menu, esce appena ha risposto.

Il percorso stabile per chi sta fuori dall'IDE e' il collegamento `~/.bottega/bin/nucleo`.

### Modalita' isola (Melissa dentro Claude Code, `nucleo/Sources/Isola/`)

La usa la mod `melissa` di Claude Code (`andreapianidev/claude-code-mods`, cartella `melissa/`). Un solo processo
per Mac, lanciato dalla mod attraverso LaunchServices, cosi' i permessi di microfono e riconoscimento vocale sono
del Nucleo e non del terminale in cui gira Claude:

```
open -n -g -a "<Bottega Nucleo.app>" --args --isola      (l'app e' quella a cui punta ~/.bottega/bin/nucleo)
```

Serve HTTP/1.1 su un socket Unix, `~/.bottega/nucleo/isola.sock` (permessi 600). Ogni risposta e' JSON con `ok`;
gli errori hanno `ok: false` ed `errore`.

| Richiesta | Corpo | Risposta |
|---|---|---|
| `GET /ping` | | `{ok, versione, parla, ascolta}`: `parla` e' vero finche' qualcosa della voce di Melissa deve ancora sentirsi (audio in riproduzione o in arrivo, testo non ancora detto; un turno aperto e vuoto non conta). La mod lo aspetta prima di riaprire il microfono nella conversazione e prima di ogni frase della cronaca. `ascolta` e' vero finche' il microfono e' aperto |
| `POST /detta` | `{sessione, progetto}` | `{ok}`: apre il microfono (riconoscimento di Apple, `it-IT`, modo push). 409 se ascolta gia' un'altra sessione |
| `POST /detta/fine` | | `{ok}`: chiude la frase; il testo arriva come evento |
| `POST /stato` | `{stato: pensa\|pronto\|riposo, testo?}` | `{ok}`: l'isola mostra lo stato (`pronto` si ritira da sola dopo 1,8 s) |
| `POST /parla` | `{sessione, testo, append?, final?, voce?}` | `{ok, voce}`: Melissa lo dice (ElevenLabs `eleven_v4_turbo` sul socket caldo, voce di sistema se non risponde). Con `append: true` i pezzi di uno stesso testo (la risposta di Claude letta mentre arriva) si accodano nello stesso turno di voce; `final: true` lo chiude, anche con testo vuoto. `voce` e' l'id di un'altra voce ElevenLabs dell'account (un personaggio a cui Melissa passa la chiamata, dalla build 120): si manda la frase intera (`append: false`), che chiude il turno aperto e ne apre uno con quella voce; un valore che non e' un id si ignora. 409 mentre ascolta |
| `POST /zitta` | | `{ok}`: silenzio subito |
| `POST /scalda` | `{voci: [{voce, testi}]}` | `{ok, mancanti, inCoda}`: prepara l'audio dei riempitivi (9.11), come `voice.scalda` del servizio e con la stessa cache. `voce` e' l'id ElevenLabs (stessa regola di `/parla`, un id non valido si salta), `""` per Melissa. Risponde subito, la generazione va dopo, un pezzo alla volta; 503 senza chiave ElevenLabs. Non serve niente su `/parla`: un pezzo il cui testo e' gia' pronto parte dal disco. Corpo fino a 256 KB |
| `GET /eventi?sessione=X` | | trattenuta fino a 15 s: `{ok, eventi: [...]}`, vuota se non succede niente |
| `POST /mostra` | `{testo, chi}` oppure `{fine: true}` | `{ok}` subito: la voce del Nucleo di servizio (la barra, build 134) sull'isola. Vedi sotto |

Eventi di una sessione: `{tipo: "parziale", testo}` mentre parli, `{tipo: "testo", testo}` a dettato finito,
`{tipo: "errore", messaggio}`, `{tipo: "ferma", at}` (clic sull'isola mentre la voce di Melissa per quella sessione
si sente ancora: la mod ferma il turno di Claude). Un `ferma` non raccolto entro 3 s si scarta, cosi' non ferma mai un
turno successivo, e `/detta` svuota la coda della sessione.

Il dettato si chiude da solo 3,5 s dopo l'ultima parola nuova, o dopo 10 s senza parole. Un clic sull'isola chiude
il dettato; mentre Melissa racconta, ferma Claude. L'isola sta nella tacca del MacBook (sugli schermi senza tacca
pende sotto la barra dei menu) e si ritira quando non ha niente da dire. Il processo esce dopo 15 minuti senza
richieste, dettato o voce; un secondo `--isola` trova il socket vivo ed esce subito (e se due partono nello stesso istante decide il lock su `~/.bottega/nucleo/isola.lock`, tenuto per tutta la vita del processo). Un'isola rimasta su "pensa" o "parla" per due minuti senza voce e senza microfono torna a riposo da sola.

Il microfono apre solo quando macOS lo concede (la prima volta chiede il permesso): l'orologio dei 10 s parte da li', e
un dettato chiuso mentre il microfono si apriva lo richiude subito. Il log sta sempre in `~/.bottega/nucleo/isola.log`:
la mod lo passa a `open --stderr`, e se l'isola parte senza (stderr su `/dev/null`) il Nucleo apre da se' quel file in
aggiunta e ci mette sopra stderr (resta sul terminale solo se l'isola e' lanciata a mano da un terminale).

L'isola segue la voce del proprio processo con `Out.tap` (gli stessi eventi `voice.*` della modalita' servizio):
stdout non porta niente, `Out.enabled` e' spento.
Sopra il testo l'isola scrive chi parla: Melissa, o il personaggio la cui voce (`/parla {voce}`) e' nei file
`~/.bottega/personaggi/*.json` (`voce` -> `nome`, riletti al massimo una volta al minuto). Nome e testo cambiano quando
quel pezzo comincia davvero a suonare, non quando arriva la `/parla`: le battute di voci diverse stanno nella stessa
coda. Se davanti non c'e' niente, il nome sale gia' alla `/parla`.

La voce della barra sull'isola (build 134, `nucleo/Sources/Isola/IsolaAvviso.swift`). Quando parla la barra, la voce e'
quella del Nucleo in modalita' servizio, un altro processo: l'isola non la sente. Il servizio allora, a ogni pezzo che
comincia davvero a suonare (lo stesso istante di `segmentoIniziato`), manda all'isola `POST /mostra {testo, chi}`
(testo senza i tag audio, al piu' 500 caratteri; `chi` e' il nome da `ChiParla`, come per la mod), e a voce finita
(`speakingEnded`) `POST /mostra {fine: true}`. L'isola mostra il testo sotto il nome come una battuta sua; alla fine si
ritira dopo 1,2 s, ma solo se sta ancora mostrando una battuta del servizio (una richiesta della mod nel frattempo,
`/stato`, `/parla`, `/detta`, la fa tornare della mod). La voce dell'isola stessa e il microfono vengono prima: mentre
l'isola parla o ascolta, `/mostra` risponde `ok` e non cambia niente. `/mostra` non tiene in vita l'isola (non conta
per i 15 minuti). Dal lato del servizio e' spara e dimentica: una coda seriale fuori dal main, un secondo al massimo
per scrivere e per leggere, niente se il socket non c'e' o nessuno risponde; con piu' di 6 richieste in attesa le
battute nuove si scartano (la `fine` passa sempre). La voce non aspetta mai l'isola. Solo dalla modalita' servizio:
l'isola stessa, la modalita' macOS e `--cli` non mandano niente.

## 2. Memoria

Dati in `~/.bottega/memoria/` (cartella 700):
- `memoria.db` SQLite (node:sqlite, FTS5)
- `spool/` righe JSONL scritte dagli hook (veloci, senza aprire il database)
- `contesto/<chiave-progetto>.md` contesto pronto da iniettare a inizio sessione
- `bacheca/<chiave-progetto>.jsonl` attivita' in diretta di tutte le sessioni (memoria condivisa tra
  sessioni che girano insieme): `UserPromptSubmit` inietta a Claude cosa hanno fatto le altre sessioni
  sullo stesso progetto negli ultimi 30 minuti

CLI: `node memoria/cli.mjs <comando>`; comandi minimi: `ingest`, `search <testo> [--progetto P] [--json]`,
`recent [--progetto P] [--json]`, `remember <testo> [--progetto P]`, `summarize <sessionId>`,
`backfill [--giorni N]`, `context <cwd>`, `bacheca [--progetto P] [--minuti N] --json`, `install`, `uninstall`, `status --json`.
Comandi aggiunti dall'implementazione: `sessione <id>`, `worker` (interno, riassunti in background),
`grafici [--giorni N=30] --json` (la stanza Memoria, `lib/grafici.mjs`: `{giorni, ora, scritti: [{giorno: 'AAAA-MM-GG',
fatti, decisioni, riassunti, schermate, richieste}], letti: [{giorno, avvio, ricerche, strumenti: {cerca, ...}}],
progetti: [{progetto, ricordi}] (al massimo 8), ore: number[7][24] (lunedi' per primo, senza le richieste),
adesso: {giorno, ora}, totali: {ricordi, sessioni, riassunte, coda, lettiSettimana, ultimo}}`; `ore` alimenta il battito
della stanza Memoria, disegnato in WebGPU da `media/motore/battito-gpu.js` (Metal sul Mac, griglia SVG ferma se manca);
le note vanno con i fatti; `avvio` = sessioni avviate quel giorno, cioe' contesti dati da SessionStart; `ricerche` =
osservazioni con uno strumento `mcp__bottega-memoria__*`; solo letture, giorni dell'orologio del Mac, da 7 a 90),
`bacheca` restituisce `[{at, sessionId, project, kind, summary, file?}]`. Radici dei progetti
configurabili in `~/.bottega/memoria/config.json`.
`personaggio <chiave> [--frase T] [--limite N=5] --json` restituisce `{ultime: [{at, testo}], ricordi: [{at, chi, testo}]}` (9.11); le note con `origin: "personaggio"` si trovano solo con `search`/`memoria_cerca`, mai in contesto, bacheca, `recent`/`memoria_recenti`, sessione, grafici, categorie o riassunti.
L'estensione la usa con `--json`.

Soglie dei riassunti: al primo `Stop` con almeno 15 osservazioni, poi ogni 25 nuove osservazioni e non
prima di 20 minuti dall'ultimo; `SessionEnd` riassume sempre se c'e' qualcosa di nuovo; `SessionStart`
recupera le sessioni ferme da 30 minuti senza `SessionEnd`. Motore: Agnes `agnes-3.0-flash` (massimo 6
richieste al minuto), riserva Apple Intelligence tramite `nucleo --cli generate` (testo tagliato a
7000 caratteri) solo se Agnes rifiuta o non risponde. Nessun modello da scaricare.

Schema JSON di una voce restituita da `search`/`recent`:
`{"id": 12, "kind": "riassunto|fatto|decisione|nota|prompt", "project": "Peak", "projectPath": "...",
"sessionId": "...", "title": "...", "text": "...", "createdAt": 1790877674873, "score": 0.83}`

Hook installati in `~/.claude/settings.json` (unione con quelli esistenti, backup prima, mai rimozioni
di hook altrui): `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`.
Ogni hook esce sempre con 0 entro 150 ms; il lavoro pesante (riassunti) parte staccato.
Server MCP `bottega-memoria` registrato a livello utente, strumenti: `memoria_cerca`, `memoria_ricorda`,
`memoria_recenti`, `memoria_sessione`, `memoria_bacheca`.

## 3. Estensione <-> plancia (webview)

Estensione -> plancia:
- `{type: "snapshot", snapshot}` (gia' esistente: projects, live, elsewhere, scannedAt, home) con in piu'
  `jobs: Job[]`, `activity: AgentActivity[]`, `system: SystemStats | null`, `assistant: AssistantState`.
  `activity` unisce Claude Code, Cline, Codex e i terminali integrati; ogni elemento ha `key`, `source`, `id`,
  `project`, `path?`, `title`, `status` (`in corso`, `ti aspetta`, `finito`, `errore`, `sconosciuto`),
  `updatedAt`, `startedAt?`, `summary?`, `steps?`, `evidence`. I testi sono brevi e ripuliti da righe sensibili.
  Le trascrizioni Codex e Cline sono lette in sola lettura; il terminale fornisce solo gli eventi che la shell
  integration segnala dopo l'attivazione. Lo stato `sconosciuto` non implica che il processo sia attivo.
  Si manda solo con la Home visibile: un'istantanea arrivata con la Home nascosta si manda quando torna
  davanti (`retainContextWhenHidden` la tiene viva, ma ridisegnarla di nascosto e' lavoro sprecato).
  Anche il cruscotto (`stats`) si ricalcola solo con la Home visibile.
- `{type: "fuoco", focused}`: la finestra della Bottega davanti o dietro, a `ready` e a ogni cambio (la sfera riposa)
- `{type: "focus", path}`
- `{type: "memoria", query, project, results: MemoryItem[], checkedAt, bacheca}` risposta a una ricerca.
  `checkedAt` e' l'ora del controllo, distinta da `createdAt` dei ricordi. In caso di errore: `{type: "memoria", query, project, error}`; la plancia conserva i risultati precedenti e mostra il problema. Risposte con query o progetto superati vengono scartate.
- `{type: "assistant", state: AssistantState}` aggiornamento leggero mentre Melissa parla
- `{type: "view", view}` apre una stanza: `plancia`, `regia`, `lavori`, `memoria`, `melissa`, `cruscotto`
  (comandi `bottega.openMelissa`, `bottega.openCruscotto`)
  `bottega.openRegia` e' nella testata delle viste Bottega nella barra sinistra. La Regia legge
  `snapshot.activity` e le code in `snapshot.work`, raggruppa per percorso e apre il compositore Lavori
  per i nuovi compiti. Il pannello conserva l'ultima stanza richiesta fino al messaggio `ready`.
- `{type: "regia.digest", digest: {at, text, engine, alternatives}}`: sintesi conservata sul Mac e scelta
  tra Agnes e Apple Intelligence dagli stessi stati e titoli osservati. La Regia richiede
  `regia.digest` all'apertura; `regia.refresh` la rigenera a mano. Il giro automatico non avviene
  prima di otto ore dall'ultima sintesi. `regia.metal` apre la finestra nativa del Nucleo.
- `{type: "stats", stats: Stats}` il cruscotto (vedi sotto), in risposta a `stats.request` e poi a ogni
  scansione completa (ogni 2 minuti) se i numeri sono cambiati; `{type: "stats", stats: null, error}`
  se i registri non si leggono

Plancia -> estensione (`type` + campi):
`ready`, `refresh`, `open`, `here`, `claude {path, id?}`, `finder`, `xcode`, `push`,
`job.new {path, task}`, `job.focus {id}`, `job.stop {id}`, `job.remove {id}`,
`regia.digest`, `regia.refresh`, `regia.metal`,
`memoria.search {query, project?, limite?}` (senza testo gli ultimi `limite` ricordi, da 10 a 200: «Mostra altri
ricordi» ne chiede 20 in piu'; la stanza la richiede entrando e ogni minuto finche' e' davanti senza ricerca scritta),
`memoria.grafici` (-> `{type: 'memoria.grafici', dati}` con l'uscita di `grafici`, entrando e ogni 5 minuti),
`memoria.remember {text, project?}`,
`voice.toggle`, `assistant.ask {text}` (domanda scritta a Melissa),
`stats.request {period?}` (il cruscotto chiede i numeri; `period` 7, 30 o 90 e' solo informativo:
la risposta contiene sempre tutti e tre i periodi, cosi' cambiare periodo non costa un giro)

```ts
interface Job {
  id: string; project: string; path: string; task: string;
  status: 'in coda' | 'in corso' | 'ti aspetta' | 'finito' | 'fermato';
  createdAt: number; startedAt?: number; endedAt?: number;
  sessionId?: string; pid?: number; lastActivity?: number;
}
interface SystemStats { load: number[]; memoryPressure: string; memoryUsedGB: number; memoryTotalGB: number; thermal: string; cores: number; }
interface AssistantState {
  enabled: boolean;      // interruttore generale di Melissa (bottega.voice.enabled)
  conversing: boolean;   // modalita' conversazione in corso (mic sempre aperto); un tap di
                         // Opzione+Spazio la accende/spegne, tenere premuto parla una volta
  state: 'idle'|'listening'|'thinking'|'speaking'|'error';
  partial?: string;
  log: { role: 'tu'|'melissa'|'azione'; text: string; at: number }[];  // ultimi 30
  brain: 'agnes'|'apple'|'nessuno';
}
```

Voce ElevenLabs, percorso dell'audio (build 125). Il PCM del socket text-to-dialogue non passa piu' dal thread
principale del Nucleo: ricezione, decodifica (JSON, base64, byte dispari), conversione in float32 e accodamento in
AudioOut avvengono su una coda seriale del socket, che mette nello stesso ordine di arrivo anche i marcatori di inizio e
fine di ogni segmento. Sul thread principale resta solo la contabilita' dello Speaker (segmenti, watchdog di 8 s, eventi
voice.spoken e voice.state), che puo' arrivare in ritardo senza fermare la voce. Un barge-in chiude il socket prima di
azzerare AudioOut, e l'audio del giro vecchio viene scartato. Nessuna interfaccia cambia. Nel registro compare una riga
nuova, al primo audio di un segmento e solo se supera 50 ms: "voce: primo audio del segmento in coda N ms dopo il
socket". Misura del 6 ottobre 2026 che l'ha motivato: dal terminale, stesso modello, stessa voce e stesso schema di
invio, zero buchi in 5 prove; nel Nucleo i buchi comparivano solo col Mac carico, perche' l'audio aspettava il thread
principale, lo stesso delle animazioni dell'isola. L'isola a riposo non anima piu' l'aura a pannello chiuso: da ferma
resta a 0% di CPU. La mod chiude il turno di voce a ogni frase della cronaca (0.14): prima lo chiudeva il Nucleo dopo
20 s di silenzio ("manca final").

Linea lenta (build 130). Il 6 ottobre dalle 18:10 i buchi sono tornati con il Mac scarico: la coda del socket era
ferma (nessuna riga "dopo il socket" oltre il primo audio dopo l'avvio), il Nucleo campionato passava il tempo ad
aspettare, e un turno da 336 caratteri ha dato 20 s di audio in 26 s, circa 0,77x: ElevenLabs genera piu' lento di
quanto la voce parli, a ondate (zero buchi dalle 13:30 alle 14:20 e dalle 17:20 alle 18:10). Nessuna scorta piccola
regge una linea sempre indietro, e la voce scattava due o tre volte per frase. Ora, con un buco nell'ultimo minuto,
dalla seconda frase di un turno in poi AudioOut tiene da parte la frase finche' non e' arrivata intera (il suo
marcatore di fine), mentre la precedente continua a suonare, e poi la suona tutta: la pausa cade fra due frasi. La
lascia partire comunque dopo 2,5 s di silenzio o con 6 s di audio in mano. La prima frase di un turno non aspetta mai.
Registro: "voce: linea lenta, frase tenuta N ms, M ms di audio, intera|parte prima che finisse[, a voce ferma]".

Solo ElevenLabs (build 133, regola di Andrea del 6 ottobre 2026: mai una voce che non sia ElevenLabs; si riprova, e
se proprio non va si mostra l'errore). La voce di Apple non si sente piu' in nessun caso: ne' senza chiave, ne' dopo un
errore, ne' chiesta per nome da /parla o voice.speak (`apple`, `com.apple.*` diventano la voce di Melissa). Quello che il
socket non riesce a dire (non si apre, cade, resta muto 8 s) va nella coda di prima, che ora genera ogni frase con
ElevenLabs REST nella stessa voce: fino a quattro tentativi, subito e poi dopo 1, 2 e 4 s, in ordine e senza mescolarsi
al socket. Se falliscono tutti la frase non si dice e l'errore si vede: sull'isola ("Voce: ..."), nella fascia della
mod (evento `{tipo:"errore", messaggio}` alla sessione che stava raccontando) e come evento `voice.error {messaggio}`.
Senza chiave l'errore arriva subito. Anche la voce per l'iPhone (ponte, SpeechFile) prova il socket e poi REST tre
volte; Apple solo con `--cli tts --engine apple`. Registro: "voce: riprovo con ElevenLabs REST, ...", "ElevenLabs REST,
tentativo N fallito", "ElevenLabs non risponde (N tentativi)". Il paragrafo qui sotto descrive com'era fino alla 132.

Voce ElevenLabs e voce di Apple non si mescolano mai (dalla build 126). AudioOut e' una coda sola: prima l'audio di un
turno passato ad Apple e quello ElevenLabs dei turni dopo finivano alternati, e si sentivano tutte e due insieme. Ora la
voce di Apple comincia un segmento solo quando non c'e' piu' audio ElevenLabs in arrivo, e le frasi ElevenLabs (anche
quelle dalla cache) aspettano, in ordine, finche' Apple ha consegnato tutto il suo audio. Una frase che trova il socket
ancora occupato a chiudere il turno prima (`close_socket` mandato, l'audio lungo di quel turno ancora in arrivo:
`is_final` arriva solo a generazione finita) aspetta finche' quel socket manda dati, anche ben piu' di 3 s; se resta
muto per 8 s si chiude e si riapre, e solo se non si riapre si passa ad Apple. Mentre aspetta, dietro si accodano anche
le frasi delle altre voci. Ogni passaggio ad Apple lascia una riga sola nel registro, con il motivo: "voce: passo alla
voce di Apple, <motivo>". Caso del 6 ottobre 2026 (17:33 e 17:34): dopo 3 s la frase andava ad Apple mentre il socket
consegnava ancora il turno prima, e 1,5 s dopo ElevenLabs ripartiva sopra Apple.

### Il cruscotto (`Stats`, da `src/stats.ts`)

Fonte: i registri di Claude Code `~/.claude/projects/<cartella>/<sessione>.jsonl` piu'
`<sessione>/subagents/*.jsonl` (i sottoagenti appartengono alla sessione che li ha lanciati).
Le cifre principali di ore, token, valore a listino, progetti e grafici di durata misurano Claude Code.
La sezione "Attivita' osservate" usa lo stesso registro multi-fonte della Home (`snapshot.activity`):
conteggia Claude Code, Cline, Codex e terminali integrati per stato corrente e per giorno
dell'ultimo `updatedAt`. Un'attivita' entra in un solo giorno; questa serie non misura ore di lavoro,
numero di messaggi, token o costi. Accanto a ciascuna fonte il Cruscotto mostra separatamente i
consumi che i registri locali permettono di misurare: Codex legge le differenze dei contatori
cumulativi input/output e il tempo trascorso nei turni conclusi; Cline SDK legge input/output/cache
e i costi dichiarati per messaggio. Codex non ha un costo locale affidabile; Cline non ha una durata
di lavoro confrontabile; il terminale non ha uno storico di consumi. In questi casi appare N/D.
Il lettore scandisce al massimo 90 giorni e conserva il risultato in memoria per due minuti;
mostra quanti file ha letto e quanti ha omesso. La copertura dei conteggi delle attivita' e' piu'
breve: fino a 7 giorni e 100 sessioni Codex, 45 giorni Cline, terminali solo durante l'app aperta.
Regole, scritte anche in chiaro nel cruscotto:
- attivita': le righe `user`, `assistant`, `system` con `timestamp`. Dentro una sessione due eventi a
  meno di 15 minuti valgono come lavoro, una pausa piu' lunga spezza il conto;
- `you` (ore di Andrea) = unione degli intervalli di tutte le sessioni, due sessioni insieme contano
  una volta; `claude` = somma per sessione, mostra il parallelismo;
- token da `message.usage` delle righe `assistant`; le righe con lo stesso `message.id` + `requestId`
  sono la stessa risposta (una riga per blocco): contano una volta, col valore piu' alto per campo;
- progetto di una sessione: come nella plancia (`sessionOwner` in `scan.ts`): cartella di partenza,
  altrimenti il progetto in cui ha toccato piu' file (almeno due); il resto va in "Fuori dai progetti"
  (`path: null`);
- valore a listino: stima a prezzi API (input, output, lettura cache, scrittura cache 1,25x o 2x
  l'input per 5 minuti o 1 ora). Non e' quello che si paga con un abbonamento. Misurato il 2/10/2026
  sui conti `cost-state` che Claude Code scrive nelle sessioni: la stima sta il 6,5% sotto (Claude Code
  conta anche chiamate che non finiscono nel registro).
- giorni, ore e settimane (ISO, da lunedi') nel fuso orario del Mac.

Cache: `<globalStorage>/cruscotto-cache.json`, un riassunto per file con dimensione, mtime e byte
letti. Al giro dopo si rileggono solo i file cambiati; un file solo cresciuto (sessione viva) riprende
dall'ultima riga completa. Lettura a pezzi da 1 MB, cedendo il passo all'host ogni ~12 ms.

```ts
type Tok = [input: number, output: number, lettiDallaCache: number, scrittiInCache: number];
interface StatsTotals { you: number; claude: number; tok: Tok; cost: number; sessions: number;
  prompts: number; activeDays: number }                 // minuti, dollari, messaggi scritti da Andrea
interface Stats {
  version: 1; computedAt: number; ms: number;           // ms = tempo del calcolo
  files: { total: number; read: number; cached: number; mb: number };
  gapMinutes: 15; streakMinutes: 30; tz: string; firstEvent: number;
  today: { date: string; you: number; claude: number; tok: number; sessions: number };
  week: { start: string; now: {you, claude, tok}; prevSoFar: {you, claude, tok}; prevFull: {you, claude, tok} };
  days: { date: string /* YYYY-MM-DD */; you; claude; sessions; prompts; tok: Tok; cost }[];  // ultimi 90, dal piu' vecchio
  weeks: (StatsTotals & { key: string /* 2026-W40 */; start: string; end: string })[];         // settimane che toccano i 90 giorni
  months: (StatsTotals & { key: string /* 2026-09 */; start: string; end: string })[];
  periods: Record<'7' | '30' | '90', StatsTotals & {
    days: number; from: string; avgSession: number;    // minuti di Claude per sessione
    peak: { n: number; at: number };                   // massimo di sessioni attive insieme
    prev: StatsTotals;                                 // gli stessi giorni subito prima
    projects: { name: string; path: string | null; you; claude; tok: Tok; cost; sessions;
      prev: { you; claude; tok: number; cost }; last: number;
      daily: number[]; hours: number[] /* 24, minuti tuoi per ora */; live: number }[];
    edges: { a: string; b: string; minutes: number }[];  // progetti lavorati insieme (>= 20 min)
    models: { id: string; name: string; tok: Tok; messages: number; cost: number | null }[];
    heat: number[][];                                  // [lunedi'..domenica][0..23] minuti tuoi
    lengths: { edges: number[] /* [5,15,30,60,120,240] */; bins: number[] /* 7 fasce */;
      median: number; n: number };                     // minuti di lavoro di ogni sessione DENTRO il periodo,
                                                       // solo sessioni con almeno 1 minuto
    stalled: { name: string; path: string; prev: number; last: number }[];  // >= 30 min nel periodo prima,
                                                       // zero in questo (non sono in `projects`), max 8
  }>;
  streak: { current: number; best: number; bestEnd: string | null };
  records: { busiestDay: {date, you} | null; longestStint: {start, minutes} | null; tokenDay: {date, tok} | null };
  live: { pid; sessionId; project: string; path: string | null; title; status; since; started;
    today: number; tokToday: number;
    cwd: string;                                       // cartella in cui gira la sessione
    where: string }[];                                 // vedi sotto
  prices: { note: string; perModel: Record<string, [input, output, cacheRead]> };  // $ per milione
  unpricedTokens: number;
  todaySessions: { sid: string; project: string; path: string | null; title: string; where: string;
    spans: number[];                                   // [inizio, fine, ...] minuti dalla mezzanotte locale,
                                                       // gia' fusi (15 min), tagliati a oggi e ad adesso
    tok: number; live: boolean }[];                    // in ordine di inizio, le ultime 40; fuori le sessioni
                                                       // chiuse con meno di 30 secondi di lavoro
  concurrency7: { start: number;                       // ms, inizio della prima delle 168 ore (ora locale)
    avg: number[]; peak: number[]; busy: number[] };   // 168 valori, dalla piu' vecchia a quella in corso
  observedActivity?: {
    sources: {source: 'claude'|'cline'|'codex'|'terminale'; total; inCorso; tiAspetta;
      finito; errore; sconosciuto}[];                   // stati del registro osservato al calcolo
    days: {date: string; claude; cline; codex; terminale}[];  // ultimi 90 giorni locali,
                                                               // conteggi per ultimo aggiornamento
  };
  sourceMetrics?: Record<'7'|'30'|'90', {
    codex: {tokens: number|null; cost: null; durationMinutes: number|null; records: number; files: number; skipped: number};
    cline: {tokens: number|null; cost: number|null; durationMinutes: null; records: number; files: number; skipped: number};
  }>;
}
```

Campi del banco (le due colonne in fondo al cruscotto), tutti dagli stessi intervalli delle sessioni:
- `where` (in `live` e `todaySessions`): dove gira la sessione rispetto al suo progetto. `''` nella cartella
  del progetto; `"copia Bottega-idee, ramo idee"` in un worktree elencato nello snapshot
  (`Project.worktrees`, il ramo si omette se uguale al nome), con `", cartella X"` se in una sua
  sottocartella; `"cartella sito"` in una sottocartella del progetto; `"dalla home"`; per le sessioni fuori
  dai progetti `"cartella <nome>"`. `StatsInput.projects[].worktrees` e' opzionale e arriva gia' dallo
  snapshot. L'attribuzione al progetto principale resta quella di `canonKey` (sezione 4.10).
- `concurrency7`: per ogni ora, `busy` = minuti con almeno una sessione (0..60), `avg` = minuti di sessione
  diviso `busy` (quante sessioni insieme, in media, mentre ne girava almeno una; 0 se `busy` e' 0,
  arrotondato a 0,1), `peak` = massimo di sessioni nello stesso istante. A parita' di istante chi finisce
  esce prima di chi entra.
- `lengths` e `stalled` stanno dentro ogni periodo. La plancia ne ricava "Quanto dura una sessione" e "Chi sale
  e chi scende" (quest'ultimo usa anche `projects[].you` e `prev.you`).
Peso: `concurrency7` circa 1,5 KB; `todaySessions` circa 300 byte a sessione, quindi qualche KB in una giornata
normale e al massimo circa 12 KB (40 sessioni).

## 4. Le otto idee: regole, radar, briefing, continua, clienti, notte, dimenticati, ricerca

Tutto quello che segue e' calcolato dall'estensione (`src/regole.ts`, `src/radar.ts`, `src/briefing.ts`,
`src/continua.ts`, `src/clienti.ts`, `src/notte.ts`, `src/dimenticati.ts`, `src/ricerca.ts`, `src/vercel.ts`) e arriva alla
plancia nello `snapshot` o come risposta a una richiesta. File su disco, tutti fuori dal repository:

| file | chi lo scrive | cosa contiene |
|---|---|---|
| `~/.bottega/regole-cache.json` | regole | esiti per progetto (chiave: HEAD), visibilita' GitHub (24 h), app-ads.txt (6 h) |
| `~/.bottega/regole.json` | Andrea (facoltativo) | `{"pubbliciPerScelta": ["owner/nome"], "commitDaControllare": 10}`; la Bottega (`andreapianidev/bottega-ide`) e' pubblica per scelta anche senza questo file |
| `~/.bottega/radar/stato.json` | radar | ultimo dato di App Store Connect e AdMob, con la sua eta' |
| `~/.bottega/radar/vercel.json` | radar (Vercel) | ultima pubblicazione di produzione di ogni sito collegato, domini, dettagli gia' letti, con la loro eta' (600) |
| `~/.bottega/briefing.json` | briefing | ultimo briefing (`date`, `text`, `points`, `heard`) |
| `~/.bottega/clienti.json` | plancia (Clienti) | `{"version":1,"rounding":15,"clients":[{"id","nome","progetti":[path],"tariffa"?}]}`: nomi di clienti, mai nel repository |
| `~/.bottega/notte.json` | plancia (Lavori) | finestra e parallelismo della coda della notte, resoconto dell'ultima notte |
| `~/.bottega/stato.json` | estensione | riassunto per App Intents e widget (vedi 4.9), mode 600 |

### 4.1 Lo snapshot si allarga

```ts
interface Snapshot { /* ...campi della sezione 3... */
  rules: RulesState;
  radar: RadarState;
  briefing: Briefing | null;
  forgotten: Forgotten[];
  night: NightState;
}
type Livello = 'rosso' | 'giallo' | 'verde';
interface RuleAction { act: string; label: string; args?: Record<string, string> } // act = messaggio plancia -> estensione
interface RuleHit {
  id: 'build' | 'push' | 'remoto' | 'pubblico' | 'rilascio' | 'segreti' | 'app-ads' | 'vercel';
  livello: 'rosso' | 'giallo';
  frase: string;     // cosa e' violato, una frase
  rimedio: string;   // come si rimedia, una frase
  azione?: RuleAction;
  dettagli?: string[]; // per esempio i commit incriminati: "a1b2c3d Sistema il login"
}
interface ProjectRules { path: string; livello: Livello; hits: RuleHit[]; checkedAt: number }
interface RulesState {
  projects: Record<string, ProjectRules>; // chiave: path del progetto
  global: RuleHit[];                      // regole non legate a un progetto (app-ads.txt)
  appAds: { checkedAt: number; identical: boolean; hosts: { host: string; md5: string | null; error?: string }[] } | null;
  counts: { rosso: number; giallo: number; verde: number };
  checkedAt: number; running: boolean;
}
```

Regole (rosso: si rimedia subito; giallo: va sistemato):
- `segreti` rosso: chiavi nei commit non ancora spinti (`git diff @{u}..HEAD`, schemi di `memoria/lib/redact.mjs` tramite
  `findSecrets`; le regole basate sul nome della variabile contano nei file di configurazione, o nel codice solo con un
  valore letterale). Il valore trovato non viene mai mostrato: solo file e tipo. Con segreti, niente pulsante «Spingi»:
  l'azione e' `job.prepare` («Fai togliere la chiave»).
- `pubblico` rosso: `gh api repos/OWNER/NAME` dice `private: false`, Andrea ha il permesso di scrittura (i cloni di progetti
  altrui non contano) e il repository non e' tra i pubblici per scelta.
- `rilascio` rosso: versione su App Store Connect in lavorazione (PREPARE_FOR_SUBMISSION, READY_FOR_REVIEW,
  WAITING_FOR_EXPORT_COMPLIANCE, WAITING_FOR_REVIEW, IN_REVIEW, o rifiutata e quindi destinata a tornare in revisione:
  REJECTED, METADATA_REJECTED, DEVELOPER_REJECTED, INVALID_BINARY) con `releaseType` diverso da `AFTER_APPROVAL`. Azione
  `rule.fix {path, rule: 'rilascio'}`: dopo conferma modale la Bottega la mette in rilascio automatico
  (`Radar.setAutomaticRelease`, che lancia un errore in italiano se App Store Connect rifiuta).
- `build` giallo: negli ultimi N commit (default 10, solo ultimi 60 giorni) un commit tocca il codice di un'app senza che
  salga il numero di build nello stesso commit (`CURRENT_PROJECT_VERSION`, `versionCode`, `"build"` di `bottega.json`).
  Codice = estensioni di sorgenti (swift, m, h, kt, java, ts, tsx, js, mjs, cjs, py, metal, xib, storyboard, xcstrings,
  strings, plist, gradle, kts, css, html; le cartelle generate `out/`, `test-out/`, `dist/`, `build/`, `Pods/` no). Il numero
  di build si cerca in pbxproj, xcconfig, `project.yml` (XcodeGen), gradle, `*.properties` e `bottega.json`. Si leggono solo
  i nomi dei file degli ultimi N commit, poi `git log --no-walk -G` sui commit sospetti. Azione `job.prepare {path, task}`.
- `push` giallo: commit non spinti. Azione `push {path}`.
- `remoto` giallo: repository senza remoto (o ramo senza upstream).
- `app-ads` rosso, globale: `app-ads.txt` non identico byte per byte sui tre host (www.andreapiani.com,
  privacypolicyhub.vercel.app, walkie-talky.vercel.app; elenco cambiabile con `appAdsHosts` in `regole.json`).
- `vercel` rosso: l'ultima pubblicazione di produzione del sito collegato al progetto e' fallita (`state: 'ERROR'` in
  `RadarState.vercel`, `vercelHits` di `src/vercel.ts`, chiamata da `regole.ts`). Frase "L'ultima pubblicazione di
  <nome> su Vercel è fallita (<giorno mese>).", rimedio "Online resta quella del <giorno mese>. Guarda il registro su
  Vercel, correggi e ripubblica." (senza la prima frase se non c'e' una pubblicazione pronta prima), dettagli: commit,
  errore, indirizzo su vercel.com. Nessun pulsante.

I progetti senza git non entrano in `projects`. `counts` comprende anche le regole globali. Costo misurato su 68
progetti: primo controllo 11 s (quasi tutto `gh`), i successivi 0,4 s (solo `rev-parse`, nessun ricalcolo).
Un pulsante d'azione manda `{type: act, ...args}`; se `args` non ha `path`, la plancia aggiunge quello del progetto.

```ts
interface RadarApp {
  ascId: string;          // Apple ID dell'app
  bundleId: string;       // identificatore tecnico: si usa per collegare, MAI mostrato come nome
  name: string;           // nome su App Store Connect
  projectPath?: string;   // progetto collegato tramite PRODUCT_BUNDLE_IDENTIFIER
  version?: { string: string; state: string; label: string; tone: 'ok'|'attesa'|'male'; build?: string; releaseType?: string; at?: number };
  live?: string;          // ultima versione pubblicata
  reviews: { stars: number; title: string; body: string; territory?: string; at: number }[]; // ultime 5
  money?: { yesterday: number; last7: number; daily: number[]; currency: string }; // daily: 7 giorni fino a ieri, dal piu' vecchio
}
interface RadarState {
  apps: RadarApp[];
  totals: { yesterday: number; last7: number; daily: number[]; currency: string } | null;
  ascAt: number; admobAt: number;   // 0 = mai letto; admobAt fissa il giorno usato per il report AdMob (sette giorni fino a ieri)
  ascError?: string; admobError?: string;
  refreshing: boolean;
  vercel?: VercelState;   // assente se il radar non legge Vercel (prove con dir o fetch finti)
}
interface VercelSito {
  projectId: string;
  name: string;           // nome del progetto su Vercel
  projectPath: string;    // progetto collegato
  via: 'project.json' | 'repo.json' | 'github' | 'nome';
  state: string;          // READY, ERROR, BUILDING, INITIALIZING, QUEUED, CANCELED
  label: string;          // "pubblicata", "fallita", "in costruzione", "in coda", "annullata"
  tone: 'ok' | 'attesa' | 'male';
  at: number; readyAt?: number;
  domain?: string;        // dall'alias dell'ultima pronta: prima un dominio vero, poi *.vercel.app
  url: string;            // dettaglio della pubblicazione su vercel.com (solo https://vercel.com/...)
  commit?: { sha: string; message: string; ref?: string };
  error?: string;         // solo per le fallite
  lastReady?: { at: number; url: string }; // se l'ultima non e' pronta: quella che resta online
}
interface VercelState { sites: VercelSito[]; at: number; error?: string; refreshing: boolean } // at 0 = mai letto
interface Briefing {
  date: string;            // YYYY-MM-DD
  at: number;
  text: string;            // quello che Melissa dice (circa trenta secondi)
  points: { kind: 'ore'|'lavori'|'store'|'soldi'|'regole'|'calendario'|'dimenticati'|'notte'; text: string; act?: RuleAction }[];
  heard: boolean;          // gia' ascoltato o chiuso oggi
}
interface Forgotten { path: string; name: string; idleDays: number; reasons: string[] } // fermi da 14 giorni o piu'
// Anche un progetto vivo compare se ha una copia di lavoro (worktree) ferma da 14 giorni con modifiche o commit
// da spingere: il motivo dice quale copia, il ramo e da quanti giorni.
interface NightState {
  from: string; to: string;      // "01:00", "06:00"
  parallel: number;              // 1 o 2
  queued: number; running: number;
  ac: boolean | null;            // alimentazione dalla corrente (null: Nucleo assente)
  why: string;                   // perche' adesso parte o non parte, una frase
  report: { date: string; jobs: { id: string; project: string; task: string; status: string; summary?: string }[] } | null;
}
```

Siti su Vercel (`src/vercel.ts`, agganciato al radar: stessa cartella, stessa spinta, cadenza sua):
- Nessuna chiave nuova: la CLI di Vercel gia' collegata (`vercel api`, che firma da sola). Il token non passa mai
  dalla Bottega. Elenco chiuso (`comandoAmmesso`): `whoami`, `ls`, `inspect`, `project ls` e `api` solo con `-X GET`
  su `/vN/deployments`, `/vN/projects`, `/vN/user` (piu' un id); rifiutati prima di lanciare il processo `deploy`,
  `rm`, `env`, `promote`, `rollback`, `redeploy`, `alias`, `--token`, `-F`, `--input` e tutto il resto.
- Collegamento: `.vercel/project.json` (nella cartella o in una sottocartella), `.vercel/repo.json`; in mancanza il
  repository GitHub del remoto origin (letto da `.git/config`) o il nome (cartella, `vercel.json`, `package.json`,
  non i nomi generici come web, app, sito) uguale a quello di una pubblicazione recente.
- Costo misurato su 144 progetti (42 collegati): prima lettura 35 chiamate in 26 s, poi a regime UNA chiamata
  (`/v6/deployments?target=production&limit=100`, circa 1 s). I progetti fuori dalle ultime 100 si leggono uno per
  uno solo se la lettura precedente potrebbe aver perso qualcosa (in pratica ogni qualche giorno); i dettagli
  (`/v13/deployments/<id>`: alias ed errore) solo per le pubblicazioni nuove. Al massimo 3 pagine, 16 progetti e
  16 dettagli per lettura, due processi insieme, `nice -n 10`, 30 s di tempo massimo per chiamata.
- Cadenza: `bottega.vercel.ogniMinuti` (default 30, tra 10 e 1440); `radar.refresh` la forza, al massimo una volta
  al minuto. Un progetto tolto da Vercel (404) si ricorda e non si richiede a ogni lettura.
- Cache `~/.bottega/radar/vercel.json` (cartella 700, file 600): solo stati, date, domini, messaggi di commit e
  indirizzi di vercel.com. Le variabili d'ambiente che l'API manda con i dettagli restano in memoria.
- Una pubblicazione di produzione fallita accende il semaforo rosso del progetto (regola `vercel`, sopra).

Punto `calendario` del briefing (nella plancia «Agenda»), subito dopo le regole: «Oggi hai: 09:00 ..., 16:30 ...»
(`fraseCalendario`: ordinati per ora, al massimo cinque, gli altri contati; «Oggi in agenda non hai niente.» se vuoto).
Viene dalla delega del calendario (5.7); se la delega e' in corso, fallita, spenta o fermata dal tetto, la riga non c'e'.

Il `Job` della sezione 3 acquista `night?: boolean` e lo stato `'stanotte'` (in fila per la notte: non parte di giorno).
I lavori notturni partono con un preambolo che vieta push, pubblicazioni e deploy, e con il modo di permessi
`bottega.notte.permessi` (default `acceptEdits`).

### 4.2 Messaggi nuovi, plancia -> estensione

| messaggio | campi | risposta |
|---|---|---|
| `rules.refresh` | | snapshot |
| `rule.fix` | `path`, `rule` | snapshot (conferma modale prima di toccare App Store Connect) |
| `job.prepare` | `path`, `task` | `{type:'composer', path, task}`: la plancia apre Lavori con il compositore gia' scritto |
| `radar.refresh` | | snapshot |
| `briefing.listen` | | Melissa lo dice a voce |
| `briefing.make` | | rifa' il briefing adesso, snapshot |
| `briefing.dismiss` | | `heard = true`, snapshot |
| `continua.prepare` | `path` | `{type:'continua', path, prompt, sources: string[]}` |
| `job.new` | `path`, `task`, `night?` | come prima; con `night: true` va in fila per la notte |
| `notte.config` | `from`, `to`, `parallel` | snapshot |
| `notte.now` | `id` | fa partire subito un lavoro della notte |
| `clients.request` | `month?` (`YYYY-MM`, default mese in corso) | `{type:'clients', report: ClientReport}` |
| `clients.save` | `clients: Client[]` | `{type:'clients', report}` |
| `clients.export` | `month`, `format`: `csv` o `md` | `{type:'clients.exported', path}` (dialogo di salvataggio, poi Finder) |
| `ricerca` | `query` | `{type:'ricerca', query, memoria: MemoryItem[], codice: CodeHit[], ms, error?}` |

```ts
interface Client { id: string; nome: string; progetti: string[]; tariffa?: number } // tariffa in euro l'ora, facoltativa
interface ClientReport {
  month: string; months: string[];  // mesi con ore registrate, dal piu' recente
  rounding: number;                 // 15: ogni giorno di ogni cliente si arrotonda al quarto d'ora piu' vicino
  clients: { id: string; nome: string; minutes: number; raw: number; amount?: number;
             days: { date: string; minutes: number }[]; projects: { path: string; name: string; minutes: number }[] }[];
  unassigned: { path: string | null; name: string; minutes: number }[];
  config: Client[];
  projects: { path: string; name: string }[];
}
interface CodeHit { project: string; projectPath: string; file: string; line: number; text: string }
```

Le ore di un cliente sono l'unione degli intervalli di tutte le sue sessioni (stessa regola del cruscotto: due
sessioni insieme contano una volta), giorno per giorno, poi arrotondate al quarto d'ora piu' vicino. Il totale e' la
somma dei giorni arrotondati.

### 4.3 Estensione -> plancia, messaggi nuovi

`{type:'composer', path, task, night?}`, `{type:'continua', ...}`, `{type:'clients', report}`,
`{type:'clients.exported', path}`, `{type:'ricerca', ...}` (vedi sopra).

### 4.4 Nucleo: comandi nuovi

| cmd | argomenti | risposta | note |
|---|---|---|---|
| `power.status` | | `ac: bool`, `battery: number\|null`, `charging: bool`, `lowPower: bool` | IOKit `IOPSCopyPowerSourcesInfo`; `battery` null su un Mac senza batteria |
| `power.keepAwake` | `reason` | `token` (`sveglio-N`) | `IOPMAssertionCreateWithName` (`PreventUserIdleSystemSleep`), nome visibile in `pmset -g assertions`: `Bottega: <reason>`. Chiuso il Nucleo, tutte le asserzioni si rilasciano |
| `power.release` | `token` | | errore in italiano se il token non esiste |
| `spotlight.index` | `items: [{id, kind: 'progetto'\|'ricordo', title, text?, url, keywords?, date?}]`, `replace?: bool` | `count` | CoreSpotlight, `domainIdentifier` = kind, `uniqueIdentifier` = `kind:id`. `date`: millisecondi, secondi o `YYYY-MM-DD`. `replace` svuota prima i domini dei kind presenti. Ogni chiamata ha 10 s; se Spotlight e' spento (`mdutil`) risponde con un errore in italiano (CoreSpotlight -1003). Gli url stanno anche in `~/.bottega/nucleo/spotlight.json` (600), perche' il clic su un risultato porta solo l'identificatore |
| `spotlight.clear` | `kind?` | | senza `kind` svuota tutto |
| `widget.reload` | | | Chiede a WidgetKit una nuova timeline; il sistema decide quando visualizzarla. Invalidazioni aggregate, al massimo una ogni 5 minuti salvo riconnessione del Nucleo |

Eventi nuovi: `power.changed {ac, battery, charging}` (notifica di IOKit, nessun polling).
`menubar.update` accetta anche `lines?: [{id?, title, tone?: 'rosso'\|'giallo'\|'ok'}]` (righe in cima al menu: soldi di
ieri, regole violate, briefing) e `tone?: 'rosso'\|'giallo'\|null` (un puntino colorato sull'icona). Un clic su una riga
con `id` emette `menubar.clicked {item: id}`.
`lines` e `tone` assenti lasciano quelli di prima; `tone: null` toglie il puntino. `tone: 'ok'` non disegna il puntino
sull'icona (le righe con `tone: 'ok'` hanno un puntino verde). Le righe senza `id` non sono cliccabili. I numeri
(`busy`, `waiting`, `queued`) vengono da `workCounts` (4.9): `inCorso`, `tiAspetta`, `inCoda + stanotte`.

Il Nucleo lanciato da macOS e non dall'estensione (App Intents, un clic su Spotlight, il widget) si riconosce perche'
stdin non e' una pipe, ne' un socket, ne' un terminale (`BOTTEGA_NUCLEO_MODO=servizio|macos` lo forza). In quel modo
non scrive JSON su stdout, non accende voce, sfera, scorciatoia o barra dei menu, ed esce da solo dopo 30 secondi di
quiete. Il Nucleo lanciato dall'estensione non risulta a LaunchServices: intents e clic arrivano sempre a una seconda
copia in modo macOS, che convive con il servizio.

### 4.5 Schema URL `bottega://andreapiani.bottega-home/<via>`

`progetto?path=`, `ricordo?id=&q=`, `chiedi?testo=`, `lavoro?progetto=&compito=` (sempre con conferma modale: un link
non avvia mai un lavoro da solo; `lavoro` senza `progetto` apre il compositore vuoto), `briefing`, `vedetta`,
`continua?progetto=`, `cerca?q=`, e (sezione 7) `melissa` (apre Melissa e la conversazione), `plancia`, `osservatorio`.

### 4.6 App Intents, Comandi rapidi e widget

Il Nucleo espone «Chiedi a Melissa», «Avvia un lavoro», «Briefing», «Stato delle regole». I primi due aprono lo schema
URL; gli altri leggono `~/.bottega/stato.json`:

```json
{ "aggiornato": 1790900000000,
  "briefing": { "date": "2026-10-02", "text": "..." },
  "regole": { "rosso": 1, "giallo": 4, "verde": 30, "voci": [{ "progetto": "Peak", "livello": "rosso", "frase": "..." }] },
  "soldi": { "ieri": 12.3, "sette": 80.1, "valuta": "USD", "aggiornato": 1790900000000 },
  "lavori": { "inCorso": 1, "tiAspetta": 0, "inCoda": 0, "stanotte": 2, "vive": 3 } }
```

Intents (identificatori nel bundle): `ChiediAMelissa` (testo), `AvviaLavoro` (progetto, compito), `LeggiBriefing`
(restituisce il testo come dialogo e apre `briefing`), `StatoDelleRegole` (una frase: quante rosse e gialle, poi le prime
tre voci, rosse prima). Frasi: «Chiedi a Melissa con <app>», «Avvia un lavoro con <app>», «Briefing di <app>», «Stato
delle regole di <app>» e una variante ciascuna. Sono in `Contents/Resources/Metadata.appintents`, generato da
`nucleo/build.sh` con `appintentsmetadataprocessor` (la build si ferma se mancano); `scripts/package.sh` registra il
Nucleo installato con `lsregister -f` e il widget con `pluginkit -a`.

Widget: `Bottega Nucleo.app/Contents/PlugIns/BottegaWidget.appex` (`com.andreapiani.bottega.nucleo.widget`, kind
`com.andreapiani.bottega.stato`), piccolo, medio e grande: semaforo delle regole, conteggi, prime tre voci, briefing.
Sandbox con sola lettura di `~/.bottega/stato.json`. La timeline richiede un rinnovo ogni 15 minuti; `widget.reload` chiede un aggiornamento anticipato, soggetto al budget di WidgetKit. Un tocco
apre `bottega://andreapiani.bottega-home/briefing` (lo riceve il Nucleo e lo gira alla Bottega).

Aggiornamento continuo (4 ottobre 2026): Idee ricalcola le ore ogni 60 secondi anche con la Home
nascosta o la finestra senza focus. Il risultato pubblicato alla Home e quello scritto nel widget
sono lo stesso snapshot; un calcolo più vecchio non può sostituirne uno più recente. Gli eventi
continui vengono aggregati senza rimandare la scrittura indefinitamente. La sola riscrittura del
heartbeat non consuma una nuova invalidazione WidgetKit. `ore.aggiornato` identifica il calcolo,
indipendentemente da `aggiornato` del file; un errore conserva i dati precedenti con la loro data.
Il widget Oggi legge regole e ore dallo stesso file letto una sola volta e mostra fonti e data/ora.
I conteggi e le voci attive dei lavori usano il registro multi-fonte anche sul widget Mac.

Installazione: `scripts/widget-lifecycle.sh` termina esclusivamente l'appex Bottega installato
prima di sostituire il bundle, anche se sospeso. Dopo la registrazione LaunchServices/pluginkit
ripete il controllo per coprire un riavvio automatico; solo dopo riapre Bottega. Questo evita
`WidgetArchiver.ValidationError.bundleStubNotSupported: Bundle version did not match`:
il vecchio processo del widget sopravviveva agli aggiornamenti dell'app e macOS scartava tutte
le nuove timeline. `--stage-only` non termina processi e non modifica l'installazione.

### 4.7 La Plancia e' la Home, fissa

La Plancia si apre sempre all'avvio, anche con una cartella aperta (senza rubare il fuoco), come prima scheda
appuntata del primo gruppo. Chiuderla e' possibile, ma il comando `bottega.openPlancia` (Cmd+Maiusc+H) e l'icona della
barra di stato la riaprono appuntata. Un serializzatore la ripristina al riavvio.

Nello snapshot, `advice: Advice | null`:
```ts
interface Advice {
  at: number;                      // quando sono stati generati
  engine: 'apple' | 'regole';      // Apple Intelligence sul Mac, oppure frasi fisse se non c'e'
  items: { text: string; act?: RuleAction }[]; // da 3 a 5 consigli, una frase ciascuno
}
```
I consigli nascono da candidati verificabili (`adviceCandidates` in `src/briefing.ts`): ogni fatto ha il suo rimedio e
il suo pulsante, e le violazioni uguali in piu' progetti diventano un solo candidato con il rimedio al plurale. Apple
Intelligence (`ai.generate` del Nucleo) sceglie e ordina i 3-5 piu' importanti rispondendo solo con i numeri; il testo
mostrato e' sempre il rimedio esatto, mai una frase del modello (provato sui dati veri: quando riformulava sbagliava
soggetti e stati). `engine: 'apple'` vuol dire «scelti da Apple Intelligence». Senza Apple Intelligence, o se il
modello non restituisce almeno due numeri validi, valgono i primi quattro candidati. Al massimo una volta ogni 3 ore o
quando cambia molto il quadro; messaggio `advice.refresh` per rifarli a mano.

Il briefing detto a voce e' sempre: apertura di Melissa, i punti esatti come escono dai dati, chiusura di Melissa.
Agnes scrive solo le due frasi di apertura e chiusura (senza numeri ne' fatti: se contengono cifre si scartano e si
dice «Buongiorno.»). Provato sui dati veri: quando Agnes riscriveva tutto il briefing cambiava i numeri.

### 4.8 Melissa vive dentro l'IDE

`bottega.voice.sfera`: `ide` (default) o `schermo`. Con `ide` l'estensione non manda mai `orb.show` ne' `orb.dock` (e
all'avvio manda `orb.hide`): la sfera del Nucleo non galleggia sullo schermo e non copre le altre app (per esempio la
Melissa di Avo Agency AI, che ha una sfera sua e la scorciatoia Cmd+Opzione+M). Melissa sta nella barra laterale
DESTRA (sezione 6) e nella barra di stato: `Melissa` con l'icona dello stato (microfono, ascolto, rotella che pensa,
altoparlante, avviso), colorata col sodio quando e' attiva; un clic apre o chiude la conversazione. Quando Melissa
comincia ad ascoltare, la barra si mostra senza rubare il fuoco. Con `schermo` torna il comportamento di prima (sfera
grande in conversazione, piccola agganciata con `bottega.voice.orbAlwaysVisible`).

La sfera delle viste (barra e pagina di Melissa) usa il componente unico in WebGPU se c'e'
(`media/motore/sfera-gpu.js`): `window.BottegaSferaGPU.mount(canvas, {reduced, onFail}) -> {set(stato, spenta,
livello), wake(), sleep(), riposa(si), redraw()}`. Riposo (build 32, rivisto nella 34): con `riposa(true)` la sfera
in `idle` o spenta, finiti i movimenti (1,5 s dall'ultimo cambio, voce muta), si ferma su un fotogramma e riparte al
primo `set` che cambia stato. Barra e Home chiamano `riposa(false)` finche' la finestra della Bottega e' davanti
(`fuoco`): li' la sfera gira sempre, anche con Melissa spenta (ferma sembrava un'immagine). Dietro si ferma, tranne
quando Melissa ascolta, pensa o parla. Con la finestra dietro il `body` prende la classe `sfondo` e le
animazioni dei CSS si mettono in pausa. L'adattatore arriva dopo: se WebGPU manca, `onFail(motivo)` e si passa al Canvas
2D su un canvas nuovo, con il motivo nel log (idem se `mount` lancia o il file non c'e'). La Home carica i file di
`media/motore/` presenti prima delle stanze.

### 4.9 Il lavoro in giro: una sola fonte di verita'

Per Andrea ogni sessione Claude viva e' un lavoro, avviata dalla Bottega o no. Lo snapshot porta:

```ts
interface WorkItem {
  key: string;                       // "job:<id>" oppure "sess:<sessionId>"
  source: 'bottega' | 'altrove';     // lavoro della Bottega o sessione aperta fuori (terminale, altra app)
  status: 'in corso' | 'ti aspetta' | 'nel terminale' | 'in coda' | 'stanotte';
  project: string; path: string; title: string; since: number;
  jobId?: string; sessionId?: string; pid?: number; night?: boolean;
}
interface WorkCounts { inCorso: number; tiAspetta: number; nelTerminale: number; inCoda: number; stanotte: number; vive: number }
// Snapshot: work: WorkItem[] (le vive in ordine di since, dalla piu' recente; poi in coda e stanotte nell'ordine in cui partiranno), workCounts: WorkCounts
```

Da `registro ~/.claude/sessions`: `busy` = in corso, `idle` = ti aspetta, `shell` = nel terminale. Una sessione senza
ancora il suo jsonl in `~/.claude/projects` (`LiveSession.empty`, da `readLiveSessions`) e non `busy` non e' lavoro: e' il
pannello di Claude Code nell'editor, che avvia il processo appena si apre anche se nessuno scrive. Un lavoro della
Bottega appena partito, che non ha ancora la sua sessione, assorbe la sessione nata dopo nella stessa cartella (niente
doppioni). `workItems` e `workCounts` (in `src/jobs.ts`) producono lavori e code Claude. Dalla build 102,
`conteggiOsservati(activity, workCounts(work))` calcola `inCorso` e `tiAspetta` sul registro comune Claude, Codex,
Cline e terminali, preservando `inCoda`, `stanotte` e `nelTerminale`. `vive` somma i due contatori attivi e
`nelTerminale`. Frase, KPI e grafici della Home e di Lavori usano questo stesso registro; un array vuoto azzera
i contatori attivi. Senza `activity`, le vecchie istantanee mantengono il comportamento precedente. Gli strumenti
Claude `lavori_elenco` e `sessioni_attive` continuano a descrivere le sessioni azionabili di Claude. Messaggio `bacheca.sessione {sessionId}` -> `{type:'bacheca.sessione', sessionId,
items}`: cosa ha fatto quella sessione nelle ultime tre ore, dalla bacheca della Memoria.

### 4.10 Worktree git

Una cartella il cui `.git` e' un FILE (`gitdir: <repo>/.git/worktrees/<nome>`) e' un worktree, non un progetto. Se il
repository principale e' tra i progetti, il worktree compare dentro di lui (`Project.worktrees: {path, branch, changes,
ahead, upstream}[]`) e tutto cio' che succede li' (sessioni passate e vive, ore del cruscotto, memoria) e' del progetto
principale. Una sola regola, in due copie allineate: `worktreeMain`/`canonKey` in `src/scan.ts` (usata da
`sessionOwner`, quindi anche dal cruscotto) e `worktreeMain` in `memoria/lib/paths.mjs` (usata da `projectOf`).

## 5. Connettori e posta per progetto

La Bottega non tiene chiavi di Gmail, Vercel o simili: usa i connettori che l'utente ha gia' in Claude Code. Codice:
`src/connettori.ts` (scoperta, mappa, sola lettura), `src/connettori-mappa.ts` (la mappa), `src/mcp.ts` (client MCP
diretto), `src/delega.ts` (deleghe a `claude -p`), `src/posta.ts` (rubrica e fili), `src/whatsapp.ts` (chat per
progetto), `src/strumenti-connettori.ts` (gli strumenti di Melissa, 5.7), `src/connettori-host.ts` (la stanza,
agganciata in `extension.ts` con `registerConnettori` e `handleConnettori`), `media/connettori.js` e `.css` (la stanza
Connettori, ottava scheda della plancia).

### 5.1 Due tipi di connettori

| tipo | da dove | come si usa | costo |
|---|---|---|---|
| claude.ai (Gmail, Google Calendar, Vercel, Stripe...) | `claude mcp list` | solo delega a `claude -p` | da 8 a 80 s, da 0,02 a 0,08 $ (con il perimetro, 5.4) |
| locale stdio (mail-mcp, asc-mcp, google-play, whatsapp-business, whatsapp-personal...) | `~/.claude.json`, `mcpServers` utente e per progetto | client MCP diretto | istantaneo, gratis |
| remoto http e plugin | `claude mcp list` e `~/.claude.json` | delega (oggi non usati) | come claude.ai |

`claude mcp list` controlla la salute di ogni server ed e' lento (circa 25 s): si lancia con `nice` dalla home, al
massimo una volta al giorno (cache in globalStorage, `connettori-mcp-list.json`) o su richiesta. Riga per server:
`<nome>: <destinazione> - <icona> <stato>`; stati (`statoDa`) `Needs authentication` -> `da autenticare`,
`Not configured` -> `non configurato`, `Connected` -> `connesso`. `Connected` vince su `fail` e `timed out`: la riga
`! Connected · tools fetch failed, Request timed out` e' `connesso` con `avviso: "collegato, il controllo degli
strumenti è scaduto"` (`"... non è riuscito"` senza timeout), perche' e' scaduto il controllo di salute, non il server.
`Failed to connect`, `Disconnected` e un timeout senza `Connected` restano `errore`. I server in `~/.claude.json` che
l'elenco non ha visto (quelli di progetto) entrano come `sconosciuto`. Dalla configurazione locale si leggono solo nomi
e forma: comando, argomenti ed `env` restano in memoria il tempo di avviare il server, mai in cache, log o messaggi.
Dei remoti e di claude.ai si tiene `origine` (`origineDi`): schema e host dell'indirizzo
(`https://gmailmcp.googleapis.com`), mai percorso o query, che possono contenere chiavi.

Nella stanza i plugin non collegati (`tipo: 'plugin'`, stato diverso da `connesso`) stanno in un riquadro chiuso in
fondo, una riga per nome pulito e stato ("gmail, non configurato, in 5 plugin: sales, design...").

Strumenti di Claude Code: `mcp__<nome con i caratteri fuori da [A-Za-z0-9_-] sostituiti da _>__<strumento>`, per
esempio `mcp__claude_ai_Gmail__search_threads`, `mcp__plugin_design_slack__...`, `mcp__mail-mcp__search_messages`.

### 5.2 Capacita' e mappa

Capacita': `posta`, `calendario`, `deploy`, `store`, `file`, `pagamenti`, `pubblicita`, `ricerca`, `messaggi` (le chat
WhatsApp dei clienti di ogni progetto, mappa `['/^whatsapp/']`). La mappa (`src/connettori-mappa.ts`) lega a ogni
capacita' dei nomi puliti (minuscolo, senza `claude.ai ` e `plugin:<x>:`), esatti o espressioni tra barre.
L'impostazione `bottega.connettori.mappa` aggiunge voci, per esempio `{ "posta": ["mio-imap"] }`. Una capacita' e'
accesa se almeno un connettore mappato e' connesso, o e' un server locale stdio a livello utente non ancora
controllato. `STRUMENTI` della stessa mappa dice quali strumenti usare per capacita' e connettore (per `messaggi`:
`list_chats`, `search_contacts`); tutti passano comunque da `soloLettura`.

### 5.3 Sola lettura, sempre

`soloLettura(nome, annotazioni?, server?)` (`src/connettori.ts`), sul nome breve dello strumento spezzato in parole
(`search_threads`, `getThread`):
1. falso, sempre, se una parola e' tra quelle che scrivono, inviano, cancellano o spendono (`send`, `reply`, `delete`,
   `update`, `create`, `generate`, `token`, `download`, `publish`, `sync`, `transcribe`... elenco `SCRIVE`), quindi
   `get_or_create`, `list_and_delete`, `auth_generate_token` restano fuori;
2. falso, sempre, anche con `readOnlyHint` o con il permesso a mano, se il nome corrisponde a
   `SENSIBILI = /one_time_code_values|certificate|verify_signature|parse_payload|secret|credential|password/i`: codici
   promozionali riscattabili, certificati, firme e contenuti dei webhook. Non scrivono, ma il loro contenuto finirebbe
   nel contesto di Melissa e del suo cervello;
3. vero se una parola e' un verbo o un nome di lettura, in qualunque posizione (asc-mcp e google-play scrivono
   `apps_list`, `builds_get_processing_state`): `search`, `list`, `get`, `read`, `query`, `fetch`, `find`, `count`,
   `check`, `inspect`, `analyze`, `analysis`, `compare`, `comparison`, `explore`, `trend`, `stats`, `report`, `summary`,
   `overview`, `breakdown`, `status` (elenco `LEGGE`);
4. vero se `annotazioni.readOnlyHint === true` (da tools/list: `ClientMcp.chiama` le passa quando ha gia' fatto
   `strumenti()`);
5. vero se il server e' in `bottega.connettori.letturaPermessa` con un nome breve che corrisponde
   (`{ "admob": ["/.*/"] }`, chiavi e valori esatti o /regex/), per i server di sola analisi i cui strumenti non hanno
   un verbo (`top_apps`, `wow_revenue`). Server: il terzo argomento, o il prefisso `mcp__<server>__` del nome. Default
   `admob`, `searchconsole`, `keyword-suggest` con `/.*/`; la stanza lo carica con `impostaLetturaPermessa` all'avvio e
   a ogni cambio dell'impostazione.

Conteggi su tools/list del 2 ottobre 2026, prima e dopo le regole 3, 4 e 5: admob 4 e 34 su 36, asc-mcp 0 e 195 su
389, google-play 0 e 26 su 48, searchconsole 4 e 13 su 17, keyword-suggest 0 e 9 su 9.

Il client diretto (`ClientMcp.chiama`) rifiuta il resto prima ancora di avviare il server; la delega passa a
`--allowedTools` solo strumenti che superano lo stesso filtro (con il nome completo, quindi anche la regola 5).

### 5.4 Deleghe (`claude -p`)

```
nice -n 10 claude -p --output-format stream-json --verbose --model <bottega.connettori.modello, default haiku>
  --permission-mode dontAsk --no-session-persistence --max-budget-usd <min(tetto residuo, 0,40)>
  --settings '{"disableAllHooks":true,"allowedMcpServers":[{"serverUrl":"<origine>/*"}]}'
  --tools "" --allowedTools <strumenti di sola lettura, separati da virgola>
  --disallowedTools <gli altri strumenti visti dello stesso server, o gli altri server se l'origine manca>
  (prompt su stdin, cwd ~/.bottega/connettori, env BOTTEGA_DELEGA=1)
```

Il perimetro (`perimetroDelega`): Claude Code carica gli schemi degli strumenti di tutti i server MCP (997 il 2 ottobre
2026) e haiku, senza ricerca differita, sforava ("Prompt is too long"). `--strict-mcp-config` toglie anche i connettori
di claude.ai; `allowedMcpServers` con `serverName` non li riconosce; con `serverUrl` carica solo quel server e non avvia
nemmeno i server locali. Per un server locale si usa `serverName`. Se un server da usare non ha ne' origine ne' tipo
locale, `allowedMcpServers` non si scrive e si negano per nome tutti gli altri server noti. Il primo messaggio di
stream-json (`system/init`) elenca gli strumenti caricati: i nomi (solo nomi) si uniscono in
`~/.bottega/connettori/strumenti-visti.json` (600) e dalla delega successiva gli altri strumenti dello stesso server si
negano. `disableAllHooks`: nessun hook dell'utente (uno costava 6 s a ogni delega). `CodaOpts.server?: () => { nome,
prefisso, tipo?, origine? }[]` porta i connettori conosciuti (la stanza passa quelli di `claude mcp list`).

Misure (una ricerca Gmail): tutti i server con haiku "Prompt is too long"; sonnet con ricerca differita 0,72 $ al
primo turno; haiku con gli altri server negati 16 s e 0,068 $; haiku con solo search_threads e senza hook 9 s e
0,028 $; la delega vera della posta 81 s e 0,077 $ con 24 fili, da 8 a 9 s e circa 0,02 $ con pochi risultati.

Il prompt chiede SOLO JSON, con lo schema scritto dentro, e di chiamare sempre gli strumenti prima di rispondere (una
volta haiku aveva risposto `[]` a memoria). Una delega alla volta, in coda, timeout 180 s. Uscita letta dall'ultima
riga di stream-json con `result`: `{ result, is_error, subtype, total_cost_usd, num_turns }`; dentro `result` il JSON
si estrae anche da un blocco ```` ```json ````. Tetto giornaliero `bottega.connettori.tettoGiornalieroUsd` (default 1):
se la spesa di oggi piu' la stima supera il tetto, la delega non parte; una delega sola non supera mai 0,40 $
(`MASSIMO_PER_DELEGA`). Stima = media delle ultime cinque deleghe riuscite della stessa capacita', altrimenti
`STIMA_BASE` 60 s e 0,08 $. Spesa di oggi e tetto sono sempre scritti in testa alla scheda Connettori, anche a zero.

Una delega non e' una sessione di Andrea:
- **Hook della Memoria**: con `BOTTEGA_DELEGA=1` nell'ambiente escono subito con 0, prima di leggere il payload, senza
  scrivere spool, bacheca o contesto (`memoria/lib/hook.mjs`, `guard`).
- **Sessioni vive**: nel registro `~/.claude/sessions/<pid>.json` una delega e' `kind: interactive`,
  `entrypoint: sdk-cli` (verificato il 2 ottobre 2026), come qualunque programma fatto con l'SDK. Il segno sicuro e'
  la cartella di lavoro: `readLiveSessions` scarta le voci con `cwd` dentro `~/.bottega/connettori` (`isDelega`),
  quindi le deleghe non compaiono tra le sessioni vive, nei Lavori e nel cruscotto.
- `--no-session-persistence`: nessun jsonl in `~/.claude/projects`, quindi niente nelle sessioni passate.

File, tutti 600 in una cartella 700:

```ts
// ~/.bottega/connettori/<capacita>.json, l'ultima delega di quella capacita' (posta, chiedi, calendario...)
interface EsitoDelega { capacita: string; at: number; ok: boolean; costo: number; durataMs: number; turni?: number; errore?: string; data?: unknown }
// ~/.bottega/connettori/spesa.json
interface Spesa { giorni: Record<'YYYY-MM-DD', number>; storico: { at; capacita; costo; durataMs; ok }[] } // 60 giorni, 40 deleghe
// ~/.bottega/connettori/strumenti-visti.json: { at, strumenti: string[] }, nomi completi visti nei messaggi init
```

### 5.5 Posta per progetto

```ts
// ~/.bottega/rubrica.json (600, mai nel repository)
type Rubrica = Record<string /* percorso del progetto */, { indirizzi: string[]; domini: string[];
  telefoni?: string[] /* E.164: "+34600000000" */; gruppi?: string[] /* "<cifre>@g.us" */ }>;
// telefoni e gruppi si scrivono solo se non vuoti: le rubriche di prima restano valide
// ~/.bottega/connettori/posta-fili.json (600)
interface FileFili { at: number; giorni: number; fonti: { locale?: FonteStato; gmail?: FonteStato }; fili: Filo[] }
interface FonteStato { nome: string; at: number; n: number; costo?: number; durataMs?: number; errore?: string; pieno?: boolean }
interface Filo { id: string /* gmail:<threadId> | mail:<account>:<mailbox>:<id> */; fonte: 'gmail' | 'mail'; threadId?: string;
  da: string; indirizzo: string; oggetto: string; data: string /* ISO */; nonLetto: boolean; anteprima: string; link?: string }
```

Fonti: il server di posta locale (un solo `search_messages {since, limit: 500, includeBody: false}`, il massimo di
mail-mcp: mittente, oggetto, data e letto, mai il corpo; se torna pieno `pieno: true` e la stanza dice che i messaggi
potrebbero essere di piu') e Gmail di claude.ai (UNA delega con `search_threads`: i mittenti e i domini in rubrica,
`newer_than:Nd {from:a from:dominio}`, piu' `newer_than:Nd is:unread in:inbox category:primary` per i mittenti nuovi).
Ogni fonte sostituisce solo i suoi fili; gli errori di una fonte si salvano in `posta-fili.json` e i fili di prima
restano. Link Gmail: `https://mail.google.com/mail/u/0/#all/<threadId>`; per la posta locale si apre Mail.

Regole di assegnazione: l'indirizzo esatto vince sul dominio; tra i domini vince il piu' lungo (`shop.cliente.it`
batte `cliente.it`, un sottodominio del mittente vale); a parita' il filo va a tutti i progetti. Chi non corrisponde
va in "Da assegnare", raggruppato per mittente; per i fornitori di posta (gmail.com, libero.it...) si offre solo
l'indirizzo, mai il dominio. `rubrica.add` riconosce un gruppo (`...@g.us`), un indirizzo (chiocciola), un telefono
(cifre, spazi, `+`, `00`, normalizzato in E.164) o un dominio.

Proposte e suggerimenti:
- `indiceProgetti`: i domini dei file di ogni progetto (`package.json` homepage, `vercel.json` alias e domains, URL di
  README e CLAUDE.md), senza quelli generici (github.com, vercel.app, apple.com, google.com...) e senza
  `bottega.posta.dominiIgnorati`. I domini che compaiono in PIU' di un progetto sono di fornitori e si scartano;
- `proposte(fili, indice)`: per ogni mittente in "Da assegnare", dal motivo piu' forte: il dominio sta nei file di un
  solo progetto ("il dominio è nel README"), il dominio richiama il nome del progetto, il nome del mittente lo cita, un
  oggetto lo cita ("l'oggetto cita <progetto>"). Citare (`citaProgetto`) = parole intere di seguito che attaccate fanno
  il nome attaccato ("CheckIn Facile" = "checkin facile" = "checkinfacile"), nomi sotto le 4 lettere esclusi. A parita'
  tra piu' progetti nessuna proposta. La voce proposta e' il dominio per i primi due motivi su un dominio proprio,
  altrimenti l'indirizzo;
- mittenti automatici (`mittenteAutomatico`: `noreply`, `no-reply`, `donotreply`, `notifications`, `mailer-daemon`,
  `postmaster`, `newsletter`, `bounce`, `alerts`...) fuori da "Da assegnare" e dalle proposte, solo contati; si
  assegnano a mano o con un dominio gia' in rubrica;
- i domini dei file di un solo progetto non ancora in rubrica restano come indizio debole, in un riquadro chiuso in
  fondo (`suggerimenti`).

Impostazioni: `bottega.posta.giorni` (7), `bottega.posta.aggiornaOgniMinuti` (0, solo su richiesta; aggiorna la fonte
locale e WhatsApp), `bottega.posta.gmailOgniMinuti` (0; se acceso, Gmail in automatico al massimo ogni 120 minuti).

### 5.6 WhatsApp per progetto

Fonti: i server locali stdio con capacita' `messaggi` (whatsapp-business, whatsapp-personal), interrogati con il
client diretto (`src/whatsapp.ts`, `StanzaConnettori.serverDiretto`). `list_chats {limit: 100, page,
include_last_message: true, sort_by: 'last_active'}`, al massimo 5 pagine, fino alla prima chat piu' vecchia di
`bottega.whatsapp.giorni`; ogni riga e' un JSON `{ jid, name, last_message_time, last_message, last_sender,
last_is_from_me }`. Le chat `@lid` non hanno il numero nel JID: si trova con `search_contacts {query: <cifre del lid>}`,
voce con lo stesso `jid`, campo `phone_number`. Stato (`@broadcast`), bot e canali si scartano.

```ts
// ~/.bottega/connettori/whatsapp.json (600), al massimo 600 chat
interface FileWa { at: number; giorni: number; fonti: { business?: FonteWaStato; personale?: FonteWaStato }; chat: ChatWa[] }
interface FonteWaStato { nome: string; at: number; n: number; durataMs?: number; errore?: string }
interface ChatWa { id: string /* wa:<fonte>:<jid> */; fonte: 'business' | 'personale'; server: string; jid: string;
  gruppo: boolean; contatto: string; telefono: string /* E.164 o vuoto */; ultimo: string /* max 120 */;
  data: string /* ISO */; mio: boolean /* l'ultimo l'ha scritto Andrea */; nonLetto?: boolean /* solo se il server lo dice */ }
```

Privacy (`ammessa`, applicata prima di scrivere su disco e prima di mostrare): una chat del numero personale entra solo
se il numero o il gruppo e' in rubrica, oppure, con `bottega.whatsapp.personaleDaAssegnare` (default false), se e' di
una persona; le altre non vengono nemmeno scritte. Le chat del numero business entrano tutte, gruppi compresi. Dei
messaggi si tiene solo l'anteprima dell'ultimo. Si assegna per `telefoni` e `gruppi`; le chat senza numero non vanno in
"Da assegnare", dove una chat ha una proposta se il nome del contatto cita un solo progetto. Aprire: `open
whatsapp://send?phone=<cifre>` (solo persone con numero; non invia niente). Aggiornamento con il pulsante o insieme alla
posta locale (`bottega.posta.aggiornaOgniMinuti`).

Per gli altri moduli (`connettori-host.ts`): `stanzaConnettori(): StanzaConnettori | undefined`, la stanza attiva;
`StanzaConnettori.serverDiretto(nome): { nome; avvio: AvvioServer } | undefined`, un server locale stdio utilizzabile
(diretto, connesso o non ancora controllato a livello utente) con il modo di avviarlo, da passare a
`conServer`/`ClientMcp`. L'avvio contiene comando ed env: solo in memoria.

### 5.7 Melissa e i connettori

Codice: `src/strumenti-connettori.ts`. Gli strumenti entrano nell'elenco di Melissa da `extension.ts`
(`Object.assign(TOOLS, STRUMENTI_CONNETTORI)`, prima che nasca l'assistente) e il modulo riceve la stanza con
`registraStrumentiConnettori(registerConnettori(...))`. Gli strumenti sono in sezione 6 («Le mani di Melissa»).

- Sola lettura in due passi. Prima di avviare qualsiasi processo `connettore_leggi` scarta chi ha una parola che
  scrive o e' sensibile (regole 1 e 2 di 5.3, `soloLettura(nome, { readOnlyHint: true })`). Poi il server parte,
  `tools/list` da' le annotazioni e `ClientMcp.chiama` applica tutte le regole di 5.3 con annotazioni e server.
  `strumentiLeggibili(tools, server)` negli elenchi usa le stesse regole complete: per Melissa valgono quindi anche
  `readOnlyHint` e `letturaPermessa` (i report di admob come `top_apps` le arrivano). `strumentiNoti`, per le deleghe
  ai connettori di claude.ai, resta sui nomi brevi della mappa.
- Server locali stdio: `conServer` per chiamata, timeout 60 s, server chiuso a fine chiamata. Gli elenchi degli
  strumenti (`tools/list`: nome, descrizione, schema; mai comando o env) restano in memoria 5 minuti.
- Risultati per Melissa: campi vuoti tolti, testi oltre 500 caratteri accorciati, tutto troncato a 6000 caratteri con
  la lunghezza vera dichiarata. Quello che legge passa al suo cervello (Agnes, o quello scelto per la conversazione).
- Log: solo server, strumento e durata. Mai argomenti, contenuti o env.
- Deleghe di Melissa: capacita' `chiedi` (`~/.bottega/connettori/chiedi.json`), schema
  `{"risposta": "testo breve da leggere a voce"}`, strumenti presi da `STRUMENTI` della mappa piu' un piccolo elenco
  (`STRUMENTI_IN_PIU`), sempre filtrati con `soloLettura`.
- Calendario del briefing: capacita' `calendario`, una delega al giorno al massimo, dalle 5 del mattino, la prima volta
  che si raccolgono i fatti del briefing della giornata (briefing o consigli), solo se `claude.ai Google Calendar` e'
  connesso e `bottega.briefing.calendario` (default true) e' acceso. Strumento: solo `list_events`. Esito in
  `~/.bottega/connettori/calendario.json` (600, cartella 700), con
  `data: { giorno: 'YYYY-MM-DD', eventi: { ora: 'HH:MM' | 'tutto il giorno', titolo: string }[] }`. Un esito di oggi,
  anche fallito, vale come tentativo: non si riprova fino a domani. Se il file non e' di oggi o non e' riuscito, il
  briefing esce senza la riga (punto `calendario`, 4.1).

### 5.8 Messaggi plancia <-> estensione

| messaggio | campi | risposta |
|---|---|---|
| `connettori.request` | | `connettori` e `posta`; avvia `claude mcp list` se la cache ha piu' di un giorno |
| `connettori.refresh` | | rilegge `claude mcp list` adesso; `connettori` con `aggiornando: true`, poi il risultato |
| `posta.refresh` | `fonte`: `locale` (default) o `gmail` | `posta` con `aggiornando`, poi i fili nuovi |
| `whatsapp.refresh` | | `posta` con `whatsapp.aggiornando`, poi le chat |
| `rubrica.add` | `path`, `voce` (gruppo, indirizzo, telefono o dominio, 5.5) | `posta` |
| `rubrica.remove` | `path`, `voce` | `posta` |
| `posta.apri` | `id` del filo | apre Gmail nel browser o Mail |
| `whatsapp.apri` | `id` della chat | apre la chat in WhatsApp sul Mac (persone con numero) |

Estensione -> plancia (instradati da `plancia.js` alla stanza `BottegaConnettori`):

```ts
{ type: 'connettori', stato: ConnettoriStato & { deleghe: StatoDeleghe } }
{ type: 'posta', stato: PostaStato }
interface ConnettoriStato { aggiornatoAt: number; aggiornando: boolean; errore?: string; connettori: Connettore[];
  capacita: { id; nome; cosa; accesa: boolean; fonti: string[] }[] }
interface Connettore { nome; pulito; tipo: 'claude.ai' | 'plugin' | 'locale' | 'remoto';
  stato: 'connesso' | 'da autenticare' | 'non configurato' | 'errore' | 'sconosciuto'; prefisso: string; capacita: string[];
  diretto: boolean; ambito: 'claude.ai' | 'utente' | 'progetto' | 'plugin'; progetti?: string[];
  avviso?: string; origine?: string /* 5.1 */ }
interface StatoDeleghe { inCorso: string | null; coda: string[]; spesaOggi: number; tetto: number; modello: string;
  stime: Record<string, { secondi: number; usd: number }> }
interface PostaStato { aggiornatoAt; aggiornando: 'locale' | 'gmail' | null; errore?; giorni; fonti;
  disponibili: { locale: string | null; gmail: boolean }; deleghe: StatoDeleghe;
  progetti: { path; name; voce; fili: Filo[] /* max 30 */; nonLetti; chat: ChatWa[] /* max 20 */; chatDaRispondere: number }[];
  daAssegnare: { indirizzo; dominio; generico: boolean; nome; n; nonLetti; ultimo: Filo;
    proposta?: { path; name; voce; motivo } }[];   // max 40, senza i mittenti automatici, prima le proposte
  automatici: number;                              // mittenti automatici tolti da "Da assegnare"
  suggerimenti: { path; name; domini: string[] }[]; // solo domini di un progetto solo, mostrati chiusi in fondo
  whatsapp: { aggiornatoAt; aggiornando: boolean; errore?; giorni; fonti: { business?; personale? };
    disponibili: string[]; daAssegnare: (ChatWa & { proposta?: { path; name; motivo } })[] /* max 30 */ };
  tuttiProgetti: { path; name }[] }
```

Comando: `bottega.openConnettori` apre la Home sulla stanza Connettori.

Impostazioni della sezione: `bottega.connettori.mappa` ({}), `bottega.connettori.letturaPermessa`
(`{ "admob": ["/.*/"], "searchconsole": ["/.*/"], "keyword-suggest": ["/.*/"] }`), `bottega.connettori.modello`
(haiku), `bottega.connettori.tettoGiornalieroUsd` (1), le tre `bottega.posta.*` (5.5), `bottega.whatsapp.giorni` (7, da
1 a 90), `bottega.whatsapp.personaleDaAssegnare` (false), `bottega.briefing.calendario` (true).

## 6. La barra di Melissa

La barra verticale sinistra mostra, nell'ordine, File, Cerca, Regia, Cruscotto e Plancia.
Le ultime tre voci sono contenitori dell'estensione: riusano gli alberi delle attività e dei
progetti e aprono la rispettiva stanza della Home quando diventano visibili. Il Cruscotto
mostra quattro conteggi correnti. Le altre icone ereditate da VS Code non sono fissate.
Nel gruppo in basso, Melissa sostituisce l'account: il pulsante apre la vista esistente
e avvia la conversazione; Impostazioni resta al suo posto. La miniatura della sfera è
statica, la sfera nella vista è disegnata dal motore WebGPU su Metal. La posizione delle
icone viene scritta una sola volta nel profilo dopo la chiusura dell'app durante
l'installazione; le modifiche successive fatte dall'utente restano sue.

Melissa come Jarvis, con il suo carattere, nella barra laterale DESTRA della Bottega (secondary side bar).
La vista e' un contributo standard di VS Code 1.140, senza API proposte:

```json
"viewsContainers": { "secondarySidebar": [{ "id": "melissaBarra", "title": "Melissa", "icon": "media/melissa.svg" }] },
"views": { "melissaBarra": [{ "id": "bottega.barra", "name": "Melissa", "type": "webview" }] },
"configurationDefaults": { "workbench.secondarySideBar.defaultVisibility": "visible" }
```

All'avvio l'estensione apre il contenitore una volta (`workbench.view.extension.melissaBarra`) senza rubare il fuoco.

### Estensione -> barra

`{type: 'stato', assistant, brain, work, workCounts, board}`

- `assistant: AssistantState` (sezione 3)
- `work: WorkItem[]`, `workCounts: WorkCounts` (sezione 4.9)
- `activity`: «Sessioni osservate» nella barra e nella Home in ordine di `updatedAt`, dalla piu' recente; lo stato resta nel bordo e nell'etichetta (6 ottobre 2026). Lo stesso ordine vale per la Regia (righe e progetti, dal piu' recente) e per le righe della Live Activity
- `board: Record<sessionId, {at, kind, summary, file?}[]>`: le ultime voci della bacheca della Memoria per ogni sessione
  viva (al massimo 4 per sessione, ultime 3 ore)
- `brain: BrainState`
- `assistant.attivita` e `assistant.raccontando`: il terminale e il pulsante «racconta / ferma» (sotto)
- separati: `{type:'bacheca.sessione', sessionId, items}` (risposta a «Le ultime tre ore»), `{type:'visibile', visible}`,
  `{type:'fuoco', focused}` (la finestra della Bottega davanti o dietro: a `ready` e a ogni cambio); un campo assente in
  `stato` vuol dire invariato

```ts
type Provider = 'agnes' | 'apple' | 'deepseek';          // OpenRouter tolto il 3/10/2026 (build 61)
type Effort = 'rapido' | 'normale' | 'profondo';
interface BrainOption {
  provider: Provider; model: string; label: string;       // "DeepSeek V4.1 Flash"
  note: string;                                            // "gratis", "a consumo, a fondo V4 Pro", "sul Mac"
  price?: { in: number; out: number };                     // dollari per milione di token, se un servizio li dice
  available: boolean; why?: string;                        // perche' no: "senza credito (402)", ...
}
interface BrainState {
  current: { provider: Provider; model: string; label: string };
  effort: Effort;
  defaultProvider: Provider;   // il cervello a cui si torna a fine conversazione: Agnes, salvo una scelta «sempre»
  temporary: boolean;          // vero se il cervello di adesso vale solo per questa conversazione
  options: BrainOption[];
  accounts: Account[];                                     // i conti dei servizi, solo dati veri
  checkedAt: number;
}
interface Account {
  id: 'agnes' | 'deepseek' | 'elevenlabs';
  label: string; text: string; tone: 'ok' | 'attesa' | 'male';
  local?: boolean;                                         // contato dalla Bottega, non letto dal servizio
}
```

### Barra -> estensione

`ready`, `converse` (apre o chiude la conversazione a voce), `ask {text}`, `voice.toggle`,
`brain.set {provider, model}`, `effort.set {effort}`, `personaggio.set {chi}`,
`job.focus {id}`, `job.write {id, text}` (istruzioni a un lavoro della Bottega), `open {path}`, `claude {path, id}`
(riprendi qui una sessione aperta altrove), `bacheca.sessione {sessionId}`, `home {view}` (porta la Home su una stanza),
`comando {id}` (comandi rapidi: `briefing`, `regole`, `lavori`, `cruscotto`, `continua`, `cerca`; `racconta` e
`racconta.ferma` dal pulsante «racconta»; `conti` apre la sezione
«Servizi» del Cruscotto, sezione 14).

`brain.set {provider, model, sempre?}`: con `sempre` vero il cervello diventa il predefinito (con `agnes` toglie il
predefinito). Nella testata, accanto a «racconta», l'interruttore «sempre»: acceso quando il cervello di adesso e' il
predefinito, spento quando vale solo per questa conversazione (e la nota sotto il nome dice «per questa conversazione»).
Accenderlo rende predefinito il cervello di adesso; spegnerlo riporta il predefinito ad Agnes. Con Agnes predefinita e in
uso e' acceso e fermo.

`personaggio.set {chi}` (dalla build 124, `chi` e' `melissa` o la chiave di un file di `personaggi/`): con chi parla Andrea. Nella testata,
sotto il cervello, «Melissa · Darlene · Elliot · Krista» (lo stato arriva in `assistant.personaggio`). Chi prende la
chiamata saluta con la sua voce e risponde con gli stessi strumenti di Melissa: prompt `cuore()` di `src/personaggi.ts`
(carattere del personaggio, regola su come si parla, regole di verita'), voce ElevenLabs del personaggio sul primo pezzo
di ogni risposta (`voice.speak {voice}`, Nucleo build 120). «Passami Darlene», «ridammi Melissa» fanno lo stesso a voce.
Dall'iPhone risponde sempre Melissa, perche' la voce la fa il ponte con la sua. Con Melissa al telefono e la voce accesa,
«chiedi a Elliot» (capito da `chiVuole`) la fa dirigere e poi risponde lui; in conversazione lo fa anche da sola, col
personaggio scelto da `ospiteDellaFrase`. Risponde chi lei chiama con lo strumento `passa_parola` (9.11, dalla build
135). Il personaggio risponde senza strumenti, poi
Melissa chiude; ogni battuta si pensa mentre quella prima suona e parte quando il Nucleo dice che e' finita
(`voice.state`), perche' due voci sono due socket e il loro audio si mescolerebbe. Nel registro le battute dei personaggi
hanno il nome davanti. Personaggi, ruoli e scelta sono gli stessi della mod melissa e dell'iPhone (9.10).

Dalla build 125: `AssistantState.personaggi` e' l'elenco dei personaggi caricati da `extensions/bottega-home/personaggi/`,
in ordine di `ordine`, nella forma `[{chiave, nome, ruolo}]`. La barra non ha piu' nomi scritti a mano: genera un
pulsante per Melissa, sempre per primo, e uno per ogni voce dell'elenco (`nome` come testo, `ruolo` come suggerimento);
senza elenco resta solo Melissa. `personaggio.set {chi}` accetta 'melissa' o una chiave caricata, ogni altro valore si
ignora. Con le battute a tre la
risposta di Melissa chiude il suo turno con `voice.speak {final:true}` prima che parli il personaggio, e ogni battuta e'
un turno a se' (`append:false, final:true`, con `voice`). Una frase detta mentre il turno e' in corso non apre un turno
concorrente: si tiene e parte quando la voce ha finito. La battuta a tre usa il cervello che ha risposto al turno (anche
la riserva o Apple). Nella storia del modello le righe di chi ha la chiamata restano sue, quelle degli altri diventano
`user "(Nome ha detto: ...)"`. Chi e' chiamato lo dice solo `passa_parola` (9.11), mai un nome nel testo. `pubblica` toglie da `~/.bottega/personaggi` i file eliminati dalla sorgente.

### Cervelli

I due cervelli in rete parlano l'API compatibile OpenAI con gli strumenti, in streaming. OpenRouter (Claude, Gemini,
GPT a consumo) c'era fino alla build 60: tolto il 3/10/2026 per scelta di Andrea («Agnes e DeepSeek bastano e avanzano»);
a voce «usa Claude» risponde che non c'e' piu'. La sua chiave resta nel vault e la Bottega la ignora.

| provider | url | chiave | modelli | impegno |
|---|---|---|---|---|
| agnes | `https://apihub.agnes-ai.com/v1/chat/completions` | `AGNES_API_KEY` (`~/.secrets/agnes-ai.env`) | `agnes-3.0-flash` | `reasoning_effort`: none / low / high |
| deepseek | `https://api.deepseek.com/chat/completions` | `DEEPSEEK_API_KEY` (`~/.secrets/deepseek-harness.env`) | `deepseek-flash` (DeepSeek-V4.1-Flash) per rapido e normale, `deepseek-v4-pro` per profondo (`GET /models`, 3/10/2026) | `reasoning_effort`: none / low / high; non disponibile finche' l'API risponde 402 |
| apple | Nucleo, cervello Foundation Models con strumenti (build 16, `src/cervello.ts` della sessione nativo) | | sul Mac | |

**Agnes e' il cervello predefinito** (decisione di Andrea, 2 ottobre 2026). Un altro cervello si usa se Andrea lo
sceglie: dalla barra, dall'iPhone o a voce con `cervello_cambia {cervello?, impegno?}` («usa DeepSeek», «pensa piu' a
fondo», «torna ad Agnes»). Di solito vale per quella conversazione: si torna al predefinito quando la conversazione si
chiude, dopo 15 minuti senza domande, al riavvio della Bottega e dopo qualsiasi errore (un 401 o un 402 mette anche il
cervello da parte per un'ora). Dal 3 ottobre 2026 la scelta puo' valere «sempre» (interruttore nella barra, selettore
dell'iPhone, 9.8): quel cervello diventa il predefinito, salvato in `globalState` (`bottega.cervello.predefinito`,
assente = Agnes) e sopravvive al riavvio, finche' non si sceglie «sempre» un altro. Un predefinito che adesso non si
puo' usare (DeepSeek senza credito, Apple senza Nucleo) ripiega su Agnes senza cancellarsi. L'impegno si ricorda sempre
(`bottega.cervello.impegno`). Apple Intelligence resta la riserva automatica solo quando Agnes non risponde (429, rete).
Ogni cambio (barra, voce, iPhone, cervello messo da parte) chiama `onChange` di `Cervelli`: la barra rilegge il cervello
e il ponte avvisa l'iPhone sugli eventi, cosi' Mac e iPhone mostrano sempre la stessa scelta. A voce lo strumento
`cervello_cambia` non ha `sempre`: la sua scelta vale per la conversazione, poi si torna al predefinito.
Con DeepSeek i nomi vecchi `deepseek-chat` e `deepseek-reasoner` portano entrambi a V4.1 Flash, senza e con ragionamento:
fino alla build 60 rapido e normale erano la stessa cosa e V4 Pro non si usava mai.

### I conti dei servizi (in testa alla barra)

Solo dati veri, al massimo ogni 5 minuti (mai a ogni domanda):
- Agnes: nessun endpoint di saldo (`/user/balance` risponde 404). Si mostra se risponde, le richieste fatte oggi dalla
  Bottega (contate in `globalState`) e i 429 degli ultimi 10 minuti (limite di circa 20 richieste al minuto).
- DeepSeek: `GET https://api.deepseek.com/user/balance` (`is_available`, `balance_infos`).
- ElevenLabs: la chiave non puo' leggere l'account; i caratteri del mese da `~/.bottega/nucleo/usage.json`, dichiarati
  come conteggio della Bottega.

### Le mani di Melissa

Strumenti nuovi: `cervello_cambia {cervello?, impegno?}`, `sessione_leggi {progetto}` (cosa ha fatto una sessione dalla
coda della sua trascrizione, `src/mani.ts`: ultima richiesta, ultima risposta, strumenti, file, se aspetta; per le
sessioni aperte altrove e' sola lettura), `attivita_elenco {fonte?, progetto?, stato?}` e
`attivita_dettaglio {chiave}` (metadati ripuliti di Claude Code, Cline, Codex e terminali),
`terminale_ultime_righe {chiave}` (al massimo gli ultimi 8 KB acquisiti dalla shell integration dopo l'avvio,
con righe sensibili omesse; nessun accesso all'output dei terminali esterni),
`cruscotto_mostra {progetto?, giorni?}` (la Home va sul cruscotto e manda
`{type:'crus.focus', path?, period?}`: il cruscotto cambia periodo e accende il progetto sul cielo e in classifica
mentre Melissa risponde; un comando arrivato prima dei dati si applica al loro arrivo). In conversazione, quando un
lavoro comincia ad aspettare, Melissa lo dice una volta («Peak ti aspetta»).

### Il codice davanti ad Andrea (3/10/2026)

`src/occhio.ts` (logica pura, `test/occhio.cjs`) e `src/occhio-host.ts` (VS Code). Il file «davanti» e' l'editor di
testo attivo; se davanti c'e' la Home, la barra o un'immagine, l'ultimo file di codice guardato (`file:` o `untitled:`).
- A ogni domanda, solo con un file aperto, il prompt di sistema ha una riga («Davanti ad Andrea nell'editor:
  avo_bnb/db.py, python, 420 righe; sullo schermo le righe 37-55; selezionate le righe 46-50; accanto: ...») e la regola
  di come spiegare il codice (`CODICE_RULE` in `assistant.ts`). Il contenuto non entra mai nel prompt da solo.
- Lo strumento `codice_leggi {file?}` (ha preso il posto di `editor_contesto`): prima la selezione fatta col mouse
  (fino a 12.000 caratteri), poi il file intero con i numeri di riga (`37| ...`) fino a 60.000 caratteri; un file piu'
  lungo da' la parte sullo schermo con 150 righe prima e dopo, e dice di non inventare il resto. `file` legge un altro
  file aperto per nome. I file di segreti (`~/.secrets`, `.env*`, chiavi `.pem .p8 .p12 .key .jks`, `id_*`, `.npmrc`,
  `.netrc`) non si leggono mai: andrebbero al cervello in rete. Apple Intelligence non ha questo strumento (contesto
  troppo piccolo).

### «racconta» e il terminale di Melissa (3/10/2026)

Il pulsante «racconta» della barra (comando `bottega.racconta`) racconta quello che Andrea ha davanti: il file di codice
nella scheda attiva (`Occhio.davanti()`, l'ultimo file guardato se davanti c'e' altro), oppure la stanza che la Home sta
mostrando (la Home manda `{type: "vista", view}` a ogni cambio: Plancia e Melissa il briefing, Lavori l'elenco dei
lavori, le altre `leggiStanza`). Il contenuto, gia' letto, va con la domanda («Raccontami la stanza App Store.») ma non
resta nella storia della conversazione. Su un file (`Occhio.racconto()`, `codiceDaRaccontare` in `src/occhio.ts`, dal
4/10/2026): senza selezione va TUTTO il file, fino a `LIMITE_RACCONTO` (200.000 caratteri con i numeri di riga; oltre,
dall'inizio e il resto dichiarato non letto), con la domanda «Raccontami tutto il file X ... non solo la parte che ho
sullo schermo»; le righe sullo schermo non entrano nel testo. Con righe selezionate si spiegano quelle («Spiegami le
righe A-B che ho selezionato in X»), con il file intorno come contesto. `Assistant.racconta()` pensa con
DeepSeek (V4.1 Flash, V4 Pro con «profondo»; senza chiave o senza credito torna ad Agnes), ragiona anche se poi parla, e
racconta con la voce ElevenLabs mentre DeepSeek scrive, frase per frase, anche a voce spenta se il Nucleo c'e'. Durante
il racconto il pulsante diventa «ferma» (`comando` `racconta.ferma`, comando `bottega.raccontaFerma`): la risposta si
interrompe e `voice.stopSpeaking` la zittisce. «Spiega con Melissa» (icona nel titolo dell'editor e tasto destro,
`bottega.spiegaCodice`) fa lo stesso sempre sul codice.

Durante il racconto Melissa dice anche i passi degli strumenti, con frasi fisse e vere (`src/racconto.ts`,
`fraseInizio`, `fraseFine` con i dati del risultato, `fraseAttesa` oltre 8 s; come `AgentActivityNarration` della
Melissa di Avo): mai il ragionamento del modello, mai comandi o chiavi, mai una chiamata a un cervello.

Il terminale (`AssistantState.attivita: {at, testo, stato}[]`, ultimi 40; `stato`: `nota`, `corre`, `fatto`,
`errore`, `voce`) sta sempre in vista sotto la sfera, a caratteri da terminale, con le ultime quattro righe e le altre
scorrendo: la domanda, quale cervello pensa, ogni strumento che parte e cosa ha trovato, ogni frase detta, la fine,
gli errori (voce assente, niente da raccontare, fermata). Si riempie a ogni domanda, anche fuori dal racconto.
`raccontando: boolean` dice alla barra se mostrare «ferma»; resta vero mentre il Nucleo
riproduce l'audio anche dopo che il testo e' stato generato, fino a `voice.state` di fine.

Strumenti sui connettori (5.7), sempre in sola lettura:
- `connettori_elenco {server?, cerca?}`: senza server, i connettori con stato e tipo (diretti e gratis, oppure via
  Claude e a pagamento) e i nomi degli strumenti di sola lettura dei diretti (al massimo 20 per server, tre server
  avviati alla volta); con server, i suoi strumenti di sola lettura con descrizione breve e argomenti (`nome*: tipo`,
  asterisco = obbligatorio), filtrabili con `cerca`.
- `connettore_leggi {server, strumento, argomenti?}`: uno strumento di sola lettura di un server locale stdio,
  gratis e subito. Quello che non passa `soloLettura` viene rifiutato senza avviare il server. `whatsapp-personal` e
  `mail-mcp` solo su richiesta esplicita di Andrea (scritto nella descrizione dello strumento).
- `connettore_chiedi {compito, connettori[]}` (`risky`): delega a `claude -p` per i connettori di claude.ai. Chiede
  sempre conferma con la stima di tempo e costo (`stime.chiedi` della coda, altrimenti `STIMA_BASE`, 60 s e 0,08 $) e
  la spesa di oggi sul tetto; dopo il si' la delega parte in coda e la risposta arriva a voce con `announce` quando
  Melissa e' libera (al massimo un minuto di attesa). Con il tetto raggiunto non chiede nemmeno.

Strumenti sulle stanze (`src/strumenti-stanze.ts`, provato da `test/strumenti-stanze.cjs`), registrati da
`extension.ts` come gli altri (`Object.assign(TOOLS, STRUMENTI_STANZE)`, poi `registraStrumentiStanze(fonti)` con
`resolveProject`, il calcolo del cruscotto, `appStore.state()`, `idee.rules.state()`, `idee.radar.state()`, le ore per
cliente (`buildReport` sul registro appena calcolato), la Memoria, `stanzaConnettori()`, `idee.night.state()`,
`showHome` e `panelHost.send`):

- `stanza_leggi {stanza, progetto?, periodo?, mese?}`: stanza = `cruscotto | appstore | vedetta | siti | clienti |
  posta | whatsapp | dafare | memoria | connettori | notte`. Restituisce un riassunto gia' pronto per la voce: frasi
  corte, numeri arrotondati (ore a 5 minuti, euro interi sopra i 10, importi da fatturare al centesimo), al massimo
  1200 caratteri, i cinque elementi che contano di piu'; se non ci sta tutto finisce con «Il resto è nella stanza:
  chiedimi i dettagli.». Niente lineette lunghe o medie, nemmeno quelle che arrivano dai dati (commit, oggetti).
  Legge solo lo stato che la plancia mostra: nessuna chiamata di rete, nessuna delega, nessun costo. Il cruscotto e le
  ore per cliente ricalcolano in locale, in modo incrementale, come la Home (al massimo 20 secondi, poi «riprova tra
  poco»). Dati piu' vecchi di mezz'ora: la frase finisce con l'eta' («Dati di 3 ore fa.»).
  - `progetto`: risolto con `resolveProject`; per `appstore` vale anche il nome di un'app, per `clienti` il nome di un
    cliente o di un suo progetto. Senza: il quadro di tutto.
  - `periodo` in giorni, ricondotto a 1, 7, 30, 90, 365 (predefinito 7 per il cruscotto, 30 per l'App Store). Il
    cruscotto tiene 90 giorni (365 diventa 90 e lo dice); l'App Store usa i giorni fino a 30 e i mesi oltre (90 = 3
    mesi, 365 = 12 mesi compreso quello in corso), con il confronto sul periodo prima.
  - `mese`: `YYYY-MM`, «settembre», «settembre 2025», «mese scorso», «questo mese» (senza anno: l'ultimo con quel
    nome). Vale per `appstore`, `clienti` e `cruscotto` (solo il totale del mese).
  - Cosa legge ogni stanza: `cruscotto` (`Stats`: ore tue e di Claude, sessioni, token, valore a listino, confronto,
    da lunedi', primi cinque progetti, sessioni aperte); `appstore` (`AppStoreStato`: totale, AdMob, Store, download,
    confronto, app migliori, buchi con stima, `storeFinoA`, errori); `vedetta` (`RulesState` piu' versione su App Store
    e sito del progetto); `siti` (`RadarState.vercel`: fallite prima, in corso, ultime pubblicate; dice che guarda le
    pubblicazioni, non se i siti rispondono); `clienti` (`ClientReport` del mese); `dafare` (la riga «Da fare:»
    dell'ultimo riassunto di ogni progetto, `splitSummary` di `continua.ts`); `memoria` (bacheca delle ultime due ore,
    decisioni e note recenti); `posta` (mail per progetto piu' il conto delle chat); `whatsapp` (chat che aspettano
    risposta); `connettori` (stati e spesa delle deleghe); `notte` (finestra, coda, resoconto).
- `stanza_mostra {stanza, progetto?}`: la Home su `cruscotto`, `appstore`, `vedetta` (anche `siti`), `clienti`,
  `connettori` (anche `posta` e `whatsapp`), `plancia` (anche `dafare`, con il progetto in evidenza), `memoria`,
  `lavori` (anche `notte`), `melissa`, oppure l'Osservatorio (`bottega.openOsservatorio`). Sul cruscotto con un
  progetto manda anche `{type:'crus.focus', path}`.
- `cruscotto_mostra` resta solo la vista: la sua descrizione e la sua risposta dicono di chiamare `stanza_leggi` per
  dire le cifre.
- Privacy: `posta` e `whatsapp` solo se Andrea chiede esplicitamente di mail, messaggi o di chi gli ha scritto (scritto
  nella descrizione). Escono solo nome del contatto, progetto, oggetto della mail e, per WhatsApp e solo per un
  progetto, un'anteprima di 60 caratteri dell'ultimo messaggio. Mai indirizzi, numeri di telefono, corpi delle mail.
  Quello che Melissa legge con questi strumenti va al suo cervello (Agnes, o quello scelto per la conversazione): e'
  una lettura che esce dal Mac, come per `connettore_leggi`.

## 7. La Bottega nativa: Apple Intelligence, Metal, macOS 27

Tutto sul Mac, solo framework Apple. Apple Intelligence (FoundationModels) solo per compiti brevi e strutturati,
con generazione guidata (`@Generable`) dove serve un dato, sessioni preparate prima dell'uso (`prewarm`), finestra di
contesto misurata con `tokenCount` prima dell'invio (su macOS 27.0 `contextSize` = **8192** token), errori tradotti
da `LanguageModelError` (un solo punto: `CervelloErrori.translate`, anche per `Intelligence.swift`; il vecchio
`GenerationError` e' deprecato e non si usa piu'). I riassunti lunghi delle sessioni restano ad Agnes.
Comandi del Nucleo smistati da `Nativo.handle` (Service.swift) e `NativoCLI.run` (CLI.swift).

### 7.1 Apple Intelligence come cervello, con gli strumenti

`src/cervello.ts`, dentro il selettore dei cervelli della sezione 6. Agnes risponde sempre finche' risponde (scelta di
Andrea, 2 ottobre 2026). Quando Agnes da' 429, errore di rete o 5xx entra la riserva, in quest'ordine (Andrea, 4
ottobre 2026): DeepSeek (`Cervelli.riservaDeepseek()`: chiave presente e non da parte; Flash, V4 Pro con «profondo»),
poi Apple Intelligence. Lo stesso turno passa subito alla riserva CON gli strumenti (nessuna attesa cieca sul 429) e
per 2 minuti i turni vanno diretti alla prima riserva (interruttore, `BrainRouter.reserves()`). DeepSeek come riserva
che fallisce non torna ad Agnes: il turno passa al Mac. `assistant.brain` puo' valere `deepseek`. Melissa dice il cambio
solo quando succede ("Agnes non risponde, ti rispondo con DeepSeek.", "Neanche DeepSeek risponde, ti rispondo dal
Mac.", "Agnes non risponde, ti rispondo dal Mac.", "Agnes e' tornata."). Scelto a mano nella barra, Apple risponde sempre lui, con gli strumenti; se non risponde si torna ad
Agnes. Se anche Apple fallisce resta il vecchio ripiego `ai.generate` senza strumenti.

Apple ha la stessa forma degli altri cervelli: `appleOpenAiStream(nucleo, {effort})` ha la firma di `LlmStreamFn`
(messaggi e strumenti OpenAI dentro, `{content}` e `{tool_call:{index,id,name,arguments}}` fuori, un passo per
chiamata). Dietro c'e' una sola sessione FoundationModels per turno: il passo finisce con la tool_call, il messaggio
`tool` successivo con lo stesso `tool_call_id` diventa `tool.result` e la sessione riprende. Strumenti per Apple:
sottoinsieme ordinato `APPLE_TOOLS` (17, con `stanza_leggi` e `stanza_mostra`), con le stesse conferme di Melissa per push e stop; l'impegno (`rapido`,
`normale`, `profondo`) e' quello della barra.

| cmd | argomenti | risposta |
|---|---|---|
| `ai.agent` | `req?`, `messages` (OpenAI) oppure `instructions` + `prompt` + `history?`, `tools` (ToolSpec OpenAI), `effort?` (`rapido` 200 token e temperatura 0,3, `normale` 400 e 0,6, `profondo` 800 e 0,7), `maxTokens?` | `text`, `toolCalls [{name,args}]`, `ms`, `dropped` (strumenti tolti), `droppedHistory`, `tokens {instructions, prompt, history, tools, total, budget, context, output}`, `finish` (`stop`, `length`, `cancelled`) |
| `tool.result` | `call`, `result` | |
| `ai.cancel` | `req` | `cancelled` |

Eventi: `ai.delta {req, text, reset?}` (testo nuovo; `reset` = testo intero riscritto), `tool.call {req, call, id,
name, args}`. Ogni ToolSpec diventa un `Tool` con schema dinamico (`DynamicGenerationSchema` dal JSON Schema); uno
strumento che non risponde in 20 s torna come testo d'errore. Se il contesto non basta si toglie prima la storia, poi
gli strumenti in coda alla lista. Misure (2/10/2026, Mac carico): 10 strumenti tipici = 886 token, tutti i 22 = 1658;
domanda con strumento: `tool.call` a 1,3 s, risposta a 1,9 s; saluto 1,5 s. Agnes sulla stessa rete: primo byte
0,75-0,80 s. Per questo Apple resta di riserva.

### 7.2 Bacheca viva

`bacheca.live {on}` -> `{on, dir}`: il Nucleo guarda `~/.bottega/memoria/bacheca/*.jsonl` con FSEvents (nessun polling)
ed emette `bacheca.attivita {project, key, sessionId, kind, at}` per ogni riga nuova; la stella del progetto
nell'Osservatorio pulsa. L'estensione la accende quando Apple Intelligence c'e'. CPU misurata a riposo, con le
sessioni vere che scrivono: 0,05%.
Le frasi scritte sul Mac ("Claude sta sistemando il login di Peak") sono state misurate su sessioni vere e uscivano
vaghe o sbagliate ("sta cercando informazioni sui dispositivi di Bottega"): NON si generano, la bacheca degli hook
resta quella di prima.

### 7.3 Categorie del lavoro

`@Generable enum Categoria { correzione, funzione, rilascio, ricerca, manutenzione, documentazione }`.
Nucleo: `ai.classify {text}` -> `{categoria, motivo}`; `--cli classify` (righe JSON `{id, text}` dentro,
`{id, categoria, motivo, ms}` fuori; exit 2 senza Apple Intelligence). Memoria (`memoria/lib/categorie.mjs`): tabella
`categorie(sessionId PK, categoria, motivo, engine, at)`, `node memoria/cli.mjs classifica [--tutte] [--limite N]`
(riassunti senza categoria, titolo + riassunto, a pezzi da 8, Nucleo sotto `taskpolicy -b` e `nice -n 19`),
`categorie [--giorni N] --json` (sessione -> categoria). L'estensione classifica in fondo all'avvio e ogni 30 minuti.
Pesatura: minuti di Claude di ogni sessione (`StatsEngine.sessionSpans()`, sessione e sottoagenti fusi), finestre 7/30/90
giorni (`categorieMinuti` in `src/osservatorio.ts`); le sessioni non classificate vanno in `altro`. Il messaggio `stats`
alla plancia porta `categorie` e `categorieFrase` ("Questa settimana 60% correzioni.", solo con almeno 30 minuti
classificati). Misura su 16 sessioni etichettate a mano (`~/.bottega/valutazione-categorie.json`, fuori dal
repository): 13 giuste su 16 (81%), 3,5 s a sessione.

### 7.4 Ricerca per significato: misurata, non adottata

Provate il 2/10/2026 su 21 domande vere (successo@1 / @5 / MRR): ricerca di oggi 33% / 57% / 0,44; bm25 + embedding
contestuale (`NLContextualEmbedding`, media dei token) fusi con RRF k=60: 24% / 38% / 0,33; + espansione guidata della
domanda: 24% / 43% / 0,36 (1,2 s); + riordino guidato dei primi 20 entro 1,5 s: mai in tempo. Tetto senza limite di
tempo: riordino "migliori" 48% / 62% / 0,53 (3,6 s), "punteggi" 38% / 48% (6 s). Obiettivo 60% / 85% non raggiunto:
la ricerca resta quella della sezione 2. Il lavoro sta nel ramo `nativo-ricerca-misurata` su GitHub.

### 7.5 Widget, controlli, Siri e Spotlight

`stato.json` (4.6) si allarga:
```json
"ore": { "aggiornato": 1790900000000, "fonti": ["claude", "codex"], "oggi": 135, "ieri": 220, "settimana": 1180, "giorni": [{ "date": "YYYY-MM-DD", "minuti": 80 }] },
"lavori": { "...": "campi di 4.6", "nelTerminale": 0,
            "voci": [{ "key": "job:<id>|sess:<sid>", "progetto": "", "path": "", "titolo": "", "stato": "ti aspetta", "da": 0 }] },
"progetti": [{ "nome": "", "path": "", "ramo": "main", "daSpingere": 2, "modifiche": 3, "livello": "rosso|giallo|verde|null", "ultima": 0 }]
```
Minuti interi, `da` e `ultima` in millisecondi, `giorni` gli ultimi 7 dal piu' vecchio. Letto da `nucleo/Shared/StatoNativo.swift`.
Widget `com.andreapiani.bottega.oggi` (piccolo, medio, grande): ore di oggi, barre Swift Charts dei 7 giorni, chi ti
aspetta, semaforo, soldi di ieri; nei formati medio e grande tre link (Parla con Melissa, Apri la plancia, Nuovo lavoro).
Controlli del Centro di Controllo (`com.andreapiani.bottega.controllo.melissa|plancia|lavoro|osservatorio`) con le
intents condivise `ParlaConMelissa`, `ApriPlancia`, `NuovoLavoro`, `ApriOsservatorio` (`nucleo/Shared/AzioniRapide.swift`,
`allowedExecutionTargets .main`: le esegue il Nucleo). L'appex ha il suo `Metadata.appintents` (build.sh si ferma se manca).
Entita': `ProgettoEntity` (IndexedEntity, id = path; query per nome senza maiuscole, accenti, spazi), `LavoroEntity`
(id = key). Intents nuovi: `ApriProgetto(progetto)`, `ProgettiDaSpingere`, `CosaMiAspetta`; `AvviaLavoro` prende il
progetto come entita' (le scorciatoie salvate col progetto scritto a mano vanno rifatte). Frasi nel provider unico
`BottegaScorciatoie` (8 scorciatoie, 18 frasi), per esempio "Apri <progetto> nella Bottega", "Che progetti aspettano un
push su Bottega", "Cosa mi aspetta su Bottega", "Apri l'Osservatorio di Bottega". Spotlight: gli elementi `progetto`
di `spotlight.index` sono associati all'entita' (`associateAppEntity`), niente doppioni.

### 7.6 Un solo motore Metal

`MetalEngine.shared` (`nucleo/Sources/Motore/`): un device, una coda, un `default.metallib` con tutti gli shader
(sfera e cielo; build.sh compila ogni `.metal` di `Sources`). Ritmo: 0 fps se non visibile; sfera grande 60/30, sfera
agganciata 30/12, cielo 30/15 (60 durante ingresso e gesti, 30 in risparmio energetico); con Riduci movimento un fotogramma quando cambia qualcosa. Il respiro della sfera
accelera con le sessioni al lavoro (da `menubar.update`: `busy` 0 = 1,4 rad/s, 1 circa 1,9, 3 circa 2,5, massimo 3).
Comandi: `metal.stats` (costi per fotogramma per cliente, fps, carico), `metal.load {busy, waiting}`, `metal.pulse {key,
project}`; `--cli metal-bench [--frames N] [--width W --height H]`. Benchmark fuori schermo del 4/10/2026, build Release,
Apple M2, 60 fotogrammi, 40 progetti e 1.800 stelle: cielo 1440×900 24,9 µs CPU / 0,745 ms GPU medi; 1920×1230
19,3 µs / 0,633 ms; 3840×2160 25,2 µs / 1,311 ms. Sono costi del renderer, esclusi compositing SwiftUI e pannelli.
Sfera grande 2,95–3,02 ms GPU, agganciata 0,638 ms. Il widget non usa Metal (WidgetKit archivia viste statiche).

### 7.7 L'Osservatorio

Finestra nativa (SwiftUI + Metal) del Nucleo: cielo prospettico interattivo, ingresso animato, orbita con trascinamento,
zoom con scroll/pinch e ripristino della camera. `SkyCamera` proietta la stessa scena per Metal, picking ed etichette;
`SkyLabelLayout` misura i nomi e scarta le posizioni che intersecano bordi, stelle o altre etichette. Il cielo ha spazio
proprio, i riepiloghi stanno sotto e l'ispettore scorre a destra (anche i riepiloghi sotto 1080 pt). Mappa ore 7×24 e
barre con nome/valore separati dal tracciato. «Vista immersiva» allarga il cielo; Esc torna ai pannelli. La richiesta
`secondoSchermo` continua a spostare la finestra sul monitor esterno. Test geometria: `scripts/test-osservatorio.sh`.
Comandi: `osservatorio.open {data?, secondoSchermo?}` -> `{open, hasData, stars}` (senza dati emette
`osservatorio.ready`), `osservatorio.data {data}` (`data` = `{stats, live?, categorie?}` o lo `Stats` da solo),
`osservatorio.close`; evento `osservatorio.closed`. Ultimi dati in `~/.bottega/nucleo/osservatorio.json` (600).
Si apre con il comando `bottega.openOsservatorio`, il link `bottega://.../osservatorio`, la voce "Apri l'Osservatorio"
della barra dei menu del Nucleo (apre subito con gli ultimi numeri e chiede quelli nuovi) e l'intent `ApriOsservatorio`.
L'estensione (`src/osservatorio.ts`) risponde a `osservatorio.ready` e rimanda i dati dopo ogni calcolo del cruscotto
solo se la finestra e' aperta e i numeri sono cambiati. Plancia -> estensione: `osservatorio.open` (pulsante «Apri nell'Osservatorio» sotto il cielo del cruscotto),
`cielo.diag` e `sfera.diag {motore: 'webgpu'|'canvas'|'svg', motivo, gpu, isSecureContext, crossOriginIsolated,
userAgent}` (con quale motore gira e perche', scritto nel registro).

### 7.7.1 Cruscotto Metal della Regia

`regia.open {data}` apre una finestra nativa SwiftUI con barre disegnate da `MTKView` e shader Metal;
`regia.data {data}` aggiorna solo la finestra aperta, `regia.close` la chiude, `regia.closed` notifica
l'estensione. `data` contiene `projects: [{name, waiting, errors, running, queued}]`, `summary`, `engine`,
`updatedAt`. Le barre per progetto sono impilate per stato; il renderer disegna a richiesta quando arrivano
dati o la finestra torna visibile, senza fotogrammi continui a riposo. La vista Home e il grafico usano lo
stesso `snapshot.activity` piu' le code in `snapshot.work`.

### 7.8 WebGPU nelle webview: un solo motore per sfera e cielo

`media/motore/gpu.js` (`window.BottegaGPU`: un dispositivo per webview, ogni shader compilato in uno scope di errori,
giro dei fotogrammi a 30 fps se succede qualcosa, 20 a riposo, 15 se un fotogramma costa piu' di 8 ms, fermo a vista
nascosta, documento nascosto o tela fuori schermo, un fotogramma solo con Riduci movimento; fra due fotogrammi aspetta con
un timer che scade 17 ms prima e poi chiede `requestAnimationFrame`, cosi' la webview si sveglia solo per i fotogrammi
che disegna e non 60 volte al secondo), `cielo-gpu.js`
(`window.BottegaCieloGPU.mount(canvas, {reduced, rilascio, onStato, onFail})`) e `sfera-gpu.js`
(`window.BottegaSferaGPU.mount(canvas, {reduced, zoom?, post?, onFail?})` -> `{set(stato, spenta, livello), wake(),
sleep(), riposa(si), redraw(), smonta(), motore, stato, costo, costoGpu, frames}`). Il tempo della sfera avanza solo
mentre si muove: ripartendo dal riposo riprende dallo stesso fotogramma, senza salti. `mount` lancia se WebGPU manca; se cade dopo
chiama `onFail(motivo)` e la vista passa al Canvas 2D. Caricati da `panel.ts` (tutti e tre, `gpu.js` per primo) e da
`barra.ts` (`gpu.js`, `sfera-gpu.js`). `gpu.js` chiede `timestamp-query` quando l'adattatore lo offre (serve solo a
`costoGpu`, ms di GPU per fotogramma; senza, il tempo dall'invio alla fine); `costo` resta il tempo di CPU.

La sfera (2/10/2026) e' la sfera Metal di Avo Agency AI (`VoiceOrbShaders.metal` + `VoiceOrbRenderer.swift`) portata
in WGSL senza tagli: raymarching 80 passi fuori e 56 nel nucleo volumetrico, convezione, granuli, iridescenza, corona,
raggi per banda, onda d'urto, battito, vagabondaggio, impulso, molla della voce; 12.288 particelle sulla GPU (calcolo +
scie + sprite additivi, smorzamento riportato a 60 Hz), bloom a piramide di 5 livelli con striscia anamorfica, maschera
radiale di `VoiceOrbIndicator`. Uscita come Avo: luce lineare Display P3 su tela `rgba16float` con `toneMapping:
{mode: 'extended'}` (il nucleo va oltre il bianco quanto concede lo schermo, sull'Air fino a 2x); se la tela non la
accetta, il formato a 8 bit e sopra il bianco si taglia. Prima era una palla liscia perche' mancavano particelle e
bloom, il nucleo aveva 20 passi invece di 56, l'esposizione era abbassata a 0,62 e la tela era sRGB con l'alone
premoltiplicato dopo la codifica (troppo scuro). Differenze volute da Avo: niente sfondo d'umore (foto, meteo) ne'
extra cinematografici; 30/20 fps invece di 60 (i filtri della voce sono corretti per il passo); sotto i 480 px di
tela le particelle sono k volte tante e grandi radice di k (k = lato/480), cosi' la sfera della barra e' quella di Avo
rimpicciolita e non un banco di neve; in piu' lo stato `error` (sodio) e `spenta`. Il controllo d'uscita dal nucleo e'
ogni due passi: stessa immagine, un millisecondo in meno. Verifica: fotogrammi del renderer Metal di Avo (programma
Swift fuori schermo) e della webview (Chrome, valori grezzi della tela) negli stessi istanti, medie per zona entro 1-2
livelli su 255 sulla sfera.
Il cielo del cruscotto: WebGPU, poi Canvas 2D animato, poi SVG fermo; l'indicatore in alto a destra dice quale.
Perche' fino alla build 17 il cielo era in SVG (2/10/2026): non VS Code (WebGPU nelle webview funziona, la cache Dawn in
`~/Library/Application Support/Bottega/DawnWebGPUCache` lo prova) ma lo shader della corrente, che usava `meta`,
parola riservata del WGSL: l'errore arrivava al dispositivo condiviso e spegneva anche il cielo. Corretto, e uno
shader rotto ora ferma solo il suo motore. Costo misurato con Dawn su Metal (M2): cielo 1120x1120 0,5 ms per
fotogramma; ripiego Canvas 2D del cielo 1,5 ms. Sfera, `costoGpu` dai timestamp al ritmo vero (la GPU a 20-30 fps
abbassa le frequenze, il fotogramma dura di piu' che a pieno regime): 480x480 riposo 5,2 ms, ascolta 3,9-4,9,
pensa 4,1, parla 4,1-5,0, errore 3,8; 208x208 (la barra) da 2,3 a 3,4 ms; CPU 0,3-0,4 ms. A pieno regime 480x480
2,0-2,9 ms, come il Metal nativo di Avo alla stessa misura (2,2-3,0). La versione senza particelle ne' bloom
costava circa la meta'.

Lo `Stats` del messaggio `stats` (sezione 3) porta in piu', facoltativi: `categorie: {'7'|'30'|'90': {categoria:
minuti}}` e `categorieFrase` (7.3); il cruscotto mostra «Che lavoro e' stato» solo se ci sono.

## 8. Vision sul Mac, e cosa di Apple Intelligence non e' entrato

Tutto sul Mac, l'immagine non lascia il Nucleo. Codice: `nucleo/Sources/Vista/` (Swift Vision `RecognizeTextRequest`,
livello accurato, correzione linguistica, italiano e inglese; ScreenCaptureKit). Comandi:

| cmd | argomenti | risposta |
|---|---|---|
| `vision.ocr` | `path?` oppure `base64?` (anche `data:`), `lingue?` | `testo`, `righe [{testo, conf}]`, `ms` |
| `vision.guarda` | `lingue?` | `testo`, `righe` (numero), `app` (in primo piano), `finestra?`, `ms`; senza permesso `ok: false`, `permesso: false` e l'errore in italiano |

CLI: `ocr` (processo lungo: righe JSON `{id, base64, mime?}` dentro, una riga `{id, testo, ms}` o `{id, error}` per
riga, subito), `ocr-file <percorso>`, `guarda` (solo a mano). Misure (M2): 0,1-0,3 s a immagine a caldo; la prima dopo un
riavvio fino a 43 s (carica i modelli).

### 8.1 «Melissa, guarda»

Strumento di Melissa `guarda_schermo` (anche per Apple Intelligence): cattura dello schermo principale SOLO quando
Andrea lo chiede, senza le finestre del Nucleo, letta con Vision; a Melissa arriva solo il testo (al massimo 3500
caratteri) con app e finestra in primo piano. Verso Agnes va solo questo testo, e solo per «guarda». Il permesso di
registrazione dello schermo lo chiede macOS la prima volta (probabilmente intestato a Bottega, che lancia il Nucleo).

### 8.2 Schermate cercabili nella Memoria

`memoria/lib/immagini.mjs`: le immagini base64 delle trascrizioni (riga `user` in `message.content`, dentro
`tool_result`, riga `attachment` in `attachment.prompt`; non `toolUseResult`, che le ripete) passano dall'OCR del
Nucleo `--cli ocr`, una alla volta sotto `taskpolicy -b` e `nice -n 19` (120 s per la prima del giro, poi 30 s; un
tempo scaduto ferma il giro; exit 64 = Nucleo senza `ocr`, il giro si ferma pulito). Tabelle `immagini(hash PK sha1 del
base64, sessionId, file, riga, pos, at, fonte incollata|strumento, mime, memoryId, stato
da_leggere|letta|vuota|errore|sparita, ms, caratteri, errore)` e `immagini_file(file PK, size, offset, righe, at)`:
scansione incrementale dei file toccati negli ultimi N giorni, il base64 non si salva mai. Testo con almeno 20
caratteri utili -> `redact` -> ricordo `kind: 'immagine'`, `origin: 'auto'` (segue la sessione se cambia progetto),
titolo «Schermata: <parole>», testo fino a 4000 caratteri piu' la riga «Da una schermata incollata|vista da Claude
nella sessione <id8> (riga N), <data>.»; entra nella ricerca esistente. `node memoria/cli.mjs immagini [--limite
N=40] [--giorni N=90] [--riprova] [--json]` -> `{lette, nuove, saltate, errori, restano, ms, trovate, nucleo:
ok|senza-ocr|assente|occupato}`. L'estensione lancia un giro all'avvio e ogni 30 minuti. Prove: `node --test
memoria/test/*.test.mjs` (Nucleo finto, mai il database vero). Misure del 2/10/2026: 637 immagini distinte negli
ultimi 90 giorni (63 incollate, 574 da strumenti), scansione iniziale 1,6 s su 962 MB; su un database di prova 40
schermate vere in 44 s (1,1 s l'una in fondo), 38 con testo, nessuna chiave rimasta, trovate dalla ricerca.

### 8.3 Misurati e lasciati fuori

Su dati veri, il 2/10/2026, soglia 8 su 10 (o 4 su 5) giusti e nessun fatto inventato:
- riga di stato delle sessioni (`ai.stato`, dall'ultimo messaggio di Claude e dall'ultima richiesta): da 3 a 6 su 10
  in sei varianti di istruzioni, con righe sbagliate e un rifiuto per le regole di sicurezza;
- riassunto della posta e «cosa ti chiede» (`ai.posta`, posta locale letta in sola lettura): 3 su 5, legge male le
  risposte che citano il messaggio di Andrea;
- «cosa e' cambiato» dai commit (`ai.cambiato`): da 2 a 3 su 5, instabile sui commit in spagnolo;
- commento ai grafici con segnaposto (`ai.commento`): la regola sulle cifre regge (35 frasi, nessuna cifra del
  modello passata), il senso no (circa 1 su 5, confronti falsi con segnaposto validi);
- documenti (PDF e scansioni: testo, tabelle e importi riconosciuti bene, 96-98% delle parole) restano fuori perche'
  il riassunto breve sul Mac non e' stato giudicato e il testo dei documenti non deve andare ad Agnes.
Il lavoro sta nel ramo `fase3-completa` su GitHub.


## 9. La Bottega per iPhone e il ponte

```
iPhone (ios/, SwiftUI)  --HTTPS sulla rete Tailscale-->  estensione: src/ponte.ts  --stdio-->  Nucleo: ponte.voce, ponte.qr
   sfera Metal del Nucleo (stessi file)                   Melissa (assistant.ts), lavori (jobs.ts)
   ascolto: SFSpeechRecognizer it-IT sull'iPhone
```

Il Mac deve essere acceso con la Bottega aperta per il ponte, i lavori e i dati in diretta. Quando manca, Melissa
risponde alle domande generiche direttamente dall'iPhone tramite Agnes o DeepSeek e ElevenLabs (9.10).
iPhone e Mac si parlano direttamente dentro Tailscale (WireGuard, gia' cifrato).

### 9.1 Il ponte (estensione, `src/ponte.ts`, `src/ponte-host.ts`)

- Ascolta SOLO sull'indirizzo IPv4 Tailscale del Mac (`tailscale status --json`, `Self.TailscaleIPs`), porta 7790.
  Dal Wi-Fi o da internet non si vede. Ogni minuto ricontrolla Tailscale: se si spegne il ponte si chiude, se
  l'indirizzo cambia si riapre. Impostazione `bottega.ponte.attivo` (vero). Registro: canale «Bottega per iPhone».
- Ogni richiesta: `Authorization: Bearer <gettone>`. Il gettone (32 byte casuali, base64url) nasce una volta in
  `~/.bottega/ponte.json` (permessi 600) ed e' copiato in `~/.secrets/bottega.env` (`BOTTEGA_PONTE_TOKEN`). Per
  cambiarlo si cancella `ponte.json`, si riavvia la Bottega e si ricollega l'iPhone. Confronto a tempo costante;
  indirizzi fuori da 100.64.0.0/10 e fd7a:115c:a1e0::/48 -> 403; 20 gettoni sbagliati in 10 minuti -> quell'indirizzo
  riceve 429 per 10 minuti sui gettoni sbagliati (il gettone giusto passa sempre, cosi' un nuovo QR non resta
  chiuso fuori dai widget col gettone vecchio). Corpo al massimo 16 KB, testo al massimo 2000 caratteri.
- `GET /v1/stato` -> `{versione, mac, ora, vicino (9.9), https?: {porta, impronta}, melissa: {stato, cervello, parziale?, risposta?, personaggio?, registro: [{chi: tu|melissa|azione,
  testo, alle}]}, lavori: [{chiave, activityKey?, origine: bottega|altrove, stato, progetto, path?, titolo, da, jobId?}],
  attivita: [{key, source, project, path?, status, title, summary?, steps?, evidence?, updatedAt, startedAt?}],
  conti: {inCorso, tiAspetta, nelTerminale, inCoda, stanotte, vive},
  quadroLavori?: {progetti: [{nome, conteggio}], giorni: [{data, conteggio}]},
  regiaDigest?: {at, text, engine: agnes|apple}, memoria?}`.
  `regiaDigest` e' l'ultima sintesi del Mac, facoltativa, con orario proprio: l'iPhone distingue
  il testo conservato dallo stato delle sessioni ricevuto ora.
  `melissa.personaggio` (build 134) e' chi ha la chiamata nella barra del Mac: `'melissa'` o la chiave di un
  personaggio (9.11), sempre una chiave semplice (`[a-z0-9_-]`, al piu' 40 caratteri; qualunque altro valore vale
  `'melissa'`, `personaggioDi` in `src/ponte.ts`). Assente con un Mac precedente: l'iPhone lo legge come Melissa.
  L'iPhone lo mostra nella riga del Mac in testa («sul Mac sei con Darlene») e sotto la sfera quando sul Mac si
  risponde o si parla. E' solo la scelta della barra: le domande dell'iPhone attraverso il ponte le prende sempre
  Melissa, e sull'iPhone con le chiavi la scelta e' locale (pulsanti «Con chi parli» in `ConversazioneView`).
  `memoria` (build 126, facoltativo, assente se vuoto) e' il contesto dalla memoria della Bottega che Melissa e i
  personaggi ricevono come dati (9.11, «Sanno cosa fa Andrea»): il riassunto del progetto con l'attivita' piu' recente
  (`~/.bottega/memoria/contesto/<projectKey>.md`) e i titoli dei riassunti degli ultimi tre giorni, al piu' 2500
  caratteri, gia' passato da `censura` (`src/memoria-contesto.ts`). Il Mac lo rilegge al piu' ogni due minuti e lo
  manda subito con l'ultimo letto, quindi il primo stato dopo l'avvio puo' non averlo ancora.
  `attivita` e' il registro osservato dalla Home: Claude Code, Cline, Codex e terminali integrati, con testo
  ripulito e stato della fonte. `steps` (ultimi 8 passi, massimo 180 caratteri ciascuno) ed `evidence`
  (massimo 300 caratteri) sono opzionali e passano dalla stessa redazione del testo riservato. `activityKey` collega una sessione Claude azionabile alla stessa attivita',
  per non contarla due volte sull'iPhone. Un Mac precedente non manda questi campi.
  `conti` usa `snapshot.workCounts`, con attivi da tutte le fonti osservate; `quadroLavori.progetti` conta
  le attivita' in corso o in attesa per percorso sul registro completo, deduplicato per chiave, prima dei limiti del ponte.
  Nomi di progetto uguali sono distinti con la cartella superiore. Il campo non viene inviato prima della prima scansione del Mac.
  `quadroLavori.giorni` contiene gli ultimi sette giorni nel fuso del Mac: ciascuna sessione osservata di Claude,
  Cline, Codex o terminale compare solo nel giorno del suo ultimo aggiornamento, non come lavoro concluso.
  L'iPhone mostra i nuovi grafici solo se riceve questo campo; uno stato salvato conserva l'ora di origine.
  Lavori sull'iPhone usa `attivita` e `lavori` di questa stessa risposta per le viste per progetto e per stato,
  con il filtro «Da seguire / Tutte». `activityKey` mantiene la scheda interattiva Claude anche quando la riga
  visualizzata viene da `attivita`.
  `path` identifica il progetto anche quando due cartelle hanno lo stesso nome: grafico e gruppi iOS
  mantengono le cartelle distinte, con il percorso superiore nell'etichetta degli omonimi. Senza `path`
  resta il raggruppamento per nome dei Mac precedenti. Le sessioni finite sono contate a parte, senza
  entrare nella scala delle barre degli stati da seguire.
  `https` (build 71): le stesse rotte cifrate su `porta + 1` (7791), con il
  certificato fatto dal Mac (`src/ponte-tls.ts`: chiave P-256 fatta da Node in PKCS#8, perche' quella di `openssl -newkey` la BoringSSL di Electron non la carica (build 72); SHA-256, 800 giorni, SAN col nome MagicDNS e l'indirizzo,
  in `~/.bottega/ponte-tls/`, rifatto se scade tra meno di 30 giorni o cambia il nome) e la sua impronta SHA-256
  del DER in esadecimale minuscolo. I QR nuovi portano `https_porta` e `https_impronta` per iniziare gia' con il pin.
  I collegamenti precedenti recuperano l'impronta con una lettura HTTPS di `/v1/stato` sull'IP Tailscale: la risposta
  autenticata deve dichiarare la stessa impronta vista nel certificato. Su IP Tailscale l'app non ripiega su HTTP,
  che App Transport Security blocca. `risposta` e' il testo che Melissa sta generando sul Mac: viene inviato
  nello SSE durante lo stream e sparisce quando entra nel registro finale. La vista iPhone conserva l'ultimo
  registro Mac ricevuto anche quando gli eventi si interrompono. Registro: gli ultimi 30 della barra di Melissa.
  Lavori: i primi 40 di `snapshot.work`.
- `GET /v1/eventi` -> `text/event-stream`: subito una riga `data: <stato>`, poi una a ogni cambio di Melissa,
  lavori o attivita' osservate (al massimo tre al secondo), `: ping` ogni 25 s.
- `POST /v1/chiedi {testo, conferma?}` -> `{risposta, stato}`. Con `conferma` (il numero arrivato nella notifica
  CONFERMA) passa solo se e' ancora la domanda aperta (`Assistant.pendingConfirmation()`), altrimenti 409. `Assistant.askRemote`: stesso cervello, stessa storia e stessi
  strumenti della barra, con `speak` falso (il Mac sta zitto). Conferme a rischio (push) come sul Mac: il turno dopo
  e' il si' o il no. 409 se Melissa sta gia' rispondendo (`Assistant.busy()`).
- `POST /v1/parla {testo}` -> `application/x-ndjson`, una riga per evento mentre Melissa risponde:
  `{tipo: 'voce', ok}` (subito: c'e' la voce del Mac?), `{tipo: 'frase', testo}` (ogni frase appena pronta),
  `{tipo: 'audio', pcm}` (PCM 16 bit, 24 kHz, mono, base64), `{tipo: 'voce-persa', errore}`, poi
  `{tipo: 'fine', risposta, stato}` dopo l'ultimo audio, oppure `{tipo: 'errore', errore}`. `Assistant.askRemoteVoice`:
  turno a voce come sul Mac (Agnes con `reasoning_effort: none`), ma ogni frase va al ponte invece che agli
  altoparlanti; il Mac non si mette in ascolto e la sua sfera non si muove. Ogni frase va subito al Nucleo
  (`ponte.flusso.testo`, in ordine) e l'audio torna come eventi `ponte.audio`. Se l'iPhone chiude la connessione,
  `Assistant.interruptRemote` ferma la risposta e `ponte.flusso.ferma` la voce. 409 se Melissa sta gia' rispondendo.
  Misura del 2/10/2026, prima di questo flusso: la voce partiva solo dopo tutta la risposta, la sintesi intera e il
  download del WAV.
- `POST /v1/voce {testo}` -> `audio/wav` (PCM 16 bit, 24 kHz, mono), dal Nucleo con `ponte.voce`. 503 senza Nucleo.
  Resta per chi vuole una frase intera; l'app usa `/v1/parla`.
- `POST /v1/lavoro {id, testo}` -> `{ok: true}` | 404: scrive nel terminale di un lavoro della Bottega.
- `GET /v1/stanza?nome=..` -> una stanza della plancia in sola lettura (9.6); `POST /v1/stanza/azione {..}` -> le
  poche azioni della stanza App Store (9.7).
- `GET /v1/stato`: `melissa.scelta?` (9.8), facoltativo. `GET /v1/cervelli` e `POST /v1/cervello {provider?, impegno?,
  sempre?}`: il cervello di Melissa (9.8).
- `GET /v1/assistente/config`: **solo HTTPS**, gettone obbligatorio, `Cache-Control: no-store`. Restituisce le chiavi
  Agnes, DeepSeek ed ElevenLabs disponibili sul Mac, `voiceID` e il prompt di Melissa per l'iPhone. Su HTTP torna 403;
  non entra nel QR, negli eventi, nei log o nei widget. L'app conserva le chiavi nel portachiavi del solo iPhone.
- `POST /v1/assistente/storia {turns:[{id,chi,testo}]}`: importa al massimo 24 turni completi fatti offline nel registro
  e nella storia di Melissa sul Mac. ID UUID, `chi` in `tu|melissa`, testo fino a 2000 caratteri. Gli ID importati
  sono ricordati in `~/.bottega/telefono-turni-importati.json` (600), per non duplicare un turno dopo un retry.
- Errori: `{errore}` in italiano, da mostrare cosi' com'e'.
- Comando «Collega l'iPhone» (`bottega.ponte.collega`): pagina con il QR (dal Nucleo) di
  `bottega://collega?host=<nome MagicDNS>&ip=<100.x>&porta=7790&token=<gettone>&https_porta=7791&https_impronta=<sha256>`
  e il pulsante per copiarlo. I due campi HTTPS mancano solo se il server TLS non e' partito.

### 9.2 Il Nucleo (`nucleo/Sources/Ponte/PonteComandi.swift`)

- `ponte.voce {testo}` -> `{path, engine: elevenlabs|apple, seconds}`: `SpeechFile.render` (ElevenLabs con la voce di
  Melissa, ripiego sulla voce di sistema) in un WAV sotto la cartella temporanea `bottega-ponte/`. L'estensione lo
  legge e lo cancella; i file piu' vecchi di dieci minuti li toglie il Nucleo al giro dopo.
- `ponte.qr {testo}` -> `{png}`: QR in base64 (CoreImage, correzione M, 12 px per modulo).
- `ponte.flusso.apri {id}` -> `{ok}`, `ponte.flusso.testo {id, testo}`, `ponte.flusso.fine {id}`,
  `ponte.flusso.ferma {id}`: lo stesso socket ElevenLabs di Melissa (`eleven_v4_turbo`, la voce di Avo, text-to-dialogue
  stream-input), ogni frase mandata e svuotata subito. `fine` invia `close_socket`: `is_final_audio_for_turn`
  chiude un turno, non ogni `flush`, mentre `is_final` conferma che l'ultimo PCM e' uscito. Eventi
  `ponte.audio {id, pcm}`, `ponte.audio.fine {id}` (dopo `is_final`), `ponte.audio.errore {id, errore}`.
  Se il socket cade prima del primo PCM, il Nucleo riprova con la stessa voce di Melissa su HTTPS REST
  (`eleven_multilingual_v2`) dopo che il testo della risposta e' completo. Un turno alla volta.

### 9.3 L'app (`ios/`)

- Progetto XcodeGen (`ios/project.yml`, `cd ios && xcodegen`), bundle `com.andreapiani.bottega.ios`, iOS 27+, solo
  iPhone, schema `bottega://` per il collegamento. Versione e build in `ios/Version.xcconfig`, scritte da
  `scripts/bump-build.sh`: sempre uguali a quelle della Bottega. Icona: `swift brand/icon.swift <out> --ios`.
- Sfera: `nucleo/Sources/Orb/OrbRenderer.swift`, `OrbShaders.metal` e `nucleo/Sources/Voice/AudioLevels.swift` sono
  compilati anche nell'app, non copiati; `ios/Bottega/Sfera/NucleoSuIPhone.swift` rifa' quel poco del Nucleo che
  chiamano (`MetalEngine`, `Log`, `Out`, `Nucleo.bundle`, `OrbPanel`). Chi cambia l'interfaccia di quei tre file
  compila anche l'app.
- Ascolto sull'iPhone come sul Mac: `SFSpeechRecognizer` it-IT, frase chiusa dopo 1,8 s senza parole nuove, otto
  secondi senza parole chiudono la conversazione; «basta», «a dopo», «chiudi» la chiudono a voce. Melissa sull'iPhone
  chiama direttamente Agnes o DeepSeek e il WebSocket ElevenLabs anche quando il Mac e' collegato. Ogni pezzo PCM
  va in coda su un `AVAudioPlayerNode` appena arriva (`FlussoVoce.swift`), la sfera si muove con il suono vero
  (tap sul mixer, `AudioLevels`). Un tocco sulla sfera interrompe subito modello e riproduzione. I turni locali
  vengono sincronizzati con la storia del Mac quando il ponte e' disponibile. Il ponte conserva `/v1/parla` per
  compatibilita' e altre viste, ma non e' il percorso della conversazione iOS. Gettone nel portachiavi
  (`AfterFirstUnlockThisDeviceOnly`), nome e porta nelle preferenze.
- Rete: HTTPS su Tailscale. Un QR nuovo fornisce subito porta e impronta del certificato; per un abbinamento
  precedente l'app legge una volta `/v1/stato` via HTTPS sull'IP 100.64.0.0/10, poi confronta l'impronta del
  certificato ricevuto con quella dichiarata nella risposta autenticata. Il traffico ordinario usa solo il pin
  (`FiduciaPonte`), salvato nelle preferenze condivise (`ponteHttps`) anche per i widget. Se l'impronta cambia,
  l'app ripete quella verifica; non ripiega su HTTP verso l'IP, che iOS blocca con ATS. Il vecchio percorso HTTP
  resta solo per un Mac privo di HTTPS e un nome MagicDNS `.ts.net` raggiungibile. Gli eventi ripartono da soli
  con attesa crescente fino a 30 s e si fermano con l'app dietro.
  Un 401 ferma gli eventi (niente tentativi che farebbero bloccare l'indirizzo): si riparte con un nuovo QR o al
  ritorno davanti dell'app. `/v1/parla` tollera 180 s senza dati (strumenti lenti), le altre richieste 90 s.
- Audio: si guarda sempre `motore.isRunning` (Siri, chiamate e cuffie fermano il motore: suonare su un motore fermo
  fa cadere l'app); a fine giro senza conversazione aperta, alla chiusura e con l'app dietro la sessione audio si
  rilascia (`setActive(false, .notifyOthersOnDeactivation)`), cosi' musica e podcast ripartono. Con `voce-persa` a
  meta' risposta, le frasi non ancora dette le dice la voce di iOS. Un solo giro di ascolto alla volta (contatore di
  giro: i callback di un riconoscimento fermato non toccano quello nuovo).
- Token per le push osservati da `didFinishLaunching`, anche quando iOS sveglia l'app in background per una Live
  Activity; il token del widget arriva con un avviso Darwin. «Scollega» avvisa prima il Mac (token vuoti) e chiude
  le Live Activity.

### 9.4 Notifiche, Live Activity, widget, Siri

Le manda il Mac, direttamente ad APNs (HTTP/2), senza server di terzi: `extensions/bottega-home/src/apns.ts`
(client) e `src/avvisi.ts` (quando e cosa mandare). Mac spento o Bottega chiusa: non arriva niente.

**Chiave.** La chiave APNs del team, gia' nel vault: `~/.secrets/apns-AuthKey_RF29RR7SKM.p8`, Key ID `RF29RR7SKM`,
team `ERAK83QBBM`, sviluppo e produzione. Si legge da `~/.secrets/bottega.env` (`APNS_KEY_PATH`, `APNS_KEY_ID`,
`APNS_TEAM_ID`), mai dal repository. JWT ES256 (`crypto.sign` con `dsaEncoding: 'ieee-p1363'`), rifatto ogni 50
minuti. Host: `api.sandbox.push.apple.com` per `ambiente: 'sviluppo'` (build Debug), `api.push.apple.com` per
`produzione`. Topic: `com.andreapiani.bottega.ios` (alert), `com.andreapiani.bottega.ios.push-type.liveactivity`,
`com.andreapiani.bottega.ios.push-type.widgets`. Un token che APNs dice morto (410, `BadDeviceToken`,
`Unregistered`) si toglie dal registro.

Ogni push porta `apns-expiration` (0 = un tentativo solo, adesso). Un turno dall'iPhone esclude quelli del Mac:
finche' dura, microfono, tasto e barra del Mac non aprono turni (`Assistant.remote`, `busy()`).

**Registro.** `POST /v1/dispositivo {token?, ambiente, avvio?, attivita?, widget?}` -> `{ok: true}`: token in esadecimale.
`token` = notifiche (`didRegisterForRemoteNotifications`), `avvio` = push-to-start della Live Activity
(`Activity<BottegaAttivita>.pushToStartTokenUpdates`), `attivita` = la Live Activity aperta adesso
(`activity.pushTokenUpdates`; `attivita: ''` quando finisce), `widget` = `WidgetPushHandler`. Un solo iPhone per
ora: i campi si fondono; se cambia `ambiente` i token di prima si buttano. File `~/.bottega/iphone.json` (600).

**Notifiche** (`apns-push-type: alert`). Solo quando Andrea e' lontano dal Mac: nessun input da tastiera o mouse da
2 minuti (`HIDIdleTime`), impostazione `bottega.iphone.avvisi` (`lontano` | `sempre` | `mai`, default `lontano`).
Il testo passa dai server di Apple: solo nome del progetto e una frase breve, mai codice o contenuto delle sessioni.
Unica eccezione voluta, il `passo` di una sessione seguita (9.5): un verbo e il nome di un file o di un programma
(«modifica ponte.ts»), al massimo 60 caratteri, mai percorsi, argomenti o testo dei comandi.
- `ATTESA`: una sessione passa a «ti aspetta». `{aps: {alert: {title: <progetto>, body: "Ti aspetta: <titolo>"},
  sound: "default", category: "ATTESA", "thread-id": <progetto>, "interruption-level": "time-sensitive"},
  chiave: <work key>, jobId?: <id>}`. Azione «Rispondi» (testo) solo se c'e' `jobId`: l'app manda il testo con
  `POST /v1/lavoro`. Una volta per passaggio a «ti aspetta», non piu' di una ogni 10 minuti per la stessa sessione.
- `FINITO`: un lavoro della Bottega esce dalla lista mentre era «in corso» (o un lavoro della notte finisce).
  `{aps: {alert: {title, body: "Ha finito: <titolo>"}, category: "FINITO", "thread-id"}}`.
- `CONFERMA`: Melissa aspetta un si' o un no su un'azione a rischio (push, stop). `{aps: {alert: {title: "Melissa",
  body: "Posso <azione>?"}, sound: "default", category: "CONFERMA", "interruption-level": "time-sensitive"},
  conferma: <numero della domanda>}`. Azioni «Si'» e «No»: l'app manda
  `POST /v1/chiedi {testo: "si'"|"no", conferma}`; una notifica vecchia prende 409 e non conferma niente.
- `REGOLA`: un progetto passa a rosso nel semaforo. `{aps: {alert: {title, body: <frase>}, category: "REGOLA"}}`.
- Allarme della stanza App Store (13.7): `{aps: {alert: {title: <app>, body: <testo>}, "thread-id": "appstore"}}`, senza
  categoria; al Mac no (e' gia' una notifica del Mac).
Toccare una notifica apre l'app (ATTESA, FINITO: stanza Lavori; CONFERMA: Melissa).
Con Andrea al Mac: ATTESA, FINITO e REGOLA si considerano viste (allontanandosi non arriva una raffica per ogni
sessione ferma; arriva solo chi comincia ad aspettare mentre e' via); la CONFERMA resta in sospeso e parte quando si
allontana, se la domanda e' ancora aperta. Un invio fallito per la rete si riprova dopo un minuto. All'avvio della Bottega i
primi 60 secondi fanno da linea di partenza: quello che c'e' gia' non suona. `mai` spegne solo le notifiche: Live
Activity e widget restano.

**Live Activity** (`apns-push-type: liveactivity`, attributi `BottegaAttivita` in `ios/Condiviso/BottegaAttivita.swift`).
`content-state` = `{inCorso, tiAspetta, vive, righe: [{progetto, stato, da, fonte?}], segui?: {progetto, passo, stato}, aggiornato}` (al massimo tre righe,
in ordine di tempo, dalla piu' recente, dal 6 ottobre 2026; prima era prima chi ti aspetta; `da` e `aggiornato` in ms dal 1970). Dalla build 92 contatori e righe
provengono dal registro `attivita` di tutte le fonti (Claude Code, Cline, Codex e Terminale), deduplicato
per chiave; `vive` conta quelle in corso o in attesa, non lo storico. `fonte` e' il nome visibile del programma,
facoltativo per leggere anche i payload precedenti. Il registro vuoto e' autorevole; soltanto se manca
si usa `lavori` con i contatori precedenti. Le notifiche con azioni restano legate ai lavori controllabili.
- Vive finche' ci sono sessioni AL LAVORO (`inCorso`) o una sessione seguita dall'iPhone (`segui`, 9.5, anche se
  aspetta; allora l'avvio dice «Segui <progetto>»): quelle ferme contano come «ti aspetta» tutto il giorno e
  non la farebbero mai finire. Chi aspetta resta nel contenuto, in ambra, finche' l'attivita' vive.
- Avvio con il token `avvio` quando ci sono sessioni al lavoro e non c'e' un'attivita' aperta:
  `{aps: {timestamp, event: "start", "content-state", "attributes-type": "BottegaAttivita", attributes: {mac},
  alert: {title: "Bottega", body: "<n> sessioni al lavoro"}}}`, priorita' 10. Vale anche con Andrea al Mac.
- Aggiornamento con il token `attivita` a ogni cambio, al massimo ogni 15 s (priorita' 5; 10 se cambia `tiAspetta`):
  `{aps: {timestamp, event: "update", "content-state", "stale-date": ora + 15 min}}`.
- Se non cambia niente, un aggiornamento ogni 10 minuti comunque, cosi' l'attivita' non diventa vecchia.
- Chiusa a mano sull'iPhone mentre ci sono sessioni: non riparte finche' non passano 2 minuti senza sessioni. Un
  avvio rifiutato da APNs si riprova dopo 2 minuti. Dopo `end` il Mac toglie il token `attivita` dal registro.
- Fine dopo 2 minuti senza sessioni: `{aps: {timestamp, event: "end", "content-state", "dismissal-date": ora + 5 min}}`.
- Token di un'attivita' che non c'e' piu' (build 43). APNs risponde 200 anche al token di un'attivita' chiusa, quindi il
  Mac non se ne accorge dagli errori. Due difese: (1) l'app, a ogni avvio, se non ha Live Activity aperte ma il Mac ha
  ancora un suo token `attivita`, manda `attivita: ""` (app reinstallata o aggiornata, attivita' chiusa ad app spenta);
  il Mac, se quel token non era di un'attivita' fatta partire da lui (push-to-start nei 10 minuti prima), riparte
  subito con `avvio`. (2) Oltre le 8 ore (limite di iOS) il token si toglie e si riparte con `avvio`.
- Interruttore «Live Activity e Dynamic Island» nelle impostazioni dell'app (preferenza condivisa
  `liveActivityAccese`, accese se mai scelto). Spente: l'app manda `avvio: ""` e `attivita: ""` e chiude quelle aperte,
  e i nuovi token di avvio restano sull'iPhone. Riaccese: rimanda il token di avvio, e il Mac (che l'aveva visto
  sparire) la fa ripartire subito se c'e' lavoro, anche se quella di prima era stata chiusa a mano (build 69). Lo
  sparire lo dice il ponte appena arriva `avvio: ""` (`Avvisi.avvioTolto`): spente e riaccese in meno di un secondo un
  giro non le vedeva mai spente (build 75). Sotto, se servono, il rimando alle
  impostazioni di iOS (`ActivityAuthorizationInfo().areActivitiesEnabled`).

**Widget** (`apns-push-type: widgets`, `{aps: {"content-changed": true}}`, priorita' 5) a ogni cambio di `tiAspetta`
o `inCorso`, e quando cambiano identita', fonte, progetto, titolo o stato delle sessioni osservate,
al massimo uno ogni 5 minuti (salvo `tiAspetta` che sale). Il widget rilegge `GET /v1/stato` dal ponte
con il collegamento condiviso; se il Mac non risponde mostra l'ultimo stato salvato dall'app (`StatoMac.ultimo()`)
con la sua eta'. La stessa push parte anche quando cambia il numero dei rossi del semaforo o cambiano gli allarmi in
`Istantanea.negozio` (App Store e avvisi di ricarica dei servizi), sempre al massimo una ogni 5 minuti; quei due
pezzi della firma contano solo quando semaforo e negozio sono stati letti.

**Condiviso tra app e widget** (`ios/Condiviso/`): gruppo `group.com.andreapiani.bottega.ios`, portachiavi
`$(AppIdentifierPrefix)com.andreapiani.bottega.condiviso` (il gettone), `StatoMac`, `BottegaAttivita`, `Tinte`.

**Estensione dei widget** (`ios/BottegaWidget/`, bundle `com.andreapiani.bottega.ios.widget`, con app group,
portachiavi condiviso e `aps-environment` per le push dei widget; il token lo scrive in `Condiviso.chiaveTokenWidget`
e l'app lo manda al Mac): widget «Sessioni»
(piccolo, medio, schermata di blocco): conteggi, progetti e righe usano la stessa proiezione multi-fonte
deduplicata di `StatoMac`; nel medio compare il programma di ogni riga. La Live Activity (Dynamic Island e schermata di blocco), il controllo
«Parla con Melissa» del Centro di Controllo (apre `bottega://melissa?ascolta=1`), e quattro widget che vengono dalle
stanze del Mac (9.6):

- «Guadagni» (piccolo, medio, grande, schermata di blocco rettangolare e in linea; `AppIntentConfiguration` con
  periodo ieri, settimana o mese e un'app o tutte): `GET /v1/stanza?nome=appstore&periodo=..&progetto=<app>`. Totale in
  ambra, AdMob e Store, freccia sul periodo prima (solo AdMob quando lo Store e' incompleto), barre impilate dei giorni
  con i colori della stanza; nel grande le tre app migliori e il primo buco con la stima al mese. Con
  `storeIncompleto` dice «Store fino al ...». Le app proposte nella configurazione sono quelle viste l'ultima volta
  nella stanza. Un tocco apre `bottega://stanze?nome=appstore`.
- «Consigli» (medio, grande): `GET /v1/stanza?nome=consigli`. Un tocco apre `bottega://stanze?nome=<apri>` (o
  `bottega://lavori`); con piu' consigli la freccia (`ProssimoConsiglio`, App Intent interattivo) passa al successivo
  leggendo solo la copia, senza rete. I consigli dei lavori in attesa comprendono tutte le fonti,
  con il nome del programma; Claude presente nel registro non viene contato due volte. I lavori appena
  creati non ancora rappresentati restano disponibili. Per le sessioni osservate in sola lettura
  il consiglio rimanda al programma sul Mac, senza promettere una risposta remota.
- «Crediti» (piccolo, medio): `GET /v1/stanza?nome=servizi`, ogni ora. DeepSeek con il saldo e i giorni al ritmo di
  adesso, ElevenLabs con i caratteri del mese, Agnes gratis, ognuno col suo tono; nel medio la spesa di DeepSeek dei
  14 giorni. Un tocco apre `bottega://stanze?nome=cruscotto`.
- «Semaforo» (piccolo, schermata di blocco tonda): `GET /v1/stanza?nome=vedetta`; il primo rosso in una riga. Un
  tocco apre `bottega://stanze?nome=vedetta`.

Guadagni, Consigli e Semaforo hanno il gestore delle push (`SpintaWidget`), Crediti no. Timeline: ogni 30 minuti
(Crediti 60). Richiesta di 8 s al massimo (`DatiWidget`), prima il nome MagicDNS poi l'indirizzo 100.x, gettone del
portachiavi condiviso. Copia condivisa (`ios/Condiviso/CacheWidget.swift`): `Library/Caches/widget` nel contenitore
del gruppo, protezione fino al primo sblocco, solo `appstore`, `vedetta`, `consigli`, `servizi`. La scrivono i widget
e l'app (`PonteStanze.leggi`, che poi ricarica il widget di quella stanza); una copia di meno di 2 minuti non si
richiede, cosi' piu' widget sulla stessa stanza fanno una richiesta sola. Col Mac spento il widget mostra la copia
con «2 h fa» e la frase dell'errore; senza copia lo dice, mai un numero finto. Scollegando l'iPhone la copia si
cancella.

**Siri** (App Intents nell'app): «Chiedi a Melissa» (`POST /v1/chiedi`, Siri legge la risposta) e «Chi mi aspetta»
(dallo stato), con le frasi per Comandi rapidi e Siri.

### 9.5 La scheda di una sessione (`src/ponte-sessioni.ts`, `src/ponte-sessioni-host.ts`, `src/sessione-lettura.ts`, `src/schermo.ts`)

Per tutte le sessioni Claude del Mac, anche quelle aperte in iTerm o altrove. Le rotte passano dal gettone come le
altre: `src/ponte.ts` le gira a `SessioniPonte.gestisci` dopo il controllo (`PonteDeps.sessioni`), e chiudendo il
ponte si chiudono anche i flussi della scheda. `chiave` e' la `chiave` di `/v1/stato` (`job:<id>` o `sess:<sessionId>`).
Nessuna rotta apre una shell o esegue comandi arbitrari.

- `GET /v1/sessione?chiave=K` -> `Scheda` | 404:
  `{chiave, origine: bottega|altrove, stato, progetto, titolo, da, jobId?, iniziata?, ultimo?, richiesta?, risposta?,
  passi: [{testo, tipo: modifica|comando|lettura|ricerca|web|agente|altro, alle, inCorso?}], file: [percorso],
  token?: {entrata, uscita, contesto, parziale?}, domanda?: Domanda, scrivibile, terminale, modifiche, seguita,
  finita?}`. Fonti: la coda (256 KB) di `~/.claude/projects/<cartella>/<sessione>.jsonl` (come `src/mani.ts`) e il
  registro `~/.claude/sessions/<pid>.json` (`status`, `waitingFor`, `startedAt`, `cwd`). Passi in chiaro, gli ultimi
  20: «ha modificato ponte.ts», «sta lanciando <descrizione o comando>», «sta leggendo README.md». File relativi al
  progetto. Token: `uscita` e `entrata` (input + cache creata) su tutta la sessione, una volta per messaggio
  (`message.id`), contati la prima volta su tutto il file (al massimo gli ultimi 64 MB, allora `parziale`) e poi solo
  sulla parte nuova; `contesto` = l'ultimo messaggio con la cache letta. `iniziata` = `startedAt` del registro.
- `Domanda` = `{id, tipo: permesso|scelta|domanda|finestra, testo, strumento?, comando?, opzioni?, chiede?}`, solo
  quando la sessione aspetta («ti aspetta» o `status: waiting` nel registro). `permesso`: `waitingFor` = «approve
  <Strumento>: <comando>» (Claude Code lo scrive nel registro), descrizione dalla trascrizione; con Claude Code
  vecchi, uno strumento senza risultato a sessione ferma. `scelta`: un `AskUserQuestion` aperto, con le opzioni.
  `domanda`: Claude ha finito il giro, `testo` = la sua ultima risposta, `chiede` se finisce con una domanda.
  `finestra`: un altro `waitingFor` («dialog open», «input needed», «approve plan»): si gestisce dal Mac. `id` cambia
  a ogni domanda nuova.
- `GET /v1/sessione/eventi?chiave=K` -> `text/event-stream`: subito `data: <Scheda>`, poi una a ogni cambio, `: ping`
  ogni 25 s. Mentre almeno un flusso e' aperto un giro ogni 1,5 s guarda solo dimensione e data del jsonl e del
  registro e lo stato del lavoro; la coda si rilegge solo se sono cambiati. Nessun flusso aperto: nessun timer.
  Al massimo 8 flussi insieme (429).
- `POST /v1/sessione/rispondi {chiave, domanda: <id>, risposta: si|no|testo, testo?}` -> `{ok: true}`. Solo lavori
  della Bottega (403 «Questa sessione e' aperta in un'altra app: rispondi dal Mac.»), solo se `domanda` e' ancora
  la domanda aperta adesso (409 altrimenti), mai per `finestra` (409). Tasti nel terminale (`JobManager.type`,
  senza portarlo davanti): permesso si' = invio (la prima opzione, «Yes», e' gia' scelta), no = Esc, testo = Esc e
  dopo 350 ms il testo con invio (no, e cosa fare invece); scelta: solo testo (Esc, poi il testo come messaggio);
  domanda: «Sì», «No» o il testo, con invio. Testo senza a capo e caratteri di controllo, al massimo 2000.
- `GET /v1/sessione/modifiche?chiave=K` -> `{cartella, ramo, file: [{percorso, aggiunte, tolte, tipo:
  modificato|nuovo|tolto|binario}], nonTracciati, troncato}` | 403 fuori dai progetti | 409 non e' un repository.
  Cartella: il `cwd` della sessione se sta dentro un progetto che la Bottega conosce (un worktree), altrimenti la
  cartella del progetto; mai fuori dai progetti. `git diff HEAD --numstat --no-renames --relative` piu'
  `git ls-files --others --exclude-standard` (i primi 40, con le righe contate).
- `GET /v1/sessione/diff?chiave=K&file=F` -> `{file, diff, troncato, nuovo}`. `F` relativo, risolto dentro la
  cartella (anche dopo i link simbolici), altrimenti 400/403. Un file tracciato: `git diff HEAD -- :(literal)F`; un
  file nuovo solo se `ls-files --others --exclude-standard` lo elenca (mai un file ignorato come `.env`):
  `git diff --no-index -- /dev/null F`.
- git: sempre `spawn` senza shell, `--no-optional-locks`, `core.fsmonitor=false`, `--no-ext-diff --no-textconv`,
  `GIT_TERMINAL_PROMPT=0`, 10 s al massimo, uscita tagliata a 200 KB (`troncato`).
- `GET /v1/sessione/terminale?chiave=K` -> `text/event-stream` di `{righe: [..ultime 150], vivo}`. Solo lavori della
  Bottega (403), 404 se il terminale e' chiuso, 409 con il motivo se non si puo' leggere. L'uscita viene dall'API
  stabile della shell integration: `window.onDidStartTerminalShellExecution` ricorda il comando che gira in ogni
  terminale, e solo mentre l'iPhone guarda si apre `execution.read()` (dati da quel momento in poi). `Schermo`
  esegue le sequenze ANSI che servono a un'interfaccia in linea (a capo, cursore, cancella riga e schermo, schermo
  alternativo) e scarta il resto; in memoria, mai su disco, al massimo quattro invii al secondo e tre terminali
  insieme. Da qui non si scrive.
- `POST /v1/sessione/segui {chiave}` -> `{ok, seguita}` (`chiave: ''` smette). Il Mac guarda quella sessione ogni 5 s
  (solo mentre e' seguita) e la Live Activity porta nel `content-state` il campo facoltativo
  `segui: {progetto, passo, stato}`. `passo` passa dai server di Apple, quindi e' corto e senza contenuti: un verbo e
  il nome del file o del programma («modifica ponte.ts», «lancia npm», «chiede un permesso», «aspetta te»), mai
  argomenti, percorsi o testo della sessione. Dopo due minuti fuori dalla lista si smette da soli. Una sessione seguita
  tiene viva la Live Activity anche quando aspetta (9.4); la riga seguita sta in testa, con l'occhio.
- `POST /v1/sessione/riassunto {chiave}` -> `application/x-ndjson` con le stesse righe di `/v1/parla` (`voce`,
  `frase`, `audio`, `voce-persa`, `fine {risposta}`, `errore`), 409 se Melissa sta gia' rispondendo. La domanda a
  Melissa e' «riassumimi a voce, in due frasi, la sessione su <progetto>» con la scheda in frasi brevi (sotto i 2000
  caratteri): parla proprio di quella sessione anche se sullo stesso progetto ce n'e' piu' d'una. Resta nella
  conversazione come le altre domande.
- `src/jobs.ts`: `waiting` (Claude Code con una domanda aperta) conta come «ti aspetta» anche per le sessioni aperte
  altrove (prima finiva in «nel terminale»).

App (`ios/`): un tocco su una sessione nella stanza Lavori apre `SessioneView` (scheda in diretta, domanda in
primo piano, «Riassumimelo», «Segui»), da li' `ModificheView` / `DiffView` e `TerminaleView`. Cliente a parte,
`PonteSessioni` (stesso collegamento di `Ponte`, sue connessioni). La diretta vive solo con la scheda aperta e
l'app davanti.

### 9.6 Le stanze della plancia (`src/ponte-stanze.ts`)

Una rotta sola per leggere, dietro il gettone come le altre: `src/ponte.ts` la gira a `PonteDeps.stanze`
(`RotteStanze.leggi(searchParams)`) dopo il controllo del gettone; un metodo diverso da GET prende 405. L'unica che
scrive, le azioni della stanza App Store, e' in 9.7. Le fonti sono
quelle di `stanza_leggi` (sezione 6): `fontiStanze()` di `src/strumenti-stanze.ts`, cioe' lo stato che la plancia
mostra (`AppStore.state()`, il calcolo del cruscotto, `idee.rules`, `idee.radar` con `vercel`, le ore per cliente, la
Memoria, `statoPosta()` della stanza Connettori, `idee.night`), piu' i lavori per la fila della notte. Nessuna
chiamata di rete, nessuna delega, nessuna scrittura. Elenchi tagliati: una risposta sta sotto i 40 KB anche con
centinaia di progetti, salvo `appstore`, che con i dati veri (43 buchi, ognuno con il suo compito) arriva a circa
55 KB e resta sotto gli 80 KB. Testi gia' ripuliti dalle lineette lunghe e medie (`pulisci`).

`GET /v1/stanza?nome=<appstore|cruscotto|vedetta|dafare|posta|clienti|notte|servizi|consigli>&periodo=..&progetto=..&mese=..&app=..`

- `periodo`: `ieri`/`oggi` (1), `settimana` (7), `mese` (30), `trimestre` (90), `anno` (365) o i giorni, ricondotti
  da `periodoDa`. `progetto`: risolto con `resolveProject` (per `appstore` anche il nome di un'app). `mese`:
  `YYYY-MM` o come lo dice Andrea (`meseDa`), per `appstore` e `clienti`. `app`: la chiave di un'app, solo per
  `appstore` (9.7).
- Ogni risposta: `{stanza, ora, aggiornatoAt, ...}`; `aggiornatoAt` e' l'ora del dato sul Mac (0 se non si sa).
- Errori `{errore}` in italiano: 400 stanza sconosciuta, 404 progetto o app che non c'e', 503 stanza non pronta
  (prima lettura in corso, calcolo oltre 20 s, Memoria o Connettori assenti, Bottega che si avvia). La frase si
  mostra cosi' com'e'.

Forme (tempi in ms dal 1970, euro, minuti):

- `appstore` (predefinito 30 giorni): `{aggiornando, valuta, periodo, mese, quale: giorni|mesi, etichetta, progetto,
  cifre: {totale, admob, store, download}, prima: Cifre|null, grafico: [{chiave, admob, store|null, download,
  nelPeriodo}], storeFinoA, storeIncompleto, abbonamenti: {finoA, attivi, prove, mrr, ritardo, attiviPrima,
  giorniPrima, eventi: {categoria: n}}|null, app: [{chiave, nome, piattaforma, path, progetto, totale, admob, store,
  download}] (fino a 25, con almeno 50 centesimi o un download), buchi: [{id, app, gravita, titolo, perche, cosa,
  stima, stimaNota, path, progetto, daQuando}] (fino a 50), buchiTotali, stimaTotale, allarmi: [{app, testo, at}]
  (10), errori: {store?, admob?}}`; i campi in piu' per la stanza intera sull'iPhone sono in 9.7. Giorni fino a 30 (per `ieri` il grafico e' la settimana con ieri in fondo), mesi
  oltre (90 = 3 mesi, anno = 12 compreso quello in corso; il grafico ha sempre 12 mesi). `store: null` = il report
  di quel giorno non c'e' ancora (dopo `storeFinoA`) o Apple non lo da' piu' (`storeSenzaDati`): non e' zero.
  `storeIncompleto`: il periodo arriva oltre l'ultimo report dello Store. Abbonati: l'ultimo giorno con il report
  (`abbFinoA`) contro almeno sette giorni prima; eventi sommati sui giorni del periodo (al massimo 30), quelli a
  zero non viaggiano.
- `cruscotto` (predefinito 7; 1 e 7 danno 7, 365 da' 90 con `anno`): `{periodo, progetto: {nome, path}|null, cifre:
  {tu, claude, sessioni, token, valore, giorniAttivi}, prima: {tu, claude, token, valore}|null, oggi: {tu, claude,
  sessioni, token}, settimana: {tu, claude, primaFinOra, inizio}|null, grafico: [{giorno, tu, claude|null}] (un
  punto per giorno del periodo), progetti: [{nome, path, tu, claude, sessioni, token, valore, vive, ultimo}] (8),
  vive, anno?}`. Con un progetto il grafico ha solo le sue ore tue (`claude: null`) e `progetti` e' vuoto.
- `vedetta`: `{conti: {rosso, giallo, verde}, globali: [Regola], progetti: [{path, nome, livello, regole: [Regola]
  (3), altre}] (25, prima i rossi; i verdi no), progettiTotali, siti: {aggiornatoAt, errore?, conti: {male,
  attesa, ok}, elenco: [{nome, path, progetto, stato, etichetta, tono, at, dominio?, errore?, onlineDal?}] (25,
  prima le fallite, poi in corso, poi le piu' recenti)}|null}`, `Regola = {id, livello, frase, rimedio}`.
- `dafare`: `{progetti: [{nome, path, at, cose: [..8], altre}] (25), riassunti}`: la riga «Da fare:» dell'ultimo
  riassunto di ogni progetto che ne ha una, dagli ultimi 25 riassunti (5 con un progetto). Non di piu': la CLI
  della Memoria taglia l'uscita a 64 KB (vedi sotto).
- `posta`: `{giorni, posta: {aggiornatoAt, errore?}, whatsapp: {aggiornatoAt, errore?}, conti: {nonLetti,
  chatDaRispondere, mailDaAssegnare, chatDaAssegnare}, progetti: [{nome, path, nonLetti, chatDaRispondere, mail:
  [{da, oggetto, at, nonLetto}] (5), mailTotali, chat: [{contatto, gruppo, at, mio, anteprima?}] (5), chatTotali}]
  (20, solo quelli con posta o chat)}`. Privacy: `da` e' il nome del mittente, o il solo dominio se manca il nome;
  `contatto` che sia solo un numero diventa «contatto senza nome»; l'anteprima (60 caratteri, solo se l'ultimo
  messaggio non e' tuo) ha indirizzi e numeri sostituiti da «[indirizzo]» e «[numero]»; anche `oggetto` ha indirizzi
  e telefoni sostituiti (`oggettoSicuro`: date e numeri d'ordine restano). Mai indirizzi, numeri, corpi delle mail.
- `clienti`: `{mese, mesi, inCorso, arrotondamento, configurati, clienti: [{id, nome, minuti, importo?, tariffa?,
  giorni, progetti: [{nome, path, minuti}] (4)}] (30), fuori: [{nome, path, minuti}] (6), totale: {minuti,
  importo?}}`.
- `notte`: `{finestra: {da, a}, insieme, inFila, inCorso, corrente, perche, fila: [{progetto, path, titolo, stato,
  chiave}] (15, i lavori «stanotte»), resoconto: {giorno, lavori: [{progetto, compito, stato, riassunto?}] (15)}|null}`.
- `servizi` (per il widget «Crediti»): `{servizi: [{id: deepseek|elevenlabs|agnes, nome, tono: ok|attesa|male,
  frase?, valuta?, saldo?, mediaGiorno?, giorniRimasti?, letto?, unita?, usati?, limite?, rinnovo?, gratis?}], spesa:
  {valuta, giorni: [{giorno, deepseek, caratteri}] (14, fino a oggi)}}`. DeepSeek ha `valuta`, `saldo`,
  `mediaGiorno`, `giorniRimasti` e `letto`; ElevenLabs `unita`, `usati`, `limite` e `rinnovo`; Agnes `gratis`. Fonte:
  `~/.bottega/conti/giorni.json` (sezione 14), letto a ogni richiesta; `aggiornatoAt` = `aggiornato` del file. Solo i
  tre servizi noti, in quest'ordine; `campioni` non esce. Un giorno senza riga ha `null` (non letto), non zero. Un
  `tono` sconosciuto vale `attesa`. Senza file: 503 «I conti dei servizi non sono ancora stati letti: li legge la
  Bottega sul Mac.»; file che non si legge: 503.
- `consigli` (per il widget «Consigli»): `{consigli: [{id, fonte: appstore|vedetta|lavori|dafare|home, etichetta,
  titolo, perche?, cosa?, valore?, soggetto?, apri, chiave?}] (8), conti: {buchi, stimaTotale, rossi, tiAspetta}}`. In
  ordine: il buco piu' grosso dell'App Store (`valore` = stima in euro al mese), la prima regola rossa (prima quelle
  di tutti i progetti), fino a due sessioni che ti aspettano (`chiave` = la chiave della sessione), la prima cosa da
  fare dell'ultimo riassunto della Memoria (al massimo 4 s, poi si lascia indietro), fino a tre consigli della Home
  (`advice` di `~/.bottega/briefing.json`, `etichetta` «Apple Intelligence» o «La Home»). `apri` = la stanza da
  aprire nell'app (`appstore`, `vedetta`, `dafare`), oppure `lavori` o `stanze`. Una fonte non pronta si salta: la
  risposta e' 200 anche con l'elenco vuoto, e in `conti` vale `null`. Mai posta ne' WhatsApp.

Niente di quello che passa di qui finisce nel registro del ponte: si scrivono solo le frasi d'errore della rotta
(«Non trovo il progetto ...»). Niente nelle notifiche APNs.

App (`ios/Bottega/Stanze/`): terza voce «Stanze» accanto a Melissa e Lavori (`Navigazione.Stanza.stanze`), una
griglia di sette tessere; ogni stanza si apre a tutto schermo (`StanzaPlancia`, `AppStoreView`, `CruscottoView`,
`VedettaView`, `DaFareView`, `PostaView`, `ClientiView`, `NotteView`), si tira giu' per aggiornare. Cliente a parte
`PonteStanze` (stesso collegamento di `Ponte`, sue connessioni, 45 s). Ogni risposta buona resta come ultima copia con
l'ora in cui l'iPhone l'ha vista: con il Mac spento la stanza mostra quella con la frase dell'errore e «Questo è
l'ultimo dato visto, 2 ore fa». In memoria sempre; su disco (cache dell'app, protezione completa) solo `appstore`,
`cruscotto`, `vedetta`, `dafare`, `notte`; `posta` e `clienti` solo in memoria. Scollegando l'iPhone le copie si
cancellano. Un tocco su un progetto che ha una sessione aperta nei Lavori apre la sua scheda (9.5). Link:
`bottega://stanze[?nome=appstore]`. `AppStoreView` e' la stanza intera; un tocco su un'app apre `SchedaAppView` (9.7).
`servizi` e `consigli` non sono tessere della griglia: le leggono i widget (9.4).

Dalla build iPhone 96, una stanza visibile si rilegge ogni 60 secondi e subito al ritorno in primo piano;
il ciclo si cancella uscendo o passando in background. Una richiesta cancellata non aggiorna la copia e non
avvia ripieghi di rete. Il refresh periodico aspetta che le letture manuali siano terminate.
Lavori e il riepilogo del Cruscotto usano il registro `attivita` delle quattro fonti, con gli stessi conteggi
deduplicati dei widget e l'ora effettiva dello snapshot anche offline. Anche i progetti aprono sessioni Codex,
Cline e Terminale; solo i lavori collegati conservano le azioni già previste dal ponte.
Il dettaglio ore, token e grafici di `/v1/stanza?nome=cruscotto` del Mac 95 resta relativo a Claude Code:
l'iPhone e il racconto di Melissa dichiarano questo ambito, senza dedurre ore dalle quantità di sessioni.
La build mobile 96 è indipendente dalla build Mac 95, lasciata in esecuzione senza reinstallazione.

La build mobile 97 serializza le registrazioni dei token APNs: ogni richiesta conserva il proprio snapshot,
il delta si calcola dopo la conferma precedente e solo i valori confermati vengono memorizzati. Una vecchia
richiesta di spegnimento non può quindi sorpassare la riaccensione della Live Activity. Il cambio Mac invalida
gli invii accodati e le conferme della destinazione precedente. La chiusura manuale della Live Activity resta
distinta dallo spegnimento e dalla riaccensione espliciti.

La build mobile 98 estende all'intervallo IP Tailscale `100.64.0.0/10` l'eccezione ATS per il certificato
privato del ponte, sia nell'app sia nel widget. Le richieste restano HTTPS, con TLS minimo 1.2: il certificato
deve coincidere con l'impronta del Mac abbinato e superare la verifica di nome/IP e scadenza. Il percorso IP
funziona anche senza risoluzione MagicDNS; non viene introdotto un ripiego HTTP. L'ambiente APNs deriva dal
profilo di firma incorporato, non da Debug/Release: una Release installata con firma development registra
token di sviluppo. Gli ACK salvati senza ambiente, o per un ambiente diverso, vengono invalidati e reinviati.
Le modifiche restano mobile: il Mac 95 non viene reinstallato o riavviato.

### 9.7 La stanza App Store sull'iPhone: piu' dati, grafici e azioni (`src/ponte-stanze.ts`, `ios/Bottega/Stanze/AppStore/`)

Parita' con la stanza del Mac (sezione 13): l'iPhone vede tutto quello che mostra `media/appstore.js` e puo' fare le
stesse azioni sui buchi. Le recensioni non ci sono: non le ha nemmeno la stanza del Mac.

**Campi in piu' di `GET /v1/stanza?nome=appstore`** (tutti facoltativi per l'app: un Mac vecchio risponde senza e la
stanza si mostra lo stesso):

- in testa: `fase?` (mentre `aggiornando`), `controlloOre` (`bottega.appstore.controlloOre`, null se non si sa).
- `grafico[].prima: {chiave, admob, store|null, download}|null`: lo stesso punto nel periodo prima, tanti giorni (o
  mesi) indietro quanti ne ha il grafico. Serve alla tendenza cumulata.
- `versioni: [{chiave, v, app}]`: le uscite (giorni o mesi, come il grafico) dentro il grafico, solo con un filtro
  (`app` o `progetto`), come le tacche della stanza del Mac con un'app scelta.
- `app[]` (fino a 25, quelle con almeno 50 centesimi o un download nel periodo) con in piu' `totalePrima|null`,
  `buchi`, `subito` (i buchi alti), `abbonati?` (che pagano all'ultimo giorno), `andamento: number[]` (euro per punto
  del grafico, lo Store solo dove c'e': la scintilla).
- `abbonamenti` con in piu' `grazia`, `mrrPrima`, `eventiPrima` (stessa finestra subito prima, null se non c'e' intera),
  `serie: [{giorno, attivi, prove}]` (7 o 30 giorni fino a `abbFinoA`; per l'anno tutti i giorni che Apple tiene),
  `perApp: [{chiave, nome, attivi, prove, mrr}]` (12, senza filtro).
- `scheda: {finoA, giorni, imp, vis, dl, impPrima, visPrima, dlPrima, haPrima, fonti: [{fonte, imp, vis, dl}],
  perApp: [{chiave, nome, imp, vis, dl}]}|null`: la finestra di `finestraScheda` del Mac (7 o 30 giorni fino a
  `schedaFinoA`, 30 per l'anno), fonti a zero escluse.
- `buchi[]` (fino a 50) con in piu' `chiave`, `tipo`, `fonte`, `soglia?`, `verifica?: {versione, giorno, prima, dopo,
  giorniDopo, esito}`, `compito?`: solo se il buco ha un progetto; e' il `compito` della regola o, se la regola non ne
  ha uno, il buco in chiaro («Nell'app X: titolo. perche' Cosa fare: ...»), sempre su una riga. `perche` e `cosa`
  fino a 600 caratteri.
- `risolti: [{id, chiave, app, titolo, quando, daQuando, prima?, dopo?}]` (20), `ignorati: [{id, chiave, app, titolo,
  quando, daQuando, motivo?}]` (30), `allarmi` fino a 10 con `chiave`, `paesi: [{codice, euro, impressioni}]` (12,
  solo senza filtro: sono di tutte le app).
- `dettaglio`: null, salvo con `app=<chiave>` (`ios:<id>`, `android:<pacchetto>`, `admob:<id>`; 404 se non c'e'):
  `{chiave, nome, piattaforma, progetto?, path?, bundleId?, approvazione?, collegata?, suAdmob, formati: [{formato,
  richieste, abbinate, impressioni, clic, euro}] (senza quelli a zero), unita: [{nome, formato, richieste,
  impressioni, euro}] (12, per euro), acquisti|null, versioni: [{v, quando}] (8, la piu' recente in testa),
  versioniMesi, codice: {letteAt, file, sdk, ump, att, attRichiesta, skan, storekit, revenuecat, formati,
  idProva}|null}`. Con `app=` cifre, grafico, buchi, abbonati e scheda sono solo di quell'app.

**`POST /v1/stanza/azione {stanza: 'appstore', azione, id?, motivo?, compito?}`** -> `{ok, azione, messaggio, id?,
lavoro?, stato?, progetto?}`. Dietro il gettone come le altre (`src/ponte.ts` la gira a `RotteStanze.azione` dopo il
controllo), solo POST (405), corpo al massimo 16 KB. Un'altra `stanza` prende 400. Elenco chiuso `AZIONI_APPSTORE`;
ogni altra azione 400 con l'elenco. Push, pubblicazioni e invii in revisione non ci sono e non ci saranno.

- `verifica`: «Verifica di nuovo», rilegge AdMob e App Store Connect adesso (`appstore.refresh` della plancia). Se
  sta gia' rileggendo risponde ok e non rilancia.
- `ignora {id, motivo}`: `appstore.ignora` della plancia (motivo su una riga, 300 caratteri). 404 se il buco non c'e'.
- `ripristina {id}`: `appstore.ripristina`; 404 se l'id non e' tra gli ignorati.
- `lavoro {id, compito?}`: «Fallo sistemare a Claude». Il progetto viene SEMPRE dal buco (`projectPath`, che deve
  essere un progetto della Bottega), mai dalla richiesta; 409 senza progetto. Il compito e' quello scritto (o
  corretto) sull'iPhone, ripulito su una riga senza caratteri di controllo (3000 al massimo), o quello del buco; in
  fondo il Mac aggiunge sempre `CODA_COMPITO` («Questo lavoro parte dall'iPhone: non fare git push, non pubblicare e
  non mandare niente in revisione. Quello lo decide Andrea dal Mac.»). Parte come `lavoro_nuovo` di Melissa
  (`AssistantDeps.actions.startJob`: in coda se non c'e' posto). Lo stesso buco non riparte per 2 minuti (409:
  doppio tocco). 503 se i lavori non sono pronti.
- 503 se la stanza App Store non e' pronta o la Bottega non ha registrato le azioni.

Gestori: `StanzeDeps.azioni` (`AzioniAppStore`), passati da `src/ponte-host.ts` a `handleAppStore` di
`src/appstore-host.ts` (gli stessi messaggi della plancia, nessuna logica duplicata) e a `startJob`. Niente di quello
che passa (compiti, motivi) finisce nel registro del ponte. Provato da `test/ponte-stanze.cjs` (gettone, solo POST,
elenco chiuso, progetto dal buco, divieto di push in coda, doppio tocco) con un gestore finto.

**App** (`ios/Bottega/Stanze/AppStore/`): `ModelliAppStore.swift` (le forme, solo Foundation; `StanzaAppStore` non
sta piu' in `ModelliStanze.swift`), `CalcoliAppStore.swift` (frasi e conti del Mac: la frase in testa, la verifica
dopo una versione, la tendenza cumulata, riempimento, mostrati, ogni mille), `GraficiAppStore.swift` (Swift Charts:
guadagni impilati AdMob e Store con le versioni come `RuleMark` tratteggiati, download, tendenza contro il periodo
prima, confronto tra le app a barre orizzontali, abbonati nel tempo, barre per paesi e fonti; tocco o trascinamento
con `chartXSelection` mostrano il giorno), `SezioniAppStore.swift`, `BuchiAppStore.swift` (le azioni,
`PonteStanze.azione`), `SchedaAppView.swift` (la scheda di un'app: `NavigationLink` dalla stanza). Ogni buco dice
cosa fare, quanto vale, da quanto c'e' e la verifica; «Fallo sistemare a Claude» mostra il compito in un foglio da
correggere e parte solo con «Avvia». Le azioni sono accese solo se l'ultima lettura e' arrivata dal Mac; con il Mac
spento restano spente con «Serve il Mac acceso, con la Bottega aperta.» Le schede delle app finiscono nella stessa
copia su disco della stanza (la chiave contiene `app=`): con il Mac spento si vede l'ultima scheda vista, con l'eta'.
Un allarme si riconosce da ora, app e testo insieme: gli allarmi di uno stesso controllo hanno la stessa ora.


### 9.8 Il cervello di Melissa sull'iPhone (`src/ponte.ts`, `ios/Bottega/Viste/CervelloView.swift`)

Sull'iPhone, sotto la sfera, il nome del cervello che Melissa sta usando, piccolo: «Agnes», «DeepSeek», «DeepSeek V4
Pro» (DeepSeek con impegno profondo), «Apple Intelligence». Viene da `melissa.scelta` dello stato, quindi si aggiorna
con gli eventi anche quando si cambia dal Mac o a voce. Un tocco sul nome, o un tocco lungo sulla sfera (o l'azione di
accessibilita' «Scegli il cervello»), apre il selettore: i cervelli che il Mac dice, con la nota («gratis», «a consumo, a
fondo V4 Pro», «gratis, sul Mac») e, se non disponibili, il perche' («senza credito», «il Nucleo non è acceso»); «Per
questa conversazione» o «Sempre»; l'impegno (rapido, normale, profondo, come nella barra: resta finche' non lo cambi).
Cambiare «Per questa conversazione»/«Sempre» vale anche per il cervello di adesso se non e' Agnes. Con il Mac spento
il selettore locale offre Agnes e DeepSeek, con l'impegno; la scelta viene applicata come predefinita anche al Mac
quando torna in linea. Apple Intelligence del Mac non e' disponibile in questa modalita'. Lo stato di una Bottega
vecchia senza `scelta` si legge ancora (il nome non compare).

- `GET /v1/stato` -> `melissa.scelta?: {provider, nome, impegno, predefinito, perOra}` (`sceltaDi`, senza rete).
- `GET /v1/cervelli` -> `PonteCervelli`: `{provider, nome, impegno, predefinito, perOra, opzioni: [{provider, nome, nota,
  disponibile, perche?}]}` (da `Cervelli.state()`, che va in rete solo con le cache vecchie, come la barra).
- `POST /v1/cervello {provider?, impegno?, sempre?}` -> `PonteCervelli`. Dopo il gettone. Elenco chiuso: `provider` in
  agnes, deepseek, apple; `impegno` in rapido, normale, profondo; `sempre` booleano; almeno uno tra provider e impegno,
  altrimenti 400 con la frase. Un cervello non disponibile -> 409 con la frase di `Cervelli.set` («Apple Intelligence
  adesso non è disponibile: il Nucleo non è acceso.»). Passa da `rotteCervelli` (ponte.ts), che chiama gli stessi
  `Cervelli.setEffort` e `Cervelli.set(provider, undefined, sempre)` della barra. 405 con il metodo sbagliato.
  Dopo il cambio il ponte manda subito uno stato sugli eventi.

### 9.9 Vicino o lontano: il cavo e la casa (`nucleo/Sources/Ponte/CavoIPhone.swift`, `src/ponte.ts`, `src/avvisi.ts`)

La strada resta una sola, Tailscale, vicino o lontano: cambia il comportamento, non il collegamento. Il cavo e la
rete di casa dicono al Mac dov'e' l'iPhone, non portano dati.

- Nucleo: `usb.iphone {}` -> `{collegato}` ed evento `usb.iphone {collegato}` quando cambia (anche una volta
  all'avvio del servizio). IOKit: `IOServiceAddMatchingNotification` su `IOUSBHostDevice`, comparsa e
  scomparsa, sul run loop principale; nessun timer, 0% di CPU da fermo. Un iPhone = `idVendor` 0x05AC e
  «USB Product Name» che comincia per «iPhone» (marca e nome si guardano nel codice: un filtro su `idVendor` nel
  dizionario di IOKit non trova niente su `IOUSBHostDevice`, misurato il 3/10/2026). Qualunque iPhone, non solo
  quello collegato al ponte: il Mac e' di Andrea. Gli iPhone si contano per `registryID`, perche' alla scomparsa
  le proprieta' non si leggono piu'.
- Estensione (`src/ponte-host.ts`): ascolta `usb.iphone`, rilegge con il comando quando il Nucleo si riaccende
  (`available`), un Nucleo giu' (`down`) vale come cavo staccato. Un cambio manda subito uno stato agli eventi e
  riguarda gli avvisi.
- Casa (`direttiInCasa`, dentro lo stesso `tailscale status --json` che il ponte legge ogni minuto): gli indirizzi
  Tailscale dei peer iOS in linea con `CurAddr` su un indirizzo privato (10/8, 172.16/12, 192.168/16), cioe'
  raggiunti «direct» nella rete del Mac. Da fuori casa il percorso passa da un indirizzo pubblico o da un relay.
  L'iPhone e' l'indirizzo dell'ultima richiesta col gettone giusto (non 127.0.0.1); prima della sua prima
  richiesta basta un iPhone in casa. Il passaggio casa/lontano si vede entro un minuto.
- `GET /v1/stato` (e gli eventi) -> `vicino: usb | casa | lontano` (`vicinoDi`): il cavo vince, poi la casa.
- Avvisi (9.4): con `vicino` = usb l'iPhone sta sulla scrivania e si fa come con Andrea al Mac: niente ATTESA,
  FINITO, REGOLA (si considerano viste), la CONFERMA aspetta. Casa non cambia niente: in casa ma lontano dalla
  tastiera le notifiche servono. Live Activity e widget restano come sono.
- App: «Vicino via cavo, ponte Tailscale» / «Collegato in casa» nella riga sotto il nome del Mac. Col cavo, l'app davanti e il
  ponte collegato lo schermo resta acceso (`isIdleTimerDisabled`), e torna normale appena una delle tre cose manca.
- Voce: risponde il dispositivo a cui hai parlato, vicino o lontano (scelta di Andrea del 3/10/2026). Il cavo non
  sposta la voce.
- Da decidere, solo descritto: il cavo anche come canale (`usbmuxd`, come Xcode), per quando Wi-Fi o Tailscale non
  ci sono. Solo il Mac puo' aprire la connessione verso l'iPhone, quindi servirebbe un tunnel nel Nucleo e un
  ascolto nell'app, con l'app davanti.

### 9.10 Melissa autonoma sull'iPhone

- Alla prima risposta del Mac con HTTPS, `Ponte` importa `/v1/assistente/config` se manca una configurazione locale.
  Dalle Impostazioni si puo' ripetere l'importazione dopo il cambio di una chiave. Il portachiavi usa
  `AfterFirstUnlockThisDeviceOnly`, gruppo della sola app, senza backup su altri dispositivi. Scollegare l'iPhone
  cancella chiavi e storia locale; collegarlo a un altro Mac le cancella prima dell'importazione nuova.
- Quando una chiave LLM e' importata, `AssistenteTelefono` chiama direttamente Agnes (`agnes-3.0-flash`) o DeepSeek
  (`deepseek-flash`, oppure `deepseek-v4-pro` con impegno profondo) via Chat Completions SSE anche con il Mac
  collegato. Il Mac invia a `/v1/stato` il registro delle attivita' osservate; l'app passa al modello diretto uno
  snapshot breve con fonte, stato, progetto, titolo, riassunto e ora, trattato come dati non come istruzioni. Se il
  ponte cade, Melissa e Siri usano l'ultimo snapshot salvato, dichiarandone l'ora e che gli stati possono essere cambiati;
  non lo presentano come live. Lavori e il riepilogo nella testata mostrano lo stesso registro salvato, con la data.
  Il registro viene cancellato quando si scollega o si abbina un altro Mac. La storia privata sull'iPhone contiene al
  massimo 80 turni e conserva 16 turni nel contesto del modello. Non si inviano strumenti del Mac.
- Con la voce accesa, `VoceTelefono` apre direttamente il WebSocket ElevenLabs Text to Dialogue con
  `eleven_v4_turbo`, la stessa `voiceID` e `pcm_24000` del Nucleo. Le frasi arrivano a `FlussoVoce` mentre il modello
  scrive. Dopo `close_socket`, solo `is_final` conferma che tutto il PCM del racconto e' arrivato:
  `is_final_audio_for_turn` puo' riferirsi a una frase precedente e non interrompe mai la ricezione.
  L'attesa finale scade dopo 20 secondi senza PCM, rinnovati a ogni frammento, non dopo 20 secondi di racconto.
  Un errore durante l'invio della chiusura viene propagato anche se arriva prima dell'attesa; tutti i percorsi
  di uscita cancellano socket e timer. Test di regressione: `ios/Tests/VoceTelefonoTests.swift`, eseguibili
  senza rete o dispositivo con `scripts/test-ios-voice.sh`. La prova del servizio reale e' separata e opt-in
  (`BOTTEGA_TEST_REALE=1`, chiave e voce nell'ambiente): confronta il PCM di un'introduzione con quello di un
  racconto di piu' frasi, includendo l'audio che arriva dopo la richiesta di chiusura.
  Un tocco cancella la richiesta e il socket. Se ElevenLabs non manda audio, l'app mostra un errore chiaro;
  non sostituisce silenziosamente la voce di Melissa nella modalita' autonoma.
- «Racconta» nelle Stanze, nei Lavori e nella scheda di una sessione legge la copia dei dati gia' visibili, con i filtri attivi
  sull'iPhone. La narrazione a voce parte da `deepseek-flash` senza ragionamento lungo; se DeepSeek non risponde prima del testo,
  prova Agnes. Le frasi SSE vanno subito a ElevenLabs e il PCM alla sfera, con il testo visibile durante il racconto.
  Un secondo tocco ferma la richiesta e l'audio. Il racconto non entra nella storia della conversazione.
- I turni locali hanno UUID e sono salvati in Application Support con protezione dati. Con il Mac collegato, l'app
  li sincronizza subito in blocchi di sei a `/v1/assistente/storia`; se manca la rete li invia al ritorno della
  connessione. Una scelta locale di cervello o impegno viene applicata al Mac come scelta «sempre». Siri usa lo
  stesso percorso diretto per il testo; la voce letta da Siri segue il sistema, mentre nell'app e' ElevenLabs.
- Personaggi (dalla build 121, `ios/Bottega/Voce/Personaggi.swift`): Darlene, Elliot e Krista di Mr. Robot. Dalla build
  125 stanno in un file per personaggio, `extensions/bottega-home/personaggi/<chiave>.json` (campi in
  `personaggi/LEGGIMI.md`): carattere, saluti, voce ElevenLabs, ruolo, `parole` che lo fanno entrare. E' la fonte unica:
  l'estensione li porta con se' e all'avvio li copia in `~/.bottega/personaggi/` (solo i file cambiati), da dove li legge
  la mod melissa (dalla 0.14, al piu' una volta al minuto; senza cartella Melissa parla da sola); l'app iPhone li include
  nella build (`project.yml`, cartella `personaggi`). Un personaggio nuovo e' un file nuovo: poi `scripts/package.sh`,
  la build iPhone e `/reload-plugins`. Nomi, chiavi e scelta di chi entra si leggono dai file.
  «Passami Darlene», «fammi parlare con Krista» passano la chiamata: saluta il personaggio con la sua voce e
  risponde lui finche' Andrea non dice «ridammi Melissa» o la conversazione si chiude. Con Melissa al telefono,
  «chiedi a Elliot», «sentiamo Darlene» (capiti da `ChiVuole`) la fanno dirigere, poi risponde lui; a voce e in conversazione lo puo' fare anche
  da sola, non piu' di una volta ogni tre risposte. Chi puo' tirare dentro da sola lo sceglie il codice
  (`Personaggi.adatto`, dalla build 122): Elliot se Andrea parla di sicurezza, Krista se rimanda o cerca scuse,
  altrimenti uno diverso dall'ultimo; al prompt arriva solo quel nome. Lasciato al
  modello sceglieva sempre Darlene. Dalla build 123, dopo quattro risposte senza ospiti l'invito diventa deciso
  («Stavolta tira dentro ...») e il personaggio sa per cosa e' stato chiamato. Ruoli, scelta e testo dell'invito
  sono gli stessi della barra (`ospiteDellaFrase`, `invito`). Chi e' chiamato lo dice lo strumento `passa_parola` (9.11): il personaggio risponde
  con la sua voce, poi Melissa chiude. Ogni battuta apre il suo socket ElevenLabs con la voce di chi parla. Il
  personaggio usa lo stesso cervello (Agnes o DeepSeek), senza lo snapshot del Mac. Nella storia locale `chi` e' la
  chiave del personaggio; verso il Mac e nella vista diventa `melissa` con il nome davanti («Darlene: ...»), cosi'
  `/v1/assistente/storia` resta `tu|melissa`. Test senza simulatore: `scripts/test-ios-personaggi.sh`. Dalla build 135
risponde chi riceve la parola con `passa_parola`, o l'invitato di un invito deciso (9.11); prima (build 124-134) si
cercava il nome nel testo.

### 9.11 Chi risponde quando Melissa chiama, e cosa si dice mentre si pensa (build 126, mod 0.15)

Regole scritte due volte: sul Mac nella barra (`src/personaggi.ts`, `src/riempitivi.ts`, `src/assistant.ts`,
`src/regia-personaggi.ts`) e sull'iPhone (`Voce/Personaggi.swift`, `Voce/Riempitivi.swift`, `Voce/AssistenteTelefono.swift`,
`Voce/Melissa.swift`), che deve funzionare a Mac spento. La mod melissa non ha piu' regole sue: le chiede alla barra.

**Sul Mac la regia sta in un posto solo (build 136, mod 0.19).** La mod melissa di Claude Code non decide piu' chi parla,
quando, con che voce e con che prompt: lo chiede alla barra con `POST /v1/regia` sul socket Unix
`~/.bottega/regia.sock` (`src/regia-personaggi-host.ts`; cartella 700, socket 600, nessun gettone: lo stesso modo con cui
la mod parla al Nucleo su `isola.sock`, e funziona anche a Tailscale spento, quando il ponte verso l'iPhone e' chiuso).
Ogni richiesta porta `{azione, sessione}` (`sessione`: l'id della sessione Claude Code; la barra tiene per sessione
contatore, ultimo ospite, ospiti recenti, pausa della cronaca e ultimo `umore`, e dimentica una sessione ferma da sei
ore). Le risposte con un ospite lo danno pronto (`OspiteRegia`): `{chiave, nome, voce, sistema, istruzione, offerte,
strumento, deciso}`; la mod aggiunge al `sistema` ora, cartella, memoria e ricordi, e mette `istruzione` in fondo al
messaggio dell'utente, dopo la chiacchierata.

| `azione` | Cosa manda la mod | Cosa risponde la barra |
|---|---|---|
| `frase` | `frase`, `chi` (chi ha la chiamata), `prima` (prima frase della conversazione) | `{passa}` se c'e' il nome esatto dopo "passami" (`chiChiede`); altrimenti `{invito, offerte, strumento, deciso}` per la risposta di Melissa (lo strumento sempre, l'invito quando c'e' uno scelto). Subito, senza modello |
| `chivuole` | `frase`, `chi` | `chiVuole` della barra (DeepSeek Flash, al piu' 2,5 s): `{riga, passa, chiede, regia, voci: OspiteRegia[], chiude, somme, ospite}`; `regia` e' l'istruzione della battuta di Melissa al posto della risposta, `voci` i prompt del giro a piu' voci, `somme` quella delle somme, `ospite` chi risponde al parere chiesto |
| `parola` | `da` (chi ha appena parlato), `argomenti` della sua chiamata a `passa_parola`, `offerte`, `deciso`, `conStrumento`, `ultima`, `cronaca`, `poi` | `{chi, ospite}`: chi risponde (quello della chiamata, o senza la chiamata il `deciso`, mai se il cervello non aveva lo strumento) e il suo prompt; dopo un personaggio chi risponde non passa piu' la parola. Nella chiacchierata il 40% dei passaggi fra ospiti lo decide qui |
| `chiusa` | `dopo` (l'ospite) | `{istruzione}` della chiusa di Melissa, senza domande e senza strumento |
| `cronaca` | `appunti`, `silenzioMs`, `erroriDiFila`, `finale` (riassunto di fine turno), `richiesta`, `battute` (dette nel turno) | `{occasione: {tipo, chi, fatto, poi}, freno, riga, invito, offerte, strumento, deciso}`: `occasione()` e `frenoOspite()` della barra, piu' le prime due battute del turno come freno; lo strumento solo quando un fatto passa i freni (nella cronaca Melissa parla ogni 7-10 s) |

Tempi: 800 ms per le azioni senza modello, 3,2 s per `chivuole`. Bottega chiusa, socket assente o risposta in ritardo:
la mod fa parlare solo Melissa, niente ospiti e niente passaggi di chiamata, e lo scrive una volta nel registro (`regia:
la Bottega non risponde (...), parla solo Melissa`; al ritorno `regia: la Bottega risponde`). Nessuna copia di riserva
delle regole nella mod: via `chiamata`, `chiamatoPerNome`, `ospiteChiesto`, `chiChiede`, `ospiteDellaFrase`,
`invitoConversa`, `campoDi`, `occasione`, `frenata`, `invitoCronaca`, `chiVuole`, `giroDiVoci`, `istruzioneGiro`, `regia`.
La mod resta padrona di ascolto, voce, riempitivi, memoria e narrazione. Nel registro della barra (canale Melissa):
`regia per la mod, chi vuole: ...` e `regia per la mod: <Nome> da' la parola a <chiave>`.

**Chi e' chi (build 136).** Ogni prompt di un ospite, nella barra, nella mod (tramite la regia) e sull'iPhone, porta
`CHI_E_CHI` (`Personaggi.chiEChi`): Andrea e' la persona che ascolta; Claude (Claude Code) e' l'assistente che lavora nel
terminale, e file, comandi, errori e risposte del terminale sono suoi, non di Andrea; Melissa e' l'assistente a voce che
passa la parola, e chi le risponde la chiama Melissa, non Andrea. L'istruzione di chi risponde a Melissa dice
"Rispondi alla domanda di Melissa, rivolto a lei (se dici un nome e' Melissa), mentre Andrea ascolta". Prima (6
ottobre) Elliot chiamava Claude «Andrea» e, rispondendo a Melissa, diceva «Andrea».

**Chi parla lo decide il modello, con uno strumento (build 135; sostituisce segnale `@chiave`, `chiamatoPerNome` e la
tabella dei vocativi delle build 124-134).** Nessun nome si cerca piu' nel testo detto. Chi risponde dopo una battuta
lo dice la chiamata allo strumento `passa_parola`, che arriva strutturata (Chat Completions, `tool_calls`) e non finisce
mai nella voce:

```json
{"type": "function", "function": {"name": "passa_parola",
  "description": "Da' la parola a uno dei personaggi: risponde con la sua voce subito dopo la tua battuta. Senza questa chiamata nessuno risponde, anche se lo nomini.",
  "parameters": {"type": "object", "properties": {
    "a": {"type": "string", "enum": ["<chiavi di chi puo' rispondere adesso>"], "description": "la chiave di chi deve rispondere"},
    "perche": {"type": "string", "description": "per cosa lo chiami, in poche parole"}},
   "required": ["a"]}}}
```

- **Chi ce l'ha.** La risposta di Melissa quando parla a voce (chiacchierata, tasto) o legge in «racconta»: `enum` =
  i personaggi con una voce (`strumentoPassaParola`, sull'iPhone `Personaggi.strumentoPassaParola`), insieme agli altri
  strumenti. L'ospite del giro a tre quando puo' passare la parola (non il secondo di un giro): `enum` = gli altri con
  voce, mai se stesso ne' chi l'ha chiamato. La chiusa di Melissa dopo un ospite no (dalla build 136: la parola torna
  ad Andrea). Un personaggio con la chiamata no.
- **Lettura.** `passaParolaA(argomenti, offerte)`: la chiave di `a` (con la maiuscola vale lo stesso) se e' fra quelle
  offerte, altrimenti nessuno; JSON rotto, nessuno. Registro: `passa la parola: <chiave>` (o `niente, argomenti non
  validi`).
- **In streaming, senza ritardi.** Il testo arriva prima e va subito alla voce; la chiamata arriva in fondo. Se nella
  risposta c'e' solo `passa_parola`, il giro del modello si chiude li': nessun passo in piu' (la battuta e' gia'
  detta). Con altri strumenti insieme, quelli si eseguono e `passa_parola` riceve come risultato «Fatto: <Nome>
  risponde dopo la tua battuta.». Solo la chiamata, senza testo: Melissa non dice niente e risponde chi ha la parola.
- **Come si chiede.** L'invito dice battuta e chiamata insieme (`chiamaCon`, uguale sull'iPhone): «Nella stessa risposta
  fai due cose: scrivi la tua battuta, che chiude con una domanda rivolta a <Nome>, e chiama lo strumento passa_parola con
  a = <chiave>. Il testo da solo non basta: senza la chiamata <Nome> non sente la domanda.» Misura del 6 ottobre, con il
  solo «chiama lo strumento»: DeepSeek Flash faceva la domanda nel testo e saltava lo strumento; con questa frase lo chiama
  6 volte su 6, Agnes 3 su 3, testo prima della chiamata.
- **Invito deciso.** Quando l'invito l'ha deciso il codice («Stavolta tira dentro ...», l'ospite di un fatto in
  «racconta», il 40% in cui un ospite deve passare la parola a un altro), l'invitato risponde anche se il modello si
  dimentica la chiamata (registro: `passa la parola: <chiave>, invito deciso senza la chiamata`). Con l'invito facoltativo
  («Con te c'e' anche ...») risponde solo chi riceve la parola.
- **Cervello senza strumenti.** Apple Foundation Models (scelto, riserva o ripiego): niente strumento, niente invito nel
  prompt, nessuno viene chiamato e Melissa parla da sola, senza errori.
- **Le frasi di Andrea.** Le capisce solo `chiVuole` (qui sotto), anche col tasto fuori dalla conversazione: "chiedi a
  Elliot", "Vabbe' Krista, e tu?" danno `chiede`, e Melissa glielo chiede (regia) prima che risponda. Resta nel codice,
  immediato, solo il comando col nome esatto dopo "passami", "fammi parlare con", "ridammi" (`chiChiede`). Via
  `ospiteChiesto` e il ramo "anche Andrea puo' chiamare" per vocativo.

Risponde solo un personaggio con una voce. Dopo la chiusa di Melissa la parola torna ad Andrea.

**Chi entra da solo nella chiacchierata.** Un ospite puo' entrare dopo ogni risposta di Melissa senza ospite, anche
nella prima di una conversazione (il contatore parte da 1); mai nella risposta subito dopo un ospite, e in quella dopo
ancora non entra nessuno se Andrea tocca di nuovo l'argomento dell'ospite di prima. L'invito e' deciso dopo due
risposte senza ospite, o subito se entra quello le cui `parole` Andrea ha appena detto (Elliot sulla password). Risposte in due o tre frasi brevi, e al piu' quattro dette
(le prime tre e l'ultima, `breve`); il prompt porta data e ora, che altrimenti il modello inventa. Nella cronaca vale la stessa regola: non serve piu' che fosse quello
scelto in anticipo (prima della mod 0.15 una domanda spontanea a Elliot restava senza risposta, 6/10/2026). Melissa
non parla finche' il personaggio non ha detto la sua battuta, nemmeno se intanto Claude comincia un turno nuovo.

| Battuta di Melissa | Chi risponde |
|---|---|
| `Elliot, tu che dici?` / `Che ne pensi, Krista?` / `Allora, Darlene?` / `Elliot... tu che dici?` | elliot / krista / darlene / elliot |
| `Dai Krista, diglielo tu.` / `E tu Krista che ne dici?` / `Tocca a te, Krista.` | krista |
| `Krista, che ne pensi? Io dico di si'.` / `Ehi Darlene ascolta questa.` | krista / darlene |
| `Ok Elliot, ma tu cosa faresti?` | elliot |
| `Ti ricordi quando Elliot ha bucato E Corp?` / `Vuoi che apra il file di Krista?` | nessuno |
| `Krista direbbe che sei pigro.` / `Darlene, al posto tuo, avrebbe gia' litigato.` | nessuno |
| `Darlene ti ha mai detto di no? Comunque e' finita.` / `Non so. Tu che dici?` | nessuno |
| `Krista te lo sta dicendo da mezz'ora e tu fai lo gnorri.` (`te` dopo il nome non chiama) | nessuno |
| `Sono sicura che Krista avrebbe qualcosa da dirti.` con `invitato = krista` | krista |

**Parlano fra loro (mod 0.16, build 126; dalla build 135 con passa_parola).** Un personaggio chiamato, nel 40% dei casi
e se c'e' un altro personaggio con voce, riceve nel prompt "Poi chiedi a <Nome> cosa ne pensa." piu' `chiamaCon` (scelto
a caso fra gli altri, mai chi lo ha chiamato); quello risponde una volta (invito deciso, anche senza la chiamata) ("<Nome> ti ha appena chiesto qualcosa"), poi Melissa chiude con tutto il giro davanti. Gli ospiti
entrano dopo ogni risposta di Melissa senza ospite; l'invito e' deciso dopo due, o subito per argomento.

**La cronaca automatica non si ferma fra un turno e l'altro (mod 0.18.3, Andrea, 6 ottobre).** Con la cronaca
accesa: (1) a ogni prompt di Andrea Melissa lo dice subito in una frase breve, sua ("Andrea chiede a Claude di ...",
riassunto, mai letto parola per parola se lungo, passato da `censura`) e riparte a raccontare; (2) racconta anche gli
agenti: le azioni dei sotto-agenti (`tool.call` con `agentId`) entrano negli appunti come "un agente <cosa fa>", con il
`description` dell'agente quando c'e', e l'avvio e la fine di un agente sono fatti da raccontare; (3) a fine turno, dopo
il riassunto, se ci sono agenti che lavorano ancora (in background) la cronaca continua con lo stesso passo, e si
ferma solo dopo 60 s senza nessuna azione di nessuno; (4) chiusa la chiacchierata, se Claude o un agente lavorano, la
cronaca riprende da sola. Registro: `cronaca: continua per gli agenti` e `cronaca: ferma, nessuno lavora da 60 s`.

**Ospiti dai fatti (build 134, mod 0.18; sostituisce le regole a tempo e a caso delle build 126-133).** Nella cronaca
della mod, nelle letture di «racconta» della barra e nel riassunto di fine turno un personaggio entra solo se c'e' un
**fatto** che lo chiama, mai per orologio o per sorte: via `OSPITE_VIVO_MS` (i 2 minuti) e `OSPITE_RACCONTO = 0.5`.
La funzione e' una sola, uguale nei tre posti: `occasione(appunti, stato) -> {tipo, chi} | null`, con questi tipi, in
quest'ordine di precedenza (vince il primo che c'e'):

1. `sicurezza`: gli appunti contengono le `parole_cronaca` di un personaggio (ripulite: niente "firma", "token",
   "certificat", "permess", che scattavano a ogni build). Va a quel personaggio.
2. `errore`: azioni fallite di fila (`Non e' andata`, contate dall'ultima andata a buon fine) >= `errori_ripetuti` di
   un personaggio che ha `errore` fra le `occasioni`.
3. `rischio`: un'azione che corrisponde a
   `RISCHIO = /rm -rf|--force|\bpush\b.*(-f\b|--force)|reset --hard|\bsudo\b|drop (table|database)|--prod\b|\bdeploy\b/i`.
4. `scelta`: Claude chiede qualcosa ad Andrea (una sua frase finisce con `?` e contiene
   `vuoi|preferisci|devo|procedo|confermi|scegli|quale|ti va`).
5. `fine`: il riassunto di fine turno, o la fine di una lettura di «racconta».
6. `umore`: riguarda Andrea, non il codice. La sua richiesta del turno (o, in chiacchierata, cio' che ha appena detto)
   contiene le `parole` di un personaggio con `umore` oppure uno sfogo (`intento` = `sfogo`), oppure e' notte fonda
   (ora locale >= 23 o < 6). Al massimo una volta ogni 20 minuti. Va prima di `attesa`.
7. `attesa`: nessun appunto nuovo da almeno `ATTESA_MS = 25 s` (Claude lavora in silenzio). Solo qui due personaggi
   si parlano anche nella cronaca: il primo risponde a Melissa e chiude chiedendo per nome a un secondo (uno con
   `attesa` o, se non c'e', un altro qualsiasi diverso), il secondo risponde, poi Melissa riprende. Al massimo due
   ospiti per attesa.

Chi entra: fra i personaggi che hanno quel `tipo` nelle `occasioni` (per `sicurezza` quello delle parole), a turno:
prima chi non e' ancora entrato, poi chi e' entrato da piu' tempo, a parita' l'`ordine` piu' basso (con il solo "diverso
dall'ultimo" se ne alternavano sempre due su tre). `rischio` guarda solo le azioni di Claude, non la sua prosa; gli
appunti non portano mai la riga di comando intera (puo' contenere un token), quindi chi annota un comando ci aggiunge
solo i pezzi a rischio o sensibili ("Claude lancia rm -rf"). **Chi vuole sentire Andrea: microfono di Apple e modello, non elenchi (build 134, mod 0.18.3).** Esempio del 6
ottobre: "Passami Cristal Vista" e "Passami la nostra amica psicologa" non passavano niente. Due rimedi, niente elenchi di
nomi storpiati:
1. **Il microfono li scrive giusti.** Ogni riconoscimento Apple (`SFSpeechAudioBufferRecognitionRequest`, Nucleo in
   `AppleSTT.swift` e iPhone in `Ascolto.swift`) riceve `contextualStrings` con i `nome` dei personaggi caricati, piu'
   "Melissa", "Claude", "Claude Code" e "Bottega": Apple li preferisce quando il suono ci somiglia.
2. **Il modello capisce chi.** A ogni frase di Andrea in chiacchierata, in parallelo con la risposta, parte una richiesta breve
   sempre a **DeepSeek Flash** (`deepseek-flash` su `https://api.deepseek.com/chat/completions`, l'ultimo Flash
   dell'account, che ha credito; mai Agnes, regola di Andrea del 6 ottobre), in tutti e tre i posti: `chiVuole(frase, personaggi) -> {passa: chiave|"melissa"|null,
   chiede: chiave[], tutti: boolean}` (un `chiede` scritto come stringa vale come elenco di uno). Il prompt elenca chiave, nome e `ruolo` di ognuno e spiega: `passa` quando Andrea vuole
   parlare con lui da ora in poi ("passami...", "fammi parlare con...", "la psicologa", un nome capito male che
   somiglia), `chiede` quando vuole solo il suo parere adesso ("chiedi a...", "e tu...?"); risposta solo JSON,
   `max_tokens` 40, temperatura 0, attesa massima 2,5 s (oltre, o senza chiave DeepSeek: come null, e nessuna
   richiesta ad altri cervelli). Il testo del prompt e' uno solo, parola per parola, nel messaggio di sistema
   (`promptChiVuole` in `register.tsx` e `src/personaggi.ts`, `ChiVuole.prompt` in `Personaggi.swift`); la frase di
   Andrea va da sola nel messaggio dell'utente; una chiave scritta con la maiuscola vale la stessa chiave. Con `passa`
   la chiamata passa nel codice, subito, come prima; con `chiede` quel personaggio e' l'invitato del giro, e risponde
   anche se Melissa non lo nomina (il parere chiesto da Andrea non resta nel vuoto). **Giro a piu' voci**: con `tutti` (Andrea vuole sentirli
   tutti: "fammi sentire tutti", "parla con gli altri", "passami Elliot e gli altri") o con piu' di un `chiede`,
   rispondono uno dopo l'altro tutti i personaggi (o quelli chiesti), una battuta ciascuno, ognuno dal suo campo e
   sapendo cosa hanno detto quelli prima; la battuta del successivo si pensa mentre suona la precedente; poi Melissa
   chiude. `passa` insieme a `tutti`: la chiamata passa a quello e gli altri rispondono in questo giro. Esempi veri del
   6 ottobre che il prompt deve far capire: "No dicevo Eliot Elliot passami Elliot e gli altri personaggi passami
   qualcuno fammi sentire tutte... siamo io te e altri" = passa elliot, tutti; "Melissa c'e' la psicologa se mi fumo
   una canna, parla con gli altri" = chiede [krista], tutti. **Melissa coordina, non rifiuta** (Andrea, 6 ottobre: "dice che
   non ha voglia di fare da centralino"): quando `chiVuole` da' `passa`, `chiede` o `tutti`, la battuta di Melissa non
   e' quella pensata prima (che puo' essere un rifiuto) ma una breve regia nel suo stile, pensata con un prompt che
   le dice cosa sta succedendo: passa la parola ("Ok, ti passo Krista."), apre il brainstorming ("Sentiamo tutti:
   Elliot, comincia tu.") o chiede il parere. Nel carattere di Melissa, in tutti i posti: quando Andrea chiede un
   personaggio o un parere di gruppo lo fa sempre, puo' punzecchiare ma non si rifiuta mai, e non dice mai che non le
   va di fare da tramite; nel brainstorming tiene le fila e alla fine tira le somme in una o due frasi. Il nome detto esatto ("passami Krista")
   resta la via immediata nel codice, senza aspettare il modello. Niente campo `nomi_sentiti` nei JSON. Registro:
   `chi vuole: passa <chiave>|chiede <chiavi>|tutti|nessuno (<ms> ms)`, le parti presenti unite da una virgola ("passa
   elliot, tutti", "chiede krista darlene"; `rigaChiVuole`, sull'iPhone `ChiVuole.riga`). Il giro e la regia sono
   funzioni uguali nei tre posti: `giroDiVoci(v, conVoce, conLaChiamata) -> {voci, chiude}`, `istruzioneGiro(chi,
   primo)`, `regia({passa, chiede, voci})`. Se il modello risponde quando la risposta della barra ha gia' cominciato a
   parlare, niente regia: il giro si fa dopo la risposta, e un `passa` arrivato tardi passa senza giro.

**Tutti presenti, ognuno con la domanda
del suo campo** (Andrea, 6 ottobre: Krista, la psicologa, veniva interrogata sul codice; ma non va esclusa, i suoi
pareri disinteressati servono). Tutti e tre entrano a turno nei fatti che li riguardano (i JSON: Elliot sicurezza,
rischio, errore, scelta, attesa; Darlene rischio, scelta, attesa, fine; Krista umore, errore, scelta, attesa, fine; tutti
`chiacchiera`); per `errore` vale l'`errori_ripetuti` di ciascuno (Elliot 2, Krista 3). Quello che cambia e' la
**domanda**: l'invito dice a Melissa di chiedere all'ospite solo dal suo `ruolo_cronaca`. A Elliot il lato tecnico e la
sicurezza; a Darlene la provocazione, la scorciatoia, il rischio; a Krista il lato umano anche di un fatto tecnico (come
ci sta lavorando Andrea, se conviene fermarsi, come decidere, un parere da fuori), mai dettagli di file, errori o
comandi che non puo' sapere. `umore` sceglie chi ce l'ha (Krista). Restano i freni: mai nelle prime due battute
di un turno di cronaca, mai entro `OSPITE_PAUSA_MS = 60 s` dall'ultimo ospite (per `sicurezza` ed `errore` bastano 30 s:
sono i fatti che contano di piu'). Con un'occasione Melissa riceve l'invito deciso (chiude con la domanda per lui e la
chiamata a `passa_parola`), e nell'invito c'e' il fatto ("Claude ha appena lanciato rm -rf", "terzo errore di fila"),
cosi' la domanda parla di quello. Senza occasione nessun invito. Chi riceve la parola risponde sempre. La
chiacchierata (pulsante Melissa) resta com'e' (risponde chi riceve la parola, al 40% un personaggio passa la parola a un
altro), con i punti sotto su memoria e attese e con un vincolo: quando nessuno e' scelto dalle `parole`, l'ospite (e a
chi si passa la parola) si sceglie fra chi ha `chiacchiera` nelle `occasioni` (oggi tutti e tre); uno sfogo di Andrea
(`intento` = `sfogo`) sceglie chi ha `umore` (Krista), il primo in `ordine`, come le sue `parole`. A ognuno si chiede
dal suo campo, come sopra: l'invito della chiacchierata finisce, nei tre posti, con lo stesso testo (`campoDi`, sull'iPhone
`Personaggi.campo`): "chiedi a <Nome> solo dal suo campo (<ruolo_cronaca>)", e per chi ha `umore` ": il lato umano anche
di un fatto tecnico, mai dettagli di file, errori o comandi che non puo' sapere". Nel registro: `ospite: <chi> per <tipo> (<fatto>)` o, quando un fatto
c'e' ma i freni lo fermano, `ospite: niente, <tipo> fermato da <freno>`.

**Ognuno ha la sua memoria, nella Memoria della Bottega (build 134, mod 0.18.3; sostituisce
`detti-personaggi.json`).** Andrea, 6 ottobre: i personaggi ricordano come la Memoria che usano tutte le sessioni
Claude Code, dal terminale e dalla Bottega.
- **Scrivere.** Ogni battuta generata di un personaggio o di Melissa (chiacchierata, cronaca, interventi, riassunto;
  non saluti fissi, riempitivi, letture lunghe) e ogni frase che Andrea dice in chiacchierata va nello spool della
  Memoria come evento esterno: una riga JSONL in `~/.bottega/memoria/spool/<AAAA-MM-GG>.jsonl` (cartella 700, file
  600), `{ev: "external", source: "personaggio", sid: <chiave>, id: <unico>, cwd, at, text, who: <chiave>|"andrea"}`,
  dove `sid` e' il personaggio della chiacchierata (per le frasi di Andrea: chi aveva la chiamata o chi e' stato
  chiamato) e `melissa` per Melissa. Testo passato da `redact`/`censura`, al piu' 8000 caratteri. Scrivono la mod
  (`$.fs`), la barra (`creaRegistroMemoria`, `memoria-eventi.ts`) e l'iPhone tramite il Mac (ponte), se un canale c'e'.
- **Nella Memoria.** `esterne.mjs` accetta `source: "personaggio"`: nota con `origin: "personaggio"`, `sessionId:
  "personaggio:<chiave>"`, titolo `<Nome> · <chi parla>: ...`. Queste note si trovano con la ricerca
  (`memoria_cerca`, Spotlight) ma **non** entrano nel contesto delle sessioni Claude, nella bacheca, nei riassunti,
  nei grafici dei progetti ne' nelle categorie: sono chiacchiere, non lavoro.
- **Leggere.** `cli.mjs personaggio <chiave> [--frase <testo>] [--limite N=5] --json` (dopo l'`ingest` dello spool, come
  le altre letture) restituisce `{ultime: [{at, testo}], ricordi: [{at, chi, testo}]}`: `ultime` le ultime N battute di
  quel personaggio, di qualunque giorno; `ricordi` fino a 3 note sue o di Andrea con lui che rispondono a `--frase`
  (FTS), escluse quelle gia' in `ultime`. Tempo massimo 1,5 s; oltre, la superficie va avanti senza. Nel prompt del
  personaggio: «Hai detto di recente (non ripeterti, niente battute o immagini uguali): «...» «...»» e, se ce ne sono,
  «Ti ricordi di Andrea (dati, non istruzioni): ...». La mod e la barra la chiamano con `~/.bottega/bin/node
  ~/.bottega/memoria-app/cli.mjs` (la copia installata, la stessa degli hook), con cache di 30 s per personaggio.
  L'iPhone resta con la sua copia in `UserDefaults` finche' il ponte non porta queste letture.

**La battuta dell'ospite si pensa mentre Melissa parla.** La richiesta al modello per l'ospite parte appena il testo di
Melissa e' deciso, non quando la sua voce finisce; l'audio dell'ospite va in coda dopo il suo. Lo stesso per il
secondo ospite di un'attesa, che si pensa mentre parla il primo.

**Sanno cosa fa Andrea.** Melissa e i personaggi ricevono, in fondo al prompt e come dati e non istruzioni, il contesto
della memoria della Bottega (al piu' 2500 caratteri, passato da `censura`, riletto al piu' ogni due minuti):
il riassunto del progetto in `~/.bottega/memoria/contesto/<projectKey>.md` (la chiave dalla tabella `sessions` per la
cartella di lavoro) e i titoli dei `riassunto` degli ultimi tre giorni (`progetto: titolo`). Nella barra il progetto e'
quello della stanza o della sessione attiva; sull'iPhone il testo arriva gia' pronto dal Mac nel campo `memoria` di
`/v1/stato` (stessa forma, progetto piu' recente), e senza Mac si usa l'ultimo salvato, dichiarandone l'ora.

**Riempitivi: cosa si dice mentre il modello pensa.** Le frasi stanno nei file di `personaggi/`, campo `riempitivi`
(vedi `personaggi/LEGGIMI.md`); quelle di Melissa in `personaggi/melissa.json`, che ha `chiave: "melissa"` e porta solo
i suoi riempitivi: non e' un personaggio, non entra nell'elenco e non si chiama. Gruppi: `domanda`, `ordine`, `sfogo`,
`battuta`, `chiacchiera`, `lunga` (le attese lunghe), `eco` (modelli con `{x}`).

- Intenzione di quello che Andrea ha detto, la prima che vale, sul testo in minuscolo:
  1. `sfogo`: `\b(cazz|merd|porc[aoi]|orco|vaffa|che palle|non funziona|non va\b|si e' rotto|si è rotto|odio|che schifo|stufo|incazz)`;
  2. `battuta`: `\b(ah(ah)+|ha(ha)+|lol|scherz|rid[oei]\b|battuta)`;
  3. `ordine`: dopo un eventuale vocativo (`parola, `) e uno o piu' fra `dai`, `allora`, `ok`, `okay`, `senti`, `ehi`,
     `ascolta`, comincia con `fai|fammi|apri|metti|controlla|scrivi|lancia|manda|cerca|trova|leggi|dimmi|spiega|
     spiegami|ricordami|prepara|aggiungi|togli|cambia|sistema|guarda|chiama|prova|ferma|crea|calcola|traduci|riassumi|
     puoi|potresti|devi|voglio che|vorrei che|mi serve`;
  4. `domanda`: finisce con `?`, oppure dopo un eventuale `e`/`ma`/`allora`/`senti` comincia con
     `come|perch[eé]|cosa|che cosa|quando|dove|quale|quali|quanto|quanti|quante|chi|sai|secondo te|ti ricordi|hai mai|
     c'e'|c'è|esiste`;
  5. altrimenti `chiacchiera`.
- Tema per l'eco: la prima parola con l'iniziale maiuscola, di almeno tre lettere, che non sta a inizio frase e non
  e' il nome di Melissa, di Andrea o di un personaggio (il riconoscimento di Apple scrive i nomi propri con la
  maiuscola). Con un tema, intenzione `domanda`, `ordine` o `chiacchiera` e `caso2 < 0.25`, si usa un modello di `eco`
  con `{x}` sostituito.
- Scelta: il gruppo dell'intenzione della voce che parla; se e' vuoto, il suo `chiacchiera`; se manca anche quello,
  lo stesso gruppo di Melissa. Si escludono le ultime `min(3, n - 1)` frasi dette da quella voce (per l'eco conta il
  modello, non la frase finita), poi `candidati[floor(caso * candidati.length)]`.
- Tempi, da quando la domanda parte verso il modello: a 900 ms la prima frase (intenzione), a 5 s e a 10 s una frase
  di `lunga`, poi piu' niente. Ognuna solo se la risposta non ha ancora cominciato a parlare. Nella barra, uno
  strumento che dura piu' di 1,5 s dopo che la risposta e' gia' partita dice una frase di `lunga`, una volta per turno.
- Dopo un riempitivo detto, la risposta perde l'intercalare iniziale, che sarebbe un doppione: si toglie fino a due
  volte `^(mh+|m+h|uhm+|ehm+|allora|dunque|vediamo|ok|okay|beh|be'|bah|ah|eh|oh|ecco|si|sì)\s*[,.!…:]+\s*` (senza
  distinguere maiuscole) e si rimette la maiuscola; se non resta niente, la risposta resta com'era.
- Voce: un riempitivo e' un turno di voce intero, con la voce di chi parla (`final: true`). Il Nucleo ne tiene l'audio
  gia' pronto (modalita' isola, `POST /scalda`; servizio, `voice.scalda`), cosi' parte senza aspettare ElevenLabs.
  L'iPhone ha una sua copia in `Caches/riempitivi/`. Le frasi di `eco` cambiano ogni volta e vanno dal vivo.

## 10. Gli aggiornamenti: VS Code solo quando serve, Claude Code sempre

Regola di Andrea (2/10/2026): VS Code sotto la Bottega si aggiorna solo quando l'estensione Claude Code lo chiede, mai
per le uscite mensili di Microsoft; Claude Code invece sempre. `src/aggiorna.ts` (logica, senza `vscode`) e
`src/aggiorna-host.ts` (notifiche, comando, impostazioni `bottega.aggiornamenti.*`).

- **Claude Code**, ogni ora (il primo controllo 90 s dopo l'avvio): `GET open-vsx.org/api/anthropic/claude-code/
  darwin-arm64/latest`. Se `version` e' piu' nuova di quella installata e il suo `engines.vscode` e' soddisfatto,
  `workbench.extensions.installExtension('anthropic.claude-code@<versione>')`. La versione nuova entra in uso al
  prossimo riavvio delle estensioni: niente riavvio automatico, le sessioni aperte non cadono. In piu' i default del
  tema accendono `extensions.autoCheckUpdates` e `extensions.autoUpdate`.
- **VS Code**, al massimo una volta ogni 20 ore (il primo 2 minuti dopo l'avvio): il minimo di `engines.vscode`
  dell'ultima Claude Code contro `vscode.version`. Se basta, finito (GitHub non si chiama). Se no, `GET api.github.com/
  repos/microsoft/vscode/releases/latest`: se quella versione soddisfa il minimo, notifica del Nucleo `notify {id:
  'aggiorna:<tag>', actions: [aggiorna, dopo]}` (senza Nucleo, notifica della Bottega con gli stessi pulsanti).
  `notify.clicked`: `aggiorna` lancia, `dopo` tace la stessa versione per tre giorni, il clic sul corpo chiede conferma
  in una finestra modale (un clic per sbaglio non fa partire un'ora di compilazione). Comando «Controlla se VS Code va
  aggiornato» (`bottega.aggiornaVSCode`): il controllo subito, e la notifica se serve.
- **Lo script** `scripts/aggiorna-vscode.sh <tag>` (anche a mano): parte staccato dalla Bottega (`spawn` detached,
  uscita in `~/.bottega/aggiornamento.log`), perche' alla fine `package.sh` chiude e riapre la Bottega. Rifiuta una
  versione che non sia `N.N.N` e una compilazione di VS Code gia' in corso. Cambia `vscodeTag`, `bump-build.sh`,
  `build.sh` (che installa); poi commit di `bottega.json` e `ios/Version.xcconfig` e di nient'altro, e push. Se la
  compilazione si ferma rimette `bottega.json` e `Version.xcconfig` com'erano: in /Applications resta la Bottega di
  prima.
- **L'esito** in `~/.bottega/aggiornamento.json`: `{stato: 'in corso' | 'fatto' | 'fallito', tag, build?, motivo?,
  push?, at, annunciato?}`. La Bottega lo legge all'avvio e ogni 30 s mentre e' `in corso`, lo dice con una notifica
  una volta sola (`annunciato: true`). `motivo` e' la riga `patch fallita` di `patch-source.py` o il primo errore di
  compilazione. Un `in corso` piu' vecchio di tre ore vale come morto.
- **Dove sono i sorgenti**: `bottegaSorgenti` in `product.json` (lo scrive `package.sh`), poi
  `bottega.aggiornamenti.sorgenti`, poi `~/Prototipi/Bottega`.

## 11. Cline, la riserva di Claude Code

Quando il credito di Claude Code finisce si continua a lavorare con Cline (`saoudrizwan.claude-dev`, Open VSX) sul
fornitore scelto in Cline (per Andrea DeepSeek, `deepseek-v4-pro`). Codice: `src/cline.ts` (logica pura, provata da
`test/cline.cjs`) e `src/cline-host.ts`. Si spegne tutto con `bottega.cline.attivo: false`.

- **Installazione**: se manca, da Open VSX, al massimo tre tentativi al giorno. Gli aggiornamenti li fa VS Code
  (aggiornamento automatico delle estensioni).
- **Terza voce della barra di destra**, dopo Melissa e Claude Code, senza patch a VS Code. VS Code tiene la posizione
  dei contenitori in `views.customizations` (`viewContainerLocations[id] = 2`, la barra secondaria) e l'ordine delle
  voci in `workbench.auxiliarybar.pinnedPanels`, nel database `User/globalStorage/state.vscdb` del profilo
  predefinito. Le due chiavi si possono scrivere solo a Bottega chiusa (aperta le tiene in memoria e le riscrive alla
  chiusura). La Bottega lancia quindi un processo staccato (il Node di Electron, `ELECTRON_RUN_AS_NODE=1`) che aspetta
  la fine del processo principale (`process.ppid` dell'host delle estensioni), aggiunge
  `workbench.view.extension.claude-dev-ActivityBar` in fondo alle voci con `/usr/bin/sqlite3` e scrive
  `~/.bottega/cline-in-barra`. Una volta sola: se poi Cline viene spostato a mano, resta dove l'ha messo Andrea.
  Registro in `~/.bottega/cline.log`.
- **Server MCP**: quelli utente di `~/.claude.json` (`mcpServers`) vanno in
  `~/.cline/data/settings/cline_mcp_settings.json` (mode 600; `CLINE_DATA_DIR` se impostata), stdio come sono, `http`
  come `streamableHttp`, `sse` come `sse`. La Bottega tocca solo i server che ha messo lei (elenco `gestiti` in
  `~/.bottega/cline.json`): quelli aggiunti a mano in Cline restano, e di un server gia' presente restano `disabled`,
  `autoApprove` e `timeout` scelti in Cline. I nuovi entrano con `autoApprove: []`: Cline chiede conferma a ogni
  chiamata. I server di progetto e i connettori di claude.ai non passano (questi ultimi sono legati all'account
  claude.ai). Si riallinea all'avvio e quando cambia `~/.claude.json`.
- **Contesto e memoria**: la regola globale `~/Documents/Cline/Rules/bottega.md`, riscritta quando cambia
  `~/.claude/CLAUDE.md`, contiene: leggere il `CLAUDE.md` del progetto, `memoria_cerca` e `memoria_bacheca` prima di
  ogni compito, `memoria_ricorda` per le decisioni (sempre con `progetto`, perche' il server MCP lanciato da Cline non
  ha la cartella del progetto come cartella di lavoro), messaggi e pubblicazioni solo su richiesta esplicita, e una
  copia di `~/.claude/CLAUDE.md`. Dalla build 103 le conversazioni locali Cline entrano anche automaticamente
  nella Memoria tramite importazione incrementale, senza dipendere dagli hook Claude (contratto sotto).
- **Chiave**: la Bottega non la tocca. Cline la tiene in `~/.cline/data/secrets.json`, si imposta dalle sue
  impostazioni.

## 12. Il terminale, quarta voce della barra di destra

### Nuove sessioni dalla plancia

- `activity.new {id}` crea una sessione indipendente nella cartella e con la fonte dell'attivita'
  presente nello snapshot. Il messaggio non puo' scegliere comandi o percorsi arbitrari.
- `session.new` e `bottega.nuovaSessione` aprono il selettore Claude Code, Cline, Codex, Terminale.
  Le sessioni sono processi CLI in terminali Panel nella stessa finestra, accessibili dalla barra
  Terminale con nomi `Fonte · progetto`, numerati se duplicati. Non riutilizzano sessioni esistenti.
  I pannelli nativi degli agenti restano disponibili nelle rispettive voci; non vengono duplicati.
- La lista Home e Lavori espone «Nuova sessione»; l'azione separata di progetto indica esplicitamente
  che apre un'altra finestra. Titoli e azioni vanno a capo su pannelli stretti.
- Cline usa un core dedicato (`instance new`, client con `--address`), terminato alla chiusura del suo
  terminale senza toccare gli altri core. Il launcher verifica un runtime Node compatibile con SQLite
  prima di avviare il core. Non cambia le modalita' di approvazione degli agenti e non invia un compito.
- Sorgenti: `src/sessioni.ts`, `shell/cline-session.cjs`. Test: `test/sessioni.cjs`, `test/plancia.cjs`
  e `scripts/test-terminal-bar.cjs`.

### Barra delle sessioni (build 88)

La barra nativa mantiene separati i selettori delle viste, le sessioni del terminale e le azioni.
In barra laterale secondaria, il nome singolo è sostituito dalle schede delle sessioni del pannello:
nomi contenuti con ellissi, selezione aggiornata in diretta e scorrimento orizzontale quando lo spazio
finisce. Il menu resta sempre raggiungibile. I terminali aperti nell'editor non vengono duplicati.

Passare su «Terminale» per 250 ms apre il menu senza spostare il fuoco dalla shell. Freccia giù o
il pulsante della tendina lo aprono da tastiera; Esc chiude. Il menu permette di creare un terminale
nella cartella corrente e scegliere le sessioni aperte. Nessun passaggio del mouse crea o chiude
processi. I titoli sono inseriti come testo, mai HTML. Eventi e timer vengono smaltiti con la vista.

Implementazione: `brand/terminal-bar.ts`, `brand/workbench.css`, applicati esclusivamente da
`scripts/patch-source.py` ai sorgenti nativi. L'estensione conserva la gestione della cartella
(`bottega.terminaleQui`), della shell e di Agnes. Gli altri contenitori mantengono il selettore
originale, con il titolo lungo correttamente contenuto.

Codice: `src/terminale.ts` (logica pura, provata da `test/terminale.cjs`) e `src/terminale-host.ts`. Colori e carattere
in `extensions/bottega-theme`.

- **La voce**: e' il terminale vero di VS Code. Il suo contenitore (id `terminal`, lo stesso della vista; con il
  pacchetto italiano si chiama «Terminale») passa dal pannello in basso alla barra di destra, dopo Melissa, Claude Code
  e Cline, senza patch a VS Code e con lo stesso meccanismo di Cline (sezione 11): un processo staccato aspetta la fine
  del processo principale e scrive `views.customizations.viewContainerLocations.terminal = 2` e la voce in fondo a
  `workbench.auxiliarybar.pinnedPanels`, con `spostaInBarra` di `src/cline.ts`. Una volta sola (file segnale
  `~/.bottega/terminale-in-barra`, registro `~/.bottega/terminale.log`): se Andrea lo riporta in basso, resta in basso.
  Se alla stessa chiusura deve spostarsi anche Cline (Cline attivo, installato e senza `~/.bottega/cline-in-barra`), il
  programma del terminale aspetta quel file, fino a 30 secondi, poi scrive: due programmi insieme si pesterebbero le
  stesse chiavi. Si spegne con `bottega.terminale.barra: false`.
- **Cosa cambia per il resto**: i lavori della Bottega (`src/jobs.ts`) e le sessioni di Claude (`claudeIn`,
  Cmd+Alt+C) aprono i loro terminali nell'editor, quindi non si spostano. La shell integration non dipende dal posto
  della vista: `src/ponte-sessioni-host.ts` legge l'uscita come prima. Ctrl+`, le attivita' (tasks), il terminale del
  debug e `git push` della Bottega si aprono nella voce di destra invece che in basso. Nel pannello in basso restano
  Problemi, Output, Console di debug, Porte.
- **La cartella corrente** (`cartellaCorrente`): la sessione della scheda attiva, se la scheda e' un terminale
  nell'editor (cartella del lavoro della Bottega, poi la cartella viva della shell integration, poi quella di
  creazione); altrimenti, per il file attivo, la piu' interna tra la radice git (un worktree, dove `.git` e' un file,
  conta come radice sua; la home non conta mai) e la cartella del workspace che lo contiene, poi la cartella del file;
  altrimenti la prima cartella del workspace; altrimenti la home.
- **Il terminale che VS Code crea da solo** quando si apre la voce vuota (o Ctrl+`) nasce nella prima cartella del
  workspace o nella home: VS Code non permette di sceglierla. Se la cartella corrente e' un'altra, la Bottega lo
  sostituisce subito con uno nella cartella giusta. Solo se: e' l'unico terminale fuori dall'editor, e' nato senza
  opzioni (niente nome, cartella, shell), sono passati 10 secondi dall'avvio (i terminali ripristinati restano) e
  `terminal.integrated.cwd` e' vuota.
- **Comandi**: `bottega.terminale` (apre la voce, o un terminale nuovo nella cartella corrente se non ce n'e'),
  `bottega.terminaleQui` «Terminale qui» (palette: cartella corrente; Explorer e menu della scheda: la cartella, o
  quella del file), `bottega.terminaleEsterno` «Apri in iTerm2» (palette ed Explorer) e `bottega.terminaleEsternoDaQui`
  (pulsante nel titolo della voce Terminale: la cartella del terminale attivo).
- **iTerm2**: profilo dinamico «Bottega» in `~/Library/Application Support/iTerm2/DynamicProfiles/bottega.json`
  (Guid fisso `bottega-terminale-andreapiani`), con i colori `terminal.*` del tema attivo (Notte se scuro, Calima se
  chiaro, piu' `workbench.colorCustomizations`), i 16 ANSI, cursore, selezione, carattere e altezza riga di
  `terminal.integrated.*`. Si riscrive solo se cambia: all'avvio, al cambio di tema o di impostazioni, prima di aprire
  iTerm2. Si apre con `execFile('/usr/bin/osascript', ['-e', ...righe, cartella, 'Bottega'])`: cartella e profilo sono
  argomenti (`argv`), mai testo dello script, e `quoted form of` li cita per la shell (`cd '...' && clear` in una
  finestra nuova con il profilo). Con `bottega.terminale.esterno: terminal`, o senza `/Applications/iTerm.app`,
  `open -a Terminal <cartella>`; nel secondo caso una riga lo dice.
- **Melissa**: `terminale_apri {progetto?, esterno?}`: un terminale nella cartella del progetto (o nella cartella
  corrente), nella Bottega o, con `esterno: true`, in iTerm2. Registrato da `extension.ts` come gli strumenti dei
  connettori (`Object.assign(TOOLS, STRUMENTI_TERMINALE)`).

- **Agnes nel terminale** (`bottega.terminale.agnes`, predefinito acceso). Codice: `src/terminale-agnes.ts` (regole,
  socket, cervelli, copia dei file; provato da `test/terminale-agnes.cjs`), il collegamento in `src/terminale-host.ts`, il
  widget in `extensions/bottega-home/shell/agnes.zsh` con `zshenv`, `zprofile`, `zshrc`, `zlogin`.
  - **Come si carica.** A ogni avvio l'estensione copia `shell/*` in `~/.bottega/zsh/` (cartella 700, file 600, solo i
    file cambiati) e mette `ZDOTDIR=~/.bottega/zsh` nella variabile d'ambiente dell'estensione
    (`ctx.environmentVariableCollection`, `persistent = false`, rimessa a ogni avvio solo dopo aver scritto i file). Vale
    per tutti i terminali nuovi della Bottega, nessun file di Andrea viene toccato. I file di `~/.bottega/zsh` caricano
    quelli veri (`$HOME/.zshenv`, `.zprofile`, `.zshrc`, `.zlogin`, oppure `BOTTEGA_ZDOTDIR_UTENTE` se la Bottega e' partita
    con un altro ZDOTDIR) nello stesso ordine e con `ZDOTDIR` al loro posto, poi `agnes.zsh`. `HISTFILE` resta
    `~/.zsh_history`. Alla fine `ZDOTDIR` torna `$HOME`: shell figlie e `.zlogout` sono quelle di sempre. Una shell non
    interattiva (attivita', script) legge solo `.zshenv` e torna subito a casa.
  - **Shell integration di VS Code.** Convivono senza patch: quando inietta, VS Code mette `ZDOTDIR` nella sua cartella
    temporanea e prende quello che il terminale aveva (`~/.bottega/zsh`) come `USER_ZDOTDIR`, poi carica i nostri file
    al posto di quelli di `$HOME` (`terminalEnvironment.ts`, `shellIntegration-*.zsh`). Il nostro `precmd` e' il primo
    della lista e restituisce il codice d'uscita, quindi `__vsc_precmd` lo vede giusto. Provato da
    `test/terminale-agnes.cjs` con gli script veri dell'app.
  - **Comando o frase.** All'Invio il widget (che sostituisce `accept-line`, conservando quello di prima) decide in
    locale, sotto il millisecondo (0,1 ms misurato), senza processi esterni:
    - comando: riga vuota, su piu' righe o con `\` finale; prima parola (dopo `VAR=x`, `noglob`, `command`, `builtin`,
      `nocorrect`, `exec`) che e' un percorso o contiene sintassi di shell; prima parola nota a `whence` seguita da flag,
      percorsi, `$`, virgolette, redirezioni o glob; `echo`, `print`, `printf`, `say` e le parole riservate (`for`,
      `if`...); una sola parola sconosciuta (zsh dice command not found come sempre);
    - frase: almeno due parole con la prima sconosciuta e senza `| ; < > && $( )` e backtick (anche un errore di
      battitura come «gti status»: Agnes propone `git status`); una prima parola nota seguita da almeno due parole
      funzione italiane intere e minuscole (mi, il, la, i, un, di, che, per, con, tutti, questo, dove, come, fammi, dammi,
      nel, dal, qui, quanto, piu', oggi... elenco in `agnes.zsh`), oppure da una sola con almeno tre parole dopo il
      comando («find i file grossi»); una domanda di almeno tre parole che finisce con `?`.
    - Per forzare: `# richiesta` e `? richiesta`; `#! deepseek richiesta` e `#! agnes richiesta` scelgono il cervello per
      quella richiesta; `??` (con una nota facoltativa) spiega in due righe perche' l'ultimo comando e' fallito e propone
      il rimedio. `#` resta: una riga che comincia con `# ` da sola non fa niente in zsh (con `interactivecomments` e'
      un commento, senza e' un errore), e una riga incollata su piu' righe non viene mai intercettata.
    - **Paracadute.** Doppio Invio veloce (il secondo arriva mentre Agnes pensa, o entro 1 s dal primo) ed Esc alla
      domanda eseguono la riga com'era. Il caso opposto: `command_not_found_handler` passa ad Agnes una riga di almeno
      due parole scritta da sola e senza sintassi di shell (scrive `~/.bottega/zsh/.richiesta.<pid>`, il prompt dopo la
      chiede), salvo quando la riga era stata appena eseguita «com'era». Un gestore gia' definito da Andrea resta e viene
      chiamato per gli altri casi.
    - **Indizio.** Mentre si scrive, se la riga e' una frase, il nome del cervello in grigio dopo il testo (`POSTDISPLAY`
      con `region_highlight` `fg=8,memo=bottega`, hook `line-pre-redraw`), solo se `POSTDISPLAY` e' libero.
  - **Il socket.** `~/.bottega/terminale.sock`, permessi 600, protocollo a righe (niente HTTP, niente curl: il widget usa
    `zsh/net/socket`). Richiesta: righe `chiave valore` (`azione proponi|consenti|stato`, `tipo comando|perche`,
    `origine auto|forzata`, `cervello`, `cartella`, `zsh`, `ultimo`, `codice`, `richiesta`, `comando`; a capo dentro un
    valore = `\x1e`), poi una riga vuota. Risposta: `esito ok|errore|aspetta`, `esegui subito|chiedi|proponi`,
    `consentibile si|no`, `nota`, `spiega`, `avviso`, `errore` (zero o piu'), una riga vuota, poi il comando com'e'. Una
    richiesta alla volta (la seconda: «aspetta un attimo, sto gia' pensando»). Con piu' finestre della Bottega il socket
    e' della prima; le altre restano di riserva e lo riprendono entro 30 s quando sparisce. Alla chiusura si cancella solo
    se e' ancora il nostro (inode).
  - **Cervelli.** `bottega.terminale.cervello`: `agnes` (predefinito, `agnes-3.0-flash` con `reasoning_effort: none`,
    tramite `Cervelli.streamFor` di `src/cervelli.ts`, quindi conta nelle richieste di oggi della barra) o `deepseek`
    (stessa chiave e stesso endpoint di Melissa). Se non risponde (errore, 12 s), l'altro, poi Apple Intelligence
    (`runAppleTurn` dal Nucleo, senza strumenti, 24 s); il cambio lo dice una riga grigia. Agnes al massimo una richiesta
    ogni 3 secondi: da primo cervello risponde «aspetta un attimo», da riserva si salta. Nessuna chiave nella shell, in
    env, nei file di zsh o nei log (il registro «Bottega, terminale» scrive cartella, cervello e tempo, non il testo).
  - **Contesto mandato.** macOS e versione, versione di zsh, cartella corrente, ramo e `git status --short` (15 righe al
    massimo), per `??` l'ultimo comando e il codice d'uscita. Mai il contenuto dei file, mai la storia. Prompt di sistema:
    solo il comando, una riga (o piu' comandi con `&&`), BSD e macOS e non GNU, niente sudo se non indispensabile,
    niente cancellazioni, pubblicazioni o push se non chiesti.
  - **Tre modi** (`bottega.terminale.agnesModo`): `proponi` (il comando nel buffer, Invio di Andrea), `chiedi`
    (predefinito: il comando nel buffer e sopra «eseguo? [invio] sì, [s]empre, [n]o, [m]odifica, [esc] la tua riga
    com'era», una mappa di tasti sua `bottega_domanda`; le frecce non fanno niente), `auto` (partono da soli i consentiti
    e i comandi che leggono soltanto: `ls`, `cat`, `du`, `git status`, `git log`, `find` senza `-delete`/`-exec`...).
    Un comando che parte da solo lo dice in grigio («eseguo, e' tra i consentiti»).
  - **Consentiti.** `~/.bottega/terminale-consentiti.json` (600, `{"forme": [...]}`). Si confronta la forma: programma
    piu' sottocomando (`git status`, `npm test`, `npm run build`, `npx expo`), o programma piu' le opzioni iniziali (`ls`,
    `du -sh`). `s` alla domanda aggiunge le forme di tutte le parti. Consentito vuol dire senza domanda in `chiedi` e in
    `auto`. «Terminale: comandi consentiti» (`bottega.terminaleConsentiti`) li elenca, la x li toglie.
  - **Paletti** (`decidi` in `src/terminale-agnes.ts`): nessun modo e nessun consentito li scavalca, chiedono sempre con
    l'avviso in ambra («attenzione: ...») e non si possono consentire. `rm` (ogni forma), `shred`, `truncate`; `git push`
    di ogni tipo, `reset --hard`, `clean -f`, `checkout --`/`restore`, `branch -D`, `stash drop/clear`; `dd`, `mkfs`,
    `diskutil erase...`; `chmod/chown -R`; scritture su `/dev/*` (salvo null, stdout, stderr, tty); `curl|sh` e
    `sh -c "$(curl ...)"`; `kill -9`, `killall`, `pkill`; `shutdown`, `reboot`; `find -delete`; impostazioni di sistema
    (`defaults delete`, `csrutil`, `nvram`, `launchctl unload`...); pubblicazioni (`vercel` salvo i sottocomandi che
    leggono, `npm/yarn/pnpm/bun publish`, `eas submit/update`, `xcrun altool`, `fastlane`, `gh release create`,
    `gh pr merge`, `firebase/netlify/fly/wrangler deploy`, `cargo publish`, `pod trunk push`, `docker push`,
    `supabase db push`, `heroku`, `twine`); installazioni globali (`brew install`, `npm i -g`, `pip install`); `sudo`;
    scritture fuori dalla cartella corrente o direttamente nella home (`cp`, `mv`, `touch`, `mkdir`, `tee`, `>`...,
    percorsi con variabili compresi; `cd` sposta la risoluzione dei percorsi ma non la cartella di riferimento). Una
    catena (`&&`, `||`, `;`, `|`) va da sola solo se ci va ogni parte; una sostituzione `$( )` chiede sempre.
  - **iTerm2.** Con Agnes accesa il profilo dinamico «Bottega» ha `Custom Command: Yes` e
    `Command: /usr/bin/env ZDOTDIR=~/.bottega/zsh /bin/zsh -l` (la `$SHELL` di Andrea se e' zsh; niente se la shell non e'
    zsh o il percorso ha spazi). Funziona anche a Bottega chiusa: niente socket, le frasi restano a zsh e `# ...` dice
    «la Bottega e' chiusa».
  - **Spento** (`bottega.terminale.agnes: false`): niente ZDOTDIR per i terminali nuovi, socket chiuso e cancellato,
    profilo di iTerm2 senza comando. I file in `~/.bottega/zsh` restano (innocui).

## 13. La stanza App Store

Codice: `src/appstore.ts` (motore, regole dei buchi, verifica, allarmi e lettura dei repository),
`src/appstore-dati.ts` (lettori puri di abbonamenti, analisi della scheda e versioni), `src/appstore-storia.ts` (la
memoria dei buchi), `src/appstore-host.ts` (aggancio: controllo periodico, notifiche, messaggi, strumento di Melissa),
`media/appstore.js` e `media/appstore.css` (la stanza, montata da `plancia.js` come le altre: `BottegaAppStore.mount`).
Tutto provato da `test/appstore.cjs`. Aggancio in `extension.ts`: `registerAppStore(ctx, { radar, projects, send,
nucleo, showHome, log })` e `handleAppStore(m)` nel `default` dei messaggi.

### 13.1 Fonti

Tutte dirette, gratis, con le credenziali che il radar usa gia' (sezione 4.1). `Radar.asc()`, `Radar.admob()` e
`Radar.ascJwt()` sono pubblici per questo: un solo JWT e un solo token di Google per le due cose.

- **Vendite di App Store Connect**: `GET /v1/salesReports`, `reportType=SALES`, `reportSubType=SUMMARY`,
  `vendorNumber=ASC_VENDOR_NUMBER` (da `~/.secrets/appstoreconnect-api.env`). Giornalieri versione `1_1` per gli ultimi
  62 giorni, mensili versione `1_0` per i 24 mesi (escluso quello in corso, che si somma dai giorni). TSV dentro gzip.
  Si contano: download nuovi (`1`, `1F`, `1T`, `F1`, `1E`, `1EP`, `1EU`), riscaricamenti (`3`, `3F`, `F3`), acquisti
  in-app (`IA1`, `IA9`, `IAY`, `IAC`, `FI1`, con `Subscription` New o Renewal), ricavi = `Units` x `Developer Proceeds`
  nella `Currency of Proceeds`. Gli aggiornamenti (`7*`) no. Un acquisto va alla sua app con `Parent Identifier` (lo
  SKU della app); se lo SKU non si conosce resta sotto `sku:<sku>` e fuori dalle app.
  Dalla colonna `Version` dei download e degli aggiornamenti si ricavano le uscite (`uscite` di `appstore-dati.ts`): il
  giorno (o il mese) in cui compare una versione piu' alta di tutte quelle viste prima; il primo passo e' la base.
- **Abbonamenti**: report `SUBSCRIPTION` e `SUBSCRIPTION_EVENT`, giornalieri, versione `1_4`, sugli stessi 62 giorni.
  Dal primo: abbonati che pagano (prezzo pieno e offerte a pagamento), in prova gratuita, in ritardo di pagamento
  (`Billing Retry`), in tolleranza (`Grace Period`), ricavi ricorrenti al mese (abbonati a prezzo pieno x ricavo
  netto / mesi del periodo, in euro). Dal secondo, per categoria: prove, conversioni, nuovi, rinnovi, disdette
  (`Cancel`, cioe' rinnovo spento), rimborsi, ritardi, ritorni (`Reactivate*`). Un errore su questi report non ferma
  le vendite: il giorno resta vuoto.
  Risposte: 200 si legge e si tiene per sempre; 410 e' `perso` (Apple non lo da' piu': nei grafici e' n/d, non zero);
  404 con «no sales» e' `vuoto`, ma Apple risponde cosi' anche per un report non ancora pubblicato, quindi un vuoto
  degli ultimi 4 giorni o degli ultimi 3 mesi non si tiene e si richiede; ogni altro 404 si richiede.
- **Scheda dello Store**: i report di analisi di App Store Connect. Per ogni app con almeno 10 download in 62 giorni:
  la richiesta `ONGOING` (`GET /apps/{id}/analyticsReportRequests`, una volta al giorno; se manca o Apple l'ha fermata
  per inattivita' la Bottega la crea con `POST /analyticsReportRequests`, e i dati arrivano dal giorno dopo), i due
  report «App Store Discovery and Engagement Standard» (impressioni ed eventi `Page view` di pagina prodotto o foglio
  dello Store, in dispositivi unici) e «App Downloads Standard» (`First-time download` per fonte, `Redownload` a
  parte), le istanze `DAILY` non ancora lette (ogni 6 ore), i loro segmenti (CSV dentro gzip). Un'istanza contiene gli
  eventi elaborati quel giorno, anche di giorni prima: le istanze si **sommano**. Fonti: ricerca, navigazione, web,
  altre app. Apple le prepara con due o tre giorni di ritardo (`schedaFinoA`).
- **AdMob**: `accounts`, `apps` e `adUnits` (elenchi) e cinque `networkReport:generate`: `DATE x APP` (62 giorni,
  euro e impressioni), `MONTH x APP` (24 mesi), `DATE x APP x FORMAT` (62 giorni: da qui i formati dei 30 giorni, la
  verifica dopo una versione e gli allarmi), `AD_UNIT` e `COUNTRY` sugli ultimi 30 giorni
  (euro, richieste, abbinate, impressioni, clic). Si rileggono a ogni aggiornamento: AdMob ritocca gli ultimi giorni.
  Valuta del conto AdMob: euro.
- **Cambi**: `https://open.er-api.com/v6/latest/EUR`, senza chiave, al massimo una volta al giorno; senza risposta si
  tengono gli ultimi. Le valute senza cambio finiscono in `senzaCambio` e fuori dai totali.
- **I repository**: le app si collegano ai progetti con i bundle id (`projectBundleIds` del radar) e, per Android, con
  l'`applicationId` di `app/build.gradle(.kts)`. `leggiRepo` legge fino a 5000 file (Swift, Objective-C, Kotlin, Java,
  plist, pbxproj, xcconfig, xml, gradle, Podfile, Package.resolved; non `node_modules`, `Pods`, `build`,
  `DerivedData`, `.git`, `.claude`...) e cerca: SDK di AdMob, formati usati nel codice, consenso UMP,
  `NSUserTrackingUsageDescription` e `requestTrackingAuthorization`, quanti identificativi SKAdNetwork, l'ID di prova
  di Google fuori da un file con `DEBUG` (test e framework esclusi), gli ID di unita' con la piattaforma del file
  (segnaposto come `0000...` o `0123456789...` esclusi), acquisti in-app veri (non basta `import StoreKit`). Si
  rilegge ogni 6 ore o con «Aggiorna».

Cache in `~/.bottega/appstore/` (cartella 700, file 600): `vendite.json` (schema 2: report di vendita, abbonamenti,
istanze di analisi, SKU, nomi, cambi, repository; con lo schema 1 i report si riscaricano, cambi e repository restano),
`stato.json` (l'ultimo stato, mostrato subito all'apertura) e `storia.json` (13.6). Tra due letture almeno 45 minuti,
**contati dall'ultima lettura salvata**, quindi anche dopo un riavvio della Bottega; «Aggiorna» li salta. Prima
lettura: circa 210 report e le schede di una dozzina di app, un minuto e mezzo; poi pochi report al giorno e una
lettura completa in pochi secondi. Se AdMob non risponde si tengono i suoi numeri dell'ultima lettura buona, spostati
sulle date nuove.

### 13.2 Stato (`AppStoreStato`, estensione -> plancia `{ type: 'appstore', state }`)

```ts
{
  aggiornatoAt, aggiornando, fase?,            // fase: «Scarico le vendite dello Store: 30 report su 85»
  errori: { store?, admob?, cambi?, repo? },   // frasi in italiano
  valuta: 'EUR',
  giorni: string[],        // YYYY-MM-DD, 62, fino a ieri
  mesi: string[],          // YYYY-MM, 24, fino al mese in corso
  storeFinoA?: string,     // ultimo giorno con il report dello Store (Apple pubblica verso le 14)
  storeSenzaDati: string[],// mesi «perso»
  abbFinoA?, schedaFinoA?, // ultimo giorno con abbonamenti e con i dati della scheda
  totale: { giorni: Serie, mesi: Serie, abbonamenti?: Abbonamenti, scheda?: Scheda },
                           // Serie = { admob: number[], store: number[], dl: number[] }, euro
  app: AppRiga[],          // ordinate per euro degli ultimi 30 giorni
  paesi: { codice, euro, impressioni }[],      // 30 giorni, i primi 12
  buchi: Buco[],           // senza gli ignorati
  risolti: BucoChiuso[],   // ultimi 60 giorni
  ignorati: BucoChiuso[],  // con il motivo
  allarmi: { id, chiave, app, testo, at }[],   // ultime 48 ore
  controlloOre?: number,   // bottega.appstore.controlloOre
  senzaCambio: string[],
  publisher?: string,
}
Abbonamenti = { attivi, prove, mrr, ritardo, grazia: number[], eventi: Record<categoria, number[]> }   // 62 giorni
Scheda = { imp, vis, dl: number[], fonti: Record<fonte, { imp, vis, dl }> }   // fonti sui 30 giorni fino a schedaFinoA
BucoChiuso = { id, chiave, app, titolo, quando, daQuando, motivo?, prima?, dopo?, projectPath? }
AppRiga = { chiave: 'ios:<Apple ID>' | 'android:<pacchetto>' | 'admob:<appId>', nome, piattaforma, ascId?, bundleId?,
  admobId?, approvazione?, collegata?, projectPath?, projectName?, giorni: Serie, mesi: Serie,
  formati: { formato, richieste, abbinate, impressioni, clic, euro }[], unita: { id, nome, formato, richieste,
  impressioni, euro }[], acquisti: { nuovi, rinnovi, altri, euro }, repo?: RepoEsito,
  versioni: { v, quando }[], versioniMesi: { v, quando }[], abbonamenti?: Abbonamenti, scheda?: Scheda }
Buco = { id, chiave, app, gravita: 'alta' | 'media' | 'bassa', titolo, perche, cosa, stima?, stimaNota?,
  projectPath?, compito?, tipo, fonte: 'admob' | 'store' | 'codice' | 'abbonamenti' | 'scheda', misura?, soglia?,
  daQuando?, verifica?: { versione, giorno, prima, dopo, giorniDopo, esito: 'risolto' | 'meglio' | 'uguale' | 'presto' } }
```

Si mostrano le app che in 12 mesi hanno reso, venduto, avuto almeno 10 download o chiesto annunci. L'app di AdMob
si unisce a quella dello Store con `linkedAppInfo.appStoreId`; un'app AdMob non collegata resta `admob:<appId>`.

### 13.3 I buchi (`trovaBuchi`)

Sugli ultimi 30 giorni, ordinati per gravita' e poi per stima. La stima e' in euro al mese, solo dove ha un senso
onesto, e dice sempre come e' fatta (`stimaNota`):

- AdMob non ha approvato l'app (`appApprovalState` diverso da APPROVED): alta.
- App AdMob non collegata alla scheda dello Store, con richieste: media.
- Almeno 30 download, zero euro e zero richieste: alta; stima = download x resa mediana per download delle altre app
  (servono almeno tre app per la mediana).
- Riempimento sotto il 60% con almeno 500 richieste (alta sotto il 20%); stima = richieste mancanti fino al 90% x quota
  mostrata (tra 25% e 60%) x RPM del formato nel portafoglio.
- Annunci caricati e non mostrati, con almeno 500 abbinate, sotto la soglia del formato (apertura 20%, interstitial
  35%, banner 50%, nativo 40%; alta sotto la meta' della soglia); stima = abbinate x (soglia - quota) x RPM.
  Gli annunci con premio li sceglie l'utente: sotto il 15% e' un buco basso, senza stima.
- Solo banner (o nativi) con almeno 3000 impressioni e nessun formato a schermo intero, nemmeno nel codice: media;
  stima larga = banner x 8% x RPM degli interstitial.
- Dal codice, se c'e' AdMob: manca UMP (alta), manca ATT o non viene mai chiesto (media, solo iOS), meno di 10
  SKAdNetworkItems (bassa), ID di prova fuori da DEBUG (media), ID di un altro account (alta), ID di un'unita' di
  un'altra app della stessa piattaforma (media).
- Unita' AdMob senza richieste mentre l'app ne ha altre: bassa.
- AdMob in calo di oltre il 35% in una settimana (con almeno 5 euro la settimana prima): media; stima = la differenza
  portata a un mese. Download in calo di oltre il 30% sul mese prima (almeno 60): media.
- Acquisti in-app nel codice, almeno 100 download e niente venduto: bassa.
- Abbonamenti: abbonati in ritardo di pagamento e nessuno in tolleranza in 30 giorni, con almeno 5 abbonati (il periodo
  di tolleranza e' probabilmente spento): media. Prove gratuite che diventano abbonamenti meno del 15% (le prove dei
  giorni da 37 a 7 prima, contro le conversioni degli ultimi 30, almeno 10 prove): media. Piu' disdette che
  abbonamenti nuovi in 30 giorni (almeno 5): bassa.
- Scheda: conversione da impressioni a download sotto meta' della mediana delle app (almeno tre app con 2000
  impressioni): media. Visite alla pagina che diventano download meno del 20% (almeno 200 visite): media. Impressioni
  delle ultime due settimane con dati sotto il 70% delle due prima (almeno 1000): media.

`compito` e' il testo gia' scritto per un lavoro Claude sul progetto (cita la skill `ios-admob-integration`).

### 13.4 Messaggi

- plancia -> estensione: `{ type: 'appstore.request' }` all'apertura della stanza (risponde subito con lo stato salvato
  e rilegge se sono passati 45 minuti), `{ type: 'appstore.refresh' }` («Aggiorna», rilegge tutto subito),
  `{ type: 'appstore.ignora', id, motivo }` e `{ type: 'appstore.ripristina', id }` (13.6, lo stato nuovo arriva subito),
  `{ type: 'job.prepare', path, task }` («Sistema con Claude»: il compositore dei Lavori gia' scritto, sezione 4.2),
  `{ type: 'open', path }` («Apri il progetto»).
- estensione -> plancia: `{ type: 'appstore', state }` a ogni cambiamento (anche durante la lettura, per la fase).
- Comando `bottega.openAppStore`. La stanza sta dopo la Vedetta: tasto 7 (Clienti 8, Connettori 9).

### 13.5 La stanza

Periodo Settimana (7 giorni contro i 7 prima), Mese (30 contro 30), Anno (12 mesi contro i 12 prima). La frase in
cima, le cifre (totale, AdMob, Store, download, ognuna con la variazione), i guadagni a barre impilate (AdMob sotto,
Store sopra, colori fissi verificati con il validatore della palette, suggerimento al passaggio), i download, «Dove
intervenire» (tutti, subito, con una stima; i primi dieci, poi «Mostra tutti»), «App per app» (riga apribile con i
formati, gli acquisti, le versioni uscite, cosa c'e' nel codice e i suoi buchi, «Mostra nei grafici») e «Dove rende
AdMob» per paese. I giorni dopo `storeFinoA` e i mesi `perso` non sono zero: la barra dello Store manca e il
suggerimento dice perche'. Novita' della build 50: in testa l'ora precisa dell'ultima lettura, se ricontrolla da sola
e gli allarmi; una tendina sceglie l'app (grafici, cifre e buchi solo suoi, con le tacche tratteggiate delle versioni
uscite); ogni buco dice da quanto c'e', l'esito dopo l'ultima versione e ha «Ignora» (il motivo si scrive nella
pagina, mai una finestra del browser); in fondo «Risolti» e «Ignorati» (con «Ripristina»); le sezioni «Abbonamenti»
(cifre, abbonati giorno per giorno, eventi del periodo, tabella per app) e «La scheda dello Store» (impressioni,
visite, download nuovi, conversione, fonti, tabella per app), che compaiono solo se ci sono dati.

### 13.6 La memoria dei buchi (`src/appstore-storia.ts`, `~/.bottega/appstore/storia.json`)

- Ogni buco ha un id stabile (`<chiave>:<tipo>[:<formato>]`). Alla prima comparsa si segna `primaVolta` (in stato
  `daQuando`); un buco risolto che torna riparte da adesso.
- Un buco aperto che non scatta piu' diventa **risolto** solo se la sua `fonte` e' stata letta in quel giro: AdMob
  giu' o un report di Apple mancante non chiudono niente. Si tengono la misura alla comparsa e quella attuale
  (`misure` di `costruisci`, calcolate anche per i formati che non sono buchi): «dal 9% al 41%». I risolti restano 120
  giorni, la stanza mostra quelli degli ultimi 60.
- **Ignorato**: resta fuori dall'elenco a ogni lettura, con il motivo (300 caratteri al massimo), finche' Andrea non lo
  ripristina.
- **Verifica dopo una versione** (`verificaBuchi`, per riempimento e mostrati): l'ultima uscita con almeno 5 giorni
  prima e 3 dopo nella finestra; quota nei 30 giorni prima contro i giorni dopo (servono 100 richieste o abbinate per
  parte). `risolto` se dopo e' sopra la soglia, `meglio` se sale di un quarto e di almeno 3 punti, `uguale` dopo 7
  giorni senza cambi, altrimenti `presto`.
- `natoAt` e' la prima lettura: i buchi trovati quella volta c'erano gia', e il briefing non li annuncia come nuovi.

### 13.7 Allarmi, controllo periodico, iPhone, Melissa e briefing

- **Allarmi** (`trovaAllarmi`): un'app che AdMob non approva piu' (lo stato precedente sta in `storia.approvazioni`);
  i guadagni AdMob di ieri sotto il 40% della media dei 7 giorni prima (con una media di almeno 2 euro); il
  riempimento di ieri di un formato sotto meta' di quello dei 30 giorni (almeno 1000 richieste nei 30 giorni e 200
  ieri). Crollo e riempimento solo dopo le 8 del mattino: prima AdMob non ha chiuso ieri. L'id contiene il giorno; un
  allarme non si ripete per 7 giorni. Senza AdMob letto, niente allarmi.
- Ogni allarme nuovo (al massimo tre per lettura) e' una **notifica del Mac** via Nucleo (`notify`, id
  `bottega:appstore:<id>`, pulsante «Apri App Store»; il clic apre la stanza). Gli allarmi delle ultime 48 ore vanno
  negli avvisi dell'iPhone (`Istantanea.negozio`, sezione 9.4): con Andrea lontano dal Mac suona quello che non c'era
  al giro prima, mai alla partenza, con `thread-id: appstore`, al massimo tre. Al Mac no: c'e' gia' la notifica del Mac.
- **Controllo periodico**: `bottega.appstore.controlloOre` (default 3, 0 lo spegne). Un giro ogni 15 minuti (il primo
  dopo 2 minuti dall'avvio) rilegge se dall'ultima lettura sono passate quelle ore. Anche con la stanza chiusa: serve
  agli allarmi. I report di Apple gia' scaricati non si riscaricano.
- **Melissa**: lo strumento `app_guadagni { periodo?: 'ieri' | 'settimana' | 'mese' | 'anno', app?, mostra? }` risponde
  con `AppStore.riassunto()`: quanto hanno reso, le prime tre app, gli abbonati, i primi tre buchi con la stima, gli
  allarmi, l'eta' dei dati. Con dati vecchi di oltre tre ore risponde e intanto rilegge. Registrato in `extension.ts`
  con `Object.assign(TOOLS, STRUMENTI_APPSTORE)`.
- **Briefing**: `Facts.appstore` (`AppStore.briefing()`, solo con dati di meno di 36 ore) prende il posto della riga di
  AdMob del radar: ieri AdMob e Store (o lo Store dell'altro ieri), la settimana contro quella prima, gli abbonati se
  sono cambiati, il primo allarme, i buchi nuovi di ieri e oggi (non quelli della prima lettura), con «Apri App Store».

## 14. Crediti e consumi dei servizi

Chi lo scrive: l'estensione (`src/conti.ts`, classe `Conti`, montata da `registraConti` in `extension.ts`). Chi lo legge:
la sezione «Servizi: crediti e consumi» del Cruscotto (`media/conti.js`), gli avvisi del Mac e dell'iPhone, il ponte e i
widget dell'iPhone (stanza `servizi`). I servizi non danno lo storico con le chiavi che abbiamo, quindi la Bottega lo
tiene lei: legge i saldi 20 secondi dopo l'avvio e poi ogni 30 minuti, e ogni volta che il Cruscotto lo chiede (al
massimo una lettura ogni 10 minuti, o subito con «Aggiorna i saldi»). Una lettura alla volta. Lo storico parte dal
3 ottobre 2026; se la Bottega resta chiusa per giorni, la spesa di quei giorni va sul giorno della lettura dopo.

Fonti:
- **DeepSeek**: `GET https://api.deepseek.com/user/balance` (`balance_infos` USD, `is_available`). La discesa del saldo
  fra due letture e' spesa, la salita e' una ricarica.
- **ElevenLabs**: i caratteri per giorno dal Nucleo (`elevenLabsCharsByDay`, sezione 1). Il mese, il limite e il giorno
  del rinnovo da `GET /v1/user/subscription` solo se la chiave ha il permesso `user_read` (oggi no: 401
  `missing_permissions`, e resta il conteggio della Bottega).
- **Agnes**: gratis; le richieste di oggi contate dalla Bottega (`Cervelli.agnesOggi()`).
- **Deleghe a Claude** (`claude -p`): `~/.bottega/connettori/spesa.json` (sezione 5.4), spesa vera in dollari.
- **Claude Code a listino** non e' qui: e' l'abbonamento, non una spesa. La sezione lo cita prendendolo dal Cruscotto.
- **OpenRouter** c'era nelle build 59 e 60: tolto nella 61 con i suoi cervelli. Alla prima lettura la 61 toglie dal file
  il suo saldo, il suo campione e i suoi giorni.

`~/.bottega/conti/giorni.json` (mode 600, scritto intero: tmp + rename):

```json
{
  "schema": 1,
  "aggiornato": 1759450000000,
  "servizi": {
    "deepseek":   { "nome": "DeepSeek", "valuta": "USD", "saldo": 9.98, "letto": 1759450000000,
                    "mediaGiorno": 0.12, "giorniRimasti": 83, "tono": "ok",
                    "frase": "restano 9,98 $, circa 83 giorni al ritmo attuale" },
    "elevenlabs": { "nome": "ElevenLabs", "unita": "caratteri", "usatiMese": 12345, "limiteMese": null,
                    "rinnovo": null, "tono": "ok", "frase": "12.345 caratteri di voce a ottobre, contati dalla Bottega" },
    "agnes":      { "nome": "Agnes", "gratis": true, "tono": "ok", "frase": "gratis, 15 richieste oggi" }
  },
  "giorni": {
    "2026-10-03": {
      "deepseek":   { "speso": 0.12, "ricarica": 10.0, "saldo": 9.98 },
      "elevenlabs": { "caratteri": 1200 },
      "agnes":      { "richieste": 15 },
      "deleghe":    { "usd": 0.4 }
    }
  },
  "campioni": { "deepseek": { "at": 0, "saldo": 9.98 } }
}
```

- `servizi` contiene solo i servizi che hanno una chiave (ElevenLabs anche senza chiave, se il Nucleo ha contato
  qualcosa). `giorni` usa chiavi in ora locale e tiene gli ultimi 400 giorni; un servizio manca in un giorno senza dati.
  `campioni` serve solo all'estensione, per contare la differenza alla lettura dopo.
- `mediaGiorno`: media di `speso` sugli ultimi 7 giorni che hanno dati per quel servizio (oggi compreso), `null` con
  meno di 2 giorni. `giorniRimasti` = saldo / media, arrotondato in giu'.
- `tono`: `male` se il saldo e' a zero o sotto, o il servizio dice che non e' disponibile; `attesa` sotto 2 $
  (`SOGLIA_USD`) o con meno di 5 giorni al ritmo attuale (`SOGLIA_GIORNI`); ElevenLabs `attesa` oltre il 90% del limite
  del mese, `male` a limite finito (solo con `user_read`). Altrimenti `ok`.
- `frase`: italiano, senza lineette, pronta per la barra, un widget o una notifica.

Avvisi di ricarica: un servizio in `attesa` o `male` da' un allarme con id `conti:<servizio>:<YYYY-MM-DD>`, quindi uno
al giorno, anche dopo un riavvio (gli id di oggi gia' nel file non suonano di nuovo). Sul Mac: notifica del Nucleo
`bottega:conti:...` con «Apri i conti» (comando `bottega.apriConti`, il Cruscotto sulla sezione). Sull'iPhone: lo stesso
allarme entra in `Istantanea.negozio` (sezione 9.4) insieme a quelli della stanza App Store, con testo «Restano 1,20 $,
... Si ricarica su platform.deepseek.com.».

Plancia: la webview chiede `{type: "conti.request", aggiorna?: bool}` a ogni richiesta delle statistiche del Cruscotto
(e con «Aggiorna i saldi»); l'estensione risponde subito con `{type: "conti", conti: ContiFile | null}` e, se i dati
hanno piu' di 10 minuti o `aggiorna` e' vero, di nuovo dopo la lettura. `{type: "conti.mostra"}` porta la vista sulla
sezione. Nella barra di Melissa, sotto i conti, «Crediti e consumi, giorno per giorno» manda `comando` `conti`.

### Ore osservate condivise tra Home e widget (4 ottobre 2026)

`Stats.workTime` contiene `today: {date, minutes}`, `days: {date, minutes}[]` (90 giorni locali),
`weekMinutes` (ultimi sette giorni incluso oggi), `previousWeekMinutes` (sette precedenti) e
`sources: ("claude" | "codex")[]`. È l'unione degli intervalli: le sessioni parallele non si
sommano. Claude conserva il criterio esistente di pausa; Codex usa i progressi registrati dentro
un turno esplicito, interrompe gli intervalli oltre 15 minuti e non prolunga file fermi fino
all'ora corrente. Cline e terminali non hanno durate affidabili e sono dichiarati esclusi dalle
ore; restano presenti nei conteggi delle attività. Non è una misura del tempo personale al Mac.

La Home e `stato.json.ore` usano questo riepilogo. `today.you`, `days.you`, periodi, token e costi
preesistenti restano specifici di Claude; `sourceMetrics` conserva i consumi separati per fonte.
La cache Codex è per file, dimensione e modifica: i progressi nuovi compaiono al giro successivo
senza il precedente TTL di due minuti; i file invariati non vengono riletti.

### Companion Apple Watch: consegna e scadenza dello stato

`OrologioTelefono` invia `IstantaneaOrologio` via `updateApplicationContext`, con un
identificatore `invio` diverso a ogni trasmissione. `CodaOrologio` conserva l'ultimo
payload non consegnato; a contenuti invariati il refresh avviene dopo 10 minuti.
Attivazione, installazione/cambio Watch e richiesta manuale forzano il reinvio.
Una cancellazione pendente ha precedenza al riallineamento. Timestamp precedenti
sullo stesso Mac non sovrascrivono dati recenti. La data resta quella del Mac,
anche quando l'iPhone risponde dalla cache.

La complicazione prepara una voce di timeline alla scadenza di 20 minuti dal dato:
oltre la soglia nasconde i conteggi e indica «Da aggiornare»; senza dati indica
«Apri su iPhone». Il rettangolo mostra l'ora dell'ultima lettura. Nessuna credenziale
viene trasferita al Watch. La consegna in background resta soggetta a WatchConnectivity
e l'aggiornamento del quadrante a WidgetKit.

### Identita' nella finestra Informazioni

Il pannello Informazioni nativo e quello del banco mostrano `bottegaVersion` e
`bottegaBuild` da `product.json`, aggiornati a ogni confezionamento. Anche «Copia»
include questi dati. La sezione «Base VS Code» conserva versione, commit e data
upstream: `product.version` e la versione in `package.json` restano quelli di VS Code
per la compatibilita' delle estensioni. `CFBundleShortVersionString` e
`CFBundleVersion` in Info.plist seguono invece versione e build di Bottega.
Test del formatter nativo: `node scripts/test-about-dialog.cjs` dopo aver applicato
`scripts/patch-source.py` ai sorgenti VS Code.

### Memoria Codex (build 102)

`memoria/lib/codex.mjs` importa le trascrizioni locali prima delle letture CLI `recent` e `search`; comando
manuale `import-codex --json`. Nessuna rete o generazione: le richieste utente e `task_complete.last_agent_message`
sono note (`origin: codex`, `sessionId: codex:<uuid>`) con data originale, fonte nel titolo e testo redatto.
Non vengono importati ragionamenti, strumenti, immagini, contesto del client o conversazioni degli agenti delegati.
La ricerca non propone di riprendere una nota Codex con il comando Claude.

Lettura incrementale per inode e offset, transazione per file, deduplicazione degli eventi anche dopo rotazione;
ultimi sette giorni nelle cartelle giornaliere (oggi e otto giorni precedenti), massimo 100 file recenti e 32 MiB
per chiamata. Righe oltre 256 KiB saltate senza bloccare le successive, note limitate a 8.000 caratteri. Il prossimo
controllo prosegue il recupero. Cline e terminali sono acquisiti dal percorso aggiunto nella build 103, sotto.
Gli hook Claude e il loro limite di 150 ms restano invariati.

Il parser dello stato Codex riconosce richieste esplicite di input o approvazione e le risposte associate per
`call_id`; completamento, interruzione e nuovo turno cancellano le attese. Le domande asincrone non fermano
l'agente e non sono classificate come attesa. Un turno finito non diventa automaticamente «ti aspetta».

### Fonti integrate, Memoria e viste derivate (build 103)

`memoria/lib/fonti.mjs:syncSources()` e' il punto comune di importazione Codex e Cline.
CLI (`recent/recenti`, `search/cerca`, `grafici`, `context/contesto`, `sessione`, `bacheca`,
`import-all`) e MCP lo eseguono prima delle letture. `import-all --json` restituisce
`{codex: {imported, skipped}, cline: {imported, skipped}, spool}`. L'estensione esegue
`Memoria.sync()` all'avvio e ogni 60 secondi, anche senza Home visibile; le chiamate
sovrapposte nella stessa istanza vengono accorpate, timeout del processo 30 secondi.

Cline: SDK `~/.cline/data/sessions/<id>/<id>.messages.json` versione 1 con metadati
`<id>.json`; formato estensione `tasks/<id>/ui_messages.json` nei globalStorage
Bottega/Code/Insiders/VSCodium e nella directory dati Cline. `CLINE_DATA_DIR` permette
di isolare le prove. Massimo 100 file modificati negli ultimi 45 giorni, 8 MiB per file;
cache inode/mtime/dimensione e transazione per file. JSON incompleto viene ritentato.
Si acquisiscono richieste, testo delle risposte, esiti `attempt_completion` e domande
legacy; niente ragionamenti, risultati degli strumenti, immagini o messaggi parziali.

`memoria-eventi.ts` scrive nello spool privato eventi
`{ev: "external", source: "terminale"|"melissa", sid, id, cwd?, at, text, who}`.
Melissa registra richieste/risposte e ripristina le ultime righe disponibili senza
attribuire la vecchia conversazione al workspace corrente. Il terminale registra solo
comando ed esito degli eventi di shell osservati, non l'output. Scrittura accodata,
file 600 e directory 700, redazione e limite 8.000 caratteri prima della persistenza.
Gli hook Claude non cambiano e restano entro il loro vincolo di 150 ms.

`esterne.mjs` produce note con `origin` uguale alla fonte e `sessionId: <fonte>:<sid>`.
`external_events` deduplica fonte/sessione/evento; una riscrittura aggiorna il testo
senza una seconda nota. Date originali, niente timestamp futuro oltre la tolleranza
di un minuto. Bacheca, dettaglio sessione e contesto includono queste note; il contesto
ordina gli esiti e le note per data, prima di applicare il budget. Le note esterne non
offrono il resume Claude. Spotlight indicizza anche note e fatti, ogni cinque minuti.

Continua e Da fare usano l'ultimo esito disponibile per progetto (riassunto Claude o
risposta/esito Codex, Cline, Melissa). Estraggono solo liste esplicite «Da fare», anche
Markdown. Un esito nuovo senza lista non riporta in vita la lista di un vecchio
riassunto. Assenza di una lista non significa che non esista altro lavoro da fare.

Barra laterale, schede progetto, briefing, suggerimenti dei progetti dimenticati e
letture Melissa usano il registro `activity` comune. Il ponte Osservatorio mantiene
gli stati attivi anche con la Home chiusa; aggiunge nei periodi i progetti osservati
senza metriche Claude, con `observedOnly: true`. Il decoder Swift predefinisce il campo
a false per compatibilita'; quei progetti sono visibili con «Ore non disponibili».
Ore, consumi, categorie e connessioni preesistenti dell'Osservatorio restano Claude e
la didascalia ne dichiara la copertura.

`StatsEngine.lastLedger` include anche gli intervalli Codex attribuiti da `cwd` al
progetto o worktree; gli intervalli paralleli dello stesso progetto si uniscono.
Il rendiconto Clienti usa questo registro e dichiara la copertura Claude+Codex.
`Stats.workTime` e' sempre l'unione globale; i campi storici Claude non cambiano
significato. Il Cruscotto letto da Melissa distingue ore osservate, conteggi di tutte
le fonti e consumi per fonte. Cline e terminali non diventano ore o costi zero quando
la misura non e' disponibile. Copertura completa: `docs/AUDIT_FONTI_INTEGRATE.md`.

### Inventari Vercel e stack dei clienti (ottobre 2026)

`RadarState.vercel.catalog` è l'inventario dei progetti Vercel, compresi quelli senza cartella o pubblicazioni di produzione. `catalogAt` indica l'ultima lettura riuscita; `catalogError` conserva l'errore senza cancellare lo stato precedente; `catalogPartial` segnala i limiti di paginazione. Il lettore usa la CLI autenticata, solo GET su team e progetti, con paginazione (massimo 10 pagine per scope). Cache privata in `~/.bottega/radar/vercel.json`. Nessuna variabile d'ambiente, credenziale Git o deploy hook viene serializzato.

La Home aggiunge `vercel`, il comando `bottega.openVercel` e il messaggio `vercel.refresh`. I tasti rapidi delle nove stanze originarie restano invariati. Melissa apre la nuova stanza anche chiedendo «mostra i siti» e legge l'inventario completo quando disponibile.

`clienti.json` resta la fonte delle assegnazioni. `Client.progetti` accetta percorsi locali, `github:owner/repository` e `vercel:prj_id`; i vecchi file restano validi. L'identità del repository e gli ID Vercel risolvono gli abbinamenti a ogni lettura. Le somiglianze di nome non assegnano clienti. Il `ClientReport.stack` aggiunge cartelle, stato Git locale, metadati GitHub e progetti Vercel. Le ore delle cartelle collegate a un'assegnazione remota entrano nello stesso conto; associazioni in conflitto restano fuori dalla fatturazione finché non sono risolte. I conteggi avanti/indietro di Git si riferiscono all'ultimo fetch, non a una lettura corrente del ramo remoto.

`GithubInventory` legge `/user/repos` con `gh api`, conserva solo repository, ramo predefinito, ultimo push, visibilità e stato archiviato. Cache 600 in `~/.bottega/github-stack.json`, cadenza 15 minuti, aggiornamento richiesto al massimo ogni minuto; paginazione fino a 1.000 repository con indicazione di inventario parziale. Errori e assenza di autenticazione conservano l'ultimo dato e la sua data. `clients.refresh` rilegge entrambi i servizi e aggiorna il report; le scansioni locali alimentano lo stesso collegamento. Nessun commit, fetch, pull, push o deploy viene eseguito dalla sincronizzazione.

L'iPhone legge `GET /v1/stanza?nome=vercel`, indipendente dalle regole della Vedetta. Il payload Clienti include solo gli asset assegnati o in conflitto. `POST /v1/stanza/azione` ammette `{stanza: "vercel" | "clienti", azione: "aggiorna"}`: avvia le letture sul Mac e restituisce `{ok:true,avviato:true}`; i dati aggiornati arrivano con le successive GET. Il gettone e il controllo dell'origine del ponte restano obbligatori. Le nuove stanze non includono credenziali e Clienti mantiene la cache solo in memoria sull'iPhone.
