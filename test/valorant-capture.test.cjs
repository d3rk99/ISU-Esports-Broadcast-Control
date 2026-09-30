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

test('16:9 captures at other resolutions are scaled onto the 1080p grid', async () => {
  for (const [width, height] of [[1600, 900], [2560, 1440], [3840, 2160], [1280, 720]]) {
    const resizeCalls = [];
    const capture = new ValorantWindowCapture({
      desktopCapturer: { getSources: async () => [{ id: 'window:1', name: 'VALORANT', thumbnail: image(width, height, resizeCalls) }] }
    });
    const frame = await capture.capture('VALORANT');
    assert.deepEqual(resizeCalls, [{ width: 1920, height: 1080, quality: 'best' }], `${width}x${height}`);
    assert.equal(frame.width, 1920);
    assert.equal(frame.sourceWidth, width);
    assert.equal(frame.normalized, true);
  }
});

test('captures with the wrong shape or too few pixels remain rejected', async () => {
  for (const [width, height] of [[1920, 1200], [2560, 1080], [1024, 768], [1152, 648]]) {
    const capture = new ValorantWindowCapture({
      desktopCapturer: { getSources: async () => [{ id: 'window:1', name: 'VALORANT', thumbnail: image(width, height) }] }
    });
    await assert.rejects(capture.capture('VALORANT'), (error) => {
      assert.equal(error.code, 'CAPTURE_SIZE', `${width}x${height}`);
      assert.deepEqual(error.details, { width, height, expectedWidth: 1920, expectedHeight: 1080, tolerance: 2 });
      return true;
    });
  }
});

test('empty window thumbnails are reported as a transient capture failure', async () => {
  const capture = new ValorantWindowCapture({
    desktopCapturer: {
      getSources: async () => [{ id: 'window:1', name: 'YouTube Test', thumbnail: image(0, 0) }]
    }
  });

  await assert.rejects(capture.capture('YouTube'), (error) => {
    assert.equal(error.code, 'CAPTURE_EMPTY');
    assert.equal(error.details.sourceName, 'YouTube Test');
    return true;
  });
});
