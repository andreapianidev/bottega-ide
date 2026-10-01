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
| `orb.dock` | | `presentation` | sfera agganciata: piccola (~56 pt, pannello 72x72 pt), sempre a schermo finche' il Nucleo gira, su tutte le Scrivanie, non prende mai il fuoco, senza didascalia, trascinabile con una posizione sua (default in basso a destra sopra il Dock, margini 24 pt). Se la grande e' visibile si rimpicciolisce nella piccola. Costo misurato fuori schermo: 12 fps a riposo, ~13 µs di CPU e ~0.7 ms di GPU per fotogramma (CPU ~0.02%, GPU ~1%); 30 fps se lo stato e' listening o speaking. Lo stato `error` la tinge d'ambra; gli altri stati cambiano solo il colore (per ingrandirla l'estensione manda `orb.show`) |
| `orb.hide` | | | sfera nascosta del tutto (solo quando Andrea spegne la voce); dopo 2 minuti nascosta libera anche la memoria grafica |
| `orb.state` | `state`: `idle`, `listening`, `thinking`, `speaking`, `error`; `caption?` | | la sfera usa anche il livello audio interno. La sfera segue da sola la voce (ascolto, pensiero dopo `voice.final`, parlato) e la didascalia mostra la trascrizione parziale o la frase detta; lo stato e la didascalia mandati qui valgono fino alla prossima transizione della voce |
| `hotkey.register` | `key` (es. `space`), `modifiers` (es. `["option"]`) | `label` | eventi `hotkey.down {key}`, `hotkey.up {key}`: tieni premuto per parlare. Default Option+Space. Cmd+Option+M e' rifiutata (e' di Melissa) |
| `hotkey.unregister` | | | |
| `notify` | `id`, `title`, `body`, `actions?: [{id, title}]`, `subtitle?`, `sound?` (default true) | | eventi `notify.clicked {id, action?}` (`action` assente = clic sulla notifica, `dismiss` = chiusa) |
| `menubar.update` | `busy`, `waiting`, `queued`, `title?`, `items?: [{id, title, status}]`, `visible?` | | icona nella barra dei menu (compare al primo update); `status` di un item: `busy`, `waiting`, `queued`, `done`, `error`; menu con una riga per item e "Apri la Bottega"; evento `menubar.clicked {item}` (`item` = id dell'item, oppure `open`). `visible: false` toglie l'icona |
| `ai.generate` | `prompt`, `instructions?`, `maxTokens?` | `text` | Apple Intelligence sul dispositivo (FoundationModels) |
| `ai.summarize` | `text`, `instructions?` | `text` | idem, con istruzioni di riassunto in italiano (richiesta, cosa e' stato fatto, decisioni, file, prossimi passi). Testi oltre la finestra di contesto: riassunto a pezzi da ~10.000 caratteri, poi fusione |
| `ai.embed` | `texts: [string]`, `language` (`it`) | `vectors: [[number]]`, `dimension` | NLEmbedding di frase, vettori normalizzati (norma 1, quindi coseno = prodotto scalare). Una riga per testo, testo vuoto = vettore di zeri. La dimensione la decide il sistema: su macOS 27.2 per l'italiano e' **640**, non 512: chi salva vettori legga `dimension` |
| `system.stats` | | `load: [1m,5m,15m]`, `memoryPressure: normal/warning/critical`, `memoryUsedGB`, `memoryTotalGB`, `thermal: nominal/fair/serious/critical`, `cores` | |
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
  }>;
  streak: { current: number; best: number; bestEnd: string | null };
  records: { busiestDay: {date, you} | null; longestStint: {start, minutes} | null; tokenDay: {date, tok} | null };
  live: { pid; sessionId; project: string; path: string | null; title; status; since; started;
    today: number; tokToday: number }[];
  prices: { note: string; perModel: Record<string, [input, output, cacheRead]> };  // $ per milione
  unpricedTokens: number;
}
```
