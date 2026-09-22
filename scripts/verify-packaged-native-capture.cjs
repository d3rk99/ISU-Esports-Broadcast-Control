const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const moduleRoot = process.argv[2];
  if (!moduleRoot) throw new Error('Pass the packaged app.asar.unpacked node_modules path');
  const entry = path.join(path.resolve(moduleRoot), '@screen-capture', 'node', 'dist', 'index.mjs');
  const capture = await import(pathToFileURL(entry).href);
  if (!capture.isSupported?.()) throw new Error('Native screen capture reports unsupported');
  const support = capture.captureApiSupport?.();
  if (!support?.graphicsCapture) throw new Error('Windows Graphics Capture is unavailable');
  const windows = capture.enumerateWindows?.();
  if (!Array.isArray(windows)) throw new Error('Native window enumeration did not return an array');
  process.stdout.write(`PACKAGED_NATIVE_CAPTURE_OK windows=${windows.length}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
