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
| `voice.listen` | `mode`: `push` o `utterance`, `locale` | `backend` | trascrizione ElevenLabs in tempo reale (vedi sotto). `utterance` finisce da sola alla prima frase che il server chiude (~0.8 s di silenzio), o dopo 8 s se nessuno parla; `push` resta aperto fino a `voice.stop` (massimo 120 s). Se Melissa sta parlando viene zittita: fuori dalla conversazione il microfono e' chiuso mentre lei parla. Se ElevenLabs non risponde: risposta di errore ed evento `voice.state {state:"error", message}` |
| `voice.stop` | | | chiude l'ascolto, chiude a mano la frase (commit) ed emette l'ultimo `voice.final` (~0.25 s dopo) |
| `voice.speak` | `text`, `voice?`, `append?: bool`, `final?: bool`, `model?` | `engine` | evento `voice.spoken {text, engine}` quando un pezzo e' stato davvero ascoltato. Senza `append` il testo e' una risposta intera. Con `append: true` l'estensione manda i pezzi man mano che l'LLM li scrive: la prima frase (o il primo inciso lungo) parte subito, poi una frase alla volta; `final: true` (anche con `text` vuoto) chiude il turno. `model` sceglie il modello ElevenLabs (default `eleven_v4_turbo`). `voice`: `apple` forza la voce Apple, `com.apple...` sceglie una voce Apple precisa, qualsiasi altro valore e' un voice id ElevenLabs |
| `voice.stopSpeaking` | | | interruzione (barge-in): silenzio subito, coda svuotata |
| `voice.converse.start` | `locale?` | `echoCancellation`, `backend` | modalita' conversazione: microfono sempre aperto, ogni frase che il server chiude (~0.8 s di silenzio) e' un turno dell'utente (`voice.final {text, mode:"converse"}`). Si manda solo l'audio intorno alla voce (300 ms prima, 1.5 s dopo). Se l'utente parla sopra Melissa, la voce si ferma ed esce `voice.bargein {text, trigger}` (`trigger`: `energy` con cancellazione dell'eco hardware, `speech` quando lo decide il testo parziale). Eco: prima la cancellazione hardware (voice processing), se fallisce il filtro software sul testo (parole in comune con quello che Melissa sta dicendo) |
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
`src/continua.ts`, `src/clienti.ts`, `src/notte.ts`, `src/dimenticati.ts`, `src/ricerca.ts`) e arriva alla
plancia nello `snapshot` o come risposta a una richiesta. File su disco, tutti fuori dal repository:

| file | chi lo scrive | cosa contiene |
|---|---|---|
| `~/.bottega/regole-cache.json` | regole | esiti per progetto (chiave: HEAD), visibilita' GitHub (24 h), app-ads.txt (6 h) |
| `~/.bottega/regole.json` | Andrea (facoltativo) | `{"pubbliciPerScelta": ["owner/nome"], "commitDaControllare": 10}`; la Bottega (`andreapianidev/bottega-ide`) e' pubblica per scelta anche senza questo file |
| `~/.bottega/radar/stato.json` | radar | ultimo dato di App Store Connect e AdMob, con la sua eta' |
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
  id: 'build' | 'push' | 'remoto' | 'pubblico' | 'rilascio' | 'segreti' | 'app-ads';
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
}
interface Briefing {
  date: string;            // YYYY-MM-DD
  at: number;
  text: string;            // quello che Melissa dice (circa trenta secondi)
  points: { kind: 'ore'|'lavori'|'store'|'soldi'|'regole'|'dimenticati'|'notte'; text: string; act?: RuleAction }[];
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
non avvia mai un lavoro da solo), `briefing`, `vedetta`, `continua?progetto=`, `cerca?q=`.

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
Melissa di Avo Agency AI, che ha una sfera sua e la scorciatoia Cmd+Opzione+M). Melissa sta in due posti dell'IDE:

- la vista `bottega.melissa` nella barra laterale (icona di Melissa): una webview (`media/sfera.js`, `sfera.css`) con la
  sfera disegnata in Canvas 2D come quella della pagina di Melissa, lo stato, l'ultima frase e un campo per scriverle.
  Riceve `{type:'assistant', state: AssistantState}`; manda `ready`, `converse` (apre o chiude la conversazione),
  `ask {text}`, `open` (pagina di Melissa nella Home), `voice.toggle`. Quando Melissa comincia ad ascoltare la vista si
  mostra senza rubare il fuoco. Gira solo se visibile, con riduci movimento resta ferma.
- la barra di stato: `Melissa` con l'icona dello stato (microfono, ascolto, rotella che pensa, altoparlante, avviso),
  colorata col sodio quando e' attiva; un clic apre o chiude la conversazione.

Con `schermo` torna il comportamento di prima (sfera grande in conversazione, piccola agganciata con
`bottega.voice.orbAlwaysVisible`).

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
`src/connettori.ts` (scoperta e mappa), `src/connettori-mappa.ts` (la mappa), `src/mcp.ts` (client MCP diretto),
`src/delega.ts` (deleghe a `claude -p`), `src/posta.ts` (rubrica e fili), `src/connettori-host.ts` (la stanza,
agganciata in `extension.ts` con `registerConnettori` e `handleConnettori`), `media/connettori.js` e `.css` (la stanza
Connettori, ottava scheda della plancia).

### 5.1 Due tipi di connettori

| tipo | da dove | come si usa | costo |
|---|---|---|---|
| claude.ai (Gmail, Google Calendar, Vercel, Stripe...) | `claude mcp list` | solo delega a `claude -p` | da 20 a 70 s, da 0,14 a 0,46 $ |
| locale stdio (mail-mcp, asc-mcp, google-play...) | `~/.claude.json`, `mcpServers` utente e per progetto | client MCP diretto | istantaneo, gratis |
| remoto http e plugin | `claude mcp list` e `~/.claude.json` | delega (oggi non usati) | come claude.ai |

`claude mcp list` controlla la salute di ogni server ed e' lento (circa 25 s): si lancia con `nice` dalla home, al
massimo una volta al giorno (cache in globalStorage, `connettori-mcp-list.json`) o su richiesta. Riga per server:
`<nome>: <destinazione> - <icona> <stato>`; stati `Connected` -> `connesso`, `Needs authentication` -> `da
autenticare`, `Not configured` -> `non configurato`, `Failed` -> `errore`. I server in `~/.claude.json` che l'elenco
non ha visto (quelli di progetto) entrano come `sconosciuto`. Dalla configurazione locale si leggono solo nomi e forma:
comando, argomenti ed `env` restano in memoria il tempo di avviare il server, mai in cache, log o messaggi.

Strumenti di Claude Code: `mcp__<nome con i caratteri fuori da [A-Za-z0-9_-] sostituiti da _>__<strumento>`, per
esempio `mcp__claude_ai_Gmail__search_threads`, `mcp__plugin_design_slack__...`, `mcp__mail-mcp__search_messages`.

### 5.2 Capacita' e mappa

Capacita': `posta`, `calendario`, `deploy`, `store`, `file`, `pagamenti`, `pubblicita`, `ricerca`. La mappa
(`src/connettori-mappa.ts`) lega a ogni capacita' dei nomi puliti (minuscolo, senza `claude.ai ` e `plugin:<x>:`),
esatti o espressioni tra barre. L'impostazione `bottega.connettori.mappa` aggiunge voci, per esempio
`{ "posta": ["mio-imap"] }`. Una capacita' e' accesa se almeno un connettore mappato e' connesso, o e' un server locale
stdio a livello utente non ancora controllato.

### 5.3 Sola lettura, sempre

`soloLettura(nome)`: il nome breve dello strumento comincia per `search`, `list`, `get` o `read` e non contiene parole
che scrivono (`send`, `reply`, `forward`, `delete`, `move`, `set`, `update`, `create`, `trash`, `label`, `save`,
`token`...). Il client diretto (`ClientMcp.chiama`) rifiuta il resto prima ancora di avviare il server; la delega passa
a `--allowedTools` solo strumenti che superano lo stesso filtro.

### 5.4 Deleghe (`claude -p`)

```
nice -n 10 claude -p --output-format json --model <bottega.connettori.modello, default haiku>
  --permission-mode dontAsk --no-session-persistence --max-budget-usd <min(tetto residuo, 0,80)>
  --tools "" --allowedTools <strumenti di sola lettura, separati da virgola>
  (prompt su stdin, cwd ~/.bottega/connettori, env BOTTEGA_DELEGA=1)
```

Il prompt chiede SOLO JSON, con lo schema scritto dentro. Una delega alla volta, in coda, timeout 180 s. Uscita
letta: `{ result, is_error, subtype, total_cost_usd, num_turns }`; dentro `result` il JSON si estrae anche da un blocco
```` ```json ````. Tetto giornaliero `bottega.connettori.tettoGiornalieroUsd` (default 1): se la spesa di oggi piu' la
stima supera il tetto, la delega non parte. Stima = media delle ultime cinque deleghe riuscite della stessa capacita',
altrimenti 60 s e 0,45 $. Spesa di oggi e tetto sono sempre scritti in testa alla scheda Connettori, anche a zero.

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
// ~/.bottega/connettori/<capacita>.json, l'ultima delega di quella capacita'
interface EsitoDelega { capacita: string; at: number; ok: boolean; costo: number; durataMs: number; turni?: number; errore?: string; data?: unknown }
// ~/.bottega/connettori/spesa.json
interface Spesa { giorni: Record<'YYYY-MM-DD', number>; storico: { at; capacita; costo; durataMs; ok }[] } // 60 giorni, 40 deleghe
```

### 5.5 Posta per progetto

```ts
// ~/.bottega/rubrica.json (600, mai nel repository)
type Rubrica = Record<string /* percorso del progetto */, { indirizzi: string[]; domini: string[] }>;
// ~/.bottega/connettori/posta-fili.json (600)
interface FileFili { at: number; giorni: number; fonti: { locale?: FonteStato; gmail?: FonteStato }; fili: Filo[] }
interface FonteStato { nome: string; at: number; n: number; costo?: number; durataMs?: number; errore?: string }
interface Filo { id: string /* gmail:<threadId> | mail:<account>:<mailbox>:<id> */; fonte: 'gmail' | 'mail'; threadId?: string;
  da: string; indirizzo: string; oggetto: string; data: string /* ISO */; nonLetto: boolean; anteprima: string; link?: string }
```

Fonti: il server di posta locale (un solo `search_messages {since, limit: 300, includeBody: false}`: mittente,
oggetto, data e letto, mai il corpo) e Gmail di claude.ai (UNA delega con `search_threads`: i mittenti e i domini in
rubrica, `newer_than:Nd {from:a from:dominio}`, piu' `newer_than:Nd is:unread in:inbox category:primary` per i
mittenti nuovi). Ogni fonte sostituisce solo i suoi fili. Link Gmail: `https://mail.google.com/mail/u/0/#all/<threadId>`;
per la posta locale si apre Mail.

Regole di assegnazione: l'indirizzo esatto vince sul dominio; tra i domini vince il piu' lungo (`shop.cliente.it`
batte `cliente.it`, un sottodominio del mittente vale); a parita' il filo va a tutti i progetti. Chi non corrisponde
va in "Da assegnare", raggruppato per mittente; per i fornitori di posta (gmail.com, libero.it...) si offre solo
l'indirizzo, mai il dominio. Suggerimenti: i domini di `package.json` (`homepage`), `vercel.json` (`alias`, `domains`),
e degli URL in README e CLAUDE.md, senza quelli generici (github.com, vercel.app, apple.com, google.com...), senza quelli
gia' in rubrica e senza `bottega.posta.dominiIgnorati`.

Impostazioni: `bottega.posta.giorni` (7), `bottega.posta.aggiornaOgniMinuti` (0, solo su richiesta; aggiorna la fonte
locale), `bottega.posta.gmailOgniMinuti` (0; se acceso, Gmail in automatico al massimo ogni 120 minuti).

### 5.6 Messaggi plancia <-> estensione

| messaggio | campi | risposta |
|---|---|---|
| `connettori.request` | | `connettori` e `posta`; avvia `claude mcp list` se la cache ha piu' di un giorno |
| `connettori.refresh` | | rilegge `claude mcp list` adesso; `connettori` con `aggiornando: true`, poi il risultato |
| `posta.refresh` | `fonte`: `locale` (default) o `gmail` | `posta` con `aggiornando`, poi i fili nuovi |
| `rubrica.add` | `path`, `voce` (indirizzo se ha la chiocciola, altrimenti dominio) | `posta` |
| `rubrica.remove` | `path`, `voce` | `posta` |
| `posta.apri` | `id` del filo | apre Gmail nel browser o Mail |

Estensione -> plancia (instradati da `plancia.js` alla stanza `BottegaConnettori`):

```ts
{ type: 'connettori', stato: ConnettoriStato & { deleghe: StatoDeleghe } }
{ type: 'posta', stato: PostaStato }
interface ConnettoriStato { aggiornatoAt: number; aggiornando: boolean; errore?: string; connettori: Connettore[];
  capacita: { id; nome; cosa; accesa: boolean; fonti: string[] }[] }
interface Connettore { nome; pulito; tipo: 'claude.ai' | 'plugin' | 'locale' | 'remoto';
  stato: 'connesso' | 'da autenticare' | 'non configurato' | 'errore' | 'sconosciuto'; prefisso: string; capacita: string[];
  diretto: boolean; ambito: 'claude.ai' | 'utente' | 'progetto' | 'plugin'; progetti?: string[] }
interface StatoDeleghe { inCorso: string | null; coda: string[]; spesaOggi: number; tetto: number; modello: string;
  stime: Record<string, { secondi: number; usd: number }> }
interface PostaStato { aggiornatoAt; aggiornando: 'locale' | 'gmail' | null; errore?; giorni; fonti;
  disponibili: { locale: string | null; gmail: boolean }; deleghe: StatoDeleghe;
  progetti: { path; name; voce; fili: Filo[] /* max 30 */; nonLetti }[];
  daAssegnare: { indirizzo; dominio; generico: boolean; nome; n; nonLetti; ultimo: Filo }[];
  suggerimenti: { path; name; domini: string[] }[]; tuttiProgetti: { path; name }[] }
```

Comando: `bottega.openConnettori` apre la Home sulla stanza Connettori.
