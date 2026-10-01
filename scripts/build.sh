#!/bin/zsh
# Compila la Bottega dai sorgenti di VS Code e la installa in /Applications.
#   scripts/build.sh            build completa (sorgenti, dipendenze, compilazione, app)
#   scripts/build.sh --package  solo il confezionamento, riusando l'ultima compilazione
set -euo pipefail
ROOT=${0:A:h:h}
SRC=$ROOT/vendor/vscode
TAG=$(python3 -c "import json;print(json.load(open('$ROOT/bottega.json'))['vscodeTag'])")
LOG=$ROOT/vendor/build.log

[[ $(uname -m) == arm64 ]] || { echo "La Bottega e' solo per Apple Silicon."; exit 1; }
major=$(sw_vers -productVersion | cut -d. -f1)
(( major >= 27 )) || { echo "La Bottega richiede macOS 27 o successivo (qui: $(sw_vers -productVersion))."; exit 1; }

if [[ ${1:-} != --package ]]; then
  # Il Mac e' un Air da 16 GB: una compilazione di VS Code alla volta, e con priorita' bassa.
  if pgrep -f "gulp vscode-darwin" >/dev/null; then echo "C'e' gia' una compilazione di VS Code in corso."; exit 1; fi

  echo "== sorgenti VS Code $TAG"
  if [[ ! -d $SRC/.git ]]; then
    mkdir -p $SRC && git -C $SRC init -q && git -C $SRC remote add origin https://github.com/microsoft/vscode.git
  fi
  if ! git -C $SRC rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    for i in 1 2 3 4; do git -C $SRC fetch --depth 1 origin tag $TAG --no-tags && break; sleep 5; done
  fi
  # I file LFS servono solo ai test di Copilot: si saltano.
  git -C $SRC -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false checkout -q -f $TAG
  git -C $SRC clean -fdq   # niente -x: node_modules resta e si risparmiano venti minuti

  echo "== patch Bottega"
  (cd $SRC && python3 $ROOT/scripts/patch-source.py)

  echo "== Node $(cat $SRC/.nvmrc)"
  source ~/.nvm/nvm.sh
  nvm install "$(cat $SRC/.nvmrc)" >/dev/null
  nvm use "$(cat $SRC/.nvmrc)" >/dev/null

  cd $SRC
  stamp=$SRC/node_modules/.bottega-lock
  lockhash=$(shasum package-lock.json | cut -c1-40)
  if [[ ! -f $stamp || $(cat $stamp) != $lockhash ]]; then
    echo "== dipendenze npm (la prima volta ci vuole parecchio)"
    nice -n 10 npm ci 2>&1 | tee -a $LOG | tail -5
    echo $lockhash > $stamp
  fi

  echo "== compilazione (log in $LOG)"
  BOTTEGA_BUILD=1 NODE_OPTIONS=--max-old-space-size=7168 nice -n 10 npm run gulp vscode-darwin-arm64-min 2>&1 | tee -a $LOG | grep -E "Finished|Error|error TS" | tail -40
fi

$ROOT/scripts/package.sh
