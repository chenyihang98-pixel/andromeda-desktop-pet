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
  showCompanion: () => ipcRenderer.invoke('andromeda:show-companion'),
  interact: kind => ipcRenderer.invoke('andromeda:interaction', kind),
  companionState: () => ipcRenderer.invoke('andromeda:companion-state'),
  command: command => ipcRenderer.invoke('andromeda:companion-command', command),
  assistant: command => ipcRenderer.invoke('andromeda:assistant', command),
  openLink: key => ipcRenderer.invoke('andromeda:open-link', key),
  exportData: kind => ipcRenderer.invoke('andromeda:export', kind),
  voicePermission: () => ipcRenderer.invoke('andromeda:voice-permission'),
  autostart: enabled => ipcRenderer.invoke('andromeda:autostart', enabled),
  taskBridge: enabled => ipcRenderer.invoke('andromeda:task-bridge', enabled),
  toss: () => ipcRenderer.invoke('andromeda:toss'),
  shortcuts: command => ipcRenderer.invoke('andromeda:shortcuts', command),
  rhythm: level => ipcRenderer.invoke('andromeda:rhythm', level),
  onRhythm: callback => subscribe('andromeda:rhythm', callback),
  exportCharacter: data => ipcRenderer.invoke('andromeda:export-character', data),
  restoreBackup: data => ipcRenderer.invoke('andromeda:restore-backup', data),
  registerDeepLink: enabled => ipcRenderer.invoke('andromeda:register-deep-link',enabled),
  getCharacter: () => ipcRenderer.invoke('andromeda:character'),
  installCharacter: action => ipcRenderer.invoke('andromeda:install-character',action),
  onCharacter: callback => {const listener=(_event,value)=>callback(value);ipcRenderer.on('andromeda:character',listener);return()=>ipcRenderer.removeListener('andromeda:character',listener);},
  onCompanion: callback => subscribe('andromeda:companion', callback),
  onEvent: callback => subscribe('andromeda:event', callback),
  onPublic: callback => subscribe('andromeda:public', callback),
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
