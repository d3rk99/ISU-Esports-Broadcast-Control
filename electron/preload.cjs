const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('isuDesktop', {
  platform: process.platform,
  versions: Object.freeze({ electron: process.versions.electron }),
  savedRocketLeagueConnection: ipcRenderer.sendSync('rocket-league:get-saved-connection-sync'),
  savedValorantOcrSettings: ipcRenderer.sendSync('valorant-ocr:get-settings-sync'),
  savedCompanionSettings: ipcRenderer.sendSync('companion:get-settings-sync'),
  savedOutputDisplaySettings: ipcRenderer.sendSync('overlay:get-output-display-settings-sync'),
  overlayBaseUrl: 'http://127.0.0.1:3174',
  publishState: (state) => ipcRenderer.send('broadcast:update-state', state),
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
  configureValorantOcr: (settings) => ipcRenderer.invoke('valorant-ocr:configure', settings),
  getValorantOcrInfo: () => ipcRenderer.invoke('valorant-ocr:get-info'),
  listValorantWindows: () => ipcRenderer.invoke('valorant-ocr:list-windows'),
  captureValorantOcrSnapshot: () => ipcRenderer.invoke('valorant-ocr:capture-snapshot'),
  saveValorantLoadoutTemplate: (details) => ipcRenderer.invoke('valorant-ocr:save-loadout-template', details),
  clearValorantOcrState: () => ipcRenderer.invoke('valorant-ocr:clear'),
  setValorantObserverName: (details) => ipcRenderer.invoke('valorant-ocr:set-observer-name', details),
  startValorantOcrSimulator: () => ipcRenderer.invoke('valorant-ocr:start-simulator'),
  stopValorantOcrSimulator: () => ipcRenderer.invoke('valorant-ocr:stop-simulator'),
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
  onValorantOcrState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('valorant-ocr:state', listener);
    return () => ipcRenderer.removeListener('valorant-ocr:state', listener);
  },
  onValorantOcrStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('valorant-ocr:status', listener);
    return () => ipcRenderer.removeListener('valorant-ocr:status', listener);
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
