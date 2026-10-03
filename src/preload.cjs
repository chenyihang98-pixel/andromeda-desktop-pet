'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('回调必须是函数');
  // Never expose the privileged IpcRendererEvent to page JavaScript.
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('andromeda', Object.freeze({
  getState: () => ipcRenderer.invoke('andromeda:get-state'),
  setSettings: (patch) => ipcRenderer.invoke('andromeda:set-settings', patch),
  showSettings: () => ipcRenderer.invoke('andromeda:show-settings'),
  hide: () => ipcRenderer.invoke('andromeda:hide'),
  quit: () => ipcRenderer.invoke('andromeda:quit'),
  undock: () => ipcRenderer.invoke('andromeda:undock'),
  openReleases: () => ipcRenderer.invoke('andromeda:open-releases'),
  resetPosition: () => ipcRenderer.invoke('andromeda:reset-position'),
  playAction: (action) => ipcRenderer.invoke('andromeda:play-action', action),
  startDrag: () => ipcRenderer.send('andromeda:start-drag'),
  drag: () => ipcRenderer.send('andromeda:drag'),
  endDrag: () => ipcRenderer.send('andromeda:end-drag'),
  cancelDrag: () => ipcRenderer.send('andromeda:cancel-drag'),
  onState: (callback) => subscribe('andromeda:state', callback),
  onAction: (callback) => subscribe('andromeda:action', callback),
  onGaze: (callback) => subscribe('andromeda:gaze', callback),
}));
