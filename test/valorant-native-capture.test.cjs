const test = require('node:test');
const assert = require('node:assert/strict');
const { HybridValorantWindowCapture, NativeValorantWindowCapture, NATIVE_BACKEND, FALLBACK_BACKEND, packedBgraBuffer } = require('../electron/valorant-native-capture.cjs');

function fakeImage(width, height) {
  return {
    getSize: () => ({ width, height }),
    resize: ({ width: nextWidth, height: nextHeight }) => fakeImage(nextWidth, nextHeight),
    crop: ({ width: nextWidth, height: nextHeight }) => fakeImage(nextWidth, nextHeight),
    toPNG: () => Buffer.from('png'),
    toDataURL: () => 'data:image/png;base64,test'
  };
}

test('native capture enumerates windows and emits normalized Windows Graphics Capture frames', async (t) => {
  let resolveFrame;
  class ScreenCapture {
    async start() {}
    nextFrame() { return new Promise((resolve) => { resolveFrame = resolve; }); }
    async stop() { resolveFrame?.(null); }
  }
  const captureModule = {
    isSupported: () => true,
    captureApiSupport: () => ({ graphicsCapture: true, minimumUpdateInterval: true }),
    enumerateWindows: () => [{ handle: 42, title: 'NACE VALORANT Test', isValid: true, width: 1920, height: 1079 }],
    ColorFormat: { Bgra8: 'bgra8' },
    ScreenCapture
  };
  const nativeImage = { createFromBitmap: (_buffer, size) => fakeImage(size.width, size.height) };
  const capture = new NativeValorantWindowCapture({ nativeImage, loadModule: async () => captureModule, now: () => 1234 });
  t.after(() => capture.close());
  assert.deepEqual(await capture.listWindows(), [{ id: 'hwnd:42', name: 'NACE VALORANT Test', handle: 42, width: 1920, height: 1079, backend: NATIVE_BACKEND }]);
  const pending = capture.capture('VALORANT', { captureFps: 8 });
  while (!resolveFrame) await new Promise((resolve) => setImmediate(resolve));
  resolveFrame({ width: 1920, height: 1079, buffer: Buffer.alloc(1920 * 1079 * 4) });
  const frame = await pending;
  assert.equal(frame.backend, NATIVE_BACKEND);
  assert.equal(frame.height, 1080);
  assert.equal(frame.sourceHeight, 1079);
  assert.equal(frame.normalized, true);
  assert.equal(frame.capturedAt, 1234);
});

test('hybrid capture prefers native and falls back automatically', async () => {
  const nativeFrame = { backend: NATIVE_BACKEND };
  const fallbackFrame = { sourceName: 'fallback' };
  const nativeCapture = { capture: async () => nativeFrame, close: async () => {} };
  const fallbackCapture = { capture: async () => fallbackFrame, close: async () => {} };
  const hybrid = new HybridValorantWindowCapture({ nativeCapture, fallbackCapture });
  assert.equal(await hybrid.capture('VALORANT'), nativeFrame);
  nativeCapture.capture = async () => { throw new Error('native unavailable'); };
  const fallback = await hybrid.capture('VALORANT');
  assert.equal(fallback.backend, FALLBACK_BACKEND);
  assert.match(fallback.fallbackReason, /native unavailable/);
});

test('hybrid native-only mode surfaces native errors instead of falling back', async () => {
  let fallbackCalls = 0;
  const hybrid = new HybridValorantWindowCapture({
    nativeCapture: { capture: async () => { throw new Error('native failed'); } },
    fallbackCapture: { capture: async () => { fallbackCalls += 1; } }
  });
  await assert.rejects(hybrid.capture('VALORANT', { backend: 'native' }), /native failed/);
  assert.equal(fallbackCalls, 0);
});

test('native capture removes GPU row padding before creating an Electron bitmap', () => {
  const source = Buffer.from([
    1, 2, 3, 4, 5, 6, 7, 8, 99, 99, 99, 99,
    9, 10, 11, 12, 13, 14, 15, 16, 99, 99, 99, 99
  ]);
  assert.deepEqual([...packedBgraBuffer({ buffer: source, rowPitch: 12 }, 2, 2)], [
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16
  ]);
});
