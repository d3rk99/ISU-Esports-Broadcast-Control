const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('stream', {
  view: () => ipcRenderer.invoke('stream:view'),
  command: (action, payload) => ipcRenderer.invoke('stream:command', action, payload),
  onStatus: callback => { const listener = (_event, status) => callback(status); ipcRenderer.on('stream:status', listener); return () => ipcRenderer.removeListener('stream:status', listener); }
});
