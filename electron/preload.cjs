// Мостики страницы к окну: выбор папки, вход в Claude через Терминал, показ папки в Finder.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modelist', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  claudeLogin: () => ipcRenderer.invoke('claude-login'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
});
