# Dev helper: find words on a screenshot (tesseract, 3x upscale). prints "word x y" (screen coords).
import sys; from PIL import Image; import subprocess
im=Image.open(sys.argv[1]).convert('L'); W,H=im.size; k=3
big=im.resize((W*k,H*k)).point(lambda v:0 if v>100 else 255); big.save('/tmp/ui-find.png')
d=subprocess.run(['tesseract','/tmp/ui-find.png','-','--psm','11','tsv'],capture_output=True,text=True).stdout.splitlines()
for l in d[1:]:
    p=l.split('\t')
    if len(p)>11 and p[11].strip() and float(p[10])>40: print(p[11], int(p[6])//k+int(p[8])//(2*k), int(p[7])//k+int(p[9])//(2*k))
