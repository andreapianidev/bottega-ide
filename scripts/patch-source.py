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

# 5. Niente Copilot integrato: la Bottega lavora con Claude Code. Nella 1.140 il passo che
#    prepara l'SDK di Copilot funziona solo nella CI di Microsoft (che scarica Copilot gia'
#    pronto) e in una build locale fallisce; saltarlo fa anche risparmiare otto minuti.
replace("build/lib/extensions.ts",
        "\tconst extensionPath = path.join(root, 'extensions', 'copilot');\n\tif (!fs.existsSync(extensionPath)) {",
        "\tconst extensionPath = path.join(root, 'extensions', 'copilot');\n\tif (process.env.BOTTEGA_BUILD || !fs.existsSync(extensionPath)) {")
replace("build/gulpfile.vscode.ts",
        "\t\tprepareBuiltInCopilotRipgrepShim(platform, arch, builtInCopilotExtensionDir, appNodeModulesDir);",
        "\t\tif (fs.existsSync(builtInCopilotExtensionDir)) {\n\t\t\tprepareBuiltInCopilotRipgrepShim(platform, arch, builtInCopilotExtensionDir, appNodeModulesDir);\n\t\t}")

# 6. Niente verifica delle firme delle estensioni: il verificatore (@vscode/vsce-sign) e' solo nel
#    VS Code di Microsoft, quindi in una build dai sorgenti ogni estensione da Open VSX si fermerebbe
#    su "cannot verify the extension signature". Lo stesso fa VSCodium.
p = "src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts"
s = (SRC / p).read_text()
old = "description: localize('extensions.verifySignature', \"When enabled, extensions are verified to be signed before getting installed.\"),\n\t\t\t\tdefault: true,"
new = "description: localize('extensions.verifySignature', \"When enabled, extensions are verified to be signed before getting installed.\"),\n\t\t\t\tdefault: false,"
replace(p, old, new)

# 7. Niente AI di VS Code fin dal primo avvio. La Bottega lo mette gia' a true nelle configurationDefaults
#    di bottega-theme, ma quelle arrivano solo dopo che l'estensione e' registrata: nel frattempo
#    l'agentHost (Copilot CLI) puo' partire e restare vivo fino alla chiusura.
replace("src/vs/workbench/contrib/chat/browser/chat.shared.contribution.ts",
        "\"Disable and hide built-in AI features provided by GitHub Copilot, including chat and inline suggestions.\"),\n\t\t\tdefault: false,",
        "\"Disable and hide built-in AI features provided by GitHub Copilot, including chat and inline suggestions.\"),\n\t\t\tdefault: true,")

# 8. Niente percorsi guidati e onboarding di primo avvio (propongono Copilot e i temi Dark/Light 2026).
#    Sono impostazioni APPLICATION e MACHINE: le configurationDefaults di un'estensione le scartano.
p = "src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts"
replace(p, "'workbench.welcomePage.walkthroughs.openOnInstall': {\n\t\t\tscope: ConfigurationScope.MACHINE,\n\t\t\ttype: 'boolean',\n\t\t\tdefault: true,",
        "'workbench.welcomePage.walkthroughs.openOnInstall': {\n\t\t\tscope: ConfigurationScope.MACHINE,\n\t\t\ttype: 'boolean',\n\t\t\tdefault: false,")
replace(p, "'workbench.welcomePage.experimentalOnboarding': {\n\t\t\tscope: ConfigurationScope.APPLICATION,\n\t\t\ttype: 'boolean',\n\t\t\tdefault: true,",
        "'workbench.welcomePage.experimentalOnboarding': {\n\t\t\tscope: ConfigurationScope.APPLICATION,\n\t\t\ttype: 'boolean',\n\t\t\tdefault: false,")

# 9. Niente finestra "Sessioni agenti" di VS Code: scripts/package.sh toglie out/vs/sessions (22 MB) quando
#    trova questa patch compilata. Chi chiede quella finestra (--agents, link bottega:// di sessione,
#    comandi) riceve una finestra normale, e un'area di lavoro degli agenti ripristinata si apre come
#    finestra normale invece di caricare sessions.html, che non c'e' piu'.
#    La condizione isMacintosh e' sempre vera (la Bottega e' solo per Mac): serve solo a non lasciare codice
#    irraggiungibile, che il compilatore TypeScript di VS Code rifiuta.
p = "src/vs/platform/windows/electron-main/windowsMainService.ts"
replace(p, "\t\tthis.logService.trace('windowsManager#openAgentsWindow');\n",
        "\t\tthis.logService.trace('windowsManager#openAgentsWindow');\n\t\tif (isMacintosh) {\n\t\t\treturn this.open(openConfig);\n\t\t}\n")
replace(p, "\t\t\tisSessionsWindow: isWorkspaceIdentifier(options.workspace) && isEqual(options.workspace.configPath, this.environmentMainService.agentSessionsWorkspace),",
        "\t\t\tisSessionsWindow: false,")
