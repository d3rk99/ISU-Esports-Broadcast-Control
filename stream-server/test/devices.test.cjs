const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSources, parseDshowList, parseDshowOptions, parseV4l2Formats, deviceInput, listDevices } = require('../core/media/devices.cjs');
const { validate, defaults } = require('../core/config.cjs');

// Real-shaped Windows FFmpeg output (dshow), new -sources format and the classic list format.
const SOURCES_DSHOW = `Auto-detected sources for dshow:
  @device_sw_{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\{A3FCE0F5-3493-419F-958A-ABA1250EC20B} [OBS Virtual Camera] (video)
  @device_pnp_\\\\?\\usb#vid_0fd9&pid_0066 [Game Capture HD60 X] (video)
  @device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{1} [Digital Audio Interface (Game Capture HD60 X)] (audio)
  @device_sw_{860BB310}\\{DeckLink} [Decklink Video Capture] (video)
  @device_cm_{33D9A762}\\Decklink Audio Capture [Decklink Audio Capture] (audio)
`;
const LIST_DSHOW = `[dshow @ 000001] "OBS Virtual Camera" (video)
[dshow @ 000001]   Alternative name "@device_sw_{860BB310}\\{A3FCE0F5}"
[dshow @ 000001] "Logitech BRIO" (video)
[dshow @ 000001] "Microphone (Logitech BRIO)" (audio)
[dshow @ 000001] "Broken thing" (none)
dummy: Immediate exit requested`;
const OPTIONS = `[dshow @ 01] DirectShow video device options (from video devices)
[dshow @ 01]  Pin "Capture" (alternative pin name "0")
[dshow @ 01]   vcodec=mjpeg  min s=1920x1080 fps=30 max s=1920x1080 fps=60.0002
[dshow @ 01]   pixel_format=nv12  min s=1280x720 fps=5 max s=1280x720 fps=59.9402
[dshow @ 01]   pixel_format=yuyv422  min s=1920x1080 fps=5 max s=1920x1080 fps=30
[dshow @ 01]   vcodec=mjpeg  min s=1920x1080 fps=30 max s=1920x1080 fps=60.0002`;

test('parses dshow devices: virtual camera, capture card, DeckLink, audio', () => {
  const d = parseSources(SOURCES_DSHOW);
  assert.deepEqual(d.map((x) => x.name), ['OBS Virtual Camera', 'Game Capture HD60 X', 'Digital Audio Interface (Game Capture HD60 X)', 'Decklink Video Capture', 'Decklink Audio Capture']);
  assert.deepEqual(d[2].kinds, ['audio']);
  const l = parseDshowList(LIST_DSHOW);
  assert.deepEqual(l.map((x) => `${x.name}:${x.kinds}`), ['OBS Virtual Camera:video', 'Logitech BRIO:video', 'Microphone (Logitech BRIO):audio']);
});

test('listDevices falls back to the classic dshow list when -sources is empty', async () => {
  const run = async (_f, args) => (args.includes('-sources') ? 'Auto-detected sources for dshow:\n' : LIST_DSHOW);
  const r = await listDevices('ffmpeg', { platform: 'win32', run });
  assert.equal(r.backend, 'dshow');
  assert.deepEqual(r.video.map((v) => v.name), ['OBS Virtual Camera', 'Logitech BRIO']);
  assert.deepEqual(r.audio.map((v) => v.name), ['Microphone (Logitech BRIO)']);
});

test('parses modes, dedupes, rounds 59.94/60 and sorts biggest first', () => {
  const m = parseDshowOptions(OPTIONS);
  assert.deepEqual(m.map((x) => x.label), ['1920x1080 @ 60 fps · mjpeg', '1920x1080 @ 30 fps · yuyv422', '1280x720 @ 59.94 fps · nv12']);
  const v = parseV4l2Formats('[video4linux2,v4l2 @ 0x1] Compressed:       mjpeg :          Motion-JPEG : 1920x1080 1280x720\n[video4linux2,v4l2 @ 0x1] Raw       :     yuyv422 :           YUYV 4:2:2 : 640x480');
  assert.deepEqual(v.map((x) => x.label), ['1920x1080 · mjpeg', '1280x720 · mjpeg', '640x480 · yuyv422']);
});

test('dshow args: card audio on the same input; compressed vs raw format flag; silence when no audio', () => {
  const a = deviceInput({ videoDevice: 'Game Capture HD60 X', audioDevice: 'Digital Audio Interface (Game Capture HD60 X)', videoSize: '1920x1080', framerate: '59.94', deviceFormat: 'nv12' }, { platform: 'win32' });
  assert.deepEqual(a.args.slice(-2), ['-i', 'video=Game Capture HD60 X:audio=Digital Audio Interface (Game Capture HD60 X)']);
  assert.ok(a.args.includes('-pixel_format') && a.args.includes('-rtbufsize'));
  assert.equal(a.audio, '0:a:0');
  const b = deviceInput({ videoDevice: 'OBS Virtual Camera', deviceFormat: 'mjpeg' }, { platform: 'win32' });
  assert.ok(b.args.includes('-vcodec') && b.args.includes('anullsrc=r=48000:cl=stereo'));
  assert.equal(b.audio, '1:a:0');
  assert.throws(() => deviceInput({ videoDevice: '' }, { platform: 'win32' }), /Choose a video capture device/);
});

test('config: device source needs a device and sane mode values', () => {
  const c = defaults(); c.input = { ...c.input, type: 'device', videoDevice: 'OBS Virtual Camera', videoSize: '1920x1080', framerate: '60000/1001', deviceFormat: 'nv12' };
  assert.equal(validate(c).input.type, 'device');
  assert.throws(() => validate({ ...c, input: { ...c.input, videoDevice: '' } }), /Pick a video capture device/);
  assert.throws(() => validate({ ...c, input: { ...c.input, framerate: '60; rm -rf' } }), /frame rate/);
  assert.throws(() => validate({ ...c, input: { ...c.input, deviceFormat: 'nv12 -i x' } }), /pixel format/);
});

test('A/V sync like OBS: one dshow graph, device timestamps (no wall-clock restamp), 10 ms audio buffer; manual offset', () => {
  const a = deviceInput({ videoDevice: 'Blackmagic Web Presenter', audioDevice: 'Blackmagic Web Presenter Audio' }, { platform: 'win32' });
  assert.deepEqual(a.args.slice(-2), ['-i', 'video=Blackmagic Web Presenter:audio=Blackmagic Web Presenter Audio']);
  assert.ok(!a.args.includes('-use_wallclock_as_timestamps'));
  assert.equal(a.args[a.args.indexOf('-audio_buffer_size') + 1], '10');
  const b = deviceInput({ videoDevice: 'V', audioDevice: 'A', audioBufferMs: 40 }, { platform: 'win32' }).args;
  assert.equal(b[b.indexOf('-audio_buffer_size') + 1], '40');
  assert.ok(!deviceInput({ videoDevice: 'V' }, { platform: 'win32' }).args.includes('-audio_buffer_size'));
  const { ProgramEncoder } = require('../core/media/encoder.cjs');
  const enc = new ProgramEncoder({ nvencUsable: true, libx264: true, path: 'ffmpeg' });
  const settings = { mode: 'hardware', resolution: '1280x720', fps: 59.94, videoBitrate: 3000, audioBitrate: 128 };
  const late = enc.args({ type: 'test', audioOffsetMs: -150 }, settings).join(' ');
  assert.match(late, /setpts=PTS\+0\.150\/TB,scale/); // audio earlier = picture held back 150 ms
  const early = enc.args({ type: 'test', audioOffsetMs: 200 }, settings).join(' ');
  assert.match(early, /asetpts=PTS\+0\.200\/TB,aresample/);
  assert.doesNotMatch(enc.args({ type: 'test' }, settings).join(' '), /setpts/);
  assert.throws(() => validate({ ...defaults(), input: { ...defaults().input, audioOffsetMs: 5000 } }), /Audio sync offset/);
});
