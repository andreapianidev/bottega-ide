import numpy as np
from PIL import Image, ImageFilter

def blur_box(im, box, down=12, radius=14):
    x0,y0,x1,y1 = box
    a = np.asarray(im.crop(box)).astype(np.uint8)
    p = 40
    a = np.pad(a, ((p,p),(p,p),(0,0)), mode='edge')
    r = Image.fromarray(a)
    w,h = r.size
    r = r.resize((max(1,w//down), max(1,h//down)), Image.BOX).resize((w,h), Image.BILINEAR)
    r = r.filter(ImageFilter.GaussianBlur(radius))
    r = r.crop((p,p,p+(x1-x0),p+(y1-y0)))
    im.paste(r, (x0,y0))

pl = Image.open('plancia_c.png').convert('RGB')
boxes = [
    (1292,1378,1680,1436),   # ImmoCRM-Cloud description
    (1292,1483,1640,1541),   # TiVedo-android description
    (1292,1588,1850,1646),   # ImmobiliareAI description (client name)
    (1292,1694,2095,1744),   # DonnaIsabella last commit message (client data)
    (838,1694,1100,1744),    # DonnaIsabella project name (client)
]
for b in boxes: blur_box(pl, b)
pl.save('plancia_e.png')

lv = Image.open('lavori_c.png').convert('RGB')
a = np.asarray(lv).copy()
a[698:782, 1555:1820] = (19,26,45)
Image.fromarray(a).save('lavori_e.png')

for n in ['memoria','melissa']:
    Image.open(f'{n}_c.png').convert('RGB').save(f'{n}_e.png')
