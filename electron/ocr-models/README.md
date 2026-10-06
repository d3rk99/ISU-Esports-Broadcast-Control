# OCR models

`ow.traineddata`: Tesseract LSTM model for Overwatch scoreboard **player names**
(font BigNoodleTooOblique, white on team colour, capitals + digits + space/_).

- Fine-tuned from tessdata_best `eng` on 6,000 synthetic name lines drawn in the real font with
  the same preprocessing as the live read (4x, threshold 185, shear 0.21), int8.
- Real names from Derk's live boards (test/fixtures/ow-names): **17/20 exact vs 10/20** for the
  stock English model; names with digits (D3RK99, OOLAKACHO26, BINGUS457) now read right.
- Used for the `name` column only (`"lang": "ow"` in overwatch-ocr-profiles.json). Numbers keep
  the English model. If this file is missing the app falls back to English.
- Retrain: `sh tools/ow-name-training/train.sh` (needs tesseract 5 training tools).
