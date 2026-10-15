#!/bin/zsh
# Icona di Moony AI per l'app iPhone, il Watch, il widget Icona e la luna dell'avvio (Luna.imageset): la stessa luna dell'app Mac Moony AI.
# Non e' un disegno a parte: usa il generatore del Mac (~/Prototipi/Avo Agency AI/scripts/genera-icona-moony.swift,
# lo shader vero della sfera) e ne prende il corpo senza i margini macOS. Il generatore rende l'icona a 1273 px,
# cosi' il corpo dello squircle (824/1024) misura 1024: si ritaglia il centro e si appoggia su fondo notte pieno,
# perche' iOS e watchOS vogliono un quadrato opaco e la maschera la mettono loro.
#   scripts/icona-moony-ios.sh
set -euo pipefail
ROOT=${0:A:h:h}
GEN="$HOME/Prototipi/Avo Agency AI/scripts/genera-icona-moony.swift"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
nice swiftc -O "$GEN" -o "$TMP/genera"
nice "$TMP/genera" "$TMP" 1273
python3 - "$TMP/icon_1273.png" "$ROOT/ios" <<'PY'
import sys
from PIL import Image
src, ios = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGBA")
o = (im.width - 1024) // 2
corpo = im.crop((o, o, o + 1024, o + 1024))
# fondo: il colore del bordo dello squircle (notte grafite della vignetta), cosi' gli angoli non si vedono
fondo = Image.new("RGBA", corpo.size, (8, 8, 10, 255))
icona = Image.alpha_composite(fondo, corpo).convert("RGB")
for p in ("Bottega/Assets.xcassets/AppIcon.appiconset/icon-1024.png",
          "BottegaWatch/Assets.xcassets/AppIcon.appiconset/icon-1024.png"):
    icona.save(f"{ios}/{p}", optimize=True)
icona.resize((512, 512), Image.LANCZOS).save(f"{ios}/BottegaWidget/Assets.xcassets/Icona.imageset/icona.png", optimize=True)
# la luna con lo squircle del Mac, angoli trasparenti: schermata d'avvio e benvenuto dell'app
im.resize((512, 512), Image.LANCZOS).save(f"{ios}/Bottega/Assets.xcassets/Luna.imageset/luna.png", optimize=True)
print("icona Moony AI scritta: app iPhone, Watch, widget, luna dell'avvio")
PY
