#!/bin/sh
# Build .lstmf files from out/*.png + .gt.txt, split into train/eval lists.
set -e
cd "$(dirname "$0")"
rm -rf lstmf && mkdir -p lstmf
n=0
for png in out/*.png; do
  base=$(basename "$png" .png)
  # tesseract needs a box file: one line per character for a single-line image
  python3 -W ignore - "$png" "out/$base.gt.txt" > "out/$base.box" <<'EOF'
import sys
from PIL import Image
w, h = Image.open(sys.argv[1]).size
t = open(sys.argv[2]).read().rstrip('\n')
for ch in t:
    print(f"{' ' if ch == ' ' else ch} 0 0 {w} {h} 0")
print(f"\t 0 0 {w} {h} 0")
EOF
  tesseract "$png" "lstmf/$base" --psm 7 lstm.train >/dev/null 2>&1 || true
  n=$((n+1))
done
ls lstmf/*.lstmf | sort > all.txt
total=$(wc -l < all.txt)
head -n $((total - 400)) all.txt > train.txt
tail -n 400 all.txt > eval.txt
echo "lstmf: $total  train: $(wc -l < train.txt)  eval: $(wc -l < eval.txt)"
