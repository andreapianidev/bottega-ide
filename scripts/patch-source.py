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
replace(p,
        "import { extUriBiasedIgnorePathCase, isEqual, isEqualAuthority, normalizePath, originalFSPath, removeTrailingPathSeparator }",
        "import { extUriBiasedIgnorePathCase, isEqualAuthority, normalizePath, originalFSPath, removeTrailingPathSeparator }")

# 10. Terminali nella barra: nomi contenuti, sessioni e menu al passaggio del mouse.
# Il modulo resta nei sorgenti Bottega; vendor/ viene sempre rigenerata da questo script.
shutil.copyfile(ROOT / 'brand/terminal-bar.ts', SRC / 'src/vs/workbench/contrib/terminal/browser/bottegaTerminalBar.ts')
p = 'src/vs/workbench/contrib/terminal/browser/terminalView.ts'
replace(p,
        "import * as nls from '../../../../nls.js';",
        "import { BottegaTerminalTabs } from './bottegaTerminalBar.js';\nimport * as nls from '../../../../nls.js';")
replace(p,
        "import { IViewDescriptorService } from '../../../common/views.js';",
        "import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';")
replace(p,
        'const item = this._instantiationService.createInstance(SingleTerminalTabActionViewItem, action, actions);',
        '''// The pane header and the composite title each own an ActionBar instance.
					// Do not put both controls in the same disposable map: replacing one
					// would unsubscribe the other while it is still visible.
					if (this.viewDescriptorService.getViewLocationById(this.id) === ViewContainerLocation.AuxiliaryBar) {
						return this._instantiationService.createInstance(BottegaTerminalTabs, action);
					}
					const item = this._instantiationService.createInstance(SingleTerminalTabActionViewItem, action, actions);''')
# I nodi testo diretti dentro display:flex non accettano text-overflow. Avvolgerli
# conserva icone/status nativi e rende efficace l'ellissi anche fuori dalla barra.
replace(p,
        "\t\t\tif (this._altCommand) {\n\t\t\t\tlabel.classList.remove(this._altCommand);",
        '''			for (const node of Array.from(label.childNodes)) {
				if (node.nodeType === 3) {
					const text = dom.$('span.bottega-terminal-label');
					text.textContent = node.textContent;
					node.replaceWith(text);
				}
			}

			if (this._altCommand) {
				label.classList.remove(this._altCommand);''')
p = 'src/vs/workbench/contrib/terminal/browser/terminalMenus.ts'
replace(p,
        "ContextKeyExpr.equals(`config.${TerminalSettingId.TabsShowActiveTerminal}`, 'always')",
        "ContextKeyExpr.equals(`config.${TerminalSettingId.TabsShowActiveTerminal}`, 'always'),\n\t\t\t\t\t\t\tContextKeyExpr.equals('viewLocation', 'auxiliarybar')")
p = 'src/vs/workbench/browser/parts/compositeBarActions.ts'
old = '''		this._register(this.hoverService.setupDelayedHover(this.container, () => ({
			content: this.computeTitle(),
			style: HoverStyle.Pointer,
			position: {
				hoverPosition: this.options.hoverOptions.position(),
			},
			persistence: {
				hideOnKeyDown: true,
			},
		}), { groupId: 'composite-bar-actions' }));'''
replace(p, old, "\t\tif (this.compositeBarActionItem.id !== 'terminal' || this.options.icon) {\n" + old + "\n\t\t}")
replace(p,
        '\t\tthis.updateChecked();\n\t\tthis.updateEnabled();',
        '''		this.updateChecked();
		this.updateEnabled();

		if (this.compositeBarActionItem.id === 'terminal' && !this.options.icon) {
			container.classList.add('bottega-terminal-trigger');
			container.setAttribute('aria-haspopup', 'menu');
			container.setAttribute('aria-expanded', 'false');
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cancel = () => { clearTimeout(timer); timer = undefined; };
			this._register(toDisposable(cancel));
			this._register(addDisposableListener(container, 'mouseenter', () => {
				cancel();
				timer = setTimeout(() => {
					if (container.isConnected) {
						void this.commandService.executeCommand('bottega.terminalMenu', container, false);
					}
				}, 250);
			}));
			this._register(addDisposableListener(container, 'mouseleave', cancel));
			this._register(addDisposableListener(container, 'mousedown', cancel));
			this._register(addDisposableListener(container, 'dragstart', cancel));
			this._register(addDisposableListener(container, 'keydown', (event: KeyboardEvent) => {
				if (event.key === 'ArrowDown') {
					EventHelper.stop(event, true);
					cancel();
					void this.commandService.executeCommand('bottega.terminalMenu', container, true);
				}
			}, true));
		}''')

# La toolbar nativa deve conoscere la larghezza minima reale del selettore,
# altrimenti lo considera una semplice icona da 22 px quando decide l'overflow.
p = 'src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarPart.ts'
replace(p,
        'getActionMinWidth: action => action instanceof SubmenuItemAction && action.item.isSplitButton ? 36 : undefined,',
        "getActionMinWidth: action => action.id === 'workbench.action.terminal.focus' ? 76 : action instanceof SubmenuItemAction && action.item.isSplitButton ? 36 : undefined,")

# Informazioni: l'identita' di Bottega arriva dal product.json del pacchetto,
# non dalla versione di VS Code usata per la compatibilita' delle estensioni.
replace('src/vs/base/common/product.ts',
        'export interface IProductConfiguration {',
        'export interface IProductConfiguration {\n\treadonly bottegaVersion?: string;\n\treadonly bottegaBuild?: number;')
about_prefix = '''(productService.bottegaVersion && productService.bottegaBuild !== undefined
			? `Versione Bottega: ${productService.bottegaVersion}\\nBuild: ${productService.bottegaBuild}\\n\\nBase VS Code\\n`
			: '') + '''
replace('src/vs/platform/dialogs/electron-browser/dialog.ts',
        "return localize({ key: 'aboutDetail',",
        "return " + about_prefix + "localize({ key: 'aboutDetail',")
replace('src/vs/workbench/browser/parts/dialogs/dialog.ts',
        "return localize('aboutDetail',",
        "return " + about_prefix + "localize('aboutDetail',")

# La sfera di Melissa occupa il posto dell'account nella barra sinistra. La sua vista
# usa gia' il motore WebGPU/Metal condiviso: qui c'e' solo il comando che la apre.
p = 'src/vs/workbench/browser/parts/globalCompositeBar.ts'
replace(p,
        "private readonly accountAction = this._register(new Action(ACCOUNTS_ACTIVITY_ID));",
        "private readonly accountAction = this._register(new Action(ACCOUNTS_ACTIVITY_ID));\n\tprivate readonly melissaAction = this._register(new Action('bottega.melissa', localize('bottegaMelissa', \"Parla con Melissa\"), 'bottega-melissa-action', true, async () => {\n\t\tawait this.commandService.executeCommand('bottega.barra.apri');\n\t\tawait this.commandService.executeCommand('bottega.voice.converse');\n\t}));")
replace(p,
        "@IExtensionService private readonly extensionService: IExtensionService,",
        "@IExtensionService private readonly extensionService: IExtensionService,\n\t\t@ICommandService private readonly commandService: ICommandService,")
replace(p,
        "if (action.id === ACCOUNTS_ACTIVITY_ID) {\n\t\t\t\t\treturn this.instantiationService.createInstance(AccountsActivityActionViewItem,",
        "if (action.id === 'bottega.melissa') {\n\t\t\t\t\treturn undefined;\n\t\t\t\t}\n\n\t\t\t\tif (action.id === ACCOUNTS_ACTIVITY_ID) {\n\t\t\t\t\treturn this.instantiationService.createInstance(AccountsActivityActionViewItem,")
replace(p,
        "\t\tthis.globalActivityActionBar.push(this.globalActivityAction);",
        "\t\tthis.globalActivityActionBar.push(this.melissaAction, { icon: true, label: false });\n\t\tthis.globalActivityActionBar.push(this.globalActivityAction);")
