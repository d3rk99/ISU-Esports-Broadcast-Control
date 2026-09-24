# Parallel scoreboard OCR

In the controller OCR Lab or the Game Bridge VALORANT settings, choose **Parallel Grid OCR**: 1, 2, 4 (default), or 8 workers. Apply/save the settings. For remote capture, change this on the bridge computer, where recognition actually runs.

The scoreboard scans batches of up to the selected number of cells from one captured frame. A bounded Tesseract worker pool performs text recognition concurrently. Home score, away score, and timer retain separate workers and an independent schedule; they do not wait for the scoreboard batch. Initial player-name acquisition still precedes regular grid scanning.

The grid scan interval is the delay between completed batches, not a guaranteed per-cell refresh period. The debug view highlights all active cells and reports the last completed grid sweep duration. Compare sweep times at 1, 2, and 4 workers using the same scene after warm-up. Try 8 only if the capture PC has spare CPU and memory; check game frame rate as well as OCR speed.

More workers do not guarantee proportional acceleration: capture, image preprocessing, and loadout image matching still share main-process work. Worker startup also costs time and memory. Reducing the setting limits concurrent jobs but previously initialized idle workers remain allocated until the app restarts. No real-game speedup is claimed without measuring it on the capture PC.

Automated tests cover bounded worker concurrency, serialization within a worker, independent headline scanning while grid work is blocked, and discarding grid results after state reset.
