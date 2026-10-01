const { contextBridge, ipcRenderer } = require('electron');
const on = (channel) => callback => { const listener = (_event, value) => callback(value); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); };
contextBridge.exposeInMainWorld('stream', {
  view: () => ipcRenderer.invoke('stream:view'),
  command: (action, payload) => ipcRenderer.invoke('stream:command', action, payload),
  apiKey: () => ipcRenderer.invoke('stream:apiKey'),
  onStatus: on('stream:status'),
  // Preview JPEG bytes (Uint8Array) and audio meter { peak:[L,R], rms:[L,R] } in dBFS.
  onPreview: on('stream:preview'),
  onMeter: on('stream:meter')
});
