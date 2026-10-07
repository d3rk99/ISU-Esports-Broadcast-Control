const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('isuDesktop', {
  getDisplayStatus: () => ipcRenderer.invoke('displays:status'),
  setDisplayMode: (details) => ipcRenderer.invoke('displays:set-mode', details),
  setDisplayNoise: (details) => ipcRenderer.invoke('displays:set-noise', details),
  getDisplayKey: () => ipcRenderer.invoke('displays:get-key'),
  setDisplayKey: (details) => ipcRenderer.invoke('displays:set-key', details),
  getObsDisplays: () => ipcRenderer.invoke('obs-displays:get'),
  saveObsDisplays: (details) => ipcRenderer.invoke('obs-displays:save', details),
  setupObsDisplays: () => ipcRenderer.invoke('obs-displays:setup'),
  getObsDisplaysStatus: () => ipcRenderer.invoke('obs-displays:status'),
  platform: process.platform,
  versions: Object.freeze({ electron: process.versions.electron }),
  savedRocketLeagueConnection: ipcRenderer.sendSync('rocket-league:get-saved-connection-sync'),
  savedCompanionSettings: ipcRenderer.sendSync('companion:get-settings-sync'),
  savedOutputDisplaySettings: ipcRenderer.sendSync('overlay:get-output-display-settings-sync'),
  overlayBaseUrl: 'http://127.0.0.1:3174',
  publishState: (state) => ipcRenderer.send('broadcast:update-state', state),
  pickCarModel: () => ipcRenderer.invoke('rl-car:pick-model'),
  getRocketLeagueCarAssetPack: () => ipcRenderer.invoke('rl-car:get-asset-pack'),
  getRocketLeagueCarAssetDetails: (details) => ipcRenderer.invoke('rl-car:get-asset-details', details),
  saveCarRender: (dataUrl) => ipcRenderer.invoke('rl-car:save-render', dataUrl),
  getBroadcastInfo: () => ipcRenderer.invoke('broadcast:get-info'),
  getNetworkAddresses: () => ipcRenderer.invoke('network:get-addresses'),
  configureCompanion: (settings) => ipcRenderer.invoke('companion:configure', settings),
  getCompanionStatus: () => ipcRenderer.invoke('companion:get-status'),
  pickImage: (details) => ipcRenderer.invoke('assets:pick-image', details),
  openOverlayPreview: (details) => ipcRenderer.invoke('overlay:preview', details),
  openOverlayOutput: (details) => ipcRenderer.invoke('overlay:open-output', details),
  openProgramOutput: (details) => ipcRenderer.invoke('overlay:open-program-output', details),
  setProgramOutput: (details) => ipcRenderer.invoke('overlay:set-program-output', details),
  getOutputDisplays: () => ipcRenderer.invoke('overlay:get-output-displays'),
  configureOutputDisplays: (settings) => ipcRenderer.invoke('overlay:configure-output-displays', settings),
  configureRocketLeague: (settings) => ipcRenderer.invoke('rocket-league:configure', settings),
  getRocketLeagueStatus: () => ipcRenderer.invoke('rocket-league:get-status'),
  setRocketLeagueUpdateInterval: (value) => ipcRenderer.invoke('rocket-league:set-update-interval', value),
  startRocketLeagueSimulator: () => ipcRenderer.invoke('rocket-league:start-simulator'),
  stopRocketLeagueSimulator: () => ipcRenderer.invoke('rocket-league:stop-simulator'),
  getSpectateReceiver: () => ipcRenderer.invoke('spectate-receiver:get'),
  configureSpectateReceiver: (next) => ipcRenderer.invoke('spectate-receiver:configure', next),
  onSpectated: (callback) => { const l = (_e, p) => callback(p); ipcRenderer.on('spectated:update', l); return () => ipcRenderer.removeListener('spectated:update', l); },
  onSpectateReceiverStatus: (callback) => { const l = (_e, p) => callback(p); ipcRenderer.on('spectate-receiver:status', l); return () => ipcRenderer.removeListener('spectate-receiver:status', l); },
  getValorantBoardSettings: () => ipcRenderer.invoke('valorant-board:get-settings'),
  configureValorantBoard: (settings) => ipcRenderer.invoke('valorant-board:configure', settings),
  clearValorantBoard: () => ipcRenderer.invoke('valorant-board:clear'),
  setValorantBoardName: (details) => ipcRenderer.invoke('valorant-board:set-name', details),
  testValorantBoard: () => ipcRenderer.invoke('valorant-board:test-read'),
  onValorantBoardState: (callback) => { const l = (_e, p) => callback(p); ipcRenderer.on('valorant-board:state', l); return () => ipcRenderer.removeListener('valorant-board:state', l); },
  onValorantBoardStatus: (callback) => { const l = (_e, p) => callback(p); ipcRenderer.on('valorant-board:status', l); return () => ipcRenderer.removeListener('valorant-board:status', l); },
  getOverwatchOcrSettings: () => ipcRenderer.invoke('overwatch-ocr:get-settings'),
  configureOverwatchOcr: (settings) => ipcRenderer.invoke('overwatch-ocr:configure', settings),
  clearOverwatchOcr: () => ipcRenderer.invoke('overwatch-ocr:clear'),
  setOverwatchOcrName: (details) => ipcRenderer.invoke('overwatch-ocr:set-name', details),
  testOverwatchOcr: () => ipcRenderer.invoke('overwatch-ocr:test-read'),
  debugCaptureOverwatchOcr: () => ipcRenderer.invoke('overwatch-ocr:debug-capture'),
  onOverwatchOcrState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('overwatch-ocr:state', listener);
    return () => ipcRenderer.removeListener('overwatch-ocr:state', listener);
  },
  onOverwatchOcrStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('overwatch-ocr:status', listener);
    return () => ipcRenderer.removeListener('overwatch-ocr:status', listener);
  },
  onRocketLeagueEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('rocket-league:event', listener);
    return () => ipcRenderer.removeListener('rocket-league:event', listener);
  },
  onRocketLeagueStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('rocket-league:status', listener);
    return () => ipcRenderer.removeListener('rocket-league:status', listener);
  },
  onDisplayStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('displays:status', listener);
    return () => ipcRenderer.removeListener('displays:status', listener);
  },
  onCompanionAction: (callback) => {
    const listener = async (_event, payload = {}) => {
      try {
        const result = await callback(payload.action);
        ipcRenderer.send('companion:action-result', { id: payload.id, ok: true, ...result });
      } catch (error) {
        ipcRenderer.send('companion:action-result', {
          id: payload.id,
          ok: false,
          error: error?.message || String(error),
          statusCode: Number(error?.statusCode) || 400
        });
      }
    };
    ipcRenderer.on('companion:action', listener);
    return () => ipcRenderer.removeListener('companion:action', listener);
  },
  copyText: (text) => ipcRenderer.send('clipboard:write', text)
});
