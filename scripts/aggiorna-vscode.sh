#!/bin/zsh
# Porta la Bottega su un'altra versione di VS Code. La lancia la Bottega dopo «Aggiorna» nella notifica (quando Claude
# Code chiede un VS Code piu' nuovo), oppure si lancia a mano:
#   scripts/aggiorna-vscode.sh 1.141.0
# Cambia vscodeTag in bottega.json, alza la build, ricompila e installa (scripts/build.sh: alla fine la Bottega si
# chiude e si riapre), poi commit e push di bottega.json e ios/Version.xcconfig, e di nient'altro.
# Se la compilazione si ferma (una patch che non si applica piu', un errore) bottega.json torna com'era e in
# /Applications resta la Bottega di prima. L'esito va in ~/.bottega/aggiornamento.json: la Bottega lo legge e lo dice.
set -uo pipefail
ROOT=${0:A:h:h}
TAG=${1:-}
STATO=$HOME/.bottega/aggiornamento.json
LOG=$HOME/.bottega/aggiornamento.log
mkdir -p $HOME/.bottega

esito() {  # esito <stato> [motivo] [push]
  python3 - "$STATO" "$TAG" "$1" "${2:-}" "${3:-}" "$ROOT/bottega.json" <<'PY'
import json, sys, time
f, tag, stato, motivo, push, conf = sys.argv[1:7]
d = {"stato": stato, "tag": tag, "at": int(time.time() * 1000)}
try: d["build"] = json.load(open(conf))["build"]
except Exception: pass
if motivo: d["motivo"] = motivo
if push: d["push"] = push == "si"
json.dump(d, open(f, "w"), indent=2, ensure_ascii=False)
PY
}

echo "== $(date '+%d/%m/%Y %H:%M') aggiornamento a VS Code ${TAG:-?}"
if [[ ! $TAG =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
  echo "Manca la versione, per esempio: scripts/aggiorna-vscode.sh 1.141.0"; exit 1
fi
if pgrep -f "gulp vscode-darwin" >/dev/null; then
  esito fallito "C'era gia' una compilazione di VS Code in corso: riprova quando ha finito."; exit 1
fi
esito "in corso"

# copie per tornare indietro se la compilazione si ferma
TMP=$(mktemp -d)
cp $ROOT/bottega.json $TMP/ && cp $ROOT/ios/Version.xcconfig $TMP/ 2>/dev/null
indietro() {
  cp $TMP/bottega.json $ROOT/bottega.json
  [[ -f $TMP/Version.xcconfig ]] && cp $TMP/Version.xcconfig $ROOT/ios/Version.xcconfig
}

python3 - $ROOT/bottega.json $TAG <<'PY'
import json, sys
p, tag = sys.argv[1:3]
d = json.load(open(p)); d["vscodeTag"] = tag
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
$ROOT/scripts/bump-build.sh

if ! $ROOT/scripts/build.sh; then
  indietro
  # il motivo piu' utile: la patch che non si applica (patch-source.py la nomina) o il primo errore di compilazione
  MOTIVO=$(grep -h "patch fallita" $LOG 2>/dev/null | tail -1 | cut -c1-200)
  [[ -n $MOTIVO ]] || MOTIVO=$(grep -hE "error TS|Error:" $ROOT/vendor/build.log $LOG 2>/dev/null | tail -1 | cut -c1-200)
  esito fallito "${MOTIVO:-Compilazione non riuscita.} Registro: ~/.bottega/aggiornamento.log."
  exit 1
fi

B=$(python3 -c "import json;print(json.load(open('$ROOT/bottega.json'))['build'])")
PUSH=si
git -C $ROOT commit -q -m "VS Code $TAG sotto la Bottega (build $B)" \
  -m "Aggiornamento lanciato dalla Bottega (scripts/aggiorna-vscode.sh): Claude Code chiedeva un VS Code piu' nuovo." \
  -- bottega.json ios/Version.xcconfig || PUSH=no
[[ $PUSH == si ]] && { git -C $ROOT push -q origin main || PUSH=no; }
esito fatto "" $PUSH
echo "== fatto: VS Code $TAG, build $B, push: $PUSH"
