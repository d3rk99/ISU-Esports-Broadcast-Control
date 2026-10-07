#!/bin/sh
# Retrain the VALORANT name model (Linux/WSL with tesseract 5 training tools: tesseract,
# lstmtraining, combine_tessdata). ~10 min on a normal CPU.
#   sh tools/valorant-name-training/train.sh
# Writes electron/ocr-models/val.traineddata. Add real gamertags to REAL in make_data.py first.
set -e
cd "$(dirname "$0")"
mkdir -p base
[ -f eng_best.traineddata ] || curl -sL -o eng_best.traineddata https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata
combine_tessdata -e eng_best.traineddata base/eng.lstm
rm -rf out lstmf ckpt && mkdir -p ckpt
python3 make_data.py ${SAMPLES:-6400}
sh prep.sh
lstmtraining --model_output ckpt/valnames --continue_from base/eng.lstm --traineddata eng_best.traineddata \
  --train_listfile train.txt --eval_listfile eval.txt --max_iterations ${ITER:-6000} --debug_interval -1
lstmtraining --stop_training --convert_to_int --continue_from ckpt/valnames_checkpoint \
  --traineddata eng_best.traineddata --model_output ../../electron/ocr-models/val.traineddata
echo "done: electron/ocr-models/val.traineddata"
