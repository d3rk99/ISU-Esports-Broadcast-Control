const test = require('node:test');
const assert = require('node:assert/strict');
const { ValorantWindowCapture } = require('../electron/valorant-capture.cjs');

function image(width, height, resizeCalls = []) {
  return {
    getSize: () => ({ width, height }),
    resize(options) {
      resizeCalls.push(options);
      return image(options.width, options.height, resizeCalls);
    }
  };
}

test('near-1080p window captures are normalized to the OCR profile size', async () => {
  const resizeCalls = [];
  const thumbnail = image(1920, 1079, resizeCalls);
  const capture = new ValorantWindowCapture({
    desktopCapturer: {
      getSources: async () => [{ id: 'window:1', name: 'YouTube - VALORANT Test', thumbnail }]
    }
  });

  const frame = await capture.capture('YouTube');
  assert.deepEqual(resizeCalls, [{ width: 1920, height: 1080, quality: 'best' }]);
  assert.equal(frame.width, 1920);
  assert.equal(frame.height, 1080);
  assert.equal(frame.sourceWidth, 1920);
  assert.equal(frame.sourceHeight, 1079);
  assert.equal(frame.normalized, true);
  assert.deepEqual(frame.image.getSize(), { width: 1920, height: 1080 });
});

test('captures outside the near-1080p tolerance remain rejected', async () => {
  const capture = new ValorantWindowCapture({
    desktopCapturer: {
      getSources: async () => [{ id: 'window:1', name: 'VALORANT', thumbnail: image(1600, 900) }]
    }
  });

  await assert.rejects(capture.capture('VALORANT'), (error) => {
    assert.equal(error.code, 'CAPTURE_SIZE');
    assert.deepEqual(error.details, {
      width: 1600,
      height: 900,
      expectedWidth: 1920,
      expectedHeight: 1080,
      tolerance: 2
    });
    return true;
  });
});
