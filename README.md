<p align="center">
  <img src="brand/icon-1024.png" width="128" alt="Icona della Bottega: la cupola dell'osservatorio sotto una lampada al sodio">
</p>

<h1 align="center">Bottega</h1>

<p align="center">
  Un IDE per lavorare con Claude Code, costruito su VS Code e cucito addosso al Mac.<br>
  Tutti i tuoi progetti su una plancia, piu' sessioni Claude in parallelo, una memoria che si
  ricorda cosa avete fatto, e Melissa: un'assistente a cui parli.
</p>

<p align="center">
  Apple Silicon, macOS 27 o successivo. Open source, licenza MIT. Progetto personale in fase alfa.
</p>

![La Bottega: la plancia dei progetti e, dietro, i lavori](docs/screenshot/hero.jpg)

## Perche' esiste

Chi lavora con Claude Code finisce presto con dieci terminali aperti, sessioni sparse in cartelle
diverse e nessuna idea di quale progetto aspetti un push o quale sessione ti stia aspettando.
La Bottega mette tutto in un posto solo: vede ogni progetto e ogni sessione Claude del Mac, ti dice
in una frase com'e' la situazione e ti lascia lavorare a voce.

La Bottega e' VS Code 1.140 compilato dai sorgenti ufficiali Microsoft (licenza MIT), con poche patch
mirate e quattro pezzi propri.

## Cosa c'e' dentro

### La plancia

All'avvio, al posto della pagina di benvenuto, una frase dice com'e' la situazione: quante sessioni
Claude lavorano, quali progetti aspettano un push, quali hanno modifiche fuori da un commit. Sotto,
le sessioni Claude aperte in tutto il Mac (respirano quando lavorano) e l'elenco dei progetti con
stato git, numero di build letto dal progetto Xcode o Android, e lo storico delle sessioni Claude di
ciascuno, da riprendere con un clic.

### I lavori

![I lavori](docs/screenshot/lavori.jpg)

Piu' sessioni Claude in parallelo, ognuna in una scheda dell'editor. Scegli il progetto, scrivi cosa
deve fare Claude, avvia. Quando un lavoro ha bisogno di te diventa la cosa piu' luminosa della
pagina e arriva una notifica di macOS. Una coda rispetta i limiti del Mac: con 16 GB lavorano al
massimo tre sessioni insieme, meno se la memoria e' sotto pressione o il Mac e' caldo. Nella stanza Lavori
compaiono anche le sessioni Claude aperte fuori dalla Bottega (un terminale, un'altra app): ogni sessione viva è un
lavoro, e tutti i numeri della Bottega li contano allo stesso modo.

### La memoria

![La memoria](docs/screenshot/memoria.jpg)

La nostra versione di [claude-mem](https://github.com/thedotmack/claude-mem). Gli hook di Claude
Code registrano ogni sessione; a intervalli un modello la riassume in italiano, con fatti e decisioni
separati. Ogni nuova sessione parte sapendo cosa e' stato fatto su quel progetto, e Claude puo'
cercare nella memoria con il server MCP `bottega-memoria`.

Le sessioni che girano nello stesso momento si vedono a vicenda: se due sessioni lavorano sullo
stesso progetto, ognuna sa cosa ha appena toccato l'altra (la bacheca), e viene avvisata se sta per
mettere le mani su un file che l'altra ha modificato da poco.

### Melissa

![Melissa](docs/screenshot/melissa.jpg)

Un'assistente vocale con un carattere suo, che agisce sull'IDE: apre progetti, avvia lavori Claude,
cerca nella memoria, legge lo stato di git e del sistema. Tocca **Opzione+Spazio** per una
conversazione in tempo reale (la puoi interrompere mentre parla), tienilo premuto per un comando
solo. Funziona ovunque sul Mac, anche con la Bottega in secondo piano. Le azioni a rischio, come un
push, chiedono sempre conferma.

- Ascolto: ElevenLabs `scribe_v2_realtime`, in streaming.
- Ragionamento: Agnes AI (`agnes-3.0-flash`, API compatibile OpenAI) con strumenti, in streaming,
  cosi' Melissa comincia a parlare mentre la risposta e' ancora in arrivo.
- Voce: ElevenLabs `eleven_v4_turbo` su canale tenuto caldo, circa 0,2 secondi al primo suono.
  Se ElevenLabs non risponde, parla con una voce di sistema di macOS.
- La sfera vive dentro la Bottega, nella barra laterale e nella barra di stato. Con `bottega.voice.sfera` su
  `schermo` torna la sfera disegnata in Metal dal Nucleo, in un pannello di vetro sopra le finestre.

### Il Nucleo

Un'app Swift nativa nascosta dentro la Bottega (`nucleo/`), per tutto quello che Electron non sa
fare: audio, sfera Metal, scorciatoia globale, notifiche, icona nella barra dei menu, pressione di
memoria e temperatura del Mac, Apple Intelligence (FoundationModels) ed embedding di frase
(NaturalLanguage). Solo framework Apple, nessuna dipendenza esterna. Da fermo: 0% di CPU, circa
30 MB di memoria, nessuna connessione aperta.

### La Home

La plancia è la Home dell'app: una scheda appuntata che si apre sempre, anche con una cartella aperta, e che si
ritrova al riavvio. In cima il briefing del giorno e i consigli scritti da Apple Intelligence sul Mac (senza Apple
Intelligence restano consigli fissi ricavati dalle regole), poi i numeri che contano, i progetti dimenticati e l'elenco
dei progetti con il loro semaforo.

### Il semaforo delle regole e la Vedetta

Ogni progetto ha un semaforo che si accende quando una regola è violata: un commit che tocca il codice di un'app senza
far salire il numero di build, commit non spinti, repository senza remoto, repository pubblici non voluti, chiavi nei
commit non ancora spinti, una versione su App Store Connect che non andrà in rilascio automatico, `app-ads.txt` diverso
tra i siti che lo servono. Per ogni violazione c'è la frase che dice come rimediare e, quando si può, il pulsante che lo
fa. La stanza Vedetta mette tutto insieme, accanto al radar dello Store: stato di ogni app su App Store Connect,
ultime recensioni e quanto ha reso su AdMob ieri e negli ultimi sette giorni. Funziona anche senza rete, con l'età del
dato in chiaro. Le chiavi si leggono da `~/.secrets/` e dal server MCP di AdMob già autenticato: nel repository non c'è
niente.

### Il briefing del mattino, la notte, «continua da dove eri»

Alla prima apertura della giornata Melissa dice in trenta secondi cosa conta: ore e progetti di ieri, lavori che
aspettano, novità dallo Store, soldi di ieri, regole violate, progetti dimenticati, cosa è successo stanotte. Una volta
sola, poi resta una card nella Home. I lavori si possono mettere in fila per la notte: partono nella finestra scelta
(di default dall'una alle sei), uno o due alla volta, solo se il Mac è alla corrente e la memoria è tranquilla; il
Nucleo tiene sveglio il Mac mentre lavorano e il loro prompt vieta push e pubblicazioni. Su ogni progetto, «Continua da
dove eri» prepara un lavoro che riparte dall'ultimo riassunto della memoria e dalle cose rimaste da fare: il prompt si
legge e si cambia prima di partire.

### Ore per cliente e «Dove l'ho già risolto?»

La stanza Clienti raggruppa le ore del cruscotto per cliente (l'associazione progetto e cliente sta in
`~/.bottega/clienti.json`, solo sul tuo Mac), arrotonda ogni giorno al quarto d'ora ed esporta il mese in CSV e in
Markdown. «Dove l'ho già risolto?» cerca per significato in tutta la memoria e per testo nel codice di tutti i progetti.

### Melissa dentro l'IDE

La sfera di Melissa vive nella barra laterale e nella barra di stato della Bottega, non sopra le altre app. Chi la vuole
sullo schermo, come prima, imposta `bottega.voice.sfera` su `schermo`. Il Nucleo espone anche i Comandi rapidi
(«Chiedi a Melissa», «Avvia un lavoro», «Briefing», «Stato delle regole», anche con Siri), un widget da scrivania
con il semaforo delle regole e il briefing, e mette progetti e ricordi in Spotlight (se l'indicizzazione di Spotlight è
accesa sul Mac).

### L'aspetto

Temi Bottega Notte e Bottega Calima: il cielo sopra l'osservatorio del Roque de los Muchachos, a La
Palma, illuminato solo dalle lampade al sodio che la legge sul cielo buio impone all'isola. Titoli
senza maiuscolo forzato, schede e finestre arrotondate, icona propria. Copilot non e' incluso: la
Bottega lavora con Claude Code.

## Requisiti

- Mac con Apple Silicon e macOS 27 o successivo
- Xcode con gli strumenti a riga di comando (per compilare il Nucleo)
- Node 22 (estensioni e memoria) e nvm (la build di VS Code installa da sola la versione che chiede)
- circa 15 GB liberi per la prima compilazione di VS Code
- [Claude Code](https://docs.anthropic.com/claude-code) installato (`claude` nel PATH)
- facoltative, per Melissa e per i riassunti della memoria:
  - una chiave [Agnes AI](https://agnes-ai.com) (c'e' un piano gratuito)
  - una chiave [ElevenLabs](https://elevenlabs.io) con accesso a sintesi e trascrizione

## Compilare e installare

```bash
git clone https://github.com/andreapianidev/bottega-ide.git
cd bottega-ide
scripts/build.sh            # sorgenti di VS Code, patch, npm ci, compilazione, confezione, installazione
```

La prima volta ci vogliono da 30 a 60 minuti; le successive, se cambiano solo estensioni e Nucleo:

```bash
scripts/build.sh --package  # confeziona e installa riusando l'ultima compilazione di VS Code
```

Il risultato va in `/Applications/Bottega.app` (se e' aperta viene chiusa, sostituita e riaperta) e
il comando `bottega` in `~/.local/bin`. I dati stanno in `~/.bottega` e in
`~/Library/Application Support/Bottega`, separati dal tuo VS Code.

L'app e' firmata ad hoc sul tuo Mac: non e' notarizzata e non e' pensata per essere distribuita
come binario.

### Cosa serve per far funzionare Melissa e la memoria

Nel repository non c'e' nessuna chiave: ognuno usa le sue. La plancia e i lavori funzionano senza
niente; Melissa e i riassunti della memoria hanno bisogno di due servizi esterni.

**1. Agnes AI, il cervello** (risposte di Melissa e riassunti della memoria)

- Registrati su [agnes-ai.com](https://agnes-ai.com) e crea una chiave API dalla console. Il piano
  gratuito basta: circa 20 richieste al minuto, che Melissa e la memoria si dividono (la memoria ne
  usa al massimo 6).
- Modello usato: `agnes-3.0-flash`, sull'API compatibile OpenAI `https://apihub.agnes-ai.com/v1`.
- Senza Agnes: Melissa risponde con Apple Intelligence del Mac, ma senza poter agire sull'IDE, e la
  memoria riassume con Apple Intelligence.

**2. ElevenLabs, orecchie e voce** (Melissa che ti ascolta e ti risponde a voce)

- Serve un account [ElevenLabs](https://elevenlabs.io) con una chiave API che abbia almeno i
  permessi di sintesi vocale (*text to speech*), trascrizione (*speech to text*) e lettura delle
  voci (*voices read*). Non serve il permesso di lettura dell'account.
- Modelli usati: `scribe_v2_realtime` per ascoltare, `eleven_v4_turbo` per parlare. Entrambi
  consumano crediti: una risposta di Melissa e' di solito 100-200 caratteri. Per un uso quotidiano
  conviene un piano a pagamento; la Bottega conta i caratteri consumati nel mese in
  `~/.bottega/nucleo/usage.json`.
- Scegli una voce dalla tua libreria ElevenLabs (anche una creata da te) e copia il suo
  *voice ID*: quella di Melissa e' legata all'account dell'autore e non funziona con altri account.
- Senza ElevenLabs: Melissa non ti sente (le puoi scrivere dalla pagina Melissa) e risponde con una
  voce di sistema di macOS.

**3. Dove mettere le chiavi**

La Bottega le legge dalle variabili d'ambiente. Il modo piu' semplice e' aggiungerle a `~/.zshrc`
e riavviare la Bottega:

```bash
export AGNES_API_KEY="la-tua-chiave-agnes"
export ELEVENLABS_API_KEY="la-tua-chiave-elevenlabs"
export ELEVENLABS_VOICE_ID="id-della-voce-scelta"
```

In alternativa, se tieni le chiavi in file separati fuori dai progetti, la Bottega legge anche
`~/.secrets/agnes-ai.env` e `~/.secrets/elevenlabs.env` (righe `NOME=valore`, permessi `600`).
La chiave Agnes puo' essere inserita anche al primo uso: la Bottega la chiede e la conserva nel
portachiavi dell'editor. Le chiavi non vanno mai messe nel repository.

**4. Permessi di macOS**

Al primo uso macOS chiede il microfono per la Bottega e le notifiche per «Bottega Nucleo».
Il microfono resta chiuso finche' non tocchi Opzione+Spazio o la sfera di Melissa.

### La memoria per Claude Code

Si attiva dal comando «Bottega: attiva la memoria per Claude Code». Aggiunge cinque hook a
`~/.claude/settings.json` (con un backup prima, senza toccare gli hook che hai gia') e registra il
server MCP `bottega-memoria`. Ogni hook esce entro 150 millisecondi e non blocca mai Claude.
Si toglie con `node ~/.bottega/memoria-app/cli.mjs uninstall`. Dettagli in
[`memoria/README.md`](memoria/README.md).

## Cosa esce dal tuo Mac

- verso Agnes AI: le domande che fai a Melissa e il testo delle sessioni da riassumere (al massimo
  12.000 caratteri per sessione, gia' ripulito dalle chiavi riconoscibili);
- verso ElevenLabs: l'audio mentre Melissa ti ascolta (solo a conversazione aperta o col tasto
  premuto) e il testo che deve pronunciare;
- verso Open VSX: le ricerche e i download delle estensioni.

Nient'altro. La build dai sorgenti di VS Code non contiene telemetria; progetti, sessioni, memoria e
statistiche restano in locale.

## Scorciatoie

| Tasti | Azione |
|---|---|
| `Opzione+Spazio`, tocco | conversazione con Melissa, accesa o spenta |
| `Opzione+Spazio`, tenuto | un solo comando a Melissa |
| `Cmd+Shift+H` | apre la plancia |
| `Cmd+Alt+C` | nuova sessione Claude nella cartella aperta |
| `/` nella plancia | cerca |

## Com'e' fatta

| Percorso | Cosa contiene |
|---|---|
| `product.bottega.json` | nome, bundle id, cartelle dati, galleria Open VSX |
| `scripts/patch-source.py` | le poche patch a VS Code: temi predefiniti, icona, CSS, esclusione di Copilot |
| `brand/` | icona (generata da `icon.swift`) e ritocchi grafici al banco di lavoro |
| `extensions/bottega-home/` | plancia, lavori, Melissa, client del Nucleo e della memoria |
| `extensions/bottega-theme/` | temi e impostazioni predefinite |
| `nucleo/` | l'app nativa in Swift e Metal |
| `memoria/` | hook, server MCP e riga di comando della memoria (Node, zero dipendenze) |
| `docs/CONTRATTI.md` | i protocolli tra i pezzi: da leggere prima di toccarne uno |

Le modifiche a VS Code passano solo da `scripts/patch-source.py`, che fallisce in modo esplicito se
una patch non si applica piu': per passare a una versione nuova di VS Code si cambia `vscodeTag` in
`bottega.json` e si rilancia la build. Tutto il resto vive in estensioni, cosi' gli aggiornamenti
costano poco.

## Stato del progetto

E' un progetto personale, nato per il modo di lavorare di una persona sola, ed e' in fase alfa.
Alcune scelte sono personali e configurabili: le cartelle dei progetti
(`bottega.roots`, di default `~/prototipi` e alcune cartelle iCloud), la lingua (l'interfaccia e
Melissa parlano italiano), il carattere di Melissa. Segnalazioni e proposte sono benvenute nelle
[issue](https://github.com/andreapianidev/bottega-ide/issues).

## Ringraziamenti

- [Visual Studio Code](https://github.com/microsoft/vscode), Microsoft, licenza MIT
- [Open VSX](https://open-vsx.org) per le estensioni
- [claude-mem](https://github.com/thedotmack/claude-mem), l'idea da cui nasce la memoria
- [Claude Code](https://docs.anthropic.com/claude-code) di Anthropic

## Licenza

[MIT](LICENSE). VS Code e' un marchio di Microsoft; la Bottega non e' affiliata a Microsoft ne' ad
Anthropic.

© 2026 Bottega · Andrea Piani · NIE Z2331796-S · Tijarafe, Santa Cruz de Tenerife · Islas Canarias
