from frame import *
from PIL import ImageEnhance
W,H=1800,1100
canvas=background(W,H,glows=[(W*0.55,H*1.0,W*0.75,H*0.5,0.38),(W*0.6,H*0.45,W*0.7,H*0.6,0.07)],nstars=320)
back=window('lavori_e.png',1120,radius=16)
a=back.getchannel('A'); back=ImageEnhance.Brightness(back.convert('RGB')).enhance(0.78).convert('RGBA'); back.putalpha(a)
bx,by=W-1120-70,56
shadow(canvas,back,bx,by,[(50,30,0.7,(2,4,10),0),(12,10,0.5,(0,0,0),0)])
canvas.alpha_composite(back,(bx,by))
front=window('plancia_e.png',1360,radius=20)
fx,fy=70,H-front.height-90
shadow(canvas,front,fx,fy,[(70,44,0.85,(2,4,10),0),(20,16,0.6,(0,0,0),0),(4,3,0.45,(0,0,0),0)])
canvas.alpha_composite(front,(fx,fy))
c=canvas.convert('RGB'); c.save('out/hero.png',optimize=True); c.save('out/hero.jpg',quality=88,subsampling=0,optimize=True,progressive=True)
print(c.size, front.size, (fx,fy))
