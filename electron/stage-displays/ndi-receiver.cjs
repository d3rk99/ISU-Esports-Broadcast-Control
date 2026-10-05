'use strict';
// Stage display client side of the NDI player cards: finds "ISU Player Card NN" for this
// station (mDNS discovery, plus the controller's IP directly in case multicast is filtered)
// and hands BGRA frames to the renderer, which paints them on a canvas. Latest frame wins;
// a slow renderer never queues frames.

function loadNdi() {
  try { return { ndi: require('@stagetimerio/grandiose'), error: '' }; }
  catch (error) { return { ndi: null, error: `NDI runtime not available on this station (${error.code || error.message})` }; }
}

class NdiCardReceiver {
  constructor({ onFrame, onStatus = () => {}, loadNdiImpl = loadNdi } = {}) {
    Object.assign(this, { onFrame, onStatus, loadNdiImpl });
    this.running = false;
    this.generation = 0;
  }

  sourceName(station, kind = 'card') { return `${kind === 'stage' ? 'ISU Stage' : 'ISU Player Card'} ${String(station).padStart(2, '0')}`; }

  async start({ station, controllerHost = '', kind = 'card', extraHosts = [] }) {
    await this.stop();
    const { ndi, error } = this.loadNdiImpl();
    if (!ndi) { this.onStatus({ state: 'error', error }); throw new Error(error); }
    this.ndi = ndi;
    this.running = true;
    const generation = ++this.generation;
    const wanted = this.sourceName(station, kind);
    this.onStatus({ state: 'searching', source: wanted });
    const ips = [controllerHost, ...extraHosts].filter(Boolean);
    const finder = await ndi.find({ showLocalSources: true, ...(ips.length ? { extraIPs: ips } : {}) });
    let source = null;
    try {
      for (let i = 0; i < 20 && !source && this.running && generation === this.generation; i += 1) {
        await finder.wait(500);
        source = finder.sources().find((s) => s.name.endsWith(`(${wanted})`) || s.name === wanted);
      }
    } finally { await finder.destroy(); }
    if (!source || generation !== this.generation) {
      if (generation === this.generation) this.onStatus({ state: 'error', error: `NDI source "${wanted}" not found on the network` });
      throw new Error(`NDI source "${wanted}" not found`);
    }
    this.receiver = await ndi.receive({ source, colorFormat: ndi.COLOR_FORMAT_RGBX_RGBA, bandwidth: ndi.BANDWIDTH_HIGHEST, name: `ISU Stage ${station}` });
    this.onStatus({ state: 'receiving', source: source.name });
    this.loop(generation);
    return source;
  }

  async loop(generation) {
    while (this.running && generation === this.generation) {
      try {
        const frame = await this.receiver.video(1000);
        if (!frame?.data || generation !== this.generation) continue;
        this.onFrame({ width: frame.xres, height: frame.yres, stride: frame.lineStrideBytes, data: frame.data, rgba: true });
      } catch (error) {
        if (/connection lost/i.test(String(error?.message))) { this.onStatus({ state: 'error', error: 'NDI connection lost' }); break; }
        // timeouts just mean no new frame (a static card only re-sends when it changes)
      }
    }
  }

  async stop() {
    this.running = false;
    this.generation += 1;
    const receiver = this.receiver;
    this.receiver = null;
    try { await receiver?.destroy?.(); } catch {}
  }
}

module.exports = { NdiCardReceiver, loadNdi };
