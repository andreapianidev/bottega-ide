# Memoria

La memoria persistente della Bottega. Ogni sessione di Claude Code lascia una traccia, la traccia
diventa un riassunto in italiano, e la sessione successiva sullo stesso progetto parte sapendo gia'
cosa e' stato fatto. Le sessioni aperte nello stesso momento si vedono a vicenda attraverso la
bacheca. Claude puo' anche cercare nella memoria da solo, con il server MCP `bottega-memoria`.

Solo Node 22 e i suoi moduli `node:`, nessuna dipendenza npm.

## Cosa raccoglie

| Momento | Cosa viene scritto |
|---|---|
| Inizio sessione | niente di nuovo: legge il contesto pronto del progetto e chi ci sta lavorando adesso |
| Ogni richiesta | il testo della richiesta, senza chiavi e password |
| Ogni strumento | nome, file toccati, un estratto di al massimo 400 caratteri di comando e risultato |
| Fine turno, fine sessione | parte in background il riassunto |

Il riassunto dice cosa e' stato chiesto, cosa e' stato fatto, le decisioni, i file toccati e cosa
resta da fare. Decisioni e fatti utili diventano anche voci separate, piu' facili da ritrovare.

Le sessioni partite dalla home vengono attribuite al progetto in cui hanno toccato piu' file, come
fa la plancia. I progetti sono le sottocartelle di `~/prototipi` e delle cartelle iCloud Prototipi,
Avo Agency e Progetti xCode (si cambiano in `~/.bottega/memoria/config.json`, chiave `roots`).

## Conversazioni Codex

Dalla build 102, aprire la linea del tempo o cercare importa anche le conversazioni Codex locali recenti.
Richieste e risposte concluse diventano note con fonte e orario originali, senza generazione o chiamate in rete.
L'importazione e' incrementale: un controllo continua dove il precedente si e' fermato, senza duplicare le note.
Sono esclusi strumenti, ragionamenti, immagini, contesto del client e agenti delegati. Le note hanno un limite di
8.000 caratteri; vengono letti al massimo 100 file recenti, negli ultimi sette giorni, 32 MiB per controllo.
Dalla build 103 lo stesso percorso acquisisce anche Cline, nei formati SDK e archivio
dell'estensione (Bottega, VS Code, Insiders e VSCodium). Richieste, risposte ed esiti
conservano fonte e data; ragionamenti, risultati degli strumenti e messaggi parziali
sono esclusi. Si controllano al massimo 100 file modificati negli ultimi 45 giorni,
fino a 8 MiB ciascuno, senza duplicare gli eventi gia' acquisiti.

Melissa registra richieste e risposte, compresa la cronologia locale ripristinabile.
I terminali integrati registrano comando ed esito dopo l'avvio del monitor, senza
salvare l'output completo. Non e' possibile recuperare retroattivamente terminali
esterni o comandi mai osservati. I testi vengono redatti e limitati a 8.000 caratteri.

L'estensione sincronizza all'avvio e ogni minuto, anche con la stanza Memoria chiusa.
CLI e MCP sincronizzano prima delle letture: ricerca, contesto e bacheca usano lo stesso
archivio. I ricordi importati sono note originali, non riassunti generati o decisioni
dedotte automaticamente. La copertura delle altre funzioni e' in
[Audit delle fonti integrate](../docs/AUDIT_FONTI_INTEGRATE.md).

```sh
node memoria/cli.mjs import-codex --json
node memoria/cli.mjs import-all --json
```

## Sessioni in parallelo: la bacheca

Ogni richiesta e ogni modifica finiscono anche in `bacheca/<progetto>.jsonl` (al massimo qualche
centinaio di righe per progetto). Cosi':

- quando scrivi a una sessione, Claude riceve un riassunto di cosa hanno fatto le **altre**
  sessioni sullo stesso progetto negli ultimi 30 minuti, con un avviso esplicito se una di loro ha
  appena modificato un file che citi;
- quando Claude modifica un file che un'altra sessione ha toccato negli ultimi 10 minuti, riceve
  un avviso subito dopo la modifica;
- all'avvio, il contesto dice chi sta lavorando adesso sullo stesso progetto;
- lo strumento `memoria_bacheca` e il comando `bacheca` mostrano tutto, per progetto.

## Dove stanno i dati

Tutto in `~/.bottega/memoria/` (cartella leggibile solo da te):

| Percorso | Cosa |
|---|---|
| `memoria.db` | database SQLite: sessioni, osservazioni, memorie, indice di ricerca, vettori |
| `spool/<data>.jsonl` | le righe scritte dagli hook, prima di entrare nel database |
| `contesto/<progetto>.md` | il testo che riceve una sessione nuova su quel progetto |
| `bacheca/` | l'attivita' recente delle sessioni, per progetto |
| `memoria.log` | errori e riassunti fatti |

Gli hook non aprono mai il database: scrivono una riga e escono, sempre con successo, in meno di
150 ms. Il lavoro pesante lo fa un processo staccato.

## Come si cerca

Dentro Claude Code, con gli strumenti del server `bottega-memoria`:
`memoria_cerca`, `memoria_recenti`, `memoria_sessione`, `memoria_ricorda`, `memoria_bacheca`.

Dal terminale:

```bash
node memoria/cli.mjs search "webhook stripe" --progetto ImmobiliareAI
node memoria/cli.mjs recent --progetto Bottega
node memoria/cli.mjs remember "Le build iOS solo da Xcode Cloud" --progetto Woofmap
node memoria/cli.mjs bacheca --minuti 30
node memoria/cli.mjs context ~/prototipi/Bottega
node memoria/cli.mjs status
```

Con `--json` le risposte hanno la forma descritta in `docs/CONTRATTI.md`.
La ricerca usa le parole (FTS5) e, quando il Nucleo e' installato, anche il significato
(vettori di Apple sul Mac).

## Riassumere le sessioni passate

```bash
node memoria/cli.mjs backfill --giorni 30 --max 20
```

Riprende da dove si era fermato e salta le sessioni gia' riassunte. Va piano apposta (vedi sotto).

## Installare e disinstallare

```bash
node memoria/cli.mjs install --app-dir ~/.bottega/memoria-app
node memoria/cli.mjs uninstall
```

`install` aggiunge i cinque hook a `~/.claude/settings.json` (prima ne fa una copia accanto, con
data e ora nel nome), senza toccare gli hook di altri strumenti, e registra il server MCP a livello
utente. Rilanciarlo non duplica niente. `uninstall` toglie solo le voci della Memoria; i dati
restano in `~/.bottega/memoria/` finche' non cancelli la cartella. `--prova` mostra cosa farebbe
senza scrivere, `--no-mcp` lascia stare il server MCP.

## Privacy

Tutto resta sul Mac. Prima di scrivere qualunque cosa, chiavi, token e password riconoscibili
vengono sostituiti da `[chiave nascosta]`.

L'unica cosa che esce dal Mac e' il testo da riassumere (richieste, risposte e strumenti di una
sessione, al massimo 12.000 caratteri, gia' ripulito dalle chiavi): va ad Agnes AI
(`agnes-3.0-flash`), che e' il motore dei riassunti. Agnes riceve al massimo 6 richieste al minuto
dalla Memoria, perche' il piano e' condiviso con altre app. Se Agnes risponde «troppe richieste» o
non risponde, il riassunto lo fa Apple Intelligence, gia' dentro macOS: nessun download.

© 2026 Bottega · Andrea Piani · NIE Z2331796-S · Tijarafe, Santa Cruz de Tenerife · Islas Canarias
