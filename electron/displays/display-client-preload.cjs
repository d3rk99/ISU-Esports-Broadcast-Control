'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const on = (channel) => (callback) => { const l = (_e, v) => callback(v); ipcRenderer.on(channel, l); return () => ipcRenderer.removeListener(channel, l); };
contextBridge.exposeInMainWorld('display', {
  getConfig: () => ipcRenderer.invoke('display:get-config'),
  saveConfig: (next) => ipcRenderer.invoke('display:save-config', next),
  getMirrorSource: () => ipcRenderer.invoke('display:get-mirror-source'),
  mirrorStatus: (status) => ipcRenderer.send('display:mirror-status', status),
  openSettings: () => ipcRenderer.send('display:open-settings'),
  onMode: on('display:mode'),
  onLink: on('display:link'),
  onNdiStatus: on('display:ndi-status'),
  onFrame: on('display:frame')
});
