'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// На сенсорной панели случайный щипок не должен масштабировать интерфейс.
webFrame.setVisualZoomLevelLimits(1, 1);

contextBridge.exposeInMainWorld('calendar', {
  list: () => ipcRenderer.invoke('events:list'),
  save: (event, baseUpdatedAt) => ipcRenderer.invoke('events:save', event, baseUpdatedAt),
  remove: (id, baseUpdatedAt) => ipcRenderer.invoke('events:remove', id, baseUpdatedAt),
  directory: () => ipcRenderer.invoke('directory:list'),
  saveRefs: (refs) => ipcRenderer.invoke('directory:save', refs),
  removeRefs: (refs) => ipcRenderer.invoke('directory:remove', refs),
  attendance: () => ipcRenderer.invoke('attendance:list'),
  mark: (eventId, name, status) => ipcRenderer.invoke('attendance:mark', eventId, name, status),
  saveReport: (fileName, text) => ipcRenderer.invoke('report:save', fileName, text),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  generateKey: () => ipcRenderer.invoke('sync:generate-key'),
  onChanged: (callback) => ipcRenderer.on('events:changed', () => callback()),
  minimize: () => ipcRenderer.invoke('window:minimize'),
});
