import { createCarRenderer } from './rl-car-renderer.js';
import { normalizeLoadout, loadoutKey } from './rl-loadout.js';
import './rl-car-lab.css';

export function openCarLab(getGame, saveLibrary) {
  if (document.querySelector('#rl-car-lab')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'rl-car-lab';
  dialog.innerHTML = `<header><div><small>ISU ESPORTS / EXPERIMENTAL</small><h2>Rocket League Car Render Lab</h2></div><button id="car-close">CLOSE</button></header>
    <p>Local WebGL renderer · no team screenshots required once models are mapped. Import a complete vehicle GLB with embedded textures you have permission to use.</p>
    <div class="car-lab-grid"><section>
      <label>TELEMETRY PLAYER<select id="car-player"></select></label><button id="car-refresh">REFRESH PLAYERS / LOADOUT</button>
      <label>DETECTED ASSETS<textarea id="car-loadout" readonly rows="7"></textarea></label>
      <label>MAP ARTWORK TO<select id="car-scope"><option value="body">This body (generic artwork for everyone using it)</option><option value="loadout">This reported loadout (operator-supplied appearance)</option></select></label>
      <p class="car-warning">The API does not document every paint attribute. A matching loadout is NOT proof of identical colors. Materials come from the imported model; decals are not automatically composed in this prototype.</p>
      <button id="car-import">IMPORT GLB FOR SELECTED MAPPING</button>
      <button id="car-saved">LOAD SAVED MODEL</button>
      <button id="car-demo">TEST WITH DEMO CAR</button>
      <label class="car-enabled"><input id="car-enabled" type="checkbox"> Use saved car artwork on player stat cards</label>
      <button id="car-remove">REMOVE SELECTED MAPPING</button>
    </section><section><div id="car-canvas"></div><p>Drag to rotate · scroll to zoom · transparent PNG output (800 × 500)</p>
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
  const library = () => getGame().rocketLeague.carRenderer || { enabled: false, models: {}, renders: {} };
  const status = (message) => { $('car-status').textContent = message; };
  const key = () => loadoutKey(selected?.loadout, $('car-scope').value);
  const invalidate = () => { revision++; model = null; loadedKey = ''; $('car-save').disabled = true; };
  const updateSelection = () => {
    invalidate();
    selected = snapshot[Number($('car-player').value)] || null;
    $('car-loadout').value = selected ? normalizeLoadout(selected.loadout).map((item, index) => `${index}: ${item || '(empty)'}`).join('\n') || 'No Loadout field received.' : 'No live players. Start the RL test feed or connect a match.';
    status(key() ? (library().renders?.[key()] ? 'Saved artwork exists for this mapping. Load the saved model to adjust it.' : 'Unmapped: import a model. Existing preview is not assigned to this selection.') : 'Missing body data: live artwork remains unchanged.');
  };
  const refresh = () => {
    const previous = selected?.id;
    snapshot = structuredClone(getGame().rocketLeague.live?.players || []);
    $('car-player').replaceChildren(...snapshot.map((player, index) => new Option(`${player.name} · ${Number(player.teamNum) === 0 ? 'Blue' : 'Orange'}`, String(index))));
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
    status('Loading local model…');
    const success = await renderer.load(asset.url);
    if (closed || version !== revision || !success) return;
    model = asset; loadedKey = targetKey; $('car-save').disabled = false;
    status(`Ready: ${asset.name}. Check orientation and appearance, then save. This preview does not update Program until saved.`);
  };
  $('car-player').onchange = updateSelection;
  $('car-scope').onchange = updateSelection;
  $('car-refresh').onclick = refresh;
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
    status('DEMO ONLY — original generic geometry, not a Rocket League car. Cannot be assigned to real players.');
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
  refresh(); dialog.showModal();
}
