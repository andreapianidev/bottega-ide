#!/bin/zsh
# L'icona del Nucleo (notifiche, Comandi rapidi, widget sul Mac): la luna di Moony AI per Mac, non piu' la bottega
# (16/10/2026, Andrea: «le notifiche su macOS hanno la vecchia icona di Melissa e non la luna di Moony AI»). Parte dai
# PNG dell'app Mac Moony AI (AppIcon.appiconset, scritti da ~/Prototipi/Avo Agency AI/scripts/genera-icona-moony.swift)
# e scrive brand/MoonyAI.icns, che nucleo/build.sh mette nel Nucleo. Quando l'icona del Mac cambia, si rilancia.
#   scripts/icona-moony-mac.sh
set -euo pipefail
ROOT=${0:A:h:h}
SRC="$HOME/Prototipi/Avo Agency AI/Avo Agency AI/Assets.xcassets/AppIcon.appiconset"
SET=$(mktemp -d /tmp/moony-icona.XXXXXX)/MoonyAI.iconset
trap 'rm -rf "${SET:h}"' EXIT
mkdir -p "$SET"
for lato in 16 32 128 256 512; do
  cp "$SRC/icon_${lato}.png" "$SET/icon_${lato}x${lato}.png"
  cp "$SRC/icon_$((lato * 2)).png" "$SET/icon_${lato}x${lato}@2x.png"
done
iconutil -c icns -o "$ROOT/brand/MoonyAI.icns" "$SET"
echo "icona Moony AI per il Nucleo: brand/MoonyAI.icns"
