"""Le catture del 2 ottobre 2026 (cruscotto, settimana, Vedetta, IDE con Claude Code).

Ritaglio sulla finestra, via la notifica di installazione in basso a destra, sfocatura dei nomi dei
clienti, poi la cornice di frame.py. Le coordinate valgono solo per queste catture.
Uso: python3 catture-2-ottobre.py <cartella con le catture> <cartella di uscita>
"""
import sys
from PIL import Image
from edit_lib import blur_box, erase_text
from frame import framed

src, out = sys.argv[1], sys.argv[2]
NOME = 'Screenshot 2026-10-02 alle {}.jpg'

# (cattura, nome, ritaglio sulla finestra, zone da sfocare in coordinate della cattura)
CATTURE = [
    ('02.46.04', 'cruscotto', (3, 0, 2973, 1877), [
        ('cielo', 1497, 1232, 1705, 1292),    # pesmitidelcalcio, etichetta nel cielo (cliente)
        (1995, 1760, 2310, 1845),    # pesmitidelcalcio, riga 9 dei progetti (cliente)
    ]),
    ('02.48.22', 'settimana', (20, 15, 3007, 1890), []),   # il taglio in basso toglie la notifica
    # La finestra della Vedetta e' quella del cruscotto spostata in su di 22 px: la barra del titolo
    # tagliata si rimette con le prime 22 righe della cattura delle 02.46.
    ('02.45.18', 'vedetta', (3, 0, 2973, 1872), []),
    ('03.08.39', 'ide', (4, 0, 3242, 2050), [
        ('cielo', 1705, 738, 1915, 792),      # pesmitidelcalcio, etichetta nel cielo (cliente)
    ]),
]

for cattura, nome, box, zone in CATTURE:
    im = Image.open(f'{src}/{NOME.format(cattura)}').convert('RGB')
    if nome == 'vedetta':
        sopra = Image.open(f'{src}/{NOME.format("02.46.04")}').convert('RGB').crop((0, 0, im.width, 22))
        alta = Image.new('RGB', (im.width, im.height + 22))
        alta.paste(sopra, (0, 0)); alta.paste(im, (0, 22)); im = alta
    for z in zone:
        if z[0] == 'cielo':
            erase_text(im, z[1:])
        else:
            blur_box(im, z)
    im = im.crop(box)
    tmp = f'{out}/{nome}_e.png'
    im.save(tmp)
    c = framed(tmp, f'{out}/{nome}')
    print(nome, c.size)
