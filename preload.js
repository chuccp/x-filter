// Preload script — kept minimal since we use nodeIntegration: true
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, callback) => ipcRenderer.on(channel, (event, ...args) => callback(...args)),
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
