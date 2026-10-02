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

def erase_text(im, box, margin=60, radius=22, feather=6):
    """Toglie un'etichetta del cielo: al suo posto la luce sfocata di quello che ha intorno, con i bordi
    sfumati, cosi' resta un alone di cielo e non un rettangolo."""
    from PIL import ImageDraw
    x0, y0, x1, y1 = box
    big = (x0 - margin, y0 - margin, x1 + margin, y1 + margin)
    r = im.crop(big).filter(ImageFilter.GaussianBlur(radius))
    m = Image.new('L', r.size, 0)
    ImageDraw.Draw(m).rounded_rectangle([margin, margin, margin + x1 - x0, margin + y1 - y0], radius=12, fill=255)
    m = m.filter(ImageFilter.GaussianBlur(feather))
    im.paste(r, big[:2], m)
