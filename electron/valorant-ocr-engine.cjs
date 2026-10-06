const path = require('node:path');
const { createWorker, OEM, PSM } = require('tesseract.js');
const englishData = require('@tesseract.js-data/eng');

function isRecoverableWorkerPipeError(error) {
  return error?.code === 'EPIPE' || /\bEPIPE\b|broken pipe/i.test(String(error?.message || error || ''));
}

// Extra trained models shipped with the app (electron/ocr-models/<code>.traineddata). 'ow' =
// Overwatch scoreboard names (BigNoodleTooOblique, fine-tuned from tessdata_best eng, see
// electron/ocr-models/README.md). Missing file = fall back to English.
const CUSTOM_LANG_DIR = path.join(__dirname, 'ocr-models');
function customLangAvailable(code) {
  try { return require('node:fs').existsSync(path.join(unpackedPath(CUSTOM_LANG_DIR), `${code}.traineddata`)); } catch { return false; }
}

function unpackedPath(value) {
  return String(value || '').replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

class TesseractOcrEngine {
  constructor({ createWorkerImpl = createWorker } = {}) {
    this.createWorkerImpl = createWorkerImpl;
    this.workerPromises = new Map();
    this.workerJobs = new Map();
    this.observerConcurrency = 4;
    this.observerCursor = 0;
  }

  async getWorker(key = 'default', lang = 'eng') {
    const custom = lang !== 'eng' && customLangAvailable(lang);
    key = custom ? `${lang}:${key}` : key;
    if (!this.workerPromises.has(key)) {
      const langPath = custom ? unpackedPath(CUSTOM_LANG_DIR) : unpackedPath(englishData.langPath);
      const workerPath = unpackedPath(require.resolve('tesseract.js/src/worker-script/node/index.js'));
      const corePath = unpackedPath(path.dirname(require.resolve('tesseract.js-core/package.json')));
      const workerPromise = this.createWorkerImpl(custom ? lang : (englishData.code || 'eng'), OEM.LSTM_ONLY, {
        langPath,
        workerPath,
        corePath,
        cacheMethod: 'none',
        gzip: custom ? false : englishData.gzip !== false,
        logger: () => {}
      }).catch((error) => {
        this.workerPromises.delete(key);
        throw error;
      });
      this.workerPromises.set(key, workerPromise);
    }
    return this.workerPromises.get(key);
  }

  enqueueWorkerJob(key, task) {
    const previous = this.workerJobs.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    const tail = next.catch(() => {}).finally(() => {
      if (this.workerJobs.get(key) === tail) this.workerJobs.delete(key);
    });
    this.workerJobs.set(key, tail);
    return next;
  }

  async recognizeNow(image, { allowedChars = '0123456789:', kind = 'score', fieldId = 'default', pageMode = 'line', lang = 'eng' } = {}) {
    const startedAt = Date.now();
    try {
      const worker = await this.getWorker(fieldId, lang);
      await worker.setParameters({
        tessedit_char_whitelist: allowedChars,
        tessedit_pageseg_mode: pageMode === 'char' ? PSM.SINGLE_CHAR : PSM.SINGLE_LINE,
        preserve_interword_spaces: '0'
      });
      const result = await worker.recognize(image);
      const confidence = Math.max(0, Math.min(1, Number(result?.data?.confidence || 0) / 100));
      return {
        text: String(result?.data?.text || '').trim(),
        confidence,
        latencyMs: Date.now() - startedAt,
        kind
      };
    } catch (error) {
      if (isRecoverableWorkerPipeError(error)) { this.workerPromises.delete(fieldId); this.workerPromises.delete(`${lang}:${fieldId}`); }
      throw error;
    }
  }

  async recognize(image, options = {}) {
    const fieldId = options.fieldId || 'default';
    // Scoreboard grids (VALORANT Observer 3, Overwatch board) share a small worker pool.
    const key = fieldId.startsWith('observer3-') || fieldId.startsWith('overwatch-')
      ? `grid-worker-${this.observerCursor++ % this.observerConcurrency}`
      : fieldId;
    return this.enqueueWorkerJob(key, () => this.recognizeNow(image, { ...options, fieldId: key }));
  }

  async close() {
    const workerPromises = [...this.workerPromises.values()];
    this.workerPromises.clear();
    this.workerJobs.clear();
    await Promise.all(workerPromises.map(async (workerPromise) => {
      try { await (await workerPromise).terminate(); } catch {}
    }));
  }
}

module.exports = { TesseractOcrEngine, isRecoverableWorkerPipeError, unpackedPath, customLangAvailable, CUSTOM_LANG_DIR };
