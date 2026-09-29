const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stageClient', {
  openSettings: () => ipcRenderer.send('stage-client:open-settings'),
  closeSettings: () => ipcRenderer.send('stage-client:close-settings'),
  onConfigChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('stage-client:config-changed', listener);
    return () => ipcRenderer.removeListener('stage-client:config-changed', listener);
  },
  getConfig: () => ipcRenderer.invoke('stage-client:get-config'),
  saveConfig: (details) => ipcRenderer.invoke('stage-client:save-config', details),
  setCursorLock: (details) => ipcRenderer.invoke('stage-client:set-cursor-lock', details),
  getPlayerSource: () => ipcRenderer.invoke('stage-client:get-player-source'),
  reportStatus: (status) => ipcRenderer.send('stage-client:renderer-status', status),
  onOpenSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('stage-client:open-settings', listener);
    return () => ipcRenderer.removeListener('stage-client:open-settings', listener);
  },
  onCursorLock: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('stage-client:cursor-lock', listener);
    return () => ipcRenderer.removeListener('stage-client:cursor-lock', listener);
  },
  onMode: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('stage-client:mode', listener);
    return () => ipcRenderer.removeListener('stage-client:mode', listener);
  },
  onPrepare: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('stage-client:prepare', listener);
    return () => ipcRenderer.removeListener('stage-client:prepare', listener);
  }
});
