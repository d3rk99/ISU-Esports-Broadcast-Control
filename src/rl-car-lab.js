import { createCarRenderer } from './rl-car-renderer.js';
import { normalizeLoadout, loadoutKey } from './rl-loadout.js';
import './rl-car-lab.css';

function assetMatchKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function bodyMatchesLoadout(body, loadoutBody) {
  const target = assetMatchKey(loadoutBody);
  if (!target) return false;
  return [body.id, body.displayName, body.productId, ...(body.aliases || [])].some((value) => {
    const key = assetMatchKey(value);
    return key === target || key.endsWith(target) || target.endsWith(key);
  });
}

function assetMatchesLoadout(asset, loadoutItem) {
  const target = assetMatchKey(loadoutItem);
  if (!target) return false;
  return [asset.id, asset.displayName, asset.productId, ...(asset.aliases || [])].some((value) => {
    const key = assetMatchKey(value);
    return key === target || key.endsWith(target) || target.endsWith(key);
  });
}

export function openCarLab(getGame, saveLibrary) {
  if (document.querySelector('#rl-car-lab')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'rl-car-lab';
  dialog.innerHTML = `<header><div><small>ISU ESPORTS / EXPERIMENTAL</small><h2>Rocket League Car Render Lab</h2></div><button id="car-close">CLOSE</button></header>
    <p>Local WebGL renderer. Use the extracted Rocket League asset pack when available, or import a complete vehicle GLB with embedded textures you have permission to use.</p>
    <div class="car-lab-grid"><section>
      <label>TELEMETRY PLAYER<select id="car-player"></select></label><button id="car-refresh">REFRESH PLAYERS / LOADOUT</button>
      <label>DETECTED ASSETS<textarea id="car-loadout" readonly rows="7"></textarea></label>
      <label>MAP ARTWORK TO<select id="car-scope"><option value="body">This body (generic artwork for everyone using it)</option><option value="loadout">This reported loadout (operator-supplied appearance)</option></select></label>
      <div class="car-pack-panel">
        <div class="car-pack-head"><strong>RL LOADOUT ASSET PACK</strong><span id="car-pack-status">Checking...</span></div>
        <div class="car-pack-row">
          <img id="car-pack-thumb" alt="" />
          <label>BODY<select id="car-pack-body"></select></label>
        </div>
        <label>DECAL<select id="car-pack-decal"></select></label>
        <label>WHEEL<select id="car-pack-wheel"></select></label>
        <label>PAINT MODE<select id="car-paint-mode"><option value="team">Team blue/orange fallback</option><option value="custom">Custom lab colors</option><option value="off">No paint recolor</option></select></label>
        <div class="car-color-row">
          <label>PRIMARY<input id="car-primary-color" type="color" value="#1597ff"></label>
          <label>SECONDARY<input id="car-secondary-color" type="color" value="#82fff7"></label>
        </div>
        <button id="car-pack-load" disabled>LOAD SELECTED BODY</button>
      </div>
      <p class="car-warning">The API does not document every paint color. The extracted pack now supplies body, wheel, decal, material and texture links, but unknown player-selected colors may still use the blue/orange fallback.</p>
      <button id="car-import">IMPORT GLB FOR SELECTED MAPPING</button>
      <button id="car-saved">LOAD SAVED MODEL</button>
      <button id="car-demo">TEST WITH DEMO CAR</button>
      <label class="car-enabled"><input id="car-enabled" type="checkbox"> Use saved car artwork on player stat cards</label>
      <button id="car-remove">REMOVE SELECTED MAPPING</button>
    </section><section><div id="car-canvas"></div><p>Drag to rotate - scroll to zoom - transparent PNG output (800 x 500)</p>
      <button id="car-reset">RESET VIEW</button><button id="car-save" disabled>SAVE RENDER TO MAPPING</button>
      <p id="car-status" role="status">Select a live player, or use the demo to test rendering.</p>
    </section></div>`;
  document.body.append(dialog);
  const $ = (id) => dialog.querySelector(`#${id}`);
  let renderer;
  try { renderer = createCarRenderer($('car-canvas')); }
  catch (error) { dialog.remove(); throw Error(`WebGL unavailable: ${error.message}`); }
  let snapshot = [];
  let selected = null;
  let model = null;
  let loadedKey = '';
  let revision = 0;
  let closed = false;
  let busy = false;
  let pack = { available: false, bodies: [] };
  const library = () => getGame().rocketLeague.carRenderer || { enabled: false, models: {}, renders: {} };
  const status = (message) => { $('car-status').textContent = message; };
  const selectedBody = () => pack.bodies?.[Number($('car-pack-body').value)] || null;
  const selectedDecal = () => {
    if ($('car-pack-decal').value === 'auto') return loadoutDecal();
    if ($('car-pack-decal').value === 'none') return null;
    return pack.decals?.[Number($('car-pack-decal').value)] || null;
  };
  const selectedWheel = () => {
    if ($('car-pack-wheel').value === 'auto') return loadoutWheel();
    if ($('car-pack-wheel').value === 'none') return null;
    return pack.wheels?.[Number($('car-pack-wheel').value)] || null;
  };
  const loadoutDecal = () => {
    const body = selectedBody();
    const decalSlot = normalizeLoadout(selected?.loadout)[1];
    return pack.decals?.find((decal) => assetMatchesLoadout(decal, decalSlot)
      && (decal.universal || decal.appliesToBodyId === body?.id || assetMatchKey(decal.appliesToBodyName) === assetMatchKey(body?.displayName))) || null;
  };
  const loadoutWheel = () => {
    const wheelSlot = normalizeLoadout(selected?.loadout)[2];
    return pack.wheels?.find((wheel) => assetMatchesLoadout(wheel, wheelSlot)) || null;
  };
  const assetDetails = async (kind, asset) => {
    if (!asset?.id) return asset || null;
    const result = await window.isuDesktop?.getRocketLeagueCarAssetDetails?.({ kind, id: asset.id });
    if (!result?.available || !result.asset) return asset;
    return result.asset;
  };
  const key = () => loadoutKey(selected?.loadout, $('car-scope').value);
  const invalidate = () => { revision++; model = null; loadedKey = ''; $('car-save').disabled = true; };
  const syncPackThumbnail = () => {
    const body = selectedBody();
    $('car-pack-thumb').src = body?.thumbnailUrl || '';
    $('car-pack-thumb').style.visibility = body?.thumbnailUrl ? 'visible' : 'hidden';
  };
  const invalidatePackPreview = () => {
    invalidate();
    status('Selection changed. Press LOAD SELECTED BODY to render the current body/decal/wheel setup.');
  };
  const syncPackSelectionToLoadout = () => {
    if (!pack.available || !selected) return;
    const loadoutBody = normalizeLoadout(selected.loadout)[0];
    const index = pack.bodies.findIndex((body) => bodyMatchesLoadout(body, loadoutBody));
    if (index >= 0) $('car-pack-body').value = String(index);
    syncPackThumbnail();
  };
  const updateSelection = () => {
    invalidate();
    selected = snapshot[Number($('car-player').value)] || null;
    $('car-loadout').value = selected ? normalizeLoadout(selected.loadout).map((item, index) => `${index}: ${item || '(empty)'}`).join('\n') || 'No Loadout field received.' : 'No live players. Start the RL test feed or connect a match.';
    syncPackSelectionToLoadout();
    status(key() ? (library().renders?.[key()] ? 'Saved artwork exists for this mapping. Load the saved model to adjust it.' : 'Unmapped: import or load an asset-pack body. Existing preview is not assigned to this selection.') : 'Missing body data: live artwork remains unchanged.');
  };
  const refresh = () => {
    const previous = selected?.id;
    snapshot = structuredClone(getGame().rocketLeague.live?.players || []);
    $('car-player').replaceChildren(...snapshot.map((player, index) => new Option(`${player.name} - ${Number(player.teamNum) === 0 ? 'Blue' : 'Orange'}`, String(index))));
    const index = snapshot.findIndex((player) => player.id === previous);
    if (index >= 0) $('car-player').value = String(index);
    updateSelection();
  };
  const run = async (operation) => {
    if (busy) return;
    busy = true;
    try { await operation(); } catch (error) { if (!closed) status(error.message); }
    finally { busy = false; }
  };
  const load = async (asset) => {
    if (!asset) return;
    const targetKey = key();
    const version = ++revision;
    model = null; loadedKey = ''; $('car-save').disabled = true;
    status('Loading local model...');
    const success = await renderer.load(asset.url, asset);
    if (closed || version !== revision || !success) return;
    model = asset; loadedKey = targetKey; $('car-save').disabled = !targetKey;
    status(targetKey
      ? `Ready: ${asset.name}. Check orientation and appearance, then save. This preview does not update Program until saved.`
      : `Ready: ${asset.name}. No live player mapping is selected, so this preview is for testing only.`);
  };
  const loadPack = async () => {
    const result = await window.isuDesktop?.getRocketLeagueCarAssetPack?.();
    pack = result || { available: false, bodies: [] };
    if (!pack.available) {
      $('car-pack-status').textContent = pack.error || 'Not found';
      $('car-pack-body').replaceChildren(new Option('No asset pack found', ''));
      $('car-pack-load').disabled = true;
      syncPackThumbnail();
      return;
    }
    $('car-pack-status').textContent = `${pack.bodies.length} bodies / ${pack.wheels.length} wheels / ${pack.decals?.length || 0} decals${pack.itemCount ? ` / ${pack.itemCount} item rows` : ''}`;
    $('car-pack-body').replaceChildren(...pack.bodies.map((body, index) => new Option(body.displayName, String(index))));
    $('car-pack-decal').replaceChildren(
      new Option('Auto from selected player', 'auto'),
      new Option('None', 'none'),
      ...(pack.decals || []).map((decal, index) => new Option(`${decal.displayName}${decal.appliesToBodyName ? ` (${decal.appliesToBodyName})` : decal.universal ? ' (Universal)' : ''}`, String(index)))
    );
    $('car-pack-wheel').replaceChildren(
      new Option('Auto from selected player', 'auto'),
      new Option('None', 'none'),
      ...(pack.wheels || []).map((wheel, index) => new Option(wheel.displayName, String(index)))
    );
    $('car-pack-load').disabled = false;
    syncPackSelectionToLoadout();
  };
  $('car-player').onchange = updateSelection;
  $('car-scope').onchange = updateSelection;
  $('car-pack-body').onchange = () => { syncPackThumbnail(); invalidatePackPreview(); };
  $('car-pack-decal').onchange = invalidatePackPreview;
  $('car-pack-wheel').onchange = invalidatePackPreview;
  $('car-paint-mode').onchange = invalidatePackPreview;
  $('car-primary-color').onchange = invalidatePackPreview;
  $('car-secondary-color').onchange = invalidatePackPreview;
  $('car-refresh').onclick = refresh;
  $('car-pack-load').onclick = () => run(async () => {
    const body = await assetDetails('body', selectedBody());
    if (!body?.meshUrl) throw Error('Choose a body from the asset pack.');
    const decal = await assetDetails('decal', selectedDecal());
    const wheel = await assetDetails('wheel', selectedWheel());
    const paintMode = $('car-paint-mode').value;
    await load({
      name: body.displayName,
      url: body.meshUrl,
      source: 'rl-loadout-assets',
      bodyId: body.id,
      teamNum: Number(selected?.teamNum) || 0,
      paintMode,
      useTeamPaint: paintMode !== 'off',
      primaryColor: $('car-primary-color').value,
      secondaryColor: $('car-secondary-color').value,
      textures: body.textures || [],
      decal,
      wheel,
      wheelAnchors: body.wheelAnchors
    });
  });
  $('car-import').onclick = () => run(async () => {
    if (!key()) throw Error('Select a player with a detected body first.');
    const version = revision;
    const asset = await window.isuDesktop?.pickCarModel();
    if (closed || version !== revision) return;
    await load(asset);
  });
  $('car-saved').onclick = () => run(async () => {
    const asset = library().models?.[key()];
    if (!asset) throw Error('No saved model for this mapping.');
    await load(asset);
  });
  $('car-demo').onclick = () => {
    invalidate(); renderer.demo();
    status('DEMO ONLY - original generic geometry, not a Rocket League car. Cannot be assigned to real players.');
  };
  $('car-reset').onclick = () => renderer.resetCamera();
  $('car-save').onclick = () => run(async () => {
    if (!model || !key() || loadedKey !== key()) throw Error('Load a model for the current mapping first.');
    const savedKey = loadedKey;
    const savedModel = model;
    const version = revision;
    const image = await window.isuDesktop?.saveCarRender(renderer.png());
    if (closed || version !== revision) return;
    if (!image?.url) throw Error('PNG saving requires the desktop controller.');
    const current = library();
    saveLibrary({ ...current, models: { ...current.models, [savedKey]: savedModel }, renders: { ...current.renders, [savedKey]: { url: image.url, savedAt: new Date().toISOString() } } });
    status('Saved. Matching players will reuse this PNG without running WebGL in the overlay.');
  });
  $('car-enabled').checked = Boolean(library().enabled);
  $('car-enabled').onchange = () => saveLibrary({ ...library(), enabled: $('car-enabled').checked });
  $('car-remove').onclick = () => {
    const current = library();
    const models = { ...current.models }; const renders = { ...current.renders };
    delete models[key()]; delete renders[key()];
    saveLibrary({ ...current, models, renders }); invalidate();
    status('Mapping removed. Imported files are retained locally.');
  };
  const close = () => { if (closed) return; closed = true; revision++; renderer.dispose(); dialog.remove(); };
  $('car-close').onclick = close;
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  refresh(); loadPack(); dialog.showModal();
}
