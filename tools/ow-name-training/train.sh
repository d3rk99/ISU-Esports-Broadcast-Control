#!/bin/sh
# Retrain the Overwatch name model (Linux/WSL with tesseract 5 training tools installed:
# tesseract, lstmtraining, combine_tessdata). Takes ~10 min on a normal CPU.
#   sh tools/ow-name-training/train.sh
# Writes electron/ocr-models/ow.traineddata. Add real gamertags to REAL in make_data.py first.
set -e
cd "$(dirname "$0")"
mkdir -p fonts base
[ -f fonts/BigNoodleTooOblique.ttf ] || curl -sL -o fonts/BigNoodleTooOblique.ttf https://raw.githubusercontent.com/Resike/Overwatch/master/Fonts/BigNoodleTooOblique.ttf
[ -f eng_best.traineddata ] || curl -sL -o eng_best.traineddata https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata
combine_tessdata -e eng_best.traineddata base/eng.lstm
rm -rf out lstmf ckpt && mkdir -p ckpt
python3 make_data.py 6400
sh prep.sh
lstmtraining --model_output ckpt/ownames --continue_from base/eng.lstm --traineddata eng_best.traineddata \
  --train_listfile train.txt --eval_listfile eval.txt --max_iterations 6000 --debug_interval -1
lstmtraining --stop_training --convert_to_int --continue_from ckpt/ownames_checkpoint \
  --traineddata eng_best.traineddata --model_output ../../electron/ocr-models/ow.traineddata
echo "done: electron/ocr-models/ow.traineddata"
