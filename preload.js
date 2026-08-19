const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lemon', {
  openHtml: () => ipcRenderer.invoke('project:open-html'),
  saveSession: (payload) => ipcRenderer.invoke('project:save-session', payload),
  loadSession: () => ipcRenderer.invoke('project:load-session'),
  getWebviewPreload: () => ipcRenderer.invoke('app:webview-preload'),
  logDiagnostic: (message) => ipcRenderer.invoke('diagnostic:log', message),
  readDiagnostic: () => ipcRenderer.invoke('diagnostic:read')
});
