// Pink noise for the player headset (IEMs carry game + comms underneath; the headset masks the room).
// The noise is generated here (no audio file to ship or license): 30 s of pink noise made with
// Paul Kellet's filter, crossfaded into itself so the loop has no click, played on the output
// device picked in the client settings. The controller only says on/off + volume; this side caps
// it with the station's own "max volume" and always fades in/out so nobody gets a jolt.
(() => {
  const LOOP_SECONDS = 30;
  const XFADE_SECONDS = 1;
  const FADE_IN = 1.5; const FADE_OUT = 0.6;
  let ctx = null; let gain = null; let source = null; let buffer = null;
  let want = { on: false, volume: 30 }; let device = { id: '', label: '', maxVolume: 60 };
  let status = { state: 'off', device: '', error: '' };
  let report = () => {};

  // Pink noise, peak-normalized to -6 dBFS. Separate generators per channel (decorrelated stereo).
  function makeBuffer(rate) {
    const len = Math.round(LOOP_SECONDS * rate); const xf = Math.round(XFADE_SECONDS * rate);
    const out = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c += 1) {
      const raw = new Float32Array(len + xf);
      let b0 = 0; let b1 = 0; let b2 = 0; let b3 = 0; let b4 = 0; let b5 = 0; let b6 = 0;
      for (let i = 0; i < raw.length; i += 1) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
      }
      // Equal-power crossfade of the tail into the head: the loop point is seamless.
      for (let i = 0; i < xf; i += 1) { const t = i / xf; raw[i] = raw[i] * Math.sin(t * Math.PI / 2) + raw[len + i] * Math.cos(t * Math.PI / 2); }
      let peak = 0; for (let i = 0; i < len; i += 1) peak = Math.max(peak, Math.abs(raw[i]));
      const k = 0.5 / (peak || 1);
      const ch = out.getChannelData(c); for (let i = 0; i < len; i += 1) ch[i] = raw[i] * k;
    }
    return out;
  }

  const level = () => Math.max(0, Math.min(1, (want.volume / 100) * (device.maxVolume / 100)));
  function setStatus(next) { status = { ...status, ...next }; report(status); }

  async function ensureContext() {
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: 'playback' });
      gain = ctx.createGain(); gain.gain.value = 0; gain.connect(ctx.destination);
      buffer = makeBuffer(ctx.sampleRate);
    }
    if (ctx.state === 'suspended') await ctx.resume();
    await applyDevice();
  }

  async function applyDevice() {
    if (!ctx || typeof ctx.setSinkId !== 'function') return;
    const id = device.id || '';
    try {
      if ((ctx.sinkId || '') !== id) await ctx.setSinkId(id);
      setStatus({ device: device.label || 'Default output', error: '' });
    } catch (error) {
      // Picked headset unplugged/renamed: fall back to the default output and say so.
      try { await ctx.setSinkId(''); } catch {}
      setStatus({ device: 'Default output', error: `Headset "${device.label || id}" not found, using default output` });
    }
  }

  async function apply() {
    try {
      if (want.on) {
        await ensureContext();
        if (!source) {
          source = ctx.createBufferSource(); source.buffer = buffer; source.loop = true;
          source.connect(gain); source.start();
        }
        const now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now); gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(level(), now + FADE_IN);
        setStatus({ state: 'playing' });
      } else if (ctx && source) {
        const now = ctx.currentTime; const s = source; source = null;
        gain.gain.cancelScheduledValues(now); gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + FADE_OUT);
        setTimeout(() => { try { s.stop(); s.disconnect(); } catch {} }, FADE_OUT * 1000 + 100);
        setStatus({ state: 'off' });
      } else setStatus({ state: 'off' });
    } catch (error) {
      setStatus({ state: 'error', error: error.message || String(error) });
    }
  }

  window.pinkNoise = {
    set(next = {}) { want = { on: Boolean(next.on), volume: Math.max(0, Math.min(100, Number(next.volume ?? want.volume) || 0)) }; return apply(); },
    setDevice(next = {}) { device = { id: String(next.id || ''), label: String(next.label || ''), maxVolume: Math.max(0, Math.min(100, Number(next.maxVolume ?? 60))) }; return ctx ? applyDevice().then(() => want.on && apply()) : Promise.resolve(); },
    onStatus(fn) { report = fn; report(status); },
    level, // for tests
    status: () => status
  };
})();
