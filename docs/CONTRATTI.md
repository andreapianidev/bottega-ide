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
| `capabilities` | | `foundationModels: bool`, `speechLocaleInstalled: bool`, `speechLocale`, `embedding: bool`, `metal: string`, `memoryGB`, `cores`; in piu': `version`, `foundationModelsReason?` (se non disponibile), `speechBackend` (`SpeechAnalyzer` o `SFSpeechRecognizer`), `embeddingDimension`, `ttsEngine` (`elevenlabs` o `apple`), `ttsModel`, `elevenLabsConfigured`, `elevenLabsVoice`, `elevenLabsCharsThisMonth`, `appleVoice`, `echoCancellation` (`hardware` o `software`, l'ultimo percorso usato in conversazione), `echoCancellationTested: bool`, `conversing: bool`, `hotkey` (etichetta o null) | |
| `speech.prepare` | `locale` (default `it-IT`) | `installed: bool` | scarica il modello vocale se manca (AssetInventory); eventi `speech.progress {fraction, locale}` |
| `voice.listen` | `mode`: `push` o `utterance`, `locale` | `backend` | `utterance` finisce da solo dopo ~1.2 s di silenzio (o dopo 8 s se nessuno parla); `push` resta aperto fino a `voice.stop` (massimo 120 s). Se Melissa sta parlando viene zittita: fuori dalla conversazione il microfono e' chiuso mentre lei parla |
| `voice.stop` | | | chiude l'ascolto ed emette l'ultimo `voice.final` |
| `voice.speak` | `text`, `voice?`, `append?: bool`, `final?: bool`, `model?` | `engine` | evento `voice.spoken {text, engine}` quando un pezzo e' stato davvero ascoltato. Senza `append` il testo e' una risposta intera. Con `append: true` l'estensione manda i pezzi man mano che l'LLM li scrive: la prima frase (o il primo inciso lungo) parte subito, poi una frase alla volta; `final: true` (anche con `text` vuoto) chiude il turno. `model` sceglie il modello ElevenLabs (default `eleven_v4_turbo`). `voice`: `apple` forza la voce Apple, `com.apple...` sceglie una voce Apple precisa, qualsiasi altro valore e' un voice id ElevenLabs |
| `voice.stopSpeaking` | | | interruzione (barge-in): silenzio subito, coda svuotata |
| `voice.converse.start` | `locale?` | `echoCancellation`, `backend` | modalita' conversazione: microfono sempre aperto, trascrizione sul dispositivo, ~0.8 s di silenzio chiude il turno dell'utente (`voice.final {text, mode:"converse"}`). Se l'utente parla sopra Melissa, la voce si ferma ed esce `voice.bargein {text, trigger}` (`trigger`: `energy` con cancellazione dell'eco hardware, `speech` con il filtro software). Eco: prima la cancellazione hardware (voice processing), se fallisce il filtro software sul testo |
| `voice.converse.stop` | | | chiude la conversazione (emette `voice.final` se c'era una frase a meta') |
| `wake.enable` | `phrase` (default `melissa`), `locale?` | | ascolto continuo a basso consumo (la trascrizione riceve audio solo intorno alla voce); evento `wake.detected {phrase, text}`. Sospeso mentre Melissa parla e durante ascolto o conversazione |
| `wake.disable` | | | |
| `orb.show` / `orb.hide` | | | sfera Metal in un pannello flottante di vetro, in basso al centro, trascinabile (la posizione resta) |
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

Eventi aggiuntivi: `voice.state {state, conversing, mode?, wake?}` (`state`: `idle`, `listening`, `processing`,
`speaking`), `voice.partial {text, mode}`, `voice.final {text, mode}`, `voice.level {level 0..1, source: mic|tts}`
(al massimo 15 al secondo, niente eventi mentre resta silenzio), `voice.bargein {text, trigger}`,
`voice.engine {engine, reason}` (ElevenLabs e' caduto, si continua con la voce Apple), `orb.clicked`,
`system.pressure {memoryPressure, thermal}` quando cambia, `log {level, message}`, `ready {version}`.

Voce: ElevenLabs se c'e' la chiave (`ELEVENLABS_API_KEY` nell'ambiente, altrimenti `~/.secrets/elevenlabs.env`,
con `ELEVENLABS_VOICE_ID` facoltativo, default Melissa `QITiGyM4owEZrBEf0QV8`), sempre in tempo reale sul socket
text-to-dialogue, modello `eleven_v4_turbo`, tenuto caldo mentre la voce e' in uso (conversazione, sfera visibile,
o una risposta negli ultimi 2 minuti). I caratteri mandati si contano in `~/.bottega/nucleo/usage.json` (la chiave
non ha il permesso di leggere il saldo). Senza chiave o a qualsiasi errore: AVSpeechSynthesizer, voce
`com.apple.voice.premium.it-IT.Emma`, i tag come `[laughs]` vengono tolti.

Permessi: microfono e riconoscimento vocale li chiede il Nucleo, ma macOS li attribuisce al processo
responsabile, cioe' a Bottega.app che lo lancia: per questo anche Bottega.app deve avere
`NSMicrophoneUsageDescription` e `NSSpeechRecognitionUsageDescription` (lo fa `scripts/package.sh`). Le notifiche
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
recupera le sessioni ferme da 30 minuti senza `SessionEnd`. Motore: Apple Intelligence tramite
`nucleo --cli generate` (testo tagliato a 7000 caratteri), poi Agnes (massimo 6 richieste al minuto).

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

Plancia -> estensione (`type` + campi):
`ready`, `refresh`, `open`, `here`, `claude {path, id?}`, `finder`, `xcode`, `push`,
`job.new {path, task}`, `job.focus {id}`, `job.stop {id}`, `job.remove {id}`,
`memoria.search {query, project?}`, `memoria.remember {text, project?}`,
`voice.toggle`, `assistant.ask {text}` (domanda scritta a Melissa)

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
