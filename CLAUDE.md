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
  lanciarla guarda `uptime` e `pgrep -f gulp.js`.
- Per lavorare solo sulla plancia non serve ricompilare VS Code: `cd extensions/bottega-home && npm
  run build`, poi `scripts/build.sh --package`.
- Testi visibili in italiano, senza lineette lunghe, senza maiuscolo forzato.
- Il bundle id `com.andreapiani.bottega` e lo schema `bottega://` non si cambiano: dati e
  associazioni dell'utente dipendono da li'.
