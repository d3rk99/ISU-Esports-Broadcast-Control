const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('isuDesktop', {
  platform: process.platform,
  versions: Object.freeze({ electron: process.versions.electron }),
  savedRocketLeagueConnection: ipcRenderer.sendSync('rocket-league:get-saved-connection-sync'),
  savedValorantConnection: ipcRenderer.sendSync('valorant:get-saved-connection-sync'),
  overlayBaseUrl: 'http://127.0.0.1:3174',
  publishState: (state) => ipcRenderer.send('broadcast:update-state', state),
  getBroadcastInfo: () => ipcRenderer.invoke('broadcast:get-info'),
  getNetworkAddresses: () => ipcRenderer.invoke('network:get-addresses'),
  pickImage: (details) => ipcRenderer.invoke('assets:pick-image', details),
  openOverlayPreview: (details) => ipcRenderer.invoke('overlay:preview', details),
  configureRocketLeague: (settings) => ipcRenderer.invoke('rocket-league:configure', settings),
  getRocketLeagueStatus: () => ipcRenderer.invoke('rocket-league:get-status'),
  setRocketLeagueUpdateInterval: (value) => ipcRenderer.invoke('rocket-league:set-update-interval', value),
  startRocketLeagueSimulator: () => ipcRenderer.invoke('rocket-league:start-simulator'),
  stopRocketLeagueSimulator: () => ipcRenderer.invoke('rocket-league:stop-simulator'),
  configureValorant: (settings) => ipcRenderer.invoke('valorant:configure', settings),
  getValorantStatus: () => ipcRenderer.invoke('valorant:get-status'),
  startValorantSimulator: () => ipcRenderer.invoke('valorant:start-simulator'),
  stopValorantSimulator: () => ipcRenderer.invoke('valorant:stop-simulator'),
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
  onValorantEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('valorant:event', listener);
    return () => ipcRenderer.removeListener('valorant:event', listener);
  },
  onValorantStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('valorant:status', listener);
    return () => ipcRenderer.removeListener('valorant:status', listener);
  },
  copyText: (text) => ipcRenderer.send('clipboard:write', text)
});
