'use strict';
// NDI receiver for the display client. Finds a source by name (mDNS + extra IPs for networks
// that block multicast), receives RGBX (the NDI SDK converts OBS's UYVY on its own thread),
// and hands the newest frame to the renderer. If the source disappears it keeps retrying.

function loadNdi() {
  try { return { ndi: require('@stagetimerio/grandiose'), error: '' }; }
  catch (error) { return { ndi: null, error: `NDI library could not load (${error.code || error.message}). This build is missing the bundled NDI runtime: rebuild with "npm run ndi:install" first, or install the NDI Runtime from ndi.video.` }; }
}

const matches = (sourceName, wanted) => sourceName === wanted || sourceName.endsWith(`(${wanted})`);

class NdiReceiver {
  constructor({ onFrame, onStatus = () => {}, loadNdiImpl = loadNdi, retryMs = 2000 } = {}) {
    Object.assign(this, { onFrame, onStatus, loadNdiImpl, retryMs });
    this.generation = 0;
  }

  async start({ source, hosts = [] }) {
    await this.stop();
    const generation = ++this.generation;
    const { ndi, error } = this.loadNdiImpl();
    if (!ndi) { this.onStatus({ state: 'error', error, source }); return; }
    this.ndi = ndi;
    this.run(generation, source, hosts.filter(Boolean));
  }

  live(generation) { return generation === this.generation; }

  async run(generation, wanted, hosts) {
    const ndi = this.ndi;
    while (this.live(generation)) {
      this.onStatus({ state: 'searching', error: '', source: wanted, fps: 0 });
      let found = null;
      const finder = await ndi.find({ showLocalSources: true, ...(hosts.length ? { extraIPs: hosts } : {}) });
      try {
        for (let i = 0; i < 10 && !found && this.live(generation); i += 1) {
          await finder.wait(500);
          found = finder.sources().find((s) => matches(s.name, wanted));
        }
      } finally { await finder.destroy().catch(() => {}); }
      if (!this.live(generation)) return;
      if (!found) {
        this.onStatus({ state: 'error', error: `NDI source "${wanted}" not found`, source: wanted, fps: 0 });
        await new Promise((r) => setTimeout(r, this.retryMs));
        continue;
      }
      const receiver = await ndi.receive({ source: found, colorFormat: ndi.COLOR_FORMAT_RGBX_RGBA, bandwidth: ndi.BANDWIDTH_HIGHEST, name: 'ISU Display Client' });
      this.receiver = receiver;
      this.onStatus({ state: 'receiving', error: '', source: found.name, fps: 0 });
      let frames = 0; let since = Date.now(); let idle = 0;
      while (this.live(generation)) {
        try {
          const frame = await receiver.video(1000);
          if (!frame?.data || !this.live(generation)) continue;
          idle = 0; frames += 1;
          this.onFrame({ width: frame.xres, height: frame.yres, stride: frame.lineStrideBytes, data: frame.data });
          const now = Date.now();
          if (now - since >= 2000) { this.onStatus({ state: 'receiving', error: '', source: found.name, fps: Math.round((frames * 1000) / (now - since)) }); frames = 0; since = now; }
        } catch (error) {
          if (/connection lost/i.test(String(error?.message))) break;
          // Graphics that don't change send few frames; only give up after 10 s of nothing.
          idle += 1;
          if (idle >= 10) break;
        }
      }
      try { await receiver.destroy?.(); } catch {}
      if (this.receiver === receiver) this.receiver = null;
      if (this.live(generation)) this.onStatus({ state: 'searching', error: 'NDI feed lost, reconnecting', source: wanted, fps: 0 });
    }
  }

  async stop() {
    this.generation += 1;
    const receiver = this.receiver; this.receiver = null;
    try { await receiver?.destroy?.(); } catch {}
  }
}

module.exports = { NdiReceiver, loadNdi, matches };
