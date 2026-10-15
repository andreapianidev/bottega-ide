#!/bin/zsh
# Icona di Moony AI per l'app iPhone, il Watch, il widget Icona e la luna dell'avvio (Luna.imageset): la stessa
# icona dell'app Mac Moony AI. Non e' un disegno a parte: parte dal PNG a 1024 dell'app Mac (MAC qui sotto, scritto
# da ~/Prototipi/Avo Agency AI/scripts/genera-icona-moony.swift), stessa luna, stesso alone, stesse proporzioni.
# Quando l'icona del Mac cambia, si rilancia questo script. Su iOS e watchOS l'icona e' un quadrato opaco (gli
# angoli li arrotonda il sistema): qui si tolgono cornice, ombra e trasparenza del Mac e la notte grafite continua
# fino ai bordi con la stessa vignetta del generatore (centro 0.115/0.118/0.132, bordo 0.030/0.031/0.038, piena a 1,15 volte il semiasse del corpo).
# Se il generatore cambia quei valori o la griglia (tela 1024, corpo 824), vanno cambiati anche qui.
#   scripts/icona-moony-ios.sh
set -euo pipefail
ROOT=${0:A:h:h}
MAC="$HOME/Prototipi/Avo Agency AI/Avo Agency AI/Assets.xcassets/AppIcon.appiconset/icon_1024.png"
python3 - "$MAC" "$ROOT/ios" <<'PY'
import sys, math
from PIL import Image
src, ios = sys.argv[1], sys.argv[2]
mac = Image.open(src).convert("RGBA")
W = mac.width
c, a = W / 2, 412 * W / 1024
centro, bordo = (0.115, 0.118, 0.132), (0.030, 0.031, 0.038)
# fondo: la vignetta del generatore estesa a tutto il quadrato
fondo = Image.new("RGBA", (W, W))
px = fondo.load()
for y in range(W):
    for x in range(W):
        k = min(1, math.hypot(x + 0.5 - c, y + 0.5 - c) / (a * 1.15)) ** 2
        px[x, y] = tuple(round((ce + (bo - ce) * k) * 255) for ce, bo in zip(centro, bordo)) + (255,)
# il corpo del Mac sopra; l'ombra (nera, alfa al massimo 0,42) fuori dallo squircle non si porta
r, g, b, al = mac.split()
al = al.point(lambda v: max(0, min(255, round((v - 115) * 255 / 140))))
icona = Image.alpha_composite(fondo, Image.merge("RGBA", (r, g, b, al))).convert("RGB")
for p in ("Bottega/Assets.xcassets/AppIcon.appiconset/icon-1024.png",
          "BottegaWatch/Assets.xcassets/AppIcon.appiconset/icon-1024.png"):
    icona.save(f"{ios}/{p}", optimize=True)
icona.resize((512, 512), Image.LANCZOS).save(f"{ios}/BottegaWidget/Assets.xcassets/Icona.imageset/icona.png", optimize=True)
# la luna con lo squircle del Mac, angoli trasparenti: schermata d'avvio e benvenuto dell'app
mac.resize((512, 512), Image.LANCZOS).save(f"{ios}/Bottega/Assets.xcassets/Luna.imageset/luna.png", optimize=True)
print("icona Moony AI scritta: app iPhone, Watch, widget, luna dell'avvio")
PY
