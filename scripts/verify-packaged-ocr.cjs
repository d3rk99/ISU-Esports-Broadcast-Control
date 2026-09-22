const path = require('node:path');

const moduleRoot = path.resolve(process.argv[2] || 'release/bridge/win-unpacked/resources/app.asar.unpacked/node_modules');
const { createWorker, OEM } = require(path.join(moduleRoot, 'tesseract.js'));
const englishData = require(path.join(moduleRoot, '@tesseract.js-data/eng'));

async function main() {
  const worker = await createWorker(englishData.code || 'eng', OEM.LSTM_ONLY, {
    langPath: englishData.langPath,
    workerPath: path.join(moduleRoot, 'tesseract.js/src/worker-script/node/index.js'),
    corePath: path.join(moduleRoot, 'tesseract.js-core'),
    cacheMethod: 'none',
    gzip: englishData.gzip !== false,
    logger: () => {}
  });

  console.log('PACKAGED_TESSERACT_WORKER_OK');
  await worker.terminate();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
