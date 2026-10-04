#!/bin/zsh
# Le fotografie della sfera per la Live Activity dell'iPhone (SferaFoto in ios/BottegaWidget/AttivitaWidget.swift).
# Una Live Activity non esegue Metal: si disegna la sfera vera con il renderer del Nucleo (modalita' piccola, senza
# scintille ne' bagliore), si riducono i toni per uno schermo normale, si ricavano tre stati e si sfuma l'alone.
# Serve ImageMagick (magick) e Python con Pillow. Da rifare quando cambiano OrbRenderer.swift o OrbShaders.metal.
set -euo pipefail
QUI=${0:A:h}
ROOT=${QUI:h:h}
T=$(mktemp -d)
trap 'rm -rf $T' EXIT
ORB=$ROOT/nucleo/Sources/Orb
# encodeFrame e' privata nel Nucleo: la copia di lavoro la rende visibile al programma
sed 's/    private func encodeFrame(/    func encodeFrame(/' $ORB/OrbRenderer.swift > $T/OrbRenderer.swift
cp $ROOT/nucleo/Sources/Voice/AudioLevels.swift $T/
nice swiftc -O -o $T/sfera $QUI/main.swift $QUI/shim.swift $T/OrbRenderer.swift $T/AudioLevels.swift
# stato 0 (a riposo nel Nucleo), 288 px, 5 s perche' arrivi il rumore ricco, modalita' piccola, esposizione 1.2
$T/sfera $ORB/OrbShaders.metal 0 288 5 $T/grezza.png piccola 1.2
magick $T/grezza.png -channel RGB -modulate 100,200 -sigmoidal-contrast 6x55% +channel $T/base.png
magick $T/base.png -resize 96x96 $T/lavoro.png
magick $T/base.png -channel RGB -modulate 72,30 +channel -resize 96x96 $T/riposo.png
# ambra fatta apposta per «ti aspetta»: la tinta della sfera calma girata, non lo stato di errore del Nucleo
magick $T/base.png -channel RGB -modulate 100,95,9 +channel -resize 96x96 $T/aspetta.png
python3 - $T <<'PY'
import math, sys
from PIL import Image
t = sys.argv[1]
for n in ['riposo', 'lavoro', 'aspetta']:
    im = Image.open(f'{t}/{n}.png').convert('RGBA'); w, h = im.size; px = im.load()
    cx, cy, R = (w - 1) / 2, (h - 1) / 2, w / 2
    for y in range(h):
        for x in range(w):
            r = math.hypot(x - cx, y - cy) / R
            m = 1.0 if r <= 0.84 else max(0.0, 1 - (r - 0.84) / 0.16)
            m = m * m * (3 - 2 * m)
            p = px[x, y]; px[x, y] = (p[0], p[1], p[2], int(p[3] * m))
    im.save(f'{t}/{n}-finale.png', optimize=True)
PY
A=$ROOT/ios/BottegaWidget/Assets.xcassets
cp $T/riposo-finale.png $A/SferaRiposo.imageset/SferaRiposo.png
cp $T/lavoro-finale.png $A/SferaLavoro.imageset/SferaLavoro.png
cp $T/aspetta-finale.png $A/SferaAspetta.imageset/SferaAspetta.png
echo "Fatte: SferaRiposo, SferaLavoro, SferaAspetta ($(du -ch $A/Sfera*.imageset/*.png | tail -1 | cut -f1))"
