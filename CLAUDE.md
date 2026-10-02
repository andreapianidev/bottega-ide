# Bottega

VS Code compilato dai sorgenti (tag in `bottega.json`), piu' estensioni proprie. Leggi `README.md`.

## Regole del progetto

- **Le modifiche a VS Code passano solo da `scripts/patch-source.py`**, mai a mano in `vendor/vscode`:
  `vendor/` viene azzerata a ogni build (`git checkout -f` + `git clean`). Ogni patch e' una
  sostituzione esatta che fallisce ad alta voce se il testo non c'e' piu'.
- Patch al minimo. Tutto cio' che si puo' fare con un'estensione (`extensions/`) si fa li': le patch
  sono il costo che si paga a ogni aggiornamento di VS Code.
- **Build sale a ogni modifica**, nello stesso commit: `scripts/bump-build.sh` (allinea anche le
  versioni delle estensioni).
- La compilazione di VS Code pesa (Air M2 16 GB): una sola alla volta, gia' con `nice`. Prima di
  lanciarla guarda `uptime` e `pgrep -f "gulp vscode-darwin"`.
- Per lavorare solo sulla plancia non serve ricompilare VS Code: `cd extensions/bottega-home && npm
  run build`, poi `scripts/build.sh --package`.
- Testi visibili in italiano, senza lineette lunghe, senza maiuscolo forzato.
- Il bundle id `com.andreapiani.bottega` e lo schema `bottega://` non si cambiano: dati e
  associazioni dell'utente dipendono da li'.
- I protocolli tra Nucleo, Memoria, estensione e plancia stanno in `docs/CONTRATTI.md`: chi cambia
  un'interfaccia aggiorna quel file nello stesso commit.
- La Memoria e' installata davvero in `~/.claude/settings.json` (5 hook) e come server MCP utente:
  gli hook devono restare sotto i 150 ms e uscire sempre con 0. Per provare usa
  `BOTTEGA_HOME` e `CLAUDE_SETTINGS` verso una cartella di prova, mai i file veri.
- Chiavi: Agnes da `~/.secrets/agnes-ai.env`, ElevenLabs da `~/.secrets/elevenlabs.env`. Agnes e' a
  ~20 richieste al minuto condivise con tutte le app di Andrea: i test reali sono su richiesta
  (`BOTTEGA_TEST_REALE=1 npm test`).
- Il Nucleo si compila con `nucleo/build.sh` (leggero); da fermo deve restare a 0% di CPU.
- **Andrea ha sempre l'ultima versione in /Applications (regola, 2 ottobre 2026).** Ogni modifica
  finita si chiude cosi', senza chiedere: `scripts/bump-build.sh`, `scripts/package.sh` (installa
  in `/Applications/Bottega.app`; se la Bottega e' aperta la chiude, la sostituisce e la riapre),
  commit, push. Una modifica non e' finita finche' in /Applications non gira quella build.
- **Il repository e' PUBBLICO ed e' l'unico** (`andreapianidev/bottega-ide`, open source MIT, scelta di
  Andrea del 2 ottobre 2026). Prima di ogni push: nessuna chiave nel diff (`git diff origin/main..HEAD`),
  nessun dato di clienti in codice, documenti o screenshot (nomi, email, descrizioni di progetti dei
  clienti: negli screenshot vanno sfocati), nessun dato aziendale oltre alla riga legale del README.
  Il vecchio repository privato `andreapianidev/bottega` e' stato tolto: si spinge solo su `origin`.
