'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// На сенсорной панели случайный щипок не должен масштабировать интерфейс.
webFrame.setVisualZoomLevelLimits(1, 1);

contextBridge.exposeInMainWorld('calendar', {
  list: () => ipcRenderer.invoke('events:list'),
  save: (event, baseUpdatedAt) => ipcRenderer.invoke('events:save', event, baseUpdatedAt),
  remove: (id, baseUpdatedAt) => ipcRenderer.invoke('events:remove', id, baseUpdatedAt),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  pickFolder: () => ipcRenderer.invoke('settings:pick-folder'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
});
