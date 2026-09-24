const test = require('node:test');
const assert = require('node:assert/strict');
const { TesseractOcrEngine, isRecoverableWorkerPipeError } = require('../electron/valorant-ocr-engine.cjs');

test('grid reuses a bounded pool and serializes each worker while running workers concurrently', async () => {
  let created = 0;
  let active = 0;
  let peak = 0;
  const engine = new TesseractOcrEngine({ createWorkerImpl: async () => {
    created++;
    let busy = false;
    return {
      setParameters: async () => { assert.equal(busy, false); },
      recognize: async () => {
        assert.equal(busy, false);
        busy = true;
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        busy = false;
        return { data: { text: '7', confidence: 95 } };
      },
      terminate: async () => {}
    };
  } });
  engine.observerConcurrency = 2;
  await Promise.all(Array.from({ length: 20 }, (_, index) => engine.recognize(Buffer.from('x'), { fieldId: `observer3-home-${index}-kills` })));
  assert.equal(created, 2);
  assert.equal(peak, 2);
  await engine.close();
});

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

test('OCR engine recreates a field worker after a broken pipe', async () => {
  let attempts = 0;
  const engine = new TesseractOcrEngine({
    createWorkerImpl: async () => {
      attempts += 1;
      return {
        setParameters: async () => {
          if (attempts === 1) {
            const error = new Error('broken pipe, write');
            error.code = 'EPIPE';
            throw error;
          }
        },
        recognize: async () => ({ data: { text: '9', confidence: 95 } }),
        terminate: async () => {}
      };
    }
  });
  await assert.rejects(() => engine.recognize(Buffer.from('a'), { fieldId: 'timer' }), /broken pipe/);
  const result = await engine.recognize(Buffer.from('b'), { fieldId: 'timer' });
  assert.equal(result.text, '9');
  assert.equal(attempts, 2);
  await engine.close();
});

test('OCR broken pipe detector accepts EPIPE variants', () => {
  const coded = new Error('write failed');
  coded.code = 'EPIPE';
  assert.equal(isRecoverableWorkerPipeError(coded), true);
  assert.equal(isRecoverableWorkerPipeError(new Error('broken pipe, write')), true);
  assert.equal(isRecoverableWorkerPipeError(new Error('other failure')), false);
});
