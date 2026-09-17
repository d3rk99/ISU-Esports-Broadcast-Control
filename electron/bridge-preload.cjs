const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('isuBridge', {
  getConfig: () => ipcRenderer.invoke('bridge:get-config'),
  getStatus: () => ipcRenderer.invoke('bridge:get-status'),
  start: (config) => ipcRenderer.invoke('bridge:start', config),
  stop: () => ipcRenderer.invoke('bridge:stop'),
  listWindows: () => ipcRenderer.invoke('bridge:list-windows'),
  captureSnapshot: () => ipcRenderer.invoke('bridge:capture-snapshot'),
  clearOcr: () => ipcRenderer.invoke('bridge:clear-ocr'),
  startSimulator: (config) => ipcRenderer.invoke('bridge:start-simulator', config),
  stopSimulator: () => ipcRenderer.invoke('bridge:stop-simulator'),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('bridge:status', listener);
    return () => ipcRenderer.removeListener('bridge:status', listener);
  },
  onOcrState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('bridge:ocr-state', listener);
    return () => ipcRenderer.removeListener('bridge:ocr-state', listener);
  }
});
