const test = require('node:test');
const assert = require('node:assert/strict');
const { TesseractOcrEngine } = require('../electron/valorant-ocr-engine.cjs');

test('OCR engine keeps one independent worker per field', async () => {
  const workers = [];
  const engine = new TesseractOcrEngine({
    createWorkerImpl: async () => {
      const worker = {
        terminated: false,
        setParameters: async () => {},
        recognize: async () => ({ data: { text: '7', confidence: 90 } }),
        terminate: async () => { worker.terminated = true; }
      };
      workers.push(worker);
      return worker;
    }
  });
  await Promise.all([
    engine.recognize(Buffer.from('a'), { fieldId: 'homeScore' }),
    engine.recognize(Buffer.from('b'), { fieldId: 'awayScore' }),
    engine.recognize(Buffer.from('c'), { fieldId: 'homeScore' })
  ]);
  assert.equal(workers.length, 2);
  await engine.close();
  assert.equal(workers.every((worker) => worker.terminated), true);
});
