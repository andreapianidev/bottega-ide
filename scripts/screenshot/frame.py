import numpy as np
from PIL import Image, ImageFilter, ImageDraw
rng_seed = 7

def hexrgb(h): h=h.lstrip('#'); return np.array([int(h[i:i+2],16) for i in (0,2,4)],float)
NIGHT=hexrgb('121a2e'); DEEP=hexrgb('0c1222'); SODIUM=hexrgb('f4ab3c'); WARM=hexrgb('e8e2d0')

def background(W,H,glows,seed=rng_seed,nstars=260):
    y=np.linspace(0,1,H)[:,None,None]; x=np.linspace(0,1,W)[None,:,None]
    bg = NIGHT*(1-y) + DEEP*y
    bg = np.broadcast_to(bg,(H,W,3)).copy()
    yy,xx=np.mgrid[0:H,0:W].astype(float)
    for (cx,cy,rx,ry,strength) in glows:
        d=((xx-cx)/rx)**2+((yy-cy)/ry)**2
        g=np.exp(-d*2.2)*strength
        bg = 255-(255-bg)*(1-(SODIUM/255)*g[...,None])
    rng=np.random.default_rng(seed)
    img=Image.fromarray(np.clip(bg,0,255).astype(np.uint8))
    # stars, drawn on a 3x layer for antialiasing
    S=3
    layer=Image.new('RGBA',(W*S,H*S),(0,0,0,0)); dr=ImageDraw.Draw(layer)
    for _ in range(nstars):
        sx=rng.uniform(0,W); sy=rng.uniform(0,H*0.75)
        r=rng.choice([0.5,0.6,0.7,0.8,1.0,1.3],p=[.3,.25,.2,.12,.09,.04])
        a=int(rng.uniform(40,170)*(1-sy/H*0.9))
        col=tuple(WARM.astype(int)) if rng.random()>0.15 else tuple(SODIUM.astype(int))
        dr.ellipse([(sx-r)*S,(sy-r)*S,(sx+r)*S,(sy+r)*S],fill=col+(a,))
    layer=layer.resize((W,H),Image.LANCZOS)
    img=img.convert('RGBA'); img.alpha_composite(layer)
    # dither noise against banding
    a=np.asarray(img.convert('RGB')).astype(float)
    a+=rng.normal(0,0.9,a.shape)
    return Image.fromarray(np.clip(a,0,255).astype(np.uint8)).convert('RGBA')

def rounded_mask(w,h,r,S=4):
    m=Image.new('L',(w*S,h*S),0)
    ImageDraw.Draw(m).rounded_rectangle([0,0,w*S-1,h*S-1],radius=r*S,fill=255)
    return m.resize((w,h),Image.LANCZOS)

def window(src,ww,radius=20):
    im=Image.open(src).convert('RGB')
    wh=round(ww*im.height/im.width)
    im=im.resize((ww,wh),Image.LANCZOS)
    im=im.filter(ImageFilter.UnsharpMask(radius=0.7,percent=55,threshold=1))
    S=4
    # hairlines: outer dark, inner light
    border=Image.new('RGBA',(ww*S,wh*S),(0,0,0,0)); d=ImageDraw.Draw(border)
    d.rounded_rectangle([0,0,ww*S-1,wh*S-1],radius=radius*S,outline=(0,0,0,200),width=S)
    d.rounded_rectangle([S,S,ww*S-1-S,wh*S-1-S],radius=(radius-1)*S,outline=(255,255,255,34),width=S)
    border=border.resize((ww,wh),Image.LANCZOS)
    win=im.convert('RGBA'); win.alpha_composite(border)
    win.putalpha(rounded_mask(ww,wh,radius))
    return win

def shadow(canvas,win,x,y,layers):
    for (blur,dy,alpha,color,spread) in layers:
        W,H=canvas.size
        sh=Image.new('L',(W,H),0)
        m=win.getchannel('A')
        if spread:
            m=m.resize((win.width+2*spread,win.height+2*spread))
        sh.paste(m,(x-spread,y+dy-spread))
        sh=sh.filter(ImageFilter.GaussianBlur(blur))
        sh=sh.point(lambda v:int(v*alpha))
        col=Image.new('RGBA',(W,H),color+(255,)); col.putalpha(sh)
        canvas.alpha_composite(col)

SHADOW=[(60,40,0.75,(2,4,10),0),(18,14,0.55,(0,0,0),0),(4,3,0.45,(0,0,0),0)]

def framed(src,out,W=1800,pad=80,top=72,bottom=104):
    ww=W-2*pad
    win=window(src,ww)
    H=top+win.height+bottom
    canvas=background(W,H,glows=[(W*0.5,H*1.05,W*0.7,H*0.40,0.32),(W*0.5,H*0.6,W*0.65,H*0.65,0.05)])
    shadow(canvas,win,pad,top,SHADOW)
    canvas.alpha_composite(win,(pad,top))
    canvas=canvas.convert('RGB')
    canvas.save(out+'.png',optimize=True)
    canvas.save(out+'.jpg',quality=88,subsampling=0,optimize=True,progressive=True)
    return canvas

if __name__=='__main__':
    import sys
    for n in ['plancia','lavori','memoria','melissa']:
        c=framed(f'{n}_e.png',f'out/{n}')
        print(n,c.size)
