// Automatic car artwork: renders a live player's car (from their Stats API loadout)
// with the Car Render Lab renderer, saves the PNG and hands back its URL.
// One hidden WebGL renderer, one render at a time, queued and de-duplicated.

import { createCarRenderer } from './rl-car-renderer.js';
import { buildAssetIndex, composeCar } from './rl-car-compose.js';
import { liveLoadoutKey } from './rl-roster-sync.js';
import { findFinish } from './rl-car-finish.js';

let packPromise = null;
let renderer = null;
let host = null;
const queue = [];
const queued = new Set();
let running = false;

async function assetPack() {
  if (!packPromise) {
    packPromise = (async () => {
      const pack = await window.isuDesktop?.getRocketLeagueCarAssetPack?.();
      if (!pack?.available) throw Error(pack?.error || 'Rocket League asset pack not found.');
      return { pack, index: buildAssetIndex(pack) };
    })();
    packPromise.catch(() => { packPromise = null; }); // retry next time (pack may be added later)
  }
  return packPromise;
}

async function details(kind, asset) {
  if (!asset?.id) return null;
  const result = await window.isuDesktop?.getRocketLeagueCarAssetDetails?.({ kind, id: asset.id });
  return result?.available && result.asset ? result.asset : asset;
}

function ensureRenderer() {
  if (renderer) return renderer;
  host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:500px;pointer-events:none;opacity:0';
  document.body.append(host);
  renderer = createCarRenderer(host);
  return renderer;
}

// job: { key, player: { id, name, loadout, teamNum }, teams, paint }
// Resolves { url, name, loadoutKey } or throws.
async function renderOne(job) {
  const { pack, index } = await assetPack();
  const finishes = pack.finishes || [];
  const fromFeed = (job.player.loadout || []).map((item) => findFinish(finishes, item)).find(Boolean);
  const paintFinish = fromFeed || finishes.find((f) => /^glossy$/i.test(f.displayName)) || null;
  const car = composeCar({ Loadout: job.player.loadout, TeamNum: job.player.teamNum }, job.teams || [], index, { paint: job.paint || null });
  if (!car.body) throw Error(`No asset for body "${job.player.loadout?.[0] || '?'}"`);
  const [body, decal, wheel] = await Promise.all([details('body', car.body), details('decal', car.decal), details('wheel', car.wheel)]);
  const r = ensureRenderer();
  const ok = await r.load(body.meshUrl, {
    name: body.displayName,
    url: body.meshUrl,
    bodyId: body.id,
    teamNum: car.teamNum,
    paint: car.paint,
    textures: body.textures || [],
    materialBindings: body.materialBindings || {},
    wheelAnchors: body.wheelAnchors,
    decal,
    wheel,
    paintFinish,
    accentFinish: paintFinish
  });
  if (!ok) throw Error('Render was cancelled.');
  const image = await window.isuDesktop?.saveCarRender?.(r.png());
  if (!image?.url) throw Error('Saving the render needs the desktop controller.');
  const label = [body.displayName, car.decal?.displayName].filter(Boolean).join(' / ');
  return { url: image.url, name: `Auto: ${label}`, loadoutKey: liveLoadoutKey(job.player.loadout) };
}

async function pump(onDone, onError) {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try { onDone(job, await renderOne(job)); }
      catch (error) { onError?.(job, error); }
      finally { queued.delete(job.key); }
    }
  } finally { running = false; }
}

// Adds a render job unless the same player+loadout is already waiting.
export function requestCarRender(job, onDone, onError) {
  const key = `${job.player.id}|${liveLoadoutKey(job.player.loadout)}|${JSON.stringify(job.paint || null)}`;
  if (queued.has(key)) return false;
  queued.add(key);
  queue.push({ ...job, key });
  pump(onDone, onError);
  return true;
}

export function carRenderQueueSize() {
  return queue.length + (running ? 1 : 0);
}
