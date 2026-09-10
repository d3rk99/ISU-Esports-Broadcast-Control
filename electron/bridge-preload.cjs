const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('isuBridge', {
  getConfig: () => ipcRenderer.invoke('bridge:get-config'),
  start: (config) => ipcRenderer.invoke('bridge:start', config),
  stop: () => ipcRenderer.invoke('bridge:stop'),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('bridge:status', listener);
    return () => ipcRenderer.removeListener('bridge:status', listener);
  }
});
