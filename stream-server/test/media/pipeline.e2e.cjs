'use strict';
// Real-media end-to-end: test source -> ONE encoder -> disk delay -> 3 stream-copy outputs ->
// 3 local RTMP receivers. Checks enforced delay, encode-once, decodable synchronized A/V.
// Usage: node test/media/pipeline.e2e.cjs [delaySeconds=10] [outputs=3]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findFfmpeg } = require('../../core/media/ffmpeg.cjs');
const { RealEngine } = require('../../core/media/engine.cjs');
const { startReceiver } = require('./receiver.cjs');

const delaySeconds = Number(process.argv[2] ?? 10);
const outputCount = Number(process.argv[3] ?? 3);
const logger = { write() {} };

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration', '-of', 'json', file]).toString();
  return JSON.parse(out);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isu-e2e-'));
  const ffmpeg = await findFfmpeg();
  const engine = new RealEngine({ ffmpeg, storageDir: path.join(dir, 'delay'), credentials: { open: (c) => c }, logger });
  await engine.init();
  const receivers = [];
  for (let i = 0; i < outputCount; i++) receivers.push(await startReceiver(path.join(dir, `rx${i}.ts`)));
  engine.configureDestinations(receivers.map((r, i) => ({ id: `o${i}`, name: `RX ${i}`, enabled: true, protocol: 'RTMP', serverUrl: r.url, credential: 'test-key' })));
  const config = { input: { type: 'test' }, encoder: { mode: process.env.MODE || 'software', resolution: '1280x720', fps: 59.94, videoBitrate: 4000, audioBitrate: 128 }, delaySeconds };
  const startedAt = performance.now();
  await engine.startProgram(config);
  const encodeStartedAt = performance.now();

  // Interlock: before the buffer is ready every start path must be refused.
  let blocked = false;
  try { await engine.startAll(); } catch { blocked = true; }
  if (!blocked) throw new Error('INTERLOCK FAILED: startAll accepted before delay filled');

  while (!engine.ready()) {
    if (engine.state === 'ERROR') throw new Error(engine.error);
    if (performance.now() - startedAt > (delaySeconds + 30) * 1000) throw new Error('buffer never became ready');
    await new Promise((r) => setTimeout(r, 100));
  }
  const readyAt = performance.now();
  await engine.startAll();
  const firstChunk = await new Promise((resolve) => engine.delay.once('chunk', resolve));
  // Stream 12 s of delayed media to every receiver.
  await new Promise((r) => setTimeout(r, 12000));
  const snap = engine.snapshot();
  await engine.close();
  for (const r of receivers) await r.stop();

  const results = receivers.map((r) => {
    const info = probe(r.file);
    return { file: path.basename(r.file), bytes: fs.statSync(r.file).size, streams: info.streams.map((s) => `${s.codec_type}:${s.codec_name}${s.width ? ` ${s.width}x${s.height}@${s.avg_frame_rate}` : ''}`), duration: Number(info.format.duration).toFixed(2), firstMediaAfterEncodeS: ((r.firstMediaAt - encodeStartedAt) / 1000).toFixed(2) };
  });
  const report = {
    delaySeconds,
    readyAfterS: ((readyAt - encodeStartedAt) / 1000).toFixed(2),
    firstReleasedChunkAgeS: (firstChunk.ageMs / 1000).toFixed(3),
    encoder: snap.encoder,
    encoderInstance: snap.encoderInstance,
    outputsFedByEncoderInstance: snap.outputs.map((o) => o.encoderInstance),
    outputs: snap.outputs.map((o) => ({ state: o.state, sentChunks: o.sentChunks, dropped: o.droppedChunks, error: o.error })),
    receivers: results
  };
  console.log(JSON.stringify(report, null, 2));
  const problems = [];
  if (Number(report.readyAfterS) < delaySeconds) problems.push('ready before the delay elapsed');
  if (firstChunk.ageMs < delaySeconds * 1000) problems.push('a chunk was released early');
  if (new Set(report.outputsFedByEncoderInstance).size !== 1) problems.push('outputs fed by different encoders');
  for (const r of results) {
    if (!r.streams.some((s) => s.startsWith('video:h264')) || !r.streams.some((s) => s.startsWith('audio:aac'))) problems.push(`${r.file}: missing h264/aac`);
    if (Number(r.firstMediaAfterEncodeS) < delaySeconds) problems.push(`${r.file}: received media before the delay`);
  }
  console.log(problems.length ? `FAIL: ${problems.join('; ')}` : 'PASS');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(problems.length ? 1 : 0);
})().catch((error) => { console.error('E2E ERROR', error); process.exit(1); });
