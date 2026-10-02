#!/bin/zsh
# Prende l'app compilata da gulp, aggiunge le estensioni della Bottega, versione e firma,
# e la installa in /Applications/Bottega.app.
set -euo pipefail
ROOT=${0:A:h:h}
BUILT=$ROOT/vendor/VSCode-darwin-arm64/Bottega.app
DIST=$ROOT/dist/Bottega.app
read VERSION BUILD MINOS < <(python3 -c "import json;d=json.load(open('$ROOT/bottega.json'));print(d['version'],d['build'],d['minimumMacOS'])")

[[ -d $BUILT ]] || { echo "Manca $BUILT: lancia prima scripts/build.sh"; exit 1; }

echo "== estensioni della Bottega"
(cd $ROOT/extensions/bottega-home && npm install --silent && npm run -s build)
rm -rf $ROOT/dist && mkdir -p $ROOT/dist
ditto $BUILT $DIST
EXT=$DIST/Contents/Resources/app/extensions
# Copilot non fa parte della Bottega (vedi scripts/patch-source.py, punto 5).
rm -rf $EXT/copilot
for e in bottega-home bottega-theme; do
  rm -rf $EXT/$e && mkdir -p $EXT/$e
  rsync -a --exclude node_modules --exclude src --exclude /test --exclude tsconfig.json --exclude package-lock.json $ROOT/extensions/$e/ $EXT/$e/
done

# Potatura: quello che VS Code porta con se' e alla Bottega non serve (analisi del 2 ottobre 2026).
# Lavora solo sulla copia in dist/: la compilazione in vendor/ resta intera, quindi si torna indietro
# togliendo una riga da qui e rilanciando scripts/build.sh --package.
echo "== potatura ($(du -sm $DIST | cut -f1) MB)"
APP=$DIST/Contents/Resources/app
# Mappe dei sorgenti: servono solo a leggere i crash minificati (288 MB).
find $DIST -name '*.map' -type f -delete
# Copilot e la sandbox dei suoi agenti: li usa solo l'agentHost, spento con chat.disableAIFeatures (120 MB,
# di cui 24 MB di eseguibili Windows e Linux).
rm -rf $APP/node_modules.asar.unpacked/@github/copilot-sdk-darwin-arm64 $APP/node_modules.asar.unpacked/@microsoft/mxc-sdk
# Lingue di Electron: restano inglese e italiano, con le varianti di genere (46 MB).
for l in "$DIST/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/"*.lproj(N); do
  case ${l:t:r} in en|en_*|it|it_*) ;; *) rm -rf "$l";; esac
done
# Estensioni integrate che Andrea non usa: notebook, account Microsoft e GitHub, integrazione GitHub nel
# pannello Git, debugger JavaScript, inoltro porte, task di grunt/gulp/jake, temi in piu', grammatiche di
# linguaggi assenti dai suoi progetti, linguaggi dei prompt di Copilot. Groovy resta (build.gradle),
# C#, HLSL e ShaderLab restano (LaPalma3D, Unity).
for e in ipynb notebook-renderers microsoft-authentication github github-authentication tunnel-forwarding \
    ms-vscode.js-debug ms-vscode.js-debug-companion ms-vscode.vscode-js-profile-table debug-auto-launch debug-server-ready \
    grunt gulp jake \
    theme-abyss theme-kimbie-dark theme-monokai theme-monokai-dimmed theme-quietlight theme-red \
    theme-solarized-dark theme-solarized-light theme-tomorrow-night-blue \
    fsharp powershell perl julia r clojure coffeescript razor vb bat dart restructuredtext pug handlebars latex \
    markdown-math prompt-basics; do
  rm -rf $EXT/$e
done
# Finestra "Sessioni agenti": si toglie solo se la build contiene la patch 9 di patch-source.py (che non la
# apre mai), altrimenti un link bottega:// di sessione aprirebbe una finestra vuota.
SESSIONS=0
if grep -q 'isSessionsWindow:!1' $APP/out/mainImpl.js; then
  rm -rf $APP/out/vs/sessions && SESSIONS=1
fi
echo "   dopo: $(du -sm $DIST | cut -f1) MB"

# product.json viene scritto al momento della compilazione: il numero di build si allinea qui.
# Si rifonde anche product.bottega.json, cosi' le sue modifiche valgono senza ricompilare VS Code.
python3 - $DIST/Contents/Resources/app/product.json $VERSION $BUILD $ROOT/product.bottega.json $SESSIONS <<'PY'
import json, sys
p, v, b, over, sessions = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5] == "1"
d = json.load(open(p)); d.update(json.load(open(over))); d["bottegaVersion"] = v; d["bottegaBuild"] = b
if sessions:
    # Senza questi checksum VS Code direbbe "installazione danneggiata" per i file tolti.
    d["checksums"] = {k: c for k, c in d.get("checksums", {}).items() if not k.startswith("vs/sessions/")}
json.dump(d, open(p, "w"), indent="\t", ensure_ascii=False)
PY

echo "== Nucleo e Memoria dentro l'estensione"
HOME_EXT=$EXT/bottega-home
if [[ -x $ROOT/nucleo/build.sh ]]; then
  (cd $ROOT/nucleo && ./build.sh >/dev/null)
  rm -rf "$HOME_EXT/nucleo" && mkdir -p "$HOME_EXT/nucleo"
  ditto "$ROOT/nucleo/build/Bottega Nucleo.app" "$HOME_EXT/nucleo/Bottega Nucleo.app"
fi
if [[ -f $ROOT/memoria/cli.mjs ]]; then
  rsync -a --delete --exclude test --exclude '*.test.mjs' $ROOT/memoria/ $HOME_EXT/memoria/
fi

echo "== Info.plist (build $BUILD, macOS minimo $MINOS)"
PL=$DIST/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" $PL
/usr/libexec/PlistBuddy -c "Set :LSMinimumSystemVersion $MINOS" $PL 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :LSMinimumSystemVersion string $MINOS" $PL
/usr/libexec/PlistBuddy -c "Delete :LSArchitecturePriority" $PL 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSArchitecturePriority array" -c "Add :LSArchitecturePriority:0 string arm64" $PL

# Permessi di macOS: i testi li legge Andrea nella finestra di richiesta, quindi in italiano.
/usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription La Bottega ascolta la tua voce solo mentre parli con Melissa." $PL
/usr/libexec/PlistBuddy -c "Delete :NSSpeechRecognitionUsageDescription" $PL 2>/dev/null || true

# Firma con un'identita' stabile (il certificato Apple Development del Mac): con la firma ad hoc ogni
# build e' un'app nuova per macOS, che richiede di nuovo la password del Portachiavi ("Bottega Safe
# Storage"), microfono, notifiche e posizione. BOTTEGA_SIGN_IDENTITY la sceglie a mano; senza
# certificati si ripiega sull'ad hoc.
IDENTITY=${BOTTEGA_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | grep -m1 -oE '"Apple Development: [^"]+"' | tr -d '"')}
IDENTITY=${IDENTITY:--}
echo "== firma: ${IDENTITY/#-/ad hoc}"
# Il Nucleo sta in Resources, dove --deep non arriva: si firma prima, da solo (chiede microfono e
# notifiche, quindi anche lui deve restare la stessa app da una build all'altra).
NUCLEO_APP="$DIST/Contents/Resources/app/extensions/bottega-home/nucleo/Bottega Nucleo.app"
[[ -d "$NUCLEO_APP" ]] && codesign --force --timestamp=none --sign "$IDENTITY" "$NUCLEO_APP" 2>&1 | tail -2
codesign --force --deep --timestamp=none --sign "$IDENTITY" $DIST 2>&1 | tail -2
codesign --verify --deep $DIST && echo "firma ok"

echo "== installazione in /Applications"
# Andrea deve avere sempre l'ultima versione: se la Bottega e' aperta la si chiude con calma
# (VS Code ritrova schede e file non salvati), la si sostituisce e la si riapre.
WAS_RUNNING=0
MAIN='/Applications/Bottega.app/Contents/MacOS/Bottega( |$)'
# La Bottega di Andrea (senza argomenti) si riapre alla fine; qualsiasi altra istanza lanciata da
# /Applications (misure, prove) va chiusa comunque: togliere l'app sotto un processo vivo lo fa cadere.
pgrep -f '/Applications/Bottega.app/Contents/MacOS/Bottega$' >/dev/null && WAS_RUNNING=1
if pgrep -f "$MAIN" >/dev/null; then
  osascript -e 'tell application "Bottega" to quit' >/dev/null 2>&1 || true
  for i in {1..30}; do pgrep -f "$MAIN" >/dev/null || break; sleep 1; done
  pkill -TERM -f "$MAIN" 2>/dev/null || true
  for i in {1..10}; do pgrep -f "$MAIN" >/dev/null || break; sleep 1; done
fi
rm -rf /Applications/Bottega.app
ditto $DIST /Applications/Bottega.app
# Percorsi stabili per chi sta fuori dall'IDE (hook della Memoria, server MCP).
APPEXT=/Applications/Bottega.app/Contents/Resources/app/extensions/bottega-home
mkdir -p ~/.bottega/bin && chmod 700 ~/.bottega
[[ -d "$APPEXT/nucleo" ]] && ln -sfn "$APPEXT/nucleo/Bottega Nucleo.app/Contents/MacOS/BottegaNucleo" ~/.bottega/bin/nucleo
[[ -d "$APPEXT/memoria" ]] && ln -sfn "$APPEXT/memoria" ~/.bottega/memoria-app
mkdir -p ~/.local/bin
ln -sf /Applications/Bottega.app/Contents/Resources/app/bin/code ~/.local/bin/bottega
echo "Bottega $VERSION (build $BUILD) su VS Code $(python3 -c "import json;print(json.load(open('$DIST/Contents/Resources/app/package.json'))['version'])") installata."
if (( WAS_RUNNING )); then open -a /Applications/Bottega.app && echo "Bottega riaperta"; fi

# Comandi rapidi, Spotlight e il widget trovano il Nucleo solo se LaunchServices lo conosce: si
# registra la copia installata e si dimentica quella di sviluppo (stesso bundle id, widget doppio).
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
NUCLEO_APP="$APPEXT/nucleo/Bottega Nucleo.app"
if [[ -d "$NUCLEO_APP" ]]; then
  $LSREG -u "$ROOT/nucleo/build/Bottega Nucleo.app" 2>/dev/null || true
  pluginkit -r "$ROOT/nucleo/build/Bottega Nucleo.app/Contents/PlugIns/BottegaWidget.appex" 2>/dev/null || true
  $LSREG -f "$NUCLEO_APP" && echo "Nucleo registrato (Comandi rapidi, Spotlight)"
  [[ -d "$NUCLEO_APP/Contents/PlugIns/BottegaWidget.appex" ]] && pluginkit -a "$NUCLEO_APP/Contents/PlugIns/BottegaWidget.appex" || true
fi
