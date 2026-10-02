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
| `voice.speak` | `text`, `voice?`, `append?: bool`, `final?: bool`, `model?` | `engine` | evento `voice.spoken {text, engine}` quando un pezzo e' stato davvero ascoltato. Senza `append` il testo e' una risposta intera. Con `append: true` l'estensione manda i pezzi man mano che l'LLM li scrive: la prima frase (o il primo inciso lungo) parte subito, poi una frase alla volta; `final: true` (anche con `text` vuoto) chiude il turno. `model` sceglie il modello ElevenLabs (default `eleven_v4_turbo`). `voice`: `apple` forza la voce Apple, `com.apple...` sceglie una voce Apple precisa, qualsiasi altro valore e' un voice id ElevenLabs |
| `voice.stopSpeaking` | | | interruzione (barge-in): silenzio subito, coda svuotata |
| `voice.converse.start` | `locale?` | `echoCancellation`, `backend` | modalita' conversazione: microfono sempre aperto, ogni frase che il server chiude (~0.8 s di silenzio) e' un turno dell'utente (`voice.final {text, mode:"converse"}`). Trascrizione (2/10/2026, `Voice/AppleSTT.swift`): come la Melissa di Avo Agency AI, SFSpeechRecognizer it-IT sul Mac,
i buffer del microfono passati cosi' come sono, risultati parziali, una richiesta nuova per ogni frase, frase chiusa
dopo 1,8 s senza parole nuove o quando il riconoscitore la da' per finita. Niente voice processing (VPIO affama il
riconoscitore). Mentre Melissa parla il microfono non si ascolta e si riapre 250 ms dopo (Avo Agency AI: niente eco,
niente interruzioni a voce; si interrompe con un tocco). Permesso "Riconoscimento vocale" per Bottega Nucleo, chiesto
con lo stesso tempo massimo del microfono. ElevenLabs realtime resta con `BOTTEGA_STT=elevenlabs`. Con ElevenLabs:
si manda tutto l'audio, anche il silenzio: fino al 2/10/2026 passava solo quello sopra una soglia fissa (livello 0,08, circa -37 dBFS), e il microfono del MacBook Air senza voice processing restava sotto, quindi a ElevenLabs non arrivava niente. La conversazione si chiude dopo 60 s di silenzio, l'audio in piu' ha un tetto. Registro: `conversazione richiesta`, `trascrizione: primo audio inviato a ElevenLabs`, `prima trascrizione parziale ricevuta`, `conversazione chiusa dal Nucleo` con i secondi inviati; l'estensione scrive ogni tocco e il motivo di ogni chiusura. Se l'utente parla sopra Melissa, la voce si ferma ed esce `voice.bargein {text, trigger}` (`trigger`: `energy` con cancellazione dell'eco hardware, `speech` quando lo decide il testo parziale). Eco: prima la cancellazione hardware (voice processing), se fallisce il filtro software sul testo (parole in comune con quello che Melissa sta dicendo) |
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
non ha il permesso di leggere il saldo). Senza chiave o a qualsiasi errore: AVSpeechSynthesizer, voce di sistema
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
`bacheca` restituisce `[{at, sessionId, project, kind, summary, file?}]`. Radici dei progetti
configurabili in `~/.bottega/memoria/config.json`.
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
  `jobs: Job[]`, `system: SystemStats | null`, `assistant: AssistantState`
  Si manda solo con la Home visibile: un'istantanea arrivata con la Home nascosta si manda quando torna
  davanti (`retainContextWhenHidden` la tiene viva, ma ridisegnarla di nascosto e' lavoro sprecato).
  Anche il cruscotto (`stats`) si ricalcola solo con la Home visibile.
- `{type: "fuoco", focused}`: la finestra della Bottega davanti o dietro, a `ready` e a ogni cambio (la sfera riposa)
- `{type: "focus", path}`
- `{type: "memoria", query, results: MemoryItem[]}` risposta a una ricerca
- `{type: "assistant", state: AssistantState}` aggiornamento leggero mentre Melissa parla
- `{type: "view", view}` apre una stanza: `plancia`, `lavori`, `memoria`, `melissa`, `cruscotto`
  (comandi `bottega.openMelissa`, `bottega.openCruscotto`)
- `{type: "stats", stats: Stats}` il cruscotto (vedi sotto), in risposta a `stats.request` e poi a ogni
  scansione completa (ogni 2 minuti) se i numeri sono cambiati; `{type: "stats", stats: null, error}`
  se i registri non si leggono

Plancia -> estensione (`type` + campi):
`ready`, `refresh`, `open`, `here`, `claude {path, id?}`, `finder`, `xcode`, `push`,
`job.new {path, task}`, `job.focus {id}`, `job.stop {id}`, `job.remove {id}`,
`memoria.search {query, project?}`, `memoria.remember {text, project?}`,
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

### Il cruscotto (`Stats`, da `src/stats.ts`)

Fonte: i registri di Claude Code `~/.claude/projects/<cartella>/<sessione>.jsonl` piu'
`<sessione>/subagents/*.jsonl` (i sottoagenti appartengono alla sessione che li ha lanciati).
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
  ascAt: number; admobAt: number;   // 0 = mai letto
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
| `widget.reload` | | | WidgetKit ridisegna subito il widget: l'estensione lo manda dopo aver riscritto `stato.json` |

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
Sandbox con sola lettura di `~/.bottega/stato.json`. Si aggiorna ogni 15 minuti, o subito con `widget.reload`. Un tocco
apre `bottega://andreapiani.bottega-home/briefing` (lo riceve il Nucleo e lo gira alla Bottega).

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
// Snapshot: work: WorkItem[] (prima chi ti aspetta), workCounts: WorkCounts
```

Da `registro ~/.claude/sessions`: `busy` = in corso, `idle` = ti aspetta, `shell` = nel terminale. Un lavoro della
Bottega appena partito, che non ha ancora la sua sessione, assorbe la sessione nata dopo nella stessa cartella (niente
doppioni). `workItems` e `workCounts` (in `src/jobs.ts`) sono le sole funzioni che contano: frasi della Home e di
Lavori, numero sulla scheda Lavori, barra di stato, barra dei menu del Nucleo, `stato.json` e gli strumenti di Melissa
`lavori_elenco` e `sessioni_attive`. Messaggio `bacheca.sessione {sessionId}` -> `{type:'bacheca.sessione', sessionId,
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

Melissa come Jarvis, con il suo carattere, nella barra laterale DESTRA della Bottega (secondary side bar).
Contributo standard di VS Code 1.140, senza API proposte e senza patch:

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
- `board: Record<sessionId, {at, kind, summary, file?}[]>`: le ultime voci della bacheca della Memoria per ogni sessione
  viva (al massimo 4 per sessione, ultime 3 ore)
- `brain: BrainState`
- separati: `{type:'bacheca.sessione', sessionId, items}` (risposta a «Le ultime tre ore»), `{type:'visibile', visible}`,
  `{type:'fuoco', focused}` (la finestra della Bottega davanti o dietro: a `ready` e a ogni cambio); un campo assente in
  `stato` vuol dire invariato

```ts
type Provider = 'agnes' | 'openrouter' | 'apple' | 'deepseek';
type Effort = 'rapido' | 'normale' | 'profondo';
interface BrainOption {
  provider: Provider; model: string; label: string;       // "Claude Sonnet 5.5"
  note: string;                                            // "gratis", "a consumo", "sul Mac"
  price?: { in: number; out: number };                     // dollari per milione di token (OpenRouter)
  available: boolean; why?: string;                        // perche' no: "senza credito (402)", ...
}
interface BrainState {
  current: { provider: Provider; model: string; label: string };
  effort: Effort;
  options: BrainOption[];
  credit?: { openrouter?: number };                        // dollari rimasti, se l'API lo dice
  accounts: Account[];                                     // i conti dei servizi, solo dati veri
  checkedAt: number;
}
interface Account {
  id: 'agnes' | 'openrouter' | 'deepseek' | 'elevenlabs';
  label: string; text: string; tone: 'ok' | 'attesa' | 'male';
  local?: boolean;                                         // contato dalla Bottega, non letto dal servizio
}
```

### Barra -> estensione

`ready`, `converse` (apre o chiude la conversazione a voce), `ask {text}`, `voice.toggle`,
`brain.set {provider, model}`, `effort.set {effort}`,
`job.focus {id}`, `job.write {id, text}` (istruzioni a un lavoro della Bottega), `open {path}`, `claude {path, id}`
(riprendi qui una sessione aperta altrove), `bacheca.sessione {sessionId}`, `home {view}` (porta la Home su una stanza),
`comando {id}` (comandi rapidi: `briefing`, `regole`, `lavori`, `cruscotto`, `continua`, `cerca`).

### Cervelli

Tutti e tre i cervelli in rete parlano l'API compatibile OpenAI con gli strumenti, in streaming:

| provider | url | chiave | modelli | impegno |
|---|---|---|---|---|
| agnes | `https://apihub.agnes-ai.com/v1/chat/completions` | `AGNES_API_KEY` (`~/.secrets/agnes-ai.env`) | `agnes-3.0-flash` | `reasoning_effort`: none / low / high |
| openrouter | `https://openrouter.ai/api/v1/chat/completions` | `OPENROUTER_API_KEY` (`~/.secrets/openrouter-vision.env`) | i piu' recenti per famiglia dall'elenco vero (`/api/v1/models`, cache 24 h): Claude Sonnet, Claude Opus, Gemini Flash, GPT | `reasoning: {effort}`: low / medium / high |
| deepseek | `https://api.deepseek.com/chat/completions` | `DEEPSEEK_API_KEY` (`~/.secrets/deepseek-harness.env`) | `deepseek-chat` | non disponibile finche' l'API risponde 402 |
| apple | Nucleo, cervello Foundation Models con strumenti (build 16, `src/cervello.ts` della sessione nativo) | | sul Mac | |

**Agnes e' sempre il cervello primario** (decisione di Andrea, 2 ottobre 2026). Un altro cervello si usa solo se Andrea
lo sceglie (dalla barra o a voce con lo strumento `cervello_cambia {cervello?, impegno?}`: «usa Claude», «pensa piu' a
fondo», «torna ad Agnes») e vale per quella conversazione: si torna ad Agnes da soli quando la conversazione si chiude,
dopo 15 minuti senza domande, al riavvio della Bottega e dopo qualsiasi errore (un 401 o un 402 mette anche il cervello
da parte per un'ora). La scelta manuale non si salva mai; si ricorda solo l'impegno (`globalState`). Apple Intelligence
resta la riserva automatica solo quando Agnes non risponde (429, rete).
Il saldo OpenRouter si mostra com'e': l'API accetta un piccolo scoperto, quindi conta solo un 402 vero.

### I conti dei servizi (in testa alla barra)

Solo dati veri, al massimo ogni 5 minuti (mai a ogni domanda):
- Agnes: nessun endpoint di saldo (`/user/balance` risponde 404). Si mostra se risponde, le richieste fatte oggi dalla
  Bottega (contate in `globalState`) e i 429 degli ultimi 10 minuti (limite di circa 20 richieste al minuto).
- OpenRouter: `GET /api/v1/credits` (`total_credits - total_usage`); sotto 1 $ in attesa, sotto zero «va ricaricato».
- DeepSeek: `GET https://api.deepseek.com/user/balance` (`is_available`, `balance_infos`).
- ElevenLabs: la chiave non puo' leggere l'account; i caratteri del mese da `~/.bottega/nucleo/usage.json`, dichiarati
  come conteggio della Bottega.

### Le mani di Melissa

Strumenti nuovi: `cervello_cambia {cervello?, impegno?}`, `sessione_leggi {progetto}` (cosa ha fatto una sessione dalla
coda della sua trascrizione, `src/mani.ts`: ultima richiesta, ultima risposta, strumenti, file, se aspetta; per le
sessioni aperte altrove e' sola lettura), `cruscotto_mostra {progetto?, giorni?}` (la Home va sul cruscotto e manda
`{type:'crus.focus', path?, period?}`: il cruscotto cambia periodo e accende il progetto sul cielo e in classifica
mentre Melissa risponde; un comando arrivato prima dei dati si applica al loro arrivo). In conversazione, quando un
lavoro comincia ad aspettare, Melissa lo dice una volta («Peak ti aspetta»).

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

## 7. La Bottega nativa: Apple Intelligence, Metal, macOS 27

Tutto sul Mac, solo framework Apple. Apple Intelligence (FoundationModels) solo per compiti brevi e strutturati,
con generazione guidata (`@Generable`) dove serve un dato, sessioni preparate prima dell'uso (`prewarm`), finestra di
contesto misurata con `tokenCount` prima dell'invio (su macOS 27.0 `contextSize` = **8192** token), errori tradotti
da `LanguageModelError` (un solo punto: `CervelloErrori.translate`, anche per `Intelligence.swift`; il vecchio
`GenerationError` e' deprecato e non si usa piu'). I riassunti lunghi delle sessioni restano ad Agnes.
Comandi del Nucleo smistati da `Nativo.handle` (Service.swift) e `NativoCLI.run` (CLI.swift).

### 7.1 Apple Intelligence come cervello, con gli strumenti

`src/cervello.ts`, dentro il selettore dei cervelli della sezione 6. Agnes risponde sempre finche' risponde (scelta di
Andrea, 2 ottobre 2026); Apple Intelligence entra come riserva quando Agnes da' 429, errore di rete o 5xx: lo stesso
turno passa subito al Mac CON gli strumenti (nessuna attesa cieca sul 429) e per 2 minuti i turni vanno diretti al Mac
(interruttore, `BrainRouter`). Melissa dice il cambio solo quando succede ("Agnes non risponde, ti rispondo dal Mac.",
"Agnes e' tornata."). Scelto a mano nella barra, Apple risponde sempre lui, con gli strumenti; se non risponde si torna ad
Agnes. Se anche Apple fallisce resta il vecchio ripiego `ai.generate` senza strumenti.

Apple ha la stessa forma degli altri cervelli: `appleOpenAiStream(nucleo, {effort})` ha la firma di `LlmStreamFn`
(messaggi e strumenti OpenAI dentro, `{content}` e `{tool_call:{index,id,name,arguments}}` fuori, un passo per
chiamata). Dietro c'e' una sola sessione FoundationModels per turno: il passo finisce con la tool_call, il messaggio
`tool` successivo con lo stesso `tool_call_id` diventa `tool.result` e la sessione riprende. Strumenti per Apple:
sottoinsieme ordinato `APPLE_TOOLS` (14), con le stesse conferme di Melissa per push e stop; l'impegno (`rapido`,
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
"ore": { "oggi": 135, "ieri": 220, "settimana": 1180, "giorni": [{ "date": "YYYY-MM-DD", "minuti": 80 }] },
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
agganciata 30/12, cielo 30/15; con Riduci movimento un fotogramma quando cambia qualcosa. Il respiro della sfera
accelera con le sessioni al lavoro (da `menubar.update`: `busy` 0 = 1,4 rad/s, 1 circa 1,9, 3 circa 2,5, massimo 3).
Comandi: `metal.stats` (costi per fotogramma per cliente, fps, carico), `metal.load {busy, waiting}`, `metal.pulse {key,
project}`; `--cli metal-bench [--frames N] [--width W --height H]`. Misure fuori schermo (M2): cielo 1920x1230 11-47 µs
di CPU e 0,3-0,6 ms di GPU per fotogramma, 4K 0,64 ms; sfera grande 2,4-3,1 ms di GPU, agganciata 0,9 ms. Il widget non
usa Metal (WidgetKit archivia viste statiche).

### 7.7 L'Osservatorio

Finestra nativa (SwiftUI + Metal, Liquid Glass) del Nucleo: il cielo dei progetti in Metal, pannelli di vetro con oggi,
settimana, "Quando lavori" (superficie Chart3D giorno x ora x minuti), progetti, token per progetto, categorie; modalita'
"Secondo schermo". Comandi: `osservatorio.open {data?, secondoSchermo?}` -> `{open, hasData, stars}` (senza dati emette
`osservatorio.ready`), `osservatorio.data {data}` (`data` = `{stats, live?, categorie?}` o lo `Stats` da solo),
`osservatorio.close`; evento `osservatorio.closed`. Ultimi dati in `~/.bottega/nucleo/osservatorio.json` (600).
Si apre con il comando `bottega.openOsservatorio`, il link `bottega://.../osservatorio`, la voce "Apri l'Osservatorio"
della barra dei menu del Nucleo (apre subito con gli ultimi numeri e chiede quelli nuovi) e l'intent `ApriOsservatorio`.
L'estensione (`src/osservatorio.ts`) risponde a `osservatorio.ready` e rimanda i dati dopo ogni calcolo del cruscotto
solo se la finestra e' aperta e i numeri sono cambiati. Plancia -> estensione: `osservatorio.open` (pulsante «Apri nell'Osservatorio» sotto il cielo del cruscotto),
`cielo.diag` e `sfera.diag {motore: 'webgpu'|'canvas'|'svg', motivo, gpu, isSecureContext, crossOriginIsolated,
userAgent}` (con quale motore gira e perche', scritto nel registro).

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
iPhone (ios/, SwiftUI)  --HTTP sulla rete Tailscale-->  estensione: src/ponte.ts  --stdio-->  Nucleo: ponte.voce, ponte.qr
   sfera Metal del Nucleo (stessi file)                   Melissa (assistant.ts), lavori (jobs.ts)
   ascolto: SFSpeechRecognizer it-IT sull'iPhone
```

Il Mac deve essere acceso con la Bottega aperta: il ponte vive nell'estensione. Nessun server di terzi in mezzo,
nemmeno le VM: iPhone e Mac si parlano direttamente dentro Tailscale (WireGuard, gia' cifrato).

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
- `GET /v1/stato` -> `{versione, mac, ora, melissa: {stato, cervello, parziale?, registro: [{chi: tu|melissa|azione,
  testo, alle}]}, lavori: [{chiave, origine: bottega|altrove, stato, progetto, titolo, da, jobId?}], conti: {inCorso,
  tiAspetta, inCoda, vive}}`. Registro: gli ultimi 30 della barra di Melissa. Lavori: i primi 40 di `snapshot.work`.
- `GET /v1/eventi` -> `text/event-stream`: subito una riga `data: <stato>`, poi una a ogni cambio di Melissa o dei
  lavori (al massimo tre al secondo), `: ping` ogni 25 s.
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
- Errori: `{errore}` in italiano, da mostrare cosi' com'e'.
- Comando «Collega l'iPhone» (`bottega.ponte.collega`): pagina con il QR (dal Nucleo) di
  `bottega://collega?host=<nome MagicDNS>&ip=<100.x>&porta=7790&token=<gettone>` e il pulsante per copiarlo.

### 9.2 Il Nucleo (`nucleo/Sources/Ponte/PonteComandi.swift`)

- `ponte.voce {testo}` -> `{path, engine: elevenlabs|apple, seconds}`: `SpeechFile.render` (ElevenLabs con la voce di
  Melissa, ripiego sulla voce di sistema) in un WAV sotto la cartella temporanea `bottega-ponte/`. L'estensione lo
  legge e lo cancella; i file piu' vecchi di dieci minuti li toglie il Nucleo al giro dopo.
- `ponte.qr {testo}` -> `{png}`: QR in base64 (CoreImage, correzione M, 12 px per modulo).
- `ponte.flusso.apri {id}` -> `{ok}`, `ponte.flusso.testo {id, testo}`, `ponte.flusso.fine {id}`,
  `ponte.flusso.ferma {id}`: lo stesso socket ElevenLabs di Melissa (`eleven_v4_turbo`, la voce di Avo, text-to-dialogue
  stream-input), ogni frase mandata e svuotata subito come in `Speaker.swift`. Eventi `ponte.audio {id, pcm}`,
  `ponte.audio.fine {id}` (dopo l'ultima frase), `ponte.audio.errore {id, errore}` (anche dopo 8 s senza audio). Un
  turno alla volta; il socket resta caldo 90 s dopo l'ultima frase.

### 9.3 L'app (`ios/`)

- Progetto XcodeGen (`ios/project.yml`, `cd ios && xcodegen`), bundle `com.andreapiani.bottega.ios`, iOS 27+, solo
  iPhone, schema `bottega://` per il collegamento. Versione e build in `ios/Version.xcconfig`, scritte da
  `scripts/bump-build.sh`: sempre uguali a quelle della Bottega. Icona: `swift brand/icon.swift <out> --ios`.
- Sfera: `nucleo/Sources/Orb/OrbRenderer.swift`, `OrbShaders.metal` e `nucleo/Sources/Voice/AudioLevels.swift` sono
  compilati anche nell'app, non copiati; `ios/Bottega/Sfera/NucleoSuIPhone.swift` rifa' quel poco del Nucleo che
  chiamano (`MetalEngine`, `Log`, `Out`, `Nucleo.bundle`, `OrbPanel`). Chi cambia l'interfaccia di quei tre file
  compila anche l'app.
- Ascolto sull'iPhone come sul Mac: `SFSpeechRecognizer` it-IT, frase chiusa dopo 1,8 s senza parole nuove, otto
  secondi senza parole chiudono la conversazione; «basta», «a dopo», «chiudi» la chiudono a voce. Risposta da
  `/v1/parla`: ogni pezzo di audio va in coda su un `AVAudioPlayerNode` appena arriva (`FlussoVoce.swift`), la sfera
  si muove con il suono vero (tap sul mixer, `AudioLevels`). Un tocco sulla sfera mentre parla chiude la connessione
  e la risposta si ferma anche sul Mac. Senza audio dal Mac: la voce italiana di iOS con il testo intero. Gettone nel portachiavi (`AfterFirstUnlockThisDeviceOnly`),
  nome e porta nelle preferenze.
- Rete: prima il nome MagicDNS (eccezione ATS per `ts.net`, HTTP dentro Tailscale), se non si risolve l'indirizzo
  100.x. Eventi ripresi da soli con attesa crescente fino a 30 s, fermi con l'app dietro.
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
Toccare una notifica apre l'app (ATTESA, FINITO: stanza Lavori; CONFERMA: Melissa).
Con Andrea al Mac: ATTESA, FINITO e REGOLA si considerano viste (allontanandosi non arriva una raffica per ogni
sessione ferma; arriva solo chi comincia ad aspettare mentre e' via); la CONFERMA resta in sospeso e parte quando si
allontana, se la domanda e' ancora aperta. Un invio fallito per la rete si riprova dopo un minuto. All'avvio della Bottega i
primi 60 secondi fanno da linea di partenza: quello che c'e' gia' non suona. `mai` spegne solo le notifiche: Live
Activity e widget restano.

**Live Activity** (`apns-push-type: liveactivity`, attributi `BottegaAttivita` in `ios/Condiviso/BottegaAttivita.swift`).
`content-state` = `{inCorso, tiAspetta, vive, righe: [{progetto, stato, da}], segui?: {progetto, passo, stato}, aggiornato}` (al massimo tre righe,
prima chi ti aspetta; `da` e `aggiornato` in ms dal 1970).
- Vive finche' ci sono sessioni AL LAVORO (`inCorso`) o una sessione seguita dall'iPhone (`segui`, 9.5, anche se
  aspetta; allora l'avvio dice «Segui <progetto>»): quelle ferme contano come «ti aspetta» tutto il giorno e
  non la farebbero mai finire. Chi aspetta resta nel contenuto, in ambra, finche' l'attivita' vive.
- Avvio con il token `avvio` quando ci sono sessioni al lavoro e non c'e' un'attivita' aperta:
  `{aps: {timestamp, event: "start", "content-state", "attributes-type": "BottegaAttivita", attributes: {mac},
  alert: {title: "Bottega", body: "<n> sessioni Claude al lavoro"}}}`, priorita' 10. Vale anche con Andrea al Mac.
- Aggiornamento con il token `attivita` a ogni cambio, al massimo ogni 15 s (priorita' 5; 10 se cambia `tiAspetta`):
  `{aps: {timestamp, event: "update", "content-state", "stale-date": ora + 15 min}}`.
- Se non cambia niente, un aggiornamento ogni 10 minuti comunque, cosi' l'attivita' non diventa vecchia.
- Chiusa a mano sull'iPhone mentre ci sono sessioni: non riparte finche' non passano 2 minuti senza sessioni. Un
  avvio rifiutato da APNs si riprova dopo 2 minuti. Dopo `end` il Mac toglie il token `attivita` dal registro.
- Fine dopo 2 minuti senza sessioni: `{aps: {timestamp, event: "end", "content-state", "dismissal-date": ora + 5 min}}`.

**Widget** (`apns-push-type: widgets`, `{aps: {"content-changed": true}}`, priorita' 5) a ogni cambio di `tiAspetta`
o `inCorso`, al massimo uno ogni 5 minuti (salvo `tiAspetta` che sale). Il widget rilegge `GET /v1/stato` dal ponte
con il collegamento condiviso; se il Mac non risponde mostra l'ultimo stato salvato dall'app (`StatoMac.ultimo()`)
con la sua eta'.

**Condiviso tra app e widget** (`ios/Condiviso/`): gruppo `group.com.andreapiani.bottega.ios`, portachiavi
`$(AppIdentifierPrefix)com.andreapiani.bottega.condiviso` (il gettone), `StatoMac`, `BottegaAttivita`, `Tinte`.

**Estensione dei widget** (`ios/BottegaWidget/`, bundle `com.andreapiani.bottega.ios.widget`, con app group,
portachiavi condiviso e `aps-environment` per le push dei widget; il token lo scrive in `Condiviso.chiaveTokenWidget`
e l'app lo manda al Mac): widget «Sessioni»
(piccolo, medio, schermata di blocco), la Live Activity (Dynamic Island e schermata di blocco), il controllo
«Parla con Melissa» del Centro di Controllo (apre `bottega://melissa?ascolta=1`).

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
  copia di `~/.claude/CLAUDE.md`. Le sessioni di Cline non entrano ancora nella memoria da sole: Claude Code ha gli
  hook, Cline per ora no.
- **Chiave**: la Bottega non la tocca. Cline la tiene in `~/.cline/data/secrets.json`, si imposta dalle sue
  impostazioni.
