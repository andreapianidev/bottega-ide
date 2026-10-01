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
  rsync -a --exclude node_modules --exclude src --exclude tsconfig.json --exclude package-lock.json $ROOT/extensions/$e/ $EXT/$e/
done

# product.json viene scritto al momento della compilazione: il numero di build si allinea qui.
python3 - $DIST/Contents/Resources/app/product.json $VERSION $BUILD <<'PY'
import json, sys
p, v, b = sys.argv[1], sys.argv[2], int(sys.argv[3])
d = json.load(open(p)); d["bottegaVersion"] = v; d["bottegaBuild"] = b
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

echo "== firma ad hoc"
codesign --force --deep --sign - $DIST 2>&1 | tail -2
codesign --verify --deep $DIST && echo "firma ok"

echo "== installazione in /Applications"
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
