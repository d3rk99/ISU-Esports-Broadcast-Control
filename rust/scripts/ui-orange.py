# Dev helper: centres of orange (#f47920) buttons on a screenshot: "x y w h".
import sys; from PIL import Image
im=Image.open(sys.argv[1]).convert('RGB'); W,H=im.size
on=lambda p: abs(p[0]-0xf4)<12 and abs(p[1]-0x79)<16 and abs(p[2]-0x20)<16
seen=set(); boxes=[]
for y in range(0,H,3):
    for x in range(250,W,3):
        if (x,y) in seen or not on(im.getpixel((x,y))): continue
        x2=x
        while x2+3<W and on(im.getpixel((x2+3,y))): x2+=3
        y2=y
        while y2+3<H and on(im.getpixel((x,y2+3))): y2+=3
        for yy in range(y,y2+1,3):
            for xx in range(x,x2+1,3): seen.add((xx,yy))
        if x2-x>20 and y2-y>8: boxes.append(((x+x2)//2,(y+y2)//2,x2-x,y2-y))
for b in boxes: print(*b)
