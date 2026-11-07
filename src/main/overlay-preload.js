// Bridge for the gaming mini-player window: it only sends playback commands and receives now-playing state.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soulOverlay', {
  command: (action, value) => ipcRenderer.send('overlay-command', action, value),
  hide: () => ipcRenderer.send('overlay-toggle'),
  dragStart: () => ipcRenderer.send('overlay-drag-start'),
  dragEnd: () => ipcRenderer.send('overlay-drag-end'),
  onState: (cb) => ipcRenderer.on('overlay-state', (e, state) => cb(state)),
  // extra = pixels the preset list needs (0 closes it). The reply says which way the window grew.
  menu: (extra) => ipcRenderer.send('overlay-menu', extra),
  onMenuPlaced: (cb) => ipcRenderer.on('overlay-menu-placed', (e, side) => cb(side))
});
