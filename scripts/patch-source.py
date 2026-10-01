#!/usr/bin/env python3
"""Applica le modifiche della Bottega ai sorgenti di VS Code.

Ogni modifica e' una sostituzione esatta: se il testo da cercare non c'e' piu'
(perche' Microsoft ha cambiato il file in una versione nuova) lo script si ferma
e dice quale, invece di produrre un'app modificata a meta'.
"""
import json, pathlib, shutil, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "vendor" / "vscode"

def replace(rel, old, new):
    p = SRC / rel
    s = p.read_text()
    if new in s:
        return
    if s.count(old) != 1:
        sys.exit(f"patch fallita: in {rel} il testo da sostituire compare {s.count(old)} volte\n  {old!r}")
    p.write_text(s.replace(old, new))
    print(f"  patch {rel}")

# 1. Identita' del prodotto, galleria Open VSX
product = json.loads((SRC / "product.json").read_text())
product.update(json.loads((ROOT / "product.bottega.json").read_text()))
meta = json.loads((ROOT / "bottega.json").read_text())
product["bottegaVersion"] = meta["version"]
product["bottegaBuild"] = meta["build"]
(SRC / "product.json").write_text(json.dumps(product, indent="\t", ensure_ascii=False) + "\n")
print("  product.json")

# 2. Temi predefiniti: Bottega Notte e Bottega Calima al posto di Dark/Light 2026
replace("src/vs/workbench/services/themes/common/workbenchThemeService.ts",
        "export const COLOR_THEME_DARK = 'Dark 2026';", "export const COLOR_THEME_DARK = 'Bottega Notte';")
replace("src/vs/workbench/services/themes/common/workbenchThemeService.ts",
        "export const COLOR_THEME_LIGHT = 'Light 2026';", "export const COLOR_THEME_LIGHT = 'Bottega Calima';")

# 3. Icona dell'app
shutil.copyfile(ROOT / "brand" / "Bottega.icns", SRC / "resources" / "darwin" / "code.icns")
print("  icona")

# 4. Ritocchi grafici del banco di lavoro: entrano nel bundle compilato, quindi i
#    checksum di integrita' restano coerenti e VS Code non segnala installazioni corrotte.
style = SRC / "src/vs/workbench/browser/media/style.css"
css = (ROOT / "brand" / "workbench.css").read_text()
s = style.read_text()
marker = "/* ===== Bottega:"
if marker in s:
    s = s[: s.index(marker)].rstrip() + "\n"
style.write_text(s + "\n" + css)
print("  workbench.css")
