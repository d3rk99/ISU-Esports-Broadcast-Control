const path = require('node:path');
const { createWorker, OEM, PSM } = require('tesseract.js');
const englishData = require('@tesseract.js-data/eng');

function isRecoverableWorkerPipeError(error) {
  return error?.code === 'EPIPE' || /\bEPIPE\b|broken pipe/i.test(String(error?.message || error || ''));
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

  async getWorker(key = 'default') {
    if (!this.workerPromises.has(key)) {
      const langPath = unpackedPath(englishData.langPath);
      const workerPath = unpackedPath(require.resolve('tesseract.js/src/worker-script/node/index.js'));
      const corePath = unpackedPath(path.dirname(require.resolve('tesseract.js-core/package.json')));
      const workerPromise = this.createWorkerImpl(englishData.code || 'eng', OEM.LSTM_ONLY, {
        langPath,
        workerPath,
        corePath,
        cacheMethod: 'none',
        gzip: englishData.gzip !== false,
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

  async recognizeNow(image, { allowedChars = '0123456789:', kind = 'score', fieldId = 'default' } = {}) {
    const startedAt = Date.now();
    try {
      const worker = await this.getWorker(fieldId);
      await worker.setParameters({
        tessedit_char_whitelist: allowedChars,
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
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
      if (isRecoverableWorkerPipeError(error)) this.workerPromises.delete(fieldId);
      throw error;
    }
  }

  async recognize(image, options = {}) {
    const fieldId = options.fieldId || 'default';
    const key = fieldId.startsWith('observer3-')
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

module.exports = { TesseractOcrEngine, isRecoverableWorkerPipeError, unpackedPath };
