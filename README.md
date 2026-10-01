# Bottega

Un VS Code tutto nostro, costruito attorno a Claude Code. Solo Apple Silicon, solo macOS 27 e successivi.

La Bottega e' VS Code compilato dai sorgenti ufficiali Microsoft (licenza MIT), con tre cose in piu':

- **La plancia.** All'avvio, al posto della pagina di benvenuto, c'e' l'elenco di tutti i progetti in
  `~/prototipi` e nelle cartelle iCloud (Prototipi, Avo Agency, Progetti xCode): stato git, commit da
  spingere, modifiche fuori da un commit, numero di build, e le sessioni Claude Code di ciascuno, da
  riprendere con un clic. In cima, le sessioni Claude aperte in questo momento in tutto il Mac, con
  chi sta lavorando e chi aspetta.
- **Claude Code dentro.** Un clic apre una sessione Claude in una scheda dell'editor, nella cartella del
  progetto; `Riprendi` lancia `claude --resume` sulla sessione scelta. Al primo avvio la Bottega
  installa l'estensione ufficiale Claude Code da Open VSX.
- **Il suo aspetto.** Temi Bottega Notte e Bottega Calima (il cielo di La Palma e le lampade al sodio
  dell'osservatorio), titoli senza maiuscolo forzato, schede e finestre arrotondate, icona propria.

## Da dove legge i dati

| Cosa | Fonte |
|---|---|
| Progetti | sottocartelle dirette delle radici in `bottega.roots` |
| Stato git | `git status --porcelain=v2 --branch`, `git log -1` |
| Numero di build | `CURRENT_PROJECT_VERSION` / `MARKETING_VERSION` nel `project.pbxproj`, `versionCode` su Android, `version` di `package.json` |
| Sessioni Claude vive | `~/.claude/sessions/<pid>.json` (solo i processi ancora vivi) |
| Storico sessioni | `~/.claude/projects/*/*.jsonl` degli ultimi 45 giorni: titolo, cartella, file toccati |

Le sessioni partite dalla home vengono attribuite al progetto in cui hanno toccato piu' cartelle e file.

## Compilare

```bash
scripts/build.sh            # sorgenti, patch, npm ci, compilazione, confezione, installazione
scripts/build.sh --package  # solo confezione e installazione, riusando l'ultima compilazione
```

Il risultato va in `/Applications/Bottega.app` e il comando `bottega` in `~/.local/bin`.
I dati dell'app stanno in `~/.bottega` e `~/Library/Application Support/Bottega`, separati da VS Code.

La versione di VS Code e' fissata in `bottega.json` (`vscodeTag`). Per passare a una nuova versione si
cambia il tag e si rilancia la build: `scripts/patch-source.py` si ferma con un messaggio chiaro se una
delle modifiche non si applica piu'.

## Dove stanno le modifiche

| File | Cosa fa |
|---|---|
| `product.bottega.json` | nome, bundle id `com.andreapiani.bottega`, cartelle dati, galleria Open VSX |
| `scripts/patch-source.py` | temi predefiniti, icona, CSS del banco di lavoro |
| `brand/workbench.css` | i ritocchi grafici a VS Code |
| `brand/icon.swift` | genera l'icona (`swift brand/icon.swift`) |
| `extensions/bottega-home` | la plancia, le viste laterali, i comandi Claude |
| `extensions/bottega-theme` | temi e impostazioni predefinite |

## Scorciatoie

| Tasti | Azione |
|---|---|
| `Cmd+Shift+H` | apre la plancia |
| `Cmd+Alt+C` | nuova sessione Claude nella cartella aperta |
| `/` nella plancia | cerca un progetto |

## Licenza e marchi

Codice di VS Code: MIT, Microsoft. La Bottega non usa il marketplace Microsoft (riservato ai prodotti
Microsoft) ma Open VSX. Niente telemetria: la build dai sorgenti non la include.

© 2026 Bottega · Andrea Piani · NIE Z2331796-S · Tijarafe, Santa Cruz de Tenerife · Islas Canarias
